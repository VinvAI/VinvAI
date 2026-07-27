"""Differential oracle — compare a function against a REFERENCE implementation.

The highest-yield oracle for evaluator/parser/adapter code: for any function
with a reference implementation, disagreement IS the bug report — no learned
invariant or status code required. The canonical case is a Python
evaluator/interpreter (an agent framework's ``LocalPythonExecutor``-style
sandbox): its reference is CPython ``exec`` itself, and a corpus spanning ast
node types mechanically surfaces "rejects valid Python" / "computes a different
value" / "accepts what CPython rejects" defects.

Two pieces:

* **Reference-finder** (``propose_references``) — given the function-harness
  target set, proposes a differential reference per symbol, BY SHAPE, never by
  name. A callable qualifies when it has exactly ONE required parameter, that
  parameter is annotated ``str`` (or is unannotated), and its name is one of
  ``_CODE_PARAM_NAMES`` (``code``/``source``/``src``/``expression``/``expr``/
  ``snippet``/``program``/``code_action``). Shape is what the oracle actually
  needs, because the runner calls ``fn(snippet)`` positionally: a name rule
  arms ``metrics.evaluate_model(preds, labels)`` on an ML repo and floods the
  adjudication budget with TypeErrors. The proposal is made from the SOURCE
  signature (discovery imports nothing) and re-verified against the live
  ``inspect.signature`` in the worker; an entry that fails verification is
  DROPPED with a recorded reason rather than run. Proposals land in
  ``.vinv/exercise/references.json`` where a human (or agent) can add explicit
  ``module:qualname`` references for anything the shape rule cannot see —
  explicit entries are trusted and never shape-verified.
* **Runner** (``run_differential``) — drives each (target, reference) pair over
  the corpus in an isolated worker subprocess (same discipline as
  ``functions.py``: imports of target code can do anything), compares outcomes,
  and clusters mismatches as ``differential-mismatch`` issues.

Comparison semantics per corpus snippet (each ends with a bare ``result``
expression so evaluators that return the last value and ``exec``+namespace
agree on WHAT is compared):

* both succeed → compare ``repr`` of the values (tuple-returning evaluators are
  unwrapped via the proposal's ``extract`` rule);
* both raise → agree when the target's error names the reference's exception
  type (a sandbox is allowed to WRAP, e.g. ``InterpreterError: … TypeError …``);
* one raises, one succeeds → mismatch (the two shapes of evaluator bugs:
  "rejected valid Python" and "accepted what CPython rejects").

**Policy is not a defect.** A sandbox that refuses ``nonlocal``, or refuses a
builtin it was never given, is enforcing a documented limit — reporting that as
a bug is noise, and noise is how an oracle gets switched off. Refusals whose
message matches ``POLICY_PATTERNS`` are bucketed as ``policy_limits``
(informational: exactly what the sandbox will not do) and never clustered as
issues. Only *unexplained* disagreement becomes an issue.

**Configure the target as production does.** An entry's ``call_kwargs`` are
passed to every target call, and a ``"@module:SYMBOL"`` value is resolved by
import in the worker — so
``{"static_tools": "@pkg.executor:BASE_PYTHON_TOOLS"}`` drives the evaluator
with the toolset it actually ships with. Without this the oracle compares
against a crippled configuration and every builtin looks "forbidden".
"""

from __future__ import annotations

import argparse
import importlib
import inspect
import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from . import store
from .functions import annotation_base, detect_src_roots, discover_targets
from .issues import FailureCluster, normalize_signature
from .semantics_corpus import RAISING_CORPUS, SEMANTIC_CORPUS

DEFAULT_TIMEOUT_S = 60.0

_CODE_PARAM_NAMES = frozenset(
    {"code", "source", "src", "expression", "expr", "snippet", "program", "code_action"}
)

# Refusal messages that mean "this sandbox deliberately does not do that" —
# a documented limit, not a defect. Matched case-insensitively against the
# target's error message. Extend per-entry via `policy_patterns`.
# =========================================================================
# Policy vs defect: two layers, no phrase list
# =========================================================================
#
# "Did the sandbox refuse on PURPOSE, or break?" cannot be answered by matching
# English. A list of phrases encodes one project's prose and mis-scores every
# other one — and the greedy version of exactly that list buried smolagents'
# own filed issue #2552 ("NoneType is not supported") next to a genuine limit
# ("Nonlocal is not supported"). So the question is answered in two layers:
#
# **Layer 1 — structural, high recall.** Two signals that are facts, not
# wording, and that hold for any sandbox in any language-hosted evaluator:
#
#   * the refusal names a SYNTAX CONSTRUCT that the snippet actually contains
#     (ast node type present in the source) — the sandbox is declining a
#     language feature, which is a documented limit;
#   * the refusal names an IDENTIFIER the snippet uses that was never granted
#     to it (a builtin/tool absent from the configured toolset) — the sandbox
#     is declining a capability.
#
#   Anything else is UNRESOLVED. Layer 1 deliberately never guesses: false
#   positives on "policy" are how a real bug gets buried.
#
# **Layer 2 — agentic adjudication.** Unresolved refusals render a prompt (the
# repo's established print-prompt -> harness -> JSON-reply contract, same as
# plan.py's semantic prompts) asking whether this is a stated limit or a
# defect. The verdict is folded into the LEARNED exception policy, so the
# second time that message shape appears no model call is needed.
#
# Unresolved-and-unadjudicated refusals are reported as ``unadjudicated`` —
# never silently classified either way.
#
# **Cost is bounded three ways**, because "ask a model about every refusal" is
# not a design:
#
#   * refusals are deduplicated by SHAPE (``refusal_key`` normalises digits and
#     whitespace), so a message that occurs sixty times is one question;
#   * an answered shape is cached in ``adjudications.json`` and never re-asked,
#     so steady-state cost is zero;
#   * ``max_adjudications`` caps how many NEW questions one run may raise, and
#     the overflow is reported rather than dropped silently.

