"""One unmet precondition is one finding, not one per module it blocked.

``classify_row`` exempts the two import failures that say nothing about the
code under test: a dependency this machine lacks (the ``ImportError`` family)
and an exception the repo defines about itself. A third shape reached a verdict
and should not have, and it went from rare to common the moment the workers
started running under the TARGET's own interpreter — before that, a service
whose settings are unset never got far enough to raise, because the import died
on ``ModuleNotFoundError`` first and was exempt.

Measured on demo-fastapi: 14 of the 15 modules that attempted an import raised
the same ``pydantic_core.ValidationError`` — required settings were not
configured — and the run reported 15 separate defect clusters on a repo whose
only problem was an unset environment variable. Provenance cannot separate
that: the exception belongs to pydantic, so "the repo stating its own
precondition" does not apply.

Dispersion can, and it is a fact about the run rather than a vocabulary. What it
establishes is that the group has ONE cause — not that the cause is harmless — so
the group collapses to a single REPRESENTATIVE cluster rather than to none: a
broken shared ``__init__`` blocks every module that imports it and is a real
defect, and trading fifteen fabricated findings for one missed one is not a fix.

These tests pin all three directions — the group is collapsed to one, the
collapse is described, and a genuine defect that happens to occur during import
keeps its own cluster.
"""

from __future__ import annotations

from typing import Any

import pytest

from exerciser.functions import cluster_function_failures, shared_import_preconditions
from exerciser.issues import FailureCluster


def _import_row(module: str, error_type: str, error_module: str, message: str) -> dict[str, Any]:
    return {
        "module": module,
        "target_id": module,
        "phase": "import",
        "status": "error",
        "error_type": error_type,
        "error_module": error_module,
        "error": message,
        "error_mro": [error_type, "ValueError", "Exception", "BaseException", "object"],
        "repo_packages": ["app"],
    }


def _clusters(rows: list[dict[str, Any]]):
    """The real clustering path, so these tests bind to production behaviour."""
    return cluster_function_failures(rows)


#: Realistic module names. NOT ``mod0``/``mod1``: cluster signatures are
#: digit-normalised, so numbered fixtures collapse into a single cluster and
#: every count in these tests would be measuring the fixture instead of the
#: code. The repo that exposed this had ``app.core.config``, ``app.api.routes``…
_MODULES = [
    "app.core.config",
    "app.core.db",
    "app.core.security",
    "app.crud",
    "app.main",
    "app.utils",
    "app.api.routes.items",
    "app.api.routes.login",
    "app.api.routes.users",
    "app.api.routes.utils",
    "app.backend_pre_start",
    "app.initial_data",
    "app.tests_pre_start",
    "app.models",
]


def _settings_failure(module: str) -> dict[str, Any]:
    return _import_row(
        module,
        "ValidationError",
        "pydantic_core._pydantic_core",
        "5 validation errors for Settings\nPROJECT_NAME\n  Field required",
    )


# =========================================================================
# The shared precondition
# =========================================================================


def test_one_error_across_every_module_is_reported_once_not_fourteen_times() -> None:
    rows = [_settings_failure(m) for m in _MODULES]
    kept, preconditions = shared_import_preconditions(rows, _clusters(rows))

    # ONE cluster, not fourteen and not zero. `clusters` is what reaches
    # issues.json and the dispatch path, so a group that leaves nothing behind
    # here is a finding the extension can never show or act on.
    assert len(kept) == 1
    assert kept[0].to_json()["kind"] == "import-error"
    assert len(preconditions) == 1
    found = preconditions[0]
    assert found["error_type"] == "ValidationError"
    assert found["modules_blocked"] == 14
    assert found["modules_attempted"] == 14
    assert found["clusters_withheld"] == 13
    assert found["reported_as"] == kept[0].to_json()["endpoint_id"]
    # Folded is not discarded: the cause has to be readable from the summary.
    assert "PROJECT_NAME" in found["detail"]


def test_a_shared_cause_is_still_reachable_by_the_dispatch_path() -> None:
    """The regression this guards against.

    An earlier form withheld the whole group. On a repo whose every module fails
    to import because ONE shared module is broken — a real defect, and the most
    consequential kind — the run then reported it in a summary field the
    extension does not read, and dispatched nothing.
    """
    rows = [
        _import_row(m, "TypeError", "somelib.core", "unsupported operand type(s)") for m in _MODULES
    ]
    kept, preconditions = shared_import_preconditions(rows, _clusters(rows))

    assert [c.to_json()["kind"] for c in kept] == ["import-error"]
    assert preconditions[0]["clusters_withheld"] == 13


