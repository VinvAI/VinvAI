"""Boundary fault injection: catalogue, chunk sweep, and the runner's verdicts.

P1.3 of the 2026-07-27 exploration audit. Nothing in a normal run produces a
``content=None`` or a mid-token stream split — the real dependency is
well-behaved — so the handling code for those shapes is never executed until a
user hits it. These tests plant both failure modes and prove the oracle sees
them, and (equally important) that correct handling stays silent.
"""

from __future__ import annotations

from pathlib import Path

from exerciser import store
from exerciser.faults import (
    catalogue_faults,
    chunk_boundary_cases,
    classify_row,
    cluster_fault_failures,
    run_faults,
    value_digest,
)


def _make_repo(tmp_path: Path, source: str) -> Path:
    pkg = tmp_path / "edge"
    pkg.mkdir(parents=True, exist_ok=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "consumer.py").write_text(source, encoding="utf-8")
    store.exercise_dir(tmp_path).mkdir(parents=True, exist_ok=True)
    return tmp_path


# ---- the cataloguer --------------------------------------------------------


def test_catalogue_derives_faults_from_the_declared_contract():
    faults = catalogue_faults({"content": "str | None", "choices": "list"})
    by_field: dict[str, set[str]] = {}
    for f in faults:
        by_field.setdefault(f.field_name, set()).add(f.label)
    # An optional string yields absence, emptiness, and an unencodable-but-legal str.
    assert {"none", "empty", "lone-surrogate", "whitespace-only"} <= by_field["content"]
    # A list yields emptiness plus the two stream hazards.
    assert {"empty", "duplicate-index", "reordered"} <= by_field["choices"]
    # Every fault explains why the contract PERMITS it — the report has to be
    # able to say "this is legal", not "we made something up".
    assert all(f.why_legal for f in faults)


def test_non_optional_fields_are_not_handed_none():
    labels = {f.label for f in catalogue_faults({"content": "str"})}
    assert "none" not in labels, "the contract does not permit None here"
    assert "empty" in labels


def test_catalogue_is_deterministic():
    # `first == catalogue_faults(same)` alone reduces to [] == [] and passes
    # against a cataloguer that returns nothing. Determinism is only worth
    # asserting over a catalogue with contents, and the ordering claim is that
    # it is a function of the CONTRACT, not of dict insertion order.
    first = [f.to_json() for f in catalogue_faults({"b": "int", "a": "str | None"})]
    assert [(f["field"], f["label"]) for f in first] == [
        ("a", "none"),
        ("a", "empty"),
        ("a", "lone-surrogate"),
        ("a", "whitespace-only"),
        ("b", "zero"),
        ("b", "negative"),
    ]
    assert first == [f.to_json() for f in catalogue_faults({"b": "int", "a": "str | None"})]
    assert first == [f.to_json() for f in catalogue_faults({"a": "str | None", "b": "int"})]


# ---- the chunk sweep -------------------------------------------------------


def test_chunk_sweep_covers_every_split_point():
    cases = chunk_boundary_cases("abcd")
    # Whole, each interior split, and per-character.
    assert ["abcd"] in cases
    assert ["a", "bcd"] in cases
    assert ["abc", "d"] in cases
    assert ["a", "b", "c", "d"] in cases
    # Every case must reassemble to the original — a sweep that changes the
    # payload is testing something else.
    assert all("".join(c) == "abcd" for c in cases)


def test_chunk_sweep_of_empty_stream_is_a_single_case():
    assert chunk_boundary_cases("") == [[]]


# ---- the convergence comparison -------------------------------------------


