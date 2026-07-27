"""A LEARNED policy for "is this exception a defect, or a deliberate refusal?"

Every oracle that pushes made-up inputs at code hits the same question, and it
is the question that decides whether the tool is useful or ignored. Answering it
with a hand-written list of exception names does not survive contact with a new
repository: the list encodes one codebase's vocabulary, and the next repo
refuses input with ``InterpreterError``, ``ToolValidationError``, ``Problem``,
or something nobody has ever seen. A curated taxonomy is a maintenance treadmill
that silently mis-scores every project it was not written for.

So the policy is LEARNED, per repo, from evidence the run itself produces —
the same Beta-Bernoulli machinery the exploration bandit uses, and the same
doctrine: every number is a learnable prior.

**The features are structural, not lexical.** Nothing here knows what
"ValueError" means:

* ``dispersion`` — the fraction of distinct targets that raise this exception
  when handed guessed inputs. A REJECTION VOCABULARY is dispersed: the library
  says no the same way everywhere. A genuine break is concentrated: one
  function, one path. This is the strongest signal and it is fully
  self-supervised.
* ``class_invariance`` — whether the same exception comes back for valid,
  boundary AND negative inputs alike. If every input class produces it, the
  exception is about the harness guessing, not about any particular value.
* ``conformant`` — whether the value that provoked it CONFORMED to the
  parameter's declared type. ``halve(0)`` where the annotation says ``int`` is
  a legal value the signature invited, so raising on it is the function's
  fault; passing ``None`` to a ``str`` parameter is the harness deliberately
  violating the contract, so raising is correct. This is read off the input
  class, and it is the feature that separates "does not handle its own
  declared domain" from "refused junk".
* ``provenance`` — defined by the repo under test, by the standard library, or
  by a third party. A repo that DEFINES an exception class and raises it is
  stating an API contract. This is read from ``type(exc).__module__``, so it
  needs no list of names.
* ``family`` — the nearest BUILTIN ancestor in the exception's MRO. This is
  Python's own hierarchy, not a curated taxonomy: ``InterpreterError(ValueError)``
  inherits "bad argument" semantics and ``MyThing(RuntimeError)`` inherits
  "something went wrong at runtime", on any repo, including one whose exception
  names nobody has ever seen. Reading the MRO is what makes the policy
  transfer; the per-family base rates below are priors that evidence overrides.
* ``feedback`` — when a downstream verdict confirms or refutes a finding (an
  episode fixed it; a human dismissed it), that lands as real evidence and
  outweighs the priors.

Posteriors persist in ``.vinv/exercise/exception_policy.json`` and decay toward
the uninformative prior between runs, exactly like the bandit's arms: a lesson
learned against a codebase that has since changed must not dominate forever.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import store

# Posterior mean at or above which an exception is REPORTED as a defect.
# Deliberately above 0.5: a false finding costs more than a missed one, because
# a noisy oracle gets switched off entirely.
REPORT_THRESHOLD = 0.6

# Evidence below this much total mass is "not yet known"; the structural priors
# carry the decision and the verdict is marked low-confidence.
MIN_EVIDENCE = 3.0

# How much accumulated evidence survives to the next run.
DECAY = 0.5

# Strength of the structural priors, in pseudo-observations. Small: they are a
# STARTING POINT that a handful of real observations overrides.
_PRIOR_STRENGTH = 2.0


@dataclass
class ExceptionEvidence:
    """Accumulated evidence about one exception signature."""

    key: str
    alpha: float = 1.0  # pseudo-count of "was a defect"
    beta: float = 1.0  # pseudo-count of "was a deliberate refusal"
    targets: set[str] = field(default_factory=set)
    input_classes: set[str] = field(default_factory=set)
    occurrences: int = 0
    confirmed: int = 0  # downstream said: real defect
    refuted: int = 0  # downstream said: not a defect

    def mean(self) -> float:
        return self.alpha / (self.alpha + self.beta)

    def mass(self) -> float:
        return self.alpha + self.beta - 2.0

    def to_json(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "alpha": round(self.alpha, 4),
            "beta": round(self.beta, 4),
            "targets": sorted(self.targets),
            "input_classes": sorted(self.input_classes),
            "occurrences": self.occurrences,
            "confirmed": self.confirmed,
            "refuted": self.refuted,
            "defect_probability": round(self.mean(), 4),
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ExceptionEvidence:
        return cls(
            key=str(data.get("key", "")),
            alpha=float(data.get("alpha", 1.0)),
            beta=float(data.get("beta", 1.0)),
            targets=set(data.get("targets") or []),
            input_classes=set(data.get("input_classes") or []),
            occurrences=int(data.get("occurrences", 0)),
            confirmed=int(data.get("confirmed", 0)),
            refuted=int(data.get("refuted", 0)),
        )


def signature(exception_type: str, provenance: str) -> str:
    """The learning key: the exception type plus where its class is defined.

    Provenance is part of the key because the same NAME means different things
    from different origins — a repo's own ``ValidationError`` is its contract,
    a third party's is that library's.
    """
    return f"{exception_type}@{provenance}"


# Base rate that an exception of each BUILTIN family is a defect. These are
# priors over PYTHON'S OWN hierarchy (every exception, custom or not, inherits
# from one of them), not a per-repo taxonomy — and every one is overridden by a
# handful of real observations.
_FAMILY_PRIOR: dict[str, float] = {
    # "you gave me a bad argument" — the refusal families.
    "TypeError": 0.15,
    "ValueError": 0.15,
    "LookupError": 0.15,
    "AttributeError": 0.25,
    "ArithmeticError": 0.4,
    # Dividing by zero is the CODE doing it, not the caller naming it.
    "ZeroDivisionError": 0.55,
    "NotImplementedError": 0.1,
    # "this machine lacks something" — environment families.
    "OSError": 0.1,
    "ImportError": 0.1,
    "ModuleNotFoundError": 0.1,
    "EOFError": 0.1,
    "SystemExit": 0.1,
    "KeyboardInterrupt": 0.05,
    "TimeoutError": 0.15,
    # "the program itself is broken" — no argument choice justifies these.
    "NameError": 0.9,
    "UnboundLocalError": 0.95,
    "SystemError": 0.9,
    "MemoryError": 0.85,
    "RecursionError": 0.9,
    "SyntaxError": 0.85,
    "IndentationError": 0.85,
    "AssertionError": 0.8,
    "ReferenceError": 0.8,
    "StopIteration": 0.8,
    "GeneratorExit": 0.7,
    # Generic middles.
    "RuntimeError": 0.5,
    "Exception": 0.4,
    "BaseException": 0.4,
}


# Most specific first, DERIVED from the real builtin hierarchy rather than
# hand-ordered: a family listed in _FAMILY_PRIOR but missing from a
# hand-maintained tuple would silently fall through to its base and be scored
# wrong (ZeroDivisionError read as ArithmeticError, verified in test). Sorting
# by MRO depth makes the order a fact about Python, not a list to keep in sync.
def _order_by_specificity(names: tuple[str, ...]) -> tuple[str, ...]:
    import builtins

    def depth(name: str) -> int:
        cls = getattr(builtins, name, None)
        if isinstance(cls, type) and issubclass(cls, BaseException):
            return len(cls.__mro__)
        return 0  # unknown to this interpreter: consider it last

    return tuple(sorted(names, key=lambda n: (-depth(n), n)))


_FAMILY_ORDER: tuple[str, ...] = _order_by_specificity(tuple(_FAMILY_PRIOR))


def family_of(mro_names: list[str] | tuple[str, ...]) -> str:
    """The nearest builtin ancestor in an exception's MRO.

    ``["InterpreterError", "ValueError", "Exception", "BaseException"]`` →
    ``"ValueError"``. Structural: it reads the class hierarchy the target
    itself declared, so a repo-defined exception is scored by what it INHERITS
    rather than by what it is called.
    """
    names = list(mro_names or [])
    for candidate in _FAMILY_ORDER:
        if candidate in names:
            return candidate
    return "Exception"


def provenance_of(error_module: str, repo_packages: set[str]) -> str:
    """``repo`` | ``stdlib`` | ``thirdparty`` | ``unknown`` for an exception class.

    Structural, from ``type(exc).__module__`` — no list of exception names is
    involved, so it behaves the same on a repo nobody has seen.
    """
    if not error_module:
        return "unknown"
    top = error_module.partition(".")[0]
    if top in repo_packages:
        return "repo"
    if top in ("builtins", "__builtin__") or top in _STDLIB_TOP_LEVEL:
        return "stdlib"
    return "thirdparty"


def _stdlib_names() -> frozenset[str]:
    """Top-level stdlib module names, from the interpreter itself.

    ``sys.stdlib_module_names`` is authoritative and version-correct, so this
    is a fact about the running Python rather than a list somebody typed.
    """
    import sys

    return frozenset(getattr(sys, "stdlib_module_names", ()) or ())


_STDLIB_TOP_LEVEL = _stdlib_names()


def structural_prior(
    provenance: str,
    dispersion: float,
    class_invariance: float,
    family: str = "Exception",
    conformant: bool = False,
) -> float:
    """Prior probability that an exception with these features is a DEFECT.

    Pure, monotone function of the structural features — its job is only to be
    a sane starting point before evidence arrives:

    * ``family`` (the builtin ancestor) carries most of the signal, because
      Python's hierarchy already separates "bad argument" from "program broken";
    * a repo-DEFINED exception leans further toward contract, since a codebase
      defines exception classes precisely to refuse things;
    * high dispersion (many distinct targets raise it) reads as a rejection
      vocabulary;
    * high class-invariance (every input class provokes it) reads as "this is
      about our guessing, not about any particular value".
    """
    base = _FAMILY_PRIOR.get(family, 0.5)
    if conformant:
        # The value we supplied was legal for the declared type, so the
        # signature invited it: failing on it is the function's own domain gap.
        base = base + (1.0 - base) * 0.25
    else:
        # We deliberately violated the annotation, so refusing is correct — but
        # only partially discounted: an unbound local is a bug on any input.
        base *= 0.7
    if provenance == "repo":
        base *= 0.6  # the repo defined this class to say no with
    elif provenance == "thirdparty":
        base = min(0.98, base * 1.1)
    penalty = 0.2 * max(0.0, min(1.0, dispersion)) + 0.1 * max(0.0, min(1.0, class_invariance))
    return max(0.02, min(0.98, base - penalty))


class ExceptionPolicy:
    """Learned defect-probability per exception signature, for one repo."""

    def __init__(self, evidence: dict[str, ExceptionEvidence] | None = None):
        self.evidence: dict[str, ExceptionEvidence] = evidence or {}

    # ---- observation -----------------------------------------------------

    def observe(
        self, key: str, *, target: str, input_class: str, is_defect: bool | None = None
    ) -> None:
        """Record one sighting. ``is_defect`` is downstream feedback, if known."""
        ev = self.evidence.setdefault(key, ExceptionEvidence(key=key))
        ev.occurrences += 1
        if target:
            ev.targets.add(target)
        if input_class:
            ev.input_classes.add(input_class)
        if is_defect is True:
            ev.confirmed += 1
            ev.alpha += 1.0
        elif is_defect is False:
            ev.refuted += 1
            ev.beta += 1.0

    def dispersion(self, key: str, total_targets: int) -> float:
        """Fraction of the run's targets that raised this exception."""
        ev = self.evidence.get(key)
        if ev is None or total_targets <= 0:
            return 0.0
        return min(1.0, len(ev.targets) / float(total_targets))

    def class_invariance(self, key: str) -> float:
        """How INVARIANT the exception is across the three input classes (0..1).

        One class is not invariance — it is the opposite, a value-specific
        failure — so a single class scores 0 and only all three score 1.
        """
        ev = self.evidence.get(key)
        if ev is None:
            return 0.0
        return max(0.0, min(1.0, (len(ev.input_classes) - 1) / 2.0))

    # ---- decision --------------------------------------------------------

    def defect_probability(
        self,
        key: str,
        *,
        provenance: str,
        total_targets: int,
        family: str = "Exception",
        conformant: bool = False,
    ) -> tuple[float, bool]:
        """``(probability, confident)`` that this exception signals a defect.

        Combines the structural prior (as ``_PRIOR_STRENGTH``
        pseudo-observations) with whatever real evidence has accumulated, so a
        repo with no history still behaves sensibly and a repo with history
        overrides the prior.
        """
        prior = structural_prior(
            provenance,
            self.dispersion(key, total_targets),
            self.class_invariance(key),
            family,
            conformant,
        )
        ev = self.evidence.get(key)
        alpha = _PRIOR_STRENGTH * prior + (ev.alpha - 1.0 if ev else 0.0)
        beta = _PRIOR_STRENGTH * (1.0 - prior) + (ev.beta - 1.0 if ev else 0.0)
        total = alpha + beta
        probability = alpha / total if total > 0 else prior
        confident = (ev.mass() if ev else 0.0) >= MIN_EVIDENCE
        return probability, confident

    def is_defect(
        self,
        key: str,
        *,
        provenance: str,
        total_targets: int,
        family: str = "Exception",
        conformant: bool = False,
    ) -> bool:
        probability, _ = self.defect_probability(
            key,
            provenance=provenance,
            total_targets=total_targets,
            family=family,
            conformant=conformant,
        )
        return probability >= REPORT_THRESHOLD

    # ---- persistence -----------------------------------------------------

    def to_json(self) -> dict[str, Any]:
        return {
            "version": 1,
            "report_threshold": REPORT_THRESHOLD,
            "learning": (
                "Beta posterior per exception signature (type@provenance). "
                "Features are structural — dispersion across targets, "
                "invariance across input classes, where the class is defined — "
                "so the policy transfers to a repo whose exception vocabulary "
                "nobody has seen."
            ),
            "signatures": {k: ev.to_json() for k, ev in sorted(self.evidence.items())},
        }

    @classmethod
    def load(cls, repo: Path, *, decay: float = DECAY) -> ExceptionPolicy:
        """Load the persisted policy, decaying accumulated evidence."""
        doc = store.read_json(store.exercise_dir(repo) / "exception_policy.json") or {}
        evidence: dict[str, ExceptionEvidence] = {}
        for key, data in (doc.get("signatures") or {}).items():
            if not isinstance(data, dict):
                continue
            ev = ExceptionEvidence.from_json({**data, "key": key})
            # Decay toward the uninformative prior, like the bandit's arms.
            ev.alpha = 1.0 + (ev.alpha - 1.0) * decay
            ev.beta = 1.0 + (ev.beta - 1.0) * decay
            evidence[key] = ev
        return cls(evidence)

    def save(self, repo: Path, logger: logging.Logger | None = None) -> None:
        log = logger or logging.getLogger(__name__)
        store.exercise_dir(repo).mkdir(parents=True, exist_ok=True)
        store.write_json(store.exercise_dir(repo) / "exception_policy.json", self.to_json())
        log.info("exception policy: %d signatures learned", len(self.evidence))


def record_feedback(
    repo: Path,
    key: str,
    *,
    was_defect: bool,
    target: str = "",
    input_class: str = "",
    logger: logging.Logger | None = None,
) -> None:
    """Fold a downstream verdict back into the policy.

    This is the loop closing: an episode that FIXED a reported crash confirms
    the signature; a finding a human dismissed refutes it. Either way the next
    run scores that exception better, on this repo and in this repo's own
    vocabulary.
    """
    policy = ExceptionPolicy.load(repo, decay=1.0)  # no decay when writing back
    policy.observe(key, target=target, input_class=input_class, is_defect=was_defect)
    policy.save(repo, logger=logger)
