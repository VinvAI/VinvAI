"""Click CLI (spec §13)."""

from __future__ import annotations

import sys
from pathlib import Path

import click

from tracelens.launcher import run as run_mod


def _force_utf8_stdio() -> None:
    """On Windows a piped stdout/stderr defaults to the ANSI codepage, which
    cannot encode all report/trace output (the frozen binary ignores
    PYTHONUTF8/PYTHONIOENCODING, so this must happen in-process)."""
    for stream in (sys.stdout, sys.stderr):
        try:
            if (stream.encoding or "").replace("-", "").lower() != "utf8":
                stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


_force_utf8_stdio()


@click.group()
def main() -> None:
    """tracelens — third-party tracing + RCA."""


@main.command("install")
@click.option("--check", is_flag=True, help="Verify tracelens package importable.")
def install_cmd(check: bool) -> None:
    if check:
        import tracelens  # noqa: F401

        click.echo("tracelens OK")
    else:
        click.echo("use: tracelens install --check")


@main.command(context_settings={"ignore_unknown_options": True, "allow_extra_args": True})
@click.argument("args", nargs=-1, type=click.UNPROCESSED)
def run_cmd(args: tuple[str, ...]) -> None:
    """Launch a target Python service under tracelens; capture JSONL traces.

    \b
    Usage:
      tracelens run [OPTIONS] -- <user command>

    \b
    Required pattern:
      Pass tracelens flags BEFORE the literal `--`, then the unmodified user command
      (e.g. `python -m uvicorn app:app --host 0.0.0.0 --port 8000`) AFTER the `--`.

    \b
    Observability presets (a bare `run` uses --standard; pick at most one):
      --standard                     DEFAULT. AST + OTel spans capturing per-function latency
                                     (plus cpu/blocked split). Latency-honest: tracemalloc
                                     stays OFF because its allocation hook taxes the user's
                                     own code inside the timed window. A tracer_calibration
                                     header line records the measured per-call overhead and
                                     the active axes for every run.
      --minimal                      Bare AST + OTel spans (latency only). No memory, no
                                     determinism capture. Lowest overhead.
      --full                         Memory (full tracemalloc) AND determinism capture, for
                                     controlled experiments.
      TRACELENS_PRESET=memory        Memory-focused preset: full tracemalloc, no determinism
                                     (same axes as `--memory` on the default preset).
      Granular flags below override the preset per-axis (e.g. --standard --memory).

    \b
    Flags (all optional except --target-package for useful coverage):
      --target-package PKG, -t PKG   Repeatable. The Python package(s) whose functions
                                     should be AST-instrumented. Without this, only OTel
                                     framework spans (FastAPI / requests / etc.) are
                                     captured — internal calls are invisible.
      --output PATH, -o PATH         JSONL output path. Use `-` for stdout. Default:
                                     $TRACELENS_HOME/baselines/<service>/trace.jsonl
                                     (TRACELENS_HOME defaults to ~/.tracelens).
      --sample-rate FLOAT            ParentBased(TraceIdRatioBased) ratio in [0, 1].
                                     Default 1.0 (trace every request).
      --no-otel-autoinst             Skip OpenTelemetry contrib auto-instrumentation;
                                     keep only the AST hook.
      --instrument-third-party       Allow the AST hook into site-packages modules
                                     (default skips them; only the user's --target-package
                                     code is instrumented).
      --summary-byte-cap N           Cap on args_summary / result_summary serialized
                                     bytes (default 256).
      --accept-fork-loss             Silence the warning when --reload / --workers /
                                     gunicorn worker patterns are detected. Child
                                     processes ARE traced and merged back at exit;
                                     a worker outliving the supervisor can leave an
                                     unmerged .child-<pid> sidecar.
      --memory / --no-memory         Force per-function memory attribution on/off (overrides
                                     the preset). Captured via tracemalloc byte deltas around
                                     each instrumented call and emitted as `mem_delta_bytes` on
                                     every exit span — the same AST-rewrite path as latency.
                                     On for full and the memory preset; off for standard and
                                     minimal (tracemalloc distorts user-code latency).
      --capture-determinism          Force clock + RNG capture on (time.* / random.* / uuid4 /
                                     secrets per request) to a sidecar <output>.determinism.jsonl.
      --no-capture-determinism       Force determinism capture off (overrides the preset).

    \b
    Examples:
      # Standard (default): latency-honest capture. No flags needed:
      tracelens run --target-package myapp -- \\
        python -m uvicorn myapp.api:app --host 0.0.0.0 --port 8000

      # Bare spans only (lowest overhead):
      tracelens run -t myapp --minimal -- python -m myapp.main

      # Memory-focused capture (full tracemalloc; distorts latency, and the
      # tracer_calibration header says so):
      tracelens run -t myapp --memory -- python -m myapp.main

      # Stream JSONL to stdout instead of a file:
      tracelens run -t myapp -o - -- python -m myapp.main

    \b
    Notes:
      * Stop with Ctrl-C or `kill -TERM <pid>` — tracelens flushes spans on the way out.
      * After exit, `<output>.summary.json` is written next to the JSONL automatically.
      * Run `tracelens analyze --help` and `tracelens report --help` for downstream stages.
      * Run `tracelens summarize <log>` to (re)produce summary.json post-hoc.
    """
    # Click strips `--` from UNPROCESSED; recover from raw argv (spec §5.1).
    #
    # The subcommand may surface as either `run` (Click ≥ 8.2 — drops the `_cmd`
    # suffix derived from the function name) or `run-cmd` (Click ≤ 8.1 — only
    # converts underscores to dashes). Try both before falling back to the
    # Click-mangled args.
    av = sys.argv
    ri = -1
    for token in ("run", "run-cmd", "run_cmd"):
        try:
            ri = av.index(token)
            break
        except ValueError:
            continue
    if ri >= 0:
        run_mod.run_main(list(av[ri + 1 :]))
        return
    run_mod.run_main(list(args))


