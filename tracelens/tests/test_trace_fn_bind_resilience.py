"""Regression: tracelens's own arg-enrichment must never break the wrapped call.

``wrap_call`` computes an ``inspect.Signature.bind`` over the target's args purely
to attach span metadata (args_hash/schema/summary). Some callables are invoked with
an arg shape that ``bind`` cannot reconcile with the declared signature — notably
pydantic v1 validators driven through descriptor machinery — even though calling the
function directly works fine. Enrichment failure there previously raised
``TypeError: missing a required argument`` straight into the user's request path
(HTTP 500). Binding must degrade to "skip arg attributes", not crash.
"""

from __future__ import annotations

import asyncio
import inspect

import pytest

from tracelens.runtime import trace_fn


def test_wrap_call_survives_unbindable_signature() -> None:
    # impl runs on one positional arg, but its *declared* signature says it needs
    # two (cls, v) — exactly the pydantic-v1-validator shape. sig.bind(one_arg)
    # raises TypeError; the call itself must still succeed and return normally.
    def impl(*args: object) -> str:
        return str(args[-1]).upper()

    impl.__signature__ = inspect.Signature(  # type: ignore[attr-defined]
        [
            inspect.Parameter("cls", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            inspect.Parameter("v", inspect.Parameter.POSITIONAL_OR_KEYWORD),
        ]
    )
    # sanity: the bind really does blow up the way it did in prod
    with pytest.raises(TypeError):
        inspect.signature(impl).bind("get")

    assert trace_fn.wrap_call("pkg.validate_method", impl, "get") == "GET"


def test_wrap_call_async_survives_unbindable_signature() -> None:
    async def impl(*args: object) -> str:
        return str(args[-1]).lower()

    impl.__signature__ = inspect.Signature(  # type: ignore[attr-defined]
        [
            inspect.Parameter("cls", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            inspect.Parameter("v", inspect.Parameter.POSITIONAL_OR_KEYWORD),
        ]
    )
    out = asyncio.run(trace_fn.wrap_call_async("pkg.avalidate", impl, "GET"))
    assert out == "get"


def test_wrap_call_still_binds_normal_signature() -> None:
    # The happy path must be unaffected: a normal signature still runs.
    def add(a: int, b: int = 3) -> int:
        return a + b

    assert trace_fn.wrap_call("pkg.add", add, 4) == 7
    assert trace_fn.wrap_call("pkg.add", add, 4, b=10) == 14


def test_wrap_call_propagates_real_impl_errors() -> None:
    # Best-effort binding must NOT swallow genuine exceptions from the target.
    def boom(x: int) -> int:
        raise ValueError("real failure")

    with pytest.raises(ValueError, match="real failure"):
        trace_fn.wrap_call("pkg.boom", boom, 1)


def test_pydantic_v1_validator_under_wrap_call() -> None:
    # Faithful end-to-end repro using the same legacy-validator machinery seen in
    # the traceback (pydantic._internal._decorators_v1). Building the model must
    # not raise out of tracelens's wrapper.
    pydantic = pytest.importorskip("pydantic")
    from pydantic import validator  # legacy v1-style validator (v2 compat shim)

    class M(pydantic.BaseModel):
        method: str

        @validator("method")
        def _upper(cls, v):  # noqa: N805 — classic v1 signature (cls, v)
            # Route the validator body through tracelens exactly like the AST
            # rewrite does, so sig.bind runs against (cls, v).
            def _impl(cls, v):
                return v.upper()

            return trace_fn.wrap_call("pkg._upper", _impl, cls, v)

    assert M(method="get").method == "GET"
