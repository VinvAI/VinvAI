"""Regression test for ``_prepend_tracelens_import`` and ``from __future__``.

Bug history (2026-05-04):
  Previously the AST rewriter only skipped past a leading docstring before
  inserting ``from tracelens.runtime import trace_fn as _tracelens_tf``.
  Files structured as::

      \"\"\"docstring\"\"\"
      from __future__ import annotations
      import os

  ended up rewritten to::

      \"\"\"docstring\"\"\"
      from tracelens.runtime import trace_fn as _tracelens_tf
      from __future__ import annotations  # <- now illegal
      import os

  which Python rejects with::

      SyntaxError: from __future__ imports must occur at the beginning
      of the file

  In a single target-repo run this silently disabled tracing for ~60 modules
  including the ``parsing`` library where most handler work happens, so
  the flamegraph showed a flat one-level tree even though ``--target-package
  parsing`` was passed.

The fix in ``_prepend_tracelens_import`` advances past every leading
``from __future__ import`` statement before injecting the runtime import.
"""

from __future__ import annotations

import ast

from tracelens.launcher.import_hook import _prepend_tracelens_import


def _compiles(body: list[ast.stmt]) -> bool:
    mod = ast.Module(body=body, type_ignores=[])
    ast.fix_missing_locations(mod)
    try:
        compile(mod, "<test>", "exec")
        return True
    except SyntaxError:
        return False


def test_handles_future_import_after_docstring() -> None:
    src = '"""module docstring"""\n' "from __future__ import annotations\n" "import os\n"
    body = ast.parse(src).body
    new_body = _prepend_tracelens_import(body)

    # 0: docstring, 1: __future__ import, 2: tracelens import, 3: import os
    assert isinstance(new_body[0], ast.Expr)
    assert isinstance(new_body[1], ast.ImportFrom) and new_body[1].module == "__future__"
    assert isinstance(new_body[2], ast.ImportFrom) and new_body[2].module == "tracelens.runtime"
    assert _compiles(new_body), "rewritten module must still compile"


def test_handles_multiple_future_imports() -> None:
    src = "from __future__ import annotations\n" "from __future__ import division\n" "import os\n"
    body = ast.parse(src).body
    new_body = _prepend_tracelens_import(body)

    assert all(isinstance(s, ast.ImportFrom) and s.module == "__future__" for s in new_body[:2])
    assert isinstance(new_body[2], ast.ImportFrom) and new_body[2].module == "tracelens.runtime"
    assert _compiles(new_body)


def test_no_future_import_keeps_original_behaviour() -> None:
    src = "import os\n"
    body = ast.parse(src).body
    new_body = _prepend_tracelens_import(body)

    assert isinstance(new_body[0], ast.ImportFrom) and new_body[0].module == "tracelens.runtime"
    assert _compiles(new_body)


def test_idempotent_when_already_injected() -> None:
    src = (
        "from __future__ import annotations\n"
        "from tracelens.runtime import trace_fn as _tracelens_tf\n"
        "import os\n"
    )
    body = ast.parse(src).body
    new_body = _prepend_tracelens_import(body)

    assert (
        sum(
            1
            for s in new_body
            if isinstance(s, ast.ImportFrom)
            and s.module == "tracelens.runtime"
            and any(a.name == "trace_fn" for a in s.names)
        )
        == 1
    )
    assert _compiles(new_body)


def test_docstring_only_no_imports() -> None:
    src = '"""just a docstring"""\n'
    body = ast.parse(src).body
    new_body = _prepend_tracelens_import(body)

    assert isinstance(new_body[0], ast.Expr)
    assert isinstance(new_body[1], ast.ImportFrom) and new_body[1].module == "tracelens.runtime"
    assert _compiles(new_body)