@main.group("analyze")
def analyze() -> None:
    """Offline analysis."""


@analyze.command("spans")
@click.argument("log", type=click.Path(path_type=Path))
@click.option("--out", type=click.Path(path_type=Path), default=Path("spans.json"))
@click.option("--chrome-out", type=click.Path(path_type=Path), default=None)
def analyze_spans(log: Path, out: Path, chrome_out: Path | None) -> None:
    from tracelens.analysis import spans as spans_mod

    spans_mod.build_spans(log, out, chrome_out)


@analyze.command("depgraph")
@click.argument("log", type=click.Path(path_type=Path))
@click.option("--out", type=click.Path(path_type=Path), default=Path("depgraph.json"))
@click.option("--min-support", type=int, default=5)
def analyze_depgraph(log: Path, out: Path, min_support: int) -> None:
    from tracelens.analysis import depgraph as dg

    dg.build_depgraph(log, out, min_support=min_support)


@analyze.command("outcomes")
@click.argument("log", type=click.Path(path_type=Path))
@click.option("--oracle", type=str, default=None)
@click.option("--out", type=click.Path(path_type=Path), default=Path("outcomes.json"))
def analyze_outcomes(log: Path, oracle: str | None, out: Path) -> None:
    from tracelens.analysis import clustering as cl

    cl.build_outcomes(log, out, oracle_dotted=oracle)


@analyze.command("metrics")
@click.argument("log", type=click.Path(path_type=Path))
@click.option("--bucket", type=str, default="60s")
@click.option("--out", type=click.Path(path_type=Path), default=Path("metrics.parquet"))
def analyze_metrics(log: Path, bucket: str, out: Path) -> None:
    from tracelens.analysis import metrics as met

    met.build_metrics(log, out, bucket=bucket)


@analyze.command("circa")
@click.option("--metrics", type=click.Path(path_type=Path), required=True)
@click.option("--depgraph", type=click.Path(path_type=Path), required=True)
@click.option("--target", type=str, required=True)
@click.option("--normal", type=str, required=True)
@click.option("--incident", type=str, required=True)
@click.option("--out", type=click.Path(path_type=Path), default=Path("circa.json"))
def analyze_circa(
    metrics: Path, depgraph: Path, target: str, normal: str, incident: str, out: Path
) -> None:
    from tracelens.analysis import circa as cr

    cr.run_circa(metrics, depgraph, target, normal, incident, out)


@analyze.command("gcm")
@click.option("--metrics", type=click.Path(path_type=Path), required=True)
@click.option("--depgraph", type=click.Path(path_type=Path), required=True)
@click.option("--target", type=str, required=True)
@click.option("--normal", type=str, required=True)
@click.option("--incident", type=str, required=True)
@click.option(
    "--metric-col",
    type=str,
    default="latency_p95",
    help="Parquet column used as each node's observed value in the SCM.",
)
@click.option("--out", type=click.Path(path_type=Path), default=Path("gcm.json"))
def analyze_gcm(
    metrics: Path,
    depgraph: Path,
    target: str,
    normal: str,
    incident: str,
    out: Path,
    metric_col: str,
) -> None:
    from tracelens.analysis import gcm_rca as gcm

    gcm.run_gcm(metrics, depgraph, target, normal, incident, out, metric_col=metric_col)


@analyze.command("provenance")
@click.option("--golden", type=click.Path(path_type=Path), required=True)
@click.option("--current", type=click.Path(path_type=Path), required=True)
@click.option("--out", type=click.Path(path_type=Path), default=Path("provenance.json"))
def analyze_provenance(golden: Path, current: Path, out: Path) -> None:
    from tracelens.analysis import correctness as corr

    corr.provenance_diff(golden, current, out)


