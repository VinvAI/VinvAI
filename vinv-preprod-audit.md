# Vinv — Pre-Production Audit

**Subject:** `fix/exploration-gaps` / PR #40 @ `a8d570f` vs `main` @ `9a93dce` — 31 commits, **+29,623 / −724 across 94 files**
**Date:** 2026-07-27
**Method:** sixteen adversarial subsystem reviewers across three passes. Every defect carries a `file:line` anchor and a concrete failure scenario. Wiring and reachability claims were verified against the call graph, not inferred from commit messages. Several findings were confirmed by execution.
**Stance:** this is a pre-deployment audit of the owner's own code. The bar is not "is it clever" but **"will it hurt a user, and does it earn its place."**

---

## 0. Verdict

**Do not deploy as-is. Two defects on the live path are blockers, and one is a secret leak.**

The headline is not the new subsystems — it is that **the feature that ships today is broken in production**, and nobody caught it because it works on a toy service and fails on a real one.

Three findings dominate everything else:

1. 🔴 **The exercise pass cannot complete on any real service.** An undrained stdout pipe deadlocks the engine, guaranteeing a 180s timeout-kill on any repo big enough to matter. *Two independent reviewers found this without knowledge of each other.* One line.
2. 🔴 **Bearer tokens and PII are written into the user's repo**, contradicting the code's own "tokens are never persisted" contract — and then leaked into request URLs and server access logs.
3. 🟠 **79% of the diff (23,530 lines) is unreachable from the product**, undocumented, and exposed by no VS Code command. Shipped-path source is **2,573 lines — 9%**.

The engineering *judgment* in this PR is frequently excellent — the containment design, the fail-closed discipline, the PEP 669 coverage, the value oracle. The engineering *delivery* is not: the plumbing around the good design leaks, and the good design isn't plugged in.

**~21,400 of 29,623 lines are cut-, defer-, or shrink-able. A ~4,100-line subset (14%) delivers essentially all realized value.**

---

## 1. The shape of the problem

| | Lines | Share |
|---|---|---|
| Added by PR #40 | 29,623 | 100% |
| **Reachable from the product** (`plan→run→profile→scorecard`) | **2,573** | **9%** |
| Behind the manual `campaign`/`functions` CLI | 23,530 | 79% |
| Pure data (`semantics_corpus` snippet tuple) | 3,843 | 13% |

Verified: `exerciseRunner.ts:289-304` invokes exactly four verbs. The two `campaign` hits in `extension/src` are a **pre-rename alias for the index `sweep`** (`indexServer.ts:368,720`) — unrelated. The `'services'` hits in `autoPilot.ts:461` are a **pipeline phase label**, not `exerciser/services.py`. **No VS Code command** among the 30 in `package.json` exposes any new subsystem, and `campaign` appears in **zero tracked docs**.

This is the central fact of the audit. It means most of the risk *and* most of the value in this PR is latent — which is good news for safety and bad news for return on 29,000 lines.

---

## 2. 🔴 BLOCKERS — on the live path, shipping today

### 2.1 Undrained stdout → every exercise pass on a real repo hangs and is killed

`extension/src/harness/exerciseRunner.ts:197`

`cp.spawn(bin, args, {cwd, env})` defaults to `stdio: 'pipe'`. Only `stderr` gets a listener (`:203`); **`child.stdout` is never read, resumed, piped, or ignored.** It is the *only* spawn site in `extension/src` that does this — `indexing.ts:176`, `identification.ts:140`, `episodeLoop.ts:363`, `tracedRun.ts:152`, `rewardEngine.ts:124`, `binaryAgents.ts:69`, `harnessRunner.ts:729` all drain it.

`cli.py:53` writes the **entire** result document to stdout, pretty-printed — for `plan` that includes every endpoint's `body_schema` with `$ref`s fully inlined plus ~8 generated input records each (`plan.py:410-421`).

**Failure:** a 23-endpoint FastAPI service produces >64 KB → the OS pipe buffer fills → the engine blocks in `write()` → `exit` never fires → the 180s timer (`:205`) SIGKILLs it → the user sees `"exerciser timed out after 180s"` while `plan.json` on disk is complete and correct. Works on a 3-endpoint demo; fails on every real repo; reads as a flake.

**Fix (one line):** `stdio: ['ignore','pipe','pipe']` plus a bounded `stdout` data handler — draining is better than ignoring, because the CLI emits structured `{"status":"error"}` on stdout, which also fixes §2.3.

### 2.2 Orphaned processes — `child.kill()` instead of the codebase's own `killProcessTree`

`exerciseRunner.ts:206`

