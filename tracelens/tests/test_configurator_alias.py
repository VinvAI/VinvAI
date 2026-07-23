"""OTel configurator entry point: ``configure`` and ``_configure``."""

from __future__ import annotations

from importlib.metadata import entry_points

from tracelens.otel.configurator import TracelensConfigurator


def test_entry_point_resolves_to_class_with_both_methods() -> None:
    eps = [e for e in entry_points(group="opentelemetry_configurator") if e.name == "tracelens"]
    assert eps, "tracelens opentelemetry_configurator entry point missing"
    cls = eps[0].load()
    assert cls is TracelensConfigurator
    obj = cls()
    assert callable(getattr(obj, "configure", None))
    assert callable(getattr(obj, "_configure", None))


def test__configure_delegates_to_configure() -> None:
    calls: list[dict[str, object]] = []
    c = TracelensConfigurator()

    def fake_configure(**kw: object) -> None:
        calls.append(kw)

    c.configure = fake_configure  # type: ignore[method-assign]
    c._configure(auto_instrumentation_version="0.99", extra=1)
    assert calls == [{"auto_instrumentation_version": "0.99", "extra": 1}]
