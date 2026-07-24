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

``symbol_coverage_delta`` is the loop's reward signal: the set of newly-covered
symbol ids since the previous round.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from identification.runner import map_trace_to_tree


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
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Coverage facts for one endpoint from the newest capture.

    Returns a dict with ``covered_ids`` (the join-key set for the reward),
    ``covered``/``total``/``pct``, ``uncovered`` names and ``handler_observed``.
    A tracemap failure (no capture yet, handler not run) degrades to zero
    coverage rather than raising — the loop treats that as "no new symbols".
    """
    log = logger or logging.getLogger(__name__)
    try:
        result = map_trace_to_tree(
            repo, api_id=api_id, trace=trace, service=service,
            store_dir=store_dir, logger=log,
        )
    except Exception as exc:  # no capture / handler absent — zero coverage
        log.debug("coverage: tracemap failed for %s: %s", api_id, exc)
        return {
            "api_id": api_id,
            "covered_ids": set(),
            "covered": 0,
            "total": 0,
            "pct": 0.0,
            "uncovered": [],
            "handler_observed": False,
        }
    tree = result.get("tree", {})
    covered_ids, all_ids = _covered_symbol_ids(tree)
    cov = result.get("coverage", {})
    return {
        "api_id": api_id,
        "covered_ids": covered_ids,
        "covered": len(covered_ids),
        "total": len(all_ids),
        "pct": cov.get("pct", round(100.0 * len(covered_ids) / len(all_ids), 1) if all_ids else 0.0),
        "uncovered": _uncovered_names(tree),
        "handler_observed": bool(result.get("handler_observed")),
    }
