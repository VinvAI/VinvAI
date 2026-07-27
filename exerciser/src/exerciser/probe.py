"""Probe identity and measurement — defined ONCE, because both are join keys.

Two formulas in this codebase are not merely repeated, they are *cross-module
contracts*, and inlining them broke both:

``probe_id``
    ``run`` and ``regress`` both write ``baselines/<api_id>.json``, keyed by
    probe id. ``run`` hashed a 3-tuple and ``regress`` a 4-tuple, so the two id
    spaces never intersected: regress compared every replay against a golden
    that did not exist, silently seeded a second disjoint population, and
    reported ``degraded == 0`` because it was **comparing against nothing**.
    Note the mismatch held even when ``query`` was empty — ``[a,b,c]`` and
    ``[a,b,c,null]`` are different JSON.

``input_size``
    ``run`` summed ``len(body) + len(path_params) + len(query)`` when LEARNING
    ``size_relation``; ``regress`` passed ``len(case["input"])`` when ENFORCING
    it — and ``case["input"]`` is the wrapper ``{body, path_params, query}``,
    whose length is the structural constant **3**. A relation learned as
    ``out=5 <= in=6`` was then replayed as ``out=5 > in=3`` and reported as a
    violation on every replay of every endpoint that ever learned it.

Both leave no trace when they drift: the ids simply stop matching and the
oracle silently measures nothing. Keeping them here, with the identity tests in
``test_probe_identity.py``, is what makes a future divergence a failing test
rather than a silent hole.

This module imports nothing from the package — it is a leaf, so any module may
use it without an import cycle.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

#: Width of the truncated SHA-256 used for probe ids. Baseline stores written
#: before this module existed used the same width, so ids remain compatible.
_ID_WIDTH = 16


def input_size(body: Any, path_params: Any, query: Any) -> int:
    """Size of one probe's input, as ``size_relation`` is LEARNED.

    Counts the members of the three request parts — never the arity of the
    wrapper that holds them.
    """
    n = 0
    if isinstance(body, dict | list | str):
        n += len(body)
    if isinstance(path_params, dict | list | str):
        n += len(path_params)
    if isinstance(query, dict | list | str):
        n += len(query)
    return n


def input_size_of(inp: Any) -> int:
    """``input_size`` for the persisted ``{body, path_params, query}`` form."""
    if not isinstance(inp, dict):
        return 0
    return input_size(inp.get("body"), inp.get("path_params"), inp.get("query"))


def probe_id(
    endpoint_id: Any,
    strategy: Any,
    path_params: Any,
    query: Any,
    auth_index: Any = None,
) -> str:
    """Stable identity of one concrete request, for the golden-baseline store.

    ``query`` is part of the key: two probes differing only by query string are
    different requests and must not share a golden.

    ``auth_index`` is part of the key because **who asked** changes what a
    correct answer is. The auth sweep replays every endpoint under each captured
    credential set, all tagged ``strategy="authed"``; without this component all
    of them collapse onto one id and the last writer wins. A superuser 200 and a
    normal-user 403 then share a golden, so whichever ran last defines
    "correct" — and the next run, ordering differently, reports a phantom
    degradation. It also silently discarded the authorization signal the sweep
    exists to produce.

    Every writer of the baseline store must call THIS function — an id computed
    any other way lands in a disjoint space and is never compared.
    """
    key = json.dumps(
        [endpoint_id, strategy, path_params or {}, query or {}, auth_index],
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(key.encode()).hexdigest()[:_ID_WIDTH]


def probe_id_of(execution: dict[str, Any]) -> str:
    """``probe_id`` for a persisted execution/suite row."""
    inp = execution.get("input") or {}
    return probe_id(
        execution.get("endpoint_id"),
        execution.get("strategy"),
        inp.get("path_params") if isinstance(inp, dict) else {},
        inp.get("query") if isinstance(inp, dict) else {},
        execution.get("auth_index"),
    )