`extension/src/proc.ts:80-114` exists **specifically** because Windows `child.kill()` does not kill the process tree, and is used correctly at `harnessRunner.ts:465/943/1064/1460`, `episodeLoop.ts:482`, `rewardEngine.ts:129`. Not here. `.venv\Scripts\exerciser.exe` is a **uv trampoline** — a distinct process from the `python.exe` it launches — and `spawn` is called without `detached`, so there is no process group on POSIX either.

Because §2.1 guarantees a timeout on every real repo, this fires every time: orphaned Python keeps driving 200 probes at the user's dev server. Three passes → three orphans → the next run fails on a locked `plan.json.tmp-<pid>`.

### 2.3 `profile` / `scorecard` failures are discarded — failure reported as success

`exerciseRunner.ts:302-313`. Both `runEngine` return values are thrown away (`plan` and `run` correctly check `step.ok`; these two do not). `readExerciseJson` swallows all errors (`:44-50`) and `exerciseStateFromArtifacts` coalesces null to zeros (`:93-96`).

**Failure:** `profile` crashes → line 306 reads the **previous** run's `profile.json` → the pass returns `outcome:'done'` with last-run's coverage and invariant counts. A crashed profile is indistinguishable from a clean run: green **"done — 0/0 endpoints · 0 invariants."** This silently defeats `cli.py:56-58`'s explicit "diagnostics must be LOUD" contract.

### 2.4 No cancellation, no teardown on deactivate

`runExercisePass` (`:226`) accepts no `CancellationToken`; caller `autoPilot.ts:377` passes none; `extension.ts:236-239` `deactivate()` only stops the embedder. Close the window mid-`run` and the engine keeps driving the service with no parent and no UI. Task Manager is the only recourse.

### 2.5 Session-long wedge from an unguarded `spawn`

`harnessRunner.ts:1051-1058`. `running = true` at `:1051`, then an **unguarded** `spawn` at `:1054`; `running` is reset only in `settle()` (`:1274`). A synchronous throw (bad `cwd`, EMFILE, disconnected network drive — all reachable on Windows) leaves `isHarnessBusy()` permanently true and every later episode returns *"another harness run is already in progress."* The sibling `dispatchAgentPrompt` guards the identical call at `:887-896`.

### 2.6 Unbounded output accumulation → extension-host OOM

`harnessRunner.ts:1243` — `out += chunk` with no cap, fed by both stdout and stderr (`:1260-1263`). Siblings bound it explicitly (`dispatchAgentPrompt` `.slice(-400_000)` at `:931`, `episodeLoop.ts:359`, `rewardEngine.ts:121`). A long `--verbose stream-json` run produces hundreds of MB in one V8 string.

---

## 3. 🔴 SECURITY — secrets written to disk and leaked into URLs

`run.py:837`, `state.py:79`, `store.py:118`, `run.py:634`

`_execution_row` persists `result.body` verbatim for any dict/list response. `POST /api/v1/login/access-token` is an ordinary plan endpoint, so a 200 writes `{"access_token":"eyJhbGciOi…"}` into **`.vinv/exercise/results.jsonl`**. `state.record_creations` then harvests `scalar_values(ex["body"])` — including the JWT — into `response_values` and writes it to **`.vinv/exercise/state_ledger.jsonl`**. Password hashes, emails, and any 2xx body content land there too. `.vinv/` sits inside the user's repo and is a commit away from a public push.

This directly contradicts the code's own contract at `run.py:492` ("tokens are never persisted"), `run.py:614`, and `regress.py:68`.

**Knock-on leak:** `_auth_sweep:634` substitutes those harvested scalars into **path params** — issuing `DELETE /users/eyJhbGciOi…`, putting the bearer token into request URLs and therefore into the server's access logs and any proxy in between.

**Fix:** redact bodies before persistence (the shape hash + value digest already exist for exactly this purpose); restrict harvesting to id-shaped fields; never place harvested scalars into path params without a type/length filter.

---

## 4. 🟠 False-positive generators on the live path

Each of these dispatches a bogus fix episode at `exerciseRunner.ts:334`. Precision is the product; these are reputation damage.

