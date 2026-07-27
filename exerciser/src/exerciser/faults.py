"""Boundary fault injection — adversarial-but-LEGAL shapes at a dependency edge.

Every integration boundary (a model provider, an MCP server, an HTTP dependency)
has a type contract, and the bugs live in the gap between what that contract
*permits* and what the consuming code *assumes*. Nothing in a normal run
produces those shapes: the real dependency is well-behaved, so the handling code
for ``content=None`` or a truncated fence is never executed until a user hits it
in production.

Two pieces, mirroring the differential oracle's finder/runner split:

* **Fault cataloguer** (``catalogue_faults``) — derives the adversarial-shape
  set from a boundary's declared type contract. A ``str | None`` field yields
  ``None``, ``""`` and a lone-surrogate string; a list field yields ``[]``,
  a duplicate-index list and a reordered one; a fenced-text field yields every
  truncation of its fence. Each fault carries WHY it is legal, so a report can
  say "the contract permits this" rather than "we made something up".
* **Chunk-boundary sweep** (``chunk_boundary_cases``) — for a canonical stream
  of length L, emit all L split points and assert the aggregator converges to
  the same value. Streaming aggregators are where off-by-one and
  partial-token-buffer bugs live, and a sweep is the only way to find the one
  split that breaks: testing "a stream" tests one arbitrary split of L.

The runner (``run_faults``) drives a target callable over the catalogue in an
isolated worker (same discipline as ``functions.py``/``differential.py``) and
clusters two failure kinds:

* ``fault-crash`` — the boundary shape was legal and the consumer raised an
  UNTYPED exception (a typed rejection is correct handling, not a defect);
* ``fault-divergence`` — a chunk-boundary sweep where different split points
  produced different aggregate results. The aggregator is order-dependent on
  chunking, which is always a bug.
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import os
import subprocess
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import store
from .functions import detect_src_roots
from .issues import FailureCluster, normalize_signature

DEFAULT_TIMEOUT_S = 60.0

# A lone surrogate: legal in a Python str, unencodable as UTF-8. Providers
# return these from truncated multi-byte sequences.
_LONE_SURROGATE = "bad\ud800text"


@dataclass
class Fault:
    """One adversarial-but-legal value for a boundary field."""

    field_name: str
    label: str
    value: Any
    why_legal: str

    def to_json(self) -> dict[str, Any]:
        return {
            "field": self.field_name,
            "label": self.label,
            "value": self.value,
            "why_legal": self.why_legal,
        }


@dataclass
class FaultBoundary:
    """A dependency edge described by its type contract."""

    name: str
    target: str  # "module:qualname" — the consumer to drive
    contract: dict[str, str] = field(default_factory=dict)  # field -> type spec
    # A canonical, WELL-FORMED payload; faults are applied on top of it, so the
    # only difference between a passing and a failing call is the one field.
    baseline: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "target": self.target,
            "contract": self.contract,
            "baseline": self.baseline,
        }


def catalogue_faults(contract: dict[str, str]) -> list[Fault]:
    """Adversarial-but-legal values implied by a boundary's type contract.

    Derived from the DECLARED type, not from imagination: an optional field can
    legally be absent, a list can legally be empty or arrive out of order, a
    string can legally hold an unpaired surrogate. Deterministic and ordered.
    """
    faults: list[Fault] = []
    for name in sorted(contract):
        spec = (contract[name] or "").strip().lower()
        optional = "none" in spec or spec.endswith("?") or spec.startswith("optional")
        base = spec.replace("optional[", "").replace("]", "")
        base = base.split("|")[0].strip().rstrip("?") or "str"

        if optional:
            faults.append(Fault(name, "none", None, f"contract declares {name} as optional"))
        if base.startswith("str") or base in ("string", "text"):
            faults.append(Fault(name, "empty", "", "the empty string is a valid str"))
            faults.append(
                Fault(
                    name,
                    "lone-surrogate",
                    _LONE_SURROGATE,
                    "a lone surrogate is a legal str but is not UTF-8 encodable",
                )
            )
            faults.append(
                Fault(
                    name,
                    "whitespace-only",
                    "   \n\t",
                    "whitespace-only text is a valid str",
                )
            )
        elif base.startswith("list") or base.startswith("seq") or base.startswith("array"):
            faults.append(Fault(name, "empty", [], "an empty list is a valid list"))
            faults.append(
                Fault(
                    name,
                    "duplicate-index",
                    [{"index": 0}, {"index": 0}],
                    "nothing in the contract makes stream indices unique",
                )
            )
            faults.append(
                Fault(
                    name,
                    "reordered",
                    [{"index": 1}, {"index": 0}],
                    "delivery order is not guaranteed by the contract",
                )
            )
        elif base.startswith("dict") or base.startswith("map") or base.startswith("object"):
            faults.append(Fault(name, "empty", {}, "an empty mapping is a valid dict"))
        elif base.startswith("int") or base.startswith("num") or base.startswith("float"):
            faults.append(Fault(name, "zero", 0, "zero is in range for a number"))
            faults.append(Fault(name, "negative", -1, "the contract states no lower bound"))
        elif base.startswith("bool"):
            faults.append(Fault(name, "false", False, "False is a valid bool"))
    return faults


# =========================================================================
# Chunk-boundary sweep
# =========================================================================


def chunk_boundary_cases(canonical: str) -> list[list[str]]:
    """Every single split of ``canonical`` into two chunks, plus the extremes.

    For a stream of length L there are L+1 split points, and an aggregator that
    buffers partial tokens breaks at exactly the splits that fall INSIDE a
    token. Testing "a stream" tests one arbitrary split; the sweep tests all of
    them, which is the only way to find that one.
    """
    cases: list[list[str]] = [[canonical]] if canonical else [[]]
    for i in range(1, len(canonical)):
        cases.append([canonical[:i], canonical[i:]])
    # Per-character chunking is the worst case for any buffering aggregator.
    if canonical:
        cases.append(list(canonical))
    return cases


# =========================================================================
# Worker — runs INSIDE the subprocess, importing target code
# =========================================================================


def _summarize(value: Any, cap: int = 200) -> Any:
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


def _resolve(target: str) -> Any:
    mod_name, _, qual = target.partition(":")
    mod = importlib.import_module(mod_name)
    obj = mod
    for part in qual.split("."):
        obj = getattr(obj, part)
    return obj


def _worker_main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="exerciser-faults-worker")
    ap.add_argument("--plan", required=True)
    ap.add_argument("--repo", required=True)
    args = ap.parse_args(argv)

    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    repo = Path(args.repo)
    for root in plan.get("src_roots", ["."]):
        p = str((repo / root).resolve())
        if p not in sys.path:
            sys.path.insert(0, p)

    rows: list[dict[str, Any]] = []
    target = plan["target"]
    try:
        fn = _resolve(target)
    except BaseException as exc:
        rows.append(
            {
                "boundary": plan["name"],
                "target": target,
                "phase": "import",
                "status": "error",
                "error_type": type(exc).__name__,
                "error": str(exc)[:400],
            }
        )
        _emit(rows)
        return 0

    baseline = plan.get("baseline") or {}
    # 1) Shape faults: the baseline payload with ONE field made adversarial.
    for fault in plan.get("faults", []):
        payload = dict(baseline)
        payload[fault["field"]] = fault["value"]
        rows.append(_call_once(plan["name"], target, fn, payload, fault))

    # 2) Chunk-boundary sweep: every split must aggregate to the same value.
    sweep = plan.get("chunk_sweep")
    if sweep:
        field_name = sweep["field"]
        outcomes: list[dict[str, Any]] = []
        for idx, chunks in enumerate(sweep["cases"]):
            payload = dict(baseline)
            payload[field_name] = chunks
            row = _call_once(
                plan["name"],
                target,
                fn,
                payload,
                {
                    "field": field_name,
                    "label": f"split-{idx}",
                    "why_legal": "chunking is not part of the contract",
                },
                phase="chunk-sweep",
            )
            row["split_index"] = idx
            row["chunk_count"] = len(chunks)
            outcomes.append(row)
            rows.append(row)
        # Convergence: every split that SUCCEEDED must agree on the result.
        values = {
            json.dumps(o.get("result"), sort_keys=True, default=str)
            for o in outcomes
            if o.get("status") == "ok"
        }
        rows.append(
            {
                "boundary": plan["name"],
                "target": target,
                "phase": "chunk-convergence",
                "status": "ok" if len(values) <= 1 else "error",
                "distinct_results": len(values),
                "splits": len(outcomes),
                "error": (
                    None
                    if len(values) <= 1
                    else (
                        f"{len(values)} distinct aggregate results across "
                        f"{len(outcomes)} split points — the aggregator is "
                        "chunk-boundary dependent"
                    )
                ),
            }
        )
    _emit(rows)
    return 0


def _call_once(
    boundary: str,
    target: str,
    fn: Any,
    payload: dict[str, Any],
    fault: dict[str, Any],
    *,
    phase: str = "fault",
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "boundary": boundary,
        "target": target,
        "phase": phase,
        "fault_field": fault.get("field"),
        "fault_label": fault.get("label"),
        "why_legal": fault.get("why_legal"),
    }
    try:
        out = fn(**payload)
        row.update(status="ok", result=_summarize(out))
    except BaseException as exc:
        row.update(
            status="error",
            error_type=type(exc).__name__,
            error=str(exc)[:400],
            traceback_tail="".join(traceback.format_exception_only(type(exc), exc))[:300],
        )
    return row


def _emit(rows: list[dict[str, Any]]) -> None:
    for r in rows:
        sys.stdout.write(json.dumps(r, default=str) + "\n")
    sys.stdout.flush()


# =========================================================================
# Driver
# =========================================================================

# Exceptions that mean "the consumer deliberately refused this shape at the
# edge". Deliberately NARROWER than the function harness's set: there, the
# harness supplies a wrong-typed argument against the annotation, so an
# AttributeError is the function correctly rejecting junk. HERE the contract
# says the shape is LEGAL, so `AttributeError: 'NoneType' has no attribute
# 'strip'` is not a refusal — it is the assumption failing three frames in,
# which is precisely the defect this oracle exists to find.
_TYPED_REJECTIONS = frozenset(
    {
        "TypeError",
        "ValueError",
        "NotImplementedError",
        "ValidationError",
        "PydanticCustomError",
    }
)


def classify_row(row: dict[str, Any]) -> str | None:
    """Failure kind for one fault row, or None when the outcome is acceptable."""
    if row.get("phase") == "chunk-convergence":
        return "fault-divergence" if row.get("status") == "error" else None
    if row.get("phase") == "import" and row.get("status") == "error":
        return "import-error"
    if row.get("status") != "error":
        return None
    # A typed rejection is the consumer correctly refusing the shape.
    return None if row.get("error_type") in _TYPED_REJECTIONS else "fault-crash"


def cluster_fault_failures(rows: list[dict[str, Any]]) -> list[FailureCluster]:
    clusters: dict[str, FailureCluster] = {}
    for row in rows:
        kind = classify_row(row)
        if kind is None:
            continue
        target = row.get("target", "?")
        if kind == "fault-divergence":
            detail = str(row.get("error"))
        else:
            detail = f"{row.get('error_type', 'error')} on {row.get('fault_label')}"
        sig = normalize_signature(kind, f"{target} {detail}")
        cluster = clusters.get(sig)
        if cluster is None:
            cluster = FailureCluster(
                signature=sig,
                kind=kind,
                title=f"{target} — {detail}"[:300],
                endpoint_id=target,
                method="FAULT",
                path=target,
                exemplar={
                    "input": {
                        "field": row.get("fault_field"),
                        "label": row.get("fault_label"),
                    },
                    "strategy": f"fault/{row.get('fault_label', 'sweep')}",
                    "status": None,
                    "error": row.get("error"),
                    "detail": detail,
                    "expected": (
                        "a stable aggregate across every split point"
                        if kind == "fault-divergence"
                        else (
                            "handled, or refused with a typed error — the shape is "
                            f"legal: {row.get('why_legal')}"
                        )
                    ),
                },
            )
            clusters[sig] = cluster
        cluster.count += 1
    return sorted(clusters.values(), key=lambda c: (c.kind, c.path))


def load_boundaries(repo: Path) -> list[FaultBoundary]:
    """Declared boundaries from ``.vinv/exercise/boundaries.json``."""
    doc = store.read_json(store.exercise_dir(repo) / "boundaries.json")
    out: list[FaultBoundary] = []
    for entry in (doc or {}).get("boundaries", []):
        if not isinstance(entry, dict) or not entry.get("target"):
            continue
        out.append(
            FaultBoundary(
                name=str(entry.get("name") or entry["target"]),
                target=str(entry["target"]),
                contract=dict(entry.get("contract") or {}),
                baseline=dict(entry.get("baseline") or {}),
            )
        )
    return out


def run_faults(
    repo: Path,
    *,
    target: str | None = None,
    contract: dict[str, str] | None = None,
    baseline: dict[str, Any] | None = None,
    chunk_field: str | None = None,
    chunk_canonical: str | None = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    python: str | None = None,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Drive every declared boundary over its fault catalogue. Persists and summarises."""
    log = logger or logging.getLogger(__name__)
    repo = repo.resolve()

    if target:
        boundary = FaultBoundary(
            name=target,
            target=target,
            contract=contract or {},
            baseline=baseline or {},
        )
        doc = store.read_json(store.exercise_dir(repo) / "boundaries.json") or {}
        merged = {
            e["target"]: e
            for e in doc.get("boundaries", [])
            if isinstance(e, dict) and e.get("target")
        }
        entry = boundary.to_json()
        if chunk_field and chunk_canonical:
            entry["chunk_field"] = chunk_field
            entry["chunk_canonical"] = chunk_canonical
        merged[target] = entry
        store.write_json(
            store.exercise_dir(repo) / "boundaries.json",
            {"version": 1, "boundaries": sorted(merged.values(), key=lambda e: e["target"])},
        )
        boundaries = [boundary]
        chunk_by_target = (
            {target: (chunk_field, chunk_canonical)} if chunk_field and chunk_canonical else {}
        )
    else:
        boundaries = load_boundaries(repo)
        doc = store.read_json(store.exercise_dir(repo) / "boundaries.json") or {}
        chunk_by_target = {
            e["target"]: (e["chunk_field"], e["chunk_canonical"])
            for e in doc.get("boundaries", [])
            if isinstance(e, dict) and e.get("chunk_field") and e.get("chunk_canonical")
        }

    diagnostics: list[str] = []
    if not boundaries:
        diagnostics.append(
            "0 fault boundaries declared — this oracle is idle. Declare one in "
            '.vinv/exercise/boundaries.json as {"target": "module:fn", '
            '"contract": {"content": "str | None"}, "baseline": {...}} to arm it.'
        )
        log.warning("faults_empty %s", diagnostics[0])

    src_roots = detect_src_roots(repo)
    tmp_dir = store.exercise_dir(repo) / "faults"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    timeouts: list[str] = []

    for boundary in boundaries:
        faults = catalogue_faults(boundary.contract)
        plan: dict[str, Any] = {
            "name": boundary.name,
            "target": boundary.target,
            "src_roots": src_roots,
            "baseline": boundary.baseline,
            "faults": [f.to_json() for f in faults],
        }
        sweep = chunk_by_target.get(boundary.target)
        if sweep:
            plan["chunk_sweep"] = {
                "field": sweep[0],
                "cases": chunk_boundary_cases(sweep[1]),
            }
        plan_file = tmp_dir / f"{boundary.target.replace(':', '_').replace('.', '_')}.plan.json"
        store.write_json(plan_file, plan)

        cmd = [
            python or sys.executable,
            "-m",
            "exerciser.faults",
            "--worker",
            "--plan",
            str(plan_file),
            "--repo",
            str(repo),
        ]
        env = dict(os.environ)
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
            timeouts.append(boundary.target)
            rows.append(
                {
                    "boundary": boundary.name,
                    "target": boundary.target,
                    "phase": "boundary",
                    "status": "error",
                    "error_type": "BoundaryTimeout",
                    "error": f"exceeded {timeout_s}s — a fault shape hung the consumer",
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

    clusters = cluster_fault_failures(rows)
    store.write_jsonl(store.exercise_dir(repo) / "fault_results.jsonl", rows)

    result: dict[str, Any] = {
        "status": "ok",
        "diagnostics": diagnostics,
        "repo": str(repo),
        "boundaries": len(boundaries),
        "faults_injected": sum(1 for r in rows if r.get("phase") == "fault"),
        "chunk_splits": sum(1 for r in rows if r.get("phase") == "chunk-sweep"),
        "issue_clusters": len(clusters),
        "timeouts": timeouts,
        "clusters": [c.to_json() for c in clusters],
        "results_file": str(store.exercise_dir(repo) / "fault_results.jsonl"),
    }
    store.write_json(store.exercise_dir(repo) / "faults.json", result)
    log.info(
        "faults: %d boundaries, %d faults, %d chunk splits, %d clusters",
        len(boundaries),
        result["faults_injected"],
        result["chunk_splits"],
        len(clusters),
    )
    return result


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--worker" in argv:
        argv.remove("--worker")
        return _worker_main(argv)
    sys.stderr.write("exerciser.faults: use `exerciser faults <repo>`\n")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
