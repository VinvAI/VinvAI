"""Wrapping a worker in ``tracelens run`` so driven calls produce spans.

The function driver imports target modules and calls their exported callables
in a subprocess. That subprocess is the only place a library's own code ever
runs, so it is the only place tracelens can instrument it — which is why the
worker docstring has always named itself "the natural place for tracelens to
attach". This module is that attachment.

Nothing here is specific to the ``functions`` oracle. The wrap is a pure argv
transform of exactly the shape ``_worker.run_worker`` already accepts for
containment, so an oracle that wants traced workers composes the two rather
than growing its own launcher.

**Degrading is deliberate.** When tracelens cannot be resolved the argv comes
back unchanged and the run proceeds untraced: the exercise still produces rows,
coverage and issues, it just produces no spans. A missing tracer is a reason to
report less, never a reason to refuse to drive the code — the caller records
:func:`trace_status` in its summary so a span-less run says why.
"""

from __future__ import annotations

import importlib.util
import os
import re
import shlex
import shutil
import sys
from collections.abc import Sequence
from pathlib import Path

#: Capture session directory, mirroring bring-up's `.vinv/captures/vinv-bringup/`.
TRACE_SESSION = "vinv-exerciser"

_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _slug(name: str) -> str:
    return _SLUG_RE.sub("-", name).strip("-") or "service"


def resolve_tracelens() -> list[str] | None:
    """The argv prefix that runs tracelens, or None when it is not installed.

    Prefers the console script (the frozen binary in a packaged install), and
    falls back to ``-m tracelens.cli`` for a dev checkout whose venv is on
    ``sys.path`` but whose ``Scripts/`` is not on ``PATH`` — the normal shape
    when the extension spawns an engine by absolute path.
    """
    exe = shutil.which("tracelens")
    if exe:
        return [exe]
    try:
        if importlib.util.find_spec("tracelens.cli") is not None:
            return [sys.executable, "-m", "tracelens.cli"]
    except (ImportError, ValueError):  # pragma: no cover - broken install
        pass
    return None


def capture_path(repo: Path, service: str | None, oracle: str, unit: str | None = None) -> Path:
    """Where a traced worker writes its JSONL.

    ``.vinv/captures/vinv-exerciser/<service>/<oracle>/[<unit>.]trace.jsonl`` —
    the same ``captures/<session>/<slug>/`` layout bring-up writes, so every
    consumer that globs for captures finds these without being taught a second
    convention. Per-unit files exist because workers TRUNCATE their output: one
    shared path across modules would leave only whichever module ran last.
    """
    base = repo / ".vinv" / "captures" / TRACE_SESSION / _slug(service or "repo") / oracle
    return base / (f"{_slug(unit)}.trace.jsonl" if unit else "trace.jsonl")


def tracelens_wrap(
    argv: list[str],
    *,
    target_packages: Sequence[str],
    output: Path,
    sample_rate: float = 1.0,
) -> list[str]:
    """``argv`` wrapped in ``tracelens run``, or ``argv`` unchanged.

    Returned unchanged when tracelens is missing or no target package was
    resolved — instrumenting nothing is what a bare wrap would achieve anyway,
    at the cost of a launcher in between.

    ``target_packages`` are the TARGET's import packages, never the exerciser's.
    Tracing the driver instead of the driven code is the one mistake here that
    still produces a plausible-looking non-empty trace.
    """
    packages = [p for p in dict.fromkeys(target_packages) if p and p.isidentifier()]
    base = resolve_tracelens()
    if base is None or not packages:
        return list(argv)
    output.parent.mkdir(parents=True, exist_ok=True)
    wrapper = [*base, "run"]
    for pkg in packages:
        wrapper += ["--target-package", pkg]
    wrapper += ["--output", str(output), "--sample-rate", str(sample_rate), "--"]
    return [*wrapper, *argv]


