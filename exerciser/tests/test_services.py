"""Environment synthesis: the services a repo assumes, provided inside the jail.

The claim under test is narrow and load-bearing: a target that needs Postgres,
Redis or S3 should RUN under containment — not connect out, not be skipped —
and a target that needs a populated schema should find one. The tests also pin
the honesty half, which matters more than the coverage half: what the stand-in
cannot do is recorded as the HARNESS's shortfall, never as a defect in the repo,
and a row invented by the harness is legible as invented.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from exerciser import service_doubles as sd
from exerciser import services
from exerciser.sandbox import SandboxPolicy, prepare_sandbox


@pytest.fixture(autouse=True)
def _clean_doubles(tmp_path: Path):
    sd.reset()
    yield
    sd.reset()


def _connect(tmp_path: Path, **kwargs):
    sd.install(directory=str(tmp_path / "svc"), **kwargs)
    return sd.connect("postgresql://user@localhost:5432/app")


# =========================================================================
# The substitute is a real PEP 249 driver
# =========================================================================


def test_a_postgres_dsn_is_served_without_a_postgres(tmp_path: Path):
    conn = _connect(tmp_path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)")
    cur.execute("INSERT INTO widgets (name) VALUES (%s)", ("hello",))
    conn.commit()
    cur.execute("SELECT name FROM widgets WHERE name = %s", ("hello",))
    assert cur.fetchall() == [("hello",)]
    # …and the substitution is recorded, not silent.
    assert any(e["kind"] == sd.SUBSTITUTED for e in sd.events())


def test_pyformat_parameters_survive_the_translation(tmp_path: Path):
    conn = _connect(tmp_path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)")
    cur.execute("INSERT INTO t (a) VALUES (%(a)s)", {"a": "x"})
    cur.execute("SELECT a FROM t WHERE a = %(a)s", {"a": "x"})
    assert cur.fetchall() == [("x",)]


def test_an_escaped_percent_is_not_eaten_by_the_translation(tmp_path: Path):
    # `%%` is a literal percent; a translator that rewrote it would corrupt
    # every LIKE pattern in the repo.
    conn = _connect(tmp_path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)")
    cur.execute("INSERT INTO t (a) VALUES (%s)", ("50% off",))
    cur.execute("SELECT a FROM t WHERE a LIKE '%%off'")
    assert cur.fetchall() == [("50% off",)]


def test_the_dbapi_exception_hierarchy_is_the_one_the_repo_catches(tmp_path: Path):
    conn = _connect(tmp_path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT UNIQUE)")
    cur.execute("INSERT INTO t (a) VALUES (%s)", ("dup",))
    with pytest.raises(sd.IntegrityError):
        cur.execute("INSERT INTO t (a) VALUES (%s)", ("dup",))
    # PEP 249 §8: IntegrityError is a DatabaseError is an Error.
    assert issubclass(sd.IntegrityError, sd.DatabaseError)
    assert issubclass(sd.DatabaseError, sd.Error)


def test_two_dsns_are_two_databases(tmp_path: Path):
    sd.install(directory=str(tmp_path / "svc"))
    a = sd.connect("postgresql://h/alpha")
    b = sd.connect("postgresql://h/beta")
    a.cursor().execute("CREATE TABLE only_in_a (id INTEGER PRIMARY KEY)")
    rows = b.cursor().execute("SELECT name FROM sqlite_master WHERE name = 'only_in_a'").fetchall()
    assert rows == []


# =========================================================================
# Schema: declared beats induced, induced beats nothing
# =========================================================================


def test_a_missing_table_is_induced_from_the_failing_statement(tmp_path: Path):
    conn = _connect(tmp_path, seed_rows=0)
    cur = conn.cursor()
    # Nothing created `accounts`. A real server would raise, the target would
    # be recorded as rejected, and the code path would never run.
    cur.execute("SELECT email FROM accounts WHERE email = %s", ("a@b.c",))
    assert cur.fetchall() == []  # ran, rather than exploding
    induced = [e for e in sd.events() if e["kind"] == sd.INDUCED]
    assert induced and induced[0]["table"] == "accounts"
    assert "email" in induced[0]["columns"], "the column came off the statement itself"


def test_an_induced_table_is_seeded_so_a_read_path_has_something_to_read(tmp_path: Path):
    conn = _connect(tmp_path, seed_rows=2)
    rows = conn.cursor().execute("SELECT id, name FROM users").fetchall()
    assert len(rows) == 2, "the fixture gap is what this closes"
    assert any(e["kind"] == sd.SEEDED for e in sd.events()), "invented data says so"


def test_a_missing_column_on_an_existing_table_is_added(tmp_path: Path):
    conn = _connect(tmp_path, seed_rows=0)
    cur = conn.cursor()
    cur.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY)")
    cur.execute("INSERT INTO orders (total) VALUES (%s)", (10,))
    assert cur.execute("SELECT total FROM orders").fetchall() == [(10,)]
    assert any(e.get("column") == "total" for e in sd.events())


def test_the_repair_loop_terminates_on_a_statement_it_cannot_fix(tmp_path: Path):
    conn = _connect(tmp_path)
    with pytest.raises(sd.SubstitutionGap):
        conn.cursor().execute("SELECT * FROM t GROUP BY ROLLUP(a)")
    gaps = [e for e in sd.events() if e["kind"] == sd.FIDELITY_GAP]
    assert gaps, "the harness's own shortfall is recorded as the harness's"


def test_declared_ddl_is_applied_before_anything_runs(tmp_path: Path):
    sd.install(
        directory=str(tmp_path / "svc"),
        seed_rows=0,
        schema_sources=[
            {
                "kind": "ddl",
                "detail": "schema.sql",
                "statements": ["CREATE TABLE people (id SERIAL PRIMARY KEY, nickname TEXT);"],
            }
        ],
    )
    conn = sd.connect("postgresql://h/app")
    conn.cursor().execute("INSERT INTO people (nickname) VALUES (%s)", ("ada",))
    assert conn.cursor().execute("SELECT nickname FROM people").fetchall() == [("ada",)]
    # The repo DECLARED this table, so nothing was induced for it.
    assert not [e for e in sd.events() if e["kind"] == sd.INDUCED]
    assert any(e["kind"] == "declared-schema" for e in sd.events())


# =========================================================================
# Key-value and object store
# =========================================================================


def test_the_keyspace_serves_the_commands_a_repo_actually_uses(tmp_path: Path):
    sd.install(directory=str(tmp_path / "svc"))
    r = sd.KeyValueDouble(decode_responses=True)
    assert r.ping() is True
    r.set("k", "v")
    assert r.get("k") == "v"
    assert r.incr("counter") == 1 and r.incr("counter", 2) == 3
    r.hset("h", mapping={"a": "1"})
    assert r.hgetall("h") == {"a": "1"}
    r.rpush("q", "x", "y")
    assert r.lrange("q", 0, -1) == ["x", "y"]
    r.sadd("s", "m")
    assert r.sismember("s", "m")
    assert r.exists("k") == 1 and r.delete("k") == 1 and r.exists("k") == 0


def test_bytes_are_returned_unless_the_caller_asked_for_strings(tmp_path: Path):
    sd.install(directory=str(tmp_path / "svc"))
    raw = sd.KeyValueDouble()
    raw.set("k", "v")
    assert raw.get("k") == b"v", "redis-py returns bytes without decode_responses"


def test_an_unimplemented_command_raises_instead_of_inventing_an_answer(tmp_path: Path):
    sd.install(directory=str(tmp_path / "svc"))
    r = sd.KeyValueDouble()
    with pytest.raises(sd.SubstitutionGap):
        r.xadd("stream", {"a": 1})
    assert any(e["kind"] == sd.FIDELITY_GAP for e in sd.events())


def test_the_object_store_round_trips_through_the_jail(tmp_path: Path):
    sd.install(directory=str(tmp_path / "svc"))
    s3 = sd.ObjectStoreDouble(str(tmp_path / "svc" / "objectstore"))
    s3.create_bucket(Bucket="b")
    s3.put_object(Bucket="b", Key="k.txt", Body=b"payload")
    assert s3.get_object(Bucket="b", Key="k.txt")["Body"].read() == b"payload"
    assert s3.list_objects_v2(Bucket="b")["KeyCount"] == 1
    with pytest.raises(sd.ClientError):
        s3.get_object(Bucket="b", Key="missing")


# =========================================================================
# Installation
# =========================================================================


def test_an_absent_driver_is_served_rather_than_failing_at_import(tmp_path: Path):
    pytest.importorskip("sqlite3")
    sd.install(directory=str(tmp_path / "svc"))
    import psycopg2  # noqa: PLC0415 - the point of the test is that this import works

    assert getattr(psycopg2, "__vinv_stub__", False) or getattr(
        psycopg2, "__vinv_substituted__", False
    )
    conn = psycopg2.connect("postgresql://h/app")
    conn.cursor().execute("SELECT 1")


def test_a_server_backed_url_is_rewritten_to_a_jail_local_one(tmp_path: Path):
    sd.install(directory=str(tmp_path / "svc"))
    out = sd.substitute_url("postgresql+psycopg://u:p@db.internal:5432/prod")
    assert out.startswith("sqlite:///")
    # sqlite URLs and non-URLs pass through untouched.
    assert sd.substitute_url("sqlite:///x.db") == "sqlite:///x.db"
    assert sd.substitute_url("not a url") == "not a url"


# =========================================================================
# Planning — what the repo needs is READ, never configured
# =========================================================================


def _repo(tmp_path: Path, files: dict[str, str]) -> Path:
    for name, body in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    return tmp_path


def test_requirements_are_discovered_from_the_repos_own_imports(tmp_path: Path):
    repo = _repo(
        tmp_path,
        {
            "app/db.py": "import psycopg2\n\ndef q():\n    return psycopg2.connect('')\n",
            "app/cache.py": "import redis\n",
            "app/blob.py": "import boto3\n",
        },
    )
    families = {r.family for r in services.discover_requirements(repo)}
    assert families == {services.SQL_FAMILY, services.KV_FAMILY, services.OBJECTSTORE_FAMILY}


def test_a_repo_that_needs_nothing_gets_no_substitution(tmp_path: Path):
    repo = _repo(tmp_path, {"pure.py": "def add(a, b):\n    return a + b\n"})
    plan = services.plan_services(repo)
    assert plan.requirements == []
    assert plan.needed is False, "no service, no cost"


def test_a_dsn_in_settings_counts_as_evidence(tmp_path: Path):
    repo = _repo(tmp_path, {"settings.py": "URL = 'postgresql://u@h:5432/db'\n"})
    reqs = services.discover_requirements(repo)
    assert [r.family for r in reqs] == [services.SQL_FAMILY]


def test_sqlalchemy_models_are_found_and_preferred_over_ddl(tmp_path: Path):
    repo = _repo(
        tmp_path,
        {
            "models.py": (
                "from sqlalchemy.orm import declarative_base\n"
                "import psycopg2\n"
                "Base = declarative_base()\n"
            ),
            "sql/schema.sql": "CREATE TABLE t (id INT);\n",
        },
    )
    sources = services.discover_schema_sources(repo)
    kinds = [s.kind for s in sources]
    assert kinds[0] == "sqlalchemy-metadata", "a model declaration is richer than stray DDL"
    assert "ddl" in kinds
    assert sources[0].target == "models:Base.metadata"


def test_ddl_statements_are_collected_verbatim(tmp_path: Path):
    repo = _repo(
        tmp_path,
        {
            "app.py": "import psycopg2\n",
            "db/schema.sql": "CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);\n",
        },
    )
    plan = services.plan_services(repo)
    ddl = [s for s in plan.schema_sources if s.kind == "ddl"]
    assert ddl and len(ddl[0].statements) == 2


# =========================================================================
# Fixtures the structure could not supply
# =========================================================================


def test_an_induced_table_becomes_one_cached_fixture_question(tmp_path: Path):
    from exerciser import store

    store.exercise_dir(tmp_path).mkdir(parents=True, exist_ok=True)
    induced = [{"table": "accounts", "columns": ["email", "plan"]}]
    channel, answered = services.fixture_questions(tmp_path, induced)
    channel.save()
    assert answered == []

    path = store.exercise_dir(tmp_path) / "agent_fixture.json"
    doc = store.read_json(path)
    key = next(iter(doc["questions"]))
    doc["questions"][key]["answer"] = {
        "rows": [{"email": "real@example.com", "plan": "pro"}],
        "adequate": False,
    }
    store.write_json(path, doc)

    channel2, answered2 = services.fixture_questions(tmp_path, induced)
    assert answered2 == [
        {"table": "accounts", "rows": [{"email": "real@example.com", "plan": "pro"}]}
    ]
    assert channel2.save()["asked_this_run"] == 0, "answered once, cached forever"


def test_answered_fixtures_are_inserted_into_the_substitute(tmp_path: Path):
    conn = _connect(tmp_path, seed_rows=0)
    conn.cursor().execute("SELECT email FROM accounts")  # induces the table
    db = Path(next(iter(sd._SqlBackend._instances.values())).path)
    written = services.apply_fixtures(
        db, [{"table": "accounts", "rows": [{"email": "real@example.com"}]}]
    )
    assert written == 1
    assert conn.cursor().execute("SELECT email FROM accounts").fetchall() == [("real@example.com",)]


def test_apply_fixtures_ignores_columns_the_table_does_not_have(tmp_path: Path):
    conn = _connect(tmp_path, seed_rows=0)
    conn.cursor().execute("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)")
    db = Path(next(iter(sd._SqlBackend._instances.values())).path)
    assert services.apply_fixtures(db, [{"table": "t", "rows": [{"a": "1", "nope": "2"}]}]) == 1
    assert services.apply_fixtures(db, [{"table": "t", "rows": [{"nope": "2"}]}]) == 0


# =========================================================================
# The sandbox carries the plan
# =========================================================================


def test_the_sandbox_writes_a_plan_the_worker_can_read(tmp_path: Path):
    repo = _repo(
        tmp_path / "repo",
        {"app.py": "import psycopg2\n", "sql/s.sql": "CREATE TABLE t (id INT);\n"},
    )
    policy = SandboxPolicy(enabled=True, root_parent=tmp_path / "roots")
    (tmp_path / "roots").mkdir()
    sandbox = prepare_sandbox(repo, policy)
    try:
        assert sandbox.service_plan is not None
        doc = json.loads(sandbox.service_plan.read_text(encoding="utf-8"))
        assert doc["enabled"] is True
        assert [r["family"] for r in doc["requirements"]] == [services.SQL_FAMILY]
        assert doc["schema_sources"][0]["kind"] == "ddl"
        # The runtime module ships beside the shim, since the worker has only
        # the standard library and the repo on its path.
        assert (sandbox.shim / "_vinv_service_doubles.py").is_file()
    finally:
        sandbox.dispose()


def test_synthesis_can_be_turned_off_and_then_nothing_is_planned(tmp_path: Path):
    repo = _repo(tmp_path / "repo", {"app.py": "import psycopg2\n"})
    (tmp_path / "roots").mkdir()
    policy = SandboxPolicy(enabled=True, synthesize_services=False, root_parent=tmp_path / "roots")
    sandbox = prepare_sandbox(repo, policy)
    try:
        assert sandbox.service_plan is None
    finally:
        sandbox.dispose()


# =========================================================================
# Induction reads the statement — it does not guess from names
# =========================================================================


def test_a_tables_own_name_is_not_induced_as_one_of_its_columns(tmp_path: Path):
    conn = _connect(tmp_path, seed_rows=0)
    conn.cursor().execute("SELECT customers.email FROM customers WHERE customers.tier = %s", ("x",))
    induced = [e for e in sd.events() if e["kind"] == sd.INDUCED][0]
    assert sorted(induced["columns"]) == ["email", "tier"]
    assert "customers" not in induced["columns"]


def test_a_counter_column_is_seeded_as_a_number(tmp_path: Path):
    # Not cosmetic. sqlite orders TEXT above every INTEGER, so a string here
    # would make `order_count >= 3` silently TRUE and the branch under test
    # would never run — an invented row manufacturing a verdict.
    conn = _connect(tmp_path, seed_rows=1)
    rows = (
        conn.cursor()
        .execute(
            "SELECT customers.order_count FROM customers WHERE customers.order_count >= %s", (3,)
        )
        .fetchall()
    )
    assert rows == [], "a seeded count of 1 must not satisfy >= 3"
    assert isinstance(sd._seed_value("order_count", 0), int)
    assert isinstance(sd._seed_value("retry_attempts", 0), int)
    assert isinstance(sd._seed_value("is_active", 0), int)
    assert isinstance(sd._seed_value("unit_price", 0), float)
    assert sd._seed_value("created_at", 0) == "2020-01-01 00:00:00"


# =========================================================================
# Audit regressions — each of these reproduced a real failure before its fix
# =========================================================================


def test_a_substitution_gap_is_never_a_defect_in_the_repo(tmp_path: Path):
    # THE honesty guarantee. A SubstitutionGap scored 0.605 as
    # `function-crash` before the containment rule existed.
    from exerciser.sandbox import mark_contained

    row = {
        "status": "error",
        "error_type": "SubstitutionGap",
        "error_module": "_vinv_service_doubles",
        "error_mro": ["SubstitutionGap", "Exception", "BaseException"],
        "error": "the SQL substitute could not honour this statement",
    }
    out = mark_contained(dict(row))
    assert out["contained"] is True
    assert out["contained_by"] == "service-substitute"
    assert out["effects"]["substitution-gap"]

    from exerciser.functions import classify_row

    assert classify_row(out) is None, "a gap is never a reportable defect, structurally"


def test_percent_literals_survive_when_no_parameters_are_passed(tmp_path: Path):
    # The driver does no interpolation without params — neither may we.
    conn = _connect(tmp_path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
    cur.execute("INSERT INTO t (name) VALUES ('discount 100%save')")
    assert cur.execute("SELECT name FROM t").fetchall() == [("discount 100%save",)]
    cur.execute("INSERT INTO t (name) VALUES (%s)", ("Jackson",))
    assert cur.execute("SELECT name FROM t WHERE name LIKE '%son'").fetchall() == [("Jackson",)]


def test_percent_escape_scans_left_to_right(tmp_path: Path):
    # '%%%s' means "literal percent, then placeholder" — a lookbehind regex
    # was reproduced corrupting the placeholder count.
    conn = _connect(tmp_path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
    cur.execute("INSERT INTO t (name) VALUES (%s)", ("%b",))
    assert cur.execute("SELECT name FROM t WHERE name LIKE '%%%s'", ("b",)).fetchall() == [("%b",)]


def test_like_is_case_sensitive_as_postgres_is(tmp_path: Path):
    conn = _connect(tmp_path, seed_rows=0)
    cur = conn.cursor()
    cur.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
    cur.executemany("INSERT INTO t (name) VALUES (%s)", [("Bob",), ("bob",)])
    assert cur.execute("SELECT name FROM t WHERE name LIKE 'B%'").fetchall() == [("Bob",)]
    # …and ILIKE stays case-insensitive, as Postgres defines it.
    got = cur.execute("SELECT name FROM t WHERE name ILIKE 'B%' ORDER BY name").fetchall()
    assert got == [("Bob",), ("bob",)]


def test_a_column_named_uuid_is_not_rewritten(tmp_path: Path):
    # `\bUUID\b -> TEXT` was reproduced renaming a COLUMN in a WHERE clause.
    conn = _connect(tmp_path, seed_rows=0)
    cur = conn.cursor()
    cur.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, uuid TEXT, email TEXT)")
    cur.execute("INSERT INTO users (uuid, email) VALUES (%s, %s)", ("u-1", "a@x.com"))
    assert cur.execute("SELECT email FROM users WHERE uuid = %s", ("u-1",)).fetchall() == [
        ("a@x.com",)
    ]


def test_a_float_cast_stays_a_float_cast(tmp_path: Path):
    # Deleting `::float` was reproduced turning a ratio into integer division.
    conn = _connect(tmp_path, seed_rows=0)
    cur = conn.cursor()
    cur.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, d INTEGER)")
    cur.execute("INSERT INTO t (n, d) VALUES (%s, %s)", (1, 2))
    assert cur.execute("SELECT n::float / d FROM t").fetchall() == [(0.5,)]
    # An inexpressible cast fails LOUDLY as a gap, never silently.
    with pytest.raises(sd.SubstitutionGap):
        cur.execute("SELECT (n + d)::money FROM t")


def test_insert_returning_works(tmp_path: Path):
    conn = _connect(tmp_path, seed_rows=0)
    cur = conn.cursor()
    cur.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")
    cur.execute("INSERT INTO t (name) VALUES (%s) RETURNING id", ("x",))
    assert cur.fetchone() == (1,)
    conn.commit()
    assert cur.execute("SELECT name FROM t").fetchall() == [("x",)]


def test_an_alias_repairs_the_real_table_not_a_phantom(tmp_path: Path):
    conn = _connect(tmp_path, seed_rows=0)
    cur = conn.cursor()
    cur.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)")
    cur.execute("SELECT u.phone FROM users u WHERE u.phone = %s", ("555",))
    tables = {
        r[0]
        for r in cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    assert "u" not in tables, "the alias must not become a phantom table"
    assert "phone" in {
        r[1]
        for r in sd._SqlBackend._instances[next(iter(sd._SqlBackend._instances))].raw.execute(
            "PRAGMA table_info('users')"
        )
    }


def test_a_numeric_comparison_in_the_statement_wins_over_the_name(tmp_path: Path):
    # `balance >= 100` is direct evidence `balance` holds numbers; the name
    # heuristic alone seeded a string, and string-vs-int comparison in sqlite
    # silently takes the wrong branch.
    conn = _connect(tmp_path, seed_rows=1)
    rows = (
        conn.cursor()
        .execute("SELECT balance FROM wallets WHERE balance >= %s AND balance < 100", (0,))
        .fetchall()
    )
    assert rows and all(isinstance(v, int | float) for (v,) in rows)


def test_seeded_values_are_in_the_ledger_not_just_a_count(tmp_path: Path):
    conn = _connect(tmp_path, seed_rows=1)
    conn.cursor().execute("SELECT email FROM accounts")
    seeded = [e for e in sd.events() if e["kind"] == sd.SEEDED]
    assert seeded and seeded[0].get("rows"), "invented data must be legible as invented"


def test_a_merged_hierarchy_keeps_the_repos_except_clause_working(tmp_path: Path):
    import types as _types

    fake = _types.ModuleType("fakedriver")

    class RealError(Exception):
        pass

    class RealIntegrityError(RealError):
        pass

    fake.Error = RealError
    fake.IntegrityError = RealIntegrityError
    sd.install(directory=str(tmp_path / "svc"))
    sd._patch_pep249(fake)
    conn = fake.connect("postgresql://h/app")
    cur = conn.cursor()
    cur.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, e TEXT UNIQUE)")
    cur.execute("INSERT INTO t (e) VALUES (%s)", ("dup",))
    caught = False
    try:
        cur.execute("INSERT INTO t (e) VALUES (%s)", ("dup",))
    except fake.IntegrityError:
        caught = True
    assert caught, "the repo's `except driver.IntegrityError` must catch the substitute's raise"


def test_reset_restores_the_import_machinery(tmp_path: Path):
    import builtins

    before = builtins.__import__
    sd.install(directory=str(tmp_path / "svc"))
    sd.install(directory=str(tmp_path / "svc2"))  # second install must not stack
    sd.reset()
    assert builtins.__import__ is before, "the wrapper must come off on reset"
    import sys as _sys

    assert not any(type(f).__name__ == "_StubFinder" for f in _sys.meta_path)


def test_the_ledger_is_append_only_across_workers(tmp_path: Path):
    # Two processes share one run's ledger; the second must not erase the
    # first's recorded gaps.
    ledger = tmp_path / "ledger.jsonl"
    sd.install(directory=str(tmp_path / "svc"), ledger=str(ledger))
    conn = sd.connect("postgresql://h/a")
    with pytest.raises(sd.SubstitutionGap):
        conn.cursor().execute("SELECT * FROM t GROUP BY ROLLUP(x)")
    first = ledger.read_text().count("substitution-gap")
    assert first >= 1
    sd.reset()
    sd.install(directory=str(tmp_path / "svc"), ledger=str(ledger))
    sd.connect("postgresql://h/b")
    assert ledger.read_text().count("substitution-gap") >= first, "gaps must survive"

    from exerciser.sandbox import _read_service_ledger

    summary = _read_service_ledger(ledger)
    assert summary["substitution_gaps"] >= 1


def test_sqlalchemy_engines_get_the_declared_schema(tmp_path: Path):
    sqlalchemy = pytest.importorskip("sqlalchemy")
    sd.install(
        directory=str(tmp_path / "svc"),
        seed_rows=0,
        schema_sources=[
            {
                "kind": "ddl",
                "detail": "schema.sql",
                "statements": ["CREATE TABLE people (id SERIAL PRIMARY KEY, name TEXT);"],
            }
        ],
    )
    sd._patch_sqlalchemy(sqlalchemy)
    engine = sqlalchemy.create_engine("postgresql://db.internal:5432/prod")
    with engine.connect() as conn:
        rows = conn.execute(sqlalchemy.text("SELECT name FROM people")).fetchall()
    assert rows == [], "the declared table EXISTS on the sqlalchemy path"


def test_sqlalchemy_schema_failures_become_gaps_not_repo_errors(tmp_path: Path):
    sqlalchemy = pytest.importorskip("sqlalchemy")
    sd.install(directory=str(tmp_path / "svc"), seed_rows=1)
    sd._patch_sqlalchemy(sqlalchemy)
    engine = sqlalchemy.create_engine("postgresql://db.internal:5432/prod2")
    with pytest.raises(sd.SubstitutionGap):
        with engine.connect() as conn:
            conn.execute(sqlalchemy.text("SELECT email FROM customers"))
    # …the repair ran, so the next statement finds the induced, seeded table.
    with engine.connect() as conn:
        rows = conn.execute(sqlalchemy.text("SELECT email FROM customers")).fetchall()
    assert len(rows) == 1


def test_vendored_sql_files_cannot_starve_the_repos_own_ddl(tmp_path: Path):
    vend = tmp_path / ".venv" / "lib"
    vend.mkdir(parents=True)
    for i in range(250):
        (vend / f"v{i}.sql").write_text("CREATE TABLE vendored (id INT);", encoding="utf-8")
    real = tmp_path / "db"
    real.mkdir()
    (real / "schema.sql").write_text("CREATE TABLE mine (id INT);", encoding="utf-8")
    (tmp_path / "app.py").write_text("import psycopg2\n", encoding="utf-8")
    sources = services.discover_schema_sources(tmp_path)
    assert any("mine" in s.detail for s in sources), "the repo's own DDL must be found"


def test_module_path_starts_at_the_package_boundary(tmp_path: Path):
    pkg = tmp_path / "src" / "myapp"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "models.py").write_text(
        "from sqlalchemy.orm import declarative_base\nimport psycopg2\nBase = declarative_base()\n",
        encoding="utf-8",
    )
    sources = services.discover_schema_sources(tmp_path)
    assert (
        sources and sources[0].target == "myapp.models:Base.metadata"
    ), "src/ is a source root, not a package name"


def test_an_install_error_survives_into_the_summary(tmp_path: Path):
    from exerciser.sandbox import _read_service_ledger

    ledger = tmp_path / "ledger.jsonl"
    ledger.write_text(
        json.dumps({"kind": "install-error", "detail": "service doubles failed to install: boom"})
        + "\n",
        encoding="utf-8",
    )
    runtime = _read_service_ledger(ledger)
    assert runtime["error"].endswith("boom")
    out = services.summarise({"enabled": True}, runtime)
    assert "boom" in out["error"]
    assert any("did not install" in d for d in out["diagnostics"])


def test_declared_tables_are_seeded_too(tmp_path: Path):
    sd.install(
        directory=str(tmp_path / "svc"),
        seed_rows=1,
        schema_sources=[
            {
                "kind": "ddl",
                "detail": "s.sql",
                "statements": ["CREATE TABLE cfg (id SERIAL PRIMARY KEY, key TEXT);"],
            }
        ],
    )
    conn = sd.connect("postgresql://h/app")
    assert len(conn.cursor().execute("SELECT * FROM cfg").fetchall()) == 1


def test_agent_fixtures_ride_into_the_jail_and_replace_placeholders(tmp_path: Path):
    conn = _connect(
        tmp_path, fixtures=[{"table": "accounts", "rows": [{"email": "real@co.com"}]}], seed_rows=1
    )
    rows = conn.cursor().execute("SELECT email FROM accounts").fetchall()
    emails = {e for (e,) in rows}
    assert "real@co.com" in emails, "the answered fixture is applied on induction"
    assert any(e["kind"] == sd.FIXTURE_APPLIED for e in sd.events())


def test_redis_from_url_and_exceptions_import(tmp_path: Path):
    import types as _types

    fake = _types.ModuleType("fakeredis_mod")
    fake.__vinv_stub__ = True
    sd.install(directory=str(tmp_path / "svc"))
    sd._patch_kv(fake)
    client = fake.Redis.from_url("redis://localhost:6379/0", decode_responses=True)
    client.set("k", "v")
    assert client.get("k") == "v"
    assert fake.ConnectionPool.from_url("redis://x").connection_kwargs == {}
    import sys as _sys

    assert "fakeredis_mod.exceptions" in _sys.modules


def test_object_store_keys_cannot_escape_the_bucket(tmp_path: Path):
    sd.install(directory=str(tmp_path / "svc"))
    s3 = sd.ObjectStoreDouble(str(tmp_path / "svc" / "objectstore"))
    s3.create_bucket(Bucket="b")
    s3.put_object(Bucket="b", Key="....//escape.txt", Body=b"x")
    s3.put_object(Bucket="b", Key="/abs/olute.txt", Body=b"y")
    outside = [
        f
        for f in tmp_path.rglob("*")
        if f.is_file() and "objectstore" not in str(f) and f.suffix == ".txt"
    ]
    assert outside == [], "every key lands inside the store root"


def test_two_hosts_are_two_databases(tmp_path: Path):
    sd.install(directory=str(tmp_path / "svc"))
    a = sd.connect("postgresql://hostA/app")
    b = sd.connect("postgresql://hostB/app")
    a.cursor().execute("CREATE TABLE only_a (id INTEGER PRIMARY KEY)")
    assert (
        b.cursor().execute("SELECT name FROM sqlite_master WHERE name='only_a'").fetchall() == []
    ), "two servers in reality must not share substitute state"


# =========================================================================
# Second-round audit regressions
# =========================================================================


def test_ilike_with_a_spliced_parameter_still_folds_case(tmp_path: Path):
    # The literal is wrapped in runtime lower(), not Python-lowered — a value
    # spliced in AFTER a Python .lower() stayed upper-case and silently
    # matched nothing.
    conn = _connect(tmp_path, seed_rows=0)
    cur = conn.cursor()
    cur.execute("CREATE TABLE ppl (id INTEGER PRIMARY KEY, name TEXT)")
    cur.executemany("INSERT INTO ppl (name) VALUES (%s)", [("Bob",), ("bobcat",)])
    got = cur.execute("SELECT name FROM ppl WHERE name ILIKE '%s%%'", ("Bob",)).fetchall()
    assert sorted(v for (v,) in got) == ["Bob", "bobcat"]


def test_failed_seeding_rolls_back_and_is_recorded(tmp_path: Path):
    # A partial seed batch left uncommitted was persisted later by the repo's
    # own commit() with NO ledger entry — invented data must never be silent.
    sd.install(
        directory=str(tmp_path / "svc"),
        seed_rows=2,
        schema_sources=[
            {
                "kind": "ddl",
                "detail": "s.sql",
                "statements": [
                    "CREATE TABLE flags (id SERIAL PRIMARY KEY, active INTEGER UNIQUE);"
                ],
            }
        ],
    )
    conn = sd.connect("postgresql://h/app")
    cur = conn.cursor()
    cur.execute("INSERT INTO flags (active) VALUES (%s)", (99,))
    conn.commit()
    rows = cur.execute("SELECT active FROM flags ORDER BY active").fetchall()
    assert rows == [(99,)], "no phantom seeded rows may survive the rollback"
    assert any(
        e["kind"] == sd.FIDELITY_GAP and "rolled back" in e["detail"] for e in sd.events()
    ), "the failed seeding is itself recorded"


def test_a_column_named_serial_is_not_rewritten_in_queries(tmp_path: Path):
    conn = _connect(tmp_path, seed_rows=0)
    cur = conn.cursor()
    cur.execute('CREATE TABLE devices (id INTEGER PRIMARY KEY, "serial" TEXT)')
    cur.execute("INSERT INTO devices (serial) VALUES (%s)", ("SN-1",))
    assert cur.execute("SELECT serial FROM devices").fetchall() == [("SN-1",)]
    # …while SERIAL as a TYPE in DDL still becomes the rowid alias.
    cur.execute("CREATE TABLE g (id SERIAL PRIMARY KEY, v TEXT)")
    cur.execute("INSERT INTO g (v) VALUES (%s)", ("a",))
    assert cur.execute("SELECT id FROM g").fetchall() == [(1,)]


def test_placeholders_inside_quoted_identifiers_are_left_alone(tmp_path: Path):
    stmt, params = sd._translate("SELECT \"a%sb\" FROM t WHERE x = '%s'", ("v",))
    assert '"a%sb"' in stmt, "an identifier is a NAME; format characters are inert in it"
    assert "'v'" in stmt and params == ()


def test_minted_exception_submodules_are_removed_on_reset(tmp_path: Path):
    import sys as _sys
    import types as _types

    fake = _types.ModuleType("fakekv_reset")
    sd.install(directory=str(tmp_path / "svc"))
    sd._patch_kv(fake)
    assert "fakekv_reset.exceptions" in _sys.modules
    sd.reset()
    assert (
        "fakekv_reset.exceptions" not in _sys.modules
    ), "a leftover stub would shadow the real submodule forever"


def test_schema_repair_under_an_open_returning_cursor_is_a_gap(tmp_path: Path):
    # sqlite cannot commit while an unfetched RETURNING cursor is open; a
    # repair triggered then must be a recorded gap, never a raw sqlite error
    # blamed on the repo.
    conn = _connect(tmp_path, seed_rows=0)
    cur = conn.cursor()
    cur.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    cur.execute("INSERT INTO t (v) VALUES (%s) RETURNING id", ("x",))
    other = conn.cursor()
    with pytest.raises(sd.SubstitutionGap):
        other.execute("SELECT missing_col FROM elsewhere")
    assert any(e["kind"] == sd.FIDELITY_GAP and "commit" in e["detail"] for e in sd.events())
    # The original cursor still works once fetched.
    assert cur.fetchone() == (1,)
