"""The four blockers a real third-party repo exposed that no synthetic test did.

Driving the campaign against a clone of huggingface/smolagents (1414 indexed
chunks, 275 module-level functions) surfaced defects that every fixture in this
suite was too small or too clean to reach:

1. A nested union in an annotation (``list[Step | None]``) sent annotation
   parsing into unbounded recursion, so ``discover_targets`` raised
   ``RecursionError`` and the campaign armed ZERO oracles.
2. A play whose worker never reached the target was scored as a clean play:
   coverage bonus paid, posterior updated, ``status: ok`` reported.
3. Import cost and call cost shared one deadline, so a module that takes 27s to
   import (any torch/pandas/transformers-adjacent repo) was killed mid-import
   and blamed for "a call hung".
4. The containment shim replaced the ``subprocess.Popen`` CLASS with a function,
   so every module that transitively imported ``asyncio`` failed to import on
   Windows — and the harness reported each failure as a defect in the user's
   repo. Eighteen fabricated findings on a clean codebase.

Each test below fails on the code as it was.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from exerciser.campaign import Play, _as_count, is_inconclusive
from exerciser.functions import (
    DEFAULT_CALL_BUDGET_S,
    _is_pure_container_annotation,
    _split_top_level,
    _union_members,
    annotation_base,
    call_verdict,
    classify_row,
    is_control_flow_signal,
)

# =========================================================================
# 1. Nested unions in annotations
# =========================================================================

# (annotation, expected annotation_base, expected pure-container verdict)
_NESTED_UNIONS = [
    # The exact shapes smolagents uses.
    ("list[ChatMessage | dict]", "list", "list"),
    ("list[TaskStep | ActionStep | PlanningStep]", "list", "list"),
    ("dict[str, dict[str, str | type | bool]]", "dict", "dict"),
    # A bar nested one level down, and two levels down.
    ("dict[str, int | None]", "dict", "dict"),
    ("list[dict[str, int | None]]", "list", "list"),
    # A bar nested inside a Callable's argument list, which uses [[...]].
    ("Callable[[int | str], bool]", "callable", None),
    # Nested union under a non-container head.
    ("Awaitable[int | None]", "awaitable", None),
]


@pytest.mark.parametrize(("annotation", "base", "pure"), _NESTED_UNIONS)
def test_a_nested_union_terminates_and_reads_the_outer_head(
    annotation: str, base: str | None, pure: str | None
) -> None:
    """``"|" in text`` is not the same question as "is this a union".

    Both callers recursed on their first top-level member; with the bar nested,
    the only member IS the whole string, so the recursion never shrank its
    input. The correct answer for a nested union is the OUTER constructor.
    """
    assert _union_members(annotation) is None, "nested bar is not a top-level union"
    assert annotation_base(annotation) == base
    assert _is_pure_container_annotation(annotation) == pure


@pytest.mark.parametrize(
    ("annotation", "members"),
    [
        ("list[str] | None", ["list[str]"]),
        ("dict[str,int]|None", ["dict[str,int]"]),
        ("list[int] | Path", ["list[int]", "Path"]),
        ("int | str | None", ["int", "str"]),
        # A top-level bar AND a nested one: the top-level split must still win,
        # and each member is then resolved on its own.
        ("dict[str, int | None] | None", ["dict[str, int | None]"]),
    ],
)
def test_a_genuine_top_level_union_still_decomposes(annotation: str, members: list[str]) -> None:
    assert _union_members(annotation) == members


def test_the_impurity_backstop_still_refuses_a_union_with_a_non_container() -> None:
    """The regression this fix must not cause.

    ``list[int] | Path`` may hold a ``Path``, whose ``.unlink()`` is exactly what
    the pure-container backstop exists for. A fix that made unions cheap by
    reading the first member would have quietly approved it.
    """
    assert _is_pure_container_annotation("list[int] | Path") is None
    assert _is_pure_container_annotation("dict[str, int] | object") is None
    # ...but a union of two containers of the SAME builtin is still pure.
    assert _is_pure_container_annotation("list[int] | list[str]") == "list"
    # ...and a union of two DIFFERENT containers is not, because the guard
    # cannot say which one a call site saw.
    assert _is_pure_container_annotation("list[int] | dict[str, int]") is None


def test_an_unbalanced_closer_does_not_blind_the_splitter() -> None:
    """Depth went negative, so every later separator looked nested.

    A truncated or malformed annotation string (``"]bad | list[int]"``) made the
    splitter return the whole string — which is the same input that drove the
    recursion above. Clamping at zero confines the damage to the bad character.
    """
    assert _split_top_level("]bad | list[int]", "|") == ["]bad", "list[int]"]
    assert _split_top_level(")x | y", "|") == [")x", "y"]
    # Sanity: balanced input is unaffected.
    assert _split_top_level("a[b|c] | d", "|") == ["a[b|c]", "d"]


@pytest.mark.parametrize("annotation", ["", "   ", "|", "||", "None", "none | None"])
def test_degenerate_annotations_resolve_without_recursing(annotation: str) -> None:
    """No input may reach the recursive branch without shrinking."""
    annotation_base(annotation)  # must simply return
    _is_pure_container_annotation(annotation)


def test_discovery_survives_a_module_full_of_nested_unions(tmp_path: Path) -> None:
    """End to end: the shape that armed zero oracles.

    ``discover_targets`` walks every function's annotations, so one nested union
    anywhere in the repo raised ``RecursionError`` out of discovery — which
    ``campaign`` caught as "function oracles unavailable" and reported as a
    healthy run with nothing to do.
    """
    from exerciser.functions import discover_targets

    pkg = tmp_path / "pkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "m.py").write_text(
        "class Step: pass\n"
        "def a(x: list[Step | None]) -> int: return len(x)\n"
        "def b(y: dict[str, str | bool]) -> int: return len(y)\n"
        "def c(z: list[dict[str, int | None]]) -> int: return len(z)\n",
        encoding="utf-8",
    )
    index = tmp_path / ".vinv" / "index"
    index.mkdir(parents=True)
    (index / "chunks.jsonl").write_text(
        "".join(
            json.dumps({"kind": "function", "file": "pkg/m.py", "name": n, "parent": None}) + "\n"
            for n in ("a", "b", "c")
        ),
        encoding="utf-8",
    )

    targets, _skipped = discover_targets(tmp_path)
    assert {t.qualname for t in targets} >= {"a", "b", "c"}


# =========================================================================
# 2. Inconclusive plays
# =========================================================================


def test_a_play_that_did_no_work_and_found_nothing_is_inconclusive() -> None:
    assert is_inconclusive(Play(work=0, violations=0)) is True


def test_a_play_that_found_something_is_conclusive_whatever_its_counter_says() -> None:
    """A violation is proof the oracle ran. The counter does not get a veto."""
    assert is_inconclusive(Play(work=0, violations=1)) is False
    assert is_inconclusive(Play(work=0, signatures=("abc",))) is False


def test_an_oracle_that_reports_no_counter_is_treated_as_conclusive() -> None:
    """``None`` means unknown, not zero.

    Concurrency and environment report no work counter. Treating unknown as
    zero would silently stop the bandit learning from them at all — trading one
    silent failure for another.
    """
    assert is_inconclusive(Play()) is False
    assert is_inconclusive(Play(work=None, violations=0)) is False


def test_a_play_that_did_work_and_found_nothing_is_conclusive() -> None:
    """The ordinary clean result. This MUST still teach the bandit."""
    assert is_inconclusive(Play(work=12, violations=0)) is False


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (0, 0),
        (7, 7),
        (None, None),
        ("12", None),  # a string counter cannot support a claim that work happened
        (-1, None),  # nor can a negative one
        (True, None),  # bool is an int subclass; a flag is not a count
        (False, None),
        (1.5, None),
    ],
)
def test_work_counters_are_read_conservatively(raw: object, expected: int | None) -> None:
    assert _as_count(raw) == expected


def test_inconclusive_plays_claim_no_coverage_pay_no_credit_and_are_counted(
    tmp_path: Path,
) -> None:
    """The whole point, at the loop level.

    Every runner claims ``covered=(action.target,)`` the instant it is invoked.
    A worker that never imported the target therefore collected the exploration
    bonus and posted a Bernoulli update, so the bandit developed preferences
    over arms it had never measured — and the report said ``status: ok``.
    """
    from exerciser.bandit import Action
    from exerciser.campaign import run_campaign

    action = Action(target="pkg.m:f", technique="deterministic", oracle="crash")

    def never_reaches_the_target(_a: Action) -> Play:
        return Play(work=0, violations=0, covered=(action.target,), subprocesses=1)

    result = run_campaign(
        tmp_path,
        actions=[action],
        runners={"crash": never_reaches_the_target},
        budget=4,
        seed=1,
    )

    assert result["plays_run"] == 4, "budget is still spent — the time was really burned"
    assert result["inconclusive_plays"] == 4
    assert result["new_ground"] == 0, "no ground may be claimed by a play that ran nothing"
    assert all(p["inconclusive"] is True for p in result["plays"])
    assert all(p["credit"] == 0.0 for p in result["plays"])
    assert all(p["new_coverage"] == 0 for p in result["plays"])
    assert any(
        "reached no target" in d for d in result["diagnostics"]
    ), "the report must SAY that nothing was exercised"
    # The posterior must be untouched: alpha/beta still at their priors.
    by_oracle = result["by_oracle"]["crash"]
    assert by_oracle["violations"] == 0
    assert by_oracle["coverage_sum"] == 0


def test_a_productive_play_is_unaffected_by_the_inconclusive_path(tmp_path: Path) -> None:
    """The control. A play that works must still be credited and counted."""
    from exerciser.bandit import Action
    from exerciser.campaign import run_campaign

    action = Action(target="pkg.m:f", technique="deterministic", oracle="crash")
    calls = {"n": 0}

    def finds_one_thing(_a: Action) -> Play:
        calls["n"] += 1
        return Play(
            work=5,
            violations=1,
            signatures=(f"sig-{calls['n']}",),
            covered=(f"ground-{calls['n']}",),
            subprocesses=1,
        )

    result = run_campaign(
        tmp_path,
        actions=[action],
        runners={"crash": finds_one_thing},
        budget=3,
        seed=1,
    )
    assert result["inconclusive_plays"] == 0
    assert result["violations"] == 3
    assert result["new_ground"] == 3
    assert all(p["inconclusive"] is False for p in result["plays"])
    assert not any("reached no target" in d for d in result["diagnostics"])


# =========================================================================
# 3. Import cost vs call cost
# =========================================================================

_SLOW_IMPORT_PKG = """\
import time

