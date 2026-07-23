"""Vinv Engine / components / common / persistence — Crash-safe atomic file operations.

Used by any component that needs reliable file I/O:
  - actor_runtime (mailbox, event log, correlation store)
  - todo (DAG checkpoints)
  - user (future: channel state)
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from core.components.common.exceptions import PersistenceError

logger = logging.getLogger(__name__)


class AtomicWriter:
    """Crash-safe file writes using write-to-temp + rename (POSIX)."""

    @staticmethod
    def write_json(path: Path, data: Any) -> None:
        """Atomically write *data* as JSON to *path*."""
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
            try:
                with os.fdopen(fd, "w") as f:
                    json.dump(data, f, default=str)
                    f.flush()
                    os.fsync(f.fileno())
                os.rename(tmp, path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        except OSError as exc:
            logger.error("Failed to write JSON to %s: %s", path, exc)
            raise PersistenceError(f"Failed to write {path}: {exc}") from exc

    @staticmethod
    def append_line(path: Path, data: Any) -> None:
        """Append a single JSON-encoded line to *path*."""
        logger.debug("Appending line to path: %s", path)
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            line = json.dumps(data, default=str) + "\n"
            with open(path, "a") as f:
                f.write(line)
                f.flush()
                os.fsync(f.fileno())
        except OSError as exc:
            logger.error("Failed to append line to %s: %s", path, exc)
            raise PersistenceError(f"Failed to append to {path}: {exc}") from exc

    @staticmethod
    def append_raw_line(path: Path, raw: str) -> None:
        """Append a pre-serialized string as a single line (no JSON encoding)."""
        logger.debug("Appending raw line to path: %s", path)
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(path, "a") as f:
                f.write(raw.rstrip("\n") + "\n")
                f.flush()
                os.fsync(f.fileno())
        except OSError as exc:
            logger.error("Failed to append raw line to %s: %s", path, exc)
            raise PersistenceError(f"Failed to append to {path}: {exc}") from exc

    @staticmethod
    def read_json(path: Path) -> Any:
        """Read JSON from *path*, returning None if not found."""
        if not path.exists():
            logger.debug("Reading JSON from %s: not found", path)
            return None
        try:
            with open(path) as f:
                data = json.load(f)
            logger.debug("Reading JSON from %s: found", path)
            return data
        except (OSError, json.JSONDecodeError) as exc:
            logger.error("Failed to read JSON from %s: %s", path, exc)
            raise PersistenceError(f"Failed to read {path}: {exc}") from exc

    @staticmethod
    def read_lines(path: Path) -> list[str]:
        """Read all non-empty lines from *path*."""
        if not path.exists():
            logger.debug("Reading lines from %s: not found", path)
            return []
        try:
            with open(path) as f:
                lines = [line for line in f.read().splitlines() if line.strip()]
            logger.debug("Reading lines from %s: %d lines", path, len(lines))
            return lines
        except OSError as exc:
            logger.error("Failed to read lines from %s: %s", path, exc)
            raise PersistenceError(f"Failed to read lines from {path}: {exc}") from exc

    @staticmethod
    def write_markdown(path: Path, content: str) -> None:
        """Atomically write markdown content to *path*."""
        logger.debug("Writing markdown to path: %s", path)
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
            try:
                with os.fdopen(fd, "w") as f:
                    f.write(content)
                    f.flush()
                    os.fsync(f.fileno())
                os.rename(tmp, path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        except OSError as exc:
            logger.error("Failed to write markdown to %s: %s", path, exc)
            raise PersistenceError(f"Failed to write {path}: {exc}") from exc

    @staticmethod
    def read_markdown(path: Path) -> str | None:
        """Read markdown from *path*, returning None if not found."""
        if not path.exists():
            logger.debug("Reading markdown from %s: not found", path)
            return None
        try:
            with open(path) as f:
                content = f.read()
            logger.debug("Reading markdown from %s: found", path)
            return content
        except OSError as exc:
            logger.error("Failed to read markdown from %s: %s", path, exc)
            raise PersistenceError(f"Failed to read {path}: {exc}") from exc
