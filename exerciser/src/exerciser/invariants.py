"""Daikon-lite invariant learner over observed endpoint outputs.

For each endpoint the engine has a set of OBSERVATIONS — one per successful
execution — each a small record: the response body (parsed JSON when available),
its size, the input size, and a monotone call index. From these it proposes
candidate invariants and keeps only those that HOLD across enough evidence:

* ``never_null``   — a top-level field is present and non-null in every response.
* ``stable_enum``  — a string field only ever took a small set of values.
* ``numeric_bound``— a numeric field stayed within ``[min, max]``.
* ``size_relation``— ``len(output) <= len(input)`` held on every observation.
* ``id_monotonic`` — an id-like field strictly increased across calls.

Discipline (matches ``testflow.md`` Phase-7 / the mission spec):

* an invariant is KEPT only with **support ≥ 5** observations and **0
  counterexamples**;
* confidence is the **Laplace estimate ``(s+1)/(n+2)``** over ``n`` relevant
  observations (with no counterexamples ``s = n``), so more evidence → higher
  confidence, and a bare-minimum-support invariant is honestly less certain than
  a heavily-witnessed one.

Pure and dependency-free so the learner (including counterexample rejection and
the support threshold) is unit-tested directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# The minimum number of supporting observations before an invariant is reported.
MIN_SUPPORT = 5
# A field is only treated as a stable enum when its distinct-value count stays at
# or below this cap (above it, it is free-form, not an enum).
_ENUM_MAX_CARDINALITY = 8


@dataclass
class Observation:
    """One successful execution's output facts."""

    body: Any  # parsed JSON body (dict/list/scalar) or None
    output_size: int  # len of body (fields for dict, elems for list, chars for str)
    input_size: int  # len of the input the probe sent
    call_index: int  # a monotone counter over successive calls to this endpoint


@dataclass
class Invariant:
    kind: str
    field: str | None
    description: str
    support: int
    confidence: float

    def to_json(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "field": self.field,
            "description": self.description,
            "support": self.support,
            "confidence": round(self.confidence, 4),
        }


def _laplace(supporting: int, total: int) -> float:
    """Laplace-smoothed hold rate ``(s+1)/(n+2)`` (n = total relevant obs)."""
    return (supporting + 1) / (total + 2)


def _top_level_fields(body: Any) -> dict[str, Any]:
    """Top-level dict fields of a body (a list of records → its first record's
    fields, so a collection endpoint still yields per-field invariants)."""
    if isinstance(body, dict):
        return body
    if isinstance(body, list) and body and isinstance(body[0], dict):
        return body[0]
    return {}


def _coerce_size(value: Any) -> int:
    if isinstance(value, (dict, list, str)):
        return len(value)
    return 0


def learn_invariants(observations: list[Observation]) -> list[Invariant]:
    """Infer the kept invariants for one endpoint. Deterministic, order-stable."""
    obs = [o for o in observations if o.body is not None]
    if len(obs) < MIN_SUPPORT:
        return []

    invariants: list[Invariant] = []

    # ---- per-field invariants over dict-shaped bodies ----------------------
    field_bodies = [_top_level_fields(o.body) for o in obs]
    # Fields that appear in at least one observation.
    all_fields: list[str] = []
    for fb in field_bodies:
        for k in fb:
            if k not in all_fields:
                all_fields.append(k)

    for fname in sorted(all_fields):
        present = [fb for fb in field_bodies if fname in fb]
        n = len(present)
        if n < MIN_SUPPORT:
            continue
        values = [fb[fname] for fb in present]

        # never_null: present and non-null in every observation that had the body.
        non_null = sum(1 for v in values if v is not None)
        if non_null == n and n == len(field_bodies):
            invariants.append(
                Invariant("never_null", fname, f"'{fname}' is always present and non-null",
                          n, _laplace(n, n))
            )

        # stable_enum: small distinct set of scalar (str/bool/int-enum) values.
        scalars = [v for v in values if isinstance(v, (str, bool))]
        if scalars and len(scalars) == n:
            distinct = sorted({str(v) for v in scalars})
            if 1 < len(distinct) <= _ENUM_MAX_CARDINALITY:
                invariants.append(
                    Invariant(
                        "stable_enum", fname,
                        f"'{fname}' only ever took values {{{', '.join(distinct)}}}",
                        n, _laplace(n, n),
                    )
                )

        # numeric_bound: numeric field within observed [min, max].
        nums = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
        if nums and len(nums) == n:
            lo, hi = min(nums), max(nums)
            invariants.append(
                Invariant(
                    "numeric_bound", fname,
                    f"'{fname}' stayed within [{lo}, {hi}]",
                    n, _laplace(n, n),
                )
            )

        # id_monotonic: an id-like numeric field strictly increasing across calls.
        lname = fname.lower()
        if (lname == "id" or lname.endswith("_id")) and nums and len(nums) == n:
            seq = [
                _top_level_fields(o.body)[fname]
                for o in sorted(obs, key=lambda o: o.call_index)
                if fname in _top_level_fields(o.body)
            ]
            seq = [v for v in seq if isinstance(v, (int, float)) and not isinstance(v, bool)]
            if len(seq) >= MIN_SUPPORT and all(b > a for a, b in zip(seq, seq[1:])):
                invariants.append(
                    Invariant(
                        "id_monotonic", fname,
                        f"'{fname}' strictly increased across successive calls",
                        len(seq), _laplace(len(seq), len(seq)),
                    )
                )

    # ---- whole-response size relation --------------------------------------
    sized = [o for o in obs if o.input_size > 0]
    if len(sized) >= MIN_SUPPORT:
        holds = sum(1 for o in sized if o.output_size <= o.input_size)
        if holds == len(sized):
            invariants.append(
                Invariant(
                    "size_relation", None,
                    "len(output) <= len(input) on every observation",
                    len(sized), _laplace(len(sized), len(sized)),
                )
            )

    invariants.sort(key=lambda i: (i.kind, i.field or ""))
    return invariants
