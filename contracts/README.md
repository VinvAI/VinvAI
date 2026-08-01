# lens-contracts

> **The data contract.** Every event Vinv records is pinned here as a typed model with a versioned schema — so traces written today stay readable tomorrow.

![part of vinv](https://img.shields.io/badge/part_of-vinv-d71921?style=flat-square)
![internal](https://img.shields.io/badge/internal_to-monorepo-0a0a0a?style=flat-square)

Internal to the monorepo — a workspace member the other Vinv engines depend on, not a package you install on its own. `SpanEvent` and its generated schema are the executable contract used by
Tracelens readers. Other event models remain forward-looking until a producer imports them.

## `// 01 · install`

```bash
cd contracts
pip install -e ".[dev]"
```

## `// 02 · use`

```python
from lens_contracts import SpanEvent, EventHeader, CodeVersion
```

Every event embeds a shared header (schema version, service, timestamp), and every model ships a matching JSON Schema as package data. Additions are forward-compatible; readers skip unknown fields.

## `// 02b · cross-language vectors`

`vectors/` holds shared test data for behaviour that several engines implement
separately and must implement identically. It is not importable package data —
each suite reads the JSON directly.

`vectors/invocation_render.json` pins how a parameterized invocation's command
template is filled in. Three implementations do it: the extension's Run button
(TypeScript), the exercise pass and bring-up's recorder (Python, one file
duplicated verbatim). The whole value of a recorded invocation is that the
command a human runs is the command the exercise pass measured and the command
bring-up verified — nothing in any type system enforces that, so these vectors
do. A change made on one side and not the others fails there.

## `// 03 · tests`

```bash
pytest
```

---

<div align="center">

part of **[vinv](../README.md)** · [vinv.ai](https://vinv.ai)

</div>
