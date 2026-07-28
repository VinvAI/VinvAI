"""How this repo expects to be run — read from what it already declares.

Every oracle spawned its worker with ``cwd=repo``, and a repo's relative paths
resolve against the working directory, so that choice silently decides what the
code under test reads. It was never a decision: five call sites hardcoded it and
nothing modelled "where is this meant to run from" as a question at all.

demo-fastapi answers that question **twice**, in machine-readable form, and
neither answer was consulted:

* ``.github/workflows/test-backend.yml`` — ``working-directory: backend``
* ``backend/Dockerfile`` — ``WORKDIR /app/backend/``, with compose's
  ``context: .`` mapping the repo root onto ``/app``

Its settings then declare ``env_file="../.env"``, relative because the app runs
from ``backend/``. Started at the repo root instead, ``../.env`` resolved
outside the repo entirely, every required setting was missing, 14 of 15 modules
failed to import, and the engine reported fifteen defects in a clean repo.

**What this module does NOT do is decide.** A list of places to read a
declaration from is a list, and a list only ever covers the build systems
someone thought of — Bazel, Nix, Earthly, a shell script or a sentence in a
README are all equally valid ways for a project to say where it runs, and
enumerating them does not converge. Any design that has to recognise the
mechanism fails on the next repo.

So these are HINTS that order an empirical search, and the search is what
settles it: ``functions.candidate_workdirs`` puts these first, the distribution
that owns the file next, and the repo root last, and then the worker is RUN
from each in turn until the module actually imports. That is the discipline the
rest of the engine already uses — ``containment`` ("the answer comes from a
PROBE, never from the presence of a binary on PATH"), ``interpreter`` for
candidate interpreters, ``service_doubles.induce`` for schema: act, read the
failure, try the next thing, converge.

The consequence worth stating plainly: a repo that declares nothing this module
recognises is still handled correctly, because being unable to read a project's
automation is not the same as being unable to run its code. What the hints buy
is speed — the right directory first, so the retry is usually never paid.

The sources happen to be easy to read, and that is their only claim:

* CI ``working-directory:``, the strongest, because it is literally "how this
  project runs its own code", written by the people who know;
* ``WORKDIR`` in a Dockerfile, mapped back through the build context that says
  which host directory the image root corresponds to;
* ``Procfile`` / Makefile / justfile recipes that ``cd`` before running;
* ``[tool.pytest.ini_options] testpaths``.

Every claim carries its source, so a chosen directory is auditable from the run
summary rather than being a silent default.
"""

from __future__ import annotations

import logging
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import store
from .agent_loop import AgentChannel, Question, question_key
from .redact import is_secret_key, redact_text

log = logging.getLogger(__name__)

#: Bounded so a repo with a large `.github` tree cannot make discovery expensive.
_MAX_FILES_PER_SOURCE = 40

#: Ranked. A repo that both runs CI from `backend` and builds an image with a
#: different WORKDIR is telling us two things; CI is about running THIS
#: checkout, while a Dockerfile describes a built image whose layout may not
#: mirror the source tree at all.
_SOURCE_RANK = {
    "ci-working-directory": 0,
    "procfile": 1,
    "make-recipe": 1,
    "pytest-testpaths": 2,
    "dockerfile-workdir": 3,
}


@dataclass(frozen=True)
class WorkdirClaim:
    """One repo-relative directory the project says it runs from, and where it said so."""

    path: str
    source: str
    detail: str = ""

    @property
    def rank(self) -> int:
        return _SOURCE_RANK.get(self.source, 9)

    def to_json(self) -> dict[str, str]:
        return {"path": self.path, "source": self.source, "detail": self.detail}


def _rel(repo: Path, candidate: Path) -> str | None:
    """``candidate`` as a repo-relative directory, or None when it escapes the repo."""
    try:
        resolved = candidate.resolve()
        rel = resolved.relative_to(repo.resolve()).as_posix()
    except (OSError, ValueError):
        return None
    if not resolved.is_dir():
        return None
    return rel or "."


def _yaml_scalars(text: str, key: str) -> list[str]:
    """Values of ``key:`` in a YAML-ish document, without a YAML dependency.

    Deliberately a line scan rather than a parser: this reads two specific keys
    out of CI and compose files, a full YAML dependency for that is not worth
    it, and a file this cannot parse contributes nothing rather than raising.
    """
    out: list[str] = []
    pattern = re.compile(rf"^\s*{re.escape(key)}\s*:\s*(?P<v>[^\s#][^#\n]*?)\s*(?:#.*)?$")
    for line in text.splitlines():
        found = pattern.match(line)
        if found:
            out.append(found.group("v").strip().strip("'\""))
    return out


