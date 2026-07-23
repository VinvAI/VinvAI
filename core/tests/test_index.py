from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


_MODULE_PATH = Path(__file__).parents[1] / "src" / "core" / "index.py"
_SPEC = importlib.util.spec_from_file_location("core_native_index_test", _MODULE_PATH)
assert _SPEC is not None and _SPEC.loader is not None
native_index = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(native_index)


class IndexAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.binary = self.root / "vinv-index"
        self.binary.write_text("#!/bin/sh\n", encoding="utf-8")
        self.binary.chmod(0o755)

    def test_default_store_is_repo_local(self) -> None:
        self.assertEqual(
            native_index.default_store_dir(self.root),
            self.root.resolve() / ".vinv" / "index",
        )

    def test_run_uses_argv_and_parses_last_json_line(self) -> None:
        completed = subprocess.CompletedProcess(
            [],
            0,
            stdout='progress line\n{"status":"ok","operation":"query","results":[]}\n',
            stderr="",
        )
        with mock.patch.object(native_index.subprocess, "run", return_value=completed) as run:
            result = native_index.run_index_command(
                ["query", "spaces and ; shell syntax"],
                binary=self.binary,
            )

        run.assert_called_once()
        args, kwargs = run.call_args
        self.assertEqual(
            args[0],
            [str(self.binary.resolve()), "query", "spaces and ; shell syntax"],
        )
        self.assertTrue(kwargs["capture_output"])
        self.assertFalse(kwargs["check"])
        self.assertEqual(result["status"], "ok")

    def test_nonzero_json_error_is_typed(self) -> None:
        completed = subprocess.CompletedProcess(
            [],
            2,
            stdout=json.dumps({"status": "error", "error": "gateway unavailable"}),
            stderr="details",
        )
        with (
            mock.patch.object(native_index.subprocess, "run", return_value=completed),
            self.assertRaisesRegex(native_index.IndexCommandError, "gateway unavailable") as caught,
        ):
            native_index.run_index_command(["query", "x"], binary=self.binary)

        self.assertEqual(caught.exception.returncode, 2)
        self.assertEqual(caught.exception.stderr, "details")

    def test_index_compatibility_wrapper_uses_canonical_store(self) -> None:
        payload = {
            "status": "ok",
            "operation": "index",
            "index_dir": str(self.root / ".vinv" / "index"),
            "files": 3,
            "symbols": 7,
        }
        with mock.patch.object(native_index, "run_index_command", return_value=payload) as run:
            result = native_index.index_codebase(
                str(self.root),
                languages="python",
                force_reindex=True,
            )

        run.assert_called_once_with(
            [
                "index",
                str(self.root.resolve()),
                "--store-dir",
                str(self.root.resolve() / ".vinv" / "index"),
                "--languages",
                "python",
                "--force",
            ],
            binary=None,
            timeout=None,
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["store_dir"], str(self.root / ".vinv" / "index"))
        self.assertEqual(result["stats"]["symbols_total"], 7)

    def _query_payload(self) -> dict:
        return {
            "status": "ok",
            "results": [
                {
                    "file": "src/app.py",
                    "name": "handle_request",
                    "lang": "python",
                    "lines": [10, 20],
                    "summary": "Handles a request.",
                    "snippet": "def handle_request(): ...",
                    "score": 0.9,
                    "neighbors": [],
                    "parent_context": [],
                }
            ],
        }

    def test_retrieve_code_preserves_legacy_result_shape(self) -> None:
        with (
            mock.patch.dict(
                native_index.os.environ, {"VINV_HOME": str(self.root / "home")}
            ),
            mock.patch.object(
                native_index, "run_index_command", return_value=self._query_payload()
            ),
        ):
            result = native_index.retrieve_code(
                "request handler",
                repo_path=str(self.root),
            )

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["results"][0]["target"]["file_path"], "src/app.py")
        self.assertEqual(result["results"][0]["target"]["symbol_id"], "handle_request")

    def test_retrieve_code_logs_a_content_safe_decision_event(self) -> None:
        """The Python surface writes the same bandit ledger as the editor MCP."""
        from core import retrieval_telemetry as telemetry

        home = self.root / "home"
        with (
            mock.patch.dict(
                native_index.os.environ,
                {"VINV_HOME": str(home), "VINV_RETRIEVAL_POLICY_MODE": "shadow"},
            ),
            mock.patch.object(
                native_index, "run_index_command", return_value=self._query_payload()
            ),
        ):
            result = native_index.retrieve_code(
                "secret internal query text",
                repo_path=str(self.root),
            )
            expected_epoch = telemetry.retrieval_epoch(
                native_index.default_store_dir(str(self.root))
            )

        ledger = home / "telemetry" / "retrieval.jsonl"
        self.assertTrue(ledger.exists())
        raw = ledger.read_text(encoding="utf-8").strip()
        self.assertNotIn("secret internal query", raw)  # content-safe
        event = json.loads(raw.splitlines()[-1])
        self.assertEqual(event["type"], "decision")
        self.assertEqual(event["decision_id"], result["vinv_decision_id"])
        self.assertEqual(event["epoch"], expected_epoch)
        self.assertEqual(event["surface"], "python-agent")
        self.assertEqual(event["action"], {"top_k": 5, "policy": "baseline"})
        self.assertEqual(event["propensity"], 1.0)
        self.assertEqual(event["result_count"], 1)
        self.assertEqual(len(event["result_hashes"]), 1)

    def test_explore_mode_propensities_match_the_editor_contract(self) -> None:
        """propensity(a) = eps/|A| + (1-eps)*[a == requested], as in the TS side."""
        from core import retrieval_telemetry as telemetry

        with mock.patch.dict(
            native_index.os.environ,
            {
                "VINV_RETRIEVAL_POLICY_MODE": "explore",
                "VINV_RETRIEVAL_ACTIONS": "3,5,8,10",
                "VINV_RETRIEVAL_EPSILON": "0.2",
            },
        ):
            greedy = telemetry.select_retrieval_action(5, random_value=0.9)
            self.assertEqual(greedy["top_k"], 5)
            self.assertAlmostEqual(greedy["propensity"], 0.2 / 4 + 0.8)

            explored = telemetry.select_retrieval_action(5, random_value=0.01)
            self.assertEqual(explored["top_k"], 3)  # 0.01/0.2 = 0.05 -> index 0
            self.assertEqual(explored["policy"], "explore")
            self.assertAlmostEqual(explored["propensity"], 0.2 / 4)


if __name__ == "__main__":
    unittest.main()
