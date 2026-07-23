import json
import tempfile
import unittest
from pathlib import Path

import off_policy


def write_events(events):
    raw = tempfile.mkdtemp()
    target = Path(raw) / "telemetry.jsonl"
    target.write_text(
        "".join(json.dumps(event) + "\n" for event in events),
        encoding="utf-8",
    )
    return target


class OffPolicyTests(unittest.TestCase):
    def test_doubly_robust_estimate_and_support_diagnostics(self):
        samples = [
            {
                "decision_id": f"d-{index}",
                "action": 5 if index % 2 else 3,
                "propensity": 0.5,
                "reward": 0.8 if index % 2 else 0.2,
            }
            for index in range(400)
        ]
        result = off_policy.estimate(samples, target_top_k=5)
        self.assertAlmostEqual(result["snips"], 0.8)
        self.assertAlmostEqual(result["doubly_robust"], 0.8)
        self.assertEqual(result["overlap"], 0.5)
        self.assertGreaterEqual(result["effective_sample_size"], 199)
        self.assertTrue(result["support_ok"])

        unsupported = off_policy.estimate(samples, target_top_k=10)
        self.assertIsNone(unsupported["snips"])
        self.assertEqual(unsupported["effective_sample_size"], 0)
        self.assertFalse(unsupported["support_ok"])

    def test_rare_epsilon_greedy_action_is_supported_by_ess_not_overlap(self):
        # Epsilon-greedy with eps=0.1 over 4 actions gives non-greedy arms a
        # 0.025 propensity: raw overlap is far below the old 10% gate, yet the
        # estimate is identified. The gate must key on effective sample size.
        samples = []
        for index in range(12000):
            explored = index % 40 == 0  # 2.5% of draws hit the target arm
            samples.append(
                {
                    "decision_id": f"d-{index}",
                    "action": 8 if explored else 5,
                    "propensity": 0.025 if explored else 0.925,
                    "reward": 0.9 if explored else 0.5,
                }
            )
        result = off_policy.estimate(samples, target_top_k=8)
        self.assertLess(result["overlap"], 0.1)
        self.assertGreaterEqual(result["effective_sample_size"], 100)
        self.assertTrue(result["support_ok"])
        self.assertAlmostEqual(result["snips"], 0.9)

    def test_default_clip_aligns_with_logged_propensities(self):
        samples = [
            {
                "decision_id": f"d-{index}",
                "action": 3 if index % 4 == 0 else 5,
                "propensity": 0.025 if index % 4 == 0 else 0.925,
                "reward": 1.0,
            }
            for index in range(400)
        ]
        aligned = off_policy.estimate(samples, target_top_k=3)
        self.assertEqual(aligned["clipped_fraction"], 0)
        self.assertAlmostEqual(aligned["weight_clip_used"], 40.0)
        clipped = off_policy.estimate(samples, target_top_k=3, weight_clip=10.0)
        self.assertGreater(clipped["clipped_fraction"], 0)

    def test_cross_fitting_folds_are_stratified_by_action(self):
        # One rare action with exactly two samples: stratification must place
        # one in each fold so neither cross-fitted model is starved of it.
        samples = [
            {
                "decision_id": f"common-{index}",
                "action": 5,
                "propensity": 0.9,
                "reward": 0.5,
            }
            for index in range(20)
        ] + [
            {
                "decision_id": f"rare-{index}",
                "action": 10,
                "propensity": 0.05,
                "reward": 1.0,
            }
            for index in range(2)
        ]
        folds = off_policy._stratified_folds(samples)
        rare_folds = sorted(folds[f"rare-{index}"] for index in range(2))
        self.assertEqual(rare_folds, [0, 1])
        # Every fold's training split therefore contains the rare action, so
        # the direct method uses its observed mean rather than the global mean.
        result = off_policy.estimate(
            samples, target_top_k=10, min_ess=1, min_samples=1
        )
        self.assertAlmostEqual(result["direct_method"], 1.0)

    def test_loader_joins_feedback_and_enforces_epoch(self):
        events = [
            {
                "type": "decision",
                "decision_id": "one",
                "epoch": "current",
                "action": {"top_k": 5},
                "propensity": 1,
            },
            {
                "type": "feedback",
                "decision_id": "one",
                "epoch": "current",
                "reward": 1,
            },
            {
                "type": "decision",
                "decision_id": "stale",
                "epoch": "old",
                "action": {"top_k": 3},
                "propensity": 1,
            },
        ]
        samples, diagnostics = off_policy.load_samples(
            write_events(events), "current"
        )
        self.assertEqual(
            samples,
            [
                {
                    "decision_id": "one",
                    "action": 5,
                    "propensity": 1.0,
                    "reward": 1.0,
                    "epoch": "current",
                }
            ],
        )
        self.assertEqual(diagnostics["logged_decisions"], 1)
        self.assertEqual(diagnostics["explicit_feedback_rate"], 1.0)

    def test_loader_pools_epochs_and_consistency_guard_reads_them(self):
        events = []
        # Two epochs, both with enough samples to qualify for the guard. In
        # epoch A the candidate (10) beats the baseline (5); in epoch B it
        # LOSES badly — pooling must surface the contradiction.
        for epoch, candidate_reward in (("A", 1.0), ("B", 0.0)):
            for i in range(off_policy.EPOCH_CONSISTENCY_MIN_N):
                for action, reward in ((5, 0.5), (10, candidate_reward)):
                    decision_id = f"{epoch}-{action}-{i}"
                    events.append(
                        {
                            "type": "decision",
                            "decision_id": decision_id,
                            "epoch": epoch,
                            "action": {"top_k": action},
                            "propensity": 0.5,
                        }
                    )
                    events.append(
                        {
                            "type": "feedback",
                            "decision_id": decision_id,
                            "epoch": epoch,
                            "reward": reward,
                        }
                    )
        samples, _ = off_policy.load_samples(write_events(events), off_policy.POOL_ALL)
        self.assertEqual(len(samples), 4 * off_policy.EPOCH_CONSISTENCY_MIN_N)
        consistency = off_policy.epoch_consistency(
            samples, baseline_top_k=5, target_top_k=10
        )
        self.assertEqual(len(consistency["epochs"]), 2)
        self.assertFalse(consistency["ok"])
        # Restricting to the consistent epoch alone passes the guard.
        epoch_a = [s for s in samples if s["epoch"] == "A"]
        self.assertTrue(
            off_policy.epoch_consistency(epoch_a, 5, 10)["ok"]
        )

    def test_bca_delta_interval_covers_a_real_effect_at_small_n(self):
        # ~60 pooled samples with a genuine large effect: candidate action 10
        # rewards 1.0, baseline 5 rewards 0.0, epsilon-greedy-style logged
        # propensities. The BCa LCB must clear zero (the gate must be able to
        # FIRE at realistic volume), and support must pass the small-n gates.
        samples = []
        for i in range(30):
            samples.append(
                {
                    "decision_id": f"b{i}",
                    "action": 5,
                    "propensity": 0.9,
                    "reward": 0.0,
                    "epoch": "e",
                }
            )
            samples.append(
                {
                    "decision_id": f"c{i}",
                    "action": 10,
                    "propensity": 0.1,
                    "reward": 1.0,
                    "epoch": "e",
                }
            )
        interval = off_policy.bootstrap_dr_delta(
            samples, baseline_top_k=5, target_top_k=10, iterations=400
        )
        self.assertGreater(interval[0], 0.0)
        candidate = off_policy.estimate(samples, 10)
        baseline = off_policy.estimate(samples, 5)
        self.assertTrue(candidate["support_ok"])
        self.assertTrue(baseline["support_ok"])

    def test_action_pull_floor_blocks_unsupported_cells(self):
        # 45 samples but only 3 pulls of the candidate action: ESS and count
        # gates could pass, the per-action floor must not.
        samples = []
        for i in range(42):
            samples.append(
                {
                    "decision_id": f"b{i}",
                    "action": 5,
                    "propensity": 0.9,
                    "reward": 0.5,
                    "epoch": "e",
                }
            )
        for i in range(3):
            samples.append(
                {
                    "decision_id": f"c{i}",
                    "action": 10,
                    "propensity": 0.1,
                    "reward": 1.0,
                    "epoch": "e",
                }
            )
        self.assertFalse(off_policy.estimate(samples, 10)["support_ok"])

    def test_loader_excludes_fallback_decisions_and_separates_sources(self):
        events = [
            {
                "type": "decision",
                "decision_id": "served",
                "epoch": "e",
                "action": {"top_k": 3},
                "propensity": 0.05,
            },
            {
                "type": "feedback",
                "decision_id": "served",
                "epoch": "e",
                "source": "auxiliary",
                "reward": 0.5,
            },
            {
                "type": "decision",
                "decision_id": "fell-back",
                "epoch": "e",
                "action": {"top_k": 3},
                "propensity": 0.05,
                "fallback": True,
            },
            {
                "type": "feedback",
                "decision_id": "fell-back",
                "epoch": "e",
                "source": "explicit",
                "reward": -1,
            },
        ]
        explicit, diagnostics = off_policy.load_samples(write_events(events), "e")
        self.assertEqual(explicit, [])
        self.assertEqual(diagnostics["fallback_decisions_excluded"], 1)
        auxiliary, _ = off_policy.load_samples(
            write_events(events), "e", reward_source="auxiliary"
        )
        self.assertEqual(len(auxiliary), 1)
        self.assertEqual(auxiliary[0]["decision_id"], "served")
        any_source, _ = off_policy.load_samples(
            write_events(events), "e", reward_source="any"
        )
        self.assertEqual(len(any_source), 1)

    def test_promotion_path_requires_support_and_positive_delta(self):
        # Candidate action 3 dominates the baseline 5 with abundant explicit
        # feedback under epsilon-greedy logging: the doubly robust delta CI
        # must sit above zero and both supports must clear the ESS gate.
        samples = []
        for index in range(4000):
            explored = index % 10 == 0
            samples.append(
                {
                    "decision_id": f"d-{index}",
                    "action": 3 if explored else 5,
                    "propensity": 0.1 if explored else 0.9,
                    "reward": 0.9 if explored else 0.3,
                }
            )
        candidate = off_policy.estimate(samples, target_top_k=3)
        baseline = off_policy.estimate(samples, target_top_k=5)
        self.assertTrue(candidate["support_ok"])
        self.assertTrue(baseline["support_ok"])
        interval = off_policy.bootstrap_dr_delta(
            samples, baseline_top_k=5, target_top_k=3, iterations=200
        )
        self.assertGreater(interval[0], 0)
        # And the reverse comparison must not be promotable.
        reverse = off_policy.bootstrap_dr_delta(
            samples, baseline_top_k=3, target_top_k=5, iterations=200
        )
        self.assertLess(reverse[1], 0)


if __name__ == "__main__":
    unittest.main()
