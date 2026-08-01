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
from .campaign import run_campaign
from .concurrency import run_concurrency
from .containment import detect_containment, parse_tier
from .differential import run_differential
from .environment import run_environment
from .faults import run_faults
from .functions import run_functions
from .invocations import DEFAULT_INVOCATION_TIMEOUT_S, run_invocations
from .plan import build_plan
from .profile import build_profile
from .regress import replay_suite
from .run import run_exercise
from .sandbox import DEFAULT_MAX_COPY_MB, SandboxPolicy
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
  3. exerciser functions <repo> [--no-sandbox] [--require-tier TIER] [--no-services]
       Drive catalogued entry points and exported functions. Verified-pure
       targets run IN PROCESS (isolated workers, per-module deadline); every
       target the purity guard could NOT verify is routed through containment
       automatically. Writes functions.json, function_results.jsonl. Needs no
       running service. --no-sandbox leaves the unverified set refused;
       `exerciser containment` reports which tier this host can provide.
  4. exerciser invocations <repo> [--service X]
       Run each invocation `.vinv/services.json` records for a `python_cli` or
       `python_library` service, wrapped in tracelens. This is what exercises a
       repo whose Python is CLIs rather than servers — there is no base URL to
       send anything to. Writes invocations.json, invocation_results.jsonl.
  5. exerciser campaign <repo> [--base-url URL] [--budget N]
       Allocate ONE budget across every armed oracle by Thompson sampling over
       (target x technique x oracle) — instead of driving each oracle
       exhaustively. Writes campaign.json; reports which technique paid.
  6. exerciser profile <repo>
       Build the behavioral profile + learned invariants.
       Writes profile.json, profile.md, invariants.json.
  7. exerciser regress <repo> --base-url http://127.0.0.1:PORT
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
@click.option(
    "--sandbox/--no-sandbox",
    default=True,
    show_default=True,
    help=(
        "Route the targets the purity guard could not verify through containment "
        "(the default). Containment is the strongest wall this host offers: an OS "
        "sandbox where one is available, otherwise the Python shim — plus a "
        "disposable copy of the repo, redirected HOME/TMPDIR/XDG_*, blocked "
        "network and subprocess spawning, POSIX rlimits. --no-sandbox leaves that "
        "whole set REFUSED and undriven; it never runs them loose."
    ),
)
@click.option(
    "--require-tier",
    type=click.Choice(["os-sandbox", "process-shim"]),
    default=None,
    help=(
        "Refuse the run rather than accept a weaker containment tier. "
        "'os-sandbox' demands a kernel-enforced wall (sandbox-exec/bwrap/unshare)."
    ),
)
@click.option(
    "--max-tier",
    type=click.Choice(["os-sandbox", "process-shim"]),
    default=None,
    help="Cap containment at this tier (for reproducing weaker-tier behaviour).",
)
@click.option(
    "--sandbox-max-copy-mb",
    default=DEFAULT_MAX_COPY_MB,
    show_default=True,
    help="Refuse to sandbox a repo whose copy would exceed this size.",
)
@click.option(
    "--sandbox-keep-root",
    is_flag=True,
    help="Leave the sandbox tree on disk for inspection instead of discarding it.",
)
@click.option(
    "--services/--no-services",
    default=True,
    show_default=True,
    help=(
        "Substitute the services the repo expects to already be running "
        "(Postgres, Redis, S3) INSIDE the jail, so a target that needs one runs "
        "instead of failing to connect. Containment is unchanged either way — "
        "the network stays blocked; --no-services just leaves those targets "
        "unexercised. Substitution is reported, and a statement the stand-in "
        "cannot honour is recorded as the HARNESS's gap, never as a defect."
    ),
)
@click.option(
    "--seed-rows",
    default=1,
    show_default=True,
    help=(
        "Rows seeded into a table whose schema had to be induced, so a read path "
        "has something to read. 0 leaves induced tables empty."
    ),
)
@click.option(
    "--trace/--no-trace",
    default=True,
    show_default=True,
    help=(
        "Wrap each module's worker in `tracelens run` so the calls this driver "
        "makes produce spans — the only way a library with no service of its own "
        "gets a trace. Captures land under "
        ".vinv/captures/vinv-exerciser/<service>/functions/. --no-trace still "
        "drives every target; it just records nothing."
    ),
)
@click.option(
    "--only-target",
    "only_targets",
    multiple=True,
    help=(
        "Drive ONE exported callable as module:qualname instead of sweeping the "
        "library (repeatable). A library's entry points are its units of work, "
        "and this is how one of them is run on its own — the editor's "
        "'Run Service with Arguments…' fills this slot from the entrypoints "
        "inventory. Omit it and every discovered target runs, as before."
    ),
)
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def functions_cmd(
    repo_path,
    service,
    max_targets,
    module_timeout,
    python,
    sandbox,
    require_tier,
    max_tier,
    sandbox_max_copy_mb,
    sandbox_keep_root,
    services,
    seed_rows,
    trace,
    only_targets,
    verbose,
):
    _configure_logging(verbose)
    policy = (
        SandboxPolicy(
            enabled=True,
            max_copy_mb=sandbox_max_copy_mb,
            keep_root=sandbox_keep_root,
            require_tier=parse_tier(require_tier),
            max_tier=parse_tier(max_tier),
            synthesize_services=services,
            seed_rows=max(0, seed_rows),
        )
        if sandbox
        else None
    )
    try:
        result = run_functions(
            Path(repo_path),
            service=service,
            max_targets=max_targets,
            module_timeout_s=module_timeout,
            python=python,
            sandbox=sandbox,
            sandbox_policy=policy,
            trace=trace,
            # None, not [], when unset: `only_targets=[]` filters every target
            # away and reports a clean zero, which is indistinguishable from a
            # library with nothing to drive.
            only_targets=list(only_targets) or None,
            logger=logging.getLogger("exerciser.functions"),
        )
    except Exception as exc:
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


