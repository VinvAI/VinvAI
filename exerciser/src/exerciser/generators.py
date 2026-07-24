"""OSS generator adapters — install-safe, optional, deterministic.

testflow.md calls for property-based generation (Hypothesis) and OpenAPI-native
fuzzing. This module ADOPTS the real OSS tools where they compose with the
coverage-guided urllib driver, and falls back to the in-tree deterministic
generator (``schema.py``) otherwise — so `uv sync` never breaks when an optional
dependency is absent.

Adopted:
* **hypothesis-jsonschema** (`from_schema`) — when installed, supplies the
  ``hypothesis_valid`` generator arm: property-based valid instances drawn from
  the JSON schema. Determinism is achieved by seeding Hypothesis's global RNG and
  drawing a single example per (schema, seed), so a given seed reproduces the same
  instance. The in-tree generator remains the GUARANTEED source for the valid
  class and the SOLE source for the boundary/negative classes (which
  hypothesis-jsonschema, being a validity generator, does not produce).

Evaluated and deferred (documented, not bolted on):
* **Schemathesis** — owns its own Hypothesis test lifecycle and execution loop;
  it does not compose with a serial urllib driver that must stamp each request
  with ``X-Vinv-Exercise-Id`` for clean trace attribution, and its generator
  overlaps hypothesis-jsonschema which is already adopted. Deferred.
* **CrossHair** — symbolic execution over PURE typed functions, a function-level
  path orthogonal to exercising HTTP endpoints against a live traced service.
  Kept optional/unwired rather than misapplied.
* **KLEE** — C/LLVM symbolic executor; it does NOT apply to Python. Not used.

``hypothesis_valid_available`` lets callers probe support without importing the
optional package themselves.
"""

from __future__ import annotations

import warnings
from typing import Any


def hypothesis_valid_available() -> bool:
    """Whether hypothesis-jsonschema is importable in this environment."""
    try:
        import hypothesis  # noqa: F401
        import hypothesis_jsonschema  # noqa: F401
    except Exception:
        return False
    return True


def hypothesis_valid_instance(schema: dict[str, Any], seed: int) -> Any | None:
    """A property-based VALID instance for ``schema``, or None when unavailable.

    Deterministic per (schema, seed): the Hypothesis RNG is seeded and a single
    example is drawn. Any failure (unsupported schema keyword, generation error)
    returns None so the caller falls back to the in-tree generator.
    """
    try:
        from hypothesis import HealthCheck, given, settings
        from hypothesis import seed as hyp_seed
        from hypothesis_jsonschema import from_schema
    except Exception:
        return None

    drawn: list[Any] = []

    @hyp_seed(seed)
    @settings(
        max_examples=1,
        deadline=None,
        database=None,
        suppress_health_check=list(HealthCheck),
    )
    @given(from_schema(schema))
    def _collect(value: Any) -> None:
        if not drawn:
            drawn.append(value)

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            _collect()  # type: ignore[call-arg]
    except Exception:
        return None
    return drawn[0] if drawn else None
