# Playbook: serial-async (independent I/O awaited back-to-back)

The evidence behind this kind: inside one parent call, several I/O children
ran strictly sequentially — each started only after the previous finished —
yet nothing in the data flow forced that order. The recoverable time is the
sum minus the slowest call.

## Fix patterns, in preference order

1. **Gather the independent awaits.** `asyncio.gather(a(), b(), c())` /
   `Promise.all([...])` — start all, wait once. The wall time becomes the
   slowest call instead of the sum.
2. **Start early, await late.** When the calls are interleaved with other
   work, create the task/promise at first opportunity and await it at last
   need — overlap without restructuring.
3. **Move truly independent work off the request path.** If a call's result
   is never used in the response (fire-and-forget notification, log ship),
   it does not belong in the request's critical path at all — queue it.

## Traps

- **Hidden data dependence.** If call B secretly reads state that call A
  writes (session, DB row, cache), parallelizing reorders the writes and
  changes behavior. Prove independence from the arguments and the trace, not
  from optimism.
- **Shared client limits.** One connection/session used by both calls (a DB
  connection is usually NOT concurrent-safe) serializes anyway or corrupts.
  Give each concurrent branch its own connection or use a pool.
- **Error semantics.** `gather` fails fast by default; the sequential code
  may have run call B even when A failed — or never reached B. Match the
  original failure behavior (`return_exceptions`, explicit try per branch).
- **Backend pressure.** Parallelizing 20 calls turns a polite client into a
  burst. Bound concurrency (semaphore) when fan-in is large.

## Verification discipline

The fresh trace must show the children's spans OVERLAPPING (start times
interleaved), the parent's wall time near the slowest child, and identical
responses — including on the error paths you can exercise.
