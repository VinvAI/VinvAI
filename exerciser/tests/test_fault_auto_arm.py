"""The fault oracle has to arm itself, and only where it can be honest.

`boundaries.json` is hand-written and `--auto-target` has to be pointed at a
consumer by name, so on a repo nobody has prepared the oracle armed ZERO actions
and the campaign reported the vacuum in a note that no code path acted on.
Measured on a clone of langchain-ai/langchain: 2 of 6 oracles armed, and the
fault oracle was never one of them.

Deriving from the consumers' own annotations closes that — but only under the
gate this file exists to pin, which has two halves.

The first: a contract the harness cannot SATISFY is worse than no contract. For
`validate_hostname(hostname: str, policy: SSRFPolicy)` there is no value the
harness can build for `policy`, so the baseline carried the string family's
`"vinv"`, the first attribute access raised `AttributeError`, and that was
reported as a defect in the target. `annotation_resolved` is the same honesty
gate the function channel applies.

The second: a contract the harness cannot COMPLETE is dead rather than false,
and dead silently, which is worse than loud. An unannotated parameter is dropped
from the contract, so `def f(a: str, helper)` derived `{"a": "str"}` and passed
the first gate — then every fault built on it omitted `helper`, died in the
signature with `TypeError`, and `TypeError` is a typed rejection, i.e. recorded
as the consumer correctly refusing the shape. Same shape as the `baseline={}`
bug `baseline_from_contract` was written to fix, and anti-correlated with code
quality in the same way: the less annotated the repo, the more certainly it
reports clean. Measured on a 50-target mix, 17 boundaries were derived in that
state and nothing said so.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from exerciser.faults import (
    SKIP_NO_ANNOTATION,
    SKIP_UNDESCRIBABLE,
    SKIP_UNSATISFIABLE,
    derive_boundaries,
)

_PKG = '''\
from __future__ import annotations


def all_resolvable(name: str, count: int, tags: list) -> str:
    """Every annotation is one the harness can build a real value for."""
    return f"{name}:{count}:{len(tags)}"


def has_opaque_parameter(hostname: str, policy: SSRFPolicy) -> None:
    """`policy` is a class the harness has no instance of."""
    if policy.block_localhost:
        raise ValueError(hostname)


def unannotated(a, b):
    return a


def partly_annotated(name: str, helper) -> str:
    """`helper` is REQUIRED and unannotated — no contract can supply it."""
    return f"{name}{helper}"


def annotated_with_optional_extra(name: str, retries=3) -> str:
    """`retries` is unannotated but OPTIONAL, so omitting it is a legal call."""
    return name * retries
'''

_ALL_TARGETS = [
    "targetpkg.edges:all_resolvable",
    "targetpkg.edges:has_opaque_parameter",
    "targetpkg.edges:unannotated",
    "targetpkg.edges:partly_annotated",
    "targetpkg.edges:annotated_with_optional_extra",
]


def _repo(tmp_path: Path) -> Path:
    pkg = tmp_path / "targetpkg"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "edges.py").write_text(_PKG, encoding="utf-8")
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "targetpkg"\n', encoding="utf-8")
    return tmp_path


_REACHABILITY_PROBE = """\
import importlib, json, sys
sys.path.insert(0, sys.argv[1])
mod, _, qual = sys.argv[2].partition(':')
fn = getattr(importlib.import_module(mod), qual)
try:
    fn(**json.loads(sys.argv[3]))
except TypeError as exc:
    # The one failure this asks about: the call died in the SIGNATURE, so the
    # target's own first line never ran. Any other exception means the harness
    # reached the code, which is all a boundary has to promise.
    if 'required positional argument' in str(exc) or 'required keyword-only' in str(exc):
        print('UNREACHABLE')
        raise SystemExit(0)
except BaseException:
    pass
print('REACHED')
"""


def _reaches_target(repo: Path, target: str, payload: dict) -> bool:
    proc = subprocess.run(
        [sys.executable, "-c", _REACHABILITY_PROBE, str(repo), target, json.dumps(payload)],
        capture_output=True,
        text=True,
    )
    return proc.stdout.strip() == "REACHED"


# =========================================================================
# Gate one: a contract the harness cannot satisfy
# =========================================================================


def test_a_boundary_is_derived_when_every_annotation_is_satisfiable(tmp_path: Path):
    derived, skipped = derive_boundaries(_repo(tmp_path), ["targetpkg.edges:all_resolvable"])
    assert [b.target for b in derived] == ["targetpkg.edges:all_resolvable"]
    assert skipped == {}
    boundary = derived[0]
    assert set(boundary.contract) == {"name", "count", "tags"}
    # A fault replaces ONE field of a WELL-FORMED payload, so every other
    # required parameter has to be present or the call dies in the signature.
    assert set(boundary.baseline) == {"name", "count", "tags"}


def test_an_unsatisfiable_annotation_is_refused_not_guessed_at(tmp_path: Path):
    """The regression: passing `"vinv"` for `policy: SSRFPolicy` makes the
    consumer raise on the harness's own value, which is not a defect."""
    derived, skipped = derive_boundaries(_repo(tmp_path), ["targetpkg.edges:has_opaque_parameter"])
    assert derived == []
    assert skipped == {"targetpkg.edges:has_opaque_parameter": SKIP_UNSATISFIABLE}


