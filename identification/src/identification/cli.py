"""Click CLI for identification: entry-point and call-tree analysis."""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

import click

from identification.runner import (
    build_api_call_tree,
    list_service_apis,
    map_trace_to_tree,
    render_call_tree_text,
    render_trace_map_text,
    render_trace_summary_text,
    summarize_traces,
)


def _force_utf8_stdio() -> None:
    """On Windows a piped stdout/stderr defaults to the ANSI codepage, and the
    rendered call trees contain characters it cannot encode (the frozen binary
    ignores PYTHONUTF8/PYTHONIOENCODING, so this must happen in-process)."""
    for stream in (sys.stdout, sys.stderr):
        try:
            if (stream.encoding or "").replace("-", "").lower() != "utf8":
                stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


_force_utf8_stdio()


def _emit(result: dict) -> None:
    """Print the operation result as JSON and exit non-zero on error status."""
    click.echo(json.dumps(result, indent=2, default=str))
    if isinstance(result, dict) and result.get("status") == "error":
        sys.exit(1)


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )


_GROUP_HELP = """\
identification — entry-point and call-tree analysis for a service.

Build the repo's Rust index first, then:

\b
  1. identification consolidate <repo>
       List the service's entry points. Writes
       <repo>/.vinv/identification/apis.json.
  2. identification calltree <repo> --api-id ID | --symbol module:qualname
       Build the call tree for one entry point. Writes
       <repo>/.vinv/identification/<id>.calltree.json.
  3. identification tracemap <repo> --api-id ID | --symbol module:qualname
       Overlay a captured trace onto that call tree. Writes
       <repo>/.vinv/identification/<id>.tracemap.json.
  4. identification tracesummary <repo>
       Rank entry points by trace activity. Writes
       <repo>/.vinv/identification/tracesummary.json.

Override the index location with --store-dir. Run any subcommand with --help
for its options.
"""


_CONSOLIDATE_HELP = """\
List the entry points a service defines (HTTP routes, CLI commands, background
workers, scheduled jobs, lifecycle hooks, script entries).

Requires an existing index at <repo>/.vinv/index (or --store-dir).
Pass --service NAME to label the output. Writes
<repo>/.vinv/identification/apis.json.
"""


_CALLTREE_HELP = """\
Build the call tree for ONE entry point.

Identify it by --api-id (any `id` from `consolidate`), or by --symbol
(`module:qualname`) for a function no declaration names — the shape the
exerciser drives directly. Writes
<repo>/.vinv/identification/<id>.calltree.json and prints an indented tree.
--max-depth caps recursion. Requires an existing index.
"""


_TRACEMAP_HELP = """\
Overlay a captured trace onto ONE entry point's call tree.

Identify the entry point by --api-id, or by --symbol (`module:qualname`) for a
function no declaration names — the same pair `calltree` takes, so anything that
has a static tree can also have a runtime one. Annotates each node with whether
it ran (call count, duration, errors) and reports the static/runtime gaps. The
capture is probed under <repo>/.vinv/captures/ (override with --trace);
--request-id scopes to a single request. Writes
<repo>/.vinv/identification/<id>.tracemap.json. Requires an existing index and a
captured trace.
"""


_TRACESUMMARY_HELP = """\
Rank every endpoint by how many trace requests exercised it (busiest first).

The capture is probed under <repo>/.vinv/captures/ (override with --trace).
Writes <repo>/.vinv/identification/tracesummary.json. Requires an existing index
and a captured trace.
"""


@click.group(help=_GROUP_HELP)
def main() -> None:
    pass


@main.command("consolidate", help=_CONSOLIDATE_HELP)
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option("--service", default=None, help="Optional service label woven into the output.")
@click.option("--store-dir", default=None, help="Code index dir (default: <repo>/.vinv/index).")
@click.option("-v", "--verbose", is_flag=True, help="Enable INFO-level logging to stderr.")
def consolidate_cmd(
    repo_path: str,
    service: str | None,
    store_dir: str | None,
    verbose: bool,
) -> None:
    _configure_logging(verbose)
    log = logging.getLogger("identification.consolidate")
    try:
        result = list_service_apis(
            Path(repo_path),
            service=service,
            store_dir=store_dir,
            logger=log,
        )
    except Exception as exc:  # surface failures as error JSON
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    _emit(result)


