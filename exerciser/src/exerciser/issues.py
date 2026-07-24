"""Failure clustering — 5xx / crash / invariant-violation results into issues.

A behavioural failure is only actionable once identical failures are collapsed
into one cluster (so a fix episode is dispatched once, not per probe). Clustering
uses the SAME normalisation the rest of Vinv uses for dedup: digits normalised
(ports, ids, durations vary run-to-run without changing what is broken),
whitespace collapsed, then a sha256 prefix — the ``failureSignature`` /
``issueSignature`` family in the extension.

The clusters are written to ``.vinv/exercise/issues.json``; the extension side
feeds NEW clusters into the existing autoTrigger dispatch with the behavioural
evidence (failing input, expected-vs-got, covered frames) attached.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Any

_DIGITS = re.compile(r"\d+")
_WS = re.compile(r"\s+")


def normalize_signature(kind: str, text: str) -> str:
    """Digit-normalised, whitespace-collapsed sha256 prefix (24 hex chars).

    Matches autoPilotMachine.failureSignature / insightRunner.issueSignature so a
    cluster id is stable across runs and comparable with the extension's own.
    """
    normalized = f"{kind} " + _WS.sub(" ", _DIGITS.sub("#", text)).strip().lower()[:600]
    return hashlib.sha256(normalized.encode()).hexdigest()[:24]


@dataclass
class FailureCluster:
    signature: str
    kind: str  # "server-error" | "crash" | "invariant-violation"
    title: str
    endpoint_id: str
    method: str
    path: str
    count: int = 0
    exemplar: dict[str, Any] = field(default_factory=dict)
    covered_frames: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "signature": self.signature,
            "kind": self.kind,
            "title": self.title,
            "endpoint_id": self.endpoint_id,
            "method": self.method,
            "path": self.path,
            "count": self.count,
            "exemplar": self.exemplar,
            "covered_frames": self.covered_frames,
        }


def _cluster_text(kind: str, method: str, path: str, detail: str) -> str:
    return f"{method} {path} {detail}"


def cluster_failures(executions: list[dict[str, Any]]) -> list[FailureCluster]:
    """Cluster the failing executions from a run's results.

    A failure is: a 5xx status (``server-error``), a no-response/transport error
    (``crash``), or an ``invariant_violation`` flag on the execution
    (``invariant-violation``). Non-failures are ignored.
    """
    clusters: dict[str, FailureCluster] = {}
    for ex in executions:
        status = ex.get("status")
        error = ex.get("error")
        violation = ex.get("invariant_violation")
        kind: str | None = None
        detail = ""
        if violation:
            kind, detail = "invariant-violation", str(violation)
        elif error and status is None:
            kind, detail = "crash", error
        elif isinstance(status, int) and status >= 500:
            kind, detail = "server-error", f"HTTP {status}"
        if kind is None:
            continue
        method = ex.get("method", "?")
        path = ex.get("path", "?")
        sig = normalize_signature(kind, _cluster_text(kind, method, path, detail))
        cluster = clusters.get(sig)
        if cluster is None:
            cluster = FailureCluster(
                signature=sig,
                kind=kind,
                title=f"{method} {path} — {detail}",
                endpoint_id=ex.get("endpoint_id", ex.get("api_id", "?")),
                method=method,
                path=path,
                exemplar={
                    "input": ex.get("input"),
                    "strategy": ex.get("strategy"),
                    "status": status,
                    "error": error,
                    "detail": detail,
                    "expected": ex.get("expected"),
                },
                covered_frames=list(ex.get("covered_frames", []) or []),
            )
            clusters[sig] = cluster
        cluster.count += 1
    return sorted(clusters.values(), key=lambda c: (c.kind, c.path, c.method))


def issues_document(clusters: list[FailureCluster]) -> dict[str, Any]:
    return {
        "version": 1,
        "cluster_count": len(clusters),
        "clusters": [c.to_json() for c in clusters],
    }
