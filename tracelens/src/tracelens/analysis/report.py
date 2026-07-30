"""HTML report: run offline stages and render a self-contained dashboard (spec §13 / M12).

The report is a single static HTML file with inline CSS/JS/SVG — no external/CDN
dependencies, so it renders offline. It runs every offline stage (spans, depgraph,
outcomes, metrics, CIRCA, GCM, drift, provenance) once in a temp dir and turns the
results into architect-level widgets: KPI cards, an outcome-mix donut, a request
latency histogram, component hotspot bars, an interactive dependency-graph, and
root-cause tables. Raw stage JSON is kept in collapsible panels for auditability.
"""

from __future__ import annotations

import html
import json
import math
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

import networkx as nx  # pyright: ignore[reportMissingModuleSource]  # runtime dependency
import pandas as pd  # pyright: ignore[reportMissingImports]  # runtime dependency

from tracelens.analysis import circa as circa_mod
from tracelens.analysis import clustering, gcm_rca
from tracelens.analysis import correctness as corr
from tracelens.analysis import depgraph as dg
from tracelens.analysis import metrics as met
from tracelens.analysis import spans as spans_mod
from tracelens.analysis.spans import _load_validated_lines

# ---------------------------------------------------------------------------
# small numeric / formatting helpers
# ---------------------------------------------------------------------------


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * p
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return s[int(k)]
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def _fmt_ms(v: float) -> str:
    if v >= 1000:
        return f"{v / 1000:.2f}s"
    if v >= 1:
        return f"{v:.1f}ms"
    return f"{v * 1000:.0f}\u00b5s"


def _short(qual: str) -> str:
    parts = qual.split(".")
    return ".".join(parts[-2:]) if len(parts) > 2 else qual


def _esc(x: Any) -> str:
    return html.escape(str(x))


def _help(text: str, pos: str = "") -> str:
    """A small info badge that reveals a plain-English tooltip on hover/focus.

    Pure CSS (no JS), so it works in a fully offline HTML file. ``pos='r'`` right-
    aligns the bubble so header icons near the page edge don't clip off-screen.
    """
    cls = f"help {pos}".strip()
    return f"<span class='{cls}' tabindex='0'>i<span class='tip'>{_esc(text)}</span></span>"


# Plain-English tooltip copy, kept out of the f-strings below so the heading lines stay short.
_HELP = {
    "outcome": (
        "How every request turned out: OK (finished fine), Slow (took unusually long), "
        "Fail (hit an error), or Wrong (broke an expected rule). The number in the middle "
        "is the total requests."
    ),
    "latency": (
        "A bar chart of how long requests took, fastest on the left. Tall bars on the left "
        "mean most requests were quick; a long tail to the right means a few were slow."
    ),
    "hotspots": (
        "The pieces of code that added up to the most total time across the whole run. This "
        "is where the app actually spent its time \u2014 the best places to look when speeding "
        "things up."
    ),
    "busiest": (
        "The most-frequently-run pieces of code, with how long each takes (typical and "
        "worst-case). A file path underneath shows where that code lives."
    ),
    "lift": (
        "Which pieces of code show up far more often in failed, slow, or wrong requests than "
        "in healthy ones. A lift of 2 means it appears twice as often when things go bad "
        "\u2014 a likely culprit."
    ),
    "circa": (
        "An automatic first-guess at the root cause. It finds the component whose behavior "
        "changed the most (statistically) between the healthy and problem periods, and ranks "
        "the likeliest suspects."
    ),
    "gcm": (
        "A deeper root-cause method that estimates how much each component actually CAUSED the "
        "problem, rather than just happening at the same time. Needs extra setup (the rca "
        "add-on) and a healthy-vs-problem split."
    ),
    "drift": (
        "Compares the healthy first half of the run against the second half to see which "
        "measurements shifted. Big shifts flag where the system started behaving differently."
    ),
    "provenance": (
        "Checks whether re-running produces the same results as a reference run \u2014 a way to "
        "catch flaky or non-repeatable behavior. Here it compares the trace against itself, so "
        "there are no differences by design."
    ),
    "raw": (
        "The underlying data behind every widget above, in raw JSON form, for auditing or "
        "debugging. Click to expand."
    ),
    "selector": (
        "Pick one API to see its own metrics and root-cause analysis, or \u201cAll endpoints\u201d "
        "for the whole trace combined. Endpoints and their requests come from the "
        "identification phase; the number is how many requests hit that route."
    ),
}


# ---------------------------------------------------------------------------
# stage plumbing (unchanged behavior, richer capture)
# ---------------------------------------------------------------------------


def _median_split_ts(df: pd.DataFrame) -> tuple[str, str]:
    if df.empty or "bucket" not in df.columns:
        full = "1970-01-01T00:00:00+00:00,2099-12-31T23:59:59+00:00"
        return full, full
    ts = sorted(pd.to_datetime(df["bucket"], utc=True).unique())
    if len(ts) < 2:
        s = ts[0].isoformat()
        return f"{s},{s}", f"{s},{s}"
    mid = len(ts) // 2
    return (
        f"{ts[0].isoformat()},{ts[mid - 1].isoformat()}",
        f"{ts[mid].isoformat()},{ts[-1].isoformat()}",
    )


def _pick_gcm_target(dep_path: Path, comps: set[str]) -> str:
    data: dict[str, Any] = json.loads(dep_path.read_text(encoding="utf-8"))
    G = nx.node_link_graph(
        data,
        directed=bool(data.get("directed", True)),
        multigraph=bool(data.get("multigraph", False)),
    )
    best: str | None = None
    best_deg = -1
    for node in G.nodes():
        s = str(node)
        if s not in comps:
            continue
        deg = int(G.in_degree(node))
        if deg > best_deg:
            best_deg = deg
            best = s
    if best:
        return best
    return next(iter(comps)) if comps else "unknown"


def _safe_read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return cast(dict[str, Any], data)
        return {"error": "not_a_dict"}
    except Exception:
        return {"error": "read_failed"}


# ---------------------------------------------------------------------------
# widgets — each returns an HTML fragment string
# ---------------------------------------------------------------------------


