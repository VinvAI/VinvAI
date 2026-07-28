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
  chunking, which is always a bug. Convergence is decided on a digest of the
  FULL value (``value_digest``), not on the lossy ``_summarize`` rendering:
  an aggregator returning a list of the right length with corrupted contents is
  precisely the bug the sweep exists for, and comparing shapes misses it. A
  split that RAISES while other splits succeed is a divergence too — the typed
  rejections that mean "correct refusal" for a shape fault mean nothing here,
  because every split carries the SAME payload.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import logging
import os
import re
import subprocess
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import store
from ._worker import worker_entrypoint
from .agent_loop import AgentChannel, Question, question_key
from .functions import detect_src_roots
from .interpreter import resolve_cached
from .issues import FailureCluster, build_clusters

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


def _parse_typespec(raw: str | None) -> tuple[str, bool, str]:
    """Normalise a declared type into ``(spec, optional, base)``.

    Type annotations arrive spelled several ways for the same thing, and the
    original one-line parse only understood one of them. ``Optional[str]``
    rendered by ``__name__`` was the bare word "Optional" — no base type at all,
    so 3 of its 4 faults never fired; rendered by ``str()`` it is
    ``typing.Optional[str]``, where the module qualifier defeated the
    ``startswith("optional")`` test. ``Union[str, None]`` is a third spelling.
    ``str | None`` — the one spelling the single test used — happened to work,
    which is why this looked correct.

    Returns the lowered spec, whether ``None`` is admissible, and the base type
    name to derive value faults from.
    """
    spec = (raw or "").strip().lower()
    # Module qualifiers carry no meaning here: `typing.Optional[str]` and
    # `Optional[str]` declare the same domain.
    for prefix in ("typing.", "t.", "builtins."):
        spec = spec.replace(prefix, "")

    optional = (
        "none" in spec or spec.endswith("?") or spec.startswith("optional[") or spec == "optional"
    )

    # Unwrap one Optional[...]/Union[...] layer, then take the first member: the
    # faults are derived from the type the value actually carries when present.
    inner = spec
    for wrapper in ("optional[", "union["):
        if inner.startswith(wrapper) and inner.endswith("]"):
            inner = inner[len(wrapper) : -1]
            break
    members = [m.strip() for m in inner.replace("|", ",").split(",") if m.strip()]
    base = next((m for m in members if m not in ("none", "nonetype")), "")
    base = base.rstrip("?").strip() or "str"
    return spec, optional, base


def catalogue_faults(contract: dict[str, str]) -> list[Fault]:
    """Adversarial-but-legal values implied by a boundary's type contract.

    Derived from the DECLARED type, not from imagination: an optional field can
    legally be absent, a list can legally be empty or arrive out of order, a
    string can legally hold an unpaired surrogate. Deterministic and ordered.
    """
    faults: list[Fault] = []
    for name in sorted(contract):
        spec, optional, base = _parse_typespec(contract[name])
        del spec  # kept for readability of the parse step

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
    """JSON-safe, bounded rendering of a value — for HUMANS reading the rows.

    Lossy on purpose (list contents dropped, dicts truncated). Never use it to
    decide whether two results are equal: see ``value_digest``.
    """
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


_ADDRESS_RE = re.compile(r"0x[0-9a-fA-F]+")
_MAX_CANONICAL_DEPTH = 12