def test_the_digest_compares_contents_not_shapes():
    # The whole point: an aggregator returning a list of the RIGHT LENGTH with
    # corrupted contents is the bug the sweep exists for. Comparing summaries
    # ({"type": "list", "len": 3}) converges on it silently.
    assert value_digest([1, 2, 3]) != value_digest([1, 2, 4])
    assert value_digest(["a", "b"]) != value_digest(["b", "a"]), "order is part of the value"
    assert value_digest([1, 2, 3]) == value_digest([1, 2, 3])
    # Dicts past the 12-key truncation the summary applies, differing only in
    # the last key's VALUE.
    left = {f"k{i}": i for i in range(20)}
    right = {**left, "k19": 999}
    assert value_digest(left) != value_digest(right)
    # …but key ORDER is not part of a dict's value.
    assert value_digest({"a": 1, "b": 2}) == value_digest({"b": 2, "a": 1})
    assert value_digest({1, 2}) == value_digest({2, 1})
    # Types are not interchangeable just because contents match.
    assert value_digest([1, 2]) != value_digest((1, 2))
    assert value_digest("1") != value_digest(1)


def test_the_digest_normalises_default_repr_addresses():
    # An object with the DEFAULT __repr__ renders its instance address, which
    # differs on every call — hashing that would make every split look
    # divergent, i.e. a false positive on every sweep of every such aggregator.
    class Opaque:
        pass

    assert value_digest(Opaque()) == value_digest(Opaque())

    class WithState:
        def __init__(self, n):
            self.n = n

    assert value_digest(WithState(1)) == value_digest(WithState(1))
    assert value_digest(WithState(1)) != value_digest(WithState(2))


def test_the_digest_survives_cycles_and_unrenderable_values():
    # Surviving is not the property that matters — `return "x"` survives
    # everything and makes every split of every stream look convergent. The
    # digest has to keep DISCRIMINATING on the awkward values too.
    def cycle(head: int) -> list:
        out: list = [head]
        out.append(out)
        return out

    assert value_digest(cycle(1)) == value_digest(cycle(1)), "stable across instances"
    assert value_digest(cycle(1)) != value_digest(cycle(2)), "the cycle is not the whole value"
    assert value_digest(cycle(1)) != value_digest([1]), "a cycle is not its acyclic prefix"

    class Hostile:
        def __repr__(self):
            raise RuntimeError("no")

    class AlsoHostile:
        def __repr__(self):
            raise RuntimeError("no")

    assert value_digest(Hostile()) == value_digest(Hostile())
    assert value_digest(Hostile()) != value_digest(
        AlsoHostile()
    ), "an unrenderable value still has a type, and two types are not equal"
    assert value_digest(Hostile()) != value_digest(cycle(1))


# ---- verdicts --------------------------------------------------------------


def test_typed_rejection_is_correct_handling_not_a_defect():
    assert classify_row({"phase": "fault", "status": "error", "error_type": "TypeError"}) is None
    assert (
        classify_row({"phase": "fault", "status": "error", "error_type": "RecursionError"})
        == "fault-crash"
    )
    assert classify_row({"phase": "fault", "status": "ok"}) is None


def test_convergence_row_becomes_a_divergence_cluster():
    rows = [
        {
            "phase": "chunk-convergence",
            "status": "error",
            "target": "edge.consumer:aggregate",
            "error": "3 distinct aggregate results across 5 split points",
        }
    ]
    (cluster,) = cluster_fault_failures(rows)
    assert cluster.kind == "fault-divergence"
    assert "distinct aggregate" in cluster.title


# ---- end to end ------------------------------------------------------------

# A consumer that assumes content is always a str: `.strip()` on None is an
# AttributeError deep inside, not a typed rejection at the edge.
_FRAGILE_CONSUMER = """\
def handle(content=None, choices=None):
    return content.strip().upper()
"""

_ROBUST_CONSUMER = """\
def handle(content=None, choices=None):
    if not isinstance(content, str):
        raise TypeError("content must be a str")
    return content.strip().upper()
"""