@analyze.command("drift")
@click.option("--metrics", type=click.Path(path_type=Path), required=True)
@click.option("--baseline", type=str, required=True)
@click.option("--window", type=str, required=True)
@click.option("--out", type=click.Path(path_type=Path), default=Path("drift.json"))
def analyze_drift(metrics: Path, baseline: str, window: str, out: Path) -> None:
    from tracelens.analysis import correctness as corr

    corr.drift_metrics(metrics, baseline, window, out)


@main.command("report")
@click.argument("log", type=click.Path(path_type=Path))
@click.option("--out", type=click.Path(path_type=Path), default=Path("report.html"))
@click.option(
    "--code-overlay",
    type=click.Path(path_type=Path, exists=True),
    default=None,
    help="Code-index symbol catalog (parquet/jsonl/json) keyed by qualname (T1.5).",
)
@click.option(
    "--identification",
    type=click.Path(path_type=Path, exists=True, file_okay=False),
    default=None,
    help="Identification dir with *.tracemap.json (per-API request grouping). "
    "Auto-discovered from the trace path when omitted.",
)
@click.option(
    "--api-id",
    default=None,
    help="Scope the report to a single endpoint by its identification id "
    "(e.g. GET_v1_vinv_sessions). Omits the 'All endpoints' overview and dropdown.",
)
def report_cmd(
    log: Path,
    out: Path,
    code_overlay: Path | None,
    identification: Path | None,
    api_id: str | None,
) -> None:
    from tracelens.analysis import report as rep

    rep.write_report(
        log, out, code_overlay=code_overlay, identification=identification, api_id=api_id
    )


@main.command("summarize")
@click.argument("log", type=click.Path(path_type=Path, exists=True))
@click.option(
    "--out",
    type=click.Path(path_type=Path),
    default=None,
    help="Defaults to <log>.summary.json next to the JSONL.",
)
def summarize_cmd(log: Path, out: Path | None) -> None:
    """T1.4 — produce summary.json from a captured JSONL post-hoc."""
    from tracelens.launcher.summary import write_summary

    target = write_summary(log, out_path=out)
    click.echo(f"summary written: {target}")


@analyze.command("symbol-stats")
@click.argument("log", type=click.Path(path_type=Path, exists=True))
@click.option("--out", type=click.Path(path_type=Path), default=Path("symbol-stats.parquet"))
def analyze_symbol_stats(log: Path, out: Path) -> None:
    """T2.4 — per-symbol perf overlay parquet (consumed by the code index to rank by cost)."""
    from tracelens.analysis import symbol_stats as ss

    ss.build_symbol_stats(log, out)


@analyze.command("dynamic-static-diff")
@click.argument("log", type=click.Path(path_type=Path, exists=True))
@click.option(
    "--static",
    "static_path",
    type=click.Path(path_type=Path, exists=True),
    required=True,
    help="Static call graph JSON (code index / SCIP / hand-built).",
)
@click.option("--out", type=click.Path(path_type=Path), default=Path("dyn-static-diff.json"))
def analyze_dynamic_static_diff(log: Path, static_path: Path, out: Path) -> None:
    """T2.5 — diff observed runtime call graph (depgraph) vs. static (code index)."""
    from tracelens.analysis import dynamic_static_diff as ds

    ds.build_diff(log, static_path, out)


@analyze.command("corpus")
@click.argument("log", type=click.Path(path_type=Path, exists=True))
@click.option("--out", type=click.Path(path_type=Path), default=Path("corpus.parquet"))
def analyze_corpus(log: Path, out: Path) -> None:
    """T2.2 — assemble the per-request replay corpus from a captured JSONL."""
    from tracelens.analysis import corpus as cp

    cp.build_corpus(log, out)


@main.command("attach")
@click.argument("pid", type=int)
@click.option("--output", "-o", type=click.Path(path_type=Path), default=Path("attach.jsonl"))
@click.option("--duration", type=str, default="60s")
def attach_cmd(pid: int, output: Path, duration: str) -> None:
    from tracelens.launcher import attach as att

    att.run_attach(pid, output, duration)


@main.command("proxy")
@click.option("--port", type=int, required=True)
@click.option("--output", "-o", type=click.Path(path_type=Path), default=Path("proxy.jsonl"))
@click.argument("passthrough", nargs=-1, type=click.UNPROCESSED)
def proxy_cmd(port: int, output: Path, passthrough: tuple[str, ...]) -> None:
    from tracelens.launcher import proxy as pr

    pr.run_proxy(port, output, list(passthrough))


if __name__ == "__main__":
    main()
