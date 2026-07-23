"""Regression test for class-method rewriting in the AST hook.

Bug history (2026-05-04):
  ``_split_wrapped`` produced a wrapper that referenced the inner
  function by its bare name even when the inner lived inside a class.
  At call time Python raised::

      NameError: name '_tl_impl_close_3692079' is not defined.
      Did you mean: 'self._tl_impl_close_3692079'?

  Every method on every class in every instrumented module was broken,
  silently disabling tracing for OOP-heavy modules (e.g. ``parsing/pkg.py``
  which holds the Neo4j driver wrapper used by every API handler in target-repo).

The fix introduces a ``receiver_arg`` kwarg to ``_split_wrapped`` and a
``_method_receiver_arg`` helper that picks the right receiver based on
the method's decorator list and arg signature:

  * Instance methods → ``self`` (first arg name)
  * Classmethods    → ``cls`` (first arg name)
  * Staticmethods   → ``None`` (bare-name reference, like module-level fns)

The wrapper then references the inner via ``self.<inner_name>`` (or
``cls.<inner_name>``), and the first positional arg is dropped from the
forwarded call to avoid double-passing the receiver.
"""

from __future__ import annotations

import ast
import textwrap

from tracelens.launcher.import_hook import _instrument_module


def _execute(src: str) -> dict:
    """AST-rewrite ``src``, exec it in a stub namespace, return the namespace.

    Provides a minimal ``_tracelens_tf`` stub so the rewritten code can run
    without importing tracelens.runtime — we want to assert the rewrite
    *shape* compiles & evaluates correctly, not the runtime semantics.
    """
    tree = ast.parse(textwrap.dedent(src))
    new_tree = _instrument_module(tree, "demo_mod", "/tmp/demo_mod.py")
    ast.fix_missing_locations(new_tree)
    code = compile(new_tree, "<demo_mod>", "exec")

    class _StubTF:
        @staticmethod
        def wrap_call(qual, fn, *args, **kwargs):
            return fn(*args, **kwargs)

        @staticmethod
        async def wrap_call_async(qual, fn, *args, **kwargs):
            return await fn(*args, **kwargs)

    ns: dict = {"_tracelens_tf": _StubTF}
    exec(code, ns)
    return ns


def test_instance_method_uses_self_receiver() -> None:
    """A regular instance method must call ``self.<inner_name>(...)``."""
    ns = _execute(
        """
        class Foo:
            def __init__(self, x):
                self.x = x

            def double(self) -> int:
                return self.x * 2
        """
    )
    foo = ns["Foo"](5)
    assert foo.double() == 10  # would raise NameError before the fix


def test_method_with_args_and_kwargs() -> None:
    ns = _execute(
        """
        class Calc:
            def __init__(self, base):
                self.base = base

            def combine(self, x, y, *, scale=1):
                return (self.base + x + y) * scale
        """
    )
    c = ns["Calc"](10)
    assert c.combine(1, 2) == 13
    assert c.combine(1, 2, scale=2) == 26


def test_classmethod_uses_cls_receiver() -> None:
    ns = _execute(
        """
        class Counter:
            n = 0

            @classmethod
            def bump(cls, by=1):
                cls.n += by
                return cls.n
        """
    )
    Counter = ns["Counter"]
    assert Counter.bump() == 1
    assert Counter.bump(5) == 6


def test_staticmethod_decorator_preserved_on_inner() -> None:
    """Staticmethods have no receiver, so the wrapper uses bare-name
    lookup.  For that to work the inner function must ALSO be a
    staticmethod — otherwise the bare-name reference resolves to the
    descriptor wrapper which Python wraps in a function-not-found error
    when accessed without going through the class.

    The fix copies ``@staticmethod`` / ``@classmethod`` decorators
    from the outer to the inner so binding behaviour matches.
    """
    ns = _execute(
        """
        class Helper:
            @staticmethod
            def add(a, b):
                return a + b
        """
    )
    Helper = ns["Helper"]
    assert Helper.add(2, 3) == 5
    assert Helper().add(7, 8) == 15


def test_module_level_function_unchanged() -> None:
    """Module-level functions still use bare-name references (no regression)."""
    ns = _execute(
        """
        def add(a, b):
            return a + b
        """
    )
    assert ns["add"](2, 3) == 5


def test_inheritance_with_super_call() -> None:
    """Methods that call ``super()`` must still work after rewrite.

    Zero-arg ``super()`` requires being lexically inside a class body, so
    extracting the inner to module level would break this — confirming
    the receiver-attribute approach is correct.
    """
    ns = _execute(
        """
        class Base:
            def greet(self):
                return "hello"

        class Child(Base):
            def greet(self):
                return super().greet() + " world"
        """
    )
    c = ns["Child"]()
    assert c.greet() == "hello world"


def test_async_method_uses_self_receiver() -> None:
    """Async methods inside classes must also receive the ``self.`` fix."""
    import asyncio

    ns = _execute(
        """
        class AsyncCalc:
            def __init__(self, base):
                self.base = base

            async def add(self, x):
                return self.base + x
        """
    )
    c = ns["AsyncCalc"](10)
    result = asyncio.run(c.add(5))
    assert result == 15


def test_property_getter_and_setter_both_work() -> None:
    """A setter must not overwrite the extracted getter implementation."""
    ns = _execute(
        """
        class Item:
            def __init__(self):
                self._value = 1

            @property
            def value(self):
                return self._value

            @value.setter
            def value(self, new_value):
                self._value = new_value
        """
    )
    item = ns["Item"]()
    assert item.value == 1
    item.value = 7
    assert item.value == 7


def test_wrapped_function_docstring_is_preserved() -> None:
    ns = _execute(
        '''
        def documented():
            """Public API documentation."""
            return 42
        '''
    )
    assert ns["documented"].__doc__ == "Public API documentation."


def test_runtime_checkable_protocol_result_is_preserved() -> None:
    """Generated implementation names must not become protocol requirements."""
    ns = _execute(
        """
        from typing import Protocol, runtime_checkable

        @runtime_checkable
        class Runnable(Protocol):
            def run(self) -> int:
                ...

        class Worker:
            def run(self) -> int:
                return 1

        protocol_result = isinstance(Worker(), Runnable)
        """
    )
    assert ns["protocol_result"] is True
