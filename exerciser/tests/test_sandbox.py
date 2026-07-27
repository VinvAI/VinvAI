"""The execution sandbox — testflow Phase 5, driven for real.

The purity guard refuses to call anything that touches the world, which is
correct and, on its own, a coverage CEILING: the interesting functions in any
repo are the ones that write files, open sockets and shell out. These tests
build throwaway target packages whose functions do exactly that, then assert the
three things that make a sandbox worth having:

* the effects LAND SOMEWHERE DISPOSABLE — the real path on the real repo (and
  the real ``$HOME``) is asserted absent, every time;
* the attempt is RECORDED — "this function writes a file / opens a socket /
  shells out" is reported even when it is refused;
* failure is CLOSED — when containment cannot be established the target stays
  refused with a reason, and never runs loose.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from exerciser import store
from exerciser.functions import (
    call_verdict,
    classify_row,
    discover_with_refusals,
    learn_exception_policy,
    run_functions,
)
from exerciser.sandbox import (
    DEFAULT_EXCLUDES,
    IsolationUnavailable,
    SandboxPolicy,
    copy_repo,
    gitignore_patterns,
    group_attempts,
    mark_contained,
    planned_rlimits,
    prepare_sandbox,
    sandbox_env,
    snapshot_tree,
    tree_delta,
)

# A note name no developer's home directory could plausibly already contain, so
# "it is not in the real $HOME" is evidence about the sandbox and nothing else.
HOME_NOTE = "vinv-sandbox-escape-probe.txt"
ARTIFACT = "sandbox-artifact.txt"

_IMPURE_PKG = {
    "__init__.py": "",
    "effects.py": f"""\
import os
import socket
import subprocess


def add(a: int, b: int) -> int:
    return a + b


def write_artifact(tag: str) -> str:
    # A repo-RELATIVE write: unsandboxed it lands in the repo, sandboxed it
    # lands in the disposable copy.
    with open({ARTIFACT!r}, "w", encoding="utf-8") as fh:
        fh.write(str(tag))
    return {ARTIFACT!r}


def write_home_note(tag: str) -> str:
    path = os.path.join(os.path.expanduser("~"), {HOME_NOTE!r})
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(str(tag))
    return path


def fetch_status(host: str) -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect((str(host), 80))
    return "connected"


def probe_shell(tag: str) -> str:
    done = subprocess.run(["echo", str(tag)], capture_output=True)
    return str(done.returncode)
