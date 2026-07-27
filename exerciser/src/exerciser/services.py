"""Environment synthesis — what a repo assumes is already running, provided.

:mod:`exerciser.service_doubles` is the runtime half: stand-ins for Postgres,
Redis and S3 that live inside the jail. This module is the planning half. It
answers two questions before a worker starts:

1. **Which services does this repo even need?** Read off the code, never
   configured by hand — an AST pass over the repo's imports, plus the DSNs its
   settings and environment name. A repo that touches no database gets no
   substitution and pays nothing for this machinery.

2. **What schema should the database already have?** The repair loop in the
   runtime can induce a workable schema from nothing but the errors a statement
   produces, and that is what makes this work on a repo nobody has ever seen.
   But induction is the FALLBACK, not the plan: where the repo declares its own
   schema — SQLAlchemy metadata, Django models, ``CREATE TABLE`` in a ``.sql``
   file or a migration — that declaration is exact and induction is a guess, so
   the declaration is applied first and induction only fills what remains.

The ordering is the whole point. Cheapest and most faithful first:

    repo's own ORM metadata  ->  repo's own DDL  ->  error-driven induction
                                                 ->  the agent channel

Each rung only handles what the rung above could not, so a repo with real
models pays nothing for induction, a repo with raw SQL pays nothing for the
agent, and a repo with neither still runs.
"""

from __future__ import annotations

import ast
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .agent_loop import AgentChannel, Question, question_key
from .service_doubles import KV_MODULES, OBJECTSTORE_MODULES, PEP249_DRIVERS

log = logging.getLogger(__name__)

#: Files to skip when scanning — vendored code is not this repo's requirement.
_SKIP_DIRS = frozenset(
    {
        ".git",
        ".venv",
        "venv",
        "node_modules",
        "__pycache__",
        "site-packages",
        ".tox",
        "build",
        "dist",
    }
)
_MAX_SCAN_FILES = 3000

SQL_FAMILY = "sql"
KV_FAMILY = "kv"
OBJECTSTORE_FAMILY = "objectstore"

_FAMILY_BY_MODULE: dict[str, str] = {}
for _name in PEP249_DRIVERS:
    _FAMILY_BY_MODULE[_name] = SQL_FAMILY
for _name in ("sqlalchemy", "sqlmodel", "django.db", "peewee", "tortoise", "databases", "alembic"):
    _FAMILY_BY_MODULE[_name] = SQL_FAMILY
for _name in KV_MODULES:
    _FAMILY_BY_MODULE[_name] = KV_FAMILY
for _name in OBJECTSTORE_MODULES + ("botocore", "aioboto3", "minio"):
    _FAMILY_BY_MODULE[_name] = OBJECTSTORE_FAMILY

#: A DSN in a settings file or a default argument is direct evidence that the
#: repo expects a server at that address, even when the import is indirect.
_DSN = re.compile(
    r"\b(postgres|postgresql|mysql|mariadb|redis|rediss|amqp|mongodb|s3|clickhouse)(\+\w+)?://[^\s\"']+",
    re.I,
)
_DSN_FAMILY = {
    "postgres": SQL_FAMILY,
    "postgresql": SQL_FAMILY,
    "mysql": SQL_FAMILY,
    "mariadb": SQL_FAMILY,
    "clickhouse": SQL_FAMILY,
    "redis": KV_FAMILY,
    "rediss": KV_FAMILY,
    "s3": OBJECTSTORE_FAMILY,
}


@dataclass
class ServiceRequirement:
    """One external service this repo expects to already be running."""

    family: str
    evidence: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {"family": self.family, "evidence": self.evidence[:8]}


@dataclass
class SchemaSource:
    """Where an exact schema declaration was found, and how to apply it."""

    kind: str  # "sqlalchemy-metadata" | "django-models" | "ddl"
    detail: str
    #: ``module:symbol`` for a metadata object the worker imports, or raw DDL.
    target: str = ""
    statements: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        out = {"kind": self.kind, "detail": self.detail}
        if self.target:
            out["target"] = self.target
        if self.statements:
            out["statements"] = self.statements
        return out


#: Scan-bound notes from the most recent planning pass. A bounded scan that
#: says nothing reads as "covered everything"; these land in the plan's
#: diagnostics so a hit cap is a visible fact, never a silent one.
_scan_notes: list[str] = []


def _python_files(repo: Path, limit: int = _MAX_SCAN_FILES) -> list[Path]:
    out: list[Path] = []
    for path in repo.rglob("*.py"):
        if any(part in _SKIP_DIRS for part in path.parts):
            continue
        out.append(path)
        if len(out) >= limit:
            _scan_notes.append(
                f"python scan stopped at the {limit}-file bound — service discovery "
                "may be incomplete for this repo"
            )
            break
    return out


