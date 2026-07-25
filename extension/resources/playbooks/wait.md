# Playbook: wait (time blocked, not computing)

The evidence behind this kind: a call's wall time far exceeds its CPU time
(tracelens records `blocked_ms = wall − cpu` on every span) — the process sat
waiting on a socket, a lock, a sleep, or the scheduler. You cannot optimize a
wait by making code faster; you remove it, overlap it, or shorten its source.

## Fix patterns, in preference order

1. **Identify WHAT it waits on.** Downstream service, database, lock, sleep,
   DNS, connection setup — the trace's call path plus the blocked span names
   it. Each has a different fix; guessing wastes the episode.
2. **Overlap independent waits.** Two blocked calls with no data dependence
   should run concurrently (see `serial-async`) — waiting twice sequentially
   is the one pure waste.
3. **Reuse connections.** Per-call TCP/TLS handshakes and connection churn
   are classic hidden waits — pool and keep-alive.
4. **Shorten the downstream.** If the wait IS the downstream's latency, the
   fix lives there (its own playbook kind, its own episode) — or cache its
   answer if it repeats (see `cache`).
5. **Remove literal sleeps and polls.** Fixed `sleep(1)` retries and tight
   poll loops become event/callback waits or exponential backoff with a cap.

## Traps

- **Deliberate pacing.** Rate limits, debounces, and backoff sleeps exist to
  protect something. Removing them trades latency for outages — confirm the
  wait is accidental before deleting it.
- **Lock contention**: shrinking the critical section beats making waiters
  "faster". Look for I/O performed while holding a lock.
- **Async illusion**: `await` does not remove a wait, it only frees the
  thread. The request still takes the downstream's time — end-to-end latency
  needs overlap or removal, not just async syntax.

## Verification discipline

The fresh trace must show `blocked_ms` down on the same flow — not merely CPU
time shuffled — with responses unchanged and no new pressure downstream
(error rates, timeouts) where the wait used to throttle.
