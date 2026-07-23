"""Regression: determinism capture of RNG return values must handle uuid.UUID.

``uuid.UUID.hex`` is a *property* returning str, not a method. The wrapper used
``v.hex()`` for bytes/bytearray/UUID alike, so every request that generated a
``uuid.uuid4()`` (e.g. request-id middleware) hit ``TypeError: 'str' object is not
callable`` and returned HTTP 500. Each RNG value type must serialize cleanly.
"""

from __future__ import annotations

import hashlib
import uuid

import pytest

from tracelens.launcher import determinism_capture as dc


@pytest.fixture
def _captured(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    recs: list[dict] = []
    monkeypatch.delenv("TRACELENS_RAW_DETERMINISM_VALUES", raising=False)
    monkeypatch.setattr(dc, "_current_request_id", lambda: "req-1")
    monkeypatch.setattr(dc, "record_determinism_source", lambda *a, **k: None)
    monkeypatch.setattr(dc, "_emit", lambda rec: recs.append(rec))
    return recs


def test_uuid_return_value_does_not_crash(_captured: list[dict]) -> None:
    fixed = uuid.UUID("12345678123456781234567812345678")
    wrapped = dc._wrap_rng("uuid.uuid4", lambda: fixed)
    out = wrapped()  # previously raised TypeError: 'str' object is not callable
    assert out is fixed  # real value passes through unchanged
    assert "payload" not in _captured[0]
    assert _captured[0]["payload_sha256"] == hashlib.sha256(
        fixed.hex.encode()
    ).hexdigest()


def test_bytes_return_value_hex_encoded(_captured: list[dict]) -> None:
    wrapped = dc._wrap_rng("secrets.token_bytes", lambda n=4: b"\xde\xad\xbe\xef")
    assert wrapped() == b"\xde\xad\xbe\xef"
    assert _captured[0]["payload_len"] == 8
    assert "deadbeef" not in str(_captured[0])


def test_other_return_value_stringified(_captured: list[dict]) -> None:
    wrapped = dc._wrap_rng("random.randint", lambda a, b: 42)
    assert wrapped(1, 100) == 42
    assert _captured[0]["payload_len"] == 2


def test_raw_payload_is_available_only_by_explicit_opt_in(
    monkeypatch: pytest.MonkeyPatch, _captured: list[dict]
) -> None:
    monkeypatch.setenv("TRACELENS_RAW_DETERMINISM_VALUES", "1")
    wrapped = dc._wrap_rng("secrets.token_hex", lambda n=4: "secret-value")
    assert wrapped() == "secret-value"
    assert _captured[0]["payload"] == "secret-value"


def test_clock_values_are_hashed_by_default(_captured: list[dict]) -> None:
    wrapped = dc._wrap_clock("time.time", lambda: 1752561000.123456)
    assert wrapped() == 1752561000.123456  # real value passes through unchanged
    record = _captured[0]
    assert "value" not in record
    assert record["payload_sha256"] == hashlib.sha256(
        repr(1752561000.123456).encode()
    ).hexdigest()


def test_clock_raw_value_requires_explicit_opt_in(
    monkeypatch: pytest.MonkeyPatch, _captured: list[dict]
) -> None:
    monkeypatch.setenv("TRACELENS_RAW_DETERMINISM_VALUES", "1")
    wrapped = dc._wrap_clock("time.monotonic", lambda: 12.5)
    assert wrapped() == 12.5
    assert _captured[0]["value"] == 12.5
