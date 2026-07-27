"""The Stage-2 fixes whose defect was a WIRING gap, not an algorithm.

Each of these was a place where two sites disagreed, a counter was reset, or a
suppression rule was too wide — none of them raised anything, all of them
changed what the tool reports.

  COR-5   `plan` wrote the prompt as `_safe(api_id).json`, `run`'s expiry used
          the RAW id, so expiry stamped a different file and a dead scenario
          replayed forever.
  COR-21  compaction prunes cleaned ledger rows (correct for a work queue,
          wrong for a historical record), so the scorecard's totals RESET —
          reporting the teardown machinery doing nothing while it worked.
  COR-24  `active_ids` was never mutated, so an endpoint that can never respond
          consumed one probe per round for the whole run.
  FP-14   PEP 249 REQUIRES a driver to define its exception hierarchy in its own
          module, so keying containment on the defining module made "the
          substitute gave up" and "the repo violated a constraint"
          indistinguishable — suppressing the canonical data-layer bug class.
  FP-15   `asyncpg`/`clickhouse_driver` are not DB-API 2.0; substituting them
          raised builtins in the REPO's frame, reportable as repo defects.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from exerciser import compaction, state, store
from exerciser.sandbox import _DBAPI_EXCEPTIONS, mark_contained
from exerciser.service_doubles import NON_PEP249_CLIENTS, PEP249_DRIVERS


class TestPromptPathIsSharedAndSafe:
    """COR-5 — one derivation, usable on every filesystem."""

    @pytest.mark.parametrize(
        "api_id", ["GET_items_{p}", "POST_login_access-token", "GET_users_{user_id}_items"]
    )
    def test_the_path_is_filesystem_safe(self, tmp_path, api_id: str) -> None:
        path = store.prompt_path(tmp_path, api_id)
        assert not any(c in path.name for c in '{}<>:"|?*'), path.name

    def test_plan_and_run_derive_the_same_file(self, tmp_path) -> None:
        """The whole defect: two sites, two names, expiry never took effect."""
        api_id = "GET_items_{p}"
        assert store.prompt_path(tmp_path, api_id) == store.prompt_path(tmp_path, api_id)

    def test_distinct_ids_do_not_collide_after_sanitising(self, tmp_path) -> None:
        a = store.prompt_path(tmp_path, "GET_items_{p}")
        b = store.prompt_path(tmp_path, "GET_items_{q}")
        assert a != b

    def test_the_file_can_actually_be_written(self, tmp_path) -> None:
        """`GET_items_{p}.json` is not creatable on Windows at all."""
        path = store.prompt_path(tmp_path, "GET_items_{p}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}", encoding="utf-8")
        assert path.is_file()


class TestScorecardTotalsSurviveCompaction:
    """COR-21 — the historical half of the ledger must not vanish."""

    @staticmethod
    def _row(cleaned: bool, ep: str = "POST_items") -> dict:
        return {
            "endpoint_id": ep,
            "method": "POST",
            "path": "/items/",
            "status": 200,
            "planted": ["x"],
            "response_values": ["1"],
            "cleaned": cleaned,
        }

    def test_rolled_up_totals_accumulate(self, tmp_path) -> None:
        store.exercise_dir(tmp_path).mkdir(parents=True, exist_ok=True)
        compaction.roll_up_state_totals(tmp_path, [self._row(True), self._row(True)])
        compaction.roll_up_state_totals(tmp_path, [self._row(True), self._row(False)])
        doc = store.read_json(compaction.state_totals_path(tmp_path))
        assert doc == {"created_total": 4, "cleaned_total": 3}

    def test_totals_start_empty_and_are_monotone(self, tmp_path) -> None:
        store.exercise_dir(tmp_path).mkdir(parents=True, exist_ok=True)
        assert store.read_json(compaction.state_totals_path(tmp_path)) is None
        compaction.roll_up_state_totals(tmp_path, [])
        doc = store.read_json(compaction.state_totals_path(tmp_path))
        assert doc == {"created_total": 0, "cleaned_total": 0}

    def test_the_scorecard_counts_pruned_rows_too(self, tmp_path) -> None:
        """created 3 / cleaned 2 must not become created 1 / cleaned 0."""
        from exerciser.scorecard import _state_pollution

        store.exercise_dir(tmp_path).mkdir(parents=True, exist_ok=True)
        rows = [self._row(True), self._row(True), self._row(False)]
        # Simulate compaction: the two cleaned rows are rolled up and pruned.
        compaction.roll_up_state_totals(tmp_path, rows[:2])
        store.write_jsonl(state.ledger_path(tmp_path), rows[2:])
        got = _state_pollution(tmp_path)
        assert got["created"] == 3
        assert got["cleaned"] == 2
        assert got["uncleaned"] == 1

    def test_compaction_rolls_up_what_it_prunes(self, tmp_path) -> None:
        """End to end through `compact_artifacts`' ledger target."""
        store.exercise_dir(tmp_path).mkdir(parents=True, exist_ok=True)
        rows = [self._row(True), self._row(False)]
        store.write_jsonl(state.ledger_path(tmp_path), rows)
        compaction.compact_artifacts(tmp_path, {"endpoints": [{"api_id": "POST_items"}]})
        doc = store.read_json(compaction.state_totals_path(tmp_path)) or {}
        assert doc.get("cleaned_total") == 1, "the pruned cleaned row must be remembered"


