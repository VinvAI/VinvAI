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

Discipline:

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

import math
from dataclasses import dataclass
from dataclasses import field as dc_field
from typing import Any

# The minimum number of supporting observations before an invariant is reported.
MIN_SUPPORT = 5
# A field is only treated as a stable enum when its distinct-value count stays at
# or below this cap (above it, it is free-form, not an enum).
_ENUM_MAX_CARDINALITY = 8
# Confidence floor for ENFORCING a learned invariant. Retained for documents
# written before the justification test existed, and for hand-authored ones.
#
# NOTE: this gate alone is INERT against anything the learner produces. Every
# call site passes supporting == total with n >= MIN_SUPPORT, so `_laplace` is
# (n+1)/(n+2) >= 6/7 = 0.857 — always above 0.8. `MIN_SUPPORT` already pins the
# floor above the gate, so the gate can never reject a learned invariant. That
# is why `_chance_probability` below, not this constant, is the real control.
ENFORCE_MIN_CONFIDENCE = 0.8

# Maximum tolerated probability that an invariant held across its observations
# BY CHANCE. Daikon's core idea: "never violated" is not evidence — the question
# is how surprising the agreement is given how little was seen
# [Ernst et al., IEEE TSE 27(2), 2001].
#
# 0.10 is not arbitrary. This probability IS the invariant's expected
# false-positive rate on healthy traffic, and Google's Tricorder found that
# analyzers above ~10% effective false positives get dismissed or disabled by
# developers [Sadowski et al., CACM 61(4), 2018]. So this is the loosest value a
# HARD failure — one that dispatches a fix episode against possibly-correct code
# — can defensibly carry. It admits never_null/size_relation at n>=4 (cheap to
# witness, genuinely informative) while requiring ~19 observations before a
# learned range or enum may fail a build.
MAX_CHANCE_PROBABILITY = 0.10


