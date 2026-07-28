"""A worker's working directory is a choice, and it was being made wrongly.

Every oracle spawned its worker with ``cwd=repo``. That is not neutral: a
repo's relative paths — an ``env_file``, a data file, a template directory —
resolve against the process working directory, so choosing it changes what the
code under test reads.

Found on demo-fastapi, a repo that was correctly configured the whole time. Its
settings declare ``env_file="../.env"``, relative because the app runs from
``backend/`` and the file sits at the repo root. Started from the repo root
instead, ``../.env`` resolved OUTSIDE the repo, every required setting was
missing, and 14 of 15 modules failed to import — reported as fifteen defects in
someone's clean repo. Run from ``backend/``, the same code loads a 37-line
``.env`` and imports cleanly.

The rule is the one ``detect_src_roots`` already applies to imports: the
distribution is the unit. These tests pin that, and pin the fallback — a
single-distribution repo must keep the previous behaviour exactly.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

from exerciser.functions import detect_src_roots, distribution_cwd


def _dist(directory: Path, name: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "pyproject.toml").write_text(
        textwrap.dedent(f"""
            [project]
            name = "{name}"
            version = "0.1.0"
            """).strip(),
        encoding="utf-8",
    )


def test_a_nested_distribution_runs_from_its_own_directory(tmp_path: Path) -> None:
    """The demo-fastapi shape: one distribution one level down."""
    repo = tmp_path / "repo"
    _dist(repo / "backend", "demo-backend")
    (repo / "backend" / "app").mkdir(parents=True)
    (repo / "backend" / "app" / "config.py").write_text("", encoding="utf-8")

    assert distribution_cwd(repo, "backend/app/config.py") == (repo / "backend").resolve()


def test_the_deepest_declaring_ancestor_wins(tmp_path: Path) -> None:
    """A monorepo root usually carries a manifest too; it must not shadow members."""
    repo = tmp_path / "repo"
    _dist(repo, "monorepo-root")
    _dist(repo / "libs" / "core", "acme-core")
    (repo / "libs" / "core" / "acme_core").mkdir(parents=True)
    (repo / "libs" / "core" / "acme_core" / "util.py").write_text("", encoding="utf-8")

    assert (
        distribution_cwd(repo, "libs/core/acme_core/util.py") == (repo / "libs" / "core").resolve()
    )


def test_a_single_distribution_repo_is_unchanged(tmp_path: Path) -> None:
    """The previous behaviour, which is correct here and must not move."""
    repo = tmp_path / "repo"
    _dist(repo, "solo")
    (repo / "solo").mkdir()
    (repo / "solo" / "mod.py").write_text("", encoding="utf-8")

    assert distribution_cwd(repo, "solo/mod.py") == repo.resolve()


def test_a_file_no_distribution_claims_falls_back_to_the_repo(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _dist(repo / "backend", "demo-backend")
    (repo / "scripts").mkdir()
    (repo / "scripts" / "tool.py").write_text("", encoding="utf-8")

    assert distribution_cwd(repo, "scripts/tool.py") == repo.resolve()


def test_a_repo_with_no_manifest_at_all_falls_back(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / "pkg").mkdir(parents=True)
    (repo / "pkg" / "mod.py").write_text("", encoding="utf-8")

    assert distribution_cwd(repo, "pkg/mod.py") == repo


def test_the_cwd_and_the_import_root_agree_on_who_owns_a_file(tmp_path: Path) -> None:
    """Both answers come from the same distribution, or the worker is incoherent.

    A module imported as ``acme_core.util`` but run from the repo root reads a
    different filesystem than the one its package expects. The two rules have to
    be derived from the same unit.
    """
    repo = tmp_path / "repo"
    _dist(repo, "monorepo-root")
    _dist(repo / "libs" / "core", "acme-core")
    (repo / "libs" / "core" / "acme_core").mkdir(parents=True)
    (repo / "libs" / "core" / "acme_core" / "util.py").write_text("", encoding="utf-8")

    roots = detect_src_roots(repo)
    cwd = distribution_cwd(repo, "libs/core/acme_core/util.py")

    assert "libs/core" in roots
    assert cwd.relative_to(repo.resolve()).as_posix() == "libs/core"


def test_a_relative_path_the_repo_declares_resolves_from_the_chosen_cwd(
    tmp_path: Path,
) -> None:
    """The end-to-end shape of the bug, without needing pydantic.

    `../config.ini` is reachable from the distribution directory and is NOT
    reachable from the repo root — which is exactly what happened to
    demo-fastapi's `env_file="../.env"`.
    """
    repo = tmp_path / "repo"
    _dist(repo / "backend", "demo-backend")
    (repo / "backend" / "app").mkdir(parents=True)
    (repo / "backend" / "app" / "config.py").write_text("", encoding="utf-8")
    (repo / "config.ini").write_text("[x]\ny = 1\n", encoding="utf-8")

    cwd = distribution_cwd(repo, "backend/app/config.py")

    assert (cwd / "../config.ini").resolve().is_file()
    assert not (repo / "../config.ini").resolve().is_file()
