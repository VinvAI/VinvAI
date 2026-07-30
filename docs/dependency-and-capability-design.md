# Dependency & capability management — audit and design

Status: proposal. Covers every path by which Vinv acquires a third-party library,
for itself and for the projects and agents it drives.

The OTel skew that prompted this is one instance of a general defect, so the
audit is organised by *regime* (how intent is expressed and enforced) rather than
by package.

---

## Part 1 — Audit

Four regimes coexist. They share no policy, no verification, and in two cases
they write to the same directory without knowing about each other.

| # | Regime | Where | Intent expressed as | Verified? |
|---|--------|-------|--------------------|-----------|
| R1 | Engine deps | root `pyproject.toml` + `uv.lock` | declarative manifest | partially |
| R2 | Target-project deps | `bringup/…/prompts/*.txt` | **English prose run by an LLM** | no |
| R3 | Zero-install injection | `tracelens/…/launcher/run.py` | `sys.path` append | no |
| R4 | Capability injection | `extension/src/mcp/`, soft-imports | mixed | no |

### R1 — Engine dependencies: uv workspace, one lockfile

Nine members under `[tool.uv.workspace]`, one `uv.lock`, cross-member refs via
`tool.uv.sources = { workspace = true }`. The shape is right and modern. The
enforcement around it is not.

**No lock enforcement in CI.** `.github/workflows/test.yml:24`, `:77` and
`lint.yml:55` all run a bare `uv sync`. Bare sync is free to re-resolve and
rewrite `uv.lock`; nothing fails when the committed lock and the resolved set
disagree. A dependency drift lands green.

**No shared constraint policy.** Members were each pinned by hand, and they
disagree. Measured across all nine manifests:

| Package | Divergence |
|---|---|
| `pydantic` | `>=2.0.0,<3.0.0` (contracts, tracelens) vs **uncapped** `>=2.10.5` (core) |
| `jsonschema` | `>=4.20.0,<5.0.0` (contracts, tracelens) vs **uncapped** `>=4.0.0` (core) |
| `pyyaml` | `>=6.0.1,<7.0.0` (tracelens) vs **uncapped** `>=6.0.0` (core) |
| `httpx` | `>=0.27.0,<0.29.0` (tracelens[demo]) vs **uncapped** `>=0.24.0` (core) |
| `pytest` | `>=9.0.3,<10.0.0` (tracelens[dev]) vs `>=8.0.0,<10.0.0` (root + 8 members) |

Fourteen requirements carry no upper bound at all, concentrated in `core`
(`dspy-ai`, `openai`, `litellm`, `pexpect`, `websocket-client`, `pydantic`,
`httpx`, `jsonschema`, `pyyaml`) and `embedder` (`torch`, `huggingface-hub`,
`einops`). Every one of those is a silent-major-bump waiting for the next
`uv lock`. The root `pytest>=8.0.0` is already counterfactual — tracelens's
`>=9.0.3` wins the resolution, so root's declared floor describes a version the
workspace never installs.

**The `litellm` shim does not survive a non-uv install.** `core/pyproject.toml`
declares a bare, unpinned `"litellm"` and redirects it locally:

```toml
dependencies = ["litellm", ...]
[tool.uv.sources]
litellm = { path = "vendor/litellm_stub", editable = true }
```

`tool.uv.sources` is uv-only and is **not** recorded in built wheel metadata. Any
`pip install vinv-core` therefore resolves **BerriAI `litellm` from PyPI** — a
different package with a large transitive tree — in place of the in-tree
OpenAI-only shim. The stub's version string, `1.81.13+vinv_engine.openai`, makes
the substitution look plausible in `pip show` output rather than obvious. This is
a correctness and supply-chain hazard, not a style issue.

**Dead declaration.** `tracelens`'s `otel-libs` extra
(`tracelens/pyproject.toml:31-39`) is installed by nothing in the repo — not
`install.sh`, not CI, not the extension, not bringup.

**No policy document.** `docs/` has none; `AGENTS.md` says only `uv sync`.

### R2 — Target-project dependencies: an LLM as the package resolver

