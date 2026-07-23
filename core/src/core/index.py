"""Python adapter for the native Vinv code-index binary.

The Rust ``index`` executable is the production implementation.  This module
keeps subprocess handling in one place and retains the former Python tool
function names used by agents and backend orchestration.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import Any, Mapping, Sequence


class IndexError(RuntimeError):
    """Base error raised by the native index adapter."""


class IndexBinaryNotFound(IndexError):
    """Raised when the native index executable cannot be located."""


class IndexCommandError(IndexError):
    """Raised when the native index executable exits unsuccessfully."""

    def __init__(self, message: str, *, returncode: int, stderr: str = "") -> None:
        super().__init__(message)
        self.returncode = returncode
        self.stderr = stderr


class IndexProtocolError(IndexError):
    """Raised when the executable does not return a JSON object."""


def default_store_dir(repo_path: str | os.PathLike[str]) -> Path:
    """Return the canonical production store for ``repo_path``."""
    return Path(repo_path).expanduser().resolve() / ".vinv" / "index"


def discover_index_binary(
    binary: str | os.PathLike[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> Path:
    """Locate the native executable using overrides, PATH, then dev layout."""
    env = os.environ if environ is None else environ
    explicit = str(binary or env.get("VINV_INDEX_BINARY", "")).strip()
    if explicit:
        candidate = Path(explicit).expanduser()
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate.resolve()
        found = shutil.which(explicit)
        if found:
            return Path(found).resolve()
        raise IndexBinaryNotFound(f"Configured index binary is not executable: {explicit}")

    found = shutil.which("vinv-index")
    if found:
        return Path(found).resolve()

    package_file = Path(__file__).resolve()
    candidates = (
        Path(sys.executable).resolve().parent / "index",
        Path(sys.argv[0]).resolve().parent / "index",
        package_file.parents[3] / "index" / "dist" / "index",
        package_file.parents[3] / "index" / "target" / "release" / "index",
        package_file.parents[3] / "index" / "target" / "debug" / "index",
    )
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate.resolve()

    # The crate's historical binary name is intentionally the last PATH probe:
    # "index" is generic enough to collide with unrelated system utilities.
    found = shutil.which("index")
    if found:
        return Path(found).resolve()

    raise IndexBinaryNotFound(
        "Vinv index binary not found. Set VINV_INDEX_BINARY, install `vinv-index` "
        "or `index` on PATH, or build index/scripts/build_binary.sh."
    )


def _parse_json_output(stdout: str) -> dict[str, Any]:
    text = stdout.strip()
    candidates = [text] if text else []
    candidates.extend(line.strip() for line in reversed(text.splitlines()) if line.strip())
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    preview = text[-500:] if text else "<empty>"
    raise IndexProtocolError(f"Index binary returned invalid JSON: {preview}")


def run_index_command(
    argv: Sequence[str],
    *,
    binary: str | os.PathLike[str] | None = None,
    timeout: float | None = None,
    environ: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Run one native command safely and return its JSON object."""
    child_env = None
    if environ is not None:
        child_env = dict(os.environ)
        child_env.update(environ)
    executable = discover_index_binary(binary, environ=child_env)
    command = [str(executable), *(str(arg) for arg in argv)]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
            env=child_env,
        )
    except OSError as exc:
        raise IndexCommandError(
            f"Could not execute index binary: {exc}", returncode=-1
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise IndexCommandError(
            f"Index command timed out after {timeout} seconds",
            returncode=-1,
            stderr=(exc.stderr or "") if isinstance(exc.stderr, str) else "",
        ) from exc

    try:
        payload = _parse_json_output(completed.stdout)
    except IndexProtocolError:
        if completed.returncode != 0:
            detail = completed.stderr.strip() or completed.stdout.strip() or "unknown error"
            raise IndexCommandError(
                f"Index command failed: {detail}",
                returncode=completed.returncode,
                stderr=completed.stderr,
            ) from None
        raise

    if completed.returncode != 0:
        detail = payload.get("error") or payload.get("message") or completed.stderr.strip()
        raise IndexCommandError(
            f"Index command failed: {detail or 'unknown error'}",
            returncode=completed.returncode,
            stderr=completed.stderr,
        )
    return payload


def index_repository(
    repo_path: str,
    *,
    store_dir: str | None = None,
    languages: str | None = None,
    force: bool = False,
    no_summarize: bool = False,
    binary: str | os.PathLike[str] | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    repo = str(Path(repo_path).expanduser().resolve())
    store = str(Path(store_dir).expanduser().resolve()) if store_dir else str(default_store_dir(repo))
    argv = ["index", repo, "--store-dir", store]
    if languages:
        argv.extend(["--languages", languages])
    if force:
        argv.append("--force")
    if no_summarize:
        argv.append("--no-summarize")
    return run_index_command(argv, binary=binary, timeout=timeout)


def query_index(
    query: str,
    *,
    repo_path: str | None = None,
    store_dir: str | None = None,
    top_k: int = 5,
    context_symbols: str | None = None,
    binary: str | os.PathLike[str] | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    if not repo_path and not store_dir:
        raise ValueError("Either repo_path or store_dir must be provided")
    argv = ["query", query, "--top-k", str(top_k)]
    if store_dir:
        argv.extend(["--store-dir", str(Path(store_dir).expanduser().resolve())])
    elif repo_path:
        repo = str(Path(repo_path).expanduser().resolve())
        argv.extend(["--repo-path", repo, "--store-dir", str(default_store_dir(repo))])
    if context_symbols:
        argv.extend(["--context-symbols", context_symbols])
    return run_index_command(argv, binary=binary, timeout=timeout)


def update_index(
    repo_path: str,
    *,
    store_dir: str | None = None,
    languages: str | None = None,
    no_summarize: bool = False,
    skip_embeddings: bool = False,
    binary: str | os.PathLike[str] | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    repo = str(Path(repo_path).expanduser().resolve())
    store = str(Path(store_dir).expanduser().resolve()) if store_dir else str(default_store_dir(repo))
    argv = ["update", repo, "--store-dir", store]
    if languages:
        argv.extend(["--languages", languages])
    if no_summarize:
        argv.append("--no-summarize")
    if skip_embeddings:
        argv.append("--skip-embeddings")
    return run_index_command(argv, binary=binary, timeout=timeout)


def _compat_result(payload: dict[str, Any]) -> dict[str, Any]:
    """Expose legacy status/store/stat keys while retaining native fields."""
    result = dict(payload)
    if result.get("status") == "ok":
        result["status"] = "success"
    if "index_dir" in result:
        result.setdefault("store_dir", result["index_dir"])
    result.setdefault(
        "stats",
        {
            "files_scanned": result.get("files", 0),
            "symbols_total": result.get("symbols", 0),
            "edges_total": result.get("edges", 0),
        },
    )
    return result


def index_codebase(
    repo_path: str,
    store_dir: str | None = None,
    languages: str | None = None,
    force_reindex: bool = False,
) -> dict[str, Any]:
    """Compatibility wrapper for the legacy agent tool name."""
    return _compat_result(
        index_repository(
            repo_path,
            store_dir=store_dir,
            languages=languages,
            force=force_reindex,
        )
    )


def sync_index(
    repo_path: str,
    store_dir: str | None = None,
    languages: str | None = None,
    skip_embeddings: bool = False,
) -> dict[str, Any]:
    """Compatibility wrapper for the legacy agent tool name."""
    return _compat_result(
        update_index(
            repo_path,
            store_dir=store_dir,
            languages=languages,
            skip_embeddings=skip_embeddings,
        )
    )


def retrieve_code(
    query: str,
    repo_path: str | None = None,
    store_dir: str | None = None,
    top_k: int = 5,
    context_symbols: str | None = None,
) -> dict[str, Any]:
    """Compatibility wrapper returning logical-context-shaped query hits.

    Every call logs a bandit decision event into the shared retrieval ledger
    (same schema and epoch as the editor MCP), so Python-agent retrievals feed
    the same off-policy learning loop. Explicit rewards can be attached later
    via :func:`core.retrieval_telemetry.record_retrieval_feedback` with the
    returned ``decision_id``.
    """
    from core import retrieval_telemetry as telemetry

    resolved_store = (
        str(Path(store_dir).expanduser().resolve())
        if store_dir
        else str(default_store_dir(repo_path)) if repo_path else None
    )
    selection = telemetry.select_retrieval_action(top_k)

    started = time.monotonic()
    payload = query_index(
        query,
        repo_path=repo_path,
        store_dir=store_dir,
        top_k=int(selection["top_k"]),
        context_symbols=context_symbols,
    )
    latency_ms = (time.monotonic() - started) * 1000.0

    decision_id = None
    if resolved_store:
        decision_id = telemetry.log_retrieval_decision(
            store_dir=resolved_store,
            query=query,
            requested_top_k=top_k,
            selection=selection,
            latency_ms=latency_ms,
            results=payload.get("results", []),
        )
    results = []
    for hit in payload.get("results", []):
        lines = hit.get("lines") or [None, None]
        symbol_id = hit.get("name") or ""
        target = {
            "symbol_id": symbol_id,
            "file_path": hit.get("file"),
            "line_range": lines,
            "language": hit.get("lang"),
            "raw_signature": symbol_id,
            "synthetic_summary": hit.get("summary"),
            "code_snippet": hit.get("snippet"),
        }
        results.append(
            {
                "target": target,
                "neighbors": hit.get("neighbors", []),
                "parent_context": hit.get("parent_context", []),
                "score": hit.get("score"),
                "readable_summary": (
                    f"Found {symbol_id} in {hit.get('file')} "
                    f"(lines {lines[0]}–{lines[1]})."
                ),
            }
        )
    result = _compat_result(payload)
    result["results"] = results
    if decision_id:
        result["vinv_decision_id"] = decision_id
    return result


__all__ = [
    "IndexBinaryNotFound",
    "IndexCommandError",
    "IndexError",
    "IndexProtocolError",
    "default_store_dir",
    "discover_index_binary",
    "index_codebase",
    "index_repository",
    "query_index",
    "retrieve_code",
    "run_index_command",
    "sync_index",
    "update_index",
]
