"""Regression: AST rewrite of pydantic-v1-style ``@validator`` methods.

Bug history (2026-07-01):
  A method whose first arg is ``cls`` but which carries no literal
  ``@classmethod`` decorator (the exact shape of a pydantic v1
  ``@validator``) was split into an inner *plain function* referenced as
  ``cls._tl_impl_<name>(v)`` with the first positional arg dropped
  (``skip_first``). Accessing a plain function through the *class* does not
  bind, so ``v`` landed in the ``cls`` slot and the real ``v`` went missing::

      TypeError: AuditRequestData._tl_impl_validate_method_7639383()
                 missing 1 required positional argument: 'v'

  Every request that built a model with a v1-style validator returned
  HTTP 500. The fix adds ``@classmethod`` to the inner when the receiver is
  ``cls`` and no literal classmethod/staticmethod decorator is present, so the
  ``cls.<inner>`` bound-call convention holds.
"""

from __future__ import annotations

import ast
import textwrap

from tracelens.launcher.import_hook import _instrument_module


def _execute(src: str) -> dict:
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


def test_cls_first_arg_without_classmethod_decorator() -> None:
    """A ``(cls, v)`` method with a non-classmethod decorator must still run.

    ``passthrough`` stands in for pydantic's ``@validator`` — a decorator that
    is neither classmethod nor staticmethod. Pydantic invokes such a validator
    with the *class* supplied as ``cls``; we mirror that by passing the class
    explicitly. The inner must bind ``cls`` so ``v`` is not dropped.
    """
    ns = _execute(
        """
        def passthrough(*dargs):
            def deco(fn):
                return fn
            return deco

        class Model:
            @passthrough("method")
            def validate_method(cls, v):
                return v.upper()
        """
    )
    Model = ns["Model"]
    # Pydantic-style invocation: the class is passed as the ``cls`` receiver.
    # Before the fix this raised: missing 1 required positional argument: 'v'.
    assert Model.validate_method(Model, "get") == "GET"


def test_real_pydantic_v1_validator_end_to_end() -> None:
    """Faithful repro: build a model whose validator body is AST-rewritten."""
    import pytest

    pydantic = pytest.importorskip("pydantic")
    from pydantic import validator

    ns = _execute(
        """
        from pydantic import BaseModel, validator

        class AuditRequestData(BaseModel):
            method: str

            @validator("method")
            def validate_method(cls, v):
                return v.upper()
        """
    )
    AuditRequestData = ns["AuditRequestData"]
    # Previously raised: missing 1 required positional argument: 'v'
    assert AuditRequestData(method="get").method == "GET"
    del validator, pydantic


def test_genuine_classmethod_still_works() -> None:
    """Ensure the fix doesn't disturb real ``@classmethod`` methods."""
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


def test_instance_method_with_cls_named_first_arg_unaffected() -> None:
    """Instance methods use ``self`` and must be untouched by the cls fix."""
    ns = _execute(
        """
        class Foo:
            def __init__(self, x):
                self.x = x

            def double(self):
                return self.x * 2
        """
    )
    assert ns["Foo"](5).double() == 10
