#!/usr/bin/env python3
"""Tune retrieval on development questions, then open the frozen holdout once."""

import argparse
import json
import os
import subprocess
from pathlib import Path

import bench_retrieval as bench


def build_store(index_bin, repo, store, mode, no_summarize):
    env = {**os.environ, "INDEX_EMBED_MODE": mode}
    command = [index_bin, "index", repo, "--store-dir", str(store), "--force"]
    if no_summarize:
        command.append("--no-summarize")
    result = subprocess.run(command, capture_output=True, text=True, env=env, check=False)
    if result.returncode:
        raise RuntimeError(f"index build failed for {mode}: {result.stderr or result.stdout}")


def run_policy(index_bin, store, questions, mode, rank_weight, top_k):
    env = {
        **os.environ,
        "INDEX_EMBED_MODE": mode,
        "INDEX_RANK_WEIGHT": str(rank_weight),
    }
    return bench.bench(
        questions,
        lambda query, k: bench.run_query(
            [index_bin, "query", query, "--store-dir", str(store), "--top-k", str(k)],
            env=env,
        ),
        top_k,
    )


def utility(evaluation, top_k, context_penalty):
    quality = evaluation["overall"]["symbol"][f"ndcg@{top_k}"]
    tokens = evaluation["overall"]["context_tokens_estimate"]["mean"]
    return quality - context_penalty * tokens / 1000


def target_files(questions):
    out = set()
    for question in questions:
        if "file" in question:
            out.add(question["file"])
        for answer in question.get("answers", []):
            out.add(answer["file"])
    return out


def assert_holdout_disjoint(dev, holdout):
    """Refuse to run with target-file leakage between tuning and holdout.

    A holdout question whose gold file also appears as a development target
    rewards whatever representation was tuned for that file, silently inflating
    the holdout estimate.
    """
    overlap = target_files(dev) & target_files(holdout)
    if overlap:
        raise RuntimeError(
            "holdout target files overlap the development set: "
            + ", ".join(sorted(overlap))
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--index-bin", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--dev-questions", default="eval/questions.vinv.json")
    parser.add_argument("--holdout-questions", default="eval/questions.vinv.holdout.json")
    parser.add_argument("--modes", default="docstring,signature,full")
    parser.add_argument("--rank-weights", default="0.005,0,0.0025,0.01")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--context-penalty", type=float, default=0.01)
    parser.add_argument(
        "--material-regression",
        type=float,
        default=0.02,
        help="holdout symbol-nDCG regression beyond which promotion is refused "
        "even if the CI is inconclusive",
    )
    parser.add_argument("--no-summarize", action="store_true")
    parser.add_argument("--reuse-stores", action="store_true")
    parser.add_argument("--json-output", required=True)
    args = parser.parse_args()

    modes = [value.strip() for value in args.modes.split(",") if value.strip()]
    weights = [float(value) for value in args.rank_weights.split(",")]
    if not modes or not weights or args.top_k < 1:
        parser.error("at least one mode/weight and positive top-k are required")
    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    dev = bench._load_questions(args.dev_questions)
    holdout = bench._load_questions(args.holdout_questions)
    assert_holdout_disjoint(dev, holdout)

    stores = {}
    for mode in modes:
        store = work_dir / mode
        if not args.reuse_stores:
            build_store(args.index_bin, args.repo, store, mode, args.no_summarize)
        elif not (store / "meta.json").is_file():
            raise RuntimeError(f"cannot reuse missing store for {mode}: {store}")
        stores[mode] = store

    candidates = []
    candidate_rows = {}
    for mode in modes:
        for weight in weights:
            label = f"{mode}:rank={weight:g}"
            rows = run_policy(
                args.index_bin, stores[mode], dev, mode, weight, args.top_k
            )
            evaluation = bench.evaluate(label, rows, (1, 5, args.top_k), True)
            candidates.append(
                {
                    "mode": mode,
                    "rank_weight": weight,
                    "utility": utility(
                        evaluation, args.top_k, args.context_penalty
                    ),
                    "evaluation": evaluation,
                }
            )
            candidate_rows[label] = rows

    baseline = candidates[0]
    winner = max(candidates, key=lambda candidate: candidate["utility"])
    baseline_label = baseline["evaluation"]["label"]
    winner_label = winner["evaluation"]["label"]
    dev_delta = bench.paired_bootstrap_ndcg_delta(
        candidate_rows[baseline_label],
        candidate_rows[winner_label],
        "symbol",
        args.top_k,
    )

    holdout_rows = {}
    for candidate in (baseline, winner):
        label = candidate["evaluation"]["label"]
        if label in holdout_rows:
            continue
        holdout_rows[label] = run_policy(
            args.index_bin,
            stores[candidate["mode"]],
            holdout,
            candidate["mode"],
            candidate["rank_weight"],
            args.top_k,
        )
    holdout_delta = bench.paired_bootstrap_ndcg_delta(
        holdout_rows[baseline_label],
        holdout_rows[winner_label],
        "symbol",
        args.top_k,
    )
    # The selection protocol is recorded verbatim so a reader can verify
    # nothing was chosen after peeking at the holdout: one winner is
    # pre-registered on development utility, then the holdout is opened
    # exactly once for baseline-vs-winner.
    payload = {
        "pre_registration": {
            "rule": "argmax development utility; open holdout once for winner only",
            "metric": f"symbol_ndcg@{args.top_k} - context_penalty * estimated_tokens / 1000",
            "context_penalty": args.context_penalty,
            "grid": {
                "modes": modes,
                "rank_weights": weights,
            },
            "material_regression": args.material_regression,
        },
        "baseline": baseline,
        "winner": winner,
        "candidates": candidates,
        "development_delta": dev_delta,
        "holdout_delta": holdout_delta,
        "promote": bool(
            winner_label != baseline_label
            and holdout_delta["ci95"][0] > -args.material_regression
            and holdout_delta["mean"] >= 0
        ),
        "holdout": {
            label: bench.evaluate(label, rows, (1, 5, args.top_k), True)
            for label, rows in holdout_rows.items()
        },
    }
    Path(args.json_output).write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps({"winner": winner_label, "holdout_delta": holdout_delta}, indent=2))


if __name__ == "__main__":
    main()
