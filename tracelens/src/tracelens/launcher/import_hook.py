"""AST import hook (Python < 3.12 primary; also fallback when monitoring unavailable).

Carries diagnostics for T4.1 (per-module instrumentation result) and T1.3 (coverage scan).
"""

from __future__ import annotations

import ast
import importlib.abc
import importlib.machinery
import importlib.util
import logging
import os
import re
import sys
import tokenize
import types
from collections.abc import Sequence
from importlib.machinery import ModuleSpec
from types import ModuleType

_log = logging.getLogger("tracelens.diag")
_targets_cache: tuple[str, ...] = ()

# T4.1 — per-module rewrite outcomes, surfaced via ``rewrite_status()`` to the launcher's
# summary writer. Keys are fully-qualified module names; values are ``"ok:N_funcs"`` or
# ``"failed:<exc>"`` or ``"skipped:<reason>"``.
_module_status: dict[str, str] = {}


def rewrite_status() -> dict[str, str]:
    """Snapshot of per-module rewrite results so far. Called from the launcher's summary."""
    return dict(_module_status)


def _targets() -> tuple[str, ...]:
    global _targets_cache
    raw = os.environ.get("TRACELENS_TARGET_PACKAGES", "")
    _targets_cache = tuple(p.strip() for p in raw.split(",") if p.strip())
    return _targets_cache


def _want_module(fullname: str) -> bool:
    for p in _targets():
        if fullname == p or fullname.startswith(p + "."):
            return True
    return False


def _skip_site_packages(path: str) -> bool:
    if os.environ.get("TRACELENS_INSTRUMENT_THIRD_PARTY") == "1":
        return False
    norm = path.replace("\\", "/")
    return "site-packages" in norm


# Directory-style targets (see launcher/targets.py): a module qualifies when its
# resolved source file lives under one of these roots. Env-based like _targets()
# so the finder works in any process that inherited the launcher's environment.
def _target_roots() -> tuple[str, ...]:
    from tracelens.launcher import targets as _targets_mod

    return _targets_mod.roots_from_env()


# Never rewrite tracelens' own modules, even when its source checkout happens to
# live under a target root (monorepo layouts): wrap_call wrapping itself recurses.
_OWN_PACKAGE_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

# Path segments that mark third-party / derived trees inside a target root.
_ROOT_SKIP_SEGMENTS = ("site-packages", ".venv", "venv", "node_modules", "__pycache__")


def _origin_in_roots(origin: str, fullname: str) -> bool:
    roots = _target_roots()
    if not roots:
        return False
    if fullname == "tracelens" or fullname.startswith("tracelens."):
        return False
    try:
        real = os.path.realpath(origin)
    except OSError:
        return False
    if real == _OWN_PACKAGE_DIR or real.startswith(_OWN_PACKAGE_DIR + os.sep):
        return False
    parts = real.replace("\\", "/").split("/")
    if any(seg in parts for seg in _ROOT_SKIP_SEGMENTS):
        return False
    return any(real == r or real.startswith(r + os.sep) for r in roots)


def _is_tracelens_own_tests_tree(origin_path: str, fullname: str) -> bool:
    """Spec §20 #17: skip test_* only under the tool's tests tree, not user packages."""
    norm = origin_path.replace("\\", "/")
    if fullname.startswith("tracelens.tests."):
        return True
    if "/tracelens/tests/" in norm and "demo_app" not in norm:
        return True
    if norm.endswith("/tracelens/tests/__init__.py") or "/src/tracelens/tests/" in norm:
        return True
    return False


def _skip_test_name(name: str, origin_path: str, fullname: str) -> bool:
    return name.startswith("test_") and _is_tracelens_own_tests_tree(origin_path, fullname)


def _prepend_tracelens_import(body: list[ast.stmt]) -> list[ast.stmt]:
    """Insert ``from tracelens.runtime import trace_fn as _tracelens_tf``.

    Insertion rules (Python language constraints):

    1. Skip past a leading module docstring.
    2. Skip past **all** ``from __future__ import …`` statements — Python
       requires future-imports to appear before any other import, so our
       injected import must come AFTER them, not before.  Without this
       step, modules that begin with::

           \"\"\"docstring\"\"\"
           from __future__ import annotations
           import os

       fail to compile after rewrite with::

           SyntaxError: from __future__ imports must occur at the
           beginning of the file

       which is exactly the failure mode that silently disabled tracing
       for ~60 modules in target-repo (and any other repo using
       ``from __future__ import annotations`` at the top of files).

    3. If we already injected the import on a previous pass, return early
       so re-imports stay idempotent.
    """
    i = 0
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        if isinstance(body[0].value.value, str):
            i = 1
    while i < len(body):
        stmt = body[i]
        if not isinstance(stmt, ast.ImportFrom) or stmt.module != "__future__":
            break
        i += 1
    if i < len(body):
        imp_check = body[i]
        if isinstance(imp_check, ast.ImportFrom):
            if imp_check.module == "tracelens.runtime" and any(
                a.name == "trace_fn" for a in imp_check.names
            ):
                return body
    prep = ast.parse("from tracelens.runtime import trace_fn as _tracelens_tf\n").body
    return body[:i] + list(prep) + body[i:]


