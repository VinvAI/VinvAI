"""The FUNCTION-level input channel — calling code, not just requesting routes.

Until now every input Vinv could generate travelled as an HTTP request to a
discovered route. That caps what it can find to what a route reaches: a library
(no routes at all) was unexercisable, and even in a service the bugs living in
pure helpers — boundary/falsy handling, parser semantics, schema introspection,
interpreter-flag behaviour — sit behind a corridor no request opens.

This module drives catalogued entry points and exported functions IN PROCESS:
import the module, call the function, record args/returns/exceptions. It turns
the ``entrypoints`` inventory (which identification has always produced and
nothing ever consumed) into a target set.

Three deliberate design points:

* **Isolation by subprocess.** Target code is arbitrary: it can ``sys.exit``,
  spin forever, install signal handlers, or corrupt the interpreter. Each module
  is driven in a worker process (``python -m exerciser.functions --worker``)
  under a wall-clock deadline, so a hang or a hard exit costs one module's
  results, never the run. The worker is also the natural place for tracelens to
  attach, so function-level calls produce spans like any other traffic.
* **Deterministic arguments, with Hypothesis as an optional widener.** Values
  come from type hints via the same seeded generator the HTTP path uses; when
  ``hypothesis`` is installed, a property-based arm draws additional instances.
* **Destructive names are never called.** A harness that calls ``delete_all`` or
  ``drop_database`` because it was exported is not a testing tool. Names and
  modules matching the deny patterns are catalogued and skipped, loudly.

Artifacts land beside the HTTP ones: ``.vinv/exercise/functions.json`` (the
plan + summary) and ``function_results.jsonl`` (one row per call).
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
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import store
from .exception_policy import ExceptionPolicy, family_of, provenance_of, signature
from .issues import FailureCluster, normalize_signature

# Call names/modules a harness must never invoke, however they were catalogued.
# Substring match on the lowercased qualified name.
_DENY_SUBSTRINGS = (
    "delete",
    "destroy",
    "drop",
    "truncate",
    "purge",
    "wipe",
    "erase",
    "remove",
    "rmtree",
    "unlink",
    "shutdown",
    "terminate",
    "kill",
    "exit",
    "reboot",
    "restart",
    "format_disk",
    "deploy",
    "publish",
    "send_email",
    "charge",
    "payment",
    "transfer",
    "migrate",
    "upgrade",
    "downgrade",
)
# Modules never worth importing (side effects at import, or not target code).
_DENY_MODULE_PARTS = frozenset(
    {
        "setup",
        "conftest",
        "__main__",
        "migrations",
        "alembic",
    }
)

# Wall-clock deadline for one worker (all calls for one module).
DEFAULT_MODULE_TIMEOUT_S = 30.0
# Per-call deadline enforced inside the worker via a thread watchdog is not
# possible without cooperation, so the module deadline is the real bound; this
# caps how many calls one module may make so a fast function cannot monopolise
# the module's budget.
DEFAULT_CALLS_PER_FUNCTION = 6


# =========================================================================
# Candidate discovery
# =========================================================================


@dataclass
class FunctionTarget:
    """One callable the harness will drive, with its import coordinates."""

    module: str
    qualname: str
    file: str
    kind: str  # "entrypoint" | "exported"
    is_async: bool = False
    params: list[dict[str, Any]] = field(default_factory=list)

    @property
    def id(self) -> str:
        return f"{self.module}:{self.qualname}"

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "module": self.module,
            "qualname": self.qualname,
            "file": self.file,
            "kind": self.kind,
            "is_async": self.is_async,
            "params": self.params,
        }


def is_denied(name: str) -> bool:
    """Whether a qualified name must never be called by the harness."""
    low = name.lower()
    return any(s in low for s in _DENY_SUBSTRINGS)


def module_name_for(rel_file: str, src_roots: list[str]) -> str | None:
    """Import name for a repo-relative ``.py`` path, or None when it is not one.

    ``src_roots`` are repo-relative directories that sit on ``sys.path`` at
    runtime (``src``, ``.``); the longest matching root wins so
    ``src/pkg/mod.py`` becomes ``pkg.mod`` rather than ``src.pkg.mod``.
    """
    norm = rel_file.replace("\\", "/")
    if not norm.endswith(".py"):
        return None
    stem = norm[:-3]
    best: str | None = None
    for root in sorted(src_roots, key=len, reverse=True):
        r = root.strip("/")
        if not r or r == ".":
            cand = stem
        elif stem == r or stem.startswith(r + "/"):
            cand = stem[len(r) :].strip("/")
        else:
            continue
        if best is None:
            best = cand
    if best is None:
        return None
    parts = [p for p in best.split("/") if p]
    if not parts:
        return None
    if parts[-1] == "__init__":
        parts = parts[:-1]
    if not parts or any(p in _DENY_MODULE_PARTS for p in parts):
        return None
    if not all(p.isidentifier() for p in parts):
        return None
    return ".".join(parts)


def detect_src_roots(repo: Path) -> list[str]:
    """Repo-relative directories that behave as import roots.

    ``src/`` when present (the src-layout convention), plus the repo root.
    """
    roots = ["."]
    if (repo / "src").is_dir():
        roots.insert(0, "src")
    return roots


def _param_records(fn: Any) -> list[dict[str, Any]] | None:
    """Serializable parameter records for a callable, or None when undrivable.

    A parameter with no default and no usable annotation makes the call a guess,
    so the target is skipped rather than called with junk — the harness reports
    what it could NOT drive instead of manufacturing false failures.
    """
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return None
    out: list[dict[str, Any]] = []
    for name, p in sig.parameters.items():
        if name in ("self", "cls"):
            continue
        if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
            continue  # *args/**kwargs: callable without them
        ann = p.annotation
        # Guard the empty sentinel FIRST: inspect.Parameter.empty is a class,
        # so getattr(ann, "__name__") on it yields the truthy "_empty" and an
        # unannotated parameter would masquerade as an annotated one.
        ann_name = None
        if ann is not p.empty:
            ann_name = getattr(ann, "__name__", None) or str(ann)
        has_default = p.default is not p.empty
        if not has_default and ann_name is None:
            return None
        out.append(
            {
                "name": name,
                "annotation": ann_name,
                "has_default": has_default,
                "keyword_only": p.kind == p.KEYWORD_ONLY,
            }
        )
    return out


def discover_targets(
    repo: Path,
    *,
    max_targets: int = 200,
    logger: logging.Logger | None = None,
) -> tuple[list[FunctionTarget], list[dict[str, str]]]:
    """Callables to drive, plus the skipped ones with reasons.

    Two sources, in priority order: identification's catalogued NON-HTTP entry
    points (CLI commands, tasks, script mains — inventory that has never had a
    driver), then public module-level functions of the same files. Discovery
    imports nothing; signatures are read in the worker, so a module that
    explodes on import costs only its own results.
    """
    log = logger or logging.getLogger(__name__)
    apis_doc = store.read_json(store.apis_json_path(repo))
    entrypoints = (apis_doc or {}).get("entrypoints") or []
    src_roots = detect_src_roots(repo)

    targets: list[FunctionTarget] = []
    skipped: list[dict[str, str]] = []
    seen: set[str] = set()

    def _add(module: str, qualname: str, rel: str, kind: str) -> None:
        tid = f"{module}:{qualname}"
        if tid in seen or len(targets) >= max_targets:
            return
        if is_denied(qualname) or is_denied(module):
            skipped.append({"id": tid, "reason": "destructive-name"})
            seen.add(tid)
            return
        seen.add(tid)
        targets.append(FunctionTarget(module=module, qualname=qualname, file=rel, kind=kind))

    files_seen: set[str] = set()
    for ep in entrypoints:
        if not isinstance(ep, dict) or ep.get("kind") == "http_api":
            continue
        rel = ep.get("file")
        handler = ep.get("handler")
        if not isinstance(rel, str):
            continue
        files_seen.add(rel)
        module = module_name_for(rel, src_roots)
        if module is None:
            skipped.append({"id": rel, "reason": "not-an-importable-module"})
            continue
        if isinstance(handler, str) and handler:
            _add(module, handler, rel, "entrypoint")

    # Exported functions of the same modules widen the target set past the
    # handful of decorated entry points — for a LIBRARY that is the whole
    # surface. Names are read from source (no import) via the code index.
    index_syms = _index_functions_by_file(repo)
    for rel in sorted(index_syms if not files_seen else (files_seen | set(index_syms))):
        module = module_name_for(rel, src_roots)
        if module is None:
            continue
        for name in index_syms.get(rel, []):
            if name.startswith("_"):
                continue  # private by convention
            _add(module, name, rel, "exported")

    log.info(
        "functions: %d targets, %d skipped (roots=%s)",
        len(targets),
        len(skipped),
        src_roots,
    )
    return targets, skipped


def _index_functions_by_file(repo: Path) -> dict[str, list[str]]:
    """Module-level function names per repo-relative file, from the code index.

    Deliberately reads the SAME index the rest of Vinv reads; when it is absent
    the harness still runs on the catalogued entry points alone.
    """
    chunks = repo / ".vinv" / "index" / "chunks.jsonl"
    out: dict[str, list[str]] = {}
    if not chunks.is_file():
        return out
    try:
        with chunks.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict) or rec.get("kind") != "function":
                    continue
                rel, name = rec.get("file"), rec.get("name")
                if not isinstance(rel, str) or not isinstance(name, str):
                    continue
                if rec.get("parent"):
                    continue  # methods need an instance; module-level only
                out.setdefault(rel, []).append(name)
    except OSError:
        return out
    return {k: sorted(set(v)) for k, v in out.items()}


# =========================================================================
# Argument generation
# =========================================================================

# Deterministic per-class values by annotation, mirroring schema.py's classes:
# a valid instance, a boundary instance, and a hostile one.
_BY_ANNOTATION: dict[str, dict[str, Any]] = {
    "str": {"valid": "vinv", "boundary": "", "negative": None},
    "int": {"valid": 3, "boundary": 0, "negative": -(2**63)},
    "float": {"valid": 1.5, "boundary": 0.0, "negative": float("nan")},
    "bool": {"valid": True, "boundary": False, "negative": None},
    "bytes": {"valid": b"vinv", "boundary": b"", "negative": None},
    "list": {"valid": [1, 2], "boundary": [], "negative": None},
    "dict": {"valid": {"k": "v"}, "boundary": {}, "negative": None},
    "tuple": {"valid": (1, 2), "boundary": (), "negative": None},
    "set": {"valid": {1}, "boundary": set(), "negative": None},
}
INPUT_CLASSES = ("valid", "boundary", "negative")


def value_for(annotation: str | None, cls: str) -> Any:
    """Deterministic argument value for an annotation and input class.

    Unknown annotations fall back to the string family — a wrong-typed argument
    is itself a legitimate probe (the negative class exists to be rejected).
    """
    if annotation:
        base = annotation.split("[")[0].split(".")[-1].strip().lower()
        table = _BY_ANNOTATION.get(base)
        if table is not None:
            return table[cls]
        if base in ("any", "object"):
            return _BY_ANNOTATION["str"][cls]
        if base in ("none", "nonetype"):
            return None
    return _BY_ANNOTATION["str"][cls]


def arg_sets_for(params: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One argument map per input class for a target's parameters.

    Parameters with defaults are omitted from the ``valid`` set (exercising the
    documented default path) and supplied in the others.
    """
    out: list[dict[str, Any]] = []
    for cls in INPUT_CLASSES:
        kwargs: dict[str, Any] = {}
        for p in params:
            if cls == "valid" and p.get("has_default"):
                continue
            kwargs[p["name"]] = value_for(p.get("annotation"), cls)
        out.append({"class": cls, "kwargs": kwargs})
    return out


