"""
File Management Tools — Universal file system access for ALL actors
===================================================================

Provides safe, structured file operations that any actor can use during
task execution. Actors can save, read, list, copy, move, and manage files
without relying on terminal commands.

DESIGN PRINCIPLES:
- All paths are resolved and confined to an authorized workspace root
- Default workspace is ~/vinv_engine_shared (shared across actors)
- External absolute paths require an explicit operator-controlled override
- No hardcoded filenames — all params are dynamic
- Synchronous interface (DSPy ReAct expects sync tools)
- File operations are logged for audit trail
"""

import os
import json
import shutil
import hashlib
import logging
import tempfile
import time as _time
from pathlib import Path
from typing import Dict, Any, List, Optional

from core.components.bootstrap.paths import DEFAULT_VINV_ENGINE_SHARED_DIR
from core.components.project_context import get_project_root

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# File-read deduplication cache
# ---------------------------------------------------------------------------
# When an agent reads the same file twice and the file hasn't changed on disk
# (same mtime + size), return a lightweight stub instead of the full content.
# This prevents redundant multi-KB payloads from inflating trajectory context,
# especially during browser/desktop retry loops.
#
# Disable: VINV_ENGINE_FILE_DEDUP_ENABLED=0
# Max entries: VINV_ENGINE_FILE_DEDUP_MAX_ENTRIES (default 256)

_FILE_DEDUP_ENABLED = os.environ.get("VINV_ENGINE_FILE_DEDUP_ENABLED", "1") == "1"
_FILE_DEDUP_MAX_ENTRIES = int(os.environ.get("VINV_ENGINE_FILE_DEDUP_MAX_ENTRIES", "256"))


class _FileReadDedupCache:
    """Thread-safe cache that detects unchanged file re-reads.

    Tracks ``(resolved_path) → (mtime, size, content_hash)`` for every
    successful ``read_file`` call.  On a subsequent read, if *mtime* and
    *size* still match the cached entry the file hasn't changed — return
    a stub instead of the full content.
    """

    _STUB_TEMPLATE = (
        "File unchanged since last read (mtime & size identical). "
        "The full content from the earlier read_file result in this "
        "execution is still current — refer to that instead of re-reading.\n"
        "  path: {path}\n"
        "  size_bytes: {size}\n"
        "  content_hash: {hash}"
    )

    def __init__(self, *, max_entries: int = _FILE_DEDUP_MAX_ENTRIES) -> None:
        import threading
        self._lock = threading.Lock()
        self._max = max_entries
        # resolved_path → (mtime: float, size: int, sha256_hex: str)
        self._entries: dict[str, tuple[float, int, str]] = {}

    # ------------------------------------------------------------------
    def check(self, resolved_path: str) -> Optional[Dict[str, Any]]:
        """Return a stub result dict if the file is unchanged, else *None*."""
        if not _FILE_DEDUP_ENABLED:
            return None
        try:
            stat = os.stat(resolved_path)
        except OSError:
            return None
        mtime, size = stat.st_mtime, stat.st_size
        with self._lock:
            prev = self._entries.get(resolved_path)
        if prev is None:
            return None
        prev_mtime, prev_size, prev_hash = prev
        if mtime == prev_mtime and size == prev_size:
            logger.debug("file_dedup: stub for %s (hash=%s)", resolved_path, prev_hash)
            return {
                "status": "success",
                "content": self._STUB_TEMPLATE.format(
                    path=resolved_path, size=prev_size, hash=prev_hash,
                ),
                "file_path": resolved_path,
                "size_bytes": prev_size,
                "truncated": False,
                "_dedup_stub": True,
            }
        return None

    # ------------------------------------------------------------------
    def record(self, resolved_path: str, content: str) -> None:
        """Record a fresh read so future identical reads can be stubbed."""
        if not _FILE_DEDUP_ENABLED:
            return
        try:
            stat = os.stat(resolved_path)
        except OSError:
            return
        content_hash = hashlib.sha256(content.encode("utf-8", errors="replace")).hexdigest()
        with self._lock:
            self._entries[resolved_path] = (stat.st_mtime, stat.st_size, content_hash)
            if len(self._entries) > self._max:
                oldest_key = next(iter(self._entries))
                del self._entries[oldest_key]

    # ------------------------------------------------------------------
    def invalidate(self, resolved_path: str) -> None:
        """Remove a path from the cache (called after writes)."""
        with self._lock:
            self._entries.pop(resolved_path, None)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


_file_dedup_cache = _FileReadDedupCache()

# Directory name segments to omit when listing/searching (keeps ReAct context small; aligns with the code-index skips).
_LIST_FILES_SKIP_DIR_NAMES: frozenset[str] = frozenset(
    {
        "node_modules",
        ".git",
        "__pycache__",
        ".tox",
        ".mypy_cache",
        ".pytest_cache",
        "venv",
        ".venv",
        "env",
        "dist",
        "build",
        ".eggs",
        ".cursor",
        ".ruff_cache",
        ".coverage",
        "htmlcov",
        "coverage",
        ".nox",
        "site-packages",
        ".next",
        ".nuxt",
        ".svelte-kit",
        "bower_components",
        ".cache",
        ".parcel-cache",
        ".turbo",
        ".idea",
        ".vscode",
        "vendor",
        "target",
        ".terraform",
        ".angular",
        ".gradle",
        ".sass-cache",
    }
)
_LIST_FILES_SKIP_DIR_SUFFIXES: tuple[str, ...] = (".egg-info",)

