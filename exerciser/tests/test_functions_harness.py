"""The function-level input channel, driven for real (subprocess workers).

G1: every input used to travel as an HTTP request, so a LIBRARY — no routes —
was unexercisable, and bugs in pure helpers sat behind a corridor no request
opens. These tests build a throwaway target package, run the real driver
(isolated workers, real imports), and assert it CATCHES a planted crash while
staying quiet on correct code, refusing to guess, and surviving hostile targets.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from exerciser import store
from exerciser.functions import (
    annotation_base,
    annotation_resolved,
    arg_sets_for,
    call_verdict,
    classify_row,
    denial_reason,
    discover_targets,
    impurity_reasons,
    is_denied,
    module_function_defs,
    module_imports,
    module_name_for,
    name_segments,
    resolved_value_for,
    run_functions,
    value_for,
)

_TARGET_PKG = {
    "__init__.py": "",
    "calc.py": """\
def add(a: int, b: int) -> int:
    return a + b


def halve(n: int) -> float:
    # Planted defect: the falsy-zero case divides by an empty denominator.
    counts = [] if n == 0 else [1, 2]
    return n / len(counts)


def greet(name: str, punct: str = "!") -> str:
    return f"hello {name}{punct}"


def _private(x: int) -> int:
    return x


def untyped(a, b):
    return a


def delete_everything(path: str) -> None:
    raise AssertionError("the harness must never call this")
