"""Fixture FastAPI app — the compose `app` service, run on the host."""

from fastapi import FastAPI

app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True}
