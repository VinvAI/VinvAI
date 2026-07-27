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
    DIFFERENTIAL_EVIDENCE_CAP,
    DISPERSION_EVIDENCE_CAP,
    GLOBAL_FEEDBACK_CAP,
    MIN_EVIDENCE,
    REPORT_THRESHOLD,
    ExceptionPolicy,
    Feedback,
    apply_dispersion_evidence,
    apply_feedback,
    family_of,
    feedback_from_adjudications,
    observe_differential_rows,
    provenance_of,
    record_feedback,
    signature,
    site_key,
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


def test_dispersion_is_measured_against_the_targets_that_raised():
    # The denominator is the targets that raised ANYTHING, not every target
    # ever discovered. "5 of the 5 objectors said ValueError" is a rejection
    # vocabulary whether the repo has 10 functions or 10,000.
    policy = ExceptionPolicy()
    key = signature("ValueError", "stdlib")
    for i in range(5):
        policy.observe(key, target=f"mod:f{i}", input_class="valid")
    assert policy.dispersion(key) == policy.dispersion(key, total_targets=10_000)
    assert policy.dispersion(key) > 0.5
    # An unseen signature disperses over nothing.
    assert policy.dispersion(signature("Other", "stdlib")) == 0.0


def test_dispersion_no_longer_depends_on_repo_size():
    # M4: dividing by ALL targets made the SAME evidence read as ~0.67
    # (dominant, from three samples) on a small repo and ~0.10 (inert) on a
    # large one — loud exactly where it was least reliable. The share of
    # RAISING targets is a property of the evidence, not of the repo's size.
    def dispersion_for(total_targets: int) -> float:
        policy = ExceptionPolicy()
        key = signature("Refuses", "repo")
        for i in range(3):
            policy.observe(key, target=f"mod:f{i}", input_class="valid")
        return policy.dispersion(key, total_targets=total_targets)

    tiny, huge = dispersion_for(3), dispersion_for(3000)
    assert tiny == huge, "the same evidence must mean the same thing at any repo size"


def test_dispersion_saturates_rather_than_spiking_on_one_sample():
    # One target raising E out of one target that raised anything is a sample of
    # size one, not proof of a vocabulary.
    policy = ExceptionPolicy()
    key = signature("Lonely", "repo")
    policy.observe(key, target="mod:f", input_class="valid")
    assert policy.dispersion(key) < 0.3

    many = ExceptionPolicy()
    for i in range(50):
        many.observe(key, target=f"mod:f{i}", input_class="valid")
    assert many.dispersion(key) > 0.9, "and it must still reach ~1 when many agree"


def test_invariance_counts_only_the_value_input_classes():
    # M-minor: "import" is a provenance, not a class of value. Counting it while
    # dividing by 2.0 inflated invariance for every import failure.
    policy = ExceptionPolicy()
    key = signature("Boom", "repo")
    for cls in ("valid", "boundary", "negative", "import", "differential"):
        policy.observe(key, target="mod:f", input_class=cls)
    assert policy.class_invariance(key) == 1.0, "capped at 1.0, not inflated past it"

    imports_only = ExceptionPolicy()
    imports_only.observe(key, target="mod:f", input_class="import")
    imports_only.observe(key, target="mod:g", input_class="differential")
    assert imports_only.class_invariance(key) == 0.0


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


# ---- the policy actually learns ---------------------------------------------


def test_unlabelled_sightings_alone_move_nothing_and_say_so():
    # The honest baseline, pinned so the docstring cannot drift from it: without
    # a label the posterior does not move, mass stays 0, and the verdict is
    # returned as NOT confident — the structural prior is doing all the work.
    policy = ExceptionPolicy()
    key = signature("Mystery", "repo")
    for i in range(50):
        policy.observe(key, target=f"m:f{i}", input_class="valid")
    ev = policy.evidence[key]
    assert (ev.alpha, ev.beta) == (1.0, 1.0)
    assert ev.mass() == 0.0
    _, confident = policy.defect_probability(key, provenance="repo", total_targets=50)
    assert not confident


