"""Differential oracle: a buggy evaluator disagrees with CPython, mechanically.

The class of defect this exists for: an evaluator/interpreter that computes a
DIFFERENT value (or rejects/accepts different programs) than the language it
claims to implement. No status code, exception, or learned invariant surfaces
it — only comparison against the reference does.
"""

from __future__ import annotations

import json
from pathlib import Path

from exerciser import store
from exerciser.differential import (
    AST_CORPUS,
    AST_CORPUS_RAISING,
    cluster_mismatches,
    judge_row,
    propose_references,
    run_differential,
)

# A miniature evaluator with two planted bugs of the smolagents class:
# `//` is rewritten to `/` (wrong value, silently), and lambdas are rejected
# (valid Python refused). Everything else defers to real exec.
_BUGGY_EVALUATOR = """\
def evaluate_code(code: str):
    if "lambda" in code:
        # An UNEXPLAINED refusal: no stated policy, so it reads as a defect.
        raise ValueError("internal error while evaluating")
    ns = {}
    exec(code.replace("//", "/"), ns)
    return (ns.get("result"), False)
"""

# Same refusal, but STATING a deliberate limit — the sandbox is allowed to
# say no, and saying so must not be reported as a bug.
_POLICY_EVALUATOR = """\
def evaluate_code(code: str):
    if "lambda" in code:
        raise ValueError("Lambda is not supported.")
    ns = {}
    exec(code, ns)
    return (ns.get("result"), False)
"""

_FAITHFUL_EVALUATOR = """\
def evaluate_code(code: str):
    ns = {}
    exec(code, ns)
    return (ns.get("result"), False)
"""


