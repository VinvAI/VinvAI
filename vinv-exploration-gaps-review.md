# Full Engineering Audit — `fix/exploration-gaps` / PR #40

**Reviewer stance:** adversarial, senior-IC. The goal is not to pass this branch; it is to hold Vinv to the standard where a competent outsider reading the code concludes *"this is how you build an autonomous bug-finder."* Everything below is written to that bar.

**Scope:** PR #40, branch `fix/exploration-gaps` @ `a8d570f`, diffed against `main` @ `9a93dce`. **31 commits, +29,623 / −724 across 94 files.** Reviewed in two adversarial passes across fifteen subsystems: route discovery, function harness, oracle wiring, differential oracle, sandbox, OS-layer containment, service doubles, fault injection, exception policy, branch coverage, environment matrix, concurrency, child-process tracing, RL/campaign orchestration, and the TypeScript harness.

**Audit method.** Twelve subsystem reviewers on the original 28-commit branch (`a4c8217`), then three reviewers on the three follow-up commits (`f4f3a15`, `ad96cc0`, `a8d570f`) that were pushed in response to the first pass. Every implementation defect carries a `file:line` anchor and a concrete failure scenario; every prescribed solution carries a citation verified against DBLP and the publisher/author PDF. Claims about wiring and reachability were verified directly against the call graph, not inferred from commit messages.

**Sections §0–§8 and Appendix A/B cover the branch as reviewed at `a4c8217`. §9 is the re-audit of the three follow-up commits (the current PR head `a8d570f`) and is the most important section if you are deciding whether to merge PR #40 today.**

---

## 0. Verdict

The branch implements the *entire* `vinv-gap-analysis.md` roadmap in one pass. The module-level engineering is, in most places, genuinely good: honest docstrings, real statistics where there is statistics, and — importantly — several designs the reviewers actively tried and failed to break. But three classes of problem stand between this branch and the standard it aims for:

1. **The marquee capability is not connected to the product.** The autonomous loop still runs the old HTTP-only pipeline; everything new is reachable only from a manual CLI. The gap analysis's own thesis — *"Vinv observes but does not explore"* — remains true in production after this branch.
2. **The half that *is* live ships false-positive generators.** The one new capability that reaches users (invariant enforcement) fires on thin evidence, with a confidence gate that is mathematically incapable of filtering anything. For a tool whose entire value rests on trust, this is the most dangerous category.
3. **Recurring "happy-path-only" craft.** Across every subsystem the same shape repeats: the common case is correct and the edges leak, swallow, or invert *silently*, with a green test suite on top because the tests exercise the same happy path the code was written against.

None of this is unfixable. Most fixes are individually cheap. But the branch should not be trusted against unfamiliar code until Section 2's live-path defects and Section 5's precision doctrine are in place.