This is where the OTel skew lives. `bringup` renders shell into a prompt and an
LLM agent executes it against the *target service's* venv:
`bringup/src/bringup/runner.py:135-158` defines `_OTEL_PIN_SPECS`;
`prompts/otel_pin_block.txt` and `prompts/tracelens_install_editable.txt` carry
the instructions.

Five structural problems, in order of severity.

**1. Two writers to one venv, with incompatible semantics and no arbitration.**
`uv sync` is a *converging, exact* reconciler — it prunes extraneous packages by
default. bringup's path is an *imperative, additive* one-shot
(`pip install --force-reinstall`, `uv pip install --reinstall`). Last writer wins
and neither can observe the other.

This is directly observable in this workspace right now:

```
opentelemetry_instrumentation_urllib3-0.49b2.dist-info    INSTALLER=uv  REQUESTED=yes
opentelemetry_instrumentation_logging-0.49b2.dist-info    INSTALLER=uv  REQUESTED=yes
opentelemetry_instrumentation_starlette-0.49b2.dist-info  INSTALLER=uv  REQUESTED=yes
```

None of those three appear anywhere in `uv.lock`. They are agent-injected
packages living inside a lock-managed venv: invisible to `uv lock`, `uv sync` and
CI, and scheduled for silent deletion by the next exact sync — which will remove
instrumentation coverage with no error and no log line.

**2. The pin's sanity check runs upstream of the step that breaks it.** Step 3
asserts two versions (`opentelemetry-api`, `opentelemetry-instrumentation`) and
two imports. Step 4 then runs
`python -m opentelemetry.instrumentation.bootstrap -a install`, which installs
*more* contrib packages afterwards. The check cannot see them. That ordering is
exactly how `0.65b0` contrib landed on a `0.49b2` base and produced

```
ImportError: cannot import name 'HTTP_DURATION_HISTOGRAM_BUCKETS_NEW'
             from 'opentelemetry.instrumentation._semconv'
```

**3. `bootstrap -a install` is unpinnable by construction.** It resolves "latest
compatible" against the target venv at run time and accepts no version argument.
Any design that calls it has given up determinism at that point. OpenTelemetry's
own guidance is to pin core and contrib together as a set — core `1.X.0` with
contrib `0.(X+21)b0` — which is a statement about a *set*, and `bootstrap` cannot
express a set.

**4. Prose is not a resolver.** `otel_pin_block.txt` is a six-row installer table
(Poetry / uv / PDM / Pipenv / conda / plain venv) in natural language, with
"switch installers, do not abort" instructions. The branches differ in real
semantics — `--force-reinstall` vs `--reinstall`, `--no-deps` present in one step
and explicitly absent in the next. An LLM choosing among them *is* the dependency
resolver, and it is nondeterministic.

**5. One correction to the original diagnosis.** The venv is currently
**coherent** at `1.28.2` / `0.49b2`, and the ImportError does not reproduce —
`opentelemetry.instrumentation.{requests,httpx,urllib3,starlette}` all import
cleanly, and `HTTP_DURATION_HISTOGRAM_BUCKETS_NEW` is absent from `_semconv`
because every package is on the older pair. The skew was transient: a
re-resolution pulled the whole set *down* to satisfy tracelens's
`opentelemetry-instrumentation>=0.48b0,<0.50.0`.

That healing is the other half of the bug. It silently discarded bringup's
`1.44.0`/`0.65b0` intent — and the comment at `runner.py:130-134` states that
contrib `<0.64b0` crashes every request on FastAPI ≥0.137. So the workspace is
now sitting on the version pair bringup itself considers broken, arrived at by
accident, with nothing reporting the reversal.

### R3 — Zero-install injection: already built, better, and bypassed

`tracelens` already implements foreign-venv capture with **no installs into the
target**:

- `run.py:552` `_capture_dependency_roots()` — resolves the directories holding
  tracelens's own OTel / PyYAML / wrapt / `importlib_metadata` via `find_spec` on
  the *current* interpreter.
- `run.py:668-680` — hands them to the target interpreter as
  `TRACELENS_CAPTURE_DEP_ROOTS` and re-execs into the target's own python.
