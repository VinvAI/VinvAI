"""Regression: `tracelens run -- python -m pkg.mod` for a NOT-INSTALLED package.

`python -m` prepends the working directory to `sys.path`. The launcher runs the
module in-process through `runpy.run_module`, which does not — so the resolver
saw only tracelens's own path. A module that is INSTALLED resolves either way,
which is why every traced service (all of them pip-installed) worked and this
went unnoticed; a module that merely lives in the checkout raised
`ModuleNotFoundError` under tracelens for a command that ran fine without it.

That is the shape of every CLI in a repo nobody ran `pip install -e` on, i.e.
exactly the units the exerciser's invocation oracle drives.

The sibling branch for a plain script path had always inserted the script's own
directory; this pins the `-m` branch to the same promise.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

#: The CONSOLE SCRIPT, deliberately — not `python -c "...run_main..."`. The
#: `-c` form prepends the working directory to `sys.path` on its own, so it
#: cannot reproduce this defect: it hides the very gap under test. Users run
#: the console script, whose `sys.path[0]` is the interpreter's Scripts/bin
#: directory.
_TRACELENS = shutil.which("tracelens")

pytestmark = pytest.mark.skipif(
    _TRACELENS is None, reason="tracelens console script not installed on PATH"
)


def _uninstalled_package(root: Path) -> None:
    """A package that exists ONLY in ``root`` — never on sys.path."""
    pkg = root / "acme"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "tool.py").write_text(
        "import sys\n"
        "\n"
        "def summarize(n):\n"
        "    return f'rows={n * 2}'\n"
        "\n"
        "print(summarize(int(sys.argv[1]) if len(sys.argv) > 1 else 3))\n",
        encoding="utf-8",
    )


def _run(root: Path, out: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            str(_TRACELENS), "run",
            "--target-package", "acme",
            "--output", str(out),
            "--", sys.executable, "-m", "acme.tool", "4",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(root),
        timeout=180,
    )


def test_module_in_the_working_directory_resolves(tmp_path: Path) -> None:
    _uninstalled_package(tmp_path)
    out = tmp_path / "trace.jsonl"

    proc = _run(tmp_path, out)

    assert "ModuleNotFoundError" not in proc.stderr, proc.stderr[-2000:]
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert "rows=8" in proc.stdout, "the module ran but its own output was lost"


def test_the_run_is_actually_instrumented(tmp_path: Path) -> None:
    # Resolving the module is only half of it: the point of running it under
    # tracelens is the spans, so a run that resolves and records nothing is
    # still a failure.
    _uninstalled_package(tmp_path)
    out = tmp_path / "trace.jsonl"

    _run(tmp_path, out)

    assert out.is_file(), "no capture was written"
    components = set()
    for line in out.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            components.add(json.loads(line).get("component"))
        except json.JSONDecodeError:
            continue
    assert "acme.tool.summarize" in components, sorted(c for c in components if c)