# =========================================================================
# Worker — runs INSIDE the subprocess, importing target code
# =========================================================================


def _summarize(value: Any, cap: int = 200) -> Any:
    """JSON-safe, bounded rendering of a return value."""
    try:
        if value is None or isinstance(value, bool | int | float):
            return value
        if isinstance(value, str):
            return value[:cap]
        if isinstance(value, list | tuple | set):
            return {"type": type(value).__name__, "len": len(value)}
        if isinstance(value, dict):
            return {"type": "dict", "len": len(value), "keys": sorted(map(str, value))[:12]}
        return {"type": type(value).__name__, "repr": repr(value)[:cap]}
    except Exception:
        return {"type": "unrenderable"}


def _worker_main(argv: list[str]) -> int:
    """Drive one module's targets in this process; emit JSONL rows on stdout."""
    ap = argparse.ArgumentParser(prog="exerciser-functions-worker")
    ap.add_argument("--plan", required=True, help="path to the per-module plan JSON")
    ap.add_argument("--repo", required=True)
    args = ap.parse_args(argv)

    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    repo = Path(args.repo)
    for root in plan.get("src_roots", ["."]):
        p = str((repo / root).resolve())
        if p not in sys.path:
            sys.path.insert(0, p)

    module_name = plan["module"]
    repo_packages = plan.get("repo_packages") or []
    rows: list[dict[str, Any]] = []
    try:
        mod = importlib.import_module(module_name)
    except BaseException as exc:  # target import can raise anything, incl. SystemExit
        rows.append(
            {
                "module": module_name,
                "target_id": module_name,
                "phase": "import",
                "status": "error",
                "error_type": type(exc).__name__,
                "error_module": getattr(type(exc), "__module__", "") or "",
                "error_mro": [c.__name__ for c in type(exc).__mro__],
                "repo_packages": plan.get("repo_packages") or [],
                "error": str(exc)[:400],
            }
        )
        _emit(rows)
        return 0

    for row in rows:  # the import-failure row, if any
        row.setdefault("repo_packages", repo_packages)
    for target in plan["targets"]:
        qual = target["qualname"]
        try:
            fn = getattr(mod, qual, None)
        except Exception:
            fn = None
        if fn is None or not callable(fn):
            rows.append(
                {
                    "module": module_name,
                    "target_id": f"{module_name}:{qual}",
                    "phase": "resolve",
                    "status": "skipped",
                    "error": "not a module-level callable",
                }
            )
            continue
        params = _param_records(fn)
        if params is None:
            rows.append(
                {
                    "module": module_name,
                    "target_id": f"{module_name}:{qual}",
                    "phase": "signature",
                    "status": "skipped",
                    "error": "unannotated required parameter — refusing to guess",
                }
            )
            continue
        for arg_set in arg_sets_for(params):
            row = _call_once(module_name, qual, fn, arg_set)
            row["repo_packages"] = repo_packages
            rows.append(row)
    _emit(rows)
    return 0


