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
from pathlib import Path
from typing import Any

from identification.runner import map_trace_to_tree

# Deliberate reuse of the runner's capture resolution (freshest trace.jsonl,
# service-directory aware): both joins below MUST read the same capture file,
# or "observed" and the coverage numbers would describe different runs.
from identification.runner import _resolve_trace_file


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
    try:
        with trace_path.open(encoding="utf-8") as fh:
            for line in fh:
                if handler not in line:
                    continue  # cheap prefilter before JSON parsing
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                comp = ev.get("component") if isinstance(ev, dict) else None
                if isinstance(comp, str) and (comp == handler or comp.endswith(suffix)):
                    return True
    except OSError:
        return False
    return False


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
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Coverage facts for one endpoint from the newest capture.

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
        return {
            "api_id": api_id,
            "covered_ids": set(),
            "covered": 0,
            "total": 0,
            "pct": 0.0,
            "uncovered": [],
            "handler_observed": observed,
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
    return {
        "api_id": api_id,
        "covered_ids": covered_ids,
        "covered": len(covered_ids),
        "total": len(all_ids),
        "pct": cov.get(
            "pct", round(100.0 * len(covered_ids) / len(all_ids), 1) if all_ids else 0.0
        ),
        "uncovered": _uncovered_names(tree),
        "handler_observed": observed,
    }
