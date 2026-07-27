"""FP-17: the receiver-agnostic method backstop refused provably PURE targets.

`_IMPURE_METHOD_NAMES` matches a method NAME with no regard for what it is
called on. That is correct as a backstop — an unresolvable receiver must be
refused — but it also refused every target that mutates a container the caller
handed it:

    def dedupe(xs: list[int]) -> list[int]:
        xs.remove(0)          # list.remove, not os.remove -> was "impure"
        return xs

Nothing outside the process changes there, and the signature SAYS so. Losing
these costs coverage precisely on the small, self-contained functions the crash
harness drives best, and the loss is invisible: a refused target is simply
absent from the run.

The fix consults parameter annotations in `_resolve_receiver`, alongside the
module-level bindings and `self.<attr>` bindings it already consulted, and only
for CONCRETE builtin containers. The negative half of this file is the load
bearing half: an unknown receiver, an ABC, a union with a non-container member,
a reassigned name and a `*args` annotation must all keep being refused.
"""

from __future__ import annotations

import pytest

from exerciser.functions import (
    attribute_bindings,
    impurities_in_source,
    impurity_reasons,
    module_imports,
    module_method_defs,
    receiver_bindings,
)


def _reasons(src: str, fn: str = "process") -> list[str]:
    return impurities_in_source(src, fn)


class TestAnAnnotatedContainerReceiverIsPure:
    """The whole point: a stated builtin container type is evidence, not a guess."""

    @pytest.mark.parametrize(
        ("label", "src"),
        [
            (
                "list.remove",
                "def process(xs: list[int]) -> int:\n    xs.remove(3)\n    return len(xs)\n",
            ),
            (
                "set.remove",
                "def process(tags: set[str], tag: str) -> set:\n"
                "    tags.remove(tag)\n"
                "    return tags\n",
            ),
            (
                "bare list annotation",
                "def process(xs: list) -> list:\n    xs.remove(3)\n    return xs\n",
            ),
            (
                "typing.List alias",
                "import typing\n"
                "def process(xs: typing.List[int]) -> list:\n"
                "    xs.remove(3)\n"
                "    return xs\n",
            ),
            (
                "builtins-qualified",
                "def process(xs: builtins.list) -> list:\n    xs.remove(3)\n    return xs\n",
            ),
            (
                "optional container",
                "def process(xs: list[int] | None) -> None:\n"
                "    if xs is not None:\n"
                "        xs.remove(3)\n",
            ),
            (
                "keyword-only parameter",
                "def process(*, xs: list[int]) -> list:\n    xs.remove(3)\n    return xs\n",
            ),
            (
                "positional-only parameter",
                "def process(xs: list[int], /) -> list:\n    xs.remove(3)\n    return xs\n",
            ),
            # Names on the table that a container does not really own. They are
            # included because the RULE is "the receiver's type is known and its
            # whole method surface is confined to itself", not "this particular
            # method is harmless".
            (
                "dict.flush is not a filesystem flush",
                "def process(d: dict[str, int]) -> dict:\n    d.flush()\n    return d\n",
            ),
            (
                "bytearray.truncate",
                "def process(buf: bytearray) -> bytearray:\n    buf.truncate()\n    return buf\n",
            ),
        ],
    )
    def test_it_is_not_refused(self, label: str, src: str) -> None:
        assert _reasons(src) == [], f"{label}: an annotated container receiver is pure"

    def test_the_transitive_walk_agrees(self) -> None:
        """The exemption has to hold through the frontier, not just at depth 0."""
        src = (
            "def _prune(xs: list[int]) -> list:\n"
            "    xs.remove(3)\n"
            "    return xs\n"
            "def process(xs: list[int]) -> list:\n"
            "    return _prune(xs)\n"
        )
        assert _reasons(src) == []


