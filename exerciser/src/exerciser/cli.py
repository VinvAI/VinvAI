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
