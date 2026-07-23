"""Click CLI for goal: render prompts that distill a working context into one goal.

``goal create [CONTEXT]`` : print the goal-distillation prompt over the given
                            context (argument, ``--context-file``, or stdin).

Harness-only: every command prints a fully rendered prompt (zero LLM calls)
for the caller's coding-agent harness to execute; the harness replies with the
JSON object the prompt specifies.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import IO

import click

from goal.runner import render_goal_prompt


def _force_utf8_stdio() -> None:
    """On Windows a piped stdout/stderr defaults to the ANSI codepage, and the
    rendered prompt text can contain characters it cannot encode, so
    reconfigure the streams in-process."""
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
goal — render prompts that distill a working context into one actionable goal.

\b
  goal create "CONTEXT TEXT"
  goal create --context-file notes.md
  some-command | goal create --context-file -

Prints the rendered prompt (no LLM calls); execute it with your coding-agent
harness, which replies with the JSON object the prompt specifies. Run
`goal create --help` for per-command options.
"""

_CREATE_HELP = """\
Print the goal-distillation prompt for a working context.

The context can be passed as the CONTEXT argument, read from --context-file,
or piped on stdin via `--context-file -`. Exactly one source is required.
Execute the printed prompt with your coding-agent harness.
"""


@click.group(help=_GROUP_HELP)
def main() -> None:
    pass


@main.command("create", help=_CREATE_HELP)
@click.argument("context", required=False, default=None)
@click.option("--context-file", type=click.File("r", encoding="utf-8"), default=None,
              help="Read the context from a file instead of the argument ('-' for stdin).")
@click.option("--print-prompt", is_flag=True, hidden=True,
              help="Deprecated no-op: printing the rendered prompt is the only mode.")
@click.option("-v", "--verbose", is_flag=True, help="Enable INFO-level logging to stderr.")
def create_cmd(context: str | None, context_file: IO[str] | None,
               print_prompt: bool, verbose: bool) -> None:
    _configure_logging(verbose)
    if (context is None) == (context_file is None):
        raise click.UsageError(
            "pass the context exactly one way: either the CONTEXT argument or "
            "--context-file (use '-' for stdin)."
        )
    text = context if context is not None else context_file.read()
    try:
        click.echo(render_goal_prompt(text))
    except ValueError as exc:
        raise click.UsageError(str(exc)) from exc


# ---- verification agent prompts ---------------------------------------------
# The episode loop's verification prompts (audit judge, test authors, stall
# judge) ride this CLI so their wording lives in one versioned place. Every
# command reads ONE JSON payload from --payload-file ('-' = stdin) and prints
# the rendered prompt; the caller dispatches it to the coding-agent harness
# and parses the JSON object the prompt demands.


def _read_payload(payload_file: IO[str]) -> dict:
    try:
        payload = json.load(payload_file)
    except ValueError as exc:
        raise click.UsageError(f"payload is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise click.UsageError("payload must be a JSON object")
    return payload


def _agent_command(name: str, help_text: str):
    """Shared shape of the three agent subcommands (payload → rendered prompt)."""

    def decorator(renderer):
        @main.command(name, help=help_text)
        @click.option("--payload-file", type=click.File("r", encoding="utf-8"),
                      required=True,
                      help="JSON payload for the agent ('-' for stdin).")
        @click.option("-v", "--verbose", is_flag=True,
                      help="Enable INFO-level logging to stderr.")
        def command(payload_file: IO[str], verbose: bool) -> None:
            _configure_logging(verbose)
            payload = _read_payload(payload_file)
            try:
                click.echo(renderer(payload))
            except ValueError as exc:
                raise click.UsageError(str(exc)) from exc

        command.__name__ = name.replace("-", "_")
        return command

    return decorator


@_agent_command(
    "judge-diff",
    "Print the prompt that audits a fix diff against its issue AND stated "
    "goal/criteria. Payload: {issue, diff, flags?: [..], goal?, "
    "success_criteria?: [..]}. The prompt demands cheat_likelihood, "
    "goal_alignment, criteria_verdicts, scope_drift, concerns, directives.",
)
def _judge_diff_cmd(payload: dict) -> str:
    from goal.agents import render_judge_diff_prompt

    flags = payload.get("flags")
    criteria = payload.get("success_criteria")
    return render_judge_diff_prompt(
        issue=str(payload.get("issue", "")),
        diff=str(payload.get("diff", "")),
        flags=[str(f) for f in flags] if isinstance(flags, list) else None,
        goal=str(payload.get("goal", "")),
        success_criteria=[str(c) for c in criteria] if isinstance(criteria, list) else None,
    )


@_agent_command(
    "author-tests",
    "Print the prompt that authors one test file for a fix episode. Payload: "
    "{approach, issue, symbols, goal?, runtime_evidence?}. The prompt demands "
    "test_code + rationale.",
)
def _author_tests_cmd(payload: dict) -> str:
    from goal.agents import render_author_tests_prompt

    return render_author_tests_prompt(
        approach=str(payload.get("approach", "")),
        issue=str(payload.get("issue", "")),
        symbols=str(payload.get("symbols", "")),
        goal=str(payload.get("goal", "")),
        runtime_evidence=str(payload.get("runtime_evidence", "")),
    )


@_agent_command(
    "judge-stall",
    "Print the explorer/auditor stall-negotiation prompt. Payload: {task, "
    "evidence_a, evidence_b}. The prompt demands the four utilities + mutation.",
)
def _judge_stall_cmd(payload: dict) -> str:
    from goal.agents import render_judge_stall_prompt

    return render_judge_stall_prompt(
        task=str(payload.get("task", "")),
        evidence_a=str(payload.get("evidence_a", "")),
        evidence_b=str(payload.get("evidence_b", "")),
    )


if __name__ == "__main__":
    main()
