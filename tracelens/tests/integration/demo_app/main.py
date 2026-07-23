"""Read-only third-party demo service (spec §14)."""

from __future__ import annotations

import asyncio
import random

from fastapi import FastAPI

app = FastAPI()


def db_lookup(n: int) -> str:
    import time

    time.sleep(n * 0.005)
    return f"db:{n}"


def cache_get(n: int) -> str:
    return f"cache:{n}"


@app.get("/healthy")
def healthy() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/slow/{n}")
def slow(n: int) -> dict[str, str]:
    return {"db": db_lookup(n), "cache": cache_get(n)}


@app.get("/sometimes_fails")
def sometimes_fails() -> dict[str, str]:
    if random.random() < 0.1:
        raise ValueError("random failure")
    return {"ok": "true"}


@app.get("/wrong/{n}")
def wrong(n: int) -> dict[str, int]:
    return {"expected": n * 2, "got": n + 1}


@app.get("/n_plus_one/{n}")
def n_plus_one(n: int) -> dict[str, list[str]]:
    return {"rows": [db_lookup(i) for i in range(n)]}


@app.get("/async_ping")
async def async_ping() -> dict[str, str]:
    await asyncio.sleep(0)
    return {"async": "ok"}
