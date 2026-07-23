"""T1.5 — code index ↔ tracelens code overlay.

Reads a code-index symbol catalog (parquet or JSONL) keyed by qualified name and
exposes ``lookup(component) -> dict | None`` so analyze stages can attach
file:line, signature, summary, source excerpt to each component.

The overlay format is intentionally narrow:

    parquet/jsonl with columns: qualname, file, line, signature, summary, body_excerpt

Anyone can produce the overlay file by hand or from a code-index export.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)


def load_overlay(path: Path) -> dict[str, dict[str, Any]]:
    """Return ``{qualname: {file,line,signature,summary,body_excerpt}}``.

    Accepts:
        - Parquet (preferred, what the code index's symbol-catalog export produces)
        - JSONL (one record per line, same columns)
        - JSON (dict ``{qualname: {...}}`` or list ``[{qualname,...},...]``)
    """
    if not path.is_file():
        _log.warning("code-overlay: %s not found; report will lack code context", path)
        return {}
    suf = path.suffix.lower()
    rows: list[dict[str, Any]] = []
    if suf == ".parquet":
        try:
            import pandas as pd

            df = pd.read_parquet(path)
            rows = df.to_dict("records")
        except Exception as exc:  # noqa: BLE001
            _log.warning("code-overlay parquet load failed: %s", exc)
            return {}
    elif suf in (".jsonl", ".ndjson"):
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    elif suf == ".json":
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            _log.warning("code-overlay json load failed: %s", exc)
            return {}
        if isinstance(data, dict):
            for k, v in data.items():
                if isinstance(v, dict):
                    rec = dict(v)
                    rec.setdefault("qualname", k)
                    rows.append(rec)
        elif isinstance(data, list):
            rows = [r for r in data if isinstance(r, dict)]
    else:
        _log.warning("code-overlay: unknown suffix %s; expected .parquet/.jsonl/.json", suf)
        return {}

    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        q = r.get("qualname")
        if not isinstance(q, str):
            continue
        out[q] = {
            "file": r.get("file"),
            "line": r.get("line"),
            "signature": r.get("signature"),
            "summary": r.get("summary"),
            "body_excerpt": r.get("body_excerpt"),
            **{k: v for k, v in r.items() if k not in ("qualname",)},
        }
    return out


def lookup(overlay: dict[str, dict[str, Any]], component: str) -> dict[str, Any] | None:
    """Direct lookup; fallback to longest-prefix match if exact misses (e.g. nested classes)."""
    if component in overlay:
        return overlay[component]
    # try the parent qualname (a.b.c -> a.b) for one level
    if "." in component:
        parent = component.rsplit(".", 1)[0]
        return overlay.get(parent)
    return None
