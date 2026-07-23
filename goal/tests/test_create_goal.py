"""Tests for the goal CLI and prompt renderers.

Harness-only: the CLI prints rendered prompts (zero LLM calls). These tests
verify the plumbing around rendering — context validation, truncation, CLI
input sources, payload handling for the verification-agent prompts, and that
each rendered prompt carries its inputs and its JSON output contract.
"""

from __future__ import annotations

import json

import pytest
from click.testing import CliRunner

import goal.runner as runner
from goal.agents import (
    render_author_tests_prompt,
    render_judge_diff_prompt,
    render_judge_stall_prompt,
)
from goal.cli import main


# ── runner ───────────────────────────────────────────────────────


def test_render_goal_prompt_carries_context_and_contract():
    out = runner.render_goal_prompt("users report intermittent 502s")

    assert "users report intermittent 502s" in out
    assert '"goal"' in out           # the JSON output contract
    assert '"reasoning"' in out
    assert "imperative" in out       # the distillation instruction


def test_render_goal_prompt_rejects_empty_context():
    with pytest.raises(ValueError, match="context is empty"):
        runner.render_goal_prompt("   \n  ")


def test_prepare_context_truncates_oversized_context():
    text, truncated = runner.prepare_context("x" * (runner.MAX_CONTEXT_CHARS + 500))

    assert truncated is True
    assert len(text) == runner.MAX_CONTEXT_CHARS


def test_prepare_context_keeps_small_context_untouched():
    text, truncated = runner.prepare_context("  small context  ")

    assert truncated is False
    assert text == "small context"


# ── CLI: create ──────────────────────────────────────────────────


def test_cli_create_from_argument():
    result = CliRunner().invoke(main, ["create", "fix the flaky login test"])

    assert result.exit_code == 0, result.output
    assert "fix the flaky login test" in result.output
    assert '"goal"' in result.output


def test_cli_create_from_stdin():
    result = CliRunner().invoke(
        main, ["create", "--context-file", "-"], input="context from stdin"
    )

    assert result.exit_code == 0, result.output
    assert "context from stdin" in result.output


def test_cli_create_from_file(tmp_path):
    ctx = tmp_path / "notes.md"
    ctx.write_text("context from a file", encoding="utf-8")
    result = CliRunner().invoke(main, ["create", "--context-file", str(ctx)])

    assert result.exit_code == 0, result.output
    assert "context from a file" in result.output


def test_cli_requires_exactly_one_context_source(tmp_path):
    ctx = tmp_path / "notes.md"
    ctx.write_text("ctx", encoding="utf-8")

    neither = CliRunner().invoke(main, ["create"])
    both = CliRunner().invoke(main, ["create", "ctx", "--context-file", str(ctx)])

    assert neither.exit_code != 0
    assert "exactly one way" in neither.output
    assert both.exit_code != 0
    assert "exactly one way" in both.output


def test_cli_create_rejects_empty_context():
    result = CliRunner().invoke(main, ["create", "   "])

    assert result.exit_code != 0
    assert "context is empty" in result.output


# ── verification-agent prompt renderers ──────────────────────────


def test_judge_diff_prompt_carries_inputs_and_contract():
    out = render_judge_diff_prompt(
        issue="requests 502 under load",
        diff="--- a/x.py\n+++ b/x.py\n+fix",
        flags=["broad except added"],
        goal="stabilize the API",
        success_criteria=["no 502s in the soak test"],
    )

    assert "requests 502 under load" in out
    assert "+++ b/x.py" in out
    assert "broad except added" in out
    assert "no 502s in the soak test" in out
    assert '"cheat_likelihood"' in out
    assert '"criteria_verdicts"' in out
    assert '"scope_drift"' in out


def test_judge_diff_prompt_requires_issue_and_diff():
    with pytest.raises(ValueError, match="issue and a diff"):
        render_judge_diff_prompt(issue=" ", diff="d")
    with pytest.raises(ValueError, match="issue and a diff"):
        render_judge_diff_prompt(issue="i", diff="")


def test_author_tests_prompt_carries_inputs_and_contract():
    out = render_author_tests_prompt(
        approach="acceptance: must fail on current code",
        issue="off-by-one in pagination",
        symbols="pager.py:42 paginate()",
        runtime_evidence="page_size observed in [10, 100]",
    )

    assert "acceptance: must fail on current code" in out
    assert "off-by-one in pagination" in out
    assert "pager.py:42" in out
    assert "page_size observed in [10, 100]" in out
    assert '"test_code"' in out
    assert '"rationale"' in out


def test_judge_stall_prompt_carries_inputs_and_contract():
    out = render_judge_stall_prompt(
        task="fix the retry storm",
        evidence_a="attempt 1: timeout in fetch()",
        evidence_b="attempt 2: timeout in fetch()",
    )

    assert "fix the retry storm" in out
    assert "attempt 1: timeout in fetch()" in out
    assert '"explorer_continue"' in out
    assert '"mutation"' in out


def test_input_clipping_caps_apply():
    big = "x" * (runner.MAX_CONTEXT_CHARS * 2)
    out = render_judge_diff_prompt(issue=big, diff="d")
    # The issue section is clipped to MAX_ISSUE_CHARS, not passed whole.
    from goal.agents import MAX_ISSUE_CHARS

    assert ("x" * MAX_ISSUE_CHARS) in out
    assert ("x" * (MAX_ISSUE_CHARS + 1)) not in out


# ── CLI: agent subcommands ───────────────────────────────────────


def test_cli_judge_diff_renders_prompt():
    payload = json.dumps({"issue": "the bug", "diff": "the diff"})
    result = CliRunner().invoke(
        main, ["judge-diff", "--payload-file", "-"], input=payload
    )

    assert result.exit_code == 0, result.output
    assert "the bug" in result.output
    assert '"cheat_likelihood"' in result.output


def test_cli_agent_command_rejects_bad_payload():
    result = CliRunner().invoke(
        main, ["judge-stall", "--payload-file", "-"], input="{not json"
    )

    assert result.exit_code != 0
    assert "not valid JSON" in result.output


def test_cli_agent_command_surfaces_missing_fields():
    result = CliRunner().invoke(
        main, ["author-tests", "--payload-file", "-"], input=json.dumps({})
    )

    assert result.exit_code != 0
    assert "approach and an issue" in result.output
