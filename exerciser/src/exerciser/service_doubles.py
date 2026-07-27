"""In-jail stand-ins for the services a repo expects to already be running.

A large share of any real repo's code is unreachable without a Postgres on
5432, a Redis on 6379, or an S3 endpoint. Under containment the network is
denied, so those targets fail to connect and land as ``contained`` — correctly
not reported as defects, but not exercised either. Weakening the sandbox to let
them out is the wrong trade: it buys coverage with the guarantee. The move here
is the other one — **remove the need for the service** by substituting it
inside the jail, so containment stays maximal AND the code path runs.

Where to substitute is the whole design question, and the answer that scales is
to cut at an interface that is a STANDARD rather than at a wire protocol:

* **PEP 249 (DB-API 2.0)** is a specification. ``connect() -> Connection ->
  cursor() -> execute()/fetchall()`` is the same shape in psycopg, psycopg2,
  pymysql, MySQLdb, cx_Oracle and every other conforming driver, so ONE
  sqlite-backed adapter serves the whole family — present or absent, since a
  driver that is not installed is served by the same object through a
  ``sys.meta_path`` finder.
* **SQLAlchemy URLs** are a standard too: rewriting ``postgresql://…`` to a
  jail-local ``sqlite:///…`` covers SQLAlchemy and therefore everything built
  on it, including Django's ``DATABASES`` by the same substitution.
* **redis-py and boto3** have no PEP, but their command surfaces are just data
  structures — a keyspace and an object store — and are implemented here
  directly over a dict and a directory.

Fidelity is bounded and saying so is part of the design. A statement the
substitute cannot honour (a dialect-specific construct sqlite rejects) is
recorded as a SUBSTITUTION GAP and never as a defect in the repo: the harness's
whole three-value discipline — ok / rejected / defect — gains a fourth value
rather than quietly mislabelling its own limitation as someone else's bug.

The second half is schema. A function that needs a populated table gets an
empty database and raises on the missing table, which is a fixture problem
wearing a defect's clothes. ``induce`` closes that with an error-driven repair
loop: run the statement, read the substitute's own complaint (``no such table:
users``, ``no such column: users.email``), extend the schema from what the
failing SQL itself mentions, retry. It converges in a bounded number of rounds,
it needs no knowledge of the repo whatsoever, and it composes with the exact
sources that are better when they exist — the repo's own ORM metadata and DDL,
applied first by :mod:`exerciser.services` before a single statement runs.

This module is deliberately DEPENDENCY-FREE and imports nothing from the rest
of the package: it is copied into the sandbox's shim directory and imported by
the generated ``sitecustomize``, inside a worker that has only the standard
library and the repo on its path. That also makes it directly unit-testable in
the parent process, which is why the behaviour below is pinned by tests rather
than by inspection of a string literal.
"""

from __future__ import annotations

import builtins
import json
import os
import re
import sqlite3
import sys
import types
from typing import Any

# ---------------------------------------------------------------------------
# Ledger — every substitution and every fidelity gap is written down
# ---------------------------------------------------------------------------

#: A statement the substitute could not honour. NEVER a defect in the repo.
FIDELITY_GAP = "substitution-gap"
#: A service call served by a stand-in instead of the real thing.
SUBSTITUTED = "substituted"
#: Schema the repair loop had to invent because nothing declared it.
INDUCED = "induced-schema"
#: A row the harness seeded so a read path had something to read.
SEEDED = "seeded-row"
#: An agent-supplied fixture row applied in place of placeholder seeding.
FIXTURE_APPLIED = "fixture-row"
#: Schema the repo itself declared, applied before anything ran.
DECLARED = "declared-schema"

#: How many repair rounds one statement may drive. The loop only ever ADDS
#: schema, so it is monotone and terminates on its own; the cap is a guard
#: against a pathological statement, not the mechanism that makes it converge.
MAX_REPAIR_ROUNDS = 12

_events: list[dict[str, Any]] = []
_ledger_path: str = ""
_flushed = 0


def _record(kind: str, service: str, detail: str, **extra: Any) -> None:
    entry = {"kind": kind, "service": service, "detail": detail[:400]}
    entry.update(extra)
    _events.append(entry)
    _flush()


def _flush() -> None:
    """APPEND new events as JSONL. Append-only because several module workers
    share one run: a whole-document rewrite was reproduced erasing an earlier
    worker's recorded gaps — the one thing the ledger exists to preserve."""
    global _flushed
    if not _ledger_path:
        return
    try:
        with open(_ledger_path, "a", encoding="utf-8") as fh:
            for event in _events[_flushed:]:
                fh.write(json.dumps(event, default=str) + "\n")
        _flushed = len(_events)
    except OSError:  # pragma: no cover - the jail is being torn down
        pass


def events() -> list[dict[str, Any]]:
    """Everything the doubles did this run (test and report entry point)."""
    return list(_events)


def reset() -> None:
    """Tear the installation down completely — tests share one interpreter.

    Everything ``install`` touched is restored: the import wrapper comes off
    ``builtins.__import__``, the stub finder leaves ``sys.meta_path``, the
    modules that finder minted leave ``sys.modules``. Leaving any of them was
    reproduced serving a stub psycopg2 to unrelated code for the rest of the
    process.
    """
    global _ledger_path, _installed, _flushed, _DEFAULT_DIR, _SEED_ROWS, _REAL_IMPORT, _FINDER
    _events.clear()
    _ledger_path = ""
    _flushed = 0
    _installed = False
    _DEFAULT_DIR = ""
    _SEED_ROWS = 1
    _pending.clear()
    _FIXTURES.clear()
    _SCHEMA_STATEMENTS.clear()
    _SCHEMA_METADATA.clear()
    _Keyspace.reset_all()
    _SqlBackend.reset_all()
    if _REAL_IMPORT is not None:
        builtins.__import__ = _REAL_IMPORT
        _REAL_IMPORT = None
    if _FINDER is not None:
        try:
            sys.meta_path.remove(_FINDER)
        except ValueError:  # pragma: no cover
            pass
        for name in _FINDER.created:
            module = sys.modules.get(name)
            if module is not None and getattr(module, "__vinv_stub__", False):
                del sys.modules[name]
        _FINDER = None
    for name in _MINTED_SUBMODULES:
        sys.modules.pop(name, None)
    _MINTED_SUBMODULES.clear()


# ---------------------------------------------------------------------------
# SQL — one sqlite-backed PEP 249 adapter for every conforming driver
# ---------------------------------------------------------------------------

# The translation discipline, learned the hard way (each rule below had a
# reproduced silent-wrong-answer without it):
#
# * String literals are NEVER rewritten. `'50%save'` is data; a dialect rule
#   that touches it corrupts what the repo stores and reads back.
# * Type names are NOT rewritten. sqlite accepts any column type name (affinity
#   rules), so `UUID`/`JSONB`/`DOUBLE PRECISION` are legal as written — and a
#   word-level rewrite of `UUID`→`TEXT` was reproduced renaming a COLUMN called
#   `uuid` in a WHERE clause. Only `SERIAL` (needed for rowid autoincrement),
#   `AUTO_INCREMENT` (a syntax error) and `TYPE[]` (brackets don't parse) are
#   touched.
# * A `::cast` is mapped to `CAST(x AS affinity)` for simple operands; anything
#   this cannot express is LEFT IN PLACE so it fails loudly and lands as a
#   recorded substitution gap — deleting the cast was reproduced turning
#   `n::float / d` into integer division, a plausible wrong answer.
# * `%s`/`%(name)s` conversion mirrors the DRIVER's semantics, not a regex over
#   the text: psycopg does no interpolation at all when no parameters are
#   passed (so a bare `LIKE '%son'` must survive untouched), and when they are
#   passed it is literal-unaware, scanning left-to-right with `%%` as the
#   escape — which is what makes `'%%%s'` mean "percent, then placeholder".
_SERIAL = re.compile(r"\bBIGSERIAL\b|\bSMALLSERIAL\b|\bSERIAL\b", re.I)
_AUTO_INCREMENT = re.compile(r"\bAUTO_INCREMENT\b", re.I)
_NOW = re.compile(r"\bNOW\(\)", re.I)
_ARRAY_TYPE = re.compile(r"\b(\w+)\[\]")
_PYFORMAT = re.compile(r"%\((\w+)\)s")

# `x::type` for operands this can rewrite faithfully: a (qualified) name, a
# number, or a placeholder. Anything else keeps its `::` and fails loudly.
_CAST = re.compile(r"([\w.]+|\?|:\w+)\s*::\s*([A-Za-z_]\w*(?:\s+precision)?)", re.I)
_CAST_AFFINITY = {
    "int": "INTEGER",
    "integer": "INTEGER",
    "bigint": "INTEGER",
    "smallint": "INTEGER",
    "boolean": "INTEGER",
    "bool": "INTEGER",
    "float": "REAL",
    "float4": "REAL",
    "float8": "REAL",
    "real": "REAL",
    "double precision": "REAL",
    "numeric": "REAL",
    "decimal": "REAL",
    "text": "TEXT",
    "varchar": "TEXT",
    "char": "TEXT",
    "uuid": "TEXT",
    "json": "TEXT",
    "jsonb": "TEXT",
    "date": "TEXT",
    "timestamp": "TEXT",
    "timestamptz": "TEXT",
}