def tracelens_wrap_command(
    command: str,
    *,
    target_packages: Sequence[str],
    output: Path,
    sample_rate: float = 1.0,
) -> str:
    """``command`` wrapped in ``tracelens run``, as a SHELL STRING.

    The argv form ([`tracelens_wrap`]) is for a worker whose argv we built
    ourselves. A recorded invocation is different: it is a command line the repo
    (or the bring-up agent) wrote, and in this project those are bash-spelled —
    env prefixes, `/c/`-style paths, quoting that only a shell resolves. Parsing
    one into argv to re-quote it is how that spelling gets destroyed, so the
    prefix is composed as text and the shell does the splitting it was always
    going to do.

    Returned unchanged when tracelens is missing or no package resolves.
    """
    packages = [p for p in dict.fromkeys(target_packages) if p and p.isidentifier()]
    base = resolve_tracelens()
    if base is None or not packages:
        return command
    output.parent.mkdir(parents=True, exist_ok=True)
    parts = [*base, "run"]
    for pkg in packages:
        parts += ["--target-package", pkg]
    parts += ["--output", str(output), "--sample-rate", str(sample_rate), "--"]
    return " ".join(shlex.quote(p) for p in parts) + " " + command


def shell_quote_path(path: Path) -> str:
    """A filesystem path as one shell word.

    ``shlex.quote`` single-quotes, which is what makes a Windows path with
    backslashes survive bash intact — inside single quotes a backslash is a
    literal, not an escape.
    """
    return shlex.quote(str(path))


def resolve_shell() -> list[str] | None:
    """The argv prefix that runs a recorded command string, or None.

    bash, for the same reason bring-up's replay uses bash: the commands this
    runs were written to be run by it. On Windows that is Git Bash — never
    WSL's `System32\\bash.exe` stub, which cannot see the repo's interpreter.
    """
    if os.name == "nt":
        for candidate in (
            os.environ.get("VINV_BASH"),
            shutil.which("bash"),
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ):
            if not candidate:
                continue
            path = Path(candidate)
            # The System32 stub is a WSL launcher, not a shell we can use.
            if path.parent.name.lower() == "system32":
                continue
            if path.is_file():
                return [str(path), "-lc"]
        return None
    bash = shutil.which("bash") or "/bin/bash"
    return [bash, "-lc"] if Path(bash).is_file() else None


def invocation_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """Environment for a traced invocation: stdio pinned to UTF-8.

    Same reason the worker pins it — the locale encoding is cp1252 on Windows
    for every interpreter this project supports, so a CLI printing a box-drawing
    character or any CJK text would die inside its own print rather than doing
    its job.
    """
    env = dict(os.environ if base is None else base)
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def trace_status(target_packages: Sequence[str]) -> dict[str, object]:
    """Why this run is or is not traced — recorded in the oracle's summary.

    A run with no spans is otherwise indistinguishable from a run whose spans
    were lost, and those have different fixes.
    """
    packages = [p for p in dict.fromkeys(target_packages) if p and p.isidentifier()]
    if resolve_tracelens() is None:
        return {
            "traced": False,
            "reason": (
                "tracelens is not installed (no `tracelens` on PATH and no importable "
                "tracelens.cli) — install it to capture spans for these calls"
            ),
        }
    if not packages:
        return {
            "traced": False,
            "reason": (
                "no importable target package was resolved for these modules, so "
                "`--target-package` would match nothing"
            ),
        }
    return {"traced": True, "target_packages": packages}


def merge_traces(directory: Path, name: str = "trace.jsonl") -> Path | None:
    """Concatenate per-unit captures into one ``trace.jsonl`` beside them.

    Line-oriented JSONL concatenates cleanly, and each part keeps its own
    per-run header — those describe genuinely separate runs, so collapsing them
    would misreport one calibration as covering all of the work.

    Returns the merged path, or None when nothing was captured.
    """
    parts = sorted(p for p in directory.glob("*.trace.jsonl") if p.name != name)
    parts = [p for p in parts if p.is_file() and p.stat().st_size > 0]
    if not parts:
        return None
    merged = directory / name
    with open(merged, "wb") as out:
        for part in parts:
            with open(part, "rb") as src:
                shutil.copyfileobj(src, out)
            # A part whose final line lacks its newline would otherwise splice
            # onto the next part's first line and lose both.
            if part.stat().st_size and not _ends_with_newline(part):
                out.write(os.linesep.encode())
    return merged


def _ends_with_newline(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            f.seek(-1, os.SEEK_END)
            return f.read(1) in (b"\n", b"\r")
    except OSError:
        return True