""",
}


def _make_repo(tmp_path: Path, *, pkg: dict[str, str] | None = None) -> Path:
    import re

    src = tmp_path / "src" / "targetpkg"
    src.mkdir(parents=True)
    files = pkg or _TARGET_PKG
    for name, body in files.items():
        (src / name).write_text(body, encoding="utf-8")
    # A minimal code index derived from the actual sources: the harness reads
    # module-level function names here.
    index = tmp_path / ".vinv" / "index"
    index.mkdir(parents=True)
    chunks = []
    for name, body in files.items():
        for fn in re.findall(r"^(?:async )?def (\w+)", body, re.MULTILINE):
            chunks.append(
                {
                    "id": f"src/targetpkg/{name}:{fn}",
                    "file": f"src/targetpkg/{name}",
                    "lang": "python",
                    "kind": "function",
                    "name": fn,
                    "start_line": 1,
                    "end_line": 2,
                    "parent": None,
                }
            )
    (index / "chunks.jsonl").write_text(
        "".join(json.dumps(c) + "\n" for c in chunks), encoding="utf-8"
    )
    return tmp_path


# ---- unit: targeting rules -------------------------------------------------


def test_module_names_resolve_through_src_layout():
    roots = ["src", "."]
    assert module_name_for("src/pkg/mod.py", roots) == "pkg.mod"
    assert module_name_for("src/pkg/__init__.py", roots) == "pkg"
    assert module_name_for("tool.py", roots) == "tool"
    assert module_name_for("README.md", roots) is None
    assert module_name_for("src/pkg/conftest.py", roots) is None


def test_destructive_names_are_denied():
    assert is_denied("delete_user")
    assert is_denied("db.drop_all")
    assert is_denied("shutdown")
    assert not is_denied("add")
    assert not is_denied("compute_total")


def test_names_split_into_word_segments_not_substrings():
    # The guard matches WORDS. A substring denylist is what let `nuke_everything`
    # through while blocking `charge_density`.
    assert name_segments("remove_prefix") == ["remove", "prefix"]
    assert name_segments("dropAllTables") == ["drop", "all", "tables"]
    assert name_segments("db.drop_all") == ["db", "drop", "all"]
    assert name_segments("HTTPClient") == ["http", "client"]


def test_the_guard_catches_the_destroyers_a_substring_list_missed():
    # Every one of these was invisible to the old substring denylist.
    for name in (
        "nuke_everything",
        "reset_database",
        "clear_all",
        "flush_all",
        "revoke_token",
        "rm_rf",
        "prune_old",
        "evict_entry",
        "rollback_migration",
        "revert_commit",
        "void_invoice",
    ):
        assert is_denied(name), name


def test_domain_nouns_are_drivable_again_but_real_verbs_are_not():
    # Segment matching is a tradeoff, taken deliberately: a Tier-A verb denies
    # unconditionally (so `remove_prefix` stays denied — a lost string helper is
    # cheaper than a wrong guess), while an ambiguous Tier-B verb needs a
    # stateful object beside it. That gives back the scientific-computing
    # coverage the substring list was throwing away.
    assert is_denied("remove_prefix"), "Tier-A verbs deny unconditionally"
    for name in ("transfer_matrix", "charge_density", "transfer_function", "charge_carrier"):
        assert not is_denied(name), name
    # The tradeoff is not free and is not hidden: an ambiguous verb beside a
    # genuinely stateful noun still denies, so physics' `charge_state` loses to
    # `reset_state`/`clear_state`. Safety wins that tie; the AST purity check is
    # what keeps the residual coverage loss small.
    assert is_denied("charge_state")
    for name in ("transfer_funds", "charge_card", "send_email", "reset_database"):
        assert is_denied(name), name
    # Bare Tier-B verbs are the whole identifier, so there is no noun to save them.
    assert is_denied("deploy")
    assert is_denied("publish")


def test_every_denial_records_why():
    reason = denial_reason("reset_database")
    assert reason and "reset" in reason and "database" in reason
    assert denial_reason("compute_total") is None


def test_test_modules_are_never_importable_targets():
    roots = ["src", "."]
    # Importing a test module runs its fixtures against real state, and its
    # `test_*` functions then get called with junk.
    assert module_name_for("tests/test_foo.py", roots) is None
    assert module_name_for("src/pkg/test/helpers.py", roots) is None
    assert module_name_for("src/pkg/testing/util.py", roots) is None
    assert module_name_for("test_foo.py", roots) is None
    assert module_name_for("src/pkg/models_test.py", roots) is None
    assert module_name_for("src/pkg/models.py", roots) == "pkg.models"


# ---- unit: the AST purity pre-check ---------------------------------------


def _impurities(source: str, name: str) -> list[str]:
    return impurity_reasons(name, module_function_defs(source), imports=module_imports(source))


def test_purity_check_sees_what_the_body_does_not_what_it_is_called():
    # A perfectly innocent NAME over a body that deletes the filesystem. No
    # verb vocabulary can catch this; reading the body can.
    source = (
        "import os\nimport shutil\nimport subprocess\nimport requests\n\n\n"
        "def tidy(path: str) -> None:\n    os.remove(path)\n\n\n"
        "def sweep(path: str) -> None:\n    shutil.rmtree(path)\n\n\n"
        "def spawn(cmd: str) -> None:\n    subprocess.run(cmd)\n\n\n"
        "def fetch(url: str) -> None:\n    requests.get(url)\n\n\n"
        "def record(path: str) -> None:\n    open(path, 'w')\n\n\n"
        "def query(conn) -> None:\n    conn.execute('DELETE FROM t')\n\n\n"
        "def stop() -> None:\n    import sys\n\n    sys.exit(1)\n\n\n"
        "def pure(a: int, b: int) -> int:\n    return a + b\n"
    )
    for name in ("tidy", "sweep", "spawn", "fetch", "record", "query", "stop"):
        assert _impurities(source, name), name
    assert _impurities(source, "pure") == [], "a pure body must stay drivable"


def test_purity_check_follows_same_module_helpers_one_hop():
    source = (
        "import os\n\n\n"
        "def tidy(path: str) -> None:\n    _really(path)\n\n\n"
        "def _really(path: str) -> None:\n    os.remove(path)\n"
    )
    reasons = _impurities(source, "tidy")
    assert reasons and "_really" in reasons[0]


def test_reading_a_file_is_not_a_side_effect():
    # Over-blocking costs coverage, so the check is about MUTATION: reads and
    # path arithmetic stay drivable.
    source = (
        "import os\n\n\n"
        "def load(path: str) -> str:\n"
        "    full = os.path.join(path, 'x')\n"
        "    with open(full) as fh:\n"
        "        return fh.read()\n"
    )
    assert _impurities(source, "load") == []


def test_an_unreadable_mode_is_treated_as_a_write():
    source = "def save(path: str, mode: str) -> None:\n    open(path, mode)\n"
    assert _impurities(source, "save"), "a computed mode is not assumed to be 'r'"


# ---- unit: the bypasses an audit drove through the purity check ------------
#
# Each of these was ACCEPTED by the guard — i.e. would have been imported and
# called in-process — because the walk matched the local BINDING name against a
# set of module roots and silently skipped anything it did not recognise.

# The control the guard always refused, kept beside the bypasses so a test that
# regresses to "refuse everything" is distinguishable from one that works.
_CONTROL = "import os\n\n\ndef tidy(path: str) -> None:\n    os.remove(path)\n"

_BYPASSES = {
    # 1. An alias the module-root set has no entry for.
    "aliased-module": (
        "import os as _os\n\n\ndef tidy(path: str) -> None:\n    _os.remove(path)\n",
        "tidy",
    ),
    "aliased-subprocess": (
        "import subprocess as sp\n\n\ndef spawn(cmd: str) -> None:\n    sp.run([cmd])\n",
        "spawn",
    ),
    # 2. The worst one: `ast.walk` saw a Call whose `.func` was itself a Call,
    #    hit `continue`, and inspected NOTHING.
    "getattr-dispatch": (
        'import shutil\n\n\ndef sweep(root: str) -> None:\n    getattr(shutil, "rmtree")(root)\n',
        "sweep",
    ),
    "subscript-dispatch": (
        'def apply(table: dict, path: str) -> None:\n    table["rm"](path)\n',
        "apply",
    ),
    # 3. Transitive depth was 1, so one extra hop hid the call.
    "three-hop-chain": (
        "import os\n\n\ndef a(p: str) -> None:\n    b(p)\n\n\n"
        "def b(p: str) -> None:\n    c(p)\n\n\ndef c(p: str) -> None:\n    os.remove(p)\n",
        "a",
    ),
    # 4. ORM mutation: no module root, and neither method name was listed.
    "orm-session": (
        "def purge(session, row) -> None:\n    session.delete(row)\n    session.flush()\n",
        "purge",
    ),
    # 5. Arbitrary source text, executed.
    "exec-builtin": ("def apply(code: str):\n    exec(code)\n", "apply"),
    "eval-builtin": ("def apply(code: str):\n    return eval(code)\n", "apply"),
    # 6. `from os import remove` — a bare name that is really a stdlib mutator.
    "from-import": (
        "from os import remove\n\n\ndef tidy(path: str) -> None:\n    remove(path)\n",
        "tidy",
    ),
}


def test_the_control_case_is_still_refused():
    assert _impurities(_CONTROL, "tidy") == ["calls os.remove()"]


@pytest.mark.parametrize("case", sorted(_BYPASSES))
def test_every_audited_bypass_is_refused(case: str):
    source, name = _BYPASSES[case]
    assert _impurities(source, name), f"{case} was ACCEPTED — the guard is bypassed"


def test_an_alias_resolves_to_the_module_it_really_names():
    imports = module_imports(
        "import os as _os\nimport a.b as c\nimport json.decoder\n"
        "from os.path import join\nfrom . import helper\n"
    )
    assert imports["_os"] == "os"
    assert imports["c"] == "a.b"
    assert imports["json"] == "json", "`import a.b` binds only `a`"
    assert imports["join"] == "os.path.join"
    assert imports["helper"].startswith("."), "a relative import is never a stdlib root"


def test_a_chain_deeper_than_the_limit_is_refused_rather_than_assumed_harmless():
    # Depth is finite, so the honest answer past it is "cannot verify" — not
    # silence, which is what let a 2-hop chain through when the limit was 1.
    source = (
        "import os\n\n\ndef a(p: str) -> None:\n    b(p)\n\n\n"
        "def b(p: str) -> None:\n    c(p)\n\n\n"
        "def c(p: str) -> None:\n    d(p)\n\n\ndef d(p: str) -> None:\n    e(p)\n\n\n"
        "def e(p: str) -> None:\n    os.remove(p)\n"
    )
    reasons = _impurities(source, "a")
    assert reasons and any("cannot verify" in r for r in reasons)


def test_a_recursive_helper_terminates():
    source = "def a(n: int) -> int:\n    return 0 if n <= 0 else a(n - 1)\n"
    assert _impurities(source, "a") == []


def test_an_unresolvable_bare_name_is_refused():
    # `handler` is neither a builtin, an import, nor a same-module def, so the
    # guard has no source to judge and must not assume it is pure.
    source = "def dispatch(handler, x):\n    return handler(x)\n"
    assert _impurities(source, "dispatch")


def test_the_guard_did_not_become_refuse_everything():
    # The whole point of hardening is that ORDINARY pure code stays drivable —
    # builtins, literals, comprehensions, f-strings, nested defs, same-module
    # helpers, stdlib READS.
    source = (
        "import os\nimport math\nfrom collections import Counter\n\n\n"
        "def normalise(raw: str) -> str:\n"
        "    parts = sorted(p.strip() for p in raw.split(','))\n"
        "    return ','.join(parts)\n\n\n"
        "def summarise(raw: str) -> str:\n"
        "    counts = Counter(normalise(raw))\n"
        "    return f'{len(counts)} distinct, {math.sqrt(len(raw)):.2f}'\n\n\n"
        "def load(path: str) -> str:\n"
        "    full = os.path.join(path, 'x')\n"
        "    with open(full) as fh:\n"
        "        return fh.read()\n\n\n"
        "def tally(rows: list) -> int:\n"
        "    def weigh(row):\n"
        "        return len(row)\n\n"
        "    return sum(weigh(r) for r in rows)\n"
    )
    for name in ("normalise", "summarise", "load", "tally"):
        assert _impurities(source, name) == [], name


# The audit's concrete scenario: NO arguments, so nothing depends on generated
# values. The old guard accepted it; the harness would have imported the module
# and deleted a real directory.
_ALIASED_DESTROYER_PKG = {
    "__init__.py": "",
    "calc.py": """\