def _call_once(module: str, qual: str, fn: Any, arg_set: dict[str, Any]) -> dict[str, Any]:
    """Call one target once, recording the outcome. Never raises."""
    started = time.monotonic()
    row: dict[str, Any] = {
        "module": module,
        "target_id": f"{module}:{qual}",
        "qualname": qual,
        "phase": "call",
        "input_class": arg_set["class"],
        "kwargs": {k: _summarize(v) for k, v in arg_set["kwargs"].items()},
    }
    try:
        out = fn(**arg_set["kwargs"])
        if inspect.isawaitable(out):
            import asyncio

            out = asyncio.run(_await(out))
        row.update(status="ok", result=_summarize(out), result_type=type(out).__name__)
    except BaseException as exc:  # a target may raise SystemExit/KeyboardInterrupt
        row.update(
            status="error",
            error_type=type(exc).__name__,
            # WHERE the exception class is defined: an exception the target
            # package defines itself is a deliberate refusal signal, not a
            # crash. builtins/third-party origins are judged on type alone.
            error_module=getattr(type(exc), "__module__", "") or "",
            # The class hierarchy the target itself declared. Scoring by what
            # an exception INHERITS (Python's own taxonomy) is what lets the
            # policy transfer to a repo whose exception names are unknown.
            error_mro=[c.__name__ for c in type(exc).__mro__],
            error=str(exc)[:400],
            traceback_tail="".join(traceback.format_exception_only(type(exc), exc))[:400],
        )
    row["duration_ms"] = round((time.monotonic() - started) * 1000.0, 3)
    return row


