"""T1.1 — contrib instrumenter probe surfaces correct status per library."""

from __future__ import annotations

from tracelens.launcher.otel_setup import probe_contrib_instrumenters


def test_probe_returns_dict_for_known_libs() -> None:
    probe = probe_contrib_instrumenters()
    # Every value should be one of these statuses.
    valid = {"available", "library_missing", "instrumenter_missing"}
    for inst, status in probe.items():
        assert status in valid or status.startswith("failed:"), f"{inst}={status}"


def test_probe_reports_python_stdlib_libs_as_present() -> None:
    """``logging`` and ``asyncio`` ship with Python; their library status should never be
    ``library_missing`` regardless of whether the instrumenter package is installed."""
    probe = probe_contrib_instrumenters()
    for known in ("opentelemetry.instrumentation.logging", "opentelemetry.instrumentation.asyncio"):
        if known in probe:
            assert probe[known] != "library_missing"
