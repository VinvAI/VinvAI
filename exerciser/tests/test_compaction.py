"""Long-horizon context: rolling summary token bound + generation compaction."""

from __future__ import annotations

from exerciser import store
from exerciser.compaction import (
    MAX_ENDPOINTS,
    TOKEN_BUDGET,
    compact_artifacts,
    compact_results,
    compact_state_ledger,
    compaction_summary_path,
    decayed_compact,
    estimate_tokens,
    within_budget,
)
from exerciser.state import ledger_path


def _execs(n_endpoints, rounds):
    out = []
    for r in range(rounds):
        for e in range(n_endpoints):
            out.append({
                "endpoint_id": f"EP_{e}", "method": "GET", "path": f"/e{e}",
                "status": 200 if r % 2 else 500, "round": r,
            })
    return out


def test_latest_per_endpoint_wins():
    execs = _execs(3, 4)
    summary = compact_results(execs)
    # 3 endpoints → at most 3 data lines regardless of 4 rounds.
    data_lines = [ln for ln in summary.splitlines() if ln.startswith("GET")]
    assert len(data_lines) == 3


def test_long_run_stays_under_token_budget():
    # A big many-endpoint many-round run.
    execs = _execs(200, 30)
    cov = [{"api_id": f"EP_{e}", "covered": 1, "total": 4, "uncovered": ["a", "b", "c"]}
           for e in range(200)]
    summary = compact_results(execs, cov)
    assert within_budget(summary, TOKEN_BUDGET)
    assert estimate_tokens(summary) <= TOKEN_BUDGET
    data_lines = [ln for ln in summary.splitlines() if ln.startswith("GET")]
    assert len(data_lines) <= MAX_ENDPOINTS


def test_gap_endpoints_lead():
    execs = _execs(2, 1)
    cov = [
        {"api_id": "EP_0", "covered": 4, "total": 4, "uncovered": []},
        {"api_id": "EP_1", "covered": 0, "total": 4, "uncovered": ["x", "y"]},
    ]
    summary = compact_results(execs, cov)
    lines = [ln for ln in summary.splitlines() if ln.startswith("GET")]
    # The bigger-gap endpoint (EP_1, /e1) leads.
    assert "/e1" in lines[0]


# ---- generation compaction ---------------------------------------------------

def _result_row(endpoint="EP_0", strategy="schema_valid", body=None, round_no=0):
    return {
        "endpoint_id": endpoint, "method": "GET", "path": "/e0",
        "strategy": strategy, "round": round_no, "status": 200,
        "input": {"body": body, "path_params": {}, "query": {}},
    }


def test_decayed_compact_keeps_newest_per_key_and_bounds_history():
    # 40 generations of the SAME (endpoint, strategy, input) — expected
    # retained history at 50%/generation decay is ~1 row, newest always kept.
    rows = [_result_row(round_no=r) for r in range(40)]
    kept, dropped = decayed_compact(rows, lambda r: "k")
    assert kept[-1]["round"] == 39, "the newest generation always survives"
    assert dropped > 0
    assert len(kept) < 10, "history is a decayed sample, not the full log"


def test_decayed_compact_is_idempotent():
    rows = [_result_row(strategy=s, round_no=r)
            for s in ("schema_valid", "observed") for r in range(30)]
    kept1, dropped1 = decayed_compact(rows, lambda r: r["strategy"])
    kept2, dropped2 = decayed_compact(kept1, lambda r: r["strategy"])
    assert dropped1 > 0
    assert dropped2 == 0 and kept2 == kept1, "a second pass must drop nothing"


def test_decayed_compact_distinct_keys_all_survive():
    rows = [_result_row(endpoint=f"EP_{i}") for i in range(20)]
    kept, dropped = decayed_compact(
        rows, lambda r: r["endpoint_id"],
    )
    assert dropped == 0 and len(kept) == 20


def test_state_ledger_drops_cleaned_and_vanished_endpoints():
    rows = [
        {"endpoint_id": "POST_a", "planted": ["x@y.test"], "cleaned": True},
        {"endpoint_id": "POST_gone", "planted": ["z@y.test"], "cleaned": False},
        {"endpoint_id": "POST_a", "planted": ["kept@y.test"], "cleaned": False},
        {"planted": ["legacy@y.test"], "cleaned": False},  # no id — keep
    ]
    kept, dropped = compact_state_ledger(rows, {"POST_a"})
    assert dropped == 2
    assert [r.get("planted") for r in kept] == [["kept@y.test"], ["legacy@y.test"]]


def test_compact_artifacts_end_to_end_idempotent_and_loud(tmp_path):
    # Unbounded logs from many runs.
    store.write_jsonl(store.results_path(tmp_path),
                      [_result_row(round_no=r) for r in range(50)])
    store.write_jsonl(ledger_path(tmp_path), [
        {"endpoint_id": "EP_0", "planted": ["a@b.test"], "cleaned": True},
        {"endpoint_id": "EP_gone", "planted": ["c@d.test"], "cleaned": False},
        {"endpoint_id": "EP_0", "planted": ["e@f.test"], "cleaned": False},
    ])
    store.write_jsonl(store.exercise_dir(tmp_path) / "optimize.jsonl",
                      [{"label": "GET /slow", "action": "revert-and-retry", "at": i}
                       for i in range(30)])
    store.write_jsonl(store.exercise_dir(tmp_path) / "regress.jsonl",
                      [{"cases": 5, "at": i} for i in range(30)])
    plan = {"endpoints": [{"api_id": "EP_0"}]}

    first = compact_artifacts(tmp_path, plan)
    assert first["total_dropped"] > 0
    # Newest survives everywhere.
    results = store.read_jsonl(store.results_path(tmp_path))
    assert results[-1]["round"] == 49
    ledger = store.read_jsonl(ledger_path(tmp_path))
    assert [r["planted"] for r in ledger] == [["e@f.test"]]
    opt = store.read_jsonl(store.exercise_dir(tmp_path) / "optimize.jsonl")
    assert opt[-1]["at"] == 29 and len(opt) < 30
    reg = store.read_jsonl(store.exercise_dir(tmp_path) / "regress.jsonl")
    assert reg[-1]["at"] == 29 and len(reg) < 30
    # Loud one-line artifact of what was dropped.
    summary = compaction_summary_path(tmp_path).read_text(encoding="utf-8")
    assert summary.count("\n") == 1 and summary.startswith("compaction @")
    assert "results.jsonl" in summary and "state_ledger.jsonl" in summary
    # Idempotent: a second run at the same generation drops nothing.
    second = compact_artifacts(tmp_path, plan)
    assert second["total_dropped"] == 0
    assert store.read_jsonl(store.results_path(tmp_path)) == results