""",
}

# No chained calls anywhere: the purity walk refuses what it cannot RESOLVE, and
# `x.strip().lower()` is rooted at a call, so even that is an impurity refusal.
_PURE_PKG = {
    "__init__.py": "",
    "calc.py": (
        "def add(a: int, b: int) -> int:\n    return a + b\n\n\n"
        "def scale(n: int, factor: int = 2) -> int:\n    return n * factor\n"
    ),
}


def _make_repo(tmp_path: Path, *, pkg: dict[str, str] | None = None) -> Path:
    """A throwaway repo with a source package and the code index the harness reads."""
    src = tmp_path / "src" / "targetpkg"
    src.mkdir(parents=True)
    files = pkg or _IMPURE_PKG
    for name, body in files.items():
        (src / name).write_text(body, encoding="utf-8")
    index = tmp_path / ".vinv" / "index"
    index.mkdir(parents=True)
    chunks = []
    for name, body in files.items():
        for fn in re.findall(r"^(?:async )?def (\w+)", body, re.MULTILINE):
            chunks.append(
                {
                    "id": f"src/targetpkg/{name}:{fn}",
                    "file": f"src/targetpkg/{name}",
                    "lang": "python",
                    "kind": "function",
                    "name": fn,
                    "start_line": 1,
                    "end_line": 2,
                    "parent": None,
                }
            )
    (index / "chunks.jsonl").write_text(
        "".join(json.dumps(c) + "\n" for c in chunks), encoding="utf-8"
    )
    return tmp_path


def _rows(repo: Path) -> list[dict]:
    return store.read_jsonl(store.exercise_dir(repo) / "function_results.jsonl")


def _for(rows: list[dict], qualname: str) -> list[dict]:
    return [r for r in rows if str(r.get("target_id", "")).endswith(":" + qualname)]


def _attempts(report: dict, qualname: str, kind: str) -> list[str]:
    out: list[str] = []
    for effect in report.get("effects") or []:
        if str(effect.get("target_id", "")).endswith(":" + qualname) and effect["kind"] == kind:
            out.extend(effect["attempts"])
    return out


# ---- unit: the copy, the environment, the caps ------------------------------


def test_the_copy_skips_the_disposable_and_honours_gitignore(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / "pkg").mkdir(parents=True)
    (repo / "pkg" / "mod.py").write_text("x = 1\n", encoding="utf-8")
    (repo / ".git").mkdir()
    (repo / ".git" / "objects").write_text("junk" * 100, encoding="utf-8")
    (repo / "node_modules").mkdir()
    (repo / "node_modules" / "big.js").write_text("junk" * 100, encoding="utf-8")
    (repo / "scratch").mkdir()
    (repo / "scratch" / "tmp.bin").write_text("junk", encoding="utf-8")
    (repo / ".gitignore").write_text("scratch/\n# a comment\n!keep\nsub/dir\n", encoding="utf-8")

    assert gitignore_patterns(repo) == frozenset({"scratch"})

    dest = tmp_path / "copy"
    report = copy_repo(repo, dest, SandboxPolicy(enabled=True))

    assert (dest / "pkg" / "mod.py").is_file(), "real source must survive the copy"
    assert not (dest / ".git").exists()
    assert not (dest / "node_modules").exists()
    assert not (dest / "scratch").exists(), ".gitignore names are honoured"
    assert report.files == 2, "mod.py and .gitignore only"
    assert report.bytes > 0
    assert report.to_json()["cap_mb"] == pytest.approx(SandboxPolicy().max_copy_mb)


def test_a_repo_too_large_to_copy_refuses_rather_than_running_unsandboxed(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "big.txt").write_text("x" * 4096, encoding="utf-8")
    policy = SandboxPolicy(enabled=True, max_copy_mb=0.001)
    with pytest.raises(IsolationUnavailable) as excinfo:
        copy_repo(repo, tmp_path / "copy", policy)
    assert "cap" in str(excinfo.value)
    # …and preparing a sandbox propagates it rather than degrading.
    with pytest.raises(IsolationUnavailable):
        prepare_sandbox(repo, policy)


def test_the_environment_redirects_every_disposable_path_into_the_tree(tmp_path: Path):
    repo = _make_repo(tmp_path)
    sandbox = prepare_sandbox(repo, SandboxPolicy(enabled=True, keep_root=True))
    try:
        env = sandbox_env(sandbox, base_env={"PATH": "/usr/bin", "PYTHONPATH": "/elsewhere"})
        root = str(sandbox.root)
        for var in ("TMPDIR", "TEMP", "TMP", "HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"):
            assert env[var].startswith(root), f"{var} must point inside the sandbox"
        assert env["PYTHONDONTWRITEBYTECODE"] == "1"
        assert env["VINV_SANDBOX_ROOT"] == root
        assert env["PYTHONPATH"].split(os.pathsep)[0] == str(sandbox.shim)
        assert (sandbox.shim / "sitecustomize.py").is_file()
        assert sandbox.repo_copy.is_dir()
    finally:
        sandbox.policy = SandboxPolicy(enabled=True)
        sandbox.dispose()
    assert not sandbox.root.exists(), "the tree is discarded, and with it every effect"


def test_resource_caps_are_platform_guarded():
    caps = dict(planned_rlimits(SandboxPolicy(enabled=True, max_processes=64)))
    assert caps["RLIMIT_NOFILE"] == 512
    assert caps["RLIMIT_NPROC"] == 64
    # RLIMIT_AS is Linux-only on purpose: elsewhere CPython reserves a virtual
    # address space large enough that a meaningful cap kills the interpreter.
    assert ("RLIMIT_AS" in caps) is sys.platform.startswith("linux")
    assert planned_rlimits(
        SandboxPolicy(enabled=True, max_open_files=None, address_space_mb=None)
    ) == ([] if not sys.platform.startswith("linux") else [])


def test_the_effect_ledger_groups_and_bounds_attempts():
    grouped = group_attempts(
        [
            {"kind": "network", "detail": "socket.socket()"},
            {"kind": "network", "detail": "socket.socket()"},
            {"kind": "filesystem", "detail": "open('a')"},
            "not a dict",
        ]
    )
    assert grouped == {"network": ["socket.socket()"], "filesystem": ["open('a')"]}


def test_our_own_containment_is_never_charged_to_the_target():
    from exerciser.exception_policy import ExceptionPolicy

    blocked = mark_contained(
        {
            "phase": "call",
            "status": "error",
            "sandboxed": True,
            "input_class": "valid",
            "error_type": "SandboxBlocked",
            "error_module": "sitecustomize",
            "error_mro": ["SandboxBlocked", "RuntimeError", "Exception"],
            "error": "network access is blocked by the Vinv execution sandbox",
        }
    )
    assert blocked["contained"] is True
    assert call_verdict(blocked) == "contained", "counted, not hidden"
    assert classify_row(blocked) is None, "…and never a defect in the target"
    # The signature must not enter the learned policy either: a containment
    # artefact shaping later verdicts would be evidence about us, not the repo.
    policy = ExceptionPolicy()
    learn_exception_policy([blocked], policy, 4)
    assert policy.evidence == {}

    # A target that catches the block and raises its OWN error is judged on it:
    # the marker is the exception's DEFINING MODULE, not the message.
    own = dict(blocked)
    own.pop("contained")
    own.update(error_type="ConfigError", error_module="targetpkg.err")
    assert "contained" not in mark_contained(own)


def test_the_tree_walk_is_the_ground_truth_of_what_was_left_behind(tmp_path: Path):
    (tmp_path / "a.txt").write_text("one", encoding="utf-8")
    before = snapshot_tree(tmp_path)
    (tmp_path / "b.txt").write_text("two", encoding="utf-8")
    (tmp_path / "a.txt").write_text("one-changed", encoding="utf-8")
    delta = tree_delta(before, snapshot_tree(tmp_path))
    assert delta["created"] == ["b.txt"]
    assert delta["modified"] == ["a.txt"]
    assert delta["removed"] == []


def test_discovery_hands_the_impurity_refusals_back_as_drivable_targets(tmp_path: Path):
    repo = _make_repo(tmp_path)
    targets, skipped, refused = discover_with_refusals(repo)
    assert {t.qualname for t in targets} == {"add"}, "only the pure one is drivable normally"
    names = {r.target.qualname for r in refused}
    assert names == {"write_artifact", "write_home_note", "fetch_status", "probe_shell"}
    assert all(r.reasons for r in refused), "a refusal without its reasons is not recoverable"
    assert all(r.target.params for r in refused), "…and it must carry enough to call"
    assert {s["id"] for s in skipped} >= {f"targetpkg.effects:{n}" for n in names}


def test_a_destructive_name_is_never_promoted_to_the_sandbox(tmp_path: Path):
    repo = _make_repo(
        tmp_path,
        pkg={
            "__init__.py": "",
            "effects.py": (
                "import os\n\n\ndef delete_workspace(path: str) -> None:\n    os.remove(path)\n\n\n"
                "def test_helper(path: str) -> None:\n    open(path, 'w').close()\n"
            ),
        },
    )
    _targets, skipped, refused = discover_with_refusals(repo)
    assert refused == [], "containment does not make drop/delete a good idea"
    reasons = {s["id"]: s["reason"] for s in skipped}
    assert reasons["targetpkg.effects:delete_workspace"].startswith("destructive-name")
    assert reasons["targetpkg.effects:test_helper"] == "test-scaffolding"


# ---- the real driver, under containment ------------------------------------


@pytest.mark.skipif(sys.platform == "win32", reason="posix worker spawn")
def test_a_file_writing_target_is_refused_without_the_flag(tmp_path: Path):
    repo = _make_repo(tmp_path)

    result = run_functions(repo, module_timeout_s=60.0, explore=False)

    assert _for(_rows(repo), "write_artifact") == [], "never called with the sandbox off"
    assert not (repo / ARTIFACT).exists()
    assert result["sandbox"] == {"enabled": False}
    assert any("impure-body" in s["reason"] for s in result["skipped"])


@pytest.mark.skipif(sys.platform == "win32", reason="posix worker spawn")
def test_a_file_writing_target_runs_in_the_sandbox_and_leaves_the_repo_alone(tmp_path: Path):
    repo = _make_repo(tmp_path)
    policy = SandboxPolicy(enabled=True, keep_root=True)

    result = run_functions(repo, module_timeout_s=120.0, explore=False, sandbox_policy=policy)

    report = result["sandbox"]
    assert report["status"] == "ok", report.get("reason")
    calls = _for(_rows(repo), "write_artifact")
    assert calls, "the sandbox must actually CALL the refused target"
    assert all(r["sandboxed"] for r in calls), "…and every row says so"
    assert any(r["status"] == "ok" for r in calls), "the write itself must succeed"

    # THE assertion: the real repo is untouched.
    assert not (repo / ARTIFACT).exists()
    root = Path(report["root"])
    landed = list(root.rglob(ARTIFACT))
    assert landed, "the write has to have landed somewhere in the disposable tree"
    assert all(str(p).startswith(str(root)) for p in landed)

    # The effect is REPORTED, not merely prevented.
    assert any(ARTIFACT in a for a in _attempts(report, "write_artifact", "filesystem"))
    created = [f for delta in report["filesystem_delta"] for f in delta["created"]]
    assert any(ARTIFACT in name for name in created), "the before/after walk saw it too"
    assert report["copy"]["files"] > 0 and report["copy"]["ms"] >= 0.0
    # A skipped entry a reader can follow from refusal to containment.
    entry = next(s for s in result["skipped"] if s["id"].endswith(":write_artifact"))
    assert entry["sandbox"] == "driven-under-containment"


@pytest.mark.skipif(sys.platform == "win32", reason="posix worker spawn")
def test_a_write_that_would_escape_the_tree_is_refused_and_recorded(tmp_path: Path):
    repo = _make_repo(tmp_path)
    home_note = Path(os.path.expanduser("~")) / HOME_NOTE
    assert not home_note.exists(), "precondition: the probe file must not already exist"

    result = run_functions(
        repo,
        module_timeout_s=120.0,
        explore=False,
        sandbox_policy=SandboxPolicy(enabled=True, keep_root=True),
    )
    report = result["sandbox"]
    root = Path(report["root"])

    # $HOME was redirected, so the "home" write landed in the tree…
    assert not home_note.exists(), "the developer's real home must never be written"
    assert list((root / "home").rglob(HOME_NOTE)), "…it landed in the sandbox home instead"
    assert any(HOME_NOTE in a for a in _attempts(report, "write_home_note", "filesystem"))


@pytest.mark.skipif(sys.platform == "win32", reason="posix worker spawn")
def test_a_socket_target_is_reported_as_a_network_attempt(tmp_path: Path):
    repo = _make_repo(tmp_path)

    result = run_functions(
        repo,
        module_timeout_s=120.0,
        explore=False,
        sandbox_policy=SandboxPolicy(enabled=True),
    )

    attempts = _attempts(result["sandbox"], "fetch_status", "network")
    assert attempts and any("socket" in a for a in attempts)
    assert result["sandbox"]["effect_totals"]["network"] > 0
    calls = _for(_rows(repo), "fetch_status")
    assert calls and all(r["status"] == "error" for r in calls), "no connection is made"
    assert all("blocked by the Vinv execution sandbox" in r.get("error", "") for r in calls)
    # …and the block is OUR apparatus, so it is counted, not reported as a bug
    # in the target. "It opens a socket" is already said by the ledger.
    assert all(r["contained"] for r in calls)
    assert result["sandbox"]["verdicts"].get("contained", 0) >= len(calls)
    assert not any("fetch_status" in c["title"] for c in result["clusters"])


@pytest.mark.skipif(sys.platform == "win32", reason="posix worker spawn")
def test_a_subprocess_target_is_reported_as_an_attempt_and_never_spawns(tmp_path: Path):
    repo = _make_repo(tmp_path)

    result = run_functions(
        repo,
        module_timeout_s=120.0,
        explore=False,
        sandbox_policy=SandboxPolicy(enabled=True),
    )

    attempts = _attempts(result["sandbox"], "probe_shell", "subprocess")
    assert attempts and any("Popen" in a for a in attempts)
    assert any("echo" in a for a in attempts), "the ARGV it wanted to run is evidence too"
    calls = _for(_rows(repo), "probe_shell")
    assert calls and all(r["status"] == "error" for r in calls), "nothing was spawned"
    assert all("process spawning is blocked" in r.get("error", "") for r in calls)
    assert all(r["contained"] for r in calls)
    assert not any("probe_shell" in c["title"] for c in result["clusters"])


@pytest.mark.skipif(sys.platform == "win32", reason="posix worker spawn")
def test_isolation_failure_leaves_every_candidate_refused(tmp_path: Path):
    repo = _make_repo(tmp_path)
    # A cap no repo can satisfy: containment cannot be established.
    policy = SandboxPolicy(enabled=True, max_copy_mb=0.0001)

    result = run_functions(repo, module_timeout_s=60.0, explore=False, sandbox_policy=policy)

    report = result["sandbox"]
    assert report["status"] == "unavailable"
    assert "cap" in report["reason"]
    refused = {r["id"] for r in report["refused"]}
    assert "targetpkg.effects:write_artifact" in refused
    assert all(r["reason"].startswith("sandbox-unavailable") for r in report["refused"])
    # Fail CLOSED: nothing ran, nothing was written, and the run says so loudly.
    assert _for(_rows(repo), "write_artifact") == []
    assert not (repo / ARTIFACT).exists()
    assert any("sandbox unavailable" in d for d in result["diagnostics"])
    entry = next(s for s in result["skipped"] if s["id"].endswith(":write_artifact"))
    assert entry["sandbox"].startswith("unavailable:")
    # …and the pure target is still driven normally.
    assert any(r["status"] == "ok" for r in _for(_rows(repo), "add"))


@pytest.mark.skipif(sys.platform == "win32", reason="posix worker spawn")
def test_a_pure_target_is_unaffected_by_the_flag(tmp_path: Path):
    plain = _make_repo(tmp_path / "plain", pkg=_PURE_PKG)
    boxed = _make_repo(tmp_path / "boxed", pkg=_PURE_PKG)

    off = run_functions(plain, module_timeout_s=60.0, explore=False)
    on = run_functions(boxed, module_timeout_s=60.0, explore=False, sandbox=True)

    assert on["targets"] == off["targets"]
    assert on["calls"] == off["calls"] and on["calls"] > 0
    assert on["issue_clusters"] == off["issue_clusters"] == 0
    assert on["verdicts"] == off["verdicts"]
    assert on["sandbox"]["candidates"] == 0, "a pure repo has nothing to contain"
    assert on["sandbox"]["copy"] is None, "…so nothing is even copied"
    assert not any(r.get("sandboxed") for r in _rows(boxed))


@pytest.mark.skipif(sys.platform == "win32", reason="posix worker spawn")
def test_the_sandbox_recovers_targets_refused_merely_as_UNVERIFIABLE(tmp_path: Path):
    # The purity walk refuses what it cannot resolve, not only what it knows to
    # be dangerous: `x.strip().lower()` is rooted at a call, so the receiver is
    # computed at runtime and the guard says no. That conservatism is right, and
    # it is exactly the coverage the sandbox is here to give back.
    repo = _make_repo(
        tmp_path,
        pkg={
            "__init__.py": "",
            "effects.py": "def label(x: str) -> str:\n    return x.strip().lower()\n",
        },
    )
    _targets, skipped, refused = discover_with_refusals(repo)
    assert [r.target.qualname for r in refused] == ["label"]
    assert any("cannot verify" in r for r in refused[0].reasons)
    assert not any(s["id"].endswith(":label") and "destructive" in s["reason"] for s in skipped)

    result = run_functions(repo, module_timeout_s=120.0, explore=False, sandbox=True)
    calls = _for(_rows(repo), "label")
    assert any(r["status"] == "ok" and r["result"] == "vinv" for r in calls)
    assert result["sandbox"]["effect_totals"]["network"] == 0, "and it touched nothing"


@pytest.mark.skipif(sys.platform == "win32", reason="posix worker spawn")
def test_sandboxed_findings_are_tagged_apart_from_ordinary_ones(tmp_path: Path):
    repo = _make_repo(
        tmp_path,
        pkg={
            "__init__.py": "",
            "effects.py": (
                "def add(a: int, b: int) -> int:\n    return a + b\n\n\n"
                "def scale(n: int, factor: int = 2) -> int:\n    return n * factor\n\n\n"
                "def negate(n: int) -> int:\n    return -n\n\n\n"
                "def halve(n: int) -> float:\n"
                "    counts = [] if n == 0 else [1, 2]\n"
                "    return n / len(counts)\n\n\n"
                "def burst(n: int) -> int:\n"
                "    with open('boom.txt', 'w', encoding='utf-8') as fh:\n"
                "        fh.write('x')\n"
                "    if n != 0:\n"
                "        total = n\n"
                "    return total\n"
            ),
        },
    )
    result = run_functions(repo, module_timeout_s=120.0, explore=False, sandbox=True)

    strategies = {c["exemplar"]["strategy"].split("/")[0] for c in result["clusters"]}
    assert "function" in strategies, "the pure crash is an ordinary finding"
    assert "function-sandboxed" in strategies, "the contained crash is marked as such"
    assert not (repo / "boom.txt").exists()
    assert sum(result["sandbox"]["verdicts"].values()) > 0


# ---- fail-closed, from the inside ------------------------------------------


@pytest.mark.skipif(sys.platform == "win32", reason="posix worker spawn")
def test_the_worker_refuses_to_run_when_the_shim_did_not_load(tmp_path: Path):
    # The parent establishes containment; the WORKER independently verifies it.
    # Spawned without the shim on PYTHONPATH, it must import nothing at all.
    plan = tmp_path / "plan.json"
    plan.write_text(
        json.dumps(
            {
                "module": "targetpkg.effects",
                "src_roots": ["src", "."],
                "repo_packages": ["targetpkg"],
                "targets": [{"qualname": "write_artifact"}],
            }
        ),
        encoding="utf-8",
    )
    env = dict(os.environ)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    proc = subprocess.run(
        [sys.executable, "-m", "exerciser.sandbox", "--worker", "--plan", str(plan), "--repo", "."],
        capture_output=True,
        text=True,
        env=env,
    )
    assert proc.returncode == 0
    rows = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    assert len(rows) == 1
    assert rows[0]["status"] == "skipped"
    assert "fail closed" in rows[0]["error"]


@pytest.mark.skipif(sys.platform == "win32", reason="posix worker spawn")
def test_the_sandbox_worker_is_invocable_as_a_module():
    proc = subprocess.run(
        [sys.executable, "-m", "exerciser.sandbox"],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 2
    assert "--sandbox" in proc.stderr


def test_the_default_excludes_never_prune_ordinary_source():
    assert "src" not in DEFAULT_EXCLUDES
    assert "build" not in DEFAULT_EXCLUDES, "excluding it could hide real packages"
    assert {".git", "node_modules", "__pycache__", ".venv"} <= DEFAULT_EXCLUDES