def test_fragile_consumer_crashes_on_a_legal_shape(tmp_path: Path):
    repo = _make_repo(tmp_path, _FRAGILE_CONSUMER)

    result = run_faults(
        repo,
        target="edge.consumer:handle",
        contract={"content": "str | None"},
        baseline={"content": "hello"},
    )

    assert result["status"] == "ok"
    assert result["faults_injected"] >= 3
    assert result["issue_clusters"] >= 1
    crash = next(c for c in result["clusters"] if c["kind"] == "fault-crash")
    assert "AttributeError" in crash["title"]
    assert "legal" in crash["exemplar"]["expected"]


def test_robust_consumer_stays_silent(tmp_path: Path):
    repo = _make_repo(tmp_path, _ROBUST_CONSUMER)

    result = run_faults(
        repo,
        target="edge.consumer:handle",
        contract={"content": "str | None"},
        baseline={"content": "hello"},
    )

    assert result["issue_clusters"] == 0, "a typed refusal is correct handling"


# An aggregator that drops a partial token when a chunk splits mid-word: it
# converges for MOST splits and breaks for exactly the ones inside a token.
_CHUNK_BUGGY = """\
def aggregate(chunks=None):
    words = []
    for c in chunks or []:
        # Bug: only keeps whole space-delimited words per chunk, so a split
        # inside a word silently loses the fragment.
        words.extend(w for w in c.split(" ") if len(w) > 2)
    return " ".join(words)
"""

_CHUNK_CORRECT = """\
def aggregate(chunks=None):
    return "".join(chunks or [])
"""


def test_chunk_boundary_sweep_finds_the_split_that_breaks(tmp_path: Path):
    repo = _make_repo(tmp_path, _CHUNK_BUGGY)

    result = run_faults(
        repo,
        target="edge.consumer:aggregate",
        contract={},
        baseline={},
        chunk_field="chunks",
        chunk_canonical="hello brave world",
    )

    assert result["chunk_splits"] > 10, "every split point is swept"
    kinds = {c["kind"] for c in result["clusters"]}
    assert (
        "fault-divergence" in kinds
    ), "an aggregator whose result depends on chunking must be caught"


def test_correct_aggregator_converges_across_every_split(tmp_path: Path):
    repo = _make_repo(tmp_path, _CHUNK_CORRECT)

    result = run_faults(
        repo,
        target="edge.consumer:aggregate",
        contract={},
        baseline={},
        chunk_field="chunks",
        chunk_canonical="hello brave world",
    )

    assert result["issue_clusters"] == 0
    rows = store.read_jsonl(store.exercise_dir(repo) / "fault_results.jsonl")
    conv = next(r for r in rows if r.get("phase") == "chunk-convergence")
    assert conv["distinct_results"] == 1


# An aggregator whose result is always a 3-element list — the SHAPE never
# changes, so a summary-based comparison converges — but whose CONTENTS depend
# on where the stream was split.
_CHUNK_CONTENT_BUG = """\
def aggregate(chunks=None):
    parts = list(chunks or [])
    # Bug: the aggregate is built from the FIRST chunk only, so its content
    # depends on the split point while its length never does.
    head = parts[0] if parts else ""
    return [head, head.upper(), len(head)]
"""


def test_same_length_different_content_is_a_divergence(tmp_path: Path):
    repo = _make_repo(tmp_path, _CHUNK_CONTENT_BUG)

    result = run_faults(
        repo,
        target="edge.consumer:aggregate",
        contract={},
        baseline={},
        chunk_field="chunks",
        chunk_canonical="hello brave world",
    )

    rows = store.read_jsonl(store.exercise_dir(repo) / "fault_results.jsonl")
    conv = next(r for r in rows if r.get("phase") == "chunk-convergence")
    assert conv["distinct_results"] > 1, "contents differ even though every length is 3"
    # The lossy rendering really is identical across every split — which is
    # exactly why convergence cannot be decided on it.
    sweep = [r for r in rows if r.get("phase") == "chunk-sweep" and r.get("status") == "ok"]
    assert len({str(r["result"]) for r in sweep}) == 1
    assert {c["kind"] for c in result["clusters"]} == {"fault-divergence"}


