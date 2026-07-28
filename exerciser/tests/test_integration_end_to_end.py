"""End to end, through the REAL pipeline, asserting the CONTRACT with the extension.

Companion to `test_integration_reachability.py`, which drives the CLI as a
subprocess and asserts that each feature is on a path the engine takes. This one
drives the same pipeline in-process and asserts the other half: that what a run
LEAVES BEHIND carries what the reader on the far side needs, and that the stages
between discovery and the verdict did what they claim.

The contract assertions are the point. This branch has now hit the same defect five times:
a producer whose output nothing consumes, with both ends reporting success. A
unit test on the writing end passes whether or not a reading end exists, and a
unit test on the reading end passes against a fixture the writer never produced.
The only thing that catches it is one test that spans the boundary, so the
contract assertions here name the fields by the reader's expectations rather
than by the writer's.

The fixture repo is built to make each stage do real work:

===========================  ==================================================
``src/`` layout              `detect_src_roots` must resolve `src`, not `.`
`[project] name`             the interpreter probe's OWN-distribution signal
a module needing `$DEMO_TOKEN`   the environment induction ladder
a module needing `service/`  the working-directory search (a relative open())
a genuine ZeroDivisionError  a real defect the verdict path must find
a `_private` helper          internal targets are driven, exported ones first
a filesystem writer          the purity guard refuses it; containment drives it
a `requests.post` to a host  the HTTP double substitutes it
a settings dump with a key   nothing may copy the credential into an artifact
===========================  ==================================================
"""

from __future__ import annotations

import ast
import json
import os
import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest

from exerciser import store
from exerciser.campaign import result_path, run_campaign
from exerciser.functions import detect_src_roots, discover_with_refusals, run_functions

# A credential that must never appear in anything the engine writes. Fabricated;
# the shape is what matters, because `redact_text` decides by key name.
FAKE_KEY = "sk-proj-INTEGRATION-NOT-A-REAL-KEY"

_MODULES: dict[str, str] = {
    "pure.py": '''
        """Verified-pure functions: the crash oracle's ordinary path."""


        def add(a: int, b: int) -> int:
            return a + b


        def divide(a: int, b: int) -> float:
            """A REAL defect: the harness's boundary class includes 0."""
            return a / b


        def _scale(n: int) -> int:
            """Private by convention, driven anyway — API stability is not safety."""
            return n * 2
    ''',
    "needs_env.py": '''
        """Import fails until the environment names what it wants."""
        import os

        if not os.environ.get("DEMO_TOKEN"):
            raise RuntimeError("DEMO_TOKEN environment variable is required")


        def token_length(n: int) -> int:
            return n
    ''',
    "impure.py": '''
        """Writes a file, so the purity guard refuses it and containment drives it."""
        from pathlib import Path


        def record(name: str) -> str:
            Path("side-effect.txt").write_text(name, encoding="utf-8")
            return name
    ''',
    "provider.py": '''
        """Reaches a remote API — the substitution's whole reason to exist."""
        import requests


        def ask(prompt: str) -> str:
            reply = requests.post(
                "https://api.example-provider.com/v1/chat?key=SECRETKEYVALUE",
                json={"prompt": prompt},
            )
            return reply.json()["choices"][0]["message"]["content"]
    ''',
    "settings_dump.py": '''
        """Renders its whole input dict when it rejects one field, as pydantic does."""
        import os

        _SEEN = {k: v for k, v in os.environ.items() if k.startswith("DEMO_")}
        if not os.environ.get("DEMO_REGION"):
            raise ValueError(
                "1 validation error for Settings\\nDEMO_REGION\\n  Field required "
                "[type=missing, input_value=" + repr(_SEEN) + "]"
            )


        def region(n: int) -> int:
            return n
    ''',
}


