"""Click CLI for bringup: a two-stage Stage 2 bring-up driven by .vinv/vinv.md.

Stage 2a — ``bringup list <repo>``  : render the runbook that enumerates every
                                      service into ``<repo>/.vinv/services.json``.
Stage 2b — ``bringup start <repo>`` : render the runbook that starts one selected
                                      service (``--service``), instrumenting its
                                      ``--module``(s) under tracelens.

Harness-only: both commands print the fully rendered task prompt (zero LLM
calls) for the caller's coding-agent harness to execute. The legacy in-process
agent mode is gone; ``--print-prompt`` is accepted as a no-op for backwards
compatibility.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import click

from bringup.runner import (
    render_list_prompt,
    render_start_prompt,
)


def _force_utf8_stdio() -> None:
    """On Windows a piped stdout/stderr defaults to the ANSI codepage, and the
    rendered prompts contain characters it cannot encode, so reconfigure the
    streams in-process."""
    for stream in (sys.stdout, sys.stderr):
        try:
            if (stream.encoding or "").replace("-", "").lower() != "utf8":
                stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


_force_utf8_stdio()


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )


_GROUP_HELP = """\
bringup — render the runbooks that enumerate and start a repository's services.

\b
  1. bringup list  <repo>
       Print the runbook that writes a service inventory to
       <repo>/.vinv/services.json. Installs nothing, starts nothing.
  2. bringup start <repo> --service NAME [--module PKG ...]
       Print the runbook that installs, starts and verifies ONE selected
       service and records the verified start command(s).

Both commands render the full task prompt (no LLM calls); pipe the output into
your coding-agent harness (Claude Code, Cursor, Windsurf, ...) to execute it.
Requires <repo>/.vinv/vinv.md to exist. Run `bringup list --help` or
`bringup start --help` for per-command options.
"""

_LIST_HELP = """\
Print the runbook that lists every service and its modules into
REPO_PATH/.vinv/services.json.

The runbook installs nothing and starts nothing; its output feeds
`bringup start`. Requires REPO_PATH/.vinv/vinv.md to exist. Execute the
printed runbook with your coding-agent harness.
"""

_START_HELP = """\
Print the runbook that installs, starts and verifies ONE selected service,
recording the verified start command(s) at
REPO_PATH/.vinv/start_commands/<service>.json.

Pass each package to instrument with a repeated --module flag. Requires
REPO_PATH/.vinv/vinv.md to exist. Execute the printed runbook with your
coding-agent harness.
"""


@click.group(help=_GROUP_HELP)
def main() -> None:
    pass


@main.command("list", help=_LIST_HELP)
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option("--print-prompt", is_flag=True, hidden=True,
              help="Deprecated no-op: printing the rendered prompt is the only mode.")
@click.option("--portable", is_flag=True,
              help="Emit the tool-agnostic runbook variant (no Vinv-specific tool names) "
                   "for a foreign coding agent.")
@click.option("-v", "--verbose", is_flag=True, help="Enable INFO-level logging to stderr.")
def list_cmd(repo_path: str, print_prompt: bool, portable: bool, verbose: bool) -> None:
    _configure_logging(verbose)
    click.echo(render_list_prompt(Path(repo_path), portable=portable))


@main.command("start", help=_START_HELP)
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option("--service", required=True,
              help="Name of the service to bring up (from .vinv/services.json).")
@click.option("--module", "modules", multiple=True,
              help="Top-level Python package to instrument under tracelens (repeatable).")
@click.option("--session-id", default="vinv-bringup",
              help="Session id woven into tracelens output paths (default 'vinv-bringup').")
@click.option("--start-hint", default=None,
              help="How YOU start this service (e.g. 'make run-api'). The runbook verifies it, "
                   "then records the tracelens-wrapped equivalent. Defaults to the hint recorded "
                   "at .vinv/start_hints/<service>.json; a hint never lowers the verified bar.")
@click.option("--print-prompt", is_flag=True, hidden=True,
              help="Deprecated no-op: printing the rendered prompt is the only mode.")
@click.option("--portable", is_flag=True,
              help="Emit the tool-agnostic runbook variant (no Vinv-specific tool names) "
                   "for a foreign coding agent.")
@click.option("-v", "--verbose", is_flag=True, help="Enable INFO-level logging to stderr.")
def start_cmd(
    repo_path: str,
    service: str,
    modules: tuple[str, ...],
    session_id: str,
    start_hint: str | None,
    print_prompt: bool,
    portable: bool,
    verbose: bool,
) -> None:
    _configure_logging(verbose)
    click.echo(render_start_prompt(
        Path(repo_path),
        service=service,
        modules=list(modules),
        session_id=session_id,
        portable=portable,
        start_hint=start_hint,
    ))


if __name__ == "__main__":
    main()
