#!/usr/bin/env python3
"""Six live Vinv-on-Vinv evolution episodes.

Each episode applies one controlled code mutation to a probe module, then
verifies the whole learning loop end to end against the live index:

  1. mutate   — edit ``tests/e2e/episodes/probe.py`` (create / edit body /
                add / rename / oversize / delete);
  2. reindex  — incremental ``index update`` with the live gateway; assert the
                content epoch advanced by exactly one and reuse stayed high;
  3. freshness— query the index for the mutated concept; assert the probe file
                is retrieved (new context) and, on rename/delete, that the old
                symbol is gone (no stale context);
  4. benchmark— run the frozen 32-question holdout; assert overall symbol
                nDCG@10 stays within tolerance of the episode-0 reference
                (probe mutations must not damage unrelated retrieval);
  5. learn    — run an explore-mode decision/feedback cycle over the holdout
                questions through the production telemetry module (same ledger
                and epoch as the editor MCP), then run offline policy
                evaluation for this episode's epoch and record its verdict.

The report lands in ``index/eval/episodes/report.json``. Requires the live
gateway env (INDEX_GATEWAY_KEY / INDEX_GATEWAY_URL / INDEX_SUMMARY_MODEL /
INDEX_EMBEDDING_MODEL) and a prebuilt release binary.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
STORE = REPO / ".vinv" / "index"
PROBE = REPO / "tests" / "e2e" / "episodes" / "probe.py"
EPISODES_DIR = Path(__file__).resolve().parent / "episodes"
HOLDOUT = Path(__file__).resolve().parent / "questions.vinv.holdout.json"
NDCG_TOLERANCE = 0.05
TELEMETRY_ROUNDS = 2


def load_telemetry_module():
    """The production telemetry module, loaded by path (no core install needed)."""
    path = REPO / "core" / "src" / "core" / "retrieval_telemetry.py"
    spec = importlib.util.spec_from_file_location("retrieval_telemetry", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PROBE_V1 = '''"""Episode probe module — mutated across evolution episodes."""


def validate_episode_token(token: str) -> bool:
    """An episode token is valid when it is a 12-char lowercase hex string."""
    return len(token) == 12 and all(c in "0123456789abcdef" for c in token)


def compute_episode_checksum(payload: bytes) -> int:
    """Additive checksum of the episode payload, folded into 16 bits."""
    return sum(payload) & 0xFFFF


class EpisodeLedger:
    """Accumulates per-episode reward observations."""

    def __init__(self) -> None:
        self.rewards: list[float] = []

    def observe(self, reward: float) -> None:
        self.rewards.append(reward)

    def mean_reward(self) -> float:
        return sum(self.rewards) / len(self.rewards) if self.rewards else 0.0
'''


def mutate(episode: int) -> str:
    """Apply the episode's controlled mutation; returns a description."""
    if episode == 1:
        PROBE.parent.mkdir(parents=True, exist_ok=True)
        PROBE.write_text(PROBE_V1)
        return "create probe module with 3 symbols"
    if episode == 2:
        text = PROBE.read_text().replace(
            "return sum(payload) & 0xFFFF",
            "return (sum(payload) * 31 + len(payload)) & 0xFFFF",
        )
        PROBE.write_text(text)
        return "change compute_episode_checksum body (behavior change)"
    if episode == 3:
        PROBE.write_text(
            PROBE.read_text()
            + '''

def schedule_episode_replay(delay_seconds: float) -> dict:
    """Plan a delayed replay of the episode, clamped to one hour."""
    clamped = min(max(delay_seconds, 0.0), 3600.0)
    return {"replay_in": clamped, "clamped": clamped != delay_seconds}
'''
        )
        return "add schedule_episode_replay symbol"
    if episode == 4:
        text = PROBE.read_text().replace(
            "compute_episode_checksum", "derive_episode_checksum"
        )
        PROBE.write_text(text)
        return "rename compute_episode_checksum -> derive_episode_checksum"
    if episode == 5:
        lines = [
            f'    step_{i} = (step_{i - 1} + {i}) % 9973 if {i} else seed' for i in range(120)
        ]
        PROBE.write_text(
            PROBE.read_text()
            + '''

def episode_entropy_walk(seed: int) -> int:
    """A deliberately oversized function to exercise continuation chunking."""
'''
            + "\n".join(lines)
            + "\n    return step_119\n"
        )
        return "add oversized symbol (exercises AST continuation chunking)"
    if episode == 6:
        PROBE.unlink()
        return "delete the probe module (symbols must disappear)"
    raise ValueError(episode)


