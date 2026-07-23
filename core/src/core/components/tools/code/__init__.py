"""core code tools — windowed read / regex grep / surgical edit helpers.

The semantic-index tools are exposed through :mod:`core.index`, a lightweight
adapter around the native Rust executable.  They are not imported here so
editor-only consumers do not pay any subprocess-adapter import cost.
"""

from core.components.tools.code.editor import (
    bulk_edit_code,
    edit_code,
    grep_code,
    read_code,
)

__all__ = [
    "grep_code",
    "read_code",
    "edit_code",
    "bulk_edit_code",
]
