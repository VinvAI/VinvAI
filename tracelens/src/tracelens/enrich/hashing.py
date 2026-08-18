"""Deterministic BLAKE2b hash for args/results."""

from __future__ import annotations

import hashlib
from dataclasses import fields, is_dataclass
from typing import Any


def _repr_part(x: Any, budget: list[int]) -> str:
    if budget[0] <= 0:
        return "…[truncated]"
    if x is None:
        return "None"
    if isinstance(x, bool):
        return "True" if x else "False"
    if isinstance(x, int):
        return str(x)
    if isinstance(x, float):
        return f"{x:.12g}"
    if isinstance(x, str):
        s = repr(x)
        if len(s) > 256:
            s = s[:256] + "…"
            budget[0] -= 256
        else:
            budget[0] -= len(s)
        return s
    if isinstance(x, bytes | bytearray):
        budget[0] -= 20
        return f"bytes(len={len(x)})"
    if isinstance(x, dict):
        parts = []
        for k in sorted(x.keys(), key=lambda z: str(z)):
            if budget[0] <= 0:
                parts.append("…")
                break
            parts.append(f"{_repr_part(k, budget)}:{_repr_part(x[k], budget)}")
        return "{" + ",".join(parts) + "}"
    if isinstance(x, list | tuple):
        budget[0] -= 2
        inner = ",".join(_repr_part(i, budget) for i in x[:64])
        if len(x) > 64:
            inner += ",…"
        return "(" + inner + ")" if isinstance(x, tuple) else "[" + inner + "]"
    if isinstance(x, set):
        budget[0] -= 2
        items = sorted(x, key=lambda z: str(z))
        return "{" + ",".join(_repr_part(i, budget) for i in items[:128]) + "}"
    if is_dataclass(x) and not isinstance(x, type):
        parts = []
        for f in fields(x):
            if budget[0] <= 0:
                break
            parts.append(f"{f.name}={_repr_part(getattr(x, f.name), budget)}")
        return x.__class__.__name__ + "(" + ",".join(parts) + ")"
    budget[0] -= 40
    return f"<{type(x).__name__}>"


def canonical_repr(value: Any, max_bytes: int = 4096) -> str:
    budget = [max_bytes]
    r = _repr_part(value, budget)
    enc = r.encode("utf-8", errors="replace")
    if len(enc) > max_bytes:
        enc = enc[:max_bytes] + b"\xe2\x80\xa6[truncated]"
    return enc.decode("utf-8", errors="replace")


def canonical_hash(value: Any) -> str:
    try:
        payload = canonical_repr(value).encode("utf-8", errors="replace")
        h = hashlib.blake2b(payload, digest_size=8).hexdigest()
        return h[:16]
    except Exception:
        return "unhashable00000"[:16]


def type_schema_str(value: Any) -> str:
    try:
        return type(value).__name__
    except Exception:
        return "Any"
