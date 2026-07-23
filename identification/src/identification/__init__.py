"""Deterministic entry-point analysis over the Vinv code index.

Reads the Rust JSON index (``<repo>/.vinv/index``); vectors and embeddings are
never loaded.

* ``list_service_apis`` (``consolidate``) — enumerate every entry point a service
  exposes (HTTP routes, CLI commands, background/queue workers, scheduled jobs,
  event hooks, ``__main__`` scripts) straight from source, each attributed to its
  handler symbol.
* ``build_api_call_tree`` (``calltree``) — build the static call tree rooted at
  one entry point's handler by walking the index's precomputed call graph, with
  ``render_call_tree_text`` for an indented view.
* ``map_trace_to_tree`` (``tracemap``) — overlay a tracelens runtime capture onto
  that static call tree: annotate each node with whether it executed (call count,
  duration, error status) and surface the static/runtime gaps, with
  ``render_trace_map_text`` for an indented view.

Does not depend on backend, core, tracelens, FAISS, or an LLM runtime.
"""

from identification.runner import (
    build_api_call_tree,
    list_service_apis,
    map_trace_to_tree,
    render_call_tree_text,
    render_trace_map_text,
    render_trace_summary_text,
    summarize_traces,
)

__all__ = [
    "build_api_call_tree",
    "list_service_apis",
    "map_trace_to_tree",
    "render_call_tree_text",
    "render_trace_map_text",
    "render_trace_summary_text",
    "summarize_traces",
]
