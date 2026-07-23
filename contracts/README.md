# lens-contracts

> **The data contract.** Every event Vinv records is pinned here as a typed model with a versioned schema — so traces written today stay readable tomorrow.

![part of vinv](https://img.shields.io/badge/part_of-vinv-d71921?style=flat-square)
![internal](https://img.shields.io/badge/audience-internal-0a0a0a?style=flat-square)

Internal library — `SpanEvent` and its generated schema are the executable contract used by
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

## `// 03 · tests`

```bash
pytest
```

---

<div align="center">

part of **[vinv](../README.md)** · [vinv.ai](https://vinv.ai)

</div>