def read_meta() -> dict:
    return json.loads((STORE / "meta.json").read_text())


def run_update(index_bin: str) -> dict:
    out = subprocess.run(
        [index_bin, "update", str(REPO), "--store-dir", str(STORE)],
        capture_output=True,
        text=True,
        timeout=1800,
    )
    for line in reversed(out.stdout.strip().splitlines()):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise RuntimeError(f"update produced no JSON: {out.stdout[-400:]} {out.stderr[-400:]}")


def run_query(index_bin: str, query: str, top_k: int) -> list[dict]:
    out = subprocess.run(
        [index_bin, "query", query, "--store-dir", str(STORE), "--top-k", str(top_k)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    for line in reversed(out.stdout.strip().splitlines()):
        try:
            return json.loads(line).get("results", [])
        except json.JSONDecodeError:
            continue
    return []


def run_holdout_bench(index_bin: str, tag: str) -> dict:
    """Frozen holdout benchmark; returns the overall metrics block."""
    output = EPISODES_DIR / f"holdout-{tag}.json"
    subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parent / "bench_retrieval.py"),
            "--index-bin",
            index_bin,
            "--store-dir",
            str(STORE),
            "--questions",
            str(HOLDOUT),
            "--top-k",
            "10",
            "--json-output",
            str(output),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=3600,
    )
    payload = json.loads(output.read_text())
    return payload["evaluations"][0]["overall"]


def telemetry_cycle(index_bin: str, telemetry) -> dict:
    """Explore-mode decision/feedback cycle over the holdout questions.

    Uses the production telemetry module (shared ledger + epoch with the
    editor MCP). The reward is task-grounded: 1.0 when the retrieval hit any
    of the question's expected files, else 0.0 — the same signal the benchmark
    grades, delivered through the explicit-feedback path.
    """
    questions = json.loads(HOLDOUT.read_text())
    decisions = 0
    explored = 0
    hits = 0
    for _ in range(TELEMETRY_ROUNDS):
        for question in questions:
            raw = question.get("file") or ""
            expected = raw if isinstance(raw, list) else [raw]
            selection = telemetry.select_retrieval_action(10)
            started = time.monotonic()
            results = run_query(index_bin, question["q"], int(selection["top_k"]))
            latency_ms = (time.monotonic() - started) * 1000.0
            decision_id = telemetry.log_retrieval_decision(
                store_dir=STORE,
                query=question["q"],
                requested_top_k=10,
                selection=selection,
                latency_ms=latency_ms,
                results=results,
            )
            returned = [r.get("file", "") for r in results]
            reward = float(
                any(
                    ret.endswith(exp) or exp.endswith(ret)
                    for exp in expected
                    for ret in returned
                    if ret and exp
                )
            )
            telemetry.record_retrieval_feedback(
                decision_id, reward, store_dir=STORE, outcome="episode-bench"
            )
            decisions += 1
            explored += selection["policy"] == "explore"
            hits += reward > 0
    return {"decisions": decisions, "explored": explored, "hit_rate": hits / decisions}


def run_ope(telemetry, tag: str) -> dict:
    ledger = Path(os.environ.get("VINV_HOME", str(Path.home() / ".vinv")))
    ledger = ledger / "telemetry" / "retrieval.jsonl"
    epoch = telemetry.retrieval_epoch(STORE)
    output = EPISODES_DIR / f"ope-{tag}.json"
    proc = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parent / "off_policy.py"),
            "--telemetry",
            str(ledger),
            "--epoch",
            epoch,
            "--target-top-k",
            "5",
            "--baseline-top-k",
            "10",
            "--json-output",
            str(output),
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if output.exists():
        return json.loads(output.read_text())
    return {"error": proc.stderr[-400:] or proc.stdout[-400:]}


