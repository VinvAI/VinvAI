"""`tracelens run` orchestrator (spec §5.2).

T1.4 / T4.2 / T4.4 / T4.5 — tracks the dispatch decision, OTel-instrumenter load status,
coverage scan, rewrite status; on shutdown writes ``<output>.summary.json``. Default output
path is ``$TRACELENS_HOME/baselines/<service>/trace.jsonl``.
"""

from __future__ import annotations

import logging
import math
import os
import re
import runpy
import shutil
import signal
import stat
import sys
from collections.abc import Sequence
from pathlib import Path, PurePosixPath

from tracelens.launcher import coverage_scan as _scan_mod
from tracelens.launcher import executor_context as _exec_ctx
from tracelens.launcher import otel_setup
from tracelens.launcher import summary as _summary_mod
from tracelens.launcher import targets as _targets_mod

_log = logging.getLogger("tracelens.diag")

# Module-level state used by the shutdown handler — populated in run_main.
_run_state: dict[str, object] = {}

# Observability presets. A bare `tracelens run` uses ``standard``. All collection now flows
# through the single AST-rewrite path (``wrap_call``), which captures BOTH latency (span
# duration) and memory (``tracelens.mem_delta_bytes``) per function. ``minimal`` drops the
# extra axes (memory + determinism capture) for the lowest-overhead bare-span baseline;
# ``standard`` keeps memory but requires determinism to be explicitly requested because
# RNG payloads can contain credentials; ``full`` enables both for controlled experiments. The
# heavy out-of-process/sampling profilers (CPU/alloc/gc/rss sampler, eBPF) have been removed.
# Granular flags (``--memory`` / ``--capture-determinism``) override the preset per axis.
_PRESETS: dict[str, dict[str, object]] = {
    "minimal": {"determinism": False, "memory": False},
    "standard": {"determinism": False, "memory": True},
    "full": {"determinism": True, "memory": True},
}
_DEFAULT_PRESET = "standard"
_MAX_BUNDLED_SOURCE_FILES = 10_000
_MAX_BUNDLED_SOURCE_BYTES = 256 * 1024 * 1024


def _safe_service_name(value: str) -> str:
    """Turn an OTel service name into one safe path component."""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip(".-")
    return safe[:128] or "tracelens-target"


