"""
Code Editor Tools — grep, read, edit, and bulk-edit for code-writing agents
============================================================================

Provides structured, LLM-friendly tools for surgical code manipulation:

    grep_code       — regex search across a folder with structured results
    read_code       — windowed file reader (max 100 lines) with line numbers
    edit_code       — replace a line range with new code
    bulk_edit_code  — apply multiple edits atomically (indentation, renames, etc.)

All tools return Dict[str, Any] with a "status" key ("success" or "error").
"""

from __future__ import annotations

import logging
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from core.components.tools.file.file_tools import confine_path

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
if not logger.handlers:
    _handler = logging.StreamHandler(sys.stderr)
    _handler.setLevel(logging.INFO)
    _handler.setFormatter(
        logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    )
    logger.addHandler(_handler)

_MAX_READ_LINES = 100
_MAX_GREP_RESULTS = 50
_MAX_LINE_LEN = 500


def _resolve_confined(path: str) -> Path | Dict[str, Any]:
    """Resolve a caller path inside the project authority roots.

    Returns the resolved Path, or a structured error dict when the path
    escapes the authorized roots (same confinement as the file tools:
    project root + shared workspace, symlinks resolved first).
    """
    try:
        return confine_path(Path(path))
    except PermissionError as exc:
        return {"status": "error", "error": str(exc)}

# ═══════════════════════════════════════════════════════════════════════
# grep_code — Regex search across a folder
# ═══════════════════════════════════════════════════════════════════════


def grep_code(
    pattern: str,
    path: str = ".",
    include_glob: str = "",
    max_results: int = _MAX_GREP_RESULTS,
    context_lines: int = 2,
) -> Dict[str, Any]:
    """
    Search for a regex pattern across files in a directory.

    Returns structured matches with file path, line number, and context.
    Uses ripgrep (rg) if available, falls back to grep.

    Args:
        pattern:       Regex pattern to search for.
        path:          Directory or file to search in.
        include_glob:  Optional glob to filter files (e.g. "*.py", "*.js").
        max_results:   Maximum number of matches to return (default 50).
        context_lines: Lines of context before/after each match (default 2).

    Returns:
        Dict with "status", "matches" list, and "total_matches" count.
    """
    confined = _resolve_confined(path)
    if isinstance(confined, dict):
        return confined
    resolved = confined
    if not resolved.exists():
        return {"status": "error", "error": f"Path not found: {path}"}

    try:
        re.compile(pattern)
    except re.error as e:
        return {"status": "error", "error": f"Invalid regex: {e}"}

    matches = _grep_rg(pattern, str(resolved), include_glob, max_results, context_lines)
    if matches is None:
        matches = _grep_fallback(pattern, str(resolved), include_glob, max_results, context_lines)

    return {
        "status": "success",
        "pattern": pattern,
        "path": str(resolved),
        "total_matches": len(matches),
        "matches": matches[:max_results],
    }


def _grep_rg(
    pattern: str, path: str, include_glob: str, max_results: int, context: int
) -> Optional[List[Dict[str, Any]]]:
    """Try ripgrep first — much faster on large repos."""
    try:
        cmd = [
            "rg", "--json", "--max-count", str(max_results),
            "-C", str(context), "-e", pattern, path,
        ]
        if include_glob:
            cmd.extend(["--glob", include_glob])

        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30,
        )
        if result.returncode > 1:
            return None

        matches: List[Dict[str, Any]] = []
        for line in result.stdout.splitlines():
            try:
                import json
                obj = json.loads(line)
                if obj.get("type") == "match":
                    data = obj["data"]
                    text = data["lines"]["text"].rstrip("\n")
                    matches.append({
                        "file": data["path"]["text"],
                        "line": data["line_number"],
                        "text": text[:_MAX_LINE_LEN],
                    })
            except (ValueError, KeyError):
                continue
        return matches
    except FileNotFoundError:
        return None
    except subprocess.TimeoutExpired:
        return None


