"""Choosing the interpreter that can actually import the target.

The bug these tests pin came from a real run, not a fixture. Against a clone of
langchain-ai/langchain the engine reported ``status: "ok"``, ``issue_clusters:
0``, ``diagnostics: []`` — while 185 of 288 outcomes were
``ModuleNotFoundError: No module named 'langchain_core'``, because the workers
ran under Vinv's own venv. The same command with ``--python`` pointed at the
repo's venv produced 642 calls and 5 defect clusters.

So the tests are built around the ways the choice could go wrong:

* the repo's venv is not called ``.venv`` (the real one was ``.venv-target``),
  so any name-based discovery misses it;
* Vinv's own venv shares enough ordinary libraries (pydantic, requests, PyYAML)
  with the target that a flat "how many dependencies do you have" count nearly
  ties — 20 against 15 on the real repo — and would invert on a repo with more
  common dependencies still;
* an active ``VIRTUAL_ENV`` is ALWAYS Vinv's own when the CLI runs, so trusting
  it re-elects exactly the interpreter this module exists to stop electing;
* the manifests inside a venv's ``site-packages`` are other projects', and
  reading them measures every candidate against pandas' dependency list;
* a repo's venv can be older than the worker's own ``requires-python`` floor,
  which must be reported rather than crashed into;
* an explicit ``--python`` must never be second-guessed, however bad it looks.

The fake environments here are REAL venvs (``python -m venv``) with synthetic
``.dist-info`` directories dropped in, so the probe subprocess is exercised for
real rather than mocked out.
"""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from exerciser import interpreter
from exerciser.interpreter import (
    MIN_WORKER_PYTHON,
    Candidate,
    Probe,
    Requirements,
    _requirement_name,
    declared_requirements,
    discover_candidates,
    normalize_dist,
    probe_candidate,
    resolve_interpreter,
)

# =========================================================================
# Fixtures — real venvs, synthetic metadata
# =========================================================================


def _make_venv(root: Path, dists: list[str]) -> str:
    """A real venv at ``root``, reporting ``dists`` as installed.

    ``--without-pip`` keeps it to roughly a quarter of a second; the metadata is
    written by hand because what the probe reads is ``.dist-info``, not an
    actual package. Nothing is downloaded and nothing is imported.
    """
    subprocess.run(
        [sys.executable, "-m", "venv", "--without-pip", str(root)],
        check=True,
        capture_output=True,
    )
    site = next(root.glob("lib/python*/site-packages"), None) or (root / "Lib/site-packages")
    site.mkdir(parents=True, exist_ok=True)
    for dist in dists:
        info = site / f"{dist.replace('-', '_')}-1.0.dist-info"
        info.mkdir(exist_ok=True)
        (info / "METADATA").write_text(
            f"Metadata-Version: 2.1\nName: {dist}\nVersion: 1.0\n", encoding="utf-8"
        )
    exe = next((p for p in (root / "bin/python3", root / "Scripts/python.exe") if p.exists()), None)
    assert exe is not None, "venv produced no interpreter"
    return str(exe)


