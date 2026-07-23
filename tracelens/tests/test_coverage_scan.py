"""T1.3 / T2.3 — coverage scan."""

from __future__ import annotations

import sys
from pathlib import Path

from tracelens.launcher.coverage_scan import scan_targets


def test_scan_demo_app(tmp_path: Path) -> None:
    """Scan the in-tree demo app and assert we count public functions correctly."""
    pkg_root = Path(__file__).resolve().parents[1] / "tests" / "integration"
    if str(pkg_root) not in sys.path:
        sys.path.insert(0, str(pkg_root))
    res = scan_targets(["demo_app"])
    totals = res["totals"]
    # demo_app/main.py defines: db_lookup, cache_get, healthy, slow, sometimes_fails,
    # wrong, n_plus_one, async_ping  →  8 public functions, 0 generators.
    assert totals["public_functions"] >= 5
    assert totals["modules"] >= 1


def test_scan_handles_missing_package() -> None:
    res = scan_targets(["nonexistent_package_xyz"])
    assert res["totals"].get("modules", 0) == 0


def test_scan_respects_skip_pattern(tmp_path: Path, monkeypatch) -> None:
    pkg = tmp_path / "scan_pkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "m.py").write_text(
        "def public_a(): pass\n" "def public_b(): pass\n" "def __dunder__(): pass\n",
        encoding="utf-8",
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    res = scan_targets(["scan_pkg"])
    # 2 public, 0 dunder counted (default pattern strips dunders).
    assert res["totals"]["public_functions"] == 2