SHARED_WORKSPACE = os.environ.get("VINV_ENGINE_SHARED_DIR", DEFAULT_VINV_ENGINE_SHARED_DIR)
SHARED_FILES = os.path.join(SHARED_WORKSPACE, "code_projects")
SHARED_RESEARCH = os.path.join(SHARED_WORKSPACE, "research_projects")
SHARED_SCREENSHOTS = os.path.join(SHARED_WORKSPACE, "screenshots")
VINV_ENGINE_ROOT = Path(__file__).resolve().parent.parent.parent

_FILE_REGISTRY_PATH = os.path.join(SHARED_WORKSPACE, ".file_registry.json")
import threading as _threading
_file_registry_lock = _threading.Lock()

_live_file_events: list[dict] = []
_live_file_events_lock = _threading.Lock()


def drain_live_file_events() -> list[dict]:
    """Return and clear all file-creation events since the last drain.

    Called by the hero layer to discover files created during execution
    and publish them to SharedContext for downstream soft-dependencies.
    """
    with _live_file_events_lock:
        events = list(_live_file_events)
        _live_file_events.clear()
    logger.debug("drain_live_file_events: returning %d events", len(events))
    return events


def _ensure_dirs():
    """Ensure shared workspace directories exist."""
    for d in (SHARED_WORKSPACE, SHARED_FILES, SHARED_SCREENSHOTS):
        Path(d).mkdir(parents=True, exist_ok=True)


def _path_is_under_list_files_skip(path: Path, root: Path) -> bool:
    """True if *path* is inside *root* and any directory component is ignored (e.g. node_modules)."""
    try:
        rel = path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    for part in rel.parts:
        if part in _LIST_FILES_SKIP_DIR_NAMES:
            return True
        if any(part.endswith(sfx) for sfx in _LIST_FILES_SKIP_DIR_SUFFIXES):
            return True
    return False


def _is_writable_target(candidate: Path) -> bool:
    """Return True if candidate (or its nearest existing parent) is writable."""
    probe = candidate if candidate.exists() else candidate.parent
    try:
        while not probe.exists() and probe.parent != probe:
            probe = probe.parent
        return os.access(str(probe), os.W_OK)
    except Exception:
        return False