def _configure_diag() -> None:
    diag = os.environ.get("TRACELENS_DIAG_LOG")
    if not diag:
        return
    Path(diag).parent.mkdir(parents=True, exist_ok=True)
    h = logging.FileHandler(diag, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    _log.addHandler(h)
    _log.setLevel(logging.INFO)


def _log_diag_dispatch(token: str) -> None:
    """Spec §20 #15: one runpy vs execvp decision per run, logged for tests."""
    try:
        diag = os.environ.get("TRACELENS_DIAG_LOG")
        if diag:
            with open(diag, "a", encoding="utf-8") as fh:
                fh.write(f"tracelens_dispatch={token}\n")
    except Exception:
        pass
    _log.info("tracelens_dispatch=%s", token)


def _parse_user_command(argv: Sequence[str]) -> tuple[list[str], list[str]]:
    if "--" not in argv:
        raise SystemExit("tracelens run: missing '--' before user command")
    i = argv.index("--")
    return list(argv[:i]), list(argv[i + 1 :])


def _default_output(user_command: list[str]) -> str:
    """T4.4 — ``$TRACELENS_HOME/baselines/<service>/trace.jsonl`` if user didn't pass --output.

    Service name is inferred from the basename of the first arg's directory, falling back to
    ``OTEL_SERVICE_NAME`` or ``tracelens-target``. Best-effort; user can always override.
    """
    home = Path(os.environ.get("TRACELENS_HOME", str(Path.home() / ".tracelens")))
    svc = os.environ.get("OTEL_SERVICE_NAME")
    if not svc:
        if user_command and user_command[0]:
            cwd = Path.cwd().name or "tracelens-target"
            cmd_stem = Path(user_command[0]).stem
            svc = cwd if cmd_stem.lower() in ("python", "python3", "uv") else cmd_stem
        else:
            svc = "tracelens-target"
    svc = _safe_service_name(svc)
    return str(home / "baselines" / svc / "trace.jsonl")


def _parse_run_flags(
    pre: list[str], *, user_command: list[str]
) -> tuple[str, list[str], str, bool, int, bool, bool, bool]:
    """Returns ``(output, targets, sample_rate, no_autoinst, summary_byte_cap,
    accept_fork_loss, memory_enabled, capture_determinism)``.

    ``memory_enabled`` / ``capture_determinism`` are resolved from the active preset
    (``--minimal`` / ``--standard`` (default) / ``--full``); a matching granular flag or env
    var overrides the preset for just that axis."""
    output: str | None = None
    targets: list[str] = []
    sample = "1.0"
    no_autoinst = False
    instrument_third = False
    summary_byte_cap = 256
    accept_fork_loss = False
    # Preset drives the defaults; ``None`` overrides mean "fall back to the preset for this axis".
    preset = os.environ.get("TRACELENS_PRESET", _DEFAULT_PRESET)
    _mem_env = os.environ.get("TRACELENS_MEMORY")
    memory_override: bool | None = (
        None if _mem_env is None else _mem_env not in ("0", "none", "off", "false")
    )
    determinism_override: bool | None = (
        True if os.environ.get("TRACELENS_CAPTURE_DETERMINISM") == "1" else None
    )
    i = 0
    while i < len(pre):
        a = pre[i]
        if a in ("--output", "-o") and i + 1 < len(pre):
            output = pre[i + 1]
            i += 2
        elif a in ("--target-package", "-t") and i + 1 < len(pre):
            targets.append(pre[i + 1])
            i += 2
        elif a == "--sample-rate" and i + 1 < len(pre):
            sample = pre[i + 1]
            i += 2
        elif a == "--no-otel-autoinst":
            no_autoinst = True
            i += 1
        elif a == "--instrument-third-party":
            instrument_third = True
            i += 1
        elif a == "--summary-byte-cap" and i + 1 < len(pre):
            try:
                summary_byte_cap = int(pre[i + 1])
            except ValueError:
                raise SystemExit(
                    f"tracelens run: --summary-byte-cap expects int, got {pre[i + 1]!r}"
                ) from None
            i += 2
        elif a == "--accept-fork-loss":
            accept_fork_loss = True
            i += 1
        elif a in ("--minimal", "--standard", "--full"):
            preset = a[2:]
            i += 1
        elif a == "--memory":
            memory_override = True
            i += 1
        elif a == "--no-memory":
            memory_override = False
            i += 1
        elif a == "--capture-determinism":
            determinism_override = True
            i += 1
        elif a == "--no-capture-determinism":
            determinism_override = False
            i += 1
        else:
            raise SystemExit(f"tracelens run: unknown option {a!r}")
    if instrument_third:
        os.environ["TRACELENS_INSTRUMENT_THIRD_PARTY"] = "1"
    try:
        sample_value = float(sample)
    except ValueError:
        raise SystemExit(
            f"tracelens run: --sample-rate expects a number from 0 to 1, got {sample!r}"
        ) from None
    if not math.isfinite(sample_value) or not 0.0 <= sample_value <= 1.0:
        raise SystemExit(f"tracelens run: --sample-rate must be between 0 and 1, got {sample!r}")
    if summary_byte_cap < 0:
        raise SystemExit(
            "tracelens run: --summary-byte-cap must be nonnegative, " f"got {summary_byte_cap}"
        )
    if summary_byte_cap != 256:
        os.environ["TRACELENS_SUMMARY_BYTE_CAP"] = str(summary_byte_cap)
    if output is None:
        output = _default_output(user_command)

    cfg = _PRESETS.get(preset, _PRESETS[_DEFAULT_PRESET])
    memory_enabled = memory_override if memory_override is not None else bool(cfg["memory"])
    capture_determinism = (
        determinism_override if determinism_override is not None else bool(cfg["determinism"])
    )
    return (
        output,
        targets,
        sample,
        no_autoinst,
        summary_byte_cap,
        accept_fork_loss,
        memory_enabled,
        capture_determinism,
    )


def _warn_if_multi_process(user_command: list[str], accept_fork_loss: bool) -> None:
    """T4.2 — detect ``--reload`` / multi-worker patterns and warn loudly."""
    flat = " ".join(user_command)
    danger_tokens = ("--reload", "--workers", "-w ", "--preload", "gunicorn")
    if any(tok in flat for tok in danger_tokens):
        msg = (
            "tracelens: detected multi-process target pattern (--reload, --workers, gunicorn). "
            "Child-process spans will be lost; only the master is traced. "
            "Drop the offending flag or pass --accept-fork-loss to silence this warning."
        )
        if not accept_fork_loss:
            _log.warning(msg)
            print(f"\033[33m[tracelens] {msg}\033[0m", file=sys.stderr)
        else:
            _log.info("tracelens: --accept-fork-loss set; silently tracing master only")


def _is_simple_python_script(cmd: list[str]) -> Path | None:
    if len(cmd) < 2:
        return None
    exe0 = shutil.which(cmd[0]) or cmd[0]
    name = Path(exe0).name.lower()
    if "python" not in name:
        return None
    script = Path(cmd[1]).expanduser()
    if not script.is_file():
        script = Path.cwd() / cmd[1]
    if script.suffix == ".py" and script.is_file():
        return script.resolve()
    return None


def _python_m_module(cmd: list[str]) -> tuple[str, list[str]] | None:
    """``python -m pkg ...`` → runpy (same in-process OTel as ``run_path``)."""
    if len(cmd) < 3:
        return None
    exe0 = shutil.which(cmd[0]) or cmd[0]
    if "python" not in Path(exe0).name.lower():
        return None
    if cmd[1] != "-m":
        return None
    return cmd[2], cmd[3:]


def _is_frozen() -> bool:
    """True when running inside a Nuitka/PyInstaller-style frozen binary.

    Nuitka normally injects ``__compiled__`` into compiled modules and exposes
    ``NUITKA_ONEFILE_*`` in onefile children; PyInstaller/cx_Freeze set
    ``sys.frozen``. Check all markers because a false negative makes a shipped
    onefile binary attempt an impossible in-process import of the target
    service's dependencies.
    """
    if getattr(sys, "frozen", False) or globals().get("__compiled__"):
        return True
    main = sys.modules.get("__main__")
    if main is not None and getattr(main, "__compiled__", None):
        return True
    return bool(
        os.environ.get("NUITKA_ONEFILE_PARENT") or os.environ.get("NUITKA_ONEFILE_DIRECTORY")
    )


def _external_target_python(user: list[str]) -> str | None:
    """Resolve the interpreter a ``python …`` user command would launch.

    Returns the resolved python path when ``user`` runs an external Python
    (``python script.py`` or ``python -m module``) on a **different** interpreter
    than the one currently hosting tracelens; otherwise ``None`` (there is
    nothing to hand off — the in-process runpy path can serve it).

    The "different interpreter" test is what makes a frozen ``tracelens`` binary
    hand the run off to the service's own venv python (whose ``sys.executable``
    is not this binary), while a source ``tracelens`` already running inside the
    target venv keeps the fast in-process path.
    """
    if len(user) < 2:
        return None
    exe0 = shutil.which(user[0]) or user[0]
    if "python" not in Path(exe0).name.lower():
        return None
    try:
        same = os.path.realpath(exe0) == os.path.realpath(sys.executable)
    except OSError:
        same = False
    if same:
        return None
    return exe0


def _is_python_command(user: list[str]) -> bool:
    if not user:
        return False
    exe0 = shutil.which(user[0]) or user[0]
    return "python" in Path(exe0).name.lower()


def _tracelens_source_root() -> str | None:
    """Directory to prepend to a child interpreter's ``PYTHONPATH`` so it can
    ``import tracelens`` from source.

    A frozen binary's tracelens modules are Nuitka-compiled for the build
    interpreter's ABI and are not importable by the target venv's python, so the
    handoff child must load tracelens from a real source tree. Resolution order:

      1. ``TRACELENS_SOURCE_ROOT`` / ``VINV_TRACELENS_PACKAGE_PATH`` env override
         (accepts either the ``src`` dir or a repo root containing ``src``).
      2. When **frozen**, the ``tracelens_src.zip`` the onefile build bundles as
         a data file (``--include-data-files=…=tracelens_src.zip``), located
         relative to this module's ``__file__`` inside the extraction dir. The
         zip is **extracted to a real directory** (not used in place): the child
         must discover tracelens' distribution metadata via ``importlib.metadata``
         to configure its OTel span exporter (the ``opentelemetry_configurator``
         entry point) — and entry-point discovery over a real ``.dist-info`` on a
         filesystem ``sys.path`` entry is reliable, whereas zipimport metadata is
         not. Without it the child silently falls back to the no-op
         ``ProxyTracerProvider`` and writes an EMPTY baseline. This makes the
         binary self-contained — no env var or co-located checkout needed.
      3. When **not** frozen, the source tree containing this very file.
    """
    for var in ("TRACELENS_SOURCE_ROOT", "VINV_TRACELENS_PACKAGE_PATH"):
        v = os.environ.get(var)
        if not v:
            continue
        base = Path(v).expanduser()
        for cand in (base / "src", base):
            if (cand / "tracelens" / "__init__.py").is_file():
                return str(cand.resolve())
    if _is_frozen():
        # Bundled-source lookup: this module is …/<extract>/tracelens/launcher/
        # run.py and the zip lands at …/<extract>/tracelens_src.zip. Extract it
        # to a stable per-extract cache dir and return that *directory* so the
        # child gets real .py files + a discoverable .dist-info (see above).
        try:
            here = Path(__file__).resolve()
            for anchor in (here.parents[2], here.parents[1], here.parents[3]):
                cand = anchor / "tracelens_src.zip"
                if cand.is_file():
                    return _extract_bundled_source(cand)
        except (IndexError, OSError):
            pass
        return None
    try:
        src = Path(__file__).resolve().parents[2]  # …/src/tracelens/launcher/run.py → …/src
        if (src / "tracelens" / "__init__.py").is_file():
            return str(src)
    except (IndexError, OSError):
        pass
    return None


def _extract_bundled_source(zip_path: Path) -> str | None:
    """Extract the bundled ``tracelens_src.zip`` to a real dir; return that dir.

    Extracts next to the zip (the onefile extraction dir is stable across runs
    via ``--onefile-tempdir-spec={CACHE_DIR}/tracelens/{VERSION}``), so the cost
    is paid once per binary version. Extraction is atomic: unpack into a temp
    sibling, then ``os.replace`` onto the final path, so a partially-written tree
    is never observed by a concurrent handoff. Returns ``None`` on failure.
    """
    import tempfile
    import zipfile

    dest = zip_path.with_name("tracelens_src")
    marker = dest / "tracelens" / "__init__.py"
    if marker.is_file():
        return str(dest)
    tmp: str | None = None
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = tempfile.mkdtemp(prefix="tracelens_src.", dir=str(zip_path.parent))
        with zipfile.ZipFile(str(zip_path)) as zf:
            members = zf.infolist()
            if len(members) > _MAX_BUNDLED_SOURCE_FILES:
                raise ValueError(f"bundled source contains too many members ({len(members)})")
            declared_size = sum(info.file_size for info in members)
            if declared_size > _MAX_BUNDLED_SOURCE_BYTES:
                raise ValueError(
                    f"bundled source is too large ({declared_size} uncompressed bytes)"
                )

            root = Path(tmp).resolve()
            written = 0
            for info in members:
                # ZIP uses POSIX separators, but treating backslashes as separators
                # too prevents archives crafted on one OS becoming unsafe on another.
                raw_name = info.filename.replace("\\", "/")
                member = PurePosixPath(raw_name)
                if (
                    not raw_name
                    or raw_name.startswith("/")
                    or member.is_absolute()
                    or ".." in member.parts
                    or (member.parts and member.parts[0].endswith(":"))
                ):
                    raise ValueError(f"unsafe bundled source member: {info.filename!r}")

                mode = info.external_attr >> 16
                file_type = stat.S_IFMT(mode)
                if stat.S_ISLNK(mode) or (file_type not in (0, stat.S_IFREG, stat.S_IFDIR)):
                    raise ValueError(f"unsafe bundled source member type: {info.filename!r}")

                target = root.joinpath(*member.parts)
                try:
                    target.relative_to(root)
                except ValueError:
                    raise ValueError(f"unsafe bundled source member: {info.filename!r}") from None
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue

                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as source, target.open("wb") as output:
                    while chunk := source.read(1024 * 1024):
                        written += len(chunk)
                        if written > _MAX_BUNDLED_SOURCE_BYTES:
                            raise ValueError("bundled source exceeds the uncompressed size limit")
                        output.write(chunk)
        if not (Path(tmp) / "tracelens" / "__init__.py").is_file():
            raise ValueError("bundled source is missing tracelens/__init__.py")
        try:
            os.replace(tmp, str(dest))
            tmp = None
        except OSError:
            # Lost the race (another handoff populated it first) — use theirs.
            if not marker.is_file():
                raise
        return str(dest) if marker.is_file() else None
    except (OSError, EOFError, RuntimeError, ValueError, zipfile.BadZipFile):
        return None
    finally:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)


