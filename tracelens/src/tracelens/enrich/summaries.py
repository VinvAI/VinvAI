"""Bounded value summaries (spec §4.4).

T4.5 — ``byte_cap`` defaults to ``$TRACELENS_SUMMARY_BYTE_CAP`` if set, else 256.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any, cast

_SENSITIVE_NAME_PARTS = (
    "api_key",
    "apikey",
    "authorization",
    "credential",
    "password",
    "secret",
    "token",
)


def _default_byte_cap() -> int:
    raw = os.environ.get("TRACELENS_SUMMARY_BYTE_CAP")
    if not raw:
        return 256
    try:
        return max(64, int(raw))
    except ValueError:
        return 256


def _capture_value_heads() -> bool:
    return os.environ.get("TRACELENS_CAPTURE_VALUE_HEAD", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _sensitive_name(value: str) -> bool:
    lowered = value.lower()
    return any(part in lowered for part in _SENSITIVE_NAME_PARTS)


def summarize(
    value: Any, *, byte_cap: int | None = None, label: str | None = None
) -> dict[str, Any]:
    if byte_cap is None:
        byte_cap = _default_byte_cap()
    try:
        out: dict[str, Any]
        if value is None:
            out = {"type": "NoneType"}
        elif isinstance(value, bool):
            out = {"v": value}
        elif isinstance(value, int):
            out = {"v": value}
        elif isinstance(value, float):
            out = {"v": value}
        elif isinstance(value, str):
            out = {
                "len": len(value),
                "sha256": hashlib.sha256(value.encode("utf-8")).hexdigest()[:16],
            }
            if _capture_value_heads():
                out["head"] = value[:32]
            elif label and _sensitive_name(label):
                out["redacted"] = True
        elif isinstance(value, list | tuple):
            n = len(value)
            elem = type(value[0]).__name__ if n else None
            out = {"len": n, "elem_type": elem}
        elif isinstance(value, dict):
            keys = sorted(str(k) for k in value.keys())
            out = {
                "len": len(value),
                "keys_head": ["<redacted>" if _sensitive_name(key) else key for key in keys[:5]],
            }
        elif isinstance(value, bytes | bytearray):
            out = {"len": len(value)}
        else:
            mod = type(value).__module__
            name = type(value).__name__
            if mod.startswith("numpy") and name == "ndarray":
                arr = cast(Any, value)
                out = {"shape": list(arr.shape), "dtype": str(arr.dtype)}
            elif mod.startswith("pandas") and name == "DataFrame":
                df = cast(Any, value)
                cols = list(df.columns.astype(str))[:5]
                out = {"shape": [int(df.shape[0]), int(df.shape[1])], "cols_head": cols}
            else:
                out = {"type": name}
        raw = json.dumps(out, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(raw) > byte_cap:
            return {"truncated": True}
        return out
    except Exception as exc:
        return {"summary_error": type(exc).__name__}
