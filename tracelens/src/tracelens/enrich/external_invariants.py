"""External post-conditions keyed by qualified name (no target source edits)."""

from __future__ import annotations

import ast
import json
import logging
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast

import yaml

_log = logging.getLogger("tracelens.diag")
_loaded: dict[str, str] | None = None


def _safe_get(value: object, key: object, default: object = None) -> object:
    if not isinstance(value, Mapping):
        raise TypeError("invariant .get() is limited to mappings")
    return value.get(key, default)


def reset_invariants_cache() -> None:
    """Clear cached invariants (tests or TRACELENS_INVARIANTS change)."""
    global _loaded
    _loaded = None


# Restricted builtins for invariant expressions (no open, exec, import, etc.).
_SAFE_BUILTINS: dict[str, Any] = {
    "len": len,
    "min": min,
    "max": max,
    "abs": abs,
    "sum": sum,
    "all": all,
    "any": any,
    "sorted": sorted,
    "isinstance": isinstance,
    "_safe_get": _safe_get,
    "True": True,
    "False": False,
    "None": None,
}

_SAFE_EXPR_NODES = (
    ast.Expression,
    ast.BoolOp,
    ast.BinOp,
    ast.UnaryOp,
    ast.Compare,
    ast.Call,
    ast.Name,
    ast.Load,
    ast.Constant,
    ast.Subscript,
    ast.Slice,
    ast.List,
    ast.Tuple,
    ast.Set,
    ast.Dict,
    ast.IfExp,
    ast.And,
    ast.Or,
    ast.Not,
    ast.UAdd,
    ast.USub,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.FloorDiv,
    ast.Mod,
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
    ast.Is,
    ast.IsNot,
    ast.In,
    ast.NotIn,
    ast.Attribute,
)


class _RewriteMappingGet(ast.NodeTransformer):
    def visit_Call(self, node: ast.Call) -> ast.AST:
        visited = self.generic_visit(node)
        if isinstance(visited, ast.Call) and isinstance(visited.func, ast.Attribute):
            return ast.copy_location(
                ast.Call(
                    func=ast.Name(id="_safe_get", ctx=ast.Load()),
                    args=[visited.func.value, *visited.args],
                    keywords=[],
                ),
                visited,
            )
        return visited


def _compile_safe_expr(expr: str) -> Any:
    """Compile a small expression language without Python object traversal."""
    tree = ast.parse(expr, mode="eval")
    for node in ast.walk(tree):
        if not isinstance(node, _SAFE_EXPR_NODES):
            raise ValueError(f"unsupported invariant syntax: {type(node).__name__}")
        if isinstance(node, ast.Name) and node.id.startswith("__"):
            raise ValueError("dunder names are not allowed")
        if isinstance(node, ast.Attribute) and node.attr != "get":
            raise ValueError("attribute access is not allowed")
        if isinstance(node, ast.Call):
            if node.keywords:
                raise ValueError("keyword arguments are not allowed")
            if isinstance(node.func, ast.Name):
                if node.func.id not in _SAFE_BUILTINS:
                    raise ValueError(f"call is not allowed: {node.func.id}")
            elif isinstance(node.func, ast.Attribute):
                if node.func.attr != "get" or not isinstance(
                    node.func.value, ast.Name | ast.Subscript
                ):
                    raise ValueError("only mapping.get(...) calls are allowed")
            else:
                raise ValueError("indirect calls are not allowed")
    tree = ast.fix_missing_locations(_RewriteMappingGet().visit(tree))
    return compile(tree, "<invariant>", "eval")


def _load_mapping(path: Path) -> dict[str, Any] | None:
    text = path.read_text(encoding="utf-8")
    suf = path.suffix.lower()
    if suf in (".yaml", ".yml"):
        raw = yaml.safe_load(text)
        if isinstance(raw, dict) and all(isinstance(k, str) for k in raw):
            return cast(dict[str, Any], raw)
        return None
    data = json.loads(text)
    if isinstance(data, dict) and all(isinstance(k, str) for k in data):
        return cast(dict[str, Any], data)
    return None


def load_invariant_exprs() -> dict[str, str]:
    """Map qualified component name → Python expression (must evaluate to truthy = OK)."""
    global _loaded
    if _loaded is not None:
        return _loaded
    raw = os.environ.get("TRACELENS_INVARIANTS", "").strip()
    if not raw:
        _loaded = {}
        return _loaded
    path = Path(raw)
    if not path.is_file():
        _log.warning("TRACELENS_INVARIANTS path not found: %s", raw)
        _loaded = {}
        return _loaded
    try:
        data = _load_mapping(path)
    except Exception as exc:
        _log.warning("invalid invariants file %s: %s", path, exc)
        _loaded = {}
        return _loaded
    if not isinstance(data, dict) or not all(isinstance(k, str) for k in data):
        _loaded = {}
        return _loaded
    out: dict[str, str] = {}
    for k, v in data.items():
        if isinstance(v, str):
            out[k] = v
        elif isinstance(v, dict) and "post" in v and isinstance(v["post"], str):
            out[k] = v["post"]
    _loaded = out
    return _loaded


def check_invariants(qual: str, bound: dict[str, Any], result: Any) -> list[str]:
    expr = load_invariant_exprs().get(qual)
    if not expr:
        return []
    env: dict[str, Any] = {
        "__builtins__": _SAFE_BUILTINS,
        "result": result,
    }
    for k, v in bound.items():
        if k != "result":
            env[k] = v
    try:
        code = _compile_safe_expr(expr)
        ok = bool(eval(code, env, env))  # nosec B307
    except Exception as exc:
        return [f"{qual}:invariant_eval_error:{type(exc).__name__}"]
    if not ok:
        return [f"{qual}:postcondition_failed"]
    return []
