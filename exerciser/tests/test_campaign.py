"""The campaign: the enriched action space, actually allocating a budget.

These tests pin the property the action space existed to provide and never
delivered — that budget SHIFTS toward whatever pays on this repo, across
oracles, and that the shift survives to the next run.
"""

from __future__ import annotations

from pathlib import Path

from exerciser import store
from exerciser.bandit import Action
from exerciser.campaign import (
    ActionSpace,
    OracleConfig,
    Play,
    campaign_path,
    default_runners,
    enumerate_actions,
    probe_equivalents,
    run_campaign,
)

# Two oracles: one reliably finds violations, the other never does.
PAYING = Action(target="pkg.mod:evaluate", technique="ast-corpus", oracle="differential")
BARREN = Action(target="pkg.mod:helper", technique="deterministic", oracle="crash")
HTTP = Action(target="GET /items", technique="schema_valid", oracle="status")


def _runners(paying_violations: int = 1) -> dict:
    def differential(action: Action) -> Play:
        return Play(violations=paying_violations, covered=(action.target,), subprocesses=1)

    def crash(action: Action) -> Play:
        return Play(violations=0, covered=(action.target,), subprocesses=1)

    return {"differential": differential, "crash": crash}


# ---- allocation ------------------------------------------------------------


def test_budget_shifts_toward_the_technique_that_pays(tmp_path: Path):
    result = run_campaign(
        tmp_path,
        budget=40,
        seed=7,
        patience=100,  # let the whole budget run: this test is about allocation
        actions=[PAYING, BARREN],
        runners=_runners(),
    )
    assert result["plays_run"] == 40
    spent = {}
    for play in result["plays"]:
        spent[play["oracle"]] = spent.get(play["oracle"], 0) + 1

    assert (
        spent["differential"] > spent["crash"]
    ), "the bandit must spend more budget on the oracle that finds things"
    assert result["preferred"]["oracle"] == "differential"
    # And a human can read WHICH TECHNIQUE paid without decoding per-arm state.
    assert result["by_technique"]["ast-corpus"]["violations"] > 0
    assert result["by_technique"]["deterministic"]["violations"] == 0
    assert (
        result["by_oracle"]["differential"]["posterior_mean"]
        > result["by_oracle"]["crash"]["posterior_mean"]
    )


def test_a_play_is_a_real_oracle_invocation_with_a_measured_cost(tmp_path: Path):
    import time

    def slow(action: Action) -> Play:
        time.sleep(0.05)
        return Play(violations=1, covered=(action.target,), subprocesses=2)

    result = run_campaign(
        tmp_path,
        budget=1,
        actions=[PAYING],
        runners={"differential": slow},
    )
    play = result["plays"][0]
    assert play["elapsed_s"] >= 0.05, "cost is measured, not assumed"
    # Two subprocesses is a floor on the price even if the clock says less.
    assert play["cost_probe_equivalents"] >= 2.0
    assert play["credit"] < 1.0, "an expensive find pays less than a cheap one"


def test_cost_is_never_a_hardcoded_one():
    # The bug being fixed: every oracle priced at 1.0 regardless of what it cost.
    assert probe_equivalents(0.0) == 1.0  # floor
    assert probe_equivalents(2.5) == 10.0  # wall-clock, in probe-equivalents
    assert probe_equivalents(0.0, subprocesses=4) == 4.0  # a fork was paid for
    assert probe_equivalents(10.0, subprocesses=1) == 40.0


# ---- persistence + warm start ----------------------------------------------


def test_posteriors_persist_and_warm_start_the_next_campaign(tmp_path: Path):
    first = run_campaign(
        tmp_path, budget=20, seed=3, patience=100, actions=[PAYING, BARREN], runners=_runners()
    )
    assert first["warm_started_arms"] == 0, "a first run has nothing to warm-start from"

    doc = store.read_json(campaign_path(tmp_path))
    assert doc is not None, "the campaign must persist its posteriors"
    assert PAYING.key in doc["bandit"]["arms"]

    second = run_campaign(
        tmp_path, budget=20, seed=3, patience=100, actions=[PAYING, BARREN], runners=_runners()
    )
    assert second["warm_started_arms"] == 2, "learning must survive the run"

    # The warm-started run starts already believing in the paying arm, so it
    # commits to it faster than the cold one did.
    def share(res: dict) -> float:
        hits = sum(1 for p in res["plays"] if p["oracle"] == "differential")
        return hits / max(1, len(res["plays"]))

    assert share(second) >= share(first)