# Default ceiling on new adjudication questions per run.
DEFAULT_MAX_ADJUDICATIONS = 25


def _snippet_constructs(snippet: str) -> set[str]:
    """Lowercased ast node-type names appearing in a snippet."""
    import ast as _ast

    try:
        tree = _ast.parse(snippet)
    except SyntaxError:
        return set()
    return {type(node).__name__.lower() for node in _ast.walk(tree)}


def _snippet_identifiers(snippet: str) -> set[str]:
    """Names the snippet references — what a capability refusal would cite."""
    import ast as _ast

    try:
        tree = _ast.parse(snippet)
    except SyntaxError:
        return set()
    out: set[str] = set()
    for node in _ast.walk(tree):
        if isinstance(node, _ast.Name):
            out.add(node.id.lower())
        elif isinstance(node, _ast.Attribute):
            out.add(node.attr.lower())
    return out


def _ubiquity() -> dict[str, float]:
    """How often each ast node type appears across the corpus.

    A node type present in almost every snippet (``Name``, ``Assign``,
    ``Expr``, ``Load``) carries no information: matching it means matching
    ordinary prose. Which types those are is DERIVED from the corpus rather
    than listed, so it stays correct as the corpus grows.
    """
    corpus = (*AST_CORPUS, *AST_CORPUS_RAISING)
    counts: dict[str, int] = {}
    for snippet in corpus:
        for node in _snippet_constructs(snippet):
            counts[node] = counts.get(node, 0) + 1
    total = max(1, len(corpus))
    return {k: v / total for k, v in counts.items()}


# Node types appearing in more than this fraction of the corpus are treated as
# uninformative — matching one proves nothing about the refusal.
_UBIQUITY_CAP = 0.25


def _discriminative_constructs(snippet: str) -> set[str]:
    """Constructs in ``snippet`` that are rare enough to be evidence."""
    ubiquity = _UBIQUITY
    return {c for c in _snippet_constructs(snippet) if ubiquity.get(c, 0.0) <= _UBIQUITY_CAP}


def _names_word(haystack: str, needle: str) -> bool:
    """Word-bounded containment — 'name' must not match 'undefined_name_xyz'."""
    import re as _re

    return (
        _re.search(rf"(?<![A-Za-z0-9_]){_re.escape(needle)}(?![A-Za-z0-9_])", haystack) is not None
    )


def policy_signal(message: str, snippet: str | None) -> tuple[str, str]:
    """Layer 1: a HINT, never a verdict. ``(hint, reason)``.

    Deliberately biased toward reporting. Three rounds of tuning this into a
    precise classifier each buried a real filed bug behind a plausible-looking
    structural rule — "Cannot unpack tuple of wrong size" names the construct
    ``Tuple``; "The variable `x` is not defined" names an identifier the source
    uses — so a structural match is now evidence to hand to layer 2, NOT a
    decision. The asymmetry is intentional: a false "defect" costs an
    adjudication, a false "policy" costs a missed bug.
    """
    low = (message or "").lower()
    if not low or snippet is None:
        return "unresolved", "no message or no snippet to compare against"
    constructs = _discriminative_constructs(snippet)
    named_construct = sorted(c for c in constructs if _names_word(low, c))
    if named_construct:
        return (
            "maybe-policy",
            f"names syntax construct(s) present in the source: {named_construct}",
        )
    identifiers = _snippet_identifiers(snippet)
    # Require the identifier to be quoted or word-bounded so a three-letter
    # variable name cannot match a substring of ordinary prose.
    named_ident = sorted(
        i
        for i in identifiers
        if len(i) > 2 and (f"'{i}'" in low or f'"{i}"' in low or f"`{i}`" in low)
        # The identifier must be QUOTED in the message: a sandbox citing a
        # capability names it explicitly, whereas an error that merely echoes
        # the failing source line proves nothing.
    )
    if named_ident:
        return (
            "maybe-policy",
            f"names identifier(s) the source uses but was not granted: {named_ident}",
        )
    return "unresolved", "refusal names nothing structural in the source"


def adjudication_prompt(target: str, snippet: str, message: str) -> str:
    """Layer 2 prompt: is this refusal a stated limit, or a defect?

    Follows the repo's print-prompt -> harness -> JSON-reply contract so the
    extension dispatches it like any other authored decision.
    """
    return (
        "A sandboxed evaluator was asked to run a snippet that CPython runs "
        "successfully, and it refused. Decide whether the refusal is a "
        "DELIBERATE, DOCUMENTED LIMIT of the sandbox, or a DEFECT wearing a "
        "refusal message.\n\n"
        "A deliberate limit declines a language feature or a capability the "
        "sandbox never granted (a builtin it does not expose, a syntax form it "
        "does not implement). A defect fails INSIDE a construct the sandbox "
        "does claim to support — for example an internal type error while "
        "evaluating an expression whose syntax it handles elsewhere.\n\n"
        f"Evaluator: {target}\n"
        f"Snippet:\n{snippet}\n\n"
        f"Refusal message:\n{message}\n\n"
        'Reply with exactly: {"verdict": "policy"|"defect", "why": "<one sentence>"}'
    )