def _canonical(value: Any, depth: int = 0, seen: frozenset[int] = frozenset()) -> str:
    """Order-stable, FULL-content serialisation of an arbitrary value.

    Everything ``_summarize`` throws away is kept: list and tuple contents in
    order, every dict key, set members sorted by their own canonical form.
    Objects are rendered by ``repr`` when they define one, and by their type
    plus attributes when they do not — because the DEFAULT ``__repr__`` embeds
    the instance address, which differs on every call and would make every
    split point look divergent.
    """
    if depth > _MAX_CANONICAL_DEPTH:
        return "<deep>"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return f"i:{value}"
    if isinstance(value, float):
        return f"f:{value!r}"
    if isinstance(value, str):
        return f"s:{value!r}"
    if isinstance(value, bytes | bytearray):
        return f"b:{bytes(value)!r}"
    if id(value) in seen:
        return "<cycle>"
    seen = seen | {id(value)}
    if isinstance(value, list | tuple):
        inner = ",".join(_canonical(v, depth + 1, seen) for v in value)
        return f"{type(value).__name__}[{inner}]"
    if isinstance(value, set | frozenset):
        inner = ",".join(sorted(_canonical(v, depth + 1, seen) for v in value))
        return f"{type(value).__name__}{{{inner}}}"
    if isinstance(value, dict):
        items = sorted(
            (_canonical(k, depth + 1, seen), _canonical(v, depth + 1, seen))
            for k, v in value.items()
        )
        return "{" + ",".join(f"{k}={v}" for k, v in items) + "}"
    if type(value).__repr__ is not object.__repr__:
        return f"r:{_ADDRESS_RE.sub('0x?', repr(value))}"
    attrs = getattr(value, "__dict__", None)
    if isinstance(attrs, dict):
        return f"o:{type(value).__name__}{_canonical(attrs, depth + 1, seen)}"
    return f"o:{type(value).__name__}"


