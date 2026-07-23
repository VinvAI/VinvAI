"""icontract-based invariant helper (spec §12.1)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


def invariant(**kwargs: Any) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    try:
        import icontract

        def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
            return icontract.invariant(**kwargs)(fn)  # type: ignore[type-var]

        return deco
    except Exception:

        def noop(fn: Callable[..., Any]) -> Callable[..., Any]:
            return fn

        return noop
