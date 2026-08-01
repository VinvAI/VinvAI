"""The rendering contract, driven by the vectors all three implementations share.

There is no type system linking bring-up's renderer, the exerciser's and the
extension's — but the whole value of a recorded invocation is that the command a
human runs is the command the exercise pass measured and the command bring-up
verified. So the linkage is these vectors: every suite reads the same file, and a
change made on one side and not the others fails here.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from exerciser.invocation_render import (
    InvocationRenderError,
    default_args,
    defaults_match_verified,
    render_invocation,
    shell_quote,
    to_bash_path,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS = REPO_ROOT / "contracts" / "vectors" / "invocation_render.json"


def _vectors() -> dict:
    return json.loads(VECTORS.read_text(encoding="utf-8"))


def test_vectors_file_exists() -> None:
    # A missing vectors file would silently turn every parametrized case below
    # into "collected 0 items", which reads as a pass.
    assert VECTORS.is_file(), f"shared render vectors missing at {VECTORS}"


@pytest.mark.parametrize("case", _vectors()["render"], ids=lambda c: c["name"])
def test_render_vectors(case: dict) -> None:
    assert render_invocation(case["invocation"], case["args"]) == case["expected"]


@pytest.mark.parametrize("case", _vectors()["error"], ids=lambda c: c["name"])
def test_error_vectors(case: dict) -> None:
    with pytest.raises(InvocationRenderError) as excinfo:
        render_invocation(case["invocation"], case["args"])
    assert case["message"] in str(excinfo.value)


def test_python_renderers_are_byte_identical() -> None:
    """The exerciser's copy must not drift from this one.

    The two packages deliberately do not import each other, so the duplication is
    intentional — but an edit to one copy alone is exactly the failure the shared
    vectors cannot catch when both suites happen to run against stale bytes.
    """
    mine = (REPO_ROOT / "bringup" / "src" / "bringup" / "invocation_render.py").read_bytes()
    theirs = (REPO_ROOT / "exerciser" / "src" / "exerciser" / "invocation_render.py").read_bytes()
    assert mine == theirs, (
        "bringup/invocation_render.py and exerciser/invocation_render.py have "
        "diverged — copy one over the other so both surfaces render identically"
    )


def test_shell_quote_leaves_ordinary_tokens_bare() -> None:
    # This is what keeps a defaults render byte-identical to the verified string.
    assert shell_quote("--since") == "--since"
    assert shell_quote("7d") == "7d"
    assert shell_quote("/c/repo/.venv/Scripts/python.exe") == "/c/repo/.venv/Scripts/python.exe"
    assert shell_quote("two words") == "'two words'"


def test_to_bash_path_is_platform_independent() -> None:
    # Keyed off the value's shape, never os.name — the vectors must give the same
    # answer on the Linux CI box and the Windows dev machine.
    assert to_bash_path(r"C:\Users\dev") == "/c/Users/dev"
    assert to_bash_path("C:/Users/dev") == "/c/Users/dev"
    assert to_bash_path("/already/posix") == "/already/posix"


def test_defaults_must_reproduce_the_verified_string() -> None:
    inv = {
        "id": "report",
        "command": "acme-tool report --since {since}",
        "params": [{"name": "since", "default": "7d"}],
        "verification": {"rendered_command": "acme-tool report --since 7d"},
    }
    assert defaults_match_verified(inv)
    assert render_invocation(inv, default_args(inv)) == "acme-tool report --since 7d"

    # Change the default and the record no longer attests to what it ran: the
    # command on file was verified with 7d, so claiming 30d is verified is a lie.
    drifted = {**inv, "params": [{"name": "since", "default": "30d"}]}
    assert not defaults_match_verified(drifted)


def test_a_record_without_a_rendered_command_makes_no_claim() -> None:
    # Every unit brought up before parameters existed must keep working.
    assert defaults_match_verified({"id": "old", "command": "acme-tool report"})
