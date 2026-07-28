"""Where a module runs from is settled by running it, not by reading the repo.

Every oracle spawned its worker with ``cwd=repo``. A repo's relative paths
resolve against the working directory, so that choice silently decides what the
code under test reads — and it was never a choice, just five hardcoded call
sites.

demo-fastapi is the case that exposed it: correctly configured, ``.env`` present
with 37 lines, settings declaring ``env_file="../.env"`` because the app runs
from ``backend/``. Started at the repo root, ``../.env`` resolved outside the
repo, 14 of 15 modules failed to import, and the engine reported fifteen defects
in a clean repo.

The obvious fix — parse CI files, Dockerfiles, Procfiles — is a list, and a list
covers only the build systems someone thought of. Bazel, Nix, Earthly, a shell
script or a README sentence are all equally valid ways to say where a project
runs. So declarations only ORDER the candidates and the IMPORT decides, which is
the discipline ``containment`` and ``interpreter`` already use.

These tests pin both halves: the hints rank sensibly, and — the part that
actually carries the design — a module whose hints are all WRONG still ends up
running from the directory where it imports.
"""

from __future__ import annotations

import json
import re
import textwrap
from pathlib import Path

from exerciser.envconfig import declared_env, declared_workdirs, workdir_claims_for
from exerciser.functions import candidate_workdirs, run_functions


def _write(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(body).strip() + "\n", encoding="utf-8")


def _index(repo: Path) -> None:
    """The minimal code index ``discover_targets`` reads, built from the sources.

    Same shape as ``test_functions_harness._make_repo``: the harness takes its
    module-level function names from here, not from a fresh parse.
    """
    chunks = []
    for path in sorted(repo.rglob("*.py")):
        rel = path.relative_to(repo).as_posix()
        if ".vinv/" in rel:
            continue
        body = path.read_text(encoding="utf-8")
        for found in re.finditer(r"^(?:async )?def (\w+)", body, re.MULTILINE):
            chunks.append(
                {
                    "id": f"{rel}:{found.group(1)}",
                    "file": rel,
                    "lang": "python",
                    "kind": "function",
                    "name": found.group(1),
                    "start_line": 1,
                    "end_line": 2,
                    "parent": None,
                }
            )
    index = repo / ".vinv" / "index"
    index.mkdir(parents=True, exist_ok=True)
    (index / "chunks.jsonl").write_text(
        "".join(json.dumps(c) + "\n" for c in chunks), encoding="utf-8"
    )


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    (repo / "backend" / "app").mkdir(parents=True)
    (repo / "backend" / "app" / "config.py").write_text("", encoding="utf-8")
    return repo


def _ci(repo: Path, workdir: str, name: str = "test.yml") -> None:
    _write(
        repo / ".github" / "workflows" / name,
        f"""
        jobs:
          test:
            steps:
              - run: pytest
                working-directory: {workdir}
        """,
    )


# =========================================================================
# Hints — they order, they do not rule
# =========================================================================


