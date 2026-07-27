"""Structural PRIORS plus learned evidence for "defect, or deliberate refusal?"

Every oracle that pushes made-up inputs at code hits the same question, and it
is the question that decides whether the tool is useful or ignored. Answering it
with a hand-written list of exception names does not survive contact with a new
repository: the list encodes one codebase's vocabulary, and the next repo
refuses input with ``InterpreterError``, ``ToolValidationError``, ``Problem``,
or something nobody has ever seen. A curated taxonomy is a maintenance treadmill
that silently mis-scores every project it was not written for.

**What actually decides a verdict, stated honestly.** Until evidence arrives the
answer is the STRUCTURAL PRIOR and nothing else — ``_FAMILY_PRIOR`` blended with
provenance, conformance, dispersion and class-invariance. On a repo's first run
that prior IS the policy; ``defect_probability`` reduces to it exactly, and the
verdict is returned with ``confident=False`` to say so. The claim this module
makes is narrower than "learned from scratch": the priors are over PYTHON'S OWN
class hierarchy rather than over one project's vocabulary (so they transfer),
and evidence overrides them as it accumulates.

**Two kinds of information, kept apart — this is the design.** The module is a
hierarchical (empirical-Bayes) model, and the split is what keeps it honest:

* COVARIATES — dispersion, class-invariance, provenance, family, conformance.
  Nobody adjudicated anything to produce them; they are properties of the run.
  They enter the PRIOR MEAN, through ``structural_prior``, carrying
  ``_PRIOR_STRENGTH`` pseudo-observations and not one more. They are *never*
  posted as α/β, because a covariate is not an observation and pretending
  otherwise makes ``mass()`` — and therefore ``MIN_EVIDENCE`` and
  ``confident`` — mean nothing. (An earlier version posted dispersion as up to
  4.0 of β mass, which exceeded ``MIN_EVIDENCE``: a common exception reached
  "confident, not a defect" on ZERO labels, was then never reported, and so
  could never acquire a label. That is a censored-feedback absorbing state, and
  it is the bug this split exists to prevent.)
* LABELS — the likelihood. Only these move α/β:

  * ``observe_differential_rows`` — agreement with an INDEPENDENT oracle. When
    the differential oracle proves the target raised ``E`` on an input CPython
    accepted, that is a labelled defect for ``E``; when both refuse and the
    target names the reference's exception type, that is a labelled refusal.
    Self-supervised but genuinely observed, per row. Bounded by
    ``DIFFERENTIAL_EVIDENCE_CAP``.
  * ``apply_feedback`` / ``record_feedback`` — downstream verdicts: a
    differential adjudication, an episode that fixed a reported crash, a human
    dismissal. Bounded by ``GLOBAL_FEEDBACK_CAP`` per signature and
    ``SITE_FEEDBACK_CAP`` per call site.

Unlabelled sightings (``observe`` with no ``is_defect``) therefore move NO α/β;
they only populate the covariates. ``mass()`` counts labels, and ``confident``
means "labels have been seen", not "the harness has an opinion".

**Reporting is a Thompson draw, not a threshold.** ``is_defect`` draws
``θ ~ Beta(α, β)`` and reports when ``max(mean, θ) >= REPORT_THRESHOLD``. A greedy
threshold on the posterior MEAN is what makes suppression self-sealing under
partial feedback: a signature is only ever labelled if it is reported, so one
below-threshold verdict removes the only path by which it could be corrected.
The draw dissolves that without any re-examination schedule to maintain — a
signature with few labels has a WIDE posterior, is occasionally drawn high, gets
surfaced, gets adjudicated, and sharpens on a real label; a signature with many
refutations has a tight posterior near zero and is drawn high essentially never.
The exploration falls out of the posterior width, exactly as it does for the
bandit arms in ``bandit.py``. The draw only ever ADDS a report — a mean already
above the threshold is reported regardless — because the censoring is
one-directional and randomly dropping a genuine crash would be a worse bug than
the one being fixed. ``rng=None`` keeps the old deterministic mean-vs-threshold
behaviour for callers that need stable output.

**The features are structural, not lexical.** Nothing here knows what
"ValueError" means:

* ``dispersion`` — the share of the targets that raised ANYTHING which raised
  this exception. A REJECTION VOCABULARY is dispersed: the library says no the
  same way everywhere. A genuine break is concentrated: one function, one path.
  This is the strongest signal and it is fully self-supervised. The denominator
  is the raising targets, not every target ever discovered — against all
  targets the same ratio meant "dominant" on a 3-target repo and "inert" on a
  3000-target one, i.e. it was loud exactly where it was least reliable.
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
import random
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import store

# Draw at or above which an exception is REPORTED as a defect. Deliberately
# above 0.5: a false finding costs more than a missed one, because a noisy
# oracle gets switched off entirely.
REPORT_THRESHOLD = 0.6

# LABEL mass below this much is "never actually checked"; the structural priors
# carry the decision and the verdict is marked low-confidence. Only labels count
# toward it — covariates enter the prior, so this number cannot be reached
# without an adjudication, a downstream verdict or an independent oracle.
MIN_EVIDENCE = 3.0

# How much accumulated evidence survives to the next run.
DECAY = 0.5

# Strength of the structural priors, in pseudo-observations. Small: they are a
# STARTING POINT that a handful of real observations overrides. Since the
# covariates enter only here, this is ALL the mass unlabelled information ever
# has — which is why an unlabelled posterior stays wide and gets explored.
_PRIOR_STRENGTH = 2.0

# Floor on each Beta parameter. ``random.betavariate`` needs both strictly
# positive, and a near-zero concentration is meaningless anyway.
_MIN_CONCENTRATION = 1e-3

# The VALUE input classes. "import" and "differential" are provenances of a
# sighting, not classes of value, so they must not count toward invariance —
# feeding a fourth name in while dividing by 2.0 inflated it past 1.0 and made
# every import failure look maximally invariant.
INPUT_CLASSES = ("valid", "boundary", "negative")

# Pseudo-target smoothing for dispersion. One target raising E out of one target
# that raised anything is not evidence of a rejection vocabulary, it is a sample
# of size one; the smoothing makes the estimate saturate from below, so
# dispersion only approaches 1.0 once many targets agree.
DISPERSION_SMOOTHING = 3.0

# Ceiling on evidence mass per source. Every one of these exists to stop an
# ABSORBING STATE: without a cap, N dismissals of one signature drive its
# posterior to zero and the steady state of the oracle is "reports nothing".
# A cap makes the repo-wide belief saturate — the (N+1)th dismissal adds nothing
# — while a call site keeps its own, larger budget.
GLOBAL_FEEDBACK_CAP = 6.0
SITE_FEEDBACK_CAP = 8.0
DIFFERENTIAL_EVIDENCE_CAP = 4.0


@dataclass
class ExceptionEvidence:
    """Accumulated LABELS about one exception signature.

    α/β hold observations only. Dispersion and class-invariance are covariates
    and live in the prior instead, so ``mass()`` is a count of times somebody
    (or an independent oracle) actually said which this was.
    """

    key: str
    alpha: float = 1.0  # pseudo-count of "was a defect"
    beta: float = 1.0  # pseudo-count of "was a deliberate refusal"
    targets: set[str] = field(default_factory=set)
    input_classes: set[str] = field(default_factory=set)
    occurrences: int = 0
    confirmed: int = 0  # downstream said: real defect
    refuted: int = 0  # downstream said: not a defect
    # Mass posted by each LABEL source, tracked separately so each can be capped
    # independently and so an audit can tell one source's belief from another's.
    feedback_mass: float = 0.0  # labelled downstream verdicts
    agreement_mass: float = 0.0  # differential agreement/disagreement

    def mean(self) -> float:
        return self.alpha / (self.alpha + self.beta)

    def mass(self) -> float:
        """Total LABEL mass — what ``MIN_EVIDENCE`` is measured against."""
        return self.alpha + self.beta - 2.0

    def post(self, credit: float, *, defect: bool, budget: float) -> float:
        """Post up to ``budget`` more pseudo-counts of evidence. Returns what landed.

        The caller owns the running total the budget is measured against, so a
        source that has spent its cap simply stops moving the posterior instead
        of overwhelming every other source.
        """
        amount = max(0.0, min(credit, budget))
        if amount <= 0.0:
            return 0.0
        if defect:
            self.alpha += amount
        else:
            self.beta += amount
        return amount

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
            "feedback_mass": round(self.feedback_mass, 4),
            "agreement_mass": round(self.agreement_mass, 4),
            "label_mass": round(self.mass(), 4),
            "defect_probability": round(self.mean(), 4),
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> ExceptionEvidence:
        beta = float(data.get("beta", 1.0))
        # MIGRATION: files written before dispersion became a covariate carry
        # its β mass inside `beta`. Leaving it there would keep an old repo in
        # the very state this module now refuses to enter — suppressed and
        # "confident" on no labels — so it is subtracted back out on load.
        legacy_dispersion = float(data.get("dispersion_beta", 0.0) or 0.0)
        if legacy_dispersion > 0.0:
            beta = max(1.0, beta - legacy_dispersion)
        return cls(
            key=str(data.get("key", "")),
            alpha=float(data.get("alpha", 1.0)),
            beta=beta,
            targets=set(data.get("targets") or []),
            input_classes=set(data.get("input_classes") or []),
            occurrences=int(data.get("occurrences", 0)),
            confirmed=int(data.get("confirmed", 0)),
            refuted=int(data.get("refuted", 0)),
            feedback_mass=float(data.get("feedback_mass", 0.0)),
            agreement_mass=float(data.get("agreement_mass", 0.0)),
        )


def signature(exception_type: str, provenance: str) -> str:
    """The learning key: the exception type plus where its class is defined.

    Provenance is part of the key because the same NAME means different things
    from different origins — a repo's own ``ValidationError`` is its contract,
    a third party's is that library's.
    """
    return f"{exception_type}@{provenance}"


def site_key(key: str, target: str) -> str:
    """The narrower learning key: one signature AT one call site.

    ``Type@provenance`` alone is too coarse for FEEDBACK. Dismissing ten noisy
    ``ValueError@stdlib`` findings from ten unrelated helpers should not silence
    ValueError for the whole repository — under a single global key it did, and
    the result was an absorbing state whose steady behaviour is "reports
    nothing". Verdicts therefore land at the site as well, and the site's own
    evidence outweighs the repo-wide belief when the two disagree.
    """
    return f"{key}#{target}"


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


@dataclass(frozen=True)
class ReportDecision:
    """One reporting decision, with the draw that produced it kept visible."""

    key: str
    target: str
    probability: float  # posterior MEAN
    theta: float  # what the threshold was actually applied to
    reported: bool
    confident: bool  # enough LABEL mass to call this learned
    exploration: bool  # reported by the draw despite a below-threshold mean

    def to_json(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "target": self.target,
            "defect_probability": round(self.probability, 4),
            "theta": round(self.theta, 4),
            "reported": self.reported,
            "confident": self.confident,
            "exploration": self.exploration,
        }


class ExceptionPolicy:
    """Learned defect-probability per exception signature, for one repo."""

    def __init__(
        self,
        evidence: dict[str, ExceptionEvidence] | None = None,
        sites: dict[str, ExceptionEvidence] | None = None,
    ):
        self.evidence: dict[str, ExceptionEvidence] = evidence or {}
        # Per-(signature, call-site) evidence, kept OUT of ``evidence`` so it
        # never pollutes dispersion (a site entry has exactly one target) or the
        # per-signature report.
        self.sites: dict[str, ExceptionEvidence] = sites or {}
        # ONE draw per (signature, site) per policy instance. The decision epoch
        # is the run: a signature judged twice in the same run (clustering, then
        # the verdict tally) must get the same answer both times, or half its
        # rows are reported and the count contradicts the clusters.
        self._draws: dict[tuple[str, str], float] = {}
        # Signatures this instance surfaced BY EXPLORATION — mean below the
        # threshold, draw above it. Reported in the run document so the
        # behaviour is visible rather than mysterious.
        self.exploration_surfaced: set[str] = set()

    def new_epoch(self) -> None:
        """Start a new decision epoch: forget this instance's memoised draws.

        A run is normally one epoch and one ``ExceptionPolicy``, so this exists
        for a long-lived process (and for tests) that reuses an instance across
        what are conceptually separate runs.
        """
        self._draws.clear()

    # ---- observation -----------------------------------------------------

    def observe(
        self, key: str, *, target: str, input_class: str, is_defect: bool | None = None
    ) -> None:
        """Record one sighting. ``is_defect`` is downstream feedback, if known.

        Without ``is_defect`` this moves NO α/β — a sighting is not a verdict —
        it only feeds the structural features. With it the verdict is posted at
        full weight up to ``GLOBAL_FEEDBACK_CAP``, past which the repo-wide
        belief about this signature is saturated.
        """
        ev = self.evidence.setdefault(key, ExceptionEvidence(key=key))
        ev.occurrences += 1
        if target:
            ev.targets.add(target)
        if input_class:
            ev.input_classes.add(input_class)
        if is_defect is None:
            return
        landed = ev.post(1.0, defect=is_defect, budget=GLOBAL_FEEDBACK_CAP - ev.feedback_mass)
        ev.feedback_mass += landed
        if is_defect:
            ev.confirmed += 1
        else:
            ev.refuted += 1

    def observe_site(self, key: str, *, target: str, input_class: str, is_defect: bool) -> None:
        """Post a verdict at ONE call site, on its own larger budget.

        This is what keeps feedback from becoming an absorbing state: the site
        that was actually adjudicated moves fully, and the repo-wide signature
        moves only until its cap.
        """
        if not target:
            return
        sk = site_key(key, target)
        ev = self.sites.setdefault(sk, ExceptionEvidence(key=sk))
        ev.occurrences += 1
        ev.targets.add(target)
        if input_class:
            ev.input_classes.add(input_class)
        landed = ev.post(1.0, defect=is_defect, budget=SITE_FEEDBACK_CAP - ev.feedback_mass)
        ev.feedback_mass += landed
        if is_defect:
            ev.confirmed += 1
        else:
            ev.refuted += 1

    def record_verdict(
        self, key: str, *, target: str = "", input_class: str = "", is_defect: bool
    ) -> None:
        """A downstream verdict, landed at both the signature and the call site."""
        self.observe(key, target=target, input_class=input_class, is_defect=is_defect)
        self.observe_site(key, target=target, input_class=input_class, is_defect=is_defect)

    def raising_targets(self) -> set[str]:
        """Every target that raised ANYTHING this policy has seen.

        The honest denominator for dispersion: the question is "of the targets
        that objected, how many objected THIS way", not "of everything that
        exists".
        """
        out: set[str] = set()
        for ev in self.evidence.values():
            out |= ev.targets
        return out

    def dispersion(self, key: str, total_targets: int = 0) -> float:
        """Share of the RAISING targets that raised this exception (0..1).

        ``total_targets`` is retained as an upper bound on the raising set —
        persisted evidence can name targets a smaller later run never
        discovered — but it is no longer the denominator. Dividing by every
        discovered target made the same ratio read as ~0.67 (dominant, and
        estimated from three samples) on a small repo and ~0.10 (inert) on a
        large one: loud exactly where it was least reliable, silent exactly
        where it would have been trustworthy.

        ``DISPERSION_SMOOTHING`` pseudo-targets in the denominator make the
        estimate saturate from below, so one target raising E out of one raising
        target scores 0.25 rather than a spurious 1.0.
        """
        ev = self.evidence.get(key)
        if ev is None or not ev.targets:
            return 0.0
        raising = len(self.raising_targets())
        if total_targets > 0:
            raising = min(raising, total_targets)
        denominator = max(raising, len(ev.targets)) + DISPERSION_SMOOTHING
        return max(0.0, min(1.0, len(ev.targets) / denominator))

    def class_invariance(self, key: str) -> float:
        """How INVARIANT the exception is across the VALUE input classes (0..1).

        One class is not invariance — it is the opposite, a value-specific
        failure — so a single class scores 0 and only all of ``INPUT_CLASSES``
        scores 1. Only members of ``INPUT_CLASSES`` count: "import" and
        "differential" describe where a sighting came from, not what value
        provoked it, and counting them inflated invariance past 1.0.
        """
        ev = self.evidence.get(key)
        if ev is None:
            return 0.0
        seen = len(ev.input_classes & set(INPUT_CLASSES))
        span = max(1, len(INPUT_CLASSES) - 1)
        return max(0.0, min(1.0, (seen - 1) / float(span)))

    # ---- decision --------------------------------------------------------

    def posterior(
        self,
        key: str,
        *,
        provenance: str,
        total_targets: int,
        family: str = "Exception",
        conformant: bool = False,
        target: str = "",
    ) -> tuple[float, float]:
        """``(α, β)`` of the posterior this signature is judged on.

        The structural prior enters as ``_PRIOR_STRENGTH`` pseudo-observations
        and the COVARIATES enter through it — that is the whole of their
        influence. Everything added on top is a label.

        When ``target`` names a call site with its own adjudicated evidence,
        that site DOMINATES: the repo-wide signature is shrunk by
        ``1/(1+site_mass)``. A signature dismissed across ten unrelated helpers
        can therefore still be reported at an eleventh site that was actually
        confirmed, which is the property a single global key destroyed.
        """
        prior = structural_prior(
            provenance,
            self.dispersion(key, total_targets),
            self.class_invariance(key),
            family,
            conformant,
        )
        ev = self.evidence.get(key)
        site = self.sites.get(site_key(key, target)) if target else None
        site_alpha = (site.alpha - 1.0) if site else 0.0
        site_beta = (site.beta - 1.0) if site else 0.0
        site_mass = site_alpha + site_beta
        shrink = 1.0 / (1.0 + site_mass)
        alpha = _PRIOR_STRENGTH * prior + (ev.alpha - 1.0 if ev else 0.0) * shrink + site_alpha
        beta = _PRIOR_STRENGTH * (1.0 - prior) + (ev.beta - 1.0 if ev else 0.0) * shrink + site_beta
        return max(_MIN_CONCENTRATION, alpha), max(_MIN_CONCENTRATION, beta)

    def label_mass(self, key: str, target: str = "") -> float:
        """How much of an actual LABEL this signature (at this site) rests on."""
        ev = self.evidence.get(key)
        site = self.sites.get(site_key(key, target)) if target else None
        return (ev.mass() if ev else 0.0) + (site.mass() if site else 0.0)

    def defect_probability(
        self,
        key: str,
        *,
        provenance: str,
        total_targets: int,
        family: str = "Exception",
        conformant: bool = False,
        target: str = "",
    ) -> tuple[float, bool]:
        """``(posterior mean, confident)`` that this exception signals a defect.

        With NO labels this reduces exactly to the structural prior and
        ``confident`` is False — the honest state of a first run. ``confident``
        counts LABEL mass only, so no amount of self-supervised structure can
        manufacture it.
        """
        alpha, beta = self.posterior(
            key,
            provenance=provenance,
            total_targets=total_targets,
            family=family,
            conformant=conformant,
            target=target,
        )
        return alpha / (alpha + beta), self.label_mass(key, target) >= MIN_EVIDENCE

    def decide(
        self,
        key: str,
        *,
        provenance: str,
        total_targets: int,
        family: str = "Exception",
        conformant: bool = False,
        target: str = "",
        rng: random.Random | None = None,
    ) -> ReportDecision:
        """Decide whether to REPORT this exception, by a Thompson draw.

        ``rng`` given (what ``run_functions`` does, and through it the campaign):
        draw ``θ ~ Beta(α, β)`` and report on ``θ >= REPORT_THRESHOLD``. The
        draw is memoised per ``(key, target)`` for the life of this instance, so
        one run is one decision epoch.

        ``rng=None`` (the default, what ``call_verdict``'s direct callers and
        every summary path use): ``θ`` is the posterior MEAN, which is the old
        deterministic threshold exactly — stable output for anything that needs
        to be reproducible without carrying a seed.

        The draw is applied in ONE DIRECTION: it can only ADD a report, never
        remove one (``reported = mean >= t or θ >= t``). The pathology being
        fixed is one-directional — suppression censors its own feedback, while
        a report earns a label either way — so the correction is too. A
        symmetric draw would also silence a signature whose mean is safely above
        the threshold, i.e. drop a genuine crash at random, which is a worse
        failure than the one being repaired.
        """
        alpha, beta = self.posterior(
            key,
            provenance=provenance,
            total_targets=total_targets,
            family=family,
            conformant=conformant,
            target=target,
        )
        probability = alpha / (alpha + beta)
        if rng is None:
            theta = probability
        else:
            slot = (key, target)
            if slot not in self._draws:
                self._draws[slot] = rng.betavariate(alpha, beta)
            theta = self._draws[slot]
        reported = probability >= REPORT_THRESHOLD or theta >= REPORT_THRESHOLD
        exploration = reported and probability < REPORT_THRESHOLD
        if exploration:
            self.exploration_surfaced.add(key)
        return ReportDecision(
            key=key,
            target=target,
            probability=probability,
            theta=theta,
            reported=reported,
            confident=self.label_mass(key, target) >= MIN_EVIDENCE,
            exploration=exploration,
        )

    def is_defect(
        self,
        key: str,
        *,
        provenance: str,
        total_targets: int,
        family: str = "Exception",
        conformant: bool = False,
        target: str = "",
        rng: random.Random | None = None,
    ) -> bool:
        return self.decide(
            key,
            provenance=provenance,
            total_targets=total_targets,
            family=family,
            conformant=conformant,
            target=target,
            rng=rng,
        ).reported

    # ---- persistence -----------------------------------------------------

    def to_json(self) -> dict[str, Any]:
        return {
            "version": 1,
            "report_threshold": REPORT_THRESHOLD,
            "learning": (
                "Beta posterior per exception signature (type@provenance), plus "
                "per call site (type@provenance#target). Alpha/beta hold LABELS "
                "only (differential agreement, adjudications, downstream "
                "verdicts), each source capped so none can drive a signature to "
                "an absorbing state. Unlabelled structure (dispersion, "
                "class-invariance, provenance, family, conformance) is a "
                "covariate and enters the PRIOR MEAN instead, so `confident` "
                "means labels were seen. Reporting is a Thompson draw against "
                "the threshold, not a greedy cut on the mean: a thinly labelled "
                "signature has a wide posterior and is periodically surfaced "
                "for adjudication, which is what stops suppression from "
                "censoring its own feedback."
            ),
            "caps": {
                "global_feedback": GLOBAL_FEEDBACK_CAP,
                "site_feedback": SITE_FEEDBACK_CAP,
                "differential_agreement": DIFFERENTIAL_EVIDENCE_CAP,
            },
            "signatures": {k: ev.to_json() for k, ev in sorted(self.evidence.items())},
            "sites": {k: ev.to_json() for k, ev in sorted(self.sites.items())},
        }

    @classmethod
    def load(cls, repo: Path, *, decay: float = DECAY) -> ExceptionPolicy:
        """Load the persisted policy, decaying accumulated evidence."""
        doc = store.read_json(store.exercise_dir(repo) / "exception_policy.json") or {}

        def _bucket(name: str) -> dict[str, ExceptionEvidence]:
            out: dict[str, ExceptionEvidence] = {}
            for key, data in (doc.get(name) or {}).items():
                if not isinstance(data, dict):
                    continue
                ev = ExceptionEvidence.from_json({**data, "key": key})
                # Decay toward the uninformative prior, like the bandit's arms.
                ev.alpha = 1.0 + (ev.alpha - 1.0) * decay
                ev.beta = 1.0 + (ev.beta - 1.0) * decay
                # The per-source budgets decay with the mass they bought, so a
                # source is free to re-earn its influence from THIS run's
                # observations rather than being locked out by a spent cap.
                ev.feedback_mass *= decay
                ev.agreement_mass *= decay
                out[key] = ev
            return out

        return cls(_bucket("signatures"), _bucket("sites"))

    def save(self, repo: Path, logger: logging.Logger | None = None) -> None:
        log = logger or logging.getLogger(__name__)
        store.exercise_dir(repo).mkdir(parents=True, exist_ok=True)
        store.write_json(store.exercise_dir(repo) / "exception_policy.json", self.to_json())
        log.info("exception policy: %d signatures learned", len(self.evidence))


# =========================================================================
# Feedback — the documented way a downstream verdict reaches the policy
# =========================================================================


@dataclass(frozen=True)
class Feedback:
    """One adjudicated verdict about one exception at one call site.

    ``is_defect`` is the label: True when something downstream confirmed the
    finding (an episode fixed it, an adjudication said ``defect``), False when
    it was refuted (a human dismissed it, an adjudication said ``policy``).
    """

    key: str
    is_defect: bool
    target: str = ""
    input_class: str = ""
    source: str = "downstream"

    def to_json(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "is_defect": self.is_defect,
            "target": self.target,
            "input_class": self.input_class,
            "source": self.source,
        }


def apply_feedback(
    repo: Path,
    verdicts: Iterable[Feedback | dict[str, Any]],
    *,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Fold downstream verdicts back into the persisted policy. THE public hook.

    This is the loop closing: an episode that FIXED a reported crash confirms
    the signature; a finding a human dismissed refutes it; a differential
    adjudication of ``policy`` says the refusal was deliberate. Either way the
    next run scores that exception better, on this repo and in this repo's own
    vocabulary.

    Every verdict lands twice — once on the signature (capped, so a run of
    dismissals cannot silence an exception type repo-wide) and once on the call
    site (which then outweighs the signature). Loading uses ``decay=1.0``: a
    write-back must not also age the evidence it is adding to.
    """
    log = logger or logging.getLogger(__name__)
    policy = ExceptionPolicy.load(repo, decay=1.0)
    applied: list[Feedback] = []
    for item in verdicts:
        fb = item if isinstance(item, Feedback) else _feedback_from_dict(item)
        if fb is None:
            continue
        policy.record_verdict(
            fb.key,
            target=fb.target,
            input_class=fb.input_class,
            is_defect=fb.is_defect,
        )
        applied.append(fb)
    if applied:
        policy.save(repo, logger=log)
    log.info("exception policy: %d downstream verdict(s) applied", len(applied))
    return {
        "applied": len(applied),
        "confirmed": sum(1 for f in applied if f.is_defect),
        "refuted": sum(1 for f in applied if not f.is_defect),
        "verdicts": [f.to_json() for f in applied],
    }


