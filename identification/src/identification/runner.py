"""Deterministic entry-point analysis over the Vinv code index.

Reads the Rust JSON index (``<repo>/.vinv/index``); vectors and embeddings are
never loaded.

``list_service_apis`` (``consolidate``)
    Enumerate every ENTRY POINT a service exposes — HTTP routes, CLI commands,
    background/queue workers, scheduled jobs, event/lifecycle hooks and bare
    ``__main__`` script entries — straight from the indexed source files,
    attributing each to its enclosing handler symbol.  Writes an inventory to
    ``<repo>/.vinv/identification/apis.json``.

``build_api_call_tree`` (``calltree``)
    Build the static call tree rooted at one entry point's handler by walking the
    index's precomputed invoke graph, resolving targets back to indexed symbols
    and recursing. Writes ``<repo>/.vinv/identification/<id>.calltree.json``.

Both are fully deterministic: the same index yields the same output every run.
"""

from __future__ import annotations

import ast
import json
import logging
import re
import tomllib
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from identification.store import open_identification_store

# Method names ubiquitous in the Python/JS standard libraries and common
# frameworks (``session.get``, ``"…".format``, ``items.append``, ``res.json``).
# A receiver call on one of these is a library call until proven otherwise, so
# ``resolve_target`` lets it resolve via a module-stem or same-file match but
# never by name uniqueness alone.  Mirror of ``is_ubiquitous`` in
# ``index/src/graph.rs`` — keep in sync.
_UBIQUITOUS_METHODS = frozenset(
    """
    get set add pop clear copy update remove format append extend insert sort
    reverse index count keys values items split rsplit join strip lstrip rstrip
    lower upper title replace startswith endswith encode decode read write
    close flush seek tell open exists mkdir unlink rename resolve glob stat
    commit rollback execute fetchone fetchall scalar scalars first one merge
    refresh delete filter search match group sub compile dumps loads dump load
    sleep now today utcnow strftime strptime isoformat timestamp send recv
    connect accept bind listen json text push shift unshift slice splice concat
    includes indexOf forEach map find next min max sum any all
    """.split()
)


# =========================================================================
# Source extensions
# =========================================================================

