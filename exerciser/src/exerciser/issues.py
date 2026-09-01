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
import logging
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import store

_DIGITS = re.compile(r"\d+")
_WS = re.compile(r"\s+")


def normalize_signature(kind: str, text: str, discriminator: str = "") -> str:
    """Digit-normalised, whitespace-collapsed sha256 prefix (24 hex chars).

    Matches autoPilotMachine.failureSignature / insightRunner.issueSignature so a
    cluster id is stable across runs and comparable with the extension's own.

    Digit-normalisation exists to erase ports, ids and durations from FREE TEXT
    so the same failure clusters across runs. ``discriminator`` is for the case
    that breaks: a detail whose entire information content IS a number. It joins
    the hash verbatim, so callers can keep ``HTTP 500`` and ``HTTP 503`` apart
    while still collapsing the ids inside a message. Empty by default, which
    reproduces the original signature exactly.
    """
    normalized = f"{kind} " + _WS.sub(" ", _DIGITS.sub("#", text)).strip().lower()[:600]
    if discriminator:
        normalized = f"{normalized} |{discriminator}"
    return hashlib.sha256(normalized.encode()).hexdigest()[:24]


@dataclass
class FailureCluster:
    signature: str
    # server-error | crash | invariant-violation | baseline-degraded | broken-access-control
    kind: str
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


