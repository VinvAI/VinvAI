"""Per-endpoint symbol coverage by joining fresh trace spans onto call trees.

After a round of probes runs against the LIVE traced service, the capture file
has grown with the spans those probes produced. This module joins that capture
onto each endpoint's static call tree — reusing identification's own tracemap
engine (``map_trace_to_tree``) so the coverage numbers are computed exactly the
way the rest of Vinv computes them, never a parallel re-implementation — and
reports, per endpoint:

* ``covered`` / ``total`` static symbols and the ``pct``;
* the NAMES of the still-uncovered symbols (what a smarter probe must reach);
* whether the handler was observed at all this capture.

``handler_observed`` is joined against the TRACE first: the handler symbol
appearing in the captured spans is the trace's own testimony that the handler
ran, regardless of whether the static-tree overlay could be built or matched.
The tracemap/calltree join is the fallback (it also supplies the handler name
when the caller does not know it). Without the trace-primary join, an endpoint
the trace clearly served (probes returning 200s with real latencies) could
read "handler not observed" purely because the static overlay failed — and be
excluded from endpoint-level opportunity detection.

``symbol_coverage_delta`` is the loop's reward signal: the set of newly-covered
symbol ids since the previous round.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Deliberate reuse of the runner's capture resolution (freshest trace.jsonl,
# service-directory aware): both joins below MUST read the same capture file,
# or "observed" and the coverage numbers would describe different runs.
from identification.runner import _resolve_trace_file, map_trace_to_tree

# One parsed scan per capture state; see _scan_trace.
_SCAN_CACHE: dict[tuple[str, int, int], _TraceScan] = {}
_SCAN_CACHE_MAX = 8


@dataclass(frozen=True)
class _TraceScan:
    """The facts every coverage question needs, extracted in ONE pass.

    ``handler_observed_in_trace`` and ``branch_ids_for_endpoint`` each opened
    and re-read the whole trace, and both are called once per ENDPOINT per
    ROUND — so a 23-endpoint run over 6 rounds re-parsed a growing file
    hundreds of times, for a file that is identical for every endpoint in a
    round. Parsing it once per (path, size, mtime) makes the cost per round
    rather than per endpoint-round, and the key self-invalidates because the
    capture grows as the run proceeds.
    """

    components: frozenset[str]  # every span component seen
    enters: tuple[tuple[str, str], ...]  # (component, request_id) for enter events
    branch_hits: tuple[tuple[str | None, str], ...]  # (request_id, branch id)


def _scan_trace(trace_path: Path) -> _TraceScan:
    key: tuple[str, int, int]
    try:
        st = trace_path.stat()
        key = (str(trace_path), st.st_size, st.st_mtime_ns)
    except OSError:
        return _TraceScan(frozenset(), (), ())
    cached = _SCAN_CACHE.get(key)
    if cached is not None:
        return cached

    components: set[str] = set()
    enters: list[tuple[str, str]] = []
    hits: list[tuple[str | None, str]] = []
    try:
        with trace_path.open(encoding="utf-8") as fh:
            for line in fh:
                if '"branch_hits"' in line:
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(row, dict) and isinstance(row.get("hits"), list):
                        for hit in row["hits"]:
                            if not isinstance(hit, dict):
                                continue
                            rid = hit.get("request_id")
                            hits.append(
                                (
                                    rid if isinstance(rid, str) else None,
                                    f"{hit.get('file')}:{hit.get('line')}:"
                                    f"{hit.get('src')}->{hit.get('dst')}",
                                )
                            )
                    continue
                if '"component"' not in line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(ev, dict):
                    continue
                comp = ev.get("component")
                if not isinstance(comp, str):
                    continue
                components.add(comp)
                rid = ev.get("request_id")
                if ev.get("event") == "enter" and isinstance(rid, str):
                    enters.append((comp, rid))
    except OSError:
        return _TraceScan(frozenset(), (), ())

    scan = _TraceScan(frozenset(components), tuple(enters), tuple(hits))
    # Bounded: one entry per distinct capture state, and a run only ever grows
    # one file. Trimmed so a long-lived process cannot accumulate scans.
    if len(_SCAN_CACHE) >= _SCAN_CACHE_MAX:
        _SCAN_CACHE.clear()
    _SCAN_CACHE[key] = scan
    return scan


def handler_observed_in_trace(
    repo: Path,
    handler: str | None,
    *,
    service: str | None = None,
    trace: str | None = None,
) -> bool:
    """True when ``handler`` appears as a span component in the fresh capture.

    Spans name their component ``module[.Class].func``, so the handler symbol
    appearing as a component's final segment is direct runtime evidence the
    handler executed — no static tree, index store, or module-path match
    required. Unknown handler or no capture degrades to False (never raises):
    absence of evidence, reported as such.
    """
    if not handler:
        return False
    # Identification hands the handler in display form ("items-read_items()"),
    # while trace components carry the bare qualname ("…items.read_items").
    # Normalize to the function name: strip a call-parens suffix and the
    # "<tag>-" display prefix before matching.
    handler = handler.removesuffix("()")
    if "-" in handler:
        handler = handler.rsplit("-", 1)[-1]
    if not handler:
        return False
    try:
        trace_path = _resolve_trace_file(Path(repo), service, trace)
    except (FileNotFoundError, OSError):
        return False
    suffix = "." + handler
    scan = _scan_trace(trace_path)
    return any(comp == handler or comp.endswith(suffix) for comp in scan.components)


def _normalize_handler(handler: str | None) -> str | None:
    """Display-form handler ("items-read_items()") → bare function name."""
    if not handler:
        return None
    handler = handler.removesuffix("()")
    if "-" in handler:
        handler = handler.rsplit("-", 1)[-1]
    return handler or None


def branch_ids_for_endpoint(
    repo: Path,
    handler: str | None,
    *,
    service: str | None = None,
    trace: str | None = None,
) -> set[str]:
    """Branch arms (from tracelens ``branch_hits`` lines) credited to ``handler``.

    A branch id is ``file:line:src->dst`` — one arm of one conditional. Hits are
    credited when their ``request_id`` belongs to a request whose spans include
    the handler; hits with no request id (module import, framework startup) are
    credited too, so they reward whichever endpoint's round first observes them
    — they are infrastructure the probe genuinely exercised. First-hit-only on
    the tracelens side keeps this set monotone, which is exactly what the
    "newly covered" reward needs. No capture / no branch lines → empty set.
    """
    handler = _normalize_handler(handler)
    try:
        trace_path = _resolve_trace_file(Path(repo), service, trace)
    except (FileNotFoundError, OSError):
        return set()
    suffix = "." + handler if handler else None
    scan = _scan_trace(trace_path)
    rids = {
        rid
        for comp, rid in scan.enters
        if handler and (comp == handler or (suffix and comp.endswith(suffix)))
    }
    return {bid for rid, bid in scan.branch_hits if rid is None or rid in rids}


def _walk(node: dict[str, Any]):
    yield node
    for ch in node.get("children", []) or []:
        yield from _walk(ch)


def _covered_symbol_ids(tree: dict[str, Any]) -> tuple[set[str], set[str]]:
    """(covered, all) resolved symbol ids from an annotated tracemap tree.

    Mirrors the tracemap coverage denominator: a resolved node with an
    observable runtime verdict counts; ``observable: false`` class nodes are
    excluded from both sets (neither confirmed nor denied).
    """
    covered: set[str] = set()
    allsyms: set[str] = set()
    for node in _walk(tree):
        sid = node.get("symbol_id")
        rt = node.get("runtime")
        if not sid or not isinstance(rt, dict):
            continue
        if rt.get("observable") is False:
            continue
        allsyms.add(sid)
        if rt.get("executed"):
            covered.add(sid)
    return covered, allsyms


def _uncovered_names(tree: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for node in _walk(tree):
        rt = node.get("runtime")
        if not isinstance(rt, dict):
            continue
        if rt.get("observable") is False or rt.get("executed"):
            continue
        name = node.get("name")
        if name and name not in names:
            names.append(name)
    return names


def endpoint_coverage(
    repo: Path,
    api_id: str,
    *,
    service: str | None = None,
    store_dir: str | None = None,
    trace: str | None = None,
    handler: str | None = None,
    symbol: str | None = None,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Coverage facts for one endpoint from the newest capture.

    ``symbol`` roots the static tree at an indexed function instead of a
    declared entry point — what a driven call is. Without it a function-level
    unit had no static denominator at all, so however much of it ran it
    reported 0/0.

    Returns a dict with ``covered_ids`` (the join-key set for the reward),
    ``covered``/``total``/``pct``, ``uncovered`` names and ``handler_observed``.
    A tracemap failure (no capture yet, handler not run) degrades to zero
    coverage rather than raising — the loop treats that as "no new symbols".

    ``handler_observed`` joins against the trace itself (see
    :func:`handler_observed_in_trace`); the tracemap result is the fallback and
    the source of the handler name when ``handler`` is not supplied.
    """
    log = logger or logging.getLogger(__name__)
    try:
        result = map_trace_to_tree(
            repo,
            api_id=api_id,
            symbol=symbol,
            trace=trace,
            service=service,
            store_dir=store_dir,
            logger=log,
        )
    except Exception as exc:  # no static overlay — zero coverage, trace still speaks
        observed = handler_observed_in_trace(repo, handler, service=service, trace=trace)
        if observed:
            log.warning(
                "coverage: tracemap failed for %s (%s) but handler %r appears in "
                "the captured spans — reporting handler_observed=true with zero "
                "symbol coverage",
                api_id,
                exc,
                handler,
            )
        else:
            log.debug("coverage: tracemap failed for %s: %s", api_id, exc)
        branch_ids = branch_ids_for_endpoint(repo, handler, service=service, trace=trace)
        return {
            "api_id": api_id,
            # Branch arms still reward exploration even when the static overlay
            # could not be built — the trace speaks for itself.
            "covered_ids": branch_ids,
            "covered": 0,
            "total": 0,
            "pct": 0.0,
            "uncovered": [],
            "handler_observed": observed,
            "branch_arms": len(branch_ids),
        }
    tree = result.get("tree", {})
    covered_ids, all_ids = _covered_symbol_ids(tree)
    cov = result.get("coverage", {})
    entrypoint = result.get("entrypoint") or {}
    handler_name = handler or entrypoint.get("handler")
    tracemap_observed = bool(result.get("handler_observed"))
    observed = tracemap_observed or handler_observed_in_trace(
        repo,
        handler_name,
        service=service,
        trace=trace,
    )
    if observed and not tracemap_observed:
        log.warning(
            "coverage: %s handler %r appears in the captured spans though the "
            "static-tree overlay missed it — reporting handler_observed=true",
            api_id,
            handler_name,
        )
    # Branch arms join the reward-id set so the bandit's "newly covered" signal
    # keeps moving after every function has been ENTERED once — the input space
    # is explored branch by branch, not function by function. The displayed
    # covered/total stay symbol-denominated (branches have no static total here).
    branch_ids = branch_ids_for_endpoint(repo, handler_name, service=service, trace=trace)
    return {
        "api_id": api_id,
        "covered_ids": covered_ids | branch_ids,
        "covered": len(covered_ids),
        "total": len(all_ids),
        "pct": cov.get(
            "pct", round(100.0 * len(covered_ids) / len(all_ids), 1) if all_ids else 0.0
        ),
        "uncovered": _uncovered_names(tree),
        "handler_observed": observed,
        "branch_arms": len(branch_ids),
    }