def _external_paths_enabled() -> bool:
    return os.environ.get("VINV_ENGINE_ALLOW_EXTERNAL_PATHS", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _allowed_path_roots() -> list[Path]:
    project_root = get_project_root()
    roots = [
        project_root if project_root else Path.cwd(),
        Path(SHARED_WORKSPACE),
        Path("/tmp/outputs"),
    ]
    resolved: list[Path] = []
    for root in roots:
        candidate = root.expanduser().resolve()
        if candidate not in resolved:
            resolved.append(candidate)
    return resolved


def _confine_path(candidate: Path) -> Path:
    """Resolve symlinks and reject paths outside the configured authority roots."""
    resolved = candidate.expanduser().resolve()
    if _external_paths_enabled():
        return resolved
    for root in _allowed_path_roots():
        try:
            resolved.relative_to(root)
            return resolved
        except ValueError:
            continue
    allowed = ", ".join(str(root) for root in _allowed_path_roots())
    raise PermissionError(f"Path is outside authorized roots ({allowed}): {resolved}")


def confine_path(candidate: Path) -> Path:
    """Public confinement hook for other tool modules (code editor, etc.)."""
    return _confine_path(candidate)


def _resolve_path(path: str, *, for_write: bool = False) -> str:
    """
    Resolve path robustly.
    - Absolute and ~ paths must remain inside an authorized root.
    - Relative paths are searched against the project and shared roots.
    - For unresolved relative paths (typically new writes), fallback is the
      shared workspace so packaged apps never try to write inside app bundles.
    """
    expanded = Path(path).expanduser()
    if expanded.is_absolute():
        return str(_confine_path(expanded))

    project_root = get_project_root()
    shared_candidate = Path(SHARED_WORKSPACE) / expanded

    if for_write:
        write_candidates = [shared_candidate]
        if project_root:
            write_candidates.insert(0, project_root / expanded)
        else:
            write_candidates.insert(0, Path.cwd() / expanded)
        for candidate in write_candidates:
            confined = _confine_path(candidate)
            if _is_writable_target(confined):
                return str(confined)
        return str(_confine_path(shared_candidate))

    candidates = [shared_candidate]
    if project_root:
        candidates.insert(0, project_root / expanded)
    else:
        candidates.insert(0, Path.cwd() / expanded)
    for candidate in candidates:
        confined = _confine_path(candidate)
        if confined.exists():
            return str(confined)
    return str(_confine_path(shared_candidate))


def _register_file(file_path: str, size_bytes: int) -> None:
    """Append a file entry to the shared file registry so other agents can discover it."""
    import time as _time
    entry = {
        "file_path": file_path,
        "size_bytes": size_bytes,
        "timestamp": _time.time(),
    }
    try:
        with _file_registry_lock:
            _ensure_dirs()
            existing: list = []
            if os.path.exists(_FILE_REGISTRY_PATH):
                with open(_FILE_REGISTRY_PATH, "r") as f:
                    existing = json.load(f)
            existing.append(entry)
            with open(_FILE_REGISTRY_PATH, "w") as f:
                json.dump(existing, f, default=str)
    except Exception as exc:
        logger.debug(f"File registry update failed (non-fatal): {exc}")


def get_recent_files(since_ts: float = 0.0) -> List[Dict[str, Any]]:
    """Return file registry entries created after *since_ts* (epoch seconds).

    Also scans the shared workspace for files created after since_ts that
    may have been created via terminal commands (bypassing save_file).
    """
    entries: List[Dict[str, Any]] = []
    registered_paths: set = set()
    try:
        with _file_registry_lock:
            if os.path.exists(_FILE_REGISTRY_PATH):
                with open(_FILE_REGISTRY_PATH, "r") as f:
                    entries = json.load(f)
        if since_ts:
            entries = [e for e in entries if e.get("timestamp", 0) > since_ts]
        registered_paths = {e.get("file_path", "") for e in entries}
    except Exception:
        pass

    # Scan shared workspace for files not in the registry (terminal-created).
    if since_ts > 0:
        try:
            for scan_dir in (SHARED_WORKSPACE, "/tmp/outputs"):
                if not os.path.isdir(scan_dir):
                    continue
                for root, _dirs, files in os.walk(scan_dir):
                    for fname in files:
                        if fname.startswith("."):
                            continue
                        fpath = os.path.join(root, fname)
                        if fpath in registered_paths:
                            continue
                        try:
                            stat = os.stat(fpath)
                            if stat.st_mtime >= since_ts:
                                entries.append({
                                    "file_path": fpath,
                                    "size_bytes": stat.st_size,
                                    "timestamp": stat.st_mtime,
                                })
                        except OSError:
                            pass
        except Exception:
            pass

    return entries


def workspace_project_roots_from_recent_files(
    since_ts: float = 0.0,
    *,
    max_roots: int | None = None,
) -> List[str]:
    """Map recent file paths to unique project roots under the shared workspace.

    Instead of listing every file (which can be millions of characters), returns
    at most *max_roots* paths, each either a project directory or a file sitting
    directly under ``SHARED_WORKSPACE``.

    Rules (paths must resolve under ``SHARED_WORKSPACE``, except ``/tmp/outputs``):

    - ``.../code_projects/<project>/...`` → ``.../code_projects/<project>``
    - ``.../research_projects/<project>/...`` → ``.../research_projects/<project>``
    - Any other path under the shared root uses the first path segment only
      (directory or file at workspace top level).

    *max_roots* defaults to ``VINV_ENGINE_WORKSPACE_FILES_MAX_ROOTS`` (default ``50``).

    Paths outside the shared workspace (except under ``/tmp/outputs``) are
    ignored so registry noise does not bloat the payload.
    """
    if max_roots is None:
        max_roots = int(os.environ.get("VINV_ENGINE_WORKSPACE_FILES_MAX_ROOTS", "50"))
    max_roots = max(1, min(max_roots, 500))

    shared_resolved = str(Path(SHARED_WORKSPACE).resolve())
    tmp_outputs = "/tmp/outputs"

    recent = get_recent_files(since_ts=since_ts)
    roots: set[str] = set()

    def _root_for(path: str) -> str | None:
        try:
            rp = str(Path(path).resolve())
        except OSError:
            return None
        try:
            if rp.startswith(shared_resolved + os.sep) or rp == shared_resolved:
                rel = os.path.relpath(rp, shared_resolved)
                parts = rel.split(os.sep)
                if not parts or parts[0] == ".":
                    return shared_resolved
                bucket = parts[0]
                if bucket in ("code_projects", "research_projects") and len(parts) >= 2:
                    return os.path.join(shared_resolved, bucket, parts[1])
                return os.path.join(shared_resolved, parts[0])
        except ValueError:
            return None
        if rp.startswith(tmp_outputs + os.sep) or rp == tmp_outputs:
            return tmp_outputs
        return None

    for entry in recent:
        fp = entry.get("file_path") if isinstance(entry, dict) else None
        if not fp or not isinstance(fp, str):
            continue
        root = _root_for(fp)
        if root:
            roots.add(root)

    ordered = sorted(roots)
    return ordered[:max_roots]


def save_file(
    content: str,
    file_path: str,
    encoding: str = "utf-8",
) -> Dict[str, Any]:
    """
    Save text content to a file. Creates parent directories automatically.

    Args:
        content: Text content to write
        file_path: Where to save (absolute or relative to shared workspace)
        encoding: File encoding (default: utf-8)

    Returns:
        {"status": "success"|"error", "file_path": "...", "size_bytes": N}
    """
    try:
        _ensure_dirs()
        resolved = _resolve_path(file_path, for_write=True)
        Path(resolved).parent.mkdir(parents=True, exist_ok=True)
        with open(resolved, "w", encoding=encoding) as f:
            f.write(content)
        size = os.path.getsize(resolved)
        _file_dedup_cache.invalidate(resolved)
        logger.info(f"📝 [FILE] Saved {size} bytes to {resolved}")
        _register_file(resolved, size)
        with _live_file_events_lock:
            _live_file_events.append({
                "file_path": resolved,
                "size_bytes": size,
                "timestamp": _time.time(),
            })
        return {"status": "success", "file_path": resolved, "size_bytes": size}
    except Exception as e:
        logger.error(f"❌ [FILE] Save failed: {e}")
        return {"status": "error", "error": str(e), "file_path": file_path}


def save_binary_file(
    data: bytes,
    file_path: str,
) -> Dict[str, Any]:
    """
    Save binary data to a file. Creates parent directories automatically.

    Args:
        data: Binary content to write
        file_path: Where to save

    Returns:
        {"status": "success"|"error", "file_path": "...", "size_bytes": N}
    """
    try:
        _ensure_dirs()
        resolved = _resolve_path(file_path, for_write=True)
        Path(resolved).parent.mkdir(parents=True, exist_ok=True)
        with open(resolved, "wb") as f:
            f.write(data)
        size = os.path.getsize(resolved)
        _file_dedup_cache.invalidate(resolved)
        logger.info(f"📝 [FILE] Saved binary {size} bytes to {resolved}")
        return {"status": "success", "file_path": resolved, "size_bytes": size}
    except Exception as e:
        logger.error(f"❌ [FILE] Binary save failed: {e}")
        return {"status": "error", "error": str(e), "file_path": file_path}


def read_file(
    file_path: str,
    encoding: str = "utf-8",
    max_chars: int = 0,
) -> Dict[str, Any]:
    """
    Read text content from a file.

    Reads the full file by default. Context sizing is handled downstream
    by the compression pipeline, not by truncating file reads.

    If the same file is read again and hasn't changed on disk (mtime + size
    match), a lightweight stub is returned instead of the full content.  This
    saves context tokens during retry-heavy workflows (browser, desktop).
    Disable via ``VINV_ENGINE_FILE_DEDUP_ENABLED=0``.

    Args:
        file_path: Path to read
        encoding: File encoding (default: utf-8)
        max_chars: Ignored (kept for API compatibility). Full file is always read.

    Returns:
        {"status": "success"|"error", "content": "...", "size_bytes": N, "truncated": bool}
    """
    try:
        resolved = _resolve_path(file_path)
        if not os.path.exists(resolved):
            logger.debug("read_file: file not found: %s", resolved)
            return {"status": "error", "error": f"File not found: {resolved}"}

        stub = _file_dedup_cache.check(resolved)
        if stub is not None:
            return stub

        size = os.path.getsize(resolved)
        with open(resolved, "r", encoding=encoding) as f:
            content = f.read()
        logger.debug("read_file: path=%s size=%d", resolved, size)

        _file_dedup_cache.record(resolved, content)

        return {
            "status": "success",
            "content": content,
            "file_path": resolved,
            "size_bytes": size,
            "truncated": False,
        }
    except Exception as e:
        logger.error("read_file failed: path=%s error=%s", file_path, e)
        return {"status": "error", "error": str(e), "file_path": file_path}


def list_files(
    directory: str = SHARED_FILES,
    pattern: str = "*",
    recursive: bool = False,
) -> Dict[str, Any]:
    """
    List files in a directory.

    Paths under ignored directories (e.g. node_modules, .git, venv, dist, build,
    __pycache__, .next, vendor) are excluded so recursive listings do not bloat
    downstream LLM context.

    Args:
        directory: Directory to list (default: shared workspace)
        pattern: Glob pattern to filter (e.g. "*.png", "*.csv")
        recursive: Whether to search subdirectories

    Returns:
        {"status": "success"|"error", "files": [...], "count": N}
    """
    try:
        resolved = Path(_resolve_path(directory))
        if not resolved.exists():
            return {"status": "success", "files": [], "count": 0,
                    "message": f"Directory does not exist: {resolved}"}
        if recursive:
            matches = list(resolved.rglob(pattern))
        else:
            matches = list(resolved.glob(pattern))
        files = []
        for p in sorted(matches):
            if not p.is_file():
                continue
            if _path_is_under_list_files_skip(p, resolved):
                continue
            files.append({
                "path": str(p),
                "name": p.name,
                "size_bytes": p.stat().st_size,
                "modified": p.stat().st_mtime,
            })
        logger.debug("list_files: dir=%s count=%d", resolved, len(files))
        return {"status": "success", "files": files, "count": len(files),
                "directory": str(resolved)}
    except Exception as e:
        logger.error("list_files failed: %s", e)
        return {"status": "error", "error": str(e)}


def find_files(
    query: str,
    root_directory: str = ".",
    max_results: int = 200,
) -> Dict[str, Any]:
    """
    Search for files by partial name from a root directory.
    Useful when actors know a filename hint but not full path.

    Skips the same dependency/build directories as list_files (node_modules, .git, etc.).
    """
    try:
        root = Path(_resolve_path(root_directory))
        if not root.exists():
            return {"status": "error", "error": f"Root directory not found: {root}"}

        q = (query or "").strip().lower()
        if not q:
            return {"status": "error", "error": "query cannot be empty"}

        matches: List[Dict[str, Any]] = []
        for p in root.rglob("*"):
            if not p.is_file():
                continue
            if _path_is_under_list_files_skip(p, root):
                continue
            if q in p.name.lower() or q in str(p).lower():
                try:
                    st = p.stat()
                    matches.append({
                        "path": str(p.resolve()),
                        "name": p.name,
                        "size_bytes": st.st_size,
                        "modified": st.st_mtime,
                    })
                except Exception:
                    continue
            if len(matches) >= max_results:
                break

        return {
            "status": "success",
            "query": q,
            "root_directory": str(root.resolve()),
            "count": len(matches),
            "files": matches,
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


def make_directory(directory_path: str) -> Dict[str, Any]:
    """Create a directory recursively and return its absolute path."""
    try:
        resolved = Path(_resolve_path(directory_path, for_write=True))
        resolved.mkdir(parents=True, exist_ok=True)
        logger.info("Created directory: %s", resolved)
        return {"status": "success", "directory": str(resolved)}
    except Exception as e:
        logger.error("make_directory failed: path=%s error=%s", directory_path, e)
        return {"status": "error", "error": str(e)}


def copy_file(
    source: str,
    destination: str,
) -> Dict[str, Any]:
    """
    Copy a file from source to destination.

    Args:
        source: Source file path
        destination: Destination file path

    Returns:
        {"status": "success"|"error", "source": "...", "destination": "...", "size_bytes": N}
    """
    try:
        src = _resolve_path(source)
        dst = _resolve_path(destination, for_write=True)
        if not os.path.exists(src):
            return {"status": "error", "error": f"Source not found: {src}"}
        Path(dst).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        size = os.path.getsize(dst)
        _file_dedup_cache.invalidate(dst)
        logger.info(f"📋 [FILE] Copied {src} → {dst} ({size} bytes)")
        return {"status": "success", "source": src, "destination": dst, "size_bytes": size}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def move_file(
    source: str,
    destination: str,
) -> Dict[str, Any]:
    """
    Move a file from source to destination.

    Args:
        source: Source file path
        destination: Destination file path

    Returns:
        {"status": "success"|"error", "source": "...", "destination": "..."}
    """
    try:
        src = _resolve_path(source)
        dst = _resolve_path(destination, for_write=True)
        if not os.path.exists(src):
            return {"status": "error", "error": f"Source not found: {src}"}
        Path(dst).parent.mkdir(parents=True, exist_ok=True)
        shutil.move(src, dst)
        _file_dedup_cache.invalidate(src)
        _file_dedup_cache.invalidate(dst)
        logger.info(f"📦 [FILE] Moved {src} → {dst}")
        return {"status": "success", "source": src, "destination": dst}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def delete_file(
    file_path: str,
) -> Dict[str, Any]:
    """
    Delete a file.

    Args:
        file_path: Path to the file to delete

    Returns:
        {"status": "success"|"error", "file_path": "..."}
    """
    try:
        resolved = _resolve_path(file_path, for_write=True)
        if not os.path.exists(resolved):
            return {"status": "success", "message": "File already does not exist",
                    "file_path": resolved}
        os.remove(resolved)
        _file_dedup_cache.invalidate(resolved)
        logger.info(f"🗑️ [FILE] Deleted {resolved}")
        return {"status": "success", "file_path": resolved}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def file_exists(
    file_path: str,
) -> Dict[str, Any]:
    """
    Check if a file exists and return its metadata.

    Args:
        file_path: Path to check

    Returns:
        {"exists": bool, "file_path": "...", "size_bytes": N, "type": "file"|"directory"}
    """
    resolved = _resolve_path(file_path)
    p = Path(resolved)
    if p.exists():
        stat = p.stat()
        return {
            "exists": True,
            "file_path": resolved,
            "size_bytes": stat.st_size,
            "type": "directory" if p.is_dir() else "file",
            "modified": stat.st_mtime,
        }
    return {"exists": False, "file_path": resolved}


def get_file_hash(
    file_path: str,
    algorithm: str = "sha256",
) -> Dict[str, Any]:
    """
    Get the hash of a file for integrity verification.

    Args:
        file_path: Path to the file
        algorithm: Hash algorithm (sha256, md5)

    Returns:
        {"status": "success"|"error", "hash": "...", "algorithm": "..."}
    """
    try:
        resolved = _resolve_path(file_path)
        if not os.path.exists(resolved):
            return {"status": "error", "error": f"File not found: {resolved}"}
        h = hashlib.new(algorithm)
        with open(resolved, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        return {"status": "success", "hash": h.hexdigest(), "algorithm": algorithm,
                "file_path": resolved}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def create_temp_file(
    content: str = "",
    suffix: str = ".txt",
    prefix: str = "vinv_engine_",
) -> Dict[str, Any]:
    """
    Create a temporary file in the shared workspace.

    Args:
        content: Initial text content
        suffix: File extension
        prefix: File name prefix

    Returns:
        {"status": "success"|"error", "file_path": "..."}
    """
    try:
        _ensure_dirs()
        fd, path = tempfile.mkstemp(suffix=suffix, prefix=prefix, dir=SHARED_FILES)
        if content:
            with os.fdopen(fd, "w") as f:
                f.write(content)
        else:
            os.close(fd)
        logger.info(f"📄 [FILE] Created temp file: {path}")
        return {"status": "success", "file_path": path}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def read_file_chunked(
    file_path: str,
    offset_lines: int = 0,
    num_lines: int = 200,
    encoding: str = "utf-8",
) -> Dict[str, Any]:
    """Read a specific range of lines from a file.

    Enables iterative processing of large files by reading in chunks.
    Call repeatedly with increasing offset_lines to walk through the file.

    Args:
        file_path: Path to read
        offset_lines: Number of lines to skip from the start (0-based)
        num_lines: Number of lines to read from the offset
        encoding: File encoding (default: utf-8)

    Returns:
        {"status", "lines", "offset_lines", "num_lines", "total_lines",
         "has_more", "file_path"}
    """
    import itertools

    try:
        resolved = _resolve_path(file_path)
        if not os.path.exists(resolved):
            return {"status": "error", "error": f"File not found: {resolved}"}

        # Lightweight line count without loading file into memory
        total = 0
        with open(resolved, "r", encoding=encoding) as f:
            for _ in f:
                total += 1

        # Stream to the requested slice without materialising the whole file
        with open(resolved, "r", encoding=encoding) as f:
            # Skip lines before offset
            for _ in itertools.islice(f, offset_lines):
                pass
            chunk = list(itertools.islice(f, num_lines))
            # Peek one more line to determine has_more
            has_more = next(f, None) is not None

        return {
            "status": "success",
            "lines": "".join(chunk),
            "offset_lines": offset_lines,
            "num_lines": len(chunk),
            "total_lines": total,
            "has_more": has_more,
            "file_path": resolved,
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


def _detect_json_structure(path: str, encoding: str = "utf-8") -> Dict[str, Any]:
    """Inspect the first portion of a JSON file to determine its shape."""
    result: Dict[str, Any] = {"type": "json"}
    try:
        # Read only the first 8KB to avoid loading huge files
        with open(path, "r", encoding=encoding) as f:
            head = f.read(8192)
        parsed = json.loads(head if len(head) < 8192 else _complete_json_fragment(head))
        if isinstance(parsed, list):
            result["shape"] = "array"
            result["length"] = len(parsed)
            if parsed and isinstance(parsed[0], dict):
                result["item_keys"] = list(parsed[0].keys())
        elif isinstance(parsed, dict):
            result["shape"] = "object"
            result["top_level_keys"] = list(parsed.keys())
    except json.JSONDecodeError:
        # File is too large to parse from a fragment; report what we can
        stripped = head.lstrip()
        if stripped.startswith("["):
            result["shape"] = "array (partial parse failed)"
        elif stripped.startswith("{"):
            result["shape"] = "object (partial parse failed)"
        else:
            result["shape"] = "unknown"
    except Exception:
        result["shape"] = "parse_error"
    return result


def _complete_json_fragment(fragment: str) -> str:
    """Best-effort closure of a truncated JSON fragment for partial parsing."""
    depth_brace = fragment.count("{") - fragment.count("}")
    depth_bracket = fragment.count("[") - fragment.count("]")
    return fragment + ("}" * max(depth_brace, 0)) + ("]" * max(depth_bracket, 0))


def _detect_markdown_structure(
    sample_lines: list[str], total_lines: int,
) -> Dict[str, Any]:
    """Count structural elements from sampled lines and estimate totals."""
    headings = 0
    links = 0
    code_fences = 0
    for line in sample_lines:
        stripped = line.lstrip()
        if stripped.startswith("#"):
            headings += 1
        if "](http" in line or "](/" in line:
            links += line.count("](")
        if stripped.startswith("```"):
            code_fences += 1

    sampled = len(sample_lines)
    scale = total_lines / max(sampled, 1) if sampled else 1.0
    return {
        "type": "markdown",
        "estimated_headings": int(headings * scale),
        "estimated_links": int(links * scale),
        "estimated_code_blocks": int(code_fences * scale // 2),
    }


def file_stats(
    file_path: str,
    encoding: str = "utf-8",
) -> Dict[str, Any]:
    """Get file statistics without loading the full content.

    For CSV/TSV files, also returns column headers, row count, and a sample
    of the first few rows. This lets agents reason about the file structure
    and plan a strategy before loading data.

    Args:
        file_path: Path to inspect
        encoding: File encoding (default: utf-8)

    Returns:
        {"status", "file_path", "size_bytes", "line_count",
         "is_tabular", "columns", "data_rows", "sample_rows"}
    """
    try:
        resolved = _resolve_path(file_path)
        if not os.path.exists(resolved):
            return {"status": "error", "error": f"File not found: {resolved}"}
        size = os.path.getsize(resolved)
        line_count = 0
        sample: list[str] = []
        header_line = ""
        with open(resolved, "r", encoding=encoding) as f:
            for i, line in enumerate(f):
                line_count += 1
                if i == 0:
                    header_line = line.rstrip("\n\r")
                if i < 6:
                    sample.append(line.rstrip("\n\r"))

        ext = os.path.splitext(resolved)[1].lower()
        is_tabular = ext in (".csv", ".tsv", ".tab")
        columns: list[str] = []
        data_rows = 0
        if is_tabular and header_line:
            sep = "\t" if ext in (".tsv", ".tab") else ","
            columns = [c.strip().strip('"') for c in header_line.split(sep)]
            data_rows = max(0, line_count - 1)

        # Detect structure for non-tabular formats so agents can reason
        # about content without loading the full file.
        format_hint: dict[str, Any] = {}
        format_hint["extension"] = ext
        if ext == ".json":
            format_hint.update(_detect_json_structure(resolved, encoding))
        elif ext in (".md", ".markdown"):
            format_hint.update(_detect_markdown_structure(sample, line_count))
        elif ext in (".docx", ".xlsx", ".pptx", ".pdf"):
            format_hint["binary"] = True
            reader_map = {
                ".docx": "read_docx_to_markdown(path)",
                ".xlsx": "read_xlsx_to_markdown(path)",
            }
            if ext in reader_map:
                format_hint["dedicated_reader"] = reader_map[ext]
            else:
                format_hint["note"] = "No structured reader; use file path directly."

        return {
            "status": "success",
            "file_path": resolved,
            "size_bytes": size,
            "line_count": line_count,
            "is_tabular": is_tabular,
            "columns": columns,
            "data_rows": data_rows,
            "sample_rows": sample,
            "format_hint": format_hint,
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


def append_to_file(
    file_path: str,
    content: str,
    encoding: str = "utf-8",
) -> Dict[str, Any]:
    """Append content to the end of a file, creating it if it does not exist.

    Enables iterative writing of large documents that exceed context length.

    Args:
        file_path: Path to append to
        content: Text content to append
        encoding: File encoding (default: utf-8)

    Returns:
        {"status", "file_path", "appended_bytes", "total_size_bytes"}
    """
    try:
        resolved = _resolve_path(file_path, for_write=True)
        Path(resolved).parent.mkdir(parents=True, exist_ok=True)
        with open(resolved, "a", encoding=encoding) as f:
            f.write(content)
        total_size = os.path.getsize(resolved)
        _file_dedup_cache.invalidate(resolved)
        return {
            "status": "success",
            "file_path": resolved,
            "appended_bytes": len(content.encode(encoding)),
            "total_size_bytes": total_size,
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


# =============================================================================
# EXPORTED TOOLS (for agent tool injection)
# =============================================================================

FILE_MANAGEMENT_TOOLS = [
    save_file,
    save_binary_file,
    read_file,
    read_file_chunked,
    file_stats,
    append_to_file,
    list_files,
    find_files,
    make_directory,
    copy_file,
    move_file,
    delete_file,
    file_exists,
    get_file_hash,
    create_temp_file,
]

_PROJECT_INDEX_PATH = os.path.join(SHARED_WORKSPACE, "project_index.md")


def search_project_index(query: str) -> Dict[str, Any]:
    """Search the project index for projects matching a query.

    The project index is a markdown file maintained by the system that
    catalogues known projects with their paths, descriptions, and key files.

    Args:
        query: Search term (project name, technology, or description fragment)

    Returns:
        {"status": "success"|"error", "matches": [...], "count": N}
    """
    try:
        idx_path = Path(_PROJECT_INDEX_PATH)
        if not idx_path.exists():
            return {
                "status": "success",
                "matches": [],
                "count": 0,
                "message": "No project index exists yet. Projects will be indexed as they are created.",
            }
        content = idx_path.read_text(encoding="utf-8")
        query_lower = query.lower()
        matches: list[dict[str, str]] = []
        current_project: dict[str, str] = {}
        for line in content.split("\n"):
            if line.startswith("## "):
                if current_project and query_lower in json.dumps(current_project).lower():
                    matches.append(current_project)
                current_project = {"name": line[3:].strip()}
            elif line.startswith("- **Path**: "):
                current_project["path"] = line.split("**: ", 1)[-1].strip()
            elif line.startswith("- **Description**: "):
                current_project["description"] = line.split("**: ", 1)[-1].strip()
            elif line.startswith("- **Key files**: "):
                current_project["key_files"] = line.split("**: ", 1)[-1].strip()
            elif line.startswith("- **Last modified**: "):
                current_project["last_modified"] = line.split("**: ", 1)[-1].strip()
        if current_project and query_lower in json.dumps(current_project).lower():
            matches.append(current_project)
        return {"status": "success", "matches": matches, "count": len(matches)}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def _get_project_discovery_markers() -> set[str]:
    """Load project discovery markers from env or use defaults."""
    raw = os.environ.get(
        "VINV_ENGINE_PROJECT_DISCOVERY_MARKERS",
        "package.json,pyproject.toml,setup.py,Cargo.toml,go.mod,pom.xml,"
        "Makefile,CMakeLists.txt,Gemfile,composer.json,build.gradle",
    )
    return {m.strip() for m in raw.split(",") if m.strip()}


def discover_projects(root_directory: str = ".") -> Dict[str, Any]:
    """Scan a directory for project roots (directories with package files).

    Identifies projects by the presence of configurable markers (package.json,
    pyproject.toml, Cargo.toml, go.mod, pom.xml, Makefile, etc.). Markers
    are loaded from VINV_ENGINE_PROJECT_DISCOVERY_MARKERS (comma-separated).

    Deduplication: projects are deduplicated by resolved path. Nested
    subprojects whose parent is already a project root are excluded
    unless they have their own distinct marker set (e.g. a monorepo
    with independent sub-packages).

    Args:
        root_directory: Directory to scan for projects

    Returns:
        {"status": "success"|"error", "projects": [...], "count": N}
    """
    markers = _get_project_discovery_markers()
    try:
        root = Path(_resolve_path(root_directory))
        if not root.exists():
            return {"status": "error", "error": f"Directory not found: {root}"}
        projects: list[dict[str, Any]] = []
        seen_paths: set[str] = set()
        project_roots: list[Path] = []
        for dirpath in sorted(root.rglob("*")):
            if not dirpath.is_dir():
                continue
            found_markers = [m for m in markers if (dirpath / m).exists()]
            if not found_markers:
                continue
            if any(part.startswith(".") or part == "node_modules" for part in dirpath.parts):
                continue
            resolved = str(dirpath.resolve())
            if resolved in seen_paths:
                continue
            seen_paths.add(resolved)
            is_nested_child = any(
                resolved.startswith(str(pr.resolve()) + os.sep) for pr in project_roots
            )
            if is_nested_child:
                parent_markers = set()
                for pr in project_roots:
                    if resolved.startswith(str(pr.resolve()) + os.sep):
                        parent_markers = {m for m in markers if (pr / m).exists()}
                        break
                if set(found_markers) <= parent_markers:
                    continue
            project_roots.append(dirpath)
            description = _infer_project_description(dirpath, found_markers)
            projects.append({
                "name": dirpath.name,
                "path": resolved,
                "markers": found_markers,
                "file_count": sum(1 for _ in dirpath.iterdir() if _.is_file()),
                "description": description,
            })
            if len(projects) >= 50:
                break
        return {"status": "success", "projects": projects, "count": len(projects)}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def _infer_project_description(project_dir: Path, markers: list[str]) -> str:
    """Infer a short description from the project's own metadata files."""
    if "package.json" in markers:
        try:
            import json as _json
            pkg = _json.loads((project_dir / "package.json").read_text(encoding="utf-8"))
            desc = pkg.get("description", "")
            if desc and len(desc) > 10:
                return desc
        except Exception:
            pass
    if "pyproject.toml" in markers:
        try:
            text = (project_dir / "pyproject.toml").read_text(encoding="utf-8")
            for line in text.splitlines():
                if line.strip().startswith("description"):
                    val = line.split("=", 1)[-1].strip().strip('"').strip("'")
                    if val and len(val) > 10:
                        return val
        except Exception:
            pass
    for readme in ("README.md", "README.rst", "README.txt", "README"):
        rp = project_dir / readme
        if rp.exists():
            try:
                lines = rp.read_text(encoding="utf-8", errors="ignore").splitlines()
                for line in lines[1:6]:
                    stripped = line.strip().lstrip("#").strip()
                    if len(stripped) > 15 and not stripped.startswith(("!", "[", "<", "```")):
                        return stripped[:200]
            except Exception:
                pass
    tech = ", ".join(markers[:3])
    return f"{project_dir.name} ({tech})"


def update_project_index(
    project_name: str,
    project_path: str,
    description: str = "",
    key_files: str = "",
) -> Dict[str, Any]:
    """Add or update a project entry in the project index.

    Args:
        project_name: Name of the project
        project_path: Absolute path to project root
        description: Brief description of the project
        key_files: Comma-separated list of key files

    Returns:
        {"status": "success"|"error"}
    """
    try:
        idx_path = Path(_PROJECT_INDEX_PATH)
        idx_path.parent.mkdir(parents=True, exist_ok=True)

        existing = idx_path.read_text(encoding="utf-8") if idx_path.exists() else "# Project Index\n\n"

        try:
            _mtime = os.path.getmtime(project_path)
            _modified = _time.strftime('%Y-%m-%d %H:%M:%S', _time.localtime(_mtime))
        except OSError:
            _modified = _time.strftime('%Y-%m-%d %H:%M:%S')

        entry = (
            f"\n## {project_name}\n"
            f"- **Path**: {project_path}\n"
            f"- **Description**: {description}\n"
            f"- **Key files**: {key_files}\n"
            f"- **Last modified**: {_modified}\n"
        )

        resolved_path = str(Path(project_path).resolve())
        path_marker = f"- **Path**: {resolved_path}"
        header = f"## {project_name}"
        already_exists = path_marker in existing or header in existing
        if already_exists:
            lines = existing.split("\n")
            new_lines: list[str] = []
            skip = False
            for line in lines:
                if line.strip() == header or (skip is False and path_marker in line):
                    if line.strip() == header:
                        skip = True
                        new_lines.append(entry.rstrip())
                    elif path_marker in line:
                        i = len(new_lines) - 1
                        while i >= 0 and new_lines[i].startswith("## "):
                            break
                        while i >= 0 and not new_lines[i].startswith("## "):
                            i -= 1
                        if i >= 0:
                            new_lines = new_lines[:i]
                        skip = True
                        new_lines.append(entry.rstrip())
                elif skip and line.startswith("## "):
                    skip = False
                    new_lines.append(line)
                elif not skip:
                    new_lines.append(line)
            idx_path.write_text("\n".join(new_lines), encoding="utf-8")
        else:
            with open(idx_path, "a", encoding="utf-8") as f:
                f.write(entry)

        return {"status": "success", "index_path": str(idx_path)}
    except Exception as e:
        return {"status": "error", "error": str(e)}


PROJECT_TOOLS = [
    search_project_index,
    discover_projects,
    update_project_index,
]


__all__ = [
    'save_file',
    'save_binary_file',
    'read_file',
    'read_file_chunked',
    'file_stats',
    'append_to_file',
    'list_files',
    'find_files',
    'make_directory',
    'copy_file',
    'move_file',
    'delete_file',
    'file_exists',
    'get_file_hash',
    'create_temp_file',
    'search_project_index',
    'discover_projects',
    'update_project_index',
    'FILE_MANAGEMENT_TOOLS',
    'PROJECT_TOOLS',
]