def _write_index(repo: Path, files: dict[str, str]) -> None:
    """A code index over the fixture, derived from its own AST.

    Written rather than shelled out to the Rust indexer: this suite is about the
    exerciser, and depending on a second engine's binary would make it skip on
    any machine that has not built one.
    """
    chunks: list[dict[str, Any]] = []
    for rel, source in files.items():
        tree = ast.parse(source)
        for node in tree.body:
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                chunks.append(
                    {
                        "id": f"{rel}:{node.name}",
                        "file": rel,
                        "lang": "python",
                        "kind": "function",
                        "name": node.name,
                        "start_line": node.lineno,
                        "end_line": getattr(node, "end_lineno", node.lineno),
                        "parent": None,
                    }
                )
    index = repo / ".vinv" / "index"
    index.mkdir(parents=True, exist_ok=True)
    (index / "chunks.jsonl").write_text(
        "".join(json.dumps(c) + "\n" for c in chunks), encoding="utf-8"
    )


@pytest.fixture(scope="module")
def demo_repo(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """The fixture repo. Module-scoped: building it costs real subprocesses."""
    repo = tmp_path_factory.mktemp("demo-repo")
    pkg = repo / "src" / "demo"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")

    written: dict[str, str] = {}
    for name, body in _MODULES.items():
        source = textwrap.dedent(body).strip() + "\n"
        (pkg / name).write_text(source, encoding="utf-8")
        written[f"src/demo/{name}"] = source

    (repo / "pyproject.toml").write_text(
        '[project]\nname = "demo-app"\nversion = "0.1.0"\ndependencies = ["requests"]\n',
        encoding="utf-8",
    )
    # What the repo PUBLISHES about its environment, including a credential that
    # must reach the worker and no artifact.
    (repo / ".env").write_text(
        f"DEMO_REGION=eu-west-1\nOPENAI_API_KEY={FAKE_KEY}\n", encoding="utf-8"
    )
    # A directory the code must run FROM for a relative path to resolve.
    (repo / "service").mkdir()
    (repo / "service" / "fixture.dat").write_text("present\n", encoding="utf-8")

    _write_index(repo, written)
    return repo


@pytest.fixture(scope="module")
def functions_result(demo_repo: Path) -> dict[str, Any]:
    """One real run of the function channel, shared by the assertions below."""
    from exerciser import interpreter

    interpreter.reset_cache()
    env_before = dict(os.environ)
    try:
        return run_functions(demo_repo, max_targets=40)
    finally:
        os.environ.clear()
        os.environ.update(env_before)


# =========================================================================
# Stage 1 — which interpreter, and is it reported
# =========================================================================


def test_the_run_records_the_interpreter_it_used(functions_result: dict[str, Any]) -> None:
    """Without this a run is unreproducible: the single most important input to
    the result was chosen and never written down."""
    chosen = functions_result["interpreter"]
    assert chosen["python"] == sys.executable, "the fixture has no better candidate"
    assert chosen["handed_off"] is False
    assert chosen["repo_distributions"]["declared"] == 1  # demo-app
    assert isinstance(chosen["considered"], list) and chosen["considered"]


# =========================================================================
# Stage 2 — import roots and target discovery
# =========================================================================


def test_a_src_layout_resolves_to_the_src_root(demo_repo: Path) -> None:
    roots = detect_src_roots(demo_repo)
    assert roots[0] == "src"
    assert roots.count(".") == 1, f"the repo root is listed twice: {roots}"


def test_discovery_drives_internals_but_claims_the_public_surface_first(
    demo_repo: Path,
) -> None:
    targets, skipped, refusals = discover_with_refusals(demo_repo, max_targets=40)
    kinds = [t.kind for t in targets]
    names = {t.qualname for t in targets}

    assert "add" in names and "divide" in names
    assert "_scale" in names, "a leading underscore is API stability, not safety"
    # Exported before internal: with a cap, filename order must not decide which
    # functions get driven.
    assert kinds.index("exported") < kinds.index("internal")
    # The filesystem writer is refused by the purity guard and kept for the
    # SANDBOX rather than dropped — a refusal is a recoverable decision.
    refused = {r.target.qualname for r in refusals}
    assert "record" in refused, skipped
    # And the provider call, whose impurity is the network reach itself.
    assert "ask" in refused, skipped


# =========================================================================
# Stage 3 — configuration the repo did not supply
# =========================================================================


def test_the_missing_variable_is_induced_from_the_modules_own_complaint(
    functions_result: dict[str, Any],
) -> None:
    """`needs_env` names DEMO_TOKEN in its exception and nothing else knows it."""
    inductions = functions_result["env_inductions"]
    supplied = {v for entry in inductions for v in entry["variables"]}
    assert "DEMO_TOKEN" in supplied, inductions
    resolved = [e for e in inductions if e["module"].endswith("needs_env")]
    assert resolved and resolved[0]["resolved"] is True, resolved


def test_a_variable_the_repo_already_declares_is_not_induced(
    functions_result: dict[str, Any],
) -> None:
    """`.env` gives DEMO_REGION, so `settings_dump` imports without a ladder."""
    supplied = {v for e in functions_result["env_inductions"] for v in e["variables"]}
    assert "DEMO_REGION" not in supplied


# =========================================================================
# Stage 4 — the verdict path
# =========================================================================


def test_a_real_defect_is_found_and_a_correct_function_is_not(
    functions_result: dict[str, Any],
) -> None:
    verdicts = functions_result["verdicts"]
    assert functions_result["calls"] > 0
    assert verdicts.get("ok", 0) > 0, "nothing was driven successfully"
    targets_with_clusters = {c["endpoint_id"] for c in functions_result["clusters"]}
    assert any("divide" in t for t in targets_with_clusters), functions_result["clusters"]
    assert not any("demo.pure:add" == t for t in targets_with_clusters)


def test_containment_drove_the_target_the_purity_guard_refused(
    functions_result: dict[str, Any],
) -> None:
    sandbox = functions_result["sandbox"]
    assert sandbox["enabled"] is True
    assert sandbox.get("tier"), sandbox
    # `effects` is the per-row list; `effect_totals` is the tally.
    assert sandbox["effect_totals"].get("filesystem", 0) >= 1, sandbox["effect_totals"]
    assert any(e.get("kind") == "filesystem" for e in sandbox["effects"]), sandbox["effects"][:3]


# =========================================================================
# Stage 5 — service substitution
# =========================================================================


def test_the_provider_call_was_substituted_rather_than_left_unreachable(
    functions_result: dict[str, Any],
) -> None:
    """Under containment the network is denied, so without the double this target
    lands as `contained` and is never exercised."""
    services = functions_result["sandbox"].get("services") or {}
    families = {r.get("family") for r in (services.get("requirements") or [])}
    assert "http" in families, services
    assert services.get("enabled") is True
    # The doubles must actually have INSTALLED. A relative import in the copied
    # module made this silently false for every family at once.
    assert not services.get("error"), services.get("error")


def test_a_failure_caused_by_the_double_is_not_blamed_on_the_repo(
    functions_result: dict[str, Any],
) -> None:
    """The double answers with a plausible SHAPE and never a correct value, so a
    target that chokes on the fabricated body failed on OUR value."""
    for gap in functions_result["substitution_gaps"]:
        assert gap["target_id"] not in {c["endpoint_id"] for c in functions_result["clusters"]}


# =========================================================================
# Stage 6 — nothing the engine writes carries a credential
# =========================================================================


def test_no_artifact_contains_the_repos_credential(
    demo_repo: Path, functions_result: dict[str, Any]
) -> None:
    """`.env` is loaded into the worker on purpose. Every artifact is written
    inside the user's repository, one `git add .` from a public push.
    """
    assert FAKE_KEY not in json.dumps(functions_result), "the run summary carries it"
    for artifact in sorted(store.exercise_dir(demo_repo).rglob("*")):
        if not artifact.is_file():
            continue
        text = artifact.read_text(encoding="utf-8", errors="replace")
        assert FAKE_KEY not in text, f"{artifact.name} carries the credential"


# =========================================================================
# Stage 7 — the artifact contract with the extension
# =========================================================================

#: Exactly the fields `extension/src/harness/exerciseRunner.ts` reads. Named from
#: the READER's side deliberately: a writer-side test passes whether or not the
#: reader exists, which is how five producer/consumer breaks reached this branch.
_ENGINE_VERDICT_FIELDS = ("status", "diagnostics")
_ISSUES_CLUSTER_FIELDS = ("signature", "kind", "title", "endpoint_id")


def test_functions_json_carries_what_the_extension_reads(
    demo_repo: Path, functions_result: dict[str, Any]
) -> None:
    doc = store.read_json(store.exercise_dir(demo_repo) / "functions.json")
    assert doc is not None, "functions.json was never written"
    for field in _ENGINE_VERDICT_FIELDS:
        assert field in doc, f"`engineVerdict` reads `{field}` and it is absent"
    assert isinstance(doc["diagnostics"], list)
    assert doc["status"] in ("ok", "environment")


def test_the_campaign_writes_the_artifact_the_extension_reads(demo_repo: Path) -> None:
    """`campaign_result.json` is the RUN's verdict.

    `functions.json` is rewritten by every crash play with `only_targets=[one]`,
    so reading it gives one arm's verdict presented as the run's. This is the
    file that fixes that, and this asserts the campaign actually produces it.
    """
    from exerciser import interpreter

    interpreter.reset_cache()
    result = run_campaign(demo_repo, budget=4, patience=100, max_targets=6)

    persisted = store.read_json(result_path(demo_repo))
    assert persisted is not None, "the campaign's verdict was printed and not written"
    for field in _ENGINE_VERDICT_FIELDS:
        assert field in persisted
    assert persisted["status"] == result["status"]
    assert "own_packages_unimportable" in persisted

    issues = store.read_json(store.issues_path(demo_repo))
    if issues and issues.get("clusters"):
        for cluster in issues["clusters"]:
            for field in _ISSUES_CLUSTER_FIELDS:
                assert field in cluster, f"the dispatch path reads `{field}`"


def test_every_artifact_the_engine_writes_is_json_serialisable(demo_repo: Path) -> None:
    """They are written with `default=str`, so a non-serialisable value degrades
    to a string rather than failing — and then the extension reads a string where
    it expected a number. Reading each one back is the check."""
    for artifact in sorted(store.exercise_dir(demo_repo).glob("*.json")):
        assert store.read_json(artifact) is not None, f"{artifact.name} is not readable JSON"


# =========================================================================
# The handshake: artifacts the extension's tests consume
# =========================================================================

#: Where the extension's `exercisePassEndToEnd.test.ts` looks for real artifacts.
#: Committed, so the TypeScript side reads documents THIS engine produced rather
#: than objects a TypeScript file invented — which is the failure mode a
#: reader-side test cannot see: it passes against a shape the writer never emits.
_FIXTURE_DIR = (
    Path(__file__).resolve().parents[2]
    / "extension"
    / "src"
    / "test"
    / "fixtures"
    / "engine-artifacts"
)

#: The artifacts that cross the boundary. Anything the extension reads belongs
#: here; anything here that the engine stops writing fails on the far side.
_HANDSHAKE_ARTIFACTS = ("issues.json", "campaign_result.json", "functions.json")


def test_the_artifacts_the_extension_reads_are_published_for_its_tests(
    demo_repo: Path, functions_result: dict[str, Any]
) -> None:
    """Emit real artifacts into the extension's fixture directory.

    Not a fixture written by hand on either side: this run produced them, and the
    extension's suite consumes exactly these bytes. A field the engine stops
    emitting therefore fails a TypeScript test, in CI, without anyone thinking to
    look — which is the only mechanism that catches a producer/consumer break,
    because both sides pass in isolation by construction.

    A credential check runs first: these files are COMMITTED, so publishing one
    that carries a secret would put it in the repository permanently.
    """
    from exerciser import interpreter

    interpreter.reset_cache()
    run_campaign(demo_repo, budget=4, patience=100, max_targets=6)

    _FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    published: list[str] = []
    for name in _HANDSHAKE_ARTIFACTS:
        source = store.exercise_dir(demo_repo) / name
        if not source.is_file():
            continue
        text = source.read_text(encoding="utf-8")
        assert FAKE_KEY not in text, f"{name} carries a credential and must not be committed"
        (_FIXTURE_DIR / name).write_text(text, encoding="utf-8")
        published.append(name)

    assert "issues.json" in published, published
    assert "campaign_result.json" in published, published

    # And the contract, asserted on what was just published rather than on what
    # the writer intended: these are the fields the extension takes.
    issues = json.loads((_FIXTURE_DIR / "issues.json").read_text(encoding="utf-8"))
    assert "cluster_count" in issues, "`exerciseStateFromArtifacts` reads `cluster_count`"
    assert isinstance(issues.get("clusters"), list)
    verdict = json.loads((_FIXTURE_DIR / "campaign_result.json").read_text(encoding="utf-8"))
    assert "status" in verdict and "diagnostics" in verdict, "`engineVerdict` reads both"


# =========================================================================
# The oracles the campaign allocates across
# =========================================================================


def test_the_differential_oracle_runs_against_the_real_repo(demo_repo: Path) -> None:
    """Only `crash` and `campaign` had integration coverage; four oracles were
    unit-tested only, so a break in how one is INVOKED was invisible."""
    from exerciser.differential import run_differential

    result = run_differential(demo_repo, timeout_s=60.0)

    assert result["status"] in ("ok", "environment"), result.get("error")
    assert "comparisons" in result
    assert isinstance(result.get("clusters"), list)


def test_the_concurrency_oracle_runs_against_a_real_target(demo_repo: Path) -> None:
    from exerciser.concurrency import run_concurrency

    result = run_concurrency(demo_repo, target="demo.pure:add", workers=2, repeats=2)

    assert result["status"] in ("ok", "environment"), result.get("error")
    assert isinstance(result.get("clusters"), list)
    # `add` is deterministic and pure, so a divergence here would be the oracle's.
    assert not [c for c in result["clusters"] if "divergence" in str(c.get("kind"))], result


def test_the_fault_oracle_runs_from_a_derived_boundary(demo_repo: Path) -> None:
    """Derivation and injection are separate halves and only the first had cover."""
    from exerciser.faults import derive_boundaries, run_faults

    derived, skipped = derive_boundaries(demo_repo, ["demo.pure:divide"])
    assert derived, f"nothing derivable from an annotated target: {skipped}"

    boundary = derived[0]
    result = run_faults(
        demo_repo,
        target=boundary.target,
        contract=dict(boundary.contract),
        baseline=dict(boundary.baseline),
        timeout_s=60.0,
    )

    assert result["status"] in ("ok", "environment"), result.get("error")
    assert result.get("faults_injected", 0) > 0, "a derived boundary produced no faults"


def test_the_environment_oracle_runs(demo_repo: Path) -> None:
    from exerciser.environment import run_environment

    result = run_environment(demo_repo, timeout_s=120.0)
    assert result["status"] in ("ok", "skipped"), result


def test_every_oracle_the_campaign_can_draw_has_a_runner(demo_repo: Path) -> None:
    """The action space and the runner map must not drift apart.

    An armed oracle with no runner drains budget into a no-op — the campaign
    handles it, but only by dropping the actions and saying so, which is a
    recovery rather than a design.
    """
    from exerciser.campaign import OracleConfig, default_runners, enumerate_actions

    space = enumerate_actions(demo_repo, max_targets=6)
    runners = default_runners(OracleConfig(repo=demo_repo))
    armed = {a.oracle for a in space.actions}

    assert armed, f"nothing armed on a repo with real targets: {space.notes}"
    assert armed <= set(runners), f"armed with no runner: {armed - set(runners)}"
