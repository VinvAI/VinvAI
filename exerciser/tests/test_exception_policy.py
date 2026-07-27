"""The LEARNED exception policy — and, above all, that it TRANSFERS.

A hand-written list of exception names scores one codebase correctly and every
other one wrong. These tests pin the properties that make the policy general:
it reads Python's own class hierarchy rather than names, it learns a repo's
rejection vocabulary from dispersion, and downstream feedback moves it.
"""

from __future__ import annotations

from pathlib import Path

from exerciser import store
from exerciser.exception_policy import (
    MIN_EVIDENCE,
    REPORT_THRESHOLD,
    ExceptionPolicy,
    family_of,
    provenance_of,
    record_feedback,
    signature,
    structural_prior,
)

# ---- structural features ---------------------------------------------------


def test_family_reads_the_class_hierarchy_not_the_name():
    # An exception nobody has ever seen is scored by what it INHERITS. This is
    # the property that makes the policy work on a repo with its own
    # vocabulary — no list of names is consulted.
    assert family_of(["WidgetPolicyError", "ValueError", "Exception"]) == "ValueError"
    assert family_of(["Kaboom", "UnboundLocalError", "NameError", "Exception"]) == (
        "UnboundLocalError"
    )
    assert family_of(["Whatever", "Exception", "BaseException"]) == "Exception"


def test_family_order_is_derived_not_hand_maintained():
    # A hand-ordered tuple silently mis-scored ZeroDivisionError as its base
    # ArithmeticError. The order now comes from the real MRO depth, so every
    # family with a prior is reachable.
    from exerciser.exception_policy import _FAMILY_ORDER, _FAMILY_PRIOR

    assert set(_FAMILY_ORDER) == set(_FAMILY_PRIOR)
    assert family_of(["ZeroDivisionError", "ArithmeticError", "Exception"]) == ("ZeroDivisionError")


def test_provenance_is_structural():
    repo_pkgs = {"myapp", "examples"}
    assert provenance_of("myapp.errors", repo_pkgs) == "repo"
    assert provenance_of("examples.thing", repo_pkgs) == "repo"
    assert provenance_of("builtins", repo_pkgs) == "stdlib"
    assert provenance_of("json.decoder", repo_pkgs) == "stdlib"
    assert provenance_of("somevendor.sdk", repo_pkgs) == "thirdparty"
    assert provenance_of("", repo_pkgs) == "unknown"


def test_a_repo_defined_exception_leans_toward_contract():
    # A codebase defines exception classes precisely to refuse things.
    own = structural_prior("repo", 0.0, 0.0, "ValueError", conformant=True)
    foreign = structural_prior("thirdparty", 0.0, 0.0, "ValueError", conformant=True)
    assert own < foreign


def test_conformance_separates_domain_gap_from_refused_junk():
    # 0 IS an int: a function whose annotation says int must handle it.
    legal = structural_prior("stdlib", 0.0, 0.0, "ZeroDivisionError", conformant=True)
    junk = structural_prior("stdlib", 0.0, 0.0, "ZeroDivisionError", conformant=False)
    assert legal >= REPORT_THRESHOLD > junk


def test_dispersion_pushes_a_rejection_vocabulary_down():
    concentrated = structural_prior("stdlib", 0.0, 0.0, "RuntimeError", conformant=True)
    everywhere = structural_prior("stdlib", 1.0, 1.0, "RuntimeError", conformant=True)
    assert everywhere < concentrated, "raised by every target = the way it says no"


# ---- learning --------------------------------------------------------------


def test_invariance_needs_more_than_one_class():
    # One class is not invariance — it is a value-specific failure, which is
    # the interesting case.
    policy = ExceptionPolicy()
    key = signature("ValueError", "stdlib")
    policy.observe(key, target="a:f", input_class="boundary")
    assert policy.class_invariance(key) == 0.0
    policy.observe(key, target="a:f", input_class="valid")
    policy.observe(key, target="a:f", input_class="negative")
    assert policy.class_invariance(key) == 1.0