_PY_EXTS = {".py"}
_JS_EXTS = {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"}
_GO_EXTS = {".go"}
_JVM_EXTS = {".java", ".kt"}


# =========================================================================
# Route-declaration patterns (deterministic, per-language)
# =========================================================================
#
# Consolidation enumerates routes straight from the SOURCE using regexes over the
# indexed source files. Each pattern captures a route DECLARATION; the
# framework tag records which matched.

# Python — FastAPI/Starlette/APIRouter and Flask/Blueprint method decorators:
#   @app.get("/x")  @router.post("/x", ...)
_RE_PY_METHOD_DECORATOR = re.compile(
    r"""@\s*([\w.]+)\.(get|post|put|patch|delete|head|options|trace)\(\s*"""
    r"""["']([^"']*)["']""",
    re.IGNORECASE,
)
# Flask-style: @app.route("/x", methods=["GET", "POST"])  (default GET)
_RE_PY_ROUTE_DECORATOR = re.compile(
    r"""@\s*([\w.]+)\.route\(\s*["']([^"']*)["']([^)]*)""",
)
# FastAPI add_api_route / Starlette add_route with an explicit methods list.
_RE_PY_ADD_ROUTE = re.compile(
    r"""([\w.]+)\.add_(?:api_)?route\(\s*["']([^"']*)["'][^)]*?"""
    r"""methods\s*=\s*\[([^\]]*)\]""",
    re.DOTALL,
)
# Router/Blueprint construction carrying a mount prefix, e.g.
#   router = APIRouter(prefix="/v1/swarms", tags=[...])
#   bp = Blueprint("x", __name__, url_prefix="/api")
# FastAPI applies this prefix to every route declared on the variable, so the
# real runtime path is `<prefix><declared path>`.  Resolved within the file.
_RE_PY_ROUTER_CTOR = re.compile(
    r"""^\s*([A-Za-z_]\w*)\s*=\s*[\w.]*?(?:APIRouter|Router|Blueprint)\(([^)]*)\)""",
    re.MULTILINE,
)
_RE_PY_PREFIX_KW = re.compile(r"""(?:url_prefix|prefix)\s*=\s*["']([^"']*)["']""")
# `from a.b.c import router as swarms_router, internal_router` — used to resolve
# an include_router(<alias>, prefix=...) call back to the (module, var) whose
# routes the mount prefix actually applies to.
_RE_PY_FROM_IMPORT = re.compile(
    r"""^\s*from\s+([\w.]+)\s+import\s+(.+?)\s*$""",
    re.MULTILINE,
)
_RE_PY_IMPORT_NAME = re.compile(r"""\b(\w+)\b(?:\s+as\s+(\w+))?""")
# app.include_router(swarms_router, prefix="/api", dependencies=...)
# Captures the mounted router variable and the (optional) mount-time prefix.
_RE_PY_INCLUDE_ROUTER = re.compile(
    r"""include_router\(\s*([\w.]+)\b([^)]*)\)""",
    re.DOTALL,
)
# Django URLconf: path("x/", view), re_path(r"^x$", view), url(r"^x$", view).
_RE_PY_DJANGO = re.compile(
    r"""\b(?:path|re_path|url)\(\s*[rR]?["']([^"']*)["']""",
)
_RE_METHODS_LIST = re.compile(r"""["']([A-Za-z]+)["']""")

# JS/TS — Express/Koa/Fastify/Hapi imperative routes (path must start with '/'
# to keep `.get(` off Map/cache/localStorage lookups).
_RE_JS_METHOD_CALL = re.compile(
    r"""\.(get|post|put|patch|delete|head|options|all)\(\s*""" r"""[`"'](/[^`"']*)[`"']""",
    re.IGNORECASE,
)
# NestJS controller decorators: @Get("x")  @Post()  @Delete(":id")
_RE_TS_NEST_DECORATOR = re.compile(
    r"""@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*[`"']?([^`"')]*)[`"']?\s*\)""",
)

# Go — gin/echo/chi/net-http (path must start with '/').
_RE_GO_METHOD = re.compile(
    r"""\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|HandleFunc|Handle)\(\s*"""
    r"""["`](/[^"`]*)["`]""",
)

# Java/Kotlin — Spring annotations.
_RE_SPRING = re.compile(
    r"""@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*"""
    r"""(?:value\s*=\s*|path\s*=\s*)?["']([^"']+)["']""",
)


# =========================================================================
# Declarative route tables (AST, Python)
# =========================================================================
#
# Regexes cover DECORATOR-shaped registration; frameworks that build their app
# from a literal routing TABLE never match them.  Plain Starlette is the
# canonical case —
#   app = Starlette(routes=[Route("/", homepage), Route("/chat", chat,
#   methods=["POST"])])
# declares two endpoints and zero decorators, and (unlike FastAPI) serves no
# ``/openapi.json`` to fall back on.  These are extracted with the ``ast``
# module instead: deterministic, whitespace-immune, and able to resolve the
# endpoint FUNCTION (``Route``'s second argument) directly rather than
# guessing the handler from adjacency.  Covered forms:
#
# * ``Route("/x", handler, methods=[...])`` / ``WebSocketRoute`` — inline in a
#   ``routes=[...]`` kwarg of ``Starlette``/``FastAPI``/``APIRouter``, in a
#   list/tuple assigned to a module variable (including ``+`` concatenation
#   and ``*splat``), or anywhere else in the file (``app.routes.append``).
# * ``Mount("/prefix", routes=[...])`` and ``Mount("/prefix", app=subapp)``
#   where ``subapp`` is a same-file ``Starlette(routes=...)`` — the mount
#   prefix is joined onto every nested path, recursively.
# * aiohttp — ``app.router.add_get("/x", handler)`` (and add_post/…/add_route/
#   add_view) plus route-table ``web.get("/x", handler)`` entries.
# * tornado — ``Application([(r"/x", Handler), …])`` and ``URLSpec`` pairs.
#
# Each extractor is GATED on the framework's name appearing in the file text,
# so a repo-local class that happens to be called ``Route`` cannot mint
# phantom endpoints in unrelated codebases.  A file that fails ``ast.parse``
# contributes nothing (the regex passes still run over it).

_STARLETTE_ROUTE_CALLS = ("Route", "WebSocketRoute")
_STARLETTE_MOUNT_CALLS = ("Mount", "Host")
_STARLETTE_APP_CTORS = ("Starlette", "FastAPI", "APIRouter", "Router")
_AIOHTTP_ADD_METHODS = {
    "add_get": "GET",
    "add_post": "POST",
    "add_put": "PUT",
    "add_patch": "PATCH",
    "add_delete": "DELETE",
    "add_head": "HEAD",
    "add_options": "OPTIONS",
    "add_view": "*",
}
_AIOHTTP_TABLE_METHODS = {
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "options",
    "view",
}


def _ast_leaf_name(node: ast.AST | None) -> str | None:
    """Bare identifier of a Name/Attribute expression (``pkg.mod.chat`` -> ``chat``)."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _ast_const_str(node: ast.AST | None) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _py_declarative_routes(text: str) -> list[tuple[str, str, int, str, str | None]]:
    """``(method, path, line, framework, handler)`` for declarative route tables.

    Deterministic AST walk — see the section comment above for covered forms.
    ``handler`` is the endpoint function/class named in the declaration itself
    (``None`` for lambdas and unresolvable expressions, in which case the
    caller falls back to symbol adjacency).
    """
    has_starlette = "starlette" in text or "fastapi" in text
    has_aiohttp = "aiohttp" in text
    has_tornado = "tornado" in text
    if not (has_starlette or has_aiohttp or has_tornado):
        return []
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []

    out: list[tuple[str, str, int, str, str | None]] = []
    # Name -> assigned expression, for resolving `routes=table` /
    # `Mount("/p", app=subapp)` references within the file.
    assigns: dict[str, ast.expr] = {}
    for node in ast.walk(tree):
        targets: list[ast.expr] = []
        value: ast.expr | None = None
        if isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets, value = [node.target], node.value
        if value is None:
            continue
        for t in targets:
            if isinstance(t, ast.Name):
                assigns[t.id] = value

    consumed: set[int] = set()  # id() of Call nodes already emitted via a walk

    def _kw(call: ast.Call, name: str) -> ast.expr | None:
        for kw in call.keywords:
            if kw.arg == name:
                return kw.value
        return None

    def _route_handler(call: ast.Call) -> str | None:
        if len(call.args) >= 2:
            leaf = _ast_leaf_name(call.args[1])
            if leaf:
                return leaf
        return _ast_leaf_name(_kw(call, "endpoint") or _kw(call, "app"))

    def _route_methods(call: ast.Call) -> list[str]:
        methods = _kw(call, "methods")
        # A NAME is resolved through the module's assignments, exactly as
        # `routes=table` already is. Without this, `Route(p, h, methods=VERBS)`
        # fell through to the Starlette default and the endpoint was probed as
        # GET — a 404 on a POST-only route, so the endpoint was simply missed.
        # The fallback must mean "no methods declared", not "declared but
        # unreadable".
        if isinstance(methods, ast.Name):
            methods = assigns.get(methods.id, methods)
        if isinstance(methods, ast.List | ast.Tuple | ast.Set):
            got = [_ast_const_str(e) for e in methods.elts]
            named = [m.upper() for m in got if m]
            if named:
                return named
        return ["GET"]  # Starlette's default for Route(...)

    def _route_path(call: ast.Call) -> str | None:
        if call.args:
            return _ast_const_str(call.args[0])
        return _ast_const_str(_kw(call, "path"))

    def _emit_route(call: ast.Call, prefix: str) -> None:
        path = _route_path(call)
        if path is None:
            # An f-string or computed path (`Route(f"/{p}/x", ...)`) is a
            # JoinedStr, so it cannot be resolved statically. One early `return`
            # used to serve both "not a route" and "a route I cannot read",
            # which meant unresolvable routes could not even be counted: they
            # silently shrank the denominator, and plan.py's empty-plan
            # diagnostic only fires at ZERO endpoints, so partial loss was
            # invisible. Say so instead of vanishing.
            logging.getLogger(__name__).warning(
                "route at line %d has a non-literal path — it cannot be "
                "discovered statically and will not be exercised",
                call.lineno,
            )
            return
        full = _join_route(prefix, path)
        handler = _route_handler(call)
        if _ast_leaf_name(call.func) == "WebSocketRoute":
            out.append(("WEBSOCKET", full, call.lineno, "starlette", handler))
        else:
            for meth in _route_methods(call):
                out.append((meth, full, call.lineno, "starlette", handler))

    def _walk_routes(node: ast.expr | None, prefix: str, depth: int) -> None:
        """Interpret ``node`` as a routes-list expression mounted at ``prefix``."""
        if node is None or depth > 8:
            return
        if isinstance(node, ast.Name):
            _walk_routes(assigns.get(node.id), prefix, depth + 1)
        elif isinstance(node, ast.List | ast.Tuple | ast.Set):
            for elt in node.elts:
                _walk_routes(elt, prefix, depth + 1)
        elif isinstance(node, ast.Starred):
            _walk_routes(node.value, prefix, depth + 1)
        elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            _walk_routes(node.left, prefix, depth + 1)
            _walk_routes(node.right, prefix, depth + 1)
        elif isinstance(node, ast.Call):
            _handle_call(node, prefix, depth)

    def _handle_call(call: ast.Call, prefix: str, depth: int) -> None:
        leaf = _ast_leaf_name(call.func)
        if leaf in _STARLETTE_ROUTE_CALLS:
            if id(call) not in consumed:
                consumed.add(id(call))
                _emit_route(call, prefix)
        elif leaf in _STARLETTE_MOUNT_CALLS:
            if id(call) in consumed:
                return
            consumed.add(id(call))
            sub_prefix = prefix
            if leaf == "Mount":
                mount_path = _route_path(call)
                if mount_path and mount_path != "/":
                    sub_prefix = _join_route(prefix, mount_path)
            _walk_routes(_kw(call, "routes"), sub_prefix, depth + 1)
            app = _kw(call, "app")
            if app is None and len(call.args) >= 2:
                app = call.args[1]
            if isinstance(app, ast.Name):
                app = assigns.get(app.id)
            if isinstance(app, ast.Call) and _ast_leaf_name(app.func) in _STARLETTE_APP_CTORS:
                _walk_routes(_kw(app, "routes"), sub_prefix, depth + 1)
        elif leaf in _STARLETTE_APP_CTORS:
            # `APIRouter(prefix="/v1", routes=[...])` mounts its own routes under
            # that prefix. Only `Mount` handled a prefix, so every declarative
            # router published its paths unprefixed — and the regex path
            # (`_router_prefixes`) DOES handle this, but only for the decorator
            # style, so a grep for "APIRouter prefix" looked satisfied while the
            # two discovery paths disagreed ~600 lines apart.
            ctor_prefix = prefix
            own = _ast_const_str(_kw(call, "prefix"))
            if own and own != "/":
                ctor_prefix = _join_route(prefix, own)
            _walk_routes(_kw(call, "routes"), ctor_prefix, depth + 1)

    if has_starlette:
        # Pass 1a: MOUNTS first. Mounts are the only nodes that carry a prefix,
        # so they must claim their sub-app's routes before anything else can.
        #
        # Previously both kinds were swept together at prefix "". `ast.walk` is
        # pre-order, so for the natural writing order —
        #     sub = Starlette(routes=[Route("/things", ...)])
        #     app = Starlette(routes=[Mount("/api", app=sub)])
        # — the bare `sub` constructor was reached FIRST, emitted "/things"
        # unprefixed, and added it to `consumed`; the later Mount then found the
        # route already consumed and returned. Writing the two lines in the
        # other order produced the correct "/api/things". The `consumed` set
        # added to prevent duplicates was what discarded the prefix, and the
        # comment claiming the sweep is "order-independent regardless" had it
        # exactly backwards.
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and _ast_leaf_name(node.func) in _STARLETTE_MOUNT_CALLS:
                _handle_call(node, "", 0)
        # Pass 1b: app constructors whose routes no Mount already claimed.
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and id(node) not in consumed:
                if _ast_leaf_name(node.func) in _STARLETTE_APP_CTORS:
                    _handle_call(node, "", 0)
        # Pass 2: any Route not reached above (appended imperatively, or in a
        # table the ctor pass could not see) still counts, unprefixed.
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and id(node) not in consumed:
                if _ast_leaf_name(node.func) in _STARLETTE_ROUTE_CALLS:
                    _handle_call(node, "", 0)

    if has_aiohttp:
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            leaf = _ast_leaf_name(node.func)
            if leaf in _AIOHTTP_ADD_METHODS and isinstance(node.func, ast.Attribute):
                path = _route_path(node)
                handler = _ast_leaf_name(node.args[1]) if len(node.args) > 1 else None
                if path and path.startswith("/"):
                    out.append((_AIOHTTP_ADD_METHODS[leaf], path, node.lineno, "aiohttp", handler))
            elif leaf == "add_route" and isinstance(node.func, ast.Attribute):
                if len(node.args) >= 2:
                    meth = _ast_const_str(node.args[0]) or "*"
                    path = _ast_const_str(node.args[1])
                    handler = _ast_leaf_name(node.args[2]) if len(node.args) > 2 else None
                    if path and path.startswith("/"):
                        out.append((meth.upper(), path, node.lineno, "aiohttp", handler))
            elif (
                leaf in _AIOHTTP_TABLE_METHODS
                and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "web"
                and len(node.args) >= 2
            ):
                path = _ast_const_str(node.args[0])
                if path and path.startswith("/"):
                    meth = "*" if leaf == "view" else leaf.upper()
                    out.append((meth, path, node.lineno, "aiohttp", _ast_leaf_name(node.args[1])))

    if has_tornado:
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            leaf = _ast_leaf_name(node.func)
            if leaf == "URLSpec" and len(node.args) >= 2:
                path = _ast_const_str(node.args[0])
                if path:
                    out.append(("*", path, node.lineno, "tornado", _ast_leaf_name(node.args[1])))
            elif leaf == "Application":
                table = node.args[0] if node.args else _kw(node, "handlers")
                if isinstance(table, ast.Name):
                    table = assigns.get(table.id)
                if isinstance(table, ast.List | ast.Tuple):
                    for elt in table.elts:
                        if isinstance(elt, ast.Tuple | ast.List) and len(elt.elts) >= 2:
                            path = _ast_const_str(elt.elts[0])
                            if path:
                                out.append(
                                    (
                                        "*",
                                        path,
                                        elt.elts[0].lineno,
                                        "tornado",
                                        _ast_leaf_name(elt.elts[1]),
                                    )
                                )

    return out


# =========================================================================
# Non-HTTP entry-point patterns (deterministic, per-language)
# =========================================================================
#
# An API route is only ONE way a service gets entered. The same deterministic
# regex-over-indexed-files approach also surfaces the OTHER starting points a
# service exposes: CLI commands, background/queue workers, scheduled jobs,
# event/lifecycle hooks and bare ``__main__`` script entries. Each pattern
# captures the entry DECLARATION; the handler symbol is attributed afterwards
# the same way routes are (``_enclosing_handler``).

# Python — Click / Typer command + group decorators:
#   @click.command("name")  @cli.group()  @app.command()
_RE_PY_CLI = re.compile(
    r"""@\s*[\w.]+\.(command|group)\(\s*(?:["']([^"']*)["'])?""",
)
# Python — argparse CLIs.  Two deterministic signals: a subcommand registration
# (`sub.add_parser("name")`) is an entry per se; a bare `ArgumentParser(...)`
# only counts when the same file also CALLS `.parse_args(` — plenty of helper
# modules build parsers they never run.
_RE_PY_ARGPARSE_ADD_PARSER = re.compile(
    r"""\.add_parser\(\s*["']([^"']+)["']""",
)
_RE_PY_ARGPARSE_CTOR = re.compile(r"""\bArgumentParser\s*\(""")
_RE_PY_ARGPARSE_PROG = re.compile(
    r"""\bArgumentParser\s*\([^)]*?prog\s*=\s*["']([^"']+)["']""",
    re.DOTALL,
)
_RE_PY_PARSE_ARGS = re.compile(r"""\.parse_args\s*\(""")
# Python — Celery tasks: @shared_task, @app.task(...), @celery.task(name="..")
_RE_PY_CELERY = re.compile(
    r"""@\s*(?:[\w.]+\.)?(?:shared_task|task|periodic_task)\b"""
    r"""(?:\([^)]*?(?:name\s*=\s*["']([^"']+)["'])?[^)]*\))?""",
)
# Python — Dramatiq actors: @dramatiq.actor  @broker.actor(...)
_RE_PY_DRAMATIQ = re.compile(r"""@\s*[\w.]+\.actor\b""")
# Python — APScheduler jobs: @scheduler.scheduled_job("cron", ...)
_RE_PY_SCHED = re.compile(
    r"""@\s*[\w.]+\.scheduled_job\(\s*(?:["']([^"']*)["'])?""",
)
# Python — Faust stream agents (Kafka consumers): @app.agent(topic)
_RE_PY_FAUST = re.compile(r"""@\s*[\w.]+\.agent\(\s*([\w.]+)?""")
# Python — FastAPI/Starlette lifecycle hooks: @app.on_event("startup")
_RE_PY_ONEVENT = re.compile(
    r"""@\s*[\w.]+\.on_event\(\s*["']([^"']+)["']""",
)
# Python — bare script entry: if __name__ == "__main__":
_RE_PY_MAIN = re.compile(
    r"""^[ \t]*if\s+__name__\s*==\s*["']__main__["']""",
    re.MULTILINE,
)

# Python — stdlib http.server / socketserver / wsgiref services.  These have no
# framework decorators, so route discovery keys on the two signals dynamic
# tools (OpenTelemetry auto-instrumentation, gunicorn/uvicorn app loading) also
# recognise: the handler base class, and the server-construction /
# ``serve_forever`` call site.
#
# A handler subclass's ``do_<VERB>`` methods become ``http_api`` entries (path
# recovered from simple ``self.path`` dispatch — ``==``/``!=``, ``startswith``,
# ``in``/``not in`` a literal tuple/list or a module-level string-tuple
# constant — else ``"/"``).  Constructing or subclassing a stdlib server class,
# a wsgiref ``make_server`` call, or a ``serve_forever`` call marks the owning
# module as a ``service_root`` entry point; a bare ``socketserver`` handler
# class with a ``handle`` method becomes a ``socket_handler`` entry.  Anything
# more dynamic (routing tables built at runtime, handler classes assembled via
# ``type``) is deliberately not guessed at.
#
# NOTE: examples here avoid literal call syntax on the trigger names — this
# file is itself scanned when vinv indexes its own repo, and a verbatim
# ``ServerClass(`` in a comment would self-match.
_STDLIB_HTTP_HANDLER_BASES = (
    "BaseHTTPRequestHandler",
    "SimpleHTTPRequestHandler",
    "CGIHTTPRequestHandler",
)
_STDLIB_SOCKET_HANDLER_BASES = (
    "BaseRequestHandler",
    "StreamRequestHandler",
    "DatagramRequestHandler",
)
_STDLIB_SERVER_CLASSES = (
    "ThreadingHTTPServer",
    "HTTPServer",
    "ThreadingTCPServer",
    "ThreadingUDPServer",
    "TCPServer",
    "UDPServer",
    "UnixStreamServer",
    "UnixDatagramServer",
    "ForkingTCPServer",
    "ForkingUDPServer",
)
_RE_PY_CLASS_DEF = re.compile(
    r"""^([ \t]*)class\s+(\w+)\s*\(([^)]*)\)\s*:""",
    re.MULTILINE,
)
_RE_PY_DO_METHOD = re.compile(
    r"""^([ \t]*)def\s+do_(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s*\(""",
    re.MULTILINE,
)
_RE_PY_HANDLE_METHOD = re.compile(r"""^([ \t]*)def\s+handle\s*\(""", re.MULTILINE)
# self.path dispatch forms inside a do_* method body.
_RE_PY_SELF_PATH_CMP = re.compile(r"""self\.path\s*(?:==|!=)\s*["']([^"']*)["']""")
_RE_PY_SELF_PATH_STARTS = re.compile(
    r"""self\.path\.startswith\(\s*["']([^"']*)["']""",
)
_RE_PY_SELF_PATH_IN = re.compile(
    r"""self\.path\s*(?:not\s+)?in\s*(?:[(\[]([^)\]]*)[)\]]|([A-Za-z_]\w*))""",
)
_RE_STR_LITERAL = re.compile(r"""["']([^"']*)["']""")
# Server construction call sites — a stdlib server class name followed by an
# open paren (its address/handler arguments).
_RE_PY_STDLIB_SERVER_CALL = re.compile(
    r"""\b(""" + "|".join(_STDLIB_SERVER_CLASSES) + r""")\s*\(""",
)
_RE_PY_SERVE_FOREVER = re.compile(r"""\.serve_forever\s*\(""")
_RE_PY_MAKE_SERVER = re.compile(r"""\bmake_server\s*\(""")


def _bases_contain(bases_text: str, names: tuple[str, ...]) -> bool:
    """Whether a class's base list names one of ``names`` (dotted or bare)."""
    base_words = re.findall(r"[\w.]+", bases_text)
    leaves = {b.rsplit(".", 1)[-1] for b in base_words}
    return any(n in leaves for n in names)


def _py_block_end(lines: list[str], header_idx: int, header_indent: int) -> int:
    """Index one past the last line of the suite headed at ``header_idx``.

    The suite ends at the first non-blank, non-comment line indented at or
    below the header (plain indentation scan — no AST needed for this).
    """
    for i in range(header_idx + 1, len(lines)):
        stripped = lines[i].strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(lines[i]) - len(lines[i].lstrip(" \t"))
        if indent <= header_indent:
            return i
    return len(lines)


def _py_class_ranges(
    text: str,
    lines: list[str],
    bases: tuple[str, ...],
) -> list[tuple[str, int, int, int]]:
    """``(class_name, header_line_idx, body_end_idx, header_indent)`` for every
    class in ``text`` whose base list names one of ``bases``."""
    out: list[tuple[str, int, int, int]] = []
    for m in _RE_PY_CLASS_DEF.finditer(text):
        if not _bases_contain(m.group(3), bases):
            continue
        idx = text.count("\n", 0, m.start())
        indent = len(m.group(1))
        out.append((m.group(2), idx, _py_block_end(lines, idx, indent), indent))
    return out


def _module_str_sequence(text: str, name: str) -> list[str]:
    """Path literals of a module-level ``NAME = ("/a", "/b")`` tuple/list constant."""
    m = re.search(
        rf"""^[ \t]*{re.escape(name)}\s*=\s*[(\[]([^)\]]*)[)\]]""",
        text,
        re.MULTILINE,
    )
    if not m:
        return []
    return [s for s in _RE_STR_LITERAL.findall(m.group(1)) if s.startswith("/")]


def _path_hints(body: str, module_text: str) -> list[str]:
    """Route paths a ``do_*`` method dispatches on, in source order.

    Parses only the simple, deterministic forms (``self.path == "/x"``,
    ``self.path.startswith("/x")``, ``self.path [not] in (…)`` with literal
    members or a module-level string-tuple constant).  Anything else yields no
    hint — the caller falls back to path ``"/"`` rather than guessing.
    """
    found: list[tuple[int, str]] = []
    for m in _RE_PY_SELF_PATH_CMP.finditer(body):
        if m.group(1).startswith("/"):
            found.append((m.start(), m.group(1)))
    for m in _RE_PY_SELF_PATH_STARTS.finditer(body):
        if m.group(1).startswith("/"):
            found.append((m.start(), m.group(1)))
    for m in _RE_PY_SELF_PATH_IN.finditer(body):
        if m.group(1) is not None:  # literal tuple/list members
            for pos, lit in ((m.start(), s) for s in _RE_STR_LITERAL.findall(m.group(1))):
                if lit.startswith("/"):
                    found.append((pos, lit))
        elif m.group(2):  # module-level constant by name
            for lit in _module_str_sequence(module_text, m.group(2)):
                found.append((m.start(), lit))
    found.sort(key=lambda t: t[0])
    ordered: list[str] = []
    for _, p in found:
        if p not in ordered:
            ordered.append(p)
    return ordered


def _stdlib_http_routes(text: str) -> list[tuple[str, str, int, str, str | None]]:
    """``(METHOD, path, line, framework, handler)`` for every ``do_<VERB>``
    method of an ``http.server`` request-handler subclass declared in ``text``."""
    if not any(b in text for b in _STDLIB_HTTP_HANDLER_BASES):
        return []
    lines = text.splitlines()
    classes = _py_class_ranges(text, lines, _STDLIB_HTTP_HANDLER_BASES)
    if not classes:
        return []
    out: list[tuple[str, str, int, str, str | None]] = []
    for m in _RE_PY_DO_METHOD.finditer(text):
        def_idx = text.count("\n", 0, m.start())
        def_indent = len(m.group(1))
        # The method must sit inside a handler class body, indented below it.
        if not any(
            start < def_idx < end and def_indent > cls_indent
            for _, start, end, cls_indent in classes
        ):
            continue
        body = "\n".join(lines[def_idx + 1 : _py_block_end(lines, def_idx, def_indent)])
        verb = m.group(2).upper()
        for path in _path_hints(body, text) or ["/"]:
            out.append((verb, path, def_idx + 1, "http.server", None))
    return out


def _stdlib_socket_handlers(text: str) -> list[tuple[str, int]]:
    """``(class_name, handle_def_line)`` for bare socketserver handler classes."""
    if not any(b in text for b in _STDLIB_SOCKET_HANDLER_BASES):
        return []
    lines = text.splitlines()
    classes = _py_class_ranges(text, lines, _STDLIB_SOCKET_HANDLER_BASES)
    out: list[tuple[str, int]] = []
    for name, start, end, cls_indent in classes:
        for m in _RE_PY_HANDLE_METHOD.finditer(text):
            def_idx = text.count("\n", 0, m.start())
            if start < def_idx < end and len(m.group(1)) > cls_indent:
                out.append((name, def_idx + 1))
                break
    return out


def _stdlib_service_root(text: str) -> tuple[str, int, str] | None:
    """``(trigger, line, framework)`` when the module owns a stdlib server.

    Signals: constructing (or subclassing) an ``http.server``/``socketserver``
    server class, a ``make_server`` call in a module that mentions wsgiref, and
    a ``serve_forever`` call.  One root per module — the earliest signal wins.
    """
    hits: list[tuple[int, str, str]] = []
    for m in _RE_PY_STDLIB_SERVER_CALL.finditer(text):
        name = m.group(1)
        fw = "http.server" if "HTTP" in name else "socketserver"
        hits.append((m.start(), name, fw))
    for m in _RE_PY_CLASS_DEF.finditer(text):
        for name in _STDLIB_SERVER_CLASSES:
            if _bases_contain(m.group(3), (name,)):
                fw = "http.server" if "HTTP" in name else "socketserver"
                hits.append((m.start(), name, fw))
                break
    if "wsgiref" in text:
        for m in _RE_PY_MAKE_SERVER.finditer(text):
            hits.append((m.start(), "make_server", "wsgiref"))
    for m in _RE_PY_SERVE_FOREVER.finditer(text):
        hits.append((m.start(), "serve_forever", "stdlib"))
    if not hits:
        return None
    pos, trigger, fw = min(hits)
    return trigger, text.count("\n", 0, pos) + 1, fw


# Python — stdio JSON-RPC servers (MCP being the dominant form).  These serve
# over stdin/stdout instead of a port, so port-centric discovery is blind to
# them.  Two deterministic signals, mirroring how MCP hosts actually launch
# them: constructing a ``FastMCP`` app (the high-level SDK), and opening the
# low-level stdio transport.  Generic hand-rolled read-stdin/write-stdout
# loops are deliberately not guessed at.  (As elsewhere in this file, comments
# avoid literal call syntax on the trigger names — this file is scanned when
# vinv indexes its own repo.)
_RE_PY_MCP_FASTMCP = re.compile(r"""\bFastMCP\(\s*(?:["']([^"']+)["'])?""")
_RE_PY_MCP_STDIO = re.compile(r"""\bstdio_server\s*\(""")
# Hand-rolled stdio JSON-RPC loops (SDK-less MCP servers): reading stdin in a
# file that also speaks the "jsonrpc" protocol tag.  Both signals are required
# — plenty of code reads stdin, and "jsonrpc" alone appears in HTTP clients —
# so the detector is gated on their conjunction, one entry per file.
_RE_PY_STDIN_READ = re.compile(r"""\bsys\.stdin\b""")
_JSONRPC_TAG = "jsonrpc"

# JS/TS — Commander/yargs CLI: .command("deploy <env>")
_RE_JS_CLI = re.compile(r"""\.command\(\s*[`"']([^`"']+)[`"']""")
# JS/TS — MCP stdio servers: new StdioServerTransport() from
# @modelcontextprotocol/sdk (the transport the host connects stdin/stdout to).
_RE_JS_MCP_STDIO = re.compile(r"""\bnew\s+StdioServerTransport\s*\(""")
# JS/TS — hand-rolled stdio JSON-RPC loops: consuming process.stdin in a file
# that also speaks the "jsonrpc" tag (same conjunction gate as Python).
_RE_JS_STDIN_READ = re.compile(r"""\bprocess\.stdin\.(?:on|once|setEncoding|resume|pipe)\s*\(""")
# JS/TS — node-cron / node-schedule: cron.schedule("* * * * *", fn)
_RE_JS_CRON = re.compile(
    r"""\b(?:cron|schedule|nodeCron)\.schedule\(\s*[`"']([^`"']+)[`"']""",
)
# JS/TS — Bull/BullMQ workers: queue.process(...)  new Worker("name", ...)
_RE_JS_WORKER = re.compile(
    r"""(?:\.process\(|new\s+Worker\(\s*[`"']([^`"']+)[`"'])""",
)


def _entrypoints_in_source(
    text: str,
    ext: str,
) -> list[tuple[str, str, int, str]]:
    """Return ``(kind, trigger, line, framework)`` for every NON-HTTP entry point
    declared in ``text`` — CLI commands, background/queue tasks, scheduled jobs,
    event/lifecycle hooks and ``__main__`` script entries.  Deterministic regex
    extraction, mirroring ``_routes_in_source``.
    """
    out: list[tuple[str, str, int, str]] = []

    def _line_of(pos: int) -> int:
        return text.count("\n", 0, pos) + 1

    if ext in _PY_EXTS:
        for m in _RE_PY_CLI.finditer(text):
            out.append(("cli_command", m.group(2) or "", _line_of(m.start()), "click/typer"))
        for m in _RE_PY_ARGPARSE_ADD_PARSER.finditer(text):
            out.append(("cli_command", m.group(1), _line_of(m.start()), "argparse"))
        ctor = _RE_PY_ARGPARSE_CTOR.search(text)
        if ctor is not None and _RE_PY_PARSE_ARGS.search(text):
            prog = _RE_PY_ARGPARSE_PROG.search(text)
            out.append(
                ("cli_command", prog.group(1) if prog else "", _line_of(ctor.start()), "argparse")
            )
        for m in _RE_PY_CELERY.finditer(text):
            out.append(("background_task", m.group(1) or "", _line_of(m.start()), "celery"))
        for m in _RE_PY_DRAMATIQ.finditer(text):
            out.append(("background_task", "", _line_of(m.start()), "dramatiq"))
        for m in _RE_PY_SCHED.finditer(text):
            out.append(("scheduled_task", m.group(1) or "", _line_of(m.start()), "apscheduler"))
        for m in _RE_PY_FAUST.finditer(text):
            out.append(("background_task", m.group(1) or "", _line_of(m.start()), "faust"))
        for m in _RE_PY_ONEVENT.finditer(text):
            out.append(("event_hook", m.group(1), _line_of(m.start()), "fastapi/starlette"))
        for m in _RE_PY_MAIN.finditer(text):
            out.append(("script_main", "__main__", _line_of(m.start()), "python"))
        for m in _RE_PY_MCP_FASTMCP.finditer(text):
            out.append(("stdio_server", m.group(1) or "FastMCP", _line_of(m.start()), "mcp"))
        for m in _RE_PY_MCP_STDIO.finditer(text):
            out.append(("stdio_server", "stdio_server", _line_of(m.start()), "mcp"))
        if _JSONRPC_TAG in text.lower():
            m = _RE_PY_STDIN_READ.search(text)
            if m is not None:
                # Trigger assembled without the literal token so this file
                # never self-matches when vinv indexes its own repo.
                out.append(("stdio_server", "sys." + "stdin", _line_of(m.start()), "jsonrpc-stdio"))
        for cls_name, line in _stdlib_socket_handlers(text):
            out.append(("socket_handler", cls_name, line, "socketserver"))
        root = _stdlib_service_root(text)
        if root is not None:
            trigger, line, framework = root
            out.append(("service_root", trigger, line, framework))
    elif ext in _JS_EXTS:
        for m in _RE_JS_CLI.finditer(text):
            out.append(("cli_command", m.group(1), _line_of(m.start()), "commander/yargs"))
        for m in _RE_JS_CRON.finditer(text):
            out.append(("scheduled_task", m.group(1), _line_of(m.start()), "node-cron"))
        for m in _RE_JS_WORKER.finditer(text):
            out.append(("background_task", m.group(1) or "", _line_of(m.start()), "bull"))
        for m in _RE_JS_MCP_STDIO.finditer(text):
            out.append(("stdio_server", "StdioServerTransport", _line_of(m.start()), "mcp"))
        if _JSONRPC_TAG in text.lower():
            m = _RE_JS_STDIN_READ.search(text)
            if m is not None:
                out.append(("stdio_server", "process.stdin", _line_of(m.start()), "jsonrpc-stdio"))

    return out


# =========================================================================
# Service-kind taxonomy (shared with handbook / bringup discovery)
# =========================================================================
#
# Every entry point ALSO carries a ``service_kind`` — the process-level
# taxonomy the discovery runbooks (handbook, bringup) use to classify what a
# repo can run: ``http-service | stdio-server | worker | scheduler | cli |
# frontend-dev-server | library``.  The mapping is additive (the finer-grained
# ``kind`` stays authoritative for call-tree rooting); it exists so a single
# vocabulary describes a runnable from static consolidation through bring-up.

_SERVICE_KIND_BY_ENTRY: dict[str, str] = {
    "http_api": "http-service",
    "event_hook": "http-service",  # lifecycle hook of the serving app process
    "stdio_server": "stdio-server",
    "cli_command": "cli",
    "script_main": "cli",
    "background_task": "worker",
    "socket_handler": "worker",
    "scheduled_task": "scheduler",
}


def _service_kind(kind: str, framework: str) -> str:
    """Map an entry-point ``kind`` (+ framework) onto the shared service taxonomy."""
    if kind == "service_root":
        # An http.server/wsgiref root serves HTTP; a bare socketserver root is a
        # long-running non-HTTP process (worker in the shared taxonomy).
        return "http-service" if framework in ("http.server", "wsgiref") else "worker"
    return _SERVICE_KIND_BY_ENTRY.get(kind, "worker")


def _join_route(prefix: str, path: str) -> str:
    """Join a router/blueprint mount prefix onto a declared route path.

    FastAPI/Flask concatenate the two (the prefix carries no trailing slash and
    the path is appended as-declared), so ``("/v1/swarms", "")`` -> ``/v1/swarms``
    and ``("/v1/swarms", "/{id}")`` -> ``/v1/swarms/{id}``.
    """
    if not prefix:
        return path
    return prefix.rstrip("/") + path


def _router_prefixes(text: str) -> dict[str, str]:
    """Map each Python router/blueprint variable to its construction prefix.

    e.g. ``router = APIRouter(prefix="/v1/swarms")`` -> ``{"router": "/v1/swarms"}``.
    Resolved within a single file (the dominant FastAPI pattern); variables with
    no prefix are omitted.
    """
    prefixes: dict[str, str] = {}
    for m in _RE_PY_ROUTER_CTOR.finditer(text):
        kw = _RE_PY_PREFIX_KW.search(m.group(2))
        if kw and kw.group(1):
            prefixes[m.group(1)] = kw.group(1)
    return prefixes


def _module_match(imp_module: str, file_module: str) -> bool:
    """True if an import path refers to the file at ``file_module``.

    Tolerant of src-root / relative-import differences: exact match, or either
    module being a dotted suffix of the other (e.g. ``api.controllers.title`` vs
    ``vinvapp.api.controllers.title``).
    """
    return (
        imp_module == file_module
        or file_module.endswith("." + imp_module)
        or imp_module.endswith("." + file_module)
    )


# Directories never worth scanning for app-assembly (include_router) files.
_MOUNT_SCAN_SKIP = frozenset(
    {
        ".git",
        ".vinv",
        ".hg",
        ".svn",
        "node_modules",
        ".venv",
        "venv",
        "env",
        "__pycache__",
        "dist",
        "build",
        ".mypy_cache",
        ".pytest_cache",
        ".tox",
        ".ruff_cache",
        "site-packages",
        ".next",
        ".cache",
        "data",
    }
)


def _scan_repo_mount_files(root: Path, already: set[str]) -> dict[str, str]:
    """Find repo ``*.py`` files that call ``include_router`` but were NOT indexed.

    The app-assembly module (``main.py``/``app.py``) is often excluded from the
    code index, yet it is where mount-time ``include_router(router, prefix=...)``
    lives.  A bounded walk (skipping vendor/build/data dirs) recovers just those
    files so cross-file mount prefixes can still be resolved.  Deterministic:
    files are returned in sorted order and only when they contain the call.
    """
    out: dict[str, str] = {}
    for p in sorted(root.rglob("*.py")):
        if any(part in _MOUNT_SCAN_SKIP for part in p.relative_to(root).parts[:-1]):
            continue
        try:
            rel = str(p.relative_to(root))
        except ValueError:
            continue
        if rel in already:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if "include_router(" in text:
            out[rel] = text
    return out


def _collect_mount_prefixes(file_texts: dict[str, str]) -> dict[tuple[str, str], str]:
    """Resolve cross-file ``include_router(<alias>, prefix=...)`` calls.

    A controller defines ``router = APIRouter(...)`` while an assembly module
    does ``from pkg.ctrl import router as ctrl_router`` then
    ``app.include_router(ctrl_router, prefix="/api")``.  The mount prefix is
    attributed to ``(pkg.ctrl, "router")`` — the (module, router-var) whose
    routes it is prepended onto.  Calls without a ``prefix=`` add nothing and are
    skipped.  Only single-line ``from … import …`` is parsed (the common form).
    """
    mounts: dict[tuple[str, str], str] = {}
    for rel, text in file_texts.items():
        if "include_router" not in text:
            continue
        this_mod = _file_to_module(rel)
        # alias -> (target_module, original_var) from this file's imports.
        aliases: dict[str, tuple[str, str]] = {}
        for im in _RE_PY_FROM_IMPORT.finditer(text):
            module = im.group(1)
            names = im.group(2).split("#", 1)[0].strip().strip("()")
            for nm in _RE_PY_IMPORT_NAME.finditer(names):
                orig, alias = nm.group(1), nm.group(2)
                if orig == "as":
                    continue
                aliases[alias or orig] = (module, orig)
        for mt in _RE_PY_INCLUDE_ROUTER.finditer(text):
            kw = _RE_PY_PREFIX_KW.search(mt.group(2))
            if not (kw and kw.group(1)):
                continue
            alias = mt.group(1).split(".")[-1]
            mounts[aliases.get(alias, (this_mod, alias))] = kw.group(1)
    return mounts


def _routes_in_source(
    text: str,
    ext: str,
    mounts: dict[str, str] | None = None,
) -> list[tuple[str, str, int, str, str | None]]:
    """Return ``(method, path, line, framework, handler)`` for every route
    declared in ``text``.  Deterministic extraction — regexes for decorator /
    imperative registration plus an AST pass for declarative route tables;
    method is upper-cased and ``"*"`` when the registration does not name one
    (Django paths, Go ``HandleFunc``).  ``handler`` is the endpoint symbol when
    the declaration itself names one (declarative tables); ``None`` means the
    caller should attribute the handler by symbol adjacency, as decorators sit
    directly above their function.  Router-local mount prefixes
    (``APIRouter(prefix=...)``) and any cross-file ``include_router(prefix=...)``
    mount prefix (passed in ``mounts`` as ``{router_var: prefix}`` for this
    file) are joined onto each path so the result is the real runtime path.
    """
    out: list[tuple[str, str, int, str, str | None]] = []
    mounts = mounts or {}

    def _line_of(pos: int) -> int:
        return text.count("\n", 0, pos) + 1

    if ext in _PY_EXTS:
        prefixes = _router_prefixes(text)

        def _full(var: str, declared: str) -> str:
            # Decorator object may be dotted (`self.router`); try it whole then
            # its trailing segment against the router-prefix / mount maps.
            seg = var.split(".")[-1]
            local = prefixes.get(var) or prefixes.get(seg, "")
            mount = mounts.get(var) or mounts.get(seg, "")
            return _join_route(mount, _join_route(local, declared))

        for m in _RE_PY_METHOD_DECORATOR.finditer(text):
            # Route paths are "" (sub-router root) or start with "/". Anything
            # else is not a route declaration — most commonly
            # `@mock.patch("pkg.attr")` in tests masquerading as HTTP PATCH.
            declared = m.group(3)
            if declared and not declared.startswith("/"):
                continue
            path = _full(m.group(1), declared)
            out.append((m.group(2).upper(), path, _line_of(m.start()), "fastapi/flask", None))
        for m in _RE_PY_ROUTE_DECORATOR.finditer(text):
            path = _full(m.group(1), m.group(2))
            methods = _RE_METHODS_LIST.findall(m.group(3)) or ["GET"]
            for meth in methods:
                out.append((meth.upper(), path, _line_of(m.start()), "flask", None))
        for m in _RE_PY_ADD_ROUTE.finditer(text):
            path = _full(m.group(1), m.group(2))
            for meth in _RE_METHODS_LIST.findall(m.group(3)) or ["*"]:
                out.append((meth.upper(), path, _line_of(m.start()), "fastapi/starlette", None))
        for m in _RE_PY_DJANGO.finditer(text):
            out.append(("*", m.group(1), _line_of(m.start()), "django", None))
        out.extend(_stdlib_http_routes(text))
        out.extend(_py_declarative_routes(text))
    elif ext in _JS_EXTS:
        for m in _RE_JS_METHOD_CALL.finditer(text):
            out.append((m.group(1).upper(), m.group(2), _line_of(m.start()), "express", None))
        for m in _RE_TS_NEST_DECORATOR.finditer(text):
            out.append((m.group(1).upper(), m.group(2) or "/", _line_of(m.start()), "nestjs", None))
    elif ext in _GO_EXTS:
        for m in _RE_GO_METHOD.finditer(text):
            meth = m.group(1).upper()
            if meth in ("HANDLEFUNC", "HANDLE"):
                meth = "*"
            out.append((meth, m.group(2), _line_of(m.start()), "go", None))
    elif ext in _JVM_EXTS:
        for m in _RE_SPRING.finditer(text):
            verb = m.group(1)
            meth = "*" if verb == "Request" else verb.upper()
            out.append((meth, m.group(2), _line_of(m.start()), "spring", None))

    return out


# =========================================================================
# Test-fixture detection
# =========================================================================
#
# Routes declared in test fixtures (a demo app under tests/, a synthetic
# service in an e2e fixture repo) are real, discoverable entry points — the
# planted-bug e2e depends on finding its fixture route — but they are not the
# service's production surface.  They are therefore FLAGGED (``is_test``),
# never dropped, and sorted after non-test APIs in the inventory.

# Path segments that mark a file as test/fixture code.  A segment matches when
# it equals one of these, or starts with ``test_`` / ends with ``_test``
# (extension stripped).  ``conftest`` covers pytest's per-directory hook files.
_TEST_PATH_SEGMENTS = frozenset(
    {
        "tests",
        "fixture",
        "fixtures",
        "demo_app",
        "conftest",
    }
)


def _is_test_path(rel: str, testpath_dirs: Iterable[str] = ()) -> bool:
    """Whether a repo-relative source path is test/fixture code.

    Deterministic heuristics: any path segment in ``_TEST_PATH_SEGMENTS`` or
    shaped ``test_*``/``*_test``, or the file living under a directory listed
    in a pytest ``testpaths`` config (``testpath_dirs``, repo-relative).
    """
    norm = rel.replace("\\", "/")
    parts = norm.split("/")
    for i, part in enumerate(parts):
        seg = Path(part).stem if i == len(parts) - 1 else part
        if seg in _TEST_PATH_SEGMENTS or seg.startswith("test_") or seg.endswith("_test"):
            return True
    return any(norm == d or norm.startswith(d + "/") for d in testpath_dirs)


def _pytest_testpath_dirs(root: Path) -> list[str]:
    """Repo-relative directories named by pytest ``testpaths`` settings.

    Reads ``pyproject.toml`` at the repo root and one level down (the monorepo
    layout — each member package carries its own pytest config); a bad or
    absent file simply contributes nothing.  Returned sorted for determinism.
    """
    dirs: set[str] = set()
    candidates = [root / "pyproject.toml", *sorted(root.glob("*/pyproject.toml"))]
    for cfg in candidates:
        try:
            data = tomllib.loads(cfg.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError):
            continue
        ini = data.get("tool", {}).get("pytest", {}).get("ini_options", {})
        if not isinstance(ini, dict):
            continue
        raw = ini.get("testpaths", [])
        if isinstance(raw, str):
            raw = [raw]
        if not isinstance(raw, list):
            continue
        for tp in raw:
            if not isinstance(tp, str) or not tp:
                continue
            abs_dir = cfg.parent / tp
            try:
                rel_dir = abs_dir.resolve().relative_to(root)
            except ValueError:
                continue
            dirs.add(rel_dir.as_posix())
    return sorted(dirs)


# =========================================================================
# consolidate — enumerate every entry point from source
# =========================================================================


def list_service_apis(
    project_root: Path,
    *,
    service: str | None = None,
    store_dir: str | None = None,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Enumerate every ENTRY POINT a service defines, purely from its SOURCE CODE.

    No traces, no running server, no frontend, no LLM/agent — fully
    deterministic. Opens the Rust index already built for ``project_root``,
    iterates its source files, and regex-extracts every starting point the
    service exposes, attributing each to its enclosing handler symbol:

    * **HTTP routes** across FastAPI/Flask/Django, Express/NestJS, gin/echo/chi,
      Spring — also surfaced under ``apis`` (kind ``http_api``).
    * **stdlib HTTP handlers** — ``http.server`` request-handler subclasses:
      each ``do_<VERB>`` method is an HTTP route (path recovered from simple
      ``self.path`` dispatch, else ``"/"``); server construction /
      ``serve_forever`` marks the module as a ``service_root``.
    * **stdio JSON-RPC servers** (kind ``stdio_server``) — MCP-style processes
      that serve over stdin/stdout instead of a port: ``FastMCP`` app
      construction, the low-level ``mcp`` stdio transport, and (JS/TS) the
      ``StdioServerTransport`` construction.
    * **CLI commands** (Click/Typer, Commander/yargs).
    * **Background/queue workers** (Celery, Dramatiq, Faust, Bull) and bare
      ``socketserver`` handlers (``socket_handler``).
    * **Scheduled jobs** (APScheduler, node-cron).
    * **Event/lifecycle hooks** (FastAPI ``on_event``).
    * **Bare ``__main__`` script entries**.

    The result carries both ``apis`` (HTTP only, back-compat) and ``entrypoints``
    (the full set, each tagged with a ``kind``).  Each entry point additionally
    carries an additive ``service_kind`` — the process-level taxonomy shared
    with the discovery runbooks (``http-service | stdio-server | worker |
    scheduler | cli | frontend-dev-server | library``) — and the result
    summarises them in ``service_kinds``.  Every entry carries
    ``is_test`` — true when its file matches test/fixture path heuristics or a
    pytest ``testpaths`` directory; such routes are sorted after the non-test
    ones (and counted in ``summary``) but never dropped.  Writes the inventory
    to ``<project_root>/.vinv/identification/apis.json``.

    Using the index's file list (rather than walking the tree) means the same curated
    source set Discovery saw — vendored/test/build dirs already excluded — and
    the symbol table gives each entry its handler name for free.

    ``store_dir`` overrides the index location; the default is
    ``<repo>/.vinv/index``.
    """
    log = logger or logging.getLogger(__name__)
    root = project_root.resolve()
    store = open_identification_store(root, store_dir)
    store_dir = store.store_dir
    store_kind = store.kind
    try:
        if store.symbol_count() == 0:
            raise FileNotFoundError(
                f"Code index at {store_dir} is empty. Re-run `index index` "
                "for this repo before consolidating."
            )
        rel_files = store.get_all_file_paths()

        # Read each candidate source once; cache so the mount-prefix pre-pass and
        # the route extraction don't re-read from disk.
        file_texts: dict[str, str] = {}
        for rel in rel_files:
            ext = Path(rel).suffix.lower()
            if ext not in (_PY_EXTS | _JS_EXTS | _GO_EXTS | _JVM_EXTS):
                continue
            rel_path = Path(rel)
            if rel_path.is_absolute():
                raise ValueError(f"index contains absolute source path: {rel}")
            abs_path = (root / rel_path).resolve()
            try:
                abs_path.relative_to(root)
            except ValueError as exc:
                raise ValueError(f"index source path escapes project root: {rel}") from exc
            try:
                file_texts[rel] = abs_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue

        # Cross-file include_router(prefix=...) mounts, keyed by (module, var).
        # The app-assembly file (main.py/app.py) carrying these calls is often
        # not in the code index, so supplement with a bounded repo scan for the
        # few extra files that call include_router.
        mount_texts = dict(file_texts)
        mount_texts.update(_scan_repo_mount_files(root, set(file_texts)))
        mount_map = _collect_mount_prefixes(mount_texts)

        # Directories pytest configs name as test roots (repo-relative).
        testpath_dirs = _pytest_testpath_dirs(root)

        apis: dict[tuple[str, str], dict[str, Any]] = {}
        # Non-HTTP entry points, deduped by (kind, file, line).
        extra_eps: dict[tuple[str, str, int], dict[str, Any]] = {}
        frameworks: set[str] = set()
        for rel, text in file_texts.items():
            ext = Path(rel).suffix.lower()
            # Mount prefixes that target a router variable defined in THIS file.
            this_mod = _file_to_module(rel)
            file_mounts = {
                var: pfx for (mod, var), pfx in mount_map.items() if _module_match(mod, this_mod)
            }
            routes = _routes_in_source(text, ext, file_mounts)
            entrypoints = _entrypoints_in_source(text, ext)
            if not routes and not entrypoints:
                continue
            is_test = _is_test_path(rel, testpath_dirs)
            # Symbols for this file, sorted by start_line for handler lookup.
            symbols = sorted(
                store.get_symbols_for_file(rel),
                key=lambda s: s["start_line"],
            )
            for method, path, line, framework, decl_handler in routes:
                frameworks.add(framework)
                # Declarative registrations (Route("/x", chat)) name their
                # endpoint function directly — trust that over adjacency.
                handler = decl_handler or _enclosing_handler(symbols, line)
                # A route's path is recorded AS DECLARED (prefixes are not
                # resolved), so many controllers legitimately share an empty or
                # bare path (e.g. `@router.get("")`).  Such routes are distinct
                # endpoints distinguished only by their handler symbol, so key
                # (and id) on the handler when the path can't stand alone.
                path_is_unique = path.startswith("/") and len(path) > 1
                key = (method, path) if path_is_unique else (method, path, handler, rel)
                entry = apis.get(key)
                if entry is None or (entry.get("is_test") and not is_test):
                    # First declaration wins — unless a test fixture claimed the
                    # route first and this is the production declaration, which
                    # then takes over the attribution.
                    apis[key] = {
                        "id": _api_id(method, path, handler),
                        "method": method,
                        "path": path,
                        "handler": handler,
                        "file": rel,
                        "line": line,
                        "framework": framework,
                        "is_test": is_test,
                    }
                elif entry.get("handler") is None and handler is not None:
                    entry["handler"] = handler

            for kind, trigger, line, framework in entrypoints:
                frameworks.add(framework)
                # __main__ is a module-level entry, not attached to a function —
                # resolve the handler from what the guard block CALLS (usually
                # main()), so the call tree has a real function to root at.
                # Every other kind decorates the handler just below it.
                handler = (
                    _main_guard_handler(text, line, symbols)
                    if kind == "script_main"
                    else _enclosing_handler(symbols, line)
                )
                ekey = (kind, rel, line)
                if ekey not in extra_eps:
                    extra_eps[ekey] = {
                        "kind": kind,
                        "service_kind": _service_kind(kind, framework),
                        "id": _entrypoint_id(kind, trigger, handler, rel),
                        "trigger": _entrypoint_trigger(kind, trigger, handler, rel),
                        "handler": handler,
                        "file": rel,
                        "line": line,
                        "framework": framework,
                        "is_test": is_test,
                    }

        # Non-test APIs first (the production surface), then test/fixture ones;
        # deterministic within each group by (path, method, file).
        api_list = sorted(
            apis.values(),
            key=lambda a: (a["is_test"], a["path"], a["method"], a["file"]),
        )

        # Unified entry-point view: HTTP routes (as kind "http_api") plus the
        # CLI/worker/scheduler/hook/script entries, sorted by (kind, file, line).
        entrypoints_list: list[dict[str, Any]] = [
            {
                "kind": "http_api",
                "service_kind": "http-service",
                "id": a["id"],
                "method": a["method"],
                "path": a["path"],
                "trigger": f"{a['method']} {a['path']}",
                "handler": a["handler"],
                "file": a["file"],
                "line": a["line"],
                "framework": a["framework"],
                "is_test": a["is_test"],
            }
            for a in api_list
        ]
        entrypoints_list.extend(
            extra_eps[k] for k in sorted(extra_eps, key=lambda t: (t[0], t[1], t[2]))
        )
        kind_counts: dict[str, int] = {}
        service_kind_counts: dict[str, int] = {}
        for ep in entrypoints_list:
            kind_counts[ep["kind"]] = kind_counts.get(ep["kind"], 0) + 1
            sk = ep["service_kind"]
            service_kind_counts[sk] = service_kind_counts.get(sk, 0) + 1
    finally:
        store.close()

    # A silent zero must never look like a clean run: an empty (or HTTP-empty)
    # inventory is loudly diagnosed, both in the result document (so every
    # downstream consumer — exerciser plan, extension, MCP — can surface it)
    # and on the log.
    diagnostics: list[str] = []
    if not api_list:
        non_http_kinds = sorted(k for k in kind_counts if k != "http_api")
        if non_http_kinds:
            diagnostics.append(
                "0 HTTP endpoints discovered — Vinv cannot exercise this repo "
                "over HTTP. Non-HTTP entry points were catalogued "
                f"({', '.join(non_http_kinds)}); the function-level harness "
                "drives those instead."
            )
        else:
            diagnostics.append(
                "0 endpoints discovered — Vinv cannot exercise this repo. No "
                "HTTP routes and no other entry points (CLI, worker, "
                "scheduler, stdio, __main__) were found. If this repo does "
                "define services, route discovery has a coverage gap — "
                "report the framework."
            )
        log.warning("consolidate_empty %s", diagnostics[0])

    result: dict[str, Any] = {
        "status": "ok",
        "diagnostics": diagnostics,
        "service": service,
        "code_root": str(root),
        "index_store": store_dir,
        "store_kind": store_kind,
        "indexed_files": len(rel_files),
        "frameworks": sorted(frameworks),
        "api_count": len(api_list),
        # Test-fixture routes are flagged (`is_test`) and sorted last, never
        # dropped — a fixture route is still a discoverable entry point.
        "summary": {
            "apis": len(api_list),
            "test_apis": sum(1 for a in api_list if a["is_test"]),
        },
        "entrypoint_count": len(entrypoints_list),
        "entrypoint_kinds": dict(sorted(kind_counts.items())),
        # Additive: the process-level taxonomy shared with the discovery
        # runbooks (http-service | stdio-server | worker | scheduler | cli |
        # frontend-dev-server | library), counted over `entrypoints`.
        "service_kinds": dict(sorted(service_kind_counts.items())),
        # Each path is the real runtime path: both router-local prefixes
        # (APIRouter(prefix=...)/Blueprint url_prefix) AND cross-file mount
        # prefixes (include_router(router, prefix=...) in another module, e.g.
        # the app-assembly main.py) are joined on. Cross-file resolution needs
        # the assembly file to be locatable (indexed or found by the bounded
        # repo scan); single-line `from … import … as …` is the supported form.
        "prefix_resolved": "full",
        # `apis` is the HTTP-only view (kept for back-compat); `entrypoints` is
        # the full set of starting points, with a `kind` discriminator.
        "apis": api_list,
        "entrypoints": entrypoints_list,
    }

    log.info(
        "consolidate_done apis=%d entrypoints=%d kinds=%s indexed_files=%d store=%s",
        len(api_list),
        len(entrypoints_list),
        dict(sorted(kind_counts.items())),
        len(rel_files),
        store_dir,
    )

    out_dir = root / ".vinv" / "identification"
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "apis.json").write_text(
            json.dumps(result, indent=2),
            encoding="utf-8",
        )
        result["output_file"] = str(out_dir / "apis.json")
    except OSError as exc:
        log.warning("Could not write apis.json: %s", exc)

    return result


def _entrypoint_id(
    kind: str,
    trigger: str,
    handler: str | None,
    rel: str,
) -> str:
    """Filesystem-safe id for a non-HTTP entry point.

    Shaped like the API ids (``KIND_slug``) so call-tree lookup is uniform.
    Prefers the handler symbol (unique per file, the function the tree roots at),
    else the declared trigger, else the module stem.
    """
    prefix = {
        "cli_command": "CLI",
        "background_task": "TASK",
        "scheduled_task": "CRON",
        "event_hook": "HOOK",
        "script_main": "MAIN",
        "service_root": "SVC",
        "socket_handler": "SOCK",
        "stdio_server": "STDIO",
    }.get(kind, kind.upper())
    if kind == "script_main":
        # Every __main__ shares the trigger "__main__"; key the id on the module
        # path so the entries stay distinct and point at their file.
        basis = re.sub(r"\.[^.]+$", "", rel).replace("/", ".")
    elif kind == "service_root":
        # Roots across files share triggers like "serve_forever"; key on the
        # module path (like __main__) so each file's root id stays distinct.
        basis = re.sub(r"\.[^.]+$", "", rel).replace("/", ".")
    else:
        # Prefer the handler symbol: it's the function the call tree roots at and
        # keeps ids distinct when several share a trigger (e.g. many `on_event
        # ("startup")` hooks). Fall back to the declared trigger, then the module.
        basis = handler or trigger or Path(rel).stem
        # Commander triggers carry arg specs ("deploy <env>"); keep the verb only.
        basis = basis.split()[0] if basis else "entry"
    slug = re.sub(r"[^A-Za-z0-9_]", "_", basis).strip("_")
    return f"{prefix}_{slug or 'entry'}"


def _entrypoint_trigger(
    kind: str, trigger: str, handler: str | None, rel: str,
) -> str:
    """The human-facing label for a non-HTTP entry point.

    Mostly the declared trigger (a command name, a queue, a cron expression).
    The exception is ``script_main``: the declaration is ``if __name__ ==
    "__main__"``, which is the SAME text in every script, so a repo of CLI tools
    renders as a wall of rows all reading "__main__" with nothing to tell them
    apart.  Those are labelled by the file that is actually run — the thing the
    user types — with the guard's handler kept in the ``handler`` field as
    before.
    """
    if kind == "script_main":
        return f"python {rel}"
    return trigger or (handler or "")


_RE_CALL_NAME = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(")
# Bare function references handed to a runner: typer.run(main), Process(target=main)
_RE_RUNNER_REF = re.compile(
    r"(?:typer\.run|sys\.exit|asyncio\.run|target\s*=)\s*\(?\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]"
)


def _main_guard_handler(
    text: str,
    guard_line: int,
    symbols: list[dict[str, Any]],
) -> str | None:
    """The same-file function a ``__main__`` guard block calls, if any.

    Scans the indented block under ``if __name__ == "__main__":`` for call
    names (plus bare references passed to runners like ``typer.run(main)``)
    and returns the first that matches a symbol defined in this file — the
    function the call tree should root at. Returns None for guards that only
    call externals (such scripts get a degraded, non-erroring tree).
    """
    lines = text.splitlines()
    if guard_line < 1 or guard_line > len(lines):
        return None
    guard = lines[guard_line - 1]
    guard_indent = len(guard) - len(guard.lstrip())
    names: list[str] = []
    for raw in lines[guard_line:]:
        if raw.strip() and (len(raw) - len(raw.lstrip())) <= guard_indent:
            break  # dedent — guard block ended
        names.extend(_RE_CALL_NAME.findall(raw))
        names.extend(_RE_RUNNER_REF.findall(raw))
    local = {s["name"] for s in symbols if s.get("name")}
    for name in names:
        if name in local:
            return name
    return None


def _enclosing_handler(symbols: list[dict[str, Any]], route_line: int) -> str | None:
    """Best-effort handler name for a route declared at ``route_line``.

    A function-definition range starts at ``def`` (decorators sit on the lines
    ABOVE), so a decorator route line is just before its handler.  The two cases
    are told apart by what CONTAINS the route line, not by how far the ``def``
    sits below it: a decorator lives at module or class scope, while an
    imperative registration (``app.get(...)`` inside a function body) is nested
    in a function.  So take the innermost containing FUNCTION when there is one,
    and otherwise the next symbol below — however many lines the decorator's
    arguments span.
    """
    after: dict[str, Any] | None = None
    for sym in symbols:  # sorted by start_line ascending
        if sym["start_line"] >= route_line:
            after = sym
            break
    # Only a function body can host an imperative registration; a module or
    # class range containing the route line just means "decorator at that scope".
    containing = [
        s
        for s in symbols
        if s["start_line"] <= route_line <= s["end_line"]
        and s.get("node_type") == "function_definition"
    ]
    if containing:
        return _symbol_name(max(containing, key=lambda s: s["start_line"]))
    return _symbol_name(after) if after is not None else None


def _symbol_name(symbol: dict[str, Any]) -> str:
    """Extract a bare identifier from either supported symbol record."""
    if symbol.get("name"):
        return str(symbol["name"])
    sid = symbol.get("symbol_id", "")
    return sid.split("::", 1)[1] if "::" in sid else sid


def _api_id(method: str, path: str, handler: str | None = None) -> str:
    """Filesystem-safe id for a route.

    Built from the path when it is descriptive; for empty or bare paths (which
    many controllers share because route prefixes are not resolved) the handler
    symbol is the only distinguishing factor, so the id keys on it to stay unique.
    """
    slug = path.strip("/").replace("/", "_").replace("{", "").replace("}", "")
    slug = re.sub(r"[^A-Za-z0-9_]", "_", slug)
    if not slug:
        slug = re.sub(r"[^A-Za-z0-9_]", "_", handler) if handler else "root"
    return f"{method.upper()}_{slug or 'root'}"


# =========================================================================
# calltree — deterministic call tree for one entry point
# =========================================================================


def _symbol_entrypoint(
    root: Path,
    symbol: str,
    store_dir: str | None,
    log: logging.Logger,
) -> dict[str, Any]:
    """A synthetic entry point rooted at one indexed symbol.

    ``consolidate`` finds entry points the repo DECLARES — a route decorator, a
    Click command, a celery task. A function the exerciser drove directly is not
    declared anywhere: it was chosen from the index because it is exported and
    callable, which is exactly why driving it needed a harness in the first
    place. It still has a call tree, and refusing to build one left every
    function-level unit with no static denominator and therefore 0/0 coverage,
    however much of it actually ran.

    Accepts ``module:qualname`` (the exerciser's target id), ``path/to/f.py:name``
    or a bare ``name``. The file half is a HINT used to disambiguate a name that
    matches several symbols — never a requirement, so a target whose module path
    does not line up with its file still resolves.
    """
    store = open_identification_store(root, store_dir)
    try:
        head, _, tail = symbol.rpartition(":")
        name = (tail or symbol).rsplit(".", 1)[-1]
        candidates = [
            c
            for c in store.find_symbol_by_name(name)
            if c.get("node_type") != "doc_section"
        ]
        if not candidates:
            raise LookupError(
                f"No indexed symbol named {name!r} for {symbol!r} in {root}. Run "
                "`index index` to (re)build the code index, or check the name."
            )
        hint = head.replace(".", "/").replace("\\", "/").removesuffix(".py")
        best = candidates[0]
        if hint:
            for c in candidates:
                fp = str(c.get("file_path", "")).replace("\\", "/")
                if fp.removesuffix(".py").endswith(hint):
                    best = c
                    break
        if len(candidates) > 1:
            log.info(
                "symbol_entrypoint ambiguous symbol=%s candidates=%d chose=%s",
                symbol, len(candidates), best.get("file_path"),
            )
        return {
            "id": symbol,
            "kind": "function",
            "service_kind": "library",
            "trigger": symbol,
            "handler": best.get("name"),
            "file": best.get("file_path"),
            "line": int(best.get("start_line") or 0),
            "framework": "python",
        }
    finally:
        store.close()


def build_api_call_tree(
    project_root: Path,
    *,
    api_id: str | None = None,
    symbol: str | None = None,
    service: str | None = None,
    store_dir: str | None = None,
    max_depth: int = 12,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Build the call tree rooted at one entry point's handler from the code index.

    Deterministic: no traces, no running server, no frontend, no LLM/agent.  The
    The indexer already recorded symbol invoke edges. This walks that graph
    starting at the entry point's handler and recursively resolves each target.

    Identify the entry point by ``api_id`` — any ``id`` emitted by ``consolidate``
    (HTTP route, CLI command, worker, scheduler, hook).  The handler is located
    via the same code-based consolidation, so the index must exist — run discovery
    / ``index index`` first.

    Resolution remains name-aware to report ambiguous symbol names: a
    target that resolves to no indexed symbol is an external/library call and
    becomes a leaf (``resolved: false``); a name matching several symbols is
    resolved to the same-file candidate when present, else the lexicographically
    first, and flagged ``ambiguous: N``.  Each symbol is expanded once globally
    (repeat references are marked ``expanded_elsewhere``), which also breaks
    recursion cycles and bounds the output; ``max_depth`` caps recursion depth.
    """
    log = logger or logging.getLogger(__name__)
    root = project_root.resolve()

    if not api_id and not symbol:
        raise ValueError("build_api_call_tree needs either api_id or symbol")

    if symbol and not api_id:
        # Rooting at a symbol skips consolidation entirely: the target was never
        # declared as an entry point, so there is nothing to look it up in.
        target = _symbol_entrypoint(root, symbol, store_dir, log)
    else:
        # Reuse the verified code-based consolidation to find the handler + its file.
        inventory = list_service_apis(
            root,
            service=service,
            store_dir=store_dir,
            logger=log,
        )
        entrypoints = inventory.get("entrypoints", [])
        store_dir = inventory.get("index_store", store_dir)

        target = next((e for e in entrypoints if e.get("id") == api_id), None)
        if target is None:
            # A declared entry point wins, but the exerciser also drives symbols
            # that were never declared. Falling back keeps one entry per unit
            # rather than making the caller know which kind it has.
            if symbol:
                target = _symbol_entrypoint(root, symbol, store_dir, log)
            else:
                raise LookupError(
                    f"No entry point '{api_id}' in {root}. Run `identification consolidate` "
                    "to list available ids (their `id` field)."
                )

    handler = target.get("handler")
    rel_file = target.get("file")
    route_line = int(target.get("line") or 0)
    if not handler or not rel_file:
        # A guard that only calls externals (uvicorn.run(...), library mains)
        # has no in-repo function to root at. That is a fact about the script,
        # not a failure — return a degraded-but-valid document so the webview
        # renders the entry instead of a red error.
        note = (
            "This entry calls no function defined in this repository "
            "(e.g. its __main__ guard only invokes library code), so there is "
            "no in-repo call tree to build."
        )
        return {
            "status": "ok",
            "degraded": note,
            "entrypoint": {
                "id": target.get("id"),
                "kind": target.get("kind", "http_api"),
                "service_kind": target.get("service_kind", "http-service"),
                "method": target.get("method"),
                "path": target.get("path"),
                "trigger": target.get("trigger"),
                "handler": None,
                "file": rel_file,
                "line": route_line,
                "framework": target.get("framework"),
            },
            "code_root": str(root),
            "index_store": store_dir,
            "store_kind": None,
            "max_depth": max_depth,
            "stats": {"internal_functions": 0, "external_calls": 0, "max_depth_reached": 0},
            "tree": {
                "name": target.get("trigger") or target.get("id"),
                "file": rel_file,
                "line": route_line,
                "resolved": False,
                "children": [],
                "note": note,
            },
        }

    store = open_identification_store(root, store_dir)
    _find_by_name: dict[str, list[dict[str, Any]]] = {}

    def find_by_name(name: str) -> list[dict[str, Any]]:
        cached = _find_by_name.get(name)
        if cached is None:
            cached = store.find_symbol_by_name(name)
            _find_by_name[name] = cached
        return cached

    def resolve_target(
        target_name: str,
        caller_file: str,
        caller_lang: str | None,
        caller_sid: str | None = None,
    ) -> tuple[dict[str, Any] | None, int]:
        """Map a call name (possibly dotted, e.g. ``self.x.foo``) to one symbol.

        Candidates are first constrained to the caller's own language and to real
        callable symbols: a within-process call never targets another language or
        a documentation section, so a Python handler must not "call" a markdown
        ``doc_section`` or a TypeScript function merely because the names collide.
        Without this guard, name-only matching pulls unrelated symbols (docs, TS,
        sibling scripts) into the tree, inflating the denominator and fabricating
        whole "not run" subtrees.
        """
        simple = target_name.rsplit(".", 1)[-1]
        cands = find_by_name(simple)
        if not cands:
            return None, 0
        cands = [c for c in cands if c.get("node_type") != "doc_section"]
        if caller_lang:
            # Strict: a within-process call cannot cross languages, so if no
            # same-language symbol matches, treat it as external (unresolved)
            # rather than resolving to a foreign-language collision.
            cands = [c for c in cands if c.get("language") == caller_lang]
        if not cands:
            return None, 0
        receiver = target_name.rsplit(".", 1)[0] if "." in target_name else ""
        recv_root = receiver.split(".")[0] if receiver else ""
        through_receiver = bool(recv_root) and recv_root not in ("self", "cls", "this")
        if through_receiver:
            # A module-alias receiver names the file that defines the target
            # (``user_controller.provision_user`` → ``.../user_controller.py``).
            # That is import resolution by convention rather than a guess, so it
            # settles names duplicated across a monorepo's parallel services
            # (admin's ``provision_user`` vs payment's) that would otherwise be
            # abandoned as unresolved by the untyped-receiver rule below.
            by_module = [c for c in cands if Path(c["file_path"]).stem == recv_root]
            if len(by_module) == 1:
                return by_module[0], 1
            if caller_sid is not None:
                # A dotted call through an import/object alias (``swarm_service
                # as ds`` → ``ds.get_swarm``) is never the caller invoking
                # itself.  Drop the same-named self-collision so it resolves to
                # the real cross-module target instead of recursing back into
                # the caller's own function (which the same-file tie-break below
                # would otherwise pick).
                pruned = [c for c in cands if c["symbol_id"] != caller_sid]
                if pruned:
                    cands = pruned
        if receiver and simple in _UBIQUITOUS_METHODS:
            # A dotted call on a ubiquitous stdlib method name (``session.get``,
            # ``"…".format``) is a library call until proven otherwise: the
            # module-stem match above already had its chance, and same-file is
            # the only other trustworthy signal (a method of a class defined
            # here).  Critically it must not fall through to the unique-name
            # rule below — a repo with exactly one function named ``format``
            # would otherwise absorb every ``str.format`` call site in the tree.
            same = [c for c in cands if c["file_path"] == caller_file]
            if len(same) == 1:
                return same[0], len(cands)
            return None, 0
        if len(cands) == 1:
            return cands[0], 1
        if through_receiver:
            # Dotted call on an untyped receiver — a local variable / attribute
            # whose class we cannot infer (``p.exists()`` on a pathlib Path,
            # ``conn.execute()`` on a DB connection, ``pool.acquire()`` …).  With
            # >1 same-named project symbol there is no reliable way to pick the
            # intended one; guessing binds the call to an unrelated function and
            # fabricates an entire phantom subtree that never ran (this is what
            # inflated the denominator with sandbox/runs/audit trees the endpoint
            # never touches).  Treat as external/unresolved instead.
            #
            # Genuine cross-module calls are unaffected: a module-alias call such
            # as ``ds.get_swarm`` already returned above once self-collision
            # pruning left a single candidate, and unique dotted names still
            # resolve.  ``self.``/``cls.`` method calls also keep resolving (a
            # call on the caller's own object), disambiguated by the same-file
            # tie-break below.
            return None, 0
        same = [c for c in cands if c["file_path"] == caller_file]
        pool = same or cands
        chosen = sorted(pool, key=lambda s: (s["file_path"], s["start_line"]))[0]
        return chosen, len(cands)

    expanded: set[str] = set()
    unresolved: set[str] = set()
    internal: set[str] = set()
    depth_reached = 0

    def node_of(sym: dict[str, Any]) -> dict[str, Any]:
        return {
            "symbol_id": sym["symbol_id"],
            "name": _symbol_name(sym),
            "file": sym["file_path"],
            "line": sym["start_line"],
            "node_type": sym.get("node_type"),
        }

    def build(sym: dict[str, Any], depth: int) -> list[dict[str, Any]]:
        nonlocal depth_reached
        depth_reached = max(depth_reached, depth)
        children: list[dict[str, Any]] = []
        for tname in sorted(set(store.get_out_links(sym["symbol_id"]))):
            chosen, ambig = resolve_target(
                tname,
                sym["file_path"],
                sym.get("language"),
                sym["symbol_id"],
            )
            if chosen is None:
                unresolved.add(tname)
                children.append({"call": tname, "resolved": False})
                continue
            child: dict[str, Any] = {"call": tname, "resolved": True, **node_of(chosen)}
            if ambig > 1:
                child["ambiguous"] = ambig
            sid = chosen["symbol_id"]
            if sid in expanded:
                child["expanded_elsewhere"] = True
            elif depth + 1 > max_depth:
                child["truncated"] = "max_depth"
            else:
                expanded.add(sid)
                internal.add(sid)
                grand = build(chosen, depth + 1)
                if grand:
                    child["children"] = grand
            children.append(child)
        return children

    try:
        file_syms = [s for s in store.get_symbols_for_file(rel_file) if _symbol_name(s) == handler]
        if not file_syms:
            raise LookupError(f"Handler '{handler}' not found in index symbols for {rel_file}.")
        # Pick the symbol whose range best fits the route line: containing first,
        # else nearest by start_line.
        containing = [s for s in file_syms if s["start_line"] <= route_line <= s["end_line"]]
        root_sym = (
            max(containing, key=lambda s: s["start_line"])
            if containing
            else min(file_syms, key=lambda s: abs(s["start_line"] - route_line))
        )
        expanded.add(root_sym["symbol_id"])
        internal.add(root_sym["symbol_id"])
        tree = {**node_of(root_sym), "children": build(root_sym, 0)}
    finally:
        store.close()

    result: dict[str, Any] = {
        "status": "ok",
        "entrypoint": {
            "id": target.get("id"),
            "kind": target.get("kind", "http_api"),
            "service_kind": target.get("service_kind", "http-service"),
            "method": target.get("method"),
            "path": target.get("path"),
            "trigger": target.get("trigger"),
            "handler": handler,
            "file": rel_file,
            "line": route_line,
            "framework": target.get("framework"),
        },
        "code_root": str(root),
        "index_store": store.store_dir,
        "store_kind": store.kind,
        "max_depth": max_depth,
        "stats": {
            "internal_functions": len(internal),
            "external_calls": len(unresolved),
            "max_depth_reached": depth_reached,
        },
        "tree": tree,
    }

    log.info(
        "call_tree_done id=%s handler=%s internal=%d external=%d depth=%d",
        target.get("id"),
        handler,
        len(internal),
        len(unresolved),
        depth_reached,
    )

    out_dir = root / ".vinv" / "identification"
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        out_file = out_dir / f"{target.get('id')}.calltree.json"
        out_file.write_text(json.dumps(result, indent=2), encoding="utf-8")
        result["output_file"] = str(out_file)
    except OSError as exc:
        log.warning("Could not write call tree: %s", exc)

    return result


def render_call_tree_text(result: dict[str, Any]) -> str:
    """Render a call-tree ``result`` as an indented ASCII tree for the terminal."""
    ep = result.get("entrypoint", {})
    kind = ep.get("kind", "http_api")
    if kind == "http_api":
        header = f"{ep.get('method')} {ep.get('path')}"
    else:
        header = f"[{kind}] {ep.get('trigger') or ep.get('id')}"
    lines = [
        f"{header}  →  {ep.get('handler')}()" f"  [{ep.get('file')}:{ep.get('line')}]",
    ]

    def walk(node: dict[str, Any], prefix: str, is_last: bool, is_root: bool) -> None:
        if is_root:
            label = f"{node.get('name')}()  [{node.get('file')}:{node.get('line')}]"
            lines.append(label)
            branch_prefix = ""
        else:
            connector = "└─ " if is_last else "├─ "
            if node.get("resolved"):
                label = f"{node.get('name')}()  [{node.get('file')}:{node.get('line')}]"
                tags = []
                if node.get("ambiguous"):
                    tags.append(f"ambiguous×{node['ambiguous']}")
                if node.get("expanded_elsewhere"):
                    tags.append("↑ shown above")
                if node.get("truncated"):
                    tags.append("… max-depth")
                if tags:
                    label += "  (" + ", ".join(tags) + ")"
            else:
                label = f"{node.get('call')}  (external)"
            lines.append(prefix + connector + label)
            branch_prefix = prefix + ("   " if is_last else "│  ")
        children = node.get("children", [])
        for i, ch in enumerate(children):
            walk(ch, branch_prefix, i == len(children) - 1, False)

    walk(result.get("tree", {}), "", True, True)
    stats = result.get("stats", {})
    lines.append("")
    lines.append(
        f"{stats.get('internal_functions', 0)} internal functions, "
        f"{stats.get('external_calls', 0)} external calls, "
        f"depth {stats.get('max_depth_reached', 0)}"
    )
    return "\n".join(lines)


# =========================================================================
# tracemap — overlay a runtime trace onto the static call tree
# =========================================================================
#
# `calltree` is the STATIC tree derived from index invoke edges; a tracelens
# capture is the DYNAMIC record of what actually ran. `tracemap` joins the two,
# deterministically: it reconstructs the runtime call forest from the trace's
# enter/exit events, finds the request(s) in which the entry point's handler
# actually executed, and annotates every node of the static tree with whether it
# ran (call count, total duration, error status). It also surfaces the two gaps
# between code and reality — static functions that never executed, and runtime
# calls under the handler that the static tree never predicted.

# Source extensions whose files map onto Python import qualnames (the only
# language tracelens instruments — captures are `python_backend_only`).
_MODULE_EXTS = (".py", ".pyi")


def _file_to_module(rel: str) -> str:
    """Map a repo-relative source path to its dotted import module.

    ``vinvapp/api/controllers/tool_probe.py`` → ``vinvapp.api.controllers.tool_probe``.
    This mirrors how tracelens names spans (``component`` = ``module[.Class].func``),
    so a static symbol's ``file`` + ``name`` can be matched to a runtime component.
    """
    p = rel.replace("\\", "/")
    for ext in _MODULE_EXTS:
        if p.endswith(ext):
            p = p[: -len(ext)]
            break
    mod = p.strip("/").replace("/", ".")
    if mod.endswith(".__init__"):
        mod = mod[: -len(".__init__")]
    return mod


def _merge_stats(stats: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Sum per-component tallies into one, preserving the memory None/0 split."""
    out: dict[str, Any] = {
        "calls": 0,
        "total_ms": 0.0,
        "blocked_ms": 0.0,
        "mem_delta_bytes": None,
        "ok": 0,
        "error": 0,
        "errors": set(),
    }
    for st in stats:
        for k in ("calls", "total_ms", "blocked_ms", "ok", "error"):
            out[k] += st[k]
        out["errors"] |= st["errors"]
        if st["mem_delta_bytes"] is not None:
            out["mem_delta_bytes"] = (out["mem_delta_bytes"] or 0) + st["mem_delta_bytes"]
    return out


def _runtime_facts(st: dict[str, Any]) -> dict[str, Any]:
    """The runtime annotation carried by a node / runtime-only / middleware row.

    ``blocked_ms`` is always present (a span that never waited genuinely blocked
    for 0ms).  ``mem_delta_bytes`` is omitted entirely when nothing measured it,
    because the ``standard`` capture preset leaves memory attribution off and a
    literal 0 would read as "this function allocates nothing".
    """
    facts: dict[str, Any] = {
        "calls": st["calls"],
        "total_ms": round(st["total_ms"], 3),
        "blocked_ms": round(st["blocked_ms"], 3),
        "ok": st["ok"],
        "error": st["error"],
        "errors": sorted(st["errors"]),
    }
    if st["mem_delta_bytes"] is not None:
        facts["mem_delta_bytes"] = st["mem_delta_bytes"]
    return facts


def _qual_matches(component: str, module: str, name: str) -> bool:
    """True if a trace ``component`` refers to symbol ``name`` defined in ``module``.

    Trace components are ``module.func`` (module-level) or ``module.Class.func``
    (method); the static symbol only knows ``module`` + ``name``, not the class,
    so a one-segment class gap is tolerated.  The module comparison is
    suffix-tolerant so a leading-package mismatch (e.g. a ``src.`` layout, or the
    runtime fullname carrying an extra top package) still matches.
    """
    parts = component.split(".")
    if not parts or parts[-1] != name:
        return False
    cands = {".".join(parts[:-1])}  # module or module.Class
    if len(parts) >= 3:
        cands.add(".".join(parts[:-2]))  # drop one class segment
    for c in cands:
        if c == module or c.endswith("." + module) or module.endswith("." + c):
            return True
    return False


def _class_methods_executed(
    module: str,
    cls: str,
    components: Iterable[str],
) -> list[str]:
    """Runtime components that are methods of class ``cls`` defined in ``module``.

    A class/constructor static node (e.g. ``SwarmLibraryRepo()``) can never match
    a runtime span by name: ``__init__`` is not AST-instrumented and the class
    name is not a span leaf (spans are ``module.Class.method``).  So a class
    counts as executed when ANY of its methods ran — a component shaped
    ``<module>.<cls>.<method>`` whose owner module suffix-matches ``module``.
    """
    hits: list[str] = []
    for comp in components:
        parts = comp.split(".")
        for i in range(1, len(parts) - 1):  # need a trailing method segment
            if parts[i] != cls:
                continue
            owner = ".".join(parts[:i])
            if owner == module or owner.endswith("." + module) or module.endswith("." + owner):
                hits.append(comp)
                break
    return hits


def _load_trace_events(path: Path) -> list[dict[str, Any]]:
    """Read a tracelens ``trace.jsonl`` into a list of event dicts (invalid lines skipped)."""
    events: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                events.append(obj)
    return events


def _resolve_trace_files(root: Path, service: str | None, override: str | None) -> list[Path]:
    """Every capture a REPO-WIDE question should read, newest first.

    ``_resolve_trace_file`` answers "which single capture" — correct for
    ``tracemap``, which overlays one endpoint of one service.  It is wrong for
    ``tracesummary``, which ranks EVERY endpoint in the repo: picking the
    freshest capture means only whichever service ran last can be seen as
    exercised, and if that service's inbound spans match no consolidated
    endpoint, the summary reports nothing exercised anywhere.  Downstream that
    empties the insight manifest, which skips probes, which starves the whole
    pipeline — with "no observed endpoints" as the only symptom.

    An explicit ``override`` or ``service`` still narrows, because those are the
    caller saying they mean one capture.
    """
    if override:
        cand = Path(override).expanduser()
        if cand.is_file():
            return [cand]
        raise FileNotFoundError(f"--trace {cand} does not exist")

    caps = root / ".vinv" / "captures"
    found = [p for p in caps.rglob("trace.jsonl") if p.is_file() and p.stat().st_size > 0] if caps.is_dir() else []
    if service:
        narrowed = [p for p in found if p.parent.name == service]
        if narrowed:
            found = narrowed
    if not found:
        raise FileNotFoundError(
            f"No tracelens capture for {root} (no non-empty trace.jsonl under {caps}). "
            "Run a service under tracing to capture a trace first, or pass --trace."
        )
    return sorted(found, key=lambda p: p.stat().st_mtime, reverse=True)


def _resolve_trace_file(root: Path, service: str | None, override: str | None) -> Path:
    """Locate the tracelens capture for ``root``, raising if none exists.

    Probe order: explicit ``override`` → the freshest ``trace.jsonl`` anywhere
    under ``<repo>/.vinv/captures/`` whose parent directory matches ``service``
    → the freshest capture overall.

    Captures land under ``.vinv/captures/<session>/<service>/trace.jsonl``
    where ``<session>`` is whatever launched the run (``vinv-bringup``, the
    extension's service runner, an ad-hoc tracelens invocation). Hardcoding
    one session name meant live service runs were invisible to tracemap while
    a stale bringup smoke trace shadowed them — recency is the honest signal.
    """
    if override:
        cand = Path(override).expanduser()
        if cand.is_file():
            return cand
        raise FileNotFoundError(f"--trace {cand} does not exist")

    caps = root / ".vinv" / "captures"
    found: list[Path] = []
    if caps.is_dir():
        found = [p for p in caps.rglob("trace.jsonl") if p.is_file()]

    def _newest(paths: list[Path]) -> Path | None:
        live = [(p.stat().st_mtime, p) for p in paths if p.stat().st_size > 0]
        return max(live)[1] if live else None

    if service:
        matching = [p for p in found if p.parent.name == service]
        best = _newest(matching)
        if best is not None:
            return best
    best = _newest(found)
    if best is not None:
        return best

    raise FileNotFoundError(
        f"No tracelens capture for {root} (no non-empty trace.jsonl under {caps}). "
        "Run a service under tracing to capture a trace first, or pass --trace."
    )


def _reconstruct_forest(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rebuild the runtime call forest from enter/exit events.

    tracelens emits each span as an ``enter`` and a matching ``exit`` and writes
    them in *completion* order — a span's ``exit`` lands as soon as it closes, so
    a child (which finishes first) appears before its parent.  This yields a
    post-order stream regardless of how enter/exit interleave.  We therefore:

    1. Pair each ``exit`` with its open ``enter`` per ``(request_id, thread_id)``
       (a stack pop — robust to both completion-adjacent and live-interleaved
       layouts), recording each span in completion (post-order) order.
    2. Rebuild nesting from the recorded ``depth``: scanning post-order, a span
       at depth ``d`` adopts the already-built spans on the working stack whose
       depth is ``> d`` as its subtree.  ``depth`` is tracelens's true runtime
       call depth, so this recovers the exact parent→child structure even under
       async interleaving (which a naive enter-pushes-under-top stack mangles).
    """
    open_spans: dict[tuple[Any, Any], list[dict[str, Any]]] = {}
    # Completed spans per key, in completion (post-order) order.
    completed: dict[tuple[Any, Any], list[dict[str, Any]]] = {}

    for ev in events:
        key = (ev.get("request_id"), ev.get("thread_id"))
        kind = ev.get("event")
        if kind == "enter":
            depth = ev.get("depth")
            open_spans.setdefault(key, []).append(
                {
                    "component": ev.get("component", ""),
                    "request_id": ev.get("request_id"),
                    "depth": depth if isinstance(depth, int) else 0,
                    "children": [],
                    "duration_ms": 0.0,
                    # Wall time is not the same question as "was it working".
                    # ``blocked_ms`` is the part of the duration spent waiting on
                    # I/O, and ``mem_delta_bytes`` the net allocation across the
                    # call — both already on every exit span, both previously
                    # dropped here, so a function that only waits looked
                    # identical to one burning CPU.
                    "blocked_ms": 0.0,
                    "mem_delta_bytes": None,
                    "status": "ok",
                    "error_type": None,
                }
            )
        elif kind == "exit":
            stack = open_spans.get(key)
            if stack:
                node = stack.pop()
                node["duration_ms"] = float(ev.get("duration_ms") or 0.0)
                node["blocked_ms"] = float(ev.get("blocked_ms") or 0.0)
                # None (memory attribution off) must stay distinguishable from 0
                # (measured, allocated nothing) all the way to the surface.
                mem = ev.get("mem_delta_bytes")
                node["mem_delta_bytes"] = None if mem is None else int(mem)
                node["status"] = ev.get("status", "ok")
                node["error_type"] = ev.get("error_type")
                completed.setdefault(key, []).append(node)

    roots: list[dict[str, Any]] = []
    for spans in completed.values():
        build: list[dict[str, Any]] = []  # stack of subtrees not yet adopted
        for node in spans:
            d = node["depth"]
            kids: list[dict[str, Any]] = []
            while build and build[-1]["depth"] > d:
                kids.append(build.pop())
            kids.reverse()
            node["children"] = kids
            build.append(node)
        roots.extend(build)
    return roots


def _iter_runtime_nodes(node: dict[str, Any]):
    yield node
    for ch in node["children"]:
        yield from _iter_runtime_nodes(ch)


def _is_code_component(component: str) -> bool:
    """Whether a runtime component names a Python function rather than a framework span.

    tracelens records ASGI/request spans in the same stream as instrumented
    functions, but labels them with the route text — ``"GET /api/binaries"``,
    ``"GET /api/binaries http send"``.  A function component is always a dotted
    import path, so whitespace is the discriminator.
    """
    return bool(component) and "." in component and not any(c.isspace() for c in component)


def map_trace_to_tree(
    project_root: Path,
    *,
    api_id: str | None = None,
    symbol: str | None = None,
    trace: str | None = None,
    service: str | None = None,
    store_dir: str | None = None,
    max_depth: int = 12,
    request_id: str | None = None,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Overlay a runtime trace onto one entry point's static call tree.

    Deterministic: no running server, no LLM/agent.  Builds the static call tree
    with :func:`build_api_call_tree`, then reads a tracelens
    ``trace.jsonl`` and reconstructs the runtime call forest.  The entry point's
    request is identified by the request(s) in which its *handler* actually ran
    (robust to unresolved route prefixes).  Every resolved node of the static
    tree is annotated with its runtime fact — executed or not, call count, total
    duration, error status — and three gaps are reported: static functions that
    never executed, runtime calls under the handler the static tree missed, and
    (tagged ``middleware``) everything the request ran outside the handler's
    subtree, which a handler-rooted walk structurally cannot see.

    ``trace`` overrides the capture location; otherwise ``<repo>/.vinv/captures/
    vinv-bringup/<service>/trace.jsonl`` (and any sibling) is probed.
    ``request_id`` scopes the overlay to a single request.
    """
    log = logger or logging.getLogger(__name__)
    root = project_root.resolve()

    static = build_api_call_tree(
        root,
        api_id=api_id,
        symbol=symbol,
        service=service,
        store_dir=store_dir,
        max_depth=max_depth,
        logger=log,
    )
    ep = static["entrypoint"]
    handler = ep["handler"]
    rel_file = ep["file"]
    handler_module = _file_to_module(rel_file)

    trace_path = _resolve_trace_file(root, service, trace)
    events = _load_trace_events(trace_path)
    forest = _reconstruct_forest(events)

    # Requests where the handler actually ran (its subtree is what we overlay).
    handler_nodes: list[dict[str, Any]] = []
    for r in forest:
        for n in _iter_runtime_nodes(r):
            if request_id and n["request_id"] != request_id:
                continue
            if _qual_matches(n["component"], handler_module, handler):
                handler_nodes.append(n)
    matched_requests = sorted({n["request_id"] for n in handler_nodes})

    # Aggregate the runtime facts of every component under the handler subtree(s).
    runtime: dict[str, dict[str, Any]] = {}
    runtime_by_func: dict[str, list[str]] = {}

    def _tally(bucket: dict[str, dict[str, Any]], n: dict[str, Any]) -> None:
        comp = n["component"]
        st = bucket.get(comp)
        if st is None:
            st = {
                "calls": 0,
                "total_ms": 0.0,
                "blocked_ms": 0.0,
                # Stays None unless at least one span actually measured memory,
                # so "attribution was off" never renders as "allocated nothing".
                "mem_delta_bytes": None,
                "ok": 0,
                "error": 0,
                "errors": set(),
            }
            bucket[comp] = st
            if bucket is runtime:
                runtime_by_func.setdefault(comp.rsplit(".", 1)[-1], []).append(comp)
        st["calls"] += 1
        st["total_ms"] += n["duration_ms"]
        st["blocked_ms"] += n.get("blocked_ms") or 0.0
        if n.get("mem_delta_bytes") is not None:
            st["mem_delta_bytes"] = (st["mem_delta_bytes"] or 0) + n["mem_delta_bytes"]
        if n["status"] == "error":
            st["error"] += 1
            if n["error_type"]:
                st["errors"].add(n["error_type"])
        else:
            st["ok"] += 1

    def _record(n: dict[str, Any]) -> None:
        _tally(runtime, n)
        for ch in n["children"]:
            _record(ch)

    for hn in handler_nodes:
        _record(hn)

    # Everything else the request ran: middleware, auth, DI providers.  The
    # framework invokes these as SIBLINGS of the handler, so no walk rooted at
    # the handler can reach them — without this pass they are absent from the
    # tree AND from ``runtime_only``, and the report reads as if the request
    # consisted of the handler alone.  Scope is structural: "ran in a matched
    # request, outside the handler's subtree".
    handler_spans = {id(n) for hn in handler_nodes for n in _iter_runtime_nodes(hn)}
    matched = set(matched_requests)
    middleware: dict[str, dict[str, Any]] = {}
    for r in forest:
        if r["request_id"] not in matched:
            continue
        for n in _iter_runtime_nodes(r):
            if id(n) in handler_spans or not _is_code_component(n["component"]):
                continue
            _tally(middleware, n)

    # Annotate the static tree; track coverage by symbol and matched components.
    matched_components: set[str] = set()
    static_syms: dict[str, bool] = {}
    unobservable: set[str] = set()

    def _annotate(node: dict[str, Any]) -> None:
        name = node.get("name")
        file = node.get("file")
        if name and file:
            mod = _file_to_module(file)
            hit = next(
                (c for c in sorted(runtime_by_func.get(name, [])) if _qual_matches(c, mod, name)),
                None,
            )
            if hit is not None:
                matched_components.add(hit)
                st = runtime[hit]
                node["runtime"] = {"executed": True, **_runtime_facts(st)}
            elif node.get("node_type") == "class_definition" and (
                methods := _class_methods_executed(mod, name, runtime.keys())
            ):
                # Constructor/class node: no direct span exists, so credit it when
                # any of its methods ran and aggregate their runtime facts.
                for m in methods:
                    matched_components.add(m)
                node["runtime"] = {
                    "executed": True,
                    **_runtime_facts(_merge_stats(runtime[m] for m in methods)),
                    "via_methods": len(methods),
                }
                hit = methods[0]
            elif node.get("node_type") == "class_definition":
                # No direct span, and no method of it ran either.  That is NOT
                # evidence the class never ran: a Pydantic model, dataclass or
                # NamedTuple is constructed through a generated ``__init__``
                # the tracer never instruments, so it can be built on every
                # request and still leave no frame.  Flag it as unobservable
                # and keep it out of the coverage denominator below.
                node["runtime"] = {"executed": False, "observable": False}
            else:
                node["runtime"] = {"executed": False}
            sid = node.get("symbol_id")
            if sid and node["runtime"].get("observable", True):
                static_syms[sid] = static_syms.get(sid, False) or (hit is not None)
            elif sid:
                unobservable.add(sid)
        for ch in node.get("children", []):
            _annotate(ch)

    tree = static["tree"]
    _annotate(tree)

    # Runtime calls under the handler that the static tree never predicted.
    runtime_only = [
        {"component": comp, **_runtime_facts(st)}
        for comp, st in runtime.items()
        if comp not in matched_components
    ]
    runtime_only.sort(key=lambda d: (-d["total_ms"], d["component"]))

    middleware_entries = [
        {"component": comp, "scope": "middleware", **_runtime_facts(st)}
        for comp, st in middleware.items()
    ]
    middleware_entries.sort(key=lambda d: (-d["total_ms"], d["component"]))

    executed = sum(1 for v in static_syms.values() if v)
    total_static = len(static_syms)
    coverage = {
        "static_functions": total_static,
        "executed": executed,
        "never_executed": total_static - executed,
        "pct": round(100.0 * executed / total_static, 1) if total_static else 0.0,
        # Nodes the tracer cannot speak to either way, excluded from the ratio
        # above rather than silently scored as never-executed.
        "unobservable": len(unobservable - set(static_syms)),
    }

    result: dict[str, Any] = {
        "status": "ok",
        "entrypoint": ep,
        "code_root": str(root),
        "index_store": static.get("index_store"),
        "store_kind": static.get("store_kind"),
        "trace_file": str(trace_path),
        "max_depth": max_depth,
        "requests_matched": matched_requests,
        "handler_observed": bool(handler_nodes),
        "coverage": coverage,
        "runtime_only": runtime_only,
        "middleware": middleware_entries,
        "tree": tree,
    }

    log.info(
        "trace_map_done id=%s handler_observed=%s requests=%d executed=%d/%d runtime_only=%d",
        ep.get("id"),
        bool(handler_nodes),
        len(matched_requests),
        executed,
        total_static,
        len(runtime_only),
    )

    out_dir = root / ".vinv" / "identification"
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        out_file = out_dir / f"{ep.get('id')}.tracemap.json"
        out_file.write_text(json.dumps(result, indent=2), encoding="utf-8")
        result["output_file"] = str(out_file)
    except OSError as exc:
        log.warning("Could not write trace map: %s", exc)

    return result


def render_trace_map_text(result: dict[str, Any]) -> str:
    """Render a trace-map ``result`` as the static tree annotated with runtime facts."""
    ep = result.get("entrypoint", {})
    kind = ep.get("kind", "http_api")
    head = (
        f"{ep.get('method')} {ep.get('path')}"
        if kind == "http_api"
        else f"[{kind}] {ep.get('trigger') or ep.get('id')}"
    )
    cov = result.get("coverage", {})
    lines = [
        f"TRACE MAP — {head}  →  {ep.get('handler')}()",
        f"trace: {result.get('trace_file')}",
    ]
    if not result.get("handler_observed"):
        lines.append("")
        lines.append(
            "handler was NOT observed in the trace — the entry point did not run "
            "during this capture (nothing to overlay)."
        )
        return "\n".join(lines)
    reqs = result.get("requests_matched", [])
    lines.append(f"requests matched: {len(reqs)} ({', '.join(reqs) or '—'})")
    coverage_line = (
        f"coverage: {cov.get('executed', 0)}/{cov.get('static_functions', 0)} "
        f"static functions executed ({cov.get('pct', 0)}%)"
    )
    if cov.get("unobservable"):
        coverage_line += (
            f"  [+{cov['unobservable']} unobservable: class nodes with no traced "
            "method — neither confirmed nor denied]"
        )
    lines.append(coverage_line)
    lines.append("")

    def _runtime_tag(node: dict[str, Any]) -> str:
        rt = node.get("runtime")
        if not rt:
            return ""
        if not rt.get("executed"):
            return "  ? unobservable" if rt.get("observable") is False else "  ✗ not executed"
        tag = f"  ✓ ×{rt['calls']} ({rt['total_ms']}ms)"
        if rt.get("via_methods"):
            tag += f"  [via {rt['via_methods']} method(s)]"
        if rt.get("error"):
            tag += f"  ⚠ {rt['error']} err"
            if rt.get("errors"):
                tag += f" [{', '.join(rt['errors'])}]"
        return tag

    def walk(node: dict[str, Any], prefix: str, is_last: bool, is_root: bool) -> None:
        if is_root:
            label = f"{node.get('name')}()  [{node.get('file')}:{node.get('line')}]"
            lines.append(label + _runtime_tag(node))
            branch_prefix = ""
        else:
            connector = "└─ " if is_last else "├─ "
            if node.get("resolved"):
                label = f"{node.get('name')}()  [{node.get('file')}:{node.get('line')}]"
                meta = []
                if node.get("ambiguous"):
                    meta.append(f"ambiguous×{node['ambiguous']}")
                if node.get("expanded_elsewhere"):
                    meta.append("↑ shown above")
                if node.get("truncated"):
                    meta.append("… max-depth")
                if meta:
                    label += "  (" + ", ".join(meta) + ")"
                label += _runtime_tag(node)
            else:
                label = f"{node.get('call')}  (external)"
            lines.append(prefix + connector + label)
            branch_prefix = prefix + ("   " if is_last else "│  ")
        for i, ch in enumerate(node.get("children", [])):
            walk(ch, branch_prefix, i == len(node.get("children", [])) - 1, False)

    walk(result.get("tree", {}), "", True, True)

    runtime_only = result.get("runtime_only", [])
    if runtime_only:
        lines.append("")
        lines.append(
            f"runtime-only (ran under the handler, absent from the static tree): "
            f"{len(runtime_only)}"
        )
        for ro in runtime_only:
            err = f"  ⚠ [{', '.join(ro['errors'])}]" if ro.get("errors") else ""
            lines.append(f"  • {ro['component']}  ×{ro['calls']} ({ro['total_ms']}ms){err}")

    middleware = result.get("middleware", [])
    if middleware:
        lines.append("")
        lines.append(
            f"[middleware] ran in the request, outside the handler subtree "
            f"(middleware, auth, dependencies): {len(middleware)}"
        )
        for mw in middleware:
            err = f"  ⚠ [{', '.join(mw['errors'])}]" if mw.get("errors") else ""
            lines.append(
                f"  • [{mw['scope']}] {mw['component']}  "
                f"×{mw['calls']} ({mw['total_ms']}ms){err}"
            )

    return "\n".join(lines)


# =========================================================================
# tracesummary — the consolidate inventory ranked by how many trace requests
# exercised each endpoint (deterministic: code index + trace counts)
# =========================================================================

_HTTP_VERBS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"})


def _root_span_counts(events: list[dict[str, Any]]) -> dict[tuple[str, str], int]:
    """Count how many times each ``(METHOD, path)`` server root span was entered.

    tracelens names a request's server-side root span ``"<METHOD> <path>"``
    (e.g. ``"GET /v1/swarms"``) — exactly the method+path ``consolidate`` now
    resolves.  Outbound HTTP *client* spans carry an extra suffix
    (``"GET /v1/swarms http send"``) and are excluded by requiring the component
    to be precisely two whitespace-separated tokens (verb + path).

    Counts ENTER occurrences (invocations), not distinct ``request_id``s: a
    capture's ``request_id`` is a session/batch id shared across many endpoints,
    so distinct-request counting collapses every endpoint to 1 and can't rank
    them.  The enter count is the real "how often was this endpoint exercised".
    """
    counts: dict[tuple[str, str], int] = {}
    for ev in events:
        if ev.get("event") != "enter":
            continue
        parts = ev.get("component", "").split(" ")
        if len(parts) != 2:
            continue
        verb, path = parts[0].upper(), parts[1]
        if verb not in _HTTP_VERBS or not path.startswith("/"):
            continue
        counts[(verb, path)] = counts.get((verb, path), 0) + 1
    return counts


def summarize_traces(
    project_root: Path,
    *,
    service: str | None = None,
    store_dir: str | None = None,
    trace: str | None = None,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Rank every consolidated endpoint by how many trace requests exercised it.

    Deterministic: runs ``consolidate`` for the full endpoint inventory (with
    real runtime paths), then reads the tracelens capture and counts the distinct
    requests whose server root span is ``"<METHOD> <path>"`` for each endpoint.
    Endpoints are returned sorted by ``trace_count`` descending (then path), so
    the busiest APIs surface first; never-exercised endpoints sort last at 0.

    Also reports ``unmatched_roots`` — server roots seen in the trace that match
    no endpoint (e.g. a path whose prefix could not be resolved), so nothing in
    the capture is silently dropped.  Writes
    ``<repo>/.vinv/identification/tracesummary.json``.
    """
    log = logger or logging.getLogger(__name__)
    root = project_root.resolve()

    consolidated = list_service_apis(
        root,
        service=service,
        store_dir=store_dir,
        logger=log,
    )
    apis = consolidated.get("apis", [])

    # EVERY capture, not just the freshest. A repo with four traced services has
    # four captures, and reading one of them means three services' endpoints are
    # reported as never exercised — see _resolve_trace_files.
    trace_paths = _resolve_trace_files(root, service, trace)
    counts: dict[tuple[str, str], int] = {}
    for path in trace_paths:
        for key, n in _root_span_counts(_load_trace_events(path)).items():
            counts[key] = counts.get(key, 0) + n
    trace_path = trace_paths[0]

    matched: set[tuple[str, str]] = set()
    rows: list[dict[str, Any]] = []
    for a in apis:
        key = (a["method"].upper(), a["path"])
        n = counts.get(key, 0)
        if n:
            matched.add(key)
        rows.append(
            {
                "id": a["id"],
                "method": a["method"],
                "path": a["path"],
                "handler": a.get("handler"),
                "file": a.get("file"),
                "line": a.get("line"),
                "trace_count": n,
            }
        )
    rows.sort(key=lambda r: (-r["trace_count"], r["path"], r["method"]))

    unmatched = sorted(
        (
            {"root": f"{verb} {path}", "trace_count": n}
            for (verb, path), n in counts.items()
            if (verb, path) not in matched
        ),
        key=lambda r: (-r["trace_count"], r["root"]),
    )
    total_invocations = sum(counts.values())

    result: dict[str, Any] = {
        "status": "ok",
        "service": service,
        "code_root": str(root),
        # `trace_file` stays the newest capture for back-compat; `trace_files` is
        # the honest answer to "what was actually counted".
        "trace_file": str(trace_path),
        "trace_files": [str(p) for p in trace_paths],
        "api_count": len(rows),
        "exercised_count": sum(1 for r in rows if r["trace_count"]),
        "trace_invocations_total": total_invocations,
        "endpoints": rows,
        "unmatched_roots": unmatched,
    }

    log.info(
        "tracesummary_done apis=%d exercised=%d invocations=%d captures=%d",
        len(rows),
        result["exercised_count"],
        total_invocations,
        len(trace_paths),
    )

    out_dir = root / ".vinv" / "identification"
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "tracesummary.json").write_text(
            json.dumps(result, indent=2),
            encoding="utf-8",
        )
        result["output_file"] = str(out_dir / "tracesummary.json")
    except OSError as exc:
        log.warning("Could not write tracesummary.json: %s", exc)

    return result


def render_trace_summary_text(result: dict[str, Any]) -> str:
    """Render a trace-summary ``result`` as endpoints ranked by request count."""
    lines = [
        f"TRACE SUMMARY — {result.get('exercised_count', 0)}/"
        f"{result.get('api_count', 0)} endpoints exercised "
        f"({result.get('trace_invocations_total', 0)} endpoint invocations in capture)",
        f"trace: {result.get('trace_file')}",
        "",
    ]
    endpoints = result.get("endpoints", [])
    width = max((len(f"{e['method']} {e['path']}") for e in endpoints), default=0)
    for e in endpoints:
        route = f"{e['method']} {e['path']}".ljust(width)
        lines.append(f"  {e['trace_count']:>5}  {route}  → {e.get('handler') or '?'}()")
    unmatched = result.get("unmatched_roots", [])
    if unmatched:
        lines.append("")
        lines.append(
            f"unmatched trace roots (no endpoint resolved to this path): " f"{len(unmatched)}"
        )
        for u in unmatched:
            lines.append(f"  {u['trace_count']:>5}  {u['root']}")
    return "\n".join(lines)
