"""FP-19: `--auto-target` armed every boundary with an EMPTY baseline.

A fault is the baseline payload with ONE field replaced. `auto_targets` set
`baseline={}`, so the generated call supplied only the faulted field and omitted
every other required parameter. Python raises `TypeError: missing 1 required
positional argument` before the consumer executes a line of its own code — and
`TypeError` is in `_TYPED_REJECTIONS`, which the classifier reads as the
consumer CORRECTLY refusing the shape.

The arithmetic is exact and it is brutal: a fault could only ever execute when
the target had exactly ONE required parameter and the fault happened to target
it. At two or more required parameters the sweep was 100% dead — no findings, no
questions on the agent channel, and a clean report. The oracle was therefore
ANTI-correlated with code quality: the wider a boundary's signature, the more
certainly it certified the boundary as safe.

`FaultBoundary.baseline` already documents faults as being applied on top of a
well-formed payload. This file proves that payload now gets built.
"""

from __future__ import annotations

import json
from pathlib import Path

from exerciser import store
from exerciser.faults import baseline_from_contract, run_faults

# Three REQUIRED parameters, all annotated. Under the old empty baseline every
# fault died on the two it did not supply. `payload.upper()` on a legal `None` is
# the defect the sweep is supposed to find.
_MULTI_PARAM = """\
def handle(payload: str | None, retries: int, tags: list) -> str:
    if retries < 0:
        raise ValueError("retries must be >= 0")
    return payload.upper() + str(len(tags))
"""


def _make_repo(tmp_path: Path, source: str) -> Path:
    pkg = tmp_path / "edge"
    pkg.mkdir(parents=True, exist_ok=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "consumer.py").write_text(source, encoding="utf-8")
    store.exercise_dir(tmp_path).mkdir(parents=True, exist_ok=True)
    return tmp_path


def _rows(repo: Path) -> list[dict]:
    return store.read_jsonl(store.exercise_dir(repo) / "fault_results.jsonl")


class TestTheDerivedBaseline:
    """Unit: what a contract turns into."""

    def test_each_annotated_field_gets_a_valid_value(self) -> None:
        assert baseline_from_contract({"payload": "str", "retries": "int"}) == {
            "payload": "vinv",
            "retries": 3,
        }

    def test_an_optional_annotation_uses_the_present_type(self) -> None:
        """`str | None` must baseline as a STRING — the None case is the FAULT."""
        assert baseline_from_contract({"content": "str | None"}) == {"content": "vinv"}

    def test_containers_and_flags(self) -> None:
        assert baseline_from_contract({"tags": "list[int]", "flag": "bool"}) == {
            "tags": [1, 2],
            "flag": True,
        }

    def test_an_empty_contract_stays_empty(self) -> None:
        assert baseline_from_contract({}) == {}

    def test_an_unknown_type_still_gets_a_placeholder(self) -> None:
        """A guess costs a dead fault (TypeError is a typed rejection), never a false one."""
        assert set(baseline_from_contract({"cfg": "Config"})) == {"cfg"}

    def test_values_that_cannot_survive_the_plan_file_are_omitted(self) -> None:
        """The baseline is written with `json.dumps(..., default=str)`.

        A `set` would reach the worker as the STRING "{1}" and a `tuple` as a
        `list`. Feeding a consumer a differently-typed argument and then blaming
        it for the resulting crash is a fabricated finding — the exact failure
        mode this whole change exists to remove — so those are dropped instead.
        """
        derived = baseline_from_contract({"tags": "set", "pair": "tuple", "blob": "bytes"})
        assert derived == {}

    def test_everything_emitted_really_is_json_safe(self) -> None:
        derived = baseline_from_contract(
            {"a": "str", "b": "int", "c": "float", "d": "bool", "e": "list", "f": "dict"}
        )
        assert json.loads(json.dumps(derived)) == derived