def test_dispersion_is_measured_against_the_run():
    policy = ExceptionPolicy()
    key = signature("ValueError", "stdlib")
    for i in range(5):
        policy.observe(key, target=f"mod:f{i}", input_class="valid")
    assert policy.dispersion(key, total_targets=10) == 0.5
    assert policy.dispersion(key, total_targets=0) == 0.0


def test_a_repos_own_rejection_vocabulary_is_learned_from_dispersion():
    # An unseen exception raised by MANY targets is how this codebase says no,
    # whatever it is called — no name list required.
    policy = ExceptionPolicy()
    key = signature("HouseStyleError", "thirdparty")
    for i in range(20):
        policy.observe(key, target=f"pkg.mod:f{i}", input_class="valid")
        policy.observe(key, target=f"pkg.mod:f{i}", input_class="negative")
    probability, _ = policy.defect_probability(
        key, provenance="thirdparty", total_targets=20, family="Exception", conformant=True
    )
    assert probability < REPORT_THRESHOLD


def test_feedback_outweighs_the_prior():
    # Confirmed findings must be able to overturn a low prior: a repo that
    # really does break with its own exception type gets learned.
    policy = ExceptionPolicy()
    key = signature("QuietError", "repo")
    for _ in range(12):
        policy.observe(key, target="pkg:f", input_class="valid", is_defect=True)
    probability, confident = policy.defect_probability(
        key, provenance="repo", total_targets=4, family="ValueError", conformant=True
    )
    assert probability >= REPORT_THRESHOLD
    assert confident


def test_refutations_silence_a_noisy_signature():
    policy = ExceptionPolicy()
    key = signature("Boom", "thirdparty")
    for _ in range(12):
        policy.observe(key, target="pkg:f", input_class="valid", is_defect=False)
    probability, _ = policy.defect_probability(
        key, provenance="thirdparty", total_targets=4, family="NameError", conformant=True
    )
    assert probability < REPORT_THRESHOLD, "a dismissed finding must stop firing"


def test_confidence_needs_real_evidence():
    policy = ExceptionPolicy()
    key = signature("X", "stdlib")
    _, confident = policy.defect_probability(
        key, provenance="stdlib", total_targets=1, family="ValueError"
    )
    assert not confident
    for _ in range(int(MIN_EVIDENCE) + 1):
        policy.observe(key, target="p:f", input_class="valid", is_defect=True)
    _, confident = policy.defect_probability(
        key, provenance="stdlib", total_targets=1, family="ValueError"
    )
    assert confident


# ---- persistence -----------------------------------------------------------


def test_evidence_persists_and_decays(tmp_path: Path):
    policy = ExceptionPolicy()
    key = signature("Sticky", "repo")
    for _ in range(10):
        policy.observe(key, target="p:f", input_class="valid", is_defect=True)
    before = policy.evidence[key].alpha
    policy.save(tmp_path)

    reloaded = ExceptionPolicy.load(tmp_path)
    after = reloaded.evidence[key].alpha
    assert 1.0 < after < before, "learning persists across runs but expires"
    assert reloaded.evidence[key].targets == {"p:f"}


def test_feedback_round_trips_through_disk(tmp_path: Path):
    store.exercise_dir(tmp_path).mkdir(parents=True)
    key = signature("Real", "repo")
    record_feedback(tmp_path, key, was_defect=True, target="p:f", input_class="valid")
    record_feedback(tmp_path, key, was_defect=True, target="p:g", input_class="valid")
    doc = store.read_json(store.exercise_dir(tmp_path) / "exception_policy.json")
    assert doc["signatures"][key]["confirmed"] == 2
    assert doc["signatures"][key]["defect_probability"] > 0.5


def test_a_fresh_repo_has_no_policy_and_still_decides(tmp_path: Path):
    policy = ExceptionPolicy.load(tmp_path)
    assert policy.evidence == {}
    # With zero history the structural priors still separate the two cases.
    assert policy.is_defect(
        signature("UnboundLocalError", "stdlib"),
        provenance="stdlib",
        total_targets=5,
        family="UnboundLocalError",
        conformant=True,
    )
    assert not policy.is_defect(
        signature("ValueError", "stdlib"),
        provenance="stdlib",
        total_targets=5,
        family="ValueError",
        conformant=True,
    )
