# ADR: Vinv VS Code extension scaffold

**Status:** Accepted  
**Date:** 2026-06-06  
**Scope:** `vinv-vs`

## Context

Vinv needs a first-class debugging surface inside VS Code for inspecting agent sessions, traces, and backend workflow state. The extension should live alongside the existing Electron shell and FastAPI backend.

## Decision

- Add `vinv-vs` at the repository root as a TypeScript VS Code extension scaffolded with the official `generator-code` Yeoman template (`yo code`).
- Categorize the extension under **Debuggers** with publisher id `vinv-vs`.
- Use a modular layout:
  - `src/extension.ts` — activation entrypoint
  - `src/commands/` — command registration
  - `src/debug/` — debugging UI and backend integration (placeholder for now)
- Defer git init inside the extension folder; the monorepo root remains the single git repository.

## Consequences

- Developers can press F5 in VS Code on `vinv-vs` to launch an Extension Development Host.
- Backend connectivity, trace viewers, and Temporal workflow inspection will be added incrementally under `src/debug/`.
- Root `README.md` lists the extension as part of the Vinv workspace.