def _grep_fallback(
    pattern: str, path: str, include_glob: str, max_results: int, context: int
) -> List[Dict[str, Any]]:
    """Pure-Python fallback when rg is not installed."""
    matches: List[Dict[str, Any]] = []
    root = Path(path)
    glob_pattern = include_glob or "**/*"

    if root.is_file():
        files = [root]
    else:
        files = sorted(root.glob(glob_pattern))

    compiled = re.compile(pattern)
    for fpath in files:
        if not fpath.is_file():
            continue
        try:
            text = fpath.read_text(errors="replace")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if compiled.search(line):
                matches.append({
                    "file": str(fpath),
                    "line": i,
                    "text": line[:_MAX_LINE_LEN],
                })
                if len(matches) >= max_results:
                    return matches
    return matches


# ═══════════════════════════════════════════════════════════════════════
# read_code — Windowed file reader with line numbers
# ═══════════════════════════════════════════════════════════════════════


def read_code(
    file_path: str,
    start_line: int = 1,
    end_line: int = 0,
) -> Dict[str, Any]:
    """
    Read a section of a file, returning line-numbered content.

    Window is capped at 100 lines. If end_line is 0 or omitted,
    reads 100 lines starting from start_line.

    Args:
        file_path:  Path to the file.
        start_line: First line to read (1-indexed, default 1).
        end_line:   Last line to read (inclusive). 0 = start_line + 99.

    Returns:
        Dict with "status", "content" (line-numbered text), "start_line",
        "end_line", "total_lines", and "file_path".
    """
    confined = _resolve_confined(file_path)
    if isinstance(confined, dict):
        return confined
    resolved = confined
    if not resolved.is_file():
        return {"status": "error", "error": f"File not found: {file_path}"}

    try:
        all_lines = resolved.read_text(errors="replace").splitlines()
    except OSError as e:
        return {"status": "error", "error": str(e)}

    total = len(all_lines)
    start = max(1, start_line)

    if end_line <= 0:
        end = min(start + _MAX_READ_LINES - 1, total)
    else:
        end = min(end_line, total)

    if end - start + 1 > _MAX_READ_LINES:
        end = start + _MAX_READ_LINES - 1

    selected = all_lines[start - 1 : end]
    width = len(str(end))
    numbered = "\n".join(
        f"{start + i:>{width}}| {line}" for i, line in enumerate(selected)
    )

    return {
        "status": "success",
        "file_path": str(resolved),
        "start_line": start,
        "end_line": end,
        "total_lines": total,
        "content": numbered,
    }


# ═══════════════════════════════════════════════════════════════════════
# edit_code — Replace a line range with new code
# ═══════════════════════════════════════════════════════════════════════


def edit_code(
    file_path: str,
    start_line: int,
    end_line: int,
    new_code: str,
) -> Dict[str, Any]:
    """
    Replace lines start_line..end_line (inclusive, 1-indexed) with new_code.

    The new_code can have any number of lines — it does not need to match
    the original line count. A backup is created at <file>.bak before editing.

    Args:
        file_path:  Path to the file to edit.
        start_line: First line to replace (1-indexed).
        end_line:   Last line to replace (inclusive).
        new_code:   Replacement text (may be multi-line).

    Returns:
        Dict with "status", "lines_removed", "lines_added", and "new_total_lines".
    """
    confined = _resolve_confined(file_path)
    if isinstance(confined, dict):
        return confined
    resolved = confined
    if not resolved.is_file():
        return {"status": "error", "error": f"File not found: {file_path}"}

    try:
        original = resolved.read_text(errors="replace")
    except OSError as e:
        return {"status": "error", "error": str(e)}

    lines = original.splitlines(keepends=True)
    total = len(lines)

    if start_line < 1 or start_line > total:
        return {"status": "error", "error": f"start_line {start_line} out of range (1..{total})"}
    if end_line < start_line or end_line > total:
        return {"status": "error", "error": f"end_line {end_line} out of range ({start_line}..{total})"}

    removed_count = end_line - start_line + 1

    new_lines = new_code.splitlines(keepends=True)
    if new_code and not new_code.endswith("\n"):
        if new_lines:
            new_lines[-1] = new_lines[-1] + "\n"
        else:
            new_lines = [new_code + "\n"]

    # Create backup
    backup = resolved.with_suffix(resolved.suffix + ".bak")
    try:
        backup.write_text(original)
    except OSError:
        pass

    result_lines = lines[: start_line - 1] + new_lines + lines[end_line:]

    try:
        resolved.write_text("".join(result_lines))
    except OSError as e:
        return {"status": "error", "error": f"Write failed: {e}"}

    new_total = len(result_lines)
    logger.info(
        f"[EDIT] {resolved}: replaced lines {start_line}-{end_line} "
        f"(-{removed_count} +{len(new_lines)}) → {new_total} total"
    )

    return {
        "status": "success",
        "file_path": str(resolved),
        "lines_removed": removed_count,
        "lines_added": len(new_lines),
        "new_total_lines": new_total,
    }