- `run.py:588` `_install_capture_dep_fallback()` — child side, **appends** each
  root to `sys.path`.
- `child_bootstrap.py:114` — writes a `sitecustomize.py` into a private dir and
  prepends it to `PYTHONPATH`, so every inheriting child process is covered.

This is the same mechanism the OpenTelemetry Operator uses (init container copies
instrumentation into a shared volume, `PYTHONPATH` points at it) and the same one
`ddtrace` uses for single-step instrumentation. The repo has the industry-standard
primitive, and bringup ignores it in favour of mutating the target venv.

**But R3 carries the identical failure class, latent.** `opentelemetry` is a
**native namespace package** — verified: no `__init__.py` in site-packages, and
`opentelemetry.__path__` is a `_NamespacePath`. Namespace packages **merge their
`__path__` across every `sys.path` entry**. So with append-precedence and a target
venv holding a *partial* OTel install:

- `opentelemetry.sdk` resolves from the target venv (earlier on the path), and
- `opentelemetry.instrumentation.requests` resolves from the injected root (later),

giving a mixed-version import *inside one namespace* — the exact
`HTTP_DURATION_HISTOGRAM_BUCKETS_NEW` failure, reachable through the "clean" path.
The docstring's claim that "the target's own copy always wins" is true
per-**module** but not per-**distribution**, and for a namespace package that
distinction is the whole bug.

### R4 — Capability injection: how tools reach the agents

Two sub-cases with opposite quality.

**MCP tool injection is the best-designed component in the system.**
`extension/src/mcp/mcpRegistrar.ts` builds one neutral `McpServerSpec`
(`command`/`args`/`env`), then adapts it per client dialect (Cursor / Claude Code
`mcpServers`, VS Code `servers`, Codex). Detection is folder-based, writes are
idempotent merges that never touch other servers' config, every `write()` has a
matching `remove()`, `LEGACY_KEYS` handles migration from renamed servers, and
machine-specific absolute paths are deliberately confined to per-machine config
so they never land in a repo-tracked `.mcp.json`. Declarative, reversible,
verified. **This is the pattern the rest of the system should copy.**

**The verification/test tools the agents use are the opposite.** Nothing declares
them, so "optional" currently means three unrelated things with no runtime
distinction:

| Tool | Documented as | Declared in a manifest | In `uv.lock` | Installed | Reality |
|---|---|---|---|---|---|
| `hypothesis-jsonschema` | **"Adopted"** (`generators.py:10`) | **no** | no | **no** | arm permanently dead |
| `hypothesis` | required by that arm | root **dev group only** | yes | dev only | dev ≠ user behaviour |
| `CrossHair` | "kept optional/unwired" | no | no | no | comment only |
| `dowhy`, `pyrca` | `tracelens[rca]` extra | yes | no | no | extra never installed |
| `evidently` | `tracelens[drift]` extra | yes | no | no | extra never installed |
| `z3-solver` | evaluated, **declined with rationale** | n/a | n/a | n/a | **correct** |

The `hypothesis-jsonschema` case is the sharpest. `generators.py` calls it
*adopted*, `hypothesis_valid_available()` gates a real generator arm on it,
`plan.py:216` consumes that arm — and the package is declared in no
`pyproject.toml`, absent from `uv.lock`, and not importable (`ModuleNotFoundError`
confirmed). The arm has never run in any install that has ever existed. Its own
tests (`exerciser/tests/test_generators.py:16`) branch on availability, so they
pass while covering nothing.

Downstream this is worse than a missing feature. `exerciser`'s Thompson-sampling
bandit explores `(target × technique × oracle)`; a technique whose capability is
absent stays in the action space and gets pulled, so the bandit spends real budget
learning that a package nobody installed finds no bugs.

`z3-solver` is the counter-example and the template:
`extension/src/harness/rewardSignals.ts:25-32` records that the WASM build works
in the extension host, what it would be used for (assertion-vacuity screening),
why that is already subsumed by the executable fail-on-pre gate, and that it
remains the vetted path if real constraint solving is ever needed. A decision,
a rationale, and zero cost. It is the only tool in the table whose status is
unambiguous — and it is unambiguous because someone wrote it down, not because
any mechanism enforced it.

