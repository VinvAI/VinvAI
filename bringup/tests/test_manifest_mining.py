"""Manifest-first runnable mining over the fixture mini-monorepo.

The edge cases the fixture plants (mirroring how mature platforms enumerate
runnables — Procfile process types, compose service mining, workspace target
inference):

* a Procfile with web + worker + clock process types;
* a docker-compose file with an app (→ host candidate) and a db (→ infra);
* a nested workspace member (`packages/member_svc`) with its own service;
* a stdio JSON-RPC (MCP) server package;
* a celery-style worker;
* a frontend dev server declared only in `webapp/package.json:scripts.dev`.

Discovery must find ALL of them, with the correct taxonomy kinds.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BRINGUP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_BRINGUP_ROOT / "src"))

from bringup.runner import (  # noqa: E402
    _classify_run_command,
    _discover_declared_runnables,
    _discover_distributions,
    list_instruction,
)

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "mini_monorepo"


def _by_name(runnables) -> dict[str, list]:
    out: dict[str, list] = {}
    for r in runnables:
        out.setdefault(r.name, []).append(r)
    return out


# ── Command classification (the taxonomy prior) ───────────────────


@pytest.mark.parametrize(
    ("command", "kind"),
    [
        ("python -m uvicorn app.main:app --port 8000", "http-service"),
        ("gunicorn app.wsgi", "http-service"),
        ("python manage.py runserver 0.0.0.0:8000", "http-service"),
        ("celery -A app.tasks worker --loglevel=info", "worker"),
        ("celery -A app.tasks beat --loglevel=info", "scheduler"),
        ("dramatiq app.actors", "worker"),
        ("python -m mini_mcp.server", "stdio-server"),
        ("vite", "frontend-dev-server"),
        ("next dev", "frontend-dev-server"),
        ("python scripts/migrate.py", "cli"),
    ],
)
def test_classify_run_command(command: str, kind: str) -> None:
    assert _classify_run_command(command) == kind


# ── Procfile process types ────────────────────────────────────────


def test_procfile_process_types_are_mined_with_kinds() -> None:
    mined = _by_name(_discover_declared_runnables(FIXTURE))
    web = next(r for r in mined["web"] if r.source == "Procfile")
    worker = next(r for r in mined["worker"] if r.source == "Procfile")
    clock = next(r for r in mined["clock"] if r.source == "Procfile")
    assert web.kind == "http-service"
    assert "uvicorn" in web.command
    assert worker.kind == "worker"
    assert clock.kind == "scheduler"


# ── docker-compose: app → host candidate, db → infra ──────────────


def test_compose_app_and_db_are_split_host_vs_infra() -> None:
    mined = _by_name(_discover_declared_runnables(FIXTURE))
    compose_app = next(r for r in mined["app"] if r.source == "docker-compose.yml")
    compose_db = next(r for r in mined["db"] if r.source == "docker-compose.yml")
    assert compose_app.kind == "http-service"  # build: + uvicorn command → host app
    assert compose_db.kind == "infra"          # postgres image → Docker infra
    assert compose_db.command == "docker compose up -d db"


# ── package.json run scripts (frontend dev server) ────────────────


def test_frontend_dev_server_script_is_mined() -> None:
    mined = _by_name(_discover_declared_runnables(FIXTURE))
    (dev,) = mined["mini-webapp:dev"]
    assert dev.kind == "frontend-dev-server"
    assert dev.source == "webapp/package.json:scripts.dev"
    # Build-shaped scripts are chores, not runnables.
    assert "mini-webapp:build" not in mined


# ── Console scripts across nested workspace members ───────────────


def test_console_scripts_of_nested_members_are_mined() -> None:
    mined = _by_name(_discover_declared_runnables(FIXTURE))
    (member,) = mined["member-serve"]
    assert member.kind == "cli"  # prior only; entry code decides the real kind
    assert member.source.startswith("packages/member_svc/pyproject.toml")
    (mcp,) = mined["mini-mcp"]
    assert mcp.source.startswith("mcp_server/pyproject.toml")


# ── Nested workspace members are distributions of their own ───────


def test_nested_workspace_members_are_discovered_as_distributions() -> None:
    dists = {d.name: d.packages for d in _discover_distributions(FIXTURE)}
    assert dists["member-svc"] == ("member_svc",)
    assert dists["mini-mcp"] == ("mini_mcp",)
    assert "mini-root" in dists  # the workspace root itself


# ── The Stage 2a prompt carries the declared-runnables cross-check ─


def test_list_instruction_renders_declared_runnables_note() -> None:
    prompt = list_instruction(FIXTURE)
    assert "Procfile" in prompt
    assert "frontend-dev-server" in prompt
    assert "docker-compose.yml" in prompt
    assert "member-serve" in prompt
    # Every declared runnable must be accounted for — the cross-check contract.
    assert "must be accounted for" in prompt
    # The stdio taxonomy reached the prompt.
    assert "python_stdio" in prompt


def test_mining_is_deterministic() -> None:
    a = _discover_declared_runnables(FIXTURE)
    b = _discover_declared_runnables(FIXTURE)
    assert a == b