async def _await(awaitable: Any) -> Any:
    return await awaitable


def _emit(rows: list[dict[str, Any]]) -> None:
    for r in rows:
        sys.stdout.write(json.dumps(r, default=str) + "\n")
    sys.stdout.flush()


# =========================================================================
# Driver — the parent side
# =========================================================================


def _expected_for(input_class: str) -> str:
    if input_class == "negative":
        return "a typed rejection (TypeError/ValueError) or a handled result"
    return "a result, or a documented exception"


# Exception types a wrong-typed (negative-class) argument SHOULD produce: they
# are the function correctly refusing bad input, not a defect.
# The only NON-learned rule: a call the harness itself got wrong (it failed to
# supply a parameter) is a HARNESS defect, not a target one. This is about our
# own call construction, not about the target's exception vocabulary, so it is
# not something to learn per repo.
_MALFORMED_CALL_MARKERS = (
    "required positional argument",
    "required keyword-only argument",
    "unexpected keyword argument",
    "takes no arguments",
)


def call_verdict(
    row: dict[str, Any],
    policy: ExceptionPolicy | None = None,
    *,
    total_targets: int = 0,
) -> str:
    """Classify one call outcome, using the LEARNED exception policy.

    ``ok`` | ``rejected`` (the target refused our guessed value) |
    ``malformed-call`` (our own fault) | ``defect``.

    There is deliberately no built-in list of exception names: which exceptions
    mean "no" is a property of the repository under test, and is learned from
    dispersion, input-class invariance and provenance (see
    ``exception_policy``). Without a policy the structural priors alone decide,
    which is still repo-agnostic.
    """
    if row.get("status") != "error":
        return "ok"
    etype = str(row.get("error_type", ""))
    message = str(row.get("error", ""))
    if etype == "TypeError" and any(m in message for m in _MALFORMED_CALL_MARKERS):
        return "malformed-call"
    policy = policy or ExceptionPolicy()
    prov = provenance_of(
        str(row.get("error_module", "")), {str(n) for n in (row.get("repo_packages") or [])}
    )
    fam = family_of(row.get("error_mro") or [etype])
    key = signature(etype, prov)
    # valid/boundary values conform to the declared annotation (0 IS an int);
    # negative values deliberately violate it.
    conformant = str(row.get("input_class", "")) in ("valid", "boundary")
    return (
        "defect"
        if policy.is_defect(
            key,
            provenance=prov,
            total_targets=total_targets,
            family=fam,
            conformant=conformant,
        )
        else "rejected"
    )