### Root cause, in one sentence

Every regime except the MCP registrar expresses dependency intent as **imperative
instructions executed at a moment** rather than **declarative state reconciled
against a lock** — so intent is unverifiable, unpinnable, and destroyed by the
next writer.

---

## Part 2 — Design

### What "robust anywhere" has to mean

The design target is not "works on my machine after a `uv sync`". It is: the same
bytes, with the same behaviour, against a target project that may be managed by
pip / Poetry / PDM / Pipenv / conda / uv, in a venv that may have no `pip` at
all, possibly PEP 668 externally-managed, possibly on a read-only filesystem,
possibly in a container, possibly offline, on any Python 3.9–3.14 — **without
writing a single byte into the target's environment, and with no LLM anywhere in
the resolution path.**

### Six principles

1. **One resolver, one lockfile, zero prose.** Anything a machine must install is
   declared in a manifest a resolver reads. No installer tables in prompts.
2. **Never write to a venv you do not own.** The target project's environment is
   read-only. Injection happens through the import system, not the installer.
3. **Ship capability as a sealed set, never as individual packages.** A bundle is
   atomic: all of it from one root, or none of it.
4. **Precedence is decided per bundle, not per module.** A namespace must never be
   satisfied from two roots at once.
5. **Capability availability is a reported value, not a silent absence.**
6. **Every declaration is verified by a test that fails when the declaration is
   wrong.**

### (a) One dependency policy at the workspace root

Add root-level constraints. uv reads `constraint-dependencies` from the workspace
root and applies them across every member, so members keep their own ranges while
the root becomes the single arbiter of shared ceilings:

```toml
# root pyproject.toml
[tool.uv]
required-version = ">=0.9,<1.0"          # the resolver itself is a dependency
constraint-dependencies = [
    "pydantic>=2.10.5,<3.0.0",
    "jsonschema>=4.20.0,<5.0.0",
    "PyYAML>=6.0.1,<7.0.0",
    "httpx>=0.27.0,<0.29.0",
    "click>=8.1.0,<9.0.0",
    "pytest>=9.0.3,<10.0.0",
    "ruff>=0.6.0,<0.9.0",
]
```

Alongside it:

- **Cap the fourteen uncapped requirements.** `torch` and `dspy-ai` especially —
  an unbounded floor on either is an unbounded blast radius.
- **Make the `litellm` shim honest.** Rename the vendored distribution to
  `vinv-litellm-shim` (still providing the `litellm` *import* package) and depend
  on it under that name. The substitution then survives every install path, not
  just uv's, and `pip install vinv-core` can no longer silently pull BerriAI.
- **CI: `uv sync --locked` everywhere, plus `uv lock --check`.** Drift fails the
  build instead of landing green.
- **Delete `otel-libs`** — it is superseded by (b).

### (b) The capability bundle — replaces R2 entirely

A **bundle** is a directory tree built by uv, from a locked manifest, at build
time, and injected read-only at run time.

```
capabilities/
  otel-capture/      pyproject.toml + uv.lock   # the ONLY place OTel versions are written
  propertygen/       pyproject.toml + uv.lock   # hypothesis, hypothesis-jsonschema
  symbolic/          pyproject.toml + uv.lock   # z3-solver, crosshair-tool
```

Each manifest carries exact pins, a `requires-python` floor, and — new — the
top-level import namespaces the bundle **owns**:

```toml
[project]
name = "vinv-capability-otel-capture"
requires-python = ">=3.9"
dependencies = [
    "opentelemetry-api==1.44.0",
    "opentelemetry-sdk==1.44.0",
    "opentelemetry-semantic-conventions==0.65b0",
    "opentelemetry-instrumentation==0.65b0",
    "opentelemetry-instrumentation-fastapi==0.65b0",
    # …the full contrib set, explicitly. No `bootstrap -a install`.
]

[tool.vinv.capability]
owns = ["opentelemetry"]        # this bundle is the sole source for this namespace
```

Build (once, per release, offline-capable):