def _kpi(label: str, value: str, sub: str = "", tone: str = "", help: str = "") -> str:
    cls = f"kpi {tone}".strip()
    sub_html = f"<div class='kpi-sub'>{_esc(sub)}</div>" if sub else ""
    hp = _help(help) if help else ""
    return (
        f"<div class='{cls}'><div class='kpi-val'>{_esc(value)}</div>"
        f"<div class='kpi-label'>{_esc(label)}{hp}</div>{sub_html}</div>"
    )


def _bar_row(label: str, value: float, vmax: float, meta: str, tone: str = "") -> str:
    pct = 0.0 if vmax <= 0 else max(1.0, 100.0 * value / vmax)
    return (
        "<div class='bar-row'>"
        f"<div class='bar-label' title='{_esc(label)}'>{_esc(_short(label))}</div>"
        "<div class='bar-track'>"
        f"<div class='bar-fill {tone}' style='width:{pct:.1f}%'></div></div>"
        f"<div class='bar-meta'>{_esc(meta)}</div></div>"
    )


# Canonical display casing for request-outcome labels, used everywhere they surface
# (donut legend, lift headings) so the report never mixes "ok"/"Ok"/"OK".
_OUTCOME_LABEL = {"ok": "OK", "slow": "Slow", "fail": "Fail", "wrong": "Wrong"}


def _donut(counts: dict[str, int]) -> str:
    total = sum(counts.values()) or 1
    r = 60.0
    circ = 2 * math.pi * r
    offset = 0.0
    segs = []
    legend = []
    for key in ("ok", "slow", "fail", "wrong"):
        n = counts.get(key, 0)
        if n <= 0:
            continue
        frac = n / total
        dash = frac * circ
        # Colour comes from the `.seg-*` / `.dot.*` rules in _CSS, not from a
        # literal here: the palette is theme-dependent (prefers-color-scheme),
        # and a hex baked into the markup could not follow it. Classes also keep
        # the arc and its legend dot from drifting apart.
        segs.append(
            f"<circle r='{r}' cx='80' cy='80' fill='none' class='seg-{key}' "
            f"stroke-width='24' stroke-dasharray='{dash:.2f} {circ - dash:.2f}' "
            f"stroke-dashoffset='{-offset:.2f}' transform='rotate(-90 80 80)'></circle>"
        )
        offset += dash
        legend.append(
            f"<div class='lg'><span class='dot {key}'></span>"
            f"{_esc(_OUTCOME_LABEL.get(key, key))} <b>{n}</b> "
            f"<span class='muted'>({100 * frac:.0f}%)</span></div>"
        )
    svg = (
        "<svg width='160' height='160' viewBox='0 0 160 160'>"
        + "".join(segs)
        + f"<text x='80' y='76' class='donut-c'>{total}</text>"
        "<text x='80' y='96' class='donut-s'>requests</text></svg>"
    )
    return f"<div class='donut-wrap'>{svg}<div class='legend'>{''.join(legend)}</div></div>"


def _histogram(values: list[float], bins: int = 24) -> str:
    if not values:
        return "<div class='muted'>no request-level durations captured</div>"
    lo, hi = min(values), max(values)
    if hi <= lo:
        hi = lo + 1.0
    width = (hi - lo) / bins
    counts = [0] * bins
    for v in values:
        idx = min(bins - 1, int((v - lo) / width))
        counts[idx] += 1
    cmax = max(counts) or 1
    bw = 100.0 / bins
    bars = []
    for i, c in enumerate(counts):
        h = 100.0 * c / cmax
        x0 = lo + i * width
        x1 = lo + (i + 1) * width
        tip = f"{_fmt_ms(x0)}\u2013{_fmt_ms(x1)}: {c} req"
        bars.append(
            f"<div class='hbar' style='height:{h:.1f}%' title='{_esc(tip)}'></div>"
            if c
            else f"<div class='hbar empty' title='{_esc(tip)}'></div>"
        )
        _ = bw
    p50 = _percentile(values, 0.5)
    p95 = _percentile(values, 0.95)
    return (
        "<div class='hist'>" + "".join(bars) + "</div>"
        f"<div class='hist-axis'><span>{_fmt_ms(lo)}</span>"
        f"<span class='muted'>p50 {_fmt_ms(p50)} \u00b7 p95 {_fmt_ms(p95)}</span>"
        f"<span>{_fmt_ms(hi)}</span></div>"
    )


def _table(
    headers: list[str],
    rows: list[list[str]],
    empty: str,
    col_help: list[str] | None = None,
) -> str:
    if not rows:
        return f"<div class='muted'>{_esc(empty)}</div>"
    head = "".join(
        f"<th>{_esc(h)}"
        + (_help(col_help[i], "r") if col_help and i < len(col_help) and col_help[i] else "")
        + "</th>"
        for i, h in enumerate(headers)
    )
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f"<table class='tbl'><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def _details_json(title: str, obj: Any) -> str:
    txt = json.dumps(obj, indent=2, default=str, ensure_ascii=False)[:20000]
    return (
        f"<details><summary>{_esc(title)}</summary>" f"<pre class='raw'>{_esc(txt)}</pre></details>"
    )


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

