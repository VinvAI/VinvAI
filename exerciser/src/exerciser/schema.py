"""Schema-driven input generation — the deterministic backbone of the plan.

Given a JSON schema (a request-body schema pulled from the live service's
OpenAPI, or synthesised from an ``apis.json`` path + index signatures), generate
concrete inputs across three CLASSES, each seeded so the same schema + seed
yields byte-identical inputs every run:

* ``valid``    — a well-formed instance honouring every constraint.
* ``boundary`` — the edges: min/max numbers, min/max-length strings, empty and
  huge strings, single-element and enum-first choices.
* ``negative`` — inputs a correct service must reject: required field omitted,
  wrong type, out-of-enum, over-max, format-violating.

Format-aware (``email``/``uuid``/``date``/``date-time``/``uri``) so a string
field that names a format gets a value of the right SHAPE for the valid class and
a deliberately malformed one for the negative class.

Pure and dependency-free (stdlib ``random`` seeded per call); the OpenAPI FETCH
lives in ``openapi.py`` so this module stays trivially unit-testable.
"""

from __future__ import annotations

import random
import string
from typing import Any

# The generation classes, in a stable order (also the bandit's per-class arms
# on the schema side — see bandit.STRATEGIES).
INPUT_CLASSES = ("valid", "boundary", "negative")

# A huge string used for the boundary/negative "overflow" cases — long enough to
# trip naive length assumptions, bounded so a body stays sane over the wire.
_HUGE_LEN = 4096


def _rng(seed: int, salt: str) -> random.Random:
    """A fresh RNG keyed on ``(seed, salt)`` so each field/class is independent
    yet fully reproducible."""
    return random.Random(f"{seed}|{salt}")


# ---- format-aware string values --------------------------------------------

def _format_value(fmt: str, rng: random.Random, *, valid: bool) -> str:
    """A string honouring (valid) or violating (not valid) a named format."""
    if fmt == "email":
        if valid:
            user = "".join(rng.choice(string.ascii_lowercase) for _ in range(6))
            return f"{user}@example.com"
        return "not-an-email"
    if fmt in ("uuid", "uuid4"):
        if valid:
            hexd = "".join(rng.choice("0123456789abcdef") for _ in range(32))
            return f"{hexd[:8]}-{hexd[8:12]}-{hexd[12:16]}-{hexd[16:20]}-{hexd[20:]}"
        return "not-a-uuid"
    if fmt == "date":
        return "2020-01-15" if valid else "2020-13-40"
    if fmt in ("date-time", "datetime"):
        return "2020-01-15T12:00:00Z" if valid else "not-a-datetime"
    if fmt in ("uri", "url"):
        return "https://example.com/x" if valid else ":::not a uri:::"
    # Unknown format: a plain token (valid) or an empty string (negative-ish).
    return _plain_string(rng, 8) if valid else ""


def _plain_string(rng: random.Random, length: int) -> str:
    return "".join(rng.choice(string.ascii_letters + string.digits) for _ in range(max(0, length)))


# ---- per-type scalar generation --------------------------------------------

def _gen_string(schema: dict[str, Any], rng: random.Random, cls: str) -> Any:
    enum = schema.get("enum")
    if isinstance(enum, list) and enum:
        if cls == "negative":
            # A value guaranteed outside the enum.
            base = "__not_in_enum__"
            return base if base not in enum else base + "_x"
        # valid/boundary both pick a real member; boundary takes the first for
        # determinism, valid a seeded choice.
        return enum[0] if cls == "boundary" else rng.choice(enum)
    fmt = schema.get("format")
    min_len = int(schema.get("minLength", 0) or 0)
    max_len = schema.get("maxLength")
    max_len = int(max_len) if isinstance(max_len, (int, float)) else None
    if fmt:
        return _format_value(str(fmt), rng, valid=cls != "negative")
    if cls == "valid":
        length = min_len if min_len > 0 else 8
        if max_len is not None:
            length = min(length, max_len)
        return _plain_string(rng, length or 8)
    if cls == "boundary":
        # Prefer the exact minLength edge; else an empty string when allowed.
        if min_len > 0:
            return _plain_string(rng, min_len)
        if max_len is not None:
            return _plain_string(rng, max_len)
        return ""
    # negative: violate a length bound when one exists, else a huge string.
    if max_len is not None:
        return _plain_string(rng, max_len + 1 if max_len + 1 <= _HUGE_LEN else _HUGE_LEN)
    if min_len > 0:
        return ""  # shorter than the minimum
    return _plain_string(rng, _HUGE_LEN)


