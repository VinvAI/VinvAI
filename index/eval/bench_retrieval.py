#!/usr/bin/env python3
"""Repository-grounded retrieval evaluation for ``index``.

Question files may use the compact ``file``/``symbol`` schema or an ``answers``
array containing graded targets. Results are evaluated at file and symbol level
with hit@k, MRR, nDCG, latency percentiles, and per-category summaries.
"""
import argparse
import json
import math
import os
import random
import shlex
import subprocess
import time
from collections import defaultdict
from pathlib import PurePosixPath


DEFAULT_KS = (1, 5, 10)
VALID_CATEGORIES = frozenset({"behavior", "identifier", "doc", "graph"})
VALID_SPLITS = frozenset({"dev", "holdout"})


def norm(path):
    """Normalize separators and harmless path syntax without touching case."""
    value = str(path or "").replace("\\", "/")
    if value.startswith("file://"):
        value = value[7:]
    absolute = value.startswith("/")
    parts = []
    for part in PurePosixPath(value).parts:
        if part in ("", "/", "."):
            continue
        if part == ".." and parts and parts[-1] != "..":
            parts.pop()
        else:
            parts.append(part)
    normalized = "/".join(parts)
    return f"/{normalized}" if absolute else normalized


def path_matches(actual, expected):
    """Match a repo-relative gold path on complete path-component boundaries."""
    actual_n, expected_n = norm(actual), norm(expected)
    if not actual_n or not expected_n:
        return False
    if expected_n.startswith("/"):
        return actual_n == expected_n
    return actual_n == expected_n or actual_n.endswith("/" + expected_n)


def _score_components(result):
    raw = result.get("score_decomposition") or result.get("score_components")
    components = dict(raw) if isinstance(raw, dict) else {}
    for name in ("dense", "sparse", "rrf", "pagerank", "graph", "rank_prior"):
        value = result.get(f"{name}_score")
        if isinstance(value, (int, float)):
            components.setdefault(name, float(value))
    return {
        str(name): float(value)
        for name, value in components.items()
        if isinstance(value, (int, float)) and math.isfinite(value)
    }


def result_fields(result):
    """Extract a normalized result across index and comparison-tool schemas."""
    r = result if isinstance(result, dict) else {}
    tgt = r.get("target")
    if isinstance(tgt, dict):
        f = tgt.get("file") or tgt.get("file_path") or tgt.get("path") or ""
        sid = tgt.get("symbol_id") or tgt.get("name") or ""
        symbol = sid.split("::")[-1] if sid else ""
    else:
        f = r.get("file") or r.get("path") or r.get("file_path") or ""
        symbol = r.get("name") or r.get("symbol") or r.get("symbol_name") or ""
    context_payload = {
        key: r.get(key)
        for key in ("summary", "snippet", "parent_context", "neighbors")
        if r.get(key) is not None
    }
    context_chars = len(json.dumps(context_payload, ensure_ascii=False, separators=(",", ":")))
    return {
        "file": norm(f),
        "symbol": str(symbol),
        "score": r.get("score"),
        "score_components": _score_components(r),
        "context_chars": context_chars,
        "context_tokens_estimate": math.ceil(context_chars / 4),
    }


def run_query(cmd, env=None):
    t0 = time.perf_counter()
    out = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        env=env,
    )
    dt = time.perf_counter() - t0
    txt = (out.stdout or "").strip()
    i = txt.find("{")
    try:
        d = json.loads(txt[i:]) if i >= 0 else {}
    except ValueError:
        d = {}
    results = d.get("results") or d.get("hits") or []
    error = d.get("error") or ((out.stderr or "").strip() if out.returncode else None)
    return [result_fields(r) for r in results], dt, error


def answers_for(question):
    answers = question.get("answers")
    if answers is None:
        answers = [{"file": question["file"], "symbol": question.get("symbol", ""), "relevance": 1}]
    normalized = []
    for answer in answers:
        relevance = float(answer.get("relevance", 1))
        if relevance > 0:
            normalized.append(
                {
                    "file": norm(answer["file"]),
                    "symbol": str(answer.get("symbol", "")),
                    "relevance": relevance,
                }
            )
    if not normalized:
        raise ValueError(f"question has no relevant answers: {question.get('q', '<unknown>')}")
    return normalized


def _match(result, answer, level):
    if not path_matches(result["file"], answer["file"]):
        return False
    return level == "file" or (bool(answer["symbol"]) and result["symbol"] == answer["symbol"])


def relevance_vector(results, answers, level):
    """Return gain labels, consuming each gold target at most once."""
    remaining = list(answers)
    gains = []
    for result in results:
        matches = [(i, a) for i, a in enumerate(remaining) if _match(result, a, level)]
        if not matches:
            gains.append(0.0)
            continue
        index, answer = max(matches, key=lambda pair: pair[1]["relevance"])
        gains.append(answer["relevance"])
        remaining.pop(index)
    return gains


def reciprocal_rank(gains):
    return next((1.0 / rank for rank, gain in enumerate(gains, 1) if gain > 0), 0.0)


