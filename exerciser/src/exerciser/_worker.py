"""The worker protocol — spawn, decode, parse, dispatch — defined ONCE.

Five oracles (``functions``, ``differential``, ``faults``, ``concurrency``,
``sandbox``) each drive target code in an isolated subprocess, and each carried
a private copy of the same protocol: build ``[python, -m, exerciser.X,
--worker, --plan, --repo]``, clone the environment and prepend ``PYTHONPATH``,
``subprocess.run`` with a timeout, catch ``TimeoutExpired``, split stdout, parse
each line as JSON, skip unparseable lines. The clone detector found
character-identical five-way matches, and the ``PYTHONPATH`` join was
byte-identical in four files.

That is not a style problem. It meant a fix to the protocol had to land in five
places, and in practice it landed in one:

* the UTF-8 decoding fix had to be applied nine times, and a single miss would
  have left one oracle dying on a target that prints an emoji;
* ``differential`` buffered every row and emitted once at the end, so one
  hanging snippet discarded all 378 comparisons — while ``functions`` had the
  same shape and needed the same fix independently;
* ``proc.stderr`` was captured and never read in every copy, so a worker that
  segfaulted left no trace at all.

Anything a worker needs that is genuinely per-oracle — the plan's contents, how
rows are judged, whether the argv is wrapped by a containment mechanism — is a
parameter here, not a reason to copy the protocol again.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class WorkerResult:
    """What one worker invocation produced."""

    rows: list[dict[str, Any]] = field(default_factory=list)
    timed_out: bool = False
    returncode: int | None = None
    #: The tail of the worker's stderr. Captured in every copy of this protocol
    #: and read by none of them, which is why a worker that segfaulted or was
    #: OOM-killed was indistinguishable from one that simply found nothing.
    stderr_tail: str = ""

    @property
    def died_silently(self) -> bool:
        """Non-zero exit with nothing to show for it — always worth reporting."""
        return not self.timed_out and bool(self.returncode) and not self.rows


def worker_env(
    *,
    base: dict[str, str] | None = None,
    extra_pythonpath: Sequence[str] = (),
) -> dict[str, str]:
    """Environment for a worker: our package importable, stdio pinned to UTF-8.

    ``PYTHONIOENCODING`` is not optional. The locale encoding is cp1252 on
    Windows for every interpreter this project supports (``<3.15``, so PEP 686's
    UTF-8 default never applies), so a target printing an emoji, CJK text, or a
    ``repr`` containing either would raise ``UnicodeEncodeError`` inside the
    worker and cost that module every row it had already earned.
    """
    env = dict(os.environ if base is None else base)
    parts = [env.get("PYTHONPATH"), *extra_pythonpath, str(Path(__file__).parents[1])]
    env["PYTHONPATH"] = os.pathsep.join([p for p in parts if p])
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def run_worker(
    module: str,
    *,
    plan_file: Path,
    repo: Path,
    python: str | None = None,
    timeout_s: float,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    wrap: Callable[[list[str]], list[str]] | None = None,
    preexec: Callable[[], None] | None = None,
) -> WorkerResult:
    """Drive ``exerciser.<module> --worker`` over a plan and collect its rows.

    ``wrap`` is the one genuine variation: the sandbox passes its containment
    mechanism's ``wrap`` so the same argv is launched under bwrap/unshare/
    sandbox-exec. Everything else is identical across every caller.

    Never raises for a target's misbehaviour — a hang, a non-zero exit and a
    torn line are all outcomes, reported on ``WorkerResult``.
    """
    argv = [
        python or sys.executable,
        "-m",
        f"exerciser.{module}",
        "--worker",
        "--plan",
        str(plan_file),
        "--repo",
        str(repo),
    ]
    if wrap is not None:
        argv = wrap(argv)

    try:
        proc = subprocess.run(  # noqa: S603 (fixed argv, no shell)
            argv,
            capture_output=True,
            text=True,
            # Explicit, because the default is the LOCALE encoding: undecodable
            # bytes from a target would otherwise raise UnicodeDecodeError
            # inside subprocess.run itself and take down the whole run, not just
            # this worker.
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
            cwd=str(cwd or repo),
            env=env if env is not None else worker_env(),
            **({"preexec_fn": preexec} if preexec is not None else {}),
        )
    except subprocess.TimeoutExpired as exc:
        # A timeout still carries whatever the worker managed to emit. Because
        # workers stream, those rows were genuinely earned and must not be
        # thrown away with the process.
        partial = exc.stdout or ""
        if isinstance(partial, bytes):
            partial = partial.decode("utf-8", errors="replace")
        return WorkerResult(rows=parse_rows(partial), timed_out=True)

    return WorkerResult(
        rows=parse_rows(proc.stdout or ""),
        returncode=proc.returncode,
        stderr_tail=" | ".join((proc.stderr or "").strip().splitlines()[-8:]),
    )


def parse_rows(stdout: str) -> list[dict[str, Any]]:
    """JSON objects, one per line; anything unparseable is skipped.

    A torn or interleaved line is never fatal — the protocol is line-delimited
    precisely so one bad line costs one row.
    """
    rows: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def emit(row: dict[str, Any]) -> dict[str, Any]:
    """Worker side: write ONE row immediately, and return it.

    Streaming rather than buffering to the end is what makes a hang, a hard
    exit or a segfault cost the rows still outstanding instead of every row the
    worker had already produced.
    """
    sys.stdout.write(json.dumps(row, default=str) + "\n")
    sys.stdout.flush()
    return row


def worker_entrypoint(
    argv: list[str] | None,
    worker_main: Callable[[list[str]], int],
    usage: str,
) -> int:
    """The ``main()`` every oracle module needs — one implementation.

    Each module carried a verbatim copy of this that differed only in the usage
    string.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    if "--worker" in args:
        args.remove("--worker")
        return worker_main(args)
    sys.stderr.write(usage.rstrip("\n") + "\n")
    return 2