| # | Defect | Anchor | Why it fires |
|---|---|---|---|
| 4.1 | `size_relation` enforced with `input_size` **always 3** | `regress.py:193` | `case["input"]` is always `{body,path_params,query}`; the invariant was *learned* with `run._input_size` semantics (`run.py:943`). Fires on **every replay of every endpoint** that ever learned it |
| 4.2 | probeId ignores **which credentials** produced the response | `run.py:967` | N credential sets collapse into one probeId, last-writer-wins. Superuser 200 + user 403 → phantom `baseline-degraded` |
| 4.3 | Every authed case replayed with `fresh_auth[0]` | `regress.py:168` | A superuser-only endpoint recorded 200 replays as the normal user → 403 → reported as a regression on unchanged code |
| 4.4 | State-drift filter **suppresses real regressions** (inverse FP) | `regress.py:216` | Generators are deterministic, so replayed values always intersect `planted` → genuine `behavior` diffs relabeled `environment`. Silences essentially every behavior diff on every mutating endpoint |
| 4.5 | `NaN`/`Inf` poisons `numeric_bound` | `invariants.py:151,263` | `min([1.0,nan])` order-dependent; `nan<=v<=nan` always False → every later response flagged forever; `json.dumps` writes a bare `NaN` token corrupting the store |
| 4.6 | `ENFORCE_MIN_CONFIDENCE` is **dead code** | `invariants.py:41` | Learned invariants always score ≥0.857 at `MIN_SUPPORT=5`; the gate cannot reject anything. The advertised precision control does nothing |
| 4.7 | Mistyped `params` crashes the whole run | `store.py:69`, `run.py:846` | `"5" <= 5` → unguarded `TypeError` aborts the exercise |
| 4.8 | `-0.0` vs `0.0`, NFC vs NFD → false `value-degraded` | `execute.py:97` | Representation-sensitive digest |
| 4.9 | Auth-sweep rows labeled `round 0` but appended last → `id_monotonic` sees non-chronological order | `run.py:384` | Phantom `invariant-violation` |

**Plus two correctness defects that silently blind the oracles:**

- **`run` and `regress` compute different probeIds into the same store.** `run.py:967` hashes a 3-tuple; `regress.py:50` a 4-tuple. They never collide, so **regress never compares against the goldens `run` earned** — it seeds a second, disjoint id space where every observation is `"recorded"` and `degraded == 0`.
- **`baselines/<api_id>.json` grows without bound.** `_auth_sweep` builds path-params from ledger ids that change every run → new probeIds every run → entries accumulate, each recorded and never re-compared. No cap, no TTL, no eviction.

---

## 5. 🟠 Coverage gaps that make endpoints permanently unreachable

These are why real-world coverage will look inexplicably poor.

- **Content type is discovered then thrown away** (`openapi.py:122`, `plan.py`). `_body_schema_of` accepts `application/x-www-form-urlencoded`, but `Endpoint` has no content-type field and nothing threads it to `execute_probe` — which *does* support `content_type='form'` (`execute.py:150`). FastAPI's OAuth2 password flow (`POST /login/access-token`) therefore gets JSON forever → 422 forever → 0% coverage, and no issue cluster because it never 5xxs.
- **Spec-level `security` ignored** (`openapi.py:147`). `_op_requires_auth` inspects only `operation["security"]`. A document declaring root-level `security: [{"bearerAuth": []}]` — the standard way to protect an entire API — yields `requires_auth=False` for every operation, so no auth permutation, no semantic prompt, no login chain is ever authored. Every endpoint 401s at 0% coverage with no diagnostic.
- **`api_id` collisions fire one endpoint's inputs at another's path** (`openapi.py:187`, `run.py:227`). `_path_suffix` keeps two segments with params normalized, so `/users/{id}/items/{item_id}` and `/teams/{id}/items/{item_id}` share a key → `grouped_by_ep` overwrite → the second endpoint is never exercised and never appears in `profile.json`, silently.
- **The `observed` bandit arm sends handler kwargs as the HTTP body** (`plan.py:238`). `_observed_examples` mines `args_summary` — the handler's *Python* parameters (`session`, `db`, `current_user`) — and posts them as the request body. Guaranteed 422 on FastAPI, so the arm permanently scores 0.
- **`_expire_semantic_reply` writes to an unsanitized filename** (`run.py:740`). `plan.py:360` writes `_safe(api_id).json`; the expiry uses the raw id → stamps a different file → a dead scenario is replayed forever and never re-authored.

---

## 6. 🟠 Structure & reusability — the owner's instinct, quantified

**~971 lines are removable with zero behaviour change.** The root cause is a missing contract, not excess ambition.

### 6.1 There is no `Oracle` abstraction, so six oracles re-derived everything

| Duplicated concept | Copies | Lines | Should be |
|---|---|---|---|
| Subprocess worker protocol (spawn+env+timeout+JSON-line parse) | **5** | ~230 | one `_worker.run_worker()` |
| `main()` `--worker` dispatch | **5** | ~55 | one `worker_entrypoint()` |
| Worker preamble (argparse, plan load, `sys.path`) | **5** | ~65 | shared |
| `_emit` | **4 byte-identical** | 16 | one 3-line fn |
| `cluster_*` construction | **5** | ~214 | one `issues.build_clusters()` |
| `_summarize` | **2 verbatim** | 30 | shared |
| `_resolve(target)` | **3** | — | shared |
| `sandbox._worker_main` forked from `functions._worker_main` | — | ~90 | one `drive_module()` |

