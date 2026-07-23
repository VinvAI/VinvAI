"""OTel Configurator entry point: TracerProvider + processor + JSONL exporter."""

from __future__ import annotations

import logging
import os

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
from opentelemetry.trace import set_tracer_provider

from tracelens.otel.exporter import JSONLFileSpanExporter
from tracelens.otel.processor import TracelensSpanProcessor

_log = logging.getLogger("tracelens.diag")


class TracelensConfigurator:
    """Entry point ``opentelemetry_configurator`` → ``entry_point.load()().configure(...)``."""

    def configure(self, auto_instrumentation_version: str | None = None, **kwargs: object) -> None:
        if os.environ.get("TRACELENS_DISABLED") == "1":
            _log.info("tracelens disabled via TRACELENS_DISABLED=1")
            return
        try:
            sample_arg = os.environ.get("OTEL_TRACES_SAMPLER_ARG", "1.0")
            ratio = float(sample_arg)
        except ValueError:
            ratio = 1.0
        ratio = max(0.0, min(1.0, ratio))
        sampler = ParentBased(TraceIdRatioBased(ratio))
        resource = Resource.create(
            {
                "service.name": os.environ.get("OTEL_SERVICE_NAME", "tracelens-target"),
            }
        )
        provider = TracerProvider(resource=resource, sampler=sampler)
        out_path = os.environ.get("TRACELENS_OUTPUT", "trace.jsonl")
        diag_path = os.environ.get("TRACELENS_DIAG_LOG")
        exporter = JSONLFileSpanExporter(out_path, diagnostic_path=diag_path)
        provider.add_span_processor(TracelensSpanProcessor())
        provider.add_span_processor(BatchSpanProcessor(exporter))
        set_tracer_provider(provider)
        _log.info(
            "tracelens TracerProvider configured output=%s ratio=%s otel=%s",
            out_path,
            ratio,
            auto_instrumentation_version,
        )

    def _configure(self, auto_instrumentation_version: str | None = None, **kwargs: object) -> None:
        """Some loaders call ``_configure``; delegate to :meth:`configure`."""
        self.configure(auto_instrumentation_version=auto_instrumentation_version, **kwargs)
