"""FP-16: honouring `.gitignore` deleted files the repo needs to RUN.

`gitignore_patterns` harvests unanchored BASENAME rules and `copy_repo` excludes
them from the sandbox copy. A `.gitignore` says "not worth version-controlling";
for generated and machine-local code — `_version.py`, `*_pb2.py`, `config.py`,
`local_settings.py`, `data/` — that is the exact OPPOSITE of "not needed to run".

The harm is a silent FALSE NEGATIVE. A pruned file that breaks an import raises
`ImportError` inside the copy, which `functions.py` exempts at import phase, so
every target in the module is dropped with a message indistinguishable from
"this machine lacks a dependency". A pruned file that does NOT break the import
surfaces later as a `FileNotFoundError`, which IS eligible to be reported — a
fabricated finding about a repo that is fine.

So: OFF by default, and when a caller opts in, the copy report says exactly what
was removed, because a module that disappears has to be diagnosable.
"""

from __future__ import annotations

from pathlib import Path

from exerciser.sandbox import (
    MAX_REPORTED_PRUNES,
    SandboxPolicy,
    copy_repo,
    gitignore_patterns,
)


def _repo_with_generated_sources(tmp_path: Path) -> Path:
    """A repo shaped like the ones that broke: generated + machine-local code."""
    repo = tmp_path / "repo"
    (repo / "pkg").mkdir(parents=True)
    (repo / "pkg" / "__init__.py").write_text("from ._version import VERSION\n", encoding="utf-8")
    (repo / "pkg" / "_version.py").write_text("VERSION = '1.2.3'\n", encoding="utf-8")
    (repo / "pkg" / "wire_pb2.py").write_text("MESSAGE = 1\n", encoding="utf-8")
    (repo / "local_settings.py").write_text("DEBUG = False\n", encoding="utf-8")
    (repo / "data").mkdir()
    (repo / "data" / "fixtures.json").write_text("{}", encoding="utf-8")
    (repo / ".gitignore").write_text(
        "_version.py\n*_pb2.py\nlocal_settings.py\ndata/\n", encoding="utf-8"
    )
    return repo


class TestTheDefaultCopiesEverything:
    def test_the_policy_default_is_off(self) -> None:
        assert SandboxPolicy().honour_gitignore is False
        assert SandboxPolicy().to_json()["honour_gitignore"] is False

    def test_generated_and_machine_local_sources_survive(self, tmp_path: Path) -> None:
        repo = _repo_with_generated_sources(tmp_path)
        # The rules are still PARSED — the change is what the copy does with them.
        assert gitignore_patterns(repo) == frozenset(
            {"_version.py", "*_pb2.py", "local_settings.py", "data"}
        )

        dest = tmp_path / "copy"
        report = copy_repo(repo, dest, SandboxPolicy(enabled=True))

        assert (dest / "pkg" / "_version.py").is_file(), "the import would fail without it"
        assert (dest / "pkg" / "wire_pb2.py").is_file()
        assert (dest / "local_settings.py").is_file()
        assert (dest / "data" / "fixtures.json").is_file()
        assert report.gitignore_pruned == ()
        assert report.gitignore_pruned_total == 0

    def test_the_harness_own_excludes_are_unaffected(self, tmp_path: Path) -> None:
        """Turning gitignore off must not start copying `.git` and `node_modules`."""
        repo = tmp_path / "repo"
        (repo / "pkg").mkdir(parents=True)
        (repo / "pkg" / "mod.py").write_text("x = 1\n", encoding="utf-8")
        (repo / ".git").mkdir()
        (repo / ".git" / "objects").write_text("junk" * 100, encoding="utf-8")
        (repo / "node_modules").mkdir()
        (repo / "node_modules" / "big.js").write_text("junk" * 100, encoding="utf-8")

        dest = tmp_path / "copy"
        report = copy_repo(repo, dest, SandboxPolicy(enabled=True))

        assert (dest / "pkg" / "mod.py").is_file()
        assert not (dest / ".git").exists()
        assert not (dest / "node_modules").exists()
        # …and those are NOT attributed to the repo's `.gitignore`, because they
        # are this harness's own fixed policy and can never surprise a reader.
        assert report.gitignore_pruned_total == 0


class TestOptingInIsDiagnosable:
    def test_what_was_pruned_is_named_on_the_report(self, tmp_path: Path) -> None:
        repo = _repo_with_generated_sources(tmp_path)
        dest = tmp_path / "copy"

        report = copy_repo(repo, dest, SandboxPolicy(enabled=True, honour_gitignore=True))

        assert not (dest / "pkg" / "_version.py").exists(), "opt-in still prunes"
        pruned = set(report.gitignore_pruned)
        assert {str(Path("pkg") / "_version.py"), str(Path("pkg") / "wire_pb2.py")} <= pruned
        assert "local_settings.py" in pruned
        assert "data" in pruned
        assert report.gitignore_pruned_total == 4

    def test_the_report_json_carries_it(self, tmp_path: Path) -> None:
        """The run report is the only place an operator can look afterwards."""
        repo = _repo_with_generated_sources(tmp_path)
        report = copy_repo(
            repo, tmp_path / "copy", SandboxPolicy(enabled=True, honour_gitignore=True)
        )
        blob = report.to_json()
        assert blob["gitignore_pruned_total"] == 4
        assert any("_version.py" in name for name in blob["gitignore_pruned"])

    def test_the_name_list_is_bounded_but_the_count_is_not(self, tmp_path: Path) -> None:
        """A 5000-entry ignore file must not turn the report into a transcript."""
        repo = tmp_path / "repo"
        repo.mkdir()
        count = MAX_REPORTED_PRUNES + 17
        for i in range(count):
            (repo / f"junk{i}.tmp").write_text("x", encoding="utf-8")
        (repo / ".gitignore").write_text("*.tmp\n", encoding="utf-8")

        report = copy_repo(
            repo, tmp_path / "copy", SandboxPolicy(enabled=True, honour_gitignore=True)
        )

        assert len(report.gitignore_pruned) == MAX_REPORTED_PRUNES
        assert report.gitignore_pruned_total == count