def test_dispersion_self_supervision_moves_the_posterior_for_real():
    # M-critical: dispersion used to be only a prior penalty, so the posterior
    # never moved and MIN_EVIDENCE was unreachable without a human. It is now
    # posted as real beta mass.
    policy = ExceptionPolicy()
    key = signature("HouseStyle", "repo")
    for i in range(30):
        policy.observe(key, target=f"pkg:f{i}", input_class="valid")

    before = policy.evidence[key].beta
    posted = apply_dispersion_evidence(policy)
    after = policy.evidence[key].beta
    assert after > before, "the strongest self-supervised signal must be evidence"
    assert posted[key] > 0
    _, confident = policy.defect_probability(key, provenance="repo", total_targets=30)
    assert confident, "the policy can now become confident with no human at all"


def test_dispersion_self_supervision_is_capped_and_cannot_run_away():
    policy = ExceptionPolicy()
    key = signature("Everywhere", "repo")
    for i in range(200):
        policy.observe(key, target=f"pkg:f{i}", input_class="valid")
    for _ in range(20):  # every run re-derives it; it must TOP UP, not compound
        apply_dispersion_evidence(policy)
    assert policy.evidence[key].dispersion_beta <= DISPERSION_EVIDENCE_CAP
    assert policy.evidence[key].beta <= 1.0 + DISPERSION_EVIDENCE_CAP


def test_a_single_target_is_not_dispersion():
    # One function raising is a value-specific failure — the interesting case —
    # not a rejection vocabulary, so nothing is posted.
    policy = ExceptionPolicy()
    key = signature("OnlyHere", "repo")
    for _ in range(20):
        policy.observe(key, target="pkg:f", input_class="valid")
    apply_dispersion_evidence(policy)
    assert policy.evidence[key].dispersion_beta == 0.0


def test_differential_agreement_labels_a_defect_without_a_human():
    # CPython accepted the input and the target raised: that is proof, from an
    # INDEPENDENT oracle, that the exception was a defect at that target.
    policy = ExceptionPolicy()
    rows = [
        {
            "phase": "compare",
            "target": "pkg:evaluate",
            "snippet": "1 + 1",
            "reference": {"ok": True, "value": "2"},
            "got": {"ok": False, "exception": "InterpreterError", "message": "nope"},
        }
    ] * 3
    counts = observe_differential_rows(policy, rows)
    assert counts["defect"] == 3
    key = signature("InterpreterError", "unknown")
    assert policy.evidence[key].alpha > 1.0
    assert policy.evidence[key].mass() > 0


def test_differential_agreement_labels_a_refusal_vocabulary():
    # Both refused AND the target named the reference's type: it refused the
    # same thing for the same reason, so the exception is working refusal.
    policy = ExceptionPolicy()
    rows = [
        {
            "phase": "compare",
            "target": "pkg:evaluate",
            "reference": {"ok": False, "exception": "SyntaxError"},
            "got": {"ok": False, "exception": "SyntaxError", "message": "bad syntax"},
        }
    ] * 3
    counts = observe_differential_rows(policy, rows)
    assert counts["refusal"] == 3
    assert policy.evidence[signature("SyntaxError", "stdlib")].beta > 1.0


def test_a_disagreement_on_exception_type_is_not_a_label():
    # That is a wrong-exception FINDING for the differential oracle to report,
    # not evidence about what the exception type means.
    policy = ExceptionPolicy()
    rows = [
        {
            "phase": "compare",
            "target": "pkg:evaluate",
            "reference": {"ok": False, "exception": "SyntaxError"},
            "got": {"ok": False, "exception": "KeyError", "message": "x"},
        }
    ]
    counts = observe_differential_rows(policy, rows)
    assert counts == {"defect": 0, "refusal": 0, "skipped": 0}
    assert policy.evidence == {}


def test_differential_evidence_is_capped():
    policy = ExceptionPolicy()
    rows = [
        {
            "phase": "compare",
            "target": f"pkg:f{i}",
            "reference": {"ok": True, "value": "2"},
            "got": {"ok": False, "exception": "Boom", "message": "m"},
        }
        for i in range(500)
    ]
    observe_differential_rows(policy, rows)
    ev = policy.evidence[signature("Boom", "unknown")]
    assert ev.agreement_mass <= DIFFERENTIAL_EVIDENCE_CAP
    assert ev.alpha <= 1.0 + DIFFERENTIAL_EVIDENCE_CAP


