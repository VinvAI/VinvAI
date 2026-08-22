# Git hooks

Local mirrors of CI so a push doesn't go red. Enable them once per clone:

```bash
git config core.hooksPath .githooks
```

- **pre-commit** — fast, diff-scoped mirror of `lint.yml`: extension README
  parity, ruff on staged Python, eslint on staged `extension/src` TypeScript.
- **pre-push** — heavier mirror of `test.yml`'s locally-runnable parts:
  extension `tsc` typecheck and `check-declared-deps`. Set
  `VINV_PREPUSH_CARGO=1` to also run `cargo test`.

**They are not a full guarantee.** The xvfb VS Code integration tests, the Rust
tests (unless opted in), and the ubuntu/macos/windows matrix run only in CI. The
hooks catch the common, deterministic failures — lint, format, README sync,
typecheck, undeclared imports — not everything.

Bypass in a pinch: `git commit --no-verify` / `git push --no-verify`.
