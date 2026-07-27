"""The purity guard must fail CLOSED on unread code (audit COR-26 + `_is_write_open`).

COR-26 was the most severe item in the register, with a live proof: `run_functions`
actually wrote outside the repo, twice, unsandboxed. A function calling an
imported first-party callable was judged pure:

    from mypkg.db import wipe_all
    def process():          # innocuous name, no local impurity
        wipe_all()          # -> impurities == []  -> called IN-PROCESS

Two compounding causes: `_dotted_reason` is an allowlist of *impurity*, so
"not on my list" meant "pure"; and resolving an import was treated as
verification, when knowing where a name came from says nothing about what it
does. The transitive analyser only walks defs in the SAME source string, so a
sibling module's body is unreadable by construction.

The prior example was caught only incidentally — the wrapper was named `push`,
and the destructive-VERB vocabulary flagged the name. Rename it to anything
ordinary and both guards miss. Every wrapper below is deliberately innocuous so
the name heuristic cannot rescue the test.

A second, independent hole found during validation: `_is_write_open` read the
mode from `args[1]` (the builtin `open(file, mode)` convention), so the method
spelling `Path.open('w')` — mode at `args[0]` — was judged pure.
"""

from __future__ import annotations

import pytest

from exerciser.functions import impurities_in_source


def _reasons(src: str, fn: str = "process") -> list[str]:
    return impurities_in_source(src, fn)


class TestCrossModuleCallsFailClosed:
    """Every shape that reaches a sibling module's body."""

    @pytest.mark.parametrize(
        ("label", "src"),
        [
            ("from-import", "from mypkg.db import wipe_all\ndef process():\n    wipe_all()\n"),
            ("dotted attribute", "import mypkg.db\ndef process():\n    mypkg.db.wipe_all()\n"),
            ("aliased module", "import mypkg.db as d\ndef process():\n    d.wipe_all()\n"),
            ("relative from-import", "from .db import wipe_all\ndef process():\n    wipe_all()\n"),
            ("relative package", "from . import db\ndef process():\n    db.wipe_all()\n"),
            ("deep relative", "from ..pkg.db import wipe_all\ndef process():\n    wipe_all()\n"),
        ],
    )
    def test_an_unread_callee_is_refused(self, label: str, src: str) -> None:
        assert _reasons(src), f"{label}: unread cross-module callee must not be judged pure"

    def test_an_innocuous_name_cannot_rescue_a_destructive_callee(self) -> None:
        """The name vocabulary is a backstop, not the guard."""
        src = "from mypkg.db import wipe_all\ndef apply_retention():\n    wipe_all()\n"
        assert _reasons(src, "apply_retention")

    def test_a_third_party_callee_is_also_unverified(self) -> None:
        src = "import boto3\ndef process():\n    boto3.client('s3').upload_file('a', 'b', 'c')\n"
        assert _reasons(src)


class TestKnownPureCodeIsStillDrivable:
    """The precision half: refusing everything would be a useless 'fix'."""

    @pytest.mark.parametrize(
        "src",
        [
            "from math import sqrt\ndef process(x):\n    return sqrt(x)\n",
            "import math\ndef process(x):\n    return math.floor(x)\n",
            "import json\ndef process(s):\n    return json.dumps(s)\n",
            "from typing import Any\ndef process(x: Any):\n    return x\n",
        ],
    )
    def test_stdlib_calls_remain_pure(self, src: str) -> None:
        assert _reasons(src) == []

    def test_same_module_helpers_remain_pure(self) -> None:
        src = "def helper(x):\n    return x + 1\ndef process(x):\n    return helper(x)\n"
        assert _reasons(src) == []

    def test_a_pure_function_with_no_calls_at_all(self) -> None:
        assert _reasons("def process(x):\n    return x * 2\n") == []

    def test_builtins_remain_pure(self) -> None:
        assert _reasons("def process(xs):\n    return sorted(len(x) for x in xs)\n") == []


class TestKnownImpureStillNamedPrecisely:
    """A known-dangerous stdlib callee keeps its specific reason, not the generic one."""

    def test_os_remove_reports_the_impure_module(self) -> None:
        reasons = _reasons("from os import remove\ndef process(p):\n    remove(p)\n")
        assert reasons and not any("not verified" in r for r in reasons)

    def test_subprocess_run_reports_the_impure_module(self) -> None:
        reasons = _reasons("import subprocess\ndef process():\n    subprocess.run(['ls'])\n")
        assert reasons and not any("not verified" in r for r in reasons)


class TestWriteOpenArity:
    """`_is_write_open` must understand both spellings of `open`."""

    @pytest.mark.parametrize("mode", ["w", "a", "x", "r+", "wb"])
    def test_the_builtin_spelling_is_caught(self, mode: str) -> None:
        src = f"def process(p):\n    open(p, {mode!r}).write('x')\n"
        assert any("writing" in r for r in _reasons(src))

    @pytest.mark.parametrize("mode", ["w", "a", "x", "r+", "wb"])
    def test_the_pathlib_method_spelling_is_caught(self, mode: str) -> None:
        """`p.open('w')` put mode at args[0]; reading args[1] saw no mode."""
        src = f"def process(p):\n    p.open({mode!r})\n"
        assert any("writing" in r for r in _reasons(src))

    def test_a_read_open_stays_pure_in_both_spellings(self) -> None:
        assert not any("writing" in r for r in _reasons("def process(p):\n    open(p, 'r')\n"))
        assert not any("writing" in r for r in _reasons("def process(p):\n    p.open('r')\n"))

    def test_a_bare_read_open_is_not_a_write(self) -> None:
        assert not any("writing" in r for r in _reasons("def process(p):\n    open(p)\n"))

    def test_a_computed_mode_is_treated_as_a_write(self) -> None:
        """The guard must not assume an unreadable mode is 'r'."""
        src = "def process(p, m):\n    p.open(m)\n"
        assert any("writing" in r for r in _reasons(src))

    def test_the_mode_keyword_is_honoured_in_both_spellings(self) -> None:
        assert any("writing" in r for r in _reasons("def process(p):\n    open(p, mode='w')\n"))
        assert any("writing" in r for r in _reasons("def process(p):\n    p.open(mode='w')\n"))
