"""Where the start prompt gets the launch command from.

The gap these cover, observed end to end: Stage 2a records a ``command`` per
service in ``services.json``, and ``render_start_prompt`` never forwarded it. The
agent therefore inferred the launch command from handbook prose; when that failed,
the extension asked the operator, and the operator typed a string byte-identical
to the one already on disk — in the same dict the prompt builder was already
reading for ``modules``.

Resolution order, most authoritative first: explicit ``start_hint`` → the
operator's recorded answer → discovery's recorded command.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bringup.runner import _discovered_command, render_start_prompt

_COMMAND = "python -m uvicorn examples.async_agent.main:app --host 0.0.0.0 --port 8000"


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    vinv = tmp_path / ".vinv"
    vinv.mkdir()
    (vinv / "vinv.md").write_text("# Handbook\n\nSome prose.\n", encoding="utf-8")
    (vinv / "services.json").write_text(
        json.dumps(
            {
                "services": [
                    {
                        "name": "api",
                        "kind": "python_web",
                        "command": _COMMAND,
                        "working_directory": str(tmp_path),
                        "port": 8000,
                        "modules": ["smolagents"],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    return tmp_path


def write_hint(repo: Path, command: str) -> None:
    d = repo / ".vinv" / "start_hints"
    d.mkdir(parents=True, exist_ok=True)
    (d / "api.json").write_text(
        json.dumps({"service": "api", "command": command, "source": "operator"}),
        encoding="utf-8",
    )


class TestDiscoveredCommand:
    def test_it_reads_the_command_stage_2a_recorded(self, repo: Path) -> None:
        assert _discovered_command(repo, "api") == _COMMAND

    def test_an_unknown_service_has_none(self, repo: Path) -> None:
        assert _discovered_command(repo, "nope") is None

    def test_a_missing_inventory_is_not_an_error(self, tmp_path: Path) -> None:
        # _read_services raises by design; a bring-up that would have run without
        # a command must still run.
        assert _discovered_command(tmp_path, "api") is None

    def test_a_blank_command_is_no_command(self, repo: Path) -> None:
        path = repo / ".vinv" / "services.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["services"][0]["command"] = "   "
        path.write_text(json.dumps(data), encoding="utf-8")
        assert _discovered_command(repo, "api") is None

    def test_a_module_colon_form_is_refused_not_laundered(self, repo: Path) -> None:
        # `-m module:attr` can never run — `-m` takes a module, `module:attr` is
        # uvicorn's app-factory syntax. The inventory is agent-written, so it
        # carries that risk; forwarding it would only launder the mistake.
        path = repo / ".vinv" / "services.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["services"][0]["command"] = "python -m examples.async_agent.main:app --port 8000"
        path.write_text(json.dumps(data), encoding="utf-8")
        assert _discovered_command(repo, "api") is None


class TestPromptResolution:
    def test_the_discovered_command_reaches_the_prompt(self, repo: Path) -> None:
        prompt = render_start_prompt(repo, service="api")
        assert _COMMAND in prompt
        assert "DISCOVERY RECORDED A LAUNCH COMMAND" in prompt

    def test_the_operator_still_wins_when_they_have_answered(self, repo: Path) -> None:
        # They may know discovery got it wrong, so their answer outranks it — and
        # only theirs may claim a human said so.
        write_hint(repo, "make run-api")
        prompt = render_start_prompt(repo, service="api")
        assert "make run-api" in prompt
        assert "THE OPERATOR TOLD US" in prompt
        assert "DISCOVERY RECORDED A LAUNCH COMMAND" not in prompt

    def test_an_explicit_hint_outranks_both(self, repo: Path) -> None:
        write_hint(repo, "make run-api")
        prompt = render_start_prompt(repo, service="api", start_hint="just dev")
        assert "just dev" in prompt
        assert "make run-api" not in prompt

    def test_the_discovered_block_does_not_claim_a_human_said_it(self, repo: Path) -> None:
        # Overstating provenance tells the agent to stop thinking about a value
        # that was itself derived — and discovery wrote the handbook too, so this
        # cannot "beat" it.
        prompt = render_start_prompt(repo, service="api")
        assert "The human who owns this repo" not in prompt
        assert "authoritative answer" not in prompt
        assert "not an authority" in prompt

    def test_no_command_and_no_hint_leaves_the_prompt_alone(self, tmp_path: Path) -> None:
        vinv = tmp_path / ".vinv"
        vinv.mkdir()
        (vinv / "vinv.md").write_text("# Handbook\n", encoding="utf-8")
        (vinv / "services.json").write_text(
            json.dumps({"services": [{"name": "api", "kind": "python_web", "modules": []}]}),
            encoding="utf-8",
        )
        prompt = render_start_prompt(tmp_path, service="api")
        assert "DISCOVERY RECORDED A LAUNCH COMMAND" not in prompt
        assert "THE OPERATOR TOLD US" not in prompt

    def test_the_deliverable_contract_survives_either_block(self, repo: Path) -> None:
        # A launch command is not a licence to skip tracing.
        for hint in (None, "make run-api"):
            if hint:
                write_hint(repo, hint)
            prompt = render_start_prompt(repo, service="api")
            assert "--target-package" in prompt
            assert "verified" in prompt
