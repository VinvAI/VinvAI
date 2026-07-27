"""Environment oracles — signature drift and the dependency-resolution matrix.

Runtime evidence, however much of it accumulates, cannot see a class of defect
that has nothing to do with the code under test: an upstream package changed a
signature, or the dependency solver picks a version the code was never run
against. Those break at import/call time in someone else's environment, and no
amount of exercising the local install reveals them.

Two oracles:

* **Signature drift** (``check_signature_drift``) — for every upstream symbol
  the repo actually CALLS, record ``inspect.signature`` and compare it against
  the recorded baseline on later runs. A parameter that disappeared, became
  required, or was reordered is reported the day the new version lands rather
  than the day a user hits it. Deliberately scoped to entry points the repo
  *calls* — signatures of the whole dependency tree would be noise.
* **Resolution matrix** (``resolve_matrix``) — resolve the dependency set under
  ``uv lock --resolution lowest-direct`` as well as ``highest``, and report
  where the two disagree. A floor that no longer resolves, or resolves to a
  version whose signature differs, is a real break that only a matrix sees.

Both are read-only over the environment: nothing is installed and no lock file
in the repo is modified (resolution runs against a copy in a temp dir).
"""

from __future__ import annotations

import importlib
import inspect
import logging
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from . import store
from .issues import FailureCluster, normalize_signature

DEFAULT_RESOLUTION_TIMEOUT_S = 180.0


# =========================================================================
# Signature drift
# =========================================================================


def signature_of(target: str) -> dict[str, Any]:
    """``inspect.signature`` of ``module:qualname``, rendered comparably.

    Returns ``{"ok": True, "params": [...], "text": "…"}`` or an ``ok: False``
    record naming why it could not be read — an upstream symbol that VANISHED
    is itself the drift signal, so failure is data, not an error.
    """
    mod_name, _, qual = target.partition(":")
    try:
        mod = importlib.import_module(mod_name)
    except BaseException as exc:
        return {"ok": False, "reason": f"import failed: {type(exc).__name__}: {exc}"[:200]}
    obj: Any = mod
    for part in qual.split(".") if qual else []:
        try:
            obj = getattr(obj, part)
        except AttributeError:
            return {"ok": False, "reason": f"symbol {target} no longer exists"}
    try:
        sig = inspect.signature(obj)
    except (TypeError, ValueError) as exc:
        return {"ok": False, "reason": f"signature unavailable: {exc}"[:200]}
    params = [
        {
            "name": name,
            "kind": str(p.kind),
            "required": p.default is p.empty and p.kind not in (p.VAR_POSITIONAL, p.VAR_KEYWORD),
        }
        for name, p in sig.parameters.items()
    ]
    return {
        "ok": True,
        "params": params,
        "text": str(sig),
        "version": _dist_version(mod_name),
    }


def _dist_version(module_name: str) -> str | None:
    """Installed version of the distribution providing ``module_name``, if known."""
    from importlib import metadata

    top = module_name.partition(".")[0]
    try:
        return metadata.version(top)
    except Exception:
        return None


