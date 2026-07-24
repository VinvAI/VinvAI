"""Bounded throughput driver — req/s and latency percentiles under load.

testflow.md Phase-6 wants throughput/concurrency numbers. Locust does not embed
cleanly as a library call for a short, capped, local burst (it is a full runner
with its own event loop, web UI, and process model), so — decided by real
integration cost — this uses a bounded thread-pool driver: fire a fixed number of
requests at a target concurrency against ONE endpoint and report req/s, p50/p95/
p99 latency, and the error rate. Callers sweep concurrency to get
error-rate-vs-concurrency.

Strictly bounded and local (a small request cap, a hard per-request timeout) so
it never turns into a load test against anything real.
"""

from __future__ import annotations

import concurrent.futures
import time
from dataclasses import dataclass
from typing import Any, Callable

from .execute import ProbeResult, execute_probe

# Hard caps so a throughput probe can never become an unbounded load test.
_MAX_REQUESTS = 500
_MAX_CONCURRENCY = 32


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    k = (len(ordered) - 1) * pct
    lo = int(k)
    hi = min(lo + 1, len(ordered) - 1)
    return round(ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo), 3)


@dataclass
class ThroughputResult:
    endpoint: str
    concurrency: int
    requests: int
    wall_s: float
    req_per_s: float
    p50_ms: float
    p95_ms: float
    p99_ms: float
    error_rate: float

    def to_json(self) -> dict[str, Any]:
        return {
            "endpoint": self.endpoint,
            "concurrency": self.concurrency,
            "requests": self.requests,
            "wall_s": round(self.wall_s, 3),
            "req_per_s": round(self.req_per_s, 2),
            "p50_ms": self.p50_ms,
            "p95_ms": self.p95_ms,
            "p99_ms": self.p99_ms,
            "error_rate": round(self.error_rate, 4),
        }


def measure_throughput(
    base_url: str,
    method: str,
    path: str,
    *,
    body: Any = None,
    path_params: dict[str, Any] | None = None,
    query: dict[str, Any] | None = None,
    requests: int = 60,
    concurrency: int = 8,
    exercise_id: str = "vinv-throughput",
    probe_fn: Callable[..., ProbeResult] = execute_probe,
) -> ThroughputResult:
    """Fire ``requests`` at ``concurrency`` against one endpoint; report the profile.

    ``probe_fn`` is injectable so the driver is testable off a live service.
    Bounds are enforced defensively.
    """
    n = max(1, min(requests, _MAX_REQUESTS))
    workers = max(1, min(concurrency, _MAX_CONCURRENCY))

    def _one(_: int) -> ProbeResult:
        return probe_fn(
            base_url, method, path,
            body=body, path_params=path_params or {}, query=query or {},
            exercise_id=exercise_id,
        )

    latencies: list[float] = []
    errors = 0
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for res in pool.map(_one, range(n)):
            latencies.append(res.latency_ms)
            if res.status is None or res.status >= 500:
                errors += 1
    wall = max(1e-6, time.monotonic() - started)

    return ThroughputResult(
        endpoint=f"{method} {path}",
        concurrency=workers,
        requests=n,
        wall_s=wall,
        req_per_s=n / wall,
        p50_ms=percentile(latencies, 0.5),
        p95_ms=percentile(latencies, 0.95),
        p99_ms=percentile(latencies, 0.99),
        error_rate=errors / n,
    )
