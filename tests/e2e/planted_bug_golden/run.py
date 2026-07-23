#!/usr/bin/env python3
"""Secret-free planted-bug golden E2E runner."""

from __future__ import annotations

import argparse
import atexit
import ast
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
VINV_ROOT = HERE.parents[2]
FIXTURE = HERE / "fixture_repo"
SERVICE = FIXTURE / "planted_app" / "service.py"
EXPECTED_FILE = "planted_app/service.py"
EXPECTED_SYMBOL = "compute_total"
HALLUCINATED_SENTINELS = {"calculate_discount", "CartService", "safe_average"}


def _cleanup_generated_artifacts() -> None:
    shutil.rmtree(FIXTURE / ".vinv", ignore_errors=True)


atexit.register(_cleanup_generated_artifacts)


def _build_synthetic_index(store_dir: Path) -> set[str]:
    """Build a deterministic Rust-index artifact from the real fixture AST."""
    source = SERVICE.read_text(encoding="utf-8")
    tree = ast.parse(source)
    chunks: list[dict[str, Any]] = []
    pending_calls: list[list[str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        symbol_id = f"{EXPECTED_FILE}::{node.name}"
        calls = sorted(
            {
                child.func.id
                for child in ast.walk(node)
                if isinstance(child, ast.Call) and isinstance(child.func, ast.Name)
            }
            - {node.name}
        )
        chunks.append(
            {
                "id": symbol_id,
                "file": EXPECTED_FILE,
                "lang": "python",
                "kind": "class" if isinstance(node, ast.ClassDef) else "function",
                "name": node.name,
                "start_line": node.lineno,
                "end_line": node.end_lineno,
                "summary": ast.get_docstring(node) or node.name,
                "text": ast.get_source_segment(source, node) or node.name,
                # v5 stores record callee paths with receivers; these are all
                # plain-name calls, and identification resolves from this field.
                "calls": calls,
            }
        )
        pending_calls.append(calls)
    by_name = {chunk["name"]: index for index, chunk in enumerate(chunks)}
    edges = [
        {"src": src, "dst": by_name[name], "kind": "invoke"}
        for src, calls in enumerate(pending_calls)
        for name in calls
        if name in by_name and by_name[name] != src
    ]
    store_dir.mkdir(parents=True)
    (store_dir / "meta.json").write_text(
        # v5: `calls` entries keep their receiver path; the fixture's calls are
        # all plain names (receiver-less), which is valid v5 content.
        json.dumps({"version": 5, "count": len(chunks)}), encoding="utf-8"
    )
    (store_dir / "chunks.jsonl").write_text(
        "".join(json.dumps(chunk) + "\n" for chunk in chunks), encoding="utf-8"
    )
    (store_dir / "edges.jsonl").write_text(
        "".join(json.dumps(edge) + "\n" for edge in edges), encoding="utf-8"
    )
    return set(by_name)


def _write_event(handle, event: dict[str, Any]) -> None:
    handle.write(json.dumps(event, sort_keys=True) + "\n")
    handle.flush()


def _capture_compatible_trace(trace_path: Path) -> dict[str, Any]:
    """Capture the actual run with Python hooks in Tracelens' JSONL event schema."""
    service_resolved = SERVICE.resolve()
    request_id = "golden-request"
    frames: dict[int, dict[str, Any]] = {}
    next_span = 0

    with trace_path.open("w", encoding="utf-8") as handle:
        def tracer(frame, event, arg):
            nonlocal next_span
            if Path(frame.f_code.co_filename).resolve() != service_resolved:
                return tracer
            frame_id = id(frame)
            qual = getattr(frame.f_code, "co_qualname", frame.f_code.co_name)
            component = f"planted_app.service.{qual}"
            if event == "call":
                next_span += 1
                depth = len(frames)
                frames[frame_id] = {
                    "component": component,
                    "depth": depth,
                    "started": time.perf_counter(),
                    "error_type": None,
                    "span": next_span,
                }
                _write_event(
                    handle,
                    {
                        "ts": float(next_span),
                        "request_id": request_id,
                        "component": component,
                        "event": "enter",
                        "depth": depth,
                        "thread_id": 1,
                    },
                )
            elif event == "exception" and frame_id in frames:
                frames[frame_id]["error_type"] = arg[0].__name__
            elif event == "return" and frame_id in frames:
                state = frames.pop(frame_id)
                _write_event(
                    handle,
                    {
                        "ts": float(next_span) + 0.5,
                        "request_id": request_id,
                        "component": state["component"],
                        "event": "exit",
                        "depth": state["depth"],
                        "thread_id": 1,
                        "duration_ms": round(
                            (time.perf_counter() - state["started"]) * 1000.0, 6
                        ),
                        "status": "error" if state["error_type"] else "ok",
                        "error_type": state["error_type"],
                    },
                )
            return tracer

        sys.path.insert(0, str(FIXTURE))
        try:
            service = importlib.import_module("planted_app.service")
            sys.settrace(tracer)
            healthy = service.checkout({"items": [{"price": 10.0}, {"price": 20.0}]})
            assert healthy == {"average": 15.0}
            reproduced = False
            try:
                service.checkout({"items": []})
            except ZeroDivisionError:
                reproduced = True
            assert reproduced, "planted regression did not reproduce"
        finally:
            sys.settrace(None)
            sys.path.remove(str(FIXTURE))
    return {"mode": "compatible-local-capture", "healthy_result": healthy, "bug_reproduced": True}


def _capture_real_tracelens(trace_path: Path) -> dict[str, Any]:
    env = os.environ.copy()
    paths = [
        HERE / "support",
        VINV_ROOT / "tracelens" / "src",
        FIXTURE,
    ]
    env["PYTHONPATH"] = os.pathsep.join(map(str, paths)) + os.pathsep + env.get("PYTHONPATH", "")
    # Prefer the project venv so `click` and other TraceLens deps resolve
    # without requiring a global install of the package.
    python = sys.executable
    venv_python = VINV_ROOT / "tracelens" / ".venv" / "bin" / "python"
    if venv_python.is_file():
        python = str(venv_python)
    command = [
        python,
        "-m",
        "tracelens.cli",
        "run",
        "--minimal",
        "--no-otel-autoinst",
        "-t",
        "planted_app",
        "-o",
        str(trace_path),
        "--",
        python,
        str(FIXTURE / "exercise.py"),
    ]
    completed = subprocess.run(command, env=env, capture_output=True, text=True, timeout=120)
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    if not trace_path.is_file() or not trace_path.stat().st_size:
        raise RuntimeError("Tracelens produced no trace events")
    return {"mode": "tracelens-cli", "bug_reproduced": True}


def _flatten_tree(node: dict[str, Any]):
    yield node
    for child in node.get("children", []):
        if child.get("resolved"):
            yield from _flatten_tree(child)


def _root_cause_evidence(
    trace_map: dict[str, Any], indexed_symbols: set[str]
) -> dict[str, Any]:
    nodes = list(_flatten_tree(trace_map["tree"]))
    root = next(node for node in nodes if node.get("name") == EXPECTED_SYMBOL)
    runtime = root.get("runtime", {})
    assert runtime.get("executed") is True
    assert runtime.get("error", 0) >= 1
    assert "ZeroDivisionError" in runtime.get("errors", [])
    assert root["file"] == EXPECTED_FILE

    lines = SERVICE.read_text(encoding="utf-8").splitlines()
    citation_line = next(
        i for i, line in enumerate(lines, 1) if "PLANTED_BUG" in line
    )
    assert "subtotal / len(items)" in lines[citation_line - 1]

    cited_symbols = {node.get("name") for node in nodes if node.get("name")}
    assert cited_symbols <= indexed_symbols, (
        f"hallucinated symbols: {sorted(cited_symbols - indexed_symbols)}"
    )
    assert not (cited_symbols & HALLUCINATED_SENTINELS)
    return {
        "root_cause": {
            "symbol": EXPECTED_SYMBOL,
            "file": EXPECTED_FILE,
            "line": citation_line,
            "error": "ZeroDivisionError",
        },
        "assertions": {
            "symbol_and_file_cited": True,
            "source_line_verified": True,
            "runtime_error_observed": True,
            "no_hallucinated_symbols": True,
        },
        "cited_symbols": sorted(cited_symbols),
    }


def _run_rust_stage() -> dict[str, Any]:
    cargo = shutil.which("cargo")
    if not cargo:
        return {"status": "skipped", "reason": "cargo is not installed"}
    completed = subprocess.run(
        [cargo, "run", "--quiet", "--manifest-path", str(HERE / "rust_harness/Cargo.toml")],
        cwd=VINV_ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    if completed.returncode:
        raise RuntimeError(f"Rust harness failed:\n{completed.stderr}\n{completed.stdout}")
    return json.loads(completed.stdout.strip().splitlines()[-1])


def _optional_agent_stage(enabled: bool) -> dict[str, Any]:
    if not enabled:
        return {
            "status": "skipped",
            "reason": "optional; pass --with-agent-stages and configure an agent command",
        }
    command = os.getenv("VINV_E2E_AGENT_COMMAND")
    has_secret = any(
        os.getenv(name) for name in ("OPENAI_API_KEY", "LITELLM_API_KEY", "ANTHROPIC_API_KEY")
    )
    if not command or not has_secret:
        return {
            "status": "skipped",
            "reason": "requires VINV_E2E_AGENT_COMMAND and an LLM API key",
        }
    completed = subprocess.run(
        command.split(),
        cwd=VINV_ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if completed.returncode:
        raise RuntimeError(f"optional agent stage failed: {completed.stderr}")
    return {"status": "ok", "command": command}


def run(args: argparse.Namespace) -> dict[str, Any]:
    _cleanup_generated_artifacts()
    rust = _run_rust_stage()
    sys.path.insert(0, str(VINV_ROOT / "identification" / "src"))
    from identification import build_api_call_tree, list_service_apis, map_trace_to_tree

    with tempfile.TemporaryDirectory(prefix="vinv-planted-golden-") as raw_tmp:
        tmp = Path(raw_tmp)
        store_dir = tmp / "index"
        indexed_symbols = _build_synthetic_index(store_dir)
        trace_path = tmp / "trace.jsonl"
        if args.real_tracelens:
            trace = _capture_real_tracelens(trace_path)
        else:
            trace = _capture_compatible_trace(trace_path)

        inventory = list_service_apis(FIXTURE, service="golden", store_dir=str(store_dir))
        endpoint = next(api for api in inventory["apis"] if api["path"] == "/checkout")
        assert endpoint["handler"] == "checkout"
        calltree = build_api_call_tree(
            FIXTURE, api_id=endpoint["id"], service="golden", store_dir=str(store_dir)
        )
        trace_map = map_trace_to_tree(
            FIXTURE,
            api_id=endpoint["id"],
            trace=str(trace_path),
            service="golden",
            store_dir=str(store_dir),
        )
        evidence = _root_cause_evidence(trace_map, indexed_symbols)
        result = {
            "status": "ok",
            "stages": {
                "rust_index": rust,
                "trace_capture": trace,
                "identification": {
                    "entrypoint": endpoint["id"],
                    "handler_observed": trace_map["handler_observed"],
                    "internal_functions": calltree["stats"]["internal_functions"],
                    "coverage": trace_map["coverage"],
                },
                "evidence": evidence,
                "handbook_bringup_agent": _optional_agent_stage(args.with_agent_stages),
            },
        }
        output = HERE / "last_result.json"
        if args.write_result:
            output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        _cleanup_generated_artifacts()
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--real-tracelens",
        action="store_true",
        help="require installed Tracelens dependencies and run its real CLI capture",
    )
    parser.add_argument(
        "--with-agent-stages",
        action="store_true",
        help="run VINV_E2E_AGENT_COMMAND when an LLM API key is present",
    )
    parser.add_argument(
        "--write-result",
        action="store_true",
        help="write last_result.json (off by default to keep the tree clean)",
    )
    args = parser.parse_args()
    try:
        print(json.dumps(run(args), indent=2))
    except Exception as exc:
        import traceback
        print(json.dumps({"status": "error", "error": str(exc) or repr(exc), "traceback": traceback.format_exc()}, indent=2), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