def _maybe_handoff_to_target_python(argv: list[str], user: list[str]) -> None:
    """Re-exec the run inside the **target service's** Python interpreter.

    Tracelens instruments in-process: it installs the AST import hook + OTel
    instrumenters into the *running* interpreter and then ``runpy``-s the target
    into it. That only works when the target's modules are importable here — true
    for a source ``tracelens`` living in the service's venv, but **false** for a
    frozen binary (sealed interpreter) or any invocation that points at a
    different venv python. In those cases we hand off: re-exec the target's own
    python running ``python -m tracelens run <same args>`` with the tracelens
    source on ``PYTHONPATH``. The child is an ordinary (non-frozen) interpreter
    that already has uvicorn / the app / a matching ABI, so its in-process path
    instruments and runs the service for real.

    Returns normally (no handoff) when the current interpreter can host the
    target itself. ``os.execvpe`` replaces this process on a successful handoff.
    """
    target_py = _external_target_python(user)
    if target_py is None:
        if _is_frozen() and not _is_python_command(user):
            command = user[0] if user else "<missing>"
            raise SystemExit(
                "tracelens run: frozen binaries require an explicit Python target "
                "(for example, '<venv>/bin/python app.py' or "
                f"'<venv>/bin/python -m {command}'). Non-Python commands cannot "
                "load TraceLens instrumentation from the frozen process."
            )
        return  # same interpreter (or not a python target) — serve it in-process.
    src_root = _tracelens_source_root()
    if src_root is None:
        if _is_frozen():
            raise SystemExit(
                "tracelens run: this is a frozen tracelens binary, so it cannot "
                "import the target service's modules "
                f"({' '.join(user[:3])} …) to instrument them in-process. Point "
                "tracelens at its source tree via VINV_TRACELENS_PACKAGE_PATH (or "
                "TRACELENS_SOURCE_ROOT) so the run can hand off into the target's "
                "venv interpreter."
            )
        return  # non-frozen + no source root resolvable: try the in-process path.
    env = dict(os.environ)
    prev = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = src_root + (os.pathsep + prev if prev else "")
    _log_diag_dispatch("handoff")
    _log.info(
        "tracelens: handing off to target interpreter %s (PYTHONPATH+=%s)",
        target_py,
        src_root,
    )
    # Call ``run_main`` directly via ``-c`` rather than routing through the Click
    # CLI: the run subcommand's name is Click-version dependent (``run`` on Click
    # ≥ 8.2, ``run-cmd`` on ≤ 8.1), and the target venv's Click need not match the
    # build interpreter's, so ``-m tracelens.cli run`` can fail with "No such
    # command 'run'". Invoking ``run_main`` skips command-name resolution entirely
    # and is immune to that skew. (We also avoid ``-m tracelens`` because a
    # ``tracelens/__main__.py`` would collide with the Nuitka onefile entry shim.)
    child = "import sys; from tracelens.launcher.run import run_main; " "run_main(sys.argv[1:])"
    if os.name == "nt":
        # os.exec* on Windows builds the child command line by joining argv with
        # spaces WITHOUT quoting, so CreateProcess re-splits the ``-c`` payload
        # at its first space and the child sees ``-c import`` (SyntaxError:
        # "Expected one or more names after 'import'"). Windows also lacks true
        # exec semantics (the parent's waiter sees an early exit). Run the child
        # as a subprocess and mirror its exit code instead.
        import subprocess

        try:
            rc = subprocess.call([target_py, "-c", child, *argv], env=env)
        except OSError as exc:
            raise SystemExit(
                f"tracelens run: failed to launch target interpreter {target_py!r}: {exc}"
            ) from None
        raise SystemExit(rc)
    os.execvpe(target_py, [target_py, "-c", child, *argv], env)
    # execvpe only returns on failure to launch the new image.
    raise SystemExit(f"tracelens run: failed to exec target interpreter {target_py!r}")


