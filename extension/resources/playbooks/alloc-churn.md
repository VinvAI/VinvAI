# Playbook: alloc-churn (a symbol allocates a large share of the run's memory)

The evidence behind this kind: from the trace's per-call `mem_delta_bytes`,
this symbol accounts for a large fraction of all bytes allocated during the
run — measured in BYTES, not milliseconds. Unlike gc-pressure it does NOT
require a GC pause to have fired; it flags allocation VOLUME itself, which
matters for RSS, container memory limits, and OOM risk even when latency is
fine. The predicted figure is a conservative half of the allocated bytes
(pooling/reuse rarely removes all of it).

## Fix patterns, in preference order

1. **Confirm the volume is real, not necessary.** Some allocation is the
   work (building the response the caller asked for). Profile allocations on
   the hot path and separate *incidental* churn (intermediates, wrappers,
   per-call rebuilds) from *inherent* output.
2. **Stop materializing intermediates.** List-per-stage pipelines →
   generators/iterators; `str +=` in loops → `join`; per-item dict/object
   wrappers around data that is immediately unwrapped; `.copy()` where a view
   or slice would do.
3. **Reuse instead of recreate.** Compiled regexes, parsers, serializers,
   buffers, and clients built per call belong at module/instance scope. A
   `bytearray`/buffer reused across calls beats a fresh allocation each time.
4. **Right-size the big collections.** Loading 100k rows to serve 20 is an
   allocation storm and a query bug — push limits/pagination/projection down
   to the source so the bytes are never allocated.
5. **Lighter structures.** Prefer arrays/tuples/`__slots__` over dicts of
   objects for large homogeneous data; stream instead of buffering whole
   payloads.

## Traps

- **Object pools in managed runtimes** are usually slower and buggier than
  the allocator you are fighting — pool only proven-expensive objects
  (connections, large buffers), never cheap ones.
- **Caching as a "fix"** turns churn into RETENTION — it trades allocation
  volume for a memory trend (see the mem-leak sweep). Bound anything you keep.
- **Micro-rewrites (`__slots__`, struct packing) before the algorithmic fix**
  are measurable but tiny next to not allocating the objects at all.

## Verification discipline

Re-run the SAME flow under tracing and compare allocated bytes per request:
the figure must drop, responses stay byte/shape identical (you removed churn,
not output), and retention across sessions stays flat (you did not plant a
cache leak). A latency change is a bonus, not the target — this is a bytes
win.
