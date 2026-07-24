"""Discovery of stdlib-HTTP services and test-fixture flagging.

Covers the two dogfooding gaps: ``http.server``-based services (like the
embedder) were invisible to ``consolidate``, and test-fixture routes polluted
the inventory unflagged.
"""

from __future__ import annotations

import json
from pathlib import Path

from test_index_store import _chunk, _write_index

from identification.runner import list_service_apis

# Mirrors the embedder's shape: ThreadingHTTPServer + BaseHTTPRequestHandler
# with do_* verb methods dispatching on self.path (literal ==, startswith,
# and membership in a module-level tuple constant).
_STDLIB_SERVER = '''\
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EMBED_PATHS = ("/v1/embeddings", "/embeddings")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            pass
        elif self.path.startswith("/static"):
            pass

    def do_POST(self):
        if self.path not in EMBED_PATHS:
            return

    def do_DELETE(self):
        pass


def make_server(port, engine):
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)
'''


def _stdlib_repo(tmp_path: Path) -> None:
    (tmp_path / "server.py").write_text(_STDLIB_SERVER, encoding="utf-8")
    _write_index(
        tmp_path,
        [
            _chunk("server.py:6-18:Handler", "server.py", "Handler", 6, 18, kind="class"),
            _chunk("server.py:7-11:do_GET", "server.py", "do_GET", 7, 11, kind="method"),
            _chunk("server.py:13-15:do_POST", "server.py", "do_POST", 13, 15, kind="method"),
            _chunk("server.py:17-18:do_DELETE", "server.py", "do_DELETE", 17, 18, kind="method"),
            _chunk("server.py:21-22:make_server", "server.py", "make_server", 21, 22),
        ],
        [],
    )


def test_stdlib_http_handler_verbs_and_paths_are_discovered(tmp_path: Path) -> None:
    _stdlib_repo(tmp_path)

    result = list_service_apis(tmp_path)

    routes = {(a["method"], a["path"]): a for a in result["apis"]}
    assert set(routes) == {
        ("GET", "/health"),        # self.path == "/health"
        ("GET", "/static"),        # self.path.startswith("/static")
        ("POST", "/v1/embeddings"),  # self.path not in EMBED_PATHS (constant)
        ("POST", "/embeddings"),
        ("DELETE", "/"),           # no dispatch → root path, not dropped
    }
    for (method, _), api in routes.items():
        assert api["framework"] == "http.server"
        assert api["handler"] == f"do_{method}"
        assert api["is_test"] is False
    assert routes[("GET", "/health")]["line"] == 7, "attributed to the do_GET def"
    assert result["summary"] == {"apis": 5, "test_apis": 0}


def test_stdlib_server_construction_marks_a_service_root(tmp_path: Path) -> None:
    _stdlib_repo(tmp_path)

    result = list_service_apis(tmp_path)

    roots = [e for e in result["entrypoints"] if e["kind"] == "service_root"]
    assert len(roots) == 1
    (root,) = roots
    assert root["trigger"] == "ThreadingHTTPServer"
    assert root["framework"] == "http.server"
    assert root["handler"] == "make_server"
    assert root["id"] == "SVC_server"
    # do_* routes also appear in the unified entry-point view as http_api.
    assert {
        e["trigger"] for e in result["entrypoints"] if e["kind"] == "http_api"
    } >= {"GET /health", "POST /v1/embeddings", "DELETE /"}