def test_an_unannotated_consumer_yields_no_contract(tmp_path: Path):
    derived, skipped = derive_boundaries(_repo(tmp_path), ["targetpkg.edges:unannotated"])
    assert derived == []
    assert skipped == {"targetpkg.edges:unannotated": SKIP_NO_ANNOTATION}


# =========================================================================
# Gate two: a contract the harness cannot complete
# =========================================================================


def test_a_required_unannotated_parameter_refuses_the_whole_boundary(tmp_path: Path):
    """`partly_annotated(name: str, helper)` PASSES the first gate.

    Its one annotation is satisfiable, so `annotation_resolved` says yes. But a
    payload built from the contract alone omits `helper`, every fault raises
    `TypeError` in the signature, and `TypeError` is a typed rejection — so the
    boundary can never fire and never says so.
    """
    repo = _repo(tmp_path)
    derived, skipped = derive_boundaries(repo, ["targetpkg.edges:partly_annotated"])
    assert derived == []
    assert skipped == {"targetpkg.edges:partly_annotated": SKIP_UNDESCRIBABLE}
    # And the reason is measured, not asserted: the payload the ungated version
    # would have armed does not reach the target.
    assert not _reaches_target(repo, "targetpkg.edges:partly_annotated", {"name": "vinv"})


def test_an_unannotated_parameter_with_a_default_is_not_a_blocker(tmp_path: Path):
    """Only REQUIRED ones are.

    Omitting an optional parameter is a legal call, so refusing here would cost
    coverage for nothing.
    """
    repo = _repo(tmp_path)
    derived, skipped = derive_boundaries(repo, ["targetpkg.edges:annotated_with_optional_extra"])
    assert [b.target for b in derived] == ["targetpkg.edges:annotated_with_optional_extra"]
    assert set(derived[0].baseline) == {"name"}
    assert skipped == {}
    assert _reaches_target(repo, derived[0].target, derived[0].baseline)


def test_every_derived_boundary_can_actually_reach_its_target(tmp_path: Path):
    """The property, stated once over the whole fixture.

    A boundary whose baseline cannot be passed to its own target is not a
    boundary — it is budget the campaign spends on a call that dies before the
    target's first line, recorded as the consumer correctly refusing a shape.
    """
    repo = _repo(tmp_path)
    derived, skipped = derive_boundaries(repo, _ALL_TARGETS)

    assert len(derived) + len(skipped) == len(_ALL_TARGETS), "every target is accounted for"
    assert derived, "the gate must not be so tight that nothing arms"
    for boundary in derived:
        assert _reaches_target(repo, boundary.target, boundary.baseline), (
            f"{boundary.target} cannot be called with its own baseline"
        )


# =========================================================================
# Per-target, and once
# =========================================================================


def test_derivation_is_per_target_so_one_refusal_does_not_disarm_the_rest(tmp_path: Path):
    repo = _repo(tmp_path)
    derived, skipped = derive_boundaries(
        repo,
        [
            "targetpkg.edges:has_opaque_parameter",
            "targetpkg.edges:all_resolvable",
            "targetpkg.edges:unannotated",
        ],
    )
    assert [b.target for b in derived] == ["targetpkg.edges:all_resolvable"]
    assert set(skipped) == {
        "targetpkg.edges:has_opaque_parameter",
        "targetpkg.edges:unannotated",
    }


def test_the_whole_catalogue_is_read_in_one_subprocess(tmp_path: Path, monkeypatch):
    """Reading a signature IMPORTS the module that defines it.

    One subprocess per target cost 0.35s each on a trivial module — 17s for a
    campaign's 50 — and re-imported the same modules 50 times over, all of it
    inside `enumerate_actions`, before a single unit of budget was spent.
    """
    from exerciser import faults as faults_module

    calls = 0
    real = faults_module.subprocess.run

    def counting(*args, **kwargs):
        nonlocal calls
        calls += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(faults_module.subprocess, "run", counting)
    derived, skipped = derive_boundaries(_repo(tmp_path), _ALL_TARGETS)

    assert len(derived) + len(skipped) == len(_ALL_TARGETS)
    assert calls == 1, f"{calls} subprocesses to read one catalogue"
