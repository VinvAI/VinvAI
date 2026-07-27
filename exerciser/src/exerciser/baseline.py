"""Golden behavior baselines — the Python mirror of probeBaseline.ts.

The mission asks the exerciser's regression verdicts to share the exact
degraded/same/improved semantics ``extension/src/harness/probeBaseline.ts`` uses.
Two integration options existed; this engine writes a SIBLING baseline store at
``.vinv/exercise/baselines/<api-id>.json`` with the IDENTICAL schema and ratchet
rules, rather than reusing ``.vinv/probes/baselines/*``. Justification:

* the exerciser records MANY inputs per endpoint (valid/boundary/negative/observed
  /semantic), keyed by an exerciser probe-id space, whereas the probe file keys
  entries by its trace-derived probeId — mixing them would collide id-spaces and
  let an exerciser probe silently rewrite a trace-probe's golden entry;
* the schema is byte-compatible, so ``probeRunner`` can consume this sibling store
  read-only for its own degraded/same/improved signal without owning its writes.

The comparison + ratchet logic here is a line-for-line port of ``compareObservation``
/ ``applyBaselines`` so a Python regression pass and a TypeScript probe pass agree.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import store

# Status classes, ranked by goodness (higher is better) — mirrors CLASS_RANK.
_CLASS_RANK = {"2xx-3xx": 3, "4xx": 2, "5xx": 1, "no-response": 0}


def status_class(status: int | None) -> str:
    if status is None:
        return "no-response"
    if status >= 500:
        return "5xx"
    if status >= 400:
        return "4xx"
    return "2xx-3xx"


def _safe_api_id(api_id: str) -> str:
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in api_id)


def _baseline_file(repo: Path, endpoint_id: str) -> Path:
    return store.baselines_dir(repo) / f"{_safe_api_id(endpoint_id)}.json"


def read_baseline(repo: Path, endpoint_id: str) -> dict[str, Any] | None:
    data = store.read_json(_baseline_file(repo, endpoint_id))
    if (
        isinstance(data, dict)
        and data.get("version") == 1
        and isinstance(data.get("entries"), dict)
    ):
        return data
    return None


def compare_observation(entry: dict[str, Any], observed: dict[str, Any]) -> dict[str, str]:
    """Port of probeBaseline.compareObservation. Pure."""
    before = _CLASS_RANK.get(entry.get("statusClass", "no-response"), 0)
    after = _CLASS_RANK.get(status_class(observed.get("httpStatus")), 0)
    if after < before:
        return {
            "verdict": "degraded",
            "detail": (
                f"status degraded: baseline {entry.get('statusClass')} "
                f"(HTTP {entry.get('httpStatus')}) → {status_class(observed.get('httpStatus'))} "
                f"(HTTP {observed.get('httpStatus')})"
            ),
        }
    if after > before:
        return {
            "verdict": "improved",
            "detail": (
                f"status improved: baseline {entry.get('statusClass')} "
                f"→ {status_class(observed.get('httpStatus'))}"
            ),
        }
    if entry.get("statusClass") == "2xx-3xx" and entry.get("shapeHash") != observed.get(
        "shapeHash"
    ):
        return {
            "verdict": "degraded",
            "detail": (
                f"response shape changed: {entry.get('shapeHash')} "
                f"→ {observed.get('shapeHash')}"
            ),
        }
    if (
        entry.get("statusClass") == "2xx-3xx"
        and entry.get("valueDigest")
        and observed.get("valueDigest")
        and entry.get("valueDigest") != observed.get("valueDigest")
    ):
        # Same status class, same shape, different VALUES. A valueDigest is only
        # seeded for probes whose output proved value-stable (identical digests
        # across repeated calls in one run), so drift here is a real behaviour
        # change — the "output changed but nothing raised" class. Entries or
        # observations without a digest express no opinion.
        return {
            "verdict": "degraded",
            "detail": (
                "response value changed on a value-stable probe "
                f"(shape unchanged): {entry.get('valueDigest')} → {observed.get('valueDigest')}"
            ),
        }
    return {"verdict": "same", "detail": ""}


def apply_baselines(
    repo: Path,
    observations: list[dict[str, Any]],
) -> dict[str, dict[str, str]]:
    """Port of probeBaseline.applyBaselines: record first-seen passing probes,
    compare the rest, ratchet improvements. Returns verdicts keyed by probeId.

    Each observation: ``{probeId, endpointId, method, path, httpStatus, handler,
    shapeHash}``. Never raises — an IO error degrades to no verdict for that
    endpoint.
    """
    verdicts: dict[str, dict[str, str]] = {}
    by_endpoint: dict[str, list[dict[str, Any]]] = {}
    for o in observations:
        by_endpoint.setdefault(o["endpointId"], []).append(o)

    now = datetime.now(UTC).isoformat()
    for endpoint_id, group in by_endpoint.items():
        try:
            existing = read_baseline(repo, endpoint_id) or {
                "version": 1,
                "endpointId": endpoint_id,
                "entries": {},
            }
            dirty = False
            for o in group:
                entry = existing["entries"].get(o["probeId"])
                if entry is None:
                    # Golden = earned: only a healthy response seeds a baseline.
                    if status_class(o.get("httpStatus")) == "2xx-3xx":
                        existing["entries"][o["probeId"]] = {
                            "probeId": o["probeId"],
                            "method": o.get("method"),
                            "path": o.get("path"),
                            "statusClass": status_class(o.get("httpStatus")),
                            "httpStatus": o.get("httpStatus"),
                            "handler": o.get("handler"),
                            "shapeHash": o.get("shapeHash"),
                            # Additive, nullable: seeded only when the run
                            # PROVED this probe's output value-stable.
                            "valueDigest": (o.get("valueDigest") if o.get("valueStable") else None),
                            "capturedAt": now,
                        }
                        dirty = True
                        verdicts[o["probeId"]] = {"verdict": "recorded", "detail": ""}
                    continue
                cmp = compare_observation(entry, o)
                verdicts[o["probeId"]] = cmp
                if (
                    cmp["verdict"] == "same"
                    and not entry.get("valueDigest")
                    and o.get("valueStable")
                    and o.get("valueDigest")
                ):
                    # Earned stability backfill: an older golden entry (or one
                    # recorded before value digests existed) gains the digest
                    # the first time a run proves the probe value-stable.
                    entry["valueDigest"] = o["valueDigest"]
                    existing["entries"][o["probeId"]] = entry
                    dirty = True
                if cmp["verdict"] == "improved":
                    existing["entries"][o["probeId"]] = {
                        **entry,
                        "statusClass": status_class(o.get("httpStatus")),
                        "httpStatus": o.get("httpStatus"),
                        "shapeHash": o.get("shapeHash"),
                        "valueDigest": (o.get("valueDigest") if o.get("valueStable") else None),
                        "capturedAt": now,
                    }
                    dirty = True
            if dirty:
                store.write_json(_baseline_file(repo, endpoint_id), existing)
        except OSError:
            continue
    return verdicts