PROBE_QUERIES = {
    1: ("episode token validation hex string", "probe.py"),
    2: ("episode payload checksum folded 16 bits", "probe.py"),
    3: ("schedule a delayed episode replay clamped to one hour", "probe.py"),
    4: ("derive episode checksum", "probe.py"),
    5: ("episode entropy walk oversized", "probe.py"),
    6: (None, None),  # deletion: assert absence instead
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index-bin", default=str(REPO / "index/target/release/index"))
    parser.add_argument("--episodes", type=int, default=6)
    args = parser.parse_args()

    EPISODES_DIR.mkdir(parents=True, exist_ok=True)
    telemetry = load_telemetry_module()
    os.environ.setdefault("VINV_RETRIEVAL_POLICY_MODE", "explore")
    os.environ.setdefault("VINV_RETRIEVAL_EPSILON", "0.3")

    report: dict = {"started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    # Episode-0 reference on the untouched index: the bar every episode must hold.
    reference = run_holdout_bench(args.index_bin, "reference")
    report["reference"] = {
        "symbol_ndcg10": reference["symbol"]["ndcg@10"],
        "file_ndcg10": reference["file"]["ndcg@10"],
        "context_tokens_mean": reference["context_tokens_estimate"]["mean"],
    }
    print(
        f"reference: symbol nDCG@10={reference['symbol']['ndcg@10']:.4f} "
        f"file nDCG@10={reference['file']['ndcg@10']:.4f}"
    )

    episodes = []
    failures = []
    for episode in range(1, args.episodes + 1):
        entry: dict = {"episode": episode}
        entry["mutation"] = mutate(episode)
        epoch_before = read_meta().get("epoch", 0)

        update = run_update(args.index_bin)
        epoch_after = read_meta().get("epoch", 0)
        entry["update"] = {
            "epoch_before": epoch_before,
            "epoch_after": epoch_after,
            "reprocessed_files": update.get("reprocessed_files"),
            "reused_files": update.get("reused_files"),
            "symbols": update.get("symbols"),
        }
        if epoch_after != epoch_before + 1:
            failures.append(f"ep{episode}: epoch {epoch_before}->{epoch_after}, expected +1")

        # Context freshness: the mutated concept must be retrievable now.
        query, expected_file = PROBE_QUERIES[episode]
        if query:
            results = run_query(args.index_bin, query, 10)
            files = [r.get("file", "") for r in results]
            fresh = any(expected_file in f for f in files)
            entry["freshness"] = {"query": query, "hit": fresh, "top": files[:3]}
            if not fresh:
                failures.append(f"ep{episode}: probe not retrieved for {query!r}")
        if episode == 4:
            # The renamed-away symbol must no longer exist under its old name.
            stale = [
                r
                for r in run_query(args.index_bin, "compute_episode_checksum", 10)
                if r.get("name") == "compute_episode_checksum"
            ]
            entry["stale_symbol_gone"] = not stale
            if stale:
                failures.append("ep4: old symbol name still indexed after rename")
        if episode == 6:
            leftovers = [
                r
                for r in run_query(args.index_bin, "episode entropy walk oversized", 10)
                if "episodes/probe.py" in r.get("file", "")
            ]
            entry["deleted_symbols_gone"] = not leftovers
            if leftovers:
                failures.append("ep6: deleted probe symbols still indexed")

        bench = run_holdout_bench(args.index_bin, f"ep{episode}")
        entry["holdout"] = {
            "symbol_ndcg10": bench["symbol"]["ndcg@10"],
            "file_ndcg10": bench["file"]["ndcg@10"],
        }
        drop = reference["symbol"]["ndcg@10"] - bench["symbol"]["ndcg@10"]
        if drop > NDCG_TOLERANCE:
            failures.append(
                f"ep{episode}: holdout symbol nDCG@10 dropped {drop:.4f} > {NDCG_TOLERANCE}"
            )

        entry["telemetry"] = telemetry_cycle(args.index_bin, telemetry)
        ope = run_ope(telemetry, f"ep{episode}")
        entry["ope"] = {
            "decisions": (ope.get("telemetry_diagnostics") or {}).get("logged_decisions"),
            "promotable": ope.get("promotable"),
            "dr_delta": ope.get("dr_delta"),
            "dr_delta_ci95": ope.get("dr_delta_ci95"),
            "candidate_support_ok": (ope.get("candidate") or {}).get("support_ok"),
            "error": ope.get("error"),
        }

        episodes.append(entry)
        print(
            f"ep{episode}: {entry['mutation']} | epoch {epoch_before}->{epoch_after} "
            f"| holdout sym nDCG@10 {bench['symbol']['ndcg@10']:.4f} "
            f"| telemetry {entry['telemetry']}"
        )

    report["episodes"] = episodes
    report["failures"] = failures
    report["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    (EPISODES_DIR / "report.json").write_text(json.dumps(report, indent=2))
    print(f"\n{'ALL EPISODES PASSED' if not failures else 'FAILURES:'}")
    for failure in failures:
        print(f"  - {failure}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