def _num_bounds(schema: dict[str, Any]) -> tuple[float | None, float | None]:
    lo = schema.get("minimum", schema.get("exclusiveMinimum"))
    hi = schema.get("maximum", schema.get("exclusiveMaximum"))
    lo = float(lo) if isinstance(lo, (int, float)) and not isinstance(lo, bool) else None
    hi = float(hi) if isinstance(hi, (int, float)) and not isinstance(hi, bool) else None
    return lo, hi


def _gen_number(schema: dict[str, Any], rng: random.Random, cls: str, *, integer: bool) -> Any:
    enum = schema.get("enum")
    if isinstance(enum, list) and enum:
        if cls == "negative":
            return "__wrong_type__"  # a string where a number is required
        return enum[0] if cls == "boundary" else rng.choice(enum)
    lo, hi = _num_bounds(schema)
    if cls == "valid":
        base_lo = lo if lo is not None else 0.0
        base_hi = hi if hi is not None else base_lo + 100.0
        val = rng.uniform(base_lo, base_hi)
        return int(round(val)) if integer else round(val, 4)
    if cls == "boundary":
        edge = lo if lo is not None else (hi if hi is not None else 0.0)
        return int(round(edge)) if integer else round(edge, 4)
    # negative: out of bounds, else a wrong type.
    if hi is not None:
        return int(hi) + 1 if integer else hi + 1.0
    if lo is not None:
        return int(lo) - 1 if integer else lo - 1.0
    return "__wrong_type__"


def _gen_boolean(rng: random.Random, cls: str) -> Any:
    if cls == "negative":
        return "__wrong_type__"
    return rng.choice([True, False]) if cls == "valid" else False


def _resolve_type(schema: dict[str, Any]) -> str:
    """The JSON-schema type, defaulting to ``string`` and tolerating a type list
    (OpenAPI 3.1 nullable style) or ``anyOf``/``oneOf`` heads."""
    t = schema.get("type")
    if isinstance(t, list):
        non_null = [x for x in t if x != "null"]
        return str(non_null[0]) if non_null else "string"
    if t:
        return str(t)
    for key in ("anyOf", "oneOf", "allOf"):
        variants = schema.get(key)
        if isinstance(variants, list):
            for v in variants:
                if isinstance(v, dict) and v.get("type") and v["type"] != "null":
                    return str(v["type"])
    if "properties" in schema:
        return "object"
    if "items" in schema:
        return "array"
    return "string"


def generate_value(schema: dict[str, Any], seed: int, cls: str, path: str = "$") -> Any:
    """Generate one concrete value of class ``cls`` for a JSON ``schema``.

    Recurses into objects/arrays; ``path`` keys the per-field RNG so sibling
    fields differ yet the whole instance is reproducible for a given seed.
    """
    if not isinstance(schema, dict):
        return None
    rng = _rng(seed, f"{cls}:{path}")
    jtype = _resolve_type(schema)

    if jtype == "object":
        props = schema.get("properties")
        props = props if isinstance(props, dict) else {}
        required = schema.get("required")
        required = [r for r in required if isinstance(r, str)] if isinstance(required, list) else list(props)
        out: dict[str, Any] = {}
        # negative class drops ONE required field (the first) to test rejection.
        drop = required[0] if cls == "negative" and required else None
        for name, sub in props.items():
            if name == drop:
                continue
            # Only required fields for the valid/boundary minimal instance; the
            # negative class keeps the rest to isolate the single violation.
            if cls != "negative" and required and name not in required:
                continue
            child_cls = "valid" if cls == "negative" else cls
            out[name] = generate_value(sub if isinstance(sub, dict) else {}, seed, child_cls, f"{path}.{name}")
        return out

    if jtype == "array":
        items = schema.get("items")
        items = items if isinstance(items, dict) else {}
        if cls == "boundary":
            return []  # the empty-array edge
        if cls == "negative":
            return "__wrong_type__"  # a scalar where an array is required
        n = 1 + (seed % 2)
        return [generate_value(items, seed, "valid", f"{path}[{i}]") for i in range(n)]

    if jtype == "integer":
        return _gen_number(schema, rng, cls, integer=True)
    if jtype == "number":
        return _gen_number(schema, rng, cls, integer=False)
    if jtype == "boolean":
        return _gen_boolean(rng, cls)
    return _gen_string(schema, rng, cls)


def generate_inputs(schema: dict[str, Any], seed: int) -> dict[str, Any]:
    """One instance per input class, keyed by class name. Deterministic."""
    return {cls: generate_value(schema, seed, cls) for cls in INPUT_CLASSES}
