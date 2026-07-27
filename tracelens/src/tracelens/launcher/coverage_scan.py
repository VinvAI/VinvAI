"""T1.3 / T2.3 — pre-import scan of the universe of instrumentable functions.

Walks each ``--target-package`` source tree on disk, counts ``FunctionDef`` /
``AsyncFunctionDef`` nodes that match the import-hook's public-function rules. Lets us
report ``"instrumented N of M public functions in K modules"`` in the end-of-run summary
and detect modules with zero spans (uncovered hot symbols).

Intentionally cheap: AST parse only, no imports, no execution. Safe to run before the user
target boots.
"""

from __future__ import annotations

import ast
import importlib.util
import logging
import os
import re
from collections import defaultdict
from collections.abc import Iterable
from pathlib import Path

_log = logging.getLogger("tracelens.diag")


def _skip_pattern() -> re.Pattern[str]:
    pat = os.environ.get("TRACELENS_SKIP_PATTERN") or r"^__.*__$"
    try:
        return re.compile(pat)
    except re.error:
        return re.compile(r"^__.*__$")


def _is_public(name: str, skip_re: re.Pattern[str]) -> bool:
    return not skip_re.match(name)


def _has_yield(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    for n in ast.walk(node):
        if isinstance(n, ast.Yield | ast.YieldFrom):
            return True
    return False


def _package_dir(package_name: str) -> Path | None:
    """Locate the on-disk root of a target package.

    Tries (in order):
        1. ``importlib.util.find_spec`` against current ``sys.path``.
        2. ``cwd/<package_name>`` — common for the typical ``tracelens run -- python -m
           uvicorn backend.api:app`` case where the user's package is importable from cwd
           but the launcher's coverage scan runs *before* cwd is on ``sys.path``.
    Returns None if neither resolves.
    """
    spec = importlib.util.find_spec(package_name)
    if spec is not None and spec.submodule_search_locations:
        return Path(next(iter(spec.submodule_search_locations)))
    if spec is not None and spec.origin and spec.origin.endswith(".py"):
        return Path(spec.origin).parent
    # CWD fallback
    cwd_pkg = Path.cwd() / package_name
    if (cwd_pkg / "__init__.py").is_file() or any(cwd_pkg.glob("*.py")):
        return cwd_pkg
    cwd_mod = Path.cwd() / f"{package_name}.py"
    if cwd_mod.is_file():
        return cwd_mod.parent
    return None


_VENV_MARKERS = ("venv", ".venv", "env", "site-packages", "node_modules")


def _iter_python_files(root: Path) -> Iterable[Path]:
    for p in root.rglob("*.py"):
        parts = p.parts
        # Skip pyc caches, editable-install build artifacts, and any nested venv.
        if "__pycache__" in parts or ".egg-info" in parts:
            continue
        if any(m in parts for m in _VENV_MARKERS):
            continue
        yield p


def _count_module(tree: ast.Module, skip_re: re.Pattern[str]) -> dict[str, int]:
    counts = {"public_functions": 0, "generators": 0, "test_class_methods": 0}
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            in_test_class = node.name.startswith("Test")
            for item in node.body:
                if isinstance(item, ast.FunctionDef | ast.AsyncFunctionDef):
                    if not _is_public(item.name, skip_re):
                        continue
                    if in_test_class:
                        counts["test_class_methods"] += 1
                        continue
                    if _has_yield(item):
                        counts["generators"] += 1
                    else:
                        counts["public_functions"] += 1
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            if not _is_public(node.name, skip_re):
                continue
            if _has_yield(node):
                counts["generators"] += 1
            else:
                counts["public_functions"] += 1
    return counts


def _fullname_from_ancestry(f: Path) -> str | None:
    """Derive the module's *import* fullname from ``__init__.py`` package ancestry.

    Used for source-root scans, where the root itself is not a package: walking up
    to the topmost package dir yields the same name the module gets at import time
    (e.g. ``<root>/admin/src/vinv_admin/main.py`` → ``vinv_admin.main``), so the
    summary's zero-span cross-reference lines up with runtime component names.
    Returns ``None`` for a bare ``__init__.py`` outside any package (nothing
    importable to report).
    """
    parts = [] if f.stem == "__init__" else [f.stem]
    d = f.parent
    while (d / "__init__.py").is_file():
        parts.insert(0, d.name)
        parent = d.parent
        if parent == d:
            break
        d = parent
    return ".".join(parts) if parts else None


def scan_targets(target_packages: Iterable[str], *, roots: Iterable[str] = ()) -> dict[str, object]:
    """Count public functions per module under each ``--target-package``.

    ``roots`` are source-root directories (see ``launcher.targets.split_targets``):
    scanned recursively, with module names derived from package ancestry rather
    than the path under the root.

    Returns::

        {
          "packages": [...],
          "roots": [...],
          "modules": {  # fullname → counts
              "demo_app.main": {"public_functions": 5, "generators": 0, "test_class_methods": 0},
              ...
          },
          "totals": {"modules": M, "public_functions": N, "generators": G},
        }
    """
    packages = list(target_packages)
    root_dirs = [Path(r) for r in roots]
    skip_re = _skip_pattern()
    modules: dict[str, dict[str, int]] = {}
    totals: defaultdict[str, int] = defaultdict(int)
    seen_files: set[Path] = set()

    def _scan_file(f: Path, fullname: str) -> None:
        if f in seen_files:
            return
        seen_files.add(f)
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"), filename=str(f))
        except (SyntaxError, UnicodeDecodeError):
            return
        counts = _count_module(tree, skip_re)
        modules[fullname] = counts
        totals["public_functions"] += counts["public_functions"]
        totals["generators"] += counts["generators"]

    for pkg in packages:
        root = _package_dir(pkg)
        if root is None:
            _log.warning("tracelens: target package %r not importable; coverage scan skipped", pkg)
            continue
        for f in _iter_python_files(root):
            # derive the module fullname from the relative path under package root
            rel = f.relative_to(root.parent if root.name == pkg else root)
            mod_parts = list(rel.with_suffix("").parts)
            if mod_parts and mod_parts[-1] == "__init__":
                mod_parts.pop()
            _scan_file(f, ".".join(mod_parts) if mod_parts else pkg)

    for root in root_dirs:
        for f in _iter_python_files(root):
            fullname = _fullname_from_ancestry(f)
            if fullname is None:
                continue
            # The import hook never rewrites tracelens' own modules (recursion
            # hazard), so keep a monorepo's tracelens checkout out of the counts.
            if fullname == "tracelens" or fullname.startswith("tracelens."):
                continue
            _scan_file(f, fullname)

    totals["modules"] = len(modules)
    return {
        "packages": packages,
        "roots": [str(r) for r in root_dirs],
        "modules": modules,
        "totals": dict(totals),
    }


def reload_target_modules(target_packages: Iterable[str]) -> dict[str, str]:
    """T1.3 optional — re-import any already-loaded modules under target packages so the
    AST hook (installed *after* startup imports) can rewrite them.

    Returns ``{fullname: status}``. Only enabled when ``TRACELENS_RELOAD_TARGETS=1``.

    Disabled by default because reload is unsafe for stateful modules (DB connection
    pools, logger configs, top-level singletons).
    """
    import importlib
    import sys as _sys

    if os.environ.get("TRACELENS_RELOAD_TARGETS") != "1":
        return {}
    out: dict[str, str] = {}
    targets = tuple(target_packages)
    for fullname in list(_sys.modules):
        if not any(fullname == t or fullname.startswith(t + ".") for t in targets):
            continue
        mod = _sys.modules.get(fullname)
        if mod is None:
            continue
        try:
            importlib.reload(mod)
            out[fullname] = "reloaded"
        except BaseException as exc:  # noqa: BLE001
            out[fullname] = f"failed:{type(exc).__name__}"
    return out
