"""Trace CHILD processes, and merge their sidecars back into the trace.

The hook is installed only in the launcher's own interpreter, so a target that
spawns work — ``subprocess`` executors, ``multiprocessing`` pools, ``uvicorn
--workers``, a CLI shelling out to another script — produced spans for the
parent and nothing at all for the child. Subprocess executors are exactly where
sandboxed code runs, so that hole covered the most interesting frames in the
program.

Two halves:

* **Bootstrap.** ``install_child_bootstrap`` writes a ``sitecustomize.py`` into
  a private directory and prepends it to ``PYTHONPATH``. CPython imports
  ``sitecustomize`` automatically at interpreter startup, so ANY Python child
  that inherits the environment installs the hook itself — no wrapper, no
  ``-m`` rewriting, and it survives arbitrarily deep process trees. The child
  writes to its own ``<output>.child-<pid>`` sidecar, because two processes
  appending JSONL lines longer than ``PIPE_BUF`` to one file will interleave
  mid-line.
* **Merge.** ``merge_sidecars`` folds every ``.child-*``/``.fork-*`` sidecar
  into the main trace in timestamp order once the run is over. Without this the
  sidecars are dead files: every reader in the repo resolves a capture by
  globbing ``trace.jsonl`` exactly, so a sidecar that is never merged is a
  capture that was never taken.

Escape hatch: ``TRACELENS_NO_CHILD_TRACING=1``.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

_log = logging.getLogger("tracelens.diag")

_ENV_DISABLE = "TRACELENS_NO_CHILD_TRACING"
# Set in the child's environment so a grandchild does not re-derive its own
# output path from the PARENT's (every process needs its own sidecar).
_ENV_PARENT_OUTPUT = "TRACELENS_PARENT_OUTPUT"

# The bootstrap runs at interpreter startup in a foreign process, so it must be
# defensive to the point of paranoia: any failure has to leave the child
# running normally, untraced. It re-derives its own sidecar path from the
# parent's output, installs the same hooks the launcher installs, and gets out
# of the way.
_SITECUSTOMIZE = '''\
"""tracelens child bootstrap — installed via PYTHONPATH, imported by CPython.