def build_clusters(
    rows: Iterable[dict[str, Any]],
    *,
    verdict: Callable[[dict[str, Any]], str | None],
    describe: Callable[[dict[str, Any], str], str],
    method: str,
    strategy: Callable[[dict[str, Any], str], str],
    expected: Callable[[dict[str, Any], str], str],
    target_of: Callable[[dict[str, Any]], str] = lambda r: str(r.get("target", "?")),
    exemplar_extra: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> list[FailureCluster]:
    """Group findings into clusters — the ONE implementation of this skeleton.

    Five oracles each carried a private copy of the same twenty lines
    (``functions``, ``differential``, ``faults``, ``concurrency``,
    ``environment``): build a dict, derive a verdict, normalise a signature,
    get-or-create a ``FailureCluster``, bump the count, sort. Only ``method``,
    the strategy label, the ``expected`` prose and the detail string ever
    differed — and the copies had already drifted, with ``differential`` sorting
    by ``(path, title)`` while the rest sorted by ``(kind, path)`` for no stated
    reason. Divergence in duplicated code is not hypothetical here; it had
    already happened.

    ``verdict`` returns the cluster kind, or ``None`` for a row that is not a
    finding. Everything else is per-oracle vocabulary.
    """
    clusters: dict[str, FailureCluster] = {}
    for row in rows:
        kind = verdict(row)
        if kind is None:
            continue
        target = target_of(row)
        detail = describe(row, kind)
        sig = normalize_signature(kind, f"{target} {detail}")
        cluster = clusters.get(sig)
        if cluster is None:
            exemplar: dict[str, Any] = {
                "input": None,
                "strategy": strategy(row, kind),
                "status": None,
                "error": detail,
                "detail": detail,
                "expected": expected(row, kind),
            }
            if exemplar_extra is not None:
                exemplar.update(exemplar_extra(row))
            cluster = FailureCluster(
                signature=sig,
                kind=kind,
                title=f"{target} — {detail}"[:300],
                endpoint_id=target,
                method=method,
                path=target,
                exemplar=exemplar,
            )
            clusters[sig] = cluster
        cluster.count += 1
    return sorted(clusters.values(), key=lambda c: (c.kind, c.path))


def cluster_failures(executions: list[dict[str, Any]]) -> list[FailureCluster]:
    """Cluster the failing executions from a run's results.

    A failure is: a 5xx status (``server-error``), a no-response/transport error
    (``crash``), an ``invariant_violation`` flag (``invariant-violation``), or an
    ``access_control_violation`` flag — a protected endpoint that served an
    anonymous request (``broken-access-control``, OWASP API1; a 2xx, so no 5xx
    oracle can see it). Non-failures are ignored.
    """
    clusters: dict[str, FailureCluster] = {}
    for ex in executions:
        status = ex.get("status")
        error = ex.get("error")
        violation = ex.get("invariant_violation")
        kind: str | None = None
        detail = ""
        # A 5xx detail is nothing BUT its number, so digit-normalisation would
        # fold 500/502/503/504 on one path into a single cluster: the first
        # status seen wins the title and exemplar, and one fix episode is
        # dispatched against a mischaracterised failure. Carry the status as a
        # verbatim discriminator so distinct server errors stay distinct.
        discriminator = ""
        if violation:
            kind, detail = "invariant-violation", str(violation)
        elif ex.get("access_control_violation"):
            kind, detail = "broken-access-control", f"anonymous request served (HTTP {status})"
            discriminator = str(status)
        elif error and status is None:
            kind, detail = "crash", error
        elif isinstance(status, int) and status >= 500:
            kind, detail = "server-error", f"HTTP {status}"
            discriminator = str(status)
        if kind is None:
            continue
        method = ex.get("method", "?")
        path = ex.get("path", "?")
        sig = normalize_signature(kind, _cluster_text(kind, method, path, detail), discriminator)
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


def clusters_from_baseline(
    verdicts: dict[str, dict[str, str]],
    observations: list[dict[str, Any]],
) -> list[FailureCluster]:
    """``baseline-degraded`` clusters from golden-baseline verdicts.

    A degraded verdict is the assert-shaped failure class: the endpoint answered
    (often 2xx) but its status class, response shape, or stable value regressed
    against the earned golden entry — "output changed but nothing raised".
    ``observations`` are the same records handed to ``apply_baselines`` (keyed
    by ``probeId``), used to attribute endpoint/method/path.
    """
    by_probe = {o.get("probeId"): o for o in observations}
    clusters: dict[str, FailureCluster] = {}
    for probe_id, verdict in verdicts.items():
        if verdict.get("verdict") != "degraded":
            continue
        o = by_probe.get(probe_id) or {}
        method = o.get("method", "?")
        path = o.get("path", "?")
        detail = verdict.get("detail", "baseline degraded")
        sig = normalize_signature(
            "baseline-degraded", _cluster_text("baseline-degraded", method, path, detail)
        )
        cluster = clusters.get(sig)
        if cluster is None:
            cluster = FailureCluster(
                signature=sig,
                kind="baseline-degraded",
                title=f"{method} {path} — {detail}",
                endpoint_id=o.get("endpointId", "?"),
                method=method,
                path=path,
                exemplar={
                    "probe_id": probe_id,
                    "status": o.get("httpStatus"),
                    "detail": detail,
                    "expected": "the earned golden baseline for this probe",
                },
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


def cluster_signature(cluster: dict[str, Any]) -> str:
    """A stable identity for one cluster.

    Every oracle's cluster document carries ``signature`` (:func:`normalize_
    signature`), which is exactly the digit-normalised identity the rest of Vinv
    dedupes on. The fallback exists only so a hand-written or older document
    still dedupes on SOMETHING rather than silently paying twice.
    """
    sig = cluster.get("signature")
    if isinstance(sig, str) and sig:
        return sig
    return "|".join(str(cluster.get(k, "")) for k in ("kind", "endpoint_id", "title"))


def merge_into_issues(
    repo: Path,
    clusters: Iterable[dict[str, Any]],
    *,
    logger: logging.Logger | None = None,
) -> int:
    """Publish an oracle's clusters into ``issues.json``. Returns how many were new.

    ``issues.json`` is the ONLY file the extension's dispatch path reads
    (``exerciseStateFromArtifacts`` -> ``clustersToEpisodes`` ->
    ``dispatchIssueEpisode``), so a cluster that never lands here is invisible:
    no Findings row, no fix episode, however correctly it was found.

    That is not hypothetical. On a CLI-only repo the invocation oracle recorded
    four failures in ``invocations.json`` and the campaign then stopped with
    ``no-actions`` — nothing published them, so ``issues.json`` was never
    written and the scorecard reported zero. Any oracle that clusters must call
    this itself rather than relying on the campaign having run.

    Merges rather than overwrites, keyed on signature, because ``run`` owns this
    file for the HTTP oracle and both sets of findings are real. The extension
    dedupes dispatches by signature, so a cluster appearing twice costs nothing.

    ORDERING: ``run`` rewrites this file wholesale, so publishers must land
    after it in a pass.
    """
    log = logger or logging.getLogger(__name__)
    incoming = [c for c in clusters if isinstance(c, dict)]
    if not incoming:
        return 0
    path = store.issues_path(repo)
    doc = store.read_json(path)
    existing = doc.get("clusters") if isinstance(doc, dict) else None
    by_sig: dict[str, dict[str, Any]] = {}
    if isinstance(existing, list):
        for c in existing:
            if isinstance(c, dict):
                by_sig[cluster_signature(c)] = c
    before = len(by_sig)
    for cluster in incoming:
        by_sig.setdefault(cluster_signature(cluster), cluster)
    ordered = sorted(by_sig.values(), key=lambda c: (str(c.get("kind")), str(c.get("path"))))
    store.write_json(path, {"version": 1, "cluster_count": len(ordered), "clusters": ordered})
    added = len(by_sig) - before
    log.info(
        "published %d cluster(s) into issues.json (%d new, %d total)",
        len(incoming),
        added,
        len(ordered),
    )
    return added
