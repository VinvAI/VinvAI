"""Regression tests for context-overflow recalibration (zero-truncation).

Derived from the bringup incident where gpt-5.4-nano rejected compression
requests with:

    "This model's maximum context length is 272000 tokens. However, your
     messages resulted in 277851 tokens. Please reduce the length of the
     messages."

The old pipeline retried the identical oversized request three times, then
concatenated raw chunks and grew. The new pipeline must:
  1. recognize the overflow generically (any provider, typed or message),
  2. parse the provider's real limit and token count from the message,
  3. teach the ModelContextRegistry (limit + token inflation),
  4. re-split the SAME content into smaller chunks and retry — never
     truncate, sample, or drop content.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from core.components.context_compressor.model_context_registry import (  # noqa: E402
    ModelContextRegistry,
)
from core.components.context_compressor.token_utils import count_tokens  # noqa: E402
from core.components.context_compressor import unified_compression as uc  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_registry(tmp_path, monkeypatch):
    """Reset the singleton and sandbox the persisted catalog per test."""
    monkeypatch.setenv(
        "VINV_ENGINE_MODEL_LIMITS_PATH", str(tmp_path / "learned_model_limits.json")
    )
    ModelContextRegistry._instance = None
    yield
    ModelContextRegistry._instance = None


# ---------------------------------------------------------------------------
# Overflow detection (provider-agnostic)
# ---------------------------------------------------------------------------

class TestOverflowDetection:
    def test_openai_400_message(self):
        e = RuntimeError(
            "litellm.BadRequestError: OpenAIException - Error code: 400 - "
            "{'error': {'message': \"This model's maximum context length is "
            "272000 tokens. However, your messages resulted in 277851 tokens. "
            "Please reduce the length of the messages.\", 'type': "
            "'invalid_request_error', 'code': 'context_length_exceeded'}}"
        )
        assert uc._is_context_overflow(e)

    def test_anthropic_message(self):
        e = RuntimeError("prompt is too long: 210000 tokens > 200000 maximum")
        assert uc._is_context_overflow(e)

    def test_bedrock_style_message(self):
        e = RuntimeError("ValidationException: Input is too long for requested model.")
        assert uc._is_context_overflow(e)

    def test_chained_cause_is_searched(self):
        inner = RuntimeError("context_length_exceeded")
        outer = RuntimeError("request failed")
        outer.__cause__ = inner
        assert uc._is_context_overflow(outer)

    def test_unrelated_error_not_flagged(self):
        assert not uc._is_context_overflow(RuntimeError("connection reset by peer"))
        assert not uc._is_context_overflow(RuntimeError("rate limit exceeded, retry"))


# ---------------------------------------------------------------------------
# Number extraction from provider messages
# ---------------------------------------------------------------------------

class TestOverflowNumberParsing:
    def test_openai_incident_numbers(self):
        e = RuntimeError(
            "This model's maximum context length is 272000 tokens. However, "
            "your messages resulted in 277851 tokens. Please reduce the length."
        )
        reported, limit = uc._parse_overflow_numbers(e)
        assert limit == 272000
        assert reported == 277851

    def test_anthropic_numbers(self):
        e = RuntimeError("prompt is too long: 210000 tokens > 200000 maximum")
        reported, limit = uc._parse_overflow_numbers(e)
        assert limit == 200000
        assert reported == 210000

    def test_comma_separated_numbers(self):
        e = RuntimeError(
            "maximum context length is 1,000,000 tokens, but you requested 1,048,576 tokens"
        )
        reported, limit = uc._parse_overflow_numbers(e)
        assert limit == 1000000
        assert reported == 1048576

    def test_single_number_treated_as_limit(self):
        e = RuntimeError("input exceeds the maximum of 128000 tokens")
        reported, limit = uc._parse_overflow_numbers(e)
        assert limit == 128000
        assert reported is None

    def test_no_numbers(self):
        e = RuntimeError("context window exceeded")
        assert uc._parse_overflow_numbers(e) == (None, None)

    def test_small_numbers_ignored(self):
        # Error codes / HTTP statuses must not be mistaken for token counts.
        e = RuntimeError(
            "Error code: 400 — maximum context length is 272000 tokens, "
            "your messages resulted in 277851 tokens"
        )
        reported, limit = uc._parse_overflow_numbers(e)
        assert limit == 272000
        assert reported == 277851


# ---------------------------------------------------------------------------
# Registry learning
# ---------------------------------------------------------------------------

class TestRegistryLearning:
    def test_learns_limit_and_inflation(self):
        reg = ModelContextRegistry()
        reg.record_overflow("m1", estimated_tokens=155000, reported_tokens=277851,
                            reported_limit=272000)
        assert reg.observed_input_limit("m1") == 272000
        assert reg.effective_input_limit("m1") == 272000
        assert reg.token_inflation("m1") == pytest.approx(277851 / 155000)

    def test_inflation_keeps_most_conservative(self):
        reg = ModelContextRegistry()
        reg.record_overflow("m1", 100000, 180000, 272000)  # ratio 1.8
        reg.record_overflow("m1", 100000, 120000, 272000)  # ratio 1.2 — ignored
        assert reg.token_inflation("m1") == pytest.approx(1.8)

    def test_inflation_never_below_one(self):
        reg = ModelContextRegistry()
        assert reg.token_inflation("unknown") == 1.0

    def test_global_fallback_for_unknown_model(self):
        reg = ModelContextRegistry()
        reg.record_overflow(None, 100000, 150000, 200000)
        # With no model id, learning lands on the global/default key and
        # applies to any model without its own observations.
        assert reg.effective_input_limit("some-other-model") == 200000
        assert reg.token_inflation("some-other-model") == pytest.approx(1.5)

    def test_partial_numbers_learn_what_is_available(self):
        reg = ModelContextRegistry()
        reg.record_overflow("m1", 0, None, 131072)
        assert reg.observed_input_limit("m1") == 131072
        assert reg.token_inflation("m1") == 1.0  # no count → no inflation learned


class TestCatalogPersistence:
    """Learned numbers must survive process restarts via the on-disk catalog."""

    def test_overflow_persists_and_reloads(self, tmp_path):
        reg = ModelContextRegistry()
        reg.record_overflow("gpt-5.4-nano", 155000, 277851, 272000)

        catalog = tmp_path / "learned_model_limits.json"
        assert catalog.exists(), "record_overflow must write the catalog"

        # Simulate a brand-new process: fresh singleton, same catalog path.
        ModelContextRegistry._instance = None
        reg2 = ModelContextRegistry()
        assert reg2.observed_input_limit("gpt-5.4-nano") == 272000
        assert reg2.effective_input_limit("gpt-5.4-nano") == 272000
        assert reg2.token_inflation("gpt-5.4-nano") == pytest.approx(277851 / 155000)

    def test_catalog_is_valid_json_with_model_names(self, tmp_path):
        import json
        reg = ModelContextRegistry()
        reg.record_overflow("claude-x", 100000, 210000, 200000)
        data = json.loads((tmp_path / "learned_model_limits.json").read_text())
        assert data["observed_limits"]["claude-x"] == 200000
        assert data["inflation"]["claude-x"] == pytest.approx(2.1)

    def test_corrupt_catalog_does_not_break_registry(self, tmp_path):
        (tmp_path / "learned_model_limits.json").write_text("{not json")
        ModelContextRegistry._instance = None
        reg = ModelContextRegistry()  # must not raise
        assert reg.token_inflation("anything") == 1.0


# ---------------------------------------------------------------------------
# Recalibrating map/reduce (no truncation, resplit on overflow)
# ---------------------------------------------------------------------------

def _make_compressor(monkeypatch, fallback_limit: int = 200000):
    monkeypatch.setenv("VINV_ENGINE_MODEL_FALLBACK_LIMIT", str(fallback_limit))
    monkeypatch.setenv("VINV_ENGINE_COMPRESS_OVERLAP_TOKENS", "0")
    comp = uc.UnifiedCompressor(enable_caching=False)
    return comp


class TestChunkCapacity:
    def test_default_quarter_of_window(self, monkeypatch):
        comp = _make_compressor(monkeypatch, fallback_limit=200000)
        assert comp._chunk_capacity(None, 0.25) == 50000

    def test_user_math_280k_window_gives_70k_chunks(self, monkeypatch):
        """280K window → 25% = 70K content per chunk. That is THE sizing rule."""
        comp = _make_compressor(monkeypatch, fallback_limit=280000)
        assert comp._chunk_capacity(None, 0.25) == 70000

    def test_uses_learned_limit_and_inflation(self, monkeypatch):
        comp = _make_compressor(monkeypatch, fallback_limit=200000)
        reg = ModelContextRegistry()
        reg.record_overflow("m1", 100000, 180000, 272000)  # limit 272k, inflation 1.8
        cap = comp._chunk_capacity("m1", 0.25)
        assert cap == int(272000 * 0.25 / 1.8)


class TestPerCallBudgetFloor:
    """A single call is never asked for an impossible ratio (e.g. 38K → 380).

    Per-chunk output budgets are floored at input × 25%; the reduce tree —
    not one heroic call — delivers deep overall compression across rounds.
    """

    def test_chunk_budget_never_collapses_with_many_chunks(self, monkeypatch):
        """Even with a tiny final target spread over hundreds of chunks, each
        call's budget stays ≥ 25% of that chunk's input."""
        comp = _make_compressor(monkeypatch, fallback_limit=280000)
        seen_budgets = []  # (input_tokens, budget)

        async def fake_compress_direct(content, max_tokens, **kwargs):
            seen_budgets.append((count_tokens(content), max_tokens))
            lines = content.split("\n")
            return "\n".join(lines[: max(1, len(lines) // 4)])

        async def fake_synthesize(parts, max_tokens, goal=""):
            joined = "\n".join(parts)
            lines = joined.split("\n")
            return "\n".join(lines[: max(1, len(lines) // 4)])

        monkeypatch.setattr(comp, "_compress_direct", fake_compress_direct)
        monkeypatch.setattr(comp, "_synthesize_chunks", fake_synthesize)

        # ~700K tokens across 10 chunks of 70K; final target only 2000 tokens.
        content = "\n".join(f"L{i} " + "x " * 50 for i in range(70000))
        asyncio.run(comp._map_reduce_recalibrating(
            content=content, max_tokens=2000, model_id="m-floor",
        ))

        assert seen_budgets, "compression must have been called"
        for input_tokens, budget in seen_budgets:
            assert budget >= int(input_tokens * 0.25), (
                f"budget {budget} below 25% of input {input_tokens} — "
                "one call was asked for an impossible ratio"
            )
            assert budget > 380, f"collapsed budget: {budget}"

    def test_reduce_converges_toward_target_across_rounds(self, monkeypatch):
        """The tree converges geometrically: each round shrinks totals, and
        the final result approaches the advisory target without truncation."""
        comp = _make_compressor(monkeypatch, fallback_limit=280000)

        def _keep_to_budget(text: str, budget: int) -> str:
            # Faithful compressor stand-in: output ≈ budget tokens.
            lines = text.split("\n")
            per_line = max(1, count_tokens(text) // max(1, len(lines)))
            keep = max(1, min(len(lines), budget // per_line))
            return "\n".join(lines[:keep])

        async def fake_compress_direct(content, max_tokens, **kwargs):
            return _keep_to_budget(content, max_tokens)

        async def fake_synthesize(parts, max_tokens, goal=""):
            return _keep_to_budget("\n".join(parts), max_tokens)

        monkeypatch.setattr(comp, "_compress_direct", fake_compress_direct)
        monkeypatch.setattr(comp, "_synthesize_chunks", fake_synthesize)

        content = "\n".join(f"R{i} " + "y " * 40 for i in range(40000))  # ~440K tokens
        target = 10000
        result = asyncio.run(comp._map_reduce_recalibrating(
            content=content, max_tokens=target, model_id="m-converge",
        ))
        result_tokens = count_tokens(result)
        assert result_tokens <= int(target * 1.5), (
            f"tree failed to converge: {result_tokens} tokens vs target {target}"
        )


class TestMapRecalibration:
    def test_overflow_triggers_resplit_not_truncation(self, monkeypatch):
        """Chunks that overflow are re-split after learning — content preserved."""
        comp = _make_compressor(monkeypatch, fallback_limit=200000)

        # Provider truth: accepts at most 5000 tokens of content per request.
        provider_capacity = 5000
        calls = {"n": 0, "overflows": 0}

        async def fake_compress_direct(content, max_tokens, **kwargs):
            calls["n"] += 1
            if count_tokens(content) > provider_capacity:
                calls["overflows"] += 1
                raise uc._ContextOverflow(
                    count_tokens(content), provider_capacity + 100,
                    # Learned limit small enough that 25% fill → feasible chunks
                    provider_capacity * 4, RuntimeError("maximum context length"),
                )
            # "Compression": keep the first line of the chunk (marker survives).
            return content.split("\n", 1)[0]

        async def fake_synthesize(parts, max_tokens, goal=""):
            return "\n\n".join(parts)

        monkeypatch.setattr(comp, "_compress_direct", fake_compress_direct)
        monkeypatch.setattr(comp, "_synthesize_chunks", fake_synthesize)

        # ~40k tokens of content with per-line markers.
        lines = [f"MARK-{i} " + "x " * 40 for i in range(4000)]
        content = "\n".join(lines)

        result = asyncio.run(comp._map_reduce_recalibrating(
            content=content, max_tokens=1000, model_id="m-test",
        ))

        assert calls["overflows"] >= 1, "first round must overflow (default capacity too big)"
        assert result, "must produce output after recalibration"
        # After learning, the registry holds the provider's real limit.
        assert ModelContextRegistry().observed_input_limit("m-test") == provider_capacity * 4
        # Output is built from real chunk content, not elision markers.
        assert "MARK-0" in result
        assert "omitted" not in result and "…" not in result

    def test_unparseable_overflow_still_makes_progress(self, monkeypatch):
        """Provider gives no numbers → fill fraction shrinks multiplicatively."""
        comp = _make_compressor(monkeypatch, fallback_limit=200000)
        provider_capacity = 3000

        async def fake_compress_direct(content, max_tokens, **kwargs):
            if count_tokens(content) > provider_capacity:
                raise uc._ContextOverflow(
                    count_tokens(content), None, None,
                    RuntimeError("context window exceeded"),
                )
            return content.split("\n", 1)[0]

        async def fake_synthesize(parts, max_tokens, goal=""):
            return "\n\n".join(parts)

        monkeypatch.setattr(comp, "_compress_direct", fake_compress_direct)
        monkeypatch.setattr(comp, "_synthesize_chunks", fake_synthesize)

        lines = [f"ROW-{i} " + "y " * 30 for i in range(3000)]
        content = "\n".join(lines)

        result = asyncio.run(comp._map_reduce_recalibrating(
            content=content, max_tokens=800, model_id="m-blind",
        ))
        assert result
        assert "ROW-0" in result

    def test_infeasible_after_max_rounds(self, monkeypatch):
        """A provider rejecting everything ends in a typed error, not raw passthrough."""
        monkeypatch.setenv("VINV_ENGINE_COMPRESS_RECALIBRATION_ROUNDS", "2")
        comp = _make_compressor(monkeypatch)

        async def always_overflow(content, max_tokens, **kwargs):
            raise uc._ContextOverflow(
                count_tokens(content), None, None, RuntimeError("context window"),
            )

        monkeypatch.setattr(comp, "_compress_direct", always_overflow)

        content = "\n".join("z " * 50 for _ in range(2000))
        with pytest.raises(uc.InfeasibleCompressionError):
            asyncio.run(comp._map_reduce_recalibrating(
                content=content, max_tokens=100, model_id="m-dead",
            ))


async def _identity_compress(content, max_tokens, **kwargs):
    """Stub for the final-convergence pass: no progress → loop exits at once."""
    return content


class TestReducePacking:
    def test_groups_packed_to_measured_capacity(self, monkeypatch):
        """Reduce groups are packed by measured token size — no group exceeds capacity."""
        monkeypatch.setenv("VINV_ENGINE_MODEL_FALLBACK_LIMIT", "8000")  # capacity 2000 @ 0.25
        comp = uc.UnifiedCompressor(enable_caching=False)
        monkeypatch.setattr(comp, "_compress_direct", _identity_compress)

        seen_group_sizes = []

        async def fake_synthesize(parts, max_tokens, goal=""):
            seen_group_sizes.append(sum(count_tokens(p) for p in parts))
            # Halve each group so rounds make progress.
            joined = "\n".join(parts)
            half = joined.split("\n")
            return "\n".join(half[: max(1, len(half) // 2)])

        monkeypatch.setattr(comp, "_synthesize_chunks", fake_synthesize)

        parts = [f"part-{i} " + "w " * 400 for i in range(12)]  # ~400 tokens each
        result = asyncio.run(comp._reduce_recalibrating(
            parts, max_tokens=500, model_id="m-pack",
        ))
        assert result
        assert seen_group_sizes, "synthesis must have been called"
        assert all(s <= 2000 for s in seen_group_sizes), (
            f"a reduce group exceeded per-request capacity: {seen_group_sizes}"
        )

    def test_reduce_overflow_recalibrates_and_repacks(self, monkeypatch):
        monkeypatch.setenv("VINV_ENGINE_MODEL_FALLBACK_LIMIT", "8000")
        comp = uc.UnifiedCompressor(enable_caching=False)
        monkeypatch.setattr(comp, "_compress_direct", _identity_compress)
        provider_capacity = 900  # smaller than the initial 2000 packing capacity

        async def fake_synthesize(parts, max_tokens, goal=""):
            group_tokens = sum(count_tokens(p) for p in parts)
            if group_tokens > provider_capacity:
                raise uc._ContextOverflow(
                    group_tokens, group_tokens + 50, provider_capacity * 4,
                    RuntimeError("maximum context length"),
                )
            return parts[0][:200]

        monkeypatch.setattr(comp, "_synthesize_chunks", fake_synthesize)

        parts = [f"seg-{i} " + "v " * 300 for i in range(10)]
        result = asyncio.run(comp._reduce_recalibrating(
            parts, max_tokens=400, model_id="m-reduce",
        ))
        assert result
        assert ModelContextRegistry().observed_input_limit("m-reduce") == provider_capacity * 4

    def test_stalled_round_joins_verbatim(self, monkeypatch):
        """If synthesis cannot shrink parts, they are joined losslessly — never cut."""
        monkeypatch.setenv("VINV_ENGINE_MODEL_FALLBACK_LIMIT", "8000")
        monkeypatch.setenv("VINV_ENGINE_MAX_SYNTHESIS_ROUNDS", "3")
        comp = uc.UnifiedCompressor(enable_caching=False)
        monkeypatch.setattr(comp, "_compress_direct", _identity_compress)

        async def broken_synthesize(parts, max_tokens, goal=""):
            raise ValueError("model returned garbage")  # non-overflow failure

        monkeypatch.setattr(comp, "_synthesize_chunks", broken_synthesize)

        parts = [f"keep-{i} " + "u " * 100 for i in range(6)]
        result = asyncio.run(comp._reduce_recalibrating(
            parts, max_tokens=50, model_id="m-stall",
        ))
        for i in range(6):
            assert f"keep-{i}" in result, "verbatim join must preserve every part"


class TestDirectCompressOverflowSignal:
    def test_compress_direct_raises_typed_overflow(self, monkeypatch):
        """A provider overflow inside _compress_direct becomes _ContextOverflow
        with parsed numbers — it is not retried as-is."""
        comp = uc.UnifiedCompressor(enable_caching=False)
        attempts = {"n": 0}

        class FakeCompressor:
            def __call__(self, **kwargs):
                attempts["n"] += 1
                raise RuntimeError(
                    "This model's maximum context length is 272000 tokens. "
                    "However, your messages resulted in 277851 tokens."
                )

        monkeypatch.setattr(comp, "_goal_compressor", None)
        monkeypatch.setattr(comp, "_legacy_compressor", FakeCompressor())

        with pytest.raises(uc._ContextOverflow) as exc_info:
            asyncio.run(comp._compress_direct("content " * 1000, max_tokens=100))

        assert attempts["n"] == 1, "oversized request must NOT be retried unchanged"
        assert exc_info.value.reported_limit == 272000
        assert exc_info.value.reported_tokens == 277851

    def test_transient_failure_returns_chunk_verbatim(self, monkeypatch):
        """Non-overflow failure after retries keeps the chunk lossless."""
        comp = uc.UnifiedCompressor(enable_caching=False)

        class FlakyCompressor:
            def __call__(self, **kwargs):
                raise ConnectionError("upstream connect error")

        monkeypatch.setattr(comp, "_goal_compressor", None)
        monkeypatch.setattr(comp, "_legacy_compressor", FlakyCompressor())

        content = "important evidence " * 200
        out = asyncio.run(comp._compress_direct(content, max_tokens=50))
        assert out == content


# ---------------------------------------------------------------------------
# Artifact-backed observations for massive outputs (grep, don't compress)
# ---------------------------------------------------------------------------

class TestLogArtifact:
    def test_full_content_preserved_on_disk(self, tmp_path, monkeypatch):
        from core.components.context_compressor import log_artifact

        monkeypatch.setenv("VINV_ENGINE_ARTIFACT_DIR", str(tmp_path))
        lines = [f"line-{i} normal output" for i in range(50000)]
        lines[123] = "ERROR: connection refused to db:5432"
        lines[40000] = "Traceback (most recent call last):"
        content = "\n".join(lines)

        digest = log_artifact.store_and_digest(content, "terminal-cmd", 5000)

        artifacts = list(tmp_path.glob("*.log"))
        assert len(artifacts) == 1
        assert artifacts[0].read_text() == content, "artifact must be byte-exact"

    def test_digest_contains_path_head_tail_diagnostics(self, tmp_path, monkeypatch):
        from core.components.context_compressor import log_artifact

        monkeypatch.setenv("VINV_ENGINE_ARTIFACT_DIR", str(tmp_path))
        lines = [f"line-{i}" for i in range(50000)]
        # Deep in the body — far outside the head/tail windows.
        lines[25000] = "ERROR: connection refused to db:5432"
        content = "\n".join(lines)

        digest = log_artifact.store_and_digest(content, "terminal-cmd", 5000)

        artifact_path = str(next(tmp_path.glob("*.log")))
        assert artifact_path in digest, "digest must point at the artifact"
        assert "grep -n" in digest, "digest must teach grep-based investigation"
        assert "line-0" in digest, "head must be present"
        assert "line-49999" in digest, "tail must be present"
        assert "connection refused" in digest, "diagnostic lines must surface"
        assert "25001:" in digest, "diagnostic lines carry line numbers for sed/grep"

    def test_digest_respects_token_budget(self, tmp_path, monkeypatch):
        from core.components.context_compressor import log_artifact

        monkeypatch.setenv("VINV_ENGINE_ARTIFACT_DIR", str(tmp_path))
        content = "\n".join("word " * 20 for _ in range(200000))  # ~4M tokens
        budget = 8000
        digest = log_artifact.store_and_digest(content, "flood", budget)
        # Head/tail/diagnostics are line-derived; allow modest overhead.
        assert count_tokens(digest) <= budget * 2, (
            f"digest {count_tokens(digest)} tokens far exceeds budget {budget}"
        )

    def test_incident_scale_17M_tokens_no_llm_needed(self, tmp_path, monkeypatch):
        """The incident's 17.5M-token capture becomes a bounded digest with
        zero LLM calls — investigation happens via grep on the artifact."""
        from core.components.context_compressor import log_artifact

        monkeypatch.setenv("VINV_ENGINE_ARTIFACT_DIR", str(tmp_path))
        # ~17.5M tokens ≈ 70M chars (token ≈ chars/4, consistently).
        block = ("x" * 69 + "\n") * 1000  # 70K chars
        content = block * 1000  # 70M chars
        assert count_tokens(content) >= 17_000_000

        digest = log_artifact.store_and_digest(content, "monster", 50000)
        assert count_tokens(digest) <= 100000
        assert "STORED AS ARTIFACT" in digest


# ---------------------------------------------------------------------------
# Multi-condition stress review (the "A-team" pass): different providers,
# different windows, different failure shapes — same guarantees.
# ---------------------------------------------------------------------------

class TestStressConditions:
    @pytest.mark.parametrize(
        "window,provider_message",
        [
            (272000, "This model's maximum context length is {limit} tokens. "
                     "However, your messages resulted in {count} tokens."),
            (200000, "prompt is too long: {count} tokens > {limit} maximum"),
            (131072, "input length exceeds the maximum of {limit} tokens "
                     "(requested {count})"),
        ],
    )
    def test_any_provider_error_shape_recalibrates(
        self, monkeypatch, window, provider_message,
    ):
        comp = _make_compressor(monkeypatch, fallback_limit=1000000)  # wrong prior
        provider_content_capacity = window // 4

        async def fake_compress_direct(content, max_tokens, **kwargs):
            tokens = count_tokens(content)
            if tokens > provider_content_capacity:
                err = RuntimeError(
                    provider_message.format(limit=window, count=tokens + 500)
                )
                reported, limit = uc._parse_overflow_numbers(err)
                raise uc._ContextOverflow(tokens, reported, limit, err)
            return content.split("\n", 1)[0]

        async def fake_synthesize(parts, max_tokens, goal=""):
            return "\n".join(parts)

        monkeypatch.setattr(comp, "_compress_direct", fake_compress_direct)
        monkeypatch.setattr(comp, "_synthesize_chunks", fake_synthesize)

        content = "\n".join(f"E{i} " + "z " * 60 for i in range(30000))  # ~500K tokens
        result = asyncio.run(comp._map_reduce_recalibrating(
            content=content, max_tokens=5000, model_id=f"m-{window}",
        ))
        assert result
        assert ModelContextRegistry().observed_input_limit(f"m-{window}") == window

    def test_learned_numbers_prevent_repeat_failures_next_process(
        self, monkeypatch, tmp_path,
    ):
        """After one overflow, a NEW process must plan feasible chunks
        immediately from the persisted catalog — before any failure."""
        comp = _make_compressor(monkeypatch, fallback_limit=1000000)
        reg = ModelContextRegistry()
        reg.record_overflow("gpt-5.4-nano", 250000, 277851, 272000)

        # New process: fresh singleton loads the catalog from disk.
        ModelContextRegistry._instance = None
        comp2 = _make_compressor(monkeypatch, fallback_limit=1000000)
        inflation = 277851 / 250000
        expected = int(272000 * 0.25 / inflation)
        assert comp2._chunk_capacity("gpt-5.4-nano", 0.25) == expected
        assert expected < 272000 // 4 + 1, "capacity must respect the REAL window"

    def test_terminal_output_bounded_to_digest(self, tmp_path, monkeypatch):
        """Terminal captures above the inline threshold become log artifacts
        plus a grep-instruction digest — full output never enters context."""
        monkeypatch.setenv("VINV_ENGINE_ARTIFACT_DIR", str(tmp_path))
        monkeypatch.setenv("VINV_ENGINE_TERMINAL_INLINE_OUTPUT_TOKENS", "1000")
        from core.components.tools.terminal.terminal_tools import _bounded_output

        big = "\n".join(f"install line {i}" for i in range(20000))
        big += "\nERROR: dependency conflict detected\nfinal line"
        result = _bounded_output(
            {"status": "success", "output": big}, "terminal-cmd",
        )

        assert result["output"] != big, "raw megabytes must not pass through"
        assert count_tokens(result["output"]) < 5000
        assert "grep -n" in result["output"]
        assert "ERROR: dependency conflict" in result["output"]
        assert result["output_log"], "artifact path must be exposed"
        assert Path(result["output_log"]).read_text() == big, "log is lossless"

    def test_terminal_small_output_passes_through(self, monkeypatch):
        from core.components.tools.terminal.terminal_tools import _bounded_output
        small = {"status": "success", "output": "ok\n"}
        assert _bounded_output(dict(small), "terminal-cmd") == small

    def test_cancellation_mid_map_returns_promptly(self, monkeypatch):
        comp = _make_compressor(monkeypatch)
        cancel = asyncio.Event()
        cancel.set()

        async def never_called(content, max_tokens, **kwargs):
            raise AssertionError("must not compress after cancellation")

        monkeypatch.setattr(comp, "_compress_direct", never_called)
        content = "\n".join("c " * 50 for _ in range(20000))
        result = asyncio.run(comp._map_reduce_recalibrating(
            content=content, max_tokens=100, model_id="m-cancel",
            cancel_event=cancel,
        ))
        assert result == content  # cancelled before any work — lossless
