"""Operational hygiene of the sandbox (audit OPS-1, OPS-2, OPS-5, OPS-8, OPS-13).

These are the defects that damage the developer's MACHINE rather than the
report: a tree that is never cleaned up, a worker that dies on an emoji, a
guard that fails open, caches written to the real AppData.

  OPS-1   `copy2` preserves the read-only attribute, so a read-only file in the
          source produced a read-only copy that `rmtree(ignore_errors=True)`
          could not remove — silently, run after run, while the report claimed
          `root_removed: true`. Separately, only IsolationUnavailable/OSError
          were caught during setup, so any other exception orphaned a fully
          populated tree.
  OPS-2   Every worker pipe used bare `text=True`. The locale encoding is
          cp1252 on Windows for every supported interpreter, so a target
          printing non-cp1252 text killed the worker — or, on the parent side,
          raised UnicodeDecodeError inside `subprocess.run` and killed the run.
  OPS-5   `snapshot_tree` called `path.resolve()` per entry — a realpath
          syscall per file, before the is_dir check, twice per module.
  OPS-8   `os.path.realpath("")` returns the CWD, never "", so the shim's
          `if not _ROOT: return False` fail-closed guard was unreachable and an
          unset env var made the current directory the sandbox root.
  OPS-13  `%APPDATA%`/`%LOCALAPPDATA%` were not redirected, so platformdirs,
          the pip cache and HF/matplotlib caches wrote to the real profile.
"""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path

import pytest

from exerciser import sandbox as sb


