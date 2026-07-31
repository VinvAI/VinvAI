"""Which captures a question reads — one service's, or the whole repo's.

Regression cover for a real failure: a repo with four traced services has four
captures, and ``tracesummary`` read only the freshest one.  Whichever service
ran last was the only one whose endpoints could be seen as exercised; the other
three reported ``trace_count: 0``.  When the freshest capture happened to hold
no request matching a consolidated endpoint, NOTHING was exercised anywhere —
which empties the insight manifest, which skips the probe pass, surfacing only
as "no observed endpoints to probe".
"""

from pathlib import Path

import pytest

from identification.runner import (
    _resolve_trace_file,
    _resolve_trace_files,
    _root_span_counts,
)


def write_capture(root: Path, service: str, roots: list[str], mtime: float) -> Path:
    """A capture whose request roots are the given ``METHOD /path`` span names."""
    d = root / ".vinv" / "captures" / "vinv-bringup" / service
    d.mkdir(parents=True, exist_ok=True)
    trace = d / "trace.jsonl"
    lines = [
        '{"component": "%s", "event": "enter", "depth": 0}' % r for r in roots
    ]
    trace.write_text("\n".join(lines) + "\n", encoding="utf-8")
    import os

    os.utime(trace, (mtime, mtime))
    return trace


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    write_capture(tmp_path, "api", ["POST /chat", "GET /"], mtime=1000)
    write_capture(tmp_path, "worker", ["POST /run-agent"], mtime=2000)
    # Newest, and holds nothing that matches a repo endpoint — the exact shape
    # that made the whole pipeline report "nothing exercised".
    write_capture(tmp_path, "ui", ["GET /gradio_api/startup-events"], mtime=3000)
    return tmp_path


def test_single_resolution_still_picks_the_freshest(repo: Path) -> None:
    # tracemap overlays ONE endpoint of ONE service, so "the freshest" stays
    # right for it; only the repo-wide question changed.
    assert _resolve_trace_file(repo, None, None).parent.name == "ui"


def test_repo_wide_resolution_returns_every_capture_newest_first(repo: Path) -> None:
    found = _resolve_trace_files(repo, None, None)
    assert [p.parent.name for p in found] == ["ui", "worker", "api"]


def test_a_named_service_still_narrows_to_its_own_capture(repo: Path) -> None:
    found = _resolve_trace_files(repo, "api", None)
    assert [p.parent.name for p in found] == ["api"]


def test_aggregating_sees_endpoints_the_freshest_capture_alone_misses(repo: Path) -> None:
    from identification.runner import _load_trace_events

    freshest = _root_span_counts(_load_trace_events(_resolve_trace_file(repo, None, None)))
    assert ("POST", "/chat") not in freshest, "the bug: api's endpoints are invisible"

    agg: dict[tuple[str, str], int] = {}
    for p in _resolve_trace_files(repo, None, None):
        for key, n in _root_span_counts(_load_trace_events(p)).items():
            agg[key] = agg.get(key, 0) + n
    assert ("POST", "/chat") in agg
    assert ("POST", "/run-agent") in agg
    assert ("GET", "/") in agg


def write_nested_capture(root: Path, service: str, oracle: str, mtime: float) -> Path:
    """An exerciser capture: `<session>/<slug>/<oracle>/trace.jsonl`, one level deeper."""
    d = root / ".vinv" / "captures" / "vinv-exerciser" / service / oracle
    d.mkdir(parents=True, exist_ok=True)
    trace = d / "trace.jsonl"
    trace.write_text('{"component": "acme.cli.main", "event": "enter", "depth": 0}\n', encoding="utf-8")
    import os

    os.utime(trace, (mtime, mtime))
    return trace


def test_a_service_narrows_onto_its_exerciser_capture_too(repo: Path) -> None:
    # CLI and function units trace into `<slug>/<oracle>/`, so matching only the
    # capture's immediate parent found nothing and fell back to "freshest
    # anywhere" — the CLI unit's overlay was read off whichever service traced
    # last (here `ui`, the newest), and every node came back "not run".
    write_nested_capture(repo, "cli-tool", "invocations", mtime=500)

    chosen = _resolve_trace_file(repo, "cli-tool", None)

    assert chosen.parent.name == "invocations"
    assert chosen.parent.parent.name == "cli-tool"


def test_the_session_directory_is_not_mistaken_for_a_service(repo: Path) -> None:
    # Without excluding the session segment, `--service vinv-bringup` would
    # "match" every capture in the repo and narrow to nothing.
    found = _resolve_trace_files(repo, "vinv-bringup", None)

    assert [p.parent.name for p in found] == ["ui", "worker", "api"]


def test_an_empty_capture_tree_still_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        _resolve_trace_files(tmp_path, None, None)


def test_a_zero_byte_capture_is_not_counted_as_one(tmp_path: Path) -> None:
    d = tmp_path / ".vinv" / "captures" / "vinv-bringup" / "api"
    d.mkdir(parents=True)
    (d / "trace.jsonl").write_text("", encoding="utf-8")
    with pytest.raises(FileNotFoundError):
        _resolve_trace_files(tmp_path, None, None)
