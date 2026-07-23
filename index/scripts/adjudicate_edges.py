#!/usr/bin/env python3
"""Adjudicate ambiguous cross-file references the deterministic resolver
refused to guess.

The Rust indexer writes ``<store>/pending_edges.jsonl`` (one record per
ambiguous call: caller chunk + every candidate definition) and consumes
``<store>/edge_overrides.jsonl`` (adjudicated edges) on the next index/update.
This script bridges the two with a single structured LLM call per reference.

Contract per call (strict, validated — the model cannot invent an id):
  input : caller name/file + candidate list (id, file, kind, summary)
  output: {"dst_id": "<one of the candidate ids>"} to resolve,
          {"dst_id": null, "reason": "..."} to abstain.
A reply that violates the contract is fed back verbatim with the rejection
reason and retried; after MAX_ATTEMPTS the reference stays pending (abstain by
exhaustion) — never guessed.

Usage:
  OPENAI_API_KEY=... python3 adjudicate_edges.py <store-dir> [--model MODEL]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request

MAX_ATTEMPTS = 3

SYSTEM_PROMPT = (
    "You resolve ambiguous cross-file code references. Given a caller and "
    "several candidate definitions that share the referenced name, pick the "
    "definition the caller most plausibly invokes, using file-path proximity, "
    "symbol kind, and the candidate summaries. If the evidence is genuinely "
    "insufficient, abstain — a wrong edge is worse than no edge. Reply with "
    'JSON only: {"dst_id": "<candidate id>"} or '
    '{"dst_id": null, "reason": "<why you abstained>"}.'
)


def chat(endpoint: str, api_key: str, model: str, messages: list[dict]) -> str:
    body = json.dumps(
        {"model": model, "temperature": 0, "messages": messages}
    ).encode()
    req = urllib.request.Request(
        f"{endpoint.rstrip('/')}/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    return data["choices"][0]["message"]["content"]


def parse_decision(reply: str, candidate_ids: set[str]) -> tuple[str | None, str]:
    """Validate a reply against the contract.

    Returns (dst_id, "") on a valid resolution, (None, "") on a valid
    abstention, and raises ValueError with the rejection reason otherwise.
    """
    text = reply.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"reply was not valid JSON: {exc}") from exc
    if not isinstance(value, dict) or "dst_id" not in value:
        raise ValueError('reply must be an object with a "dst_id" key')
    dst = value["dst_id"]
    if dst is None:
        return None, str(value.get("reason", ""))
    if not isinstance(dst, str) or dst not in candidate_ids:
        raise ValueError(
            f'"dst_id" must be null or one of the candidate ids, got {dst!r}'
        )
    return dst, ""


def adjudicate(
    record: dict, endpoint: str, api_key: str, model: str
) -> tuple[str | None, str]:
    candidates = record["candidates"]
    candidate_ids = {c["id"] for c in candidates}
    lines = [
        f"Caller: {record['src_name']} in {record['src_file']}",
        f"Referenced name: {record['name']}",
        "Candidates:",
    ]
    for c in candidates:
        lines.append(
            f"- id={c['id']} file={c['file']} kind={c['kind']} "
            f"summary={c.get('summary', '')}"
        )
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "\n".join(lines)},
    ]

    last_reason = ""
    for attempt in range(MAX_ATTEMPTS):
        if attempt:
            time.sleep(0.5 * (1 << attempt))
        try:
            reply = chat(endpoint, api_key, model, messages)
        except Exception as exc:  # transport failure: back off, same request
            last_reason = f"transport: {exc}"
            continue
        try:
            return parse_decision(reply, candidate_ids)
        except ValueError as exc:
            # Contract violation: feed the rejected reply back so the retry
            # corrects rather than repeats.
            last_reason = str(exc)
            messages.append({"role": "assistant", "content": reply})
            messages.append(
                {
                    "role": "user",
                    "content": (
                        f"That reply was rejected: {exc}. Reply again with "
                        "JSON only, exactly one of "
                        '{"dst_id": "<candidate id>"} or '
                        '{"dst_id": null, "reason": "..."}.'
                    ),
                }
            )
    return None, f"exhausted retries: {last_reason}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("store", help="index store directory")
    parser.add_argument(
        "--model", default=os.environ.get("VINV_ADJUDICATION_MODEL", "gpt-5.4-nano")
    )
    parser.add_argument(
        "--endpoint",
        default=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    )
    args = parser.parse_args()

    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        print("OPENAI_API_KEY is not set", file=sys.stderr)
        return 2

    pending_path = os.path.join(args.store, "pending_edges.jsonl")
    overrides_path = os.path.join(args.store, "edge_overrides.jsonl")
    if not os.path.exists(pending_path):
        print("no pending edges — nothing to adjudicate")
        return 0

    already: set[tuple[str, str]] = set()
    overrides: list[dict] = []
    if os.path.exists(overrides_path):
        with open(overrides_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                overrides.append(row)
                already.add((row["src_id"], row.get("name", "")))

    resolved = abstained = 0
    with open(pending_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            key = (record["src_id"], record["name"])
            if key in already:
                continue
            dst_id, reason = adjudicate(record, args.endpoint, api_key, args.model)
            if dst_id is None:
                abstained += 1
                print(
                    f"abstain {record['src_name']} -> {record['name']}: {reason}"
                )
                continue
            resolved += 1
            overrides.append(
                {
                    "src_id": record["src_id"],
                    "dst_id": dst_id,
                    "name": record["name"],
                    "kind": "invoke",
                }
            )
            already.add(key)
            print(f"resolve {record['src_name']} -> {record['name']} = {dst_id}")

    with open(overrides_path, "w") as f:
        for row in overrides:
            f.write(json.dumps(row) + "\n")
    print(
        f"done: {resolved} resolved, {abstained} abstained; "
        f"overrides at {overrides_path} (run `vinv-index update` to apply)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