def diff_signature(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    """Human-readable drift between two ``signature_of`` records.

    Only BREAKING directions are reported: a symbol that vanished, a parameter
    removed, a parameter that became required, or a positional reorder. Adding
    an optional parameter is backward-compatible and stays silent — an oracle
    that fires on every upstream release gets switched off.
    """
    if not before.get("ok"):
        return []  # no baseline to compare against
    if not after.get("ok"):
        reason = str(after.get("reason") or "")
        # An IMPORT that failed is an environment fact, not API drift. The
        # symbol may be perfectly present on a machine with the native library,
        # the env var, or the GPU — `signature_of` catches BaseException and
        # stringifies it, so a missing `libcudart.so`, an unset key, an OOM and
        # a SystemExit all arrived here indistinguishable from "the symbol was
        # deleted upstream". Reporting that as breaking drift is a false finding
        # with `from_version: null, to_version: null` attached: the harness has
        # the evidence that nothing changed and was not using it.
        if reason.startswith("import failed"):
            return []
        return [f"symbol became unusable: {reason}"]

    before_params = {p["name"]: p for p in before.get("params", [])}
    after_params = {p["name"]: p for p in after.get("params", [])}
    out: list[str] = []
    for name, bp in before_params.items():
        ap = after_params.get(name)
        if ap is None:
            out.append(f"parameter '{name}' was removed")
            continue
        if ap["required"] and not bp["required"]:
            out.append(f"parameter '{name}' became required")
        if ap["kind"] != bp["kind"]:
            out.append(f"parameter '{name}' changed kind: {bp['kind']} → {ap['kind']}")
    for name, ap in after_params.items():
        if name not in before_params and ap["required"]:
            out.append(f"new REQUIRED parameter '{name}' was added")

    b_order = [p["name"] for p in before.get("params", []) if p["name"] in after_params]
    a_order = [p["name"] for p in after.get("params", []) if p["name"] in before_params]
    if b_order != a_order:
        out.append(f"positional order changed: {b_order} → {a_order}")
    return out


def check_signature_drift(
    repo: Path,
    targets: list[str],
    *,
    update_baseline: bool = True,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Compare every target's signature against the recorded baseline.

    The first run RECORDS (there is nothing to drift from yet) and reports no
    findings; later runs compare. Baselines live in
    ``.vinv/exercise/signatures.json`` with the version they were taken at.
    """
    log = logger or logging.getLogger(__name__)
    path = store.exercise_dir(repo) / "signatures.json"
    doc = store.read_json(path) or {}
    baseline: dict[str, Any] = doc.get("signatures") or {}

    current: dict[str, Any] = {}
    findings: list[dict[str, Any]] = []
    for target in sorted(set(targets)):
        sig = signature_of(target)
        prior = baseline.get(target)
        # An UNUSABLE reading must never replace a good baseline. `current` is
        # merged over `baseline` below, so a run on a machine that could not
        # import the module overwrote the real signature with the failure — and
        # the NEXT run then hit `not before.ok` and returned no findings at all.
        # The finding self-erased AND destroyed the evidence needed to detect
        # genuine drift later.
        if sig.get("ok") or prior is None:
            current[target] = sig
        else:
            current[target] = prior
        if prior is None:
            continue  # first sighting: record, do not report
        drift = diff_signature(prior, sig)
        if drift:
            findings.append(
                {
                    "target": target,
                    "from_version": prior.get("version"),
                    "to_version": sig.get("version"),
                    "before": prior.get("text"),
                    "after": sig.get("text"),
                    "drift": drift,
                }
            )

    if update_baseline:
        # Merge rather than replace: a target not exercised this run keeps its
        # baseline instead of silently losing it.
        merged = {**baseline, **current}
        store.write_json(path, {"version": 1, "signatures": merged})

    log.info(
        "signature drift: %d targets checked, %d new baselines, %d drifted",
        len(current),
        sum(1 for t in current if t not in baseline),
        len(findings),
    )
    return {
        "checked": len(current),
        "recorded": sum(1 for t in current if t not in baseline),
        "drifted": len(findings),
        "findings": findings,
    }


# =========================================================================
# Dependency-resolution matrix
# =========================================================================


def _uv_available() -> bool:
    return shutil.which("uv") is not None


def resolve_matrix(
    repo: Path,
    *,
    resolutions: tuple[str, ...] = ("lowest-direct", "highest"),
    timeout_s: float = DEFAULT_RESOLUTION_TIMEOUT_S,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Resolve the dependency set under each resolution mode and diff them.

    Runs against a COPY of the project metadata in a temp dir, so the repo's
    own lock file is never touched. A mode that fails to resolve at all is the
    loudest possible finding: the declared floor is not installable.
    """
    log = logger or logging.getLogger(__name__)
    pyproject = repo / "pyproject.toml"
    if not pyproject.is_file():
        return {
            "status": "skipped",
            "reason": "no pyproject.toml — nothing to resolve",
            "modes": {},
        }
    if not _uv_available():
        return {
            "status": "skipped",
            "reason": "uv is not on PATH — the resolution matrix needs it",
            "modes": {},
        }

    modes: dict[str, Any] = {}
    with tempfile.TemporaryDirectory(prefix="vinv-resolve-") as tmp:
        work = Path(tmp) / "proj"
        work.mkdir()
        shutil.copy2(pyproject, work / "pyproject.toml")
        readme = repo / "README.md"
        if readme.is_file():
            shutil.copy2(readme, work / "README.md")
        for mode in resolutions:
            lock = work / "uv.lock"
            lock.unlink(missing_ok=True)
            try:
                proc = subprocess.run(  # noqa: S603 (fixed argv, no shell)
                    ["uv", "lock", "--resolution", mode],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=timeout_s,
                    cwd=str(work),
                    env={**os.environ, "UV_NO_SYNC": "1"},
                )
            except (subprocess.TimeoutExpired, OSError) as exc:
                modes[mode] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}
                continue
            if proc.returncode != 0:
                modes[mode] = {
                    "ok": False,
                    "error": (proc.stderr or proc.stdout or "")[-600:],
                }
                continue
            modes[mode] = {"ok": True, "packages": _packages_from_lock(lock)}

    diffs = _diff_modes(modes)
    log.info(
        "resolution matrix: %d modes, %d version disagreements",
        len(modes),
        len(diffs),
    )
    return {"status": "ok", "modes": modes, "disagreements": diffs}


def _packages_from_lock(lock: Path) -> dict[str, str]:
    """``{name: version}`` from a ``uv.lock`` (TOML), or ``{}`` when unreadable."""
    import tomllib

    try:
        data = tomllib.loads(lock.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return {}
    out: dict[str, str] = {}
    for pkg in data.get("package", []) or []:
        if isinstance(pkg, dict) and pkg.get("name") and pkg.get("version"):
            out[str(pkg["name"])] = str(pkg["version"])
    return out


def _diff_modes(modes: dict[str, Any]) -> list[dict[str, Any]]:
    """Packages whose resolved version differs across modes."""
    ok_modes = {m: d["packages"] for m, d in modes.items() if d.get("ok")}
    if len(ok_modes) < 2:
        return []
    names: set[str] = set()
    for pkgs in ok_modes.values():
        names |= set(pkgs)
    out: list[dict[str, Any]] = []
    for name in sorted(names):
        versions = {m: pkgs.get(name) for m, pkgs in ok_modes.items()}
        if len({v for v in versions.values() if v is not None}) > 1 or None in versions.values():
            out.append({"package": name, "versions": versions})
    return out


# =========================================================================
# Runner
# =========================================================================


def cluster_environment_findings(
    drift: dict[str, Any], matrix: dict[str, Any]
) -> list[FailureCluster]:
    """Environment findings as issue clusters, alongside the runtime ones."""
    clusters: list[FailureCluster] = []
    for finding in drift.get("findings", []):
        detail = "; ".join(finding["drift"])
        target = finding["target"]
        clusters.append(
            FailureCluster(
                signature=normalize_signature("signature-drift", f"{target} {detail}"),
                kind="signature-drift",
                title=f"{target} — {detail}"[:300],
                endpoint_id=target,
                method="ENV",
                path=target,
                count=1,
                exemplar={
                    "input": None,
                    "strategy": "environment/signature",
                    "status": None,
                    "error": detail,
                    "detail": (
                        f"{finding.get('from_version')} → {finding.get('to_version')}: "
                        f"{finding.get('before')} → {finding.get('after')}"
                    ),
                    "expected": "an upstream signature the repo already calls stays callable",
                },
            )
        )
    for mode, data in (matrix.get("modes") or {}).items():
        if data.get("ok"):
            continue
        detail = f"dependency resolution failed under --resolution {mode}"
        clusters.append(
            FailureCluster(
                signature=normalize_signature("resolution-failure", detail),
                kind="resolution-failure",
                title=detail,
                endpoint_id=mode,
                method="ENV",
                path=mode,
                count=1,
                exemplar={
                    "input": None,
                    "strategy": f"environment/{mode}",
                    "status": None,
                    "error": str(data.get("error"))[:400],
                    "detail": detail,
                    "expected": "every declared resolution mode resolves",
                },
            )
        )
    return sorted(clusters, key=lambda c: (c.kind, c.path))


def run_environment(
    repo: Path,
    *,
    targets: list[str] | None = None,
    skip_matrix: bool = False,
    timeout_s: float = DEFAULT_RESOLUTION_TIMEOUT_S,
    logger: logging.Logger | None = None,
) -> dict[str, Any]:
    """Run both environment oracles and persist ``environment.json``.

    ``targets`` are ``module:qualname`` upstream symbols; when omitted they are
    read from ``.vinv/exercise/signatures.json`` (whatever previous runs
    recorded), so the check is self-sustaining once seeded.
    """
    log = logger or logging.getLogger(__name__)
    repo = repo.resolve()
    store.exercise_dir(repo).mkdir(parents=True, exist_ok=True)

    if targets is None:
        doc = store.read_json(store.exercise_dir(repo) / "signatures.json") or {}
        targets = sorted(doc.get("signatures") or {})

    diagnostics: list[str] = []
    if not targets:
        diagnostics.append(
            "0 upstream symbols under signature watch — pass --signature-target "
            "module:qualname for each upstream entry point this repo calls. "
            "Without a watch list, a breaking upstream release is invisible "
            "until it reaches a user."
        )
        log.warning("environment_empty %s", diagnostics[0])

    drift = check_signature_drift(repo, targets, logger=log)
    matrix = (
        {"status": "skipped", "reason": "--skip-matrix", "modes": {}}
        if skip_matrix
        else resolve_matrix(repo, timeout_s=timeout_s, logger=log)
    )
    clusters = cluster_environment_findings(drift, matrix)

    result: dict[str, Any] = {
        "status": "ok",
        "diagnostics": diagnostics,
        "repo": str(repo),
        "python": sys.version.split()[0],
        "signature_drift": drift,
        "resolution_matrix": matrix,
        "issue_clusters": len(clusters),
        "clusters": [c.to_json() for c in clusters],
    }
    store.write_json(store.exercise_dir(repo) / "environment.json", result)
    return result