def ndcg(gains, ideal_relevances, k):
    def dcg(values):
        return sum((2.0**gain - 1.0) / math.log2(rank + 1) for rank, gain in enumerate(values, 1))

    actual = dcg(gains[:k])
    ideal = dcg(sorted(ideal_relevances, reverse=True)[:k])
    return actual / ideal if ideal else 0.0


def score(results, question, top_k=None):
    answers = answers_for(question)
    limit = top_k or len(results)
    result = {}
    for level in ("file", "symbol"):
        gains = relevance_vector(results[:limit], answers, level)
        result[f"{level}_rank"] = next(
            (rank for rank, gain in enumerate(gains, 1) if gain > 0), None
        )
        result[f"{level}_gains"] = gains
        result[f"{level}_ndcg"] = ndcg(gains, [a["relevance"] for a in answers], limit)
    return result


def percentile(values, p):
    if not values:
        return 0.0
    ordered = sorted(values)
    pos = (len(ordered) - 1) * p
    lo, hi = math.floor(pos), math.ceil(pos)
    if lo == hi:
        return ordered[lo]
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo)


def aggregate(rows, level, ks=DEFAULT_KS):
    n = len(rows)
    ranks = [row[f"{level}_rank"] for row in rows]
    metrics = {
        f"hit@{k}": sum(rank is not None and rank <= k for rank in ranks) / n if n else 0.0
        for k in ks
    }
    metrics["mrr"] = sum(1.0 / rank for rank in ranks if rank) / n if n else 0.0
    for k in ks:
        metrics[f"ndcg@{k}"] = (
            sum(
                ndcg(
                    row[f"{level}_gains"],
                    [a["relevance"] for a in row["answers"]],
                    k,
                )
                for row in rows
            )
            / n
            if n
            else 0.0
        )
    return metrics


def paired_bootstrap_ndcg_delta(
    baseline_rows, candidate_rows, level, k, *, iterations=5000, seed=0
):
    """Paired bootstrap confidence interval for candidate-minus-baseline nDCG."""
    if len(baseline_rows) != len(candidate_rows) or not baseline_rows:
        raise ValueError("paired rows must be non-empty and have equal length")
    deltas = [
        ndcg(candidate[f"{level}_gains"], [a["relevance"] for a in candidate["answers"]], k)
        - ndcg(baseline[f"{level}_gains"], [a["relevance"] for a in baseline["answers"]], k)
        for baseline, candidate in zip(baseline_rows, candidate_rows, strict=True)
    ]
    rng = random.Random(seed)
    samples = []
    for _ in range(iterations):
        samples.append(
            sum(deltas[rng.randrange(len(deltas))] for _ in deltas) / len(deltas)
        )
    return {
        "mean": sum(deltas) / len(deltas),
        "ci95": [percentile(samples, 0.025), percentile(samples, 0.975)],
        "win_rate": sum(delta > 0 for delta in deltas) / len(deltas),
        "loss_rate": sum(delta < 0 for delta in deltas) / len(deltas),
    }


def summarize(rows, ks=DEFAULT_KS):
    latencies = [row["latency"] * 1000 for row in rows]
    context_tokens = [row["context_tokens_estimate"] for row in rows]
    return {
        "count": len(rows),
        "file": aggregate(rows, "file", ks),
        "symbol": aggregate(rows, "symbol", ks),
        "latency_ms": {"p50": percentile(latencies, 0.50), "p95": percentile(latencies, 0.95)},
        "context_tokens_estimate": {
            "mean": sum(context_tokens) / len(context_tokens) if context_tokens else 0.0,
            "p50": percentile(context_tokens, 0.50),
            "p95": percentile(context_tokens, 0.95),
        },
        "errors": sum(bool(row.get("error")) for row in rows),
    }


def decomposition_summary(rows):
    values = defaultdict(list)
    result_count = 0
    for row in rows:
        for result in row["results"]:
            if result["score_components"]:
                result_count += 1
            for name, value in result["score_components"].items():
                values[name].append(value)
    return {
        "results_with_components": result_count,
        "component_means": {
            name: sum(component_values) / len(component_values)
            for name, component_values in sorted(values.items())
        },
    }


def evaluate(label, rows, ks=DEFAULT_KS, include_decomposition=False):
    categories = defaultdict(list)
    for row in rows:
        categories[row["category"]].append(row)
    output = {
        "label": label,
        "overall": summarize(rows, ks),
        "categories": {
            category: summarize(category_rows, ks)
            for category, category_rows in sorted(categories.items())
        },
    }
    if include_decomposition:
        output["score_decomposition"] = decomposition_summary(rows)
    return output


def _metric_line(metrics, ks):
    hits = "  ".join(f"hit@{k}={metrics[f'hit@{k}']:.3f}" for k in ks)
    ndcgs = "  ".join(f"nDCG@{k}={metrics[f'ndcg@{k}']:.3f}" for k in ks)
    return f"{hits}  MRR={metrics['mrr']:.3f}  {ndcgs}"