def _child_status_to_exit_code(status: int) -> int:
    """Map a ``waitpid`` status to the wrapper's exit code (128+N for signals)."""
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    return 1


def _finalize_trace_output(output: str) -> None:
    """Wrapper-side trace finalization once the child is gone.

    The child owns the JSONL handle and flushes one complete line per event, so
    on a clean exit there is nothing to do. If the child was killed mid-write
    (e.g. SIGKILL landing inside ``write()``), the file can end in a partial
    line — truncate back to the last complete line so every consumer reads the
    file as valid JSONL. Best-effort: never raises.
    """
    try:
        if not output or output == "-":
            return
        path = Path(output)
        if not path.is_file():
            return
        with open(path, "rb+") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            if size == 0:
                return
            fh.seek(size - 1)
            if fh.read(1) == b"\n":
                return
            window = min(size, 1 << 20)
            fh.seek(size - window)
            tail = fh.read(window)
            cut = tail.rfind(b"\n")
            fh.truncate(size - window + cut + 1 if cut >= 0 else 0)
            fh.flush()
            os.fsync(fh.fileno())
    except OSError:
        pass


def _write_summary_if_missing(output: str) -> None:
    """After a signal death the child never ran its shutdown path — produce the
    post-hoc ``<output>.summary.json`` from the wrapper instead (best-effort)."""
    try:
        if not output or output == "-":
            return
        log_path = Path(output)
        if not log_path.is_file() or log_path.stat().st_size == 0:
            return
        if log_path.with_name(log_path.name + ".summary.json").exists():
            return
        _summary_mod.write_summary(log_path)
    except BaseException as exc:  # noqa: BLE001 — supervisor must always exit
        _log.warning("tracelens supervisor summary write failed: %s", exc)


