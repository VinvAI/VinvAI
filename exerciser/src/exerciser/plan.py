"""Build the input plan per endpoint from THREE provenance layers.

1. **schema-driven** — from the endpoint's JSON schema (live OpenAPI, or the
   apis.json + synthesised path-param schemas fallback), generate ``valid``,
   ``boundary`` and ``negative`` inputs deterministically (``schema.py``).
2. **observed examples** — mine identification's captured ``args_summary`` for
   real values seen in the trace, so a probe can replay a genuine input.
3. **semantic plans** — for endpoints flagged ``needs-semantics`` (auth chains,
   resource-dependent CRUD, multi-step flows), render a harness prompt (the
   goal-engine print-prompt pattern) whose reply schema is
   ``{plans:[{endpoint,inputs,setup,expect}]}``; the prompt is written under
   ``.vinv/exercise/prompts/`` for the extension to dispatch, and any reply it
   stores is folded back in.

Every generated input is recorded WITH its provenance (``strategy`` +
``provenance``), so ``run`` can attribute a probe's coverage back to the strategy
the bandit picked, and the profile can report inputs-explored by class.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from . import store
from .generators import hypothesis_valid_available, hypothesis_valid_instance
from .openapi import (
    Endpoint,
    endpoints_from_apis,
    endpoints_from_openapi,
    fetch_openapi,
    load_apis_json,
    path_param_names,
)
from .schema import INPUT_CLASSES, generate_value

# Map an input class → the bandit strategy name it feeds.
_CLASS_STRATEGY = {
    "valid": "schema_valid",
    "boundary": "schema_boundary",
    "negative": "schema_negative",
}


def _observed_examples(repo: Path, handler: str | None) -> dict[str, Any] | None:
    """Mine a handler's newest clean observed arguments from apis.json's sibling
    tracemap/calltree captures.

    identification records ``args_summary`` on trace ENTER events; the shape it
    keeps is ``{head, len}`` for strings and ``{v}`` for scalars. We read the
    freshest capture's spans for this handler and reconstruct a concrete arg map
    for any argument whose recorded head covers the whole value.
    """
    if not handler:
        return None
    trace = _newest_trace(repo)
    if trace is None:
        return None
    example: dict[str, Any] = {}
    try:
        for line in trace.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or '"enter"' not in line:
                continue
            ev = json.loads(line)
            comp = ev.get("component", "")
            if ev.get("event") != "enter" or not comp.endswith("." + handler):
                continue
            args = ev.get("args_summary")
            if not isinstance(args, dict):
                continue
            for name, summ in args.items():
                if not isinstance(summ, dict):
                    continue
                val = _example_from_summary(summ)
                if val is not None:
                    example[name] = val
    except (OSError, ValueError):
        return None
    return example or None


def _example_from_summary(summ: dict[str, Any]) -> Any:
    if summ.get("truncated") or summ.get("summary_error"):
        return None
    if isinstance(summ.get("v"), (bool, int, float)):
        return summ["v"]
    head = summ.get("head")
    if head is not None:
        length = summ.get("len")
        if length is None or length <= len(head):
            return head
    return None


def _newest_trace(repo: Path) -> Path | None:
    caps = repo / ".vinv" / "captures"
    if not caps.is_dir():
        return None
    traces = [p for p in caps.rglob("trace.jsonl") if p.is_file() and p.stat().st_size > 0]
    if not traces:
        return None
    return max(traces, key=lambda p: p.stat().st_mtime)


# ---- semantic prompt rendering (goal-engine pattern) -----------------------

_SEMANTIC_REPLY_SCHEMA = (
    '{"plans": [{"endpoint": "<METHOD PATH>", '
    '"inputs": {"body": {..}|null, "path_params": {..}, "query": {..}, "headers": {..}}, '
    '"setup": [{"endpoint": "<METHOD PATH>", "inputs": {..}, "capture": {"<var>": "<json-pointer into the response>"}}], '
    '"expect": {"status": <int>|"2xx"|"4xx", "notes": "<what a correct service does>"}}]}'
)


def render_semantic_prompt(
    endpoint: Endpoint,
    observed: dict[str, Any] | None,
    *,
    coverage_gaps: list[str] | None = None,
) -> str:
    """Render the harness prompt for one needs-semantics endpoint.

    Tells the agent WHAT ARTIFACTS AND TOOLS it has (the .vinv/exercise/* files it
    can read over MCP, the current coverage gaps, the deterministic generators
    that already cover the schema matrix) so it authors TARGETED traffic — complex
    stateful scenarios and auth permutations the deterministic layers cannot. Ends
    with the EXACT JSON reply schema the extension parses — mirroring
    goal/agents.py's print-prompt→harness→JSON-reply contract.
    """
    params = path_param_names(endpoint.path)
    body_note = (
        json.dumps(endpoint.body_schema, indent=2)
        if endpoint.body_schema
        else "(no body schema published — infer from the handler name)"
    )
    observed_note = json.dumps(observed, indent=2) if observed else "(none observed in the trace)"
    gaps_note = ", ".join(coverage_gaps[:12]) if coverage_gaps else "(coverage not yet measured)"
    return (
        "You are planning behavioural test inputs for ONE endpoint of a running "
        "service that Vinv is exercising. This endpoint was flagged as needing "
        "SEMANTIC reasoning: it is an auth chain, a resource-dependent mutation, "
        "or a multi-step flow, so a valid call likely requires SETUP (create a "
        "resource, obtain a token) before the endpoint itself succeeds.\n\n"
        "WHAT VINV ALREADY DOES (do NOT duplicate it): deterministic generators "
        "cover the input MATRIX per endpoint — valid, boundary, negative/malformed "
        "and oversized inputs derived from the JSON schema, plus real observed "
        "values mined from the trace. Your job is the part they CANNOT do: "
        "multi-step stateful scenarios and AUTH PERMUTATIONS (anonymous vs a "
        "normal user vs a superuser) where state (a token, a created id) must flow "
        "between steps.\n\n"
        "ARTIFACTS/TOOLS AVAILABLE TO YOU (all under .vinv/exercise/, readable over "
        "MCP): plan.json (this plan, every endpoint + its generated inputs), "
        "profile.json (per-endpoint status/coverage/latency/invariants), "
        "issues.json (failure clusters), scorecard.md (the summary). Read them to "
        "target the gaps, and after your plan runs you may request another round.\n\n"
        f"Endpoint: {endpoint.method} {endpoint.path}\n"
        f"Handler: {endpoint.handler or '(unknown)'}\n"
        f"Path parameters: {params or '(none)'}\n"
        f"Requires auth: {endpoint.requires_auth}\n"
        f"Current uncovered symbols under this endpoint: {gaps_note}\n\n"
        f"Request body schema:\n{body_note}\n\n"
        f"Real values observed in the trace for this handler:\n{observed_note}\n\n"
        "Produce concrete, executable input plans: a VALID call (with whatever "
        "setup it needs), auth permutations where the endpoint is protected, and "
        "at least one NEGATIVE call a correct service must reject (bad credentials, "
        "missing resource, malformed body). Ground every value in the schema and "
        "the observed values; do not invent fields the schema does not define. For "
        "a setup step, name what to CAPTURE from its response (a token, a created "
        'id) and reference it in later inputs as "${var}" (a whole-string "${var}" '
        "keeps the captured type; header auth is {\"headers\": {\"Authorization\": "
        '"Bearer ${access_token}"}}).\n\n'
        "Reply with ONLY a JSON object (no fences, no prose) of the form:\n"
        f"{_SEMANTIC_REPLY_SCHEMA}\n"
    )


def _endpoint_plan(
    endpoint: Endpoint, repo: Path, seed: int,
) -> dict[str, Any]:
    """The per-endpoint plan record: schema inputs by class + observed + semantic
    flag, each carrying provenance."""
    inputs: list[dict[str, Any]] = []

    # Layer 1: schema-driven, one per class. The VALID class emits several
    # distinct instances (different seeds) so endpoints with a unique constraint
    # (a create-user that rejects a duplicate email) still get repeated 2xx
    # coverage — the round-robin cursor rotates through them.
    body_schema = endpoint.body_schema
    valid_seeds = [seed, seed + 101, seed + 202]
    for cls in INPUT_CLASSES:
        seeds = valid_seeds if cls == "valid" else [seed]
        for s in seeds:
            body = generate_value(body_schema, s, cls) if body_schema else None
            path_params = _gen_path_params(endpoint, s, cls)
            query = _gen_query_params(endpoint, s, cls)
            inputs.append({
                "strategy": _CLASS_STRATEGY[cls],
                "provenance": "schema",
                "class": cls,
                "body": body,
                "path_params": path_params,
                "query": query,
            })

    # Layer 1b: property-based valid instance from hypothesis-jsonschema, when the
    # optional dependency is installed (install-safe: absent → skipped). It feeds
    # the schema_valid arm as an ALTERNATIVE valid input, broadening the class.
    if body_schema and hypothesis_valid_available():
        hv = hypothesis_valid_instance(body_schema, seed)
        if hv is not None:
            inputs.append({
                "strategy": "schema_valid",
                "provenance": "hypothesis-jsonschema",
                "class": "valid",
                "body": hv,
                "path_params": _gen_path_params(endpoint, seed + 1, "valid"),
                "query": _gen_query_params(endpoint, seed, "valid"),
            })

    # Layer 2: observed examples (real trace values).
    observed = _observed_examples(repo, endpoint.handler)
    if observed:
        inputs.append({
            "strategy": "observed",
            "provenance": "trace",
            "class": "observed",
            "body": observed if endpoint.body_schema else None,
            "path_params": _observed_path_params(endpoint, observed),
            "query": {},
        })

    # Auth permutations: an anonymous variant of a protected endpoint is a
    # deterministic negative-auth probe (a correct service returns 401/403). The
    # user/superuser identities require credentials, which only a semantic scenario
    # can obtain — those ride the semantic layer's setup steps.
    if endpoint.requires_auth:
        inputs.append({
            "strategy": "schema_negative",
            "provenance": "auth-permutation",
            "class": "negative",
            "auth": "anonymous",
            "body": generate_value(body_schema, seed, "valid") if body_schema else None,
            "path_params": _gen_path_params(endpoint, seed, "valid"),
            "query": {},
            "headers": {},
        })

    return {
        **endpoint.to_json(),
        "inputs": inputs,
        "observed": observed,
    }


def _gen_path_params(endpoint: Endpoint, seed: int, cls: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    param_by_name = {p.get("name"): p for p in endpoint.param_schemas if p.get("in") == "path"}
    for name in path_param_names(endpoint.path):
        pschema = param_by_name.get(name, {}).get("schema") if param_by_name.get(name) else None
        pschema = pschema or {"type": "string", "minLength": 1}
        out[name] = generate_value(pschema, seed, cls, path=f"$path.{name}")
    return out


def _gen_query_params(endpoint: Endpoint, seed: int, cls: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for p in endpoint.param_schemas:
        if p.get("in") != "query":
            continue
        name = p.get("name")
        if not name:
            continue
        required = p.get("required", False)
        if cls == "valid" and not required:
            continue  # minimal valid call omits optional query params
        pschema = p.get("schema") or {"type": "string"}
        out[name] = generate_value(pschema, seed, cls, path=f"$query.{name}")
    return out


def _observed_path_params(endpoint: Endpoint, observed: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name in path_param_names(endpoint.path):
        if name in observed:
            out[name] = observed[name]
    return out


def build_plan(
    repo: Path,
    *,
    service: str | None = None,
    base_url: str | None = None,
    store_dir: str | None = None,
    seed: int = 1729,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Build and persist the exercise plan. Returns the plan dict.

    Endpoint shapes come from the live OpenAPI when ``base_url`` is given and the
    service answers; otherwise from identification's apis.json. Semantic prompts
    are rendered to ``.vinv/exercise/prompts/`` for the extension to dispatch.
    """
    log = logger or logging.getLogger(__name__)
    repo = repo.resolve()

    apis = load_apis_json(str(store.apis_json_path(repo)))
    spec = fetch_openapi(base_url) if base_url else None
    if spec is not None:
        endpoints = endpoints_from_openapi(spec, apis)
        input_source = "openapi"
    else:
        endpoints = endpoints_from_apis(apis)
        input_source = "apis.json"
    log.info("plan: %d endpoints from %s", len(endpoints), input_source)

    # Coverage gaps from a prior profile (when one exists) sharpen the semantic
    # prompt so the harness targets exactly the uncovered symbols.
    gaps_by_id = _coverage_gaps_by_endpoint(repo)

    store.prompts_dir(repo).mkdir(parents=True, exist_ok=True)
    plans: list[dict[str, Any]] = []
    semantic_prompts: list[str] = []
    for ep in endpoints:
        record = _endpoint_plan(ep, repo, seed)
        if ep.needs_semantics:
            prompt = render_semantic_prompt(
                ep, record.get("observed"), coverage_gaps=gaps_by_id.get(ep.api_id),
            )
            prompt_file = store.prompts_dir(repo) / f"{_safe(ep.api_id)}.json"
            # Preserve any reply the harness already authored — re-planning must
            # not clobber the dispatched scenario. An EXPIRED reply (run marked
            # it stale after its scenario failed against the live environment)
            # is preserved as history but no longer feeds the plan, and its
            # failure is threaded into the prompt so re-authorship learns from it.
            existing = store.read_json(prompt_file)
            preserved_reply = existing.get("reply") if isinstance(existing, dict) else None
            expired_reason = existing.get("reply_expired") if isinstance(existing, dict) else None
            expired_for = existing.get("reply_expired_for") if isinstance(existing, dict) else None
            if expired_reason and expired_for is not None and (
                expired_for != store.reply_fingerprint(preserved_reply)
            ):
                # A fresh reply landed since the expiry — the flag is spent.
                expired_reason = expired_for = None
            if expired_reason:
                prompt += (
                    "\n\nPREVIOUS ATTEMPT EXPIRED: your earlier scenario for this "
                    f"endpoint failed against the live service — {expired_reason}. "
                    "Author a fresh scenario that accounts for this (verify the "
                    "credentials/resources it depends on actually exist, or create "
                    "them in setup steps)."
                )
            store.write_json(prompt_file, {
                "api_id": ep.api_id,
                "endpoint": f"{ep.method} {ep.path}",
                "reply_schema": _SEMANTIC_REPLY_SCHEMA,
                "prompt": prompt,
                "reply": preserved_reply,  # the extension fills this after dispatch
                **({"reply_expired": expired_reason,
                    "reply_expired_for": expired_for} if expired_reason else {}),
            })
            record["semantic_prompt_file"] = str(prompt_file)
            semantic_prompts.append(str(prompt_file))
        # Fold in a stored reply for ANY endpoint, not just needs-semantics
        # ones: the Journey view lets a user author input plans for ordinary
        # endpoints too, and they ride the same prompts/<api_id>.json channel.
        reply = _read_semantic_reply(
            store.prompts_dir(repo) / f"{_safe(ep.api_id)}.json"
        )
        if reply:
            record["semantic_inputs"] = reply
        plans.append(record)

    result: dict[str, Any] = {
        "status": "ok",
        "service": service,
        "repo": str(repo),
        "base_url": base_url,
        "input_source": input_source,
        "seed": seed,
        "endpoint_count": len(plans),
        "semantic_prompt_count": len(semantic_prompts),
        "endpoints": plans,
    }
    store.write_json(store.plan_path(repo), result)
    result["output_file"] = str(store.plan_path(repo))
    log.info("plan: wrote %s (%d endpoints, %d semantic prompts)",
             store.plan_path(repo), len(plans), len(semantic_prompts))
    return result


def _coverage_gaps_by_endpoint(repo: Path) -> dict[str, list[str]]:
    """Uncovered symbol names per endpoint from a prior profile.json, if any."""
    profile = store.read_json(store.profile_path(repo))
    if not isinstance(profile, dict):
        return {}
    out: dict[str, list[str]] = {}
    for ep in profile.get("endpoints", []):
        gaps = ep.get("coverage", {}).get("uncovered", [])
        if gaps:
            out[ep.get("api_id")] = gaps
    return out


def _read_semantic_reply(prompt_file: Path) -> list[dict[str, Any]] | None:
    data = store.read_json(prompt_file)
    if not isinstance(data, dict):
        return None
    if data.get("reply_expired") and (
        data.get("reply_expired_for") is None
        or data.get("reply_expired_for") == store.reply_fingerprint(data.get("reply"))
    ):
        return None  # stale scenario — awaiting harness re-authorship
    reply = data.get("reply")
    if isinstance(reply, dict) and isinstance(reply.get("plans"), list):
        return reply["plans"]
    return None


def _safe(api_id: str) -> str:
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in api_id)