def _feedback_from_dict(item: dict[str, Any]) -> Feedback | None:
    if not isinstance(item, dict):
        return None
    key = str(item.get("key") or "")
    label = item.get("is_defect")
    if not key or not isinstance(label, bool):
        return None
    return Feedback(
        key=key,
        is_defect=label,
        target=str(item.get("target") or ""),
        input_class=str(item.get("input_class") or ""),
        source=str(item.get("source") or "downstream"),
    )


def record_feedback(
    repo: Path,
    key: str,
    *,
    was_defect: bool,
    target: str = "",
    input_class: str = "",
    logger: logging.Logger | None = None,
) -> None:
    """Single-verdict convenience wrapper over :func:`apply_feedback`."""
    apply_feedback(
        repo,
        [Feedback(key=key, is_defect=was_defect, target=target, input_class=input_class)],
        logger=logger,
    )


def provenance_for_exception_name(
    name: str, module: str, repo_packages: set[str] | frozenset[str]
) -> str:
    """Provenance when only the exception's NAME is on hand.

    The differential oracle's rows carry ``type(exc).__name__`` but not always
    ``__module__``. With a module, this is ordinary ``provenance_of``; without
    one, a name the running interpreter knows as a builtin is stdlib and
    anything else is unknown — still structural, still no list of names.
    """
    if module:
        return provenance_of(module, set(repo_packages))
    import builtins

    cls = getattr(builtins, name, None)
    if isinstance(cls, type) and issubclass(cls, BaseException):
        return "stdlib"
    return "unknown"