import os as _os

CACHE = "/var/cache/app"


def total(values: list) -> int:
    return sum(values)


def compact_workspace():
    for n in _os.listdir(CACHE):
        _os.remove(CACHE + "/" + n)
""",
}


def test_the_no_argument_aliased_destroyer_never_becomes_a_target(tmp_path: Path):
    repo = _make_repo(tmp_path, pkg=_ALIASED_DESTROYER_PKG)
    targets, skipped = discover_targets(repo)
    assert {t.qualname for t in targets} == {"total"}
    reasons = {s["id"]: s["reason"] for s in skipped}
    assert "impure-body" in reasons["targetpkg.calc:compact_workspace"]
    assert "os.remove" in reasons["targetpkg.calc:compact_workspace"]


def test_the_differential_oracle_is_the_only_caller_that_may_take_an_evaluator(tmp_path: Path):
    # Refusing `exec` costs the differential oracle its entire target class, so
    # code-evaluation is a NAMED impurity class an opted-in caller can accept —
    # and the in-process crash harness never does.
    pkg = {
        "__init__.py": "",
        "sandbox.py": (
            "def evaluate_code(code: str):\n    ns = {}\n    exec(code, ns)\n    return ns\n"
        ),
    }
    repo = _make_repo(tmp_path, pkg=pkg)
    strict, skipped = discover_targets(repo)
    assert strict == []
    assert "evaluates source text" in skipped[0]["reason"]

    permitted, _ = discover_targets(repo, allow_impurities=frozenset({"code-evaluation"}))
    assert {t.qualname for t in permitted} == {"evaluate_code"}

    # …and the carve-out is exactly one class wide: a body that also removes
    # files is still refused, opted in or not.
    both = {
        "__init__.py": "",
        "sandbox.py": (
            "import os as _o\n\n\ndef evaluate_code(code: str):\n"
            "    exec(code)\n    _o.remove('/tmp/x')\n"
        ),
    }
    repo2 = _make_repo(tmp_path / "two", pkg=both)
    still, _ = discover_targets(repo2, allow_impurities=frozenset({"code-evaluation"}))
    assert still == []


def test_argument_sets_cover_the_input_classes():
    params = [
        {"name": "n", "annotation": "int", "has_default": False, "keyword_only": False},
        {"name": "tag", "annotation": "str", "has_default": True, "keyword_only": False},
    ]
    sets = {s["class"]: s["kwargs"] for s in arg_sets_for(params)}
    assert sets["valid"] == {"n": 3}, "defaults are left to their documented path"
    assert sets["boundary"] == {"n": 0, "tag": ""}
    assert sets["negative"]["n"] == -(2**63)
    assert value_for("Optional[str]", "valid") == "vinv", "subscripted hints resolve"
    assert value_for(None, "boundary") == ""


def test_discovery_skips_private_and_destructive(tmp_path: Path):
    repo = _make_repo(tmp_path)
    targets, skipped = discover_targets(repo)
    names = {t.qualname for t in targets}
    assert {"add", "halve", "greet", "untyped"} <= names
    assert "_private" not in names, "private by convention"
    assert "delete_everything" not in names
    assert any(s["reason"].startswith("destructive-name") for s in skipped)
    assert all(t.module == "targetpkg.calc" for t in targets)


_IMPURE_PKG = {
    "__init__.py": "",
    "calc.py": """\