# Vinv design system, mirroring `extension/src/views/webviewTheme.ts` and the
# vinv.ai site: white/black/red, JetBrains Mono body, serif-italic display
# headings, uppercase micro-labels, sharp corners, grid + grain backdrop.
#
# Self-theming through `prefers-color-scheme` rather than the `vscode-dark` body
# class the extension's own webviews key off. This document is standalone — it is
# handed to a sandboxed `srcdoc` iframe, and is also opened straight from disk in
# a browser — so it never sees the classes VS Code stamps on a webview body, and
# a palette keyed off them would be stuck on its default forever.
#
# Semantic tones (good / warn / bad / info) are retuned per theme rather than
# shared: the GitHub-dark values they replaced were picked against a #0d1117
# panel and fall under 4.5:1 on white. `bad` is the brand red in both themes,
# which is why it doubles as `--accent-fg`.
_CSS = """
:root{
--bg:#ffffff;--bg-2:#f4f4f4;--ink:#0a0a0a;--ink-soft:#1a1a1a;
--muted:#616161;--muted-2:#7a7a7a;
--accent:#d71921;--accent-fg:#d71921;
--line:rgba(10,10,10,.14);--line-strong:rgba(10,10,10,.32);
--grid:rgba(10,10,10,.05);--grain:rgba(10,10,10,.05);--grain-blend:multiply;
--good:#0f7a34;--warn:#8a5a00;--bad:#d71921;--info:#6b3fc9;
--shadow:rgba(10,10,10,.18);
--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--serif:'Instrument Serif','Iowan Old Style',Georgia,'Times New Roman',serif}
@media (prefers-color-scheme:dark){:root{
--bg:#000000;--bg-2:#0b0b0b;--ink:#ffffff;--ink-soft:#ededed;
--muted:#8f8f8f;--muted-2:#6e6e6e;
--accent:#d71921;--accent-fg:#ff4048;
--line:rgba(255,255,255,.14);--line-strong:rgba(255,255,255,.32);
--grid:rgba(255,255,255,.05);--grain:rgba(255,255,255,.05);--grain-blend:screen;
--good:#3fca6a;--warn:#e0a33a;--bad:#ff4048;--info:#b98cff;
--shadow:rgba(0,0,0,.55)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:13px/1.6 var(--mono);-webkit-font-smoothing:antialiased;
font-feature-settings:'ss01','ss02','cv11'}
/* grid texture + film grain across the page, like the site */
body::before{content:'';position:fixed;inset:0;pointer-events:none;
background-image:linear-gradient(var(--grid) 1px,transparent 1px),
linear-gradient(90deg,var(--grid) 1px,transparent 1px);
background-size:24px 24px;mix-blend-mode:var(--grain-blend);z-index:0}
body::after{content:'';position:fixed;inset:0;pointer-events:none;
background-image:radial-gradient(var(--grain) 1px,transparent 1px);
background-size:3px 3px;opacity:.35;mix-blend-mode:var(--grain-blend);z-index:0}
body>*{position:relative;z-index:1}
a{color:var(--accent-fg)}
::selection{background:var(--accent);color:#ffffff}
.wrap{max-width:1180px;margin:0 auto;padding:28px 22px 80px}
header.top{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;
border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:22px}
header.top h1{font-family:var(--serif);font-style:italic;font-weight:400;
font-size:30px;margin:0;letter-spacing:-.01em;color:var(--ink)}
header.top .tag{background:transparent;border:1px solid var(--line-strong);border-radius:0;
padding:2px 8px;font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.meta{color:var(--muted);font-size:11px;margin-left:auto;letter-spacing:.04em}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:26px}
.kpi{background:var(--bg-2);border:1px solid var(--line);border-radius:0;padding:16px}
.kpi-val{font-size:26px;font-weight:500;letter-spacing:-.02em}
.kpi-label{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.24em;margin-top:4px}
.kpi-label::before{content:'// ';color:var(--accent-fg)}
.kpi-sub{font-size:11px;color:var(--muted-2);margin-top:6px}
.kpi.good .kpi-val{color:var(--good)}.kpi.warn .kpi-val{color:var(--warn)}
.kpi.bad .kpi-val{color:var(--bad)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px}
.card{background:var(--bg-2);border:1px solid var(--line);border-radius:0;padding:18px}
.card h2{margin:0 0 14px;font-size:10px;text-transform:uppercase;letter-spacing:.24em;
color:var(--muted)}
.card h2::before{content:'// ';color:var(--accent-fg)}
.card.full{grid-column:1 / -1}
.muted{color:var(--muted)}.small{font-size:11px}
.donut-wrap{display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.donut-c{fill:var(--ink);font-size:26px;font-weight:500;text-anchor:middle}
.donut-s{fill:var(--muted);font-size:10px;text-anchor:middle;text-transform:uppercase;letter-spacing:.24em}
.legend .lg{margin:4px 0}
.legend .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px}
/* one source of truth for outcome colour: the donut arc and its legend dot
   both key off these, so a palette edit here cannot desync the two. */
.seg-ok{stroke:var(--good)}.seg-slow{stroke:var(--warn)}
.seg-fail{stroke:var(--bad)}.seg-wrong{stroke:var(--info)}
.dot.ok{background:var(--good)}.dot.slow{background:var(--warn)}
.dot.fail{background:var(--bad)}.dot.wrong{background:var(--info)}
.bar-row{display:grid;grid-template-columns:220px 1fr 120px;gap:10px;align-items:center;
margin:7px 0}
.bar-label{font-family:var(--mono);font-size:11px;
white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}
.bar-track{background:var(--bg);border:1px solid var(--line);border-radius:0;height:16px;overflow:hidden}
.bar-fill{height:100%;background:var(--ink-soft);border-radius:0}
.bar-fill.amber{background:var(--warn)}
.bar-fill.red{background:var(--bad)}
.bar-fill.purple{background:var(--info)}
.bar-meta{text-align:right;font-size:11px;color:var(--muted);font-family:var(--mono)}
.hist{display:flex;align-items:flex-end;gap:2px;height:130px;padding-top:8px}
.hist .hbar{flex:1;background:var(--ink-soft);border-radius:0;min-height:2px}
.hist .hbar.empty{background:var(--line);min-height:2px}
.hist-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);
margin-top:6px;letter-spacing:.08em}
.tbl{width:100%;border-collapse:collapse;font-size:12px}
.tbl th{text-align:left;color:var(--muted);font-weight:500;font-size:10px;text-transform:uppercase;
letter-spacing:.18em;border-bottom:1px solid var(--line-strong);padding:7px 8px}
.tbl td{border-bottom:1px solid var(--line);padding:7px 8px;vertical-align:top}
.tbl td code{font-size:11px}
.pill{display:inline-block;padding:2px 7px;border-radius:0;font-size:9px;font-weight:500;
letter-spacing:.18em;text-transform:uppercase;border:1px solid currentColor}
.pill.good{color:var(--good)}
.pill.warn{color:var(--warn)}
.pill.bad{color:var(--bad)}
code{font-family:var(--mono)}
.callout{border-left:3px solid var(--accent-fg);background:var(--bg-2);padding:12px 14px;
border-radius:0;margin-bottom:12px}
.callout.bad{border-color:var(--bad)}.callout.warn{border-color:var(--warn)}
details{margin:10px 0}summary{cursor:pointer;color:var(--muted)}
pre.raw{background:var(--bg);border:1px solid var(--line);border-radius:0;padding:12px;
overflow:auto;font-size:11px;max-height:340px}
.note{font-size:11px;color:var(--muted);margin-top:8px}
.help{position:relative;display:inline-flex;align-items:center;justify-content:center;
width:15px;height:15px;margin-left:6px;border-radius:50%;border:1px solid var(--line-strong);
color:var(--muted);font-size:10px;font-weight:700;font-style:italic;cursor:help;
vertical-align:middle;text-transform:none;letter-spacing:0;
font-family:var(--serif);line-height:1;user-select:none}
.help:hover,.help:focus{border-color:var(--accent-fg);color:var(--accent-fg);outline:none}
.help .tip{position:absolute;bottom:150%;left:50%;transform:translateX(-50%);
width:250px;max-width:70vw;background:var(--bg);border:1px solid var(--line-strong);border-radius:0;
padding:9px 11px;font-size:11px;line-height:1.5;color:var(--ink);font-weight:400;
font-style:normal;font-family:var(--mono);
text-transform:none;letter-spacing:0;text-align:left;white-space:normal;
opacity:0;visibility:hidden;transition:opacity .12s ease;z-index:30;
box-shadow:0 8px 24px var(--shadow);pointer-events:none}
.help.r .tip{left:auto;right:-4px;transform:none}
.help .tip::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);
border:6px solid transparent;border-top-color:var(--line-strong)}
.help.r .tip::after{left:auto;right:8px;transform:none}
.help:hover .tip,.help:focus .tip{opacity:1;visibility:visible}
.card h2{display:flex;align-items:center}
.epbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 22px}
.epbar label{font-size:10px;text-transform:uppercase;letter-spacing:.24em;color:var(--muted);
display:flex;align-items:center}
.epbar label::before{content:'// ';color:var(--accent-fg)}
.epbar select{background:var(--bg-2);color:var(--ink);border:1px solid var(--line-strong);
border-radius:0;padding:7px 10px;font-size:12px;font-family:var(--mono);
max-width:520px;cursor:pointer}
.epbar select:hover,.epbar select:focus{border-color:var(--accent-fg);outline:none}
"""

