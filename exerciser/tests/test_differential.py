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
    code_shaped,
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


def _make_repo(
    tmp_path: Path, evaluator_src: str, names: tuple[str, ...] = ("evaluate_code",)
) -> Path:
    src = tmp_path / "src" / "engine"
    src.mkdir(parents=True)
    (src / "__init__.py").write_text("", encoding="utf-8")
    (src / "sandbox.py").write_text(evaluator_src, encoding="utf-8")
    index = tmp_path / ".vinv" / "index"
    index.mkdir(parents=True)
    (index / "chunks.jsonl").write_text(
        "".join(
            json.dumps(
                {
                    "id": f"src/engine/sandbox.py:{name}",
                    "file": "src/engine/sandbox.py",
                    "lang": "python",
                    "kind": "function",
                    "name": name,
                    "start_line": 1,
                    "end_line": 5,
                    "parent": None,
                }
            )
            + "\n"
            for name in names
        ),
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


def test_an_unclassifiable_refusal_is_queued_not_guessed():
    # Layer 1 is structural and never guesses: a refusal that names nothing in
    # the source is UNADJUDICATED, not silently called a defect or a limit.
    row = {
        "phase": "compare",
        "snippet": "result = 42\nresult",
        "reference": {"ok": True, "value": "42"},
        "got": {"ok": False, "exception": "InterpreterError", "message": "no"},
    }
    verdict = judge_row(row)
    assert verdict and verdict["kind"] == "unadjudicated"
    assert cluster_mismatches([row]) == [], "an unresolved refusal is not a finding"

    # Layer 2's answer decides it, and is cached by refusal SHAPE.
    from exerciser.differential import refusal_key

    key = refusal_key("", "no")
    decided = judge_row(row, adjudications={key: "defect"})
    assert decided and decided["kind"] == "rejects-valid"
    assert len(cluster_mismatches([row], adjudications={key: "defect"})) == 1
    assert judge_row(row, adjudications={key: "policy"})["kind"] == "policy-limit"


def test_reject_and_accept_asymmetries_are_mismatches():
    rejects = judge_row(
        {
            "phase": "compare",
            "snippet": "result = divmod(9, 2)\nresult",
            "reference": {"ok": True, "value": "42"},
            "got": {
                "ok": False,
                "exception": "InterpreterError",
                "message": "internal failure",
            },
        },
        adjudications={},
    )
    # Structurally unclassifiable, so queued rather than reported.
    assert rejects and rejects["kind"] == "unadjudicated"
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
    assert "wrong-value" in details, "the // rewrite (silently wrong arithmetic)"
    # The unexplained lambda refusal names nothing structural, so layer 1
    # queues it for adjudication instead of guessing either way.
    assert result["unadjudicated_count"] >= 1
    queued = result["unadjudicated"][0]
    assert "internal error" in queued["message"]
    assert "policy" in queued["prompt"] and "defect" in queued["prompt"]


def test_a_refusal_is_queued_for_adjudication_not_assumed_to_be_policy(tmp_path: Path):
    # A sandbox that says "Lambda is not supported" MAY be enforcing a
    # documented limit — but assuming so is the verdict that buries a real
    # bug, so nothing is called policy without an adjudication. Layer 1 only
    # attaches a hint.
    repo = _make_repo(tmp_path, _POLICY_EVALUATOR)

    result = run_differential(repo, target="engine.sandbox:evaluate_code", reference="cpython-exec")

    assert result["mismatch_clusters"] == 0, "an unadjudicated refusal is not a finding"
    assert result["policy_limit_count"] == 0, "nothing is policy without adjudication"
    assert result["unadjudicated_count"] >= 1
    queued = result["unadjudicated"][0]
    assert "not supported" in queued["message"]
    assert queued["layer1_hint"], "layer 1 supplies evidence for the adjudicator"

    # Once adjudicated the verdict sticks, keyed by refusal SHAPE.
    doc = store.read_json(store.exercise_dir(repo) / "adjudications.json")
    for entry in doc["verdicts"].values():
        entry["verdict"] = "policy"
    store.write_json(store.exercise_dir(repo) / "adjudications.json", doc)

    again = run_differential(repo, target="engine.sandbox:evaluate_code", reference="cpython-exec")
    assert again["policy_limit_count"] >= 1
    assert again["unadjudicated_count"] == 0, "an answered refusal is not re-asked"


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
    # Unconfigured the target refuses EVERYTHING; those refusals name nothing
    # structural, so they land on the adjudication queue rather than being
    # asserted to be defects.
    assert any(
        "no tools configured" in q["message"] for q in unconfigured["unadjudicated"]
    ), "unconfigured, the target refuses everything"

    configured = run_differential(
        repo,
        target="engine.sandbox:evaluate_code",
        reference="cpython-exec",
        call_kwargs={"tools": "@engine.sandbox:ALLOWED"},
    )
    assert not any(
        "no tools configured" in q["message"] for q in configured["unadjudicated"]
    ), "the @module:SYMBOL value resolved and reached the call"
    assert not any("no tools configured" in c["exemplar"]["detail"] for c in configured["clusters"])

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


# ---- arming the oracle: SHAPE, never the name -----------------------------


def _params(*specs: tuple[str, str | None, bool]) -> list[dict]:
    return [
        {"name": n, "annotation": a, "has_default": d, "keyword_only": False} for n, a, d in specs
    ]


def test_the_shape_rule_is_about_the_signature_not_the_name():
    # The runner calls fn(snippet) — one positional string — so that, and only
    # that, is what qualifies a target.
    assert code_shaped(_params(("code", "str", False)))[0]
    assert code_shaped(_params(("source", None, False)))[0], "unannotated is common and fine"
    assert code_shaped(_params(("code", "str", False), ("tools", "dict", True)))[0]
    # Two required parameters: every snippet would raise TypeError from OUR bad
    # call, which is noise, not evidence.
    ok, why = code_shaped(_params(("preds", "list", False), ("labels", "list", False)))
    assert not ok and "exactly 1 required parameter" in why
    # A lone required str is also the shape of slugify(text); the parameter has
    # to be NAMED like code.
    ok, why = code_shaped(_params(("text", "str", False)))
    assert not ok and "named like a code parameter" in why
    # Right name, wrong type.
    ok, why = code_shaped(_params(("code", "int", False)))
    assert not ok and "not str" in why
    assert not code_shaped([])[0]
    assert not code_shaped(None)[0]


_ML_METRICS = """\
def evaluate_model(preds: list, labels: list) -> float:
    return float(len(preds) == len(labels))


def interpret_results(scores: list) -> str:
    return "good" if scores else "empty"
"""


def test_ml_shaped_targets_are_not_armed_by_their_names(tmp_path: Path):
    # `evaluate`/`interpret` in a name meant "evaluator" only in one framework.
    # On an ML repo the old rule armed metrics code, fed it Python snippets
    # positionally, and every call raised TypeError into the adjudication budget.
    repo = _make_repo(tmp_path, _ML_METRICS, names=("evaluate_model", "interpret_results"))
    doc = propose_references(repo)
    assert doc["references"] == [], "no evaluator-shaped target here, so nothing is armed"

    result = run_differential(repo)
    assert result["pairs"] == 0
    assert result["comparisons"] == 0
    assert result["unadjudicated_count"] == 0, "no garbage in the adjudication budget"


# A source signature the live object contradicts: the decorator replaces the
# callable with a (*args, **kwargs) wrapper, so the proposal cannot survive
# contact with the real thing.
_REBOUND_EVALUATOR = """\
def _passthrough(fn):
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)

    return wrapper


@_passthrough
def evaluate_code(code: str):
    ns = {}
    exec(code, ns)
    return (ns.get("result"), False)
"""


def test_a_proposal_the_live_signature_contradicts_is_dropped(tmp_path: Path):
    repo = _make_repo(tmp_path, _REBOUND_EVALUATOR)
    assert propose_references(repo)["references"], "the SOURCE shape qualifies"

    result = run_differential(repo)

    assert result["pairs"] == 1
    assert result["comparisons"] == 0, "not one snippet was sent"
    assert result["mismatch_clusters"] == 0
    assert result["unadjudicated_count"] == 0
    assert result["dropped_count"] == 1
    dropped = result["dropped"][0]
    assert dropped["target"] == "engine.sandbox:evaluate_code"
    assert dropped["reason"], "a drop is recorded with its reason, never silent"


def test_an_explicit_entry_is_trusted_and_never_shape_verified(tmp_path: Path):
    # A human (or the CLI) declaring a reference is an instruction, not a guess:
    # shape verification exists to police the FINDER's proposals.
    repo = _make_repo(tmp_path, _FAITHFUL_EVALUATOR)
    result = run_differential(repo, target="engine.sandbox:evaluate_code", reference="cpython-exec")
    assert result["dropped_count"] == 0
    assert result["comparisons"] > 0


def test_no_references_is_loudly_diagnosed(tmp_path: Path):
    (tmp_path / ".vinv" / "exercise").mkdir(parents=True)
    result = run_differential(tmp_path)
    assert result["pairs"] == 0
    assert result["diagnostics"] and "0 differential references" in result["diagnostics"][0]


def test_layer1_hints_are_structural_and_never_decide(tmp_path: Path):
    # "Nonlocal is not supported" names an ast node in the source: a stated
    # limit. "NoneType is not supported" names a runtime VALUE type — the
    # sandbox failing INSIDE a construct it claims to support, which is a
    # defect wearing a policy message. A greedy substring match buried
    # smolagents' own filed issue #2552 behind exactly this confusion.
    from exerciser.differential import policy_signal

    nonlocal_snippet = "def f():\n    x = 1\n    def g():\n        nonlocal x\n    return g\nf()"
    verdict, reason = policy_signal("Nonlocal is not supported.", nonlocal_snippet)
    assert verdict == "maybe-policy", "a hint, never a verdict"
    assert "syntax construct" in reason

    dict_unpack = "d = {'x': 1}\nresult = {**d, 'y': 2}\nresult"
    assert policy_signal("NoneType is not supported.", dict_unpack)[0] == "unresolved"

    # A capability refusal naming an identifier the source uses is also a
    # stated limit — structural, no wording matched.
    assert (
        policy_signal(
            "Forbidden function evaluation: 'divmod' is not among the allowed tools",
            "result = divmod(9, 2)\nresult",
        )[0]
        == "maybe-policy"
    )
    # Layer 1 never guesses: an unrecognisable refusal stays unresolved and is
    # queued for adjudication instead of being called either thing.
    assert policy_signal("something went wrong", "result = 1\nresult")[0] == "unresolved"


def test_a_target_that_is_not_an_evaluator_is_dropped(tmp_path: Path):
    # `fix_final_answer_code(code_action: str) -> str` satisfies the shape rule
    # — one required str parameter named like code — but merely REWRITES the
    # source text. Driving it manufactured 378 findings against real
    # smolagents. An implementation of Python agrees with CPython on the vast
    # majority of a semantics corpus; a text rewriter agrees on none.
    rewriter = """\
def fix_code(code_action: str) -> str:
    return code_action.replace("result", "value")
"""
    repo = _make_repo(tmp_path, rewriter)

    result = run_differential(repo, target="engine.sandbox:fix_code", reference="cpython-exec")

    assert result["mismatch_clusters"] == 0, "artefacts of the wrong function are not findings"
    assert "engine.sandbox:fix_code" in result["implausible_evaluators"]
    assert "does not evaluate Python" in result["implausible_evaluators"]["engine.sandbox:fix_code"]


def test_a_real_evaluator_with_real_bugs_is_not_dropped(tmp_path: Path):
    repo = _make_repo(tmp_path, _BUGGY_EVALUATOR)
    result = run_differential(repo, target="engine.sandbox:evaluate_code", reference="cpython-exec")
    assert result["implausible_evaluators"] == {}, "a mostly-correct evaluator stays"
    assert result["mismatch_clusters"] >= 1
