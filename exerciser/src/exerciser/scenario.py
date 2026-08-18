"""Stateful sequential scenarios — ordered steps with variable capture/substitution.

Ordered flows where state flows between steps: signup → login → create-item →
get → delete, with the token and created ids captured from one step's response
and substituted into the next step's inputs.

A scenario is a list of STEPS, each ``{endpoint, method, path, inputs, capture,
expect}``. ``capture`` maps a variable name → a JSON pointer into the step's
response body; ``inputs`` may reference captured variables as ``${var}`` anywhere
(body values, path params, query, headers). The harness authors these via the
semantic-plan prompt; the engine executes them here.

Auth permutations (anon / user / superuser) are modelled as a scenario's
``auth_context`` — a header set captured by a login step (or supplied) — so the
same endpoint can be exercised under different identities without hardcoding
credentials.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .execute import ProbeResult, execute_probe

_VAR = re.compile(r"\$\{([^}]+)\}")


def substitute(value: Any, variables: dict[str, Any]) -> Any:
    """Recursively replace ``${var}`` references in strings/containers.

    A string that is EXACTLY ``${var}`` is replaced by the variable's raw value
    (preserving type — an int id stays an int); a string that merely contains
    references gets string interpolation.
    """
    if isinstance(value, str):
        whole = _VAR.fullmatch(value)
        if whole:
            return variables.get(whole.group(1), value)
        return _VAR.sub(lambda m: str(variables.get(m.group(1), m.group(0))), value)
    if isinstance(value, dict):
        return {k: substitute(v, variables) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute(v, variables) for v in value]
    return value


def json_pointer(body: Any, pointer: str) -> Any:
    """Resolve a simple JSON pointer (``/a/b/0``) or dotted path (``a.b.0``)."""
    if body is None:
        return None
    parts = [p for p in re.split(r"[/.]", pointer.lstrip("/")) if p != ""]
    cur: Any = body
    for part in parts:
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return cur


@dataclass
class StepResult:
    endpoint: str
    status: int | None
    ok: bool
    captured: dict[str, Any]
    error: str | None
    shape_hash: str
    latency_ms: float


@dataclass
class ScenarioResult:
    name: str
    steps: list[StepResult] = field(default_factory=list)
    completed: bool = False
    variables: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "completed": self.completed,
            "steps": [
                {
                    "endpoint": s.endpoint,
                    "status": s.status,
                    "ok": s.ok,
                    "captured": list(s.captured),
                    "error": s.error,
                    "latency_ms": s.latency_ms,
                }
                for s in self.steps
            ],
        }


def _step_ok(status: int | None, expect: dict[str, Any] | None) -> bool:
    if status is None:
        return False
    if not expect:
        return status < 500
    want = expect.get("status")
    if isinstance(want, int):
        return status == want
    if want == "2xx":
        return 200 <= status < 300
    if want == "4xx":
        return 400 <= status < 500
    return status < 500


def run_scenario(
    base_url: str,
    name: str,
    steps: list[dict[str, Any]],
    *,
    initial_vars: dict[str, Any] | None = None,
    exercise_id: str = "vinv-scenario",
    probe_fn: Callable[..., ProbeResult] = execute_probe,
    stop_on_failure: bool = True,
) -> ScenarioResult:
    """Execute an ordered scenario, threading captured variables between steps.

    Returns after all steps run (or the first failing step when
    ``stop_on_failure``). Never raises.
    """
    variables: dict[str, Any] = dict(initial_vars or {})
    result = ScenarioResult(name=name, variables=variables)
    for step in steps:
        method = str(step.get("method", "GET")).upper()
        path = str(step.get("path", "/"))
        inputs = substitute(step.get("inputs") or {}, variables)
        body = inputs.get("body")
        path_params = inputs.get("path_params") or {}
        query = inputs.get("query") or {}
        headers = inputs.get("headers") or {}
        content_type = inputs.get("content_type")

        res = probe_fn(
            base_url,
            method,
            path,
            body=body,
            path_params=path_params,
            query=query,
            headers=headers,
            content_type=content_type,
            exercise_id=exercise_id,
        )
        ok = _step_ok(res.status, step.get("expect"))
        captured: dict[str, Any] = {}
        for var, pointer in (step.get("capture") or {}).items():
            val = json_pointer(res.body, str(pointer))
            if val is not None:
                variables[var] = val
                captured[var] = val
        result.steps.append(
            StepResult(
                endpoint=f"{method} {path}",
                status=res.status,
                ok=ok,
                captured=captured,
                error=res.error,
                shape_hash=res.shape_hash,
                latency_ms=res.latency_ms,
            )
        )
        if not ok and stop_on_failure:
            return result
    result.completed = True
    return result