def _forward_call_pieces(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    *,
    skip_first_pos: bool = False,
) -> tuple[list[ast.expr], list[ast.keyword]]:
    """Build the positional + keyword forwarding lists for the inner call.

    ``skip_first_pos`` drops the very first positional argument from the
    forwarded list. Used when the inner is a bound method invoked through
    its receiver (``self.<inner_name>(...)``): Python implicitly passes
    the receiver as the first arg, so passing it again would duplicate it.
    """
    pos: list[ast.expr] = []
    posargs: list[ast.arg] = list(node.args.posonlyargs) + list(node.args.args)
    if skip_first_pos and posargs:
        posargs = posargs[1:]
    for a in posargs:
        pos.append(ast.Name(id=a.arg, ctx=ast.Load()))
    if node.args.vararg:
        pos.append(ast.Starred(ast.Name(id=node.args.vararg.arg, ctx=ast.Load()), ctx=ast.Load()))
    kws: list[ast.keyword] = []
    for a in node.args.kwonlyargs:
        kws.append(ast.keyword(arg=a.arg, value=ast.Name(id=a.arg, ctx=ast.Load())))
    if node.args.kwarg:
        kws.append(ast.keyword(arg=None, value=ast.Name(id=node.args.kwarg.arg, ctx=ast.Load())))
    return pos, kws


