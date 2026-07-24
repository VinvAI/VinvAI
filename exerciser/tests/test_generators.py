"""Optional OSS generator adapter — install-safe, deterministic when present."""

from __future__ import annotations

from exerciser.generators import hypothesis_valid_available, hypothesis_valid_instance


def test_availability_probe_never_raises():
    # Whether or not the optional dep is installed, the probe returns a bool.
    assert isinstance(hypothesis_valid_available(), bool)


def test_instance_returns_none_when_unavailable_or_deterministic_when_present():
    schema = {"type": "object", "required": ["n"], "properties": {"n": {"type": "integer"}}}
    a = hypothesis_valid_instance(schema, 5)
    if not hypothesis_valid_available():
        assert a is None  # install-safe fallback
    else:
        b = hypothesis_valid_instance(schema, 5)
        assert a == b  # deterministic per (schema, seed)
        assert isinstance(a, dict) and "n" in a
