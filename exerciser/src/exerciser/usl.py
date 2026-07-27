"""Universal Scalability Law fit — the maths behind "throughput-ceiling".

Gunther's USL models relative capacity at concurrency ``N`` as

    C(N) = N / (1 + sigma*(N-1) + kappa*N*(N-1))

where ``sigma`` is the contention (serialization) fraction and ``kappa`` the
coherency (crosstalk) penalty. Observed throughput is ``X(N) = lambda * C(N)``
with ``lambda`` the single-request rate, so the model fitted to a
(concurrency, throughput) sweep is

    X(N) = lambda * N / (1 + sigma*(N-1) + kappa*N*(N-1)).

**Fitting** (pure stdlib, least squares over ``sigma, kappa >= 0``): for FIXED
``(sigma, kappa)`` the model is linear in ``lambda`` — with basis values
``g_i = N_i / (1 + sigma*(N_i-1) + kappa*N_i*(N_i-1))`` the closed-form optimum
is ``lambda* = sum(y_i*g_i) / sum(g_i^2)``. That reduces the search to two
dimensions, swept by a coarse grid with iterative zoom refinement: the physical
box ``sigma in [0, 1]`` (a serialized fraction cannot exceed the whole) and
``kappa in [0, 1]`` (a knee at or beyond N=1 requires ``kappa <= 1 - sigma``)
is scanned on a 33x33 grid, then re-scanned on a window shrunk 5x around the
incumbent for several rounds — final parameter resolution ~1e-4, ample for
sweeps of a handful of concurrency levels.

**Reported**: ``sigma``, ``kappa``, the fitted unit rate ``lambda_``, ``r2``
(1 - SSE/SStot), the knee ``N* = sqrt((1-sigma)/kappa)`` where ``dX/dN = 0``
(defined only when ``kappa > 0`` and ``sigma < 1`` — otherwise the model is
monotone and ``knee`` is None), and ``peak_rps`` — ``X(N*)`` when the knee
exists, else the model's maximum over the swept concurrencies.

**Null fits** (return ``None`` rather than nonsense): fewer than 3 distinct
positive-throughput concurrencies (three parameters need at least three
supports), a flat sweep (zero throughput variance — nothing to fit, and the
flat model is itself inside the USL family at ``sigma=1, kappa=0``), or a
non-positive fitted ``lambda``/``R^2`` (the curve explains the sweep no better
than its mean). Noisy non-monotone sweeps that do fit come back with an
honestly low ``R^2``; the emission gate in ``optimize`` (policy key
``optimize.usl_min_r2``) is what keeps those from ever becoming opportunities.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

# Grid-search shape: coarse points per axis, zoom rounds, shrink per round.
# These control only the optimizer's resolution (~(1/32) * (1/5)^4 ≈ 1e-4 on
# the unit box), not any detection decision.
_GRID_POINTS = 33
_ZOOM_ROUNDS = 5
_ZOOM_SHRINK = 5.0


@dataclass
class USLFit:
    sigma: float  # contention (serialization) fraction
    kappa: float  # coherency (crosstalk) penalty
    lambda_: float  # fitted single-request rate (throughput scale)
    r2: float  # 1 - SSE/SStot of the fit
    knee: float | None  # N* = sqrt((1-sigma)/kappa); None when monotone
    peak_rps: float  # X(N*) when the knee exists, else max over the sweep

    def predict(self, n: float) -> float:
        """Model throughput X(n) = lambda * n / (1 + sigma(n-1) + kappa*n(n-1))."""
        denom = 1.0 + self.sigma * (n - 1.0) + self.kappa * n * (n - 1.0)
        return self.lambda_ * n / denom if denom > 0 else 0.0

    def to_json(self) -> dict[str, Any]:
        return {
            "sigma": round(self.sigma, 6),
            "kappa": round(self.kappa, 6),
            "lambda": round(self.lambda_, 4),
            "r2": round(self.r2, 4),
            "knee": round(self.knee, 2) if self.knee is not None else None,
            "peak_rps": round(self.peak_rps, 2),
        }


def _linspace(lo: float, hi: float, n: int) -> list[float]:
    if n <= 1 or hi <= lo:
        return [lo]
    step = (hi - lo) / (n - 1)
    return [lo + i * step for i in range(n)]


def _sse_and_lambda(
    pts: Sequence[tuple[float, float]],
    sigma: float,
    kappa: float,
) -> tuple[float, float]:
    """Least-squares error at (sigma, kappa) with the closed-form lambda*.

    g_i = N_i / (1 + sigma(N_i-1) + kappa N_i(N_i-1)); the model X = lambda*g
    is linear in lambda, so lambda* = sum(y*g)/sum(g^2) minimizes the SSE.
    """
    g: list[float] = []
    for n, _ in pts:
        denom = 1.0 + sigma * (n - 1.0) + kappa * n * (n - 1.0)
        g.append(n / denom if denom > 0 else 0.0)
    gg = sum(gi * gi for gi in g)
    if gg <= 0:
        return math.inf, 0.0
    lam = sum(y * gi for (_, y), gi in zip(pts, g, strict=False)) / gg
    sse = sum((y - lam * gi) ** 2 for (_, y), gi in zip(pts, g, strict=False))
    return sse, lam


def fit_usl(points: Iterable[tuple[float, float]]) -> USLFit | None:
    """Fit the USL to (concurrency, throughput) sweep points; None when degenerate.

    See the module docstring for the maths, the search, and the null-fit rules.
    """
    pts = [
        (float(n), float(y))
        for n, y in points
        if float(n) >= 1.0
        and float(y) > 0.0
        and math.isfinite(float(n))
        and math.isfinite(float(y))
    ]
    if len({n for n, _ in pts}) < 3:
        return None  # three parameters need at least three distinct supports
    mean_y = sum(y for _, y in pts) / len(pts)
    ss_tot = sum((y - mean_y) ** 2 for _, y in pts)
    if ss_tot <= 0:
        return None  # flat sweep — no concurrency signal to fit

    # Coarse grid over the physical box, then zoom refinement around the best.
    lo_s, hi_s, lo_k, hi_k = 0.0, 1.0, 0.0, 1.0
    best_sse, best = math.inf, (0.0, 0.0, 0.0)  # (sigma, kappa, lambda)
    for _ in range(_ZOOM_ROUNDS):
        for sigma in _linspace(lo_s, hi_s, _GRID_POINTS):
            for kappa in _linspace(lo_k, hi_k, _GRID_POINTS):
                sse, lam = _sse_and_lambda(pts, sigma, kappa)
                if sse < best_sse:
                    best_sse, best = sse, (sigma, kappa, lam)
        half_s = (hi_s - lo_s) / (2.0 * _ZOOM_SHRINK)
        half_k = (hi_k - lo_k) / (2.0 * _ZOOM_SHRINK)
        lo_s, hi_s = max(0.0, best[0] - half_s), min(1.0, best[0] + half_s)
        lo_k, hi_k = max(0.0, best[1] - half_k), min(1.0, best[1] + half_k)

    sigma, kappa, lam = best
    r2 = 1.0 - best_sse / ss_tot
    if lam <= 0 or r2 <= 0 or not math.isfinite(r2):
        return None  # explains the sweep no better than its mean

    knee = math.sqrt((1.0 - sigma) / kappa) if kappa > 0 and sigma < 1.0 else None
    fit = USLFit(sigma, kappa, lam, r2, knee, 0.0)
    if knee is not None:
        fit.peak_rps = fit.predict(knee)
    else:
        fit.peak_rps = max(fit.predict(n) for n, _ in pts)  # monotone: swept max
    return fit
