#!/usr/bin/env python3
"""Fail when code imports a third-party package no manifest declares.

WHY THIS EXISTS. Four separate instances of one defect shape were found in this
repo, each independently and each after the code had been reviewed and shipped:

  1. tracelens's `otel-libs` extra — declared, installed by NOTHING. The OTel
     contrib instrumentors were only ever in the venv because bring-up had an
     LLM agent pip-install them, so an unrelated `uv sync` pruned all nine and
     tracing silently degraded to parent-process spans with no error.
  2. exerciser's `hypothesis-jsonschema` — `generators.py` calls it "Adopted",
     `plan.py` consumes the arm it gates, and it was declared in no manifest at
     all. `hypothesis_valid_available()` returned False in every install that
     has ever shipped, and the tests branched on that probe so they passed while
     covering nothing.
  3. `jsdom` — imported by scripts/e2e-graph-webview.mjs and
     scripts/e2e-unlinked-node.mjs, declared nowhere, so both headless webview
     e2e tests fail at import on any clean checkout.
  4. `core`'s `litellm` (the `core` package has since been removed) — declared,
     but redirected to an in-tree shim by
     `[tool.uv.sources]`, which is uv-only and absent from wheel metadata, so
     `pip install vinv-core` silently resolved a DIFFERENT package.

The shape is always: real code, a real consumer, an absent or
installer-specific declaration. Nothing failed loudly, which is why all four
survived. The check is mechanical, so it belongs in CI rather than in a
reviewer's head.

WHAT IT DOES. Collects every third-party top-level import across the Python
engines and the repo's own scripts, resolves each against the union of every
manifest's declared dependencies (all groups and extras) plus stdlib and
first-party names, and reports the ones nothing declares.

Soft imports count. A `try: import x / except ImportError:` capability probe is
exactly case 2 — the probe makes absence silent, which is precisely why the
declaration must exist and be checkable. An intentionally-optional package must
be declared in an extra (that is what an extra is FOR); if it is genuinely not
wanted, add it to KNOWN_ABSENT below with a reason.

Exit 0 clean, 1 with findings. `--json` for machine output.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
import sysconfig
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Python sources to scan: every engine's src/ plus the repo's own scripts.
PY_ROOTS = (
    "contracts",
    "tracelens",
    "identification",
    "handbook",
    "bringup",
    "goal",
    "embedder",
    "exerciser",
)

SKIP_DIR_PARTS = {
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".git",
    "build",
    "dist",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "site-packages",
    # Vendored code ships its own manifest and is not this repo's declaration.
    "vendor",
    "vendored",
    "third_party",
    # Fixtures are deliberately synthetic mini-projects.
    "fixtures",
}

# import name -> distribution name, where they differ. Only entries that
# actually appear in this repo; a partial map is fine because an unmapped name
# is compared against the manifests directly.
IMPORT_TO_DIST = {
    "yaml": "PyYAML",
    "sklearn": "scikit-learn",
    "dateutil": "python-dateutil",
    "attr": "attrs",
    "pkg_resources": "setuptools",
    "dotenv": "python-dotenv",
    "hypothesis_jsonschema": "hypothesis-jsonschema",
    "dspy": "dspy-ai",
    "PIL": "pillow",
    "cv2": "opencv-python",
    "OpenSSL": "pyOpenSSL",
    "google": "protobuf",
    "importlib_metadata": "importlib-metadata",
    "sentence_transformers": "sentence-transformers",
    "websocket": "websocket-client",
    "huggingface_hub": "huggingface-hub",
    "opentelemetry": "opentelemetry-api",
    "jwt": "PyJWT",
    "zoneinfo": "backports.zoneinfo",
}

# Packages deliberately NOT declared, each with the reason. Anything added here
# is a decision on the record, which is the point.
KNOWN_ABSENT: dict[str, str] = {
    # tracelens is imported by the AST-injected trace hook inside a FOREIGN
    # service's venv; it is this repo's own package, resolved by path there.
    "tracelens": "first-party; injected into target venvs by path, never resolved from an index",
}


def norm(name: str) -> str:
    """PEP 503 normalization, so `PyYAML`/`pyyaml`/`Py_YAML` compare equal."""
    return re.sub(r"[-_.]+", "-", name).lower()


def stdlib_names() -> set[str]:
    names = set(sys.stdlib_module_names)
    # Vendored-in-stdlib and platform bits that are not on stdlib_module_names
    # for every version.
    names |= {"__future__", "typing_extensions_stub"}
    paths = {sysconfig.get_paths().get("stdlib", "")}
    return {n for n in names if n} | {p for p in paths if False}


def first_party_names() -> set[str]:
    """Top-level packages this repo itself provides."""
    out: set[str] = set()
    for member in PY_ROOTS:
        src = REPO / member / "src"
        if not src.is_dir():
            continue
        for child in src.iterdir():
            if child.is_dir() and (child / "__init__.py").exists():
                out.add(child.name)
            elif child.suffix == ".py":
                out.add(child.stem)
    return out


def declared_distributions() -> set[str]:
    """Every distribution named by ANY manifest — deps, groups, extras.

    Deliberately a union rather than per-member: this check answers "does the
    repo declare it at all", which is the question all four live cases failed.
    Per-member correctness is a separate, stricter check.
    """
    out: set[str] = set()

    def add_reqs(reqs) -> None:
        if not isinstance(reqs, list):
            return
        for r in reqs:
            if isinstance(r, str):
                # "pkg[extra]>=1,<2 ; marker" -> "pkg"
                out.add(norm(re.split(r"[<>=!~;\[ ]", r.strip(), maxsplit=1)[0]))

    for manifest in [REPO / "pyproject.toml"] + [
        REPO / m / "pyproject.toml" for m in PY_ROOTS
    ]:
        if not manifest.is_file():
            continue
        data = tomllib.loads(manifest.read_text(encoding="utf-8"))
        proj = data.get("project", {}) or {}
        add_reqs(proj.get("dependencies"))
        for reqs in (proj.get("optional-dependencies") or {}).values():
            add_reqs(reqs)
        for reqs in (data.get("dependency-groups") or {}).values():
            add_reqs(reqs)
        add_reqs(((data.get("build-system") or {}).get("requires")))
        tool_uv = (data.get("tool") or {}).get("uv") or {}
        add_reqs(tool_uv.get("constraint-dependencies"))
        add_reqs(tool_uv.get("override-dependencies"))
    return out


def py_files() -> list[Path]:
    out: list[Path] = []
    roots = [REPO / m / "src" for m in PY_ROOTS] + [REPO / "scripts"]
    for root in roots:
        if not root.is_dir():
            continue
        for f in root.rglob("*.py"):
            if SKIP_DIR_PARTS & set(f.parts):
                continue
            out.append(f)
    return out


def imports_of(path: Path) -> set[str]:
    """Top-level module names imported by `path` (absolute imports only)."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, SyntaxError):
        return set()
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                out.add(a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:  # skip relative imports
                out.add(node.module.split(".")[0])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    declared = declared_distributions()
    stdlib = stdlib_names()
    first_party = first_party_names()
    known_absent = {norm(k) for k in KNOWN_ABSENT}

    findings: dict[str, set[str]] = {}
    for f in py_files():
        for imp in imports_of(f):
            if imp in stdlib or imp in first_party or imp.startswith("_"):
                continue
            dist = norm(IMPORT_TO_DIST.get(imp, imp))
            if dist in declared or dist in known_absent:
                continue
            findings.setdefault(f"{imp} (dist: {dist})", set()).add(
                str(f.relative_to(REPO))
            )

    if args.json:
        print(json.dumps({k: sorted(v) for k, v in sorted(findings.items())}, indent=2))
    elif not findings:
        print(
            f"OK — every third-party import across {len(py_files())} Python files "
            f"resolves to one of {len(declared)} declared distributions."
        )
    else:
        print("UNDECLARED third-party imports (real code, absent declaration):\n")
        for name, files in sorted(findings.items()):
            print(f"  {name}")
            for f in sorted(files)[:6]:
                print(f"      {f}")
            if len(files) > 6:
                print(f"      … and {len(files) - 6} more")
        print(
            "\nFix by DECLARING it — in the member's dependencies if required, or in an "
            "extra if genuinely optional (an extra is what makes an optional capability "
            "installable AND checkable). If it is intentionally absent, add it to "
            "KNOWN_ABSENT in this script with the reason, so the decision is on the record."
        )
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
