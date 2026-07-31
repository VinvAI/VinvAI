# Vinv — Consolidated Audit & Fix Register

**Subject:** `fix/exploration-gaps` / PR #40 @ `a8d570f` vs `main` @ `9a93dce` — 31 commits, **+29,623 / −724 across 94 files**
**Date:** 2026-07-27 · **Purpose:** pre-production deployment audit
**Method:** sixteen adversarial subsystem reviewers across three passes. Every item carries a `file:line` anchor, a concrete failure scenario, and a fix. Wiring/reachability claims were verified against the call graph. Items marked ⚙️ were **reproduced by execution**.

> This document supersedes `vinv-exploration-gaps-review.md` and `vinv-preprod-audit.md`. It is the single register of everything to fix.

---

## Addendum — 2026-07-28 · what a real third-party repo exposed

The connector that makes the five non-HTTP oracles reachable (`CONN-1`) was built and then driven against a clone of **huggingface/smolagents** — 18 Python modules, 1,414 indexed chunks, 275 module-level functions. It found five defects **none of the 16 reviewers and none of the ~900 existing tests had caught**, because every fixture in the suite is small, cleanly typed and cheap to import.

| ID | Defect | Effect before the fix |
|---|---|---|
| **REAL-1** | Nested union in an annotation (`list[Step \| None]`) → unbounded recursion in `_is_pure_container_annotation` / `annotation_base` | `discover_targets` raised `RecursionError`; `campaign` caught it as "oracles unavailable" and armed **0 of 124 actions**. Any modern typed repo. |
| **REAL-2** | Every runner claims `covered=(target,)` on invocation, before doing any work | A play whose worker never imported the target was paid the coverage bonus and posted a Bernoulli update. The bandit learned preferences over arms it had never measured, and the report said `status: ok`. 8/12 plays on first contact. |
| **REAL-3** | Import cost and call cost shared one 30 s deadline | `import smolagents.local_python_executor` takes **27 s** cold. Worker killed mid-import; recorded as `ModuleTimeout` — *"a call hung"* — for a module never reached. **Every crash play reported `calls: 0`.** Hits any torch/pandas/transformers-adjacent repo. |
| **REAL-4** | Containment shim replaced the `subprocess.Popen` **class** with a function | `class Popen(subprocess.Popen)` resolves its metaclass as `type(Popen)` = `function` → `TypeError: function() argument 'code' must be code, not str`. `asyncio.windows_utils` does exactly this at module scope, so every module transitively importing `asyncio` failed to import — and each failure was reported as an `import-error` **defect in the user's repo**. **18 fabricated findings out of 20 clusters (90% FP).** Windows-only; CI has no Windows job. |
| **REAL-5** | `SystemExit` from a CLI entry point classified as `function-crash` | `ArgumentParser.error` is documented to exit 2, so *every* argparse entry point in *every* repo yielded a false positive — in `issues.json`, the one artifact the extension surfaces. |

**Measured effect on smolagents:** calls **57 → 117**; clusters **20 → 1**, the survivor a genuine defect (`gaia_scorer:split_string(s="", char_list=[])` builds the regex `"[]"` → `PatternError`; an empty list is an ordinary boundary value for `list[str]`, and the function never escapes its input). Fabricated findings: **18 → 0**.

Covered by `exerciser/tests/test_real_repo_blockers.py` (60 tests); each fix was reverted and the corresponding tests confirmed failing.

**Method note.** The gap was not reviewer thoroughness — it was that no test ever pointed the harness at code it did not author. A recurring third-party-repo run belongs in CI.

### Still open from this pass

- **REAL-6 · Cluster signatures split on interpolated values.** `normalize_signature` collapses digits but not other interpolated text, so `Unsupported model type: vinv` / `: ` / `: None` became **three clusters of one defect**. Not fixed here: the docstring states the function must match the extension's own `failureSignature`, so changing it is a coupled Python+TypeScript change deserving its own decision.
- **REAL-7 · Importing example scripts executes them.** `examples/agent_from_any_llm.py` calls `agent.run(...)` at module scope; discovery imports it and really tries to reach an inference provider. Findings from such modules describe our decision to import a script, not a repo defect.
- **REAL-8 · No Windows CI job.** REAL-4 was Windows-only and invisible to CI. Five pre-existing failures in `core`/`bringup` (symlink escape, read-only dirs, ACLs) are likewise Windows-only and unknown to CI.

---

## Verdict

**Do not deploy as-is.** Six blockers and one secret leak sit on the live path — the code that ships today. Separately, **79% of the diff is unreachable from the product**.

| | Count |
|---|---|
| 🔴 Blockers (live path, ship today) | **6** (BLOCK-1…6) |
| 🔴 Security | **2** (SEC-1…2) |
| 🟠 Precision / false-positive generators | **24** (FP-1…24) |
| 🟠 Correctness & coverage | **41** (COR-1…41) |
| 🟡 Structure / reusability | **14** (STR-1…14) |
| 🟡 Operational / production risk | **25** (OPS-1…25) |
| **Total actionable items** | **112** |

| Scope fact | Value |
|---|---|
| Lines added by PR #40 | 29,623 |
| **Reachable from the product** | **2,573 (9%)** |
| Behind the manual `campaign`/`functions` CLI | 23,530 (79%) |
| Removable with **zero behaviour change** | ~971 |
| Cut / defer / shrink-able | ~21,400 |
| Subset delivering essentially all realized value | **~4,100** |

**Effort to shippable:** Stage 1 ≈ 1 day · Stage 2 ≈ 2 days · Stage 3 ≈ 3 days.

---

# STAGE 1 — 🔴 BLOCKERS (before this touches a user's machine)