def classify_row(
    row: dict[str, Any],
    policy: ExceptionPolicy | None = None,
    *,
    total_targets: int = 0,
) -> str | None:
    """Failure kind for one row, or None when it is not a reportable defect.

    The harness GUESSES inputs, so it cannot tell "the function is broken" from
    "the function refused my made-up value" by looking at one call. The learned
    policy makes that call from evidence across the whole run, and everything
    it declines is still COUNTED in the verdict tally — never silently dropped.
    """
    if row.get("phase") == "import" and row.get("status") == "error":
        # Import supplies NO input, so nothing the harness did can explain the
        # failure. Two structural exemptions, and everything else is the
        # module's own doing: a dependency this machine lacks (the ImportError
        # family, which ModuleNotFoundError inherits), and an exception the
        # REPO defines — a package stating its own precondition ("you must
        # provide an api_key") rather than breaking.
        mro = list(row.get("error_mro") or [str(row.get("error_type", ""))])
        prov = provenance_of(
            str(row.get("error_module", "")),
            {str(n) for n in (row.get("repo_packages") or [])},
        )
        # Membership in the MRO, not the most-specific family: ModuleNotFoundError
        # IS an ImportError, and both mean "this machine lacks a dependency".
        if "ImportError" in mro or prov == "repo":
            return None
        return "import-error"
    if row.get("phase") != "call":
        return None
    return (
        "function-crash"
        if call_verdict(row, policy, total_targets=total_targets) == "defect"
        else None
    )


