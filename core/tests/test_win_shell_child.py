"""Regression tests for the Windows bash resolution (bringup "Listing services failed" RCA).

The incident: ``bringup list`` failed because every blocking command in the
agent's terminal came back ``terminal_busy`` — from the very first command, in
every freshly initialised session — so the agent could never read the handbook
and never wrote ``.vinv/services.json``.

The cause was shell *resolution*, not the terminal logic. From a native-Windows
parent ``shutil.which("bash")`` finds only WSL's ``System32\\bash.exe`` (rejected
by design), so resolution fell through to ``<git>\\bin\\bash.exe`` — a ~46KB
launcher that re-execs the real bash as a **child**. Both live in the shell's job
object, so ``WinShellChild.shell_is_busy`` (`any pid != self.pid`) answered "a
foreground job is running" forever, even against a shell idling at its read loop.

Two invariants keep that from regressing:

* resolution never hands back the launcher when the real image is present, so the
  process we spawn *is* the shell (``shell_is_busy`` and ``kill_foreground`` both
  assume that pid identity);
* bypassing the launcher does not cost us the MSYS environment it installs —
  without ``<git>\\usr\\bin`` on PATH the real bash has no coreutils and every
  non-builtin command fails "command not found".
"""

from __future__ import annotations

import os
import sys
import time

import pytest

from core.components.tools.terminal.backends import win_shell_child as wsc


def _fake_git_tree(root, *, with_launcher=True, with_real=True, mingw=False):
    """Build a Git-for-Windows-shaped install under ``root``; return its paths."""
    launcher = root / "bin" / "bash.exe"
    real = root / "usr" / "bin" / "bash.exe"
    if with_launcher:
        launcher.parent.mkdir(parents=True, exist_ok=True)
        launcher.write_text("launcher shim")
    if with_real:
        real.parent.mkdir(parents=True, exist_ok=True)
        real.write_text("real bash")
    if mingw:
        (root / "mingw64" / "bin").mkdir(parents=True, exist_ok=True)
    return str(launcher), str(real)


# -- resolution ------------------------------------------------------------


def test_prefer_real_bash_maps_launcher_to_usr_bin(tmp_path):
    """The launcher is swapped for the real image beside it."""
    launcher, real = _fake_git_tree(tmp_path)
    assert wsc._prefer_real_bash(launcher) == real


def test_prefer_real_bash_keeps_launcher_without_a_real_sibling(tmp_path):
    """A bare ``bin/bash.exe`` (no usr/bin sibling) is still better than nothing."""
    launcher, _ = _fake_git_tree(tmp_path, with_real=False)
    assert wsc._prefer_real_bash(launcher) == launcher


def test_prefer_real_bash_is_idempotent_on_the_real_image(tmp_path):
    _, real = _fake_git_tree(tmp_path)
    assert wsc._prefer_real_bash(real) == real


def test_resolve_never_returns_the_launcher_found_on_path(tmp_path, monkeypatch):
    """PATH lookup hitting the launcher must still yield the real bash."""
    launcher, real = _fake_git_tree(tmp_path)
    monkeypatch.setattr(wsc.shutil, "which", lambda name: launcher)
    assert wsc.resolve_windows_shell("/bin/bash") == real


def test_resolve_normalises_an_explicit_launcher_path(tmp_path):
    """Even a caller passing the launcher explicitly gets the real image."""
    launcher, real = _fake_git_tree(tmp_path)
    assert wsc.resolve_windows_shell(launcher) == real


def test_resolve_rejects_wsl_bash_from_path(tmp_path, monkeypatch):
    """System32 bash crosses into the Linux VM; it must not win PATH lookup."""
    _, real = _fake_git_tree(tmp_path)
    monkeypatch.setattr(wsc.shutil, "which", lambda name: r"C:\Windows\System32\bash.exe")
    monkeypatch.setattr(wsc, "_BASH_CANDIDATES", (real,))
    assert wsc.resolve_windows_shell("/bin/bash") == real


# -- MSYS environment handoff ----------------------------------------------


def test_apply_msys_env_prepends_coreutils_bin(tmp_path):
    """Bypassing the launcher must not cost us cat/head/grep."""
    _, real = _fake_git_tree(tmp_path, mingw=True)
    # A drive-letter path like C:\Windows contains os.pathsep on POSIX (':'),
    # so use a separator-free inherited entry to keep the assertion portable.
    inherited = r"C:\Windows" if os.name == "nt" else "/inherited/bin"
    env = wsc.apply_msys_env(real, {"PATH": inherited})
    parts = env["PATH"].split(os.pathsep)
    assert parts[0] == str(tmp_path / "usr" / "bin")
    assert str(tmp_path / "mingw64" / "bin") in parts
    assert inherited in parts  # inherited PATH is preserved, not replaced


def test_apply_msys_env_does_not_duplicate_existing_entries(tmp_path):
    _, real = _fake_git_tree(tmp_path)
    usr_bin = str(tmp_path / "usr" / "bin")
    env = wsc.apply_msys_env(real, {"PATH": usr_bin})
    assert env["PATH"].split(os.pathsep).count(usr_bin) == 1


def test_apply_msys_env_is_a_noop_for_non_msys_shells():
    """WSL / arbitrary shells keep the caller's env untouched."""
    env = {"PATH": r"C:\Windows"}
    assert wsc.apply_msys_env(r"C:\Windows\System32\bash.exe", env) == env


# -- live shell (the actual incident) --------------------------------------

_LIVE_BASH = wsc.resolve_windows_shell("/bin/bash") if sys.platform == "win32" else None

live_only = pytest.mark.skipif(
    sys.platform != "win32" or not _LIVE_BASH,
    reason="needs a real bash on win32",
)


@live_only
def test_live_idle_shell_is_not_reported_busy():
    """The incident, end to end: an idle shell must not answer 'busy'."""
    child = wsc.WinShellChild(_LIVE_BASH, cwd=os.getcwd())
    try:
        time.sleep(1.5)  # let bash settle at its read loop
        assert child.shell_is_busy() is False
    finally:
        child.close()


@live_only
def test_live_foreground_job_is_still_detected_as_busy():
    """The fix must not blunt the oracle into always answering False."""
    child = wsc.WinShellChild(_LIVE_BASH, cwd=os.getcwd())
    try:
        time.sleep(1.5)
        child.sendline("sleep 3")
        time.sleep(1.0)
        assert child.shell_is_busy() is True
        time.sleep(3.0)
        assert child.shell_is_busy() is False
    finally:
        child.close()


@live_only
def test_live_shell_has_coreutils_on_path():
    """Guards the launcher bypass: cat/head must resolve in the spawned bash."""
    child = wsc.WinShellChild(_LIVE_BASH, cwd=os.getcwd())
    try:
        time.sleep(1.5)
        child.buffer = ""
        child.sendline("echo hello | head -1; echo EXIT=$?")
        time.sleep(2.0)
        child._drain()
        assert "command not found" not in child.buffer
        assert "EXIT=0" in child.buffer
    finally:
        child.close()
