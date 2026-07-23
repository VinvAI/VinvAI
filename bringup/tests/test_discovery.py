"""Tests for distribution-based service discovery and inventory validation.

The 2026-07 bringup-list failure mode these guard: pointing ``bringup list`` at
a multi-repo workspace made the old depth-1 scan report each *repo* as a
"package" (2 fictional services), and the prompt then forced the agent to emit
exactly those names — mangling one real service and silently dropping the rest.
Discovery is now distribution-based (pyproject/setup manifests, n-level nested)
and resolves IMPORTABLE package names; the harness validates the agent-written
inventory before accepting it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BRINGUP_ROOT = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(_BRINGUP_ROOT / "src"))

from bringup.runner import (  # noqa: E402
    _default_modules,
    _discover_distributions,
    _discover_traceable_packages,
    _validate_services_inventory,
    list_instruction,
)


# ── Layout builders ───────────────────────────────────────────────


def _write(path: Path, content: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _dist_map(root: Path) -> dict[str, tuple[str, ...]]:
    return {d.name: d.packages for d in _discover_distributions(root)}


# ── Distribution discovery ────────────────────────────────────────


def test_src_layout_resolves_import_package(tmp_path: Path) -> None:
    _write(tmp_path / "payment" / "pyproject.toml", '[project]\nname = "acme-payment"\n')
    _write(tmp_path / "payment" / "src" / "acme_payment" / "__init__.py")
    assert _dist_map(tmp_path) == {"acme-payment": ("acme_payment",)}


def test_flat_self_package_with_own_manifest(tmp_path: Path) -> None:
    # vinv-electron/vinv_engine style: the manifest dir IS the package.
    _write(tmp_path / "engine" / "vinv_engine" / "pyproject.toml", '[project]\nname = "vinv-engine"\n')
    _write(tmp_path / "engine" / "vinv_engine" / "__init__.py")
    assert _dist_map(tmp_path) == {"vinv-engine": ("vinv_engine",)}


def test_poetry_packages_declaration_wins_over_layout(tmp_path: Path) -> None:
    _write(
        tmp_path / "lib" / "pyproject.toml",
        '[tool.poetry]\nname = "my-lib"\npackages = [{include = "mylib", from = "src"}]\n',
    )
    _write(tmp_path / "lib" / "src" / "mylib" / "__init__.py")
    _write(tmp_path / "lib" / "src" / "decoy" / "__init__.py")
    assert _dist_map(tmp_path) == {"my-lib": ("mylib",)}


def test_setuptools_find_include_glob(tmp_path: Path) -> None:
    _write(
        tmp_path / "app" / "pyproject.toml",
        '[project]\nname = "app"\n'
        '[tool.setuptools.packages.find]\ninclude = ["app_core*", "app_core.*"]\n',
    )
    assert _dist_map(tmp_path) == {"app": ("app_core",)}


def test_hatch_wheel_packages_path_style(tmp_path: Path) -> None:
    _write(
        tmp_path / "svc" / "pyproject.toml",
        '[project]\nname = "svc"\n'
        '[tool.hatch.build.targets.wheel]\npackages = ["src/svc_impl"]\n',
    )
    assert _dist_map(tmp_path) == {"svc": ("svc_impl",)}


def test_vendored_manifest_is_never_a_service(tmp_path: Path) -> None:
    # A vendored stub shipping its own pyproject (e.g. name = "litellm") must
    # not be enumerated as one of this repo's services.
    _write(tmp_path / "core" / "pyproject.toml", '[project]\nname = "core"\n')
    _write(tmp_path / "core" / "src" / "core" / "__init__.py")
    _write(tmp_path / "core" / "vendor" / "litellm_stub" / "pyproject.toml", '[project]\nname = "litellm"\n')
    _write(tmp_path / "core" / "vendor" / "litellm_stub" / "litellm" / "__init__.py")
    assert _dist_map(tmp_path) == {"core": ("core",)}


def test_venv_detected_by_pyvenv_cfg_regardless_of_name(tmp_path: Path) -> None:
    _write(tmp_path / "app" / "pyproject.toml", '[project]\nname = "app"\n')
    _write(tmp_path / "app" / "app" / "__init__.py")
    _write(tmp_path / "myrandomenv" / "pyvenv.cfg", "home = /usr\n")
    _write(
        tmp_path / "myrandomenv" / "Lib" / "site-packages" / "requests" / "pyproject.toml",
        '[project]\nname = "requests"\n',
    )
    assert _dist_map(tmp_path) == {"app": ("app",)}


def test_n_level_nested_monorepo(tmp_path: Path) -> None:
    _write(
        tmp_path / "teams" / "alpha" / "libs" / "auth" / "pyproject.toml",
        '[project]\nname = "alpha-auth"\n',
    )
    _write(tmp_path / "teams" / "alpha" / "libs" / "auth" / "src" / "alpha_auth" / "__init__.py")
    _write(
        tmp_path / "teams" / "beta" / "services" / "api" / "setup.py",
        "from setuptools import setup; setup()",
    )
    _write(tmp_path / "teams" / "beta" / "services" / "api" / "beta_api" / "__init__.py")
    assert _dist_map(tmp_path) == {
        "alpha-auth": ("alpha_auth",),
        "api": ("beta_api",),
    }


def test_nested_distribution_under_workspace_manifest(tmp_path: Path) -> None:
    # A workspace-level pyproject must not swallow sub-distributions beneath it.
    _write(tmp_path / "pyproject.toml", '[project]\nname = "workspace"\n')
    _write(tmp_path / "libs" / "one" / "pyproject.toml", '[project]\nname = "one"\n')
    _write(tmp_path / "libs" / "one" / "src" / "one" / "__init__.py")
    names = set(_dist_map(tmp_path))
    assert "one" in names


def test_unpackaged_top_level_package_django_style(tmp_path: Path) -> None:
    # No manifest anywhere: the topmost __init__.py dir is the service;
    # its subpackages are not separate services.
    _write(tmp_path / "mysite" / "__init__.py")
    _write(tmp_path / "mysite" / "settings" / "__init__.py")
    _write(tmp_path / "manage.py")
    assert _dist_map(tmp_path) == {"mysite": ("mysite",)}


def test_subpackages_never_surface_as_top_level(tmp_path: Path) -> None:
    _write(tmp_path / "engine" / "pyproject.toml", '[project]\nname = "engine"\n')
    _write(tmp_path / "engine" / "engine" / "__init__.py")
    _write(tmp_path / "engine" / "engine" / "components" / "__init__.py")
    _write(tmp_path / "engine" / "engine" / "config" / "__init__.py")
    assert _dist_map(tmp_path) == {"engine": ("engine",)}


def test_traceable_packages_falls_back_to_flat_scan(tmp_path: Path) -> None:
    # Zero manifests, zero __init__.py: legacy behavior, identifiers only.
    _write(tmp_path / "backend" / "api.py")
    _write(tmp_path / "my-notes" / "loose.py")  # not an identifier → dropped
    assert _discover_traceable_packages(tmp_path) == ["backend"]


def test_traceable_packages_are_import_names_not_dir_names(tmp_path: Path) -> None:
    _write(tmp_path / "payment" / "pyproject.toml", '[project]\nname = "acme-payment"\n')
    _write(tmp_path / "payment" / "src" / "acme_payment" / "__init__.py")
    pkgs = _discover_traceable_packages(tmp_path)
    assert pkgs == ["acme_payment"]
    assert all(p.isidentifier() for p in pkgs)


# ── list_instruction rendering ────────────────────────────────────


def test_list_instruction_note_is_advisory_and_names_import_packages(tmp_path: Path) -> None:
    _write(tmp_path / "payment" / "pyproject.toml", '[project]\nname = "acme-payment"\n')
    _write(tmp_path / "payment" / "src" / "acme_payment" / "__init__.py")
    _write(tmp_path / ".vinv" / "vinv.md", "# handbook\n")
    prompt = list_instruction(tmp_path)
    assert "`acme-payment`" in prompt
    assert "`acme_payment`" in prompt
    # The old mandate ("emit exactly one entry per package… do not drop any")
    # is what forced the agent to fabricate; it must stay gone.
    assert "do not drop any" not in prompt
    assert "NOT a mandate" in prompt
    assert "ADD it" in prompt  # handbook-missing-from-scan conflict rule


# ── Inventory validation ──────────────────────────────────────────


def _valid_service(tmp_path: Path) -> dict:
    return {
        "name": "acme-payment",
        "kind": "python_web",
        "command": "python -m uvicorn acme_payment.main:app --host 0.0.0.0 --port 8780",
        "working_directory": str(tmp_path),
        "port": 8780,
        "modules": ["acme_payment"],
    }


def test_validate_accepts_good_inventory(tmp_path: Path) -> None:
    worker = {
        "name": "toolshed",
        "kind": "python_worker",
        "command": "python -m toolshed",
        "working_directory": str(tmp_path),
        "port": None,
        "modules": ["toolshed"],
    }
    assert _validate_services_inventory([_valid_service(tmp_path), worker]) == []


def test_validate_rejects_hyphen_module(tmp_path: Path) -> None:
    svc = _valid_service(tmp_path) | {"modules": ["vinv-electron"]}
    issues = _validate_services_inventory([svc])
    assert any("vinv-electron" in i and "identifier" in i for i in issues)


def test_validate_rejects_python_m_module_colon_attr(tmp_path: Path) -> None:
    svc = _valid_service(tmp_path) | {
        "command": "python -m vinv_payment.main:run --host 0.0.0.0 --port 8780"
    }
    issues = _validate_services_inventory([svc])
    assert any("module" in i and ":" in i for i in issues)


def test_validate_allows_uvicorn_factory_form(tmp_path: Path) -> None:
    # `-m uvicorn pkg.main:app` is the CORRECT way to launch an ASGI app; the
    # colon check must only fire when the module target itself carries `:attr`.
    assert _validate_services_inventory([_valid_service(tmp_path)]) == []


def test_validate_rejects_web_without_port_and_docker_and_dup_names(tmp_path: Path) -> None:
    a = _valid_service(tmp_path) | {"port": None}
    b = _valid_service(tmp_path) | {"command": "docker compose up payment"}
    issues = _validate_services_inventory([a, b])
    assert any("port" in i for i in issues)
    assert any("docker" in i for i in issues)
    assert any("duplicate" in i for i in issues)


def test_validate_rejects_empty_inventory() -> None:
    assert _validate_services_inventory([]) != []


def test_validate_accepts_stdio_and_scheduler_kinds(tmp_path: Path) -> None:
    stdio = {
        "name": "acme-mcp",
        "kind": "python_stdio",
        "transport": "stdio",
        "command": "python -m acme_mcp.server",
        "working_directory": str(tmp_path),
        "port": None,
        "modules": ["acme_mcp"],
    }
    beat = {
        "name": "acme-beat",
        "kind": "python_scheduler",
        "command": "python -m celery -A acme.tasks beat",
        "working_directory": str(tmp_path),
        "port": None,
        "modules": ["acme"],
    }
    assert _validate_services_inventory([stdio, beat]) == []


def test_validate_rejects_stdio_with_port_or_http_transport(tmp_path: Path) -> None:
    svc = {
        "name": "acme-mcp",
        "kind": "python_stdio",
        "transport": "http",
        "command": "python -m acme_mcp.server",
        "working_directory": str(tmp_path),
        "port": 8080,
        "modules": ["acme_mcp"],
    }
    issues = _validate_services_inventory([svc])
    assert any("stdin/stdout" in i and "port" in i for i in issues)
    assert any("transport" in i for i in issues)


def test_validate_rejects_unknown_kind_and_transport(tmp_path: Path) -> None:
    svc = _valid_service(tmp_path) | {"kind": "python_magic", "transport": "carrier-pigeon"}
    issues = _validate_services_inventory([svc])
    assert any("python_stdio" in i for i in issues)      # allowed kinds are named
    assert any("carrier-pigeon" in i for i in issues)


def test_validate_web_transport_must_be_http(tmp_path: Path) -> None:
    ok = _valid_service(tmp_path) | {"transport": "http"}
    assert _validate_services_inventory([ok]) == []
    bad = _valid_service(tmp_path) | {"transport": "stdio"}
    issues = _validate_services_inventory([bad])
    assert any("python_web" in i and "transport" in i for i in issues)


def test_validate_grounds_modules_against_discovery(tmp_path: Path) -> None:
    # The classic real-world failure: the agent writes the DISTRIBUTION name
    # ("admin") as the module, but the import package is "vinv_admin" — a
    # valid identifier, so the identifier check passes while tracelens
    # instruments nothing. Discovery grounding must reject it AND name the fix.
    _write(tmp_path / "admin" / "pyproject.toml", '[project]\nname = "admin"\n')
    _write(tmp_path / "admin" / "src" / "vinv_admin" / "__init__.py")
    svc = {
        "name": "admin",
        "kind": "python_web",
        "command": "python -m uvicorn vinv_admin.main:app --host 0.0.0.0 --port 8770",
        "working_directory": str(tmp_path),
        "port": 8770,
        "modules": ["admin"],
    }
    issues = _validate_services_inventory([svc], tmp_path)
    assert any("'admin'" in i and "vinv_admin" in i for i in issues)
    # The corrected inventory passes.
    good = svc | {"modules": ["vinv_admin"]}
    assert _validate_services_inventory([good], tmp_path) == []


def test_validate_without_project_root_skips_grounding(tmp_path: Path) -> None:
    # Backwards-compatible: no root ⇒ only the identifier check applies.
    svc = _valid_service(tmp_path) | {"modules": ["whatever_pkg"]}
    assert _validate_services_inventory([svc]) == []


# ── start-stage module defaulting ─────────────────────────────────


def test_default_modules_resolves_from_services_json(tmp_path: Path) -> None:
    _write(
        tmp_path / ".vinv" / "services.json",
        '{"services": [{"name": "acme-payment", "modules": ["acme_payment"]}]}',
    )
    assert _default_modules(tmp_path, "acme-payment", None) == ["acme_payment"]


def test_default_modules_identifier_service_name_stands_in(tmp_path: Path) -> None:
    assert _default_modules(tmp_path, "toolshed", None) == ["toolshed"]


def test_default_modules_non_identifier_without_inventory_is_empty(tmp_path: Path) -> None:
    # Falls through to start_instruction's repo-wide auto-discovery.
    assert _default_modules(tmp_path, "acme-payment", None) == []


def test_default_modules_caller_override_wins(tmp_path: Path) -> None:
    _write(
        tmp_path / ".vinv" / "services.json",
        '{"services": [{"name": "svc", "modules": ["from_inventory"]}]}',
    )
    assert _default_modules(tmp_path, "svc", ["explicit"]) == ["explicit"]


def test_default_modules_remaps_distribution_name_to_import_package(tmp_path: Path) -> None:
    # A stale inventory carrying the distribution name must still yield a
    # working --target-package: ground through discovery, don't trust it.
    _write(tmp_path / "admin" / "pyproject.toml", '[project]\nname = "admin"\n')
    _write(tmp_path / "admin" / "src" / "vinv_admin" / "__init__.py")
    _write(
        tmp_path / ".vinv" / "services.json",
        '{"services": [{"name": "admin", "modules": ["admin"]}]}',
    )
    assert _default_modules(tmp_path, "admin", None) == ["vinv_admin"]


def test_default_modules_drops_unknown_names_when_discovery_exists(tmp_path: Path) -> None:
    _write(tmp_path / "svc" / "pyproject.toml", '[project]\nname = "svc"\n')
    _write(tmp_path / "svc" / "src" / "real_pkg" / "__init__.py")
    assert _default_modules(tmp_path, "svc", ["no_such_pkg", "real_pkg"]) == ["real_pkg"]