```bash
uv sync --locked --project capabilities/otel-capture \
        --python 3.9 --target capabilities/otel-capture/.bundle
```

`--target` produces a flat, relocatable tree with `.dist-info` intact, so
entry-point discovery — which OTel depends on heavily — keeps working.

**Injection, with the three-way rule that fixes the namespace bug.** Replace the
`sys.path` append with a `MetaPathFinder` scoped to the bundle's owned namespaces.
At injection, for each owned namespace, compare what the *target* provides against
the bundle's own requirement set:

| Target provides | Action |
|---|---|
| **none** of the namespace | **prepend the bundle** — the whole namespace comes from one root, coherent by construction |
| **all** of the bundle's requirements, satisfying its version set | **stand down** — use the target's own copy, report which |
| **some** of it | **hard, named error** — never a silent merge |

Today's append-and-hope collapses all three into the middle case, and the middle
case is the bug. Deciding per *bundle* rather than per *module* is what makes a
namespace package safe to inject.

**`bootstrap -a install` disappears.** The contrib set becomes a declared,
locked list. The genuinely dynamic question — *which* instrumentors to activate
for this particular service — is answered at run time by
`probe_contrib_instrumenters()`, which already exists at `otel_setup.py:64`. That
is the correct split: **discovery stays dynamic, installation becomes static.**

**Multi-Python and native wheels.** The OTel bundle is pure Python, so one tree
covers 3.9–3.14. Bundles with native wheels (`z3-solver`) build per
`(python-tag, platform-tag)` and resolve at inject time; a missing combination
yields *capability unavailable, with a reason* — never a broken import.

### (c) Capability manifest and honest reporting

This is the fix for the z3 / CrossHair / `hypothesis-jsonschema` class. One
machine-readable registry, one entry per tool:

```toml
[capability.hypothesis-jsonschema]
bundle    = "propertygen"
provides  = "generator-arm:hypothesis_valid"
probe     = "hypothesis_jsonschema"
status    = "adopted"                 # adopted | deferred | rejected
rationale = "property-based valid instances drawn from the JSON schema"

[capability.crosshair]
status    = "deferred"
provides  = "function-level symbolic execution over pure typed functions"
rationale = "orthogonal to exercising HTTP endpoints against a live traced service"

[capability.z3-solver]
status    = "rejected"
rationale = "assertion-vacuity screening is subsumed by the executable fail-on-pre gate"
```

Enforced by CI, so a declaration that stops being true fails the build:

- `status = "adopted"` ⇒ the probe must import **and** an eval must show the arm
  actually producing output. This is precisely the check that would have caught
  `hypothesis-jsonschema` on day one.
- `status = "deferred"` / `"rejected"` ⇒ a rationale is mandatory, and CI asserts
  **no code path references it**. This promotes the z3 comment from prose to a
  checked contract.

At run time, every engine emits a `capabilities` block into its run record —
bundle, resolved version, and `active | standing-down | unavailable(reason)`. Two
consumers change behaviour on it:

- **The bandit excludes arms whose capability is unavailable from the action
  space**, instead of sampling them and silently no-op'ing.
- **The context pack surfaces the block to the harness agent**, so the agent knows
  whether it has a solver rather than guessing.

### (d) Prompts describe intent, never commands

bringup's job becomes "start this service, unmodified." No installer table, no
version pins in prose, no `--force-reinstall`, no fallback-installer ladder. If a
bundle cannot be injected, bringup fails with a named error identifying the bundle
and the conflict. The ~8 KB of installer prose across `otel_pin_block.txt` and
`tracelens_install_editable.txt` collapses to roughly one instruction: run the
service under `tracelens run`.

This also removes the LLM from the resolution path, which is the single largest
source of nondeterminism in the current system.

### (e) Close the engine-pin loop in the extension

`ENGINE_REF` pinning (`extension/src/engines/pinned.ts`) is already the right
idea: extension version ⇒ engine commit, 1:1. Two gaps:

- The engines checkout should be synced with `uv sync --locked` at the stamped
  ref, not a bare `uv sync` (`install.ts:195`, `:204`).