def _module_names(tree: ast.AST) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name)
                names.add(alias.name.split(".", 1)[0])
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            names.add(node.module)
            names.add(node.module.split(".", 1)[0])
            for alias in node.names:
                names.add(f"{node.module}.{alias.name}")
    return names


def discover_requirements(repo: Path) -> list[ServiceRequirement]:
    """Which service families this repo's own code reaches for.

    Evidence is an import of a known client library or a DSN written down in
    the repo. Both are facts about the code, so this works on a repo the
    harness has never seen and needs nothing configured.
    """
    found: dict[str, ServiceRequirement] = {}

    def note(family: str, evidence: str) -> None:
        req = found.setdefault(family, ServiceRequirement(family))
        if evidence not in req.evidence:
            req.evidence.append(evidence)

    for path in _python_files(repo):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
            tree = ast.parse(text)
        except (OSError, SyntaxError, ValueError):
            continue
        rel = str(path.relative_to(repo))
        for name in _module_names(tree):
            family = _FAMILY_BY_MODULE.get(name)
            if family:
                note(family, f"{rel}: imports {name}")
        for match in _DSN.finditer(text):
            family = _DSN_FAMILY.get(match.group(1).lower())
            if family:
                note(family, f"{rel}: {match.group(1).lower()}:// DSN")

    for name in (
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
        "compose.yaml",
        ".env",
    ):
        path = repo / name
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for keyword, family in (
            ("postgres", SQL_FAMILY),
            ("mysql", SQL_FAMILY),
            ("mariadb", SQL_FAMILY),
            ("redis", KV_FAMILY),
            ("minio", OBJECTSTORE_FAMILY),
        ):
            if keyword in text.lower():
                note(family, f"{name}: declares {keyword}")

    return [found[k] for k in sorted(found)]


# ---------------------------------------------------------------------------
# Exact schema, where the repo declares it
# ---------------------------------------------------------------------------

_DDL = re.compile(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\"'`\[]?([A-Za-z_]\w*)", re.I)
_DDL_STATEMENT = re.compile(r"(CREATE\s+TABLE\b.*?;)", re.I | re.S)


def _is_declarative_base(node: ast.AST) -> bool:
    """``Base = declarative_base()`` or a ``DeclarativeBase`` subclass."""
    if isinstance(node, ast.Call):
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
        return name == "declarative_base"
    return False


def _module_path(repo: Path, path: Path) -> str:
    """Importable module name for ``path`` — from the PACKAGE boundary.

    Deriving from the repo root was reproduced producing ``src.myapp.models``
    for a ``src/`` layout, a name nothing can import: the worker puts source
    ROOTS on ``sys.path``, so the name must start at the outermost directory
    that still has an ``__init__.py``.
    """
    root = path.parent
    while root != repo and (root / "__init__.py").is_file():
        root = root.parent
    rel = path.relative_to(root).with_suffix("")
    parts = [part for part in rel.parts if part != "__init__"]
    return ".".join(parts)