# =========================================================================
# The ast-corpus: deterministic snippets spanning node types
# =========================================================================
#
# Every snippet is self-contained, import-free, dunder-light, and ends with a
# bare `result` expression. Kept deliberately inside what a restrictive
# evaluator SHOULD support — disagreement on these is a defect, not a policy.

# The corpus is the deterministic half of this oracle, and its breadth IS its
# power: a differential test only finds what the corpus provokes. It is
# therefore derived from the Python Language Reference, CPython's own
# semantics tests (test_scope / test_augassign / test_listcomps /
# test_unpack_ex / test_patma / test_generators / test_contextlib), and the
# published divergence lists of real re-implementations (PyPy
# cpython_differences, RustPython, Skulpt, Brython) — not from one target.
#
# `semantics_corpus` carries the detail, including per-snippet provenance
# comments and the deliberately EXCLUDED cases (hash salting, id(), __del__
# timing, refcounts) that would otherwise make comparisons flaky rather than
# informative. Weighting favours SEMANTIC_CORPUS: an interpreter bug that
# returns a plausible wrong value is invisible to every exception-based
# oracle, which is exactly the class this exists to find.
AST_CORPUS: tuple[str, ...] = SEMANTIC_CORPUS
AST_CORPUS_RAISING: tuple[str, ...] = RAISING_CORPUS


def _ubiquity() -> dict[str, float]:
    """How often each ast node type appears across the corpus.

    A node type present in almost every snippet (``Name``, ``Assign``,
    ``Expr``, ``Load``) carries no information: matching it means matching
    ordinary prose. Which types those are is DERIVED from the corpus rather
    than listed, so it stays correct as the corpus grows.
    """
    corpus = (*AST_CORPUS, *AST_CORPUS_RAISING)
    counts: dict[str, int] = {}
    for snippet in corpus:
        for node in _snippet_constructs(snippet):
            counts[node] = counts.get(node, 0) + 1
    total = max(1, len(corpus))
    return {k: v / total for k, v in counts.items()}


# Node types appearing in more than this fraction of the corpus are treated as
# uninformative — matching one proves nothing about the refusal.
_UBIQUITY_CAP = 0.25


def _discriminative_constructs(snippet: str) -> set[str]:
    """Constructs in ``snippet`` that are rare enough to be evidence."""
    ubiquity = _UBIQUITY
    return {c for c in _snippet_constructs(snippet) if ubiquity.get(c, 0.0) <= _UBIQUITY_CAP}


def _names_word(haystack: str, needle: str) -> bool:
    """Word-bounded containment — 'name' must not match 'undefined_name_xyz'."""
    import re as _re

    return (
        _re.search(rf"(?<![A-Za-z0-9_]){_re.escape(needle)}(?![A-Za-z0-9_])", haystack) is not None
    )


# =========================================================================
# The ast-corpus: deterministic snippets spanning node types
# =========================================================================
#
# Every snippet is self-contained, import-free, dunder-light, and ends with a
# bare `result` expression. Kept deliberately inside what a restrictive
# evaluator SHOULD support — disagreement on these is a defect, not a policy.


# Snippets that must RAISE under CPython — an evaluator that accepts them has
# widened the language.


# =========================================================================
# Reference-finder
# =========================================================================


def code_shaped(params: list[dict[str, Any]] | None) -> tuple[bool, str]:
    """Whether a callable has the shape this oracle can drive: ``(ok, why)``.

    The runner calls ``fn(snippet)`` — one positional string — so the only
    callables it can drive at all are the ones that ACCEPT that. Hence the rule:

    * exactly one required parameter (extra required parameters mean every
      snippet raises TypeError, which is noise, not evidence);
    * annotated ``str``, or unannotated (a plain ``def run(code)`` is common);
    * named in ``_CODE_PARAM_NAMES``, because a lone required ``str`` is also
      the shape of ``slugify(text)`` and a thousand other functions that have
      no business being fed Python programs.

    ``why`` is the recorded reason when the shape does not qualify, so a drop is
    auditable rather than silent.
    """
    records = list(params or [])
    required = [p for p in records if not p.get("has_default")]
    if len(required) != 1:
        return False, f"expected exactly 1 required parameter, found {len(required)}"
    param = required[0]
    name = str(param.get("name") or "")
    if name not in _CODE_PARAM_NAMES:
        return False, f"required parameter {name!r} is not named like a code parameter"
    annotation = param.get("annotation")
    if annotation is None:
        return True, f"one required, unannotated parameter named {name!r}"
    base = annotation_base(str(annotation))
    if base != "str":
        return False, f"required parameter {name!r} is annotated {annotation!r}, not str"
    return True, f"one required str parameter named {name!r}"


