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
from exerciser.invocations import run_invocations, service_invocations
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
    """"14 endpoints" on a repo with none is wrong about the noun, not the number."""
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
                "endpoint": "GET /a", "unit_kind": "http_endpoint", "coverage": "1/1",
                "pct": 100, "p50_ms": 1, "p95_ms": 2, "invariants": 0, "statuses": {},
            },
            {
                "endpoint": "GET /b", "unit_kind": "http_endpoint", "coverage": "1/1",
                "pct": 100, "p50_ms": 1, "p95_ms": 2, "invariants": 0, "statuses": {},
            },
            {
                "endpoint": "RUN acme-tool", "unit_kind": "cli_invocation", "coverage": "0/1",
                "pct": 0, "p50_ms": 9, "p95_ms": 9, "invariants": 0, "statuses": {},
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