def test_wsgiref_and_socketserver_services_are_discovered(tmp_path: Path) -> None:
    (tmp_path / "wsgi_app.py").write_text(
        "from wsgiref.simple_server import make_server\n"
        "def main():\n"
        '    srv = make_server("", 8000, app)\n'
        "    srv.serve_forever()\n",
        encoding="utf-8",
    )
    (tmp_path / "echo.py").write_text(
        "import socketserver\n"
        "\n"
        "class EchoHandler(socketserver.StreamRequestHandler):\n"
        "    def handle(self):\n"
        "        pass\n"
        "\n"
        'server = socketserver.TCPServer(("127.0.0.1", 9000), EchoHandler)\n',
        encoding="utf-8",
    )
    _write_index(
        tmp_path,
        [
            _chunk("wsgi_app.py:2-4:main", "wsgi_app.py", "main", 2, 4),
            _chunk("echo.py:3-5:EchoHandler", "echo.py", "EchoHandler", 3, 5, kind="class"),
            _chunk("echo.py:4-5:handle", "echo.py", "handle", 4, 5, kind="method"),
        ],
        [],
    )

    result = list_service_apis(tmp_path)

    by_kind = {}
    for e in result["entrypoints"]:
        by_kind.setdefault(e["kind"], []).append(e)
    wsgi_root = next(r for r in by_kind["service_root"] if r["file"] == "wsgi_app.py")
    assert wsgi_root["trigger"] == "make_server"
    assert wsgi_root["framework"] == "wsgiref"
    tcp_root = next(r for r in by_kind["service_root"] if r["file"] == "echo.py")
    assert tcp_root["trigger"] == "TCPServer"
    assert tcp_root["framework"] == "socketserver"
    (sock,) = by_kind["socket_handler"]
    assert sock["trigger"] == "EchoHandler"
    assert sock["handler"] == "handle"
    # No do_* handler anywhere: nothing was invented as an HTTP route.
    assert result["apis"] == []


def test_plain_class_without_handler_base_is_not_a_service(tmp_path: Path) -> None:
    # Abstain-not-guess: a do_GET-looking method on a non-handler class, and a
    # class merely named like a server, must not be reported.
    (tmp_path / "notaserver.py").write_text(
        "class Client:\n"
        "    def do_GET(self):\n"
        "        pass\n",
        encoding="utf-8",
    )
    _write_index(
        tmp_path,
        [_chunk("notaserver.py:2-3:do_GET", "notaserver.py", "do_GET", 2, 3, kind="method")],
        [],
    )

    result = list_service_apis(tmp_path)

    assert result["apis"] == []
    assert all(e["kind"] not in ("service_root", "socket_handler")
               for e in result["entrypoints"])


def test_fixture_routes_are_flagged_and_sorted_after_production(tmp_path: Path) -> None:
    (tmp_path / "app").mkdir()
    (tmp_path / "app" / "api.py").write_text(
        '@app.get("/real")\ndef real():\n    pass\n', encoding="utf-8",
    )
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_api.py").write_text(
        '@app.get("/from_a_test")\ndef fixture_route():\n    pass\n', encoding="utf-8",
    )
    (tmp_path / "demo_app").mkdir()
    (tmp_path / "demo_app" / "main.py").write_text(
        '@app.get("/demo")\ndef demo():\n    pass\n', encoding="utf-8",
    )
    # A directory only known to be tests via pytest testpaths config.
    (tmp_path / "pyproject.toml").write_text(
        '[tool.pytest.ini_options]\ntestpaths = ["checks"]\n', encoding="utf-8",
    )
    (tmp_path / "checks").mkdir()
    (tmp_path / "checks" / "routes.py").write_text(
        '@app.get("/checked")\ndef checked():\n    pass\n', encoding="utf-8",
    )
    _write_index(
        tmp_path,
        [
            _chunk("app/api.py:2-3:real", "app/api.py", "real", 2, 3),
            _chunk("tests/test_api.py:2-3:fixture_route", "tests/test_api.py",
                   "fixture_route", 2, 3),
            _chunk("demo_app/main.py:2-3:demo", "demo_app/main.py", "demo", 2, 3),
            _chunk("checks/routes.py:2-3:checked", "checks/routes.py", "checked", 2, 3),
        ],
        [],
    )

    result = list_service_apis(tmp_path)

    flags = [(a["path"], a["is_test"]) for a in result["apis"]]
    assert flags == [
        ("/real", False),        # the one production route leads
        ("/checked", True),      # via pytest testpaths
        ("/demo", True),         # demo_app segment
        ("/from_a_test", True),  # tests/ segment + test_ filename
    ]
    assert result["summary"] == {"apis": 4, "test_apis": 3}
    # The flag also rides along on the unified entry-point view.
    http_eps = [e for e in result["entrypoints"] if e["kind"] == "http_api"]
    assert [(e["path"], e["is_test"]) for e in http_eps] == flags
    # apis.json on disk carries the same additive fields.
    written = json.loads(
        (tmp_path / ".vinv" / "identification" / "apis.json").read_text(encoding="utf-8")
    )
    assert written["summary"] == {"apis": 4, "test_apis": 3}
    assert [a["is_test"] for a in written["apis"]] == [False, True, True, True]