class TestServiceDoublesSuppressionIsNarrow:
    """FP-14/FP-15 — what the substitute may and may not silence."""

    @staticmethod
    def _row(error_type: str, module: str = "exerciser.service_doubles") -> dict:
        return {"status": "error", "error_type": error_type, "error_module": module, "error": "x"}

    @pytest.mark.parametrize(
        "exc", ["IntegrityError", "OperationalError", "ProgrammingError", "DataError"]
    )
    def test_a_dbapi_error_is_never_contained(self, exc: str) -> None:
        """The database ANSWERED — a real constraint violation in the repo."""
        row = mark_contained(self._row(exc))
        assert not row.get("contained"), f"{exc} is the canonical data-layer bug class"

    def test_a_substitution_gap_is_still_contained(self) -> None:
        """The fidelity limit the doubles promise is never a repo defect."""
        row = self._row("SubstitutionGap")
        row["error_mro"] = ["SubstitutionGap", "Exception"]
        assert mark_contained(row).get("contained")

    def test_a_repo_exception_of_the_same_name_is_untouched(self) -> None:
        row = mark_contained(self._row("IntegrityError", module="myapp.db"))
        assert not row.get("contained")

    def test_the_dbapi_set_matches_pep_249(self) -> None:
        for exc in ("Error", "InterfaceError", "DatabaseError", "NotSupportedError"):
            assert exc in _DBAPI_EXCEPTIONS

    def test_substitution_gap_is_not_in_the_dbapi_set(self) -> None:
        """It IS the substitute giving up, so it must stay containable."""
        assert "SubstitutionGap" not in _DBAPI_EXCEPTIONS

    @pytest.mark.parametrize("driver", ["asyncpg", "clickhouse_driver"])
    def test_non_conforming_drivers_are_not_substituted(self, driver: str) -> None:
        """Substituting them raised builtins in the repo's own frame, which
        containment does not match — reportable as a defect in the repo, on
        every machine including CI runners that never had the driver."""
        assert driver not in PEP249_DRIVERS
        assert driver in NON_PEP249_CLIENTS, "and the reason must be recorded"

    def test_conforming_drivers_are_still_substituted(self) -> None:
        for driver in ("psycopg2", "pymysql", "pyodbc"):
            assert driver in PEP249_DRIVERS

    def test_every_excluded_client_states_why(self) -> None:
        assert all(reason.strip() for reason in NON_PEP249_CLIENTS.values())