def propose_references(repo: Path, *, logger: logging.Logger | None = None) -> dict[str, Any]:
    """Propose differential references for the discovered function targets.

    Writes/merges ``.vinv/exercise/references.json``: existing entries (human-
    or agent-authored) always win; proposals only ADD. Each entry:
    ``{"target": "module:qualname", "reference": "cpython-exec" | "module:qualname",
    "corpus": "ast", "extract": "auto"}``.
    """
    log = logger or logging.getLogger(__name__)
    # An evaluator CALLS `exec`/`eval` — that is what makes it an evaluator, and
    # the purity pre-check refuses that class for the in-process crash harness.
    # This oracle is the control for it: the target is driven in its own worker
    # against a curated corpus, so it opts into that one class and no other.
    targets, _ = discover_targets(repo, logger=log, allow_impurities=frozenset({"code-evaluation"}))
    path = store.exercise_dir(repo) / "references.json"
    existing = store.read_json(path)
    entries: dict[str, dict[str, Any]] = {}
    if isinstance(existing, dict):
        for e in existing.get("references") or []:
            if isinstance(e, dict) and isinstance(e.get("target"), str):
                entries[e["target"]] = e

    proposed = 0
    for t in targets:
        if t.id in entries:
            continue
        # SHAPE, not name. Discovery does not import, but it does read the
        # source signature, which is the same shape the worker will re-verify
        # against the live object before a single snippet is sent.
        qualifies, _why = code_shaped(t.params)
        if qualifies:
            entries[t.id] = {
                "target": t.id,
                "reference": "cpython-exec",
                "corpus": "ast",
                "extract": "auto",
                "proposed_by": "reference-finder/shape",
            }
            proposed += 1

    doc = {"version": 1, "references": sorted(entries.values(), key=lambda e: e["target"])}
    store.write_json(path, doc)
    log.info("differential: %d references (%d newly proposed)", len(entries), proposed)
    return doc


# =========================================================================
# Worker — imports the target evaluator, runs the corpus
# =========================================================================


def _outcome_ref(snippet: str) -> dict[str, Any]:
    """CPython's own verdict on a snippet (the reference side)."""
    ns: dict[str, Any] = {}
    try:
        exec(snippet, ns)  # noqa: S102 — the corpus is our own fixed text
        return {"ok": True, "value": repr(ns.get("result"))}
    except BaseException as exc:
        return {"ok": False, "exception": type(exc).__name__}


def _extract_value(out: Any, extract: str) -> Any:
    """Normalize an evaluator's return for comparison.

    ``auto``: a 2-tuple whose second element is a bool (the common
    ``(result, is_final_answer)`` shape) yields its first element; objects with
    an ``output`` attribute yield that; anything else compares as-is.
    """
    if extract == "first" and isinstance(out, tuple) and out:
        return out[0]
    if extract == "auto":
        if isinstance(out, tuple) and len(out) == 2 and isinstance(out[1], bool):
            return out[0]
        if hasattr(out, "output"):
            return out.output
    return out


_UBIQUITY: dict[str, float] = _ubiquity()


def _live_params(fn: Any) -> list[dict[str, Any]] | None:
    """Parameter records read from the LIVE callable, or None when unreadable.

    Same record shape as the source-derived ones the finder proposes from, so
    one ``code_shaped`` rule judges both sides.
    """
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return None
    out: list[dict[str, Any]] = []
    for name, p in sig.parameters.items():
        if name in ("self", "cls") or p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
            continue
        annotation = None
        if p.annotation is not p.empty:
            annotation = getattr(p.annotation, "__name__", None) or str(p.annotation)
        out.append(
            {
                "name": name,
                "annotation": annotation,
                "has_default": p.default is not p.empty,
                "keyword_only": p.kind == p.KEYWORD_ONLY,
            }
        )
    return out


def _worker_main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="exerciser-differential-worker")
    ap.add_argument("--plan", required=True)
    ap.add_argument("--repo", required=True)
    args = ap.parse_args(argv)
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    repo = Path(args.repo)
    for root in plan.get("src_roots", ["."]):
        p = str((repo / root).resolve())
        if p not in sys.path:
            sys.path.insert(0, p)

    module_name, _, qualname = plan["target"].partition(":")
    extract = plan.get("extract", "auto")
    rows: list[dict[str, Any]] = []
    try:
        fn = getattr(importlib.import_module(module_name), qualname)
    except BaseException as exc:
        rows.append(
            {
                "target": plan["target"],
                "phase": "import",
                "status": "error",
                "error_type": type(exc).__name__,
                "error": str(exc)[:400],
            }
        )
        _emit(rows)
        return 0

    # Shape verification against the LIVE object. The proposal was made from the
    # source signature, which a decorator, a re-export or a runtime rebind can
    # contradict; the worker is the only place that can see the real callable.
    # Explicit (human/CLI) entries are trusted and never verified here.
    if plan.get("verify_shape"):
        live = _live_params(fn)
        if live is None:
            qualifies, why = False, "signature could not be read from the live object"
        else:
            qualifies, why = code_shaped(live)
        if not qualifies:
            rows.append(
                {
                    "target": plan["target"],
                    "phase": "verify",
                    "status": "dropped",
                    "dropped_reason": why,
                }
            )
            _emit(rows)
            return 0

    reference = plan.get("reference", "cpython-exec")
    ref_fn = None
    if reference != "cpython-exec":
        ref_mod, _, ref_qual = reference.partition(":")
        try:
            ref_fn = getattr(importlib.import_module(ref_mod), ref_qual)
        except BaseException as exc:
            rows.append(
                {
                    "target": plan["target"],
                    "phase": "reference-import",
                    "status": "error",
                    "error": f"{reference}: {exc}"[:400],
                }
            )
            _emit(rows)
            return 0

    try:
        call_kwargs = _resolve_kwargs(plan.get("call_kwargs") or {})
    except BaseException as exc:
        rows.append(
            {
                "target": plan["target"],
                "phase": "call-kwargs",
                "status": "error",
                "error": f"could not resolve call_kwargs: {exc}"[:400],
            }
        )
        _emit(rows)
        return 0

    for snippet in plan["corpus"]:
        ref = (
            _outcome_ref(snippet)
            if ref_fn is None
            else _outcome_target(ref_fn, snippet, extract, call_kwargs)
        )
        got = _outcome_target(fn, snippet, extract, call_kwargs)
        rows.append(
            {
                "target": plan["target"],
                "phase": "compare",
                "snippet": snippet,
                "reference": ref,
                "got": got,
            }
        )
    _emit(rows)
    return 0


