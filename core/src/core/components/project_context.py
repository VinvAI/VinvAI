from __future__ import annotations

import os
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Iterator

_project_root: ContextVar[Path | None] = ContextVar("vinv_project_root", default=None)


def get_project_root() -> Path | None:
    """Return task-local project authority, with env compatibility for CLI callers."""
    root = _project_root.get()
    if root is not None:
        return root
    configured = os.environ.get("VINV_ENGINE_PROJECT_ROOT", "").strip()
    return Path(configured).expanduser().resolve() if configured else None


@contextmanager
def bind_project_root(root: Path | str) -> Iterator[Path]:
    """Bind a project root to only the current async/thread context."""
    resolved = Path(root).expanduser().resolve()
    token = _project_root.set(resolved)
    try:
        yield resolved
    finally:
        _project_root.reset(token)