import os


def total(values: list) -> int:
    return sum(values)


def tidy(path: str) -> None:
    # An innocent NAME over a body that removes files. Only the purity
    # pre-check stops this being imported and called with a guessed path.
    os.remove(path)


def housekeep(path: str) -> None:
    _erase(path)


def _erase(path: str) -> None:
    os.remove(path)
""",
}


def test_impure_bodies_are_skipped_with_a_recorded_reason(tmp_path: Path):
    repo = _make_repo(tmp_path, pkg=_IMPURE_PKG)
    targets, skipped = discover_targets(repo)
    names = {t.qualname for t in targets}
    assert names == {"total"}, "only the pure function may be driven"
    reasons = {s["id"]: s["reason"] for s in skipped}
    assert "impure-body" in reasons["targetpkg.calc:tidy"]
    assert "os.remove" in reasons["targetpkg.calc:tidy"]
    # …including one reached only through a same-module helper.
    assert "impure-body" in reasons["targetpkg.calc:housekeep"]
    assert "_erase" in reasons["targetpkg.calc:housekeep"]


def test_the_driver_never_calls_an_impure_target(tmp_path: Path):
    repo = _make_repo(tmp_path, pkg=_IMPURE_PKG)
    victim = tmp_path / "victim.txt"
    victim.write_text("still here", encoding="utf-8")

    result = run_functions(repo, module_timeout_s=60.0)

    rows = store.read_jsonl(store.exercise_dir(repo) / "function_results.jsonl")
    assert not any("tidy" in r.get("target_id", "") for r in rows)
    assert not any("housekeep" in r.get("target_id", "") for r in rows)
    assert victim.read_text(encoding="utf-8") == "still here"
    assert any("impure-body" in s["reason"] for s in result["skipped"])


# ---- classification --------------------------------------------------------


def test_typed_rejection_of_bad_input_is_not_a_failure():
    row = {
        "phase": "call",
        "status": "error",
        "input_class": "negative",
        "error_type": "TypeError",
    }
    assert classify_row(row) is None, "refusing bad input is correct behaviour"


def test_untyped_explosion_on_bad_input_is_a_failure():
    row = {
        "phase": "call",
        "status": "error",
        "input_class": "negative",
        "error_type": "RecursionError",
    }
    assert classify_row(row) == "function-crash"


def test_a_refused_guess_is_not_a_defect():
    # The harness GUESSES arguments from type hints, so a `str` annotation does
    # not make every string valid. A function raising ValueError/TypeError on a
    # made-up value is working correctly — reporting it produced 40 false
    # findings against real smolagents, which is how a tool gets ignored.
    for etype, mro in (
        ("TypeError", ["TypeError", "Exception"]),
        ("ValueError", ["ValueError", "Exception"]),
        ("AttributeError", ["AttributeError", "Exception"]),
        ("KeyError", ["KeyError", "LookupError", "Exception"]),
    ):
        row = {
            "phase": "call",
            "status": "error",
            "input_class": "valid",
            "error_type": etype,
            "error_module": "builtins",
            "error_mro": mro,
            "error": "unsupported value",
        }
        assert call_verdict(row) == "rejected", etype
        assert classify_row(row) is None


def test_exceptions_no_input_can_justify_are_defects():
    # Scored by the builtin ancestor in the MRO — Python's own taxonomy —
    # not by a curated list of names.
    for etype, mro in (
        ("UnboundLocalError", ["UnboundLocalError", "NameError", "Exception"]),
        ("NameError", ["NameError", "Exception"]),
        ("RecursionError", ["RecursionError", "RuntimeError", "Exception"]),
        ("AssertionError", ["AssertionError", "Exception"]),
    ):
        row = {
            "phase": "call",
            "status": "error",
            "input_class": "valid",
            "error_type": etype,
            "error_module": "builtins",
            "error_mro": mro,
            # The harness really did supply a value OF THE DECLARED TYPE here —
            # without that this row would be a guess, and a guess cannot be
            # called conformant (see the unresolved-annotation test below).
            "annotations_resolved": True,
        }
        assert call_verdict(row) == "defect", etype
        assert classify_row(row) == "function-crash"


def test_environment_failures_are_not_defects():
    for etype, mro in (
        ("ModuleNotFoundError", ["ModuleNotFoundError", "ImportError", "Exception"]),
        ("EOFError", ["EOFError", "Exception"]),
        ("FileNotFoundError", ["FileNotFoundError", "OSError", "Exception"]),
        ("SystemExit", ["SystemExit", "BaseException"]),
    ):
        row = {
            "phase": "call",
            "status": "error",
            "input_class": "valid",
            "error_type": etype,
            "error_module": "builtins",
            "error_mro": mro,
        }
        assert call_verdict(row) == "rejected", etype
        assert classify_row(row) is None


def test_a_call_the_harness_botched_is_never_the_targets_fault():
    row = {
        "phase": "call",
        "status": "error",
        "input_class": "valid",
        "error_type": "TypeError",
        "error": "visualizer() missing 1 required positional argument: 'image_path'",
    }
    assert call_verdict(row) == "malformed-call"
    assert classify_row(row) is None


def test_an_unknown_exception_is_scored_by_what_it_inherits():
    # A name nobody has seen is still scored correctly, because the MRO says
    # what it IS. This is what makes the policy transfer to a new repo.
    refusing = {
        "phase": "call",
        "status": "error",
        "input_class": "valid",
        "error_type": "TotallyNovelError",
        "error_module": "vendor.sdk",
        "error_mro": ["TotallyNovelError", "ValueError", "Exception"],
    }
    assert call_verdict(refusing) == "rejected"
    breaking = {
        **refusing,
        "error_mro": ["TotallyNovelError", "UnboundLocalError", "NameError", "Exception"],
    }
    assert call_verdict(breaking) == "defect"


def test_healthy_calls_classify_as_nothing():
    assert classify_row({"phase": "call", "status": "ok"}) is None


# ---- annotations the harness could not resolve ----------------------------


def test_annotation_resolution_is_reported_not_assumed():
    # Resolvable: a value really can be built that SATISFIES the annotation.
    for ann in ("str", "int", "Optional[str]", "list[int]", "dict[str, int] | None", "Any"):
        assert annotation_resolved(ann), ann
        assert resolved_value_for(ann, "valid")[1] is True
    # A typing ABC a concrete family genuinely satisfies.
    assert annotation_base("Sequence[int]") == "list"
    assert annotation_resolved("Sequence[int]")
    # Unresolvable: there is no Config to send, and `value_for` says so instead
    # of quietly handing over the string family's "vinv".
    for ann in ("Config", "pkg.Config", None, "Callable[[int], int]"):
        assert not annotation_resolved(ann), ann
    value, resolved = resolved_value_for("Config", "valid")
    assert value == "vinv" and resolved is False
    assert value_for("Config", "valid") == "vinv", "the legacy accessor still returns a probe"


def test_a_guessed_value_is_never_reported_as_conformant():
    # `assert isinstance(cfg, Config)` is a repo defending its own contract. If
    # the harness passes "vinv" for `cfg: Config` and then tells the policy the
    # value CONFORMED, every such guard becomes a reported defect.
    guessed = {
        "phase": "call",
        "status": "error",
        "input_class": "valid",
        "error_type": "AssertionError",
        "error_module": "builtins",
        "error_mro": ["AssertionError", "Exception"],
        "annotations_resolved": False,
    }
    assert call_verdict(guessed) == "rejected"
    assert classify_row(guessed) is None
    # The same failure on a value we really did build to the declared type is
    # still a defect — the fix narrows the claim, it does not disarm the oracle.
    assert call_verdict({**guessed, "annotations_resolved": True}) == "defect"


def test_argument_sets_carry_whether_the_annotations_resolved():
    resolved = arg_sets_for(
        [{"name": "n", "annotation": "int", "has_default": False, "keyword_only": False}]
    )
    assert all(s["annotations_resolved"] for s in resolved)
    guessed = arg_sets_for(
        [{"name": "cfg", "annotation": "Config", "has_default": False, "keyword_only": False}]
    )
    assert not any(s["annotations_resolved"] for s in guessed)
    # A defaulted unresolvable parameter is omitted from `valid`, so THAT call
    # is honest even though the others are guesses.
    mixed = {
        s["class"]: s["annotations_resolved"]
        for s in arg_sets_for(
            [
                {"name": "n", "annotation": "int", "has_default": False, "keyword_only": False},
                {"name": "cfg", "annotation": "Config", "has_default": True, "keyword_only": False},
            ]
        )
    }
    assert mixed == {"valid": True, "boundary": False, "negative": False}


_UNRESOLVABLE_PKG = {
    "__init__.py": "",
    "calc.py": """\