The clone detector found character-identical 5-way matches; the `PYTHONPATH` join is byte-identical in four files. **Operational consequence:** a fix to worker timeout handling must land in five files, and four will be missed — which is precisely why the emit-once data-loss bug exists in `differential` alone.

### 6.2 `campaign.py` is 212 lines of compensation for six APIs that were never agreed on

The tell: `_findings(result, count_key, …)` (`campaign.py:355`) has a `count_key` parameter that exists **only** because `differential` named its total `mismatch_clusters` while everyone else used `issue_clusters`. Rename one dict key and the parameter disappears. `enumerate_actions` (`:158-313`) is 156 lines of six copy-pasted try/except arms. `OracleConfig` is a union of six unrelated knob sets plus two private mutable caches.

Divergent signatures for the same concept: timeout is spelled `module_timeout_s` / `timeout_s` / `call_timeout_s` + `worker_timeout_s`; target selection is `--only-target` / `--target` (required in one oracle, optional elsewhere) / `--auto-target` / `--signature-target`; `run_environment` alone lacks `python=`, so `campaign` silently cannot honour `--python`.

Also: `FailureCluster` still carries HTTP vocabulary (`endpoint_id`/`method`/`path`), so five non-HTTP oracles set `endpoint_id = path = target` and invent fake methods (`"CALL"`, `"FAULT"`, `"CONC"`, `"DIFF"`, `"ENV"`). The type never grew a `target` field; the oracles just lie in the HTTP fields.

### 6.3 God modules

- **`functions.py` — 2,812 lines, five unrelated responsibilities**: name vocabulary (~400), a **1,400-line AST purity analyser** (a self-contained program with no oracle knowledge), argument generation (~150), worker (~170), driver (`run_functions` is a single **306-line function**). Section banners already mark the seams — a low-risk split. Damage today: `concurrency`, `differential`, and `faults` all import the 24-line `detect_src_roots` helper and thereby drag in the entire purity analyser.
- **`sandbox.py` — 1,709 lines, of which 310 are a different program inside a string.** `_SITECUSTOMIZE_SOURCE` (`:456-765`) is 310 lines of real Python — `_Ledger`, `_guard_write`, `_sandbox_open`, path wrappers — that is **not linted, not type-checked, not covered, and not unit-testable**. Move to `_shim_template.py` as package data.
- **`run_sandboxed_targets`** is a single 257-line function.

### 6.4 Cycles and boundary violations

- **`functions ↔ sandbox`** — worked around with `TYPE_CHECKING` plus a runtime `from . import functions as fn`; both files carry `# avoids an import cycle` comments. The cycle was *noticed and papered over*, not fixed.
- **`run ↔ regress`** — three private helpers crossing in both directions.
- **8 private-symbol reaches across module boundaries** (`fn._emit` ×3, `fn._param_records`, `fn._call_once`, `run._resolved_auth_headers`, `run._split_endpoint`, `regress._fresh_auth_headers`).
- `sandbox.py:170` documents `functions._IMPURE_MODULE_ROOTS` as its source of truth but **does not import it** — kept in sync by comment. It will drift.

### 6.5 Dead code

- **`differential.py:158-194` is unreachable** — `_ubiquity`, `_UBIQUITY_CAP`, `_discriminative_constructs`, `_names_word` are each defined **twice** (0.951 similarity); `_UBIQUITY` binds the second. Plus a 13-line orphaned comment banner at `:322-334`. **~50 lines.**
- **`campaign._accepts`** feature-detects a keyword argument on a sibling function *in the same package* that unconditionally declares it → `per_target` is always True → the entire `else` branch, `_functions_cache`, and `_accepts` itself are dead. **~26 lines.** This is defensive programming against yourself.
- `IMPLEMENTATION_DEFINED` + `EXCLUDED_UNSAFE` — **~200 lines** of "21 tests we decided not to write," exported and asserted upon.
- ~273 lines referenced only by tests, incl. `optimize.decide_optimization` + `paired_bootstrap_improvement` + episode ledger (132 lines) — machinery built ahead of a consumer that never arrived.

---

## 7. Value per subsystem — what earns its place

