"""T2.5 — diff observed runtime call graph (depgraph) vs. static call graph (code index/SCIP).

Static format expected: NetworkX node-link JSON (same as ``tracelens analyze depgraph``
emits) OR ``{"edges": [["caller","callee"], ...]}``.

Output JSON::

    {
      "edges_only_in_static":   [{"src": "...", "dst": "...", "weight": null}],   # potentially dead
      "edges_only_in_dynamic":  [{"src": "...", "dst": "...", "weight": N}],      # dynamic dispatch
      "edges_in_both":          [{"src": "...", "dst": "...", "weight": N}],
      "summary": {...}
    }
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

import pandas as pd

from tracelens.analysis.spans import _load_validated_lines


def _load_static(path: Path) -> set[tuple[str, str]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    edges: set[tuple[str, str]] = set()
    if isinstance(raw, dict) and "edges" in raw and isinstance(raw["edges"], list):
        for e in raw["edges"]:
            if isinstance(e, list | tuple) and len(e) >= 2:
                edges.add((str(e[0]), str(e[1])))
    elif isinstance(raw, dict) and "links" in raw and isinstance(raw["links"], list):
        # NetworkX node-link
        for ln in raw["links"]:
            if isinstance(ln, dict):
                s = ln.get("source")
                t = ln.get("target")
                if isinstance(s, str) and isinstance(t, str):
                    edges.add((s, t))
    return edges


def _dynamic_edges(rows: list[dict[str, Any]]) -> Counter[tuple[str, str]]:
    edges: Counter[tuple[str, str]] = Counter()
    for r in rows:
        if r.get("event") != "exit":
            continue
        p = r.get("parent_component")
        c = r.get("component")
        if isinstance(p, str) and isinstance(c, str):
            edges[(p, c)] += 1
    return edges


def build_diff(log: Path, static_path: Path, out: Path) -> None:
    rows = _load_validated_lines(log)
    df = pd.DataFrame(rows)  # noqa: F841 — reserved for future extensions
    static_edges = _load_static(static_path)
    dynamic_edges = _dynamic_edges(rows)
    only_static = sorted(static_edges - dynamic_edges.keys())
    only_dynamic = sorted(dynamic_edges.keys() - static_edges)
    in_both = sorted(static_edges & dynamic_edges.keys())
    payload = {
        "edges_only_in_static": [{"src": s, "dst": t, "weight": None} for s, t in only_static],
        "edges_only_in_dynamic": [
            {"src": s, "dst": t, "weight": dynamic_edges[(s, t)]} for s, t in only_dynamic
        ],
        "edges_in_both": [
            {"src": s, "dst": t, "weight": dynamic_edges[(s, t)]} for s, t in in_both
        ],
        "summary": {
            "static_edge_count": len(static_edges),
            "dynamic_edge_count": len(dynamic_edges),
            "only_static_count": len(only_static),
            "only_dynamic_count": len(only_dynamic),
            "in_both_count": len(in_both),
        },
    }
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
