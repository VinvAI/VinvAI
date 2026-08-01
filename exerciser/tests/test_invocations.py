"""Exercising a repo whose Python is CLIs, not servers.

There is no base URL to send anything to, so the invocations the inventory
recorded ARE the traffic. These tests pin the three things that make that
honest: the recorded command actually runs, its spans land like a served
request's, and the verdict comes from the expected exit code rather than from
"non-zero is bad" — a check command that exits 1 on findings is working.
"""

from __future__ import annotations

import json
import sys
import textwrap
from pathlib import Path

from exerciser import store
from exerciser.invocations import (
    expand_invocation,
    resolved_command,
    run_invocations,
    service_invocations,
)
from exerciser.profile import build_profile
from exerciser.scorecard import build_scorecard, render_scorecard_md

_PY = sys.executable


def _repo(tmp_path: Path, services: list[dict]) -> Path:
    repo = tmp_path / "repo"
    (repo / ".vinv").mkdir(parents=True)
    (repo / "acme").mkdir(parents=True)
    (repo / "acme" / "__init__.py").write_text("", encoding="utf-8")
    (repo / "acme" / "tool.py").write_text(
        textwrap.dedent(
            """
            import sys

            def summarize(n: int) -> str:
                return f"rows={n * 2}"

            def main() -> int:
                print(summarize(int(sys.argv[1]) if len(sys.argv) > 1 else 3))
                return int(sys.argv[2]) if len(sys.argv) > 2 else 0

            if __name__ == "__main__":
                sys.exit(main())
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )
    (repo / ".vinv" / "services.json").write_text(
        json.dumps({"services": services}), encoding="utf-8"
    )
    return repo


def _cli_service(repo: Path, invocations: list[dict] | None = None) -> dict:
    svc = {
        "name": "acme-tool",
        "kind": "python_cli",
        "command": f'"{_PY}" -m acme.tool 3',
        "working_directory": str(repo),
        "port": None,
        "modules": ["acme"],
    }
    if invocations is not None:
        svc["invocations"] = invocations
    return svc


def test_a_recorded_invocation_runs_and_is_traced(tmp_path: Path) -> None:
    repo = _repo(tmp_path, [_cli_service(tmp_path / "repo")])

    result = run_invocations(repo)

    assert result["status"] == "ok"
    assert result["invocations"] == 1
    assert result["failures"] == 0
    row = result["rows"][0]
    assert row["unit_kind"] == "cli_invocation"
    assert row["exit_code"] == 0
    assert "rows=6" in row["stdout_tail"], "the CLI's own output was not captured"
    # Spans, from a process that exits — the whole point.
    assert row["trace_lines"] > 0, "the invocation produced no spans"
    captured = Path(row["trace_jsonl"])
    assert captured.is_file()
    assert "acme.tool.summarize" in captured.read_text(encoding="utf-8", errors="replace")


def test_capture_lands_in_the_shared_captures_layout(tmp_path: Path) -> None:
    repo = _repo(tmp_path, [_cli_service(tmp_path / "repo")])

    result = run_invocations(repo)

    captured = Path(result["rows"][0]["trace_jsonl"])
    expected = repo / ".vinv" / "captures" / "vinv-exerciser" / "acme-tool" / "invocations"
    assert captured.parent == expected


def test_each_recorded_invocation_is_its_own_run(tmp_path: Path) -> None:
    repo = _repo(
        tmp_path,
        [
            _cli_service(
                tmp_path / "repo",
                [
                    {"command": f'"{_PY}" -m acme.tool 5', "purpose": "the summarize path"},
                    {"command": f'"{_PY}" -m acme.tool 7', "purpose": "a wider input"},
                ],
            )
        ],
    )

    result = run_invocations(repo)

    assert result["invocations"] == 2
    assert [r["purpose"] for r in result["rows"]] == ["the summarize path", "a wider input"]
    assert "rows=10" in result["rows"][0]["stdout_tail"]
    assert "rows=14" in result["rows"][1]["stdout_tail"]
    # Separate captures, so one invocation's spans stay attributable to it.
    assert len({r["trace_jsonl"] for r in result["rows"]}) == 2


def test_a_documented_nonzero_exit_is_not_a_defect(tmp_path: Path) -> None:
    # A check command that exits 1 on findings is behaving correctly; only a
    # MISMATCH against the recorded expectation is a finding.
    repo = _repo(
        tmp_path,
        [
            _cli_service(
                tmp_path / "repo",
                [{"command": f'"{_PY}" -m acme.tool 3 1', "expect_exit": 1}],
            )
        ],
    )

    result = run_invocations(repo)

    assert result["failures"] == 0
    assert result["issue_clusters"] == 0, "an expected exit code was reported as a defect"
    assert result["rows"][0]["status"] == "ok"


def test_an_unexpected_exit_code_is_a_finding(tmp_path: Path) -> None:
    repo = _repo(
        tmp_path,
        [
            _cli_service(
                tmp_path / "repo",
                [{"command": f'"{_PY}" -m acme.tool 3 2'}],  # expect_exit defaults to 0
            )
        ],
    )

    result = run_invocations(repo)

    assert result["failures"] == 1
    assert result["issue_clusters"] == 1
    row = result["rows"][0]
    assert row["status"] == "error"
    assert "expected 0" in row["error"]


def test_a_repo_with_no_cli_services_says_so(tmp_path: Path) -> None:
    repo = _repo(
        tmp_path,
        [{"name": "api", "kind": "python_web", "command": "x", "port": 8000, "modules": ["acme"]}],
    )

    result = run_invocations(repo)

    assert result["status"] == "environment"
    assert result["invocations"] == 0
    assert "python_cli" in result["diagnostics"][0]


def test_results_are_persisted_for_downstream_readers(tmp_path: Path) -> None:
    repo = _repo(tmp_path, [_cli_service(tmp_path / "repo")])

    run_invocations(repo)

    rows_file = store.exercise_dir(repo) / "invocation_results.jsonl"
    summary = store.read_json(store.exercise_dir(repo) / "invocations.json")
    assert rows_file.is_file() and rows_file.read_text(encoding="utf-8").strip()
    assert summary["invocations"] == 1


def test_a_cli_only_repo_can_be_profiled(tmp_path: Path) -> None:
    """A repo with no endpoints was previously unprofilable.

    `build_profile` read only results.jsonl, so a toolchain returned
    "no results.jsonl — run `exerciser run` first" no matter how much of it had
    actually been driven, and every view downstream of the profile stayed empty.
    """
    repo = _repo(tmp_path, [_cli_service(tmp_path / "repo")])
    run_invocations(repo)

    profile = build_profile(repo)

    assert profile["status"] == "ok", profile.get("error")
    assert profile["endpoint_count"] == 1
    unit = profile["endpoints"][0]
    # Tagged, so a driven CLI is never silently pooled with a served request.
    assert unit["unit_kind"] == "cli_invocation"
    assert unit["method"] == "RUN"


def test_profile_still_reports_when_nothing_has_been_exercised(tmp_path: Path) -> None:
    repo = _repo(tmp_path, [_cli_service(tmp_path / "repo")])

    profile = build_profile(repo)

    assert profile["status"] == "error"
    # The message must name every oracle, not just the HTTP one.
    assert "invocations" in profile["error"] and "functions" in profile["error"]


def test_the_scorecard_counts_units_by_kind_and_names_them(tmp_path: Path) -> None:
    """ "14 endpoints" on a repo with none is wrong about the noun, not the number."""
    repo = _repo(tmp_path, [_cli_service(tmp_path / "repo")])
    run_invocations(repo)
    build_profile(repo)

    sc = build_scorecard(repo)
    md = render_scorecard_md(sc)

    assert sc["coverage"]["after_exercised"]["units_by_kind"] == {"cli_invocation": 1}
    assert sc["endpoints"][0]["unit_kind"] == "cli_invocation"
    assert "CLI invocations with coverage" in md
    assert "endpoints with coverage" not in md


def test_a_mixed_repo_gets_the_neutral_noun_and_a_breakdown() -> None:
    # Neither "endpoints" nor "CLI invocations" is right for a mix, and "units"
    # is what the word was always standing in for.
    sc = {
        "service": "mixed",
        "input_source": "openapi",
        "coverage": {
            "before_traffic_only": {"exercised": 1, "total": 3},
            "after_exercised": {
                "endpoints_with_coverage": 2,
                "endpoints_total": 3,
                "symbols_covered": 5,
                "symbols_total": 9,
                "units_by_kind": {"cli_invocation": 1, "http_endpoint": 2},
            },
        },
        "invariants_learned": 0,
        "issue_clusters": 0,
        "issues": [],
        "endpoints": [
            {
                "endpoint": "GET /a",
                "unit_kind": "http_endpoint",
                "coverage": "1/1",
                "pct": 100,
                "p50_ms": 1,
                "p95_ms": 2,
                "invariants": 0,
                "statuses": {},
            },
            {
                "endpoint": "GET /b",
                "unit_kind": "http_endpoint",
                "coverage": "1/1",
                "pct": 100,
                "p50_ms": 1,
                "p95_ms": 2,
                "invariants": 0,
                "statuses": {},
            },
            {
                "endpoint": "RUN acme-tool",
                "unit_kind": "cli_invocation",
                "coverage": "0/1",
                "pct": 0,
                "p50_ms": 9,
                "p95_ms": 9,
                "invariants": 0,
                "statuses": {},
            },
        ],
    }

    md = render_scorecard_md(sc)

    assert "units with coverage" in md
    assert "Breakdown:" in md
    assert "**1** CLI invocation" in md and "**2** endpoints" in md


def test_a_library_falls_back_to_the_function_driver(tmp_path: Path) -> None:
    # A library has no command by definition; the driver is what runs it, and
    # that must be derived rather than fabricated.
    repo = tmp_path / "repo"
    entries = service_invocations(
        {"name": "acme-sdk", "kind": "python_library", "modules": ["acme"]}, repo
    )
    assert len(entries) == 1
    assert "functions" in entries[0]["command"]
    assert "acme-sdk" in entries[0]["command"]
    assert entries[0]["expect_exit"] == 0


def test_a_librarys_entry_points_are_reachable_one_at_a_time(tmp_path: Path) -> None:
    """The `{only}` slot is what makes a library's many entry points selectable.

    A library used to be all-or-nothing: the driver ran every exported callable
    or none. That is right for the exercise pass and useless at the Run button,
    where the question is "run THIS function".
    """
    entry = service_invocations(
        {"name": "acme-sdk", "kind": "python_library", "modules": ["acme"]}, tmp_path / "repo"
    )[0]

    # Blank (the default) keeps today's behaviour exactly: drive everything, with
    # no stray flag left behind.
    assert "--only-target" not in resolved_command(entry)
    assert resolved_command(entry).rstrip().endswith("--service acme-sdk")
    # Filled, it drives one callable — through the driver's real option, so the
    # rendered string is a command that actually parses.
    assert resolved_command(entry, {"only": "acme.tool:summarize"}).endswith(
        "--only-target acme.tool:summarize"
    )


def test_the_library_slot_names_an_option_the_driver_really_has() -> None:
    """The rendered flag must be one `vinv-exerciser functions` accepts.

    A `render` template is just a string; nothing type-checks it against the CLI
    it will be handed to. Getting it wrong produces a command that fails with "no
    such option" only when a human finally clicks Run — long after the record was
    written and marked verified.
    """
    from exerciser.cli import functions_cmd

    options = {opt for param in functions_cmd.params for opt in getattr(param, "opts", [])}
    assert "--only-target" in options


def test_unit_ids_survive_an_invocation_being_inserted(tmp_path: Path) -> None:
    """Ids key findings, coverage and history across runs — so never positional.

    With `service#index`, adding an invocation at the front silently renamed
    every later unit: the same command came back as a different unit, its history
    orphaned and its findings re-reported as new.
    """
    before = service_invocations(
        _cli_service(
            tmp_path / "repo",
            [
                {"command": "acme-tool report --since 7d"},
                {"command": "acme-tool check ./sample"},
            ],
        ),
        tmp_path / "repo",
    )
    after = service_invocations(
        _cli_service(
            tmp_path / "repo",
            [
                {"command": "acme-tool migrate"},
                {"command": "acme-tool report --since 7d"},
                {"command": "acme-tool check ./sample"},
            ],
        ),
        tmp_path / "repo",
    )

    assert [e["id"] for e in before] == ["report", "check"]
    # `report` and `check` keep their identity despite moving down the list.
    assert [e["id"] for e in after] == ["migrate", "report", "check"]


def test_an_explicit_id_wins_and_collisions_are_disambiguated(tmp_path: Path) -> None:
    entries = service_invocations(
        _cli_service(
            tmp_path / "repo",
            [
                {"id": "weekly", "command": "acme-tool report --since 7d"},
                {"command": "acme-tool report --since 30d"},
                {"command": "acme-tool report --since 90d"},
            ],
        ),
        tmp_path / "repo",
    )
    assert [e["id"] for e in entries] == ["weekly", "report", "report-2"]


def test_an_argument_edit_does_not_rename_the_unit(tmp_path: Path) -> None:
    # The id comes from the subcommand precisely so that tuning an argument —
    # the most common edit there is — keeps the unit's history intact.
    def ids(since: str) -> list[str]:
        return [
            e["id"]
            for e in service_invocations(
                _cli_service(tmp_path / "repo", [{"command": f"acme-tool report --since {since}"}]),
                tmp_path / "repo",
            )
        ]

    assert ids("7d") == ids("90d") == ["report"]


def test_variants_come_only_from_values_the_repo_enumerated() -> None:
    """This oracle EXECUTES what it builds, so it never invents argv.

    An invented HTTP body meets a running service's validation layer; an invented
    argv meets the user's shell. `--force` and `--delete` are flags too, and
    nothing in the schema distinguishes them from `--verbose`.
    """
    enumerated = expand_invocation(
        {
            "id": "report",
            "command": "acme-tool report --format {format}",
            "params": [
                {"name": "format", "type": "enum", "default": "json", "choices": ["json", "csv"]}
            ],
        }
    )
    assert [v["input_class"] for v in enumerated] == ["declared", "generated"]
    assert enumerated[0]["args"] == {"format": "json"}
    assert enumerated[1]["args"] == {"format": "csv"}

    # A free-form parameter with nothing enumerated yields the declared row only.
    freeform = expand_invocation(
        {
            "id": "scan",
            "command": "acme-tool scan {root}",
            "params": [{"name": "root", "type": "path", "default": "."}],
        }
    )
    assert len(freeform) == 1

    # And a bare flag is never flipped on the oracle's own initiative.
    flag = expand_invocation(
        {
            "id": "clean",
            "command": "acme-tool clean {force}",
            "params": [{"name": "force", "type": "flag", "default": "false"}],
        }
    )
    assert len(flag) == 1


def test_variants_change_one_parameter_at_a_time() -> None:
    # Never a cartesian product: the count stays linear in the parameters, and a
    # failing row names the one parameter that caused it.
    variants = expand_invocation(
        {
            "id": "report",
            "command": "acme-tool report --format {format} --scope {scope}",
            "params": [
                {"name": "format", "type": "enum", "default": "json", "choices": ["json", "csv"]},
                {"name": "scope", "type": "enum", "default": "all", "choices": ["all", "recent"]},
            ],
        }
    )
    assert len(variants) == 3
    assert variants[1]["args"] == {"format": "csv", "scope": "all"}
    assert variants[2]["args"] == {"format": "json", "scope": "recent"}


def test_a_parameterless_command_is_run_verbatim() -> None:
    # A recorded command may legitimately contain a literal brace; only an
    # invocation that DECLARES parameters opts into templating.
    literal = {"id": "fmt", "command": "acme-tool fmt --template '{name}'"}
    assert resolved_command(literal) == "acme-tool fmt --template '{name}'"


def test_a_parameterized_invocation_runs_every_enumerated_value(tmp_path: Path) -> None:
    repo = _repo(
        tmp_path,
        [
            _cli_service(
                tmp_path / "repo",
                [
                    {
                        "id": "summarize",
                        "command": f'"{_PY}" -m acme.tool {{rows}}',
                        "params": [
                            {"name": "rows", "type": "int", "default": "3", "examples": ["5"]}
                        ],
                    }
                ],
            )
        ],
    )

    result = run_invocations(repo)

    assert result["invocations"] == 2, "the enumerated example was not run"
    assert [r["input_class"] for r in result["rows"]] == ["declared", "generated"]
    # One unit, two inputs — exactly as many requests share one HTTP endpoint.
    assert {r["unit_id"] for r in result["rows"]} == {"acme-tool#summarize"}
    assert "rows=6" in result["rows"][0]["stdout_tail"]
    assert "rows=10" in result["rows"][1]["stdout_tail"]
    # Separate captures, so a variant's spans stay attributable to it.
    assert len({r["trace_jsonl"] for r in result["rows"]}) == 2


def test_a_template_that_cannot_be_filled_is_reported_not_run(tmp_path: Path) -> None:
    # A malformed record is a defect in the inventory, not in the tool under
    # test — so it is reported against the unit rather than shelling out to
    # something nobody described.
    repo = _repo(
        tmp_path,
        [
            _cli_service(
                tmp_path / "repo",
                [
                    {
                        "id": "broken",
                        "command": f'"{_PY}" -m acme.tool {{rows}}',
                        "params": [{"name": "other", "default": "1"}],
                    }
                ],
            )
        ],
    )

    result = run_invocations(repo)

    row = result["rows"][0]
    assert row["status"] == "error"
    assert row["error_type"] == "MalformedInvocation"
    assert "no such parameter" in row["error"]
    assert result["failures"] == 1