# A streaming parser that raises on exactly ONE mid-token split and succeeds on
# every other. ValueError is a "typed rejection" for a shape fault, so the old
# rule dropped this row twice over: once in classify_row, once by filtering the
# convergence set to status=="ok".
_CHUNK_RAISES_ON_ONE_SPLIT = """\
def aggregate(chunks=None):
    parts = list(chunks or [])
    if len(parts) == 2 and parts[0].endswith("b"):
        raise ValueError("unterminated token")
    return "".join(parts)
"""


def test_an_aggregator_that_raises_on_one_split_is_caught(tmp_path: Path):
    repo = _make_repo(tmp_path, _CHUNK_RAISES_ON_ONE_SPLIT)

    result = run_faults(
        repo,
        target="edge.consumer:aggregate",
        contract={},
        baseline={},
        chunk_field="chunks",
        chunk_canonical="abc",
    )

    rows = store.read_jsonl(store.exercise_dir(repo) / "fault_results.jsonl")
    raised = [r for r in rows if r.get("phase") == "chunk-sweep" and r.get("status") == "error"]
    assert len(raised) == 1, "exactly one split falls inside the token"
    assert raised[0]["error_type"] == "ValueError"
    assert raised[0]["sweep_divergent"] is True
    # Every other split agreed, so the convergence row is a divergence too.
    conv = next(r for r in rows if r.get("phase") == "chunk-convergence")
    assert conv["status"] == "error"
    assert conv["distinct_results"] == 1 and conv["raised_splits"] == 1
    kinds = {c["kind"] for c in result["clusters"]}
    assert kinds == {"fault-divergence"}
    assert any("ValueError" in c["title"] for c in result["clusters"])


def test_a_consumer_that_refuses_every_split_alike_is_not_a_divergence(tmp_path: Path):
    # The typed-rejection rule still applies when the refusal is CONSISTENT:
    # nothing about the chunking changed the answer.
    repo = _make_repo(
        tmp_path,
        'def aggregate(chunks=None):\n    raise ValueError("streaming not supported")\n',
    )

    result = run_faults(
        repo,
        target="edge.consumer:aggregate",
        contract={},
        baseline={},
        chunk_field="chunks",
        chunk_canonical="abc",
    )

    assert result["issue_clusters"] == 0
    rows = store.read_jsonl(store.exercise_dir(repo) / "fault_results.jsonl")
    conv = next(r for r in rows if r.get("phase") == "chunk-convergence")
    assert conv["status"] == "ok"


def test_boundary_declaration_persists_for_later_runs(tmp_path: Path):
    repo = _make_repo(tmp_path, _ROBUST_CONSUMER)
    run_faults(
        repo,
        target="edge.consumer:handle",
        contract={"content": "str | None"},
        baseline={"content": "hello"},
    )
    doc = store.read_json(store.exercise_dir(repo) / "boundaries.json")
    entry = next(e for e in doc["boundaries"] if e["target"] == "edge.consumer:handle")
    assert entry["contract"] == {"content": "str | None"}
    # A bare re-run reuses the declaration.
    again = run_faults(repo)
    assert again["boundaries"] == 1


def test_no_boundaries_is_loudly_diagnosed(tmp_path: Path):
    repo = _make_repo(tmp_path, _ROBUST_CONSUMER)
    result = run_faults(repo)
    assert result["boundaries"] == 0
    assert any("0 fault boundaries" in d for d in result["diagnostics"])


def test_unimportable_target_is_reported_not_swallowed(tmp_path: Path):
    repo = _make_repo(tmp_path, _ROBUST_CONSUMER)
    result = run_faults(repo, target="edge.nope:handle", contract={"x": "str"})
    assert any(c["kind"] == "import-error" for c in result["clusters"])