def test_mcp_stdio_servers_are_discovered_python_and_js(tmp_path: Path) -> None:
    # Python: FastMCP construction + the low-level stdio transport.
    (tmp_path / "srv.py").write_text(
        "from mcp.server.fastmcp import FastMCP\n"
        "\n"
        'mcp = FastMCP("mini-mcp")\n'
        "\n"
        "def main():\n"
        '    mcp.run(transport="stdio")\n',
        encoding="utf-8",
    )
    (tmp_path / "lowlevel.py").write_text(
        "from mcp.server.stdio import stdio_server\n"
        "\n"
        "async def serve():\n"
        "    async with stdio_server() as (r, w):\n"
        "        pass\n",
        encoding="utf-8",
    )
    # JS: StdioServerTransport from @modelcontextprotocol/sdk.
    (tmp_path / "srv.ts").write_text(
        'import { StdioServerTransport } from "@modelcontextprotocol/sdk";\n'
        "const transport = new StdioServerTransport();\n",
        encoding="utf-8",
    )
    _write_index(
        tmp_path,
        [
            _chunk("srv.py:5-6:main", "srv.py", "main", 5, 6),
            _chunk("lowlevel.py:3-5:serve", "lowlevel.py", "serve", 3, 5),
            _chunk("srv.ts:1-2:transport", "srv.ts", "transport", 1, 2, lang="typescript"),
        ],
        [],
    )

    result = list_service_apis(tmp_path)

    stdio = [e for e in result["entrypoints"] if e["kind"] == "stdio_server"]
    by_file = {e["file"]: e for e in stdio}
    assert set(by_file) == {"srv.py", "lowlevel.py", "srv.ts"}
    assert by_file["srv.py"]["trigger"] == "mini-mcp"  # FastMCP("mini-mcp")
    assert by_file["lowlevel.py"]["trigger"] == "stdio_server"
    assert by_file["srv.ts"]["trigger"] == "StdioServerTransport"
    for e in stdio:
        assert e["framework"] == "mcp"
        assert e["service_kind"] == "stdio-server"
        assert e["id"].startswith("STDIO_")
    assert result["service_kinds"]["stdio-server"] == 3
    # No HTTP route was invented for a port-less server.
    assert result["apis"] == []