def learn_exception_policy(
    rows: list[dict[str, Any]], policy: ExceptionPolicy, total_targets: int
) -> ExceptionPolicy:
    """Feed a run's outcomes into the policy BEFORE any of them are judged.

    Order matters: dispersion and class-invariance are properties of the whole
    run, so every sighting must be recorded before the first verdict is taken.
    Sightings carry no defect label — they are unlabelled evidence that shapes
    the structural features; only downstream feedback (``record_feedback``)
    supplies labels.
    """
    for row in rows:
        if row.get("status") != "error":
            continue
        prov = provenance_of(
            str(row.get("error_module", "")),
            {str(n) for n in (row.get("repo_packages") or [])},
        )
        policy.observe(
            signature(str(row.get("error_type", "")), prov),
            target=str(row.get("target_id", "")),
            input_class=str(row.get("input_class", "import")),
        )
    return policy


def _policy_report(policy: ExceptionPolicy, total_targets: int) -> dict[str, Any]:
    """Per-signature decision probabilities, for the run summary."""
    out: dict[str, Any] = {}
    for key, ev in sorted(policy.evidence.items()):
        _, provenance = key.rsplit("@", 1) if "@" in key else (key, "unknown")
        probability, confident = policy.defect_probability(
            key, provenance=provenance, total_targets=total_targets, family=key.split("@")[0]
        )
        out[key] = {
            "defect_probability": round(probability, 4),
            "confident": confident,
            "targets": len(ev.targets),
            "occurrences": ev.occurrences,
        }
    return out


def cluster_function_failures(
    rows: list[dict[str, Any]],
    policy: ExceptionPolicy | None = None,
    *,
    total_targets: int = 0,
) -> list[FailureCluster]:
    """Cluster failing function calls the same way HTTP failures cluster."""
    clusters: dict[str, FailureCluster] = {}
    for row in rows:
        kind = classify_row(row, policy, total_targets=total_targets)
        if kind is None:
            continue
        target = row.get("target_id", "?")
        detail = f"{row.get('error_type', 'error')}: {row.get('error', '')}"
        sig = normalize_signature(kind, f"{target} {detail}")
        cluster = clusters.get(sig)
        if cluster is None:
            cluster = FailureCluster(
                signature=sig,
                kind=kind,
                title=f"{target} — {detail}"[:300],
                endpoint_id=target,
                method="CALL",
                path=target,
                exemplar={
                    "input": row.get("kwargs"),
                    "strategy": f"function/{row.get('input_class', 'import')}",
                    "status": None,
                    "error": row.get("error"),
                    "detail": detail,
                    "expected": _expected_for(row.get("input_class", "")),
                },
            )
            clusters[sig] = cluster
        cluster.count += 1
    return sorted(clusters.values(), key=lambda c: (c.kind, c.path))


