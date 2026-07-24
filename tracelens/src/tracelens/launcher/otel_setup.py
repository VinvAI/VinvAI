"""Set OTel env and bootstrap auto-instrumentation in-process (runpy path).

T1.1 — auto-load contrib instrumenters when their target lib is installed in the target's env.
"""

from __future__ import annotations

import importlib
import importlib.util
import logging
import os
from pathlib import Path

from tracelens import _health

_log = logging.getLogger("tracelens.diag")


# Map target-library import name → list of OTel-contrib instrumentation packages we should
# try to load when that library is present. Some libraries have multiple instrumenters; we try
# each in order. Keep this list short and commodity — it should not require maintenance.
_CONTRIB_MAP: dict[str, list[str]] = {
    "fastapi": ["opentelemetry.instrumentation.fastapi"],
    "starlette": ["opentelemetry.instrumentation.starlette"],
    "asgi": ["opentelemetry.instrumentation.asgi"],
    "flask": ["opentelemetry.instrumentation.flask"],
    "django": ["opentelemetry.instrumentation.django"],
    "requests": ["opentelemetry.instrumentation.requests"],
    "httpx": ["opentelemetry.instrumentation.httpx"],
    "aiohttp": ["opentelemetry.instrumentation.aiohttp_client"],
    "urllib3": ["opentelemetry.instrumentation.urllib3"],
    "psycopg2": ["opentelemetry.instrumentation.psycopg2"],
    "psycopg": ["opentelemetry.instrumentation.psycopg"],
    "sqlalchemy": ["opentelemetry.instrumentation.sqlalchemy"],
    "pymongo": ["opentelemetry.instrumentation.pymongo"],
    "pymysql": ["opentelemetry.instrumentation.pymysql"],
    "redis": ["opentelemetry.instrumentation.redis"],
    "neo4j": ["opentelemetry.instrumentation.neo4j"],
    "celery": ["opentelemetry.instrumentation.celery"],
    "kafka": ["opentelemetry.instrumentation.kafka"],
    "pika": ["opentelemetry.instrumentation.pika"],
    "asyncio": ["opentelemetry.instrumentation.asyncio"],
    "logging": ["opentelemetry.instrumentation.logging"],
}


def apply_env(
    *,
    output_path: str,
    target_packages: list[str],
    sample_rate: str,
    user_command: list[str],
) -> None:
    os.environ["OTEL_PYTHON_CONFIGURATOR"] = "tracelens"
    cmd0 = user_command[0] if user_command else "app"
    inferred = Path(cmd0).stem if cmd0 else "tracelens-target"
    os.environ["OTEL_SERVICE_NAME"] = os.environ.get("OTEL_SERVICE_NAME", inferred)
    os.environ["OTEL_TRACES_SAMPLER"] = "parentbased_traceidratio"
    os.environ["OTEL_TRACES_SAMPLER_ARG"] = sample_rate
    os.environ["TRACELENS_OUTPUT"] = output_path
    os.environ["TRACELENS_TARGET_PACKAGES"] = ",".join(target_packages)


def probe_contrib_instrumenters() -> dict[str, str]:
    """Return ``{instrumenter_module: status}`` for every library on _CONTRIB_MAP.

    Status is one of: ``"loaded"``, ``"library_missing"``, ``"instrumenter_missing"``,
    ``"failed:<exc>"``. Pure introspection — does NOT call ``instrument()``.
    """
    out: dict[str, str] = {}
    for lib, instrumenters in _CONTRIB_MAP.items():
        if importlib.util.find_spec(lib) is None:
            for inst in instrumenters:
                out[inst] = "library_missing"
            continue
        for inst in instrumenters:
            if importlib.util.find_spec(inst) is None:
                out[inst] = "instrumenter_missing"
            else:
                out[inst] = "available"
    return out


def load_contrib_instrumenters() -> dict[str, str]:
    """Walk _CONTRIB_MAP, ``find_spec`` the target lib, then ``find_spec`` the instrumenter.

    For each match, import the instrumenter and call its ``Instrumentor().instrument()``.
    Status reported per instrumenter. Always-safe: any failure is logged and counted, never
    raised.
    """
    status: dict[str, str] = {}
    skipped_libs: list[str] = []
    for lib, instrumenters in _CONTRIB_MAP.items():
        if importlib.util.find_spec(lib) is None:
            skipped_libs.append(lib)
            continue
        for inst_mod in instrumenters:
            if importlib.util.find_spec(inst_mod) is None:
                status[inst_mod] = "instrumenter_missing"
                _log.info(
                    "tracelens: %s installed but %s not present — `pip install %s`",
                    lib,
                    inst_mod,
                    inst_mod.replace(".", "-"),
                )
                continue
            try:
                import inspect as _inspect

                m = importlib.import_module(inst_mod)
                # Pick the first class whose name ends in "Instrumentor", is concrete (not
                # abstract — BaseInstrumentor would otherwise win the lookup), and isn't
                # the BaseInstrumentor itself.
                cls = next(
                    (
                        c
                        for c in (getattr(m, n, None) for n in dir(m))
                        if isinstance(c, type)
                        and c.__name__.endswith("Instrumentor")
                        and c.__name__ != "BaseInstrumentor"
                        and not _inspect.isabstract(c)
                        and getattr(c, "__module__", "").startswith(inst_mod)
                    ),
                    None,
                )
                if cls is None:
                    status[inst_mod] = "no_Instrumentor_class"
                    continue
                cls().instrument()
                status[inst_mod] = "loaded"
                _log.info("tracelens: loaded %s (%s)", inst_mod, cls.__name__)
            except BaseException as exc:  # noqa: BLE001 — never crash the target
                status[inst_mod] = f"failed:{type(exc).__name__}"
                _log.warning("tracelens: %s instrument() failed: %s", inst_mod, exc)
    if skipped_libs:
        _log.debug("tracelens: skipped contrib (target lib not installed): %s", skipped_libs)
    return status