def test_handrolled_stdio_jsonrpc_loops_are_discovered(tmp_path: Path) -> None:
    # SDK-less MCP servers (like the extension's index/runtime servers): a
    # stdin read loop in a file that also speaks the "jsonrpc" protocol tag.
    (tmp_path / "srv.ts").write_text(
        "interface JsonRpcRequest { jsonrpc: '2.0'; method: string; }\n"
        "function send(m: object) { process.stdout.write(JSON.stringify(m)); }\n"
        "process.stdin.setEncoding('utf8');\n"
        "process.stdin.on('data', (chunk: string) => { handle(chunk); });\n",
        encoding="utf-8",
    )
    (tmp_path / "pysrv.py").write_text(
        "import sys, json\n"
        "for line in sys.stdin:\n"
        "    req = json.loads(line)\n"
        '    print(json.dumps({"jsonrpc": "2.0", "id": req.get("id"), "result": {}}))\n',
        encoding="utf-8",
    )
    # Reads stdin but speaks no jsonrpc: NOT a stdio server (conjunction gate).
    (tmp_path / "filter.py").write_text(
        "import sys\n"
        "for line in sys.stdin:\n"
        "    print(line.upper())\n",
        encoding="utf-8",
    )
    _write_index(
        tmp_path,
        [
            _chunk("srv.ts:2-2:send", "srv.ts", "send", 2, 2, lang="typescript"),
            _chunk("pysrv.py:1-4:module", "pysrv.py", "module", 1, 4),
            _chunk("filter.py:1-3:module", "filter.py", "module", 1, 3),
        ],
        [],
    )

    result = list_service_apis(tmp_path)

    stdio = {e["file"]: e for e in result["entrypoints"] if e["kind"] == "stdio_server"}
    assert set(stdio) == {"srv.ts", "pysrv.py"}
    assert stdio["srv.ts"]["framework"] == "jsonrpc-stdio"
    assert stdio["srv.ts"]["trigger"] == "process.stdin"
    assert stdio["pysrv.py"]["framework"] == "jsonrpc-stdio"
    assert stdio["pysrv.py"]["service_kind"] == "stdio-server"


def test_service_kind_taxonomy_covers_every_entry_kind(tmp_path: Path) -> None:
    (tmp_path / "api.py").write_text(
        '@app.get("/x")\ndef x():\n    pass\n', encoding="utf-8",
    )
    (tmp_path / "jobs.py").write_text(
        "@shared_task\ndef crunch():\n    pass\n"
        "\n"
        '@scheduler.scheduled_job("cron")\ndef nightly():\n    pass\n',
        encoding="utf-8",
    )
    (tmp_path / "cmd.py").write_text(
        '@cli.command("deploy")\ndef deploy():\n    pass\n'
        "\n"
        'if __name__ == "__main__":\n    deploy()\n',
        encoding="utf-8",
    )
    _write_index(
        tmp_path,
        [
            _chunk("api.py:2-3:x", "api.py", "x", 2, 3),
            _chunk("jobs.py:2-3:crunch", "jobs.py", "crunch", 2, 3),
            _chunk("jobs.py:5-6:nightly", "jobs.py", "nightly", 5, 6),
            _chunk("cmd.py:2-3:deploy", "cmd.py", "deploy", 2, 3),
        ],
        [],
    )

    result = list_service_apis(tmp_path)

    kinds = {e["kind"]: e["service_kind"] for e in result["entrypoints"]}
    assert kinds["http_api"] == "http-service"
    assert kinds["background_task"] == "worker"
    assert kinds["scheduled_task"] == "scheduler"
    assert kinds["cli_command"] == "cli"
    assert kinds["script_main"] == "cli"
    # Every entry point carries the additive field; the summary counts agree.
    assert all("service_kind" in e for e in result["entrypoints"])
    assert sum(result["service_kinds"].values()) == result["entrypoint_count"]


def test_stdlib_service_root_maps_to_http_service_and_socket_to_worker(
    tmp_path: Path,
) -> None:
    _stdlib_repo(tmp_path)  # http.server fixture from above
    result = list_service_apis(tmp_path)
    (root,) = [e for e in result["entrypoints"] if e["kind"] == "service_root"]
    assert root["service_kind"] == "http-service"

    # A bare socketserver repo maps its root and handler to `worker`.
    sock_repo = tmp_path / "sockrepo"
    sock_repo.mkdir()
    (sock_repo / "echo.py").write_text(
        "import socketserver\n"
        "\n"
        "class EchoHandler(socketserver.StreamRequestHandler):\n"
        "    def handle(self):\n"
        "        pass\n"
        "\n"
        'server = socketserver.TCPServer(("127.0.0.1", 9000), EchoHandler)\n',
        encoding="utf-8",
    )
    _write_index(
        sock_repo,
        [
            _chunk("echo.py:3-5:EchoHandler", "echo.py", "EchoHandler", 3, 5, kind="class"),
            _chunk("echo.py:4-5:handle", "echo.py", "handle", 4, 5, kind="method"),
        ],
        [],
    )
    sock_result = list_service_apis(sock_repo)
    sock_kinds = {e["kind"]: e["service_kind"] for e in sock_result["entrypoints"]}
    assert sock_kinds["service_root"] == "worker"
    assert sock_kinds["socket_handler"] == "worker"


