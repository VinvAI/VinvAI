# Security Policy

Vinv runs entirely on your machine — no account, no API keys, no telemetry — so
the attack surface is mostly local: the tracer that runs your service, the two
MCP servers your agent talks to over stdio, and the engine CLIs. We take reports
against any of it seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately instead, whichever you prefer:

- **GitHub** — [open a private security advisory](https://github.com/VinvAI/VinvAI/security/advisories/new)
  (Security → Advisories → *Report a vulnerability*). This keeps the report
  confidential and lets us collaborate on a fix in the same place.
- **Email** — [support@vinv.ai](mailto:support@vinv.ai) with `SECURITY` in the
  subject.

Please include:

- what the issue is and the impact you see,
- steps to reproduce (a minimal repro or PoC helps a lot),
- affected component and version — the extension version (Command Palette →
  *Vinv: About*, or the Open VSX version badge), and/or the engine/commit,
- any suggested fix or mitigation you have in mind.

## What to expect

- **Acknowledgement** within 3 business days.
- An initial assessment and severity call, and we'll keep you updated as we work
  a fix.
- Credit in the release notes when the fix ships, unless you'd rather stay
  anonymous.

Please give us a reasonable window to release a fix before any public
disclosure. We'll coordinate timing with you.

## Scope

In scope: the extension, the engine CLIs (`tracelens`, `index`, `embedder`,
`exerciser`, and the other workspace members), the MCP servers, and anything in
this repository.

Out of scope: vulnerabilities in third-party dependencies (report those
upstream, though a heads-up is welcome), and issues that require an already-fully-compromised
local machine.

## Supported versions

Vinv ships continuously from `main`; fixes land in the next extension release on
Open VSX. Please reproduce on the latest published version before reporting.
