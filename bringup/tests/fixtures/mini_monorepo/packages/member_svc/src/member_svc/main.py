"""Nested workspace member's own service — a console-script uvicorn server."""

from fastapi import FastAPI

app = FastAPI()


@app.get("/member")
def member():
    return {"member": True}


def run() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8201)
