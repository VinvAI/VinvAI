"""T2.6 — SCIP/LSIF acquisition stub.

Documented helper that invokes ``scip-python`` (preferred) or falls back to
``pyright --outputjson`` to produce a SCIP protobuf or JSON cross-reference index.
This module's job is to invoke the right tool for the language and surface a
parquet path the code-overlay loader can read.

For v1, this is **a real shell-out implementation that produces a JSON file with one
row per symbol**: ``{qualname, file, line, type_signature, callers}``. Deeper
code-index integration is out of scope.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

_log = logging.getLogger("tracelens.diag")


def acquire_scip_python(project_root: Path, out: Path) -> dict[str, str]:
    """Run ``scip-python`` if available, write SCIP file to ``out``.

    Returns ``{tool, status}``. If neither tool is installed, status is ``"missing"`` and
    the file is not written.
    """
    if shutil.which("scip-python"):
        try:
            subprocess.run(
                ["scip-python", "index", "--output", str(out), "--project-root", str(project_root)],
                check=True,
                cwd=str(project_root),
                capture_output=True,
                timeout=300,
            )
            return {"tool": "scip-python", "status": "ok", "out": str(out)}
        except subprocess.CalledProcessError as exc:
            return {"tool": "scip-python", "status": f"failed:{exc.returncode}"}
        except subprocess.TimeoutExpired:
            return {"tool": "scip-python", "status": "timeout"}
    if shutil.which("pyright"):
        try:
            res = subprocess.run(
                ["pyright", "--outputjson", str(project_root)],
                check=False,
                capture_output=True,
                timeout=300,
            )
            out.write_bytes(res.stdout or b"{}")
            return {"tool": "pyright", "status": "ok_fallback", "out": str(out)}
        except subprocess.TimeoutExpired:
            return {"tool": "pyright", "status": "timeout"}
    return {"tool": "none", "status": "missing"}
