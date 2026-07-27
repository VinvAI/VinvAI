"""`run` and `regress` must agree on probe identity and input size (COR-10/12, FP-5).

Both modules write ``baselines/<api_id>.json`` and both enforce ``size_relation``.
Before this, each inlined its own formula:

* probe id — ``run`` hashed a 3-tuple, ``regress`` a 4-tuple. The id spaces never
  intersected, so regress compared every replay against a golden that did not
  exist, silently seeded a second population, and reported ``degraded == 0``
  because it was comparing against nothing. **The regression suite looked clean
  because it was measuring nothing.**
* input size — ``run`` summed the request parts; ``regress`` took ``len()`` of the
  wrapper dict, which is the structural constant 3.

Neither drift raised anything. These tests exist so the next one fails loudly.
"""

from __future__ import annotations

from exerciser.probe import input_size, input_size_of, probe_id, probe_id_of
from exerciser.regress import _suite_from_results
from exerciser.run import _baseline_observations


def _execution(**over: object) -> dict:
    row = {
        "endpoint_id": "GET_items_{p}",
        "api_id": "GET_items_{p}",
        "method": "GET",
        "path": "/items/{item_id}",
        "strategy": "schema",
        "input_class": "valid",
        "status": 200,
        "status_class": "2xx-3xx",
        "shape_hash": "s0",
        "input": {"body": {"a": 1, "b": 2}, "path_params": {"item_id": "7"}, "query": {"q": "x"}},
        "value_digest": "d0",
        "expected": "2xx-3xx",
        "round": 1,
    }
    row.update(over)  # type: ignore[arg-type]
    return row


class TestProbeIdIsShared:
    def test_run_and_regress_derive_the_same_id_for_the_same_execution(self) -> None:
        """The join both baseline writers depend on."""
        ex = _execution()
        observations = _baseline_observations([ex])
        suite = _suite_from_results([ex])
        assert observations, "run should produce a baseline observation"
        assert suite, "regress should produce a suite case"
        assert observations[0]["probeId"] == suite[0]["probeId"]

    def test_they_agree_when_query_is_absent(self) -> None:
        """The original drift held even here: [a,b,c] != [a,b,c,null]."""
        ex = _execution(input={"body": {}, "path_params": {"item_id": "7"}})
        observations = _baseline_observations([ex])
        suite = _suite_from_results([ex])
        assert observations[0]["probeId"] == suite[0]["probeId"]

    def test_query_participates_in_identity(self) -> None:
        """Two probes differing only by query are different requests."""
        a = probe_id("e", "schema", {"id": "1"}, {"page": "1"})
        b = probe_id("e", "schema", {"id": "1"}, {"page": "2"})
        assert a != b

    def test_absent_and_empty_query_are_the_same_probe(self) -> None:
        assert probe_id("e", "s", {}, None) == probe_id("e", "s", {}, {})

    def test_id_is_stable_and_width_bounded(self) -> None:
        got = probe_id("e", "s", {"a": "1"}, {"b": "2"})
        assert got == probe_id("e", "s", {"a": "1"}, {"b": "2"})
        assert len(got) == 16

    def test_probe_id_of_matches_the_explicit_form(self) -> None:
        ex = _execution()
        assert probe_id_of(ex) == probe_id(
            ex["endpoint_id"], ex["strategy"], {"item_id": "7"}, {"q": "x"}
        )


class TestProbeIdCornerCases:
    def test_key_order_does_not_change_identity(self) -> None:
        """sort_keys must make dict construction order irrelevant."""
        a = probe_id("e", "s", {"x": "1", "y": "2"}, {})
        b = probe_id("e", "s", {"y": "2", "x": "1"}, {})
        assert a == b

    def test_none_and_empty_path_params_agree(self) -> None:
        assert probe_id("e", "s", None, {}) == probe_id("e", "s", {}, {})

    def test_distinct_endpoints_do_not_collide(self) -> None:
        assert probe_id("a", "s", {}, {}) != probe_id("b", "s", {}, {})

    def test_distinct_strategies_do_not_collide(self) -> None:
        assert probe_id("e", "schema", {}, {}) != probe_id("e", "observed", {}, {})

    def test_path_params_participate(self) -> None:
        assert probe_id("e", "s", {"id": "1"}, {}) != probe_id("e", "s", {"id": "2"}, {})

    def test_a_value_and_its_string_form_are_not_silently_merged(self) -> None:
        """`default=str` must not make 1 and "1" the same probe by accident."""
        assert probe_id("e", "s", {"id": 1}, {}) != probe_id("e", "s", {"id": "x"}, {})

    def test_unserializable_values_do_not_raise(self) -> None:
        """`default=str` exists so an exotic param cannot crash a run."""
        assert probe_id("e", "s", {"when": object()}, {})

    def test_unicode_params_are_stable(self) -> None:
        got = probe_id("e", "s", {"name": "太郎"}, {})
        assert got == probe_id("e", "s", {"name": "太郎"}, {})

    def test_probe_id_of_tolerates_a_missing_or_malformed_input(self) -> None:
        for row in ({}, {"input": None}, {"input": "not-a-dict"}):
            assert len(probe_id_of(row)) == 16


class TestInputSizeIsShared:
    def test_the_wrapper_arity_is_never_the_answer(self) -> None:
        """`len({body, path_params, query})` is 3 no matter what it holds."""
        inp = {"body": {"a": 1, "b": 2, "c": 3}, "path_params": {"id": "7"}, "query": {}}
        assert len(inp) == 3
        assert input_size_of(inp) == 4  # 3 body fields + 1 path param

    def test_learned_and_replayed_sizes_agree(self) -> None:
        body, pp, q = {"a": 1, "b": 2}, {"item_id": "7"}, {"q": "x"}
        learned = input_size(body, pp, q)
        replayed = input_size_of({"body": body, "path_params": pp, "query": q})
        assert learned == replayed == 4

    def test_missing_parts_contribute_nothing(self) -> None:
        assert input_size_of({"body": None, "path_params": {}, "query": None}) == 0
        assert input_size_of({}) == 0
        assert input_size_of(None) == 0

    def test_a_string_body_counts_its_characters(self) -> None:
        assert input_size("abcd", {}, {}) == 4