# `X ILIKE Y` where both operands sit in the same non-literal span (names or
# placeholders). The literal-pattern form is handled across spans in
# `_translate`. sqlite's lower() is ASCII-only where Postgres folds by locale —
# accepted, and narrower than either alternative (flipping LIKE or ILIKE
# semantics wholesale).
_ILIKE_INLINE = re.compile(r"([\w.]+|\?|:\w+)\s+ILIKE\s+(\?|:\w+|%\(\w+\)s|%s)", re.I)
_ILIKE_BEFORE_LITERAL = re.compile(r"([\w.]+|\?|:\w+)\s+ILIKE\s*$", re.I)


def _split_literals(sql: str) -> list[tuple[str, bool]]:
    """``(span, is_quoted)`` segments; quoted spans are preserved verbatim.

    Handles ``'…'`` string literals (with ``''`` escaping) and ``"…"`` quoted
    identifiers. Everything the dialect rules touch lives outside them.
    """
    out: list[tuple[str, bool]] = []
    i, n, plain = 0, len(sql), 0
    while i < n:
        ch = sql[i]
        if ch in ("'", '"'):
            j = i + 1
            while j < n:
                if sql[j] == ch:
                    if j + 1 < n and sql[j + 1] == ch:
                        j += 2
                        continue
                    break
                j += 1
            if plain < i:
                out.append((sql[plain:i], False))
            end = min(j + 1, n)
            out.append((sql[i:end], True))
            i = plain = end
        else:
            i += 1
    if plain < n:
        out.append((sql[plain:], False))
    return out


def _rewrite_dialect(span: str, *, is_ddl: bool = False) -> str:
    """Dialect rules over ONE non-literal span."""
    out = span
    if is_ddl:
        # Type-position syntax: exists only in CREATE/ALTER, so it is only
        # rewritten there — a column NAMED `serial` in a query is untouched.
        out = _SERIAL.sub("INTEGER", out)
        out = _AUTO_INCREMENT.sub("", out)
        out = _ARRAY_TYPE.sub(r"\1", out)
    out = _NOW.sub("CURRENT_TIMESTAMP", out)

    def cast(m: re.Match[str]) -> str:
        affinity = _CAST_AFFINITY.get(m.group(2).lower())
        if affinity is None:
            return m.group(0)  # unknown cast: keep it, fail loudly, record a gap
        return f"CAST({m.group(1)} AS {affinity})"

    out = _CAST.sub(cast, out)
    out = _ILIKE_INLINE.sub(r"lower(\1) LIKE lower(\2)", out)
    return out


def _sql_escape(value: Any) -> str:
    """A value rendered INTO an existing string literal, quote-doubled."""
    return str(value).replace("'", "''")


def _convert_span(
    span: str,
    params: Any,
    pos: int,
    consumed: list[int],
    *,
    splice: bool,
) -> tuple[str, int]:
    """Placeholder conversion for ONE segment; returns (text, next positional).

    ``splice=False`` (outside literals): ``%s`` becomes a real ``?`` binding.
    ``splice=True`` (inside a literal): the driver's client-side interpolation
    is emulated — the parameter's ESCAPED value is spliced into the literal and
    consumed, because a ``?`` inside quotes is just two characters. This is
    what makes ``LIKE '%%%s'`` mean "percent, then the value", as it does under
    psycopg, instead of a binding-count error.
    """
    named = isinstance(params, dict)
    out: list[str] = []
    i, n = 0, len(span)
    while i < n:
        if span[i] == "%":
            if i + 1 < n and span[i + 1] == "%":
                out.append("%")
                i += 2
                continue
            m = _PYFORMAT.match(span, i)
            if m:
                key = m.group(1)
                if splice and named and key in params:
                    out.append(_sql_escape(params[key]))
                else:
                    out.append(":" + key)
                i = m.end()
                continue
            if not named and i + 1 < n and span[i + 1] == "s":
                if splice:
                    if isinstance(params, list | tuple) and pos < len(params):
                        out.append(_sql_escape(params[pos]))
                        consumed.append(pos)
                    pos += 1
                else:
                    out.append("?")
                    pos += 1
                i += 2
                continue
        out.append(span[i])
        i += 1
    return "".join(out), pos


def _translate(sql: str, params: Any) -> tuple[str, Any]:
    """Rewrite one statement (and its parameters) into sqlite's dialect."""
    # SERIAL / AUTO_INCREMENT / TYPE[] are TYPE syntax, meaningful only in
    # DDL. Applying them everywhere was reproduced renaming a COLUMN called
    # `serial` in a SELECT — the same identifier-corruption class M2 removed.
    is_ddl = bool(re.match(r"\s*(CREATE|ALTER)\b", sql, re.I))
    segments = _split_literals(sql)
    idx = 0
    while idx < len(segments):
        span, quoted = segments[idx]
        if quoted:
            idx += 1
            continue
        span = _rewrite_dialect(span, is_ddl=is_ddl)
        # `name ILIKE '%a%'` — the pattern is the NEXT (literal) segment, so
        # the operand-wrapping rewrite has to reach across the boundary. The
        # literal is wrapped in lower(…) rather than lowercased in Python:
        # a parameter spliced into it later must fold too, and only sqlite's
        # own runtime lower() sees the final string.
        m = _ILIKE_BEFORE_LITERAL.search(span)
        if m and idx + 1 < len(segments) and segments[idx + 1][0].startswith("'"):
            span = span[: m.start()] + f"lower({m.group(1)}) LIKE lower("
            segments.insert(idx + 2, (")", False))
        segments[idx] = (span, False)
        idx += 1
    if params is None:
        return "".join(span for span, _ in segments), params
    # Placeholder pass, segment-aware: real bindings outside literals, the
    # driver's client-side interpolation inside them. Positional parameters a
    # splice consumed are removed so the remaining ``?`` still bind in order.
    parts: list[str] = []
    pos = 0
    consumed: list[int] = []
    for span, quoted in segments:
        if quoted and not span.startswith("'"):
            # A "quoted identifier" is a NAME; the driver's format characters
            # have no meaning inside it, and converting them was reproduced
            # corrupting the identifier and desyncing the binding order.
            parts.append(span)
            continue
        text, pos = _convert_span(span, params, pos, consumed, splice=quoted)
        parts.append(text)
    if consumed and isinstance(params, list | tuple):
        params = tuple(v for i, v in enumerate(params) if i not in consumed)
    return "".join(parts), params


_NO_TABLE = re.compile(r"no such table:\s*(?:main\.)?([A-Za-z_][\w]*)", re.I)
_NO_COLUMN = re.compile(r"no such column:\s*(?:([A-Za-z_][\w]*)\.)?([A-Za-z_][\w]*)", re.I)
_HAS_NO_COLUMN = re.compile(
    r"table\s+([A-Za-z_][\w]*)\s+has no column named\s+([A-Za-z_][\w]*)", re.I
)

# Column mentions the repair loop can read straight off the failing statement.
_INSERT_COLS = re.compile(r"INSERT\s+INTO\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)", re.I)
_QUALIFIED = re.compile(r"\b([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)\b")
_FROM_TABLES = re.compile(r"\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][\w]*)", re.I)
_WHERE_COLS = re.compile(r"\b([A-Za-z_][\w]*)\s*(?:=|<|>|<=|>=|<>|!=|\bLIKE\b|\bIN\b)", re.I)
_SELECT_LIST = re.compile(r"SELECT\s+(?:DISTINCT\s+)?(.+?)\s+FROM\s", re.I | re.S)

_SQL_KEYWORDS = frozenset(
    """select from where insert into values update set delete order by group having limit
    offset join left right inner outer on as and or not null is distinct count sum avg min
    max case when then else end asc desc union all exists between like in returning default
    current_timestamp true false""".split()
)


def _identifiers(text: str) -> list[str]:
    seen: list[str] = []
    for word in re.findall(r"[A-Za-z_][\w]*", text or ""):
        low = word.lower()
        if low in _SQL_KEYWORDS or low in seen:
            continue
        seen.append(low)
    return seen


# `FROM users u`, `JOIN orders AS o` — the alias is how most real SQL spells
# a qualified column, so a repair loop that reads `u.phone` literally invents a
# phantom table `u` while the real one stays broken.
_ALIAS = re.compile(
    r"\b(?:FROM|JOIN|UPDATE|INTO)\s+([A-Za-z_]\w*)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?", re.I
)
_ALIAS_STOP = frozenset(
    """where on set join left right inner outer cross full group order limit having
    values as using natural union select returning""".split()
)


