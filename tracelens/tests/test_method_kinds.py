"""T3.3 — classmethod / staticmethod / property are correctly handled by the AST hook.

We instrument them by wrapping the underlying function before the ``@classmethod`` /
``@staticmethod`` decorator transforms it. The AST split-wrap places the decorator list
on the *outer* function, so decorator semantics are preserved.
"""

from __future__ import annotations

import ast

from tracelens.launcher.import_hook import _instrument_module


def _rewrite(src: str, fullname: str = "demo.mod") -> ast.Module:
    tree = ast.parse(src)
    rewritten = _instrument_module(tree, fullname, "/tmp/demo.py")
    ast.fix_missing_locations(rewritten)
    return rewritten


def test_classmethod_kept_as_classmethod() -> None:
    src = """
class Foo:
    @classmethod
    def bar(cls, x):
        return x + 1
"""
    rewritten = _rewrite(src)
    code = compile(rewritten, "<test>", "exec")
    ns: dict = {}
    # exec depends on tracelens.runtime being importable; we only care that the
    # tree compiles cleanly and that Foo.bar is decorated as a classmethod.
    exec(code, ns)
    foo = ns["Foo"]
    assert isinstance(foo.__dict__["bar"], classmethod)


def test_staticmethod_kept_as_staticmethod() -> None:
    src = """
class Foo:
    @staticmethod
    def bar(x):
        return x + 1
"""
    rewritten = _rewrite(src)
    code = compile(rewritten, "<test>", "exec")
    ns: dict = {}
    exec(code, ns)
    foo = ns["Foo"]
    assert isinstance(foo.__dict__["bar"], staticmethod)


def test_property_kept_as_property() -> None:
    src = """
class Foo:
    @property
    def bar(self):
        return 42
"""
    rewritten = _rewrite(src)
    code = compile(rewritten, "<test>", "exec")
    ns: dict = {}
    exec(code, ns)
    foo = ns["Foo"]
    assert isinstance(foo.__dict__["bar"], property)


def test_underscored_helper_now_instrumented() -> None:
    """T1.3 — `_internal_helper` was over-skipped under the old `startswith('_')` rule.

    With the new dunder-only default, single-underscore helpers should be wrapped.
    """
    src = """
def _internal_helper(x):
    return x * 2
"""
    rewritten = _rewrite(src)
    # An instrumented module produces 2 top-level FunctionDefs (inner + outer) plus the
    # tracelens.runtime import header. So body length > 1 means it was rewritten.
    func_count = sum(1 for n in rewritten.body if isinstance(n, ast.FunctionDef))
    # The header import + inner + outer means at least 2 FunctionDefs (inner, outer).
    assert func_count >= 2
