"""One bad response must not cost the run (audit COR-3, COR-13, COR-14).

These three compounded into a single worst case: a malformed reply escaped the
probe's exception clause, propagated out of the unguarded round loop, and
discarded every execution recorded so far — because persistence was a terminal
phase. The state those probes had planted in the live service went unrecorded
too, so it could never be torn down and silently poisoned later baselines.

  COR-13  `execute_probe` caught (URLError, OSError, ValueError). The
          `http.client.HTTPException` family is NOT an OSError, and urllib
          re-raises `h.getresponse()` failures unwrapped, so BadStatusLine and
          LineTooLong escaped. `RemoteDisconnected` IS an OSError, which is why
          ordinary connection drops always tested clean and this stayed hidden.
  COR-14  Every write happened after the round loop closed.
  COR-3   `_path_suffix` truncates to two segments, so two distinct routes could
          share an api_id; the run loop resolves an endpoint by first match, so
          one route was exercised twice and the other never — silently.
"""

from __future__ import annotations

import http.client

import pytest

from exerciser.execute import execute_probe
from exerciser.openapi import endpoints_from_openapi


class TestProbeSwallowsTransportFailures:
    """COR-13 — the exception families that used to escape."""

    @pytest.mark.parametrize(
        "exc",
        [
            http.client.BadStatusLine("garbage"),
            http.client.LineTooLong("header line"),
            http.client.IncompleteRead(b"partial"),
            http.client.UnknownProtocol("HTTP/9"),
            http.client.RemoteDisconnected("closed"),  # an OSError; the control
            OSError("connection refused"),
            ValueError("bad url"),
        ],
    )
    def test_a_transport_failure_becomes_a_row_not_an_exception(
        self, exc: BaseException, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def boom(*_a: object, **_k: object) -> None:
            raise exc

        monkeypatch.setattr("urllib.request.urlopen", boom)
        result = execute_probe("http://svc", "GET", "/x")
        assert result.status is None
        assert result.error, "the failure must be recorded, not lost"

    def test_an_unexpected_error_still_propagates_to_the_guarded_caller(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Not everything is swallowed — the round loop's own guard handles the rest."""

        def boom(*_a: object, **_k: object) -> None:
            raise KeyboardInterrupt

        monkeypatch.setattr("urllib.request.urlopen", boom)
        with pytest.raises(KeyboardInterrupt):
            execute_probe("http://svc", "GET", "/x")


class TestEndpointIdCollisions:
    """COR-3 — two routes must never share an id."""

    @staticmethod
    def _spec(*paths: str) -> dict:
        return {"paths": {p: {"get": {}} for p in paths}}

    def test_routes_sharing_a_two_segment_suffix_get_distinct_ids(self) -> None:
        eps = endpoints_from_openapi(
            self._spec("/users/{id}/items/{item_id}", "/teams/{id}/items/{item_id}"), []
        )
        assert len(eps) == 2
        assert len({e.api_id for e in eps}) == 2, "a shadowed route is never exercised"

    def test_every_route_keeps_its_own_path(self) -> None:
        eps = endpoints_from_openapi(
            self._spec("/users/{id}/items/{item_id}", "/teams/{id}/items/{item_id}"), []
        )
        assert {e.path for e in eps} == {
            "/users/{id}/items/{item_id}",
            "/teams/{id}/items/{item_id}",
        }

    def test_a_disambiguated_id_is_stable_across_calls(self) -> None:
        """An ordinal counter would renumber when an unrelated route is added."""
        spec = self._spec("/users/{id}/items/{item_id}", "/teams/{id}/items/{item_id}")
        first = sorted(e.api_id for e in endpoints_from_openapi(spec, []))
        second = sorted(e.api_id for e in endpoints_from_openapi(spec, []))
        assert first == second

    def test_non_colliding_routes_keep_their_natural_ids(self) -> None:
        """No gratuitous renaming — the common case must be untouched."""
        eps = endpoints_from_openapi(self._spec("/items/", "/users/"), [])
        assert all("__" not in e.api_id for e in eps)

    def test_three_way_collisions_all_resolve(self) -> None:
        eps = endpoints_from_openapi(
            self._spec("/a/x/items/{i}", "/b/y/items/{i}", "/c/z/items/{i}"), []
        )
        assert len({e.api_id for e in eps}) == len(eps) == 3

    def test_the_same_path_under_two_methods_is_not_a_collision(self) -> None:
        eps = endpoints_from_openapi({"paths": {"/items/": {"get": {}, "post": {}}}}, [])
        assert len({e.api_id for e in eps}) == 2
        assert all("__" not in e.api_id for e in eps)