def _alias_map(sql: str) -> dict[str, str]:
    """``alias-or-table -> real table`` for one statement."""
    out: dict[str, str] = {}
    for tbl, alias in _ALIAS.findall(sql):
        real = tbl.lower()
        out.setdefault(real, real)
        if alias and alias.lower() not in _ALIAS_STOP:
            out[alias.lower()] = real
    return out


# A column compared with (or arithmetic against) a NUMBER in the failing
# statement is direct evidence it holds numbers — better evidence than any
# name heuristic, so it wins when seeding.
_NUMERIC_LEFT = re.compile(r"\b([A-Za-z_]\w*)\s*(?:[<>!=]=?|<>|[-+*/])\s*-?\d")
_NUMERIC_RIGHT = re.compile(r"-?\d+(?:\.\d+)?\s*(?:[<>!=]=?|<>|[-+*/])\s*([A-Za-z_]\w*)")


def _numeric_hints(sql: str) -> frozenset[str]:
    hints = {m.lower() for m in _NUMERIC_LEFT.findall(sql)}
    hints.update(m.lower() for m in _NUMERIC_RIGHT.findall(sql))
    return frozenset(h for h in hints if h not in _SQL_KEYWORDS)


def _columns_mentioned(sql: str, table: str) -> list[str]:
    """Columns the failing statement itself attributes to ``table``.

    The statement is the best available evidence about the schema it needs: an
    INSERT names its column list outright, and a SELECT/WHERE names qualified
    columns. Nothing is guessed from the table's NAME — only read off the text.
    """
    cols: list[str] = []

    def add(name: str) -> None:
        low = name.lower()
        # The table's OWN name appears in every qualified reference to it, so
        # excluding it is what stops `customers.email` contributing a phantom
        # `customers` column.
        if low in _SQL_KEYWORDS or low in ("id", table) or low in cols:
            return
        cols.append(low)

    aliases = _alias_map(sql)
    m = _INSERT_COLS.search(sql)
    if m and m.group(1).lower() == table:
        for raw in m.group(2).split(","):
            name = raw.strip().strip('"').strip("`").strip("[]")
            if re.fullmatch(r"[A-Za-z_][\w]*", name or ""):
                add(name)
    for owner, col in _QUALIFIED.findall(sql):
        if aliases.get(owner.lower(), owner.lower()) == table:
            add(col)
    # An unqualified statement against a single table attributes its bare
    # column mentions to that table — with more than one table in play there is
    # no evidence of ownership, so nothing is invented.
    tables = set(aliases.values()) or {t.lower() for t in _FROM_TABLES.findall(sql)}
    if tables == {table}:
        sel = _SELECT_LIST.search(sql)
        if sel and "*" not in sel.group(1):
            # Strip the qualifier so `customers.email` contributes `email`
            # alone — the owner was already handled by the qualified pass.
            for name in _identifiers(re.sub(r"\b[A-Za-z_]\w*\.", "", sel.group(1))):
                add(name)
        for name in _WHERE_COLS.findall(sql):
            add(name)
        m = _INSERT_COLS.search(sql)
        if not m:
            for name in _identifiers(
                re.sub(r"'[^']*'", "", sql.split("SET", 1)[-1] if "SET" in sql.upper() else "")
            ):
                add(name)
    return cols


#: Schema the REPO declares, applied to every substitute database before a
#: single statement runs. Induction is the fallback for what nobody wrote down;
#: where the repo did write it down, that is exact and induction is a guess.
_SCHEMA_STATEMENTS: list[str] = []
_SCHEMA_METADATA: list[str] = []


def declare_schema(
    *, statements: list[str] | None = None, metadata: list[str] | None = None
) -> None:
    """Register the repo's own schema declarations for every database.

    Applied LAZILY, on first connection, because a ``module:Base.metadata``
    target has to be imported and the repo is not on ``sys.path`` yet when the
    doubles install at interpreter start.
    """
    _SCHEMA_STATEMENTS.extend(statements or [])
    _SCHEMA_METADATA.extend(metadata or [])


def _resolve(target: str) -> Any:
    """``pkg.mod:Base.metadata`` -> the object, or None if unreachable."""
    module_name, _, path = target.partition(":")
    if not module_name or not path:
        return None
    import importlib

    obj: Any = importlib.import_module(module_name)
    for part in path.split("."):
        obj = getattr(obj, part)
    return obj


def _apply_declared_schema(backend: _SqlBackend) -> None:
    for statement in _SCHEMA_STATEMENTS:
        stmt, _ = _translate(statement, None)
        try:
            backend.raw.execute(stmt)
        except sqlite3.Error as exc:
            _record(FIDELITY_GAP, f"sql:{backend.name}", f"declared DDL rejected: {exc}")
    if _SCHEMA_STATEMENTS:
        backend.raw.commit()
        _record(
            "declared-schema",
            f"sql:{backend.name}",
            f"applied {len(_SCHEMA_STATEMENTS)} CREATE TABLE from the repo's own DDL",
        )
    for target in _SCHEMA_METADATA:
        try:
            metadata = _resolve(target)
            if metadata is None:
                continue
            import sqlalchemy

            engine = sqlalchemy.create_engine(f"sqlite:///{backend.path}")
            metadata.create_all(engine)
            tables = sorted(getattr(metadata, "tables", {}))
            _record(
                "declared-schema",
                f"sql:{backend.name}",
                f"{target}: created {len(tables)} table(s) from the repo's own models",
                tables=tables[:40],
            )
        except Exception as exc:  # the repo's models can fail to import for any reason
            _record(FIDELITY_GAP, f"sql:{backend.name}", f"{target}: {type(exc).__name__}: {exc}")