def test_a_vanished_target_loses_its_seat(tmp_path: Path):
    run_campaign(
        tmp_path, budget=10, seed=1, patience=100, actions=[PAYING, BARREN], runners=_runners()
    )
    # Next run: the barren target no longer exists in the repo.
    second = run_campaign(
        tmp_path, budget=10, seed=1, patience=100, actions=[PAYING], runners=_runners()
    )
    assert second["actions"] == 1
    assert all(p["target"] == PAYING.target for p in second["plays"])


# ---- stopping rule + robustness --------------------------------------------


def test_the_stopping_rule_ends_a_campaign_that_finds_nothing(tmp_path: Path):
    def barren(action: Action) -> Play:
        return Play(violations=0, covered=(action.target,))

    result = run_campaign(
        tmp_path,
        budget=100,
        patience=3,
        actions=[BARREN],
        runners={"crash": barren},
    )
    assert result["stopped"] == "no-improvement-patience"
    assert result["plays_run"] < 100, "a campaign that finds nothing must stop early"


def test_new_ground_is_only_paid_for_once(tmp_path: Path):
    def barren(action: Action) -> Play:
        return Play(violations=0, covered=("always-the-same-symbol",))

    result = run_campaign(
        tmp_path, budget=10, patience=100, actions=[BARREN], runners={"crash": barren}
    )
    coverage = [p["new_coverage"] for p in result["plays"]]
    assert coverage[0] == 1
    assert sum(coverage[1:]) == 0, "the exploration bonus is for NEW ground only"


def test_a_broken_oracle_does_not_end_the_campaign(tmp_path: Path):
    def explodes(action: Action) -> Play:
        raise RuntimeError("worker died")

    result = run_campaign(
        tmp_path, budget=5, patience=100, actions=[BARREN], runners={"crash": explodes}
    )
    assert result["status"] == "ok"
    assert result["plays_run"] == 5
    assert all("worker died" in (p["error"] or "") for p in result["plays"])


def test_an_unarmed_oracle_does_not_drain_the_budget(tmp_path: Path):
    result = run_campaign(
        tmp_path,
        budget=10,
        patience=100,
        actions=[PAYING, BARREN],
        runners={"differential": _runners()["differential"]},  # no crash runner
    )
    assert all(p["oracle"] == "differential" for p in result["plays"])
    assert result["plays_run"] == 10


def test_a_repo_with_no_armed_oracle_says_so(tmp_path: Path):
    result = run_campaign(tmp_path, budget=10, actions=[], runners={})
    assert result["status"] == "ok"
    assert result["plays_run"] == 0
    assert result["stopped"] == "no-actions"
    assert any("0 actions armed" in d for d in result["diagnostics"])


# ---- enumeration -----------------------------------------------------------


def test_enumeration_is_honest_about_what_is_not_armed(tmp_path: Path):
    # An empty directory arms nothing, and every absence is REPORTED rather
    # than silently producing a campaign that does nothing.
    space = enumerate_actions(tmp_path, base_url=None)
    assert isinstance(space, ActionSpace)
    assert space.actions == []
    joined = " ".join(space.notes)
    assert "--base-url" in joined
    assert "boundaries.json" in joined


def test_enumeration_arms_the_function_oracles_from_real_discovery(tmp_path: Path):
    # Discovery is IMPORTED, not re-implemented: a repo whose entry points
    # identification catalogued becomes (module:fn x technique x oracle) arms.
    pkg = tmp_path / "src" / "pkg"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("")
    (pkg / "mod.py").write_text("def evaluate(x):\n    return x\n")
    store.write_json(
        store.apis_json_path(tmp_path),
        {
            "entrypoints": [
                {"kind": "cli", "file": "src/pkg/mod.py", "handler": "evaluate"},
            ]
        },
    )
    space = enumerate_actions(tmp_path, base_url=None)
    oracles = {a.oracle for a in space.actions}
    assert "crash" in oracles and "concurrency" in oracles
    crash = [a for a in space.actions if a.oracle == "crash"]
    assert any(a.target.endswith(":evaluate") for a in crash)
    assert all(a.technique == "deterministic" for a in crash)


# ---- the exception policy actually receives evidence -------------------------