class TestAnUnknownReceiverIsStillRefused:
    """The backstop must keep backstopping. Every case here MUST stay impure."""

    @pytest.mark.parametrize(
        ("label", "src"),
        [
            ("unannotated parameter", "def process(xs):\n    xs.remove(3)\n"),
            (
                "a class the guard cannot read",
                "from pathlib import Path\ndef process(p: Path):\n    p.unlink()\n",
            ),
            ("a job object", "def process(job: Job):\n    job.run()\n"),
            (
                "a DataFrame is not a builtin container",
                "def process(df: DataFrame):\n    df.drop(columns=['a'])\n",
            ),
            # `Sequence`/`Mapping` are PROTOCOLS: any user class may implement
            # them, so `rows.execute()` on a `Sequence[Row]` says nothing about
            # what actually runs.
            (
                "typing ABC",
                "from typing import Sequence\n"
                "def process(xs: Sequence[int]):\n"
                "    xs.remove(3)\n",
            ),
            (
                "mapping ABC",
                "from typing import Mapping\ndef process(m: Mapping):\n    m.flush()\n",
            ),
            (
                "union with a non-container member",
                "from pathlib import Path\n"
                "def process(x: list[int] | Path):\n"
                "    x.remove(3)\n",
            ),
            (
                "union of two different containers",
                "def process(x: list[int] | dict[str, int]):\n    x.remove(3)\n",
            ),
            (
                "a star-arg annotation describes the ELEMENT, not the tuple",
                "def process(*xs: list):\n    xs.remove(3)\n",
            ),
            (
                "a kwargs annotation describes the VALUE, not the dict",
                "def process(**kw: dict):\n    kw.flush()\n",
            ),
            (
                "a deeper chain on a container is unresolvable",
                "def process(xs: list[int]):\n    xs.log.remove(3)\n",
            ),
            (
                "a local variable, not a parameter",
                "def process(src):\n    xs = src\n    xs.remove(3)\n",
            ),
        ],
    )
    def test_it_is_refused(self, label: str, src: str) -> None:
        assert _reasons(src), f"{label}: an unknown receiver must stay refused"

    def test_a_reassigned_parameter_loses_its_annotation(self) -> None:
        """The annotation describes what was PASSED IN, not what the name holds later."""
        src = "def process(xs: list[int], other):\n    xs = other\n    xs.remove(3)\n"
        assert _reasons(src), "after a rebind the guard cannot know what xs is"

    def test_a_for_loop_target_also_counts_as_a_rebind(self) -> None:
        src = "def process(xs: list[int], rows):\n    for xs in rows:\n        xs.remove(3)\n"
        assert _reasons(src)

    def test_a_with_binding_also_counts_as_a_rebind(self) -> None:
        src = (
            "import contextlib\n"
            "def process(xs: list[int], ctx):\n"
            "    with ctx as xs:\n"
            "        xs.remove(3)\n"
        )
        assert _reasons(src)

    def test_a_tainted_module_receiver_wins_over_a_shadowing_parameter(self) -> None:
        """Resolution order is the pessimistic one: a taint can only be added."""
        src = (
            "import requests\n"
            "_session = requests.Session()\n"
            "def process(_session: list):\n"
            "    _session.remove(1)\n"
        )
        assert _reasons(src), "a module-level tainted receiver keeps its taint"

    def test_a_nested_shadow_of_the_same_name_is_dropped(self) -> None:
        """Two bindings for one name means the guard cannot say which one a call saw."""
        src = (
            "def process(xs: list[int]):\n"
            "    def inner(xs):\n"
            "        xs.remove(1)\n"
            "    inner(xs)\n"
        )
        assert _reasons(src)


class TestTheExemptionDoesNotLeak:
    """A pure container call in the body must not launder the rest of it."""

    def test_a_real_filesystem_call_beside_it_is_still_found(self) -> None:
        src = (
            "import os\n"
            "def process(xs: list[int], p: str):\n"
            "    xs.remove(3)\n"
            "    os.remove(p)\n"
        )
        reasons = _reasons(src)
        assert reasons, "os.remove must still be reported"
        assert any("os.remove" in r for r in reasons)

    def test_a_tainted_self_attribute_beside_it_is_still_found(self) -> None:
        """A container parameter in the same signature must not launder `self.session`."""
        src = (
            "import requests\n"
            "class Client:\n"
            "    def __init__(self):\n"
            "        self.session = requests.Session()\n"
            "    def send(self, xs: list[int]):\n"
            "        xs.remove(3)\n"
            "        self.session.delete('/x')\n"
        )
        imports = module_imports(src)
        reasons = impurity_reasons(
            "Client.send",
            module_method_defs(src),
            imports=imports,
            methods=module_method_defs(src),
            receivers=receiver_bindings(src, imports),
            attributes=attribute_bindings(src, imports),
        )
        # `impurity_reasons` does not pass `self_attrs` for the ROOT body (only
        # for the frontier), so this lands on the unresolvable-chain rule rather
        # than the receiver-taint rule. Either way it is REFUSED, which is the
        # property under test: the container parameter did not make the body pure.
        assert reasons, "the client call must still refuse the method"

    def test_a_write_open_on_a_container_named_parameter_is_still_found(self) -> None:
        """`_OPEN_NAMES` is a separate rule and the exemption must not reach it."""
        src = "def process(xs: list[int], p: str):\n    xs.remove(3)\n    open(p, 'w')\n"
        assert _reasons(src)
