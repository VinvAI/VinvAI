"""FP-18: the OS-sandbox containment branch was a bare substring test.

`mark_contained` promises, in its own docstring, judgement "by defining module
and by MRO, both facts about the class". The shim branch and the
service-substitute branch keep that promise. The OS branch did not: under
`OS_SANDBOX` it asked only whether the error MESSAGE contained one of seven
phrases. So all of these were silently marked `contained` — i.e. NOT a defect,
and dropped from the report:

* the app's own authorization error, `PermissionError("permission denied")`,
  raised by the repo's code and nothing to do with the kernel;
* a `ValueError` that merely QUOTES the phrase in a message it builds;
* a config-driven `RuntimeError("Network is unreachable")`.

Worse, only this branch is tier-gated, so verdicts became NON-PORTABLE: the very
same result row was a reported defect on a Linux box without bwrap (PROCESS_SHIM)
and contained on a Mac (OS_SANDBOX). A finding that depends on which laptop ran
it is not a finding.

The fix keeps the deliberate generosity WITHIN the OS-error class — an ambiguous
`PermissionError` under a kernel wall is still attributed to the wall — but the
message may now only corroborate a class that is already OS-level, or a DB
driver's (the one family that provably discards the errno on the way out).
"""

from __future__ import annotations

import errno

import pytest

from exerciser.containment import ContainmentTier, os_denial
from exerciser.sandbox import mark_contained


def _row(**kw):
    row = {"status": "error"}
    row.update(kw)
    return row


class TestGenuineKernelDenialsAreStillContained:
    """The fix must not start reporting the apparatus's own refusals."""

    def test_a_denial_errno_on_an_oserror(self) -> None:
        kind, detail = os_denial(
            _row(
                error_type="PermissionError",
                error_mro=["PermissionError", "OSError", "Exception"],
                error_errno=errno.EPERM,
                error="[Errno 1] Operation not permitted: '/etc/passwd'",
            )
        )
        assert kind == "filesystem-denied"
        assert "errno" in detail

    def test_an_oserror_whose_errno_never_reached_the_row(self) -> None:
        """Some workers cannot introspect `.errno`; the CLASS is still OS-level."""
        kind, _detail = os_denial(
            _row(
                error_type="PermissionError",
                error_mro=["PermissionError", "OSError", "Exception"],
                error="[Errno 13] Permission denied: '/etc/shadow'",
            )
        )
        assert kind == "filesystem-denied"

    def test_a_refused_connect_is_a_network_denial(self) -> None:
        kind, _detail = os_denial(
            _row(
                error_type="OSError",
                error_mro=["OSError", "Exception"],
                error_errno=errno.ENETUNREACH,
                error="[Errno 101] Network is unreachable",
            )
        )
        assert kind == "network-denied"

    def test_a_c_extension_that_swallows_the_errno(self) -> None:
        """`sqlite3.OperationalError` is not an OSError and carries no errno."""
        kind, _detail = os_denial(
            _row(
                error_type="OperationalError",
                error_mro=["OperationalError", "DatabaseError", "Error", "Exception"],
                error="unable to open database file",
            )
        )
        assert kind == "filesystem-denied"

    def test_a_driver_recognised_by_its_defining_module(self) -> None:
        """MRO-less rows still resolve when the module names a real driver."""
        kind, _detail = os_denial(
            _row(
                error_type="OperationalError",
                error_module="sqlite3",
                error="attempt to write a readonly database",
            )
        )
        assert kind == "filesystem-denied"


