"""Declarative route tables, argparse CLIs, and the zero-endpoint diagnostic.

Covers the smolagents-shaped blind spot: a plain Starlette app assembled from a
literal ``routes=[Route(...)]`` list declares real HTTP endpoints and zero
decorators, so the regex passes see nothing — and the old behavior was a
SILENT empty inventory that looked exactly like a clean run.
"""

from __future__ import annotations

from pathlib import Path

from test_index_store import _chunk, _write_index

from identification.runner import _py_declarative_routes, list_service_apis

# Mirrors smolagents/examples/server/main.py — the repo the gap analysis was
# run against: declarative Starlette, no decorators, no /openapi.json.
_STARLETTE_APP = """\
from starlette.applications import Starlette
from starlette.routing import Route, WebSocketRoute


async def homepage(request):
    ...


async def chat(request):
    ...


async def live(websocket):
    ...


app = Starlette(
    debug=True,
    routes=[
        Route("/", homepage),
        Route("/chat", chat, methods=["POST"]),
        WebSocketRoute("/live", live),
    ],
)
"""


def _starlette_repo(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text(_STARLETTE_APP, encoding="utf-8")
    _write_index(
        tmp_path,
        [
            _chunk("main.py:5-6:homepage", "main.py", "homepage", 5, 6),
            _chunk("main.py:9-10:chat", "main.py", "chat", 9, 10),
            _chunk("main.py:13-14:live", "main.py", "live", 13, 14),
        ],
        [],
    )


def test_declarative_starlette_routes_are_discovered(tmp_path: Path) -> None:
    _starlette_repo(tmp_path)

    result = list_service_apis(tmp_path)

    routes = {(a["method"], a["path"]): a for a in result["apis"]}
    assert ("GET", "/") in routes, "Route('/', homepage) defaults to GET"
    assert ("POST", "/chat") in routes
    assert ("WEBSOCKET", "/live") in routes
    # The declaration names its endpoint — no adjacency guessing.
    assert routes[("GET", "/")]["handler"] == "homepage"
    assert routes[("POST", "/chat")]["handler"] == "chat"
    assert routes[("WEBSOCKET", "/live")]["handler"] == "live"
    assert routes[("POST", "/chat")]["framework"] == "starlette"
    assert result["diagnostics"] == [], "a discovered surface raises no alarm"


def test_mounts_compose_prefixes_through_variables_and_concatenation() -> None:
    text = """\
from starlette.applications import Starlette
from starlette.routing import Mount, Route

api_routes = [
    Route("/users", list_users),
    Route("/users/{id}", get_user, methods=["GET", "DELETE"]),
]

extra = [Route("/ping", ping)]

app = Starlette(routes=[
    Mount("/api", routes=api_routes + extra),
    Mount("/admin", app=Starlette(routes=[Route("/stats", stats)])),
    Route("/", home),
])
"""
    found = {(m, p): h for m, p, _, _, h in _py_declarative_routes(text)}
    assert found == {
        ("GET", "/api/users"): "list_users",
        ("GET", "/api/users/{id}"): "get_user",
        ("DELETE", "/api/users/{id}"): "get_user",
        ("GET", "/api/ping"): "ping",
        ("GET", "/admin/stats"): "stats",
        ("GET", "/"): "home",
    }


def test_routes_outside_any_constructor_still_count_once() -> None:
    text = """\
import starlette
from starlette.routing import Route

app.routes.append(Route("/late", late_handler, methods=["PUT"]))
"""
    found = [(m, p, h) for m, p, _, _, h in _py_declarative_routes(text)]
    assert found == [("PUT", "/late", "late_handler")]


def test_framework_gate_blocks_homonym_route_classes() -> None:
    # A repo-local class named Route must not mint phantom endpoints when the
    # file never mentions starlette/fastapi.
    text = 'routes = [Route("/not-http", thing)]\n'
    assert _py_declarative_routes(text) == []


def test_aiohttp_and_tornado_tables_are_discovered() -> None:
    aio = """\
from aiohttp import web

app = web.Application()
app.router.add_get("/health", health)
app.add_routes([web.post("/jobs", submit_job)])
"""
    found = {(m, p): h for m, p, _, _, h in _py_declarative_routes(aio)}
    assert found == {("GET", "/health"): "health", ("POST", "/jobs"): "submit_job"}

    tornado = """\
import tornado.web

def make_app():
    return tornado.web.Application([
        (r"/", MainHandler),
        (r"/items/([0-9]+)", ItemHandler),
    ])
"""
    found = {(m, p): h for m, p, _, _, h in _py_declarative_routes(tornado)}
    assert found == {
        ("*", "/"): "MainHandler",
        ("*", "/items/([0-9]+)"): "ItemHandler",
    }


def test_argparse_clis_are_catalogued(tmp_path: Path) -> None:
    (tmp_path / "tool.py").write_text(
        """\
import argparse


def main():
    parser = argparse.ArgumentParser(prog="mytool")
    sub = parser.add_subparsers()
    sub.add_parser("serve")
    sub.add_parser("migrate")
    args = parser.parse_args()
""",
        encoding="utf-8",
    )
    _write_index(
        tmp_path,
        [_chunk("tool.py:4-9:main", "tool.py", "main", 4, 9)],
        [],
    )

    result = list_service_apis(tmp_path)

    clis = [
        e
        for e in result["entrypoints"]
        if e["kind"] == "cli_command" and e["framework"] == "argparse"
    ]
    triggers = sorted(e["trigger"] for e in clis)
    assert triggers == ["migrate", "mytool", "serve"]


def test_zero_endpoint_inventory_is_loudly_diagnosed(tmp_path: Path) -> None:
    # A repo with source but no discoverable entry points of any kind.
    (tmp_path / "lib.py").write_text(
        "def add(a, b):\n    return a + b\n",
        encoding="utf-8",
    )
    _write_index(
        tmp_path,
        [_chunk("lib.py:1-2:add", "lib.py", "add", 1, 2)],
        [],
    )

    result = list_service_apis(tmp_path)

    assert result["api_count"] == 0
    assert len(result["diagnostics"]) == 1
    assert "0 endpoints discovered" in result["diagnostics"][0]


def test_http_empty_but_entrypoints_present_points_at_the_harness(
    tmp_path: Path,
) -> None:
    (tmp_path / "job.py").write_text(
        'if __name__ == "__main__":\n    run()\n',
        encoding="utf-8",
    )
    _write_index(
        tmp_path,
        [_chunk("job.py:1-2:run", "job.py", "run", 1, 2)],
        [],
    )

    result = list_service_apis(tmp_path)

    assert result["api_count"] == 0
    assert result["entrypoint_count"] >= 1
    (msg,) = result["diagnostics"]
    assert "0 HTTP endpoints discovered" in msg
    assert "script_main" in msg


# ---------------------------------------------------------------------------
# Audit COR-6/7/8/9 — prefixes, resolvable methods, and unreadable paths.
# ---------------------------------------------------------------------------


def _routes(text: str) -> set[tuple[str, str]]:
    return {(m, p) for m, p, _, _, _ in _py_declarative_routes(text)}


_MOUNT_SUB_FIRST = """\
from starlette.applications import Starlette
from starlette.routing import Mount, Route


async def things(request): ...


sub = Starlette(routes=[Route("/things", things, methods=["POST"])])
app = Starlette(routes=[Mount("/api", app=sub)])
"""

_MOUNT_SUB_AFTER = """\
from starlette.applications import Starlette
from starlette.routing import Mount, Route


async def things(request): ...


app = Starlette(routes=[Mount("/api", app=sub)])
sub = Starlette(routes=[Route("/things", things, methods=["POST"])])
"""

_MOUNT_INLINE = """\
from starlette.applications import Starlette
from starlette.routing import Mount, Route


async def things(request): ...


app = Starlette(
    routes=[Mount("/api", app=Starlette(routes=[Route("/things", things, methods=["POST"])]))]
)
"""


def test_a_mount_prefix_survives_however_the_sub_app_is_written():
    """COR-6: the sub-app assigned BEFORE the app used to lose its prefix.

    `ast.walk` is pre-order, so the bare `sub = Starlette(...)` constructor was
    reached first, emitted "/things" unprefixed, and added it to `consumed`;
    the later Mount then found the route consumed and returned. Writing the two
    lines in the other order produced the correct path — and assigning the
    sub-app first is the natural way to write it.
    """
    for label, src in (
        ("sub-app first", _MOUNT_SUB_FIRST),
        ("sub-app after", _MOUNT_SUB_AFTER),
        ("inline", _MOUNT_INLINE),
    ):
        assert _routes(src) == {("POST", "/api/things")}, label


def test_a_route_is_never_emitted_both_prefixed_and_bare():
    """The dedupe the `consumed` set exists for must still hold."""
    found = [(m, p) for m, p, _, _, _ in _py_declarative_routes(_MOUNT_SUB_FIRST)]
    assert len(found) == len(set(found)) == 1


_METHODS_VIA_NAME = """\
from starlette.applications import Starlette
from starlette.routing import Route


async def chat(request): ...


VERBS = ["POST", "PUT"]
app = Starlette(routes=[Route("/chat", chat, methods=VERBS)])
"""


def test_a_methods_list_held_in_a_variable_is_resolved():
    """COR-7: an unresolved `methods=` fell back to GET, so a POST-only route
    was probed with the wrong verb and simply 404'd — the endpoint was missed."""
    assert _routes(_METHODS_VIA_NAME) == {("POST", "/chat"), ("PUT", "/chat")}


_METHODS_UNRESOLVABLE = """\
from starlette.applications import Starlette
from starlette.routing import Route


async def chat(request): ...


app = Starlette(routes=[Route("/chat", chat, methods=compute_verbs())])
"""


def test_a_genuinely_unreadable_methods_expression_still_defaults_to_get():
    """Starlette's own default — the fallback must survive for the real case."""
    assert _routes(_METHODS_UNRESOLVABLE) == {("GET", "/chat")}


_ROUTER_PREFIX = """\
from fastapi import APIRouter
from starlette.routing import Route


async def listing(request): ...


router = APIRouter(prefix="/v1/swarms", routes=[Route("/list", listing)])
"""


def test_an_api_router_prefix_is_applied():
    """COR-8: only Mount handled a prefix, so declarative routers published
    their paths unprefixed — while the regex path DID handle the decorator
    style, so a grep looked satisfied and the two paths disagreed."""
    assert _routes(_ROUTER_PREFIX) == {("GET", "/v1/swarms/list")}


_FSTRING_PATH = """\
from starlette.applications import Starlette
from starlette.routing import Route


async def h(request): ...


prefix = "v1"
app = Starlette(routes=[Route(f"/{prefix}/x", h)])
"""


def test_a_non_literal_path_is_reported_not_silently_dropped(caplog):
    """COR-9: one early `return` served both 'not a route' and 'a route I
    cannot read', so unresolvable routes shrank the denominator invisibly —
    and plan.py's empty-plan diagnostic only fires at ZERO endpoints."""
    import logging

    with caplog.at_level(logging.WARNING):
        assert _routes(_FSTRING_PATH) == set()
    assert any("non-literal path" in r.message for r in caplog.records)