| Subsystem | Lines | What it finds | How often it matters | Verdict |
|---|---|---|---|---|
| **Route discovery** | 857 | Declarative `Route(...)` lists, router prefixes | **Every run** — fixes the actual root cause | **KEEP** |
| **Value oracle** (baseline+invariants+issues+execute) | ~280 | Silent wrong-value regressions | **Every run** — closes gap G2 | **KEEP** (fix §4.5–4.8) |
| **Branch coverage** (PEP 669) | ~420 | The exploration reward signal | **Every run** | **KEEP** (3 fixes) |
| **Child-process tracing** | 434 | Makes `uvicorn --workers` visible at all | **Every multi-process app** | **KEEP** |
| **Reward signals** | ~630 | Why a run was `unavailable` | Every episode | **KEEP** |
| **functions harness** | 4,233 | `None`-guard gaps, `NameError` on cold paths | Real ceiling-raiser (8→147 targets), but generator is 9 types × 3 values, **`None` for 7 of 9** hostile | **SHRINK → ~800** |
| **exception_policy** | 1,650 | Nothing — suppresses the harness's *own* noise | Learning is **dead** in the product | **SHRINK → ~120** |
| **sandbox** | 2,676 | Nothing — makes impure targets callable | 17 `skipif(win32)` → **~zero executed Windows coverage** | **SHRINK** to shim+tree |
| **containment** | 1,187 | Nothing — tier selection | `_candidates()` returns `[]` on win32 — **dead code on your platform** | **DEFER** |
| **service_doubles + services** | 3,346 | Nothing — in-jail fakes | Has a **suppression bug that swallows the canonical data-layer bug class** | **DEFER** |
| **faults** | 1,257 | Shape faults + chunk-boundary sweep | `--auto-target` finds **zero by construction** | **SHRINK** to the sweep |
| **concurrency** | 647 | GIL-yielding races only | No schedule control despite the docstring; campaign calls `fn()` with **no args** | **CUT** |
| **environment** | 613 | Signature drift + `uv lock` | Varies **no** Python version/locale/TZ; findings never clustered | **CUT** |
| **semantics_corpus** | 4,141 | Interpreter divergence in a Python-code evaluator | **~1–2% of repos** | **CUT / extract** |
| **differential** | 1,668 | Same — needs an `exec`/`eval` target | Degrades cleanly, but 5,809 lines idle | **CUT / extract** |
| **campaign + ActionBandit** | 1,834 | Nothing — dispatcher | ~400 arms / **20-play budget**; corrupts exception_policy | **DEFER** |
| **agent_loop** | 396 | Nothing — question queue | **Write-only**: nothing reads `agent_*.json` back | **DEFER** |

### 7.1 Defects verified by execution

1. **`Optional[str]` loses 3 of its 4 faults.** `typing.Optional[str].__name__ == 'Optional'`, so `catalogue_faults({'x':'Optional'})` returns **1** fault vs **4** for `'str | None'`. The string faults the module exists for never fire for any `Optional[...]` parameter.
2. **`campaign._concurrency_runner` passes no kwargs** (`campaign.py:523`) → every target is called `fn()` → any function with required params raises `TypeError` in both batches → silent pass.
3. **The campaign destroys the exception policy.** `run_functions` does `ExceptionPolicy.load(repo)` with `decay=0.5` then saves, **per play** (`functions.py:2728`). Twenty crash plays scale every human adjudication by ~1e-6 — it forgets everything within a single run.
4. **HTTP arms are fiction.** `run_exercise` (`run.py:100`) takes no endpoint or technique parameter, so 150 of ~400 arms are identical full sweeps and `by_technique` is meaningless.
5. **Service doubles swallow the canonical data-layer bug.** `sandbox.py:1062` marks any exception whose `__module__` is `exerciser.service_doubles` as `contained` — but `IntegrityError`/`OperationalError`/`ProgrammingError` are **defined in that file** (`:948-964`) and `:849` deliberately raises them as "the database answering." **Every unique / NOT NULL / check-constraint violation is silently suppressed.**
6. **`faults --auto-target` cannot find anything.** It sets `baseline={}`, so every call is missing required params → `TypeError` → in `_TYPED_REJECTIONS` → classified as correct handling.
7. **`asyncpg`/`clickhouse_driver` are in a synchronous PEP-249 menu** they don't conform to (`service_doubles.py:1577`) → `await` raises a repo-frame `TypeError` → eligible to be reported as a repo defect.

### 7.2 On the 4,141-line corpus

Its own docstring names its targets: smolagents' `LocalPythonExecutor`, RustPython, Skulpt, Brython, PyPy. `propose_references` only arms targets that call `exec`/`eval`. Realistic hit rate: **1–2% of repos**. For the other 98% it prints `"0 differential references"` and exits — to its credit, it fails *cleanly*. But that is 5,809 lines of dormant weight in every install to serve one case-study repo. It is also 3,843 lines of **data**, which should not count against "the code is too big" — the problem is shipping it in core, not its size.

**Extract to an optional `vinv-differential` package.**

---

## 8. Operational risks (latent until `functions`/`--sandbox` is exposed)