def _pyproject(directory: Path, name: str, deps: list[str]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    rendered = ", ".join(f'"{d}"' for d in deps)
    (directory / "pyproject.toml").write_text(
        textwrap.dedent(f"""
            [project]
            name = "{name}"
            version = "0.1.0"
            dependencies = [{rendered}]
            """).strip(),
        encoding="utf-8",
    )


@pytest.fixture(autouse=True)
def _clear_cache():
    interpreter.reset_cache()
    yield
    interpreter.reset_cache()


@pytest.fixture
def monorepo(tmp_path: Path) -> Path:
    """A two-package monorepo, shaped like the repo that exposed this."""
    repo = tmp_path / "repo"
    _pyproject(repo, "demo-root", ["demo-core", "requests"])
    _pyproject(repo / "libs" / "core", "demo-core", ["pydantic"])
    return repo


# =========================================================================
# Requirement parsing
# =========================================================================


@pytest.mark.parametrize(
    ("spec", "expected"),
    [
        ("langchain-core", "langchain-core"),
        ("langchain_core>=0.3.0,<0.4", "langchain-core"),
        ("Foo.Bar_baz==1.0", "foo-bar-baz"),
        ("pydantic[email]>=2", "pydantic"),
        ('httpx ; python_version < "3.12"', "httpx"),
        ("requests @ https://example.invalid/requests.whl", "requests"),
        ("  tenacity  ", "tenacity"),
        # Not names: flags, comments, paths, URLs, the marker variable itself.
        ("-r other.txt", None),
        ("-e ./libs/core", None),
        ("# a comment", None),
        ("./local/pkg", None),
        ("python", None),
        ("", None),
    ],
)
def test_requirement_names_survive_the_shapes_a_manifest_actually_carries(
    spec: str, expected: str | None
) -> None:
    assert _requirement_name(spec) == expected


def test_normalisation_collapses_the_pep503_separators() -> None:
    assert normalize_dist("Foo_Bar.Baz") == normalize_dist("foo-bar-baz") == "foo-bar-baz"


def test_a_monorepo_declares_its_own_packages_separately_from_its_dependencies(
    monorepo: Path,
) -> None:
    reqs = declared_requirements(monorepo)
    assert set(reqs.own) == {"demo-root", "demo-core"}
    # `demo-core` is declared as a dependency of the root too. It belongs to the
    # repo, so it is counted once — on the side that discriminates.
    assert "demo-core" not in reqs.third_party
    assert set(reqs.third_party) == {"requests", "pydantic"}


def test_manifests_inside_a_venv_are_not_read_as_the_repos_own(monorepo: Path) -> None:
    """A venv's site-packages is full of other projects' manifests.

    Reading them would measure every candidate against some vendored library's
    dependency list — and, worse, would add that library's name to the repo's
    "own" set, which is the number the whole ranking turns on.
    """
    vendored = monorepo / ".venv-target" / "lib" / "python3.12" / "site-packages" / "alien"
    _pyproject(vendored, "alien-package", ["numpy"])
    (monorepo / ".venv-target" / "pyvenv.cfg").parent.mkdir(parents=True, exist_ok=True)
    (monorepo / ".venv-target" / "pyvenv.cfg").write_text("version_info = 3.12\n", encoding="utf-8")

    reqs = declared_requirements(monorepo)
    assert "alien-package" not in reqs.own
    assert "numpy" not in reqs.third_party


# =========================================================================
# Candidate discovery
# =========================================================================


def test_a_venv_is_found_by_its_marker_not_by_its_name(tmp_path: Path, monkeypatch) -> None:
    """The venv that exposed this bug was called ``.venv-target``.

    Any list of blessed directory names — ``.venv``, ``venv``, ``env`` — misses
    it. ``pyvenv.cfg`` is written by the interpreter itself, so it is the marker
    that cannot be renamed out of existence.
    """
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    repo = tmp_path / "repo"
    _pyproject(repo, "demo", [])
    exe = _make_venv(repo / "kitchen-sink", [])

    origins = {c.python: c.origin for c in discover_candidates(repo)}
    assert exe in origins
    assert origins[exe] == "in-repo venv"


def test_the_fallback_is_always_present_and_always_last(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _pyproject(repo, "demo", [])
    candidates = discover_candidates(repo)
    assert candidates[-1].python == sys.executable
    assert candidates[-1].origin == "vinv's own interpreter"


def test_an_active_virtualenv_outside_the_repo_is_ignored(tmp_path: Path, monkeypatch) -> None:
    """Vinv's own venv is active on every CLI invocation.

    Treating ``VIRTUAL_ENV`` as a signal would nominate the interpreter this
    module exists to move off, and would do it with a confident-looking origin.
    """
    repo = tmp_path / "repo"
    _pyproject(repo, "demo", [])
    outside = tmp_path / "elsewhere"
    outside_exe = _make_venv(outside, [])
    monkeypatch.setenv("VIRTUAL_ENV", str(outside))

    assert all(c.origin != "VIRTUAL_ENV" for c in discover_candidates(repo))
    assert outside_exe not in {c.python for c in discover_candidates(repo)}


def test_an_active_virtualenv_inside_the_repo_is_offered(tmp_path: Path, monkeypatch) -> None:
    repo = tmp_path / "repo"
    _pyproject(repo, "demo", [])
    _make_venv(repo / ".venv", [])
    monkeypatch.setenv("VIRTUAL_ENV", str(repo / ".venv"))

    assert any(c.origin == "VIRTUAL_ENV" for c in discover_candidates(repo))


def test_the_explicit_flag_leads_the_list(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _pyproject(repo, "demo", [])
    candidates = discover_candidates(repo, explicit="/opt/somewhere/bin/python")
    assert candidates[0].origin == "--python"
    assert candidates[0].python == "/opt/somewhere/bin/python"


def test_one_venv_named_twice_is_one_candidate(tmp_path: Path, monkeypatch) -> None:
    """The same environment reached by three routes must be probed once."""
    repo = tmp_path / "repo"
    _pyproject(repo, "demo", [])
    exe = _make_venv(repo / ".venv", [])
    monkeypatch.setenv("VINV_TARGET_PYTHON", exe)
    monkeypatch.setenv("VIRTUAL_ENV", str(repo / ".venv"))

    keys = [c.key() for c in discover_candidates(repo)]
    assert len(keys) == len(set(keys))
    # The venv, and Vinv's own interpreter. Nothing counted twice.
    assert len(keys) == 2


def test_two_venvs_built_from_one_base_python_are_not_one_candidate(
    tmp_path: Path, monkeypatch
) -> None:
    """The dedup trap that made every fixture in this file pass wrongly.

    A venv's ``bin/python3`` is a SYMLINK to the base interpreter, so keying
    candidates on ``os.path.realpath`` collapses every venv created from the
    same Python into a single entry. The target's venv and Vinv's own venv then
    look like one candidate — with entirely different ``site-packages`` — and
    whichever was discovered first silently won.
    """
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    a = _make_venv(tmp_path / "a", [])
    b = _make_venv(tmp_path / "b", [])

    assert Path(a).resolve() == Path(b).resolve(), "fixture assumes a shared base interpreter"
    assert Candidate(a, "test").key() != Candidate(b, "test").key()


def test_the_two_names_for_one_venvs_interpreter_collapse(tmp_path: Path) -> None:
    root = tmp_path / "env"
    _make_venv(root, [])
    assert Candidate(str(root / "bin" / "python"), "x").key() == (
        Candidate(str(root / "bin" / "python3"), "x").key()
    )


def test_a_tool_environment_is_not_queried_for_a_repo_that_only_has_a_pyproject(
    tmp_path: Path, monkeypatch
) -> None:
    """``pyproject.toml`` alone is not evidence that a repo uses poetry.

    Nearly every Python repo has one, and ``poetry env info --path`` reports the
    ACTIVATED virtualenv — which is always Vinv's own while the CLI runs. Gating
    on the bare manifest re-nominated exactly the interpreter this module exists
    to move off, labelled "poetry environment" so it read as corroboration.
    """
    repo = tmp_path / "repo"
    _pyproject(repo, "demo", [])
    outside = tmp_path / "elsewhere"
    outside_exe = _make_venv(outside, [])
    monkeypatch.setenv("VIRTUAL_ENV", str(outside))

    assert outside_exe not in {c.python for c in discover_candidates(repo)}


# =========================================================================
# The probe
# =========================================================================


def test_the_probe_reports_what_is_installed_and_what_is_not(tmp_path: Path) -> None:
    exe = _make_venv(tmp_path / "env", ["demo-core", "requests"])
    reqs = Requirements(own=("demo-core",), third_party=("requests", "absent-thing"))

    probe = probe_candidate(Candidate(exe, "test"), reqs)

    assert probe.ok
    assert probe.own_present == ("demo-core",)
    assert probe.third_present == ("requests",)
    assert "absent-thing" in probe.missing
    assert probe.score == (1, 1)


def test_the_probe_normalises_names_the_way_packaging_does(tmp_path: Path) -> None:
    """``Demo_Core`` in METADATA and ``demo-core`` in a manifest are one name."""
    exe = _make_venv(tmp_path / "env", ["Demo_Core"])
    probe = probe_candidate(Candidate(exe, "test"), Requirements(own=("demo-core",)))
    assert probe.own_present == ("demo-core",)


def test_a_candidate_that_cannot_be_executed_is_an_answer_not_a_crash(tmp_path: Path) -> None:
    probe = probe_candidate(Candidate(str(tmp_path / "nope"), "test"), Requirements(own=("x",)))
    assert not probe.ok
    assert probe.error
    assert probe.score == (0, 0)


def test_the_probe_does_not_import_the_target(tmp_path: Path) -> None:
    """Measuring a candidate must not execute the repo.

    ``importlib.metadata`` reads ``.dist-info`` off the filesystem, so a package
    whose import would raise, hang, or write to disk is still counted correctly.
    """
    exe = _make_venv(tmp_path / "env", ["demo-core"])
    site = next((tmp_path / "env").glob("lib/python*/site-packages"))
    (site / "demo_core.py").write_text("raise SystemExit('imported!')\n", encoding="utf-8")

    probe = probe_candidate(Candidate(exe, "test"), Requirements(own=("demo-core",)))
    assert probe.ok
    assert probe.own_present == ("demo-core",)


def test_the_probe_is_isolated_from_a_shadowing_module_in_the_repo(tmp_path: Path) -> None:
    """A repo with its own ``json.py`` must not break the probe's own imports."""
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "json.py").write_text("raise RuntimeError('shadowed')\n", encoding="utf-8")
    exe = _make_venv(tmp_path / "env", ["demo-core"])

    probe = probe_candidate(Candidate(exe, "test"), Requirements(own=("demo-core",)), cwd=repo)
    assert probe.ok
    assert probe.own_present == ("demo-core",)


# =========================================================================
# The choice
# =========================================================================


def test_the_interpreter_with_the_repo_installed_wins(monorepo: Path, monkeypatch) -> None:
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    target = _make_venv(monorepo / ".venv-target", ["demo-root", "demo-core"])

    choice = resolve_interpreter(monorepo)

    assert choice.python == target
    assert choice.handed_off
    assert choice.target_installed
    assert choice.own_present == 2


def test_shared_third_party_libraries_do_not_outvote_the_repos_own_packages(
    monorepo: Path, monkeypatch
) -> None:
    """The real failure mode, in miniature.

    On langchain the two candidates scored 20 and 15 on a flat dependency count
    — Vinv's own venv genuinely has requests, pydantic and a dozen others — and
    4 against 0 on the repo's own distributions. A flat count is one common
    dependency away from picking the wrong interpreter; this pins the ordering
    that is not.
    """
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    # Has the repo, and none of its third-party dependencies.
    target = _make_venv(monorepo / ".venv-target", ["demo-root", "demo-core"])
    # Has every third-party dependency, and nothing of the repo.
    _make_venv(monorepo / ".venv-decoy", ["requests", "pydantic"])

    choice = resolve_interpreter(monorepo)

    assert choice.python == target
    assert choice.own_present == 2
    assert choice.third_present == 0


def test_a_tie_keeps_vinvs_own_interpreter(tmp_path: Path, monkeypatch) -> None:
    """The handoff is paid for by evidence or it does not happen.

    A repo that declares nothing, or one already installed into Vinv's venv,
    must behave exactly as it did before this module existed — otherwise every
    existing test in this suite is running somewhere new.
    """
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    repo = tmp_path / "repo"
    _pyproject(repo, "demo", [])
    _make_venv(repo / ".venv", [])

    choice = resolve_interpreter(repo)

    assert choice.python == sys.executable
    assert not choice.handed_off
    assert choice.diagnostics == []


def test_a_repo_that_declares_nothing_changes_nothing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()
    choice = resolve_interpreter(repo)
    assert choice.python == sys.executable
    assert not choice.handed_off


def test_every_candidate_considered_is_reported(monorepo: Path, monkeypatch) -> None:
    """A wrong choice must be debuggable from the run summary alone."""
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    _make_venv(monorepo / ".venv-target", ["demo-root", "demo-core"])

    doc = resolve_interpreter(monorepo).to_json()

    assert len(doc["considered"]) >= 2
    origins = {c["origin"] for c in doc["considered"]}
    assert {"in-repo venv", "vinv's own interpreter"} <= origins
    for entry in doc["considered"]:
        assert entry["repo_distributions_present"].endswith("/2")


def test_the_handoff_is_announced(monorepo: Path, monkeypatch) -> None:
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    _make_venv(monorepo / ".venv-target", ["demo-root", "demo-core"])

    choice = resolve_interpreter(monorepo)

    assert choice.diagnostics
    assert "workers will run under" in choice.diagnostics[0]
    assert "--python" in choice.diagnostics[0]


# =========================================================================
# The explicit flag is not second-guessed
# =========================================================================


def test_an_explicit_python_is_used_even_when_a_better_one_exists(
    monorepo: Path, tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    _make_venv(monorepo / ".venv-target", ["demo-root", "demo-core"])
    barren = _make_venv(tmp_path / "barren", [])

    choice = resolve_interpreter(monorepo, explicit=barren)

    assert choice.python == barren
    assert choice.origin == "--python"


def test_an_explicit_python_without_the_target_is_called_out(
    monorepo: Path, tmp_path: Path
) -> None:
    """Pointing the flag at the wrong venv used to produce the same silent zero."""
    barren = _make_venv(tmp_path / "barren", [])

    choice = resolve_interpreter(monorepo, explicit=barren)

    assert choice.diagnostics
    assert "NONE of the" in choice.diagnostics[0]
    assert not choice.target_installed


def test_an_unprobeable_explicit_python_is_still_honoured(monorepo: Path, tmp_path: Path) -> None:
    missing = str(tmp_path / "not-a-python")
    choice = resolve_interpreter(monorepo, explicit=missing)
    assert choice.python == missing
    assert any("could not be probed" in d for d in choice.diagnostics)


def test_the_explicit_flag_short_circuits_the_fan_out(monorepo: Path, tmp_path: Path) -> None:
    """Probing candidates that cannot win is pure cost."""
    _make_venv(monorepo / ".venv-target", ["demo-root"])
    barren = _make_venv(tmp_path / "barren", [])

    choice = resolve_interpreter(monorepo, explicit=barren)

    assert len(choice.considered) == 1


# =========================================================================
# The worker's own floor
# =========================================================================


def test_an_interpreter_below_the_worker_floor_is_not_runnable() -> None:
    old = Probe(ok=True, version=(3, 9, 18), own_present=("demo-core",))
    assert not old.runnable
    assert Probe(ok=True, version=MIN_WORKER_PYTHON, own_present=()).runnable


def test_a_too_old_venv_is_reported_rather_than_silently_skipped(
    monorepo: Path, monkeypatch
) -> None:
    """ "The repo's venv is older than our worker" is a fact the human needs.

    Handing an exerciser worker to a 3.9 interpreter reports OUR SyntaxError as
    the repo's defect; staying on the fallback without saying why looks like a
    clean run under a well-chosen interpreter. Neither is acceptable.
    """
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    exe = _make_venv(monorepo / ".venv-old", ["demo-root", "demo-core"])
    real = interpreter.probe_candidate

    def _aged(candidate, reqs, **kwargs):
        probe = real(candidate, reqs, **kwargs)
        if candidate.python == exe:
            probe.version = (3, 9, 18)
        return probe

    monkeypatch.setattr(interpreter, "probe_candidate", _aged)

    choice = resolve_interpreter(monorepo)

    assert choice.python == sys.executable
    assert not choice.handed_off
    assert any("below exerciser's" in d and "3.9.18" in d for d in choice.diagnostics)


# =========================================================================
# Caching
# =========================================================================


def test_the_choice_is_memoised_per_repo_and_flag(monorepo: Path, monkeypatch) -> None:
    """The campaign resolves the same answer for five oracles in one run."""
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    _make_venv(monorepo / ".venv-target", ["demo-root", "demo-core"])
    calls = 0
    real = interpreter.probe_candidate

    def _counted(*args, **kwargs):
        nonlocal calls
        calls += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(interpreter, "probe_candidate", _counted)

    first = interpreter.resolve_cached(monorepo)
    after_first = calls
    second = interpreter.resolve_cached(monorepo)

    assert first.python == second.python
    assert calls == after_first, "a second resolve re-probed every candidate"


# =========================================================================
# End to end, against this repo
# =========================================================================


def test_exerciser_itself_resolves_to_the_interpreter_running_these_tests() -> None:
    """The suite's own repo IS installed into the interpreter running it.

    So the correct answer is "change nothing" — and this is the guard that the
    default path of every other test in the suite has not moved.
    """
    repo = Path(__file__).resolve().parents[1]
    choice = resolve_interpreter(repo)
    assert choice.python == sys.executable
    assert not choice.handed_off


def test_the_report_is_json_serialisable(monorepo: Path) -> None:
    """It lands in the run summary, which is written to disk and printed."""
    _make_venv(monorepo / ".venv-target", ["demo-root"])
    json.dumps(resolve_interpreter(monorepo).to_json())
