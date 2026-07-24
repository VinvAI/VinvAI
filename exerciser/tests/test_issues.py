"""Failure clustering: signature normalisation + dedup by normalized signature."""

from __future__ import annotations

from exerciser.issues import cluster_failures, issues_document, normalize_signature


def _ex(status=None, error=None, method="POST", path="/x", violation=None, **kw):
    row = {
        "status": status, "error": error, "method": method, "path": path,
        "endpoint_id": kw.get("endpoint_id", "EP_x"), "strategy": "schema_valid",
        "input": {"body": {}}, "input_class": "valid",
    }
    if violation:
        row["invariant_violation"] = violation
    return row


def test_signature_normalises_digits_and_whitespace():
    a = normalize_signature("server-error", "POST /items/42 HTTP 500  at port 8000")
    b = normalize_signature("server-error", "POST /items/99 HTTP 500 at port 9999")
    assert a == b  # digits normalised → same signature


def test_server_errors_cluster():
    execs = [_ex(status=500), _ex(status=500), _ex(status=503, path="/y")]
    clusters = cluster_failures(execs)
    # /x 500 x2 collapse to one, /y is another kind of path.
    kinds = {c.kind for c in clusters}
    assert kinds == {"server-error"}
    xcluster = next(c for c in clusters if c.path == "/x")
    assert xcluster.count == 2


def test_crash_clustered_when_no_status():
    clusters = cluster_failures([_ex(error="connection refused")])
    assert len(clusters) == 1 and clusters[0].kind == "crash"


def test_invariant_violation_clustered():
    clusters = cluster_failures([_ex(status=200, violation="email was null")])
    assert len(clusters) == 1 and clusters[0].kind == "invariant-violation"


def test_2xx_and_4xx_are_not_failures():
    assert cluster_failures([_ex(status=200), _ex(status=404)]) == []


def test_issues_document_shape():
    doc = issues_document(cluster_failures([_ex(status=500)]))
    assert doc["version"] == 1 and doc["cluster_count"] == 1
    assert doc["clusters"][0]["signature"]
