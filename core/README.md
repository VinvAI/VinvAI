# core

> **The shared runtime library.** Deterministic plumbing (native-index boundary, terminal transport, file tools) plus an embeddable agent stack. The standalone Vinv CLIs are harness-only prompt renderers and no longer depend on it; it ships for embedders and its own tooling.

![part of vinv](https://img.shields.io/badge/part_of-vinv-d71921?style=flat-square)
![internal](https://img.shields.io/badge/internal_to-monorepo-0a0a0a?style=flat-square)

Internal to the monorepo — a workspace member that other Vinv engines depend on, not a package you install on its own.

## `// 01 · embed the agent runtime (optional)`

The open-source build is harness-only: no cloud LM is ever configured by this
package, and `ensure_dspy_lm_configured()` raises unless a model is already
set. Embedders who want to drive the DSPy agents directly configure their own:

```python
import dspy
from core import TerminalExecutorAgent

dspy.configure(lm=dspy.LM("your/model", api_key="..."))
agent = TerminalExecutorAgent(max_iters=50)
```

## `// 02 · native code index`

`core.index` is the Python boundary for the production Rust index executable.
It exposes native `index_repository`, `query_index`, and `update_index`
functions plus the legacy agent names `index_codebase`, `retrieve_code`, and
`sync_index`. The canonical store is `<repo>/.vinv/index`.

Set `VINV_INDEX_BINARY` to an explicit executable when it is not installed as
`vinv-index` or `index` on `PATH`. Native failures raise typed `IndexError`
subclasses; successful compatibility calls translate the native `"ok"` status
to the former `"success"` value.

---

<div align="center">

part of **[vinv](../README.md)** · [vinv.ai](https://vinv.ai)

</div>
