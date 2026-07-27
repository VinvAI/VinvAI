"""Every spelling of a type must yield the same faults (audit FP-20, FP-21).

FP-20 was execution-verified: `typing.Optional[str]` produced ONE fault where
`str | None` produced four — a 75% fault loss on every optional parameter. The
cause is that `getattr(ann, '__name__')`, the usual "pretty type name" recipe,
returns the CONSTRUCTOR name for a typing alias, discarding its parameters.
`list[int]`/`dict[...]` survived only by accident (the lowercased constructor
name still starts with "list"/"dict"), which is exactly why casual testing
looked fine — and the single existing test used `str | None`, the one spelling
that worked.

FP-21: the campaign passed no kwargs, so every concurrency target was called
`fn()`. A function with a required parameter raised TypeError in BOTH the serial
baseline and the concurrent batch; because the two agreed, the oracle did not
merely miss the race — it CERTIFIED the target as concurrency-safe.
"""

from __future__ import annotations

import typing

import pytest

from exerciser.faults import _parse_typespec, catalogue_faults

#: How a real `inspect.signature` renders each annotation, both ways.
_SPELLINGS = {
    "optional-str": ["Optional[str]", "typing.Optional[str]", "str | None", "Union[str, None]"],
    "optional-int": ["Optional[int]", "typing.Optional[int]", "int | None"],
    "plain-str": ["str", "builtins.str"],
    "list-int": ["list[int]", "typing.List[int]", "List[int]"],
}


class TestTypespecParsing:
    @pytest.mark.parametrize("spec", _SPELLINGS["optional-str"])
    def test_every_optional_str_spelling_admits_none_and_resolves_str(self, spec: str) -> None:
        _, optional, base = _parse_typespec(spec)
        assert optional, f"{spec} must admit None"
        assert base == "str", f"{spec} must resolve its member type"

    @pytest.mark.parametrize("spec", _SPELLINGS["optional-str"])
    def test_every_optional_str_spelling_yields_the_same_faults(self, spec: str) -> None:
        assert len(catalogue_faults({"x": spec})) == 4

    @pytest.mark.parametrize("spec", _SPELLINGS["plain-str"])
    def test_a_required_str_does_not_admit_none(self, spec: str) -> None:
        _, optional, base = _parse_typespec(spec)
        assert not optional and base == "str"

    @pytest.mark.parametrize("spec", _SPELLINGS["list-int"])
    def test_list_spellings_keep_their_list_faults(self, spec: str) -> None:
        _, _, base = _parse_typespec(spec)
        assert base.startswith("list")
        assert catalogue_faults({"x": spec})

    def test_optional_int_admits_none_without_borrowing_string_faults(self) -> None:
        _, optional, base = _parse_typespec("typing.Optional[int]")
        assert optional and base == "int"

    @pytest.mark.parametrize("spec", ["", None, "   "])
    def test_an_absent_annotation_degrades_to_the_string_family(self, spec: str | None) -> None:
        _, optional, base = _parse_typespec(spec)
        assert not optional and base == "str"

    def test_a_bare_optional_has_no_member_type_to_offer(self) -> None:
        """Honest degradation: no parameters means no base type exists."""
        _, optional, base = _parse_typespec("Optional")
        assert optional and base == "optional"

    def test_a_union_of_several_members_uses_the_first_non_none(self) -> None:
        _, optional, base = _parse_typespec("Union[None, str, int]")
        assert optional and base == "str"

    def test_nonetype_is_recognised_as_the_none_member(self) -> None:
        _, optional, base = _parse_typespec("Union[str, NoneType]")
        assert optional and base == "str"

    def test_parsing_is_case_insensitive(self) -> None:
        assert _parse_typespec("OPTIONAL[STR]")[1:] == (True, "str")


class TestSignatureRenderingMatchesTheParser:
    """Guard the *actual* rendering path, not just hand-written strings."""

    @staticmethod
    def _render(ann: object) -> str:
        """Mirror of the in-worker extraction in infer_contract_from_signature."""
        origin = getattr(ann, "__origin__", None)
        args = getattr(ann, "__args__", None)
        if origin is not None or args:
            return str(ann)
        return getattr(ann, "__name__", None) or str(ann)

    # ruff's UP007 wants `X | Y` here, but the legacy spellings ARE the subject
    # under test: `typing.Optional[str]` is the one that lost 3 of its 4 faults,
    # and modernising it would delete the regression this file exists for. Real
    # target repos are full of both spellings.
    @pytest.mark.parametrize(
        "ann",
        [
            typing.Optional[str],  # noqa: UP007
            str | None,
            typing.Union[str, None],  # noqa: UP007
            list[int],
        ],
    )
    def test_a_subscripted_annotation_keeps_its_parameters(self, ann: object) -> None:
        rendered = self._render(ann)
        assert "[" in rendered or "|" in rendered, f"{rendered} lost its parameters"

    def test_the_rendered_optional_produces_all_four_faults(self) -> None:
        """End to end: the exact string the worker emits, through the cataloguer."""
        assert len(catalogue_faults({"x": self._render(typing.Optional[str])})) == 4  # noqa: UP007

    def test_a_plain_class_still_renders_as_its_bare_name(self) -> None:
        assert self._render(str) == "str"
