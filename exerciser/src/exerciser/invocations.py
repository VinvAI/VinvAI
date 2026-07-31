"""Driving a CLI: the invocation oracle.

The HTTP path sends requests to a running service. The function path calls
exported callables. Neither reaches a console script, which is the entire
surface of a toolchain repo — so a `python_cli` service was inventoried, brought
up, verified, and then never exercised by anything.

This oracle closes that: it runs each invocation the inventory recorded, wrapped
in ``tracelens run`` exactly as bring-up wraps a server's start command, and
reports one row per run. The rows carry the same shape the other oracles emit
(``unit_kind``/``method``/``path``/``status``) so clusters, coverage and the
views join them without learning a third vocabulary.

**What counts as a failure here is narrower than it looks.** A CLI that exits
non-zero on bad input is working; the inventory records the expected code per
invocation, and only a mismatch is a defect. Everything else this oracle
observes — how long it took, what it wrote, which functions ran — is evidence,
not a verdict.
"""

from __future__ import annotations

import logging
import subprocess
import time
from pathlib import Path
from typing import Any

from . import store, tracing
from .issues import build_clusters
from .redact import redact_text

#: Wall-clock ceiling for one invocation. A CLI that outruns this is reported as
#: a timeout rather than allowed to hold the whole run open.
DEFAULT_INVOCATION_TIMEOUT_S = 120.0

#: How much of each stream is kept on a row. Enough to see the failure, bounded
#: so one chatty command cannot dominate the artifact.
_TAIL_CHARS = 4000

#: The pseudo-method for a CLI unit, mirroring `functions`' "CALL". Labels
#: render as `RUN acme-tool report`, beside `GET /users` and `CALL pkg.fn`.
METHOD = "RUN"

_RUN_TO_COMPLETION_KINDS = frozenset({"python_cli", "python_library"})

log = logging.getLogger("exerciser.invocations")


def _tail(text: str | None) -> str:
    if not text:
        return ""
    trimmed = text[-_TAIL_CHARS:]
    return redact_text(trimmed) if len(text) <= _TAIL_CHARS else "…" + redact_text(trimmed)


def read_services(repo: Path) -> list[dict[str, Any]]:
    """The run-to-completion services in ``.vinv/services.json``.

    Read directly rather than through bringup: this package does not depend on
    the renderer, and the field contract is the file, not the code that wrote
    it.
    """
    doc = store.read_json(repo / ".vinv" / "services.json") or {}
    services = doc.get("services") if isinstance(doc, dict) else None
    if not isinstance(services, list):
        return []
    return [
        s
        for s in services
        if isinstance(s, dict) and s.get("kind") in _RUN_TO_COMPLETION_KINDS
    ]


def service_invocations(service: dict[str, Any], repo: Path) -> list[dict[str, Any]]:
    """Every command that drives ``service``, normalized to full entries.

    Mirrors ``bringup.runner.service_invocations``: an explicit ``invocations``
    list, else the bare ``command`` as the single invocation, else — for a
    library, which has no command by definition — the function driver.
    """
    raw = service.get("invocations")
    entries: list[dict[str, Any]] = []
    if isinstance(raw, list):
        for inv in raw:
            if isinstance(inv, dict) and isinstance(inv.get("command"), str) and inv["command"].strip():
                entries.append(dict(inv))
    if not entries:
        command = service.get("command")
        if isinstance(command, str) and command.strip():
            entries = [{"command": command}]
        elif service.get("kind") == "python_library":
            name = str(service.get("name") or "repo")
            entries = [
                {
                    "command": f"vinv-exerciser functions {repo.resolve()} --service {name}",
                    "purpose": "drive the library's exported callables",
                }
            ]
    for entry in entries:
        expect = entry.get("expect_exit")
        entry["expect_exit"] = (
            0 if not isinstance(expect, int) or isinstance(expect, bool) else expect
        )
    return entries


def _target_packages(service: dict[str, Any]) -> list[str]:
    modules = service.get("modules")
    if not isinstance(modules, list):
        return []
    return [m for m in modules if isinstance(m, str) and m.isidentifier()]