class TestAMultiParameterBoundaryIsActuallyExercised:
    """End to end: the case that used to be 100% dead."""

    def test_the_defect_behind_two_extra_required_parameters_is_found(self, tmp_path: Path) -> None:
        repo = _make_repo(tmp_path, _MULTI_PARAM)

        result = run_faults(repo, auto_targets=["edge.consumer:handle"])

        assert result["boundaries"] == 1
        assert result["faults_injected"] > 0
        assert result["agent_channel"]["asked_this_run"] == 0, "annotations were enough"

        rows = [r for r in _rows(repo) if r.get("phase") == "fault"]
        assert rows, "no faults reached the consumer at all"

        # The `payload=None` fault must now reach `.upper()`.
        none_rows = [r for r in rows if r.get("fault_field") == "payload"]
        assert any(r.get("error_type") == "AttributeError" for r in none_rows), none_rows
        assert result["issue_clusters"] >= 1

    def test_no_fault_dies_on_a_missing_argument_any_more(self, tmp_path: Path) -> None:
        """The signature of the old bug: `TypeError: missing ... argument`."""
        repo = _make_repo(tmp_path, _MULTI_PARAM)
        run_faults(repo, auto_targets=["edge.consumer:handle"])

        missing = [
            r
            for r in _rows(repo)
            if r.get("phase") == "fault" and "required" in str(r.get("error") or "")
        ]
        assert missing == [], missing

    def test_an_empty_baseline_is_still_100_percent_dead(self, tmp_path: Path) -> None:
        """Characterisation of the OLD behaviour, kept so the mechanism stays visible.

        Driving the same defective consumer with `baseline={}` — what
        `--auto-target` used to arm — produces nothing but `TypeError`, which the
        classifier reads as correct handling. Zero clusters against code that
        crashes on a legal `None`. This is not a desired behaviour; it is the
        measurement that makes the fix's value legible, and it is why an
        explicitly DECLARED empty baseline is a caller error, not a default.
        """
        repo = _make_repo(tmp_path, _MULTI_PARAM)

        result = run_faults(
            repo,
            target="edge.consumer:handle",
            contract={"payload": "str | None", "retries": "int", "tags": "list"},
            baseline={},
        )

        fault_rows = [r for r in _rows(repo) if r.get("phase") == "fault"]
        assert fault_rows
        assert {r.get("error_type") for r in fault_rows} == {"TypeError"}
        assert result["issue_clusters"] == 0, "the consumer was certified safe"

    def test_the_stored_boundary_records_the_payload(self, tmp_path: Path) -> None:
        """A reader must be able to see WHAT the faults were applied on top of."""
        repo = _make_repo(tmp_path, _MULTI_PARAM)
        run_faults(repo, auto_targets=["edge.consumer:handle"])
        plan = json.loads(
            (store.exercise_dir(repo) / "faults" / "edge_consumer_handle.plan.json").read_text(
                encoding="utf-8"
            )
        )
        assert plan["baseline"] == {"payload": "vinv", "retries": 3, "tags": [1, 2]}


class TestWhatMustNotChange:
    """Negative cases: the fix must not overreach."""

    def test_an_agent_supplied_baseline_still_wins(self, tmp_path: Path) -> None:
        """The agent has seen the real boundary; the annotations have only seen types."""
        source = "def handle(content: str, retries: int):\n    return content.upper()\n"
        repo = _make_repo(tmp_path, source)
        # Pre-seed an answered question so the agent branch is taken.
        run_faults(repo, auto_targets=["edge.consumer:handle"])  # derives, asks nothing
        path = store.exercise_dir(repo) / "agent_contract.json"
        doc = store.read_json(path) or {"version": 1, "questions": {}}
        from exerciser.agent_loop import question_key

        doc.setdefault("questions", {})[question_key("contract", "edge.consumer:handle")] = {
            "topic": "contract",
            "subject": "edge.consumer:handle",
            "prompt": "",
            "answer": {
                "contract": {"content": "str", "retries": "int"},
                "baseline": {"content": "hello-from-the-agent"},
            },
        }
        store.write_json(path, doc)

        run_faults(repo, auto_targets=["edge.consumer:handle"])
        plan = json.loads(
            (store.exercise_dir(repo) / "faults" / "edge_consumer_handle.plan.json").read_text(
                encoding="utf-8"
            )
        )
        assert plan["baseline"]["content"] == "hello-from-the-agent", "the agent overrides"
        assert plan["baseline"]["retries"] == 3, "and the rest is still filled in"

    def test_a_declared_boundary_is_untouched(self, tmp_path: Path) -> None:
        """`boundaries.json` is an instruction. Nothing is invented on top of it."""
        source = "def handle(content: str, retries: int):\n    return content.upper()\n"
        repo = _make_repo(tmp_path, source)
        store.write_json(
            store.exercise_dir(repo) / "boundaries.json",
            {
                "version": 1,
                "boundaries": [
                    {
                        "target": "edge.consumer:handle",
                        "name": "edge",
                        "contract": {"content": "str | None"},
                        "baseline": {"content": "x", "retries": 1},
                    }
                ],
            },
        )
        run_faults(repo)
        plan = json.loads(
            (store.exercise_dir(repo) / "faults" / "edge_consumer_handle.plan.json").read_text(
                encoding="utf-8"
            )
        )
        assert plan["baseline"] == {"content": "x", "retries": 1}

    def test_a_correct_consumer_is_still_reported_clean(self, tmp_path: Path) -> None:
        """A well-formed baseline must not manufacture findings against good code."""
        source = (
            "def handle(payload: str | None, retries: int, tags: list) -> str:\n"
            "    if not isinstance(payload, str):\n"
            "        raise TypeError('payload must be a str')\n"
            "    return payload.upper()\n"
        )
        repo = _make_repo(tmp_path, source)

        result = run_faults(repo, auto_targets=["edge.consumer:handle"])

        assert result["faults_injected"] > 0, "the sweep really ran"
        assert result["issue_clusters"] == 0, "typed rejections are correct handling"
