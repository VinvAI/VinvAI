# ADR — eBPF second trace alongside the AST/OTel trace

Status: Accepted (v1)
Date: 2026-07-01

## Context

`tracelens run` instruments a Python service **in-process**: an AST import-hook (or the
`sys.monitoring` reservation on 3.12+) plus OpenTelemetry contrib auto-instrumentation
produce function-level spans (`enter`/`exit`, `request_id`, `component`, `duration_ms`)
streamed to `trace.jsonl`. A daemon-thread sampler can additionally stream
`kind:"sample"` CPU/alloc/gc/rss events into the same file, and a determinism-capture
sidecar streams `<output>.determinism.jsonl`.

Everything above is **Python-level**. It cannot see time spent *outside* the interpreter:
off-CPU stalls (blocked on locks / IO / network), syscall latency, native page faults, or
block-IO latency. Those are exactly the questions that dominate real latency incidents, and
they are the native domain of **eBPF**.

There was no prior ADR describing whether/how to add kernel-level observability. This ADR
records the decision.

## Decision

Add an **optional, out-of-process eBPF collector** that runs *alongside* the existing
in-process tracer and emits a **second trace** to a sidecar file, mirroring the
`.determinism.jsonl` pattern. The two traces are correlated offline by `(tid, time window)`.

The AST/OTel path is **not modified**. eBPF is a sibling collector, not a change to the
tracer, because it has a fundamentally different lifecycle (privileged, out-of-process,
Linux-only) and must be able to fail independently without touching span capture.

### Two collectors, one correlated output

```
tracelens run --ebpf KINDS -- python -m myapp
   │
   ├─ AST + OTel (in-process)        → trace.jsonl              spans: request_id, component, depth, duration_ms
   ├─ sampler sidecar (threads)      → trace.jsonl              kind:"sample" (cpu/alloc/gc/rss)
   └─ eBPF collector (subprocess)    → trace.jsonl.ebpf.jsonl   kind:"ebpf"  (offcpu/syscall/pagefault/blockio)
                                             ▲ scoped to the launcher PID (os.getpid())
```

Because dispatch is `runpy` (in-process), the target runs in the launcher's own process, so
the PID the collector attaches to is simply `os.getpid()`.

### Why a separate file, not merged into `trace.jsonl`

- eBPF is high-volume (syscalls fire constantly); merging would bloat the primary trace that
  every downstream stage streams.
- The downstream loader keys on `event: enter/exit`; a separate file is zero-risk to existing
  readers.
- Different collectors have different failure modes — a crashed BPF program must not corrupt
  the span trace.

This is the same reasoning that already put determinism capture in its own sidecar.

### Sidecar event contract (`trace.jsonl.ebpf.jsonl`)

One JSON object per line:

```json
{"ts":"2026-07-01T12:00:00.123Z","kind":"ebpf","ebpf_kind":"offcpu",
 "pid":4321,"tid":4330,"comm":"python","value":152000,"unit":"ns","mono_ns":9876543210}
```

- `ts`         — wall-clock ISO-8601, stamped collector-side at read time (join axis vs spans).
- `kind`       — always `"ebpf"`.
- `ebpf_kind`  — one of `offcpu` | `syscall` | `pagefault` | `blockio`.
- `pid`,`tid`  — process / thread id from the kernel; `tid` is the correlation key.
- `comm`       — kernel task comm (best-effort).
- `value`      — kind-specific magnitude (off-CPU/syscall duration ns; faults count; IO bytes).
- `unit`       — `"ns"` | `"count"` | `"bytes"`.
- `mono_ns`    — bpftrace `nsecs` (monotonic since boot) for finer alignment later.
- kind extras  — e.g. `syscall_nr`, `ret` on `syscall` rows.

### Correlation

Join key is `(tid, wall-clock window)`:

> span `S` ran on `tid T` from `t0..t1` (from the `exit` row's `thread_id`, `ts`, and
> `duration_ms`); attach eBPF events on `tid T` whose `ts` falls in `[t0, t1]`.

`tracelens.analysis.ebpf_correlate.correlate_exits(exit_spans, ebpf_events)` returns, per
span, aggregates like `offcpu_ns`, `syscall_ns`, `syscall_count`, `pagefault_count`,
`blockio_bytes`. This lets a slow handler be explained as "blocked off-CPU on a lock" vs
"page-fault storm" vs "block-IO bound" — which the Python trace alone cannot distinguish.

**Thread-id caveat.** A span's `thread_id` is the CPython interpreter ident
(`threading.get_ident()`), which is **not** the kernel `tid` (`gettid`) bpftrace reports. So
v1 correlates by **time window only**; a `{interpreter_ident: kernel_tid}` map recorded on the
capture side (follow-up) can be passed as `tid_map` to also require a thread match.

## Graceful degradation (never break the target)

The collector is a strict no-op — logs one line, returns a `skipped` status, never raises
into the target — when any of these hold:

- not on Linux (e.g. macOS dev machines — eBPF is unavailable there),
- `bpftrace` is not on `PATH`,
- the process lacks privileges (eBPF needs root / `CAP_BPF`),
- the running kernel rejects the generated program (missing tracepoints on that kernel).

Same "degrade to AST-only" contract the `rss` sampler already uses when `psutil` is absent.

## Docker synergy

The AST hook produces **zero spans when the app runs inside Docker** (the wrapper sits
host-side, outside the container). A **host** eBPF collector filtered by the container's
PID/cgroup sees the containerized process from the host kernel — so eBPF also fills the exact
gap the in-process path has today. (v1 scopes to `os.getpid()`; container-PID scoping is a
documented follow-up.)

## Consequences

- New optional dependency at **runtime only on the host**: `bpftrace` (system package, not a
  Python dep). Absent ⇒ no-op.
- New sidecar artifact `trace.jsonl.ebpf.jsonl`; downstream consumers may ignore it safely.
- Two traces must be correlated to be useful; the correlation join is `(tid, time window)`
  and is approximate (buffering skew), acceptable for v1.
- Linux + root only; no coverage on macOS/unprivileged runs (by design, degrades cleanly).

## Alternatives considered

- **Merge eBPF events into `trace.jsonl`** — rejected: volume + blast radius on existing
  readers.
- **Replace AST tracing with eBPF** — rejected: eBPF has no Python call semantics
  (`request_id`, qualified component names) without a uprobe/symbolication layer, and is
  Linux/root-only. The two are complementary, not substitutes.
- **In-process perf via `perf_event_open`** — rejected for v1: still Linux/root, and rewriting
  what `bpftrace` already does well adds maintenance for no portability gain.

## Follow-ups (not in v1)

- Record a `{interpreter_ident: kernel_tid}` map on the capture side (via `os.gettid()` per
  thread) so correlation can join on thread identity, not just time window.
- Container-PID / cgroup scoping so the collector covers Dockerized targets.
- `syscall`/`blockio` latency programs are kernel-version sensitive; add a probe-capability
  preflight and per-kind fallbacks.
- Wire correlated aggregates into the HTML `report` and the vinv captures loader.
