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

**This oracle never asks anybody anything.** It runs headless, so where the Run
button opens a form prefilled with each parameter's default, this decides for
itself: the declared defaults, plus one variant per value the repo itself
enumerated. See :func:`expand_invocation` for why it will not invent argv beyond
that.
"""

from __future__ import annotations

import logging
import subprocess
import time
from pathlib import Path
from typing import Any

from . import store, tracing
from .invocation_render import invocation_slug, render_invocation
from .issues import build_clusters, merge_into_issues
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


def _verified_expect_exits(repo: Path, service_name: Any) -> dict[str, int]:
    """``id -> expect_exit`` from a service's verified bring-up record.

    ``services.json`` is the inventory the AGENT writes, before anything has
    run. ``.vinv/start_commands/<service>.json`` is what bring-up writes AFTER
    verifying each invocation, so it is the only file that knows a command's
    real exit code. Where the agent omitted ``expect_exit`` — which it may, the
    field is optional and defaults to 0 — the inventory claims 0 for a command
    bring-up watched exit 3 and verified as correct. The exerciser then read the
    inventory, compared 3 against 0, and reported a working command as an error.

    Observed on a real repo: four of fourteen CLI invocations (documented exits
    of 10, 3, 10 and 2) were all flagged as defects.
    """
    if not isinstance(service_name, str) or not service_name.strip():
        return {}
    doc = store.read_json(repo / ".vinv" / "start_commands" / f"{service_name}.json") or {}
    if not isinstance(doc, dict):
        return {}
    out: dict[str, int] = {}
    for inv in doc.get("invocations") or []:
        if not isinstance(inv, dict):
            continue
        ident, expect = inv.get("id"), inv.get("expect_exit")
        if (
            isinstance(ident, str)
            and ident.strip()
            and isinstance(expect, int)
            and not isinstance(expect, bool)
        ):
            out[ident.strip()] = expect
    return out


def read_services(repo: Path) -> list[dict[str, Any]]:
    """The run-to-completion services in ``.vinv/services.json``.

    Read directly rather than through bringup: this package does not depend on
    the renderer, and the field contract is the file, not the code that wrote
    it.

    Each service's invocations are backfilled from its verified bring-up record
    (see :func:`_verified_expect_exits`), which is the only place a command's
    real expected exit code is known.
    """
    doc = store.read_json(repo / ".vinv" / "services.json") or {}
    services = doc.get("services") if isinstance(doc, dict) else None
    if not isinstance(services, list):
        return []
    kept = [
        s for s in services if isinstance(s, dict) and s.get("kind") in _RUN_TO_COMPLETION_KINDS
    ]
    for svc in kept:
        verified = _verified_expect_exits(repo, svc.get("name"))
        if not verified:
            continue
        invocations = svc.get("invocations")
        if not isinstance(invocations, list):
            continue
        for inv in invocations:
            # Only fill a GAP: an expect_exit the agent stated explicitly is a
            # deliberate declaration and outranks the observed run.
            if isinstance(inv, dict) and not isinstance(inv.get("expect_exit"), int):
                ident = inv.get("id")
                if isinstance(ident, str) and ident.strip() in verified:
                    inv["expect_exit"] = verified[ident.strip()]
    return kept


def library_driver_command(project_root: Path, service_name: str) -> str:
    """The parameterized command that drives a ``python_library`` entry.

    Mirrors ``bringup.runner.library_driver_command`` exactly. The ``{only}``
    slot is what makes a library's many entry points reachable one at a time:
    empty (the default) drives every exported callable, as it always has; filled,
    it drives one. That is the same mechanism a CLI's subcommands use, which is
    the point — an entry point IS an invocation, so neither surface needs a
    second vocabulary for "which part of this unit do I run".
    """
    return f"vinv-exerciser functions {project_root.resolve()} --service {service_name} {{only}}"


#: The `{only}` slot above. Choices are resolved at prompt time from the
#: entrypoints inventory rather than frozen here — the exported callables change
#: with every index build, and a pinned list would offer functions that no longer
#: exist.
_LIBRARY_PARAMS: list[dict[str, Any]] = [
    {
        "name": "only",
        "default": "",
        "render": "--only-target {value}",
        "choices_from": "entrypoints",
        "help": "one callable as module:qualname, or blank for every exported callable",
    }
]


def _derived_id(command: str, index: int) -> str:
    """A stable id for an invocation whose inventory entry declares none.

    Derived from the SUBCOMMAND rather than the position or the purpose text,
    because those are the two things that move: inserting an invocation renames
    every later unit, and editing a purpose string would too. The subcommand
    survives both, and survives an argument edit — which is the whole reason this
    id exists, since it keys findings, coverage and history across runs.
    """
    tokens = command.split()
    # A tracelens-wrapped command carries the real invocation after the last
    # standalone `--`; everything before it is the wrapper's own flags.
    if "--" in tokens:
        tokens = tokens[len(tokens) - 1 - tokens[::-1].index("--") + 1 :]
    for token in tokens[1:]:
        if token.startswith("-") or "=" in token:
            continue
        return invocation_slug(token.strip("\"'").lower())
    return f"run-{index + 1}"


def service_invocations(service: dict[str, Any], repo: Path) -> list[dict[str, Any]]:
    """Every command that drives ``service``, normalized to full entries.

    Mirrors ``bringup.runner.service_invocations``: an explicit ``invocations``
    list, else the bare ``command`` as the single invocation, else — for a
    library, which has no command by definition — the function driver.

    Every entry comes back with a stable ``id``: the unit identity downstream, so
    it must never be positional.
    """
    raw = service.get("invocations")
    entries: list[dict[str, Any]] = []
    if isinstance(raw, list):
        for inv in raw:
            if (
                isinstance(inv, dict)
                and isinstance(inv.get("command"), str)
                and inv["command"].strip()
            ):
                entries.append(dict(inv))
    if not entries:
        command = service.get("command")
        if isinstance(command, str) and command.strip():
            entries = [{"command": command}]
        elif service.get("kind") == "python_library":
            name = str(service.get("name") or "repo")
            entries = [
                {
                    "command": library_driver_command(repo, name),
                    "purpose": "drive the library's exported callables",
                    "params": [dict(p) for p in _LIBRARY_PARAMS],
                }
            ]
    seen: set[str] = set()
    for index, entry in enumerate(entries):
        expect = entry.get("expect_exit")
        entry["expect_exit"] = (
            0 if not isinstance(expect, int) or isinstance(expect, bool) else expect
        )
        declared = entry.get("id")
        base = (
            invocation_slug(declared.strip())
            if isinstance(declared, str) and declared.strip()
            else _derived_id(entry["command"], index)
        )
        candidate, n = base, 2
        while candidate in seen:
            candidate, n = f"{base}-{n}", n + 1
        seen.add(candidate)
        entry["id"] = candidate
    return entries


def resolved_command(invocation: dict[str, Any], args: dict[str, str] | None = None) -> str:
    """The command to actually run, with any parameters filled in.

    A parameterless invocation is returned VERBATIM rather than rendered. That is
    not an optimization: a recorded command may legitimately contain a literal
    brace (``--format '{json}'``), and rendering it would raise on a placeholder
    nobody meant to write. Only an invocation that declares parameters opts into
    templating.
    """
    if not invocation.get("params"):
        return str(invocation["command"])
    return render_invocation(invocation, args)


def expand_invocation(invocation: dict[str, Any], *, max_variants: int = 4) -> list[dict[str, Any]]:
    """The argument sets to run this invocation with, declared one first.

    **Bounded by what the repo enumerated, on purpose.** This oracle EXECUTES the
    commands it builds, which makes it categorically different from the HTTP
    generator: an invented request body reaches a running service's validation
    layer, an invented argv reaches the user's shell. So a variant is only ever
    produced from a value the inventory itself listed — an ``enum``'s ``choices``
    or a parameter's explicit ``examples`` — never from a type. Nothing here
    flips a boolean flag it was not handed a value for; ``--force`` and
    ``--delete`` are flags too, and the difference between them and ``--verbose``
    is not visible from the schema.

    Variants change ONE parameter from the defaults at a time (never a cartesian
    product), so a failing row names the parameter that caused it, and the count
    stays linear in the parameters rather than exponential.
    """
    params = invocation.get("params")
    defaults = {
        str(p["name"]): str(p.get("default") or "")
        for p in (params if isinstance(params, list) else [])
        if isinstance(p, dict) and isinstance(p.get("name"), str)
    }
    variants: list[dict[str, Any]] = [
        {"variant": "declared", "input_class": "declared", "args": dict(defaults)}
    ]
    if not isinstance(params, list):
        return variants
    for p in params:
        if not isinstance(p, dict) or not isinstance(p.get("name"), str):
            continue
        name = p["name"]
        pool: list[str] = []
        for source in ("choices", "examples"):
            values = p.get(source)
            if isinstance(values, list):
                pool.extend(str(v) for v in values if isinstance(v, str | int | float))
        for value in pool:
            if value == defaults.get(name) or len(variants) > max_variants:
                continue
            variants.append(
                {
                    "variant": f"{invocation_slug(name)}={invocation_slug(value) or 'blank'}",
                    "input_class": "generated",
                    "args": {**defaults, name: value},
                }
            )
    return variants


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
                    f"no run-to-completion service named {service!r} in " ".vinv/services.json"
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
        pairs = [
            (inv, variant)
            for inv in service_invocations(svc, repo)
            for variant in expand_invocation(inv)
        ]
        for inv, variant in pairs:
            expect_exit = inv["expect_exit"]
            # The unit is the INVOCATION; a parameter variant is a different
            # input to it, exactly as many requests share one HTTP endpoint. So
            # variants share a unit_id and are told apart by `input_class` —
            # giving each its own would inflate the unit count and split one
            # command's coverage across rows that are the same code path.
            unit_id = f"{name}#{inv['id']}"
            try:
                command = resolved_command(inv, variant["args"])
            except ValueError as exc:
                # A template that cannot be filled is a malformed record, not a
                # defect in the tool under test — report it against the unit
                # rather than running something nobody described.
                rows.append(
                    {
                        "unit_kind": "cli_invocation",
                        "unit_id": unit_id,
                        "service": name,
                        "method": METHOD,
                        "path": str(inv.get("command")),
                        "purpose": inv.get("purpose"),
                        "expect_exit": expect_exit,
                        "invocation_id": inv["id"],
                        "variant": variant["variant"],
                        "input_class": variant["input_class"],
                        "status": "error",
                        "error_type": "MalformedInvocation",
                        "error": str(exc),
                        "duration_s": 0.0,
                        "latency_ms": 0.0,
                    }
                )
                lg.warning("invocation_malformed unit=%s error=%s", unit_id, exc)
                continue
            capture = tracing.capture_path(
                repo, name, "invocations", f"{inv['id']}-{variant['variant']}"
            )
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
                # The label half of the unit — the TEMPLATE, not the rendering.
                # Every variant of an invocation is the same unit, so they must
                # agree on this string or the profile would label one unit
                # differently depending on which variant it read last.
                "path": str(inv["command"]),
                "purpose": inv.get("purpose"),
                "expect_exit": expect_exit,
                "command": command,
                "working_directory": str(cwd_path),
                "invocation_id": inv["id"],
                "variant": variant["variant"],
                "args": variant["args"],
                # The profile groups by `input_class` and reads `latency_ms`;
                # carrying both here is what lets one profiler serve a CLI unit
                # and an HTTP endpoint without a second code path. "declared" is
                # the argv the repo's inventory itself recorded; "generated" is a
                # variant built from a value it enumerated — the same distinction
                # the other oracles draw.
                "input_class": variant["input_class"],
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
                row["error"] = f"exited {proc.returncode}, expected {expect_exit}"
            rows.append(row)
            lg.info(
                "invocation unit=%s exit=%s expected=%s spans=%d %.2fs",
                unit_id,
                proc.returncode,
                expect_exit,
                traced_lines,
                duration,
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
            "invocation-timeout"
            if r.get("status") == "timeout"
            else "invocation-failure"
            if r.get("status") == "error"
            else None
        ),
        describe=lambda r, _k: f"{r.get('error_type', 'error')}: {r.get('error', '')}",
        target_of=lambda r: str(r.get("unit_id", "?")),
        method=METHOD,
        # Which argv produced the failure: the inventory's own, or a variant
        # built from a value it enumerated. A fixing agent reads this to know
        # whether the recorded command is broken or only one of its inputs.
        strategy=lambda r, _k: f"invocation/{r.get('input_class', 'declared')}",
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
            # is the failure mode this oracle exists to make visible. Deduped,
            # because a unit with several parameter variants would otherwise be
            # named once per variant and read as several broken units.
            "untraced_units": sorted({r["unit_id"] for r in untraced}),
        },
        "rows": rows,
    }
    store.write_jsonl(store.exercise_dir(repo) / "invocation_results.jsonl", rows)
    store.write_json(store.exercise_dir(repo) / "invocations.json", result)
    # Publish into issues.json — the ONE file the extension's Findings view and
    # fix-episode dispatcher read. Writing only invocations.json stranded every
    # CLI failure: correctly found, correctly clustered, and invisible. The
    # campaign publishes its own oracles, but it does not always run — on a
    # CLI-only repo it stops with 'no-actions' before publishing anything — so
    # this oracle cannot delegate the step.
    result["issues_published"] = merge_into_issues(repo, (c.to_json() for c in clusters), logger=lg)
    lg.info(
        "invocations: %d run across %d service(s), %d failing, %d clusters",
        len(rows),
        len(services),
        result["failures"],
        len(clusters),
    )
    return result


def _trace_lines(capture: Path) -> int:
    try:
        with open(capture, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0
