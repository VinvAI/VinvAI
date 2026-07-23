"""Vinv Engine / context_compressor / actors / output_distiller_actor — LLM output distillation.

Distills a task's raw output for consumption by downstream tasks, via
:class:`OutputDistillationSignature`, and feeds the result to
:meth:`ContextLedger.refine` so the ledger entry is refined in-place.

Adapted from the actor-based ``OutputDistillerActor`` (vinv-electron): this
tree has no actor runtime, so the identical algorithm is exposed as a
directly-callable :class:`OutputDistiller` instead of an ``Actor`` subclass.
Call :meth:`OutputDistiller.distill` (or :meth:`distill_and_refine`) after a
task completes.  The ``DISTILL_OUTPUT`` / ``DISTILL_RESULT`` message-type
constants are kept for protocol parity — ``timeout_registry`` already routes
on them.

Pipeline (identical to the actor version):
1. Skip tiny outputs (< 200 chars) — nothing to distill.
2. Pre-compress via ContentIngestionPipeline when raw output exceeds 70%% of
   the model window (target 40%%).
3. LLM distillation via OutputDistillationSignature (600s timeout).
4. Fall back to :meth:`ContextCompressorEngine.compress_output_dict` when the
   LLM call fails or returns empty.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

import dspy

from core.components.context_compressor.engine import ContextCompressorEngine
from core.components.context_compressor.signatures import OutputDistillationSignature

logger = logging.getLogger(__name__)

DISTILL_OUTPUT = "DISTILL_OUTPUT"
DISTILL_RESULT = "DISTILL_RESULT"

# Skip distillation for tiny outputs — there's nothing to distill and making
# an LLM call for 3-8 character strings is wasteful.
_MIN_DISTILL_CHARS = 200

# Hard ceiling on a single distillation LLM call (seconds).
_DISTILL_TIMEOUT_S = 600


class OutputDistiller:
    """LLM distillation of task outputs (callable adaptation of OutputDistillerActor).

    Protocol parity with the actor deployment
    -----------------------------------------
    IN  (``DISTILL_OUTPUT`` payload)  — task_id, task_name, goal, raw_output, downstream_tasks
    OUT (``DISTILL_RESULT`` payload)  — task_id, distilled_output  (the return value of :meth:`distill`)
    """

    def __init__(self, distiller_id: str = "output_distiller") -> None:
        self.id = distiller_id
        self._distiller = dspy.ChainOfThought(OutputDistillationSignature)
        self._compressor = ContextCompressorEngine()

    def _precompress_if_needed(
        self, raw_output: str, task_id: str, task_name: str, goal: str,
    ) -> str:
        """Compress raw_output through the ingestion pipeline if it exceeds the model context."""
        logger.debug("distiller_precompress_check task_id=%s chars=%d", task_id, len(raw_output))
        try:
            from core.components.context_compressor.token_utils import count_tokens
            from core.components.context_compressor.model_context_registry import (
                get_model_context_registry,
            )
            import os as _os
            limit = get_model_context_registry().get_limit() or 200_000
            tokens = count_tokens(raw_output)
            _trigger = float(_os.environ.get("VINV_ENGINE_DISTILLER_PRECOMPRESS_TRIGGER", "0.7"))
            if tokens <= int(limit * _trigger):
                logger.debug("distiller_precompress_within_trigger")
                return raw_output

            logger.info("distiller_precompressing tokens=%d task_id=%s", tokens, task_id)
            from core.components.context_compressor.content_ingestion import (
                ContentIngestionPipeline,
            )
            _target = float(_os.environ.get("VINV_ENGINE_DISTILLER_PRECOMPRESS_TARGET", "0.4"))
            target = int(limit * _target)
            pipeline = ContentIngestionPipeline()
            result = pipeline.process_sync(
                content=raw_output,
                max_tokens=target,
                query=f"Distill output of task '{task_name}' for downstream consumption",
                goal=goal,
                context_type="distiller_precompress",
            )
            logger.info(
                "distiller_precompressed distiller_id=%s task_id=%s original_tokens=%d compressed_tokens=%d",
                self.id, task_id, tokens, count_tokens(result.content),
            )
            return result.content
        except Exception as exc:
            logger.warning(
                "distiller_precompress_failed distiller_id=%s task_id=%s error=%s",
                self.id, task_id, exc,
            )
            return raw_output

    async def distill(
        self,
        task_id: str,
        task_name: str,
        goal: str,
        raw_output: str,
        downstream_tasks: str = "",
    ) -> str:
        """Distill ``raw_output`` for downstream tasks; returns the distilled output.

        Equivalent of the actor's DISTILL_OUTPUT → DISTILL_RESULT round-trip:
        the return value is what the actor would send as ``distilled_output``.
        Returns ``raw_output`` unchanged for empty/tiny inputs.
        """
        if not task_id or not raw_output:
            return raw_output

        if len(raw_output) < _MIN_DISTILL_CHARS:
            logger.debug(
                "distiller_skip_tiny_output distiller_id=%s task_id=%s raw_output_chars=%d",
                self.id, task_id, len(raw_output),
            )
            return raw_output

        raw_output = await asyncio.to_thread(
            self._precompress_if_needed, raw_output, task_id, task_name, goal
        )

        logger.info(
            "distiller_start distiller_id=%s task_id=%s task_name=%s raw_output_chars=%d",
            self.id, task_id, task_name, len(raw_output),
        )

        distilled: str = ""
        try:
            def _call() -> Any:
                return self._distiller(
                    task_name=task_name,
                    goal=goal,
                    raw_output=raw_output,
                    downstream_tasks=downstream_tasks,
                )

            result = await asyncio.wait_for(
                asyncio.to_thread(_call),
                timeout=_DISTILL_TIMEOUT_S,
            )
            distilled = getattr(result, "distilled_output", "") or ""
        except Exception as exc:
            logger.warning(
                "distiller_llm_error distiller_id=%s task_id=%s error=%s",
                self.id, task_id, exc,
            )

        if not distilled:
            logger.warning("OutputDistiller: LLM distillation produced empty result, using compress_output_dict fallback")
            try:
                raw_dict = json.loads(raw_output) if isinstance(raw_output, str) else raw_output
                if not isinstance(raw_dict, dict):
                    raw_dict = {"_raw": raw_dict}
                distilled = ContextCompressorEngine.compress_output_dict(raw_dict, budget=50000)
            except Exception as exc:
                logger.warning("distiller_compress_fallback_failed error=%s", exc)
                fallback = raw_output if isinstance(raw_output, str) else json.dumps(raw_output, default=str)
                distilled = fallback

        logger.info(
            "distiller_complete distiller_id=%s task_id=%s distilled_chars=%d",
            self.id, task_id, len(distilled),
        )
        return distilled

    async def distill_and_refine(
        self,
        ledger: Any,
        task_id: str,
        task_name: str,
        goal: str,
        raw_output: str,
        downstream_tasks: str = "",
    ) -> str:
        """Distill and refine the :class:`ContextLedger` entry in-place.

        ``ledger`` is a ``core.components.hero.models.ContextLedger`` (typed as
        Any to avoid an import cycle).  Mirrors the actor deployment where the
        DISTILL_RESULT handler calls ``ledger.refine(task_id, distilled)``.
        """
        distilled = await self.distill(
            task_id=task_id,
            task_name=task_name,
            goal=goal,
            raw_output=raw_output,
            downstream_tasks=downstream_tasks,
        )
        try:
            ledger.refine(task_id, distilled)
        except Exception as exc:
            logger.warning(
                "distiller_ledger_refine_failed distiller_id=%s task_id=%s error=%s",
                self.id, task_id, exc,
            )
        return distilled

    def distill_sync(
        self,
        task_id: str,
        task_name: str,
        goal: str,
        raw_output: str,
        downstream_tasks: str = "",
    ) -> str:
        """Synchronous wrapper around :meth:`distill`.

        Runs the async path in a fresh thread + event loop when a loop is
        already running (avoids deadlock), otherwise uses ``asyncio.run``.
        """
        import concurrent.futures

        coro = self.distill(
            task_id=task_id,
            task_name=task_name,
            goal=goal,
            raw_output=raw_output,
            downstream_tasks=downstream_tasks,
        )
        try:
            asyncio.get_running_loop()
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(asyncio.run, coro)
                return future.result()
        except RuntimeError:
            return asyncio.run(coro)


__all__ = [
    "OutputDistiller",
    "DISTILL_OUTPUT",
    "DISTILL_RESULT",
]