class TestTheRepoOwnErrorsAreNotContained:
    """The precision half. Every row here is the REPO failing and must be reported."""

    @pytest.mark.parametrize(
        ("label", "row"),
        [
            (
                "a ValueError quoting the phrase",
                _row(
                    error_type="ValueError",
                    error_mro=["ValueError", "Exception"],
                    error="permission denied: user lacks the 'admin' role",
                ),
            ),
            (
                "a config-driven RuntimeError",
                _row(
                    error_type="RuntimeError",
                    error_mro=["RuntimeError", "Exception"],
                    error="Network is unreachable — set VINV_OFFLINE=0 to retry",
                ),
            ),
            (
                "the repo's own authz exception",
                _row(
                    error_type="AuthorizationError",
                    error_mro=["AuthorizationError", "Exception"],
                    error_module="myapp.security",
                    error="Operation not permitted for this principal",
                ),
            ),
            (
                "a RuntimeError quoting a sqlite message",
                _row(
                    error_type="RuntimeError",
                    error_mro=["RuntimeError", "Exception"],
                    error="unable to open database file",
                ),
            ),
            (
                # `Error` alone is far too common a base-class name for a repo's
                # own hierarchy, so it is NOT accepted as DB-driver evidence.
                "a repo exception whose base is merely named Error",
                _row(
                    error_type="StorageError",
                    error_mro=["StorageError", "Error", "Exception"],
                    error_module="myapp.storage",
                    error="unable to open database file",
                ),
            ),
            (
                # The canonical false positive from the driver side: Postgres
                # reporting an APPLICATION grant failure, not a kernel refusal.
                "a driver reporting a SQL grant failure",
                _row(
                    error_type="OperationalError",
                    error_mro=["OperationalError", "DatabaseError", "Error", "Exception"],
                    error_module="psycopg2",
                    error="permission denied for table users",
                ),
            ),
            (
                "an ordinary failure with no denial wording at all",
                _row(
                    error_type="ValueError",
                    error_mro=["ValueError", "Exception"],
                    error="tag must be non-empty",
                ),
            ),
            (
                "an errno that is not a REFUSAL",
                _row(
                    error_type="FileNotFoundError",
                    error_mro=["FileNotFoundError", "OSError", "Exception"],
                    error_errno=errno.ENOENT,
                    error="[Errno 2] No such file or directory: 'nope'",
                ),
            ),
        ],
    )
    def test_it_is_not_read_as_a_kernel_denial(self, label: str, row: dict) -> None:
        assert os_denial(row) is None, label

    def test_a_successful_row_is_never_a_denial(self) -> None:
        assert os_denial({"status": "ok"}) is None


class TestVerdictsArePortableAcrossTiers:
    """The same row must not change verdict because the host offers a stronger jail."""

    @pytest.mark.parametrize(
        "row",
        [
            _row(
                error_type="ValueError",
                error_mro=["ValueError", "Exception"],
                error="permission denied: user lacks the 'admin' role",
            ),
            _row(
                error_type="RuntimeError",
                error_mro=["RuntimeError", "Exception"],
                error="Network is unreachable",
            ),
        ],
    )
    def test_a_repo_error_is_reported_under_every_tier(self, row: dict) -> None:
        under_shim = mark_contained(dict(row), ContainmentTier.PROCESS_SHIM)
        under_os = mark_contained(dict(row), ContainmentTier.OS_SANDBOX)
        assert "contained" not in under_shim
        assert "contained" not in under_os, (
            "this row used to be a defect on a host without an OS sandbox and "
            "silently contained on a host with one"
        )

    def test_a_genuine_denial_is_still_tier_gated(self) -> None:
        """Deliberate: only an OS jail can produce an OS denial, so only it may claim one."""
        row = _row(
            error_type="PermissionError",
            error_mro=["PermissionError", "OSError", "Exception"],
            error_errno=errno.EACCES,
            error="[Errno 13] Permission denied: '/etc/shadow'",
        )
        assert "contained" not in mark_contained(dict(row), ContainmentTier.PROCESS_SHIM)
        under_os = mark_contained(dict(row), ContainmentTier.OS_SANDBOX)
        assert under_os["contained"] is True
        assert under_os["contained_by"] == "os-sandbox"
        assert under_os["os_denial"]["kind"] == "filesystem-denied"
        assert under_os["effects"]["os-denied"]

    def test_the_shim_branch_is_unchanged(self) -> None:
        """The other two apparatus keep judging by defining module, at any tier."""
        blocked = mark_contained(
            _row(
                error_type="SandboxBlocked",
                error_module="sitecustomize",
                error="network is blocked",
            ),
            ContainmentTier.OS_SANDBOX,
        )
        assert blocked["contained_by"] == "process-shim"
