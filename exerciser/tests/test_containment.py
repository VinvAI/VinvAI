"""The containment CAPABILITY LADDER.

The thing being tested is a claim, not a feature: "this run was contained by X,
and X guarantees Y". So the tests are built around the ways that claim could be
false —

* a mechanism that is on ``PATH`` but does not actually contain anything is
  reported as available;
* the prober rubber-stamps whatever it is handed;
* a probe result is cached across a change that invalidates it;
* a tier is claimed that the caller explicitly capped away;
* ``effects_complete`` says True under a wall that cannot support it;
* a policy demands a tier, does not get it, and the run proceeds anyway.

The one live assertion — that the wrapped argv really cannot write outside its
root — is skipped, with the probe's own reason, on a host that offers no OS
mechanism. It is never quietly passed.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from exerciser import containment
from exerciser.containment import (
    NO_CONTAINMENT,
    SHIM_MECHANISM,
    ContainmentMechanism,
    ContainmentTier,
    bwrap_argv,
    detect_containment,
    macos_profile,
    os_denial,
    parse_tier,
    reset_containment_cache,
    tier_names,
    unshare_argv,
    unshare_env,
)

_HOST = detect_containment()
HAS_OS_TIER = _HOST.tier is ContainmentTier.OS_SANDBOX
NO_OS_TIER_REASON = (
    f"this host offers no probed OS containment mechanism "
    f"({_HOST.fallback_reason or 'no reason recorded'})"
)


@pytest.fixture(autouse=True)
def _clean_cache():
    """Probe results are a per-process fact; a test must not inherit one."""
    yield
    reset_containment_cache()


# ---- the tiers themselves ---------------------------------------------------


def test_the_tiers_are_ordered_so_require_tier_is_a_comparison():
    assert ContainmentTier.OS_SANDBOX > ContainmentTier.PROCESS_SHIM > ContainmentTier.NONE
    assert ContainmentTier.PROCESS_SHIM < ContainmentTier.OS_SANDBOX
    assert ContainmentTier.PROCESS_SHIM >= ContainmentTier.PROCESS_SHIM
    assert tier_names() == ["none", "process-shim", "os-sandbox"]


def test_a_tier_parses_from_its_wire_value_and_refuses_an_unknown_one():
    assert parse_tier("os-sandbox") is ContainmentTier.OS_SANDBOX
    assert parse_tier("process_shim") is ContainmentTier.PROCESS_SHIM
    assert parse_tier(ContainmentTier.NONE) is ContainmentTier.NONE
    assert parse_tier(None) is None
    with pytest.raises(ValueError, match="unknown containment tier"):
        parse_tier("docker")


def test_only_an_os_wall_that_actually_blocked_writes_may_claim_completeness():
    # The whole point of the ladder: the completeness CLAIM follows the wall.
    assert SHIM_MECHANISM.effects_complete is False
    assert NO_CONTAINMENT.effects_complete is False
    blocking = ContainmentMechanism(
        tier=ContainmentTier.OS_SANDBOX, name="x", blocks_writes_outside_root=True
    )
    assert blocking.effects_complete is True
    # An "OS sandbox" whose probe never demonstrated a blocked write claims
    # nothing — the tier alone is not the licence.
    hollow = ContainmentMechanism(tier=ContainmentTier.OS_SANDBOX, name="x")
    assert hollow.effects_complete is False


def test_every_tier_states_what_it_guarantees_in_words_a_reader_can_check():
    os_words = ContainmentMechanism(
        tier=ContainmentTier.OS_SANDBOX,
        name="x",
        blocks_writes_outside_root=True,
        blocks_network=True,
    ).guarantees()
    assert "IMPOSSIBLE" in os_words["writes_outside_root"]
    assert "COMPLETE" in os_words["effect_ledger"]
    shim_words = SHIM_MECHANISM.guarantees()
    assert "IMPOSSIBLE" not in shim_words["writes_outside_root"]
    assert "C extension" in shim_words["writes_outside_root"]
    assert "INCOMPLETE" in shim_words["effect_ledger"]
    assert NO_CONTAINMENT.guarantees()["writes_outside_root"] == "NOT CONTAINED"
    # …and it all survives the trip into a result document.
    assert json.loads(json.dumps(SHIM_MECHANISM.to_json()))["tier"] == "process-shim"


# ---- profile / argv construction --------------------------------------------


@pytest.mark.skipif(
    sys.platform == "win32",
    reason=(
        "macos_profile emits SBPL, whose paths are POSIX by definition; a Windows "
        "tmp_path is backslash-separated and the generator escapes those for SBPL, "
        "so the assertion compares a path shape macOS can never produce. This skips "
        "a macOS-ONLY code path — unlike the sandbox guards, it hides no "
        "cross-platform behaviour."
    ),
)
def test_the_macos_profile_denies_writes_then_readmits_only_the_root(tmp_path: Path):
    root = tmp_path / "root"
    root.mkdir()
    profile = macos_profile([root])
    lines = profile.splitlines()
    # `(deny default)` cannot start CPython; `(allow default)` plus targeted
    # denies is the shape, and in SBPL the LAST matching rule wins, so the order
    # of these three lines is the whole control.
    assert lines[0] == "(version 1)"
    assert lines.index("(allow default)") < lines.index("(deny file-write*)")
    allow = next(line for line in lines if line.startswith("(allow file-write* (subpath"))
    assert str(Path(root).resolve()) in allow, "the profile must use the RESOLVED path"
    assert lines.index("(deny file-write*)") < lines.index(allow)
    assert "(deny network*)" in profile


def test_the_macos_profile_does_not_readmit_the_host_tmpdir():
    # TMPDIR is redirected into the sandbox root, so nothing legitimate needs
    # the host one — and allowing it would punch the hole exactly where test
    # frameworks and build tools put their scratch directories.
    import tempfile

    host_tmp = str(Path(tempfile.gettempdir()).resolve())
    profile = macos_profile([Path("/some/sandbox/root")])
    assert f'(subpath "{host_tmp}")' not in profile


def test_the_macos_profile_leaves_the_network_alone_when_the_policy_allows_it():
    assert "(deny network*)" not in macos_profile([Path("/r")], block_network=False)


@pytest.mark.skipif(
    sys.platform == "win32",
    reason=(
        "Windows forbids '\"' in a filename, so the hostile path this test needs "
        "cannot be created here. The escaping it verifies is macOS-only (SBPL)."
    ),
)
def test_a_path_with_a_quote_cannot_break_out_of_the_profile_string(tmp_path: Path):
    nasty = tmp_path / 'we"ird'
    nasty.mkdir()
    profile = macos_profile([nasty])
    assert '\\"' in profile, "the quote must be escaped, not closed"
    assert profile.count('(allow file-write* (subpath "') == 1


def test_bwrap_mounts_the_tmpfs_before_binding_the_root_that_lives_under_it():
    # Order is load-bearing: the sandbox root is usually under /tmp, and a tmpfs
    # mounted AFTER the bind would hide the very directory we made writable.
    argv = bwrap_argv("/usr/bin/bwrap", ["python", "-c", "1"], [Path("/tmp/vinv-root")])
    assert argv[0] == "/usr/bin/bwrap"
    assert argv.index("--tmpfs") < argv.index("--bind")
    assert argv[argv.index("--ro-bind") + 1 : argv.index("--ro-bind") + 3] == ["/", "/"]
    assert "--die-with-parent" in argv and "--unshare-pid" in argv
    assert "--unshare-net" in argv
    assert argv[argv.index("--") + 1 :] == ["python", "-c", "1"]


def test_bwrap_does_not_unshare_the_network_when_the_policy_allows_it():
    argv = bwrap_argv("/usr/bin/bwrap", ["true"], [Path("/tmp/r")], block_network=False)
    assert "--unshare-net" not in argv


def test_unshare_carries_the_writable_paths_in_the_environment_not_the_script():
    # A path with a space or a `;` in it must never become shell code.
    argv = unshare_argv("/usr/bin/unshare", ["python", "-c", "1"], [Path("/tmp/r")])
    assert argv[1] == "-rmn"
    assert argv[-4:] == ["sh", "python", "-c", "1"], "the argv is exec'd, not interpolated"
    script = argv[argv.index("-c") + 1]
    assert "$VINV_WRITABLE_PATHS" in script and 'exec "$@"' in script
    assert "/tmp/r" not in script
    env = unshare_env([Path("/tmp/r")], base={})
    assert env["VINV_WRITABLE_PATHS"] == str(Path("/tmp/r").resolve())
    assert unshare_argv("/usr/bin/unshare", ["true"], [], block_network=False)[1] == "-rm"


def test_a_non_os_tier_never_rewrites_the_command_line():
    argv = ["python", "-m", "exerciser.sandbox", "--worker"]
    assert SHIM_MECHANISM.wrap(argv, root=Path("/tmp/r")) == argv
    assert NO_CONTAINMENT.wrap(argv, root=Path("/tmp/r")) == argv


def test_an_os_tier_with_no_tool_falls_back_to_the_bare_command():
    # Fail closed rather than emit a half-formed argv: a mechanism with no
    # binary is not one we can wrap with, and the tier check upstream is what
    # keeps this from ever being reached in a real run.
    hollow = ContainmentMechanism(tier=ContainmentTier.OS_SANDBOX, name="sandbox-exec", tool=None)
    assert hollow.wrap(["true"], root=Path("/tmp/r")) == ["true"]


# ---- the probe --------------------------------------------------------------


def _fake_probe(outcome, tool="/fake/tool", counter=None):
    def probe(python, block_network):
        if counter is not None:
            counter.append((python, block_network))
        return outcome, tool

    return probe


def test_a_mechanism_that_does_not_actually_block_is_not_offered(monkeypatch):
    # THE test that keeps this from being "is the binary installed?": the
    # candidate is present, the probe runs, and the write still lands.
    failed = containment._ProbeOutcome(False, "a write outside the allowed root still landed")
    monkeypatch.setattr(containment, "_candidates", lambda: [("liar", _fake_probe(failed))])

    mechanism = detect_containment()

    assert mechanism.tier is ContainmentTier.PROCESS_SHIM
    assert "still landed" in (mechanism.fallback_reason or "")
    assert mechanism.candidates[0]["available"] is False
    assert mechanism.effects_complete is False


def test_the_prober_is_not_a_rubber_stamp():
    # Hand `_run_probe` a "mechanism" that does nothing at all. The escaping
    # write lands, and the probe must say so — otherwise every assertion built
    # on it is worthless.
    outcome = containment._run_probe(
        lambda argv, writable: list(argv), python=sys.executable, block_network=False
    )
    assert outcome.ok is False
    assert "does not contain writes" in outcome.reason


def test_the_first_candidate_that_probes_clean_wins_and_stops_the_ladder(monkeypatch):
    passed = containment._ProbeOutcome(
        True, "probe passed", blocks_writes=True, blocks_network=True, checks=("w", "n")
    )
    later: list = []
    monkeypatch.setattr(
        containment,
        "_candidates",
        lambda: [
            ("strong", _fake_probe(passed, tool="/bin/strong")),
            ("weaker", _fake_probe(passed, tool="/bin/weaker", counter=later)),
        ],
    )

    mechanism = detect_containment()

    assert mechanism.name == "strong" and mechanism.tool == "/bin/strong"
    assert mechanism.tier is ContainmentTier.OS_SANDBOX
    assert mechanism.effects_complete is True
    assert later == [], "a weaker rung must not even be probed once a stronger one held"


def test_a_probe_result_is_cached_per_process_and_resettable(monkeypatch):
    seen: list = []
    passed = containment._ProbeOutcome(True, "ok", blocks_writes=True, blocks_network=True)
    monkeypatch.setattr(
        containment, "_candidates", lambda: [("m", _fake_probe(passed, counter=seen))]
    )

    detect_containment()
    detect_containment()
    assert len(seen) == 1, "probing costs subprocesses; it is a fact about the host"

    # …but the network question is a DIFFERENT probe, so it is a different key.
    detect_containment(block_network=False)
    assert len(seen) == 2
    assert seen[-1][1] is False

    reset_containment_cache()
    detect_containment()
    assert len(seen) == 3


def test_a_platform_with_no_candidates_lands_on_the_shim_with_a_reason(monkeypatch):
    monkeypatch.setattr(containment, "_candidates", list)

    mechanism = detect_containment()

    assert mechanism.tier is ContainmentTier.PROCESS_SHIM
    assert "no OS containment mechanism is known" in (mechanism.fallback_reason or "")
    assert mechanism.candidates == ()


def test_max_tier_can_only_ever_weaken_and_the_report_says_it_did(monkeypatch):
    passed = containment._ProbeOutcome(True, "ok", blocks_writes=True, blocks_network=True)
    monkeypatch.setattr(containment, "_candidates", lambda: [("strong", _fake_probe(passed))])

    assert detect_containment().tier is ContainmentTier.OS_SANDBOX
    capped = detect_containment(max_tier=ContainmentTier.PROCESS_SHIM)
    assert capped.tier is ContainmentTier.PROCESS_SHIM
    assert "capped containment at 'process-shim'" in (capped.fallback_reason or "")
    assert capped.effects_complete is False
    # A ceiling of NONE means "no containment", which is never a run mode — it
    # exists so the caller can be refused.
    assert detect_containment(max_tier="none").tier is ContainmentTier.NONE
    # …and it cannot RAISE a tier.
    monkeypatch.setattr(containment, "_candidates", list)
    reset_containment_cache()
    assert detect_containment(max_tier=ContainmentTier.OS_SANDBOX).tier is (
        ContainmentTier.PROCESS_SHIM
    )


# ---- reading a kernel refusal back off a row --------------------------------


def test_a_denial_errno_on_an_oserror_is_recognised():
    row = {
        "status": "error",
        "error_type": "PermissionError",
        "error_mro": ["PermissionError", "OSError", "Exception"],
        "error_errno": 1,
        "error": "[Errno 1] Operation not permitted: '/etc/passwd'",
    }
    kind, detail = os_denial(row)
    assert kind == "filesystem-denied" and "errno 1" in detail


def test_a_c_extension_that_swallows_the_errno_is_still_recognised():
    # `sqlite3.OperationalError` is not an OSError and carries no errno; the
    # message is the ONLY trace a denied `open(2)` leaves through sqlite3.
    kind, _detail = os_denial(
        {
            "status": "error",
            "error_type": "OperationalError",
            "error_mro": ["OperationalError", "DatabaseError", "Error", "Exception"],
            "error": "unable to open database file",
        }
    )
    assert kind == "filesystem-denied"


def test_a_refused_connect_is_reported_as_a_network_denial():
    kind, _detail = os_denial(
        {
            "status": "error",
            "error_type": "OSError",
            "error_mro": ["OSError", "Exception"],
            "error_errno": 101,
            "error": "[Errno 101] Network is unreachable",
        }
    )
    assert kind == "network-denied"


def test_an_ordinary_failure_is_not_mistaken_for_a_denial():
    assert os_denial({"status": "ok"}) is None
    assert (
        os_denial(
            {
                "status": "error",
                "error_type": "ValueError",
                "error_mro": ["ValueError", "Exception"],
                "error": "tag must be non-empty",
            }
        )
        is None
    )
    # An errno that is not a REFUSAL (ENOENT) is the target's own problem.
    assert (
        os_denial(
            {
                "status": "error",
                "error_type": "FileNotFoundError",
                "error_mro": ["FileNotFoundError", "OSError", "Exception"],
                "error_errno": 2,
                "error": "[Errno 2] No such file or directory: 'nope'",
            }
        )
        is None
    )


# ---- live, on this host ------------------------------------------------------


@pytest.mark.skipif(not HAS_OS_TIER, reason=NO_OS_TIER_REASON)
def test_the_detected_mechanism_really_blocks_a_write_outside_its_root(tmp_path: Path):
    # Not a re-run of the probe: this takes the mechanism the ladder actually
    # chose, wraps a command with it exactly as the sandbox driver does, and
    # asserts on the REAL path on the REAL filesystem.
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    inside_file = root / "inside.txt"
    outside_file = outside / "outside.txt"

    script = (
        "import sys\n"
        f"open({str(inside_file)!r}, 'w').write('in')\n"
        "try:\n"
        f"    open({str(outside_file)!r}, 'w').write('out')\n"
        "    sys.stdout.write('ESCAPED')\n"
        "except Exception as exc:\n"
        "    sys.stdout.write('DENIED:' + type(exc).__name__)\n"
    )
    cmd = _HOST.wrap([sys.executable, "-c", script], root=root)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

    assert not outside_file.exists(), f"the write escaped: {proc.stdout} {proc.stderr}"
    assert inside_file.exists(), f"the root must stay writable: {proc.stdout} {proc.stderr}"
    assert proc.stdout.startswith("DENIED:"), proc.stdout


@pytest.mark.skipif(not HAS_OS_TIER, reason=NO_OS_TIER_REASON)
def test_the_detected_mechanism_records_which_checks_it_actually_passed():
    assert "write-outside-root-denied" in _HOST.checks
    assert "write-inside-root-allowed" in _HOST.checks
    assert _HOST.blocks_writes_outside_root is True
    assert _HOST.tool and Path(_HOST.tool).exists()


# =========================================================================
# A row that stood on invented data is not evidence about the repo
# =========================================================================


def _call_row(**over: object) -> dict:
    row = {
        "phase": "call",
        "status": "error",
        "target_id": "pkg.mod:fn",
        "error_type": "TypeError",
        "error": "unsupported operand",
        "error_module": "builtins",
        "input_class": "valid",
    }
    row.update(over)
    return row


def test_a_call_that_failed_on_a_substituted_response_is_not_a_defect() -> None:
    """The HTTP double answers with a plausible SHAPE and never a correct value.

    A target that then reads a field the real provider would have filled fails on
    OUR value, not on its own logic. `sandbox` already drains the service ledger
    per call and writes the evidence onto the row, under a comment saying
    "so downstream consumers can down-weight it" — and until this, the flag had
    exactly one write site and zero read sites, so the verdict path ran as if the
    substitution had not happened.
    """
    from exerciser.functions import classify_row

    assert classify_row(_call_row(substitution_dependent=True)) is None


def test_a_call_that_failed_on_a_seeded_row_is_not_a_defect_either() -> None:
    from exerciser.functions import classify_row

    assert classify_row(_call_row(seed_dependent=True)) is None


def test_an_ordinary_failure_is_untouched() -> None:
    """The exemption must be narrow: no service event, no exemption."""
    from exerciser.exception_policy import ExceptionPolicy
    from exerciser.functions import classify_row

    verdict = classify_row(_call_row(), ExceptionPolicy(), total_targets=1)
    assert verdict != "not-a-defect-by-substitution"
    # It travels the ordinary learned-policy path rather than being short-circuited.
    assert verdict in (None, "function-crash")


def test_a_substituted_call_that_SUCCEEDED_is_not_reported_at_all() -> None:
    """Only failures are exempted; a success was never a finding."""
    from exerciser.functions import classify_row

    assert classify_row(_call_row(status="ok", substitution_dependent=True)) is None