class _SqlBackend:
    """One sqlite file standing in for one logical database."""

    _instances: dict[str, _SqlBackend] = {}

    def __init__(self, name: str, path: str, *, seed_rows: int = 1):
        self.name = name
        self.path = path
        self.seed_rows = seed_rows
        self.raw = sqlite3.connect(path, check_same_thread=False)
        self.raw.row_factory = sqlite3.Row
        # Postgres LIKE is case-sensitive; sqlite's default is not. Silent
        # case-folding was a reproduced wrong answer, so LIKE is made faithful
        # and ILIKE is rewritten to lower()/LIKE by the translator.
        self.raw.execute("PRAGMA case_sensitive_like = ON")
        self.induced_tables: list[str] = []
        self.induced_columns: list[str] = []
        # column -> "holds numbers", read off the failing statements.
        self._numeric: dict[str, frozenset[str]] = {}
        _apply_declared_schema(self)
        self._seed_declared()
        self._apply_fixtures()

    def _seed_declared(self) -> None:
        """Seed EMPTY declared tables too — the fixture gap ("a read path needs
        something to read") applies to the best-prepared repo exactly as much
        as to one whose schema had to be induced."""
        if self.seed_rows <= 0:
            return
        try:
            tables = [
                r[0]
                for r in self.raw.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' "
                    "AND name NOT LIKE 'sqlite_%'"
                )
            ]
        except sqlite3.Error:  # pragma: no cover
            return
        for table in tables:
            try:
                empty = self.raw.execute(f'SELECT 1 FROM "{table}" LIMIT 1').fetchone() is None
            except sqlite3.Error:  # pragma: no cover
                continue
            if empty:
                self._seed(table)

    def _apply_fixtures(self) -> None:
        """Rows the agent channel supplied for this repo, inserted verbatim.

        Fixtures are answers to earlier runs' induced-schema questions, so they
        replace placeholder seeding with REPRESENTATIVE data. Applied after
        declared schema; induced tables get theirs on creation.
        """
        for fixture in _FIXTURES:
            self._apply_one_fixture(fixture)

    def _apply_one_fixture(self, fixture: dict[str, Any]) -> None:
        table = str(fixture.get("table") or "").lower()
        if not re.fullmatch(r"[A-Za-z_]\w*", table) or not self._table_exists(table):
            return
        existing = set(self._existing_columns(table))
        written = 0
        for row in fixture.get("rows") or []:
            if not isinstance(row, dict):
                continue
            cols = [c for c in row if isinstance(c, str) and c.lower() in existing]
            if not cols:
                continue
            placeholders = ", ".join("?" for _ in cols)
            quoted = ", ".join(f'"{c.lower()}"' for c in cols)
            try:
                self.raw.execute(
                    f'INSERT INTO "{table}" ({quoted}) VALUES ({placeholders})',
                    [row[c] for c in cols],
                )
                written += 1
            except sqlite3.Error:
                continue
        if written:
            self.raw.commit()
            _record(
                FIXTURE_APPLIED,
                f"sql:{self.name}",
                f"applied {written} agent-supplied fixture row(s) to {table}",
                table=table,
                rows=written,
            )

    @classmethod
    def get(cls, name: str, path: str, *, seed_rows: int = 1) -> _SqlBackend:
        inst = cls._instances.get(name)
        if inst is None:
            inst = cls(name, path, seed_rows=seed_rows)
            cls._instances[name] = inst
        return inst

    @classmethod
    def reset_all(cls) -> None:
        for inst in cls._instances.values():
            try:
                inst.raw.close()
            except sqlite3.Error:  # pragma: no cover
                pass
        cls._instances.clear()

    # -- schema repair ----------------------------------------------------

    def _table_exists(self, table: str) -> bool:
        row = self.raw.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND lower(name)=?", (table,)
        ).fetchone()
        return row is not None

    def _existing_columns(self, table: str) -> list[str]:
        try:
            return [r[1].lower() for r in self.raw.execute(f'PRAGMA table_info("{table}")')]
        except sqlite3.Error:  # pragma: no cover
            return []

    def _repair_commit(self, what: str) -> None:
        """Commit a schema repair, or surface a recorded gap.

        sqlite refuses to commit while an unfetched ``RETURNING`` cursor is
        open on the connection. A repair triggered in that state is the
        HARNESS's constraint, so it must land as a ``SubstitutionGap`` — a raw
        ``sqlite3.OperationalError`` escaping here would be blamed on the repo.
        """
        try:
            self.raw.commit()
        except sqlite3.OperationalError as exc:
            _record(FIDELITY_GAP, f"sql:{self.name}", f"{what} could not commit: {exc}")
            raise SubstitutionGap(
                f"the SQL substitute could not commit a schema repair ({what}): {exc}"
            ) from exc

    def create_table(
        self, table: str, columns: list[str], numeric: frozenset[str] = frozenset()
    ) -> None:
        cols = ["id INTEGER PRIMARY KEY"] + [f'"{c}"' for c in columns if c != "id"]
        self.raw.execute(f'CREATE TABLE IF NOT EXISTS "{table}" ({", ".join(cols)})')
        self._repair_commit(f"create table {table}")
        self.induced_tables.append(table)
        self._numeric[table] = numeric
        _record(
            INDUCED,
            f"sql:{self.name}",
            f"created table {table}({', '.join(columns) or 'id only'}) from the failing statement",
            table=table,
            columns=list(columns),
        )
        self._seed(table)
        for fixture in _FIXTURES:
            if str(fixture.get("table") or "").lower() == table:
                self._apply_one_fixture(fixture)

    def add_column(self, table: str, column: str) -> bool:
        if column in self._existing_columns(table):
            return False
        try:
            self.raw.execute(f'ALTER TABLE "{table}" ADD COLUMN "{column}"')
        except sqlite3.Error:
            return False
        self._repair_commit(f"add column {table}.{column}")
        self.induced_columns.append(f"{table}.{column}")
        _record(
            INDUCED,
            f"sql:{self.name}",
            f"added column {table}.{column}",
            table=table,
            column=column,
        )
        return True

    def _seed(self, table: str) -> None:
        """Give an induced table one row, so a read path has something to read.

        A function that needs a POPULATED schema is the case this exists for;
        an empty table would send it down the same "raises on missing data"
        road as the missing table did. Every seeded row is recorded, so a
        result that depended on invented data is legible as such.
        """
        if self.seed_rows <= 0:
            return
        cols = [c for c in self._existing_columns(table) if c != "id"]
        numeric = self._numeric.get(table, frozenset())
        seeded: list[dict[str, Any]] = []
        for i in range(self.seed_rows):
            values = [i + 1 if c in numeric else _seed_value(c, i) for c in cols]
            try:
                if cols:
                    placeholders = ", ".join("?" for _ in cols)
                    quoted = ", ".join(f'"{c}"' for c in cols)
                    self.raw.execute(
                        f'INSERT INTO "{table}" ({quoted}) VALUES ({placeholders})', values
                    )
                else:
                    self.raw.execute(f'INSERT INTO "{table}" DEFAULT VALUES')
                seeded.append(dict(zip(cols, values, strict=False)))
            except sqlite3.Error as exc:
                # A constraint the invented row cannot satisfy. ROLL BACK the
                # partial batch: leaving it uncommitted was reproduced letting
                # the repo's own later commit() persist invented rows with no
                # ledger entry — the exact "unrecorded invented data" the
                # seeding invariant forbids. Nothing lands, and the failure is
                # itself recorded.
                self.raw.rollback()
                _record(
                    FIDELITY_GAP,
                    f"sql:{self.name}",
                    f"seeding {table} rolled back ({exc}) — table left empty",
                    table=table,
                )
                return
        self.raw.commit()
        # The VALUES are in the event, not just the count — "a result that
        # depended on invented data is legible as such" has to be literally
        # true, and a count alone does not let anyone check what was invented.
        _record(
            SEEDED,
            f"sql:{self.name}",
            f"seeded {len(seeded)} row(s) into {table}",
            table=table,
            rows=seeded[:10],
        )

    def repair(self, sql: str, error: str) -> bool:
        """Extend the schema from one failure. True when something changed."""
        aliases = _alias_map(sql)
        hints = _numeric_hints(sql)

        def induce(table: str) -> None:
            self.create_table(table, _columns_mentioned(sql, table), numeric=hints)

        m = _NO_TABLE.search(error)
        if m:
            table = aliases.get(m.group(1).lower(), m.group(1).lower())
            if not self._table_exists(table):
                induce(table)
                return True
        m = _HAS_NO_COLUMN.search(error)
        if m:
            table = aliases.get(m.group(1).lower(), m.group(1).lower())
            return self.add_column(table, m.group(2).lower())
        m = _NO_COLUMN.search(error)
        if m:
            owner, column = m.group(1), m.group(2).lower()
            if owner:
                # `u.phone` — the owner is usually an ALIAS; resolving it is
                # what keeps the real table repaired instead of a phantom `u`
                # being invented beside it.
                table = aliases.get(owner.lower(), owner.lower())
                if not self._table_exists(table):
                    induce(table)
                    return True
                return self.add_column(table, column)
            tables = sorted(set(aliases.values())) or sorted(
                {t.lower() for t in _FROM_TABLES.findall(sql)}
            )
            if len(tables) == 1:
                table = tables[0]
                if not self._table_exists(table):
                    induce(table)
                    return True
                return self.add_column(table, column)
        return False

    def execute(self, sql: str, params: Any) -> sqlite3.Cursor:
        """Run one statement, repairing missing schema as the errors name it."""
        stmt, args = _translate(sql, params)
        last = ""
        for _ in range(MAX_REPAIR_ROUNDS):
            try:
                cur = self.raw.execute(stmt) if args is None else self.raw.execute(stmt, args)
                # `INSERT … RETURNING` leaves the statement in progress until
                # its rows are fetched; committing under it is an error. sqlite
                # itself supports RETURNING fine — the commit waits for the
                # repo's own `commit()` whenever there are rows to fetch.
                if cur.description is None:
                    self.raw.commit()
                return cur
            except sqlite3.OperationalError as exc:
                last = str(exc)
                if not self.repair(stmt, last):
                    break
            except sqlite3.Error as exc:
                # An integrity/programming error is the DATABASE answering, not
                # the substitute falling short: it propagates unchanged so the
                # target sees the same failure a real server would give.
                raise _translate_error(exc) from None
        _record(FIDELITY_GAP, f"sql:{self.name}", f"{last} :: {stmt[:200]}", statement=stmt[:200])
        raise SubstitutionGap(f"the SQL substitute could not honour this statement: {last}")


def _seed_value(column: str, index: int) -> Any:
    """A plausible value for a seeded column, from its NAME's shape only.

    Names are the only evidence available for an induced column, and sqlite is
    dynamically typed, so this never has to be right — it has to be
    type-plausible enough that a consumer's arithmetic or string handling does
    not trip over it.
    """
    low = column.lower()
    if low.startswith(("is_", "has_", "can_", "should_")) or low in {
        "active",
        "enabled",
        "disabled",
        "deleted",
        "archived",
        "verified",
    }:
        return 0
    if any(word in low for word in ("price", "amount", "rate", "score", "ratio", "percent")):
        return 1.0
    # Counters and sizes must come back as NUMBERS. A string here does not just
    # look wrong — sqlite orders TEXT above every INTEGER, so `order_count >= 3`
    # would silently be TRUE and the comparison branch under test would never be
    # exercised. Type-plausible seeding is what keeps an invented row from
    # manufacturing a verdict.
    if low.endswith("_id") or any(
        word in low
        for word in (
            "count",
            "quantity",
            "qty",
            "size",
            "length",
            "total",
            "number",
            "num_",
            "age",
            "index",
            "position",
            "priority",
            "version",
            "attempts",
            "retries",
            "offset",
            "limit",
        )
    ):
        return index + 1
    if low.endswith("_at") or any(word in low for word in ("date", "time", "timestamp")):
        return "2020-01-01 00:00:00"
    if "email" in low:
        return f"user{index}@example.invalid"
    if any(word in low for word in ("json", "meta", "data", "payload", "config", "options")):
        return "{}"
    if "url" in low or "uri" in low or "link" in low:
        return f"https://example.invalid/{low}/{index}"
    if low.endswith("uuid") or low == "guid":
        return f"00000000-0000-0000-0000-{index:012d}"
    return f"{low}-{index}"


class SubstitutionGap(Exception):
    """The stand-in could not honour a call. Not a defect in the repo."""


