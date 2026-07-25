# Playbook: per-call (single call unexpectedly slow for its work)

The evidence behind this kind: this symbol's cost per call — on its own (self)
time, not its callees' — is an outlier against the typical symbol in the same
trace. The waste is inside the function body, not in how often it runs.

## Fix patterns, in preference order

1. **Find the actual line first.** Profile or bisect the body before touching
   it — per-call outliers are usually ONE thing (a quadratic scan, a parse in
   a loop, a sync sleep, an accidental deep copy), not general slowness.
2. **Better algorithm/data structure.** Linear scans behind membership tests
   → set/dict; repeated sorting → sort once; string concatenation in loops →
   join; regex recompiled per call → compile once at module level.
3. **Do less work.** Compute only what the caller consumes: lazy fields,
   early exit on the common case, skip serialization of unread data.
4. **Move constant setup out.** Client construction, schema compilation,
   template parsing per call are startup work leaking into steady state —
   hoist to module/instance scope.

## Traps

- **Deliberate cost.** Password hashing, key derivation, and rate-limit
  sleeps are slow BY DESIGN. If the body is intentional security or pacing
  cost, say so and stop — do not weaken parameters to win a benchmark.
- **Micro-optimizing the wrong 90%.** Confirm with self-time where the body
  spends; rewriting the readable 10% for style points is churn.
- **Semantics drift.** Faster algorithms with different tie-breaking,
  ordering, unicode, or float behavior change outputs. The behavior suite
  replay is the referee.

## Verification discipline

Per-call time (self basis) on the same flow must drop beyond the trace's
noise band, with call count unchanged (you fixed cost, not usage) and
responses byte/shape-identical.
