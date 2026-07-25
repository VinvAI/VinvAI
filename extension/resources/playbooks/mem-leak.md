# Playbook: mem-leak (memory this symbol holds grows run over run)

The evidence behind this kind: across capture sessions this symbol retains
net bytes EVERY run with a positive Theil–Sen trend (collectMemoryTrends) —
retention that is not being freed. Measured in BYTES. This is a stability
and cost problem (RSS growth → OOMKilled, restarts, degraded neighbours), not
a latency one, and its proof is different from every other kind: a leak is
growth over TIME, so you verify a fix by running the workload repeatedly and
checking the growth flattened — one before/after is not enough.

## Fix patterns, in preference order

1. **Find what holds the reference.** A leak is always something reachable
   that should not be: a module-level list/dict/cache that only ever grows,
   an unbounded queue, a registry/observer list nothing removes from, a
   closure capturing large state, a cache with no eviction.
2. **Bound every cache and buffer.** Unbounded memoization is the most common
   "leak" — cap it (LRU/TTL, `functools.lru_cache(maxsize=…)`, a bounded
   dict). Size caches in BYTES, not entry count, when entries vary.
3. **Close and release.** Connections, files, sockets, thread/loop handles,
   subscriptions — release them (context managers, explicit close in
   `finally`), especially on the error path where leaks hide.
4. **Break retained cycles / listeners.** Deregister callbacks and observers;
   drop back-references; use weak references (`weakref`) for caches and
   parent links that must not keep objects alive.
5. **Stop accumulating per-request state in a long-lived object.** Request
   data appended to a service/singleton field lives forever — scope it to the
   request instead.

## Traps

- **"Fixing" churn with a cache** creates exactly this leak. If you added a
  cache to reduce allocation, it MUST be bounded, or you moved the problem
  from the collector to the heap.
- **GC does not save you** from a live reference — a leak by definition is
  still reachable, so forcing collection changes nothing. Find the holder.
- **One-run measurement lies.** Retention looks flat within a single run;
  the growth only shows across runs. Trust the cross-session trend, not a
  single snapshot.

## Verification discipline

Run the workload SEVERAL times and check the retained-bytes trend: the
Theil–Sen slope must fall to ~0 (retention stopped growing), responses stay
identical, and you did not merely cap growth by breaking a legitimate cache.
A leak is proven fixed only by a flat trend across repeated runs, not by one
faster/lighter after-run.