def _resolve_kwargs(raw: dict[str, Any]) -> dict[str, Any]:
    """Resolve ``"@module:SYMBOL"`` values by import; pass everything else through.

    Lets an entry configure the target the way production does — e.g.
    ``{"static_tools": "@pkg.executor:BASE_PYTHON_TOOLS"}`` — without the plan
    file having to embed a callable.
    """
    out: dict[str, Any] = {}
    for key, value in (raw or {}).items():
        if isinstance(value, str) and value.startswith("@") and ":" in value:
            mod_name, _, sym = value[1:].partition(":")
            out[key] = getattr(importlib.import_module(mod_name), sym)
        else:
            out[key] = value
    return out


def _outcome_target(
    fn: Any, snippet: str, extract: str, kwargs: dict[str, Any] | None = None
) -> dict[str, Any]:
    try:
        out = fn(snippet, **(kwargs or {}))
        return {"ok": True, "value": repr(_extract_value(out, extract))}
    except BaseException as exc:
        return {
            "ok": False,
            "exception": type(exc).__name__,
            "message": str(exc)[:400],
        }


def _emit(rows: list[dict[str, Any]]) -> None:
    for r in rows:
        sys.stdout.write(json.dumps(r, default=str) + "\n")
    sys.stdout.flush()


# =========================================================================
# Comparison + clustering (parent side; pure, unit-tested)
# =========================================================================


def judge_row(
    row: dict[str, Any],
    *,
    policy_patterns: tuple[str, ...] = (),
    adjudications: dict[str, str] | None = None,
) -> dict[str, str] | None:
    """Verdict for one compare row, or None on agreement.

    Wrapping is allowed on the error path: a sandbox that re-raises
    ``InterpreterError: … due to: TypeError: …`` NAMES the reference type and
    therefore agrees. A refusal that states a deliberate limit is returned with
    kind ``policy-limit`` — informational, never clustered as a defect.
    """
    if row.get("phase") != "compare":
        return None
    ref, got = row.get("reference") or {}, row.get("got") or {}
    got_msg = str(got.get("message") or "")
    snippet = row.get("snippet")

    def _refusal_verdict() -> tuple[str, str]:
        """A stored layer-2 adjudication decides; layer 1 only supplies a hint.

        Nothing is called a policy limit without an adjudication, because that
        is the verdict that BURIES a finding.
        """
        stored = (adjudications or {}).get(refusal_key(str(row.get("target", "")), got_msg))
        if stored in ("policy", "defect"):
            return stored, "adjudicated by the harness"
        _, reason = policy_signal(got_msg, snippet)
        return "unresolved", reason

    if ref.get("ok") and got.get("ok"):
        if ref.get("value") != got.get("value"):
            return {
                "kind": "wrong-value",
                "detail": (
                    f"reference computed {ref.get('value')!s} but the target "
                    f"computed {got.get('value')!s}"
                ),
            }
        return None
    if ref.get("ok") and not got.get("ok"):
        verdict, reason = _refusal_verdict()
        if verdict == "policy":
            return {
                "kind": "policy-limit",
                "detail": f"deliberately refused ({reason}): {got_msg[:180]}",
            }
        if verdict == "unresolved":
            return {
                "kind": "unadjudicated",
                "detail": (
                    f"refusal could not be classified structurally ({reason}); "
                    f"awaiting adjudication: {got_msg[:160]}"
                ),
            }
        return {
            "kind": "rejects-valid",
            "detail": (
                f"valid Python rejected with no stated policy reason: "
                f"target raised {got.get('exception')}: {got_msg[:160]}"
            ),
        }
    if not ref.get("ok") and got.get("ok"):
        return {
            "kind": "accepts-invalid",
            "detail": (
                f"reference raises {ref.get('exception')} but the target "
                f"returned {got.get('value')!s}"
            ),
        }
    # both raised: the target must at least NAME the reference exception type.
    ref_exc = str(ref.get("exception") or "")
    blob = f"{got.get('exception', '')} {got_msg}"
    if ref_exc and ref_exc not in blob:
        verdict, reason = _refusal_verdict()
        if verdict == "policy":
            # Both refuse; the target refuses for its own stated reason. That
            # is a policy difference, not a wrong answer.
            return {
                "kind": "policy-limit",
                "detail": f"deliberately refused ({reason}): {got_msg[:180]}",
            }
        if verdict == "unresolved":
            # Uniform with the rejects-valid path: a refusal nothing structural
            # explains is QUEUED, not called either way. A sandbox wrapping an
            # exception type is normal practice, so whether losing the type is
            # a defect is exactly the judgement layer 2 exists to make.
            return {
                "kind": "unadjudicated",
                "detail": (
                    f"target raised {got.get('exception')} where the reference "
                    f"raises {ref_exc}, and the refusal could not be classified "
                    f"structurally ({reason}): {got_msg[:140]}"
                ),
            }
        return {
            "kind": "wrong-exception",
            "detail": (
                f"reference raises {ref_exc} but the target raised "
                f"{got.get('exception')} without naming it: {got_msg[:160]}"
            ),
        }
    return None


