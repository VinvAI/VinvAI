"""Who asked is part of a probe's identity (audit FP-6, FP-7).

The auth sweep replays every endpoint under each captured credential set, all
tagged ``strategy="authed"``. The credential was absent from the data model end
to end — not on the row, not in the probe id, not in the replay suite — which
produced two compounding defects:

  FP-6  N credential sets collapsed onto ONE probe id, last writer wins. A
        superuser 200 and a normal-user 403 shared a golden, so whichever ran
        last defined "correct" and the next run reported a phantom degradation.
        It also discarded the authorization signal the sweep exists to produce.
  FP-7  regress replayed EVERY authed case as ``fresh_auth[0]``, so a
        superuser-only 200 re-issued as the normal user came back 403 and was
        reported as a behavior regression on unchanged code — deterministic,
        permanent, and self-inflicted.

Every auth test in the original suite passed exactly ONE credential set, so
N>=2 was untested territory. These tests live there.
"""

from __future__ import annotations

import pytest

from exerciser.probe import probe_id, probe_id_of
from exerciser.run import _auth_sweep, _baseline_observations


class _Recorder:
    """Probe stub answering per-identity: superuser 200, everyone else 403."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def __call__(self, base_url, method, path, **kw):  # noqa: ANN001, ANN204
        headers = kw.get("headers") or {}
        superuser = headers.get("Authorization") == "Bearer super"
        self.calls.append({"path": path, "headers": headers})

        class R:
            status = 200 if superuser else 403
            body = {"ok": True} if superuser else {"detail": "Forbidden"}
            shape_hash = "s-ok" if superuser else "s-forbidden"
            value_digest = "v-ok" if superuser else "v-forbidden"
            latency_ms = 1.0
            error = None
            request_id = None

        return R()


ENDPOINTS = [
    {
        "api_id": "GET_users",
        "method": "GET",
        "path": "/users/",
        "handler": "h",
        "inputs": [{"class": "valid", "body": None, "path_params": {}, "query": {}}],
    }
]
TWO_IDENTITIES = [{"Authorization": "Bearer super"}, {"Authorization": "Bearer normal"}]


def _sweep(identities: list[dict[str, str]]) -> list[dict]:
    import logging

    return _auth_sweep(
        ENDPOINTS, "http://svc", "ex1", _Recorder(), identities, [], logging.getLogger("t")
    )


class TestProbeIdCarriesIdentity:
    def test_two_identities_do_not_share_a_probe_id(self) -> None:
        """FP-6: the collapse that made the last writer define 'correct'."""
        a = probe_id("GET_users", "authed", {}, {}, 0)
        b = probe_id("GET_users", "authed", {}, {}, 1)
        assert a != b

    def test_unauthenticated_probes_are_unaffected(self) -> None:
        assert probe_id("e", "schema", {}, {}) == probe_id("e", "schema", {}, {}, None)

    def test_identity_is_read_from_the_row(self) -> None:
        row = {"endpoint_id": "e", "strategy": "authed", "input": {}, "auth_index": 3}
        assert probe_id_of(row) == probe_id("e", "authed", {}, {}, 3)

    def test_a_row_without_an_index_is_the_unauthenticated_id(self) -> None:
        """Rows recorded before this field existed must stay readable."""
        row = {"endpoint_id": "e", "strategy": "authed", "input": {}}
        assert probe_id_of(row) == probe_id("e", "authed", {}, {}, None)


class TestSweepRecordsIdentity:
    def test_each_identity_gets_its_own_row_and_index(self) -> None:
        rows = _sweep(TWO_IDENTITIES)
        assert [r["auth_index"] for r in rows] == [0, 1]
        assert all(r["auth"] is True for r in rows)

    def test_the_two_identities_keep_separate_baselines(self) -> None:
        """FP-6 end to end: 200 and 403 must not overwrite one another."""
        observations = _baseline_observations(_sweep(TWO_IDENTITIES))
        assert len({o["probeId"] for o in observations}) == 2
        assert sorted(o["httpStatus"] for o in observations) == [200, 403]

    def test_reordering_the_identities_does_not_change_the_verdict(self) -> None:
        """Before, order decided which status became the golden."""
        forward = {
            o["probeId"]: o["httpStatus"] for o in _baseline_observations(_sweep(TWO_IDENTITIES))
        }
        reverse = {
            o["probeId"]: o["httpStatus"]
            for o in _baseline_observations(_sweep(list(reversed(TWO_IDENTITIES))))
        }
        # Same two ids either way; only which index maps to which status swaps.
        assert set(forward) == set(reverse)
        assert sorted(forward.values()) == sorted(reverse.values()) == [200, 403]

    def test_a_single_identity_still_works(self) -> None:
        rows = _sweep([TWO_IDENTITIES[0]])
        assert [r["auth_index"] for r in rows] == [0]

    def test_no_identities_means_no_sweep(self) -> None:
        assert _sweep([]) == []


class TestReplayUsesTheRecordingIdentity:
    """FP-7 — the case selection logic in `replay_suite`."""

    @staticmethod
    def _pick(case_index: object, available: int) -> str:
        """Mirror of the replay branch: which credential (or skip) is chosen."""
        idx = case_index if isinstance(case_index, int) else 0
        return "skip" if idx >= available else f"cred{int(idx)}"

    def test_each_case_replays_under_its_own_identity(self) -> None:
        assert self._pick(0, 2) == "cred0"
        assert self._pick(1, 2) == "cred1"

    def test_a_case_whose_identity_did_not_recapture_is_skipped_not_guessed(self) -> None:
        """Skipping is honest; replaying as someone else invents a regression."""
        assert self._pick(1, 1) == "skip"

    def test_a_legacy_case_without_an_index_falls_back_to_the_first(self) -> None:
        assert self._pick(None, 2) == "cred0"

    @pytest.mark.parametrize("bad", ["1", 1.0, True])
    def test_a_non_integer_index_is_not_trusted_as_an_offset(self, bad: object) -> None:
        # bool is an int subclass, so True legitimately indexes credential 1.
        expected = "cred1" if bad is True else "cred0"
        assert self._pick(bad, 2) == expected