def discover_schema_sources(repo: Path) -> list[SchemaSource]:
    """Exact schema declarations, in the order they should be applied.

    Nothing here guesses: a SQLAlchemy ``MetaData`` knows every table and
    column the repo defined, and a ``CREATE TABLE`` is the statement itself.
    Induction exists for repos that have neither, not as a substitute for
    reading what is written down.
    """
    sources: list[SchemaSource] = []

    for path in _python_files(repo):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, SyntaxError, ValueError):
            continue
        module = _module_path(repo, path)
        if not module:
            continue
        for node in ast.walk(tree):
            # ``Base = declarative_base()`` — the metadata hangs off it.
            if isinstance(node, ast.Assign) and _is_declarative_base(node.value):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        sources.append(
                            SchemaSource(
                                "sqlalchemy-metadata",
                                f"{path.name}: {target.id} = declarative_base()",
                                target=f"{module}:{target.id}.metadata",
                            )
                        )
            # ``class Base(DeclarativeBase)`` — SQLAlchemy 2.x spelling.
            elif isinstance(node, ast.ClassDef):
                for base in node.bases:
                    base_name = (
                        base.attr if isinstance(base, ast.Attribute) else getattr(base, "id", "")
                    )
                    if base_name == "DeclarativeBase":
                        sources.append(
                            SchemaSource(
                                "sqlalchemy-metadata",
                                f"{path.name}: class {node.name}(DeclarativeBase)",
                                target=f"{module}:{node.name}.metadata",
                            )
                        )
            # A bare ``metadata = MetaData()`` is the Core spelling.
            elif isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                func = node.value.func
                fname = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
                if fname == "MetaData":
                    for target in node.targets:
                        if isinstance(target, ast.Name):
                            sources.append(
                                SchemaSource(
                                    "sqlalchemy-metadata",
                                    f"{path.name}: {target.id} = MetaData()",
                                    target=f"{module}:{target.id}",
                                )
                            )

    sql_files: list[Path] = []
    for path in repo.rglob("*.sql"):
        # Filter BEFORE bounding: 200 vendored files under .venv/ were
        # reproduced consuming the entire budget while the repo's own
        # schema.sql was never read.
        if any(part in _SKIP_DIRS for part in path.parts):
            continue
        sql_files.append(path)
        if len(sql_files) >= 200:
            _scan_notes.append(
                "DDL scan stopped at the 200-file bound — some declared schema "
                "may not have been applied"
            )
            break
    for path in sql_files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        statements = [s.strip() for s in _DDL_STATEMENT.findall(text)]
        if statements:
            tables = sorted({t.lower() for t in _DDL.findall(text)})
            sources.append(
                SchemaSource(
                    "ddl",
                    f"{path.name}: {len(statements)} CREATE TABLE ({', '.join(tables[:6])})",
                    statements=statements[:200],
                )
            )

    # Stable, de-duplicated, metadata before raw DDL (an ORM declaration is
    # richer than the DDL a migration happened to leave lying around).
    seen: set[str] = set()
    ordered: list[SchemaSource] = []
    for source in sorted(sources, key=lambda s: (s.kind != "sqlalchemy-metadata", s.detail)):
        key = source.target or source.detail
        if key in seen:
            continue
        seen.add(key)
        ordered.append(source)
    return ordered


# ---------------------------------------------------------------------------
# The plan the worker executes
# ---------------------------------------------------------------------------


@dataclass
class ServicePlan:
    """Everything a worker needs to synthesise this repo's environment."""

    requirements: list[ServiceRequirement] = field(default_factory=list)
    schema_sources: list[SchemaSource] = field(default_factory=list)
    seed_rows: int = 1
    enabled: bool = True
    diagnostics: list[str] = field(default_factory=list)

    @property
    def needed(self) -> bool:
        return self.enabled and bool(self.requirements)

    def to_json(self) -> dict[str, Any]:
        out = {
            "version": 1,
            "enabled": self.enabled,
            "seed_rows": self.seed_rows,
            "requirements": [r.to_json() for r in self.requirements],
            "schema_sources": [s.to_json() for s in self.schema_sources],
        }
        if self.diagnostics:
            out["diagnostics"] = self.diagnostics
        return out


def plan_services(repo: Path, *, enabled: bool = True, seed_rows: int = 1) -> ServicePlan:
    """Read the repo and decide what environment to synthesise for it."""
    if not enabled:
        return ServicePlan(enabled=False)
    _scan_notes.clear()
    requirements = discover_requirements(repo)
    sources = (
        discover_schema_sources(repo) if any(r.family == SQL_FAMILY for r in requirements) else []
    )
    return ServicePlan(
        requirements=requirements,
        schema_sources=sources,
        seed_rows=seed_rows,
        diagnostics=list(dict.fromkeys(_scan_notes)),
    )


# ---------------------------------------------------------------------------
# Fixtures the structure could not supply — one cached question each
# ---------------------------------------------------------------------------

FIXTURE_TOPIC = "fixture"


def fixture_questions(
    repo: Path,
    induced: list[dict[str, Any]],
    *,
    channel: AgentChannel | None = None,
    max_new: int = 10,
) -> tuple[AgentChannel, list[dict[str, Any]]]:
    """Raise one cached question per INDUCED table, and apply the answers.

    Induction gets the code running; it does not get the data right, because
    nothing in a missing-table error says what a row should plausibly contain.
    That is a question about intent, so it goes through the same channel every
    other intent question uses — deduplicated by shape, cached forever, and
    budgeted — rather than through a model call per run.

    Returns the channel and the fixtures that are already ANSWERED, so the
    caller can apply them without waiting on the pending ones.
    """
    channel = channel or AgentChannel(repo, FIXTURE_TOPIC, max_new=max_new)
    answered: list[dict[str, Any]] = []
    for entry in induced:
        table = str(entry.get("table") or "")
        if not table:
            continue
        columns = [str(c) for c in (entry.get("columns") or [])]
        subject = f"{table}({', '.join(sorted(columns))})"
        key = question_key(FIXTURE_TOPIC, subject)
        answer = channel.ask(
            Question(
                key=key,
                topic=FIXTURE_TOPIC,
                subject=subject,
                prompt=(
                    f"The repo reads a table `{table}` with columns "
                    f"{sorted(columns) or ['(none observed)']}, but nothing in the repo "
                    "declares its schema, so the harness induced it from the failing "
                    "SQL and seeded placeholder values. Give one or more rows that are "
                    "REPRESENTATIVE of what this table holds in production, so the code "
                    "paths that read it are exercised with plausible data. Use only the "
                    "columns listed. If placeholder data is already adequate, say so."
                ),
                reply_schema=('{"rows": [{"<column>": <value>, ...}], "adequate": true|false}'),
                context={"table": table, "columns": sorted(columns)},
            )
        )
        if isinstance(answer, dict) and answer.get("rows"):
            answered.append({"table": table, "rows": answer["rows"]})
    return channel, answered


