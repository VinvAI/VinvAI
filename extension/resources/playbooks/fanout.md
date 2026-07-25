# Playbook: fanout (callee amplified per caller invocation)

The evidence behind this kind: across the trace, a callee runs many times per
invocation of its busiest caller — a loop or per-item delegation shape seen
from the aggregate call counts (the request-local variant is `n-plus-1`).
The fix almost always lives at the CALLER, not in the hot callee.

## Fix patterns, in preference order

1. **Batch the interface.** Give the callee a set-taking variant
   (`get_many(ids)`) and call it once. The callee's own body is usually fine;
   the amplification is the waste.
2. **Hoist loop-invariant calls.** If the callee's arguments do not change
   across iterations, the loop is recomputing a constant — lift it out.
3. **Push the loop down.** Move the iteration INTO the layer that can do it
   cheaply (the database, a vectorized library, a bulk API) instead of
   looping in application code over a chatty interface.
4. **Precompute/join at read time.** When the fanout implements a lookup per
   item, fetch the lookup table once and join in memory.

## Traps

- **Optimizing the callee.** Shaving 20% off a function called 500× per
  request leaves the 500× — the amplification factor bounds what internal
  tuning can recover. Attack the count, then the cost.
- **Partial-failure semantics.** One call per item fails per item; a batch
  fails as a unit. Preserve the original per-item error behavior (skip,
  default, abort) explicitly.
- **Memory spikes.** Batching materializes the whole set where the loop
  streamed it. Chunk if the set is unbounded.
- **Transaction boundaries.** N calls in N transactions vs one call in one
  transaction changes atomicity and lock behavior — check what callers rely
  on.

## Verification discipline

In the fresh trace, the callee's calls-per-caller-invocation ratio must drop
toward 1 on the same flow, with responses unchanged. If the ratio is intact
but the time dropped, you optimized the wrong thing — the shape remains.