@main.command("calltree", help=_CALLTREE_HELP)
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option(
    "--api-id",
    default=None,
    help="Entry-point id from `consolidate` (e.g. POST_tool_id_probe, HOOK_startup_x).",
)
@click.option(
    "--symbol",
    default=None,
    help=(
        "Root the tree at an indexed symbol instead — `module:qualname`, "
        "`path/to/file.py:name` or a bare name. For a function the exerciser "
        "drove directly, which no entry-point declaration names. One of "
        "--api-id / --symbol is required; with both, the declared entry point "
        "wins and the symbol is the fallback."
    ),
)
@click.option(
    "--service", default=None, help="Optional service label passed through to consolidation."
)
@click.option("--store-dir", default=None, help="Code index dir (default: <repo>/.vinv/index).")
@click.option(
    "--max-depth", default=12, show_default=True, help="Maximum recursion depth for the call tree."
)
@click.option(
    "--json", "as_json", is_flag=True, help="Emit the raw JSON result instead of the indented tree."
)
@click.option("-v", "--verbose", is_flag=True, help="Enable INFO-level logging to stderr.")
def calltree_cmd(
    repo_path: str,
    api_id: str | None,
    symbol: str | None,
    service: str | None,
    store_dir: str | None,
    max_depth: int,
    as_json: bool,
    verbose: bool,
) -> None:
    _configure_logging(verbose)
    log = logging.getLogger("identification.calltree")
    if not api_id and not symbol:
        _emit({"status": "error", "error": "one of --api-id / --symbol is required"})
        return
    try:
        result = build_api_call_tree(
            Path(repo_path),
            api_id=api_id,
            symbol=symbol,
            service=service,
            store_dir=store_dir,
            max_depth=max_depth,
            logger=log,
        )
    except Exception as exc:  # surface failures as error JSON
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    if as_json:
        _emit(result)
        return
    click.echo(render_call_tree_text(result))
    out = result.get("output_file")
    if out:
        click.echo(f"\nwrote {out}", err=True)


@main.command("tracemap", help=_TRACEMAP_HELP)
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option(
    "--api-id",
    default=None,
    help="Entry-point id from `consolidate` (e.g. POST_tool_id_probe, HOOK_startup_x).",
)
@click.option(
    "--symbol",
    default=None,
    help=(
        "Overlay the tree rooted at an indexed symbol instead — `module:qualname`, "
        "`path/to/file.py:name` or a bare name. For a function the exerciser drove "
        "directly, which no entry-point declaration names. One of --api-id / "
        "--symbol is required; with both, the declared entry point wins and the "
        "symbol is the fallback."
    ),
)
@click.option(
    "--trace",
    default=None,
    help="tracelens trace.jsonl to overlay (default: probe "
    "<repo>/.vinv/captures/vinv-bringup/<service>/trace.jsonl).",
)
@click.option(
    "--service",
    default=None,
    help="Optional service label; also picks the capture subdir to probe.",
)
@click.option("--store-dir", default=None, help="Code index dir (default: <repo>/.vinv/index).")
@click.option(
    "--max-depth",
    default=12,
    show_default=True,
    help="Maximum recursion depth for the underlying static call tree.",
)
@click.option("--request-id", default=None, help="Scope the overlay to a single trace request_id.")
@click.option(
    "--json",
    "as_json",
    is_flag=True,
    help="Emit the raw JSON result instead of the annotated tree.",
)
@click.option("-v", "--verbose", is_flag=True, help="Enable INFO-level logging to stderr.")
def tracemap_cmd(
    repo_path: str,
    api_id: str | None,
    symbol: str | None,
    trace: str | None,
    service: str | None,
    store_dir: str | None,
    max_depth: int,
    request_id: str | None,
    as_json: bool,
    verbose: bool,
) -> None:
    _configure_logging(verbose)
    log = logging.getLogger("identification.tracemap")
    if not api_id and not symbol:
        _emit({"status": "error", "error": "one of --api-id / --symbol is required"})
        return
    try:
        result = map_trace_to_tree(
            Path(repo_path),
            api_id=api_id,
            symbol=symbol,
            trace=trace,
            service=service,
            store_dir=store_dir,
            max_depth=max_depth,
            request_id=request_id,
            logger=log,
        )
    except Exception as exc:  # surface failures as error JSON
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    if as_json:
        _emit(result)
        return
    click.echo(render_trace_map_text(result))
    out = result.get("output_file")
    if out:
        click.echo(f"\nwrote {out}", err=True)


@main.command("tracesummary", help=_TRACESUMMARY_HELP)
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option(
    "--trace",
    default=None,
    help="tracelens trace.jsonl to count (default: probe "
    "<repo>/.vinv/captures/vinv-bringup/<service>/trace.jsonl).",
)
@click.option(
    "--service",
    default=None,
    help="Optional service label; also picks the capture subdir to probe.",
)
@click.option("--store-dir", default=None, help="Code index dir (default: <repo>/.vinv/index).")
@click.option(
    "--json", "as_json", is_flag=True, help="Emit the raw JSON result instead of the ranked table."
)
@click.option("-v", "--verbose", is_flag=True, help="Enable INFO-level logging to stderr.")
def tracesummary_cmd(
    repo_path: str,
    trace: str | None,
    service: str | None,
    store_dir: str | None,
    as_json: bool,
    verbose: bool,
) -> None:
    _configure_logging(verbose)
    log = logging.getLogger("identification.tracesummary")
    try:
        result = summarize_traces(
            Path(repo_path),
            trace=trace,
            service=service,
            store_dir=store_dir,
            logger=log,
        )
    except Exception as exc:  # surface failures as error JSON
        _emit({"status": "error", "error": str(exc), "repo_path": repo_path})
        return
    if as_json:
        _emit(result)
        return
    click.echo(render_trace_summary_text(result))
    out = result.get("output_file")
    if out:
        click.echo(f"\nwrote {out}", err=True)


if __name__ == "__main__":
    main()