| Sev | Finding | Anchor |
|---|---|---|
| **BLOCKER** | **Sandbox temp tree leaks up to 256 MB per run and the report claims it was removed.** Three paths: (a) non-`OSError` escape — `plan_services()`/`answered_fixtures()` run *after* the copy and an `AttributeError` on a drifted fixture file orphans the tree; (b) **zero `atexit`/`signal` handlers in the package**, so SIGTERM/`taskkill`/deactivate skip `finally`; (c) `shutil.copy2` preserves the read-only attribute so `rmtree(ignore_errors=True)` silently fails — and `:1396` unconditionally writes `root_removed: True` | `sandbox.py:336,872,1394` |
| **BLOCKER** | **cp1252 on all six worker pipes.** Bare `text=True`, no `encoding=`; `sandbox_env` never sets `PYTHONIOENCODING`. A target printing an emoji kills the worker; raw UTF-8 bytes (`0x81/0x8D/0x8F/0x90/0x9D` undefined in cp1252) raise `UnicodeDecodeError` **inside `subprocess.run`**, uncaught → kills the entire run | all 6 spawn sites |
| HIGH | **Workers batch all output to the end** — a module with 50 targets where #49 hangs loses all 48 completed results | `sandbox.py:1694` |
| HIGH | **Worker stderr captured and discarded**; the one guard tests the *global* `rows` list so it never fires after the first module, and is `log.debug` regardless | `functions.py:2671` |
| HIGH | **`snapshot_tree` calls `Path.resolve()` per file entry**, twice per module — on Windows that's an open+query+close each. 20k files × 40 modules = 1.6M resolves | `sandbox.py:1108` |
| HIGH | **`honour_gitignore=True` removes real source from the copy** → import failures that are artifacts of the copy, reported as the repo's defects. The `DEFAULT_EXCLUDES` docstring argues *against* exactly this for `build`/`dist`, then does it via `.gitignore` | `sandbox.py:244` |
| HIGH | **Windows spawn holes:** `os.startfile` not blocked; `multiprocessing` spawns via `_winapi.CreateProcess`, bypassing the `Popen` patch. Combined with no rlimits on Windows, containment reduces to tree+env redirection | `sandbox.py:698` |
| MED | **The shim fails OPEN and its fail-closed guard is dead code:** `os.path.realpath("")` returns **cwd**, never `""` — so `if not _ROOT: return False` is unreachable and an unset env var makes cwd the sandbox root | `sandbox.py:480,535` |
| MED | **Corrupt `.vinv` artifact is fatal, not degraded** — `ExceptionPolicy.load` runs *after* all subprocess work but *before* `write_jsonl`, so a drifted policy file discards an entire completed run | `exception_policy.py:771` |
| MED | **Ctrl-C loses everything** — `_call_once` catches `BaseException` so the worker swallows KeyboardInterrupt and keeps calling targets; the parent has no `finally` around artifact writes | `functions.py:2216,2736` |
| MED | **Campaign has no wall-clock deadline**; compounds with Ctrl-C loss into "the only way to stop it destroys the results" | `campaign.py:713` |
| MED | Windows junctions aren't symlinks → `copy_repo` and `services.rglob` recurse into them (uv creates junctions — see the repo's own memory note) | `sandbox.py:407` |
| MED | `%APPDATA%`/`%LOCALAPPDATA%`/`HOMEDRIVE`/`HOMEPATH` not redirected — `platformdirs`, pip cache, HF cache write to the real AppData | `sandbox.py:911` |
| MED | `issues.json` shape is an unchecked `as T` cast; an older-format file throws and flips the whole pass to `'failed'`, discarding the profile just computed | `exerciseRunner.ts:306` |
| MED | Spawned without `windowsHide` → four console flashes stealing focus per Auto-Pilot cycle, despite `proc.ts:62` documenting exactly why `hiddenBackgroundOptions` exists | `exerciseRunner.ts:197` |
| MED | `recordedTracePath` misses `serviceSlug()` → a service named `api server` → ENOENT → the anti-reward-hacking tamper guard **silently disables** and a port-squatter passes as `objective: true` | `episodeLoop.ts:270` |
| MED | `VINV_EXERCISE_TIMEOUT_S` is load-bearing, undocumented, and **under-budgeted**: 200 probes × 3 rounds × 0.8s settle ≈ 160s of settle alone against a 180s cap | `exerciseRunner.ts:176` |
| LOW | `.tmp-<pid>` litter never swept; `--sandbox-keep-root` orphans a tree per run (self-documented, unfixed); `environment.py:244` does real PyPI egress without `--offline`; `compaction` drops `cleaned` rows so the scorecard's pollution numbers silently reset | various |

### 8.1 Verified correct — do not "fix" these

Reviewers actively tried to break these and could not. Recorded so the fix pass doesn't churn them:

