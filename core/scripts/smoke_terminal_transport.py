"""Live smoke of the terminal transport through the PUBLIC tool layer.

Exercises the exact incident patterns end-to-end (auto-init -> pexpect backend
-> _bounded_output digesting), printing PASS/FAIL per scenario. Run:

    .venv/bin/python scripts/smoke_terminal_transport.py
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

os.environ.setdefault("VINV_ENGINE_TERMINAL_MIN_BLOCK_BUDGET_S", "3")

from core.components.tools.terminal.terminal_tools import (  # noqa: E402
    close_terminal,
    get_incremental_output,
    send_terminal_command,
)

FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")
    if not ok:
        FAILURES.append(name)


def main() -> int:
    # 1. Exact completion: fast command with a huge budget returns immediately.
    t0 = time.monotonic()
    r = send_terminal_command(keystrokes="echo smoke_hello", duration=600, block=True)
    dt = time.monotonic() - t0
    check(
        "exact completion (600s budget, instant return)",
        r.get("status") == "success" and r.get("exit_code") == 0
        and "smoke_hello" in r.get("output", "") and dt < 10,
        f"dt={dt:.2f}s exit={r.get('exit_code')}",
    )

    # 2. RCA killer: multiline strict-mode script whose pipeline gets SIGPIPE.
    script = "set -euo pipefail\nseq 1 200000 | head -2\necho after_head"
    r = send_terminal_command(keystrokes=script, duration=60, block=True)
    check(
        "multiline pipefail+head survives (child bash)",
        r.get("status") == "success" and r.get("completed") is True,
        f"exit={r.get('exit_code')}",
    )
    r = send_terminal_command(keystrokes="echo session_alive", duration=30, block=True)
    check("session alive after killer script", "session_alive" in r.get("output", ""))

    # 3. Flood: 300k lines -> full artifact + bounded digest, session survives.
    r = send_terminal_command(keystrokes="seq 1 300000", duration=120, block=True)
    digested = bool(r.get("output_log"))
    check(
        "flood output digested to artifact",
        r.get("status") == "success" and digested,
        f"log={r.get('output_log')} tokens_full={r.get('output_tokens_full')}",
    )
    if digested:
        check("artifact exists on disk", os.path.isfile(r["output_log"]))
    r = send_terminal_command(keystrokes="echo post_flood", duration=30, block=True)
    check("session alive after flood", "post_flood" in r.get("output", ""))

    # 4. Overrun: sleep beyond budget -> timeout, interrupted, session usable.
    t0 = time.monotonic()
    r = send_terminal_command(keystrokes="sleep 60", duration=2, block=True)
    dt = time.monotonic() - t0
    check(
        "overrun interrupted (no deadlock)",
        r.get("status") == "timeout" and dt < 20
        and r.get("session_reinitialized") is not True,
        f"dt={dt:.2f}s",
    )
    r = send_terminal_command(keystrokes="echo recovered", duration=30, block=True)
    check("session usable after interrupt", "recovered" in r.get("output", ""))

    # 5. Busy detection: fg daemon-ish job, then a blocking command is refused.
    r = send_terminal_command(keystrokes="sleep 3", duration=1, block=False)
    check("nonblocking launch returns early", r.get("status") == "success")
    r = send_terminal_command(keystrokes="echo should_wait", duration=5, block=True)
    check(
        "busy shell refuses blocking command (typed error, nothing killed)",
        r.get("status") == "error" and "terminal_busy" in (r.get("error") or ""),
    )
    time.sleep(3.2)
    get_incremental_output()
    r = send_terminal_command(keystrokes="echo free_again", duration=30, block=True)
    check("session free after fg job exits", "free_again" in r.get("output", ""))

    # 6. cwd persistence for inline single-line commands.
    send_terminal_command(keystrokes="cd /tmp", duration=30, block=True)
    r = send_terminal_command(keystrokes="pwd", duration=30, block=True)
    check("cd persists across calls", "tmp" in r.get("output", ""))

    close_terminal()
    print()
    if FAILURES:
        print(f"SMOKE FAILED: {len(FAILURES)} scenario(s): {FAILURES}")
        return 1
    print("SMOKE OK: all scenarios passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
