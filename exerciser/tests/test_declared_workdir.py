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

from exerciser.envconfig import declared_workdirs, workdir_claims_for
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
