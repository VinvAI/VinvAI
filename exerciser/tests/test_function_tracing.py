"""Driving a library must produce spans, not just rows.

A repo with no service has nothing to send traffic to, so the function driver
IS its traffic. The worker docstring named itself "the natural place for
tracelens to attach" long before anything attached there, and a run that calls
two hundred functions while recording no spans looks identical, from every
downstream view, to a repo nobody ever exercised.

These tests pin the attachment end-to-end (a real library, a real tracelens, a
real capture on disk) and the argv transform in isolation.
"""

from __future__ import annotations

import json
import re
import textwrap
from pathlib import Path

from exerciser import tracing
from exerciser.functions import run_functions


def _write(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(body).strip() + "\n", encoding="utf-8")


def _index(repo: Path) -> None:
    """The minimal code index ``discover_targets`` reads."""
    chunks = []
    for path in sorted(repo.rglob("*.py")):
        rel = path.relative_to(repo).as_posix()
        if ".vinv/" in rel:
            continue
        body = path.read_text(encoding="utf-8")
        for found in re.finditer(r"^(?:async )?def (\w+)", body, re.MULTILINE):
            chunks.append(
                {
                    "id": f"{rel}:{found.group(1)}",
                    "file": rel,
                    "lang": "python",
                    "kind": "function",
                    "name": found.group(1),
                    "start_line": 1,
                    "end_line": 2,
                    "parent": None,
                }
            )
    index = repo / ".vinv" / "index"
    index.mkdir(parents=True, exist_ok=True)
    (index / "chunks.jsonl").write_text(
        "".join(json.dumps(c) + "\n" for c in chunks), encoding="utf-8"
    )


def _library_repo(tmp_path: Path) -> Path:
    """A pure library: an importable package, no entrypoint, no server."""
    repo = tmp_path / "repo"
    (repo / "acme").mkdir(parents=True)
    _write(repo / "pyproject.toml", '[project]\nname = "acme"\nversion = "0.1"')
    (repo / "acme" / "__init__.py").write_text("", encoding="utf-8")
    _write(
        repo / "acme" / "mod.py",
        """
        def double(n: int) -> int:
            return n * 2

        def shout(text: str) -> str:
            return text.upper()
        """,
    )
    _index(repo)
    return repo


# ── End to end ────────────────────────────────────────────────────


def test_driving_a_library_captures_spans(tmp_path: Path) -> None:
    repo = _library_repo(tmp_path)

    result = run_functions(repo, service="acme", explore=False)

    assert result["calls"] > 0, "the library was never driven"
    trace = result["trace"]
    assert trace["traced"] is True, trace.get("reason")
    captured = Path(trace["trace_jsonl"])
    assert captured.is_file() and captured.stat().st_size > 0
    # The capture belongs to the driven library, not to the driver.
    assert trace["target_packages"] == ["acme"]

    rows = []
    for line in captured.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:  # tracelens header/diagnostic lines
            continue
    components = {r.get("component") for r in rows}
    assert "acme.mod.double" in components, f"no span for the driven function: {components}"
    # Function-level spans, not just framework envelopes: an `enter` event
    # carrying the argument the generator chose is the same shape HTTP traffic
    # produces, which is what lets one downstream reader serve both.
    entered = [r for r in rows if r.get("component") == "acme.mod.double" and r.get("event") == "enter"]
    assert entered and "n" in entered[0]["args_summary"]


def test_capture_lands_in_the_shared_captures_layout(tmp_path: Path) -> None:
    # Everything downstream globs `.vinv/captures/<session>/<slug>/`; a second
    # convention here would simply not be found.
    repo = _library_repo(tmp_path)

    result = run_functions(repo, service="acme", explore=False)

    captured = Path(result["trace"]["trace_jsonl"])
    assert captured.name == "trace.jsonl"
    assert captured.parent == repo / ".vinv" / "captures" / "vinv-exerciser" / "acme" / "functions"
    # Per-module parts survive alongside the merge, so one module's spans stay
    # attributable to that module.
    parts = [p for p in captured.parent.glob("*.trace.jsonl") if p.name != "trace.jsonl"]
    assert parts, "per-module captures were not kept"


def test_no_trace_still_drives_every_target(tmp_path: Path) -> None:
    repo = _library_repo(tmp_path)

    result = run_functions(repo, service="acme", explore=False, trace=False)

    assert result["calls"] > 0, "--no-trace must not stop the driver"
    assert result["trace"]["traced"] is False
    assert "trace_jsonl" not in result["trace"]


# ── The argv transform ────────────────────────────────────────────


def test_wrap_names_the_target_package_and_an_output(tmp_path: Path) -> None:
    argv = ["python", "-m", "exerciser.functions", "--worker"]
    out = tmp_path / "cap" / "trace.jsonl"

    wrapped = tracing.tracelens_wrap(argv, target_packages=["acme"], output=out)

    assert wrapped[-len(argv):] == argv, "the worker argv must survive intact after `--`"
    assert wrapped[-len(argv) - 1] == "--"
    assert "--target-package" in wrapped and "acme" in wrapped
    assert str(out) in wrapped
    assert out.parent.is_dir(), "the capture directory must exist before the worker runs"


def test_wrap_is_a_noop_without_a_usable_target_package(tmp_path: Path) -> None:
    # Wrapping to instrument nothing buys a launcher and no spans, so don't.
    argv = ["python", "-m", "exerciser.functions"]
    out = tmp_path / "trace.jsonl"
    assert tracing.tracelens_wrap(argv, target_packages=[], output=out) == argv
    assert tracing.tracelens_wrap(argv, target_packages=["not-an-identifier"], output=out) == argv


def test_status_explains_an_untraceable_run() -> None:
    status = tracing.trace_status([])
    assert status["traced"] is False
    assert "target-package" in status["reason"] or "--target-package" in status["reason"]


def test_merge_concatenates_parts_and_survives_a_missing_final_newline(
    tmp_path: Path,
) -> None:
    (tmp_path / "a.trace.jsonl").write_text('{"n":1}\n{"n":2}', encoding="utf-8")
    (tmp_path / "b.trace.jsonl").write_text('{"n":3}\n', encoding="utf-8")
    (tmp_path / "empty.trace.jsonl").write_text("", encoding="utf-8")

    merged = tracing.merge_traces(tmp_path)

    assert merged is not None and merged.name == "trace.jsonl"
    rows = [json.loads(line) for line in merged.read_text(encoding="utf-8").splitlines() if line]
    assert [r["n"] for r in rows] == [1, 2, 3], "a part's last row was spliced away"


def test_merge_returns_none_when_nothing_was_captured(tmp_path: Path) -> None:
    assert tracing.merge_traces(tmp_path) is None
