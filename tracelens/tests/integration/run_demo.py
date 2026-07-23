"""Launch demo FastAPI app under tracelens runpy (spec §14 — avoids execvp-only uvicorn)."""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.environ.get("TRACELENS_DEMO_HOST", "127.0.0.1")
    port = int(os.environ.get("TRACELENS_DEMO_PORT", "8765"))
    uvicorn.run(
        "demo_app.main:app",
        host=host,
        port=port,
        log_level=os.environ.get("TRACELENS_DEMO_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