def _chance_probability(kind: str, support: int, params: dict[str, Any]) -> float:
    """Probability this invariant would have held across ``support`` samples by luck.

    Each kind gets the standard estimator for its shape:

    * ``numeric_bound`` — for n exchangeable samples, the chance the next value
      falls outside the observed min/max is ``2/(n+1)`` (it is the new
      minimum or the new maximum). n=5 gives 0.33: a range learned from five
      observations is barely evidence at all, which is exactly the template that
      was minting false failures on boundary probes.
    * ``stable_enum`` — the Good-Turing intuition: with ``k`` distinct values in
      ``n`` samples, the mass belonging to unseen values is about ``k/n``. Seeing
      3 statuses in 5 calls says almost nothing about a 4th existing.
    * ``never_null`` / ``size_relation`` — a Bernoulli property that could have
      gone either way each time, so ``2**-n``. n=5 gives 0.031, which clears the
      threshold: these are cheap to witness and genuinely informative, which is
      why they remain enforceable on modest evidence.

    Unknown kinds return 0.0 (enforced), so adding a template cannot silently
    disable it.
    """
    n = max(0, int(support))
    if n <= 0:
        return 1.0
    if kind == "numeric_bound":
        return 2.0 / (n + 1)
    if kind == "stable_enum":
        k = len(params.get("values") or ())
        return min(1.0, k / n) if k else 1.0
    if kind in ("never_null", "size_relation"):
        return 2.0**-n
    return 0.0


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
    # Machine-readable parameters the ENFORCER needs (the description is prose):
    # stable_enum → {"values": [...]}, numeric_bound → {"min": lo, "max": hi}.
    # Additive — documents written before this key simply cannot be enforced for
    # the parameterised kinds.
    params: dict[str, Any] = dc_field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        out = {
            "kind": self.kind,
            "field": self.field,
            "description": self.description,
            "support": self.support,
            "confidence": round(self.confidence, 4),
        }
        if self.params:
            out["params"] = self.params
        return out


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
                Invariant(
                    "never_null",
                    fname,
                    f"'{fname}' is always present and non-null",
                    n,
                    _laplace(n, n),
                )
            )

        # stable_enum: small distinct set of scalar (str/bool/int-enum) values.
        scalars = [v for v in values if isinstance(v, str | bool)]
        if scalars and len(scalars) == n:
            distinct = sorted({str(v) for v in scalars})
            if 1 < len(distinct) <= _ENUM_MAX_CARDINALITY:
                invariants.append(
                    Invariant(
                        "stable_enum",
                        fname,
                        f"'{fname}' only ever took values {{{', '.join(distinct)}}}",
                        n,
                        _laplace(n, n),
                        params={"values": distinct},
                    )
                )

        # numeric_bound: numeric field within observed [min, max].
        #
        # Non-finite values are EXCLUDED, not bounded. json.loads accepts the
        # non-standard NaN/Infinity tokens, and a single NaN poisons this
        # invariant three ways: min() is order-dependent (so the learned bound
        # stops being deterministic), `nan <= v <= nan` is False for every v (so
        # every later healthy response is flagged forever), and json.dumps writes
        # a bare NaN token that is not RFC-8259 — making invariants.json
        # unreadable to JSON.parse on the TypeScript side.
        nums = [
            v
            for v in values
            if isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)
        ]
        if nums and len(nums) == n:
            lo, hi = min(nums), max(nums)
            invariants.append(
                Invariant(
                    "numeric_bound",
                    fname,
                    f"'{fname}' stayed within [{lo}, {hi}]",
                    n,
                    _laplace(n, n),
                    params={"min": lo, "max": hi},
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
            seq = [v for v in seq if isinstance(v, int | float) and not isinstance(v, bool)]
            if len(seq) >= MIN_SUPPORT and all(b > a for a, b in zip(seq, seq[1:], strict=False)):
                invariants.append(
                    Invariant(
                        "id_monotonic",
                        fname,
                        f"'{fname}' strictly increased across successive calls",
                        len(seq),
                        _laplace(len(seq), len(seq)),
                    )
                )

    # ---- whole-response size relation --------------------------------------
    sized = [o for o in obs if o.input_size > 0]
    if len(sized) >= MIN_SUPPORT:
        holds = sum(1 for o in sized if o.output_size <= o.input_size)
        if holds == len(sized):
            invariants.append(
                Invariant(
                    "size_relation",
                    None,
                    "len(output) <= len(input) on every observation",
                    len(sized),
                    _laplace(len(sized), len(sized)),
                )
            )

    invariants.sort(key=lambda i: (i.kind, i.field or ""))
    return invariants


# =========================================================================
# Enforcement — the learned assertions actually judge new responses
# =========================================================================
#
# ``learn_invariants`` proposes; this checks. A plausibly-shaped WRONG answer
# (2xx, right schema, wrong value) raises nothing and degrades no status class,
# so without enforcement it is invisible end-to-end — the single largest defect
# class in any library. Violation strings deliberately name the invariant kind
# and field but NOT the offending value: cluster signatures digit-normalise, and
# a value-per-cluster explosion would drown the signal.


def check_observation(
    invariants: list[dict[str, Any]],
    body: Any,
    *,
    output_size: int = 0,
    input_size: int = 0,
    min_confidence: float = ENFORCE_MIN_CONFIDENCE,
    max_chance: float = MAX_CHANCE_PROBABILITY,
) -> list[str]:
    """Violations of the stateless learned invariants against ONE response.

    ``invariants`` are ``Invariant.to_json`` dicts (the ``invariants.json`` /
    ``profile.json`` form). Only 2xx responses should be judged — invariants
    are learned over healthy outputs. ``id_monotonic`` is cross-call and is
    checked by ``check_monotonic_sequence`` instead. Deterministic and pure.
    """
    violations: list[str] = []
    fields = _top_level_fields(body)
    for inv in invariants:
        if not isinstance(inv, dict) or inv.get("confidence", 0) < min_confidence:
            continue
        kind = inv.get("kind")
        fname = inv.get("field")
        params = inv.get("params") or {}
        # Statistical justification, not just "never violated". Without this a
        # range or enum learned from MIN_SUPPORT=5 observations is enforced as a
        # HARD failure, so the first legitimately-larger number or fourth valid
        # enum value mints a false `invariant-violation` — which is then
        # dispatched as a fix episode against correct code.
        if _chance_probability(str(kind), int(inv.get("support", 0)), params) > max_chance:
            continue
        if kind == "never_null":
            # Judged only when the body yielded dict fields at all — an empty
            # collection response has no record to inspect, which is absence of
            # evidence, not a violation.
            if fields and fields.get(fname) is None:
                violations.append(
                    f"never_null violated: '{fname}' missing or null "
                    f"(learned: always present and non-null)"
                )
        elif kind == "stable_enum":
            values = params.get("values")
            if values and fname in fields:
                v = fields[fname]
                if isinstance(v, str | bool) and str(v) not in values:
                    violations.append(
                        f"stable_enum violated: '{fname}' took a value outside " f"its learned set"
                    )
        elif kind == "numeric_bound":
            lo, hi = params.get("min"), params.get("max")
            lname = (fname or "").lower()
            if lname == "id" or lname.endswith("_id"):
                # Ids legitimately grow past any observed bound; id_monotonic
                # is the invariant that judges them.
                continue
            if lo is not None and hi is not None and fname in fields:
                v = fields[fname]
                # Non-finite values are INCOMPARABLE, not out-of-range: every
                # ordering test against NaN is False, so `not (lo <= v <= hi)`
                # is True and the range check would report "left its learned
                # range" — a diagnosis that is simply untrue of NaN. A range
                # invariant does not apply to it. Such a response is not lost:
                # it always moves the value digest, which judges it correctly.
                if (
                    isinstance(v, int | float)
                    and not isinstance(v, bool)
                    and math.isfinite(v)
                    and not (lo <= v <= hi)
                ):
                    violations.append(f"numeric_bound violated: '{fname}' left its learned range")
        elif kind == "size_relation":
            if input_size > 0 and output_size > input_size:
                violations.append("size_relation violated: len(output) > len(input)")
    return violations


def check_monotonic_sequence(
    invariants: list[dict[str, Any]],
    bodies_in_order: list[Any],
    *,
    min_confidence: float = ENFORCE_MIN_CONFIDENCE,
) -> list[tuple[int, str]]:
    """Cross-call check for ``id_monotonic``: ``(body_index, violation)`` pairs.

    ``bodies_in_order`` are one endpoint's successful response bodies in call
    order; the index identifies WHICH call broke the ordering so the caller can
    flag that execution row.
    """
    out: list[tuple[int, str]] = []
    for inv in invariants:
        if not isinstance(inv, dict) or inv.get("confidence", 0) < min_confidence:
            continue
        if inv.get("kind") != "id_monotonic":
            continue
        fname = inv.get("field")
        prev: float | None = None
        for i, body in enumerate(bodies_in_order):
            v = _top_level_fields(body).get(fname)
            if not isinstance(v, int | float) or isinstance(v, bool):
                continue
            if prev is not None and v <= prev:
                out.append((i, f"id_monotonic violated: '{fname}' did not strictly increase"))
            prev = v
    return out