def _translate_error(exc: sqlite3.Error) -> Exception:
    """Re-raise sqlite's error under the DB-API name the caller expects.

    Looked up through ``_EXC`` at raise time, so a class merged with a real
    driver's hierarchy is the one actually raised.
    """
    if isinstance(exc, sqlite3.IntegrityError):
        return _EXC["IntegrityError"](str(exc))
    if isinstance(exc, sqlite3.ProgrammingError):
        return _EXC["ProgrammingError"](str(exc))
    if isinstance(exc, sqlite3.OperationalError):
        return _EXC["OperationalError"](str(exc))
    return _EXC["DatabaseError"](str(exc))


# PEP 249 §8 exception hierarchy, so ``except psycopg2.IntegrityError`` in the
# repo under test catches what it is written to catch.
class Error(Exception):
    pass


class DatabaseError(Error):
    pass


class OperationalError(DatabaseError):
    pass


class IntegrityError(DatabaseError):
    pass


class ProgrammingError(DatabaseError):
    pass


class InterfaceError(Error):
    pass


class DataError(DatabaseError):
    pass


class NotSupportedError(DatabaseError):
    pass


class InternalError(DatabaseError):
    pass


#: The classes ``_translate_error`` raises, looked up at RAISE time. When a
#: really-installed driver is patched, each entry is rebound to a merged
#: subclass of (driver's class, ours) — so the repo's ``except
#: psycopg2.IntegrityError`` catches what the substitute raises, whether that
#: reference was taken before or after install. A ``not hasattr`` guard alone
#: was reproduced producing exactly the mixed hierarchy it meant to prevent.
_EXC: dict[str, type[Exception]] = {}


def _register_exceptions() -> None:
    for name in (
        "Error",
        "DatabaseError",
        "OperationalError",
        "IntegrityError",
        "ProgrammingError",
        "InterfaceError",
        "DataError",
        "NotSupportedError",
        "InternalError",
    ):
        _EXC.setdefault(name, globals()[name])


_register_exceptions()


def _merge_exception(name: str, driver_class: Any) -> type[Exception]:
    """Ours, made a subclass of the driver's class of the same name."""
    current = _EXC.get(name) or globals()[name]
    if not isinstance(driver_class, type) or not issubclass(driver_class, BaseException):
        return current
    if issubclass(current, driver_class):
        return current
    try:
        merged = type(name, (driver_class, current), {"__module__": __name__})
    except TypeError:  # pragma: no cover - irreconcilable MRO
        return current
    _EXC[name] = merged
    globals()[name] = merged
    for attr in (
        "Error",
        "DatabaseError",
        "OperationalError",
        "IntegrityError",
        "ProgrammingError",
    ):
        if attr == name and hasattr(Connection, attr):
            setattr(Connection, attr, merged)
    return merged


class Cursor:
    """PEP 249 cursor over the substitute."""

    def __init__(self, backend: _SqlBackend):
        self._backend = backend
        self._cur: sqlite3.Cursor | None = None
        self.arraysize = 1

    # -- introspection ----------------------------------------------------
    @property
    def description(self):  # noqa: ANN201 - PEP 249 shape
        if self._cur is None or self._cur.description is None:
            return None
        return [(d[0], None, None, None, None, None, None) for d in self._cur.description]

    @property
    def rowcount(self) -> int:
        return -1 if self._cur is None else self._cur.rowcount

    @property
    def lastrowid(self):  # noqa: ANN201
        return None if self._cur is None else self._cur.lastrowid

    # -- execution --------------------------------------------------------
    def execute(self, operation: str, parameters: Any = None) -> Cursor:
        self._cur = self._backend.execute(operation, parameters)
        return self

    def executemany(self, operation: str, seq_of_parameters: Any) -> Cursor:
        for params in seq_of_parameters:
            self.execute(operation, params)
        return self

    def callproc(self, procname: str, parameters: Any = ()) -> Any:
        raise NotSupportedError("stored procedures have no stand-in")

    # -- fetching ---------------------------------------------------------
    def fetchone(self):  # noqa: ANN201
        row = None if self._cur is None else self._cur.fetchone()
        return None if row is None else tuple(row)

    def fetchmany(self, size: int | None = None):  # noqa: ANN201
        if self._cur is None:
            return []
        return [tuple(r) for r in self._cur.fetchmany(size or self.arraysize)]

    def fetchall(self):  # noqa: ANN201
        if self._cur is None:
            return []
        return [tuple(r) for r in self._cur.fetchall()]

    def __iter__(self):
        return iter(self.fetchall())

    def setinputsizes(self, sizes: Any) -> None:
        return None

    def setoutputsize(self, size: Any, column: Any = None) -> None:
        return None

    def close(self) -> None:
        self._cur = None

    def __enter__(self) -> Cursor:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class Connection:
    """PEP 249 connection over the substitute."""

    Error = Error
    DatabaseError = DatabaseError
    OperationalError = OperationalError
    IntegrityError = IntegrityError
    ProgrammingError = ProgrammingError

    def __init__(self, backend: _SqlBackend, dsn: str = ""):
        self._backend = backend
        self.dsn = dsn
        self.autocommit = True
        self.closed = 0

    def cursor(self, *args: Any, **kwargs: Any) -> Cursor:
        return Cursor(self._backend)

    def commit(self) -> None:
        self._backend.raw.commit()

    def rollback(self) -> None:
        self._backend.raw.rollback()

    def close(self) -> None:
        self.closed = 1

    def execute(self, operation: str, parameters: Any = None) -> Cursor:
        return self.cursor().execute(operation, parameters)

    def __enter__(self) -> Connection:
        return self

    def __exit__(self, *exc: Any) -> None:
        if exc and exc[0]:
            self.rollback()
        else:
            self.commit()


_DEFAULT_DIR = ""
_SEED_ROWS = 1


def _db_name(dsn: str) -> str:
    """A stable per-database name. Host AND database both key it, so
    ``postgresql://hostA/app`` and ``postgresql://hostB/app`` — two servers in
    reality — do not silently share one substitute state."""
    if not dsn:
        return "default"
    clean = dsn.split("?", 1)[0].rstrip("/")
    host = ""
    m = re.search(r"//(?:[^/@]*@)?([^/:]+)", clean)
    if m:
        host = re.sub(r"[^A-Za-z0-9_.-]", "_", m.group(1))
    tail = re.split(r"[/\\]", clean)[-1]
    name = re.sub(r"[^A-Za-z0-9_.-]", "_", tail) or "default"
    return (f"{host}-{name}" if host and host != name else name)[:60]


def connect(dsn: str = "", *args: Any, **kwargs: Any) -> Connection:
    """PEP 249 ``connect``. Serves any conforming driver's call signature."""
    label = dsn if isinstance(dsn, str) else ""
    if not label:
        label = str(kwargs.get("dsn") or kwargs.get("database") or kwargs.get("db") or "")
    name = _db_name(label)
    path = os.path.join(_DEFAULT_DIR or ".", f"vinv-{name}.sqlite3")
    backend = _SqlBackend.get(name, path, seed_rows=_SEED_ROWS)
    _record(
        SUBSTITUTED, "sql", f"connect({label or '<default>'}) -> sqlite {os.path.basename(path)}"
    )
    return Connection(backend, label)


# ---------------------------------------------------------------------------
# Key-value — the redis command surface over a dict
# ---------------------------------------------------------------------------


class _Keyspace:
    _instances: dict[str, _Keyspace] = {}

    def __init__(self) -> None:
        self.data: dict[bytes, Any] = {}

    @classmethod
    def get(cls, name: str) -> _Keyspace:
        inst = cls._instances.get(name)
        if inst is None:
            inst = cls()
            cls._instances[name] = inst
        return inst

    @classmethod
    def reset_all(cls) -> None:
        cls._instances.clear()


def _b(value: Any) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return value.encode("utf-8")
    return str(value).encode("utf-8")