def core_sdk_missing() -> str | None:
    """Preflight: name the missing core OTel distribution, or ``None`` when present.

    Uses ``find_spec`` (no imports) so the check is safe to run before any hook is
    installed. Only ``opentelemetry-api`` + ``opentelemetry-sdk`` are *core* — the
    contrib ``opentelemetry-instrumentation`` package is optional and its absence
    (or breakage) must never block span capture.
    """
    core = (("opentelemetry", "opentelemetry-api"), ("opentelemetry.sdk", "opentelemetry-sdk"))
    for mod, dist in core:
        try:
            if importlib.util.find_spec(mod) is None:
                return dist
        except (ImportError, ValueError):
            return dist
    return None


def core_sdk_import_error() -> str | None:
    """Preflight the EXACT imports the span pipeline performs; None when healthy.

    ``core_sdk_missing`` only proves the distributions are installed. An ancient
    or mismatched pairing (e.g. new ``opentelemetry-sdk`` over an old pinned
    ``opentelemetry-api``) still explodes at import time — historically as a deep
    traceback out of the bootstrap, or worse, swallowed into a status string.
    Import the three modules the configurator actually uses and translate any
    failure into a one-line description for the caller to present.
    """
    try:
        importlib.import_module("opentelemetry.trace")
        importlib.import_module("opentelemetry.sdk.trace")
        importlib.import_module("opentelemetry.sdk.trace.export")
    except BaseException as exc:  # noqa: BLE001 — translated to a one-liner by the caller
        return f"{type(exc).__name__}: {exc}"
    return None


def configure_tracer_provider() -> str:
    """Install tracelens's TracerProvider + JSONL exporter DIRECTLY; return a status token.

    This must never route through OTel's entry-point machinery: it needs only
    ``opentelemetry-api`` + ``opentelemetry-sdk``, which tracelens requires anyway.
    """
    try:
        from tracelens.otel.configurator import TracelensConfigurator

        TracelensConfigurator().configure()
        return "configured"
    except BaseException as exc:  # noqa: BLE001 — never crash the target
        # This failing means TOTAL capture loss (spans go to the no-op
        # ProxyTracerProvider), so the status keeps the message and the warning
        # goes to stderr, not just a maybe-unconfigured logger. The launcher
        # aborts the run on this status (_ensure_span_pipeline); other callers
        # (attach) at least get the loud line.
        msg = f"{type(exc).__name__}: {exc}"
        _health.warn_once(
            "configurator_failed",
            f"TracerProvider configuration failed ({msg}) — NO spans will be recorded",
        )
        _log.warning("tracelens: TracerProvider configuration failed: %s", exc)
        return f"failed:{msg}"


def bootstrap_autoinstrumentation(*, load_instrumentors: bool = True) -> dict[str, str]:
    """Configure the span pipeline in-process; return per-instrumenter load status.

    Step 1 — ALWAYS configure tracelens's own TracerProvider (JSONL exporter) by
    calling ``TracelensConfigurator`` directly. This used to be routed through
    OTel contrib's private entry-point loader
    (``opentelemetry.instrumentation.auto_instrumentation._load``), which tied
    core span export to the *contrib* package's importability: on Python 3.14
    that module still imports the removed ``pkg_resources``, the resulting
    ``ModuleNotFoundError`` was swallowed, no TracerProvider was ever installed,
    every span went to the no-op ``ProxyTracerProvider`` — and the trace file was
    silently never created (observed live on the fastapi demo repo).

    Step 2 (only when ``load_instrumentors``) — best-effort contrib loading:
        a. The official OTel ``_load_instrumentors`` (entry-point-based, what
           ``opentelemetry-instrument`` would do).
        b. Tracelens's own ``_CONTRIB_MAP`` walk so we work even when the
           target's env does not register entry-points (custom installs).
    With ``--no-otel-autoinst`` no ``opentelemetry.instrumentation`` module is
    imported at all, so a venv that lacks (or ships a broken) contrib package
    still captures spans in minimal mode.
    Returns the merged status dict so the launcher can fold it into summary.json (T1.4).
    """
    status: dict[str, str] = {}
    status["__tracelens_configurator__"] = configure_tracer_provider()
    if not load_instrumentors:
        status["__otel_entry_points__"] = "skipped:no_autoinst"
        return status
    try:
        from opentelemetry.instrumentation.auto_instrumentation._load import (
            _load_distro,
            _load_instrumentors,
        )

        distro = _load_distro()
        distro.configure()
        _load_instrumentors(distro)  # type: ignore[no-untyped-call]
        status["__otel_entry_points__"] = "loaded"
    except BaseException as exc:  # noqa: BLE001
        status["__otel_entry_points__"] = f"failed:{type(exc).__name__}"
        _log.warning(
            "tracelens: OTel auto-instrumentation unavailable (%s: %s) — span capture "
            "continues, but contrib instrumenters were not loaded. Install/upgrade "
            "'opentelemetry-instrumentation' in the target env or pass --no-otel-autoinst "
            "to silence this.",
            type(exc).__name__,
            exc,
        )
    # Tracelens's own probe — idempotent: instrumenters loaded twice are no-ops.
    status.update(load_contrib_instrumenters())
    return status