# ---- the feedback hook -------------------------------------------------------


def test_apply_feedback_is_the_public_hook(tmp_path: Path):
    key = signature("Wrong", "repo")
    summary = apply_feedback(
        tmp_path,
        [
            Feedback(key=key, is_defect=True, target="pkg:f", input_class="valid"),
            {"key": key, "is_defect": True, "target": "pkg:f", "input_class": "valid"},
            {"key": key, "is_defect": None},  # not a label: ignored
        ],
    )
    assert summary["applied"] == 2 and summary["confirmed"] == 2
    doc = store.read_json(store.exercise_dir(tmp_path) / "exception_policy.json")
    assert doc["signatures"][key]["confirmed"] == 2
    # The verdict lands at the CALL SITE too, which is what stops one noisy
    # signature from being silenced repo-wide.
    assert f"{key}#pkg:f" in doc["sites"]


def test_adjudications_become_feedback():
    # differential.py's adjudications.json verdicts are exactly the labels this
    # policy never had: "policy" => deliberate refusal, "defect" => a real bug.
    doc = {
        "verdicts": {
            "k1": {"verdict": "policy", "target": "pkg:e", "exception": "InterpreterError"},
            "k2": {"verdict": "defect", "target": "pkg:e", "exception": "KeyError"},
            "k3": {"verdict": None, "target": "pkg:e", "exception": "ValueError"},
            "k4": {"verdict": "policy", "target": "pkg:e"},  # no exception named
        }
    }
    feedback, skipped = feedback_from_adjudications(doc)
    labels = {f.key: f.is_defect for f in feedback}
    assert labels[signature("InterpreterError", "unknown")] is False
    assert labels[signature("KeyError", "stdlib")] is True
    assert len(feedback) == 2, "an unanswered adjudication is not a label"
    assert skipped == 1, "an entry with no exception type is counted, not guessed at"


# ---- M7: feedback must not become an absorbing state -------------------------


def test_dismissals_do_not_globally_silence_an_exception_type(tmp_path: Path):
    # M7: ten dismissals of ValueError@stdlib from ten UNRELATED helpers used to
    # drive the shared posterior to zero, whose steady state is "reports
    # nothing". The signature saturates, and the site that was actually
    # CONFIRMED still reports.
    policy = ExceptionPolicy()
    key = signature("ValueError", "stdlib")
    for i in range(10):
        policy.record_verdict(key, target=f"pkg:noisy{i}", input_class="valid", is_defect=False)

    assert policy.evidence[key].feedback_mass <= GLOBAL_FEEDBACK_CAP

    # An eleventh, unrelated site where the finding was confirmed.
    for _ in range(8):
        policy.record_verdict(key, target="pkg:real", input_class="valid", is_defect=True)
    probability, _ = policy.defect_probability(
        key,
        provenance="stdlib",
        total_targets=11,
        family="ValueError",
        conformant=True,
        target="pkg:real",
    )
    assert (
        probability >= REPORT_THRESHOLD
    ), "a confirmed call site must survive the repo-wide dismissals"


def test_a_dismissed_site_stays_quiet_while_its_neighbours_do_not(tmp_path: Path):
    policy = ExceptionPolicy()
    key = signature("Chatty", "repo")
    for _ in range(8):
        policy.record_verdict(key, target="pkg:noisy", input_class="valid", is_defect=False)
    for _ in range(8):
        policy.record_verdict(key, target="pkg:real", input_class="valid", is_defect=True)

    quiet, _ = policy.defect_probability(
        key, provenance="repo", total_targets=2, family="RuntimeError", target="pkg:noisy"
    )
    loud, _ = policy.defect_probability(
        key, provenance="repo", total_targets=2, family="RuntimeError", target="pkg:real"
    )
    assert quiet < loud, "the verdict must be about the SITE, not just the type"


def test_site_evidence_persists(tmp_path: Path):
    key = signature("Sited", "repo")
    apply_feedback(tmp_path, [Feedback(key=key, is_defect=True, target="pkg:f")])
    reloaded = ExceptionPolicy.load(tmp_path, decay=1.0)
    assert site_key(key, "pkg:f") in reloaded.sites
    assert reloaded.sites[site_key(key, "pkg:f")].confirmed == 1


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