- **No import-time side effects** anywhere (AST-scanned); `semantics_corpus` is pure string literals, nothing parsed at import.
- The two `except Exception: pass` in `semantics_corpus.py` are **inside string literals** — corpus snippets, not code.
- **No shell injection** — all spawns use argv arrays with `shell:false`; paths with spaces are safe.
- `_inside_root` case-sensitivity is a **non-issue** — Windows `realpath` normalizes case even for a non-existent leaf.
- **Artifact writes are atomic** (tmp + `os.replace`) — torn reads are not a concern; only schema drift is.
- The repo is copied **once per run, not per module**; `campaign` caches `run_functions` across plays.
- Throughput sweep is bounded (`_MAX_REQUESTS=500`, `_MAX_CONCURRENCY=32`).
- **The fail-closed discipline is real** where it counts: the worker refuses to import if the shim didn't load; `require_tier` genuinely refuses rather than downgrading; `--no-sandbox` leaves targets refused rather than running them loose.
- On Linux/macOS, containment **probes before trusting** — it runs a child that attempts to escape and checks the real filesystem, rejecting any mechanism that doesn't actually block. This is the correct design.

---

## 9. What to do — sequenced

### Stage 1 — before this touches a user's machine (~1 day)

1. **Drain `child.stdout`** (§2.1). One line. Without it the feature does not work on any real repo.
2. **`killProcessTree` + `CancellationToken` + `deactivate()` teardown** (§2.2, §2.4).
3. **Check `profile`/`scorecard` results; surface diagnostics** (§2.3).
4. **Redact secrets before persistence; stop putting harvested scalars in path params** (§3).
5. **Guard the `spawn` at `harnessRunner.ts:1054`; bound `out`** (§2.5, §2.6).

### Stage 2 — precision, before anyone trusts a finding (~2 days)

6. Fix the live-path FP generators: §4.1 `size_relation`, §4.2/§4.3 credential-aware probeIds, §4.4 the drift filter that silences real regressions, §4.5 NaN, §4.6 the dead confidence gate (replace with a real statistical justification test), §4.7 the params guard, §4.8 digest normalization.
7. Unify the probeId in one `store.probe_id()` helper used by `run` and `regress` (§4, correctness).
8. Fix the coverage-blocking gaps: content-type threading, spec-level `security`, `api_id` collisions (§5).

### Stage 3 — shrink to what earns its place (~3 days, zero behaviour change)

9. Delete confirmed dead code (§6.5) — **~350 lines**, zero risk, half a day.
10. Extract `exerciser/_worker.py` — **−250 lines**. This is the abstraction whose absence caused the rest.
11. `issues.build_clusters()` + give `FailureCluster` a real `target` field — **−130 lines**.
12. Define the `Oracle` protocol; rename `mismatch_clusters` → `issue_clusters`; unify `run_*` signatures — **−170 lines**, and `campaign.py`'s adapters collapse to a dispatch table.
13. Move `_SITECUSTOMIZE_SOURCE` to `_shim_template.py` so 310 lines become lintable and testable.
14. Split `functions.py` at its existing banners; move `detect_src_roots` to `store.py`.

### Stage 4 — decide what ships

**Ship the ~4,100-line subset** that is already on the product path and delivers essentially all realized value: route discovery, the value oracle, PEP 669 branch coverage, child-process tracing, reward-failure diagnosis. Three fixes first: the `id(code)` cache holds no reference (address reuse → wrong line numbers + unbounded growth); `branch_ids_for_endpoint` does a full `trace.jsonl` scan **per endpoint per round** (quadratic on the live path); unattributed arms are credited to every endpoint.

**Then wire `functions` into the extension pipeline as the next PR** — a ~50-line change to `exerciseRunner.ts`, worth more than the other 23,000 lines combined.

**Extract** `differential` + `semantics_corpus` to an optional package. **Defer** `campaign`, `containment`'s OS ladder, `service_doubles`, `agent_loop`. **Cut** `concurrency` and `environment`. Let real findings decide whether they earn their way back.

---

## 10. The two structural lessons

**1. `exception_policy` exists to suppress `functions.py`'s own crudeness.** Its `conformant` feature is explicitly about "passing `None` to a `str` parameter is the harness deliberately violating the contract" — 1,038 lines of Bayesian machinery to filter noise a better generator would never emit. Fix the generator (§7, `None` for 7 of 9 hostile types) and most of the policy becomes unnecessary. Its learning half is dead in the product anyway, while its entropy-seeded Thompson draw makes output **non-reproducible between runs**.