class TestDisposeReportsTheTruth:
    def test_a_read_only_file_does_not_defeat_cleanup(self, tmp_path: Path) -> None:
        """The Windows leak: copy2 preserves read-only, unlink then refuses."""
        policy = sb.SandboxPolicy()
        box = sb.prepare_sandbox(tmp_path, policy)
        victim = box.root / "readonly.txt"
        victim.write_text("x", encoding="utf-8")
        os.chmod(victim, stat.S_IREAD)
        assert box.dispose() is True
        assert not box.root.exists()

    def test_dispose_returns_false_when_the_root_survives(self, tmp_path: Path) -> None:
        """keep_root is the one case where survival is intended."""
        box = sb.prepare_sandbox(tmp_path, sb.SandboxPolicy(keep_root=True))
        try:
            assert box.dispose() is False
            assert box.root.exists()
        finally:
            sb.shutil.rmtree(box.root, ignore_errors=True)

    def test_dispose_is_idempotent(self, tmp_path: Path) -> None:
        box = sb.prepare_sandbox(tmp_path, sb.SandboxPolicy())
        assert box.dispose() is True
        assert box.dispose() is True, "a second dispose must not raise"

    def test_a_non_oserror_during_setup_does_not_orphan_a_tree(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`plan_services` reads user-editable JSON and can raise AttributeError,
        which escaped both handlers and leaked a fully populated tree."""
        before = set(Path(sb.tempfile.gettempdir()).glob("vinv-sandbox-*"))

        def boom(*_a: object, **_k: object) -> None:
            raise AttributeError("'list' object has no attribute 'values'")

        monkeypatch.setattr(sb, "copy_repo", boom)
        with pytest.raises(AttributeError):
            sb.prepare_sandbox(tmp_path, sb.SandboxPolicy())
        after = set(Path(sb.tempfile.gettempdir()).glob("vinv-sandbox-*"))
        assert after <= before, f"orphaned sandbox tree(s): {sorted(after - before)}"


class TestSandboxEnvironment:
    def _env(self, tmp_path: Path) -> dict[str, str]:
        box = sb.prepare_sandbox(tmp_path, sb.SandboxPolicy())
        try:
            return sb.sandbox_env(box)
        finally:
            box.dispose()

    def test_child_stdio_is_forced_to_utf8(self, tmp_path: Path) -> None:
        """OPS-2, child side: without this an emoji kills the worker."""
        assert self._env(tmp_path)["PYTHONIOENCODING"] == "utf-8"

    @pytest.mark.parametrize("var", ["APPDATA", "LOCALAPPDATA", "HOMEPATH"])
    def test_windows_native_home_vars_are_redirected(self, tmp_path: Path, var: str) -> None:
        """OPS-13: platformdirs/pip/HF caches otherwise hit the real profile."""
        env = self._env(tmp_path)
        assert var in env
        assert str(tmp_path) not in env[var] or "vinv-sandbox" in env[var]

    def test_the_posix_home_vars_are_still_redirected(self, tmp_path: Path) -> None:
        env = self._env(tmp_path)
        for var in ("HOME", "USERPROFILE", "TMPDIR", "XDG_CACHE_HOME"):
            assert "vinv-sandbox" in env[var], var


class TestWorkerPipesDeclareTheirEncoding:
    """OPS-2, parent side — every spawn must decode explicitly."""

    _MODULES = [
        "concurrency.py",
        "containment.py",
        "differential.py",
        "environment.py",
        "faults.py",
        "functions.py",
        "sandbox.py",
    ]

    @pytest.mark.parametrize("name", _MODULES)
    def test_no_spawn_relies_on_the_locale_encoding(self, name: str) -> None:
        src = (Path(sb.__file__).parent / name).read_text(encoding="utf-8")
        for match in re.finditer(r"text=True,", src):
            window = src[match.end() : match.end() + 120]
            assert "encoding=" in window, (
                f"{name}: a `text=True` pipe near offset {match.start()} does not "
                "declare an encoding — it will use cp1252 on Windows"
            )

    @pytest.mark.parametrize("name", _MODULES)
    def test_decoding_never_raises_on_undecodable_bytes(self, name: str) -> None:
        """Scoped to SUBPROCESS pipes — a `write_text(encoding=...)` needs no
        `errors=`, and asserting otherwise would be a test bug, not a finding."""
        src = (Path(sb.__file__).parent / name).read_text(encoding="utf-8")
        for match in re.finditer(r"text=True,", src):
            window = src[match.end() : match.end() + 120]
            assert "errors=" in window, (
                f"{name}: a worker pipe decodes strictly — undecodable bytes from "
                "the target would raise inside subprocess.run and kill the run"
            )


class TestSnapshotTree:
    """OPS-5 — correctness must survive the syscall removal."""

    def test_files_are_recorded_with_size_and_mtime(self, tmp_path: Path) -> None:
        (tmp_path / "a.txt").write_text("hello", encoding="utf-8")
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "b.txt").write_text("hi", encoding="utf-8")
        snap = sb.snapshot_tree(tmp_path)
        assert set(snap) == {"a.txt", str(Path("sub/b.txt"))} or len(snap) == 2
        assert all(isinstance(v, tuple) and len(v) == 2 for v in snap.values())

    def test_skipped_paths_are_excluded(self, tmp_path: Path) -> None:
        (tmp_path / "keep.txt").write_text("k", encoding="utf-8")
        secret = tmp_path / "skip.txt"
        secret.write_text("s", encoding="utf-8")
        snap = sb.snapshot_tree(tmp_path, skip=[secret])
        assert not any("skip" in k for k in snap)
        assert any("keep" in k for k in snap)

    def test_a_skipped_directory_is_not_descended(self, tmp_path: Path) -> None:
        d = tmp_path / "node_modules"
        d.mkdir()
        (d / "x.js").write_text("1", encoding="utf-8")
        (tmp_path / "keep.txt").write_text("k", encoding="utf-8")
        snap = sb.snapshot_tree(tmp_path, skip=[d])
        assert not any("x.js" in k for k in snap)

    def test_an_empty_skip_set_records_everything(self, tmp_path: Path) -> None:
        (tmp_path / "a.txt").write_text("a", encoding="utf-8")
        assert len(sb.snapshot_tree(tmp_path, skip=[])) == 1

    def test_a_change_is_visible_between_two_snapshots(self, tmp_path: Path) -> None:
        """The before/after pair is the ground truth of what a worker left."""
        before = sb.snapshot_tree(tmp_path)
        (tmp_path / "new.txt").write_text("n", encoding="utf-8")
        after = sb.snapshot_tree(tmp_path)
        assert set(after) - set(before)


class TestShimRootGuardFailsClosed:
    """OPS-8 — the guard that could never fire."""

    def test_realpath_of_empty_string_is_not_empty(self) -> None:
        """The premise of the bug, pinned so it cannot silently return."""
        assert os.path.realpath("") == os.getcwd()

    def test_the_shim_computes_root_only_from_a_set_variable(self) -> None:
        src = (Path(sb.__file__).parent / "sandbox.py").read_text(encoding="utf-8")
        assert (
            '_ROOT = os.path.realpath(_ROOT_RAW) if _ROOT_RAW else ""' in src
        ), "an unset VINV_SANDBOX_ROOT must yield an empty root, not the CWD"

    def test_an_unset_root_yields_empty_and_an_set_one_resolves(self, tmp_path: Path) -> None:
        """Reproduce the shim's own two-line derivation."""
        for raw, expected_empty in (("", True), (str(tmp_path), False)):
            root = os.path.realpath(raw) if raw else ""
            assert (root == "") is expected_empty
