"""Plaintext prompt store for agent instructions and protocol snippets.

Prompts ship as plain ``*.txt`` package data (``core/src/core/prompts/``) and
are read directly from disk on first use. Sibling packages that bundle their
own prompt directories (``bringup``, ``handbook``) reuse :class:`PromptDir`
with their own path, so the loader lives in exactly one place.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

_PROMPTS_PATH = Path(__file__).resolve().parents[2] / "prompts"


class PromptDir:
    """Lazily-loaded key→text store backed by a directory of ``<name>.txt`` files."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._cache: dict[str, str] = {}

    def get(self, name: str) -> str:
        """Return the text stored in ``<dir>/<name>.txt``."""
        if name not in self._cache:
            self._cache[name] = (self._path / f"{name}.txt").read_text(encoding="utf-8")
        return self._cache[name]

    def apply(self, signature_cls: Any, name: str) -> Any:
        """Inject the prompt text as ``signature_cls``'s DSPy instructions.

        DSPy's ``Signature.instructions`` is a metaclass property backed by
        ``__doc__`` read at prompt-build time, so assigning it after class
        creation takes effect for every subsequent prediction.
        """
        signature_cls.instructions = self.get(name)
        return signature_cls


# Default store for core's own bundled prompts, plus module-level shims so
# call sites read as `prompts.get(...)` / `prompts.apply(...)`.
_default = PromptDir(_PROMPTS_PATH)


def get(name: str) -> str:
    """Return the prompt text stored under ``name`` in core's prompt directory."""
    return _default.get(name)


def apply(signature_cls: Any, name: str) -> Any:
    """Inject core's prompt text as ``signature_cls``'s DSPy instructions."""
    return _default.apply(signature_cls, name)