**Update after the follow-up commits (PR #40, §9).** The three commits pushed in response to the first review confirm the pattern rather than break it. They added **7,794 lines** of new subsystems (OS containment, service doubles, a hardened purity guard) — and did **not** wire the extension, did **not** fix a single live-path false positive, left the one safety hole that runs destructive code in-process **still open**, introduced a **Windows containment regression**, and added **three new false-positive surfaces**. The correct response to the first review was on the order of **twenty lines**. This is the central lesson of the whole audit, and it is exactly the over-engineering failure mode: *answer a review by adding surface, not by fixing defects and connecting what exists.*

This document catalogues every issue, and for each names the **proven algorithm** that solves it, with a verified citation. The citations are not decoration — they are the difference between reinventing a noisy heuristic and adopting a technique the field already proved.

---

## 1. The central architectural failure: the exploration engine is dead surface

**Issue.** The autonomous extension harness — the only thing that runs in production and files findings — invokes exactly four exerciser subcommands:

```
exerciseRunner.ts:289-304  →  plan → run → profile → scorecard
```

It **never** invokes `campaign`. `run_campaign` is called from exactly one place: the manual `cli.py:430` subcommand. Therefore the function harness (`functions.py`, 2,108 lines), the differential oracle (`differential.py` + a 4,141-line corpus), fault injection, the environment matrix, concurrency oracles, the sandbox, the agent-in-the-loop channel, and the enriched `(target × technique × oracle)` action space are **all unreachable from the product**. `campaign.py`'s own docstring concedes the enriched bandit *"was defined and advertised but never constructed outside its own unit test."* This branch builds the constructor and does not wire it to the one caller that runs.

**Why it matters.** ~15,000 of the ~22,000 new lines are, from the product's perspective, dead. A reviewer cannot distinguish "built and integrated" from "built and shelved" by reading the changelog; they must trace the call graph. That the branch passes CI while shipping its headline feature disconnected is itself an indictment of the test strategy (Section 6).

**What actually reaches production:** route discovery (feeds `plan`), invariant/value-digest oracle wiring (in `run`), the violations-over-coverage reward *objective* (in `run.py`'s `EndpointBandit`), branch coverage (into the *inner* bandit only), and child-process tracing (in tracelens). Roughly two and a half of five roadmap gaps.

**Solution.** This is not an algorithm problem; it is a discipline problem. **Definition of Done for a capability = reachable from the autonomous loop + an end-to-end test that spawns the real process and asserts a real finding.** Point `exerciseRunner` at `campaign`, or land the roadmap incrementally, but never merge a headline capability that the product cannot invoke.

---

## 2. Live-path defects — these bite users *today*

These are on the shipping path and require no `campaign` wiring to manifest. They are the priority.

### 2.1 `NaN`/`Infinity` poisons `numeric_bound` — permanent false-positive storm

**Issue.** `invariants.py:151` learns `lo, hi = min(nums), max(nums)`; `json.loads` accepts the non-standard `NaN`/`Infinity` tokens by default. Three failures compound: (a) `min([1.0, nan])` is **order-dependent**, so the learned bound is non-deterministic — directly violating the module's own "deterministic, order-stable" guarantee; (b) enforcement `not (nan <= v <= nan)` is `True` for *every* value, so once a field is ever `NaN` in ≥5 healthy responses, **every subsequent response is flagged forever**; (c) `json.dumps({"min": nan})` writes a bare `NaN` token, corrupting `invariants.json` for strict parsers.

**Fix.** `nums = [v for v in nums if math.isfinite(v)]`; skip the invariant if empty; dump with `allow_nan=False` so poisoning fails loudly rather than silently.

### 2.2 A well-formed but mistyped `params` entry crashes the whole run

**Issue.** `store.read_invariants_by_endpoint` (`store.py:69`) validates only that `endpoint` is a `str`. A doc with `"params": {"min": "5"}` reaches `invariants.py:263` `lo <= v <= hi` → `TypeError: '<=' not supported between 'str' and 'int'`. `_enforce_invariants` (`run.py:846`) has no `try/except`, so one drifted or hand-edited invariant aborts the entire exercise run.

**Fix.** Type-guard params in the reader (drop invariants whose bounds aren't numeric); defensively wrap enforcement and log-and-continue.

### 2.3 The confidence gate is dead code — the advertised precision control does nothing

**Issue.** `invariants.py:41 ENFORCE_MIN_CONFIDENCE = 0.8`, but every learned invariant scores `confidence = (n+1)/(n+2) ≥ 6/7 ≈ 0.857` at the `MIN_SUPPORT = 5` floor. The gate can therefore *never* reject a learned invariant; it only rejects hand-forged low-confidence dicts (exactly, and only, what the unit test feeds it). The docstring's claim that enforcement "demands more evidence so a barely-witnessed invariant cannot mint false failures" is false. Support-of-5 is the only real threshold — and it is far too thin for `numeric_bound` and `stable_enum`, the two most overfitting-prone templates, which are enforced as **hard oracle failures**.

**Solution — this is a solved problem; use the proven statistic.** Daikon does not trust an invariant because it was never violated; it computes the **probability the invariant would hold by chance** over the observed samples and reports only if that probability is below a threshold, which *requires a minimum sample count to be statistically justified* [Ernst et al. 2001]. Replace the inert gate with Daikon's justification test. Pair it with DIDUCE's discipline: start with the strictest hypothesis and **relax it as observations accumulate**, scoring a violation by how *warm* (well-witnessed) the invariant was — a violation after thousands of confirmations is a signal; one during cold-start is not [Hangal & Lam 2002].

> **The deeper principle (answers "can we just wait for conclusive evidence?"):** Yes — for the cold-start FP class, maturity dissolves the noise, and an anomaly against a *converged* distribution is a far stronger signal than "outside the min/max of 5." This is exactly DIDUCE's train-then-check model. **But statistical maturity is conclusive evidence of what is *normal*, never of what is *correct*.** Anomaly detection is a novelty detector: it has its own false positives (rare-but-legal values) and a fatal blind spot (a *consistently* wrong answer is the baseline, not an anomaly) [Barr et al. 2015]. Waiting fixes cold-start; it cannot find the largest library-bug class. That requires an independent oracle — see §3.

### 2.4 Representation-sensitive value digest → false `value-degraded`

**Issue.** `execute.py:97` hashes `json.dumps(..., sort_keys=True)`. `0.0` and `-0.0` hash differently (`"0.0"` vs `"-0.0"`); NFC vs NFD unicode hash differently. A value-stable probe that legitimately flips `0.0 ↔ -0.0` across runs mints a false `baseline-degraded` issue and awards bandit credit for it.

**Fix.** Normalize before hashing: coerce `-0.0 → 0.0`, `unicodedata.normalize("NFC", s)`. (The whole-body digest is otherwise the *right*, conservative design — it correctly refuses to judge dynamic bodies.)

### 2.5 Branch coverage records only one arm per branch on Python 3.12/3.13

**Issue.** `monitoring_hook.py:113` returns `sys.monitoring.DISABLE` from `on_branch`. On 3.12/3.13 both outcomes of an `if` are the *same* instruction, and `DISABLE` disables events for the **instruction**, not the `(src→dst)` arm. So the first probe records whichever arm it took and then **permanently disables the branch**; every later probe that flips the condition — precisely the input the exploration reward exists to reward — records nothing. The flagship P0.3 signal is capped at one arm per branch on the very versions the roadmap targets. Only the 3.14 `BRANCH_LEFT/RIGHT` path is correct (which is *why* CPython split the event). The unit test asserts line numbers, not both arms, so it passes.

**Fix.** On `< (3,14)`, do not `DISABLE`; dedupe `(id(code), src, dst)` in a set and keep the event live, or DISABLE the instruction only after *both* arms are seen. Strengthen the test to assert two distinct `(src,dst)` per `if`.

---

## 3. The oracle problem — the intellectual core, and where the design is thinnest

Everything above is precision hygiene. This section is about *recall of the bug class that matters*: a function that returns a plausibly-shaped **wrong answer** every time. Anomaly and invariant oracles are structurally blind to it (§2.3). The branch's answer is the **differential oracle**, and the instinct is exactly right — but the execution is a prototype.

### 3.1 The differential corpus is a static hand-list; the technique's power is generative

**Issue.** `semantics_corpus.py` is 4,141 lines of ~378 hand-written Python snippets. Its own docstring cites Csmith, EMI, and NEZHA and says each seed is "meant to be amplified into an unbounded family" — but **no amplification, mutation, or grammar engine exists.** A fixed 378-item list is the antithesis of coverage-guided testing: it finds only what a human already thought to write down, does not grow with the target, and is a standing maintenance liability. It is also effectively hardwired to the Python-executor case (the `"corpus"` selector field is never read).

**Solution — the field solved this three times over:**
- **Generate, don't enumerate.** Csmith generates random *well-defined* programs so the differential has an unambiguous oracle, and found 300+ compiler bugs mechanically [Yang et al. 2011]. For an AST interpreter, an AST-node grammar generator (~300 lines) strictly dominates the 4,141-line list on coverage and never rots.
- **Manufacture oracles from real inputs.** EMI mutates the *unexecuted* parts of a seed program to synthesize variants that must produce identical output — turning any real program into a differential oracle without a corpus [Le et al. 2014].
- **Guide the search by cross-implementation divergence, not just coverage.** NEZHA's **δ-diversity** prioritizes inputs that produce previously-unseen *relative* differences between the implementations under test — the correct objective for a discrepancy hunter, and domain-independent [Petsios et al. 2017].

### 3.2 Generalize the oracle beyond a single reference

**Issue.** The differential only auto-arms on a Python-code evaluator. The gap doc's promise — "generalizes to sibling adapters / documented spec / previous version" — has no corpus or input-generation behind it for anything else.

**Solution.** The reference is a parameter, and the literature gives four proven instantiations that require *no* per-target corpus:
- **Prior released version** → regression differential. This is the single highest-leverage oracle and **has zero cold-start** (the baseline is an already-mature version) — the strongest form of "wait for conclusive evidence" because the evidence already exists [McKeeman 1998].
- **Sibling implementation** → conformance differential [McKeeman 1998; Petsios et al. 2017].
- **Metamorphic relations** when no reference exists at all: check *necessary properties relating multiple runs* (e.g., `f(x) == f(perm(x))`) rather than any single output — the canonical escape from the oracle problem [Chen et al. 2018; Barr et al. 2015].
- **Implicit oracles** (crash/hang/leak) need no spec and should always be armed [Barr et al. 2015].

### 3.3 The comparator is correct only by hand-curation

**Issue.** Divergence is decided by raw `repr()` string equality with **zero normalization** (`differential.py:431` vs `:610`). It works today only because all 378 snippets were hand-audited to avoid address-bearing reprs, non-trivial floats, and set/dict-of-string ordering. The first careless future snippet — or any cross-implementation target with legitimately different float/container repr — yields a false `wrong-value`.

**Fix.** Canonicalize before comparing: strip ` at 0x…`, normalize float formatting, sort unordered containers. Pin `PYTHONHASHSEED=0` in the worker for reproducible result files regardless.

---

## 4. The reinforcement-learning loop — right thesis, inverted arithmetic

The redesign's objective flip ("reward violations, not coverage") is real and correct. But two implementation defects mean the loop, *even if wired*, would not do what it claims.

### 4.1 Cost normalization inverts the objective

**Issue.** `bandit.py:114` returns `credit / max(1.0, cost)` with unbounded `cost` (wall-clock + subprocess count). A genuine violation from a 3-second differential play scores `1.0/12 ≈ 0.083`; a single new-symbol coverage hit on a 0.25s HTTP probe scores `COVERAGE_BONUS = 0.25`. **Cheap coverage out-rewards a real defect** — the exact inversion of the redesign's thesis. The environment oracle's real violations score `~1/240 ≈ 0.004`, indistinguishable from barren. Every campaign test returns uniform `cost=1`, so the cost path is untested and the suite passes.

**Fix.** Floor a true-violation's credit so it can never fall below the coverage bonus, or apply cost as a bounded relative multiplier rather than dividing a `[0,1]` reward by an unbounded denominator.

### 4.2 The scheduling machinery reinvents a solved problem, imperfectly

**Issue.** The bandit uses a Bernoulli-ised conjugate update that injects coin-flip variance in the tiny-budget regime the campaign actually runs (budget 20 across 100+ arms), and the coverage reward saturates one level up (the campaign bandit credits per-target, not per-branch — the very saturation P0.3 set out to kill).

**Solution — adopt the proven fuzzing schedulers wholesale:**
- **Reward exploration by path rarity.** AFLFast models greybox fuzzing as a Markov chain and assigns energy *inversely proportional to the stationary density* of each path — spend where coverage is rare [Böhme et al. 2016]. This is the correct fix for reward saturation, at the campaign level, not just the inner bandit.
- **The bandit framing is already validated.** EcoFuzz casts seed scheduling as an *adversarial* multi-armed bandit and cuts energy to unproductive arms, achieving ~214% of AFL's coverage with ~32% fewer executions [Yue et al. 2020]; Woo et al. formalize (program, seed) scheduling as a multi-armed-bandit / weighted coupon-collector problem and derive schedules that beat the naive MAB by ~1.5× unique bugs [Woo et al. 2013]. Use their reward shaping and energy cutoffs rather than a bespoke Bernoulli relaxation.

---

## 5. The false-positive doctrine — the reputation firewall

This is the most important section, because it is the one that decides whether anyone keeps using the tool. The tension the team raised — *"if we suppress, we don't catch bugs; if we don't, we cry wolf"* — is real but resolvable, and the resolution is **not** a global precision/recall dial.

### 5.1 The empirical stakes

Developers, not tool authors, decide a tool's false-positive rate, and they decide with their attention. Google's Tricorder found that analyzers exceeding **~10% effective false positives get dismissed or disabled**, and holds its platform below 5% [Sadowski et al. 2018]. Coverity's decade of commercialization reached the same conclusion qualitatively: past a noise threshold, users mentally blacklist the tool and ignore even its true reports [Bessey et al. 2010]. **Precision is not a tax on bug-finding; below a threshold it is the precondition for your true positives to ever be read.** A tool that emits 100 findings at 30% noise has an *effective recall of zero* because no one triages it.

### 5.2 The resolution: grade, don't suppress

Do not choose between "report everything" and "report nothing." **Route every candidate through a single finding-gate that grades it by provability**, and surface accordingly:

1. **Reproduce before report.** Replay deterministically N times; surface only if it reproduces every time. This alone kills the timing/measurement-noise class.
2. **Model nondeterminism first.** Learn a per-field volatility profile (timestamps, ids, floats, ordering) *before* any value oracle enforces, and exclude volatile fields. This is the DIDUCE train-phase applied to fields.
3. **Corroborate low-precision detectors.** Tier the oracles. Implicit oracles (crash, 5xx) and differential-vs-reference may report solo; `numeric_bound` and the concurrency `distinct`-count oracle require a *second independent signal* before surfacing.
4. **Rank, don't threshold-only.** When multiple candidates survive, order them by statistical trustworthiness so the top of the list is dense with real bugs — the single most cost-effective precision technique known.
5. **Attribution proof.** A finding must prove the fault is in *target* code, not the harness or the environment. (Today a positional-only-parameter call and an imported first-party callable are both misattributed to the target — see Appendix.)
6. **"Deliberate ≠ defect."** Cross-check candidates against docs/tests/config; an intentional restriction is not a bug (the differential's two-layer adjudication is the right instinct — generalize it).
7. **Close the loop.** Every dismissal is a training label that down-weights that detector; every confirmation promotes it. Track per-detector precision and pull any detector below a floor.

### 5.3 The proven algorithms for the gate

The ranking and corroboration steps are not to be invented — they are the most-cited results in the field:

- **Statistical ranking of reports.** Engler et al.'s "bugs as deviant behavior" ranks inferred rules by a **z-test on conformance-vs-violation counts**, so a rule with many confirmations and few violations (a likely-real bug) outranks statistical noise [Engler et al. 2001]. Kremenek & Engler's **Z-Ranking** formalizes this into a general report-ranking algorithm that dramatically raises the true-bug density of the top of the list [Kremenek & Engler 2003]. This is exactly the "grade by provability" step.
- **Corroboration across many observations.** Liblit et al.'s **Scalable Statistical Bug Isolation** ranks predicates by `Increase(P) = Failure(P) − Context(P)` — how much a predicate raises the failure probability *above the background rate* — and iteratively eliminates redundant predictors to isolate distinct bugs from noisy, sampled runs [Liblit et al. 2005]. This is the template for deciding a finding is real from accumulated evidence rather than a single observation.
- **Confidence that grows with evidence.** Daikon's justification test and DIDUCE's relax-with-observation are the precision core for the value/invariant oracles [Ernst et al. 2001; Hangal & Lam 2002].

### 5.4 Minimized reproductions — precision *and* recall in one move

**Issue.** Findings ship without a minimized reproduction. An un-minimized repro is both less convincing (precision) and hides the true trigger (recall).

**Solution.** Every confirmed finding should be reduced before it is shown. **Delta debugging (`ddmin`)** converges to a 1-minimal failing input by divide-and-conquer [Zeller & Hildebrandt 2002]; **HDD** applies it level-by-level over the input's parse tree so every candidate stays syntactically valid — essential for program-shaped inputs [Misherghi & Su 2006]; **C-Reduce** shows the production-grade pattern of domain-specific reduction passes plus validity checks to avoid reducing into undefined behavior [Regehr et al. 2012]. A shrunk repro is more believable *and* reveals neighbors of the bug.

### 5.5 Optimization findings specifically

Perf claims must clear the paired-bootstrap CI already in the repo (PR #39) **and** reproduce **and** self-measure the "after" **and** exceed a minimum-effect-size above the noise floor. Never report a 2% win inside measurement variance, and guard against attributing warmup/JIT/cache effects to the change.

---

## 6. Testing discipline — the tests pass *by construction*

The recurring reason these defects shipped green: **the tests exercise the same happy path the code was written against.** The branch-coverage test asserts line numbers, not both arms (misses §2.5). Every campaign test returns uniform cost, so the reward path is untested (misses §4.1). The Mount-composition test is inline-only (misses the order-dependent prefix-drop bug). The differential corpus has one blanket "it runs" test but no per-snippet provenance check. The confidence-gate test only exercises the unreachable branch (§2.3).

**Standard to adopt:** every oracle needs an **adversarial** test — both branch arms, non-uniform cost, `NaN`/`-0.0`/unicode, a hanging/`os._exit` snippet, junction/read-only/long-path on Windows, a plausibly-shaped-wrong output that *must* be caught, and a legitimately-varying output that *must not* be flagged. A test suite that never tries to produce a false positive cannot certify precision.

---

## 7. Multi-language strategy

The system divides cleanly: the **control plane** (planner, bandit, oracle abstractions, clustering, scorecard) and the **HTTP/black-box probing channel** are already language-agnostic; everything this branch added is Python-specific *because it works by importing and instrumenting CPython in-process* (`sys.monitoring`, `sitecustomize`, `inspect.signature`, CPython `exec`, monkeypatched builtins, `uv.lock`).

**The move that makes it polyglot — do not port module-by-module:**

1. **Formalize a normalized evidence contract behind a process boundary.** The workers already emit JSONL; make that the *language boundary*. A stable schema for `{spans, covered_branch_ids, call_records, violations}` means the planner/bandit/oracles never import a language runtime. Highest-leverage change; without it every new language re-touches the core.
2. **Capability-negotiated language adapters** (the branch's per-oracle `enumerate_actions` pattern, lifted to language level):

   | Capability | Python | Node | Go / Rust | JVM |
   |---|---|---|---|---|
   | HTTP/gRPC probing | ✓ | ✓ | ✓ | ✓ (already portable) |
   | Branch coverage | `sys.monitoring` | c8/V8 | `-cover` / `llvm-cov` | JaCoCo |
   | Function harness | import+call | worker `require` | **codegen + build** (cannot import-and-call) | reflection |
   | Tracing | tracelens | — | — | **→ OpenTelemetry for all** |
   | Sandbox | monkeypatch | monkeypatch | — | **→ OS container for all** |

3. **Replace two Python-specific mechanisms with portable ones:** the monkeypatch sandbox → an OS/container boundary (also fixes the "not a real boundary" + Windows-leak defects); bespoke route regexes → **tree-sitter/LSP** one-polyglot-discovery-layer.
4. **Sequence HTTP-first:** Tier 0 (all languages today) = HTTP probing + OTel tracing + regression-differential-vs-prior-version; Tier 1 = normalized branch coverage per language; Tier 2 = function harness (and be honest that compiled languages need codegen + a build step, not a port). The differential/invariant/fault oracles are written once against the evidence schema and reused for free — but only if the boundary is drawn first.

**Precision before breadth: a polyglot tool that cries wolf in five languages is worse than a Python one that is trusted.**

---

## 8. Prioritized remediation roadmap

**P0 — before this branch is trusted against unfamiliar code (days). None of these were addressed by the PR #40 follow-up commits; all are still open at `a8d570f`.**

*The whole P0 block is on the order of 20 lines of production change. It should be done before any further subsystem is written.*

1. Fix the live-path false-positive generators: `NaN`/`Infinity` filtering (§2.1), mistyped-params guard (§2.2), the dead confidence gate → Daikon justification test (§2.3), `-0.0`/unicode digest normalization (§2.4).
2. Fix the branch-coverage `DISABLE` bug on 3.12/3.13 (§2.5) — the flagship signal is currently broken.
3. **Close the imported-callable hole (#35) — ~4 lines.** In the `elif name in imports:` branch, when `_dotted_reason` is `None` and the callee's body is unreadable, emit an "unverifiable cross-module call" impurity so it routes to the containment `ad96cc0` already built. A bug-finder must never run foreign destructive code in-process. Also fix the positional-only misattribution.
4. **Make the Windows containment default honest (#36):** on a platform with no OS candidate, either keep the impure set refused by default or set `require_tier="os-sandbox"` so it fails closed loudly — never execute under a wall the code itself documents as insufficient.
5. Drop `asyncpg`/`clickhouse_driver` from the PEP-249 menu (#37) — a substitute that cannot honor a driver's contract manufactures false findings.

**P1 — connect and de-noise (weeks):**
4. Wire `campaign` into the autonomous loop, or land the roadmap incrementally with end-to-end tests (§1).
5. Fix the reward cost-inversion (§4.1); move branch coverage into the campaign reward (§4.2).
6. Stand up the finding-gate as the single choke point in front of `issues.json`: reproduce → attribute → not-deliberate → corroborate → Z-rank → minimize (§5).
7. Fix `exception_policy`'s per-play decay (it forgets everything within one campaign) so the precision feedback loop can actually learn.

**P2 — raise the ceiling (months):**
8. Replace the static differential corpus with a generative AST engine + regression-vs-prior-version + metamorphic relations (§3).
9. Improve input generation (property-based; the current "None for 7 of 9 types" is the real recall bottleneck).
10. Replace the concurrency "threads + sleep" with a **PCT** scheduler (probabilistic guarantee `≥ 1/(n·k^{d−1})` of hitting a depth-`d` bug) [Burckhardt et al. 2010] or **CHESS** iterative context bounding [Musuvathi & Qadeer 2007].
11. Draw the language boundary (§7).

---

## 9. Re-audit of the PR #40 follow-up commits (`f4f3a15`, `ad96cc0`, `a8d570f`)

After the first review, three commits were pushed. They respond to the *safety/sandbox* strand of the review and ignore the *reputation/false-positive* strand. Net: +7,794 lines, one new subsystem file over 1,900 lines, one new dependency — and the two highest-priority findings (§1 wiring, §2 live false positives) are **verified unchanged** (`invariants.py`, `execute.py`, `monitoring_hook.py`, `baseline.py`, and all of `extension/**` are untouched by these commits).

### 9.0 The meta-finding

The correct response to the first review was ~20 lines: 4 lines to point `exerciseRunner.ts` at `campaign`, ~10 lines to fix the live-path false positives (§2.1–2.4), and ~4 lines to route the imported-callable case to the containment that `ad96cc0` itself introduced. Instead the PR shipped three new subsystems, did none of the 20 lines, and *added* new defects. **For a repo aspiring to be a pinnacle of engineering, this is the anti-pattern to name explicitly: a review is answered by fixing defects and connecting what exists, never by adding surface.**

### 9.1 `f4f3a15` — purity guard: decorator hole fixed, the dangerous hole still open

- ✅ **Decorator bypass fixed and well-tested.** `_direct_impurities` now processes `decorator_list` before the `ast.Call` filter (`functions.py:1099-1104`); `@deco`, `@deco()`, and the `from evil import staticmethod` alias trap all refuse correctly (empirically reproduced).
- ❌ **The imported first-party destructive-callable false-negative (prior finding, §2 / Appendix #5) is NOT fixed.** Verified against the actual PR code: `from mypkg.db import wipe_all; def process(): wipe_all()` → `impurities = []` → **driven in-process**. Root cause: the `elif name in imports:` branch (`functions.py:1118-1125`) treats "resolved to a dotted name" as "resolved to a readable behavior" and `_dotted_reason` returns `None` for any non-stdlib module, so the call never falls through to the "cannot verify" refusal. The guard performs **zero cross-file analysis**. My prior example was caught only *incidentally* because its wrapper was named `push` (a destructive verb the name-vocabulary flags); rename it `process`/`build`/`run_it` and destructive imported code executes in the harness process. This is the single most dangerous defect in the entire PR: a bug-finder that runs foreign destructive code on the user's machine.
- 🔧 **The fix is now ~4 lines** and the PR built its own foundation for it: `ad96cc0` routes "unverifiable → contained by default," so emitting an impurity for the unresolved cross-module call sends it to containment instead of in-process execution. They built the runway and did not land the plane.
- ➕ **New false-positive surface.** Receiver-agnostic method names added to `_IMPURE_METHOD_NAMES` (`functions.py:691-724`: `remove`, `delete`, `flush`, `move`, `rename`, `run`, `truncate`) refuse *pure* targets — `xs.remove(3)` on a list, `df.drop(columns=…)` (pandas returns a copy), `job.run()`. Softened to "contained not lost" by the new default, but a real precision cost.
- **Over-engineering: 7/10.** ~1,100-line guard with a 3-round factory-origin fixpoint, five receiver-binding syntaxes (incl. walrus/`with-as`/`for`-target receivers), and a self-attribute taint engine — heavy machinery for rare same-module shapes, while the high-value cross-module case got nothing.

### 9.2 `ad96cc0` — OS containment: real on Linux/macOS, fiction on Windows, and a regression on the user's platform

- ✅ **Genuinely well-built on Linux/macOS.** It does not reimplement a sandbox — it delegates to `bwrap` / `unshare -rmn` / `sandbox-exec` (`containment.py:281-397`) and, critically, **probes before trusting**: it runs a child that attempts to write outside the root and the parent checks the real filesystem (`escaped = denied_file.exists()`, `containment.py:508`), rejecting any mechanism that doesn't actually block. This defeats "primitive present but silently no-op" false confidence and is the correct design.
- ✅ **Now the campaign default (prior finding fixed).** `run_functions` defaults `sandbox=None → enabled` (`functions.py:2557`); `campaign._functions_runner` hits it; the crash oracle is armed on `[*function_targets, *contained_targets]` (`campaign.py:220`). Opt-out is `--no-sandbox`.
- ❌ **On Windows there is no OS enforcement at all.** `_candidates()` returns `[]` for `win32` (`containment.py:614`); there is no Job Object, Restricted Token, or AppContainer anywhere in the file. Every Windows run falls back to `PROCESS_SHIM` — the same monkeypatch the first review already rejected. "Enforce at the OS layer" is simply **false on the platform the user runs.**
- ❌ **Net safety regression on Windows.** Because the same commit flipped the default to enabled, the impure/unverifiable set that used to be **refused** on Windows is now **executed** under a shim the commit's own docstring says cannot stop `sqlite3`/`ctypes` C-level I/O. Blast radius got worse, not better. A `--require-tier os-sandbox` fail-closed escape exists (`sandbox.py:717`) but **nothing in the default `functions`/`campaign` path sets it.**
- ❌ **`_UNSHARE_SCRIPT` word-splits writable paths** (`containment.py:363` `for p in $VINV_WRITABLE_PATHS`) — any path containing a space produces bogus mounts → probe fails → silent downgrade to shim, on Linux hosts with spaced repo paths.
- ⚠️ **`os_denial` masks real defects under the strong tier** (`containment.py:752`, `sandbox.py:957`): a genuine target bug that crashes with a `PermissionError`/`EACCES`-shaped error is attributed to the kernel wall and never reported — a deliberate but real false-negative channel specific to `OS_SANDBOX`.
- **Over-engineering: 6/10.** The delegate-and-probe core is earned; the ceremony is not — English-paragraph `guarantees()` baked into code as data, four hand-written comparison dunders reimplementing `functools.total_ordering`, and a `--max-tier` operator affordance with no campaign caller. On Windows all 772 lines collapse to `return SHIM`. **Leaner + more honest:** on a platform with no OS candidate, keep the impure set *refused by default* (opt-in where the wall is fake) or default `require_tier="os-sandbox"` so Windows refuses loudly instead of running under a shim it has already documented as insufficient.

### 9.3 `a8d570f` — service doubles: the strongest of the three, still over-built

- ✅ **Genuinely generic (a prior fear disproved).** Keyed on PEP 249 / SQLAlchemy URLs, not on any provider — there is **no LLM/model-provider double**. An unknown service (`amqp://`, `mongodb://`) gets no substitution and the target safely lands `contained`. The dependency fear is also unfounded: one dev-only dep (`sqlalchemy`); the 883-line `uv.lock` growth is per-platform wheel hashes, not a product tree; `service_doubles.py` imports only stdlib.
- ✅ **The SQL core is novel and defensible.** Postgres/MySQL→sqlite URL rewrite + **error-driven schema induction** (synthesize tables/columns from sqlite's own "no such table" errors) is the one service family with no faithful off-the-shelf in-process substitute.
- ❌ **Redis (~470 lines) and S3 (~110 lines) are needlessly hand-reimplemented.** `fakeredis` and `moto` (in-memory mode) are in-process, higher-fidelity, and equally vendorable into the jail — the "stdlib-only" justification is circular (the jail blocks *network*, not *pure-Python libraries*). Even the SQL dialect translator overlaps `sqlglot`'s `transpile(read="postgres", write="sqlite")`.
- ❌ **Concrete false-positive vector:** `asyncpg` and `clickhouse_driver` are in the synchronous PEP-249 menu (`service_doubles.py:1577,1583`) but are **not** DB-API 2.0. A target doing `await asyncpg.connect(...)` gets a `TypeError` raised in the *repo's* frame (`error_module="builtins"`), which is **not** classified as a `SubstitutionGap` and is eligible to be reported as a repo defect. No test covers these driver names.
- ⚠️ **Fidelity guarantee protects only against *raised* gaps, not *silently-wrong* answers.** A dialect construct sqlite accepts with different semantics (`ILIKE` folding, JSONB ops, `DISTINCT ON`), or a name-shape-guessed seed value compared numerically, yields a plausible-but-wrong result → a spurious finding. `seed_dependent=True` is a down-weight hint, not a suppression.
- **Over-engineering: 6/10.** Not gratuitous — it solves a real generic coverage gap — but two of three service families reinvent mature wheels.

### 9.4 Verdict on PR #40

| Commit | Claim | Reality | O/E |
|---|---|---|---|
| `f4f3a15` | purity guard hardened | decorator hole fixed; **imported-destructive-callable hole still open + new FP surface** | 7/10 |
| `ad96cc0` | OS containment, default | real on Linux/macOS; **nothing on Windows + net regression there** | 6/10 |
| `a8d570f` | in-jail service doubles | generic + novel SQL core; **Redis/S3 reinvented + async-driver FP vector** | 6/10 |

**All three remain reachable only via `campaign`; the autonomous product still does not run any of it.** The PR does not change §0's verdict — it reinforces it. Do not merge until the ~20-line fixes (extension wiring, live-path false positives, the imported-callable containment route) land and the Windows containment default is made honest (refuse, don't fake).

---

## Appendix A — Full implementation-defect catalogue

Ranked within each subsystem; `L` = on the live/shipping path, `C` = behind the dead `campaign` path, `C*` = behind `campaign` and introduced by the PR #40 follow-up commits.

| # | Sev | Path | Subsystem | Defect | Anchor |
|---|-----|------|-----------|--------|--------|
| 1 | HIGH | L | invariants | `NaN`/`Inf` poisons `numeric_bound`: order-dependent bound, all-values-flagged-forever, corrupt JSON | `invariants.py:151,263` |
| 2 | HIGH | L | invariants | Mistyped `params` in a well-formed doc crashes the whole run (unguarded `TypeError`) | `store.py:69`, `run.py:846` |
| 3 | HIGH | L | invariants | `ENFORCE_MIN_CONFIDENCE` is dead code; `numeric_bound`/`stable_enum` enforced as hard failures on 5 samples | `invariants.py:41` |
| 4 | HIGH | L | tracelens | Branch coverage records one arm per branch on 3.12/3.13 (`DISABLE` disables the instruction) | `monitoring_hook.py:113` |
| 5 | HIGH | L | functions | Purity guard fails **open** on imported first-party callables → runs destructive target code in-process | `functions.py:820` |
| 6 | HIGH | C | exception_policy | Evidence decayed ×0.5 **per per-target play** → a 20-play campaign scales all labels by ~1e-6 | `exception_policy.py:765`, `campaign.py:369` |
| 7 | HIGH | C | sandbox | Windows `dispose()` leaks the whole temp tree while reporting `root_removed: true` | `sandbox.py:1074` |
| 8 | HIGH | C | bandit | Cost normalization inverts objective: cheap coverage out-rewards a real defect | `bandit.py:114`, `campaign.py:132` |
| 9 | HIGH | C | differential | Emit-once worker loses all 378 comparisons on one hang/`os._exit`/segfault | `differential.py:583` |
| 10 | MED | L | execute/baseline | `-0.0` vs `0.0` and NFC/NFD digests → false `value-degraded` | `execute.py:97` |
| 11 | MED | L | routes | Declarative `Mount` prefix dropped **order-dependently** (breaks the P0.1 feature it advertises) | `runner.py:334` |
| 12 | MED | L | routes | `methods=VARIABLE` not resolved → silently defaults to GET → wrong verb probed | `runner.py:265` |
| 13 | MED | L | routes | `APIRouter(prefix=...)` ignored in the AST path (regex-vs-AST inconsistency) | `runner.py:331` |
| 14 | MED | L | functions | "Hostile" input class is `None` for 7 of 9 types → cannot reach validation bugs beyond null checks | `functions.py:1276` |
| 15 | MED | L | functions | No subprocess encoding → target non-ASCII stdout raises `UnicodeDecodeError`, kills the module's collection on Windows | `functions.py:1949` |
| 16 | MED | C | differential | Single 60s wall-clock timeout wraps all 756 evaluations; no per-snippet bound | `differential.py:985` |
| 17 | MED | C | differential | Refusal-cache key normalizes only digits → any hex address defeats it → budget re-burned every run | `differential.py:735` |
| 18 | MED | C | concurrency | "Deterministic schedule" is threads + `sleep` + repeat; catches only GIL-yielding races | `concurrency.py:112` |
| 19 | MED | C | concurrency | Wedged worker uncancelable; `atexit`-joins for full `worker_timeout_s` | `concurrency.py:133` |
| 20 | MED | C | concurrency | `distinct`-count oracle: FP on time-varying returns, FN on non-return-value corruption | `concurrency.py:179` |
| 21 | MED | C | child-trace | Sidecar path derived from a relative `TRACELENS_OUTPUT` → captures lost when a child `chdir`s | `child_bootstrap.py:70` |
| 22 | MED | C | environment | `uv.lock` schema-blind; parse failure → `{}` → reports "0 disagreements" (silent FN) | `environment.py:271` |
| 23 | MED | C | environment | Transient import failure reported as breaking API drift (e.g. torch w/o CUDA) | `environment.py:109` |
| 24 | MED | C | environment | "Resolution matrix" is uv-only + 2-cell (no python × extras axes) | `environment.py` |
| 25 | MED | C | sandbox | Windows resource-limit tier is a no-op yet `planned_rlimits` reports caps | `sandbox.py:716,743` |
| 26 | MED | C | sandbox | `copy_repo` recurses into Windows junctions (not symlinks) → escape/bloat | `sandbox.py:288` |
| 27 | MED | C | rewardSignals | `verifiedEligible` marks a non-objective "portless survival" pass as verified → trains the bandit on it | `rewardSignals.ts:591` |
| 28 | LOW-MED | C | campaign | `--seed` not reproducible (wall-clock `elapsed` feeds the reward) | `campaign.py:727` |
| 29 | LOW-MED | C | campaign | Concurrent campaigns on one repo lose-update `campaign.json` → re-credit defects | `campaign.py:772` |
| 30 | LOW-MED | C | campaign | Credited-signature eviction is lexicographic, not LRU → re-credits live defects past 5000 | `campaign.py:772` |
| 31 | LOW-MED | L | tracelens | Branch-writer is a 2nd concurrent appender to the trace → tearing > PIPE_BUF (esp. Windows) | `monitoring_hook.py:144` |
| 32 | LOW | C | differential | `_UBIQUITY` re-parses all 378 snippets at import (~66ms) unconditionally | `differential.py:452` |
| 33 | LOW | C | differential | ~50 lines of byte-identical duplicated dead code (`_ubiquity` et al. defined twice) | `differential.py:160,286` |
| 34 | LOW | L/C | multiple | Overclaiming docstrings: phantom Hypothesis (`functions.py`), unshared "shared channel" (`agent_loop.py`), "deterministic schedule", "resolution matrix" | — |

### Defects introduced or left open by the PR #40 follow-up commits (§9)

| # | Sev | Path | Subsystem | Defect | Anchor |
|---|-----|------|-----------|--------|--------|
| 35 | **HIGH** | C* | functions | **Defect #5 NOT fixed.** Imported first-party destructive callable still judged pure → **runs destructive code in-process**. `elif name in imports:` fails open for any non-stdlib module; zero cross-file analysis. Prior example passed only because the wrapper was named `push` (name vocabulary), not because the guard caught it | `functions.py:1118-1125` |
| 36 | **HIGH** | C* | containment | **Windows safety regression.** No OS mechanism exists for `win32` (`_candidates()` → `[]`); default flipped to enabled → impure targets that were *refused* are now *executed* under a shim documented as unable to stop `sqlite3`/`ctypes`. Nothing sets `require_tier` in the default path | `containment.py:614`, `functions.py:2557` |
| 37 | MED | C* | service_doubles | `asyncpg`/`clickhouse_driver` in a synchronous PEP-249 menu though neither is DB-API 2.0 → repo-frame `TypeError` not classed as `SubstitutionGap` → **eligible to be reported as a repo defect (false positive)**; no test covers them | `service_doubles.py:1577,1583` |
| 38 | MED | C* | functions | New FP surface: receiver-agnostic `_IMPURE_METHOD_NAMES` (`remove`/`delete`/`flush`/`run`/…) refuse pure targets (`list.remove`, `df.drop`, `job.run`) | `functions.py:691-724` |
| 39 | MED | C* | containment | `_UNSHARE_SCRIPT` word-splits `$VINV_WRITABLE_PATHS` → any path with a space breaks the mount → probe fails → silent downgrade to shim | `containment.py:363` |
| 40 | MED | C* | containment | `os_denial` attributes any target `PermissionError`/`EACCES` to the wall under `OS_SANDBOX` → genuine denial-shaped bugs invisible on the strong tier (false negative) | `containment.py:752`, `sandbox.py:957` |
| 41 | LOW-MED | C* | service_doubles | Silently-wrong doubles: dialect gaps (`ILIKE` folding, JSONB, `DISTINCT ON`) and name-shape-guessed seed values yield plausible-but-wrong results; `seed_dependent` is a hint, not a suppression | `service_doubles.py:858` |
| 42 | LOW | C* | service_doubles | `_patch_pep249` unconditionally overwrites `module.paramstyle = "pyformat"` (wrong for `pg8000`'s `format`, `asyncpg`'s numbered) | `service_doubles.py:1596` |

---

## Appendix B — References (all verified against DBLP + publisher/author PDF)

**Invariant inference & anomaly detection**
- [Ernst et al. 2001] M. D. Ernst, J. Cockrell, W. G. Griswold, D. Notkin. "Dynamically Discovering Likely Program Invariants to Support Program Evolution." *IEEE TSE* 27(2), 2001, 99–123 (orig. ICSE 1999). https://homes.cs.washington.edu/~mernst/pubs/invariants-tse2001.pdf
- [Hangal & Lam 2002] S. Hangal, M. S. Lam. "Tracking Down Software Bugs Using Automatic Anomaly Detection." *ICSE 2002*, 291–301. https://suif.stanford.edu/papers/Diduce.pdf

**Statistical bug finding & report ranking (the precision doctrine)**
- [Engler et al. 2001] D. Engler, D. Y. Chen, S. Hallem, A. Chou, B. Chelf. "Bugs as Deviant Behavior: A General Approach to Inferring Errors in Systems Code." *SOSP 2001*, 57–72. https://dl.acm.org/doi/10.1145/502034.502041
- [Kremenek & Engler 2003] T. Kremenek, D. Engler. "Z-Ranking: Using Statistical Analysis to Counter the Impact of Static Analysis Approximations." *SAS 2003*, LNCS 2694, 295–315. https://web.stanford.edu/~engler/z-ranking.pdf
- [Liblit et al. 2005] B. Liblit, M. Naik, A. X. Zheng, A. Aiken, M. I. Jordan. "Scalable Statistical Bug Isolation." *PLDI 2005*, 15–26. https://theory.stanford.edu/~aiken/publications/papers/pldi05.pdf

**Developer trust & false-positive thresholds (the reputation argument)**
- [Bessey et al. 2010] A. Bessey et al. "A Few Billion Lines of Code Later: Using Static Analysis to Find Bugs in the Real World." *CACM* 53(2), 2010, 66–75. https://cacm.acm.org/research/a-few-billion-lines-of-code-later/
- [Sadowski et al. 2018] C. Sadowski, E. Aftandilian, A. Eagle, L. Miller-Cushon, C. Jaspan. "Lessons from Building Static Analysis Tools at Google." *CACM* 61(4), 2018, 58–66 (the ~10% effective-FP threshold). https://cacm.acm.org/research/lessons-from-building-static-analysis-tools-at-google/

**Differential & metamorphic testing (the oracle problem)**
- [McKeeman 1998] W. M. McKeeman. "Differential Testing for Software." *Digital Technical Journal* 10(1), 1998, 100–107. https://www.hpl.hp.com/hpjournal/dtj/vol10num1/vol10num1art9.pdf
- [Yang et al. 2011] X. Yang, Y. Chen, E. Eide, J. Regehr. "Finding and Understanding Bugs in C Compilers." *PLDI 2011*, 283–294. https://users.cs.utah.edu/~regehr/papers/pldi11-preprint.pdf
- [Le et al. 2014] V. Le, M. Afshari, Z. Su. "Compiler Validation via Equivalence Modulo Inputs." *PLDI 2014*, 216–226. https://web.cs.ucdavis.edu/~su/publications/emi.pdf
- [Petsios et al. 2017] T. Petsios, A. Tang, S. Stolfo, A. D. Keromytis, S. Jana. "NEZHA: Efficient Domain-Independent Differential Testing." *IEEE S&P 2017*, 615–632. https://arxiv.org/abs/1611.00838
- [Chen et al. 2018] T. Y. Chen, F.-C. Kuo, H. Liu, P.-L. Poon, D. Towey, T. H. Tse, Z. Q. Zhou. "Metamorphic Testing: A Review of Challenges and Opportunities." *ACM Computing Surveys* 51(1), 2018, Art. 4. https://dl.acm.org/doi/10.1145/3143561
- [Barr et al. 2015] E. T. Barr, M. Harman, P. McMinn, M. Shahbaz, S. Yoo. "The Oracle Problem in Software Testing: A Survey." *IEEE TSE* 41(5), 2015, 507–525. https://discovery.ucl.ac.uk/id/eprint/1471263/1/06963470.pdf

**Coverage-guided fuzzing & bandit scheduling (the RL loop)**
- [Böhme et al. 2016] M. Böhme, V.-T. Pham, A. Roychoudhury. "Coverage-based Greybox Fuzzing as Markov Chain." *CCS 2016*, 1032–1043. https://mboehme.github.io/paper/CCS16.pdf
- [Yue et al. 2020] T. Yue et al. "EcoFuzz: Adaptive Energy-Saving Greybox Fuzzing as a Variant of the Adversarial Multi-Armed Bandit." *USENIX Security 2020*, 2307–2324. https://www.usenix.org/conference/usenixsecurity20/presentation/yue
- [Woo et al. 2013] M. Woo, S. K. Cha, S. Gottlieb, D. Brumley. "Scheduling Black-Box Mutational Fuzzing." *CCS 2013*, 511–522. https://users.ece.cmu.edu/~sangkilc/papers/ccs13-woo.pdf

**Test-case minimization (reproductions)**
- [Zeller & Hildebrandt 2002] A. Zeller, R. Hildebrandt. "Simplifying and Isolating Failure-Inducing Input." *IEEE TSE* 28(2), 2002, 183–200. https://www.st.cs.uni-saarland.de/publications/files/zeller-tse-2002.pdf
- [Misherghi & Su 2006] G. Misherghi, Z. Su. "HDD: Hierarchical Delta Debugging." *ICSE 2006*, 142–151. https://people.inf.ethz.ch/suz/publications/icse06-hdd.pdf
- [Regehr et al. 2012] J. Regehr, Y. Chen, P. Cuoq, E. Eide, C. Ellison, X. Yang. "Test-Case Reduction for C Compiler Bugs." *PLDI 2012*, 335–346. https://users.cs.utah.edu/~regehr/papers/pldi12-preprint.pdf

**Concurrency-bug scheduling (with probabilistic guarantees)**
- [Burckhardt et al. 2010] S. Burckhardt, P. Kothari, M. Musuvathi, S. Nagarakatte. "A Randomized Scheduler with Probabilistic Guarantees of Finding Bugs." *ASPLOS 2010*, 167–178. https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/asplos277-pct.pdf
- [Musuvathi & Qadeer 2007] M. Musuvathi, S. Qadeer. "Iterative Context Bounding for Systematic Testing of Multithreaded Programs." *PLDI 2007*, 446–455. https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/pldi07-icb.pdf

---

## Appendix C — What "pinnacle of engineering" would require here

Stated plainly, because it is the standard this audit was asked to apply. None of it is exotic; all of it is discipline.

1. **A capability is not done until the product can invoke it.** Definition of Done = reachable from the autonomous loop + an end-to-end test that spawns the real process and asserts a real finding. 22,000 lines behind a door the product never opens is not a feature; it is inventory.
2. **Answer a review by fixing defects, not by adding surface.** The PR #40 follow-up added 7,794 lines and fixed none of the five P0 items. The instinct to build is the thing to discipline.
3. **Fail closed on the safety path, open on the coverage path.** Refusing to verify a callee must cost coverage, never containment. Today it is inverted (#35).
4. **Never claim a guarantee the platform does not provide.** "OS-layer containment" that is a no-op on the user's own OS (#36), `planned_rlimits` that reports unenforced caps, `root_removed: true` on a tree that still exists — each of these is worse than no claim, because it is trusted.
5. **Precision is the product.** Past ~10% effective false positives a tool is abandoned [Sadowski et al. 2018]. Every oracle needs an adversarial test that tries to *produce* a false positive; a suite that only proves true positives cannot certify precision.
6. **Prefer the proven algorithm to the bespoke heuristic.** Daikon's justification test, Z-ranking, `ddmin`, PCT, AFLFast's power schedule, `fakeredis`/`moto`/`sqlglot` — each replaces hand-rolled code that is currently both larger and weaker.
7. **Delete before you add.** The 4,141-line static corpus, the duplicated dead code, the hand-written Redis/S3, the inert Windows tier — a pinnacle repo is defined as much by what it refuses to carry.

---

*Reviewed by adversarial multi-agent audit across fifteen subsystems in two passes (twelve reviewers at `a4c8217`, three at `a8d570f`); every implementation defect carries a file:line anchor and a concrete failure scenario, and every prescribed solution carries a citation verified against DBLP and the publisher/author PDF. The bar is not "does it work on the happy path" — it is "would a competent skeptic, reading only the code, conclude this is how autonomous bug-finding should be built."*