time.sleep({sleep})


def quick(n: int) -> int:
    return n * 2
"""

# The shape that broke: an import that eats almost all of the module allowance,
# followed by calls that need more time than the remainder. Under one shared
# deadline the worker is killed before finishing them; with the budgets split the
# calls get their own clock. Each target is called once per input class, so the
# per-call sleep is multiplied.
_SLOW_IMPORT_SLOW_CALLS = """\
import time

time.sleep(5)


def slow_call(n: int) -> int:
    time.sleep(3)
    return n * 2
"""


def _repo_with(tmp_path: Path, module_src: str, functions: tuple[str, ...]) -> Path:
    pkg = tmp_path / "slowpkg"
    pkg.mkdir(parents=True, exist_ok=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "m.py").write_text(module_src, encoding="utf-8")
    index = tmp_path / ".vinv" / "index"
    index.mkdir(parents=True, exist_ok=True)
    (index / "chunks.jsonl").write_text(
        "".join(
            json.dumps({"kind": "function", "file": "slowpkg/m.py", "name": n, "parent": None})
            + "\n"
            for n in functions
        ),
        encoding="utf-8",
    )
    return tmp_path


def test_a_slow_import_does_not_consume_the_call_budget(tmp_path: Path) -> None:
    """The blocker: 27s to import, a 30s combined deadline, zero calls made.

    The import allowance is deliberately smaller than the sleep is long-ish
    relative to the CALL budget, so a shared deadline would leave nothing. With
    the split, the calls get their full budget however long the import took.
    """
    repo = _repo_with(tmp_path, _SLOW_IMPORT_SLOW_CALLS, ("slow_call",))
    from exerciser.functions import run_functions

    # 5s import against an 8s module allowance leaves ~2s; the calls need ~9s.
    # One shared deadline of 8s therefore kills the worker mid-call and records
    # `ModuleTimeout` — "a call hung" — for a module that was merely slow to load.
    result = run_functions(repo, module_timeout_s=8.0, call_budget_s=25.0, explore=False)
    assert result["calls"] > 0, "the calls must happen even after a slow import"
    assert result["module_timeouts"] == [], "a slow import is not a hung call"


def test_the_import_duration_is_reported_as_evidence(tmp_path: Path) -> None:
    """A slow import must be visible AS a slow import, not inferred from silence."""
    repo = _repo_with(tmp_path, _SLOW_IMPORT_PKG.format(sleep=1), ("quick",))
    from exerciser.functions import run_functions

    result = run_functions(repo, explore=False)
    rows = [
        json.loads(ln)
        for ln in Path(result["results_file"]).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    imports = [r for r in rows if r.get("phase") == "import" and r.get("status") == "ok"]
    assert imports, "a successful import must leave a row"
    assert imports[0]["duration_ms"] >= 900.0


def test_a_module_wedged_in_import_is_still_killed(tmp_path: Path) -> None:
    """The backstop must not have been traded away.

    Widening the parent deadline is only safe if a worker that hangs before it
    can enforce anything of its own is still reaped.
    """
    repo = _repo_with(
        tmp_path, "import time\n\ntime.sleep(600)\n\n\ndef f() -> int:\n    return 1\n", ("f",)
    )
    from exerciser.functions import run_functions

    result = run_functions(repo, module_timeout_s=2.0, call_budget_s=2.0, explore=False)
    assert result["module_timeouts"] == ["slowpkg.m"]


def test_the_call_budget_is_enforced_and_says_why(tmp_path: Path) -> None:
    """Overrunning targets are skipped with a reason, not killed silently.

    Being reaped by the parent instead would discard the remaining plan and
    attribute the whole module to a hang — losing both the completed results and
    the explanation.
    """
    src = (
        "import time\n\n\n"
        "def slow_one(n: int) -> int:\n    time.sleep(4)\n    return n\n\n\n"
        "def slow_two(n: int) -> int:\n    time.sleep(4)\n    return n\n\n\n"
        "def slow_three(n: int) -> int:\n    time.sleep(4)\n    return n\n"
    )
    repo = _repo_with(tmp_path, src, ("slow_one", "slow_two", "slow_three"))
    from exerciser.functions import run_functions

    result = run_functions(repo, module_timeout_s=20.0, call_budget_s=3.0, explore=False)
    rows = [
        json.loads(ln)
        for ln in Path(result["results_file"]).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    exhausted = [r for r in rows if r.get("error_type") == "CallBudgetExhausted"]
    assert exhausted, "the budget must be enforced inside the worker"
    assert result["module_timeouts"] == [], "a spent call budget is not an outer timeout"
    assert any(
        r.get("phase") == "call" and r.get("status") == "ok" for r in rows
    ), "the targets that fit in the budget must still have run"


def test_the_default_call_budget_is_a_real_number() -> None:
    assert DEFAULT_CALL_BUDGET_S > 0


# =========================================================================
# 5. SystemExit from a CLI entry point is not a defect
# =========================================================================


@pytest.mark.parametrize(
    "mro",
    [
        ["SystemExit", "BaseException", "object"],
        ["KeyboardInterrupt", "BaseException", "object"],
        ["GeneratorExit", "BaseException", "object"],
        # A repo's own subclass of SystemExit is still a control-flow signal.
        ["CleanExit", "SystemExit", "BaseException", "object"],
    ],
)
def test_a_non_exception_baseexception_is_a_control_flow_signal(mro: list[str]) -> None:
    assert is_control_flow_signal(mro) is True


@pytest.mark.parametrize(
    "mro",
    [
        ["ValueError", "Exception", "BaseException", "object"],
        ["TypeError", "Exception", "BaseException", "object"],
        ["IndexError", "LookupError", "Exception", "BaseException", "object"],
        ["MyAppError", "Exception", "BaseException", "object"],
        # An OSError is a real failure, however process-adjacent it feels.
        ["PermissionError", "OSError", "Exception", "BaseException", "object"],
    ],
)
def test_ordinary_exceptions_are_not_control_flow_signals(mro: list[str]) -> None:
    """The rule must not become a blanket amnesty."""
    assert is_control_flow_signal(mro) is False


@pytest.mark.parametrize("mro", [[], ["object"], ["Weird"]])
def test_a_missing_or_nonsense_mro_is_not_treated_as_control_flow(mro: list[str]) -> None:
    """Absent evidence must not buy the exemption — fail toward reporting."""
    assert is_control_flow_signal(mro) is False


def test_a_cli_entry_point_exiting_is_not_reported_as_a_crash() -> None:
    """The false positive that reached issues.json on first contact.

    ``ArgumentParser.error`` is documented to exit 2, so calling any argparse
    entry point with made-up arguments raises ``SystemExit(2)``. The harness
    reported ``function-crash: SystemExit: 2`` — one false positive per CLI, in
    the one artifact the extension surfaces to the user.
    """
    row = {
        "phase": "call",
        "status": "error",
        "target_id": "pkg.cli:parse_arguments",
        "input_class": "valid",
        "annotations_resolved": True,
        "error_type": "SystemExit",
        "error_module": "builtins",
        "error_mro": ["SystemExit", "BaseException", "object"],
        "error": "2",
    }
    assert call_verdict(row) == "control-flow"
    assert classify_row(row) is None, "must not become a reportable cluster"


def test_the_control_flow_rule_does_not_touch_an_ordinary_crash() -> None:
    """The rule must claim only its own class of row.

    Whether this row is finally a ``defect`` or a ``rejected`` is the learned
    policy's call, from evidence across the whole run — not this rule's. What
    matters here is that the exemption does not intercept it on the way.
    """
    row = {
        "phase": "call",
        "status": "error",
        "target_id": "pkg.scorer:split_string",
        "input_class": "boundary",
        "annotations_resolved": True,
        "error_type": "PatternError",
        "error_module": "re",
        "error_mro": ["PatternError", "Exception", "BaseException", "object"],
        "error": "unterminated character set at position 0",
    }
    assert call_verdict(row) != "control-flow"


def test_the_real_smolagents_defect_is_still_found_end_to_end(tmp_path: Path) -> None:
    """The control that matters: the true positive must survive all five fixes.

    This is ``examples/open_deep_research/scripts/gaia_scorer.py:split_string``
    reduced to its defect. ``char_list=[]`` — an ordinary boundary value for a
    ``list[str]`` parameter — builds the pattern ``"[]"``, and ``re.split`` raises
    ``PatternError: unterminated character set``. The function also never escapes
    its input. Found on the real repo; it must keep being found.

    The clean siblings are load-bearing, not padding. The verdict is decided by
    DISPERSION across targets: an exception that every target raises is how the
    repo says "no", one that a single target raises is that target's own doing.
    With ``split_string`` alone in the module its ``PatternError`` has 100%
    dispersion and is correctly suppressed — the policy working, not failing. The
    real repo supplied 36 targets' worth of contrast; this supplies eight.

    Two DETERMINISTIC properties are asserted, because whether any single run
    reports the cluster is deliberately not deterministic: on thin evidence the
    verdict is a Thompson DRAW, so a suppressed signature stays reachable rather
    than guaranteed (3 of 5 arbitrary seeds surface this one). Asserting "it is
    always reported" would be asserting against the design.
    """
    from exerciser.functions import run_functions

    clean = "".join(f"def clean_{i}(s: str) -> int:\n    return len(s)\n\n\n" for i in range(1, 8))
    src = (
        "import re\n\n\n"
        + clean
        + "def split_string(s: str, char_list: list[str] = [',', ';']) -> list[str]:\n"
        "    pattern = f\"[{''.join(char_list)}]\"\n"
        "    return re.split(pattern, s)\n"
    )
    repo = _repo_with(tmp_path, src, tuple(f"clean_{i}" for i in range(1, 8)) + ("split_string",))

    # 1. RANKING. The genuine defect must be ranked far above the noise. Every
    #    target rejects `None` with a TypeError — that is the repo's vocabulary
    #    for "no" — while exactly one raises PatternError. Z-Ranking's whole
    #    claim is that dispersion separates these, and it must hold on real
    #    shapes, not only on hand-built policies.
    result = run_functions(repo, explore=False)
    assert result["calls"] > 0
    policy = result["exception_policy"]
    assert "PatternError@stdlib" in policy, f"the defect must be scored at all: {policy}"
    assert "TypeError@stdlib" in policy
    defect_p = policy["PatternError@stdlib"]["defect_probability"]
    noise_p = policy["TypeError@stdlib"]["defect_probability"]
    assert defect_p > noise_p * 5, (
        f"the one-target PatternError ({defect_p}) must outrank the eight-target "
        f"TypeError ({noise_p}) by a wide margin"
    )
    assert policy["PatternError@stdlib"]["targets"] == 1
    assert policy["TypeError@stdlib"]["targets"] == 8

    # 2. REACHABILITY. With exploration on and a seed whose draw surfaces it, the
    #    finding must travel all the way to a reported cluster — proving the path
    #    is open after all five fixes, not merely that the score is high.
    import shutil

    shutil.rmtree(repo / ".vinv" / "exercise", ignore_errors=True)
    explored = run_functions(repo, explore=True, seed=1)
    kinds = {c.get("kind") for c in (explored["clusters"] or [])}
    assert (
        "function-crash" in kinds
    ), f"the PatternError defect must be reachable; got {explored['clusters']}"
    titles = " ".join(str(c.get("title")) for c in explored["clusters"])
    assert "PatternError" in titles


def test_control_flow_rows_are_counted_not_dropped(tmp_path: Path) -> None:
    """Suppressed is not the same as invisible — the verdict tally must show it."""
    from exerciser.functions import run_functions

    src = "import sys\n\n\n" "def exits(n: int) -> int:\n" "    sys.exit(2)\n" "    return n\n"
    repo = _repo_with(tmp_path, src, ("exits",))
    result = run_functions(repo, explore=False)
    assert result["verdicts"].get("control-flow", 0) > 0, "counted"
    assert result["issue_clusters"] == 0, "but not reported as a defect"


# =========================================================================
# 4. The shim must not change a class into a function
# =========================================================================

# Run in a CHILD process: the shim patches process-global state (`socket`,
# `subprocess`, `builtins.open`), so importing it into the test interpreter would
# break every later test in the session.
_SHIM_PROBE = """\
import json
import sitecustomize  # noqa: F401  (installs the shim on import)
import subprocess
import socket