def _ci_workdirs(repo: Path) -> list[WorkdirClaim]:
    """``working-directory:`` from GitHub Actions / GitLab CI."""
    claims: list[WorkdirClaim] = []
    files: list[Path] = []
    for pattern in (".github/workflows/*.yml", ".github/workflows/*.yaml", ".gitlab-ci.yml"):
        files.extend(sorted(repo.glob(pattern))[:_MAX_FILES_PER_SOURCE])
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for raw in _yaml_scalars(text, "working-directory"):
            # A CI expression (`${{ ... }}`) is not a path we can resolve.
            if "$" in raw:
                continue
            rel = _rel(repo, repo / raw)
            if rel:
                claims.append(
                    WorkdirClaim(rel, "ci-working-directory", path.relative_to(repo).as_posix())
                )
    return claims


def _dockerfile_workdirs(repo: Path) -> list[WorkdirClaim]:
    """``WORKDIR`` mapped back through the compose build context.

    A Dockerfile's ``WORKDIR /app/backend`` is a path inside the IMAGE. It only
    names a host directory once the build context says which host directory the
    image was built from — compose's ``context: .`` plus ``COPY . /app`` means
    ``/app`` is the repo root, so ``/app/backend`` is ``<repo>/backend``. The
    mapping is recovered from the longest ``COPY``/``ADD`` of the context root.
    """
    claims: list[WorkdirClaim] = []
    for path in sorted(repo.rglob("Dockerfile*"))[:_MAX_FILES_PER_SOURCE]:
        try:
            parts = path.relative_to(repo).parts
        except ValueError:
            continue
        if any(p in store.SKIP_DIRS for p in parts):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        image_roots: list[str] = []
        for line in text.splitlines():
            copy = re.match(r"^\s*(?:COPY|ADD)\s+(?:--\S+\s+)*\.\s+(?P<dest>\S+)", line, re.I)
            if copy:
                image_roots.append(copy.group("dest").rstrip("/") or "/")
        workdirs = [
            m.group("d").strip().strip("'\"")
            for m in (
                re.match(r"^\s*WORKDIR\s+(?P<d>\S+)", line, re.I) for line in text.splitlines()
            )
            if m
        ]
        if not workdirs:
            continue
        final = workdirs[-1].rstrip("/") or "/"
        for image_root in sorted(image_roots, key=len, reverse=True):
            if final == image_root:
                sub = ""
            elif final.startswith(image_root + "/"):
                sub = final[len(image_root) + 1 :]
            else:
                continue
            rel = _rel(repo, repo / sub if sub else repo)
            if rel:
                claims.append(
                    WorkdirClaim(rel, "dockerfile-workdir", path.relative_to(repo).as_posix())
                )
            break
    return claims


_CD_RE = re.compile(r"\bcd\s+(?P<dir>[A-Za-z0-9_./-]+)\s*(?:&&|;)")


def _cd_workdirs(repo: Path) -> list[WorkdirClaim]:
    """Directories a Procfile / Makefile / justfile recipe ``cd``s into before running."""
    claims: list[WorkdirClaim] = []
    for name, source in (
        ("Procfile", "procfile"),
        ("Makefile", "make-recipe"),
        ("makefile", "make-recipe"),
        ("justfile", "make-recipe"),
        ("Justfile", "make-recipe"),
    ):
        path = repo / name
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for found in _CD_RE.finditer(text):
            rel = _rel(repo, repo / found.group("dir"))
            if rel and rel != ".":
                claims.append(WorkdirClaim(rel, source, name))
    return claims


def _pytest_workdirs(repo: Path) -> list[WorkdirClaim]:
    """``testpaths`` names where a project's own tests are rooted."""
    claims: list[WorkdirClaim] = []
    for path in sorted(repo.rglob("pyproject.toml"))[:_MAX_FILES_PER_SOURCE]:
        try:
            parts = path.parent.relative_to(repo).parts
        except ValueError:
            continue
        if any(p in store.SKIP_DIRS for p in parts):
            continue
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, ValueError):
            continue
        tool = data.get("tool") if isinstance(data.get("tool"), dict) else {}
        pytest_cfg = tool.get("pytest") if isinstance(tool.get("pytest"), dict) else {}
        ini = pytest_cfg.get("ini_options") if isinstance(pytest_cfg, dict) else None
        if not isinstance(ini, dict) or not ini.get("testpaths"):
            continue
        rel = _rel(repo, path.parent)
        if rel:
            claims.append(WorkdirClaim(rel, "pytest-testpaths", path.relative_to(repo).as_posix()))
    return claims