Never raises into the host program: a child that cannot be traced must still
run correctly.
"""

import os
import sys


def _tracelens_bootstrap():
    if os.environ.get("TRACELENS_NO_CHILD_TRACING") == "1":
        return
    parent_output = os.environ.get("TRACELENS_PARENT_OUTPUT") or os.environ.get(
        "TRACELENS_OUTPUT"
    )
    if not parent_output or parent_output == "-":
        return
    # Each process owns its own sidecar; concurrent appends of long JSONL lines
    # to one file interleave mid-line.
    own = f"{parent_output}.child-{os.getpid()}"
    os.environ["TRACELENS_OUTPUT"] = own
    os.environ["TRACELENS_PARENT_OUTPUT"] = parent_output
    try:
        from tracelens.launcher import monitoring_hook

        monitoring_hook.install()
    except Exception:
        return
    try:
        from tracelens.otel.configurator import TracelensConfigurator

        TracelensConfigurator().configure()
    except Exception:
        # Spans still route through whatever pipeline the child sets up; the
        # AST hook is installed either way.
        pass


try:
    _tracelens_bootstrap()
except Exception:
    pass

# Chain to any sitecustomize the host environment already had — ours must not
# displace a real one (virtualenvs and distro packages ship them).
try:
    _here = os.path.dirname(os.path.abspath(__file__))
    _rest = [p for p in sys.path if os.path.abspath(p) != _here]
    import importlib.machinery
    import importlib.util

    _spec = importlib.machinery.PathFinder.find_spec("sitecustomize", _rest)
    if _spec is not None and _spec.loader is not None:
        _mod = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
except Exception:
    pass
'''


def install_child_bootstrap(output_path: str) -> str | None:
    """Arm child-process tracing. Returns the bootstrap dir, or None when off.

    Writes ``sitecustomize.py`` to a private temp dir and PREPENDS it to
    ``PYTHONPATH`` so every inheriting Python process installs the hook.
    """
    if os.environ.get(_ENV_DISABLE) == "1":
        return None
    if not output_path or output_path == "-":
        return None
    try:
        boot_dir = tempfile.mkdtemp(prefix="tracelens-childboot-")
        Path(boot_dir, "sitecustomize.py").write_text(_SITECUSTOMIZE, encoding="utf-8")
    except OSError as exc:
        _log.warning("tracelens child tracing unavailable: %s", exc)
        return None
    # The child derives its own sidecar from this, never from TRACELENS_OUTPUT
    # (which each process overwrites with its own path).
    os.environ[_ENV_PARENT_OUTPUT] = output_path
    existing = os.environ.get("PYTHONPATH")
    os.environ["PYTHONPATH"] = boot_dir if not existing else boot_dir + os.pathsep + existing
    _log.info("tracelens child tracing armed via %s", boot_dir)
    return boot_dir


def sidecar_paths(output_path: str) -> list[Path]:
    """Every child/fork sidecar written alongside ``output_path``."""
    path = Path(output_path)
    parent, stem = path.parent, path.name
    if not parent.is_dir():
        return []
    out = [
        p
        for p in parent.iterdir()
        if p.is_file()
        and (p.name.startswith(stem + ".child-") or p.name.startswith(stem + ".fork-"))
    ]
    return sorted(out)


def _ts_of(line: str) -> str:
    """The ``ts`` field of a JSONL row, or "" — the merge sort key.

    Timestamps are ISO-8601 UTC with fixed millisecond width, so lexical order
    IS chronological order and no parsing is needed.
    """
    try:
        obj = json.loads(line)
    except ValueError:
        return ""
    return obj.get("ts", "") if isinstance(obj, dict) else ""


# Names of sidecars this process folded in, so the summary can report them
# after the files themselves are gone.
MERGED_SIDECARS: list[str] = []


def merge_sidecars(output_path: str, *, remove: bool = True) -> dict[str, int]:
    """Fold child/fork sidecars into the main trace, in timestamp order.

    Returns ``{"files": n, "lines": n}``. Best-effort and never raises: a
    sidecar that cannot be read is skipped and left on disk as evidence.
    Idempotent when ``remove`` is true (merged sidecars are deleted).
    """
    merged = {"files": 0, "lines": 0}
    try:
        sidecars = sidecar_paths(output_path)
    except OSError:
        return merged
    if not sidecars:
        return merged

    rows: list[tuple[str, str]] = []
    consumed: list[Path] = []
    for side in sidecars:
        try:
            text = side.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = [ln for ln in text.splitlines() if ln.strip()]
        if not lines:
            consumed.append(side)
            continue
        rows.extend((_ts_of(ln), ln) for ln in lines)
        consumed.append(side)
        merged["files"] += 1
        merged["lines"] += len(lines)
    if not rows:
        for side in consumed:
            if remove:
                side.unlink(missing_ok=True)
        return merged

    # Stable sort by ts keeps each process's own event order intact where
    # timestamps tie, which matters for enter/exit pairing.
    rows.sort(key=lambda pair: pair[0])
    try:
        with open(output_path, "a", encoding="utf-8") as fh:
            for _, line in rows:
                fh.write(line + "\n")
            fh.flush()
            os.fsync(fh.fileno())
    except OSError as exc:
        _log.warning("tracelens could not merge child sidecars: %s", exc)
        return {"files": 0, "lines": 0}
    MERGED_SIDECARS.extend(s.name for s in consumed)
    if remove:
        for side in consumed:
            try:
                side.unlink(missing_ok=True)
            except OSError:
                pass
    _log.info(
        "tracelens merged %d child sidecar(s), %d span line(s)",
        merged["files"],
        merged["lines"],
    )
    return merged


def merge_at_exit(output_path: str) -> None:
    """``atexit`` hook that merges only in the process that registered it.

    ``atexit`` handlers are INHERITED across ``os.fork``, so without this guard
    a forked child would run the parent's merge — two processes appending to
    the same trace concurrently, which is the interleaving the sidecars exist
    to prevent. The child only ever writes its own sidecar; the parent folds it
    in.
    """
    owner = os.getpid()

    def _hook() -> None:
        if os.getpid() != owner:
            return
        merge_sidecars(output_path)

    import atexit

    atexit.register(_hook)
