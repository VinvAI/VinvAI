"""bringup — standalone, two-stage Stage 2 bring-up runbook renderer.

Renders the runbooks a coding-agent harness executes off a repository's
discovery handbook (``<repo>/.vinv/vinv.md``), in two stages:

* ``render_list_prompt`` (Stage 2a) — the runbook that enumerates every
  service and its modules into ``<repo>/.vinv/services.json``.
* ``render_start_prompt`` (Stage 2b) — the runbook that installs and starts
  one selected service, wrapping a Python service with ``tracelens run`` so
  traces land in ``~/.tracelens/baselines/<session>/<service>/trace.jsonl``.

Harness-only: no LLM calls are made in-process. The deterministic halves —
service-inventory validation and the replay verification gate — live in
``bringup.runner``.
"""

from bringup.runner import (
    expect_vinv_handbook,
    render_list_prompt,
    render_start_prompt,
    verify_replay,
)

__all__ = [
    "expect_vinv_handbook",
    "render_list_prompt",
    "render_start_prompt",
    "verify_replay",
]
