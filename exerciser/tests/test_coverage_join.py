"""handler_observed joins against the TRACE first, calltree artifact as fallback.

The audited failure: an endpoint the trace clearly served (probes returning
200s at real latencies) read "handler not observed" because handler_observed
keyed only on the static-tree overlay — a failed static build or a module-path
mismatch silently excluded the endpoint from endpoint-level opportunity
detection. These tests pin the fixed contract:

* the handler symbol appearing in captured spans marks the endpoint observed,
  even when the tracemap join fails entirely;
* the tracemap result stays the fallback (and supplies the handler name when
  the caller does not know it);
* a re-profile over the planted live case (GET /api/v1/items/, p95 ~288ms)
  marks the handler observed.
"""

from __future__ import annotations

import json
from pathlib import Path

from exerciser import coverage as cov_mod
from exerciser import store
from exerciser.coverage import endpoint_coverage, handler_observed_in_trace
from exerciser.profile import build_profile


def _write_trace(repo: Path, components: list[str]) -> None:
    """A minimal tracelens capture whose spans ran the given components."""
    tdir = repo / ".vinv" / "captures" / "session-1" / "app"
    tdir.mkdir(parents=True, exist_ok=True)
    lines = []
    for i, comp in enumerate(components):
        lines.append(
            json.dumps(
                {
                    "event": "enter",
                    "component": comp,
                    "request_id": f"r{i}",
                    "thread_id": 1,
                    "depth": 0,
                }
            )
        )
        lines.append(
            json.dumps(
                {
                    "event": "exit",
                    "component": comp,
                    "request_id": f"r{i}",
                    "thread_id": 1,
                    "depth": 0,
                    "duration_ms": 12.5,
                    "status": "ok",
                }
            )
        )
    (tdir / "trace.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_handler_observed_in_trace_matches_component_suffix(tmp_path):
    _write_trace(tmp_path, ["app.api.routes.items.read_items", "app.core.db.get_session"])
    assert handler_observed_in_trace(tmp_path, "read_items") is True
    assert handler_observed_in_trace(tmp_path, "get_session") is True
    # The dot boundary is required: a symbol that merely ends the same way
    # must not match.
    assert handler_observed_in_trace(tmp_path, "ead_items") is False
    assert handler_observed_in_trace(tmp_path, "delete_item") is False
    assert handler_observed_in_trace(tmp_path, None) is False


def test_handler_observed_without_any_capture_is_false(tmp_path):
    assert handler_observed_in_trace(tmp_path, "read_items") is False


def test_tracemap_failure_still_observes_handler_from_trace(tmp_path, monkeypatch):
    """The planted live case: tracemap fails, but the trace served the handler."""
    _write_trace(tmp_path, ["app.api.routes.items.read_items"])

    def boom(*a, **kw):
        raise RuntimeError("no static tree for this endpoint")

    monkeypatch.setattr(cov_mod, "map_trace_to_tree", boom)
    cov = endpoint_coverage(tmp_path, "GET_api_v1_items_", handler="read_items")
    assert cov["handler_observed"] is True
    assert cov["covered"] == 0  # no static overlay — no symbol claims
    # And with a handler the trace never ran, the verdict stays honest.
    cov2 = endpoint_coverage(tmp_path, "DELETE_api_v1_items_", handler="delete_item")
    assert cov2["handler_observed"] is False


def test_tracemap_false_is_overridden_by_trace_join(tmp_path, monkeypatch):
    """Tracemap built but missed the handler → the trace-primary join wins.

    No `handler=` supplied: the name comes from the tracemap entrypoint
    (the calltree artifact acting as the name fallback).
    """
    _write_trace(tmp_path, ["app.api.routes.items.read_items"])

    def tracemap_missed(*a, **kw):
        return {
            "handler_observed": False,
            "entrypoint": {"handler": "read_items"},
            "tree": {},
            "coverage": {},
        }

    monkeypatch.setattr(cov_mod, "map_trace_to_tree", tracemap_missed)
    cov = endpoint_coverage(tmp_path, "GET_api_v1_items_")
    assert cov["handler_observed"] is True


def test_no_evidence_from_either_join_stays_unobserved(tmp_path, monkeypatch):
    _write_trace(tmp_path, ["app.core.db.get_session"])

    def tracemap_missed(*a, **kw):
        return {
            "handler_observed": False,
            "entrypoint": {"handler": "read_items"},
            "tree": {},
            "coverage": {},
        }

    monkeypatch.setattr(cov_mod, "map_trace_to_tree", tracemap_missed)
    assert endpoint_coverage(tmp_path, "GET_api_v1_items_")["handler_observed"] is False


def test_tracemap_true_needs_no_trace_rescan(tmp_path, monkeypatch):
    """The calltree fallback still stands on its own when the trace scan can't run."""

    def tracemap_hit(*a, **kw):
        return {
            "handler_observed": True,
            "entrypoint": {"handler": "read_items"},
            "tree": {},
            "coverage": {},
        }

    monkeypatch.setattr(cov_mod, "map_trace_to_tree", tracemap_hit)
    # No capture on disk at all — the tracemap verdict is trusted as-is.
    assert endpoint_coverage(tmp_path, "GET_api_v1_items_")["handler_observed"] is True


def test_reprofile_marks_planted_case_observed(tmp_path, monkeypatch):
    """Re-profiling GET /api/v1/items/ after the fix reports the handler observed."""
    repo = tmp_path
    (repo / ".vinv" / "exercise").mkdir(parents=True)
    rows = []
    for i, latency in enumerate([12.0, 30.5, 288.0]):
        rows.append(
            {
                "round": 1,
                "endpoint_id": "GET_api_v1_items_",
                "api_id": "GET_api_v1_items_",
                "method": "GET",
                "path": "/api/v1/items/",
                "handler": "read_items",
                "strategy": "schema_valid",
                "provenance": "schema",
                "input_class": "valid",
                "input": {"body": None, "path_params": {}, "query": {}},
                "expected": "2xx",
                "status": 200,
                "status_class": "2xx-3xx",
                "latency_ms": latency,
                "shape_hash": "json:items",
                "error": None,
                "request_id": None,
                "output_size": 10,
                "input_size": 1,
                "body": {"count": i},
            }
        )
    store.write_jsonl(store.results_path(repo), rows)
    _write_trace(repo, ["app.api.routes.items.read_items"])

    def boom(*a, **kw):
        raise RuntimeError("static overlay unavailable")

    monkeypatch.setattr(cov_mod, "map_trace_to_tree", boom)
    prof = build_profile(repo)
    assert prof["status"] == "ok"
    ep = next(e for e in prof["endpoints"] if e["path"] == "/api/v1/items/")
    assert ep["coverage"]["handler_observed"] is True
    assert ep["latency"]["p95_ms"] > 0


def test_legacy_rows_do_not_pin_handler_to_none(tmp_path, monkeypatch):
    """Append-only results.jsonl spans engine versions: rows written before the
    handler field existed must not pin the join to None when newer rows know it."""
    from exerciser import profile as profile_mod

    seen = {}

    def fake_endpoint_profile(repo, ep_execs, api_id, method, path, handler, **kw):
        seen[api_id] = handler
        return {
            "api_id": api_id,
            "method": method,
            "path": path,
            "handler": handler,
            "latency": {"p50_ms": 1.0, "p95_ms": 2.0},
            "inputs_explored": {},
            "status_distribution": {},
            "status_classes": {},
            "coverage": {
                "covered": 0,
                "total": 0,
                "pct": 0.0,
                "uncovered": [],
                "handler_observed": False,
            },
            "side_effects": [],
            "invariants": [],
        }

    monkeypatch.setattr(profile_mod, "_endpoint_profile", fake_endpoint_profile)
    from exerciser import store

    rows = [
        {"endpoint_id": "GET_x", "method": "GET", "path": "/x", "status": 200, "latency_ms": 1.0},
        {
            "endpoint_id": "GET_x",
            "method": "GET",
            "path": "/x",
            "status": 200,
            "latency_ms": 1.0,
            "handler": "x-read_x",
        },
    ]
    store.append_jsonl(store.results_path(tmp_path), rows)
    profile_mod.build_profile(tmp_path)
    assert seen["GET_x"] == "x-read_x", "the newer row's handler must win over the legacy None"


def test_display_form_handler_normalizes_to_trace_symbol(tmp_path):
    """'items-read_items()' (identification's display form) must match the
    trace component '…routes.items.read_items'."""
    import json as _json
    from exerciser.coverage import handler_observed_in_trace

    cap = tmp_path / ".vinv" / "captures" / "s0" / "app"
    cap.mkdir(parents=True)
    (cap / "trace.jsonl").write_text(
        _json.dumps(
            {
                "event": "enter",
                "component": "app.api.routes.items.read_items",
                "request_id": "R",
                "thread_id": 1,
            }
        )
        + "\n"
    )
    assert handler_observed_in_trace(tmp_path, "items-read_items()", trace=str(cap / "trace.jsonl"))
    assert not handler_observed_in_trace(
        tmp_path, "items-missing()", trace=str(cap / "trace.jsonl")
    )