def _is_staticmethod(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    for d in node.decorator_list:
        if isinstance(d, ast.Name) and d.id == "staticmethod":
            return True
        if isinstance(d, ast.Attribute) and d.attr == "staticmethod":
            return True
    return False


def _property_role(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    """Return a stable role suffix so property accessors cannot collide."""
    for decorator in node.decorator_list:
        if isinstance(decorator, ast.Name) and decorator.id == "property":
            return "getter"
        if isinstance(decorator, ast.Attribute) and decorator.attr in {"setter", "deleter"}:
            return decorator.attr
    return "function"


def _is_protocol_class(node: ast.ClassDef) -> bool:
    """Protocols are structural declarations; wrapping adds false requirements."""
    for base in node.bases:
        if isinstance(base, ast.Name) and base.id == "Protocol":
            return True
        if isinstance(base, ast.Attribute) and base.attr == "Protocol":
            return True
    return False


def _split_wrapped(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    qual: str,
    *,
    receiver_arg: str | None = None,
    owner_class: str | None = None,
) -> tuple[ast.FunctionDef | ast.AsyncFunctionDef, ast.FunctionDef | ast.AsyncFunctionDef]:
    """Split ``node`` into ``(inner, outer)`` where ``outer`` calls ``wrap_call``.

    Reference-resolution strategy for the inner function:

    * ``receiver_arg`` set (instance / classmethod): inner is referenced as
      ``<receiver_arg>.<inner_name>`` because it lives on the class as a
      bound method.  The first positional argument is dropped from the
      forwarded args list because Python's bound-method call passes it
      implicitly.
    * ``owner_class`` set (staticmethod): inner is referenced as
      ``<owner_class>.<inner_name>``.  Bare-name lookup fails because
      Python function bodies cannot see their enclosing class's
      attributes by simple name — they must go through the class itself.
    * neither (module-level function): inner is referenced by its bare
      name, identical to the original behaviour.

    Without these fixes, every method on every class produced
    ``NameError: name '_tl_impl_<method>_<hash>' is not defined`` at
    runtime, silently disabling instrumentation for OOP-heavy modules
    like ``parsing/pkg.py``.
    """
    role = _property_role(node)
    inner_name = f"_tl_impl_{node.name}_{role}_{abs(hash(qual)) % 10_000_000}"
    is_async = isinstance(node, ast.AsyncFunctionDef)
    cls = ast.AsyncFunctionDef if is_async else ast.FunctionDef
    # Preserve @classmethod / @staticmethod on the inner so its bind
    # behaviour matches the outer.  Without this:
    #   * @classmethod outer + bare-function inner → ``cls.inner(by)`` calls
    #     ``inner(by)`` with ``by`` bound to position 0 (which is ``cls``
    #     in the inner's signature) — wrong receiver.
    #   * @staticmethod outer + bare-function inner → similar mismatch when
    #     the wrapper is callable as ``Class.outer(a, b)``.
    # Other decorators are intentionally dropped from the inner so they
    # don't double-fire (e.g. an ``@app.get(...)`` route registration must
    # only happen once, on the outer).
    _bind_decorators: list[ast.expr] = [
        d
        for d in node.decorator_list
        if (isinstance(d, ast.Name) and d.id in ("classmethod", "staticmethod"))
        or (isinstance(d, ast.Attribute) and d.attr in ("classmethod", "staticmethod"))
    ]
    # Implicit-classmethod case (e.g. pydantic v1 ``@validator``): the method's
    # first arg is ``cls`` and it is invoked with the *class* as receiver, but it
    # carries no literal ``@classmethod`` decorator. We reference the inner as
    # ``cls.<inner_name>`` and drop the first positional arg (``skip_first``),
    # which only binds correctly if the inner is a classmethod. Accessing a
    # plain-function inner through the *class* does NOT bind, so ``cls`` would be
    # silently dropped and the call fails with
    # ``missing 1 required positional argument`` (real prod traceback:
    # ``AuditRequestData._tl_impl_validate_method_...() missing ... argument 'v'``).
    # Adding ``@classmethod`` here makes the bound-receiver call convention hold.
    if receiver_arg == "cls" and not _bind_decorators:
        _bind_decorators = [ast.Name(id="classmethod", ctx=ast.Load())]
    inner = cls(
        name=inner_name,
        args=node.args,
        body=list(node.body),
        decorator_list=_bind_decorators,
        returns=node.returns,
    )
    ast.copy_location(inner, node)

    skip_first = receiver_arg is not None
    pos, kws = _forward_call_pieces(node, skip_first_pos=skip_first)

    if receiver_arg is not None:
        inner_ref: ast.expr = ast.Attribute(
            value=ast.Name(id=receiver_arg, ctx=ast.Load()),
            attr=inner_name,
            ctx=ast.Load(),
        )
    elif owner_class is not None:
        inner_ref = ast.Attribute(
            value=ast.Name(id=owner_class, ctx=ast.Load()),
            attr=inner_name,
            ctx=ast.Load(),
        )
    else:
        inner_ref = ast.Name(id=inner_name, ctx=ast.Load())

    wrap_name = "wrap_call_async" if is_async else "wrap_call"
    call = ast.Call(
        func=ast.Attribute(
            value=ast.Name(id="_tracelens_tf", ctx=ast.Load()),
            attr=wrap_name,
            ctx=ast.Load(),
        ),
        args=[ast.Constant(value=qual), inner_ref] + pos,
        keywords=kws,
    )
    if is_async:
        ret = ast.Return(value=ast.Await(value=call))
    else:
        ret = ast.Return(value=call)
    outer_body: list[ast.stmt] = []
    if (
        node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
        and isinstance(node.body[0].value.value, str)
    ):
        doc = ast.Expr(value=ast.Constant(value=node.body[0].value.value))
        ast.copy_location(doc, node.body[0])
        outer_body.append(doc)
    outer_body.append(ret)
    outer = cls(
        name=node.name,
        args=node.args,
        body=outer_body,
        decorator_list=list(node.decorator_list),
        returns=node.returns,
    )
    ast.copy_location(outer, node)
    return inner, outer


def _method_receiver_arg(item: ast.FunctionDef | ast.AsyncFunctionDef) -> str | None:
    """Return the receiver-arg name for a class method, or ``None``.

    * ``None`` for staticmethods (no receiver — call as a bare function).
    * ``None`` for methods with zero positional args (rare; cannot infer
      a receiver, so fall back to bare-name reference and accept that
      Python will raise at call time if anyone tries to invoke it).
    * Otherwise the first positional argument's name (typically ``self``
      or ``cls``).
    """
    if _is_staticmethod(item):
        return None
    posargs = list(item.args.posonlyargs) + list(item.args.args)
    if not posargs:
        return None
    return posargs[0].arg


def _instrument_module(tree: ast.Module, fullname: str, origin_path: str) -> ast.Module:
    """T3.2: generators get wrapped at the function-call boundary (the iterator-creation
    moment) but their body is left untouched. The wrapper opens a span that closes when the
    generator object is constructed; per-yield instrumentation is a separate workstream.
    """
    new_body: list[ast.stmt] = []
    fcount = 0
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            if node.name.startswith("Test") or _is_protocol_class(node):
                new_body.append(node)
                continue
            nb: list[ast.stmt] = []
            for item in node.body:
                if isinstance(item, ast.FunctionDef | ast.AsyncFunctionDef):
                    if _bad_name(item.name) or _skip_test_name(item.name, origin_path, fullname):
                        nb.append(item)
                    elif _has_yield(item):
                        # T3.2: generators kept as-is for v1; documented limitation.
                        nb.append(item)
                    else:
                        qual = f"{fullname}.{node.name}.{item.name}"
                        receiver = _method_receiver_arg(item)
                        # Staticmethods have no receiver arg; fall back to
                        # ``ClassName.<inner_name>`` lookup so the wrapper
                        # body can find the inner descriptor.
                        owner = node.name if (receiver is None and _is_staticmethod(item)) else None
                        inner, outer = _split_wrapped(
                            item,
                            qual,
                            receiver_arg=receiver,
                            owner_class=owner,
                        )
                        nb.extend([inner, outer])
                        fcount += 1
                else:
                    nb.append(item)
            node.body = nb
            new_body.append(node)
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            if _bad_name(node.name) or _skip_test_name(node.name, origin_path, fullname):
                new_body.append(node)
            elif _has_yield(node):
                new_body.append(node)
            else:
                qual = f"{fullname}.{node.name}"
                inner, outer = _split_wrapped(node, qual)
                new_body.extend([inner, outer])
                fcount += 1
        else:
            new_body.append(node)
    _module_status[fullname] = f"ok:{fcount}_funcs"
    tree.body = _prepend_tracelens_import(new_body)
    return tree


class _InstrumentingLoader(importlib.machinery.SourceFileLoader):
    def get_code(self, fullname: str) -> types.CodeType | None:
        code = super().get_code(fullname)
        if code is None or self.path is None:
            return code
        if _skip_site_packages(self.path):
            _module_status[fullname] = "skipped:site_packages"
            return code
        try:
            with tokenize.open(self.path) as fh:
                src = fh.read()
            tree = ast.parse(src, filename=self.path)
            new_tree = _instrument_module(tree, fullname, self.path)
            ast.fix_missing_locations(new_tree)
            return compile(new_tree, self.path, "exec", dont_inherit=True)
        except BaseException as exc:  # noqa: BLE001 — never crash the target's import
            _module_status[fullname] = f"failed:{type(exc).__name__}:{exc}"
            _log.warning(
                "tracelens AST rewrite failed for %s (%s); falling back to original bytecode",
                fullname,
                type(exc).__name__,
            )
            return code


class TracelensFinder(importlib.abc.MetaPathFinder):
    @staticmethod
    def find_spec(
        fullname: str,
        path: Sequence[str] | None,
        target: ModuleType | None = None,
    ) -> ModuleSpec | None:
        del target
        name_match = _want_module(fullname)
        if not name_match and not _target_roots():
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec is None or spec.origin is None or not spec.has_location:
            return None
        if spec.loader is None:
            return None
        if not isinstance(spec.loader, importlib.machinery.SourceFileLoader):
            return None
        if not name_match and not _origin_in_roots(spec.origin, fullname):
            return None
        loader = _InstrumentingLoader(fullname, spec.origin)
        new_spec = importlib.util.spec_from_file_location(
            fullname,
            spec.origin,
            loader=loader,
            submodule_search_locations=spec.submodule_search_locations,
        )
        return new_spec


_INSTALLED = False


def install() -> None:
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True
    sys.meta_path.insert(0, TracelensFinder())


def _bad_name(name: str) -> bool:
    """T1.3 — configurable skip pattern.

    Default: only dunder names (``__init__``, ``__call__``, …). User can override with
    ``TRACELENS_SKIP_PATTERN`` (a regex). Old behaviour was ``startswith("_")`` which over-
    skipped underscored helpers like ``_internal_hot_loop`` that are exactly what we want
    to instrument.
    """
    pat = os.environ.get("TRACELENS_SKIP_PATTERN") or r"^__.*__$"
    try:
        return bool(re.match(pat, name))
    except re.error:
        return name.startswith("__") and name.endswith("__")


def _has_yield(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    class V(ast.NodeVisitor):
        def __init__(self) -> None:
            self.y = False

        def visit_Yield(self, n: ast.Yield) -> None:  # noqa: N802
            self.y = True

        def visit_YieldFrom(self, n: ast.YieldFrom) -> None:  # noqa: N802
            self.y = True

    v = V()
    for s in node.body:
        v.visit(s)
    return v.y
