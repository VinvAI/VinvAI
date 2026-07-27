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
    contract = {"b": "int", "a": "str | None"}
    first = [f.to_json() for f in catalogue_faults(contract)]
    assert first == [f.to_json() for f in catalogue_faults(contract)]


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