def test_the_reported_detail_carries_no_credential() -> None:
    """The message that motivated this rendered the settings dict verbatim."""
    rows = [
        _import_row(
            m,
            "ValidationError",
            "pydantic_core._pydantic_core",
            "Field required [input_value={'openai_api_key': 'sk-proj-LEAKED-VALUE-HERE'}]",
        )
        for m in _MODULES[:5]
    ]
    _, preconditions = shared_import_preconditions(rows, _clusters(rows))
    assert "sk-proj-LEAKED-VALUE-HERE" not in preconditions[0]["detail"]


def test_a_defect_in_one_module_is_still_a_defect() -> None:
    """The direction that matters most: this must not become a way to hide bugs."""
    rows = [_settings_failure(m) for m in _MODULES[:10]]
    # A THIRD-PARTY error module: an exception the repo defines about itself is
    # already exempt, so a repo-provenance fixture would pass for the wrong
    # reason and prove nothing about this rule.
    rows.append(_import_row("app.broken", "TypeError", "somelib.core", "unsupported operand"))

    kept, preconditions = shared_import_preconditions(rows, _clusters(rows))

    assert len(preconditions) == 1
    # The lone defect keeps its own cluster, and the shared group keeps exactly
    # one — they are separate findings and both are reportable.
    endpoints = [c.to_json()["endpoint_id"] for c in kept]
    assert "app.broken" in endpoints
    assert len(endpoints) == 2


def test_a_minority_of_modules_is_not_a_precondition() -> None:
    """Below the share threshold the errors stay defects.

    Three modules out of twenty failing the same way is a bug with a shared
    cause, not an environment that was never configured.
    """
    rows = [_settings_failure(m) for m in _MODULES[:3]]
    rows += [
        {"module": f"app.ok.{n}", "target_id": f"app.ok.{n}", "phase": "import", "status": "ok"}
        for n in "abcdefghijklmnopq"
    ]
    kept, preconditions = shared_import_preconditions(rows, _clusters(rows))

    assert preconditions == []
    assert len(kept) == 3


def test_a_tiny_repo_is_never_called_dispersed() -> None:
    """ "Both of my two modules raised the same thing" is not dispersion."""
    rows = [_settings_failure("app.alpha"), _settings_failure("app.beta")]
    kept, preconditions = shared_import_preconditions(rows, _clusters(rows))

    assert preconditions == []
    assert len(kept) == 2


def test_two_distinct_preconditions_are_reported_separately() -> None:
    rows = [_settings_failure(m) for m in _MODULES[:6]]
    rows += [
        _import_row(m, "OperationalError", "sqlalchemy.exc", "could not connect")
        for m in _MODULES[6:12]
    ]
    kept, preconditions = shared_import_preconditions(rows, _clusters(rows))

    # One representative EACH: two causes are two findings.
    assert len(kept) == 2
    assert {p["error_type"] for p in preconditions} == {"ValidationError", "OperationalError"}
    assert all(p["clusters_withheld"] == 5 for p in preconditions)
    assert {p["reported_as"] for p in preconditions} == {c.to_json()["endpoint_id"] for c in kept}


def test_a_clean_run_is_untouched() -> None:
    rows = [
        {"module": f"app.m.{n}", "target_id": f"app.m.{n}", "phase": "import", "status": "ok"}
        for n in "abcdefgh"
    ]
    kept, preconditions = shared_import_preconditions(rows, [])
    assert kept == []
    assert preconditions == []


@pytest.mark.parametrize("rows", [[], [{"phase": "call", "status": "ok"}]])
def test_no_import_rows_is_not_an_error(rows: list[dict[str, Any]]) -> None:
    kept, preconditions = shared_import_preconditions(rows, [])
    assert preconditions == []
    assert kept == []


def test_only_import_error_clusters_are_ever_folded() -> None:
    """The rule is scoped to IMPORT.

    A crash cluster is built here directly rather than through
    ``cluster_function_failures``: whether a given call row reaches a defect
    verdict is the learned policy's business, and this test is about the
    withholding filter, not about the policy. The crash is deliberately given
    the SAME module and the SAME exception as the precondition, so kind is the
    only thing that can be separating them.
    """
    rows = [_settings_failure(m) for m in _MODULES[:6]]
    crash = FailureCluster(
        signature="deadbeef",
        kind="function-crash",
        title="app.core.config — ValidationError",
        endpoint_id="app.core.config",
        method="CALL",
        path="app.core.config",
        exemplar={},
    )

    kept, preconditions = shared_import_preconditions(rows, [*_clusters(rows), crash])

    assert preconditions and preconditions[0]["modules_blocked"] == 6
    # The crash is untouched; the import group contributed its one representative.
    assert sorted(c.kind for c in kept) == ["function-crash", "import-error"]
