"""FP-24: the differential comparator did raw `repr()` string equality.

Zero normalization. It worked only because the 378 corpus snippets were
hand-audited to return primitives — a property of the CORPUS, not of the
comparator. The first snippet that binds `result` to an object with the default
`__repr__` renders as

    <mypkg.model.Config object at 0x7f3a1c0d9e50>

whose hex tail is `id()` in ONE process. The reference outcome and the target
outcome are produced by two separate calls (and, for a `module:qualname`
reference, potentially two processes), so the two addresses differ essentially
always — a GUARANTEED false `wrong-value` finding against a target that computed
exactly the right answer. The module docstring also explicitly courts
cross-implementation targets (RustPython/PyPy/Brython), which differ in reprs for
reasons of their own.

The fix erases object addresses and NOTHING else. The negative half of this file
is what keeps that honest: normalising float formatting or container ordering
would begin hiding the very disagreements the oracle exists to report.
"""

from __future__ import annotations

import pytest

from exerciser.differential import judge_row, normalize_repr, values_agree


def _compare(ref_value: str, got_value: str):
    return judge_row(
        {
            "phase": "compare",
            "target": "engine.sandbox:evaluate_code",
            "snippet": "result = make()\nresult",
            "reference": {"ok": True, "value": ref_value},
            "got": {"ok": True, "value": got_value},
        }
    )


class TestObjectAddressesAreErased:
    def test_the_same_object_at_two_addresses_agrees(self) -> None:
        assert (
            _compare(
                "<mypkg.model.Config object at 0x7f3a1c0d9e50>",
                "<mypkg.model.Config object at 0x7f3a1c0d1234>",
            )
            is None
        ), "two runs of the same code cannot share a heap address"

    @pytest.mark.parametrize(
        ("ref", "got"),
        [
            ("<function f at 0x7f3a1c0d9e50>", "<function f at 0x000001>"),
            (
                "<bound method C.m of <C object at 0x7fff01>>",
                "<bound method C.m of <C object at 0x0001>>",
            ),
            (
                "[<A object at 0x7f01>, <A object at 0x7f02>]",
                "[<A object at 0x10a>, <A object at 0x10b>]",
            ),
        ],
    )
    def test_every_default_repr_shape(self, ref: str, got: str) -> None:
        assert values_agree(ref, got)

    def test_normalization_is_idempotent_and_total(self) -> None:
        once = normalize_repr("<A object at 0x7f3a1c0d9e50>")
        assert "0x7f3a" not in once
        assert normalize_repr(once) == once

    def test_none_is_not_a_crash(self) -> None:
        assert normalize_repr(None) == ""


class TestRealDisagreementsSurvive:
    """The load-bearing half: normalization must not become a mismatch suppressor."""

    def test_a_wrong_number_is_still_a_mismatch(self) -> None:
        verdict = _compare("3", "3.5")
        assert verdict and verdict["kind"] == "wrong-value"

    def test_different_classes_at_the_same_address_still_disagree(self) -> None:
        verdict = _compare("<a.B object at 0x1000>", "<a.C object at 0x1000>")
        assert verdict and verdict["kind"] == "wrong-value"

    def test_a_hex_string_value_is_compared_by_value(self) -> None:
        """`0x…` without the ` at ` prefix is DATA, not an address."""
        verdict = _compare("'0xdeadbeef'", "'0xcafebabe'")
        assert verdict and verdict["kind"] == "wrong-value"
        assert normalize_repr("'0xdeadbeef'") == "'0xdeadbeef'"

    def test_float_formatting_is_not_normalized_away(self) -> None:
        verdict = _compare("0.1", "0.10000000000000001")
        assert verdict and verdict["kind"] == "wrong-value"

    def test_container_ordering_is_not_normalized_away(self) -> None:
        verdict = _compare("[1, 2, 3]", "[3, 2, 1]")
        assert verdict and verdict["kind"] == "wrong-value"

    def test_an_object_repr_against_a_real_value_still_disagrees(self) -> None:
        verdict = _compare("42", "<mypkg.Lazy object at 0x7f01>")
        assert verdict and verdict["kind"] == "wrong-value"

    def test_the_other_verdict_paths_are_untouched(self) -> None:
        assert (
            judge_row(
                {
                    "phase": "compare",
                    "reference": {"ok": False, "exception": "TypeError"},
                    "got": {
                        "ok": False,
                        "exception": "InterpreterError",
                        "message": "failed due to: TypeError: bad operand",
                    },
                }
            )
            is None
        )
        accepts = judge_row(
            {
                "phase": "compare",
                "reference": {"ok": False, "exception": "ZeroDivisionError"},
                "got": {"ok": True, "value": "<X object at 0x7f01>"},
            }
        )
        assert accepts and accepts["kind"] == "accepts-invalid"


class TestTheWorkerEnvironmentIsReproducible:
    def test_the_hash_seed_is_pinned(self, tmp_path, monkeypatch) -> None:
        """`set` iteration order — and therefore its `repr` — is a function of
        PYTHONHASHSEED, which CPython randomises per process. Unpinned, the stored
        result file differs run to run for reasons unrelated to the target, which
        makes a reported mismatch impossible to reproduce by re-running it.
        """
        import subprocess

        from exerciser import store
        from exerciser.differential import run_differential

        (tmp_path / "engine").mkdir()
        (tmp_path / "engine" / "__init__.py").write_text("", encoding="utf-8")
        (tmp_path / "engine" / "sandbox.py").write_text(
            "def evaluate_code(code: str):\n    return None\n", encoding="utf-8"
        )
        store.exercise_dir(tmp_path).mkdir(parents=True, exist_ok=True)

        seen: list[dict] = []
        real_run = subprocess.run

        def _capture(cmd, **kwargs):
            # WORKER launches only. `exerciser.differential.subprocess` is the
            # shared module object, so patching `.run` through it intercepts
            # every subprocess the run makes — including interpreter
            # resolution's metadata probe, which launches no worker and pins
            # nothing. The claim under test is about the worker's environment.
            if "--worker" in list(cmd):
                seen.append(dict(kwargs.get("env") or {}))
            return real_run(
                [__import__("sys").executable, "-c", "pass"],
                capture_output=True,
                text=True,
            )

        monkeypatch.setattr("exerciser.differential.subprocess.run", _capture)
        run_differential(tmp_path, target="engine.sandbox:evaluate_code")

        assert seen, "the worker was never launched"
        assert all(env.get("PYTHONHASHSEED") == "0" for env in seen)
