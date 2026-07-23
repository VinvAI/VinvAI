from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from tracelens.enrich.summaries import summarize
from tracelens.launcher.determinism_capture import _open_secure_append


def test_string_summaries_are_hash_only_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("TRACELENS_CAPTURE_VALUE_HEAD", raising=False)
    summary = summarize("sk-live-secret", label="api_key")
    assert summary["len"] == 14
    assert summary["redacted"] is True
    assert "head" not in summary
    assert "sk-live-secret" not in str(summary)


def test_raw_string_heads_require_explicit_opt_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TRACELENS_CAPTURE_VALUE_HEAD", "1")
    assert summarize("debug-value", label="value")["head"] == "debug-value"


def test_sensitive_dictionary_key_names_are_redacted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("TRACELENS_CAPTURE_VALUE_HEAD", raising=False)
    summary = summarize({"authorization": "secret", "count": 1})
    assert summary["keys_head"] == ["<redacted>", "count"]


@pytest.mark.skipif(
    os.name == "nt",
    reason="POSIX permission bits; Windows reports 0o666-style modes and access is ACL-based",
)
def test_determinism_sidecar_is_owner_only(tmp_path: Path) -> None:
    target = tmp_path / "trace.jsonl.determinism.jsonl"
    handle = _open_secure_append(target)
    handle.write("{}\n")
    handle.close()
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
