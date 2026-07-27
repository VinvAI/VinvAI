"""The shared agent channel: asked once, cached forever, budgeted.

Putting a model in the loop is only a design if its cost falls over time.
These tests pin the three properties that make that true — shape dedup, a
permanent cache, and a budget whose overflow is reported rather than dropped —
and the auto-derived boundary contracts that let fault injection run on a repo
where nobody has written a boundaries.json by hand.
"""

from __future__ import annotations

from pathlib import Path

from exerciser import store
from exerciser.agent_loop import (
    AgentChannel,
    Question,
    channel_summary,
    question_key,
)
from exerciser.faults import infer_contract_from_signature, run_faults


def _q(subject: str, topic: str = "contract") -> Question:
    return Question(
        key=question_key(topic, subject),
        topic=topic,
        subject=subject,
        prompt=f"decide: {subject}",
        reply_schema='{"verdict": "..."}',
    )


# ---- shape dedup -----------------------------------------------------------


def test_questions_dedupe_by_shape_not_by_text():
    # Line numbers, ids and sizes vary run to run without changing what is
    # being asked, so sixty occurrences of one message shape are ONE question.
    a = question_key("policy", "failed at line 12 due to: X is not supported")
    b = question_key("policy", "failed at line 4096 due to: X is not supported")
    assert a == b
    c = question_key("policy", "failed at line 12 due to: Y is not supported")
    assert a != c
    # The topic is part of the key: the same subject asked for a different
    # purpose is a different question.
    assert question_key("contract", "pkg:fn") != question_key("policy", "pkg:fn")


def test_asking_the_same_shape_twice_queues_once(tmp_path: Path):
    store.exercise_dir(tmp_path).mkdir(parents=True)
    channel = AgentChannel(tmp_path, "contract")
    assert channel.ask(_q("pkg:fn")) is None
    assert channel.ask(_q("pkg:fn")) is None
    state = channel.save()
    assert state["asked_this_run"] == 1
    assert state["pending"] == 1


# ---- caching ---------------------------------------------------------------


def test_an_answered_question_is_never_asked_again(tmp_path: Path):
    store.exercise_dir(tmp_path).mkdir(parents=True)
    first = AgentChannel(tmp_path, "contract")
    first.ask(_q("pkg:fn"))
    first.save()

    # The agent answers it on disk.
    path = store.exercise_dir(tmp_path) / "agent_contract.json"
    doc = store.read_json(path)
    key = question_key("contract", "pkg:fn")
    doc["questions"][key]["answer"] = {"contract": {"x": "str"}}
    store.write_json(path, doc)

    second = AgentChannel(tmp_path, "contract")
    assert second.ask(_q("pkg:fn")) == {"contract": {"x": "str"}}
    state = second.save()
    assert state["asked_this_run"] == 0, "steady-state cost is zero model calls"
    assert state["answered"] == 1
    assert state["pending"] == 0


def test_summary_reports_the_calls_the_cache_saved(tmp_path: Path):
    store.exercise_dir(tmp_path).mkdir(parents=True)
    channel = AgentChannel(tmp_path, "contract")
    for name in ("a:f", "b:g", "c:h"):
        channel.ask(_q(name))
    channel.save()
    path = store.exercise_dir(tmp_path) / "agent_contract.json"
    doc = store.read_json(path)
    for entry in list(doc["questions"].values())[:2]:
        entry["answer"] = {"contract": {}}
    store.write_json(path, doc)

    summary = channel_summary(tmp_path, ("contract",))
    assert summary["answered_total"] == 2
    assert summary["pending_total"] == 1
    assert summary["model_calls_saved"] == 2


# ---- budget ----------------------------------------------------------------


def test_the_budget_caps_new_questions_and_reports_the_overflow(tmp_path: Path):
    store.exercise_dir(tmp_path).mkdir(parents=True)
    channel = AgentChannel(tmp_path, "contract", max_new=2)
    # Distinct SHAPES — note digits normalise, so pkg:fn0..fn4 would be one
    # question, which is the dedup doing its job rather than a budget test.
    for name in ("pkg:alpha", "pkg:beta", "pkg:gamma", "pkg:delta", "pkg:epsilon"):
        channel.ask(_q(name))
    state = channel.save()
    assert state["asked_this_run"] == 2
    assert state["overflow"] == 3, "the excess is COUNTED, never silently dropped"


def test_digits_in_a_subject_collapse_to_one_question(tmp_path: Path):
    store.exercise_dir(tmp_path).mkdir(parents=True)
    channel = AgentChannel(tmp_path, "contract", max_new=10)
    for i in range(20):
        channel.ask(_q(f"failed at line {i}: same problem"))
    assert channel.save()["asked_this_run"] == 1, "one shape, one question"


# ---- auto-derived contracts ------------------------------------------------

_ANNOTATED = """\
def handle(content: str | None = None, retries: int = 0, tags: list | None = None):
    if not isinstance(content, str):
        raise TypeError("content must be a str")
    return content.upper()
"""

_UNANNOTATED = """\
def handle(content=None):
    return content.upper()
"""


def _make_repo(tmp_path: Path, source: str) -> Path:
    pkg = tmp_path / "edge"
    pkg.mkdir(parents=True, exist_ok=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "consumer.py").write_text(source, encoding="utf-8")
    store.exercise_dir(tmp_path).mkdir(parents=True, exist_ok=True)
    return tmp_path


def test_a_contract_is_read_off_the_code_before_asking_anyone(tmp_path: Path, monkeypatch):
    # An annotated parameter already DECLARES its admissible domain, so the
    # cheapest source is the code itself — no model call at all.
    repo = _make_repo(tmp_path, _ANNOTATED)
    monkeypatch.chdir(repo)
    contract = infer_contract_from_signature("edge.consumer:handle")
    assert "content" in contract and "None" in contract["content"]
    assert contract["retries"] == "int"


def test_unannotated_boundaries_become_one_cached_question(tmp_path: Path):
    repo = _make_repo(tmp_path, _UNANNOTATED)

    result = run_faults(repo, auto_targets=["edge.consumer:handle"])

    # Nothing could be derived, so exactly one question was raised…
    assert result["agent_channel"]["asked_this_run"] == 1
    assert result["boundaries"] == 0
    assert any("queued on the agent channel" in d for d in result["diagnostics"])

    # …and once answered, the oracle arms itself with no further questions.
    path = store.exercise_dir(repo) / "agent_contract.json"
    doc = store.read_json(path)
    key = question_key("contract", "edge.consumer:handle")
    doc["questions"][key]["answer"] = {
        "contract": {"content": "str | None"},
        "baseline": {"content": "hello"},
    }
    store.write_json(path, doc)

    armed = run_faults(repo, auto_targets=["edge.consumer:handle"])
    assert armed["boundaries"] == 1
    assert armed["agent_channel"]["asked_this_run"] == 0, "answered once, cached forever"
    # And it finds the real defect: .upper() on a legal None.
    assert armed["issue_clusters"] >= 1


def test_annotated_boundaries_need_no_agent_at_all(tmp_path: Path):
    repo = _make_repo(tmp_path, _ANNOTATED)

    result = run_faults(repo, auto_targets=["edge.consumer:handle"])

    assert result["agent_channel"]["asked_this_run"] == 0
    assert result["boundaries"] == 1, "the annotations were enough"
    assert result["faults_injected"] > 0
