"""Optional oracle for outcomes CLI tests."""

from __future__ import annotations

from typing import Any


def oracle_ok(spans: list[dict[str, Any]]) -> bool:
    return True