def declared_workdirs(repo: Path) -> list[WorkdirClaim]:
    """Every working directory this repo declares, best source first.

    Deduplicated on ``(path, source)`` and ordered by source rank then depth, so
    the answer is deterministic and a reader can see WHY it was chosen.
    """
    claims: list[WorkdirClaim] = []
    for gather in (_ci_workdirs, _cd_workdirs, _pytest_workdirs, _dockerfile_workdirs):
        try:
            claims.extend(gather(repo))
        except OSError:  # pragma: no cover - unreadable tree
            continue
    seen: set[tuple[str, str]] = set()
    unique: list[WorkdirClaim] = []
    for claim in claims:
        key = (claim.path, claim.source)
        if key in seen:
            continue
        seen.add(key)
        unique.append(claim)
    return sorted(unique, key=lambda c: (c.rank, -len(Path(c.path).parts), c.path))


def workdir_claims_for(
    repo: Path,
    rel_file: str,
    claims: list[WorkdirClaim] | None = None,
) -> list[WorkdirClaim]:
    """Every declared working directory containing ``rel_file``, best first.

    A LIST, not a winner. These are hints that order an empirical search — the
    sources below are the ones that happen to be easy to read, never a claim to
    have enumerated how projects state their layout. A repo built with Bazel,
    Nix or a shell script contributes nothing here and is still handled, because
    what settles the question is whether the module imports.
    """
    candidates = declared_workdirs(repo) if claims is None else claims
    target = Path(rel_file).as_posix()
    containing = [
        c for c in candidates if c.path == "." or target.startswith(c.path.rstrip("/") + "/")
    ]
    return sorted(containing, key=lambda c: (c.rank, -len(Path(c.path).parts), c.path))


def workdir_for(
    repo: Path,
    rel_file: str,
    claims: list[WorkdirClaim] | None = None,
) -> WorkdirClaim | None:
    """The best declared working directory that CONTAINS ``rel_file``, if any.

    Containment is the whole test. A repo may declare several — ``backend`` for
    the API and ``frontend`` for the UI — and the one that applies to a module
    is the one the module lives under. A claim that does not contain the file
    says nothing about it, and the deepest containing claim wins for the same
    reason the deepest distribution does.
    """
    candidates = declared_workdirs(repo) if claims is None else claims
    target = Path(rel_file).as_posix()
    best: WorkdirClaim | None = None
    for claim in candidates:
        if claim.path != "." and not target.startswith(claim.path.rstrip("/") + "/"):
            continue
        if best is None:
            best = claim
            continue
        # Rank first (CI beats a Dockerfile), then depth.
        if (claim.rank, -len(Path(claim.path).parts)) < (
            best.rank,
            -len(Path(best.path).parts),
        ):
            best = claim
    return best


# =========================================================================
# Environment: what the repo provides, then what its own failures ask for
# =========================================================================
#
# Same discipline as the working directory, and as `service_doubles.induce`
# before it: the repo's declarations are a STARTING POINT, and what settles the
# question is running the code and reading its complaint.
#
# A list of config mechanisms to understand — pydantic-settings, environs,
# django.conf, dynaconf, plain `os.environ` — is a list, and it goes stale the
# week someone writes another one. But every one of them fails the same way:
# the process raises, and the message names what it wanted. That message is the
# interface, it is written by the library the repo actually uses, and it needs
# no registry of libraries to read.

