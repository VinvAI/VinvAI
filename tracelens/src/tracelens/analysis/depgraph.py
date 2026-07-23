"""Stage B — dependency graph."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import networkx as nx
import pandas as pd

from tracelens.analysis.spans import _load_validated_lines


def build_depgraph(log: Path, out: Path, *, min_support: int = 5) -> None:
    rows = _load_validated_lines(log)
    df = pd.DataFrame(rows)
    if df.empty:
        out.write_text(json.dumps(nx.node_link_data(nx.DiGraph())), encoding="utf-8")
        return
    edges: Counter[tuple[str, str]] = Counter()
    for _rid, g in df.groupby("request_id"):
        g2 = g.sort_values("ts")
        for _, row in g2.iterrows():
            if row["event"] != "exit":
                continue
            p = row.get("parent_component")
            c = row["component"]
            if p and isinstance(p, str) and p and str(p) != "nan":
                edges[(p, c)] += 1
    g = nx.DiGraph()
    for (p, c), w in edges.items():
        if w >= min_support:
            g.add_edge(p, c, weight=int(w))
    out.write_text(json.dumps(nx.node_link_data(g)), encoding="utf-8")
