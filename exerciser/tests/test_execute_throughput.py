"""HTTP execution helpers (shape hashing, path fill) + throughput driver."""

from __future__ import annotations

from exerciser.execute import ProbeResult, _fill_path, response_shape_hash
from exerciser.throughput import measure_throughput, percentile


def test_shape_hash_ignores_values_tracks_structure():
    a = response_shape_hash('{"id": 1, "name": "x"}', "application/json")
    b = response_shape_hash('{"id": 999, "name": "yy"}', "application/json")
    c = response_shape_hash('{"id": 1}', "application/json")  # dropped field
    assert a == b  # values erased
    assert a != c  # structure changed


def test_shape_hash_array_union():
    a = response_shape_hash('[{"id":1},{"id":2}]', "application/json")
    b = response_shape_hash('[{"id":5}]', "application/json")
    assert a == b  # homogeneous list → one signature regardless of length


def test_empty_and_nonjson_bodies():
    assert response_shape_hash("", None) == "empty"
    assert response_shape_hash("plain text", "text/plain").startswith("raw:")


def test_fill_path_variants():
    assert _fill_path("/items/{id}", {"id": 7}) == "/items/7"
    assert _fill_path("/items/<id>", {"id": 7}) == "/items/7"
    assert _fill_path("/items/{int:id}", {"id": 7}) == "/items/7"


def test_percentile():
    vals = [float(i) for i in range(1, 101)]
    assert percentile(vals, 0.5) == 50.5 or abs(percentile(vals, 0.5) - 50.5) < 1.0
    assert percentile([], 0.5) == 0.0


def test_throughput_driver_with_fake_probe():
    def fake(base, method, path, **kw):
        return ProbeResult(200, 5.0, {}, "json:a", None, None, "json")

    res = measure_throughput("http://x", "GET", "/x", requests=20, concurrency=4, probe_fn=fake)
    assert res.requests == 20
    assert res.error_rate == 0.0
    assert res.req_per_s > 0


def test_throughput_error_rate():
    def fake(base, method, path, **kw):
        return ProbeResult(500, 5.0, None, "empty", None, None, None)

    res = measure_throughput("http://x", "GET", "/x", requests=10, concurrency=2, probe_fn=fake)
    assert res.error_rate == 1.0
