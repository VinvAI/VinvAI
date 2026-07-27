"""USL fit, concurrency sweep, and the throughput-ceiling emission."""

from __future__ import annotations

import json
import math
import random

from click.testing import CliRunner

from exerciser import cli, store
from exerciser.execute import ProbeResult
from exerciser.optimize import DEFAULT_USL_MIN_R2, detect_opportunities, policy_path
from exerciser.throughput import (
    ThroughputResult,
    pick_sweep_endpoint,
    run_sweep,
    sweep_path,
)
from exerciser.usl import fit_usl


def _usl(n: float, lam: float, sigma: float, kappa: float) -> float:
    return lam * n / (1.0 + sigma * (n - 1.0) + kappa * n * (n - 1.0))


# ---- fitting -----------------------------------------------------------------


def test_fit_recovers_known_parameters_under_noise():
    lam, sigma, kappa = 120.0, 0.06, 0.002  # true knee ≈ 21.7, inside the sweep
    rng = random.Random(42)
    pts = [
        (n, _usl(n, lam, sigma, kappa) * (1.0 + rng.uniform(-0.01, 0.01)))
        for n in (1, 2, 4, 6, 8, 12, 16, 20, 24, 28, 32)
    ]
    fit = fit_usl(pts)
    assert fit is not None
    assert abs(fit.sigma - sigma) < 0.03
    assert abs(fit.kappa - kappa) < 0.001
    assert fit.r2 > 0.99
    true_knee = math.sqrt((1.0 - sigma) / kappa)
    assert fit.knee is not None and abs(fit.knee - true_knee) < 3.0
    true_peak = _usl(true_knee, lam, sigma, kappa)
    assert abs(fit.peak_rps - true_peak) / true_peak < 0.10


def test_exact_fit_and_json_shape():
    lam, sigma, kappa = 100.0, 0.05, 0.002
    pts = [(n, _usl(n, lam, sigma, kappa)) for n in (1, 2, 4, 8, 16, 32)]
    fit = fit_usl(pts)
    assert fit is not None and fit.r2 > 0.999
    doc = fit.to_json()
    assert set(doc) == {"sigma", "kappa", "lambda", "r2", "knee", "peak_rps"}
    assert doc["knee"] is not None


def test_null_fit_too_few_distinct_concurrencies():
    assert fit_usl([]) is None
    assert fit_usl([(1, 100.0)]) is None
    assert fit_usl([(1, 100.0), (2, 150.0)]) is None
    # Repeats of one level are still one support.
    assert fit_usl([(4, 100.0), (4, 101.0), (4, 99.0)]) is None


def test_null_fit_flat_or_nonpositive_sweep():
    # Zero variance: no concurrency signal to fit.
    assert fit_usl([(1, 50.0), (2, 50.0), (4, 50.0), (8, 50.0)]) is None
    # Non-positive throughputs are filtered, leaving too few supports.
    assert fit_usl([(1, 0.0), (2, 0.0), (4, 0.0)]) is None


def test_non_monotone_noise_cannot_clear_the_gate():
    # A sweep that jumps around randomly either refuses to fit or comes back
    # with an R² far below the emission gate — it can never seed an episode.
    pts = [(1, 100.0), (2, 30.0), (4, 180.0), (8, 50.0), (16, 150.0), (32, 60.0)]
    fit = fit_usl(pts)
    assert fit is None or fit.r2 < DEFAULT_USL_MIN_R2


def test_linear_scaling_has_no_knee():
    # Perfect linear scaling: sigma = kappa = 0, monotone — no knee, and the
    # peak is the model at the largest SWEPT concurrency, never extrapolated.
    pts = [(n, 10.0 * n) for n in (1, 2, 4, 8, 16, 32)]
    fit = fit_usl(pts)
    assert fit is not None
    assert fit.knee is None
    assert fit.r2 > 0.999
    assert abs(fit.peak_rps - 320.0) < 1.0