### BLOCK-1 · Undrained stdout → every exercise pass on a real repo hangs and is killed
**`extension/src/harness/exerciseRunner.ts:197`**
`cp.spawn(bin, args, {cwd, env})` defaults to `stdio:'pipe'`; only `stderr` gets a listener (`:203`). **`child.stdout` is never read.** It is the *only* spawn site in `extension/src` that doesn't — `indexing.ts:176`, `identification.ts:140`, `episodeLoop.ts:363`, `tracedRun.ts:152`, `rewardEngine.ts:124`, `binaryAgents.ts:69`, `harnessRunner.ts:729` all drain it. `cli.py:53` prints the entire result document, including inlined `$ref` body schemas and ~8 input records per endpoint (`plan.py:410-421`).
**Failure:** 23-endpoint FastAPI → >64 KB → engine blocks in `write()` → `exit` never fires → 180s timer SIGKILLs → user sees `"exerciser timed out after 180s"` while `plan.json` on disk is complete. Works on a 3-endpoint demo; fails on every real repo; reads as a flake. *Found independently by two reviewers.*
**Fix:** `stdio:['ignore','pipe','pipe']` + a bounded `stdout` data handler (drain, don't ignore — the CLI emits structured `{"status":"error"}` there, which also serves BLOCK-3).

### BLOCK-2 · `child.kill()` instead of the codebase's own `killProcessTree` → orphaned processes
**`exerciseRunner.ts:206`**
`extension/src/proc.ts:80-114` exists **specifically** because Windows `child.kill()` doesn't kill the tree, and is used at `harnessRunner.ts:465/943/1064/1460`, `episodeLoop.ts:482`, `rewardEngine.ts:129`. Not here. `.venv\Scripts\exerciser.exe` is a **uv trampoline** — a distinct process from the `python.exe` it launches — and `spawn` has no `detached`, so there's no process group on POSIX either.
**Failure:** BLOCK-1 guarantees a timeout every run → orphaned Python keeps driving 200 probes at the dev server → three passes → three orphans → next run fails on a locked `plan.json.tmp-<pid>`.
**Fix:** use `killProcessTree`; add `detached:true` + `process.kill(-pid)` on POSIX.

### BLOCK-3 · `profile`/`scorecard` failures discarded → failure reported as success
**`exerciseRunner.ts:302-313`**
Both `runEngine` return values are thrown away (`plan`/`run` correctly check `step.ok`). `readExerciseJson` swallows all errors (`:44-50`); `exerciseStateFromArtifacts` coalesces null→zeros (`:93-96`).
**Failure:** `profile` crashes → `:306` reads the **previous** run's `profile.json` → returns `outcome:'done'` with stale coverage. A crashed profile is indistinguishable from a clean run: green *"done — 0/0 endpoints · 0 invariants."* Silently defeats `cli.py:56-58`'s explicit "diagnostics must be LOUD" contract.
**Fix:** check `step.ok` for both; return `outcome:'failed'` with the error.

### BLOCK-4 · No cancellation, no teardown on deactivate
**`exerciseRunner.ts:226`, `extension.ts:236-239`**
`runExercisePass` takes no `CancellationToken`; `autoPilot.ts:377` passes none; `deactivate()` only stops the embedder. Close the window mid-`run` → the engine keeps driving the service with no parent and no UI. Task Manager is the only recourse.
**Fix:** thread a `CancellationToken`; register the child handle for disposal in `deactivate()`.

### BLOCK-5 · Unguarded `spawn` wedges the harness lock for the whole session
**`harnessRunner.ts:1051-1058`**
`running = true` at `:1051`, unguarded `spawn` at `:1054`; `running` resets only in `settle()` (`:1274`). A synchronous throw (bad `cwd`, EMFILE, disconnected network drive — all reachable on Windows) leaves `isHarnessBusy()` permanently true; every later episode returns *"another harness run is already in progress."* The sibling `dispatchAgentPrompt` guards the identical call at `:887-896`.
**Fix:** wrap in try/catch and reset `running` in the catch.

### BLOCK-6 · Unbounded output accumulation → extension-host OOM
**`harnessRunner.ts:1243`**
`out += chunk` with no cap, fed by stdout *and* stderr (`:1260-1263`). Siblings bound it (`dispatchAgentPrompt` `.slice(-400_000)` at `:931`, `episodeLoop.ts:359`, `rewardEngine.ts:121`).
**Fix:** cap with the same `.slice(-400_000)` idiom.

---

# STAGE 1 — 🔴 SECURITY

### SEC-1 · Bearer tokens and PII written into the user's repo
**`run.py:837`, `state.py:79`, `store.py:118`**
`_execution_row` persists `result.body` verbatim. `POST /api/v1/login/access-token` is an ordinary plan endpoint, so a 200 writes `{"access_token":"eyJhbGciOi…"}` into **`.vinv/exercise/results.jsonl`**. `state.record_creations` harvests `scalar_values(ex["body"])` — including the JWT — into **`state_ledger.jsonl`**. Password hashes, emails, and any 2xx body content land there too. `.vinv/` is inside the repo, one commit from a public push.
**Contradicts the code's own contract** at `run.py:492` ("tokens are never persisted"), `run.py:614`, `regress.py:68`.
**Fix:** redact bodies before persistence — the shape hash and value digest already exist for exactly this purpose; restrict harvesting to id-shaped fields.

### SEC-2 · Harvested tokens substituted into path params → leaked to URLs and access logs
**`run.py:634`**
`_auth_sweep` does `{k: vid for k in pparams}` over harvested scalars, issuing `DELETE /users/eyJhbGciOi…` — putting the bearer token into the request URL, the server's access log, and every proxy in between.
**Fix:** never place harvested scalars into path params without a type/length/shape filter.

---

# STAGE 2 — 🟠 PRECISION (false-positive generators)

*Precision is the product. Google's Tricorder data: analyzers above ~10% effective false positives get disabled [Sadowski et al. 2018]. Each item below dispatches a bogus fix episode at `exerciseRunner.ts:334`.*

## On the live path

| ID | Defect | Anchor | Why it fires |
|---|---|---|---|
| **FP-1** | `NaN`/`Inf` poisons `numeric_bound` | `invariants.py:151,263` | `min([1.0,nan])` is order-dependent (breaks the "deterministic" guarantee); `nan<=v<=nan` is always False → **every later response flagged forever**; `json.dumps` writes a bare `NaN` token corrupting `invariants.json`. **Fix:** filter non-finite, `allow_nan=False` |
| **FP-2** | `ENFORCE_MIN_CONFIDENCE` is **dead code** | `invariants.py:41` | Learned invariants always score ≥0.857 at `MIN_SUPPORT=5`; the gate can never reject. The advertised precision control does nothing. **Fix:** Daikon statistical justification test [Ernst et al. 2001] |
| **FP-3** | Mistyped `params` crashes the whole run | `store.py:69`, `run.py:846` | Reader validates only `endpoint` is a str → `"5" <= 5` → unguarded `TypeError` aborts the exercise. **Fix:** type-guard in reader + defensive try/except |
| **FP-4** | `-0.0` vs `0.0`, NFC vs NFD → false `value-degraded` | `execute.py:97` | Representation-sensitive digest. **Fix:** coerce `-0.0→0.0`, `unicodedata.normalize("NFC")` |
| **FP-5** | `size_relation` enforced with `input_size` **always 3** | `regress.py:193` | `case["input"]` is always `{body,path_params,query}`; learned with `run._input_size` semantics (`run.py:943`). **Fires on every replay of every endpoint** that learned it. **Fix:** reuse `_input_size` |
| **FP-6** | probeId ignores **which credentials** produced the response | `run.py:967` | N credential sets collapse to one probeId, last-writer-wins. Superuser 200 + user 403 → phantom `baseline-degraded`; also poisons `valueDigest` stability. **Fix:** hash the credential set into the probeId |
| **FP-7** | Every authed case replayed with `fresh_auth[0]` | `regress.py:168` | Superuser-only endpoint recorded 200, replayed as normal user → 403 → reported as regression on unchanged code. **Fix:** persist a credential-set index; skip when unavailable (`auth_cases_skipped` already exists) |
| **FP-8** | State-drift filter **suppresses real regressions** (inverse FP) | `regress.py:216` | Generators are deterministic and `_format_value` returns fixed constants, so replayed values always intersect `planted` → genuine `behavior` diffs relabeled `environment`. **Silences essentially every behavior diff on every mutating endpoint.** **Fix:** attribute drift only on values the engine *received back*, never sent |
| **FP-9** | Auth-sweep rows labeled `round 0` but appended last | `run.py:384` | `_enforce_monotonic` reads list order → non-chronological → phantom `id_monotonic violated`. **Fix:** explicit monotone `seq` field |
| **FP-10** | Digit normalization collapses `HTTP 500/502/503` into one cluster | `issues.py:32` | First-seen status wins title and exemplar; distinct defects under-credited |
| **FP-11** | Branch coverage records **one arm per branch** on 3.12/3.13 | `monitoring_hook.py:113` | `DISABLE` disables the **instruction**, and both outcomes share it pre-3.14 → flipping the condition later records nothing. Test asserts line numbers only, so it passes. **Fix:** dedupe `(id(code),src,dst)`, don't DISABLE below 3.14 |
| **FP-12** | `verifiedEligible` marks a non-objective "portless survival" pass as verified | `rewardSignals.ts:591` | Trains the bandit on a pass that was explicitly not objectively verified. **Fix:** require `oracle==='pass_objective' \|\| tests==='pass'` |
| **FP-13** | `recordedTracePath` misses `serviceSlug()` | `episodeLoop.ts:270` | Service named `api server` → ENOENT → `catch{return null}` → the anti-reward-hacking tamper guard **silently disables** and a port-squatter passes as `objective:true` |

## Behind the CLI (fix before exposing `functions`/`campaign`)

| ID | Defect | Anchor |
|---|---|---|
| **FP-14** ⚙️ | **Service doubles swallow the canonical data-layer bug class.** `sandbox.py:1062` marks any exception whose `__module__` is `exerciser.service_doubles` as `contained` — but `IntegrityError`/`OperationalError`/`ProgrammingError` are **defined in that file** (`:948-964`) and `:849` deliberately raises them as "the database answering." **Every unique / NOT NULL / check-constraint violation is silently suppressed.** | `sandbox.py:1062` |
| **FP-15** | `asyncpg`/`clickhouse_driver` in a **synchronous** PEP-249 menu they don't conform to → `await` raises a repo-frame `TypeError` → eligible to be reported as a repo defect. No test covers them | `service_doubles.py:1577,1583` |
| **FP-16** | `honour_gitignore=True` removes real source from the sandbox copy → import failures that are artifacts of the copy, reported as the repo's defects. The `DEFAULT_EXCLUDES` docstring argues against exactly this for `build`/`dist`, then does it via `.gitignore` | `sandbox.py:244` |
| **FP-17** | Receiver-agnostic method names refuse **pure** targets: `xs.remove(3)` on a list, `df.drop(columns=…)` (returns a copy), `job.run()` | `functions.py:691-724` |
| **FP-18** | `os_denial` attributes any target `PermissionError`/`EACCES` to the kernel wall under `OS_SANDBOX` → genuine denial-shaped bugs invisible on the strong tier (false negative) | `containment.py:752`, `sandbox.py:957` |
| **FP-19** ⚙️ | `faults --auto-target` **finds nothing by construction** — `baseline={}` → every call missing required params → `TypeError` → in `_TYPED_REJECTIONS` → classified as correct handling | `faults.py` |
| **FP-20** ⚙️ | `Optional[str]` loses 3 of its 4 faults — `typing.Optional[str].__name__ == 'Optional'`, so `catalogue_faults` returns 1 fault vs 4 for `'str \| None'`. The string faults the module exists for never fire for any `Optional[...]` param | `faults.py:107` |
| **FP-21** ⚙️ | `campaign._concurrency_runner` passes **no kwargs** → every target called `fn()` → any function with required params raises `TypeError` in both batches → silent pass | `campaign.py:523-534` |
| **FP-22** | Concurrency `distinct`-count oracle: FP on time-varying returns, FN on non-return-value corruption | `concurrency.py:179` |
| **FP-23** | Transient import failure (missing CUDA, unset env) reported as **breaking API drift** | `environment.py:109` |
| **FP-24** | Differential comparator does raw `repr()` equality with **zero normalization** — correct today only because 378 snippets were hand-audited. Any address-bearing repr or cross-implementation float/container repr → false `wrong-value` | `differential.py:431,610` |

---

# STAGE 2 — 🟠 CORRECTNESS & COVERAGE

## Endpoints permanently unreachable (why real-world coverage looks poor)

| ID | Defect | Anchor |
|---|---|---|
| **COR-1** | **Content type discovered then thrown away.** `_body_schema_of` accepts `application/x-www-form-urlencoded`, but `Endpoint` has no content-type field and nothing threads it to `execute_probe` — which *does* support `content_type='form'` (`execute.py:150`). FastAPI's OAuth2 password flow gets JSON forever → 422 forever → 0% coverage, and no issue cluster because it never 5xxs | `openapi.py:122`, `plan.py` |
| **COR-2** | **Spec-level `security` ignored.** `_op_requires_auth` inspects only `operation["security"]`; a root-level `security:[{bearerAuth:[]}]` (the standard way to protect an API) yields `requires_auth=False` for every operation → no auth permutation, no semantic prompt, no login chain ever authored. Every endpoint 401s at 0% coverage with no diagnostic | `openapi.py:147` |
| **COR-3** | **`api_id` collisions fire one endpoint's inputs at another's path.** `_path_suffix` keeps two segments with params normalized, so `/users/{id}/items/{item_id}` and `/teams/{id}/items/{item_id}` share a key → `grouped_by_ep` overwrite → second endpoint never exercised, never covered, absent from `profile.json`, silently | `openapi.py:187`, `run.py:227` |
| **COR-4** | **The `observed` bandit arm sends handler kwargs as the HTTP body.** `_observed_examples` mines the handler's *Python* params (`session`, `db`, `current_user`) and posts them → guaranteed 422 on FastAPI → the arm permanently scores 0 | `plan.py:238` |
| **COR-5** | `_expire_semantic_reply` writes to an **unsanitized** filename while `plan.py:360` writes `_safe(api_id).json` → expiry stamps a different file → a dead scenario replays forever, never re-authored | `run.py:740` |
| **COR-6** | Declarative `Mount` prefix dropped **order-dependently** (variable-bound sub-app consumed before the Mount) — breaks the P0.1 feature it advertises. Test is inline-only so it passes | `runner.py:334` |
| **COR-7** | `methods=VARIABLE` not resolved → silently defaults to GET → wrong verb probed → 404 | `runner.py:265` |
| **COR-8** | `APIRouter(prefix=...)` ignored in the AST path (regex-vs-AST inconsistency) | `runner.py:331` |
| **COR-9** | Dynamic route paths (f-strings) dropped silently — should at least be counted so "0 endpoints" isn't misdiagnosed | `runner.py:274` |

## Oracle/state correctness

| ID | Defect | Anchor |
|---|---|---|
| **COR-10** | **`run` and `regress` compute different probeIds into the same store** — `run.py:967` hashes a 3-tuple, `regress.py:50` a 4-tuple. They never collide, so **regress never compares against the goldens `run` earned**; it seeds a disjoint id space where every observation is `"recorded"` and `degraded==0`. **Fix:** one shared `store.probe_id()` | `run.py:967` / `regress.py:50` |
| **COR-11** | `baselines/<api_id>.json` **grows without bound and new entries are never compared** — authed path-params come from ledger ids that change every run → new probeIds every run. No cap, no TTL, no eviction. **Fix:** key authed variants on a stable slot; evict by `capturedAt` | `baseline.py:143` |
| **COR-12** | Duplicated probe-id hash formula in two places, byte-identical today; silent 0-credit if either drifts (no test asserts equality) | `run.py:920` / `run.py:968` |
| **COR-13** | Main round loop is the **only** probe call site with no `try/except`; `execute.py:175` catches only `(URLError, OSError, ValueError)`, so `http.client.HTTPException` escapes → one malformed response aborts `run_exercise` before any artifact is written | `run.py:238`, `execute.py:175` |
| **COR-14** | **Artifacts persisted only after the loop** → a SIGKILL (guaranteed by BLOCK-1) discards the whole run *and* its untracked mutations, which can never be torn down. Scenario/canary results are never fed to `record_creations` even on a clean run | `run.py:352,403` |
| **COR-15** | Coverage recomputed **per endpoint per round** — 3 full `trace.jsonl` scans each. 23 endpoints × 9 rounds ≈ 620 full scans. Alone exceeds the 180s deadline on a real trace | `run.py:263-271` |
| **COR-16** | `branch_ids_for_endpoint` does a full trace scan per endpoint per round (quadratic on the live path) | `coverage.py:124` |
| **COR-17** | `monitoring_hook`'s `id(code)` cache holds **no reference** → address reuse → wrong line numbers, unbounded growth | `monitoring_hook.py` |
| **COR-18** | Unattributed branch arms credited to **every** endpoint → import-time branches inflate whichever endpoint runs first | `coverage.py` |
| **COR-19** | Branch-writer is a **second concurrent appender** to the trace; drained lines exceed PIPE_BUF so O_APPEND atomicity doesn't hold (never does on Windows) — the exact hazard `child_bootstrap` was built to avoid | `monitoring_hook.py:144` |
| **COR-20** | Child sidecar path derived from a **relative** `TRACELENS_OUTPUT` → captures lost when a child `chdir`s | `child_bootstrap.py:70` |
| **COR-21** | `compaction` drops every `cleaned` row → scorecard's state-pollution numbers silently reset ("created 2, cleaned 0" after a run that cleaned 8) | `compaction.py:191`, `scorecard.py:119` |
| **COR-22** | `scenario.to_json()` omits `shape_hash` → `run.py:790` always reads `"empty"` | `scenario.py:88` |
| **COR-23** | `issues.py:108` reads `covered_frames`, which `_execution_row` never sets → always `[]`, yet `exerciseRunner.ts:137` tells the fix agent to look for it | `issues.py:108` |
| **COR-24** | `active_ids` never mutated — endpoints that error every round keep consuming budget | `run.py:219` |
| **COR-25** | `record_creations(executions)` called twice over the full list | `run.py:332,403` |

## Behind the CLI

| ID | Defect | Anchor |
|---|---|---|
| **COR-26** | **Purity guard fails OPEN on imported first-party callables** → runs destructive target code in-process. `from mypkg.db import wipe_all; def process(): wipe_all()` → `impurities=[]`. `_dotted_reason` returns `None` for non-stdlib and the `elif` never falls through to "cannot verify". Zero cross-file analysis. *The prior example was caught only because the wrapper was named `push` (name vocabulary).* **Fix (~4 lines):** emit an "unverifiable cross-module call" impurity → routes to the containment `ad96cc0` already built | `functions.py:1118-1125` |
| **COR-27** | Positional-only params called by keyword → `TypeError` not in `_MALFORMED_CALL_MARKERS` → **harness error attributed to the target** | `functions.py:1017` |
| **COR-28** | `Union[A,B]` only ever exercises arm A | `functions.py:1335` |
| **COR-29** | No per-call isolation within a module — a target mutating global state contaminates siblings, so a crash can be blamed on target B that only A caused | `functions.py:1482` |
| **COR-30** ⚙️ | **The campaign destroys the exception policy.** `run_functions` does `ExceptionPolicy.load(repo)` with `decay=0.5` then saves — **per play**. Twenty crash plays scale every human adjudication by ~1e-6; it forgets everything within one run | `functions.py:2728`, `campaign.py:369` |
| **COR-31** ⚙️ | **HTTP bandit arms are fiction** — `run_exercise` takes no endpoint or technique parameter, so ~150 of ~400 arms are identical full sweeps and `by_technique` is meaningless | `run.py:100`, `campaign.py` |
| **COR-32** | **Bandit cost normalization inverts the objective** — `credit/max(1,cost)` with unbounded cost: a real violation from a 3s differential play scores 0.083 vs 0.25 for a cheap coverage hit. **Cheap coverage out-rewards real defects.** Every campaign test returns uniform cost=1, so the path is untested | `bandit.py:114`, `campaign.py:132` |
| **COR-33** | Differential **emit-once worker** — buffers all 378 rows and emits at the end; one hang/`os._exit`/segfault (plausible: the target *is* a recursive AST interpreter) voids the entire target's run | `differential.py:583` |
| **COR-34** | Single 60s wall-clock timeout wraps all 756 evaluations; no per-snippet bound | `differential.py:985` |
| **COR-35** | Refusal-cache key normalizes only digits → any hex address/path defeats it → adjudication budget re-burned every run | `differential.py:735` |
| **COR-36** | Credited-signature eviction is **lexicographic, not LRU** → re-credits live defects past 5,000 | `campaign.py:772` |
| **COR-37** | `--seed` not reproducible — wall-clock `elapsed` feeds the reward → seeded Bernoulli diverges | `campaign.py:727` |
| **COR-38** | Concurrent campaigns lose-update `campaign.json` (atomic write, but read-modify-write race) → re-credit defects | `campaign.py:772` |
| **COR-39** | `uv.lock` schema-blind: parse failure → `{}` → reports **"0 disagreements"** (silent false negative on the oracle's whole purpose) | `environment.py:271` |
| **COR-40** | "Resolution matrix" is uv-only and 2-cell — no python-version or extras axis despite the name | `environment.py:230` |
| **COR-41** | `_UNSHARE_SCRIPT` word-splits `$VINV_WRITABLE_PATHS` → any path with a space breaks the mount → probe fails → silent downgrade to shim | `containment.py:363` |

---

# STAGE 3 — 🟡 STRUCTURE & REUSABILITY

**~971 lines removable with zero behaviour change.** Root cause: a missing contract, not excess ambition. There is no `Oracle` abstraction, so six oracles re-derived everything.

| ID | Refactor | Evidence | Δ lines | Risk |
|---|---|---|---|---|
| **STR-1** | **Extract `exerciser/_worker.py`** — `run_worker()`, `worker_entrypoint()`, `emit`, `resolve`, `summarize`. Deletes 5 spawn blocks (~230), 5 `main()` dispatches (~55), 5 worker preambles (~65), 4 byte-identical `_emit` (16), 3 `_resolve`, 2 verbatim `_summarize` (30) | clone detector: character-identical 5-way matches; `PYTHONPATH` join byte-identical in 4 files | **−250** | low |
| **STR-2** | **`issues.build_clusters(...)`** — one builder + five 10-line specs. Give `FailureCluster` a real `target` field so 5 non-HTTP oracles stop faking `endpoint_id`/`method`/`path` with `"CALL"`/`"FAULT"`/`"CONC"`/`"DIFF"`/`"ENV"` | 5 near-identical `cluster_*` (~214 lines); `differential` even sorts by a different key | **−130** | low |
| **STR-3** | **Define `Oracle`/`OracleResult`; rename `mismatch_clusters`→`issue_clusters`; unify `run_*` signatures.** Collapses `campaign.py:158-313` + `:386-597` into a dispatch table | `_findings(..., count_key)` exists **only** because one module named a key differently. `OracleConfig` is a union of 6 unrelated knob sets | **−170** | med |
| **STR-4** | **Delete confirmed dead code**: `differential.py:158-194` (unreachable duplicate of `_ubiquity`/`_UBIQUITY_CAP`/`_discriminative_constructs`/`_names_word`, 0.951 similarity) + `:322-334` orphaned banner; `campaign._accepts` + its dead `else` branch + `_functions_cache` | `_UBIQUITY` binds the *second* definition. `_accepts` feature-detects a kwarg on a sibling function in the same package that unconditionally declares it | **−76** | **none** |
| **STR-5** | Merge `sandbox._worker_main` into a shared `drive_module(..., decorate_row=)` — kills the `functions↔sandbox` cycle and all 5 `fn._private` reaches | `sandbox.py:1519-1695` reimplements `functions.py:2102-2191`, same error strings | **−90** | med |
| **STR-6** | **Move `_SITECUSTOMIZE_SOURCE` to `_shim_template.py`** as package data | **310 lines of real Python inside a string literal** — not linted, type-checked, covered, or unit-testable | 0 net | low |
| **STR-7** | **Split `functions.py`** at its existing banners → `purity.py` (~1,400), `argvalues.py` (~150), `oracles/crash.py`. Move `detect_src_roots` to `store.py` | 2,812 lines, 5 responsibilities; `run_functions` is a single **306-line** function. Today `concurrency`/`differential`/`faults` import a 24-line path helper and drag in the whole purity analyser | 0 net | med |
| **STR-8** | Break `run↔regress` — move `_resolved_auth_headers`/`_split_endpoint`/`_fresh_auth_headers` to a leaf `auth.py` | 3 private helpers crossing in both directions | −10 | low |
| **STR-9** | Drop `IMPLEMENTATION_DEFINED` + `EXCLUDED_UNSAFE` (138 lines of "21 tests we decided not to write", exported and asserted upon) and the 132 lines of unconsumed `optimize.py` episode machinery | referenced only by a test that asserts they're disjoint | **−330** | low |
| **STR-10** | Normalize CLI flags — `--target` everywhere, `--timeout` everywhere | 4 spellings of target selection, 4 of timeout; `--target` is *required* in `concurrency`, optional elsewhere | −15 | none |
| **STR-11** | Give `run_environment` a `python=` param | it's the only oracle without one, so `campaign` silently cannot honour `--python` | small | low |
| **STR-12** | Route `sandbox`'s raw `write_text` through `store.write_json`; add `store.oracle_paths(repo, name)` | `sandbox.py:1265,870` bypass the atomic tmp+rename discipline; 20+ hardcoded `exercise_dir(repo)/"x.json"` call sites | small | low |
| **STR-13** | Import `functions._IMPURE_MODULE_ROOTS` instead of duplicating it | `sandbox.py:170` documents it as the source of truth but keeps a copy in sync **by comment** — it will drift | small | low |
| **STR-14** | Remove ~12 gratuitous in-function imports (`import re as _re`, `import ast as _ast`, `import hashlib` ×2) with no cycle justification | `differential.py:134,145,190,316,739`, `faults.py:546`, `run.py:914,957` | −15 | none |

**If you do only three:** STR-4 (zero risk, half a day — a function defined twice where the first copy is unreachable is what a reviewer finds in five minutes and stops trusting the PR over), then STR-1 (the abstraction whose absence caused everything else — today a worker-timeout fix must land in 5 files and 4 will be missed), then STR-3.

---

# STAGE 3 — 🟡 OPERATIONAL / PRODUCTION RISK

*Latent until `functions`/`--sandbox` is exposed, but blocking for that exposure.*

| ID | Sev | Defect | Anchor |
|---|---|---|---|
| **OPS-1** | **BLOCKER** | **Sandbox temp tree leaks up to 256 MB/run while the report claims removal.** Three paths: (a) `plan_services()`/`answered_fixtures()` run *after* the copy — a non-`OSError` (e.g. `AttributeError` on a drifted fixture) escapes both handlers and orphans the tree; (b) **zero `atexit`/`signal` handlers in the package** → SIGTERM/`taskkill`/deactivate skip `finally`; (c) `shutil.copy2` preserves read-only → `rmtree(ignore_errors=True)` silently fails, and `:1396` unconditionally writes `root_removed:True`. No stale-tree sweeper | `sandbox.py:336,872,1394` |
| **OPS-2** | **BLOCKER** | **cp1252 on all six worker pipes.** Bare `text=True`, no `encoding=`; `sandbox_env` never sets `PYTHONIOENCODING`. Child side: a target printing an emoji → `UnicodeEncodeError` → worker dies → all rows lost. Parent side: raw UTF-8 bytes (`0x81/0x8D/0x8F/0x90/0x9D` undefined in cp1252) → `UnicodeDecodeError` **inside `subprocess.run`**, uncaught → **kills the entire run** | all 6 spawn sites |
| **OPS-3** | HIGH | Workers batch all output to the end — a module with 50 targets where #49 hangs loses all 48 completed results | `sandbox.py:1694` |
| **OPS-4** | HIGH | Worker stderr captured and discarded; the one guard tests the **global** `rows` list so it never fires after the first module, and is `log.debug` regardless. A segfaulting/OOMing worker leaves no trace | `functions.py:2671` |
| **OPS-5** | HIGH | `snapshot_tree` calls `Path.resolve()` **per file entry**, twice per module — on Windows an open+query+close each. 20k files × 40 modules = 1.6M resolves, invisible in the report | `sandbox.py:1108` |
| **OPS-6** | HIGH | **Windows spawn holes:** `os.startfile` not blocked; `multiprocessing` spawns via `_winapi.CreateProcess`, bypassing the `Popen` patch. With no rlimits on Windows, containment reduces to tree+env redirection | `sandbox.py:698` |
| **OPS-7** | HIGH | **Windows containment is a no-op *and* the default was flipped to enabled** → impure targets that were previously *refused* now **execute** under a shim documented as unable to stop `sqlite3`/`ctypes`. Net safety regression. `--require-tier os-sandbox` fails closed correctly but nothing in the default path sets it | `containment.py:614`, `functions.py:2557` |
| **OPS-8** | MED | **The shim fails OPEN and its fail-closed guard is dead code** — `os.path.realpath("")` returns **cwd**, never `""`, so `if not _ROOT: return False` is unreachable and an unset env var makes cwd the sandbox root | `sandbox.py:480,535` |
| **OPS-9** | MED | Corrupt `.vinv` artifact is **fatal, not degraded** — `ExceptionPolicy.load` runs *after* all subprocess work but *before* `write_jsonl`, so a drifted policy file discards an entire completed run | `exception_policy.py:771` |
| **OPS-10** | MED | **Ctrl-C loses everything** — `_call_once` catches `BaseException` so the worker swallows KeyboardInterrupt and keeps calling targets; the parent has no `finally` around artifact writes | `functions.py:2216,2736` |
| **OPS-11** | MED | Campaign has **no wall-clock deadline**; compounds with OPS-10 into "the only way to stop it destroys the results" | `campaign.py:713` |
| **OPS-12** | MED | Windows junctions aren't symlinks → `copy_repo` and `services.rglob` recurse into them. uv creates junctions (see the repo's own memory note); a junction to a parent = unbounded recursion bounded only by the 256 MB cap | `sandbox.py:407`, `services.py:130` |
| **OPS-13** | MED | `%APPDATA%`/`%LOCALAPPDATA%`/`HOMEDRIVE`/`HOMEPATH` not redirected → `platformdirs`, pip cache, HF cache write to the **real** AppData | `sandbox.py:911` |
| **OPS-14** | MED | Unbounded `capture_output` on six spawns — a target printing in a loop produces GBs within the 30s budget | all 6 spawn sites |
| **OPS-15** | MED | `issues.json` shape is an unchecked `as T` cast; an older-format file throws and flips the whole pass to `'failed'`, discarding the profile just computed | `exerciseRunner.ts:306-325` |
| **OPS-16** | MED | Spawned without `windowsHide` → four console flashes stealing focus per Auto-Pilot cycle, despite `proc.ts:62` documenting exactly why `hiddenBackgroundOptions` exists | `exerciseRunner.ts:197` |
| **OPS-17** | MED | `VINV_EXERCISE_TIMEOUT_S` is load-bearing, undocumented, and **under-budgeted**: 200 probes × 3 rounds × 0.8s settle ≈ 160s of settle alone against a 180s cap | `exerciseRunner.ts:176` |
| **OPS-18** | MED | Differential timeout orphans grandchildren (no process group / Job Object) — the Windows process-kill footgun already in the repo's memory notes | `differential.py:985` |
| **OPS-19** | MED | Wedged concurrency worker is uncancelable; `concurrent.futures`' `atexit` joins every worker thread, so the "clean shutdown" comment is false and a hang always costs the full `worker_timeout_s` | `concurrency.py:133` |
| **OPS-20** | LOW | `.tmp-<pid>` litter never swept after a killed run | `store.py:90` |
| **OPS-21** | LOW | `--sandbox-keep-root` orphans a tree per run — the `SandboxPolicy` docstring warns the caller "should set `root_parent`"; the only caller doesn't | `cli.py:272` |
| **OPS-22** | LOW | `environment.py:244` does real PyPI network egress (2 × 180s) without `--offline` | `environment.py:244` |
| **OPS-23** | LOW | Long paths (>260) under a deep workspace — `store.write_json` has no long-path fallback; its `OSError` becomes a generic `{"status":"error"}` | `store.py` |
| **OPS-24** | LOW | `_UBIQUITY` re-parses all 378 snippets at **import** (~66 ms) unconditionally, even for repos with zero evaluator targets | `differential.py:452` |
| **OPS-25** | LOW | Frozen/Nuitka builds: `write_shim` guards `if doubles.is_file()` and **silently skips** the copy; failure surfaces only as an `install-error` line | `sandbox.py:779` |

---

# STAGE 4 — 🟢 VALUE DECISIONS (what to ship, cut, defer)

| Subsystem | Lines | What it finds | How often it matters | Verdict |
|---|---|---|---|---|
| **Route discovery** | 857 | Declarative `Route(...)` lists, router prefixes | **Every run** — fixes the actual root cause | **KEEP** |
| **Value oracle** (baseline+invariants+issues+execute) | ~280 | Silent wrong-value regressions | **Every run** — closes gap G2 | **KEEP** (fix FP-1…FP-4) |
| **Branch coverage** (PEP 669) | ~420 | The exploration reward signal | **Every run** | **KEEP** (fix FP-11, COR-16/17/18) |
| **Child-process tracing** | 434 | Makes `uvicorn --workers` visible at all | **Every multi-process app** | **KEEP** (fix COR-20) |
| **Reward signals** | ~630 | Why a run was `unavailable` | Every episode | **KEEP** (fix FP-12) |
| **functions harness** | 4,233 | `None`-guard gaps, `NameError` on cold paths | Real ceiling-raiser (8→147 targets), but generator is 9 types × 3 values, **`None` for 7 of 9** hostile | **SHRINK → ~800** |
| **exception_policy** | 1,650 | Nothing — suppresses the harness's *own* noise | Learning is **dead** in the product | **SHRINK → ~120** |
| **sandbox** | 2,676 | Nothing — makes impure targets callable | 17 `skipif(win32)` → **~zero executed Windows coverage** | **SHRINK** to shim+tree |
| **containment** | 1,187 | Nothing — tier selection | `_candidates()` returns `[]` on win32 — **dead on your platform** | **DEFER** |
| **service_doubles + services** | 3,346 | Nothing — in-jail fakes | Carries FP-14 | **DEFER** |
| **faults** | 1,257 | Shape faults + chunk-boundary sweep | `--auto-target` finds zero by construction (FP-19) | **SHRINK** to the sweep |
| **concurrency** | 647 | GIL-yielding races only | No schedule control despite the docstring; FP-21 | **CUT** |
| **environment** | 613 | Signature drift + `uv lock` | Varies **no** Python version/locale/TZ; findings never clustered | **CUT** |
| **semantics_corpus** | 4,141 | Interpreter divergence in a Python evaluator | **~1–2% of repos** | **CUT / extract** |
| **differential** | 1,668 | Same — needs an `exec`/`eval` target | Degrades cleanly, but 5,809 lines idle | **CUT / extract** |
| **campaign + ActionBandit** | 1,834 | Nothing — dispatcher | ~400 arms / 20-play budget; COR-30/31/32 | **DEFER** |
| **agent_loop** | 396 | Nothing — question queue | **Write-only**: nothing reads `agent_*.json` back | **DEFER** |

**Ship now (~4,100 lines):** route discovery + value oracle + PEP 669 branch coverage + child-process tracing + reward-failure diagnosis — everything already on the product path.

**Next PR (~50 lines, worth more than the other 23,000 combined):** teach `exerciseRunner.ts` to call `functions` after `run`.

**Extract** `differential` + `semantics_corpus` to an optional `vinv-differential` package. **Defer** `campaign`, `containment`'s OS ladder, `service_doubles`, `agent_loop`. **Cut** `concurrency`, `environment`. Let real findings decide whether they earn their way back.

**Recoverable:** CUT 8,737 · DEFER 6,763 · SHRINK ~5,900 = **~21,400 lines**.

---

# TESTING DISCIPLINE — why all of this shipped green

The recurring reason: **tests exercise the same happy path the code was written against.** Concretely:
- Branch-coverage test asserts *line numbers*, not both arms → misses FP-11.
- Every campaign test returns uniform `cost=1` → the reward path is untested → misses COR-32.
- The Mount test is inline-only → misses COR-6.
- The confidence-gate test only exercises the *unreachable* branch → misses FP-2.
- Case #6 of the purity bypass table uses `from os import remove` (**stdlib**, which `_dotted_reason` recognizes) → masks COR-26 and gives false confidence about it.
- 17 `skipif(win32)` in `test_sandbox.py` → ~zero executed Windows coverage on the platform you run.

**Standard to adopt:** every oracle needs an **adversarial** test that tries to *produce a false positive* — both branch arms, non-uniform cost, `NaN`/`-0.0`/unicode, a hanging snippet, junction/read-only/long-path on Windows, a plausibly-shaped-wrong output that *must* be caught, and a legitimately-varying output that *must not* be flagged. A suite that only proves true positives cannot certify precision.

---

# VERIFIED CORRECT — do not "fix" these

Reviewers actively tried to break these and could not. Recorded so the fix pass doesn't churn them:

- **No import-time side effects** anywhere (AST-scanned); `semantics_corpus` is pure string literals.
- The two `except Exception: pass` in `semantics_corpus.py` are **inside string literals** — corpus snippets, not code.
- **No shell injection** — all spawns use argv arrays with `shell:false`; paths with spaces are safe.
- `_inside_root` case-sensitivity is a **non-issue** — Windows `realpath` normalizes case even for a non-existent leaf.
- **Artifact writes are atomic** (tmp + `os.replace`) — torn reads aren't a concern; only schema drift is.
- Repo copied **once per run, not per module**; `campaign` caches `run_functions` across plays.
- Throughput sweep is bounded (`_MAX_REQUESTS=500`, `_MAX_CONCURRENCY=32`).
- **Fail-closed discipline is real** where it counts: the worker refuses to import if the shim didn't load; `require_tier` genuinely refuses rather than downgrading; `--no-sandbox` leaves targets refused rather than running them loose.
- On Linux/macOS containment **probes before trusting** — runs a child that attempts to escape and checks the real filesystem. Correct design.
- Differential **corpus discipline** is excellent — all 378 snippets verified deterministic, no `id()`/time/random. NaN and `PYTHONHASHSEED` hypotheses were **disproved**.
- `_laplace` math, the bool-is-int exclusion, `select` determinism, and `composeRewardBreakdown`'s weight renormalization are all correct.
- `exception_policy`'s evidence model, `containment`'s tier detection, and `service_doubles`' PEP-249 adapter are **large because their problems are** — cohesive, leave them alone.
- `semantics_corpus.py` is 3,843 lines of **data**; it should not count against "the code is too big."

---

# THE TWO STRUCTURAL LESSONS

**1. `exception_policy` exists to suppress `functions.py`'s own crudeness.** Its `conformant` feature is explicitly about "passing `None` to a `str` parameter is the harness deliberately violating the contract" — 1,038 lines of Bayesian machinery to filter noise a better generator would never emit. Fix the generator and most of the policy becomes unnecessary. Its learning half is dead in the product anyway, while its entropy-seeded Thompson draw makes output **non-reproducible between runs**.

**2. Everything hard is gated behind an orchestrator nobody calls.** The valuable insight — reaching bugs that live in *functions*, not routes — is real and correct. But it was built as a research platform (RL bandit, OS jails, service virtualization, interpreter differential testing) instead of the one thing that would deliver it: teaching the extension to call `functions` after `run`.

The *ideas* are largely right and several are genuinely SOTA-grade. The *delivery* inverted the priority: 29,000 lines of capability behind a door, while the door stayed shut and the room that is open has a hole in the floor.

---

# APPENDIX — precision doctrine & references

Developers decide a tool's false-positive rate with their attention. Tricorder: analyzers above **~10% effective false positives get dismissed or disabled**; the platform holds below 5% [Sadowski et al. 2018]. Coverity reached the same conclusion: past a noise threshold users blacklist the tool and ignore even its true reports [Bessey et al. 2010].

**Grade, don't suppress:** reproduce before report → model nondeterminism first → prove attribution (target code, not harness or environment) → corroborate low-precision detectors → rank by trustworthiness → minimize the repro → close the loop so dismissals down-weight noisy detectors.

For invariants, replace the inert gate (FP-2) with Daikon's **statistical justification test** — the probability the invariant holds by chance must fall below a threshold, requiring a minimum sample count [Ernst et al. 2001] — paired with DIDUCE's start-strict-and-relax discipline, scoring a violation by how *warm* the invariant was [Hangal & Lam 2002].

**References** (verified against DBLP + publisher/author PDF):
- Ernst, Cockrell, Griswold, Notkin. *Dynamically Discovering Likely Program Invariants.* IEEE TSE 27(2), 2001. https://homes.cs.washington.edu/~mernst/pubs/invariants-tse2001.pdf
- Hangal, Lam. *Tracking Down Software Bugs Using Automatic Anomaly Detection.* ICSE 2002. https://suif.stanford.edu/papers/Diduce.pdf
- Engler, Chen, Hallem, Chou, Chelf. *Bugs as Deviant Behavior.* SOSP 2001. https://dl.acm.org/doi/10.1145/502034.502041
- Kremenek, Engler. *Z-Ranking.* SAS 2003. https://web.stanford.edu/~engler/z-ranking.pdf
- Liblit, Naik, Zheng, Aiken, Jordan. *Scalable Statistical Bug Isolation.* PLDI 2005. https://theory.stanford.edu/~aiken/publications/papers/pldi05.pdf
- Bessey et al. *A Few Billion Lines of Code Later.* CACM 53(2), 2010. https://cacm.acm.org/research/a-few-billion-lines-of-code-later/
- Sadowski, Aftandilian, Eagle, Miller-Cushon, Jaspan. *Lessons from Building Static Analysis Tools at Google.* CACM 61(4), 2018. https://cacm.acm.org/research/lessons-from-building-static-analysis-tools-at-google/
- Zeller, Hildebrandt. *Simplifying and Isolating Failure-Inducing Input.* IEEE TSE 28(2), 2002. https://www.st.cs.uni-saarland.de/publications/files/zeller-tse-2002.pdf
- Misherghi, Su. *HDD: Hierarchical Delta Debugging.* ICSE 2006. https://people.inf.ethz.ch/suz/publications/icse06-hdd.pdf
- McKeeman. *Differential Testing for Software.* DTJ 10(1), 1998. https://www.hpl.hp.com/hpjournal/dtj/vol10num1/vol10num1art9.pdf
- Yang, Chen, Eide, Regehr. *Finding and Understanding Bugs in C Compilers (Csmith).* PLDI 2011. https://users.cs.utah.edu/~regehr/papers/pldi11-preprint.pdf
- Le, Afshari, Su. *Compiler Validation via Equivalence Modulo Inputs.* PLDI 2014. https://web.cs.ucdavis.edu/~su/publications/emi.pdf
- Petsios, Tang, Stolfo, Keromytis, Jana. *NEZHA: Efficient Domain-Independent Differential Testing.* IEEE S&P 2017. https://arxiv.org/abs/1611.00838
- Chen et al. *Metamorphic Testing: A Review of Challenges and Opportunities.* ACM CSUR 51(1), 2018. https://dl.acm.org/doi/10.1145/3143561
- Barr, Harman, McMinn, Shahbaz, Yoo. *The Oracle Problem in Software Testing: A Survey.* IEEE TSE 41(5), 2015. https://discovery.ucl.ac.uk/id/eprint/1471263/1/06963470.pdf
- Böhme, Pham, Roychoudhury. *Coverage-based Greybox Fuzzing as Markov Chain (AFLFast).* CCS 2016. https://mboehme.github.io/paper/CCS16.pdf
- Yue et al. *EcoFuzz.* USENIX Security 2020. https://www.usenix.org/conference/usenixsecurity20/presentation/yue
- Woo, Cha, Gottlieb, Brumley. *Scheduling Black-Box Mutational Fuzzing.* CCS 2013. https://users.ece.cmu.edu/~sangkilc/papers/ccs13-woo.pdf
- Regehr, Chen, Cuoq, Eide, Ellison, Yang. *Test-Case Reduction for C Compiler Bugs (C-Reduce).* PLDI 2012. https://users.cs.utah.edu/~regehr/papers/pldi12-preprint.pdf
- Burckhardt, Kothari, Musuvathi, Nagarakatte. *A Randomized Scheduler with Probabilistic Guarantees (PCT).* ASPLOS 2010. https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/asplos277-pct.pdf
- Musuvathi, Qadeer. *Iterative Context Bounding (CHESS).* PLDI 2007. https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/pldi07-icb.pdf

---

*Sixteen adversarial reviewers · three passes · `a8d570f` · 101 actionable items. Items marked ⚙️ were reproduced by execution. Wiring and reachability claims were verified against the call graph.*
