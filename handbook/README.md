# handbook

> **The discovery stage.** Vinv's pipeline starts by reading your repo the way a new engineer would — `handbook` explores the codebase and writes the onboarding handbook every later stage builds on.

![part of vinv](https://img.shields.io/badge/part_of-vinv-d71921?style=flat-square)
![output](https://img.shields.io/badge/writes-.vinv%2Fvinv.md-0a0a0a?style=flat-square)

One command:

| Command | Purpose |
| --- | --- |
| `handbook generate <repo>` | Print the exploration prompt whose execution writes `<repo>/.vinv/vinv.md`. |

## `// 01 · install`

```bash
cd handbook
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -e .
.venv/bin/handbook --help
```

Build from inside the full repo checkout (it uses sibling packages). On Windows, the venv puts executables under `.venv\Scripts\` instead of `.venv/bin/` (e.g. `.venv\Scripts\python`, `.venv\Scripts\handbook --help`).

## `// 02 · use`

The command prints a fully rendered exploration prompt — no LLM calls are made. Pipe it into any coding agent (Claude Code, Cursor, Windsurf, …) to have *its* model write the handbook:

```bash
# render the discovery prompt
handbook generate /path/to/repo | your-coding-agent

# tool-agnostic wording (no Vinv-specific tool names) for a foreign agent
handbook generate /path/to/repo --portable
```

The executed prompt lands the handbook at `<repo>/.vinv/vinv.md` — plain markdown, readable by you and by every later Vinv stage.

---

<div align="center">

part of **[vinv](../README.md)** · [vinv.ai](https://vinv.ai)

</div>