_JS_SEL = """
(function(){
 var sel=document.getElementById('epsel');if(!sel)return;
 var secs=[].slice.call(document.querySelectorAll('section.ep'));
 function show(){var v=sel.value;
  secs.forEach(function(s){s.hidden=(s.getAttribute('data-ep')!==v);});}
 sel.addEventListener('change',show);show();
})();
"""


# Cap on how many API endpoints get their own dropdown view (ranked by request
# volume), on top of the always-present "All endpoints" overview.
_MAX_ENDPOINTS = 24


def _discover_api_views(log: Path, identification: Path | None) -> list[dict[str, Any]]:
    """Read the identification-phase ``*.tracemap.json`` files and return one entry
    per exercised API endpoint, each carrying the exact ``request_ids`` that hit it.

    This is the authoritative endpoint grouping: the identification step already
    matched each HTTP route (e.g. ``GET /v1/vinv-sessions``) to the trace requests
    it produced (``requests_matched``). We only keep maps that (a) point at the trace
    we're reporting on and (b) actually observed requests."""
    ident = identification
    if ident is None:
        for base in [log.parent, *log.parents]:
            for cand in (base / "identification", base / ".vinv" / "identification"):
                if cand.is_dir():
                    ident = cand
                    break
            if ident is not None:
                break
    if ident is None or not ident.is_dir():
        return []

    try:
        log_res = log.resolve()
    except OSError:
        log_res = log

    apis: list[dict[str, Any]] = []
    for tm_path in sorted(ident.glob("*.tracemap.json")):
        try:
            tm = json.loads(tm_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        rids = {str(x) for x in (tm.get("requests_matched") or [])}
        if not rids:
            continue
        tf = str(tm.get("trace_file", ""))
        if tf:
            try:
                same = Path(tf).resolve() == log_res
            except OSError:
                same = False
            if not same and Path(tf).name != log.name:
                continue
        ep = tm.get("entrypoint", {}) or {}
        method = str(ep.get("method", "")).strip()
        path = str(ep.get("path", "")).strip()
        label = f"{method} {path}".strip() or str(ep.get("id") or tm_path.stem)
        cov = tm.get("coverage", {}) or {}
        apis.append(
            {
                "id": str(ep.get("id") or tm_path.stem),
                "label": label,
                "handler": str(ep.get("handler", "")),
                "file": str(ep.get("file", "")),
                "line": ep.get("line"),
                "coverage_pct": cov.get("pct"),
                "request_ids": rids,
            }
        )
    apis.sort(key=lambda a: (-len(a["request_ids"]), str(a["label"])))
    return apis[:_MAX_ENDPOINTS]


def _api_banner(a: dict[str, Any], n_spans: int) -> str:
    """A small header identifying which API this view is, shown above its widgets."""
    handler = f" \u2192 <code>{_esc(a['handler'])}</code>" if a.get("handler") else ""
    bits = []
    if a.get("file"):
        loc = a["file"] + (f":{a['line']}" if a.get("line") is not None else "")
        bits.append(_esc(loc))
    bits.append(f"{len(a['request_ids'])} requests \u00b7 {n_spans:,} spans")
    if a.get("coverage_pct") is not None:
        bits.append(f"static coverage {a['coverage_pct']}%")
    return (
        f"<div class='callout'><b>{_esc(a['label'])}</b>{handler}"
        f"<div class='note'>{' \u00b7 '.join(bits)}</div></div>"
    )


def _run_stages(log_path: Path) -> dict[str, Any]:
    """Run every offline analyze stage against ``log_path`` in a temp dir and return
    the captured summaries. Each stage failure is recorded, never raised, so one bad
    endpoint view can't blank the whole report."""
    stage_err: list[str] = []
    circa_summary: dict[str, Any] = {}
    gcm_summary: dict[str, Any] = {}
    drift_summary: dict[str, Any] = {}
    prov_summary: dict[str, Any] = {}
    outcomes: dict[str, Any] = {}
    metrics_cols: list[str] = []
    n_buckets = 0  # distinct 60s time windows with activity — CIRCA's real data gate

    with tempfile.TemporaryDirectory() as td:
        t = Path(td)
        try:
            spans_mod.build_spans(log_path, t / "spans.json", None)
        except Exception as exc:
            stage_err.append(f"spans:{exc}")
        try:
            # dep.json feeds CIRCA + GCM below (not rendered as a widget).
            dg.build_depgraph(log_path, t / "dep.json", min_support=1)
        except Exception as exc:
            stage_err.append(f"depgraph:{exc}")
        try:
            clustering.build_outcomes(log_path, t / "outcomes.json", oracle_dotted=None)
            outcomes = _safe_read_json(t / "outcomes.json")
        except Exception as exc:
            stage_err.append(f"outcomes:{exc}")
        try:
            met.build_metrics(log_path, t / "metrics.parquet", bucket="60s")
            mdf = pd.read_parquet(t / "metrics.parquet")
            metrics_cols = list(mdf.columns)
            if not mdf.empty and "bucket" in mdf.columns:
                n_buckets = int(mdf["bucket"].nunique())
            bspec, wspec = _median_split_ts(mdf)
            try:
                circa_mod.run_circa(
                    t / "metrics.parquet",
                    t / "dep.json",
                    "latency_p95",
                    bspec,
                    wspec,
                    t / "circa.json",
                )
                circa_summary = _safe_read_json(t / "circa.json")
            except Exception as exc:
                stage_err.append(f"circa:{exc}")
            try:
                comps = set(mdf["component"].astype(str)) if not mdf.empty else set()
                tgt = _pick_gcm_target(t / "dep.json", comps)
                gcm_rca.run_gcm(
                    t / "metrics.parquet",
                    t / "dep.json",
                    tgt,
                    bspec,
                    wspec,
                    t / "gcm.json",
                    metric_col="latency_p95",
                )
                gcm_summary = _safe_read_json(t / "gcm.json")
            except Exception as exc:
                stage_err.append(f"gcm:{exc}")
            try:
                corr.provenance_diff(log_path, log_path, t / "prov.json")
                prov_summary = _safe_read_json(t / "prov.json")
            except Exception as exc:
                stage_err.append(f"provenance:{exc}")
            try:
                corr.drift_metrics(t / "metrics.parquet", bspec, wspec, t / "drift.json")
                drift_summary = _safe_read_json(t / "drift.json")
            except Exception as exc:
                stage_err.append(f"drift:{exc}")
        except Exception as exc:
            stage_err.append(f"metrics:{exc}")

    return {
        "outcomes": outcomes,
        "circa_summary": circa_summary,
        "gcm_summary": gcm_summary,
        "drift_summary": drift_summary,
        "prov_summary": prov_summary,
        "metrics_cols": metrics_cols,
        "n_buckets": n_buckets,
        "stage_err": stage_err,
    }


def _build_view(
    rows: list[dict[str, Any]],
    overlay: Any,
    lookup: Any,
    *,
    log_path: Path | None,
    banner: str = "",
) -> str:
    """Compute aggregates + run the full RCA pipeline for one subset of rows and
    return the rendered inner HTML. When ``log_path`` is None the subset is written
    to a temp JSONL so the file-based stages can consume it (used for per-endpoint
    views); the 'All endpoints' view passes the original log to reuse its row cache."""
    exits = [r for r in rows if r.get("event") == "exit"]
    comp_count: dict[str, int] = {}
    comp_total_ms: dict[str, float] = {}
    comp_durs: dict[str, list[float]] = {}
    req_durs: list[float] = []
    errors = 0
    viol = 0
    request_ids: set[str] = set()
    for r in exits:
        c = str(r.get("component", ""))
        d = float(r.get("duration_ms", 0.0) or 0.0)
        comp_count[c] = comp_count.get(c, 0) + 1
        comp_total_ms[c] = comp_total_ms.get(c, 0.0) + d
        comp_durs.setdefault(c, []).append(d)
        request_ids.add(str(r.get("request_id", "")))
        if r.get("status") == "error":
            errors += 1
        ov = r.get("oracle_violations")
        if isinstance(ov, list) and ov:
            viol += 1
        if int(r.get("depth", 0) or 0) == 0:
            req_durs.append(d)

    err_rate = (100.0 * errors / len(exits)) if exits else 0.0

    if log_path is not None:
        stages = _run_stages(log_path)
    else:
        with tempfile.TemporaryDirectory() as td:
            sub = Path(td) / "subset.jsonl"
            with sub.open("w", encoding="utf-8") as fh:
                for r in rows:
                    fh.write(json.dumps(r, separators=(",", ":"), ensure_ascii=False) + "\n")
            stages = _run_stages(sub)

    return _render_view(
        n=len(rows),
        exits=exits,
        n_req=len(request_ids),
        err_rate=err_rate,
        errors=errors,
        viol=viol,
        req_durs=req_durs,
        comp_count=comp_count,
        comp_total_ms=comp_total_ms,
        comp_durs=comp_durs,
        banner=banner,
        overlay=overlay,
        lookup=lookup,
        **stages,
    )


def write_report(
    log: Path,
    out: Path,
    *,
    code_overlay: Path | None = None,
    identification: Path | None = None,
    api_id: str | None = None,
) -> None:
    """Render a self-contained HTML dashboard from a captured JSONL trace.

    Endpoints come from the identification phase's ``*.tracemap.json`` files (each API
    route and the exact trace requests it produced). The report runs the full RCA
    pipeline **per API in parallel**, plus an 'All endpoints' overview, and a dropdown
    at the top switches between them in one file — no separate report per endpoint.
    ``identification`` overrides auto-discovery of that directory. When ``code_overlay``
    is given, top components carry file:line + signature + summary from the code-index catalog.

    Pass ``api_id`` (an identification entry-point id, e.g. ``GET_v1_vinv_sessions``) to
    scope the whole report to that single endpoint: no 'All endpoints' overview and no
    dropdown — just that one API's analysis.
    """
    from concurrent.futures import ThreadPoolExecutor

    from tracelens.analysis.code_overlay import load_overlay, lookup

    overlay = load_overlay(code_overlay) if code_overlay else {}

    rows = _load_validated_lines(log)
    trace_rids = {str(r.get("request_id", "")) for r in rows}

    # Endpoints are defined by the identification phase, one view per exercised API.
    # Tracemaps are matched against the request ids actually present in THIS trace:
    # auto-discovery can surface maps from a different service/run living in the same
    # .vinv/identification dir, and building views from those would filter every row
    # out and silently render an all-zero report. A tracemap whose request ids never
    # intersect the trace is stale here — it is noted, not rendered.
    discovered = _discover_api_views(log, identification)
    api_views: list[dict[str, Any]] = []
    stale_maps: list[dict[str, Any]] = []
    for a in discovered:
        hit = set(a["request_ids"]) & trace_rids
        if hit:
            a = {**a, "request_ids": hit}
            api_views.append(a)
        else:
            stale_maps.append(a)

    if api_id is not None:
        # Single-endpoint report: keep only the requested API, drop the combined overview.
        picked = [a for a in api_views if a["id"] == api_id]
        if not picked:
            if any(a["id"] == api_id for a in stale_maps):
                raise ValueError(
                    f"tracemap for api-id {api_id!r} matches no request in this trace "
                    "(tracemap from another run/service?)"
                )
            avail = ", ".join(a["id"] for a in api_views) or "none"
            raise ValueError(f"no tracemap for api-id {api_id!r} in this trace; available: {avail}")
        api_views = picked

    views: list[dict[str, Any]] = []

    if api_id is None:
        # "All endpoints" aggregates over the WHOLE trace — every request that ran,
        # whether or not identification mapped it to a named endpoint. Unmatched
        # requests are real traffic (background/startup/utility roots, or endpoints
        # identification never saw); tracemap matching must never shrink this view.
        all_req = len({str(r.get("request_id", "")) for r in rows if r.get("event") == "exit"})
        stale_note = ""
        if stale_maps:
            stale_note = (
                f"<div class='muted small'>note: {len(stale_maps)} tracemap(s) from "
                "another run/service — not exercised in this trace: "
                + _esc(", ".join(a["label"] for a in stale_maps))
                + "</div>"
            )
        views.append(
            {
                "label": "All endpoints",
                "rows": rows,
                "log_path": log,
                "n_req": all_req,
                "banner": stale_note,
            }
        )

    for a in api_views:
        rids = a["request_ids"]
        sub = [r for r in rows if str(r.get("request_id", "")) in rids]
        views.append(
            {
                "label": a["label"],
                "rows": sub,
                "log_path": None,
                "n_req": len(rids),
                "banner": _api_banner(a, len(sub)),
            }
        )

    # Build every view's widgets in parallel (RCA per API).
    def _work(v: dict[str, Any]) -> str:
        return _build_view(v["rows"], overlay, lookup, log_path=v["log_path"], banner=v["banner"])

    with ThreadPoolExecutor(max_workers=min(8, len(views))) as ex:
        inners = list(ex.map(_work, views))

    # Assemble the shell: header, API selector, and one section per view.
    gen = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    service = log.parent.name if log.parent.name not in (".", "") else log.stem

    options = []
    sections = []
    for i, (v, inner) in enumerate(zip(views, inners, strict=True)):
        options.append(
            f"<option value='{i}' title='{_esc(v['label'])}'>"
            f"{_esc(v['label'])} \u00b7 {v['n_req']:,} req</option>"
        )
        hide = "" if i == 0 else " hidden"
        sections.append(f"<section class='ep' data-ep='{i}'{hide}>{inner}</section>")

    if len(views) <= 1:
        # Single-endpoint (or no-tracemap single) report: the banner already names the API,
        # so there's nothing to switch between — drop the dropdown entirely.
        selector = ""
    else:
        ep_note = f"per-API RCA \u00b7 {len(api_views)} endpoint(s) exercised in this trace"
        selector = (
            "<div class='epbar'>"
            f"<label for='epsel'>API endpoint{_help(_HELP['selector'])}</label>"
            "<select id='epsel'>" + "".join(options) + "</select>"
            f"<span class='muted small'>{_esc(ep_note)}</span></div>"
        )

    body = (
        "<div class='wrap'>"
        "<header class='top'><h1>tracelens report</h1>"
        f"<span class='tag'>service: {_esc(service)}</span>"
        "<span class='tag'>python_backend_only</span>"
        f"<span class='meta'>{_esc(str(log))}<br>generated {gen}</span></header>"
        + selector
        + "".join(sections)
        + "</div>"
    )
    html_doc = (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>tracelens report</title>"
        f"<style>{_CSS}</style></head><body>{body}<script>{_JS_SEL}</script></body></html>"
    )
    out.write_text(html_doc, encoding="utf-8")


def _render_view(**kw: Any) -> str:  # noqa: C901 — a report is inherently a big assembly
    exits = kw["exits"]
    comp_count: dict[str, int] = kw["comp_count"]
    comp_total_ms: dict[str, float] = kw["comp_total_ms"]
    comp_durs: dict[str, list[float]] = kw["comp_durs"]
    outcomes: dict[str, Any] = kw["outcomes"]
    overlay = kw["overlay"]
    lookup = kw["lookup"]

    # --- KPI cards ---
    p95_req = _percentile(kw["req_durs"], 0.95)
    err_tone = "bad" if kw["err_rate"] > 5 else ("warn" if kw["err_rate"] > 0 else "good")
    viol_tone = "bad" if kw["viol"] else "good"
    kpis = "".join(
        [
            _kpi(
                "Requests",
                f"{kw['n_req']:,}",
                "distinct request_ids",
                help="The number of separate jobs the system handled while this trace "
                "was recorded \u2014 each one is a single 'thing the app was asked to do'.",
            ),
            _kpi(
                "Spans",
                f"{len(exits):,}",
                f"{kw['n']:,} JSONL rows",
                help="Every individual step (function call) that ran, counted once per call. "
                "One request usually sets off many steps.",
            ),
            _kpi(
                "Components",
                f"{len(comp_count):,}",
                "instrumented functions seen",
                help="How many distinct pieces of code were involved. Each is a named "
                "building block of the app that we watched run.",
            ),
            _kpi(
                "Error rate",
                f"{kw['err_rate']:.1f}%",
                f"{kw['errors']} error exits",
                err_tone,
                help="The share of steps that ended in an error instead of finishing "
                "cleanly. Lower is better \u2014 0% means nothing crashed.",
            ),
            _kpi(
                "Oracle violations",
                f"{kw['viol']:,}",
                "postcondition breaches",
                viol_tone,
                help="Times a step returned a result that broke a built-in sanity rule "
                "(e.g. a value that should never be negative). Higher = more "
                "surprising or incorrect behavior.",
            ),
            _kpi(
                "p95 request",
                _fmt_ms(p95_req),
                "depth-0 wall time",
                help="How long the slowest 5% of requests took: 95 out of 100 finished "
                "faster than this. A realistic 'worst-case' response time.",
            ),
        ]
    )

    # --- outcome donut ---
    labels = outcomes.get("labels", {}) if isinstance(outcomes, dict) else {}
    dist: dict[str, int] = {}
    for v in labels.values():
        keys = v if isinstance(v, list) else [v]
        for k in keys:
            dist[str(k)] = dist.get(str(k), 0) + 1
    donut = _donut(dist) if dist else "<div class='muted'>outcomes stage produced no labels</div>"

    # --- hotspots (by cumulative time) ---
    hot = sorted(comp_total_ms.items(), key=lambda x: -x[1])[:15]
    tmax = hot[0][1] if hot else 0.0
    hot_bars = "".join(
        _bar_row(
            c,
            ms,
            tmax,
            f"{_fmt_ms(ms)} \u00b7 {comp_count.get(c, 0)}\u00d7 \u00b7 "
            f"p95 {_fmt_ms(_percentile(comp_durs.get(c, []), 0.95))}",
        )
        for c, ms in hot
    )

    # --- hotspots table with code overlay ---
    top_count = sorted(comp_count.items(), key=lambda x: -x[1])[:20]
    trows = []
    for c, k in top_count:
        durs = comp_durs.get(c, [])
        info = lookup(overlay, c) if overlay else None
        loc = ""
        if info and info.get("file"):
            loc = (
                f"<br><span class='muted small'>{_esc(info['file'])}"
                + (f":{info['line']}" if info.get("line") else "")
                + "</span>"
            )
        trows.append(
            [
                f"<code title='{_esc(c)}'>{_esc(_short(c))}</code>{loc}",
                f"{k:,}",
                _fmt_ms(sum(durs)),
                _fmt_ms(_percentile(durs, 0.5)),
                _fmt_ms(_percentile(durs, 0.95)),
            ]
        )
    hot_table = _table(
        ["Component", "Calls", "Cumulative", "p50", "p95"],
        trows,
        "no exit spans",
        col_help=[
            "The piece of code (function). Hover for its full name; a file path below "
            "it shows where it lives.",
            "How many times this code ran during the trace.",
            "Total time spent inside this code across every call added together.",
            "The typical (middle) time for one call \u2014 half of calls were faster.",
            "The slow-case time: 95 of 100 calls were faster than this.",
        ],
    )

    # --- lift (fail/slow/wrong) ---
    lift = outcomes.get("lift", {}) if isinstance(outcomes, dict) else {}
    lift_blocks = []
    tone_map = {"fail": "red", "slow": "amber", "wrong": "purple"}
    for lab in ("fail", "slow", "wrong"):
        items = [x for x in (lift.get(lab) or []) if x.get("support", 0) > 0][:6]
        if not items:
            continue
        lmax = max(x["lift"] for x in items) or 1.0
        bars = "".join(
            _bar_row(
                x["component"],
                x["lift"],
                lmax,
                f"lift {x['lift']:.2f} \u00b7 n={x['support']}",
                tone_map[lab],
            )
            for x in items
        )
        lift_blocks.append(
            f"<h3 class='small' style='margin:14px 0 4px'>"
            f"<span class='pill {('bad' if lab == 'fail' else 'warn')}'>"
            f"{_esc(_OUTCOME_LABEL.get(lab, lab))}</span></h3>{bars}"
        )
    lift_html = "".join(lift_blocks) or "<div class='muted'>no discriminating components</div>"

    # --- CIRCA ---
    circa = kw["circa_summary"]
    circa_rows = []
    for item in (circa.get("ranked") or circa.get("findings") or [])[:12]:
        p = item.get("p_value")
        ks = item.get("ks_statistic")
        sig = isinstance(p, int | float) and p < 0.01
        circa_rows.append(
            [
                f"<code title='{_esc(item.get('component', item.get('node', '')))}'>"
                f"{_esc(_short(str(item.get('component', item.get('node', '')))))}</code>",
                f"{ks:.3f}" if isinstance(ks, int | float) else "\u2014",
                (
                    f"<span class='pill bad'>{p:.4f}</span>"
                    if sig
                    else (f"{p:.4f}" if isinstance(p, int | float) else "\u2014")
                ),
            ]
        )
    if circa_rows:
        circa_empty = f"CIRCA: {circa.get('note', 'no residual-shift findings')}"
    elif circa.get("error"):
        circa_empty = f"CIRCA: {circa['error']}"
    else:
        # No ranked findings almost always means the view is too sparse in TIME: CIRCA fits a
        # parent->child model on the healthy half and needs >=8 one-minute buckets of
        # overlapping data per component. The gate is active minutes, not request count \u2014
        # 28 requests bunched into a few minutes still fail \u2014 so report the bucket count.
        nb = kw.get("n_buckets", 0)
        circa_empty = (
            f"CIRCA: not enough data; needs \u22658 one-minute time buckets of activity, "
            f"this view spans {nb} bucket(s) across {kw['n_req']:,} request(s)."
        )
    circa_tbl = _table(
        ["Component", "KS stat", "p-value"],
        circa_rows,
        circa_empty,
        col_help=[
            "The suspected piece of code, ranked by how much its behavior "
            "changed when things went wrong.",
            "How different this code's behavior was between the healthy and "
            "problem periods (0 = identical, 1 = completely different).",
            "The chance this difference is just random noise. Small values "
            "(below 0.01, shown in red) mean the change is likely real.",
        ],
    )

    # --- GCM ---
    gcm = kw["gcm_summary"]
    if gcm.get("path") == "dowhy_gcm" and gcm.get("top1"):
        gcm_html = (
            f"<div class='callout bad'><b>Top culprit:</b> "
            f"<code>{_esc(gcm.get('top1'))}</code>"
            f"<div class='note'>Attributed via DoWhy GCM Shapley values on the "
            f"incident window.</div></div>"
        )
        rk = gcm.get("ranked") or gcm.get("attributions") or []
        grows = [
            [
                f"<code>{_esc(_short(str(x.get('node', x.get('component', ''))) ))}</code>",
                f"{x.get('score', x.get('shapley', 0)):.4f}"
                if isinstance(x.get("score", x.get("shapley")), int | float)
                else "\u2014",
            ]
            for x in rk[:10]
        ]
        gcm_html += _table(
            ["Node", "Attribution"],
            grows,
            "",
            col_help=[
                "A piece of code in the call graph.",
                "How much of the problem this code is estimated to have "
                "actually caused (not just been present for). Higher = more "
                "blame.",
            ],
        )
    else:
        reason = gcm.get("error") or gcm.get("note") or json.dumps(gcm)[:200]
        gcm_html = (
            "<div class='callout warn'>GCM attribution unavailable.<div class='note'>"
            f"{_esc(str(reason)[:240])}</div>"
            "<div class='note'>Needs the <code>rca</code> extra and a normal/incident "
            "split.</div></div>"
        )

    # --- drift ---
    drift = kw["drift_summary"]
    dcols = drift.get("columns", {}) if isinstance(drift, dict) else {}
    drows = []
    for col, m in list(dcols.items())[:14]:
        if not isinstance(m, dict):
            continue
        psi = m.get("psi")
        psi_tone = (
            "bad"
            if isinstance(psi, int | float) and psi > 0.2
            else ("warn" if isinstance(psi, int | float) and psi > 0.1 else "good")
        )
        drows.append(
            [
                f"<code>{_esc(col)}</code>",
                (
                    f"<span class='pill {psi_tone}'>{psi:.3f}</span>"
                    if isinstance(psi, int | float)
                    else "\u2014"
                ),
                (
                    f"{m['kl_histogram']:.3f}"
                    if isinstance(m.get("kl_histogram"), int | float)
                    else "\u2014"
                ),
                (
                    f"{m['wasserstein_1d']:.3f}"
                    if isinstance(m.get("wasserstein_1d"), int | float)
                    else "\u2014"
                ),
            ]
        )
    drift_method = str(drift.get("path", "scipy_histogram")) if isinstance(drift, dict) else "n/a"
    drift_tbl = _table(
        ["Metric", "PSI", "KL", "Wasserstein"],
        drows,
        f"Drift: no numeric columns compared ({drift_method})",
        col_help=[
            "The measurement being compared between the run's first half "
            "(healthy) and second half.",
            "Population Stability Index \u2014 an overall 'how much did this "
            "shift?' score. Under 0.1 = stable, 0.1\u20130.2 = some drift "
            "(amber), above 0.2 = big shift (red).",
            "KL divergence \u2014 another shift score focused on the shape of "
            "the distribution. Higher = more change.",
            "Wasserstein distance \u2014 the shift measured in the metric's own "
            "units (e.g. milliseconds), so it reflects absolute size of the "
            "change, not just shape.",
        ],
    )

    # --- provenance / warnings ---
    prov = kw["prov_summary"]
    prov_line = (
        f"Compared the trace against itself (golden==current): {len(prov)} request keys, "
        "0 divergences by construction. Supply two runs via "
        "<code>analyze provenance --golden A --current B</code> for a real diff."
    )
    err_block = ""
    if kw["stage_err"]:
        parts = "".join(f"<li><code>{_esc(e)}</code></li>" for e in kw["stage_err"])
        err_block = f"<div class='card full'><h2>Stage warnings</h2><ul>{parts}</ul></div>"

    raw = (
        _details_json("CIRCA (raw)", circa)
        + _details_json("GCM (raw)", gcm)
        + _details_json("Drift (raw)", drift)
        + _details_json("Outcomes lift (raw)", lift)
    )

    return f"""
  {kw.get('banner', '')}
  <div class="kpis">{kpis}</div>

  <div class="grid">
    <div class="card"><h2>Outcome mix{_help(_HELP['outcome'])}</h2>{donut}</div>
    <div class="card"><h2>Request latency distribution{_help(_HELP['latency'])}</h2>
      {_histogram(kw['req_durs'])}</div>
  </div>

  <div class="card full"><h2>Hotspots \u2014 cumulative time{_help(_HELP['hotspots'])}</h2>
    {hot_bars}</div>

  <div class="grid">
    <div class="card"><h2>Busiest components{_help(_HELP['busiest'])}</h2>{hot_table}</div>
    <div class="card"><h2>What distinguishes bad requests (lift){_help(_HELP['lift'])}</h2>
      {lift_html}</div>
  </div>

  <div class="grid">
    <div class="card"><h2>CIRCA \u2014 residual-shift RCA{_help(_HELP['circa'])}</h2>
      {circa_tbl}</div>
    <div class="card"><h2>GCM \u2014 causal attribution{_help(_HELP['gcm'])}</h2>{gcm_html}</div>
  </div>

  <div class="card full"><h2>Metric drift (normal vs incident split){_help(_HELP['drift'])}</h2>
    {drift_tbl}
    <div class="note">Drift: {_esc(drift_method)} &middot;
      {_esc('columns analyzed: ' + ', '.join(kw['metrics_cols'][:20]))}</div></div>

  <div class="card full"><h2>Provenance{_help(_HELP['provenance'])}</h2>
    <p class="small">{prov_line}</p></div>

  {err_block}

  <div class="card full"><h2>Raw stage output{_help(_HELP['raw'])}</h2>{raw}</div>
"""