#: Shapes in which a program says "I needed this and did not get it".
#:
#: Not a catalogue of config libraries — a catalogue of the ways a MISSING NAME
#: appears in an exception message, which is a much smaller and much more stable
#: set. `KeyError: 'X'` from `os.environ[...]` is the stdlib's spelling; the
#: `field required` line is what a validating settings object prints above the
#: offending name; the rest are the plain-English forms.
_MISSING_ENV = (
    # `KeyError: 'DATABASE_URL'` — os.environ subscript, the stdlib spelling.
    re.compile(r"KeyError:?\s*['\"]([A-Z][A-Z0-9_]{2,})['\"]"),
    # A validating settings object lists the field, then why, on the next line.
    re.compile(r"^\s*([A-Z][A-Z0-9_]{2,})\s*$\n\s*(?:Field|Value) required", re.M),
    # "environment variable X is not set" / "X environment variable not set"
    re.compile(
        r"(?:variable|env(?:ironment)?)\s+['\"]?([A-Z][A-Z0-9_]{2,})['\"]?\s+"
        r"(?:is\s+)?(?:not\s+set|missing|required)",
        re.I,
    ),
    re.compile(r"['\"]?([A-Z][A-Z0-9_]{2,})['\"]?\s+environment variable", re.I),
    # "Missing X" / "X must be set"
    re.compile(r"[Mm]issing\s+(?:required\s+)?['\"]?([A-Z][A-Z0-9_]{2,})['\"]?"),
    re.compile(r"['\"]?([A-Z][A-Z0-9_]{2,})['\"]?\s+must be set", re.I),
)

#: Names that are the RUNTIME's, not the repo's. Setting these would change what
#: the interpreter itself does, which is not configuration of the target.
_NEVER_SYNTHESIZE = frozenset(
    {
        "PATH",
        "PYTHONPATH",
        "PYTHONHOME",
        "HOME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
        "VIRTUAL_ENV",
    }
)

#: The value ladder. A settings object does not merely want A value, it wants
#: one its validator accepts, and the validator says so on the next round — so
#: the shapes escalate on the target's own complaint rather than on a guess
#: about what a name means. Name-based guessing ("it is called *_URL so give it
#: a URL") is exactly the hardcoding this avoids: the same field is spelled
#: `DSN`, `ENDPOINT`, `*_URI` and `SERVER` across four projects, and the
#: validator is the only thing that knows.
#: The email is deliberately NOT at an RFC 2606 reserved domain. `.invalid`,
#: `.test` and `example.com` read as the obviously-fake choice, and
#: `email-validator` — what pydantic's `EmailStr` uses — REFUSES special-use
#: domains outright. Found live on demo-fastapi: the ladder reached the email
#: rung, `vinv@example.invalid` was rejected as "a special-use or reserved
#: name", and the run stalled one step from succeeding.
_VALUE_LADDER = (
    "vinv-placeholder",
    "0",
    "http://127.0.0.1:1",
    "vinv@vinvharness.com",
    "postgresql://vinv:vinv@127.0.0.1:1/vinv",
    "/tmp/vinv-placeholder",
    "[]",
)


def missing_env_names(error_text: str) -> list[str]:
    """Environment names an error message says were wanted and absent.

    Deduplicated, order-preserving. Runtime names are never returned: a target
    complaining about ``PATH`` is not asking to be configured.
    """
    found: list[str] = []
    for pattern in _MISSING_ENV:
        for match in pattern.finditer(error_text or ""):
            name = match.group(1)
            # The patterns spell the name as `[A-Z][A-Z0-9_]{2,}`, but the ones
            # carrying `re.I` — needed so "Environment variable" matches
            # "environment variable" — make that class case-insensitive too, and
            # the surrounding English words start matching as names. Checked
            # here rather than by dropping `re.I`, because the prose around the
            # name genuinely varies in case and the NAME genuinely does not.
            if not name.isupper():
                continue
            if name in _NEVER_SYNTHESIZE or name in found:
                continue
            found.append(name)
    return found


def next_value(current: str | None) -> str | None:
    """The next shape to try for a value the target rejected, or None when spent."""
    if current is None:
        return _VALUE_LADDER[0]
    try:
        index = _VALUE_LADDER.index(current)
    except ValueError:
        return None
    return _VALUE_LADDER[index + 1] if index + 1 < len(_VALUE_LADDER) else None


#: Files a project uses to SHOW what its environment looks like. `.env` itself
#: is included and ranked first: it is the real one, and a repo that ships it
#: has already answered the question. The `.example`/`.template`/`.sample`
#: variants exist precisely to be read by someone setting the project up, which
#: is exactly what the harness is doing.
_ENV_FILES = (
    ".env",
    ".env.local",
    ".env.example",
    ".env.template",
    ".env.sample",
    ".env.defaults",
    ".env.test",
    "env.example",
)