def test_a_differential_play_feeds_the_exception_policy(tmp_path: Path):
    # C2's loop, closed in src/ rather than described in a docstring: running
    # the differential oracle turns its rows into LABELLED evidence and lands
    # any answered adjudication as feedback.
    from exerciser.campaign import _learn_from_differential
    from exerciser.exception_policy import ExceptionPolicy, signature

    store.write_jsonl(
        store.exercise_dir(tmp_path) / "differential_results.jsonl",
        [
            {
                "phase": "compare",
                "target": "pkg.mod:evaluate",
                "reference": {"ok": True, "value": "2"},
                "got": {"ok": False, "exception": "PkgError", "module": "pkg.errors"},
            }
        ],
    )
    store.write_json(
        store.exercise_dir(tmp_path) / "adjudications.json",
        {
            "verdicts": {
                "k1": {
                    "verdict": "policy",
                    "target": "pkg.mod:evaluate",
                    "exception": "Refused",
                    "exception_module": "pkg.errors",
                }
            }
        },
    )

    _learn_from_differential(OracleConfig(repo=tmp_path), {"repo": str(tmp_path)})

    policy = ExceptionPolicy.load(tmp_path, decay=1.0)
    # Self-supervised: CPython accepted what the target refused.
    agreed = policy.evidence[signature("PkgError", "repo")]
    assert agreed.alpha > 1.0 and agreed.agreement_mass > 0
    # Adjudicated: "policy" means a deliberate refusal, and it lands at the site.
    refused = policy.evidence[signature("Refused", "repo")]
    assert refused.beta > 1.0 and refused.refuted == 1
    assert f"{signature('Refused', 'repo')}#pkg.mod:evaluate" in policy.sites


def test_a_crash_play_posts_dispersion_evidence(tmp_path: Path):
    # The functions runner tops up dispersion self-supervision after each play,
    # which is what makes the policy able to become confident with no human.
    from exerciser.exception_policy import ExceptionPolicy, signature

    key = signature("HouseStyle", "repo")
    seeded = ExceptionPolicy()
    for i in range(10):
        seeded.observe(key, target=f"pkg:f{i}", input_class="valid")
    seeded.save(tmp_path)
    assert seeded.evidence[key].beta == 1.0, "unlabelled sightings alone move nothing"

    def crash(action: Action) -> Play:
        return Play(violations=0, covered=(action.target,))

    calls = {"n": 0}
    real = __import__("exerciser.functions", fromlist=["run_functions"])

    def fake_run_functions(repo, **kwargs):
        calls["n"] += 1
        return {"targets": 10, "modules": 1, "clusters": []}

    original = real.run_functions
    real.run_functions = fake_run_functions
    try:
        run_campaign(
            tmp_path, budget=1, patience=100, actions=[BARREN], runners=None, base_url=None
        )
    finally:
        real.run_functions = original

    assert calls["n"] == 1, "the play must really invoke the oracle"
    reloaded = ExceptionPolicy.load(tmp_path, decay=1.0)
    assert reloaded.evidence[key].beta > 1.0, "dispersion must become real posterior movement"
    assert reloaded.evidence[key].dispersion_beta > 0


def test_every_default_oracle_has_a_runner(tmp_path: Path):
    # A drawn action with no runner drops its whole oracle, so a missing entry
    # here would silently disarm an oracle rather than fail loudly.
    runners = default_runners(OracleConfig(repo=tmp_path))
    assert {"crash", "differential", "fault", "concurrency", "status", "environment"} <= set(
        runners
    )


# ---- credit is paid ONCE per defect ----------------------------------------
#
# The bug: five of six runners returned the run's TOTAL cluster count, so a
# deterministic oracle re-earned full credit on every play of the same arm.
# Alpha climbed monotonically on one bug, Thompson concentrated, and because the
# play never reported zero violations the no-improvement counter could never
# fire — the campaign burned its whole budget re-finding one known defect and
# reported it as sustained yield.


def _one_defect_forever(signature: str = "sig-deterministic-defect"):
    """A stub oracle that reports the SAME cluster on every single play."""

    def runner(action: Action) -> Play:
        return Play(violations=1, signatures=(signature,), covered=(action.target,))

    return runner


def test_the_same_defect_is_credited_exactly_once(tmp_path: Path):
    result = run_campaign(
        tmp_path,
        budget=50,
        patience=3,
        actions=[PAYING],
        runners={"differential": _one_defect_forever()},
    )
    assert result["violations"] == 1, "one defect pays once, however often it is re-found"
    credited = [p for p in result["plays"] if p["violations"]]
    assert len(credited) == 1 and credited[0]["play"] == 1
    assert result["repeat_violations"] == len(result["plays"]) - 1

    # …and because the repeats credit nothing, the stopping rule can finally see
    # that the campaign has stopped making progress.
    assert result["stopped"] == "no-improvement-patience"
    assert result["plays_run"] == 4, "1 finding + `patience` barren plays"


