"""Long-horizon context: rolling summary stays under the documented token bound."""

from __future__ import annotations

from exerciser.compaction import (
    MAX_ENDPOINTS,
    TOKEN_BUDGET,
    compact_results,
    estimate_tokens,
    within_budget,
)


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