class Config:
    pass


def configure(cfg: Config) -> str:
    assert isinstance(cfg, Config)
    return "ok"


def add(a: int, b: int) -> int:
    return a + b
""",
}


def test_unresolvable_annotations_are_skipped_not_guessed(tmp_path: Path):
    repo = _make_repo(tmp_path, pkg=_UNRESOLVABLE_PKG)

    result = run_functions(repo, module_timeout_s=60.0)

    rows = store.read_jsonl(store.exercise_dir(repo) / "function_results.jsonl")
    configure = [r for r in rows if "configure" in r.get("target_id", "")]
    assert configure and all(r["status"] == "skipped" for r in configure)
    assert "unresolvable annotation" in configure[0]["error"]
    assert "refusing to guess" in configure[0]["error"]
    assert result["issue_clusters"] == 0, "a defensive isinstance guard is not a defect"
    # …and the resolvable neighbour is still driven for real.
    assert any(r.get("qualname") == "add" and r.get("status") == "ok" for r in rows)


def test_driven_rows_record_whether_the_annotations_resolved(tmp_path: Path):
    repo = _make_repo(tmp_path)
    run_functions(repo, module_timeout_s=60.0)
    rows = store.read_jsonl(store.exercise_dir(repo) / "function_results.jsonl")
    calls = [r for r in rows if r.get("phase") == "call"]
    assert calls and all("annotations_resolved" in r for r in calls)
    assert all(r["annotations_resolved"] for r in calls), "int/str targets resolve cleanly"


# ---- the real driver -------------------------------------------------------


def test_driver_calls_real_code_and_catches_the_planted_crash(tmp_path: Path):
    repo = _make_repo(tmp_path)

    result = run_functions(repo, module_timeout_s=60.0)

    assert result["status"] == "ok"
    assert result["calls"] > 0, "the harness must actually call target code"
    rows = store.read_jsonl(store.exercise_dir(repo) / "function_results.jsonl")
    # add() was really executed with real arguments.
    added = [r for r in rows if r.get("qualname") == "add" and r.get("status") == "ok"]
    assert added and any(r["result"] == 6 for r in added), "add(3, 3) == 6"
    # halve() has a planted ZeroDivisionError on the falsy-zero boundary — the
    # exact class HTTP probing cannot reach.
    kinds = {c["kind"] for c in result["clusters"]}
    assert "function-crash" in kinds
    crash = next(c for c in result["clusters"] if c["kind"] == "function-crash")
    assert "halve" in crash["title"]
    assert "ZeroDivisionError" in crash["title"]
    # And the destructive function was never invoked (it would have raised).
    assert not any(r.get("qualname") == "delete_everything" for r in rows)


def test_unannotated_parameters_are_skipped_not_guessed(tmp_path: Path):
    repo = _make_repo(tmp_path)
    run_functions(repo, module_timeout_s=60.0)
    rows = store.read_jsonl(store.exercise_dir(repo) / "function_results.jsonl")
    untyped = [r for r in rows if "untyped" in r.get("target_id", "")]
    assert untyped and all(r["status"] == "skipped" for r in untyped)
    assert "refusing to guess" in untyped[0]["error"]


def test_clean_library_produces_no_failures(tmp_path: Path):
    repo = _make_repo(
        tmp_path,
        pkg={
            "__init__.py": "",
            "calc.py": (
                "def add(a: int, b: int) -> int:\n    return a + b\n\n\n"
                "def label(x: str) -> str:\n    return x.strip().lower()\n"
            ),
        },
    )
    result = run_functions(repo, module_timeout_s=60.0)
    assert result["calls"] > 0
    assert result["issue_clusters"] == 0, "correct code must stay quiet"


def test_a_hanging_module_costs_one_module_not_the_run(tmp_path: Path):
    repo = _make_repo(
        tmp_path,
        pkg={
            "__init__.py": "",
            "calc.py": (
                "import time\n\n\n" "def spin(n: int) -> int:\n    time.sleep(600)\n    return n\n"
            ),
        },
    )
    result = run_functions(repo, module_timeout_s=3.0)
    assert result["status"] == "ok", "a hang must never take the run down"
    assert result["module_timeouts"] == ["targetpkg.calc"]


def test_a_module_that_exits_on_import_is_reported_not_fatal(tmp_path: Path):
    repo = _make_repo(
        tmp_path,
        pkg={
            "__init__.py": "",
            "calc.py": "import sys\n\nsys.exit(3)\n\n\ndef add(a: int) -> int:\n    return a\n",
        },
    )
    result = run_functions(repo, module_timeout_s=60.0)
    assert result["status"] == "ok"
    kinds = {c["kind"] for c in result["clusters"]}
    assert "import-error" in kinds


def test_empty_target_set_is_loudly_diagnosed(tmp_path: Path):
    (tmp_path / ".vinv" / "exercise").mkdir(parents=True)
    result = run_functions(tmp_path, module_timeout_s=10.0)
    assert result["targets"] == 0
    assert result["diagnostics"] and "0 function targets" in result["diagnostics"][0]


@pytest.mark.skipif(sys.platform == "win32", reason="posix worker spawn")
def test_worker_is_invocable_as_a_module(tmp_path: Path):
    import subprocess

    proc = subprocess.run(
        [sys.executable, "-m", "exerciser.functions"],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 2
    assert "exerciser functions" in proc.stderr


def test_a_librarys_own_exception_is_a_refusal_not_a_crash():
    # Verified against real smolagents: InterpreterError / AgentGenerationError
    # are the package refusing input on purpose. A library that defines an
    # exception class and raises it is stating an API contract.
    row = {
        "phase": "call",
        "status": "error",
        "module": "smolagents.local_python_executor",
        "repo_packages": ["smolagents", "examples"],
        "error_type": "InterpreterError",
        "error_module": "smolagents.local_python_executor",
        "error_mro": ["InterpreterError", "ValueError", "Exception"],
    }
    assert call_verdict(row) == "rejected"
    assert classify_row(row) is None
    # …but a genuine internal break still reports, wherever it is raised.
    assert (
        call_verdict(
            {
                **row,
                "error_type": "UnboundLocalError",
                "error_module": "builtins",
                "error_mro": ["UnboundLocalError", "NameError", "Exception"],
            }
        )
        == "defect"
    )


# ---- the suppression must not censor its own feedback -----------------------

_REFUSING_PKG = {
    "__init__.py": "",
    "errors.py": "class HouseError(Exception):\n    pass\n",
    "api.py": """\