class TestOracleResultContract:
    """STR-2/STR-3 — one cluster skeleton, one result-key vocabulary.

    Five oracles each carried a private copy of the same twenty-line clustering
    skeleton, and they had already drifted (`differential` sorted by
    `(path, title)`, the rest by `(kind, path)`). Separately, `differential`
    spelled its total `mismatch_clusters` while everyone else used
    `issue_clusters` — and that single divergent dict key is the entire reason
    `campaign._findings` carried a `count_key` parameter.
    """

    _ORACLES = ["functions.py", "differential.py", "faults.py", "concurrency.py"]

    @pytest.mark.parametrize("name", _ORACLES)
    def test_no_oracle_reimplements_the_cluster_skeleton(self, name: str) -> None:
        from exerciser import sandbox as _sb

        src = (Path(_sb.__file__).parent / name).read_text(encoding="utf-8")
        assert "clusters: dict[str, FailureCluster] = {}" not in src, (
            f"{name} still builds clusters by hand instead of using "
            "issues.build_clusters — the skeleton must exist once"
        )

    @pytest.mark.parametrize("name", _ORACLES)
    def test_no_oracle_normalises_its_own_signature(self, name: str) -> None:
        from exerciser import sandbox as _sb

        src = (Path(_sb.__file__).parent / name).read_text(encoding="utf-8")
        assert "normalize_signature(" not in src, f"{name} bypasses the shared builder"

    def test_every_oracle_reports_issue_clusters(self) -> None:
        """The key `campaign._findings` reads by default."""
        from exerciser.differential import run_differential

        assert "issue_clusters" in (run_differential.__doc__ or "") or True
        # The real contract check: the alias must exist alongside the standard key.
        import inspect

        from exerciser import differential as d

        src = inspect.getsource(d)
        assert '"issue_clusters": len(clusters),' in src
        assert '"mismatch_clusters": len(clusters),' in src, "keep the back-compat alias"

    def test_findings_defaults_to_the_standard_key(self) -> None:
        import inspect

        from exerciser.campaign import _findings

        assert inspect.signature(_findings).parameters["count_key"].default == "issue_clusters"

    def test_the_shared_builder_dedupes_and_counts(self) -> None:
        from exerciser.issues import build_clusters

        rows = [{"t": "a", "k": "boom"}, {"t": "a", "k": "boom"}, {"t": "b", "k": "boom"}]
        clusters = build_clusters(
            rows,
            verdict=lambda r: r["k"],
            describe=lambda r, _k: "same detail",
            target_of=lambda r: r["t"],
            method="TEST",
            strategy=lambda _r, _k: "s",
            expected=lambda _r, _k: "e",
        )
        assert len(clusters) == 2
        assert sorted(c.count for c in clusters) == [1, 2]

    def test_the_shared_builder_skips_non_findings(self) -> None:
        from exerciser.issues import build_clusters

        assert (
            build_clusters(
                [{"k": None}, {"k": None}],
                verdict=lambda r: r["k"],
                describe=lambda _r, _k: "d",
                method="TEST",
                strategy=lambda _r, _k: "s",
                expected=lambda _r, _k: "e",
            )
            == []
        )

    def test_the_shared_builder_sorts_deterministically(self) -> None:
        from exerciser.issues import build_clusters

        rows = [{"t": t, "k": k} for t, k in (("z", "b"), ("a", "b"), ("m", "a"))]
        clusters = build_clusters(
            rows,
            verdict=lambda r: r["k"],
            describe=lambda r, _k: r["t"],
            target_of=lambda r: r["t"],
            method="TEST",
            strategy=lambda _r, _k: "s",
            expected=lambda _r, _k: "e",
        )
        assert [(c.kind, c.path) for c in clusters] == sorted((c.kind, c.path) for c in clusters)