- `enginesSynced()` should verify the **lock hash**, not merely that a venv
  exists — otherwise a moved lock yields a different engine set than the vsix was
  cut against, which is R1's drift problem wearing R4's clothes.

### Migration order

Cheapest first; each step is independently shippable and independently valuable.

| # | Step | Cost | Buys |
|---|---|---|---|
| 1 | `uv sync --locked` + `uv lock --check` in all three workflows | hours | stops **new** drift immediately |
| 2 | Root `constraint-dependencies`; cap the 14 uncapped; rename the litellm shim | ~1 day | removes the silent-major-bump and wrong-litellm classes |
| 3 | Extract `capabilities/otel-capture`; delete `_OTEL_PIN_SPECS`, both prompt install sections, and the `bootstrap -a install` step | ~3 days | **kills the reported bug at the root** |
| 4 | Bundle `MetaPathFinder` with the own / stand-down / conflict rule, replacing the `sys.path` append | ~2 days | closes the latent namespace-merge hazard in R3 |
| 5 | Capability manifest + CI probes + run-record reporting + bandit action-space filter | ~3 days | no more silently-degraded agents |
| 6 | `propertygen` and `symbolic` bundles; wire `hypothesis-jsonschema` for real; resolve CrossHair to adopted-or-rejected | ~2 days | the declared test-tool surface becomes the real one |

Steps 1 and 2 are pure hygiene and worth doing regardless. Step 3 is the one that
makes the OTel failure structurally impossible rather than currently absent.

### Properties achieved

- Zero writes to any environment Vinv does not own.
- Identical bytes on every machine; the bundle is built once and locked.
- Works against pip-less venvs, Poetry / PDM / conda / uv, PEP 668
  externally-managed environments, read-only filesystems, containers, CI, and
  offline.
- No LLM in the resolution path.
- A version set can be **verified as a set**, before use, with a named error on
  conflict instead of an `ImportError` mid-request.
- Missing capability is reported and routed around, never silently absent.

---

## Sources