def _make_repo(tmp_path: Path, evaluator_src: str) -> Path:
    src = tmp_path / "src" / "engine"
    src.mkdir(parents=True)
    (src / "__init__.py").write_text("", encoding="utf-8")
    (src / "sandbox.py").write_text(evaluator_src, encoding="utf-8")
    index = tmp_path / ".vinv" / "index"
    index.mkdir(parents=True)
    (index / "chunks.jsonl").write_text(
        json.dumps(
            {
                "id": "src/engine/sandbox.py:evaluate_code",
                "file": "src/engine/sandbox.py",
                "lang": "python",
                "kind": "function",
                "name": "evaluate_code",
                "start_line": 1,
                "end_line": 5,
                "parent": None,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return tmp_path


# ---- judging (pure) --------------------------------------------------------


def test_value_disagreement_is_a_mismatch():
    row = {
        "phase": "compare",
        "target": "engine.sandbox:evaluate_code",
        "snippet": "result = 7 // 2\nresult",
        "reference": {"ok": True, "value": "3"},
        "got": {"ok": True, "value": "3.5"},
    }
    verdict = judge_row(row)
    assert verdict and verdict["kind"] == "wrong-value"


def test_agreement_and_wrapped_exceptions_pass():
    assert (
        judge_row(
            {
                "phase": "compare",
                "reference": {"ok": True, "value": "3"},
                "got": {"ok": True, "value": "3"},
            }
        )
        is None
    )
    # A sandbox may WRAP as long as it names the reference exception type.
    assert (
        judge_row(
            {
                "phase": "compare",
                "reference": {"ok": False, "exception": "TypeError"},
                "got": {
                    "ok": False,
                    "exception": "InterpreterError",
                    "message": "Code execution failed due to: TypeError: bad operand",
                },
            }
        )
        is None
    )


def test_reject_and_accept_asymmetries_are_mismatches():
    rejects = judge_row(
        {
            "phase": "compare",
            "reference": {"ok": True, "value": "42"},
            "got": {"ok": False, "exception": "InterpreterError", "message": "no"},
        }
    )
    assert rejects and rejects["kind"] == "rejects-valid"
    accepts = judge_row(
        {
            "phase": "compare",
            "reference": {"ok": False, "exception": "ZeroDivisionError"},
            "got": {"ok": True, "value": "inf"},
        }
    )
    assert accepts and accepts["kind"] == "accepts-invalid"


def test_mismatches_cluster_with_snippet_evidence():
    rows = [
        {
            "phase": "compare",
            "target": "engine.sandbox:evaluate_code",
            "snippet": "result = 7 // 2\nresult",
            "reference": {"ok": True, "value": "3"},
            "got": {"ok": True, "value": "3.5"},
        }
    ]
    clusters = cluster_mismatches(rows)
    assert len(clusters) == 1
    assert clusters[0].kind == "differential-mismatch"
    assert clusters[0].exemplar["input"] == "result = 7 // 2\nresult"


# ---- corpus sanity ---------------------------------------------------------


def test_corpus_is_self_consistent_under_cpython():
    # Every non-raising snippet must run clean under exec and bind `result`;
    # every raising snippet must raise. Otherwise the oracle blames targets
    # for our own corpus bugs.
    for snippet in AST_CORPUS:
        ns: dict = {}
        exec(snippet, ns)  # noqa: S102 — our own fixed corpus
        assert "result" in ns, snippet
    for snippet in AST_CORPUS_RAISING:
        try:
            exec(snippet, {})  # noqa: S102
        except BaseException:
            continue
        raise AssertionError(f"corpus snippet should raise: {snippet}")


# ---- the real driver -------------------------------------------------------


def test_buggy_evaluator_is_caught_against_cpython(tmp_path: Path):
    repo = _make_repo(tmp_path, _BUGGY_EVALUATOR)

    result = run_differential(repo, target="engine.sandbox:evaluate_code", reference="cpython-exec")

    assert result["status"] == "ok"
    assert result["comparisons"] == len(AST_CORPUS) + len(AST_CORPUS_RAISING)
    assert result["mismatch_clusters"] >= 2, "both planted bugs must surface"
    details = " ".join(c["title"] for c in result["clusters"])
    assert "rejects-valid" in details, "the unexplained lambda refusal"
    assert "wrong-value" in details, "the // rewrite (silently wrong arithmetic)"


def test_stated_policy_limits_are_reported_but_never_clustered(tmp_path: Path):
    # A sandbox that says "Lambda is not supported" is enforcing a documented
    # limit. Reporting that as a defect is noise, and noise gets oracles
    # switched off — so it lands in policy_limits, not in the clusters.
    repo = _make_repo(tmp_path, _POLICY_EVALUATOR)

    result = run_differential(repo, target="engine.sandbox:evaluate_code", reference="cpython-exec")

    assert result["mismatch_clusters"] == 0, "a stated limit is not a defect"
    assert result["policy_limit_count"] >= 1
    assert any("not supported" in p["detail"] for p in result["policy_limits"])


def test_call_kwargs_configure_the_target_as_production_does(tmp_path: Path):
    # An evaluator that needs its toolset passed in looks catastrophically
    # broken when driven with the default (empty) config — every builtin is
    # "forbidden". call_kwargs is how the oracle avoids that false-positive
    # storm; an "@module:SYMBOL" value is resolved by import in the worker.
    source = """\
ALLOWED = {"len": len, "sum": sum, "range": range, "list": list}


def evaluate_code(code: str, tools=None):
    if tools is None:
        raise ValueError("no tools configured")
    ns = dict(tools)
    exec(code, {"__builtins__": {}}, ns)
    return (ns.get("result"), False)
"""
    repo = _make_repo(tmp_path, source)

    unconfigured = run_differential(
        repo, target="engine.sandbox:evaluate_code", reference="cpython-exec"
    )
    assert any(
        "no tools configured" in c["exemplar"]["detail"] for c in unconfigured["clusters"]
    ), "unconfigured, the target refuses everything"

    configured = run_differential(
        repo,
        target="engine.sandbox:evaluate_code",
        reference="cpython-exec",
        call_kwargs={"tools": "@engine.sandbox:ALLOWED"},
    )
    assert not any(
        "no tools configured" in c["exemplar"]["detail"] for c in configured["clusters"]
    ), "the @module:SYMBOL value resolved and reached the call"

    # And the entry persists its config, so a later bare run stays configured.
    saved = store.read_json(store.exercise_dir(repo) / "references.json")
    entry = next(e for e in saved["references"] if e["target"] == "engine.sandbox:evaluate_code")
    assert entry["call_kwargs"] == {"tools": "@engine.sandbox:ALLOWED"}


def test_faithful_evaluator_produces_no_mismatches(tmp_path: Path):
    repo = _make_repo(tmp_path, _FAITHFUL_EVALUATOR)
    result = run_differential(repo, target="engine.sandbox:evaluate_code", reference="cpython-exec")
    assert result["comparisons"] > 0
    assert result["mismatch_clusters"] == 0, "agreement must stay silent"


def test_reference_finder_proposes_evaluator_shaped_targets(tmp_path: Path):
    repo = _make_repo(tmp_path, _FAITHFUL_EVALUATOR)
    doc = propose_references(repo)
    targets = {e["target"]: e for e in doc["references"]}
    assert "engine.sandbox:evaluate_code" in targets
    assert targets["engine.sandbox:evaluate_code"]["reference"] == "cpython-exec"
    # Idempotent, and explicit entries always win.
    store.write_json(
        store.exercise_dir(repo) / "references.json",
        {
            "version": 1,
            "references": [
                {
                    "target": "engine.sandbox:evaluate_code",
                    "reference": "other.mod:ref",
                    "corpus": "ast",
                    "extract": "auto",
                }
            ],
        },
    )
    doc2 = propose_references(repo)
    (entry,) = [e for e in doc2["references"] if e["target"] == "engine.sandbox:evaluate_code"]
    assert entry["reference"] == "other.mod:ref", "human-authored entries are never clobbered"


def test_no_references_is_loudly_diagnosed(tmp_path: Path):
    (tmp_path / ".vinv" / "exercise").mkdir(parents=True)
    result = run_differential(tmp_path)
    assert result["pairs"] == 0
    assert result["diagnostics"] and "0 differential references" in result["diagnostics"][0]
