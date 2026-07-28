"""Does anything actually REACH the thing that was built?

Every failure this branch shipped had the same shape, and unit tests could not
see any of them:

* the HTTP double worked perfectly against its own classes and was never
  installed, because no HTTP module produced a service requirement and
  ``install()`` is gated on requirements;
* the agent channel was written to disk and no consumer existed;
* the fault oracle's contract questions were queued in memory and never saved;
* ``evidenceFileForKind`` had no case for the kinds that fire most.

In each case the component's own tests passed, because the component worked.
What was missing was any test that the component is on a path the engine takes.

So these tests drive the REAL CLI as a subprocess against synthetic repos and
assert on the artifacts a run leaves behind. They are slower than unit tests and
they are the only kind that can fail when a feature becomes unreachable — which
is the failure mode this branch actually had, four times.

Deliberately NOT asserting on defect counts or cluster contents: those belong to
the oracles' own tests and would make this file fail for reasons that have
nothing to do with reachability.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

#: The engine is driven exactly as a user drives it. `-m exerciser.cli` rather
#: than the console script so the test does not depend on an install layout.
_CLI = [sys.executable, "-m", "exerciser.cli"]

_RUN_TIMEOUT_S = 300.0


def _write(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(body).strip() + "\n", encoding="utf-8")


def _index(repo: Path) -> None:
    """The minimal code index discovery reads, built from the sources."""
    chunks = []
    for path in sorted(repo.rglob("*.py")):
        rel = path.relative_to(repo).as_posix()
        if ".vinv/" in rel:
            continue
        for found in re.finditer(r"^def (\w+)", path.read_text(encoding="utf-8"), re.M):
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


def _run(repo: Path, *args: str) -> dict:
    """Run the real CLI and return its parsed summary."""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [p for p in (env.get("PYTHONPATH"), str(Path(__file__).parents[1] / "src")) if p]
    )
    proc = subprocess.run(
        [*_CLI, "functions", str(repo), *args],
        capture_output=True,
        text=True,
        timeout=_RUN_TIMEOUT_S,
        env=env,
    )
    start = proc.stdout.find("{")
    assert start >= 0, f"the CLI produced no JSON:\n{proc.stdout}\n{proc.stderr}"
    return json.loads(proc.stdout[start:])


def _artifact(repo: Path, name: str) -> dict:
    return json.loads((repo / ".vinv" / "exercise" / name).read_text(encoding="utf-8"))


# =========================================================================
# Fixtures — repos shaped like the failures that motivated each layer
# =========================================================================


@pytest.fixture
def plain_repo(tmp_path: Path) -> Path:
    """A repo that needs nothing: no config, no services, no venv."""
    repo = tmp_path / "plain"
    _write(repo / "pyproject.toml", '[project]\nname = "plain"\nversion = "0.1.0"')
    _write(repo / "plain" / "__init__.py", "")
    _write(repo / "plain" / "calc.py", "def double(n: int) -> int:\n    return n * 2")
    _index(repo)
    return repo


@pytest.fixture
def provider_repo(tmp_path: Path) -> Path:
    """A repo whose only external dependency is a remote API.

    The exact shape that made the HTTP double unreachable: nothing here is a
    database, a cache or an object store, so before `HTTP_FAMILY` existed this
    repo produced no service requirement at all.
    """
    repo = tmp_path / "provider"
    _write(repo / "pyproject.toml", '[project]\nname = "prov"\nversion = "0.1.0"')
    _write(repo / "prov" / "__init__.py", "")
    _write(
        repo / "prov" / "client.py",
        """
        import httpx


        def summarize(text: str) -> str:
            reply = httpx.Client().post(
                "https://api.openai.com/v1/chat/completions",
                json={"model": "gpt-4", "messages": [{"role": "user", "content": text}]},
                headers={"Authorization": "Bearer sk-not-a-real-key"},
            )
            return str(reply.json()["choices"][0]["message"]["content"])
        """,
    )
    _index(repo)
    return repo


@pytest.fixture
def unconfigured_repo(tmp_path: Path) -> Path:
    """A repo whose import needs an environment variable nothing supplies."""
    repo = tmp_path / "unconfigured"
    _write(repo / "pyproject.toml", '[project]\nname = "unconf"\nversion = "0.1.0"')
    _write(repo / "unconf" / "__init__.py", "")
    _write(
        repo / "unconf" / "settings.py",
        """
        import os

        PROJECT_SLUG = os.environ["VINV_TEST_SLUG"]


        def slug() -> str:
            return PROJECT_SLUG
        """,
    )
    _index(repo)
    return repo


# =========================================================================
# Every layer, asserted to have actually run
# =========================================================================


def test_interpreter_resolution_runs_and_is_reported(plain_repo: Path) -> None:
    """The choice must be in the summary, or the run is unreproducible."""
    result = _run(plain_repo)
    interpreter = result["interpreter"]
    assert interpreter["python"], "no interpreter was recorded"
    assert interpreter["considered"], "no candidates were probed"


def test_the_run_records_where_it_looked_for_configuration(plain_repo: Path) -> None:
    """These fields exist so a run says what it did. Absent, nothing is auditable."""
    result = _run(plain_repo)
    for field in ("interpreter", "import_preconditions", "env_inductions", "config_requests"):
        assert field in result, f"{field} missing from the run summary"


def test_a_repo_needing_nothing_escalates_nothing(plain_repo: Path) -> None:
    """The ladder must cost nothing when it is not needed."""
    result = _run(plain_repo)
    assert result["calls"] > 0, "a trivial pure function was never called"
    assert result["config_requests"] == []
    assert result["env_inductions"] == []


def test_config_requests_is_written_even_when_empty(plain_repo: Path) -> None:
    """The UI must distinguish "nothing is asked" from "no run got this far".

    Written every run, so a stale prompt for a variable that is now satisfied
    cannot persist in the panel.
    """
    _run(plain_repo)
    doc = _artifact(plain_repo, "config_requests.json")
    assert doc["requests"] == []
    assert doc["answers_path"].endswith("config_answers.json")


# ---- the layer that shipped unreachable ---------------------------------


def test_a_provider_repo_declares_a_service_requirement(provider_repo: Path) -> None:
    """The gate that made the HTTP double dead code.

    `install()` runs only when the plan carries requirements. This repo has no
    database, cache or object store — if an HTTP client does not produce a
    requirement, the doubles never install and every patcher is unreachable.
    """
    from exerciser.services import HTTP_FAMILY, discover_requirements

    families = {r.family for r in discover_requirements(provider_repo)}
    assert HTTP_FAMILY in families


def test_the_http_double_actually_serves_a_provider_call(provider_repo: Path) -> None:
    """The end-to-end assertion that unit tests could not make.

    No API key, no network. The call must COMPLETE — not land as `contained`,
    which is what happened before the substitution existed, and not fail, which
    is what happened while the double was unreachable.
    """
    result = _run(provider_repo)

    assert result["calls"] > 0, "the provider-backed function was never called"
    assert (
        result["verdicts"].get("ok", 0) > 0
    ), f"no call succeeded — the double did not serve: {result['verdicts']}"

    events = result["sandbox"]["services"]["events"]
    served = [e for e in events if e.get("kind") == "substituted" and e.get("service") == "http"]
    assert served, f"the HTTP double recorded no participation: {events[:3]}"
    assert "api.openai.com" in served[0]["detail"]


def test_the_substituted_value_reaches_the_target(provider_repo: Path) -> None:
    """The body has to satisfy the access path, or the call completes with junk."""
    _run(provider_repo)
    rows = [
        json.loads(line)
        for line in (provider_repo / ".vinv/exercise/function_results.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()
        if line.strip()
    ]
    returned = [str(r.get("result")) for r in rows if r.get("phase") == "call"]
    assert returned, "no call rows were recorded"
    assert any(
        "vinv-substituted" in value for value in returned
    ), f"the target did not receive the substituted body: {returned[:3]}"


# ---- configuration, all the way to the escalation ------------------------


def test_a_missing_variable_is_induced_rather_than_reported_as_a_defect(
    unconfigured_repo: Path,
) -> None:
    """The induction has to actually run, not merely exist."""
    result = _run(unconfigured_repo)

    induced = result["env_inductions"]
    assert induced, "nothing was induced for a module that names a missing variable"
    assert any("VINV_TEST_SLUG" in entry["variables"] for entry in induced)
    assert any(
        entry["resolved"] for entry in induced
    ), "the variable was named and supplied but the module still did not import"


def test_an_induced_run_calls_the_code_it_unblocked(unconfigured_repo: Path) -> None:
    """Supplying a value is worthless unless the target then runs."""
    result = _run(unconfigured_repo)
    assert result["calls"] > 0


def test_a_user_answer_is_read_back_on_the_next_run(unconfigured_repo: Path) -> None:
    """The write-back contract the panel depends on.

    The panel writes this file; if the engine does not read it, every answer a
    person gives is discarded and they are asked again forever.
    """
    answers = unconfigured_repo / ".vinv" / "exercise" / "config_answers.json"
    answers.parent.mkdir(parents=True, exist_ok=True)
    answers.write_text(
        json.dumps({"version": 1, "answers": {"VINV_TEST_SLUG": "from-the-user"}}),
        encoding="utf-8",
    )

    result = _run(unconfigured_repo)

    assert result["calls"] > 0
    # The value came from the answers file, so nothing had to be induced for it.
    induced_names = {n for entry in result["env_inductions"] for n in entry["variables"]}
    assert "VINV_TEST_SLUG" not in induced_names


def test_the_working_directory_search_is_reported(tmp_path: Path) -> None:
    """A module that only imports from a subdirectory must still be driven."""
    repo = tmp_path / "cwd"
    _write(repo / "pyproject.toml", '[project]\nname = "cwd"\nversion = "0.1.0"')
    _write(repo / "settings.ini", "value = 1")
    _write(repo / "svc" / "pkg" / "__init__.py", "")
    _write(
        repo / "svc" / "pkg" / "mod.py",
        """
        from pathlib import Path

        _CONFIG = Path("../settings.ini").read_text(encoding="utf-8")


        def double(n: int) -> int:
            return n * 2
        """,
    )
    _index(repo)

    result = _run(repo)

    assert result["calls"] > 0, "the module never imported from any candidate directory"
    assert result["workdir_resolutions"], "the retry happened but was not reported"
    assert result["workdir_resolutions"][0]["chosen"] == "svc"


# ---- the contract that keeps the doubles installable ---------------------


def test_the_doubles_install_at_all(provider_repo: Path) -> None:
    """Any failure here silently disables EVERY double, not just one.

    `service_doubles` is copied into the jail as a standalone module beside a
    generated `sitecustomize`, so a package-relative import inside it raises
    `attempted relative import with no known parent package` and `install()`
    aborts — taking sql, kv, objectstore and http down together while each
    target merely looks like it could not connect.

    That happened: a `from .redact import redact_url` added for a real leak
    disabled every substitution in the engine, and the only visible symptom was
    calls landing as `contained`.
    """
    result = _run(provider_repo)
    services = result["sandbox"]["services"]
    assert services.get("error") is None, f"the doubles did not install: {services.get('error')}"


def test_the_copied_modules_import_standalone(tmp_path: Path) -> None:
    """Load the shim's copies the way the jail does: no package, no parent.

    Asserted by IMPORTING them rather than by grepping for `from .`, because the
    failure is an import failure and only an import can prove the absence of
    one.
    """
    from exerciser.sandbox import write_shim

    write_shim(tmp_path)
    assert (tmp_path / "_vinv_service_doubles.py").is_file()

    probe = subprocess.run(
        [sys.executable, "-c", "import _vinv_service_doubles as d; print(bool(d.install))"],
        capture_output=True,
        text=True,
        cwd=str(tmp_path),
        timeout=60,
    )
    assert probe.returncode == 0, f"the standalone copy does not import: {probe.stderr}"


def test_a_recorded_request_line_carries_no_credential(tmp_path: Path) -> None:
    """The ledger records the URL the double answered, and URLs carry keys.

    Gemini authenticates with `?key=`, Azure SAS with `?sig=`, AWS presigns with
    `?signature=`. The client still gets the real URL; only what is written down
    is redacted.
    """
    repo = tmp_path / "keyed"
    _write(repo / "pyproject.toml", '[project]\nname = "keyed"\nversion = "0.1.0"')
    _write(repo / "keyed" / "__init__.py", "")
    _write(
        repo / "keyed" / "client.py",
        """
        import httpx


        def fetch() -> str:
            reply = httpx.Client().get(
                "https://generativelanguage.googleapis.com/v1/models?key=AIzaSyREALKEYVALUE"
            )
            return str(reply.json()["candidates"][0]["content"])
        """,
    )
    _index(repo)

    result = _run(repo)
    recorded = json.dumps(result["sandbox"]["services"].get("events", []))
    assert "AIzaSyREALKEYVALUE" not in recorded, "the double wrote a live key into the ledger"


# ---- the agentic fallback, for what no pattern can read -------------------


def test_an_unreadable_failure_is_handed_to_the_harness(tmp_path: Path) -> None:
    """The gap that made the ladder a pattern match and nothing else.

    ``missing_env_names`` reads the shapes in which a program says a variable is
    missing, and that set is finite while the ways to say it are not. A repo
    raising its own ``NeedsSetup("the widget registry has not been provisioned")``
    names nothing in any recognisable form — so nothing was induced, nothing was
    unsatisfied, and nothing escalated. The module stayed blocked and no one was
    asked, which is the pattern silently being the only path.
    """
    repo = tmp_path / "weird"
    _write(repo / "pyproject.toml", '[project]\nname = "weird"\nversion = "0.1.0"')
    _write(repo / "weird" / "__init__.py", "")
    _write(
        repo / "weird" / "mod.py",
        """
        class NeedsSetup(Exception):
            pass


        def _bootstrap():
            raise NeedsSetup("cannot start: the widget registry has not been provisioned")


        _bootstrap()


        def go() -> int:
            return 1
        """,
    )
    _index(repo)

    result = _run(repo)

    asked = result["blocked_imports_asked"]
    assert asked, "an unreadable import failure was dropped instead of asked about"
    assert asked[0]["module"] == "weird.mod"
    assert "widget registry" in asked[0]["reason"]
    doc = _artifact(repo, "agent_blocked-import.json")
    assert doc["questions"], "the question was reported but never persisted"


def test_a_readable_failure_does_not_bother_the_harness(tmp_path: Path) -> None:
    """The patterns stay because they are free.

    A ``KeyError`` from ``os.environ[...]`` is settled by induction with no model
    call at all, and must not also raise a question.
    """
    repo = tmp_path / "readable"
    _write(repo / "pyproject.toml", '[project]\nname = "readable"\nversion = "0.1.0"')
    _write(repo / "readable" / "__init__.py", "")
    _write(
        repo / "readable" / "mod.py",
        """
        import os

        SLUG = os.environ["VINV_READABLE_SLUG"]


        def slug() -> str:
            return SLUG
        """,
    )
    _index(repo)

    result = _run(repo)

    assert result["blocked_imports_asked"] == []
    assert any(e["resolved"] for e in result["env_inductions"])


def test_a_harness_answer_for_a_blocked_module_is_read_back(tmp_path: Path) -> None:
    """The loop has to close, or asking was theatre."""
    repo = tmp_path / "answered"
    _write(repo / "pyproject.toml", '[project]\nname = "answered"\nversion = "0.1.0"')
    _write(repo / "answered" / "__init__.py", "")
    _write(
        repo / "answered" / "mod.py",
        """
        import os

        if "VINV_ODD_GATE" not in os.environ:
            raise SystemError("the gate is shut")

        VALUE = os.environ["VINV_ODD_GATE"]


        def value() -> str:
            return VALUE
        """,
    )
    _index(repo)
    _run(repo)

    channel_path = repo / ".vinv" / "exercise" / "agent_blocked-import.json"
    doc = json.loads(channel_path.read_text(encoding="utf-8"))
    for entry in doc["questions"].values():
        entry["answer"] = {"variables": {"VINV_ODD_GATE": "open"}, "blocker": None}
    channel_path.write_text(json.dumps(doc), encoding="utf-8")

    result = _run(repo)
    assert result["calls"] > 0, "the harness answered and the module still was not driven"


def test_a_credential_never_returns_through_the_blocked_channel(tmp_path: Path) -> None:
    """A model that helpfully hallucinates an API key must not get it used."""
    from exerciser.envconfig import blocked_module_answers

    exercise = tmp_path / ".vinv" / "exercise"
    exercise.mkdir(parents=True)
    (exercise / "agent_blocked-import.json").write_text(
        json.dumps(
            {
                "topic": "blocked-import",
                "questions": {
                    "k": {
                        "answer": {
                            "variables": {"OPENAI_API_KEY": "sk-hallucinated", "REGION": "eu"},
                            "blocker": None,
                        }
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    answers = blocked_module_answers(tmp_path)
    assert "OPENAI_API_KEY" not in answers
    assert answers == {"REGION": "eu"}