def test_a_ci_working_directory_is_read(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _ci(repo, "backend")
    claims = workdir_claims_for(repo, "backend/app/config.py")
    assert claims and claims[0].path == "backend"
    assert claims[0].source == "ci-working-directory"


def test_a_dockerfile_workdir_is_mapped_back_through_the_build_context(
    tmp_path: Path,
) -> None:
    """``WORKDIR /app/backend`` is a path in the IMAGE, not on the host.

    It names a host directory only once ``COPY . /app`` says the image root
    corresponds to the repo root.
    """
    repo = _repo(tmp_path)
    _write(repo / "Dockerfile", "FROM python:3.12\nCOPY . /app\nWORKDIR /app/backend/")
    assert any(
        c.path == "backend" and c.source == "dockerfile-workdir" for c in declared_workdirs(repo)
    )


def test_ci_outranks_a_dockerfile(tmp_path: Path) -> None:
    """CI describes running THIS checkout; an image's layout need not mirror it."""
    repo = _repo(tmp_path)
    (repo / "svc").mkdir()
    _ci(repo, "backend")
    _write(repo / "Dockerfile", "FROM python:3.12\nCOPY . /srv\nWORKDIR /srv/svc")
    assert workdir_claims_for(repo, "backend/app/config.py")[0].source == "ci-working-directory"


def test_a_cd_in_a_makefile_counts(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _write(repo / "Makefile", "run:\n\tcd backend && uvicorn app.main:app")
    claims = workdir_claims_for(repo, "backend/app/config.py")
    assert claims and claims[0].path == "backend"


def test_a_claim_that_does_not_contain_the_file_says_nothing_about_it(
    tmp_path: Path,
) -> None:
    """A repo may declare several. The one that applies is the one it lives under."""
    repo = _repo(tmp_path)
    (repo / "frontend").mkdir()
    _ci(repo, "frontend")
    assert workdir_claims_for(repo, "backend/app/config.py") == []


def test_a_ci_expression_is_not_a_path(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    _ci(repo, "${{ matrix.package }}")
    assert declared_workdirs(repo) == []


def test_every_claim_carries_where_it_came_from(tmp_path: Path) -> None:
    """A chosen directory must be auditable, not a silent default."""
    repo = _repo(tmp_path)
    _ci(repo, "backend", name="ci.yml")
    claim = declared_workdirs(repo)[0]
    assert claim.detail == ".github/workflows/ci.yml"
    assert set(claim.to_json()) == {"path", "source", "detail"}


# =========================================================================
# Candidates — bounded, ordered, and always ending somewhere safe
# =========================================================================


def test_the_repo_root_is_always_a_candidate(tmp_path: Path) -> None:
    """The historical behaviour has to remain reachable, or this is a regression.

    Not necessarily LAST: when the repo root is also the distribution that owns
    the file, trying it first is right, and that is exactly the old behaviour.
    What must never happen is it dropping out of the search.
    """
    repo = _repo(tmp_path)
    _ci(repo, "backend")
    assert repo.resolve() in candidate_workdirs(repo, "backend/app/config.py")


def test_a_declaration_is_tried_before_anything_inferred(tmp_path: Path) -> None:
    """Hints exist to make the retry usually free."""
    repo = _repo(tmp_path)
    _ci(repo, "backend")
    assert candidate_workdirs(repo, "backend/app/config.py")[0] == (repo / "backend").resolve()


def test_the_search_is_bounded(tmp_path: Path) -> None:
    """Each candidate costs a worker run, so the list cannot grow with path depth."""
    repo = tmp_path / "repo"
    deep = repo / "a" / "b" / "c" / "d" / "e" / "f"
    deep.mkdir(parents=True)
    (deep / "mod.py").write_text("", encoding="utf-8")

    assert len(candidate_workdirs(repo, "a/b/c/d/e/f/mod.py")) <= 8


def test_a_repo_that_declares_nothing_still_has_candidates(tmp_path: Path) -> None:
    """Being unable to read a project's automation is not being unable to run it."""
    repo = tmp_path / "repo"
    (repo / "libs" / "core" / "acme").mkdir(parents=True)
    (repo / "libs" / "core" / "acme" / "util.py").write_text("", encoding="utf-8")
    _write(repo / "libs" / "core" / "pyproject.toml", '[project]\nname = "acme"\nversion = "0.1"')

    assert declared_workdirs(repo) == []
    candidates = candidate_workdirs(repo, "libs/core/acme/util.py")
    assert candidates[0] == (repo / "libs" / "core").resolve()
    assert candidates[-1] == repo.resolve()


def test_candidates_are_deduplicated(tmp_path: Path) -> None:
    """A single-distribution repo that declares its root must not try it twice."""
    repo = tmp_path / "repo"
    (repo / "pkg").mkdir(parents=True)
    (repo / "pkg" / "mod.py").write_text("", encoding="utf-8")
    _write(repo / "pyproject.toml", '[project]\nname = "solo"\nversion = "0.1"')

    candidates = candidate_workdirs(repo, "pkg/mod.py")
    assert len(candidates) == len(set(candidates))


# =========================================================================
# The part that carries the design: the import decides
# =========================================================================


def _repo_that_only_imports_from_a_subdir(tmp_path: Path) -> Path:
    """A module whose import reads a file by RELATIVE path.

    This is demo-fastapi's shape reduced to its essentials — ``env_file="../.env"``
    is exactly "open a path relative to the process working directory during
    import". From ``svc/`` the file resolves; from the repo root it does not.
    """
    repo = tmp_path / "repo"
    (repo / "svc" / "acme").mkdir(parents=True)
    _write(repo / "pyproject.toml", '[project]\nname = "acme"\nversion = "0.1"')
    _write(repo / "settings.ini", "value = 1")
    (repo / "svc" / "acme" / "__init__.py").write_text("", encoding="utf-8")
    _write(
        repo / "svc" / "acme" / "mod.py",
        """
        from pathlib import Path

        # Resolvable only when the process runs from `svc/`.
        _CONFIG = Path("../settings.ini").read_text(encoding="utf-8")


        def double(n: int) -> int:
            return n * 2
        """,
    )
    _index(repo)
    return repo


def test_a_module_is_run_from_wherever_it_actually_imports(tmp_path: Path) -> None:
    """The whole design, end to end.

    Nothing in this repo declares a working directory, and the distribution is
    the repo ROOT — so every hint points at the wrong place. The module still
    gets driven, because the engine tried the next candidate after the import
    failed.
    """
    repo = _repo_that_only_imports_from_a_subdir(tmp_path)

    result = run_functions(repo, explore=False)

    assert result["calls"] > 0, "the module was never successfully imported"
    assert result["issue_clusters"] == 0, "a clean module was reported as broken"


def test_the_directory_that_worked_is_reported(tmp_path: Path) -> None:
    """A run must say where it decided to run each module from."""
    repo = _repo_that_only_imports_from_a_subdir(tmp_path)

    result = run_functions(repo, explore=False)

    resolutions = result["workdir_resolutions"]
    assert resolutions, "the retry happened but was never reported"
    entry = resolutions[0]
    assert entry["chosen"] == "svc"
    # The failed first attempt is kept: the evidence is the point.
    assert entry["attempts"][0]["import_blocked"] is True
    assert entry["attempts"][-1]["import_blocked"] is False


def test_a_module_that_imports_first_time_costs_no_retry(tmp_path: Path) -> None:
    """The retry is paid ONLY on failure.

    Every module in a healthy repo must run exactly one worker, or this feature
    is a tax on the common case.
    """
    repo = tmp_path / "repo"
    (repo / "acme").mkdir(parents=True)
    _write(repo / "pyproject.toml", '[project]\nname = "acme"\nversion = "0.1"')
    (repo / "acme" / "__init__.py").write_text("", encoding="utf-8")
    _write(repo / "acme" / "mod.py", "def double(n: int) -> int:\n    return n * 2\n")
    _index(repo)

    result = run_functions(repo, explore=False)

    assert result["calls"] > 0
    assert result["workdir_resolutions"] == []


def test_a_module_that_imports_nowhere_is_not_blamed_on_the_directory(
    tmp_path: Path,
) -> None:
    """Exhausting the candidates means it is not a working-directory problem.

    The run must still end with the module's real import failure, not with a
    directory it never had a chance in.
    """
    repo = tmp_path / "repo"
    (repo / "acme").mkdir(parents=True)
    _write(repo / "pyproject.toml", '[project]\nname = "acme"\nversion = "0.1"')
    (repo / "acme" / "__init__.py").write_text("", encoding="utf-8")
    _write(
        repo / "acme" / "mod.py",
        "raise RuntimeError('broken wherever you run me')\n\n\ndef f() -> int:\n    return 1\n",
    )
    _index(repo)

    result = run_functions(repo, explore=False)

    assert result["workdir_resolutions"] == []
    assert result["calls"] == 0


# =========================================================================
# What "the repo itself publishes" has to mean
# =========================================================================


def test_declared_env_never_reads_outside_the_repo(tmp_path: Path) -> None:
    """`workdir.parent` is right for `backend/` and wrong for the repo root.

    The repo root is itself a workdir candidate — it is the last one on every
    list — and there `.parent` is the directory CONTAINING the checkout. A
    developer whose projects sit side by side under one folder, or whose repo
    sits in their home directory, would have had an unrelated project's `.env`
    read and its values exported into the worker running this one.
    """
    outside = tmp_path / ".env"
    outside.write_text("UNRELATED_PROJECT_TOKEN=ghp_REAL_TOKEN\n", encoding="utf-8")
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".env.example").write_text("PROJECT_NAME=demo\n", encoding="utf-8")

    supplied = declared_env(repo, repo)

    assert supplied == {"PROJECT_NAME": "demo"}
    assert "UNRELATED_PROJECT_TOKEN" not in supplied


def test_a_nested_workdir_still_reads_the_repo_root(tmp_path: Path) -> None:
    """The bound is the REPO, not the workdir — the reason `.parent` is consulted
    at all is a `backend/` that declares `env_file="../.env"`."""
    repo = tmp_path / "repo"
    (repo / "backend").mkdir(parents=True)
    (repo / ".env").write_text("SHARED=root\n", encoding="utf-8")
    (repo / "backend" / ".env").write_text("NEAR=backend\n", encoding="utf-8")

    supplied = declared_env(repo, repo / "backend")

    assert supplied == {"NEAR": "backend", "SHARED": "root"}


def test_a_workdir_outside_the_repo_contributes_nothing(tmp_path: Path) -> None:
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / ".env").write_text("STRAY=1\n", encoding="utf-8")
    repo = tmp_path / "repo"
    repo.mkdir()

    assert declared_env(repo, elsewhere) == {}


def test_the_inductions_reason_carries_no_credential() -> None:
    """`env_inductions` sits under a comment saying "names only, never values".

    That is true of `variables` and was not of `reason`, which quotes the
    target's own complaint — and the induction fires precisely when a settings
    object rejects its configuration, which is when a settings object renders its
    whole input dict into the message. The values in that dict are the ones
    `declared_env` just loaded out of the repo's real `.env` and the ones a human
    typed into `config_answers.json`.
    """
    from exerciser.redact import PLACEHOLDER, redact_text

    complaint = (
        "1 validation error for Settings\nPROJECT_NAME\n  Field required "
        "[type=missing, input_value={'openai_api_key': 'sk-proj-EXAMPLE-NOT-REAL', "
        "'postgres_server': 'localhost'}]"
    )
    cleaned = redact_text(complaint)

    assert "sk-proj-EXAMPLE-NOT-REAL" not in cleaned
    assert PLACEHOLDER in cleaned
    # The part that makes the entry worth reporting survives.
    assert "PROJECT_NAME" in cleaned
    assert "'postgres_server': 'localhost'" in cleaned


def test_induction_does_not_strand_a_module_at_the_repo_root(tmp_path: Path) -> None:
    """The two mechanisms have to compose, and they were ordered so they could not.

    `candidate_workdirs` is ordered by likelihood and ends at the repo root — the
    historical fallback — and induction fires only at that LAST entry. So a module
    needing both a real working directory and a supplied variable resolved to
    "repo root plus placeholders": it imported, so nothing failed, and it ran with
    every relative path pointing at the wrong place. That is the failure
    `candidate_workdirs` exists to remove, reached through the one path that
    skipped it.

    Here `backend/` is the right directory (it holds the data file the module
    opens by a relative path) and `APP_TOKEN` is the missing variable. Only the
    combination imports.
    """
    repo = tmp_path
    backend = repo / "backend"
    (backend / "app").mkdir(parents=True)
    (repo / "pyproject.toml").write_text('[project]\nname = "app"\n', encoding="utf-8")
    (backend / "app" / "__init__.py").write_text("", encoding="utf-8")
    # Relative to the WORKING DIRECTORY, so it only resolves from `backend/`.
    (backend / "settings.dat").write_text("ok\n", encoding="utf-8")
    (backend / "app" / "mod.py").write_text(
        textwrap.dedent("""
            import os

            if not os.environ.get("APP_TOKEN"):
                raise RuntimeError("APP_TOKEN environment variable is required")
            with open("settings.dat") as fh:      # relative to the run directory
                _SETTINGS = fh.read()


            def describe(n: int) -> str:
                return str(n)
            """).strip()
        + "\n",
        encoding="utf-8",
    )
    index = repo / ".vinv" / "index"
    index.mkdir(parents=True)
    (index / "chunks.jsonl").write_text(
        json.dumps(
            {
                "id": "backend/app/mod.py:describe",
                "file": "backend/app/mod.py",
                "lang": "python",
                "kind": "function",
                "name": "describe",
                "start_line": 1,
                "end_line": 2,
                "parent": None,
            }
        )
        + "\n",
        encoding="utf-8",
    )

    result = run_functions(repo, max_targets=5)

    inductions = result.get("env_inductions") or []
    assert inductions, "the module's own complaint named APP_TOKEN and nothing induced it"
    assert inductions[0]["resolved"] is True
    assert inductions[0]["resolved_from"] == "backend"
    resolutions = result.get("workdir_resolutions") or []
    chosen = [r for r in resolutions if r.get("module", "").endswith("mod")]
    assert chosen, f"no working directory was recorded: {resolutions}"
    # The point: NOT the repo root, and reached only because the directory
    # question was asked again once the environment answered.
    assert chosen[0]["chosen"] == "backend", chosen[0]
    assert any(a.get("reordered_after_induction") for a in chosen[0]["attempts"]), chosen[0]