def refusal_key(target: str, message: str) -> str:
    """Stable id for one refusal SHAPE — digits normalised, so an adjudication
    of "…'foo' is not among the allowed tools" covers every such message."""
    import hashlib as _h
    import re as _re

    norm = _re.sub(r"\d+", "#", (message or "").lower())
    norm = _re.sub(r"\s+", " ", norm).strip()[:300]
    return _h.sha256(f"{target}|{norm}".encode()).hexdigest()[:16]


def unadjudicated(
    rows: list[dict[str, Any]],
    *,
    policy_patterns: tuple[str, ...] = (),
    adjudications: dict[str, str] | None = None,
    limit: int | None = None,
) -> list[dict[str, str]]:
    """Refusals layer 1 could not classify — the layer-2 work queue.

    Deduplicated by refusal SHAPE, so repeated occurrences of one message cost
    a single question. ``limit`` caps the queue; the caller reports any
    overflow rather than dropping it silently.
    """
    out: dict[str, dict[str, str]] = {}
    for row in rows:
        verdict = judge_row(row, policy_patterns=policy_patterns, adjudications=adjudications)
        if verdict is None or verdict["kind"] != "unadjudicated":
            continue
        target = str(row.get("target", "?"))
        message = str((row.get("got") or {}).get("message") or "")
        key = refusal_key(target, message)
        if key not in out:
            out[key] = {
                "key": key,
                "target": target,
                "snippet": str(row.get("snippet", "")),
                "message": message,
                "prompt": adjudication_prompt(target, str(row.get("snippet", "")), message),
                "exception": (row.get("got") or {}).get("exception"),
                "exception_module": (row.get("got") or {}).get("module"),
                "layer1_hint": policy_signal(message, str(row.get("snippet", "")))[1],
            }
    ordered = sorted(out.values(), key=lambda e: e["key"])
    return ordered if limit is None else ordered[:limit]


def policy_limits(
    rows: list[dict[str, Any]],
    *,
    policy_patterns: tuple[str, ...] = (),
    adjudications: dict[str, str] | None = None,
) -> list[dict[str, str]]:
    """Deliberate refusals, deduped — what this sandbox will not do.

    Informational output: an accurate map of a sandbox's documented limits is
    useful (it is the difference between "cannot" and "broken"), but it is not
    a defect list and never becomes an issue cluster.
    """
    seen: dict[str, dict[str, str]] = {}
    for row in rows:
        verdict = judge_row(row, policy_patterns=policy_patterns, adjudications=adjudications)
        if verdict is None or verdict["kind"] != "policy-limit":
            continue
        key = verdict["detail"][:120]
        if key not in seen:
            seen[key] = {
                "target": row.get("target", "?"),
                "snippet": row.get("snippet", ""),
                "detail": verdict["detail"],
            }
    return sorted(seen.values(), key=lambda e: e["detail"])


# An evaluator that disagrees with CPython on essentially EVERY snippet of a
# 378-case semantics corpus is not a buggy evaluator — it is not an evaluator.
# Verified live: `fix_final_answer_code(code_action: str) -> str` satisfies the
# shape rule (one required str parameter named like code) but merely REWRITES
# the source text, so it "succeeds" on every snippet and differs on every one,
# manufacturing 378 findings. A real evaluator agrees on the vast majority.
DISAGREEMENT_DROP_RATIO = 0.9


def implausible_evaluator(rows: list[dict[str, Any]], target: str) -> str | None:
    """Why ``target`` should be dropped as not-an-evaluator, or None.

    Structural and corpus-relative, so it transfers: it asks whether the target
    behaved like an implementation of the language at all, not whether it
    matches any particular project.
    """
    compares = [r for r in rows if r.get("phase") == "compare" and r.get("target") == target]
    if len(compares) < 20:
        return None  # too little evidence to judge
    both_ran = [
        r
        for r in compares
        if (r.get("reference") or {}).get("ok") and (r.get("got") or {}).get("ok")
    ]
    if not both_ran:
        return None  # it refuses rather than answers — that is a real verdict
    differing = [
        r for r in both_ran if (r["reference"] or {}).get("value") != (r["got"] or {}).get("value")
    ]
    ratio = len(differing) / len(both_ran)
    if ratio >= DISAGREEMENT_DROP_RATIO:
        return (
            f"answered {len(both_ran)} snippets and disagreed with CPython on "
            f"{ratio:.0%} of them — this does not evaluate Python, so every "
            "'mismatch' would be an artefact of driving the wrong function"
        )
    return None