# ═══════════════════════════════════════════════════════════════════════
# bulk_edit_code — Atomic multi-edit for a single file
# ═══════════════════════════════════════════════════════════════════════


def bulk_edit_code(
    file_path: str,
    edits: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Apply multiple edits to a single file atomically.

    Edits are applied bottom-up to prevent line-number drift. Each edit is
    a dict with "start_line", "end_line", and "new_code". Overlapping edits
    are rejected.

    Args:
        file_path: Path to the file.
        edits:     List of {"start_line": int, "end_line": int, "new_code": str}.

    Returns:
        Dict with "status", "edits_applied", and "new_total_lines".
    """
    confined = _resolve_confined(file_path)
    if isinstance(confined, dict):
        return confined
    resolved = confined
    if not resolved.is_file():
        return {"status": "error", "error": f"File not found: {file_path}"}

    if not edits:
        return {"status": "error", "error": "No edits provided"}

    try:
        original = resolved.read_text(errors="replace")
    except OSError as e:
        return {"status": "error", "error": str(e)}

    lines = original.splitlines(keepends=True)
    total = len(lines)

    # Validate and sort bottom-up
    parsed = []
    for i, edit in enumerate(edits):
        s = edit.get("start_line")
        e = edit.get("end_line")
        code = edit.get("new_code", "")
        if s is None or e is None:
            return {"status": "error", "error": f"Edit {i}: missing start_line or end_line"}
        if s < 1 or s > total:
            return {"status": "error", "error": f"Edit {i}: start_line {s} out of range (1..{total})"}
        if e < s or e > total:
            return {"status": "error", "error": f"Edit {i}: end_line {e} out of range ({s}..{total})"}
        parsed.append((s, e, code))

    parsed.sort(key=lambda x: x[0], reverse=True)

    # Check for overlaps
    for i in range(len(parsed) - 1):
        _, e_curr, _ = parsed[i]
        s_next, _, _ = parsed[i + 1]
        if s_next >= parsed[i][0]:
            pass
        if e_curr >= parsed[i + 1][0] and parsed[i + 1][1] >= parsed[i][0]:
            return {
                "status": "error",
                "error": f"Overlapping edits: ({parsed[i][0]}-{e_curr}) and ({parsed[i+1][0]}-{parsed[i+1][1]})",
            }

    # Backup
    backup = resolved.with_suffix(resolved.suffix + ".bak")
    try:
        backup.write_text(original)
    except OSError:
        pass

    # Apply bottom-up
    edits_applied = 0
    for start, end, new_code in parsed:
        new_lines = new_code.splitlines(keepends=True)
        if new_code and not new_code.endswith("\n"):
            if new_lines:
                new_lines[-1] = new_lines[-1] + "\n"
            else:
                new_lines = [new_code + "\n"]
        lines[start - 1 : end] = new_lines
        edits_applied += 1

    try:
        resolved.write_text("".join(lines))
    except OSError as e:
        return {"status": "error", "error": f"Write failed: {e}"}

    new_total = len(lines)
    logger.info(
        f"[BULK-EDIT] {resolved}: applied {edits_applied} edits → {new_total} total lines"
    )

    return {
        "status": "success",
        "file_path": str(resolved),
        "edits_applied": edits_applied,
        "new_total_lines": new_total,
    }


# ═══════════════════════════════════════════════════════════════════════
# Exported Tool List
# ═══════════════════════════════════════════════════════════════════════

EDITOR_TOOLS = [grep_code, read_code, edit_code, bulk_edit_code]

__all__ = ["grep_code", "read_code", "edit_code", "bulk_edit_code", "EDITOR_TOOLS"]
