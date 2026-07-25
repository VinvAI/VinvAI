# Playbook: throughput-ceiling (the service stops scaling with load)

The evidence behind this kind: a concurrency sweep (`.vinv/exercise/
throughput_sweep.json`, USL fit) shows requests/second flattening — or
retrograding — as offered concurrency rises. Single-request latency fixes do
not move this; the ceiling comes from contention (queueing on a shared
resource) or crosstalk (coordination cost that grows with workers).

## Fix patterns, in preference order

1. **Find the saturated resource.** At the ceiling, ONE thing is at 100%:
   worker/thread pool, DB connection pool, a lock, one CPU core (GIL), or the
   downstream service. The trace's blocked time under load points at it.
2. **Size the pools to each other.** A 100-worker server over a 5-connection
   DB pool is a 5-way ceiling with 95 queuers. Align worker, connection, and
   downstream limits deliberately.
3. **Shrink the serial fraction.** Amdahl rules the ceiling: work done under
   a global lock, in a single writer, or per-process singleton bounds total
   throughput. Shorten critical sections; shard what must serialize.
4. **Cut coordination crosstalk.** Retrograde scaling (throughput FALLS past
   the knee) means workers interfere — cache-line/row contention, lock
   convoys, herd retries. Reduce shared mutable state per request.
5. **Add capacity only after 1–4.** More replicas of a contended resource
   just parallelize the queueing.

## Traps

- **No deadline, no backpressure**: at the ceiling, unbounded queues convert
  overload into latency and memory growth until everything times out at
  once. Bound queues, set deadlines, shed load explicitly — a fast 503 beats
  a 30s 200.
- **Testing past the knee**: numbers measured in the retrograde region are
  noise; fit and compare AT the knee.
- **Latency-throughput confusion**: batching raises throughput while raising
  per-request latency. Know which one the episode is buying.

## Verification discipline

Re-run the SAME concurrency sweep: the fitted ceiling must rise (or the knee
move right) beyond the fit's confidence band, with error rate flat and
behavior identical at every tested concurrency — not just at 1.