def cluster_mismatches(
    rows: list[dict[str, Any]],
    *,
    policy_patterns: tuple[str, ...] = (),
    adjudications: dict[str, str] | None = None,
) -> list[FailureCluster]:
    clusters: dict[str, FailureCluster] = {}
    for row in rows:
        verdict = judge_row(row, policy_patterns=policy_patterns, adjudications=adjudications)
        # policy-limit is a stated limit; unadjudicated is awaiting layer 2.
        # Neither is reported as a defect, and both are surfaced separately.
        if verdict is None or verdict["kind"] in ("policy-limit", "unadjudicated"):
            continue
        target = row.get("target", "?")
        detail = f"{verdict['kind']}: {verdict['detail']}"
        sig = normalize_signature("differential-mismatch", f"{target} {detail}")
        cluster = clusters.get(sig)
        if cluster is None:
            cluster = FailureCluster(
                signature=sig,
                kind="differential-mismatch",
                title=f"{target} — {detail}"[:300],
                endpoint_id=target,
                method="DIFF",
                path=target,
                exemplar={
                    "input": row.get("snippet"),
                    "strategy": f"differential/{verdict['kind']}",
                    "status": None,
                    "error": None,
                    "detail": detail,
                    "expected": "agreement with the reference implementation",
                },
            )
            clusters[sig] = cluster
        cluster.count += 1
    return sorted(clusters.values(), key=lambda c: (c.path, c.title))


# =========================================================================
# Driver
# =========================================================================


