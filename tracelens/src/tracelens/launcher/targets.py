"""Resolve ``--target-package`` values into import names vs. source-root directories.

A target like ``vinv_admin`` is an import name: the AST hook matches modules by
fullname prefix. But launch generators (and users) also pass repo/service *directory*
names — e.g. ``--target-package Vinv`` for a monorepo whose actual app package is
``vinv_admin``. Such a value never matches any imported module's fullname, so the
hook rewrites nothing, while the coverage scan (which walks the filesystem) happily
reports hundreds of scanned modules. That mismatch produced captures with
``modules_scanned=354, modules_rewritten=0`` and zero symbol-level spans.

``split_targets`` partitions the raw values: anything importable as a *regular*
package/module stays a name; anything that instead names an existing directory
(literal path, ``cwd/<name>``, or a bare namespace package) becomes a source root.
Roots are matched by the import hook against each module's resolved file origin.
"""

from __future__ import annotations

import importlib.machinery
import logging
import os
from pathlib import Path

_log = logging.getLogger("tracelens.diag")

_ROOTS_ENV = "TRACELENS_TARGET_ROOTS"


def _regular_package_spec(name: str) -> bool:
    """True when ``name``'s top-level part resolves to a real package/module.

    Namespace packages (``origin is None``) do NOT count: a bare directory on
    ``sys.path`` without ``__init__.py`` — like a monorepo root when cwd is on
    ``sys.path`` — resolves as one, and treating it as an import name is exactly
    the silent-zero-rewrites failure mode this module exists to prevent.

    Uses ``PathFinder`` directly (never ``importlib.util.find_spec``): the latter
    imports parent packages of dotted names, and classification runs inside the
    launcher — importing target code here would let it load before/around the
    AST hook and silently escape rewriting. Only the top-level part is resolved,
    which is sufficient to distinguish an import name from a directory name.
    """
    if not all(part.isidentifier() for part in name.split(".")):
        return False
    top = name.partition(".")[0]
    try:
        spec = importlib.machinery.PathFinder.find_spec(top, None)
    except (ImportError, ValueError, AttributeError):
        return False
    return spec is not None and spec.origin is not None


def split_targets(targets: list[str]) -> tuple[list[str], list[str]]:
    """Partition targets into ``(import_names, root_dirs)``; roots are absolute.

    Unresolvable values are kept as import names (the hook may still match them
    if the target only becomes importable after app startup mutates ``sys.path``).
    """
    names: list[str] = []
    roots: list[str] = []
    for t in targets:
        if _regular_package_spec(t):
            names.append(t)
            continue
        p = Path(t).expanduser()
        cand = p if p.is_absolute() else Path.cwd() / p
        if cand.is_dir():
            root = str(cand.resolve())
            roots.append(root)
            _log.warning(
                "tracelens: target %r is not an importable package; treating it as a "
                "source-root directory (%s) — modules whose files live under it will "
                "be instrumented",
                t,
                root,
            )
            continue
        names.append(t)
    return names, roots


def apply_roots_env(roots: list[str]) -> None:
    """Publish resolved roots for the import hook (it only reads env, like targets)."""
    if roots:
        os.environ[_ROOTS_ENV] = os.pathsep.join(roots)
    else:
        os.environ.pop(_ROOTS_ENV, None)


def roots_from_env() -> tuple[str, ...]:
    raw = os.environ.get(_ROOTS_ENV, "")
    return tuple(p for p in raw.split(os.pathsep) if p)
