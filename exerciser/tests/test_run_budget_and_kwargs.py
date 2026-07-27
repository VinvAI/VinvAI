"""Budget retirement and concurrency arguments (audit COR-24, COR-14, FP-21).

COR-24  `active_ids` was never mutated — the name and the defensive `list()`
        copies both implied retirement was implemented, but every endpoint
        stayed in the rotation for the whole run. An endpoint that can never
        respond (a wrong verb, a collided id, a form-only login) therefore
        burned one probe per round out of a default budget of 200. This is
        the multiplier that turned the coverage defects into lost budget.
COR-14  Persistence was a terminal phase, so any mid-loop exit discarded
        every execution AND left the state those probes planted unrecorded,
        so it could never be torn down.
FP-21   The campaign passed no kwargs, so every concurrency target was called
        `fn()`. A target with a required parameter then raised TypeError in
        BOTH the serial baseline and the concurrent batch — and because the
        two agreed, the oracle CERTIFIED it as concurrency-safe.
"""

from __future__ import annotations

from pathlib import Path

from exerciser import store
from exerciser.execute import ProbeResult
from exerciser.run import run_exercise
from test_run_profile_regress import _fake_coverage_factory, _write_plan


class _DeadService:
    """Never answers: every probe is a transport failure (status is None)."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, *_a: object, **_k: object) -> ProbeResult:
        self.calls += 1
        return ProbeResult(None, 1.0, None, "empty", "connection refused", None, None)


class _HealthyService:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, *_a: object, **_k: object) -> ProbeResult:
        self.calls += 1
        return ProbeResult(200, 1.0, {"ok": True}, "json:x", None, None, "json")


def _run(repo: Path, probe: object, budget: int = 40) -> dict:
    return run_exercise(
        repo,
        "http://svc",
        budget=budget,
        rounds=3,
        settle_s=0.0,
        probe_fn=probe,  # type: ignore[arg-type]
        coverage_fn=_fake_coverage_factory(),
    )


class TestUnreachableEndpointsAreRetired:
    def test_a_dead_service_does_not_consume_the_whole_budget(self, tmp_path: Path) -> None:
        """COR-24: without retirement this spends every probe on endpoints
        that cannot answer."""
        (tmp_path / ".vinv" / "exercise").mkdir(parents=True)
        _write_plan(tmp_path)
        probe = _DeadService()
        result = _run(tmp_path, probe, budget=40)
        assert result["status"] == "ok"
        assert probe.calls < 40, f"retirement never fired: spent {probe.calls}/40 probes"

    def test_a_healthy_service_is_never_retired(self, tmp_path: Path) -> None:
        """The precision half — a responding endpoint must stay in rotation."""
        (tmp_path / ".vinv" / "exercise").mkdir(parents=True)
        _write_plan(tmp_path)
        probe = _HealthyService()
        _run(tmp_path, probe, budget=12)
        assert probe.calls >= 6, "healthy endpoints must keep being exercised"

    def test_a_4xx_is_a_real_answer_and_does_not_retire(self, tmp_path: Path) -> None:
        """Only total unreachability retires; a rejection is information."""

        class _Rejecting:
            def __init__(self) -> None:
                self.calls = 0

            def __call__(self, *_a: object, **_k: object) -> ProbeResult:
                self.calls += 1
                return ProbeResult(404, 1.0, {"detail": "no"}, "json:e", None, None, "json")

        (tmp_path / ".vinv" / "exercise").mkdir(parents=True)
        _write_plan(tmp_path)
        probe = _Rejecting()
        _run(tmp_path, probe, budget=12)
        assert probe.calls >= 6


class TestExecutionsArePersistedIncrementally:
    def test_results_are_on_disk_and_not_duplicated(self, tmp_path: Path) -> None:
        """COR-14: rows are checkpointed per round, and the terminal write must
        append only what the checkpoints did not already take."""
        (tmp_path / ".vinv" / "exercise").mkdir(parents=True)
        _write_plan(tmp_path)
        probe = _HealthyService()
        _run(tmp_path, probe, budget=12)
        rows = store.read_jsonl(store.results_path(tmp_path))
        assert rows, "executions must reach disk"
        # Every row is a distinct probe; a double-write would duplicate them.
        keys = [
            (r.get("api_id"), r.get("round"), r.get("strategy"), r.get("input_class")) for r in rows
        ]
        assert len(keys) == len(rows)
        assert len(rows) <= probe.calls, "no row may be written twice"

    def test_the_ledger_is_not_double_counted(self, tmp_path: Path) -> None:
        """Round checkpoints append to the ledger; the terminal pass must not
        re-append the same creations and inflate the pollution numbers."""

        class _Creating:
            def __call__(self, *_a: object, **_k: object) -> ProbeResult:
                return ProbeResult(201, 1.0, {"id": "abc123"}, "json:c", None, None, "json")

        (tmp_path / ".vinv" / "exercise").mkdir(parents=True)
        _write_plan(tmp_path)
        _run(tmp_path, _Creating(), budget=12)
        from exerciser import state

        ledger = store.read_jsonl(state.ledger_path(tmp_path))
        rows = store.read_jsonl(store.results_path(tmp_path))
        # One ledger row per mutating 2xx EXECUTION. Several probes legitimately
        # create several rows (each is a real creation); what must never happen
        # is the same execution being appended twice — once by its round
        # checkpoint and again by the terminal pass.
        mutating_2xx = sum(
            1
            for r in rows
            if r.get("method") in {"POST", "PUT", "PATCH", "DELETE"}
            and isinstance(r.get("status"), int)
            and 200 <= r["status"] < 300
        )
        assert (
            len(ledger) == mutating_2xx
        ), f"{len(ledger)} ledger rows for {mutating_2xx} mutating 2xx executions"


class TestConcurrencyTargetsReceiveArguments:
    def test_a_targets_own_annotations_become_valid_kwargs(self, tmp_path: Path) -> None:
        """FP-21: `fn()` raised TypeError identically in both phases, so the
        oracle certified the target as safe instead of exercising it."""
        from exerciser.campaign import OracleConfig, _valid_kwargs_for

        pkg = tmp_path / "pkg"
        pkg.mkdir()
        (pkg / "__init__.py").write_text("", encoding="utf-8")
        (pkg / "bank.py").write_text(
            "def transfer(amount: int, note: str) -> int:\n    return amount\n", encoding="utf-8"
        )
        cfg = OracleConfig(repo=tmp_path)
        kwargs = _valid_kwargs_for(cfg, "pkg.bank:transfer")
        assert set(kwargs) == {"amount", "note"}, kwargs
        assert isinstance(kwargs["amount"], int)
        assert isinstance(kwargs["note"], str)

    def test_an_unreadable_target_yields_no_kwargs_instead_of_failing(self, tmp_path: Path) -> None:
        """A signature we cannot read must not fail the play."""
        from exerciser.campaign import OracleConfig, _valid_kwargs_for

        cfg = OracleConfig(repo=tmp_path)
        assert _valid_kwargs_for(cfg, "does.not:exist") == {}

    def test_a_zero_argument_target_stays_empty(self, tmp_path: Path) -> None:
        from exerciser.campaign import OracleConfig, _valid_kwargs_for

        pkg = tmp_path / "pkg"
        pkg.mkdir()
        (pkg / "__init__.py").write_text("", encoding="utf-8")
        (pkg / "t.py").write_text("def tick() -> int:\n    return 1\n", encoding="utf-8")
        cfg = OracleConfig(repo=tmp_path)
        assert _valid_kwargs_for(cfg, "pkg.t:tick") == {}