def value_digest(value: Any) -> str:
    """Stable hash of a value's FULL content — the chunk sweep's equality test.

    The sweep exists to catch an aggregator whose output depends on where the
    stream was split. Comparing ``_summarize`` output compares SHAPES, so an
    aggregator returning a list of the right length with corrupted content
    converges silently — which is exactly the bug being hunted.
    """
    try:
        canonical = _canonical(value)
    except Exception:
        try:
            canonical = f"!{_ADDRESS_RE.sub('0x?', repr(value))}"
        except Exception:
            canonical = f"!unrenderable:{type(value).__name__}"
    return hashlib.sha256(canonical.encode("utf-8", "surrogatepass")).hexdigest()[:32]


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
        # Convergence, on FULL values. `result` is a lossy human rendering; a
        # digest of the whole value is what makes "same length, different
        # contents" a divergence instead of a silent pass.
        succeeded = [o for o in outcomes if o.get("status") == "ok"]
        raised = [o for o in outcomes if o.get("status") != "ok"]
        values = {str(o.get("result_digest")) for o in succeeded}
        # A split that RAISED while another split succeeded is a divergence in
        # its own right — the streaming parser that breaks on exactly one
        # mid-token split is the canonical case, and its exception is typically
        # a ValueError, which the typed-rejection rule would otherwise discard.
        mixed = bool(raised) and bool(succeeded)
        for outcome in raised:
            outcome["sweep_divergent"] = mixed
        diverged = len(values) > 1 or mixed
        if len(values) > 1:
            detail = (
                f"{len(values)} distinct aggregate results across "
                f"{len(outcomes)} split points — the aggregator is "
                "chunk-boundary dependent"
            )
        elif mixed:
            detail = (
                f"{len(raised)} of {len(outcomes)} split points raised while "
                f"{len(succeeded)} succeeded — the aggregator is chunk-boundary "
                "dependent"
            )
        else:
            detail = None
        rows.append(
            {
                "boundary": plan["name"],
                "target": target,
                "phase": "chunk-convergence",
                "status": "error" if diverged else "ok",
                "distinct_results": len(values),
                "splits": len(outcomes),
                "raised_splits": len(raised),
                "error": detail,
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
        if phase == "chunk-sweep":
            # The sweep compares VALUES, so it needs a full-content digest —
            # `result` above is a lossy rendering meant for a human reader.
            row["result_digest"] = value_digest(out)
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
    # _TYPED_REJECTIONS must NOT apply to a divergent sweep row. A streaming
    # parser that raises ValueError on exactly the one mid-token split — and
    # succeeds on every other — is not "refusing a shape": the shape is
    # identical, only the chunking differs, so the exception IS the divergence.
    # The worker marks the row (it is the only place that can see the other
    # splits); a sweep where EVERY split raises is a consistent refusal and
    # keeps the ordinary rules below.
    if row.get("phase") == "chunk-sweep" and row.get("sweep_divergent"):
        return "fault-divergence"
    # A typed rejection is the consumer correctly refusing the shape.
    return None if row.get("error_type") in _TYPED_REJECTIONS else "fault-crash"


def _fault_detail(row: dict[str, Any], kind: str) -> str:
    if kind == "fault-divergence" and row.get("phase") == "chunk-sweep":
        # Deliberately omits the split index so every failing split of one
        # aggregator collapses into ONE finding rather than N.
        return (
            f"{row.get('error_type', 'error')} raised on a chunk-boundary "
            "split while other splits succeeded"
        )
    if kind == "fault-divergence":
        return str(row.get("error"))
    return f"{row.get('error_type', 'error')} on {row.get('fault_label')}"


def _fault_expected(row: dict[str, Any], kind: str) -> str:
    if kind == "fault-divergence":
        return "a stable aggregate across every split point"
    return "handled, or refused with a typed error — the shape is " f"legal: {row.get('why_legal')}"


def cluster_fault_failures(rows: list[dict[str, Any]]) -> list[FailureCluster]:
    return build_clusters(
        rows,
        verdict=classify_row,
        describe=_fault_detail,
        method="FAULT",
        strategy=lambda r, _k: f"fault/{r.get('fault_label', 'sweep')}",
        expected=_fault_expected,
        exemplar_extra=lambda r: {
            "input": {"field": r.get("fault_field"), "label": r.get("fault_label")},
            "error": r.get("error"),
        },
    )


def infer_contract_from_signature(
    target: str, python: str | None = None, repo: Path | None = None
) -> dict[str, str]:
    """Best-effort type contract from the consumer's own annotations.

    The cataloguer needs to know what shapes a boundary legally admits. Making
    a human write that out by hand is what stops this oracle being usable on an
    unfamiliar repo, so the first source is the code itself: an annotated
    parameter already DECLARES its admissible domain. Unannotated parameters
    are left out — they are what the agent channel is for.
    """
    import subprocess as _sp

    roots = detect_src_roots(repo) if repo is not None else ["."]
    base = repo.resolve() if repo is not None else Path.cwd()
    sys_path_lines = "".join(f"sys.path.insert(0, {str((base / r).resolve())!r})\n" for r in roots)
    code = (
        "import importlib, inspect, json, sys\n"
        + sys_path_lines
        + f"mod_name, _, qual = {target!r}.partition(':')\n"
        "try:\n"
        "    obj = importlib.import_module(mod_name)\n"
        "    for part in qual.split('.'):\n"
        "        obj = getattr(obj, part)\n"
        "    sig = inspect.signature(obj)\n"
        "except BaseException:\n"
        "    print('{}'); sys.exit(0)\n"
        "out = {}\n"
        "for name, p in sig.parameters.items():\n"
        "    if name in ('self', 'cls') or p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):\n"
        "        continue\n"
        "    ann = p.annotation\n"
        "    if ann is p.empty:\n"
        "        continue\n"
        # `getattr(ann, '__name__')` is the usual "pretty type name" recipe and
        # is right for a plain class — but for a typing alias `__name__` is the
        # CONSTRUCTOR's name, so `Optional[str]` renders as bare "Optional" and
        # every parameter of it lost 3 of its 4 faults (only `none` survived;
        # empty/whitespace/surrogate never fired). `list[int]`/`dict[...]`
        # survived only by accident, because the lowercased constructor name
        # still starts with "list"/"dict". `str(ann)` keeps the parameters, so
        # prefer it whenever the annotation is subscripted.
        "    origin = getattr(ann, '__origin__', None)\n"
        "    args = getattr(ann, '__args__', None)\n"
        "    if origin is not None or args:\n"
        "        out[name] = str(ann)\n"
        "    else:\n"
        "        out[name] = getattr(ann, '__name__', None) or str(ann)\n"
        "print(json.dumps(out))\n"
    )
    try:
        proc = _sp.run(  # noqa: S603 (fixed argv, no shell)
            [python or sys.executable, "-c", code],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            cwd=str(base),
        )
        data = json.loads((proc.stdout or "{}").strip() or "{}")
        return {k: str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except (OSError, ValueError, _sp.TimeoutExpired):
        return {}


def baseline_from_contract(contract: dict[str, str]) -> dict[str, Any]:
    """A well-formed payload for a contract, built from its own declared types.

    ``--auto-target`` used to arm boundaries with ``baseline={}``. Since a fault
    is the baseline with ONE field replaced, every generated call was then missing
    every OTHER required parameter, so the consumer raised ``TypeError`` before
    reaching a line of its own logic — and ``TypeError`` is in
    ``_TYPED_REJECTIONS``, i.e. it was recorded as the consumer CORRECTLY refusing
    the shape. The arithmetic is exact: a fault could only execute when the target
    had exactly one required parameter and the fault happened to target it; with
    two or more required parameters the whole sweep was 100% dead, silently, and
    no question was raised on the agent channel either. That makes the oracle
    anti-correlated with code quality — the wider a boundary's signature, the more
    certainly it reported clean.

    ``FaultBoundary.baseline`` documents faults as being applied ON TOP of a
    well-formed payload, and this is where that payload comes from when nobody
    declared one. Same construction as ``campaign._valid_kwargs_for``.

    Only values that survive the JSON round trip UNCHANGED are emitted, because
    the baseline travels to the worker through a plan file written with
    ``default=str``. A ``set`` would arrive as the string ``"{1}"`` and a
    ``tuple`` as a ``list``; feeding a consumer a differently-typed argument and
    then blaming it for the crash is exactly the fabricated finding this whole
    change is meant to remove. An omitted parameter costs a dead fault (the call
    raises ``TypeError``, which is a typed rejection) — never a false one.

    Limitation, deliberately not papered over: only ANNOTATED parameters appear in
    a contract, so a target with an unannotated required parameter still gets an
    incomplete payload. Values for annotations the harness cannot instantiate are
    honest guesses (``resolved_value_for`` says so via its second element) — a
    wrong guess costs a dead fault, never a fabricated finding, for the same
    reason.
    """
    from .functions import resolved_value_for

    out: dict[str, Any] = {}
    for name, annotation in (contract or {}).items():
        value = resolved_value_for(annotation, "valid")[0]
        try:
            restored = json.loads(json.dumps(value))
        except (TypeError, ValueError):
            continue
        if type(restored) is not type(value) or restored != value:
            continue
        out[name] = value
    return out


def contract_question(target: str, known: dict[str, str]) -> Question:
    """Ask the agent channel for the contract the annotations do not state."""
    prompt = (
        "A fault-injection oracle needs the TYPE CONTRACT of a dependency "
        "boundary so it can generate adversarial-but-LEGAL values for it — "
        "values the contract permits but that the consuming code may not "
        "handle (an optional field actually absent, an empty list, a string "
        "holding an unpaired surrogate, stream chunks arriving out of order).\n\n"
        f"Boundary: {target}\n"
        f"Types already known from annotations: {json.dumps(known, indent=2)}\n\n"
        "Give the contract for EVERY parameter this boundary accepts, using "
        "Python type syntax, marking optionality honestly (`str | None` only "
        "when None is genuinely permitted). Include a well-formed baseline "
        "payload the consumer accepts today.\n\n"
        'Reply with exactly: {"contract": {"<param>": "<type>"}, '
        '"baseline": {"<param>": <value>}}'
    )
    return Question(
        key=question_key("contract", target),
        topic="contract",
        subject=target,
        prompt=prompt,
        reply_schema='{"contract": {"<param>": "<type>"}, "baseline": {"<param>": <value>}}',
        context={"target": target, "known_from_annotations": known},
    )


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
    auto_targets: list[str] | None = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    python: str | None = None,
    max_questions: int = 25,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Drive every declared boundary over its fault catalogue. Persists and summarises.

    With neither ``target`` nor a declared ``boundaries.json``, ``auto_targets``
    derives boundaries from the consumers' own annotations, falling back to the
    agent channel for contracts the code does not state.
    """
    log = logger or logging.getLogger(__name__)
    repo = repo.resolve()
    python = resolve_cached(repo, explicit=python, logger=log).python
    store.exercise_dir(repo).mkdir(parents=True, exist_ok=True)
    channel = AgentChannel(repo, "contract", max_new=max_questions)
    # Bound on every branch: an auto-derived boundary has no declared sweep.
    chunk_by_target: dict[str, tuple[str, str]] = {}

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
        if chunk_field and chunk_canonical:
            chunk_by_target = {target: (chunk_field, chunk_canonical)}
    elif auto_targets:
        # No declaration: DERIVE boundaries from the consumers themselves, so
        # the oracle is usable on a repo where nobody has written a
        # boundaries.json. Annotations supply what they can; the rest becomes
        # a question on the agent channel (asked once, cached forever).
        boundaries = []
        for auto in auto_targets:
            known = infer_contract_from_signature(auto, python, repo)
            answered = channel.answer(question_key("contract", auto)) if channel else None
            if isinstance(answered, dict) and isinstance(answered.get("contract"), dict):
                contract_map = {str(k): str(v) for k, v in answered["contract"].items()}
                base = answered.get("baseline")
                baseline_map = dict(base) if isinstance(base, dict) else {}
            else:
                contract_map, baseline_map = known, {}
                if channel is not None and not known:
                    channel.ask(contract_question(auto, known))
            if contract_map:
                # Derive the well-formed payload from the contract, then let an
                # agent-supplied baseline override field by field: the agent has
                # seen the real boundary, the annotations have only seen its
                # types. Without the derived half every fault on a target with
                # two or more required parameters died as a TypeError that the
                # classifier read as "handled correctly" — see
                # `baseline_from_contract`.
                boundaries.append(
                    FaultBoundary(
                        name=auto,
                        target=auto,
                        contract=contract_map,
                        baseline={**baseline_from_contract(contract_map), **baseline_map},
                    )
                )
    else:
        boundaries = load_boundaries(repo)
        doc = store.read_json(store.exercise_dir(repo) / "boundaries.json") or {}
        chunk_by_target = {
            e["target"]: (e["chunk_field"], e["chunk_canonical"])
            for e in doc.get("boundaries", [])
            if isinstance(e, dict) and e.get("chunk_field") and e.get("chunk_canonical")
        }

    channel_state = channel.save(logger=log)

    diagnostics: list[str] = []
    if not boundaries:
        if channel_state["pending"]:
            diagnostics.append(
                f"0 fault boundaries armed — {channel_state['pending']} boundary "
                "contract(s) are queued on the agent channel "
                f"({channel_state['file']}); answer them and re-run. Contracts "
                "are cached by shape, so this cost is paid once."
            )
        else:
            diagnostics.append(
                "0 fault boundaries declared — this oracle is idle. Declare one in "
                '.vinv/exercise/boundaries.json as {"target": "module:fn", '
                '"contract": {"content": "str | None"}, "baseline": {...}}, or pass '
                "--auto-target module:fn to derive one from its annotations."
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
                encoding="utf-8",
                errors="replace",
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
        # What the engine had to ask an agent, and what it never has to ask
        # again — the caching claim, measured.
        "agent_channel": channel_state,
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
    return worker_entrypoint(
        argv, _worker_main, "exerciser.faults: use `exerciser faults <repo>`\n"
    )


if __name__ == "__main__":
    raise SystemExit(main())
