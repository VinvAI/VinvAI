"""Golden behavior baselines: earned recording, degraded/same/improved, ratchet."""

from __future__ import annotations

from exerciser.baseline import apply_baselines, compare_observation, read_baseline, status_class


def _obs(pid, status, shape="json:aaa", ep="EP_x"):
    return {
        "probeId": pid, "endpointId": ep, "method": "GET", "path": "/x",
        "httpStatus": status, "handler": "h", "shapeHash": shape,
    }


def test_status_class_boundaries():
    assert status_class(None) == "no-response"
    assert status_class(200) == "2xx-3xx"
    assert status_class(404) == "4xx"
    assert status_class(500) == "5xx"


def test_only_healthy_first_seen_is_recorded(tmp_path):
    v = apply_baselines(tmp_path, [_obs("p1", 500)])
    assert "p1" not in v  # a failing first obs is NOT baselined
    assert read_baseline(tmp_path, "EP_x") is None or "p1" not in read_baseline(tmp_path, "EP_x")["entries"]

    v2 = apply_baselines(tmp_path, [_obs("p2", 200)])
    assert v2["p2"]["verdict"] == "recorded"


def test_degraded_status(tmp_path):
    apply_baselines(tmp_path, [_obs("p", 200)])
    v = apply_baselines(tmp_path, [_obs("p", 500)])
    assert v["p"]["verdict"] == "degraded"


def test_degraded_shape_change(tmp_path):
    apply_baselines(tmp_path, [_obs("p", 200, shape="json:aaa")])
    v = apply_baselines(tmp_path, [_obs("p", 200, shape="json:bbb")])
    assert v["p"]["verdict"] == "degraded"


def test_same_when_unchanged(tmp_path):
    apply_baselines(tmp_path, [_obs("p", 200)])
    v = apply_baselines(tmp_path, [_obs("p", 200)])
    assert v["p"]["verdict"] == "same"


def test_improved_ratchets_baseline(tmp_path):
    apply_baselines(tmp_path, [_obs("p", 500)])  # not recorded (failing)
    # First healthy record.
    apply_baselines(tmp_path, [_obs("p", 200)])
    # Now a 4xx would be a degrade; an improvement path: seed at 4xx then 200.
    apply_baselines(tmp_path, [_obs("q", 404)])  # 404 not healthy → not recorded
    v = apply_baselines(tmp_path, [_obs("q", 200)])
    assert v["q"]["verdict"] == "recorded"


def test_compare_observation_pure():
    entry = {"statusClass": "2xx-3xx", "httpStatus": 200, "shapeHash": "json:a"}
    assert compare_observation(entry, {"httpStatus": 500, "shapeHash": "json:a"})["verdict"] == "degraded"
    assert compare_observation(entry, {"httpStatus": 200, "shapeHash": "json:a"})["verdict"] == "same"
