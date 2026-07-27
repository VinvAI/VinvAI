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
  target set, proposes a differential reference per symbol, by shape: a callable
  whose first required parameter is a ``str`` named like code
  (``code``/``source``/``src``/``expression``/``snippet``/``program``) in a
  module that works on ``ast`` is proposed the ``cpython-exec`` reference and
  the ast-corpus generator. Proposals land in
  ``.vinv/exercise/references.json`` where a human (or agent) can add explicit
  ``module:qualname`` references for anything the shape rules cannot see.
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
import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from . import store
from .functions import detect_src_roots, discover_targets
from .issues import FailureCluster, normalize_signature

DEFAULT_TIMEOUT_S = 60.0

_CODE_PARAM_NAMES = frozenset(
    {"code", "source", "src", "expression", "expr", "snippet", "program", "code_action"}
)

# Refusal messages that mean "this sandbox deliberately does not do that" —
# a documented limit, not a defect. Matched case-insensitively against the
# target's error message. Extend per-entry via `policy_patterns`.
POLICY_PATTERNS: tuple[str, ...] = (
    "is not supported",
    "are not supported",
    "not among the explicitly allowed",
    "forbidden function evaluation",
    "forbidden access",
    "is not allowed",
    "not permitted",
    "unauthorized",
    "unsafe",
    "disabled for security",
)


def is_policy_refusal(message: str, extra_patterns: tuple[str, ...] = ()) -> bool:
    """Whether a refusal message states a deliberate sandbox limit."""
    low = (message or "").lower()
    return any(p in low for p in (*POLICY_PATTERNS, *extra_patterns))


# =========================================================================
# The ast-corpus: deterministic snippets spanning node types
# =========================================================================
#
# Every snippet is self-contained, import-free, dunder-light, and ends with a
# bare `result` expression. Kept deliberately inside what a restrictive
# evaluator SHOULD support — disagreement on these is a defect, not a policy.

AST_CORPUS: tuple[str, ...] = (
    # arithmetic & numeric semantics
    "result = 7 // 2\nresult",
    "result = -7 // 2\nresult",
    "result = 7 % -3\nresult",
    "result = 2 ** 10\nresult",
    "result = 0.1 + 0.2\nresult",
    "result = divmod(17, 5)\nresult",
    "result = round(2.675, 2)\nresult",
    # comparisons (incl. chained) & boolean ops
    "result = 1 < 2 < 3\nresult",
    "result = 3 > 2 > 3\nresult",
    "result = (0 or '' or 'x')\nresult",
    "result = (1 and [] and 2)\nresult",
    "result = not []\nresult",
    "result = 'a' in 'cat' and 3 not in [1, 2]\nresult",
    "v = 1\nresult = (v == 1.0, v is not None)\nresult",
    # strings & f-strings
    "x = 5\nresult = f'{x:03d}-{x!r}'\nresult",
    "result = 'ab' * 3 + ''.join(['c', 'd'])\nresult",
    "result = 'Hello World'.title().swapcase()\nresult",
    "result = 'a,b,,c'.split(',')\nresult",
    # collections & comprehensions
    "result = [i * i for i in range(5) if i % 2]\nresult",
    "result = {k: v for k, v in [('a', 1), ('b', 2)]}\nresult",
    "result = {c for c in 'hello'} == set('hello')\nresult",
    "result = list(x + y for x, y in zip([1, 2], [10, 20]))\nresult",
    "result = sorted({'b': 2, 'a': 1}.items())\nresult",
    # slicing & unpacking
    "result = [0, 1, 2, 3, 4][::-1][1:3]\nresult",
    "a, *rest = [1, 2, 3, 4]\nresult = (a, rest)\nresult",
    "first, (second, third) = 1, (2, 3)\nresult = first + second + third\nresult",
    "d = {'x': 1}\nresult = {**d, 'y': 2}\nresult",
    # control flow
    "result = 0\nfor i in range(4):\n    result += i\nelse:\n    result += 100\nresult",
    "result = 0\nwhile result < 5:\n    result += 2\nresult",
    # while-else is a SEPARATE code path from for-else: an interpreter can
    # implement one and silently drop the other, and dropping it returns a
    # plausible number rather than raising.
    "result = 0\nwhile result < 3:\n    result += 1\nelse:\n    result += 100\nresult",
    "result = 0\nfor i in range(4):\n    if i == 2:\n        break\nelse:\n    result = 100\nresult",
    "result = []\nfor i in range(6):\n    if i == 2:\n        continue\n    if i == 4:\n        break\n    result.append(i)\nresult",
    "result = 'big' if 10 > 5 else 'small'\nresult",
    # exceptions
    "try:\n    1 / 0\nexcept ZeroDivisionError as e:\n    result = type(e).__name__\nresult",
    "try:\n    result = 'no-raise'\nexcept ValueError:\n    result = 'caught'\nelse:\n    result = result + '-else'\nfinally:\n    result = result + '-finally'\nresult",
    "def f():\n    try:\n        return 'try'\n    finally:\n        pass\nresult = f()\nresult",
    # functions, closures, defaults, *args/**kwargs, lambda
    "def add(a, b=10, *args, **kw):\n    return a + b + sum(args) + len(kw)\nresult = add(1, 2, 3, 4, k=5)\nresult",
    "def outer():\n    x = 1\n    def inner():\n        nonlocal x\n        x += 1\n        return x\n    inner()\n    return inner()\nresult = outer()\nresult",
    "result = (lambda x: x * 2)(21)\nresult",
    "fns = [lambda i=i: i for i in range(3)]\nresult = [f() for f in fns]\nresult",
    # generators
    "def gen(n):\n    for i in range(n):\n        yield i * 2\nresult = list(gen(4))\nresult",
    "g = (x + 1 for x in range(3))\nresult = sum(g)\nresult",
    # classes & dunder basics
    "class P:\n    def __init__(self, x):\n        self.x = x\n    def __repr__(self):\n        return f'P({self.x})'\nresult = repr(P(3))\nresult",
    "class C:\n    count = 0\n    def bump(self):\n        C.count += 1\n        return C.count\nc = C()\nc.bump()\nresult = c.bump()\nresult",
    # assignment semantics
    "x = 5\nx += 3\nx *= 2\nresult = x\nresult",
    "result = [1, 2]\nresult[0], result[1] = result[1], result[0]\nresult",
    "n = 10\nresult = [y := n + 1, y * 2]\nresult",
    # builtins an evaluator must proxy correctly
    "result = list(map(str, filter(None, [0, 1, '', 'a'])))\nresult",
    "result = (min([3, 1, 2]), max((4, 9)), abs(-7), len('abcd'))\nresult",
    "result = isinstance(True, int) and issubclass(bool, int)\nresult",
    "result = list(enumerate(['a', 'b'], start=1))\nresult",
    "result = int('ff', 16) + float('2.5')\nresult",
    # mutation & identity edge cases
    "a = [1, 2]\nb = a\nb.append(3)\nresult = a\nresult",
    "def f(x, acc=[]):\n    acc.append(x)\n    return list(acc)\nf(1)\nresult = f(2)\nresult",
)

