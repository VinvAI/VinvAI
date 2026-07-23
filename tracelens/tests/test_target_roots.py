"""Directory-style ``--target-package`` values (source roots).

Bug history (2026-07-16, vinv-bringup capture):
  Bringup generated ``--target-package Vinv`` — the *monorepo directory* name —
  while the app's import package was ``vinv_admin``. With cwd on ``sys.path``
  (the frozen-binary handoff runs ``python -c …``), ``find_spec("Vinv")``
  resolved the bare directory as a namespace package, so the coverage scan
  walked the tree and reported ``modules_scanned=354`` — but the import hook
  matches by fullname prefix, ``vinv_admin.*`` never starts with ``Vinv.``, and
  ``modules_rewritten`` stayed 0. The capture contained only OTel HTTP framework
  spans and zero symbol-level evidence.

Fix: ``launcher.targets.split_targets`` partitions targets into import names vs
source-root directories; the hook additionally matches modules whose resolved
file origin lives under a root (``TRACELENS_TARGET_ROOTS``), and the coverage
scan derives import-style fullnames from ``__init__.py`` ancestry for roots.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

from tracelens.launcher import import_hook, targets
from tracelens.launcher.coverage_scan import scan_targets


def _make_service_tree(root: Path) -> Path:
    """``<root>/MonoRoot/app/src/rootdemo_pkg/{__init__,logic}.py`` — mirrors a
    monorepo whose app package name differs from the repo directory name."""
    pkg = root / "MonoRoot" / "app" / "src" / "rootdemo_pkg"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("")
    (pkg / "logic.py").write_text("def add(a, b):\n    return a + b\n")
    return root / "MonoRoot"


def test_split_targets_partitions_dirs_and_packages(tmp_path, monkeypatch):
    mono = _make_service_tree(tmp_path)
    monkeypatch.chdir(tmp_path)
    names, roots = targets.split_targets(["MonoRoot", "json"])
    assert names == ["json"]
    assert roots == [str(mono.resolve())]


def test_split_targets_never_imports_target_code(tmp_path, monkeypatch):
    """Dotted targets must classify WITHOUT importing the parent package: split
    runs inside the launcher, and any import here would load target code before
    the AST hook can rewrite it (``importlib.util.find_spec`` does exactly that;
    ``PathFinder`` does not)."""
    pkg = tmp_path / "sideeffect_pkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("raise AssertionError('imported during split_targets')\n")
    (pkg / "sub.py").write_text("")
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.chdir(tmp_path)
    sys.modules.pop("sideeffect_pkg", None)
    names, roots = targets.split_targets(["sideeffect_pkg.sub"])
    assert names == ["sideeffect_pkg.sub"]
    assert roots == []
    assert "sideeffect_pkg" not in sys.modules


def test_split_targets_keeps_unresolvable_as_name(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    names, roots = targets.split_targets(["no_such_pkg_xyz"])
    assert names == ["no_such_pkg_xyz"]
    assert roots == []


def test_import_hook_rewrites_module_under_target_root(tmp_path, monkeypatch):
    mono = _make_service_tree(tmp_path)
    src_dir = mono / "app" / "src"
    monkeypatch.setenv("TRACELENS_TARGET_PACKAGES", "")
    monkeypatch.setenv("TRACELENS_TARGET_ROOTS", str(mono.resolve()))
    monkeypatch.syspath_prepend(str(src_dir))
    finder = import_hook.TracelensFinder()
    sys.meta_path.insert(0, finder)
    try:
        for m in ("rootdemo_pkg", "rootdemo_pkg.logic"):
            sys.modules.pop(m, None)
        logic = importlib.import_module("rootdemo_pkg.logic")
        assert logic.add(1, 2) == 3
        status = import_hook.rewrite_status()
        assert status.get("rootdemo_pkg.logic", "").startswith("ok:")
        # the wrapper split leaves an inner impl alongside the outer name
        assert any(n.startswith("_tl_impl_add_") for n in vars(logic))
    finally:
        sys.meta_path.remove(finder)
        for m in ("rootdemo_pkg", "rootdemo_pkg.logic"):
            sys.modules.pop(m, None)
        import_hook._module_status.pop("rootdemo_pkg.logic", None)


def test_import_hook_never_rewrites_tracelens_itself(monkeypatch):
    own_pkg_dir = Path(import_hook.__file__).resolve().parents[1]
    monkeypatch.setenv("TRACELENS_TARGET_ROOTS", str(own_pkg_dir.parent))
    assert not import_hook._origin_in_roots(import_hook.__file__, "tracelens.launcher.import_hook")


def test_coverage_scan_derives_import_names_for_roots(tmp_path):
    mono = _make_service_tree(tmp_path)
    result = scan_targets([], roots=[str(mono)])
    modules = result["modules"]
    assert "rootdemo_pkg.logic" in modules
    assert modules["rootdemo_pkg.logic"]["public_functions"] == 1
    assert result["roots"] == [str(mono)]