def _supervise_user_command(output: str) -> int | None:
    """Split ``tracelens run`` into a thin wrapper and a supervised child (POSIX).

    Dogfooding fix: tracelens instruments the target IN-PROCESS (runpy/execvp),
    so the CLI process itself used to *become* the traced service — there was no
    supervision at all. When the service (or its workers) died abruptly, the
    front "wrapper" process users saw in ``ps`` sat idle forever, holding the
    trace file open, because nothing reaped, forwarded signals, or exited.

    Fork before any instrumentation happens:

    * CHILD — moves into its own process group and returns ``None``; the caller
      proceeds to install hooks and run the user command exactly as before.
    * PARENT (wrapper) — forwards SIGINT/SIGTERM/SIGHUP to the child's process
      group, reaps the child promptly via a ``waitpid`` loop, sweeps any
      leftover group members, finalizes the trace JSONL (truncating a
      half-written last line) plus the shutdown summary, and returns the exit
      code to mirror: the child's own code, or 128+N for a signal death.

    Skipped (returns ``None`` without forking) on Windows and when
    ``TRACELENS_NO_SUPERVISOR=1``.
    """
    if (
        os.name == "nt"
        or not hasattr(os, "fork")
        or os.environ.get("TRACELENS_NO_SUPERVISOR") == "1"
    ):
        return None
    # Flush inherited stdio so pre-fork buffered bytes aren't emitted twice.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass
    pid = os.fork()
    if pid == 0:
        try:
            os.setpgid(0, 0)
        except OSError:
            pass
        return None
    try:
        # Mirror the child's setpgid so neither side races the other.
        os.setpgid(pid, pid)
    except OSError:
        pass

    def _forward(signum: int, _frame: object | None) -> None:
        try:
            os.killpg(pid, signum)
        except OSError:
            try:
                os.kill(pid, signum)
            except OSError:
                pass

    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        s = getattr(signal, name, None)
        if s is None:
            continue
        try:
            signal.signal(s, _forward)
        except (ValueError, OSError):
            pass

    while True:
        try:
            _wpid, status = os.waitpid(pid, 0)
            break
        except InterruptedError:
            continue  # a forwarded signal interrupted the wait; keep reaping
        except ChildProcessError:
            status = 0  # already reaped elsewhere — nothing left to wait for
            break
    # Sweep leftovers of the child's process group (e.g. encode-pool workers
    # orphaned by a SIGKILL) so nothing of the traced service outlives the run.
    try:
        os.killpg(pid, signal.SIGTERM)
    except OSError:
        pass
    exit_code = _child_status_to_exit_code(status)
    _finalize_trace_output(output)
    if os.WIFSIGNALED(status):
        _write_summary_if_missing(output)
    return exit_code