# Snippets that must RAISE under CPython — an evaluator that accepts them has
# widened the language.
AST_CORPUS_RAISING: tuple[str, ...] = (
    "result = 1 / 0\nresult",
    "result = [1, 2][5]\nresult",
    "result = {'a': 1}['b']\nresult",
    "result = int('not-a-number')\nresult",
    "result = 'a' + 1\nresult",
    "result = undefined_name_xyz\nresult",
)


# =========================================================================
# Reference-finder
# =========================================================================


def propose_references(repo: Path, *, logger: logging.Logger | None = None) -> dict[str, Any]:
    """Propose differential references for the discovered function targets.

    Writes/merges ``.vinv/exercise/references.json``: existing entries (human-
    or agent-authored) always win; proposals only ADD. Each entry:
    ``{"target": "module:qualname", "reference": "cpython-exec" | "module:qualname",
    "corpus": "ast", "extract": "auto"}``.
    """
    log = logger or logging.getLogger(__name__)
    targets, _ = discover_targets(repo, logger=log)
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
        # Discovery does not import; parameter shapes come from the worker at
        # run time. The finder's cheap signal is the NAME: evaluator-shaped
        # callables are proposed and verified (or dropped) by the runner.
        low = t.qualname.lower()
        if any(k in low for k in ("evaluate", "interpret", "execute")) and not any(
            k in low for k in ("http", "request", "sql")
        ):
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
    row: dict[str, Any], *, policy_patterns: tuple[str, ...] = ()
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
        if is_policy_refusal(got_msg, policy_patterns):
            return {
                "kind": "policy-limit",
                "detail": f"deliberately refused: {got_msg[:200]}",
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
        if is_policy_refusal(got_msg, policy_patterns):
            # Both refuse; the target refuses for its own stated reason. That
            # is a policy difference, not a wrong answer.
            return {
                "kind": "policy-limit",
                "detail": f"deliberately refused: {got_msg[:200]}",
            }
        return {
            "kind": "wrong-exception",
            "detail": (
                f"reference raises {ref_exc} but the target raised "
                f"{got.get('exception')} without naming it: {got_msg[:160]}"
            ),
        }
    return None


def policy_limits(
    rows: list[dict[str, Any]], *, policy_patterns: tuple[str, ...] = ()
) -> list[dict[str, str]]:
    """Deliberate refusals, deduped — what this sandbox will not do.

    Informational output: an accurate map of a sandbox's documented limits is
    useful (it is the difference between "cannot" and "broken"), but it is not
    a defect list and never becomes an issue cluster.
    """
    seen: dict[str, dict[str, str]] = {}
    for row in rows:
        verdict = judge_row(row, policy_patterns=policy_patterns)
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


def cluster_mismatches(
    rows: list[dict[str, Any]], *, policy_patterns: tuple[str, ...] = ()
) -> list[FailureCluster]:
    clusters: dict[str, FailureCluster] = {}
    for row in rows:
        verdict = judge_row(row, policy_patterns=policy_patterns)
        if verdict is None or verdict["kind"] == "policy-limit":
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
    clusters = cluster_mismatches(rows, policy_patterns=extra_policy)
    limits = policy_limits(rows, policy_patterns=extra_policy)
    store.write_jsonl(store.exercise_dir(repo) / "differential_results.jsonl", rows)
    compared = sum(1 for r in rows if r.get("phase") == "compare")
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
        "policy_limits": limits,
        "policy_limit_count": len(limits),
        "timeouts": timeouts,
        "clusters": [c.to_json() for c in clusters],
        "results_file": str(store.exercise_dir(repo) / "differential_results.jsonl"),
    }
    store.write_json(store.exercise_dir(repo) / "differential.json", result)
    log.info(
        "differential: %d pairs, %d comparisons, %d mismatch clusters, %d policy limits",
        len(refs),
        compared,
        len(clusters),
        len(limits),
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
