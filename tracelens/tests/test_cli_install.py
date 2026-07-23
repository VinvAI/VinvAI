import os
import subprocess
import sys
from pathlib import Path


def test_install_check() -> None:
    root = Path(__file__).resolve().parents[1]
    subprocess.run(
        [sys.executable, "-m", "tracelens.cli", "install", "--check"],
        cwd=root,
        check=True,
        env=os.environ,
    )
