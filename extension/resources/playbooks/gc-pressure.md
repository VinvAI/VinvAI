# Playbook: gc-pressure (allocation churn taxing the collector)

The evidence behind this kind: latency wobble or per-call cost that tracks
allocation volume — lots of short-lived objects created and discarded per
request, so the runtime spends time collecting instead of serving. Vinv has
no dedicated GC detector today; this surfaces through per-call outliers and
memory-trend evidence, so treat the diagnosis step as mandatory.

## Fix patterns, in preference order

1. **Prove it first.** Measure allocations on the hot path (tracemalloc, GC
   stats, heap profile) before touching code — "feels allocation-heavy" is
   how pointless rewrites start.
2. **Stop materializing intermediates.** Builder-style loops that create a
   list per stage → generators/iterators; string concat in loops → join;
   per-item dict/object wrappers around data that is immediately unwrapped.
3. **Reuse instead of recreate.** Compiled regexes, parsers, serializers,
   buffers, and clients built per call belong at module/instance scope.
4. **Right-size the big collections.** Loading 100k rows to serve 20 is both
   an allocation storm and a query bug — push limits/pagination down.
5. **Tune the collector LAST.** Generation thresholds and GC freezes help
   only after the churn itself is reduced, and they are global knobs with
   global consequences.

## Traps

- **Object pools in managed runtimes**: usually slower and buggier than the
  allocator you are fighting — modern GCs are good at short-lived garbage.
  Pool only proven-expensive objects (connections, buffers).
- **Caching as a "fix"**: turns churn into retention and trades GC pressure
  for a memory trend (see the memory-leak sweep). Bound anything you keep.
- **Premature `__slots__`/struct rewrites**: measurable but tiny next to an
  algorithmic allocation fix; do them only when profiles say objects
  dominate.

## Verification discipline

Re-profile allocations on the same flow: allocation count/bytes per request
must drop, latency variance should tighten, responses stay identical, and
memory across sessions stays flat (you reduced churn, not planted a cache
leak).
