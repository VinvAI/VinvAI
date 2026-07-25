# Playbook: cache (duplicate recomputation)

The evidence behind this kind: a deterministic symbol was re-called with an
argument hash it had already answered, and returned the same result — the
repeated calls' time is directly measured as reclaimable.

## Fix patterns, in preference order

1. **Hoist, don't cache.** If the duplicate calls happen inside one request or
   one loop, compute once and pass the value down. No invalidation problem,
   no memory growth, no new mechanism.
2. **Request-scoped memo.** Cache keyed on the argument hash, living only for
   the request (a dict on the request context). Dies with the request, so
   staleness and growth are impossible.
3. **Bounded process cache.** Only when duplicates span requests: an LRU/TTL
   cache with an explicit size bound. Choose the key from the ACTUAL arguments
   that determine the result — a too-narrow key serves wrong answers, a
   too-wide key never hits.

## Traps

- **Unbounded growth**: a bare dict memo is a slow memory leak. Always bound
  (maxsize) or scope (per-request).
- **Stampede**: when the cached value expires under concurrency, every waiter
  recomputes at once. Single-flight the fill (lock or "compute once, others
  wait") if the computation is expensive.
- **Nondeterminism**: caching a function that reads the clock, randomness, or
  mutable state changes behavior. The evidence already screened for identical
  results, but re-check the function body before trusting it.
- **Mutable return values**: handing the same cached object to two callers who
  mutate it is a shared-state bug. Return copies or immutable values.

## Verification discipline

Replay the SAME flow and confirm: duplicate-argument recomputations drop,
total time drops beyond noise, responses stay byte/shape-identical, and
memory does not trend upward across sessions. A cache that speeds up one run
but grows forever is a regression, not a win.