class KeyValueDouble:
    """A stand-in with redis-py's shape, backed by an in-jail dict.

    Only the commands a repo actually reaches for are implemented; anything
    else raises :class:`SubstitutionGap` rather than returning a plausible
    ``None`` that would let a wrong answer through as a right one.
    """

    def __init__(self, *args: Any, **kwargs: Any):
        self._space = _Keyspace.get(str(kwargs.get("db", 0)))
        self._decode = bool(kwargs.get("decode_responses", False))
        _record(SUBSTITUTED, "kv", "Redis() -> in-jail keyspace")

    @classmethod
    def from_url(cls, url: str = "", **kwargs: Any) -> KeyValueDouble:
        """redis-py's dominant constructor — the classmethod form."""
        return cls(**kwargs)

    @classmethod
    def from_pool(cls, pool: Any = None, **kwargs: Any) -> KeyValueDouble:
        return cls(**kwargs)

    # -- plumbing ---------------------------------------------------------
    def _out(self, value: Any) -> Any:
        if value is None or not self._decode:
            return value
        if isinstance(value, bytes):
            return value.decode("utf-8", "replace")
        if isinstance(value, list):
            return [self._out(v) for v in value]
        if isinstance(value, set):
            return {self._out(v) for v in value}
        if isinstance(value, dict):
            return {self._out(k): self._out(v) for k, v in value.items()}
        return value

    def _hash(self, name: Any) -> dict[bytes, bytes]:
        return self._space.data.setdefault(_b(name), {})

    def _list(self, name: Any) -> list[bytes]:
        return self._space.data.setdefault(_b(name), [])

    def _set(self, name: Any) -> set[bytes]:
        return self._space.data.setdefault(_b(name), set())

    # -- strings ----------------------------------------------------------
    def ping(self) -> bool:
        return True

    def set(
        self,
        name: Any,
        value: Any,
        ex: Any = None,
        px: Any = None,
        nx: bool = False,
        xx: bool = False,
        **_: Any,
    ) -> bool:
        key = _b(name)
        if nx and key in self._space.data:
            return False
        if xx and key not in self._space.data:
            return False
        self._space.data[key] = _b(value)
        return True

    def setex(self, name: Any, time: Any, value: Any) -> bool:
        return self.set(name, value)

    def setnx(self, name: Any, value: Any) -> bool:
        return self.set(name, value, nx=True)

    def get(self, name: Any) -> Any:
        return self._out(self._space.data.get(_b(name)))

    def mget(self, keys: Any, *args: Any) -> list[Any]:
        names = list(keys) if isinstance(keys, list | tuple) else [keys, *args]
        return [self._out(self._space.data.get(_b(k))) for k in names]

    def delete(self, *names: Any) -> int:
        return sum(1 for n in names if self._space.data.pop(_b(n), None) is not None)

    def exists(self, *names: Any) -> int:
        return sum(1 for n in names if _b(n) in self._space.data)

    def expire(self, name: Any, time: Any, **_: Any) -> bool:
        return _b(name) in self._space.data

    def ttl(self, name: Any) -> int:
        return -1 if _b(name) in self._space.data else -2

    def incr(self, name: Any, amount: int = 1) -> int:
        key = _b(name)
        current = int(self._space.data.get(key, b"0") or 0)
        current += amount
        self._space.data[key] = _b(current)
        return current

    def incrby(self, name: Any, amount: int = 1) -> int:
        return self.incr(name, amount)

    def decr(self, name: Any, amount: int = 1) -> int:
        return self.incr(name, -amount)

    def keys(self, pattern: str = "*") -> list[Any]:
        rx = re.compile("^" + re.escape(pattern).replace(r"\*", ".*").replace(r"\?", ".") + "$")
        return [self._out(k) for k in self._space.data if rx.match(k.decode("utf-8", "replace"))]

    def flushdb(self, **_: Any) -> bool:
        self._space.data.clear()
        return True

    flushall = flushdb

    # -- hashes -----------------------------------------------------------
    def hset(
        self, name: Any, key: Any = None, value: Any = None, mapping: Any = None, **_: Any
    ) -> int:
        target = self._hash(name)
        added = 0
        items = dict(mapping or {})
        if key is not None:
            items[key] = value
        for k, v in items.items():
            if _b(k) not in target:
                added += 1
            target[_b(k)] = _b(v)
        return added

    def hget(self, name: Any, key: Any) -> Any:
        return self._out(self._hash(name).get(_b(key)))

    def hgetall(self, name: Any) -> dict[Any, Any]:
        return self._out(dict(self._hash(name)))

    def hdel(self, name: Any, *keys: Any) -> int:
        target = self._hash(name)
        return sum(1 for k in keys if target.pop(_b(k), None) is not None)

    def hexists(self, name: Any, key: Any) -> bool:
        return _b(key) in self._hash(name)

    # -- lists ------------------------------------------------------------
    def rpush(self, name: Any, *values: Any) -> int:
        target = self._list(name)
        target.extend(_b(v) for v in values)
        return len(target)

    def lpush(self, name: Any, *values: Any) -> int:
        target = self._list(name)
        for v in values:
            target.insert(0, _b(v))
        return len(target)

    def lrange(self, name: Any, start: int, end: int) -> list[Any]:
        target = self._list(name)
        stop = None if end == -1 else end + 1
        return self._out(target[start:stop])

    def llen(self, name: Any) -> int:
        return len(self._list(name))

    def lpop(self, name: Any) -> Any:
        target = self._list(name)
        return self._out(target.pop(0)) if target else None

    def rpop(self, name: Any) -> Any:
        target = self._list(name)
        return self._out(target.pop()) if target else None

    # -- sets -------------------------------------------------------------
    def sadd(self, name: Any, *values: Any) -> int:
        target = self._set(name)
        before = len(target)
        target.update(_b(v) for v in values)
        return len(target) - before

    def smembers(self, name: Any) -> set[Any]:
        return self._out(set(self._set(name)))

    def srem(self, name: Any, *values: Any) -> int:
        target = self._set(name)
        removed = 0
        for v in values:
            if _b(v) in target:
                target.discard(_b(v))
                removed += 1
        return removed

    def sismember(self, name: Any, value: Any) -> bool:
        return _b(value) in self._set(name)

    def scard(self, name: Any) -> int:
        return len(self._set(name))

    # -- pipeline / pubsub ------------------------------------------------
    def pipeline(self, *args: Any, **kwargs: Any) -> _Pipeline:
        return _Pipeline(self)

    def publish(self, channel: Any, message: Any) -> int:
        return 0

    def close(self) -> None:
        return None

    def __getattr__(self, name: str) -> Any:
        # Anything unimplemented is a GAP, said out loud. Returning a plausible
        # None here would be the substitute inventing an answer.
        def _unsupported(*args: Any, **kwargs: Any) -> Any:
            _record(FIDELITY_GAP, "kv", f"unimplemented command {name}()", command=name)
            raise SubstitutionGap(f"the key-value substitute does not implement {name}()")

        return _unsupported


class _Pipeline:
    """Buffered command list, executed on ``execute()`` like redis-py's."""

    def __init__(self, client: KeyValueDouble):
        self._client = client
        self._queued: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def __getattr__(self, name: str) -> Any:
        def queue(*args: Any, **kwargs: Any) -> _Pipeline:
            self._queued.append((name, args, kwargs))
            return self

        return queue

    def execute(self, raise_on_error: bool = True) -> list[Any]:
        out = []
        for name, args, kwargs in self._queued:
            out.append(getattr(self._client, name)(*args, **kwargs))
        self._queued.clear()
        return out

    def __enter__(self) -> _Pipeline:
        return self

    def __exit__(self, *exc: Any) -> None:
        self._queued.clear()

    def reset(self) -> None:
        self._queued.clear()


# ---------------------------------------------------------------------------
# Object store — the S3 command surface over a directory
# ---------------------------------------------------------------------------


class ObjectStoreDouble:
    """A stand-in with boto3's S3 client shape, backed by a jail directory."""

    def __init__(self, root: str):
        self._root = root
        os.makedirs(root, exist_ok=True)
        _record(SUBSTITUTED, "objectstore", "client('s3') -> in-jail directory")

    def _path(self, bucket: str, key: str = "") -> str:
        """A path INSIDE the store root, whatever the key claims.

        Defence-in-depth under the OS sandbox (which already refuses escapes),
        but load-bearing under the shim tier: keys are repo-controlled data.
        """
        base = os.path.realpath(os.path.join(self._root, re.sub(r"[^A-Za-z0-9_.-]", "_", bucket)))
        candidate = os.path.realpath(os.path.join(base, (key or "").lstrip("/\\")))
        if candidate != base and not candidate.startswith(base + os.sep):
            # The key tried to leave the bucket; flatten it instead.
            candidate = os.path.join(base, re.sub(r"[^A-Za-z0-9_.-]", "_", key or "key"))
        return candidate

    def create_bucket(self, Bucket: str, **_: Any) -> dict[str, Any]:  # noqa: N803 - boto3 spelling
        os.makedirs(self._path(Bucket), exist_ok=True)
        return {"Location": f"/{Bucket}"}

    def put_object(self, Bucket: str, Key: str, Body: Any = b"", **_: Any) -> dict[str, Any]:  # noqa: N803
        path = self._path(Bucket, Key)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        payload = (
            Body
            if isinstance(Body, bytes)
            else (Body.read() if hasattr(Body, "read") else _b(Body))
        )
        with open(path, "wb") as fh:
            fh.write(payload)
        return {"ETag": '"vinv"', "ResponseMetadata": {"HTTPStatusCode": 200}}

    def get_object(self, Bucket: str, Key: str, **_: Any) -> dict[str, Any]:  # noqa: N803
        path = self._path(Bucket, Key)
        if not os.path.exists(path):
            raise ClientError("NoSuchKey", f"{Bucket}/{Key}")
        with open(path, "rb") as fh:
            payload = fh.read()
        return {"Body": _BytesBody(payload), "ContentLength": len(payload)}

    def head_object(self, Bucket: str, Key: str, **_: Any) -> dict[str, Any]:  # noqa: N803
        path = self._path(Bucket, Key)
        if not os.path.exists(path):
            raise ClientError("404", f"{Bucket}/{Key}")
        return {"ContentLength": os.path.getsize(path)}

    def delete_object(self, Bucket: str, Key: str, **_: Any) -> dict[str, Any]:  # noqa: N803
        try:
            os.remove(self._path(Bucket, Key))
        except OSError:
            pass
        return {"ResponseMetadata": {"HTTPStatusCode": 204}}

    def list_objects_v2(self, Bucket: str, Prefix: str = "", **_: Any) -> dict[str, Any]:  # noqa: N803
        base = self._path(Bucket)
        contents = []
        for dirpath, _dirs, files in os.walk(base):
            for name in files:
                rel = os.path.relpath(os.path.join(dirpath, name), base)
                if rel.startswith(Prefix):
                    contents.append(
                        {"Key": rel, "Size": os.path.getsize(os.path.join(dirpath, name))}
                    )
        return {"Contents": contents, "KeyCount": len(contents)}

    def upload_file(self, Filename: str, Bucket: str, Key: str, **_: Any) -> None:  # noqa: N803
        with open(Filename, "rb") as fh:
            self.put_object(Bucket=Bucket, Key=Key, Body=fh.read())

    def download_file(self, Bucket: str, Key: str, Filename: str, **_: Any) -> None:  # noqa: N803
        payload = self.get_object(Bucket=Bucket, Key=Key)["Body"].read()
        with open(Filename, "wb") as fh:
            fh.write(payload)

    def __getattr__(self, name: str) -> Any:
        def _unsupported(*args: Any, **kwargs: Any) -> Any:
            _record(FIDELITY_GAP, "objectstore", f"unimplemented operation {name}()", command=name)
            raise SubstitutionGap(f"the object-store substitute does not implement {name}()")

        return _unsupported