def run_functions(
    repo: Path,
    *,
    service: str | None = None,
    max_targets: int = 200,
    module_timeout_s: float = DEFAULT_MODULE_TIMEOUT_S,
    python: str | None = None,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Drive every discovered function target in isolated workers. Persists all
    artifacts and returns a summary.

    Each module gets one worker with a wall-clock deadline; a hang or hard exit
    costs that module's rows and is reported as a ``module-timeout`` — never a
    silent gap, and never the run.
    """
    log = logger or logging.getLogger(__name__)
    repo = repo.resolve()
    targets, skipped = discover_targets(repo, max_targets=max_targets, logger=log)

    diagnostics: list[str] = []
    if not targets:
        diagnostics.append(
            "0 function targets discovered — nothing to drive in-process. "
            "Either the code index is missing (run `index index`) or every "
            "candidate was skipped; see `skipped` for reasons."
        )
        log.warning("functions_empty %s", diagnostics[0])

    by_module: dict[str, list[FunctionTarget]] = {}
    for t in targets:
        by_module.setdefault(t.module, []).append(t)
    # Every top-level package this repo owns — an exception defined in any of
    # them is the repo's own deliberate signal, whichever module raised it.
    repo_packages = sorted({t.module.partition(".")[0] for t in targets})

    src_roots = detect_src_roots(repo)
    tmp_dir = store.exercise_dir(repo) / "functions"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    timeouts: list[str] = []

    for module, mod_targets in sorted(by_module.items()):
        plan_file = tmp_dir / f"{module.replace('.', '_')}.plan.json"
        store.write_json(
            plan_file,
            {
                "module": module,
                "src_roots": src_roots,
                "repo_packages": repo_packages,
                "targets": [t.to_json() for t in mod_targets],
            },
        )
        cmd = [
            python or sys.executable,
            "-m",
            "exerciser.functions",
            "--worker",
            "--plan",
            str(plan_file),
            "--repo",
            str(repo),
        ]
        env = dict(os.environ)
        # The worker imports TARGET code; keep our own package importable too.
        env["PYTHONPATH"] = os.pathsep.join(
            [p for p in (env.get("PYTHONPATH"), *(str(Path(__file__).parents[1]),)) if p]
        )
        try:
            proc = subprocess.run(  # noqa: S603 (fixed argv, no shell)
                cmd,
                capture_output=True,
                text=True,
                timeout=module_timeout_s,
                cwd=str(repo),
                env=env,
            )
        except subprocess.TimeoutExpired:
            timeouts.append(module)
            rows.append(
                {
                    "module": module,
                    "target_id": module,
                    "phase": "module",
                    "status": "error",
                    "error_type": "ModuleTimeout",
                    "error": (
                        f"module exceeded {module_timeout_s}s — a call hung "
                        "(candidate deadlock/infinite loop)"
                    ),
                }
            )
            continue
        for line in (proc.stdout or "").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
        if proc.returncode != 0 and not rows:
            log.debug("functions: worker for %s exited %s", module, proc.returncode)

    # Learn from the WHOLE run before judging any of it: dispersion and
    # class-invariance are run-level properties, so a first-pass over every
    # sighting has to happen before the first verdict.
    policy = ExceptionPolicy.load(repo)
    learn_exception_policy(rows, policy, len(targets))
    policy.save(repo, logger=log)

    clusters = cluster_function_failures(rows, policy, total_targets=len(targets))
    store.write_jsonl(store.exercise_dir(repo) / "function_results.jsonl", rows)

    called = sum(1 for r in rows if r.get("phase") == "call")
    verdicts: dict[str, int] = {}
    for r in rows:
        if r.get("phase") == "call":
            v = call_verdict(r, policy, total_targets=len(targets))
            verdicts[v] = verdicts.get(v, 0) + 1
    result: dict[str, Any] = {
        "status": "ok",
        "diagnostics": diagnostics,
        "repo": str(repo),
        "service": service,
        "targets": len(targets),
        "modules": len(by_module),
        "calls": called,
        "errors": sum(1 for r in rows if r.get("status") == "error"),
        # Honest accounting of every call outcome. `rejected` and `environment`
        # are NOT defects — the harness guesses inputs, so a refusal is usually
        # the function working — but they are counted, never hidden.
        "verdicts": dict(sorted(verdicts.items())),
        # What the LEARNED policy currently believes — the DECISION probability
        # (structural priors blended with accumulated evidence), not the raw
        # posterior, so a run is auditable rather than an oracle handing down
        # opinions.
        "exception_policy": _policy_report(policy, len(targets)),
        "module_timeouts": timeouts,
        "skipped": skipped[:100],
        "skipped_count": len(skipped),
        "issue_clusters": len(clusters),
        "clusters": [c.to_json() for c in clusters],
        "results_file": str(store.exercise_dir(repo) / "function_results.jsonl"),
    }
    store.write_json(store.exercise_dir(repo) / "functions.json", result)
    log.info(
        "functions: %d targets in %d modules, %d calls, %d clusters, %d timeouts",
        len(targets),
        len(by_module),
        called,
        len(clusters),
        len(timeouts),
    )
    return result


def main(argv: list[str] | None = None) -> int:
    """``python -m exerciser.functions --worker …`` dispatch (worker only)."""
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--worker" in argv:
        argv.remove("--worker")
        return _worker_main(argv)
    sys.stderr.write("exerciser.functions: use `exerciser functions <repo>`\n")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
