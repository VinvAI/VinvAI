"""Click CLI for the exerciser engine — mirrors identification's CLI shape.

\b
  1. vinv-exerciser plan    <repo>  — build the per-endpoint input plan
  2. vinv-exerciser run     <repo> --base-url URL — execute it against the live
        traced service, coverage-guided
  3. vinv-exerciser profile <repo>  — the behavioral profile + invariants
  4. vinv-exerciser regress <repo> --base-url URL — replay the behavior suite

Every command prints its result as JSON and exits non-zero on an error status.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

import click

from . import store
from .concurrency import run_concurrency
from .differential import run_differential
from .environment import run_environment
from .faults import run_faults
from .functions import run_functions
from .plan import build_plan
from .profile import build_profile
from .regress import replay_suite
from .run import run_exercise
from .scorecard import build_scorecard
from .throughput import pick_sweep_endpoint, run_sweep, sweep_path
from .usl import fit_usl


def _force_utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            if (stream.encoding or "").replace("-", "").lower() != "utf8":
                stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


_force_utf8_stdio()


def _emit(result: dict) -> None:
    click.echo(json.dumps(result, indent=2, default=str))
    if isinstance(result, dict):
        # Diagnostics (e.g. "0 endpoints — Vinv cannot exercise this repo")
        # must be LOUD: a silent zero looks exactly like a clean run.
        for diag in result.get("diagnostics") or []:
            click.secho(f"WARNING: {diag}", err=True, fg="yellow")
        if result.get("status") == "error":
            sys.exit(1)


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )


_GROUP_HELP = """\
exerciser — the behavioral testing engine: discover, EXERCISE, profile, and
verify every endpoint of a service.