@main.command("invocations")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option(
    "--service",
    default=None,
    help="Drive only this service (default: every python_cli / python_library entry).",
)
@click.option(
    "--timeout",
    default=DEFAULT_INVOCATION_TIMEOUT_S,
    show_default=True,
    help="Wall-clock seconds per invocation; one that outruns it is reported as a timeout.",
)
@click.option(
    "--trace/--no-trace",
    default=True,
    show_default=True,
    help=(
        "Wrap each invocation in `tracelens run` against the service's own "
        "`modules`, so a CLI run produces spans exactly as a served request does. "
        "Captures land under .vinv/captures/vinv-exerciser/<service>/invocations/."
    ),
)
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def invocations_cmd(repo_path, service, timeout, trace, verbose):
    _configure_logging(verbose)
    try:
        result = run_invocations(
            Path(repo_path),
            service=service,
            timeout_s=timeout,
            trace=trace,
            logger=logging.getLogger("exerciser.invocations"),
        )
    except Exception as exc:
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


@main.command("containment")
@click.option("--python", default=None, help="Interpreter to probe with (default: this one).")
@click.option(
    "--allow-network",
    is_flag=True,
    help="Probe without demanding a network wall (a policy that permits sockets).",
)
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def containment_cmd(python, allow_network, verbose):
    """Report which containment tier this host can actually provide, and why.

    The answer comes from a PROBE — the candidate mechanism is run on a trivial
    command and checked to have really blocked a write outside its root — never
    from the presence of a binary on PATH.
    """
    _configure_logging(verbose)
    mechanism = detect_containment(
        block_network=not allow_network,
        python=python,
        logger=logging.getLogger("exerciser.containment"),
    )
    _emit({"status": "ok", "platform": sys.platform, **mechanism.to_json()})


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
@click.option(
    "--auto-target",
    "auto_targets",
    multiple=True,
    help=(
        "Derive a boundary from this consumer's own annotations (module:fn). "
        "Repeatable. What the code does not declare becomes ONE cached "
        "question on the agent channel."
    ),
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
    repo_path,
    target,
    contract,
    baseline,
    auto_targets,
    chunk_field,
    chunk_canonical,
    timeout,
    python,
    verbose,
):
    _configure_logging(verbose)
    try:
        result = run_faults(
            Path(repo_path),
            target=target,
            contract=json.loads(contract) if contract else None,
            baseline=json.loads(baseline) if baseline else None,
            auto_targets=list(auto_targets) or None,
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


@main.command("campaign")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option("--budget", default=20, show_default=True, help="Plays to allocate across oracles.")
@click.option(
    "--base-url",
    default=None,
    help="Live traced service base URL. Without it the HTTP oracle is not armed.",
)
@click.option("--seed", default=1729, show_default=True, help="Seed for Thompson sampling.")
@click.option(
    "--patience",
    default=8,
    show_default=True,
    help="Stop after K consecutive plays that break nothing and cover nothing new.",
)
@click.option(
    "--max-targets", default=50, show_default=True, help="Cap on targets armed per oracle."
)
@click.option(
    "--include-environment",
    is_flag=True,
    help="Arm the environment resolution matrix (slow: minutes per play).",
)
@click.option("--python", default=None, help="Interpreter for oracle workers (TARGET's venv).")
@click.option("--timeout", default=60.0, show_default=True, help="Seconds per oracle invocation.")
@click.option("-v", "--verbose", is_flag=True, help="INFO logging to stderr.")
def campaign_cmd(
    repo_path,
    budget,
    base_url,
    seed,
    patience,
    max_targets,
    include_environment,
    python,
    timeout,
    verbose,
):
    """Allocate ONE budget across every armed oracle, by Thompson sampling.

    Enumerates the (target x technique x oracle) action space from the existing
    discovery functions, then spends each unit of budget on the action the
    bandit draws — instead of driving every oracle exhaustively. Posteriors
    warm-start from and persist to .vinv/exercise/campaign.json, so which
    technique pays on THIS repo is learned across runs. Reports by_technique and
    by_oracle.
    """
    _configure_logging(verbose)
    try:
        result = run_campaign(
            Path(repo_path),
            budget=budget,
            base_url=base_url,
            seed=seed,
            patience=patience,
            max_targets=max_targets,
            include_environment=include_environment,
            python=python,
            timeout_s=timeout,
            logger=logging.getLogger("exerciser.campaign"),
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
