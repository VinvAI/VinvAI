"""Click CLI for handbook: render the discovery prompt for <repo>/.vinv/vinv.md.

Harness-only: ``handbook generate`` prints the fully rendered discovery task
prompt (zero LLM calls) for the caller's coding-agent harness to execute. The
legacy in-process agent mode is gone; ``--print-prompt`` is accepted as a no-op
for backwards compatibility.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import click

from handbook.generator import render_documentation_prompt


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


@click.group()
def main() -> None:
    """handbook — render the repository onboarding-handbook prompt (.vinv/vinv.md)."""


@main.command("generate")
@click.argument("repo_path", type=click.Path(exists=True, file_okay=False))
@click.option("--print-prompt", is_flag=True, hidden=True,
              help="Deprecated no-op: printing the rendered prompt is the only mode.")
@click.option("--portable", is_flag=True,
              help="Emit the tool-agnostic prompt variant (no Vinv-specific tool names) "
                   "for a foreign coding agent.")
@click.option("-v", "--verbose", is_flag=True, help="Enable INFO-level logging to stderr.")
def generate_cmd(repo_path: str, print_prompt: bool, portable: bool, verbose: bool) -> None:
    """Print the discovery task prompt that writes REPO_PATH/.vinv/vinv.md.

    Execute the printed prompt with your coding-agent harness (Claude Code,
    Cursor, Windsurf, ...); the harness's agent writes the handbook file.
    """
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    click.echo(render_documentation_prompt(Path(repo_path), portable=portable))


if __name__ == "__main__":
    main()
