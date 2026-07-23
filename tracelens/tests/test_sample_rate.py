"""Statistical band for ParentBased(TraceIdRatioBased) at 0.5 vs 1.0 (spec §5.12)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

_SCRIPT = """
from opentelemetry import trace
tr = trace.get_tracer("sample_probe")
for _ in range(500):
    with tr.start_as_current_span("root"):
        pass
"""


def _count_enter_lines(log: Path) -> int:
    n = 0
    with log.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if obj.get("event") == "enter" and obj.get("component") == "root":
                n += 1
    return n


@pytest.mark.parametrize(
    "rate,expect_min,expect_max",
    [("1.0", 470, 530), ("0.5", 180, 320)],
)
def test_sample_rate_trace_ratio(
    tmp_path: Path, rate: str, expect_min: int, expect_max: int
) -> None:
    script = tmp_path / "emit.py"
    script.write_text(_SCRIPT, encoding="utf-8")
    out = tmp_path / f"trace_{rate}.jsonl"
    env = {**os.environ}
    r = subprocess.run(
        [
            sys.executable,
            "-m",
            "tracelens.cli",
            "run",
            "-o",
            str(out),
            "-t",
            "x",
            "--sample-rate",
            rate,
            "--no-otel-autoinst",
            "--",
            sys.executable,
            str(script),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        env=env,
        timeout=180,
        check=False,
    )
    assert r.returncode == 0, r.stderr + r.stdout
    n = _count_enter_lines(out)
    assert expect_min <= n <= expect_max, f"rate={rate} enters={n}"