# ---- sweep driver ------------------------------------------------------------


def _ok_probe(base, method, path, **kw):
    return ProbeResult(200, 2.0, {}, "json:a", None, None, "json")


def _err_probe(base, method, path, **kw):
    return ProbeResult(503, 2.0, None, "empty", None, None, None)


def test_run_sweep_levels_deduped_sorted_clamped():
    points = run_sweep(
        "http://x",
        "/ping",
        (4, 2, 2, 64),
        requests_per_level=8,
        probe_fn=_ok_probe,
    )
    assert [p.concurrency for p in points] == [2, 4, 32]  # 64 clamps to the hard cap
    # Per-level request count floors at the level so the pool saturates.
    assert [p.requests for p in points] == [8, 8, 32]
    assert all(p.endpoint == "GET /ping" for p in points)
    assert all(p.error_rate == 0.0 for p in points)


def test_run_sweep_reports_per_level_error_rates():
    points = run_sweep("http://x", "/ping", (1, 2, 4), requests_per_level=5, probe_fn=_err_probe)
    assert [p.error_rate for p in points] == [1.0, 1.0, 1.0]


def test_pick_sweep_endpoint_most_healthy_parameter_free_get():
    rows = (
        [{"method": "GET", "path": "/items", "status": 200}] * 3
        + [{"method": "GET", "path": "/items/{id}", "status": 200}] * 5  # parameterized
        + [{"method": "POST", "path": "/items", "status": 201}] * 9  # not GET
        + [{"method": "GET", "path": "/health", "status": 200}] * 2
        + [{"method": "GET", "path": "/flaky", "status": 500}] * 9  # not 2xx
        + [{"method": "GET", "path": "/dead", "status": None}]
    )
    assert pick_sweep_endpoint(rows) == "/items"
    assert pick_sweep_endpoint([]) is None
    # Ties break lexicographically for determinism.
    tied = [
        {"method": "GET", "path": "/b", "status": 200},
        {"method": "GET", "path": "/a", "status": 204},
    ]
    assert pick_sweep_endpoint(tied) == "/a"


# ---- throughput-ceiling emission --------------------------------------------


def _sweep_doc(
    *,
    knee=21.8,
    r2=0.95,
    sigma=0.05,
    kappa=0.002,
    peak=830.0,
    concurrencies=(1, 2, 4, 8, 16, 32),
    fit_null=False,
):
    return {
        "endpoint": "/ping",
        "points": [
            {"concurrency": c, "req_per_s": _usl(c, 100.0, sigma, kappa), "error_rate": 0.0}
            for c in concurrencies
        ],
        "fit": None
        if fit_null
        else {
            "sigma": sigma,
            "kappa": kappa,
            "r2": r2,
            "knee": knee,
            "peak_rps": peak,
        },
    }


def test_detect_emits_throughput_ceiling_from_sweep_file(tmp_path):
    store.write_json(sweep_path(tmp_path), _sweep_doc())
    profile = {
        "repo": str(tmp_path),
        "endpoints": [
            {"api_id": "GET_ping", "method": "GET", "path": "/ping"},
        ],
    }
    ops = detect_opportunities(profile)
    assert len(ops) == 1
    op = ops[0]
    assert op.kind == "throughput-ceiling"
    assert op.endpoint_id == "GET_ping"  # resolved from the profile
    assert op.endpoint == "GET /ping"
    assert op.metric == "req_per_s"
    assert op.value == 830.0
    # The detail states sigma, kappa, the knee, and the peak.
    for fragment in ("σ=0.050", "κ=0.00200", "21.8", "830.0"):
        assert fragment in op.detail


def test_detect_falls_back_to_raw_endpoint_id(tmp_path):
    store.write_json(sweep_path(tmp_path), _sweep_doc())
    ops = detect_opportunities({"repo": str(tmp_path), "endpoints": []})
    assert [o.kind for o in ops] == ["throughput-ceiling"]
    assert ops[0].endpoint_id == "GET /ping"


