"""Set OTel env and bootstrap auto-instrumentation in-process (runpy path).

T1.1 — auto-load contrib instrumenters when their target lib is installed in the target's env.
"""

from __future__ import annotations

import importlib
import importlib.util
import logging
import os
from pathlib import Path

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


def bootstrap_autoinstrumentation(*, load_instrumentors: bool = True) -> dict[str, str]:
    """Configure OTel auto-instrumentation in-process; return per-instrumenter load status.

    Combines two paths:
        1. The official OTel ``_load_instrumentors`` (entry-point-based, what
           ``opentelemetry-instrument`` would do).
        2. Tracelens's own ``_CONTRIB_MAP`` walk so we work even when the target's env
           does not register entry-points (custom installs).
    Returns the merged status dict so the launcher can fold it into summary.json (T1.4).
    """
    status: dict[str, str] = {}
    # 1) ALWAYS load configurators (this triggers our TracelensConfigurator → TracerProvider).
    #    The ``load_instrumentors`` flag only gates the contrib library wrapping in step 2/3,
    #    NOT the configurator that sets up the JSONL exporter — without it, no spans get
    #    written to disk regardless of how the user invokes their app.
    try:
        from opentelemetry.instrumentation.auto_instrumentation._load import (
            _load_configurators,
            _load_distro,
            _load_instrumentors,
        )

        distro = _load_distro()
        distro.configure()
        # Configures TracerProvider via our entry point; upstream keeps this private API untyped.
        _load_configurators()  # type: ignore[no-untyped-call]
        if load_instrumentors:
            _load_instrumentors(distro)  # type: ignore[no-untyped-call]
            status["__otel_entry_points__"] = "loaded"
        else:
            status["__otel_entry_points__"] = "configurator_only"
    except BaseException as exc:  # noqa: BLE001
        status["__otel_entry_points__"] = f"failed:{type(exc).__name__}"
        _log.info("tracelens: OTel entry-point loader produced no instrumenters (%s)", exc)
    # 2) Tracelens's own probe — idempotent: instrumenters loaded twice are no-ops.
    if load_instrumentors:
        status.update(load_contrib_instrumenters())
    return status