**2. Everything hard is gated behind an orchestrator nobody calls.** The genuinely valuable insight of this PR — reaching bugs that live in *functions*, not routes — is real and correct. But it was built as a research platform (RL bandit, OS jails, service virtualization, interpreter differential testing) instead of the one thing that would deliver it: teaching the extension to call `functions` after `run`.

This is the answer to "does it add value." The *ideas* are largely right and several are genuinely SOTA-grade. The *delivery* inverted the priority: 29,000 lines of capability behind a door, while the door stayed shut and the room that is open has a hole in the floor.

---

## Appendix — precision doctrine (unchanged, still the governing principle)

Developers decide a tool's false-positive rate with their attention. Google's Tricorder found analyzers exceeding **~10% effective false positives get dismissed or disabled**, and holds its platform below 5% [Sadowski et al. 2018]. Coverity reached the same conclusion: past a noise threshold users blacklist the tool and ignore even its true reports [Bessey et al. 2010].

The resolution is **grade, don't suppress**: reproduce before report → model nondeterminism first → prove attribution (target code, not harness or environment) → corroborate low-precision detectors → rank by trustworthiness [Kremenek & Engler 2003; Engler et al. 2001; Liblit et al. 2005] → minimize the repro [Zeller & Hildebrandt 2002; Misherghi & Su 2006] → close the loop so dismissals down-weight noisy detectors.

For invariants specifically, replace the inert confidence gate with Daikon's **statistical justification test** — the probability the invariant holds by chance must fall below a threshold, which requires a minimum sample count [Ernst et al. 2001] — paired with DIDUCE's discipline of starting strict and relaxing as observations accumulate, scoring a violation by how *warm* the invariant was [Hangal & Lam 2002].

**References** (verified against DBLP + publisher/author PDF):
- Ernst, Cockrell, Griswold, Notkin. *Dynamically Discovering Likely Program Invariants to Support Program Evolution.* IEEE TSE 27(2), 2001. https://homes.cs.washington.edu/~mernst/pubs/invariants-tse2001.pdf
- Hangal, Lam. *Tracking Down Software Bugs Using Automatic Anomaly Detection.* ICSE 2002. https://suif.stanford.edu/papers/Diduce.pdf
- Engler, Chen, Hallem, Chou, Chelf. *Bugs as Deviant Behavior.* SOSP 2001. https://dl.acm.org/doi/10.1145/502034.502041
- Kremenek, Engler. *Z-Ranking.* SAS 2003. https://web.stanford.edu/~engler/z-ranking.pdf
- Liblit, Naik, Zheng, Aiken, Jordan. *Scalable Statistical Bug Isolation.* PLDI 2005. https://theory.stanford.edu/~aiken/publications/papers/pldi05.pdf
- Bessey et al. *A Few Billion Lines of Code Later.* CACM 53(2), 2010. https://cacm.acm.org/research/a-few-billion-lines-of-code-later/
- Sadowski, Aftandilian, Eagle, Miller-Cushon, Jaspan. *Lessons from Building Static Analysis Tools at Google.* CACM 61(4), 2018. https://cacm.acm.org/research/lessons-from-building-static-analysis-tools-at-google/
- Zeller, Hildebrandt. *Simplifying and Isolating Failure-Inducing Input.* IEEE TSE 28(2), 2002. https://www.st.cs.uni-saarland.de/publications/files/zeller-tse-2002.pdf
- Misherghi, Su. *HDD: Hierarchical Delta Debugging.* ICSE 2006. https://people.inf.ethz.ch/suz/publications/icse06-hdd.pdf
- McKeeman. *Differential Testing for Software.* DTJ 10(1), 1998. https://www.hpl.hp.com/hpjournal/dtj/vol10num1/vol10num1art9.pdf
- Yang, Chen, Eide, Regehr. *Finding and Understanding Bugs in C Compilers.* PLDI 2011. https://users.cs.utah.edu/~regehr/papers/pldi11-preprint.pdf
- Böhme, Pham, Roychoudhury. *Coverage-based Greybox Fuzzing as Markov Chain.* CCS 2016. https://mboehme.github.io/paper/CCS16.pdf
- Burckhardt, Kothari, Musuvathi, Nagarakatte. *A Randomized Scheduler with Probabilistic Guarantees of Finding Bugs (PCT).* ASPLOS 2010. https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/asplos277-pct.pdf
- Barr, Harman, McMinn, Shahbaz, Yoo. *The Oracle Problem in Software Testing: A Survey.* IEEE TSE 41(5), 2015. https://discovery.ucl.ac.uk/id/eprint/1471263/1/06963470.pdf

---

*Sixteen adversarial reviewers, three passes, `a8d570f`. Findings marked "verified by execution" were reproduced by running the code. The full earlier PR review — including the differential/RL/multi-language analysis — remains in `vinv-exploration-gaps-review.md`.*
