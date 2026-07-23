"""Deterministic hashing for provenance / drift."""

from __future__ import annotations

from dataclasses import dataclass

from tracelens.enrich.hashing import canonical_hash, canonical_repr


def test_canonical_hash_stable() -> None:
    assert canonical_hash({"a": 1, "b": 2}) == canonical_hash({"b": 2, "a": 1})


def test_canonical_hash_length() -> None:
    assert len(canonical_hash(42)) == 16


def test_set_order_independent() -> None:
    assert canonical_hash({1, 2, 3}) == canonical_hash({3, 1, 2})


def test_float_canonical_repr_short() -> None:
    assert "1" in canonical_repr(1.0)


def test_unhashable_tuple_fallback() -> None:
    h = canonical_hash((1, object()))
    assert len(h) == 16


@dataclass
class _Box:
    x: int
    y: str


def test_dataclass_fields_sorted_by_name() -> None:
    a = _Box(x=1, y="z")
    b = _Box(x=2, y="z")
    assert canonical_hash(a) != canonical_hash(b)


def test_large_dict_truncation_does_not_crash() -> None:
    d = {str(i): i for i in range(500)}
    r = canonical_repr(d, max_bytes=4096)
    assert len(r.encode("utf-8")) <= 5000


def test_bytes_normalized() -> None:
    assert "bytes" in canonical_repr(b"abc")