def run_differential(
    repo: Path,
    *,
    target: str | None = None,
    reference: str | None = None,
    call_kwargs: dict[str, Any] | None = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    python: str | None = None,
    max_adjudications: int = DEFAULT_MAX_ADJUDICATIONS,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Run every configured (target, reference) pair; persist and summarise.

    With ``target``/``reference`` given, runs exactly that pair (and records it
    in ``references.json``); otherwise runs the reference-finder's proposals.
    ``call_kwargs`` configures the target call (see the module docstring) and is
    persisted with the entry so later runs reuse it.
    """
    log = logger or logging.getLogger(__name__)
    repo = repo.resolve()

    if target:
        refs = [
            {
                "target": target,
                "reference": reference or "cpython-exec",
                "corpus": "ast",
                "extract": "auto",
                "call_kwargs": call_kwargs or {},
                "proposed_by": "cli",
            }
        ]
        doc = store.read_json(store.exercise_dir(repo) / "references.json")
        merged = {e["target"]: e for e in (doc or {}).get("references", []) if isinstance(e, dict)}
        merged[target] = refs[0]
        store.write_json(
            store.exercise_dir(repo) / "references.json",
            {"version": 1, "references": sorted(merged.values(), key=lambda e: e["target"])},
        )
    else:
        refs = propose_references(repo, logger=log).get("references", [])

    diagnostics: list[str] = []
    if not refs:
        diagnostics.append(
            "0 differential references — no evaluator-shaped targets were "
            "found and none are declared in .vinv/exercise/references.json. "
            'Declare one as {"target": "module:fn", "reference": '
            '"cpython-exec"} to arm this oracle.'
        )
        log.warning("differential_empty %s", diagnostics[0])

    corpus = list(AST_CORPUS) + list(AST_CORPUS_RAISING)
    src_roots = detect_src_roots(repo)
    tmp_dir = store.exercise_dir(repo) / "differential"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    timeouts: list[str] = []

    for entry in refs:
        tid = entry["target"]
        plan_file = tmp_dir / (tid.replace(":", "_").replace(".", "_") + ".plan.json")
        store.write_json(
            plan_file,
            {
                "target": tid,
                "reference": entry.get("reference", "cpython-exec"),
                "extract": entry.get("extract", "auto"),
                "call_kwargs": entry.get("call_kwargs") or {},
                "corpus": corpus,
                "src_roots": src_roots,
                # Only the finder's own proposals are shape-verified; an entry a
                # human or the CLI declared is an instruction, not a guess.
                "verify_shape": str(entry.get("proposed_by") or "").startswith("reference-finder"),
            },
        )
        cmd = [
            python or sys.executable,
            "-m",
            "exerciser.differential",
            "--worker",
            "--plan",
            str(plan_file),
            "--repo",
            str(repo),
        ]
        env = dict(os.environ)
        # The worker imports TARGET code, so it usually runs under the TARGET's
        # interpreter (--python). Keep our own package importable there.
        env["PYTHONPATH"] = os.pathsep.join(
            p for p in (env.get("PYTHONPATH"), str(Path(__file__).parents[1])) if p
        )
        try:
            proc = subprocess.run(  # noqa: S603 (fixed argv, no shell)
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout_s,
                cwd=str(repo),
                env=env,
            )
        except subprocess.TimeoutExpired:
            timeouts.append(tid)
            continue
        for line in (proc.stdout or "").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue

    # Per-entry policy patterns widen the "deliberate refusal" vocabulary.
    extra_policy = tuple(
        p for e in refs for p in (e.get("policy_patterns") or []) if isinstance(p, str)
    )
    # Layer-2 adjudications the harness has already authored, keyed by refusal
    # shape, plus the ones still outstanding.
    adj_doc = store.read_json(store.exercise_dir(repo) / "adjudications.json") or {}
    adjudications = {
        k: str(v.get("verdict"))
        for k, v in (adj_doc.get("verdicts") or {}).items()
        if isinstance(v, dict) and v.get("verdict") in ("policy", "defect")
    }
    # Drop targets that answered the corpus but agree with CPython almost
    # nowhere: they are not evaluators, and their "mismatches" are artefacts.
    implausible: dict[str, str] = {}
    for entry in refs:
        reason = implausible_evaluator(rows, entry["target"])
        if reason:
            implausible[entry["target"]] = reason
            log.warning("differential: dropping %s — %s", entry["target"], reason)
    if implausible:
        rows = [r for r in rows if r.get("target") not in implausible]

    clusters = cluster_mismatches(rows, policy_patterns=extra_policy, adjudications=adjudications)
    limits = policy_limits(rows, policy_patterns=extra_policy, adjudications=adjudications)
    all_pending = unadjudicated(rows, policy_patterns=extra_policy, adjudications=adjudications)
    pending = all_pending[:max_adjudications]
    overflow = len(all_pending) - len(pending)
    if pending:
        # Write the queue with its prompts, preserving any replies already
        # stored, so the extension can dispatch them like semantic prompts.
        merged = dict(adj_doc.get("verdicts") or {})
        for item in pending:
            merged.setdefault(
                item["key"],
                {
                    "target": item["target"],
                    "snippet": item["snippet"],
                    "message": item["message"],
                    "prompt": item["prompt"],
                    # The exception identity, so an answered verdict can be fed
                    # back to the learned policy under the right signature
                    # rather than being skipped for want of a type.
                    "exception": item.get("exception"),
                    "exception_module": item.get("exception_module"),
                    "verdict": None,
                },
            )
        store.write_json(
            store.exercise_dir(repo) / "adjudications.json",
            {
                "version": 1,
                "reply_schema": '{"verdict": "policy"|"defect", "why": "<one sentence>"}',
                "verdicts": merged,
            },
        )
    store.write_jsonl(store.exercise_dir(repo) / "differential_results.jsonl", rows)
    compared = sum(1 for r in rows if r.get("phase") == "compare")
    # Proposals whose live shape contradicted the source shape. Recorded, never
    # adjudicated: a target the oracle cannot call produces TypeErrors, and
    # TypeErrors from our own bad call are not evidence about the target.
    dropped = [
        {"target": r.get("target"), "reason": r.get("dropped_reason")}
        for r in rows
        if r.get("phase") == "verify" and r.get("status") == "dropped"
    ]
    result: dict[str, Any] = {
        "status": "ok",
        "diagnostics": diagnostics,
        "repo": str(repo),
        "pairs": len(refs),
        "corpus_size": len(corpus),
        "comparisons": compared,
        "mismatch_clusters": len(clusters),
        # Informational: what the sandbox deliberately refuses. NOT defects —
        # reporting a documented limit as a bug is how an oracle gets ignored.
        "implausible_evaluators": implausible,
        "policy_limits": limits,
        "policy_limit_count": len(limits),
        # Layer 1 declined to guess on these; they are queued for agentic
        # adjudication rather than silently called one thing or the other.
        "unadjudicated": pending,
        "unadjudicated_count": len(pending),
        # Distinct refusal SHAPES, not occurrences — the real question count.
        "unadjudicated_overflow": overflow,
        # Shape-verification drops: proposed by the finder, refused by the
        # worker once it could see the real callable.
        "dropped": dropped,
        "dropped_count": len(dropped),
        "timeouts": timeouts,
        "clusters": [c.to_json() for c in clusters],
        "results_file": str(store.exercise_dir(repo) / "differential_results.jsonl"),
    }
    # Close the learning loop even for a standalone run (the campaign does this
    # too): disagreements are self-supervised evidence, and answered
    # adjudications are real labels.
    try:
        from .exception_policy import (
            ExceptionPolicy,
            apply_feedback,
            feedback_from_adjudications,
            observe_differential_rows,
        )

        repo_pkgs = sorted({e["target"].partition(":")[0].partition(".")[0] for e in refs})
        policy = ExceptionPolicy.load(repo, decay=1.0)
        observe_differential_rows(policy, rows, repo_packages=repo_pkgs)
        policy.save(repo, logger=log)
        verdicts, _skipped = feedback_from_adjudications(adj_doc, repo_packages=repo_pkgs)
        if verdicts:
            apply_feedback(repo, verdicts, logger=log)
    except Exception as exc:  # learning is never allowed to fail a run
        log.debug("differential: policy feedback skipped (%s)", exc)

    store.write_json(store.exercise_dir(repo) / "differential.json", result)
    if overflow:
        diagnostics.append(
            f"{overflow} additional refusal shape(s) exceeded the "
            f"max_adjudications={max_adjudications} budget and were not queued "
            "this run — raise the budget or adjudicate the pending ones first."
        )
    log.info(
        "differential: %d pairs, %d comparisons, %d mismatch clusters, "
        "%d policy limits, %d awaiting adjudication (%d over budget)",
        len(refs),
        compared,
        len(clusters),
        len(limits),
        len(pending),
        overflow,
    )
    return result


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--worker" in argv:
        argv.remove("--worker")
        return _worker_main(argv)
    sys.stderr.write("exerciser.differential: use `exerciser differential <repo>`\n")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