def test_a_defect_found_yesterday_does_not_pay_again_today(tmp_path: Path):
    runners = {"differential": _one_defect_forever()}
    first = run_campaign(tmp_path, budget=10, patience=100, actions=[PAYING], runners=runners)
    assert first["violations"] == 1
    assert store.read_json(campaign_path(tmp_path))["credited_signatures"] == [
        "sig-deterministic-defect"
    ]

    second = run_campaign(tmp_path, budget=10, patience=100, actions=[PAYING], runners=runners)
    assert second["violations"] == 0, "the ledger must survive the run"
    assert second["repeat_violations"] == second["plays_run"]

    # A genuinely NEW defect still pays, so the ledger suppresses repeats rather
    # than the oracle.
    third = run_campaign(
        tmp_path,
        budget=10,
        patience=100,
        actions=[PAYING],
        runners={"differential": _one_defect_forever("sig-new")},
    )
    assert third["violations"] == 1


def test_a_runner_that_reports_no_signatures_keeps_its_own_count(tmp_path: Path):
    # There is nothing to dedupe on, so the honest answer is the count it gave.
    result = run_campaign(
        tmp_path, budget=5, patience=100, actions=[PAYING], runners=_runners(paying_violations=2)
    )
    assert result["violations"] == 10
    assert result["repeat_violations"] == 0


# ---- the adapter layer: result document -> Outcome -------------------------
#
# One stub of a fixed shape used to satisfy every runner, which meant the six
# adapters — the code that decides what a result document is WORTH — were
# effectively untested. These pin each adapter against a NON-EMPTY cluster list.


def _cluster(signature: str, endpoint_id: str = "pkg.mod:evaluate") -> dict:
    return {
        "signature": signature,
        "kind": "crash",
        "title": "boom",
        "endpoint_id": endpoint_id,
        "method": "CALL",
        "path": endpoint_id,
        "count": 1,
    }


def _patch(monkeypatch, module: str, name: str, doc: dict) -> list[dict]:
    """Make ``module.name`` return ``doc``; return the recorded call kwargs."""
    calls: list[dict] = []
    mod = __import__(f"exerciser.{module}", fromlist=[name])

    def fake(*args, **kwargs):
        calls.append(kwargs)
        return doc

    monkeypatch.setattr(mod, name, fake)
    return calls


def test_the_functions_adapter_credits_only_this_target_s_clusters(tmp_path, monkeypatch):
    from exerciser.campaign import _functions_runner

    _patch(
        monkeypatch,
        "functions",
        "run_functions",
        {
            "targets": 3,
            "modules": 2,
            "calls": 9,
            "verdicts": {"ok": 9},
            "issue_clusters": 3,
            "clusters": [
                _cluster("sig-a"),
                _cluster("sig-b"),
                _cluster("sig-elsewhere", endpoint_id="pkg.mod:other"),
            ],
        },
    )
    play = _functions_runner(OracleConfig(repo=tmp_path))(PAYING)
    assert play.violations == 2, "a cluster belonging to another target is not this play's"
    assert play.signatures == ("sig-a", "sig-b")
    assert play.subprocesses == 2
    assert play.detail["calls"] == 9


def test_the_differential_adapter_reads_clusters_not_the_total(tmp_path, monkeypatch):
    from exerciser.campaign import _differential_runner

    calls = _patch(
        monkeypatch,
        "differential",
        "run_differential",
        {
            # The total and the cluster list disagree; the SIGNATURES are what a
            # play may be credited for.
            "mismatch_clusters": 99,
            "comparisons": 12,
            "policy_limit_count": 1,
            "unadjudicated_count": 0,
            "clusters": [_cluster("sig-diff-1"), _cluster("sig-diff-2")],
        },
    )
    play = _differential_runner(OracleConfig(repo=tmp_path))(PAYING)
    assert play.violations == 2
    assert play.signatures == ("sig-diff-1", "sig-diff-2")
    assert calls[0]["target"] == PAYING.target
    assert play.detail["comparisons"] == 12