def run_invocations(
    repo: Path,
    *,
    service: str | None = None,
    timeout_s: float = DEFAULT_INVOCATION_TIMEOUT_S,
    trace: bool = True,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Run every recorded invocation of every run-to-completion service.

    Returns a summary; persists ``invocation_results.jsonl`` (one row per run)
    and ``invocations.json`` (the summary) beside the other oracles' artifacts.
    """
    lg = logger or log
    services = read_services(repo)
    if service:
        services = [s for s in services if s.get("name") == service]
    if not services:
        return {
            "status": "environment",
            "repo": str(repo),
            "service": service,
            "units": 0,
            "invocations": 0,
            "diagnostics": [
                (
                    f"no run-to-completion service named {service!r} in "
                    ".vinv/services.json"
                    if service
                    else (
                        "no `python_cli` or `python_library` service in "
                        ".vinv/services.json — nothing for this oracle to drive. "
                        "Re-run `bringup list` if the repo does define CLIs."
                    )
                )
            ],
            "rows": [],
        }

    rows: list[dict[str, Any]] = []
    for svc in services:
        name = str(svc.get("name") or "service")
        packages = _target_packages(svc)
        cwd = svc.get("working_directory")
        cwd_path = Path(cwd) if isinstance(cwd, str) and Path(cwd).is_dir() else repo
        for index, inv in enumerate(service_invocations(svc, repo)):
            command = inv["command"]
            expect_exit = inv["expect_exit"]
            unit_id = f"{name}#{index}"
            capture = tracing.capture_path(repo, name, "invocations", f"{index}")
            script = command
            if trace and packages:
                script = tracing.tracelens_wrap_command(
                    command, target_packages=packages, output=capture
                )
            shell = tracing.resolve_shell()
            if shell:
                # `bash -l` sources the user's profile, and a profile that `cd`s
                # (Git Bash's default on Windows does) silently relocates the
                # command out of the directory `cwd=` set — so the working
                # directory is pinned in the script itself, not just requested.
                script = f"cd {tracing.shell_quote_path(cwd_path)} && {script}"
                argv: list[str] | str = [*shell, script]
            else:
                argv = script
            row: dict[str, Any] = {
                "unit_kind": "cli_invocation",
                "unit_id": unit_id,
                "service": name,
                "method": METHOD,
                # The label half of the unit: what was actually run.
                "path": command,
                "purpose": inv.get("purpose"),
                "expect_exit": expect_exit,
                "command": command,
                "working_directory": str(cwd_path),
                # The profile groups by `input_class` and reads `latency_ms`;
                # carrying both here is what lets one profiler serve a CLI unit
                # and an HTTP endpoint without a second code path. "declared"
                # because the argv came from the repo's inventory, not from a
                # generator — the distinction the other oracles draw too.
                "input_class": "declared",
            }
            started = time.monotonic()
            try:
                proc = subprocess.run(  # noqa: S602 (command comes from the repo's own inventory)
                    argv,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=timeout_s,
                    cwd=str(cwd_path),
                    env=tracing.invocation_env(),
                    shell=shell is None,
                )
            except subprocess.TimeoutExpired:
                row.update(
                    status="timeout",
                    error_type="Timeout",
                    error=f"did not return within {timeout_s:.0f}s",
                    duration_s=round(time.monotonic() - started, 3),
                    latency_ms=round((time.monotonic() - started) * 1000, 1),
                )
                rows.append(row)
                lg.warning("invocation_timeout unit=%s command=%s", unit_id, command)
                continue
            except OSError as exc:
                row.update(
                    status="error",
                    error_type=type(exc).__name__,
                    error=str(exc),
                    duration_s=round(time.monotonic() - started, 3),
                    latency_ms=round((time.monotonic() - started) * 1000, 1),
                )
                rows.append(row)
                lg.warning("invocation_unlaunchable unit=%s error=%s", unit_id, exc)
                continue

            duration = round(time.monotonic() - started, 3)
            traced_lines = _trace_lines(capture) if trace and packages else 0
            # The verdict is the recorded expectation, never "non-zero is bad":
            # a check command that exits 1 on findings is behaving correctly.
            ok = proc.returncode == expect_exit
            row.update(
                status="ok" if ok else "error",
                exit_code=proc.returncode,
                duration_s=duration,
                latency_ms=round(duration * 1000, 1),
                stdout_tail=_tail(proc.stdout),
                stderr_tail=_tail(proc.stderr),
                trace_jsonl=str(capture) if traced_lines else None,
                trace_lines=traced_lines,
            )
            if not ok:
                row["error_type"] = "UnexpectedExit"
                row["error"] = (
                    f"exited {proc.returncode}, expected {expect_exit}"
                )
            rows.append(row)
            lg.info(
                "invocation unit=%s exit=%s expected=%s spans=%d %.2fs",
                unit_id, proc.returncode, expect_exit, traced_lines, duration,
            )

    clusters = build_clusters(
        rows,
        # None means "not a finding" — a passing invocation must not become a
        # cluster, and an exit code the inventory EXPECTED is a pass.
        #
        # Own kinds, not the HTTP oracle's: `evidenceFileForKind` routes a
        # cluster to the artifact holding its failing rows, and anything it does
        # not recognise falls through to `results.jsonl`. Reusing "server-error"
        # here would point a fixing agent at the HTTP oracle's file, which on a
        # CLI-only repo is empty — read as "no evidence exists".
        verdict=lambda r: (
            "invocation-timeout" if r.get("status") == "timeout"
            else "invocation-failure" if r.get("status") == "error"
            else None
        ),
        describe=lambda r, _k: f"{r.get('error_type', 'error')}: {r.get('error', '')}",
        target_of=lambda r: str(r.get("unit_id", "?")),
        method=METHOD,
        strategy=lambda r, _k: "invocation/declared",
        expected=lambda r, _k: f"exit {r.get('expect_exit', 0)}",
        exemplar_extra=lambda r: {
            "command": r.get("command"),
            "exit_code": r.get("exit_code"),
            "stderr": r.get("stderr_tail"),
        },
    )

    untraced = [r for r in rows if not r.get("trace_lines")]
    result: dict[str, Any] = {
        "status": "ok",
        "repo": str(repo),
        "service": service,
        "units": len(services),
        "invocations": len(rows),
        "failures": sum(1 for r in rows if r.get("status") != "ok"),
        "issue_clusters": len(clusters),
        "clusters": [c.to_json() for c in clusters],
        "results_file": str(store.exercise_dir(repo) / "invocation_results.jsonl"),
        "trace": {
            "traced": bool(rows) and len(untraced) < len(rows),
            "spans": sum(int(r.get("trace_lines") or 0) for r in rows),
            # Named, not counted: an invocation that ran without producing spans
            # is the failure mode this oracle exists to make visible.
            "untraced_units": [r["unit_id"] for r in untraced],
        },
        "rows": rows,
    }
    store.write_jsonl(store.exercise_dir(repo) / "invocation_results.jsonl", rows)
    store.write_json(store.exercise_dir(repo) / "invocations.json", result)
    lg.info(
        "invocations: %d run across %d service(s), %d failing, %d clusters",
        len(rows), len(services), result["failures"], len(clusters),
    )
    return result


def _trace_lines(capture: Path) -> int:
    try:
        with open(capture, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0