- [Versioning and stability for OpenTelemetry clients](https://opentelemetry.io/docs/specs/otel/versioning-and-stability/)
- [Dependency pinning between packages post 1.0 — opentelemetry-python discussion #1754](https://github.com/open-telemetry/opentelemetry-python/discussions/1754)
- [opentelemetry-python-contrib CHANGELOG](https://github.com/open-telemetry/opentelemetry-python-contrib/blob/main/CHANGELOG.md)
- [Injecting auto-instrumentation — OpenTelemetry Operator](https://opentelemetry.io/docs/platforms/kubernetes/operator/automatic/)
- [Understanding how Python auto-instrumentation works — operator issue #1267](https://github.com/open-telemetry/opentelemetry-operator/issues/1267)
- [dd-trace-py: user sitecustomize directory proposal (#1344)](https://github.com/DataDog/dd-trace-py/issues/1344)
- [uv — Resolution (constraints, overrides, build constraints)](https://docs.astral.sh/uv/concepts/resolution/)
- [uv — Locking and syncing (`--locked`, `--exact` / `--inexact`)](https://docs.astral.sh/uv/concepts/projects/sync/)
- [uv — Using workspaces](https://docs.astral.sh/uv/concepts/projects/workspaces/)
- [Should `uv sync` remove extraneous packages? (#4358)](https://github.com/astral-sh/uv/issues/4358)
- [PEP 723 inline script metadata in uv](https://deepwiki.com/astral-sh/uv/12.1-pep-723-inline-script-metadata)

---

## Part 3 — Addendum: findings from running Vinv on Vinv

Added after auditing the live `.vinv` state and captures in this workspace.

### 3.1 `core` is unused by this repo — deliberately, not accidentally

Measured: `core` is **18,389 lines across 69 files**, declares **no console script**,
is depended on by **no workspace member**, is imported by **nothing**, and the
extension never spawns it. Its git history is the initial public release plus
only mechanical commits (lint, `[project.urls]`, Python-version policy).

That is not accidental dead code. `core/README.md` has an `// 01 · embed the
agent runtime (optional)` section, `core/__init__.py` exports `BaseSwarmAgent`
and `TerminalExecutorAgent`, and `core/src/core/llm.py` states the contract
explicitly: the open-source build is **harness-only**, and
`ensure_dspy_lm_configured()` *raises* `HarnessOnlyLLMError` rather than
configuring a cloud LM, so "no code path can silently reintroduce network LLM
calls." Verified live: it raises.

So `core` is a published embeddable library that this monorepo does not consume.
It should not be deleted on dead-code grounds. But it is the origin of most of
the constraint problems in Part 1: every uncapped/divergent shared requirement
flagged there (`pydantic`, `jsonschema`, `httpx`, `pyyaml`, plus `dspy-ai`,
`openai`, `pexpect`, `websocket-client`) is declared by `core` — a package
nothing in the repo installs for its own use.

### 3.2 Why `litellm` is present, and the exact inversion in its substitution

Vinv makes **no in-process LLM call**: every agent run is delegated to an
external harness CLI (`claude`, `codex`, `cursor-agent`, `gemini`), and the LLM
boundary actively refuses to configure a model. `litellm` is therefore unused
for Vinv's own agent work.

It is nevertheless not removable as things stand: `core` imports `dspy` at module
load, and **dspy 3.2.1 hard-requires `litellm>=1.64.0`**. The in-tree shim
(`core/vendor/litellm_stub`, 588 lines) exists to satisfy that import without
BerriAI's transitive tree, and it does the job — measured against dspy 3.2.1 it
covers every litellm attribute dspy actually references, and `import dspy`
succeeds against it. Two apparent gaps (`litellm.ai`, `litellm.types`) are a
docs URL and a string literal in an allowlist, not real uses.

Two things about it are worth recording:

1. **The shim's version string is load-bearing.** `1.81.13+vinv_engine.openai` is
   what makes dspy's `litellm>=1.64.0` resolve. An "honest" low version silently
   fails the constraint and the resolver pulls BerriAI litellm alongside the
   shim, whose `litellm/` directory then collides with it.
2. **The substitution is inverted.** It is a `tool.uv.sources` redirect, which is
   uv-only and absent from wheel metadata. So it applies in the monorepo venv —
   exactly where `core`'s agents never run — and does **not** apply to
   `pip install vinv-core`, the only audience `core` is published for. Those
   users get BerriAI litellm against an unpinned `"litellm"`. The substitution
   works only where it is unnecessary and is missing everywhere it is needed.

Options, all of which change what a published package installs for third parties
and so need a product decision rather than a drive-by edit:

| Option | Effect | Cost |
|---|---|---|
| Depend on real `litellm`, pinned; delete the shim | correct on every install path | large transitive tree for embedders |
| Pin `litellm=={shim version}` in `core` | `pip install vinv-core` fails **loudly** instead of silently swapping packages | breaks pip installs until the embedder opts in |
| Move `core` out of the default workspace install | monorepo stops carrying core's deps at all | embedders opt in explicitly |
| Drop `dspy-ai` from `core` | removes the root cause | rewrite of the agent runtime |

Recommendation: option 3 then 2 — stop the monorepo carrying deps for a package
it does not use, and make the remaining mismatch loud rather than silent.

### 3.3 The defect class behind the wasted episodes

Both live false positives share one shape: **the product asserting an unverified
inference as a finding.**

- A raised exception was reported as a defect without checking whether a caller
  caught it. The embedder's EADDRINUSE single-instance lock — caught at
  `cli.py:91`, returns 0 — was clustered, dispatched, and scored −1.00. Fixed:
  containment is now derived from the capture (`traceStore.containmentVerdict`),
  excluded from `current_errors`, and carried as `contained` / `contained_by` so
  consumers can *label* it rather than silently drop it.
- The same class, found concurrently in the graph UI: `isDead(n)` is `!n.rt`
  ("no trace mapped"), which on a repo at 35/7577 traced symbols renders as a
  99%-dead-code claim, and prints "never executed in captured traces" directly
  above "CALLED BY · 23".

The general rule this suggests, and which the capability manifest in Part 2 (c)
applies to tools: **never present an absence of evidence as evidence of a
defect.** Report the absence, name what would settle it, and route around it.