class _BytesBody:
    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self, amt: int | None = None) -> bytes:
        return self._payload if amt is None else self._payload[:amt]

    def close(self) -> None:
        return None


class ClientError(Exception):
    """botocore's error shape, enough for ``except ClientError`` to work."""

    def __init__(self, code: str, message: str):
        super().__init__(f"An error occurred ({code}): {message}")
        self.response = {"Error": {"Code": code, "Message": message}}


# ---------------------------------------------------------------------------
# Installation — patch what is installed, provide what is not
# ---------------------------------------------------------------------------

#: Drivers that conform to PEP 249. The list is a set of KNOWN NAMES, not of
#: known behaviours: every one of them is served by the same adapter precisely
#: because the interface is specified, so extending it is a one-line change and
#: never a new code path.
PEP249_DRIVERS: tuple[str, ...] = (
    "psycopg",
    "psycopg2",
    "psycopg2cffi",
    "pymysql",
    "MySQLdb",
    "mysql.connector",
    "pg8000",
    "cx_Oracle",
    "oracledb",
    "pyodbc",
    "snowflake.connector",
)

#: Database clients this module deliberately does NOT substitute, and why.
#:
#: The list above works because PEP 249 SPECIFIES the interface, so substituting
#: a conforming driver is never a new code path. These two do not conform, and
#: including them was actively harmful: the substitute installs a SYNCHRONOUS
#: `connect()`, so a repo doing `await asyncpg.connect(...)` got
#: `TypeError: object Connection can't be used in 'await' expression`, and
#: `clickhouse_driver.Client(...)` got `AttributeError`. Both are builtins
#: raised in the REPO's own frame, so containment does not match them and
#: neither message is a malformed-call marker — they reached `policy.is_defect`
#: and were reportable as defects in the repo. Worse, the stub is synthesized
#: when the package is ABSENT, so this fired on machines that never had the
#: driver — every CI runner.
#:
#: Leaving them out means the target fails to connect and lands `contained`,
#: which is correct and honest.
NON_PEP249_CLIENTS: dict[str, str] = {
    # async-native, no PEP 249 surface at all
    "asyncpg": "async-native API (await connect/fetch); no DB-API 2.0 surface",
    # its DB-API lives in a submodule; the top level is a Client class
    "clickhouse_driver": "top-level API is Client(...); DB-API is in .dbapi",
}

KV_MODULES: tuple[str, ...] = ("redis", "valkey")
OBJECTSTORE_MODULES: tuple[str, ...] = ("boto3",)

_installed = False
_pending: dict[str, Any] = {}
_FIXTURES: list[dict[str, Any]] = []
#: Submodules the patchers minted (e.g. `redis.exceptions`) — popped on reset,
#: because one left behind permanently shadows a real submodule imported later.
_MINTED_SUBMODULES: list[str] = []
_REAL_IMPORT: Any = None
_FINDER: _StubFinder | None = None


def _patch_pep249(module: types.ModuleType) -> None:
    module.connect = connect  # type: ignore[attr-defined]
    module.Connection = Connection  # type: ignore[attr-defined]
    module.Cursor = Cursor  # type: ignore[attr-defined]
    for name in (
        "Error",
        "DatabaseError",
        "OperationalError",
        "IntegrityError",
        "ProgrammingError",
        "InterfaceError",
        "DataError",
        "NotSupportedError",
        "InternalError",
    ):
        # A really-installed driver defines its own hierarchy, and the repo may
        # hold references to it from an earlier import. The substitute's class
        # is MERGED under the driver's (a subclass of both), then set on the
        # module — so `except psycopg2.IntegrityError` catches what the
        # substitute raises through either reference. Providing our class only
        # when the driver "lacks" one was reproduced letting a repo's correct
        # except clause miss the substitute's error entirely.
        existing = getattr(module, name, None)
        setattr(
            module, name, _merge_exception(name, existing) if existing is not None else _EXC[name]
        )
    if not hasattr(module, "Warning"):
        module.Warning = Warning  # type: ignore[attr-defined]
    module.apilevel = getattr(module, "apilevel", "2.0")  # type: ignore[attr-defined]
    module.paramstyle = "pyformat"  # type: ignore[attr-defined]
    module.__vinv_substituted__ = True  # type: ignore[attr-defined]


class _KVConnectionPool:
    """redis.ConnectionPool's shape; connections are free here."""

    def __init__(self, *args: Any, **kwargs: Any):
        self.connection_kwargs = dict(kwargs)

    @classmethod
    def from_url(cls, url: str, **kwargs: Any) -> _KVConnectionPool:
        return cls(**kwargs)

    def disconnect(self, *args: Any, **kwargs: Any) -> None:
        return None


class KVError(Exception):
    """redis.RedisError's place in the hierarchy."""


class KVConnectionError(KVError):
    pass


class KVTimeoutError(KVError):
    pass


def _patch_kv(module: types.ModuleType) -> None:
    module.Redis = KeyValueDouble  # type: ignore[attr-defined]
    module.StrictRedis = KeyValueDouble  # type: ignore[attr-defined]
    module.from_url = KeyValueDouble.from_url  # type: ignore[attr-defined]
    module.ConnectionPool = _KVConnectionPool  # type: ignore[attr-defined]
    for name, obj in (
        ("RedisError", KVError),
        ("ConnectionError", KVConnectionError),
        ("TimeoutError", KVTimeoutError),
    ):
        if not hasattr(module, name):
            setattr(module, name, obj)
    # `from redis.exceptions import ConnectionError` is the common spelling; a
    # stubbed top-level module without the submodule fails at import and the
    # target never runs.
    exc_name = f"{module.__name__}.exceptions"
    if exc_name not in sys.modules:
        _MINTED_SUBMODULES.append(exc_name)
        exceptions = types.ModuleType(exc_name)
        exceptions.RedisError = KVError  # type: ignore[attr-defined]
        exceptions.ConnectionError = KVConnectionError  # type: ignore[attr-defined]
        exceptions.TimeoutError = KVTimeoutError  # type: ignore[attr-defined]
        exceptions.ResponseError = KVError  # type: ignore[attr-defined]
        exceptions.DataError = KVError  # type: ignore[attr-defined]
        exceptions.__vinv_stub__ = getattr(module, "__vinv_stub__", False)  # type: ignore[attr-defined]
        sys.modules[exc_name] = exceptions
        module.exceptions = exceptions  # type: ignore[attr-defined]
    module.__vinv_substituted__ = True  # type: ignore[attr-defined]


def _patch_objectstore(module: types.ModuleType) -> None:
    root = os.path.join(_DEFAULT_DIR or ".", "objectstore")

    def _client(service: str = "s3", *args: Any, **kwargs: Any) -> Any:
        if service != "s3":
            _record(
                FIDELITY_GAP, "objectstore", f"no stand-in for service {service!r}", service=service
            )
            raise SubstitutionGap(f"no stand-in for AWS service {service!r}")
        return ObjectStoreDouble(root)

    module.client = _client  # type: ignore[attr-defined]
    module.resource = _client  # type: ignore[attr-defined]
    module.__vinv_substituted__ = True  # type: ignore[attr-defined]