\b
  1. exerciser plan <repo> [--base-url URL]
       Build the per-endpoint input plan (schema + observed + semantic layers).
       Writes <repo>/.vinv/exercise/plan.json.
  2. exerciser run <repo> --base-url http://127.0.0.1:PORT
       Execute the plan against the live traced service, coverage-guided.
       Writes results.jsonl, bandit.json, issues.json, baselines/*.
  3. exerciser functions <repo>
       Drive catalogued entry points and exported functions IN PROCESS
       (isolated workers, per-module deadline). Writes functions.json,
       function_results.jsonl. Needs no running service.
  4. exerciser profile <repo>
       Build the behavioral profile + learned invariants.
       Writes profile.json, profile.md, invariants.json.
  5. exerciser regress <repo> --base-url http://127.0.0.1:PORT
       Replay the accumulated behavior suite and report diffs.

Requires identification's apis.json (run `identification consolidate` first) and,
for real coverage, a service running under tracelens.
"""


@click.group(help=_GROUP_HELP)
def main() -> None:
    pass


@main.command("plan")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option("--service", default=None, help="Optional service label.")
@click.option(
    "--base-url",
    default=None,
    help="Live service base URL; its OpenAPI is fetched for real shapes/paths.",
)
@click.option("--store-dir", default=None, help="Code index dir (default: <repo>/.vinv/index).")
@click.option(
    "--seed", default=1729, show_default=True, help="Seed for deterministic input generation."
)
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def plan_cmd(repo_path, service, base_url, store_dir, seed, verbose):
    _configure_logging(verbose)
    try:
        result = build_plan(
            Path(repo_path),
            service=service,
            base_url=base_url,
            store_dir=store_dir,
            seed=seed,
            logger=logging.getLogger("exerciser.plan"),
        )
    except Exception as exc:  # surface as error JSON
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


@main.command("run")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option("--base-url", required=True, help="Live traced service base URL.")
@click.option("--service", default=None, help="Optional service label.")
@click.option("--store-dir", default=None, help="Code index dir (default: <repo>/.vinv/index).")
@click.option("--budget", default=200, show_default=True, help="Max probes across all rounds.")
@click.option(
    "--rounds",
    default=3,
    show_default=True,
    help="No-improvement patience: stop after K rounds add no new symbol.",
)
@click.option("--seed", default=1729, show_default=True, help="Seed for strategy sampling.")
@click.option(
    "--settle",
    default=0.8,
    show_default=True,
    help="Seconds to wait for spans to flush before re-joining coverage.",
)
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def run_cmd(repo_path, base_url, service, store_dir, budget, rounds, seed, settle, verbose):
    _configure_logging(verbose)
    try:
        result = run_exercise(
            Path(repo_path),
            base_url,
            service=service,
            store_dir=store_dir,
            budget=budget,
            rounds=rounds,
            seed=seed,
            settle_s=settle,
            logger=logging.getLogger("exerciser.run"),
        )
    except Exception as exc:
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


@main.command("functions")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option("--service", default=None, help="Optional service label.")
@click.option("--max-targets", default=200, show_default=True, help="Cap on callables driven.")
@click.option(
    "--module-timeout",
    default=30.0,
    show_default=True,
    help="Wall-clock seconds per module worker (a hang costs one module).",
)
@click.option("--python", default=None, help="Interpreter for the workers (default: this one).")
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def functions_cmd(repo_path, service, max_targets, module_timeout, python, verbose):
    _configure_logging(verbose)
    try:
        result = run_functions(
            Path(repo_path),
            service=service,
            max_targets=max_targets,
            module_timeout_s=module_timeout,
            python=python,
            logger=logging.getLogger("exerciser.functions"),
        )
    except Exception as exc:
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


@main.command("differential")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option(
    "--target",
    default=None,
    help="One target as module:qualname (default: reference-finder proposals).",
)
@click.option(
    "--reference",
    default=None,
    help="Reference implementation: 'cpython-exec' or module:qualname.",
)
@click.option(
    "--timeout", default=60.0, show_default=True, help="Seconds per (target, reference) pair."
)
@click.option(
    "--python",
    default=None,
    help="Interpreter for the workers — use the TARGET's venv (default: this one).",
)
@click.option(
    "--call-kwargs",
    default=None,
    help=(
        'JSON kwargs for every target call, e.g. \'{"static_tools": '
        '"@pkg.mod:BASE_TOOLS"}\'. An "@module:SYMBOL" value is resolved by '
        "import — configure the target the way production does."
    ),
)
@click.option(
    "--max-adjudications",
    default=25,
    show_default=True,
    help="Cap on NEW refusal shapes queued for agentic adjudication per run.",
)
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def differential_cmd(
    repo_path, target, reference, timeout, python, call_kwargs, max_adjudications, verbose
):
    _configure_logging(verbose)
    try:
        parsed_kwargs = json.loads(call_kwargs) if call_kwargs else None
        if parsed_kwargs is not None and not isinstance(parsed_kwargs, dict):
            raise ValueError("--call-kwargs must be a JSON object")
        result = run_differential(
            Path(repo_path),
            target=target,
            reference=reference,
            call_kwargs=parsed_kwargs,
            timeout_s=timeout,
            python=python,
            max_adjudications=max_adjudications,
            logger=logging.getLogger("exerciser.differential"),
        )
    except Exception as exc:
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


@main.command("faults")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option(
    "--target", default=None, help="Consumer to drive as module:qualname (kwargs-called)."
)
@click.option(
    "--contract",
    default=None,
    help='JSON type contract of the boundary, e.g. \'{"content": "str | None"}\'.',
)
@click.option(
    "--baseline", default=None, help="JSON well-formed payload; faults replace ONE field of it."
)
@click.option("--chunk-field", default=None, help="Field carrying the stream chunks.")
@click.option(
    "--chunk-canonical",
    default=None,
    help="Canonical stream text; every split point is swept for aggregator convergence.",
)
@click.option("--timeout", default=60.0, show_default=True, help="Seconds per boundary.")
@click.option("--python", default=None, help="Interpreter for the workers (TARGET's venv).")
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def faults_cmd(
    repo_path, target, contract, baseline, chunk_field, chunk_canonical, timeout, python, verbose
):
    _configure_logging(verbose)
    try:
        result = run_faults(
            Path(repo_path),
            target=target,
            contract=json.loads(contract) if contract else None,
            baseline=json.loads(baseline) if baseline else None,
            chunk_field=chunk_field,
            chunk_canonical=chunk_canonical,
            timeout_s=timeout,
            python=python,
            logger=logging.getLogger("exerciser.faults"),
        )
    except Exception as exc:
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


@main.command("environment")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option(
    "--signature-target",
    "signature_targets",
    multiple=True,
    help="Upstream symbol to watch as module:qualname. Repeatable.",
)
@click.option("--skip-matrix", is_flag=True, help="Skip the uv dependency-resolution matrix.")
@click.option("--timeout", default=180.0, show_default=True, help="Seconds per resolution mode.")
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def environment_cmd(repo_path, signature_targets, skip_matrix, timeout, verbose):
    _configure_logging(verbose)
    try:
        result = run_environment(
            Path(repo_path),
            targets=list(signature_targets) or None,
            skip_matrix=skip_matrix,
            timeout_s=timeout,
            logger=logging.getLogger("exerciser.environment"),
        )
    except Exception as exc:
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


@main.command("concurrency")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option("--target", required=True, help="Callable to probe as module:qualname.")
@click.option("--kwargs", "kwargs_json", default=None, help="JSON kwargs for each call.")
@click.option("--workers", default=4, show_default=True, help="Concurrent callers.")
@click.option("--repeats", default=3, show_default=True, help="Schedule repetitions.")
@click.option("--call-timeout", default=5.0, show_default=True, help="Per-call deadline (seconds).")
@click.option("--python", default=None, help="Interpreter for the worker (TARGET's venv).")
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def concurrency_cmd(
    repo_path, target, kwargs_json, workers, repeats, call_timeout, python, verbose
):
    _configure_logging(verbose)
    try:
        result = run_concurrency(
            Path(repo_path),
            target=target,
            kwargs=json.loads(kwargs_json) if kwargs_json else None,
            workers=workers,
            repeats=repeats,
            call_timeout_s=call_timeout,
            python=python,
            logger=logging.getLogger("exerciser.concurrency"),
        )
    except Exception as exc:
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


@main.command("profile")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option("--service", default=None, help="Optional service label.")
@click.option("--store-dir", default=None, help="Code index dir (default: <repo>/.vinv/index).")
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def profile_cmd(repo_path, service, store_dir, verbose):
    _configure_logging(verbose)
    try:
        result = build_profile(
            Path(repo_path),
            service=service,
            store_dir=store_dir,
            logger=logging.getLogger("exerciser.profile"),
        )
    except Exception as exc:
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


@main.command("regress")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option("--base-url", required=True, help="Live traced service base URL.")
@click.option("--service", default=None, help="Optional service label.")
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def regress_cmd(repo_path, base_url, service, verbose):
    _configure_logging(verbose)
    try:
        result = replay_suite(
            Path(repo_path),
            base_url,
            service=service,
            logger=logging.getLogger("exerciser.regress"),
        )
    except Exception as exc:
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


@main.command("throughput-sweep")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option("--base-url", required=True, help="Live service base URL to sweep.")
@click.option(
    "--endpoint",
    default=None,
    help="GET path to sweep (default: the parameter-free GET path with the "
    "most 2xx observations in results.jsonl).",
)
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def throughput_sweep_cmd(repo_path, base_url, endpoint, verbose):
    """Concurrency sweep of one healthy GET endpoint + a USL fit.

    Runs the bounded thread-pool driver at each concurrency level, fits the
    Universal Scalability Law to the (concurrency, req/s) points, and writes
    .vinv/exercise/throughput_sweep.json — the artifact detect_opportunities
    reads to emit "throughput-ceiling" opportunities.
    """
    _configure_logging(verbose)
    try:
        repo = Path(repo_path)
        if endpoint is None:
            endpoint = pick_sweep_endpoint(store.read_jsonl(store.results_path(repo)))
            if endpoint is None:
                _emit(
                    {
                        "status": "error",
                        "error": "no healthy parameter-free GET endpoint in results.jsonl "
                        "(run `exerciser run` first, or pass --endpoint)",
                        "repo_path": repo_path,
                    }
                )
                return
        points = run_sweep(base_url, endpoint)
        fit = fit_usl([(p.concurrency, p.req_per_s) for p in points])
        doc = {
            "endpoint": endpoint,
            "points": [p.to_json() for p in points],
            "fit": fit.to_json() if fit is not None else None,
        }
        store.write_json(sweep_path(repo), doc)
        result = {"status": "ok", "sweep_file": str(sweep_path(repo)), **doc}
    except Exception as exc:
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


@main.command("scorecard")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option("--service", default=None, help="Optional service label.")
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def scorecard_cmd(repo_path, service, verbose):
    _configure_logging(verbose)
    try:
        result = build_scorecard(Path(repo_path), service=service)
    except Exception as exc:
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


if __name__ == "__main__":
    main()