def feedback_from_adjudications(
    doc: dict[str, Any] | None,
    *,
    repo_packages: set[str] | frozenset[str] = frozenset(),
) -> tuple[list[Feedback], int]:
    """Convert ``adjudications.json`` verdicts into feedback. ``(feedback, skipped)``.

    The differential oracle's layer-2 adjudications are exactly the labels this
    policy has never had: ``"policy"`` means the refusal was deliberate
    (``is_defect=False``), ``"defect"`` means it was not (``is_defect=True``).

    An entry must name the exception for a signature to be built. Entries that
    do not are COUNTED and skipped rather than guessed at — the count is the
    honest measure of how much of this label source is currently unreachable.
    """
    out: list[Feedback] = []
    skipped = 0
    for entry in ((doc or {}).get("verdicts") or {}).values():
        if not isinstance(entry, dict):
            skipped += 1
            continue
        verdict = entry.get("verdict")
        if verdict not in ("policy", "defect"):
            continue  # still awaiting adjudication: not a label
        name = str(entry.get("exception") or "")
        if not name:
            skipped += 1
            continue
        provenance = provenance_for_exception_name(
            name, str(entry.get("exception_module") or ""), repo_packages
        )
        out.append(
            Feedback(
                key=signature(name, provenance),
                is_defect=(verdict == "defect"),
                target=str(entry.get("target") or ""),
                input_class="differential",
                source="adjudication",
            )
        )
    return out, skipped