def report(evaluation, ks=DEFAULT_KS):
    overall = evaluation["overall"]
    print(f"\n### {evaluation['label']} ({overall['count']} questions)")
    print(f"  file:    {_metric_line(overall['file'], ks)}")
    print(f"  symbol:  {_metric_line(overall['symbol'], ks)}")
    latency = overall["latency_ms"]
    print(f"  latency: p50={latency['p50']:.0f}ms  p95={latency['p95']:.0f}ms")
    context = overall["context_tokens_estimate"]
    print(
        "  context tokens (estimated): "
        f"mean={context['mean']:.0f}  p50={context['p50']:.0f}  p95={context['p95']:.0f}"
    )
    if overall["errors"]:
        print(f"  errors:  {overall['errors']}")
    print("  categories:")
    summary_k = max(ks)
    for category, summary in evaluation["categories"].items():
        print(
            f"    {category:<10} n={summary['count']:<3} "
            f"file MRR={summary['file']['mrr']:.3f} "
            f"symbol MRR={summary['symbol']['mrr']:.3f} "
            f"file nDCG@{summary_k}={summary['file'][f'ndcg@{summary_k}']:.3f}"
        )
    decomposition = evaluation.get("score_decomposition")
    if decomposition is not None:
        means = decomposition["component_means"]
        rendered = ", ".join(f"{name}={value:.5f}" for name, value in means.items())
        print(
            "  score decomposition: "
            f"{decomposition['results_with_components']} results"
            + (f"; mean {rendered}" if rendered else " (backend did not emit components)")
        )


def validate_questions(questions):
    if not isinstance(questions, list) or not questions:
        raise ValueError("questions file must contain a non-empty JSON array")
    for index, question in enumerate(questions, 1):
        if not isinstance(question, dict) or not str(question.get("q", "")).strip():
            raise ValueError(f"question {index} is missing q")
        category = question.get("category")
        if category not in VALID_CATEGORIES:
            raise ValueError(
                f"question {index} category must be one of {sorted(VALID_CATEGORIES)}"
            )
        answers_for(question)
        split = question.get("split", "dev")
        if split not in VALID_SPLITS:
            raise ValueError(
                f"question {index} split must be one of {sorted(VALID_SPLITS)}"
            )


def bench(questions, make_cmd, top_k):
    rows = []
    for item in questions:
        results, elapsed, error = make_cmd(item["q"], top_k)
        scored = score(results, item, top_k)
        rows.append(
            {
                **scored,
                "q": item["q"],
                "category": item["category"],
                "answers": answers_for(item),
                "latency": elapsed,
                "error": error,
                "results": results,
                "split": item.get("split", "dev"),
                "query_tokens_estimate": math.ceil(len(item["q"]) / 4),
                "context_tokens_estimate": sum(
                    result["context_tokens_estimate"] for result in results[:top_k]
                ),
            }
        )
    return rows


def _load_questions(path):
    with open(path, encoding="utf-8") as handle:
        questions = json.load(handle)
    validate_questions(questions)
    return questions


def _write_json(path, evaluations):
    payload = {"evaluations": evaluations}
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index-bin", default="index")
    ap.add_argument("--store-dir", required=True)
    ap.add_argument("--questions", required=True)
    ap.add_argument("--top-k", type=int, default=10)
    ap.add_argument("--other-bin")
    ap.add_argument("--other-args", help='template, e.g. "query {q} --repo-path /r --top-k {k}"')
    ap.add_argument("--score-decomposition", action="store_true")
    ap.add_argument(
        "--split",
        choices=("all", "dev", "holdout"),
        default="all",
        help="evaluate only the frozen development or untouched holdout partition",
    )
    ap.add_argument("--json-output", help="write machine-readable metrics to this path")
    args = ap.parse_args()

    if args.top_k < 1:
        ap.error("--top-k must be at least 1")
    questions = _load_questions(args.questions)
    if args.split != "all":
        questions = [
            question
            for question in questions
            if question.get("split", "dev") == args.split
        ]
        if not questions:
            ap.error(f"questions file has no {args.split!r} entries")
    ks = tuple(sorted({k for k in (*DEFAULT_KS, args.top_k) if k <= args.top_k}))

    idx_rows = bench(
        questions,
        lambda q, k: run_query(
            [args.index_bin, "query", q, "--store-dir", args.store_dir, "--top-k", str(k)]
        ),
        args.top_k,
    )
    evaluations = [
        evaluate(
            f"index ({os.path.basename(args.index_bin)})",
            idx_rows,
            ks,
            args.score_decomposition,
        )
    ]

    if args.other_bin and args.other_args:
        def other(q, k):
            parts = [
                part.replace("{q}", q).replace("{k}", str(k))
                for part in shlex.split(args.other_args)
            ]
            return run_query([args.other_bin, *parts])

        evaluations.append(
            evaluate("other tool", bench(questions, other, args.top_k), ks, args.score_decomposition)
        )

    for evaluation in evaluations:
        report(evaluation, ks)
    if args.json_output:
        _write_json(args.json_output, evaluations)


if __name__ == "__main__":
    main()