from .errors import HouseError


def load(name: str) -> str:
    raise HouseError(f"cannot load {name}")


def store_it(name: str) -> str:
    raise HouseError(f"cannot store {name}")


def fetch(name: str) -> str:
    raise HouseError(f"cannot fetch {name}")
""",
}


def test_a_suppressed_signature_is_re_examinable_from_a_real_run(tmp_path: Path):
    # The absorbing state, end to end. A repo-defined exception raised by every
    # target is scored as refusal vocabulary and reported by nothing — and a
    # finding is the only thing that ever gets adjudicated, so without the
    # Thompson draw the verdict could never be revised, however wrong it was.
    repo = _make_repo(tmp_path, pkg=_REFUSING_PKG)

    greedy = run_functions(repo, module_timeout_s=60.0, explore=False)
    assert greedy["verdicts"].get("rejected"), "the exception must really be raised"
    assert greedy["issue_clusters"] == 0, "the deterministic rule suppresses it"
    assert greedy["surfaced_by_exploration"] == []
    key = "HouseError@repo"
    assert (
        greedy["exception_policy"][key]["confident"] is False
    ), "suppressed on structure alone, and the run document says so"
    assert greedy["exception_policy"][key]["label_mass"] == 0.0

    # The same run, exploring: within a bounded number of seeded runs the draw
    # surfaces it, and surfacing it means REPORTING it, which is what gets it
    # adjudicated and finally labelled.
    explored = None
    for seed in range(12):
        result = run_functions(repo, module_timeout_s=60.0, seed=seed)
        if key in result["surfaced_by_exploration"]:
            explored = result
            break
    assert explored is not None, "a suppressed signature must be re-examinable"
    assert explored["issue_clusters"] > 0, "and reported, so it can be labelled"
    assert any(c["kind"] == "function-crash" for c in explored["clusters"])