out = {}
out["popen_is_class"] = isinstance(subprocess.Popen, type)
out["socket_is_class"] = isinstance(socket.socket, type)

# The exact statement `asyncio.windows_utils` runs at module scope, and the one
# that raised `TypeError: function() argument 'code' must be code, not str`
# when Popen had been replaced by a function.
try:
    class Sub(subprocess.Popen):
        pass
    out["subclass_popen"] = "ok"
except BaseException as exc:
    out["subclass_popen"] = "%s: %s" % (type(exc).__name__, exc)

try:
    class SubSock(socket.socket):
        pass
    out["subclass_socket"] = "ok"
except BaseException as exc:
    out["subclass_socket"] = "%s: %s" % (type(exc).__name__, exc)

# Still BLOCKED, both directly and through a subclass — the shim must not have
# been softened into a no-op by being made class-shaped.
def _attempt(fn):
    try:
        fn()
    except BaseException as exc:
        return type(exc).__name__
    return "NOT BLOCKED"

out["popen_blocked"] = _attempt(lambda: subprocess.Popen(["echo", "hi"]))
out["run_blocked"] = _attempt(lambda: subprocess.run(["echo", "hi"]))
out["socket_blocked"] = _attempt(lambda: socket.socket())
if out["subclass_popen"] == "ok":
    out["popen_subclass_blocked"] = _attempt(lambda: Sub(["echo", "hi"]))