def test_production_declaration_wins_route_attribution_over_fixture(
    tmp_path: Path,
) -> None:
    # The fixture file sorts first, so it is scanned first — the production
    # declaration of the same route must still take over the attribution.
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "fixture.py").write_text(
        '@app.get("/dup")\ndef fake():\n    pass\n', encoding="utf-8",
    )
    (tmp_path / "zapp").mkdir()
    (tmp_path / "zapp" / "api.py").write_text(
        '@app.get("/dup")\ndef dup():\n    pass\n', encoding="utf-8",
    )
    _write_index(
        tmp_path,
        [
            _chunk("tests/fixture.py:2-3:fake", "tests/fixture.py", "fake", 2, 3),
            _chunk("zapp/api.py:2-3:dup", "zapp/api.py", "dup", 2, 3),
        ],
        [],
    )

    result = list_service_apis(tmp_path)

    (api,) = result["apis"]
    assert api["file"] == "zapp/api.py"
    assert api["handler"] == "dup"
    assert api["is_test"] is False
    assert result["summary"] == {"apis": 1, "test_apis": 0}


_SCRIPT_MAIN = '''\
import logging

logger = logging.getLogger(__name__)

def init() -> None:
    logger.info("seeding")

def main() -> None:
    logger.info("start")
    init()

if __name__ == "__main__":
    main()
'''

_SCRIPT_MAIN_EXTERNAL_ONLY = '''\
import uvicorn

if __name__ == "__main__":
    uvicorn.run("app:app", port=8000)
'''

_SCRIPT_MAIN_RUNNER_REF = '''\
import typer

def cli() -> None:
    pass

if __name__ == "__main__":
    typer.run(cli)
'''


def test_script_main_resolves_guard_called_handler(tmp_path: Path) -> None:
    """A __main__ guard that calls a same-file function roots the tree there.

    Regression: MAIN_* entries carried handler=None, so build_call_tree raised
    'no resolved handler symbol' and the webview rendered a red error for
    every operational script (initial_data, backend_pre_start, ...).
    """
    (tmp_path / "seed.py").write_text(_SCRIPT_MAIN, encoding="utf-8")
    (tmp_path / "tool.py").write_text(_SCRIPT_MAIN_RUNNER_REF, encoding="utf-8")
    _write_index(
        tmp_path,
        [
            _chunk("seed.py:5-6:init", "seed.py", "init", 5, 6),
            _chunk("seed.py:8-11:main", "seed.py", "main", 8, 11),
            _chunk("tool.py:3-4:cli", "tool.py", "cli", 3, 4),
        ],
        [],
    )
    result = list_service_apis(tmp_path)
    mains = {e["file"]: e for e in result["entrypoints"] if e["kind"] == "script_main"}
    assert mains["seed.py"]["handler"] == "main"
    # A runner reference (typer.run(cli)) resolves the bare function name.
    assert mains["tool.py"]["handler"] == "cli"


def test_external_only_guard_has_no_handler() -> None:
    """A guard that only calls library code resolves no handler — the call
    tree builder returns a degraded document for these instead of raising."""
    from identification.runner import _main_guard_handler
    guard_line = _SCRIPT_MAIN_EXTERNAL_ONLY.splitlines().index(
        'if __name__ == "__main__":') + 1
    assert _main_guard_handler(
        _SCRIPT_MAIN_EXTERNAL_ONLY, guard_line, [{"name": "unrelated"}]
    ) is None