def test_the_faults_adapter_passes_the_boundary_contract_through(tmp_path, monkeypatch):
    from exerciser.campaign import _faults_runner

    class _Boundary:
        contract = {"kind": "queue"}
        baseline = {"latency_ms": 3}

    calls = _patch(
        monkeypatch,
        "faults",
        "run_faults",
        {
            "issue_clusters": 1,
            "faults_injected": 7,
            "clusters": [_cluster("sig-fault")],
        },
    )
    cfg = OracleConfig(repo=tmp_path, boundaries={PAYING.target: _Boundary()})
    play = _faults_runner(cfg)(PAYING)
    assert play.violations == 1 and play.signatures == ("sig-fault",)
    assert calls[0]["contract"] == {"kind": "queue"}
    assert calls[0]["baseline"] == {"latency_ms": 3}
    assert play.detail["faults_injected"] == 7


def test_the_concurrency_adapter_forwards_workers_and_repeats(tmp_path, monkeypatch):
    from exerciser.campaign import _concurrency_runner

    calls = _patch(
        monkeypatch,
        "concurrency",
        "run_concurrency",
        {
            "issue_clusters": 2,
            "worker_timed_out": True,
            "clusters": [_cluster("sig-race-1"), _cluster("sig-race-2")],
        },
    )
    play = _concurrency_runner(OracleConfig(repo=tmp_path, workers=8, repeats=5))(PAYING)
    assert play.violations == 2
    assert calls[0]["workers"] == 8 and calls[0]["repeats"] == 5
    assert play.detail["worker_timed_out"] is True


def test_the_environment_adapter_turns_its_clusters_into_violations(tmp_path, monkeypatch):
    from exerciser.campaign import _environment_runner

    _patch(
        monkeypatch,
        "environment",
        "run_environment",
        {
            "status": "ok",
            "issue_clusters": 1,
            "clusters": [_cluster("sig-drift")],
        },
    )
    play = _environment_runner(OracleConfig(repo=tmp_path))(PAYING)
    assert play.violations == 1 and play.signatures == ("sig-drift",)
    assert play.detail["status"] == "ok"


# ---- the HTTP adapter's cumulative arithmetic ------------------------------


def test_the_http_adapter_credits_only_what_is_new_in_a_cumulative_file(tmp_path, monkeypatch):
    # issues.json accumulates across plays. Crediting its total each time would
    # pay every later play for every earlier play's clusters.
    from exerciser.campaign import _http_runner

    doc = {"issue_clusters": 0, "probes_spent": 20}
    _patch(monkeypatch, "run", "run_exercise", doc)
    cfg = OracleConfig(repo=tmp_path, base_url="http://localhost:1")
    runner = _http_runner(cfg)

    store.write_json(store.issues_path(tmp_path), {"clusters": [_cluster("sig-500-a")]})
    first = runner(PAYING)
    assert first.violations == 1 and first.signatures == ("sig-500-a",)
    assert first.detail["probes_spent"] == 20

    # Second play: the file now holds the old cluster PLUS a new one.
    store.write_json(
        store.issues_path(tmp_path),
        {"clusters": [_cluster("sig-500-a"), _cluster("sig-500-b")]},
    )
    second = runner(PAYING)
    assert second.signatures == ("sig-500-a", "sig-500-b")

    # The adapter reports the whole cumulative file every play; the campaign is
    # what pays, and it pays for each signature exactly once.
    result = run_campaign(
        tmp_path, budget=2, patience=100, actions=[HTTP], runners={"status": runner}
    )
    assert result["violations"] == 2, "two distinct clusters, credited once each"
    assert [p["violations"] for p in result["plays"]] == [2, 0]
    assert result["repeat_violations"] == 2


def test_the_http_adapter_falls_back_to_the_count_delta(tmp_path, monkeypatch):
    # No readable issues.json (an older run, or a partial write): the adapter
    # still must not re-credit, so it falls back to the DELTA in the count.
    from exerciser.campaign import _http_runner

    doc = {"issue_clusters": 1, "probes_spent": 20}
    _patch(monkeypatch, "run", "run_exercise", doc)
    runner = _http_runner(OracleConfig(repo=tmp_path, base_url="http://localhost:1"))

    assert runner(PAYING).violations == 1
    assert runner(PAYING).violations == 0, "the same cumulative total is not a new finding"
    doc["issue_clusters"] = 3
    assert runner(PAYING).violations == 2


def test_the_http_adapter_refuses_to_run_without_a_base_url(tmp_path):
    from exerciser.campaign import _http_runner

    play = _http_runner(OracleConfig(repo=tmp_path))(HTTP)
    assert play.error == "no base_url" and play.violations == 0