def answered_fixtures(repo: Path) -> list[dict[str, Any]]:
    """Fixture answers already on disk, WITHOUT asking anything new.

    Called at sandbox-preparation time so the plan carries every answered
    fixture into the jail; the asking side (``fixture_questions``) runs after
    the run, from what induction actually saw.
    """
    from . import store

    doc = store.read_json(store.exercise_dir(repo) / f"agent_{FIXTURE_TOPIC}.json") or {}
    out: list[dict[str, Any]] = []
    for entry in (doc.get("questions") or {}).values():
        if not isinstance(entry, dict):
            continue
        answer = entry.get("answer")
        table = (entry.get("context") or {}).get("table")
        if isinstance(answer, dict) and answer.get("rows") and table:
            out.append({"table": table, "rows": answer["rows"]})
    return out


def apply_fixtures(db_path: Path, fixtures: list[dict[str, Any]]) -> int:
    """Insert answered fixture rows into a substitute database. Returns rows."""
    import sqlite3

    if not fixtures or not db_path.exists():
        return 0
    written = 0
    with sqlite3.connect(db_path) as conn:
        for fixture in fixtures:
            table = str(fixture.get("table") or "")
            if not re.fullmatch(r"[A-Za-z_]\w*", table):
                continue
            existing = {r[1].lower() for r in conn.execute(f'PRAGMA table_info("{table}")')}
            if not existing:
                continue
            for row in fixture.get("rows") or []:
                if not isinstance(row, dict):
                    continue
                cols = [c for c in row if isinstance(c, str) and c.lower() in existing]
                if not cols:
                    continue
                placeholders = ", ".join("?" for _ in cols)
                quoted = ", ".join(f'"{c}"' for c in cols)
                try:
                    conn.execute(
                        f'INSERT INTO "{table}" ({quoted}) VALUES ({placeholders})',
                        [row[c] for c in cols],
                    )
                    written += 1
                except sqlite3.Error:
                    continue
        conn.commit()
    return written


def summarise(plan_doc: dict[str, Any], runtime_summary: dict[str, Any] | None) -> dict[str, Any]:
    """The run document's view: what was synthesised, and where it fell short.

    ``plan_doc`` is the plan JSON the worker actually consumed (read back from
    the sandbox tree), so the summary describes THIS run rather than a fresh
    re-scan. ``substitution_gaps`` and ``error`` are top-level on purpose: a
    statement the stand-in could not honour — or an install that never
    happened — is a limit of the HARNESS, and burying either would turn the
    harness's own shortfall into an apparent property of the repo.
    """
    runtime = runtime_summary or {}
    out = {
        "enabled": bool(plan_doc.get("enabled", True)),
        "requirements": plan_doc.get("requirements") or [],
        "schema_sources": plan_doc.get("schema_sources") or [],
        "exact_schema": bool(plan_doc.get("schema_sources")),
        "substituted": runtime.get("substituted", 0),
        "declared_schema": runtime.get("declared_schema", 0),
        "induced_schema": runtime.get("induced_schema", 0),
        "seeded_rows": runtime.get("seeded_rows", 0),
        "fixture_rows": runtime.get("fixture_rows", 0),
        "substitution_gaps": runtime.get("substitution_gaps", 0),
        "events": runtime.get("events", [])[:50],
        "events_total": len(runtime.get("events", [])),
    }
    diagnostics: list[str] = list(plan_doc.get("diagnostics") or [])
    if runtime.get("error"):
        out["error"] = runtime["error"]
        diagnostics.append(
            f"service doubles did not install — every service-backed target in this run "
            f"failed to connect for the HARNESS's reasons, not the repo's: {runtime['error']}"
        )
    if out["substitution_gaps"]:
        diagnostics.append(
            f"{out['substitution_gaps']} statement(s) the service substitute could not honour "
            "— recorded as harness gaps, excluded from defect verdicts"
        )
    if diagnostics:
        out["diagnostics"] = diagnostics
    return out