def _flush_tracer() -> None:
    """Force-flush and shutdown the OTel BatchSpanProcessor. Safe to call multiple times."""
    try:
        from opentelemetry import trace

        provider = trace.get_tracer_provider()
        if hasattr(provider, "force_flush"):
            provider.force_flush(30000)
        if hasattr(provider, "shutdown"):
            provider.shutdown()
    except Exception:
        pass
    # Give the batch processor a moment to fsync before the summary writer reads the file.
    try:
        import time as _t

        _t.sleep(0.25)
    except Exception:
        pass


def _write_run_summary() -> None:
    """T1.4 — produce ``<output>.summary.json`` on shutdown. Best-effort; never crashes."""
    try:
        out = _run_state.get("output_path")
        if not out:
            return
        from tracelens.launcher.import_hook import rewrite_status as _rs
        from tracelens.otel.processor import dropped_events as _de

        log_path = Path(str(out))
        if not log_path.is_file() or log_path.stat().st_size == 0:
            return
        _summary_mod.write_summary(
            log_path,
            coverage_scan=_run_state.get("coverage_scan"),  # type: ignore[arg-type]
            rewrite_status=_rs(),
            instrumenters_loaded=_run_state.get("instrumenters_loaded"),  # type: ignore[arg-type]
            dispatch_token=_run_state.get("dispatch_token"),  # type: ignore[arg-type]
            dropped_events=int(_de()),
        )
    except BaseException as exc:  # noqa: BLE001
        _log.warning("tracelens summary write failed: %s", exc)