def test_detect_silent_without_sweep_file(tmp_path):
    assert detect_opportunities({"repo": str(tmp_path), "endpoints": []}) == []


def test_detect_silent_when_knee_extrapolated(tmp_path):
    # Knee beyond the largest swept concurrency: the ceiling was never
    # observed, only predicted — no emission.
    store.write_json(sweep_path(tmp_path), _sweep_doc(knee=45.0))
    assert detect_opportunities({"repo": str(tmp_path), "endpoints": []}) == []


def test_detect_silent_on_null_fit_or_no_knee(tmp_path):
    store.write_json(sweep_path(tmp_path), _sweep_doc(fit_null=True))
    assert detect_opportunities({"repo": str(tmp_path), "endpoints": []}) == []
    store.write_json(sweep_path(tmp_path), _sweep_doc(kappa=0.0, knee=None))
    assert detect_opportunities({"repo": str(tmp_path), "endpoints": []}) == []


def test_detect_r2_gate_default_and_policy_override(tmp_path):
    # Below the documented default gate: silent.
    store.write_json(sweep_path(tmp_path), _sweep_doc(r2=0.5))
    assert detect_opportunities({"repo": str(tmp_path), "endpoints": []}) == []
    # Above the default gate: emits.
    store.write_json(sweep_path(tmp_path), _sweep_doc(r2=0.95))
    assert len(detect_opportunities({"repo": str(tmp_path), "endpoints": []})) == 1
    # The learned policy can tighten the gate.
    store.write_json(policy_path(tmp_path), {"optimize.usl_min_r2": 0.99})
    assert detect_opportunities({"repo": str(tmp_path), "endpoints": []}) == []


# ---- CLI ---------------------------------------------------------------------


def test_cli_throughput_sweep_end_to_end(tmp_path, monkeypatch):
    # Endpoint selection reads results.jsonl; the sweep itself is faked with
    # points off a known USL curve so no live server is touched.
    store.write_jsonl(
        store.results_path(tmp_path),
        [
            {"method": "GET", "path": "/ping", "status": 200},
            {"method": "GET", "path": "/ping", "status": 200},
            {"method": "POST", "path": "/items", "status": 201},
        ],
    )

    def fake_sweep(base_url, endpoint, *args, **kwargs):
        assert base_url == "http://x" and endpoint == "/ping"
        return [
            ThroughputResult(
                f"GET {endpoint}", c, 40, 1.0, _usl(c, 100.0, 0.05, 0.002), 1.0, 2.0, 3.0, 0.0
            )
            for c in (1, 2, 4, 8, 16, 32)
        ]

    monkeypatch.setattr(cli, "run_sweep", fake_sweep)
    result = CliRunner().invoke(
        cli.main,
        ["throughput-sweep", str(tmp_path), "--base-url", "http://x"],
    )
    assert result.exit_code == 0, result.output
    out = json.loads(result.output)
    assert out["status"] == "ok"
    assert out["endpoint"] == "/ping"
    assert out["fit"] is not None and out["fit"]["knee"] is not None

    # The written artifact drives detection: the loop closes.
    on_disk = store.read_json(sweep_path(tmp_path))
    assert on_disk["fit"]["sigma"] == out["fit"]["sigma"]
    ops = detect_opportunities({"repo": str(tmp_path), "endpoints": []})
    assert [o.kind for o in ops] == ["throughput-ceiling"]


def test_cli_throughput_sweep_errors_without_candidate(tmp_path):
    result = CliRunner().invoke(
        cli.main,
        ["throughput-sweep", str(tmp_path), "--base-url", "http://x"],
    )
    assert result.exit_code == 1
    out = json.loads(result.output)
    assert out["status"] == "error"
    assert "--endpoint" in out["error"]