_ENV_LINE = re.compile(r"^\s*(?:export\s+)?(?P<k>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?P<v>.*?)\s*$")


def _parse_env_file(text: str) -> dict[str, str]:
    """``KEY=value`` pairs, comments and blanks dropped, quotes stripped."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        found = _ENV_LINE.match(line)
        if not found:
            continue
        value = found.group("v")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        # An unexpanded reference (`${OTHER}`) is not a value.
        if value.startswith("$"):
            continue
        out[found.group("k")] = value
    return out


def declared_env(repo: Path, workdir: Path | None = None) -> dict[str, str]:
    """Environment the repo itself publishes, nearest the working directory first.

    A repo that ships a ``.env.example`` has already written down every name its
    code needs and a plausible value for each — which is the whole question,
    answered by the people who know, at no cost and with no model call. Reading
    it is not a substitute for the induction loop below; it is what usually makes
    the loop unnecessary.

    Values already present in the real environment always win: a developer who
    exported ``DATABASE_URL`` meant it.
    """
    collected: dict[str, str] = {}
    roots: list[Path] = []
    if workdir is not None:
        roots.append(workdir)
        roots.append(workdir.parent)
    roots.append(repo)
    for root in roots:
        for name in _ENV_FILES:
            path = root / name
            if not path.is_file():
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for key, value in _parse_env_file(text).items():
                collected.setdefault(key, value)
    return collected


def unsatisfied_names(error_text: str, supplied: dict[str, str]) -> list[str]:
    """Of the values the harness supplied, which the target is still rejecting.

    The precise thing an agent or a human has to be asked for. A run that stalls
    with "FIRST_SUPERUSER is not a valid email address" knows exactly which
    variable defeated the ladder, and passing that on beats reporting the whole
    module as broken — the code is fine, one value is not.
    """
    return sorted(name for name in supplied if name in (error_text or ""))


# =========================================================================
# Escalation — the harness first, the human last
# =========================================================================
#
# The ladder is deliberately shallow. It exists to get past a validator that
# wants *a* well-shaped value, not to invent a value that is CORRECT — and
# there are two failures it can never resolve on its own:
#
#   * a value with real-world meaning (an account id, a region, a project slug)
#     that only the repo's own documentation or its author knows;
#   * a credential, which nothing may synthesise, ever.
#
# Both escalate, and in that order. The coding harness goes first because it can
# read the README, the docs and the provider's own site, and answering from
# those costs the user nothing. Only what the harness cannot supply reaches a
# human, and it reaches them as a described field rather than a stack trace.

CONFIG_TOPIC = "config"


def config_question(name: str, *, modules: list[str], reason: str, tried: list[str]) -> Question:
    """One cached, budgeted question asking the harness for a value.

    Keyed by the VARIABLE, not by the failure text, so the same answer is reused
    across every module that needs it and across later runs — the whole point of
    the channel. A repo needing eight variables asks eight questions once, not
    eight per module per run.
    """
    return Question(
        key=question_key(CONFIG_TOPIC, name),
        topic=CONFIG_TOPIC,
        subject=name,
        prompt=(
            f"The environment variable `{name}` has to be set before this repo's code "
            f"can be imported — {len(modules)} module(s) fail without it, including "
            f"{', '.join(modules[:3])}. The harness supplied placeholder values "
            f"({', '.join(tried) or 'none'}) and the target rejected them:\n\n"
            f"{reason[:600]}\n\n"
            "Read the repo's own README, .env.example, settings class or docs and give a "
            "value that is VALID for local, offline use — it will run inside a sandbox "
            "with no network. Never invent a real credential: if this variable is a "
            "secret, say so and leave `value` null, and the user will be asked instead."
        ),
        reply_schema=(
            '{"value": "<string>"|null, "is_secret": true|false, '
            '"description": "<what this variable is, in one sentence>", '
            '"example": "<a well-formed example>"|null}'
        ),
        context={"variable": name, "modules": modules[:20], "tried": tried},
    )


def _describe(name: str, answer: Any) -> dict[str, Any]:
    """Whatever the harness managed to say about a variable, defensively read."""
    if not isinstance(answer, dict):
        return {}
    return {
        k: answer.get(k)
        for k in ("value", "is_secret", "description", "example")
        if answer.get(k) is not None
    }


def build_config_requests(
    repo: Path,
    unresolved: dict[str, dict[str, Any]],
    *,
    channel: AgentChannel | None = None,
    max_new: int = 25,
) -> tuple[AgentChannel, dict[str, str], list[dict[str, Any]]]:
    """Ask the harness for every unresolved variable; escalate what it cannot give.

    Returns ``(channel, answered, requests)``:

    * ``answered`` — values the harness supplied, ready to feed straight back
      into the next run's environment;
    * ``requests`` — the ones a human has to provide, each carrying enough to
      RENDER an input rather than to debug a stack trace: what it is, an example
      of a well-formed value, whether it is a secret (so the field masks and the
      value never reaches a log), which modules are blocked, and what was already
      tried.

    A credential is never in ``answered`` even if the harness returned one:
    ``is_secret`` routes it to the human unconditionally. A model that helpfully
    hallucinates an API key must not be able to get it used.
    """
    channel = channel or AgentChannel(repo, CONFIG_TOPIC, max_new=max_new)
    answered: dict[str, str] = {}
    requests: list[dict[str, Any]] = []

    for name, detail in sorted(unresolved.items()):
        modules = [str(m) for m in (detail.get("modules") or [])]
        reason = redact_text(str(detail.get("reason") or ""))
        tried = [str(t) for t in (detail.get("tried") or [])]
        answer = channel.ask(config_question(name, modules=modules, reason=reason, tried=tried))
        described = _describe(name, answer)
        secret = bool(described.get("is_secret")) or is_secret_key(name)
        value = described.get("value")

        if value is not None and not secret:
            answered[name] = str(value)
            continue

        requests.append(
            {
                "variable": name,
                # Everything a field needs to render itself.
                "secret": secret,
                "description": described.get("description")
                or f"Required before {modules[0] if modules else 'this repo'} can be imported.",
                "example": described.get("example"),
                "blocked_modules": modules[:20],
                "blocked_count": len(modules),
                "tried": tried,
                "reason": reason[:400],
                "status": "awaiting-harness" if not described else "awaiting-user",
            }
        )
    return channel, answered, requests


def config_requests_path(repo: Path) -> Path:
    return store.exercise_dir(repo) / "config_requests.json"


def answers_path(repo: Path) -> Path:
    return store.exercise_dir(repo) / "config_answers.json"


def write_config_requests(repo: Path, requests: list[dict[str, Any]]) -> Path:
    """Publish what a human still has to supply, for the extension to render.

    Written even when EMPTY, so the UI can distinguish "nothing is being asked
    of you" from "the last run never got this far" — a stale prompt asking for a
    variable that is now satisfied is worse than no prompt.
    """
    path = config_requests_path(repo)
    store.write_json(
        path,
        {
            "version": 1,
            "repo": str(repo),
            "answers_path": str(answers_path(repo)),
            "requests": requests,
        },
    )
    return path


def read_config_answers(repo: Path) -> dict[str, str]:
    """Values a human supplied, read back on the next run.

    The write-back file is the contract with the UI: the extension collects the
    fields, writes ``{"answers": {"NAME": "value"}}``, and re-runs. Values are
    read into the worker's environment and never copied into any artifact —
    ``config_requests.json`` carries the QUESTION, never the answer.
    """
    doc = store.read_json(answers_path(repo)) or {}
    answers = doc.get("answers")
    if not isinstance(answers, dict):
        return {}
    return {str(k): str(v) for k, v in answers.items() if v is not None}


def answered_config(repo: Path) -> dict[str, str]:
    """Values the HARNESS answered on the config channel, without asking anything new.

    Read at the start of a run, the way ``services.answered_fixtures`` is: the
    asking happens after the run, from what actually failed, and the answers are
    picked up by the run after that.
    """
    doc = store.read_json(store.exercise_dir(repo) / f"agent_{CONFIG_TOPIC}.json") or {}
    out: dict[str, str] = {}
    for entry in (doc.get("questions") or {}).values():
        if not isinstance(entry, dict):
            continue
        answer = entry.get("answer")
        name = (entry.get("context") or {}).get("variable")
        if not isinstance(answer, dict) or not name:
            continue
        # A secret never comes back through the agent channel, whatever the
        # model said — those go to the human and arrive via `config_answers`.
        if answer.get("is_secret") or is_secret_key(str(name)):
            continue
        value = answer.get("value")
        if value is not None:
            out[str(name)] = str(value)
    return out
