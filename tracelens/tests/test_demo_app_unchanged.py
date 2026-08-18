"""demo_app tree must stay read-only."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1]


def test_demo_app_git_clean() -> None:
    r = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=PKG,
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        pytest.skip("not a git checkout")
    top = Path(r.stdout.strip())
    candidates = [
        top / "vinv" / "tracelens" / "tests" / "integration" / "demo_app",
        PKG / "tests" / "integration" / "demo_app",
    ]
    demo = next((p for p in candidates if p.is_dir()), None)
    if demo is None:
        pytest.skip("demo_app not found")
    rel = str(demo.resolve().relative_to(top))
    subprocess.run(
        ["git", "-C", str(top), "diff", "--quiet", "HEAD", "--", rel],
        check=True,
    )