_SQLA_URL = re.compile(
    r"^(postgres|postgresql|mysql|mariadb|oracle|mssql|cockroachdb)(\+\w+)?://", re.I
)


def substitute_url(url: str) -> str:
    """Rewrite a server-backed SQLAlchemy URL to a jail-local sqlite one.

    One rewrite covers SQLAlchemy and therefore everything layered on it, which
    is why this is the cut point rather than each ORM in turn.
    """
    if not isinstance(url, str) or not _SQLA_URL.match(url):
        return url
    name = _db_name(url)
    path = os.path.join(_DEFAULT_DIR or ".", f"vinv-{name}.sqlite3")
    _record(SUBSTITUTED, "sql", f"{url.split('://')[0]}:// -> sqlite ({name})", url=url[:120])
    return f"sqlite:///{path}"


def _patch_sqlalchemy(module: types.ModuleType) -> None:
    real_create = getattr(module, "create_engine", None)
    if real_create is None:
        return

    def create_engine(url: Any, *args: Any, **kwargs: Any) -> Any:
        backend: _SqlBackend | None = None
        if isinstance(url, str):
            rewritten = substitute_url(url)
            if rewritten != url:
                # MATERIALISE the backend before SQLAlchemy touches the file:
                # constructing it is what applies the repo's declared metadata
                # and DDL. Rewriting only the URL string was reproduced handing
                # the best-prepared repo an empty database.
                name = _db_name(url)
                backend = _SqlBackend.get(
                    name,
                    os.path.join(_DEFAULT_DIR or ".", f"vinv-{name}.sqlite3"),
                    seed_rows=_SEED_ROWS,
                )
                url = rewritten
        # Server-side pool arguments sqlite's dialect rejects; dropping them is
        # part of the substitution, not a change in behaviour under test.
        for key in ("pool_size", "max_overflow", "pool_timeout", "connect_args"):
            if key in kwargs and str(url).startswith("sqlite"):
                kwargs.pop(key)
        engine = real_create(url, *args, **kwargs)
        if backend is not None:
            _attach_repair(module, engine, backend)
        return engine

    module.create_engine = create_engine  # type: ignore[attr-defined]
    module.__vinv_substituted__ = True  # type: ignore[attr-defined]


def _attach_repair(module: types.ModuleType, engine: Any, backend: _SqlBackend) -> None:
    """Route the sqlalchemy path's failures through the same repair loop.

    SQLAlchemy drives its own sqlite connection, so the substitute cannot
    intercept execution — but it CAN hear the errors. A schema failure repairs
    the shared database file for every later statement, and the failing call
    surfaces as a ``SubstitutionGap`` (this is the harness's empty jail, not
    the repo's bug) instead of an ``OperationalError`` blamed on the repo.
    """
    try:
        event = __import__(f"{module.__name__}.event", fromlist=["event"])

        @event.listens_for(engine, "handle_error")
        def _on_error(context: Any) -> None:
            exc = getattr(context, "original_exception", None)
            if not isinstance(exc, sqlite3.OperationalError):
                return  # integrity/programming errors are the DATABASE answering
            statement = str(getattr(context, "statement", "") or "")
            repaired = False
            try:
                repaired = backend.repair(statement, str(exc))
            except sqlite3.Error:  # pragma: no cover - repair itself failed
                repaired = False
            if not repaired:
                _record(
                    FIDELITY_GAP,
                    f"sql:{backend.name}",
                    f"{exc} :: {statement[:200]}",
                    statement=statement[:200],
                )
            raise SubstitutionGap(
                "the SQL substitute could not honour this statement via SQLAlchemy: "
                f"{exc}" + (" (schema induced; retries will succeed)" if repaired else "")
            ) from exc

    except Exception:  # pragma: no cover - no event API on this SQLAlchemy
        _record(
            FIDELITY_GAP,
            f"sql:{backend.name}",
            "could not attach the repair hook to a SQLAlchemy engine",
        )


class _StubFinder:
    """Serve an ABSENT client library from the same substitute.

    A repo that imports ``psycopg2`` without it installed would fail at import
    and never reach the code under test. The finder is consulted last, so a
    real installation always wins — this only fills genuine holes.
    """

    def __init__(self, names: dict[str, Any]):
        self._names = names
        self.created: list[str] = []

    def find_module(self, fullname: str, path: Any = None) -> Any:  # pragma: no cover - py2 shim
        return self if fullname in self._names else None

    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        if fullname not in self._names:
            return None
        import importlib.machinery as machinery

        return machinery.ModuleSpec(fullname, self)

    def create_module(self, spec: Any) -> types.ModuleType:
        module = types.ModuleType(spec.name)
        module.__vinv_stub__ = True  # type: ignore[attr-defined]
        self.created.append(spec.name)
        return module

    def exec_module(self, module: types.ModuleType) -> None:
        self._names[module.__name__](module)


def install(
    *,
    directory: str,
    ledger: str = "",
    seed_rows: int = 1,
    stub_absent: bool = True,
    schema_sources: list[dict[str, Any]] | None = None,
    fixtures: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Activate the doubles for this process. Idempotent.

    ``directory`` is where substitute state lives — inside the jail, so the
    whole synthesised environment is discarded with the sandbox tree.
    ``fixtures`` are agent-supplied rows from earlier runs' induced-schema
    questions; they replace placeholder seeding with representative data.
    """
    global _installed, _ledger_path, _DEFAULT_DIR, _SEED_ROWS
    if _installed:
        return {"installed": False, "reason": "already installed"}
    _DEFAULT_DIR = directory
    _SEED_ROWS = seed_rows
    _ledger_path = ledger
    os.makedirs(directory, exist_ok=True)
    _FIXTURES.extend(f for f in (fixtures or []) if isinstance(f, dict))

    statements: list[str] = []
    metadata: list[str] = []
    for source in schema_sources or []:
        statements.extend(source.get("statements") or [])
        if source.get("kind") == "sqlalchemy-metadata" and source.get("target"):
            metadata.append(str(source["target"]))
    declare_schema(statements=statements, metadata=metadata)

    patchers: dict[str, Any] = {}
    for name in PEP249_DRIVERS:
        patchers[name] = _patch_pep249
    for name in KV_MODULES:
        patchers[name] = _patch_kv
    for name in OBJECTSTORE_MODULES:
        patchers[name] = _patch_objectstore
    patchers["sqlalchemy"] = _patch_sqlalchemy
    _pending.clear()
    _pending.update(patchers)

    # Already-imported modules are patched now; the rest are patched as they
    # arrive. Patching through ``__import__`` rather than a meta_path finder
    # keeps the REAL loader in charge of loading — the substitute only ever
    # decorates what the interpreter produced.
    for name, patch in list(patchers.items()):
        module = sys.modules.get(name)
        if module is not None:
            patch(module)

    global _REAL_IMPORT
    real_import = builtins.__import__
    # Never wrap our own wrapper — install() after an incomplete reset (or a
    # second install in one process) was reproduced stacking twenty wrappers
    # onto every subsequent import.
    if getattr(real_import, "__vinv_service_wrapper__", False):
        real_import = _REAL_IMPORT or real_import
    _REAL_IMPORT = real_import

    def _vinv_import(name: str, globals=None, locals=None, fromlist=(), level=0):  # noqa: A002
        module = real_import(name, globals, locals, fromlist, level)
        for candidate in {name, getattr(module, "__name__", "")} | {
            f"{name}.{f}" for f in (fromlist or ())
        }:
            patch = _pending.get(candidate)
            if patch is None:
                continue
            target = sys.modules.get(candidate)
            if target is not None and not getattr(target, "__vinv_substituted__", False):
                patch(target)
        return module

    _vinv_import.__vinv_service_wrapper__ = True  # type: ignore[attr-defined]
    builtins.__import__ = _vinv_import

    global _FINDER
    if stub_absent:
        absent = {}
        for name, patch in patchers.items():
            if name == "sqlalchemy" or "." in name:
                continue  # never stub a package the repo may genuinely lack a submodule of
            if sys.modules.get(name) is None and not _importable(name):
                absent[name] = patch
        if absent:
            _FINDER = _StubFinder(absent)
            sys.meta_path.append(_FINDER)

    _installed = True
    return {
        "installed": True,
        "directory": directory,
        "patched": sorted(patchers),
        "declared_statements": len(statements),
        "declared_metadata": len(metadata),
    }


def _importable(name: str) -> bool:
    try:
        import importlib.util

        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, AttributeError):
        return False


def summary() -> dict[str, Any]:
    """What the doubles did, in the shape the run document wants."""
    by_kind: dict[str, int] = {}
    for event in _events:
        by_kind[event["kind"]] = by_kind.get(event["kind"], 0) + 1
    return {
        "substituted": by_kind.get(SUBSTITUTED, 0),
        "induced_schema": by_kind.get(INDUCED, 0),
        "seeded_rows": by_kind.get(SEEDED, 0),
        "substitution_gaps": by_kind.get(FIDELITY_GAP, 0),
        "events": _events[:200],
    }
