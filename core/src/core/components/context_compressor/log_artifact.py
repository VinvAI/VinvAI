"""Vinv Engine / components / context_compressor / log_artifact — artifact-backed observations.

Massive tool outputs (multi-megabyte terminal captures, log floods) must not
be compressed wholesale into an LLM context: even at aggressive ratios the
result is unusable, and the compression itself costs hundreds of LLM calls.

Instead, the COMPLETE output is preserved on disk as an artifact, and the
model receives a bounded, structured digest:

  * byte/line/token counts and the artifact path,
  * the head and tail of the output,
  * every diagnostic-looking line (errors, warnings, failures) up to a
    token-derived cap, with exact counts for anything not shown,
  * an explicit instruction to grep / read ranges from the artifact file.

Nothing is lost — the agent can (and should) run targeted `grep`, `sed -n`,
or `tail` against the artifact to investigate, instead of carrying millions
of tokens of scrollback in its trajectory.
"""

from __future__ import annotations

import logging
import os
import re
import time
from typing import List, Optional, Tuple

from core.components.context_compressor.token_utils import count_tokens

logger = logging.getLogger(__name__)

# Diagnostic-line signal: the near-universal way tools and runtimes flag
# problems in text output. Used to *select* lines for the digest — never to
# delete anything (the full artifact keeps every byte).
_DIAGNOSTIC_RE = re.compile(
    r"error|exception|traceback|fatal|fail(?:ed|ure)?|warn(?:ing)?|"
    r"denied|refused|not found|no such|cannot|unable|timeout|timed out|"
    r"critical|panic|abort",
    re.IGNORECASE,
)

_SAFE_LABEL_RE = re.compile(r"[^A-Za-z0-9._-]+")


def artifact_dir() -> str:
    explicit = os.environ.get("VINV_ENGINE_ARTIFACT_DIR")
    if explicit:
        return explicit
    # Anchor the fallback to the shared workspace, not os.getcwd(): cwd-relative
    # artifact dirs scattered .vinv/logs/tool_results across whichever directory
    # each driver happened to run from, defeating discovery and GC.
    from core.components.bootstrap.paths import DEFAULT_VINV_ENGINE_SHARED_DIR

    shared_dir = os.environ.get(
        "VINV_ENGINE_SHARED_DIR", DEFAULT_VINV_ENGINE_SHARED_DIR
    )
    return os.path.join(shared_dir, ".vinv", "logs", "tool_results")


def _write_artifact(content: str, label: str) -> Optional[str]:
    try:
        directory = artifact_dir()
        os.makedirs(directory, exist_ok=True)
        safe = _SAFE_LABEL_RE.sub("_", label)[:80] or "output"
        path = os.path.join(directory, f"{safe}-{int(time.time() * 1000)}.log")
        with open(path, "w", encoding="utf-8", errors="replace") as fh:
            fh.write(content)
    except Exception as exc:
        logger.warning("log_artifact: could not write artifact: %s", exc)
        return None
    # Index the artifact so it is discoverable and GC-eligible.  This single
    # hook covers both live consumers (terminal_tools._bounded_output and
    # base_agent._truncate_tool_result).  Registration never raises.
    try:
        from core.components.common.offload_registry import register_offload

        register_offload(path, content, kind="log_artifact")
    except Exception as exc:
        logger.warning("log_artifact: registry hook failed (non-fatal): %s", exc)
    return path


def _select_lines(
    lines: List[str], head_n: int, tail_n: int, diag_cap: int,
) -> Tuple[List[str], List[str], List[Tuple[int, str]], int]:
    head = lines[:head_n]
    tail = lines[-tail_n:] if len(lines) > head_n + tail_n else []
    diagnostics: List[Tuple[int, str]] = []
    total_diag = 0
    body_start, body_end = len(head), len(lines) - len(tail)
    for idx in range(body_start, body_end):
        if _DIAGNOSTIC_RE.search(lines[idx]):
            total_diag += 1
            if len(diagnostics) < diag_cap:
                diagnostics.append((idx + 1, lines[idx]))
    return head, tail, diagnostics, total_diag


def store_and_digest(
    content: str,
    label: str,
    budget_tokens: int,
) -> str:
    """Persist *content* to an artifact file and return a bounded digest."""
    digest, _path = digest_with_artifact(content, label, budget_tokens)
    return digest


def digest_with_artifact(
    content: str,
    label: str,
    budget_tokens: int,
) -> Tuple[str, Optional[str]]:
    """Persist *content* to an artifact file; return ``(digest, artifact_path)``.

    The digest fits roughly within *budget_tokens* (head/tail/diagnostic
    section sizes are derived from it) and always includes the artifact path
    plus grep instructions. If the artifact cannot be written, the digest is
    still produced but flags that full output was not preserved.
    """
    lines = content.split("\n")
    total_bytes = len(content.encode("utf-8", errors="replace"))
    total_tokens = count_tokens(content)
    path = _write_artifact(content, label)

    # Token→line conversion from THIS content's own density (consistent with
    # count_tokens ≈ chars/4 when no tokenizer is available).
    per_line = max(1, total_tokens // max(len(lines), 1))
    budget_lines = max(24, budget_tokens // per_line)
    head_n = budget_lines // 3
    tail_n = budget_lines // 3
    diag_cap = budget_lines - head_n - tail_n

    head, tail, diagnostics, total_diag = _select_lines(
        lines, head_n, tail_n, diag_cap,
    )

    sections: List[str] = []
    sections.append(
        f"[LARGE OUTPUT — STORED AS ARTIFACT]\n"
        f"source: {label}\n"
        f"size: {total_bytes} bytes, {len(lines)} lines, ~{total_tokens} tokens\n"
        f"artifact: {path or 'UNAVAILABLE (write failed — digest only)'}"
    )
    if path:
        sections.append(
            "The COMPLETE output is preserved at the artifact path above. "
            "Do NOT ask for the full content — investigate with targeted "
            "commands, e.g.:\n"
            f"  grep -n 'pattern' '{path}'\n"
            f"  sed -n 'START,ENDp' '{path}'\n"
            f"  tail -n 100 '{path}'"
        )
    sections.append("--- HEAD ---\n" + "\n".join(head))
    if diagnostics:
        shown = "\n".join(f"{n}: {line}" for n, line in diagnostics)
        more = total_diag - len(diagnostics)
        suffix = f"\n[... {more} more diagnostic lines in artifact ...]" if more > 0 else ""
        sections.append(
            f"--- DIAGNOSTIC LINES ({total_diag} matched in body) ---\n{shown}{suffix}"
        )
    if tail:
        sections.append("--- TAIL ---\n" + "\n".join(tail))

    digest = "\n\n".join(sections)
    logger.info(
        "log_artifact: %d tokens → %d-token digest, artifact=%s",
        total_tokens, count_tokens(digest), path,
    )
    return digest, path


__all__ = ["store_and_digest", "digest_with_artifact", "artifact_dir"]
