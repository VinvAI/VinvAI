"""Drift attribution, cluster distinctness, malformed invariants (FP-8, FP-10, FP-3).

FP-8  A behaviour diff whose replayed input intersected the engine's planted
      values was relabelled ``environment``. But the input generators are
      DETERMINISTIC, so a replay always sends exactly the strings the
      recording run sent — the intersection is guaranteed for every mutating
      endpoint that ever 2xx'd. Genuine regressions there were silently
      dropped, and because `planted` grows monotonically the exemption only
      widened. Direction, not value overlap, is the real discriminator.
FP-10 `HTTP 500`, `502` and `503` on one path all digit-normalised to
      `HTTP #`, so three distinct failures became one cluster — the first
      status seen won the title, and one fix episode was dispatched against a
      mischaracterised failure.
FP-3  Only `endpoint` was type-checked when loading invariants, so drifted
      params reached the comparison and raised a bare TypeError inside the
      unguarded round loop, discarding every execution recorded so far.
"""

from __future__ import annotations

import pytest

from exerciser.issues import cluster_failures, normalize_signature
from exerciser.regress import _drift_can_explain
from exerciser.run import _enforce_invariants
from exerciser.store import _enforceable


class TestDriftDirection:
    """FP-8 — what planted state can and cannot explain."""

    @pytest.mark.parametrize(("before", "after"), [(200, 409), (200, 400), (404, 200), (409, 200)])
    def test_state_shaped_transitions_may_be_drift(self, before: int, after: int) -> None:
        """Residue can make a service reject what it accepted, or vice versa."""
        assert _drift_can_explain(before, after)

    @pytest.mark.parametrize(("before", "after"), [(200, 500), (200, 503), (500, 200), (404, 500)])
    def test_a_server_error_is_never_drift(self, before: int, after: int) -> None:
        """The headline: a genuine 200→500 must stay a `behavior` regression."""
        assert not _drift_can_explain(before, after)

    def test_a_transport_failure_is_never_drift(self) -> None:
        """No status at all is a crash, not a state effect."""
        assert not _drift_can_explain(200, None)
        assert not _drift_can_explain(None, 200)

    def test_non_integer_statuses_are_not_trusted(self) -> None:
        assert not _drift_can_explain("200", 500)


class TestClusterDistinctness:
    """FP-10 — distinct server errors must stay distinct."""

    @staticmethod
    def _rows(*statuses: int) -> list[dict]:
        return [
            {
                "status": s,
                "method": "GET",
                "path": "/items/",
                "endpoint_id": "GET_items",
                "strategy": "schema",
                "input": {},
            }
            for s in statuses
        ]

    def test_different_server_errors_do_not_collapse(self) -> None:
        clusters = cluster_failures(self._rows(500, 502, 503))
        assert len(clusters) == 3
        assert {c.count for c in clusters} == {1}

    def test_the_same_error_still_clusters(self) -> None:
        clusters = cluster_failures(self._rows(500, 500, 500))
        assert len(clusters) == 1
        assert clusters[0].count == 3

    def test_each_cluster_reports_its_own_status(self) -> None:
        titles = " ".join(c.title for c in cluster_failures(self._rows(500, 503)))
        assert "500" in titles and "503" in titles

    def test_ids_inside_a_message_are_still_collapsed(self) -> None:
        """The normaliser's real job must survive: same crash, different ids."""
        rows = [
            {
                "status": None,
                "error": f"connection to backend-{i} timed out after {i}s",
                "method": "GET",
                "path": "/items/",
                "endpoint_id": "e",
                "strategy": "s",
                "input": {},
            }
            for i in (1, 2, 3)
        ]
        assert len(cluster_failures(rows)) == 1

    def test_a_discriminator_only_splits_when_supplied(self) -> None:
        base = normalize_signature("server-error", "GET /x HTTP 500")
        assert normalize_signature("server-error", "GET /x HTTP 500", "") == base
        assert normalize_signature("server-error", "GET /x HTTP 500", "500") != base


class TestMalformedInvariantsAreDropped:
    """FP-3 — a drifted document must not discard a run."""

    @pytest.mark.parametrize(
        "params",
        [
            {"min": "5", "max": 9},  # the reported crash: "5" <= 5
            {"min": 0, "max": "9"},
            {"values": "ok"},  # would become SILENT substring matching
            {"values": {"a": 1}},
            {"min": True},  # bool is an int subclass but not a bound
            "not-a-dict",
            [1, 2],
        ],
    )
    def test_drifted_params_are_not_enforceable(self, params: object) -> None:
        assert not _enforceable({"kind": "numeric_bound", "params": params})

    @pytest.mark.parametrize(
        "params",
        [None, {}, {"min": 0, "max": 9}, {"min": 0.5, "max": 9.5}, {"values": ["a", "b"]}],
    )
    def test_well_formed_params_are_enforceable(self, params: object) -> None:
        assert _enforceable({"kind": "numeric_bound", "params": params})

    def test_a_bad_invariant_never_unwinds_the_round_loop(self) -> None:
        """Defence in depth: even if one reaches the enforcer, the run survives."""
        row = {
            "status_class": "2xx-3xx",
            "method": "GET",
            "path": "/x",
            "body": {"n": 5},
            "output_size": 1,
            "input_size": 1,
        }
        poisoned = {
            "GET /x": [
                {
                    "kind": "numeric_bound",
                    "field": "n",
                    "confidence": 0.99,
                    "support": 100,
                    "params": {"min": "5", "max": 9},
                }
            ]
        }
        _enforce_invariants(row, poisoned)  # must not raise
        assert "invariant_violation" not in row

    def test_a_healthy_invariant_still_judges_after_the_guard(self) -> None:
        row = {
            "status_class": "2xx-3xx",
            "method": "GET",
            "path": "/x",
            "body": {"n": 9999},
            "output_size": 1,
            "input_size": 1,
        }
        good = {
            "GET /x": [
                {
                    "kind": "numeric_bound",
                    "field": "n",
                    "confidence": 0.99,
                    "support": 100,
                    "params": {"min": 0, "max": 10},
                }
            ]
        }
        _enforce_invariants(row, good)
        assert "invariant_violation" in row
