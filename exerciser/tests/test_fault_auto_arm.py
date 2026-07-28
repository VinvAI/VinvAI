"""The fault oracle has to arm itself, and only where it can be honest.

`boundaries.json` is hand-written and `--auto-target` has to be pointed at a
consumer by name, so on a repo nobody has prepared the oracle armed ZERO actions
and the campaign reported the vacuum in a note that no code path acted on.
Measured on a clone of langchain-ai/langchain: 2 of 6 oracles armed, and the
fault oracle was never one of them.

Deriving from the consumers' own annotations closes that — but only under the
gate this file exists to pin. The first derivation had none, and it produced six
findings that the harness caused itself: for
`validate_hostname(hostname: str, policy: SSRFPolicy)` there is no value the
harness can build for `policy`, so the baseline carried the string family's
`"vinv"`, the first attribute access raised `AttributeError`, and that was
reported as a defect in the target. `annotation_resolved` is the same honesty
gate the function channel applies, and deriving a contract it cannot satisfy is
worse than deriving nothing.
"""

from __future__ import annotations

from pathlib import Path

from exerciser.faults import derive_boundaries

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
'''


def _repo(tmp_path: Path) -> Path:
    pkg = tmp_path / "targetpkg"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "edges.py").write_text(_PKG, encoding="utf-8")
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "targetpkg"\n', encoding="utf-8")
    return tmp_path


def test_a_boundary_is_derived_when_every_annotation_is_satisfiable(tmp_path: Path):
    derived = derive_boundaries(_repo(tmp_path), ["targetpkg.edges:all_resolvable"])
    assert [b.target for b in derived] == ["targetpkg.edges:all_resolvable"]
    boundary = derived[0]
    assert set(boundary.contract) == {"name", "count", "tags"}
    # A fault replaces ONE field of a WELL-FORMED payload, so every other
    # required parameter has to be present or the call dies in the signature.
    assert set(boundary.baseline) == {"name", "count", "tags"}


def test_an_unsatisfiable_annotation_is_refused_not_guessed_at(tmp_path: Path):
    """The regression: passing `"vinv"` for `policy: SSRFPolicy` makes the
    consumer raise on the harness's own value, which is not a defect."""
    derived = derive_boundaries(_repo(tmp_path), ["targetpkg.edges:has_opaque_parameter"])
    assert derived == []


def test_an_unannotated_consumer_yields_no_contract(tmp_path: Path):
    assert derive_boundaries(_repo(tmp_path), ["targetpkg.edges:unannotated"]) == []


def test_derivation_is_per_target_so_one_refusal_does_not_disarm_the_rest(tmp_path: Path):
    repo = _repo(tmp_path)
    derived = derive_boundaries(
        repo,
        [
            "targetpkg.edges:has_opaque_parameter",
            "targetpkg.edges:all_resolvable",
            "targetpkg.edges:unannotated",
        ],
    )
    assert [b.target for b in derived] == ["targetpkg.edges:all_resolvable"]