def _install_signal_handlers() -> None:
    def _h(signum: int, frame: object | None) -> None:
        _flush_tracer()
        _write_run_summary()
        raise SystemExit(128 + signum)

    # SIGHUP does not exist on Windows — resolve names lazily so the tuple
    # itself can't raise AttributeError there.
    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        s = getattr(signal, name, None)
        if s is None:
            continue
        try:
            signal.signal(s, _h)
        except Exception:
            pass


def _install_hooks() -> None:
    if sys.version_info >= (3, 12):
        try:
            from tracelens.launcher import monitoring_hook

            monitoring_hook.install()
            _log.info("tracelens_hook=monitoring_tool_id_reserved_ast_spans")
            return
        except Exception as exc:
            _log.warning("monitoring hook failed: %s", exc)
    from tracelens.launcher import import_hook

    import_hook.install()
    _log.info("tracelens_hook=ast")


def run_main(argv: list[str] | None = None) -> None:
    if argv is None:
        argv = sys.argv[1:]
    _configure_diag()
    pre, user = _parse_user_command(argv)
    # Before doing any in-process instrumentation, decide whether THIS
    # interpreter can actually host the target. A frozen binary (or a run that
    # points at a different venv python) cannot import the target's modules, so
    # hand the whole run off to the target's own interpreter. On a successful
    # handoff os.execvpe replaces this process and never returns here.
    _maybe_handoff_to_target_python(argv, user)
    (
        output,
        targets,
        sample,
        no_autoinst,
        summary_byte_cap,
        accept_fork_loss,
        memory_enabled,
        capture_determinism,
    ) = _parse_run_flags(pre, user_command=user)
    # Wrapper/child split: the parent becomes a supervisor (reap + signal
    # forwarding + trace finalization) and exits with the child's status; only
    # the child continues past this point to instrument and run the command.
    wrapper_exit = _supervise_user_command(output)
    if wrapper_exit is not None:
        raise SystemExit(wrapper_exit)
    if not targets:
        _log.warning("tracelens run: no --target-package; hook will not instrument app packages")
    _warn_if_multi_process(user, accept_fork_loss)
    otel_setup.apply_env(
        output_path=output,
        target_packages=targets,
        sample_rate=sample,
        user_command=user,
    )
    instrumenters = otel_setup.bootstrap_autoinstrumentation(load_instrumentors=not no_autoinst)
    # Patch ThreadPoolExecutor.submit + loop.run_in_executor so the
    # parent's contextvars (our ``_stack_cv`` *and* OTel ``current_span``)
    # ride along into worker threads. Without this, ``run_in_executor``
    # work shows up as orphan root spans under fresh request_ids and
    # the flame-graph for the calling handler looks two-layer flat.
    executor_ctx_status = _exec_ctx.install()
    _run_state["executor_context_propagation"] = executor_ctx_status
    _install_hooks()
    _install_signal_handlers()

    # Partition targets into import names vs. source-root directories (e.g. a
    # ``--target-package <repo-dir>`` whose real app package has a different import
    # name). Roots are published via env so the import hook can match modules by
    # file origin — without this, directory-style targets scan fine but rewrite
    # nothing, yielding captures with zero symbol-level spans. Runs AFTER the hook
    # install so nothing target-adjacent can be imported pre-hook.
    target_names, target_roots = _targets_mod.split_targets(targets)
    _targets_mod.apply_roots_env(target_roots)

    # Per-function memory attribution flows through the same AST-rewrite wrapper as
    # latency; enabling it just starts tracemalloc so wrap_call can read byte deltas.
    from tracelens.runtime import trace_fn as _trace_fn

    _trace_fn.set_memory_enabled(memory_enabled)
    _run_state["memory_enabled"] = memory_enabled

    if capture_determinism:
        from tracelens.launcher import determinism_capture as _dc

        _dc.install(output)
        _run_state["determinism_captured"] = True

    # T1.3 — pre-import scan of the universe of instrumentable functions.
    coverage = (
        _scan_mod.scan_targets(target_names, roots=target_roots)
        if targets
        else {"packages": [], "modules": {}, "totals": {}}
    )
    coverage_totals = coverage.get("totals")
    if not isinstance(coverage_totals, dict):
        coverage_totals = {}
    if targets:
        _log.info(
            "tracelens: target packages %s — %s public functions in %s modules (scan)",
            targets,
            coverage_totals.get("public_functions", 0),
            coverage_totals.get("modules", 0),
        )

    # T1.3 — optional re-import of pre-loaded target modules (off by default).
    reload_status = _scan_mod.reload_target_modules(targets) if targets else {}

    # Persist run state for the shutdown summary writer.
    _run_state.update(
        {
            "output_path": output,
            "instrumenters_loaded": instrumenters,
            "coverage_scan": coverage,
            "reload_status": reload_status,
            "targets": targets,
            "sample_rate": sample,
        }
    )

    try:
        script = _is_simple_python_script(user)
        if script is not None:
            _log_diag_dispatch("runpy")
            _run_state["dispatch_token"] = "runpy"
            root = str(script.parent)
            if root not in sys.path:
                sys.path.insert(0, root)
            sys.argv = [str(script)] + user[2:]
            runpy.run_path(str(script), run_name="__main__")
            _flush_tracer()
            _write_run_summary()
            return

        mod_tail = _python_m_module(user)
        if mod_tail is not None:
            mod, tail = mod_tail
            _log_diag_dispatch("runpy")
            _run_state["dispatch_token"] = "runpy"
            sys.argv = [mod, *tail]
            runpy.run_module(mod, run_name="__main__", alter_sys=True)
            _flush_tracer()
            _write_run_summary()
            return

        _log_diag_dispatch("execvp")
        _run_state["dispatch_token"] = "execvp"
        warning = (
            "external command dispatch uses degraded instrumentation; TraceLens "
            "in-process AST coverage and shutdown summary may be incomplete. "
            "Prefer an explicit Python script or 'python -m module' command."
        )
        _log.warning("tracelens: %s", warning)
        print(f"\033[33m[tracelens] warning: {warning}\033[0m", file=sys.stderr)
        oi = shutil.which("opentelemetry-instrument")
        if not oi:
            raise SystemExit(
                "tracelens run: opentelemetry-instrument not on PATH; use a python script path"
            )
        if os.name == "nt":
            # Same Windows os.exec* quoting/semantics hazard as the handoff above.
            import subprocess

            raise SystemExit(subprocess.call([oi, *user]))
        os.execvp(oi, [oi, *user])
    except BaseException:
        # On any path that doesn't go through the signal handler, still try to leave a summary.
        _flush_tracer()
        _write_run_summary()
        raise


if __name__ == "__main__":
    run_main()
