"""Branch-arm reward join: tracelens branch_hits lines → covered_ids.

G3: with function-entry coverage the bandit's "newly covered" reward saturates
after one call per function. Branch arms keep it moving; these tests pin the
attribution rules (request-id credited, unattributed credited, foreign requests
not credited) and the fallback path (branches reward even when the static
overlay cannot be built).
"""

from __future__ import annotations

import json
from pathlib import Path

from exerciser import coverage as cov_mod
from exerciser.coverage import branch_ids_for_endpoint, endpoint_coverage


def _write_trace(repo: Path, lines: list[dict]) -> Path:
    d = repo / ".vinv" / "captures" / "session-1" / "app"
    d.mkdir(parents=True, exist_ok=True)
    p = d / "trace.jsonl"
    p.write_text("".join(json.dumps(ln) + "\n" for ln in lines), encoding="utf-8")
    return p


def _enter(component: str, rid: str) -> dict:
    return {
        "ts": "2026-07-27T00:00:00.000Z",
        "request_id": rid,
        "component": component,
        "event": "enter",
        "level": "INFO",
        "depth": 0,
        "parent_component": None,
        "thread_id": 1,
    }


def _branches(hits: list[tuple[str, int, int, int, str | None]]) -> dict:
    return {
        "event": "branch_hits",
        "ts": "2026-07-27T00:00:01Z",
        "hits": [
            {"file": f, "line": ln, "src": s, "dst": d, "request_id": rid}
            for f, ln, s, d, rid in hits
        ],
    }


def test_branch_arms_attribute_by_request_id(tmp_path: Path) -> None:
    _write_trace(
        tmp_path,
        [
            _enter("app.api.read_items", "req-1"),
            _enter("app.api.other_handler", "req-2"),
            _branches(
                [
                    ("/src/app/api.py", 10, 0, 12, "req-1"),  # ours
                    ("/src/app/api.py", 20, 0, 24, "req-2"),  # another endpoint's
                    ("/src/app/boot.py", 3, 0, 8, None),  # unattributed infra
                ]
            ),
        ],
    )

    ids = branch_ids_for_endpoint(tmp_path, "read_items")

    assert "/src/app/api.py:10:0->12" in ids
    assert "/src/app/boot.py:3:0->8" in ids, "unattributed hits still reward"
    assert "/src/app/api.py:20:0->24" not in ids, "foreign requests do not credit us"


def test_display_form_handler_normalises(tmp_path: Path) -> None:
    _write_trace(
        tmp_path,
        [
            _enter("app.api.read_items", "req-1"),
            _branches([("/src/app/api.py", 10, 0, 12, "req-1")]),
        ],
    )
    assert branch_ids_for_endpoint(tmp_path, "items-read_items()")


def test_no_capture_degrades_to_empty(tmp_path: Path) -> None:
    assert branch_ids_for_endpoint(tmp_path, "read_items") == set()


def test_fallback_coverage_still_rewards_branches(tmp_path: Path, monkeypatch) -> None:
    # The static overlay fails (no index) but the trace carries branch evidence:
    # covered_ids must still grow so the reward keeps moving.
    _write_trace(
        tmp_path,
        [
            _enter("app.api.read_items", "req-1"),
            _branches([("/src/app/api.py", 10, 0, 12, "req-1")]),
        ],
    )
    monkeypatch.setattr(
        cov_mod,
        "map_trace_to_tree",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no index")),
    )

    out = endpoint_coverage(tmp_path, "GET_items", handler="read_items")

    assert out["covered"] == 0, "symbol display counts stay honest"
    assert out["branch_arms"] == 1
    assert "/src/app/api.py:10:0->12" in out["covered_ids"]