# =========================================================================
# Self-supervision — evidence that needs no human
# =========================================================================


def observe_differential_rows(
    policy: ExceptionPolicy,
    rows: Iterable[dict[str, Any]],
    *,
    repo_packages: set[str] | frozenset[str] = frozenset(),
) -> dict[str, int]:
    """Label exceptions by AGREEMENT with an independent oracle. Self-supervised.

    The differential oracle runs the same input through the target and through
    CPython, which turns a sighting into a labelled example without anyone
    adjudicating anything:

    * reference ACCEPTED the input and the target RAISED — the target refused
      something legal, so that exception was a defect at that target;
    * both raised and the target NAMED the reference's exception type — the
      target refused the same thing for the same reason, so that exception is
      working refusal vocabulary.

    Rows where both raised and the types disagree are left alone: that is a
    wrong-exception finding for the differential oracle to report, not a label
    about whether the exception type means defect.

    Bounded by ``DIFFERENTIAL_EVIDENCE_CAP`` per signature, so a large corpus
    cannot bury human feedback or drive a signature to an absorbing state.
    """
    counts = {"defect": 0, "refusal": 0, "skipped": 0}
    for row in rows:
        if row.get("phase") != "compare":
            counts["skipped"] += 1
            continue
        ref = row.get("reference") or {}
        got = row.get("got") or {}
        name = str(got.get("exception") or "")
        if got.get("ok") or not name:
            continue  # the target did not raise: nothing to label
        if ref.get("ok"):
            label, bucket = True, "defect"
        else:
            ref_name = str(ref.get("exception") or "")
            blob = f"{name} {got.get('message') or ''}"
            if not ref_name or ref_name not in blob:
                continue  # a wrong-exception finding, not a label
            label, bucket = False, "refusal"
        provenance = provenance_for_exception_name(
            name, str(got.get("module") or ""), repo_packages
        )
        key = signature(name, provenance)
        target = str(row.get("target") or "")
        ev = policy.evidence.setdefault(key, ExceptionEvidence(key=key))
        ev.occurrences += 1
        if target:
            ev.targets.add(target)
        ev.input_classes.add("differential")
        landed = ev.post(1.0, defect=label, budget=DIFFERENTIAL_EVIDENCE_CAP - ev.agreement_mass)
        ev.agreement_mass += landed
        if landed > 0.0:
            counts[bucket] += 1
    return counts


# NOTE. There used to be an ``apply_dispersion_evidence`` here, posting
# dispersion as up to 4.0 of β mass "so the posterior can move without a human".
# It is gone, and deliberately not replaced. Dispersion is a covariate, not an
# observation: as evidence it exceeded ``MIN_EVIDENCE`` on its own, so a common
# exception became suppressed AND "confident" with zero labels, and — because
# suppression is what stops a finding being reported and reporting is what earns
# a label — nothing could ever revise it. Dispersion still does its job, in
# ``structural_prior``, where a covariate belongs; the run-level sightings that
# feed it persist in ``ExceptionEvidence.targets``.
