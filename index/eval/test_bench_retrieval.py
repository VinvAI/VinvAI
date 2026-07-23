import json
import math
import re
import unittest
from pathlib import Path

import bench_retrieval as bench


EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parents[1]


def result(file, symbol="", components=None):
    return {
        "file": bench.norm(file),
        "symbol": symbol,
        "score": None,
        "score_components": components or {},
        "context_chars": 0,
        "context_tokens_estimate": 0,
    }


def row(rank, gains, latency=0.1, category="behavior"):
    return {
        "file_rank": rank,
        "symbol_rank": rank,
        "file_gains": gains,
        "symbol_gains": gains,
        "answers": [{"file": "answer.py", "symbol": "answer", "relevance": 1.0}],
        "latency": latency,
        "category": category,
        "error": None,
        "results": [],
        "context_tokens_estimate": 0,
    }


class PathMatchingTests(unittest.TestCase):
    def test_matches_repo_relative_path_against_absolute_result(self):
        self.assertTrue(
            bench.path_matches(
                "/tmp/checkout/Vinv/index/src/search.rs", "index/src/search.rs"
            )
        )

    def test_matches_windows_separators(self):
        self.assertTrue(
            bench.path_matches(
                r"C:\checkout\Vinv\index\src\search.rs", "index/src/search.rs"
            )
        )

    def test_rejects_plain_string_suffix_without_component_boundary(self):
        self.assertFalse(
            bench.path_matches(
                "/tmp/checkout/not-index/src/search.rs", "index/src/search.rs"
            )
        )
        self.assertFalse(bench.path_matches("mysearch.rs", "search.rs"))

    def test_normalizes_dot_segments(self):
        self.assertTrue(
            bench.path_matches(
                "/tmp/checkout/Vinv/index/src/../src/search.rs", "index/src/search.rs"
            )
        )

    def test_absolute_gold_path_requires_exact_match(self):
        self.assertFalse(bench.path_matches("/other/search.rs", "/repo/search.rs"))


class MetricTests(unittest.TestCase):
    def test_reciprocal_rank_and_single_relevant_ndcg(self):
        gains = [0.0, 1.0, 0.0]
        self.assertEqual(bench.reciprocal_rank(gains), 0.5)
        self.assertAlmostEqual(bench.ndcg(gains, [1.0], 3), 1.0 / math.log2(3))

    def test_graded_ndcg_uses_exponential_gain(self):
        actual = bench.ndcg([1.0, 3.0], [3.0, 1.0], 2)
        expected = (
            1.0 + 7.0 / math.log2(3)
        ) / (
            7.0 + 1.0 / math.log2(3)
        )
        self.assertAlmostEqual(actual, expected)

    def test_duplicate_result_does_not_reuse_one_gold_answer(self):
        answers = [{"file": "src/a.py", "symbol": "target", "relevance": 1.0}]
        results = [
            result("src/a.py", "target"),
            result("src/a.py", "target"),
        ]
        self.assertEqual(
            bench.relevance_vector(results, answers, "symbol"), [1.0, 0.0]
        )

    def test_file_and_symbol_ranks_are_scored_independently(self):
        question = {
            "q": "target",
            "file": "src/a.py",
            "symbol": "target",
            "category": "identifier",
        }
        scored = bench.score(
            [
                result("/repo/src/a.py", "other"),
                result("/repo/src/a.py", "target"),
            ],
            question,
            2,
        )
        self.assertEqual(scored["file_rank"], 1)
        self.assertEqual(scored["symbol_rank"], 2)

    def test_aggregate_metrics_include_misses_in_denominator(self):
        rows = [row(1, [1.0]), row(2, [0.0, 1.0]), row(None, [0.0, 0.0])]
        metrics = bench.aggregate(rows, "file", (1, 2))
        self.assertAlmostEqual(metrics["hit@1"], 1 / 3)
        self.assertAlmostEqual(metrics["hit@2"], 2 / 3)
        self.assertAlmostEqual(metrics["mrr"], 0.5)
        self.assertAlmostEqual(
            metrics["ndcg@2"], (1.0 + 1.0 / math.log2(3)) / 3
        )

    def test_latency_percentiles_use_linear_interpolation(self):
        self.assertEqual(bench.percentile([10, 20, 30], 0.5), 20)
        self.assertAlmostEqual(bench.percentile([10, 20], 0.95), 19.5)

    def test_evaluate_groups_categories(self):
        evaluation = bench.evaluate(
            "test",
            [row(1, [1.0], category="behavior"), row(None, [0.0], category="doc")],
            (1,),
        )
        self.assertEqual(evaluation["overall"]["count"], 2)
        self.assertEqual(set(evaluation["categories"]), {"behavior", "doc"})
        self.assertEqual(evaluation["categories"]["behavior"]["file"]["hit@1"], 1.0)

    def test_score_decomposition_accepts_nested_and_flat_fields(self):
        nested = bench.result_fields(
            {"file": "a.py", "name": "a", "score_components": {"dense": 0.4}}
        )
        flat = bench.result_fields(
            {"file": "b.py", "name": "b", "sparse_score": 1.25}
        )
        self.assertEqual(nested["score_components"], {"dense": 0.4})
        self.assertEqual(flat["score_components"], {"sparse": 1.25})

    def test_result_context_budget_counts_returned_evidence(self):
        parsed = bench.result_fields(
            {
                "file": "a.py",
                "name": "a",
                "summary": "summary",
                "snippet": "return answer",
                "neighbors": [{"name": "caller"}],
            }
        )
        self.assertGreater(parsed["context_chars"], 0)
        self.assertEqual(
            parsed["context_tokens_estimate"],
            math.ceil(parsed["context_chars"] / 4),
        )

    def test_paired_bootstrap_detects_consistent_ndcg_gain(self):
        baseline = [row(2, [0.0, 1.0]) for _ in range(20)]
        candidate = [row(1, [1.0, 0.0]) for _ in range(20)]
        delta = bench.paired_bootstrap_ndcg_delta(
            baseline, candidate, "symbol", 2, iterations=500, seed=7
        )
        self.assertGreater(delta["mean"], 0)
        self.assertGreater(delta["ci95"][0], 0)
        self.assertEqual(delta["win_rate"], 1.0)


class GoldSetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.questions = json.loads(
            (EVAL_DIR / "questions.vinv.json").read_text(encoding="utf-8")
        )

    def test_gold_set_is_large_balanced_and_valid(self):
        bench.validate_questions(self.questions)
        self.assertGreaterEqual(len(self.questions), 50)
        counts = {
            category: sum(q["category"] == category for q in self.questions)
            for category in bench.VALID_CATEGORIES
        }
        self.assertTrue(all(count >= 10 for count in counts.values()), counts)

    def test_every_gold_file_and_symbol_exists(self):
        for question in self.questions:
            for answer in bench.answers_for(question):
                path = REPO_ROOT / answer["file"]
                self.assertTrue(path.is_file(), answer["file"])
                text = path.read_text(encoding="utf-8")
                symbol = answer["symbol"]
                if path.suffix == ".md":
                    headings = {
                        line.lstrip("#").strip()
                        for line in text.splitlines()
                        if line.lstrip().startswith("#")
                    }
                    self.assertIn(symbol, headings, f"{answer['file']}::{symbol}")
                else:
                    self.assertRegex(
                        text,
                        rf"\b{re.escape(symbol)}\b",
                        f"{answer['file']}::{symbol}",
                    )


class HoldoutSetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dev = json.loads(
            (EVAL_DIR / "questions.vinv.json").read_text(encoding="utf-8")
        )
        cls.holdout = json.loads(
            (EVAL_DIR / "questions.vinv.holdout.json").read_text(encoding="utf-8")
        )

    def test_holdout_is_balanced_valid_and_explicit(self):
        bench.validate_questions(self.holdout)
        self.assertTrue(all(q["split"] == "holdout" for q in self.holdout))
        counts = {
            category: sum(q["category"] == category for q in self.holdout)
            for category in bench.VALID_CATEGORIES
        }
        self.assertTrue(all(count >= 4 for count in counts.values()), counts)

    def test_holdout_queries_and_targets_do_not_duplicate_development_set(self):
        dev_queries = {q["q"].casefold().strip() for q in self.dev}
        dev_targets = {
            (answer["file"], answer["symbol"])
            for question in self.dev
            for answer in bench.answers_for(question)
        }
        for question in self.holdout:
            self.assertNotIn(question["q"].casefold().strip(), dev_queries)
            for answer in bench.answers_for(question):
                self.assertNotIn((answer["file"], answer["symbol"]), dev_targets)

    def test_every_holdout_target_exists(self):
        for question in self.holdout:
            for answer in bench.answers_for(question):
                path = REPO_ROOT / answer["file"]
                self.assertTrue(path.is_file(), answer["file"])
                self.assertIn(answer["symbol"], path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
