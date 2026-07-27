"""Invariant learner: support threshold, counterexample rejection, confidence."""

from __future__ import annotations

from exerciser.invariants import MIN_SUPPORT, Observation, learn_invariants


def _obs(body, *, out=None, inp=10, idx=1):
    size = out if out is not None else (len(body) if isinstance(body, dict | list | str) else 0)
    return Observation(body=body, output_size=size, input_size=inp, call_index=idx)


def test_below_support_learns_nothing():
    obs = [_obs({"id": i, "email": "x@y.z"}) for i in range(MIN_SUPPORT - 1)]
    assert learn_invariants(obs) == []


def test_never_null_learned_with_enough_support():
    obs = [_obs({"id": i, "email": "a@b.c"}) for i in range(1, MIN_SUPPORT + 2)]
    kinds = {(i.kind, i.field) for i in learn_invariants(obs)}
    assert ("never_null", "email") in kinds
    assert ("never_null", "id") in kinds


def test_never_null_rejected_on_counterexample():
    obs = [_obs({"id": i, "email": "a@b.c"}) for i in range(1, MIN_SUPPORT + 1)]
    obs.append(_obs({"id": 99, "email": None}))  # one counterexample
    kinds = {(i.kind, i.field) for i in learn_invariants(obs)}
    assert ("never_null", "email") not in kinds


def test_stable_enum_learned():
    obs = [_obs({"status": "active" if i % 2 else "inactive"}) for i in range(MIN_SUPPORT + 3)]
    invs = [i for i in learn_invariants(obs) if i.kind == "stable_enum"]
    assert invs and "active" in invs[0].description and "inactive" in invs[0].description


def test_numeric_bound_learned():
    obs = [_obs({"score": float(i)}) for i in range(MIN_SUPPORT + 2)]
    invs = [i for i in learn_invariants(obs) if i.kind == "numeric_bound" and i.field == "score"]
    assert invs
    assert "0" in invs[0].description  # min bound


def test_id_monotonic_learned_and_rejected():
    rising = [_obs({"id": i}, idx=i) for i in range(1, MIN_SUPPORT + 2)]
    invs = [i for i in learn_invariants(rising) if i.kind == "id_monotonic"]
    assert invs

    flat = [_obs({"id": 5}, idx=i) for i in range(1, MIN_SUPPORT + 2)]
    invs2 = [i for i in learn_invariants(flat) if i.kind == "id_monotonic"]
    assert not invs2  # not strictly increasing


def test_size_relation_learned_and_rejected():
    holds = [_obs({"a": 1}, out=3, inp=10) for _ in range(MIN_SUPPORT + 1)]
    invs = [i for i in learn_invariants(holds) if i.kind == "size_relation"]
    assert invs

    breaks = [_obs({"a": 1}, out=3, inp=10) for _ in range(MIN_SUPPORT)]
    breaks.append(_obs({"a": 1}, out=50, inp=10))  # output > input
    invs2 = [i for i in learn_invariants(breaks) if i.kind == "size_relation"]
    assert not invs2


def test_laplace_confidence_increases_with_evidence():
    small = [_obs({"email": "a@b.c"}) for _ in range(MIN_SUPPORT)]
    large = [_obs({"email": "a@b.c"}) for _ in range(MIN_SUPPORT * 4)]
    c_small = next(
        i for i in learn_invariants(small) if i.field == "email" and i.kind == "never_null"
    ).confidence
    c_large = next(
        i for i in learn_invariants(large) if i.field == "email" and i.kind == "never_null"
    ).confidence
    # (s+1)/(n+2): more observations → confidence closer to 1.
    assert c_large > c_small
    assert 0.0 < c_small < c_large < 1.0
    # Exact Laplace for n == MIN_SUPPORT (=5): (5+1)/(5+2) = 6/7.
    assert abs(c_small - (MIN_SUPPORT + 1) / (MIN_SUPPORT + 2)) < 1e-9


def test_null_bodies_ignored():
    obs = [_obs(None) for _ in range(MIN_SUPPORT + 2)]
    assert learn_invariants(obs) == []


def test_list_bodied_response_uses_first_record():
    obs = [
        _obs([{"id": i, "email": "a@b.c"}, {"id": i + 1, "email": "c@d.e"}], out=2)
        for i in range(1, MIN_SUPPORT + 2)
    ]
    kinds = {(i.kind, i.field) for i in learn_invariants(obs)}
    assert ("never_null", "email") in kinds
