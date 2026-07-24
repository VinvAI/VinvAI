"""exerciser — the universal behavioral testing engine.

Discovers every endpoint (via identification), EXERCISES it against the live
traced service, profiles the outputs, learns invariants/contracts, closes the
coverage loop with a coverage-guided bandit, and keeps regression baselines.

Deterministic where it can be (seeded RNG for input generation and Thompson
sampling); every artifact lands under ``<repo>/.vinv/exercise/``.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.0"
