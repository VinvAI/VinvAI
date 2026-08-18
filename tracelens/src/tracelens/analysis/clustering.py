"""Stage C — outcomes / lift / clustering."""

from __future__ import annotations

import importlib
import json
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import linkage  # type: ignore[import-untyped]
from scipy.spatial.distance import squareform  # type: ignore[import-untyped]
from sklearn.metrics import pairwise_distances  # type: ignore[import-untyped]

from tracelens.analysis.spans import _load_validated_lines


def _has_oracle_violations(v: object) -> bool:
    return bool(v) if isinstance(v, list) else False


def build_outcomes(log: Path, out: Path, *, oracle_dotted: str | None) -> None:
    rows = _load_validated_lines(log)
    df = pd.DataFrame(rows)
    exits = df[df["event"] == "exit"].copy()
    oracle_fn = None
    if oracle_dotted:
        if ":" in oracle_dotted:
            mod_name, fn_name = oracle_dotted.split(":", 1)
        else:
            mod_name, fn_name = oracle_dotted.rsplit(".", 1)
        mod = importlib.import_module(mod_name)
        oracle_fn = getattr(mod, fn_name)
    else:
        warnings.warn("no --oracle: skipping wrong label", stacklevel=1)

    labels: dict[str, set[str]] = {}
    p95 = float(np.percentile(exits["duration_ms"].astype(float), 95)) if len(exits) else 0.0
    for rid, g in exits.groupby("request_id"):
        ls: set[str] = set()
        if (g["status"] == "error").any():
            ls.add("fail")
        top = g.sort_values("ts").iloc[0] if len(g) else None
        if top is not None and float(top["duration_ms"]) > p95 * 1.5:
            ls.add("slow")
        if oracle_fn is not None:
            try:
                ok = bool(oracle_fn(g.to_dict("records")))
                if not ok:
                    ls.add("wrong")
            except Exception:
                pass
        if g["oracle_violations"].apply(_has_oracle_violations).any():
            ls.add("wrong")
        if not ls:
            ls.add("ok")
        labels[str(rid)] = ls

    all_rids = set(labels)
    req_components: dict[str, set[str]] = {}
    for rid, g in exits.groupby("request_id"):
        req_components[str(rid)] = set(g["component"].astype(str))

    lift_out: dict[str, list[dict[str, Any]]] = {}
    for lab in ("ok", "fail", "slow", "wrong"):
        with_l = {r for r, ls in labels.items() if lab in ls}
        without_l = all_rids - with_l
        if not with_l or not without_l:
            lift_out[lab] = []
            continue
        comps: dict[str, tuple[float, int]] = {}
        all_c = set()
        for cs in req_components.values():
            all_c |= cs
        for c in all_c:
            reqs_c = {r for r, cs in req_components.items() if c in cs}
            p_in = len(reqs_c & with_l) / max(1, len(with_l))
            p_out = len(reqs_c & without_l) / max(1, len(without_l))
            lift = p_in - p_out
            sup = len(reqs_c & with_l)
            comps[c] = (lift, sup)
        rows_lift: list[dict[str, float | int | str]] = [
            {"component": c, "lift": float(v[0]), "support": int(v[1])} for c, v in comps.items()
        ]
        ranked = sorted(rows_lift, key=lambda it: (-float(it["lift"]), str(it["component"])))
        lift_out[lab] = ranked[:500]

    dendrogram: dict[str, object] = {"Z": [], "labels": []}
    if len(exits) > 1:
        comp_labels = sorted(set(exits["component"].astype(str)))
        rids = sorted(set(exits["request_id"].astype(str)))
        if comp_labels and rids:
            mat = np.zeros((len(rids), len(comp_labels)), dtype=np.float64)
            comp_i = {c: i for i, c in enumerate(comp_labels)}
            for i, rid in enumerate(rids):
                for c in req_components.get(rid, ()):
                    if c in comp_i:
                        mat[i, comp_i[c]] = 1.0
            if len(comp_labels) > 1:
                dmat = pairwise_distances(mat.T, metric="jaccard")
                z = linkage(squareform(dmat, checks=False), method="average")
                dendrogram = {"Z": z.tolist(), "labels": comp_labels}

    payload = {
        "labels": {k: sorted(v) for k, v in labels.items()},
        "lift": lift_out,
        "dendrogram": dendrogram,
    }
    out.write_text(json.dumps(payload), encoding="utf-8")