if out["subclass_socket"] == "ok":
    out["socket_subclass_blocked"] = _attempt(lambda: SubSock())

print(json.dumps(out))
"""


@pytest.fixture
def shim_probe(tmp_path: Path):
    """Run ``_SHIM_PROBE`` under a freshly generated shim, return its dict."""
    from exerciser.sandbox import write_shim

    shim_dir = tmp_path / "shim"
    write_shim(shim_dir)
    root = tmp_path / "root"
    root.mkdir()
    env = {
        "PATH": "",
        "PYTHONPATH": str(shim_dir),
        "PYTHONIOENCODING": "utf-8",
        "VINV_SANDBOX_ROOT": str(root),
        "TMPDIR": str(root),
        "TEMP": str(root),
        "TMP": str(root),
        "SYSTEMROOT": "C:\\Windows" if sys.platform == "win32" else "",
    }
    proc = subprocess.run(
        [sys.executable, "-c", _SHIM_PROBE],
        env={k: v for k, v in env.items() if v},
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
        cwd=str(tmp_path),
    )
    line = next((ln for ln in reversed((proc.stdout or "").splitlines()) if ln.startswith("{")), "")
    assert line, f"probe produced no JSON.\nstdout={proc.stdout}\nstderr={proc.stderr}"
    return json.loads(line)


def test_the_shim_keeps_a_replaced_class_a_class(shim_probe: dict) -> None:
    assert shim_probe["popen_is_class"] is True
    assert shim_probe["socket_is_class"] is True


def test_a_module_that_subclasses_a_blocked_class_still_imports(shim_probe: dict) -> None:
    """The 18-fabricated-findings bug.

    ``class Popen(subprocess.Popen)`` resolves its metaclass as
    ``type(subprocess.Popen)``. With a function installed there that is
    ``function``, so Python called ``function('Popen', bases, namespace)`` and
    raised ``TypeError: function() argument 'code' must be code, not str`` — from
    the ``class`` statement, at import time, in the standard library. Every
    module that transitively imported ``asyncio`` (any ``tqdm.auto``, any HTTP
    client) therefore failed to import under the shim, and the harness reported
    each failure as an ``import-error`` DEFECT IN THE USER'S REPO.
    """
    assert shim_probe["subclass_popen"] == "ok"
    assert shim_probe["subclass_socket"] == "ok"


def test_being_class_shaped_did_not_soften_the_block(shim_probe: dict) -> None:
    """The containment must still contain — directly and via a subclass."""
    assert shim_probe["popen_blocked"] == "SandboxBlocked"
    assert (
        shim_probe["run_blocked"] == "SandboxBlocked"
    ), "subprocess.run() constructs Popen through the module global"
    assert shim_probe["socket_blocked"] == "SandboxBlocked"
    assert (
        shim_probe.get("popen_subclass_blocked") == "SandboxBlocked"
    ), "a subclass must not be an escape hatch"
    assert shim_probe.get("socket_subclass_blocked") == "SandboxBlocked"
