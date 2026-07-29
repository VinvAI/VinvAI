"""vinv-embedder CLI: serve | warmup | status."""

from __future__ import annotations

import argparse
import errno
import json
import os
import signal
import sys
import threading
import urllib.error
import urllib.request

from . import __version__, config


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="vinv-embedder",
        description="Local embedding sidecar for the Vinv index engine",
    )
    p.add_argument("--version", action="version", version=f"vinv-embedder {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="start the embeddings server (127.0.0.1 only)")
    serve.add_argument("--port", type=int, default=config.DEFAULT_PORT)
    serve.add_argument("--model", default=config.DEFAULT_MODEL)
    serve.add_argument("--device", default="auto", help="auto | cuda | mps | cpu")

    warmup = sub.add_parser("warmup", help="download the model (with progress) and exit")
    warmup.add_argument("--model", default=config.DEFAULT_MODEL)

    status = sub.add_parser("status", help="query a running server's /health")
    status.add_argument("--port", type=int, default=config.DEFAULT_PORT)

    return p


def _cmd_serve(args: argparse.Namespace) -> int:
    config.apply_cache_env()
    # Single instance per port: a half-alive second server (e.g. one binding
    # IPv6 while an old process holds IPv4) silently splits traffic and doubles
    # model memory — refuse loudly instead.
    try:
        with urllib.request.urlopen(
            f"http://{config.BIND_HOST}:{args.port}/health", timeout=3
        ) as resp:
            if json.loads(resp.read()).get("status") == "ok":
                print(
                    f"vinv-embedder already serving on port {args.port} — reusing it. "
                    "Stop it first to change model/device.",
                    file=sys.stderr,
                )
                return 0
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        pass  # nothing healthy there — proceed to bind
    # Heavy imports deferred so `status`/`--help` stay fast.
    from .engine import EmbeddingEngine, logger
    from .server import make_server

    # First serve on a machine without a tune verdict: benchmark the real
    # model on every available device first (the static cuda>mps>cpu guess can
    # be badly wrong — see engine.tune). Explicit --device/env skips this.
    if (
        args.device == "auto"
        and not os.environ.get("VINV_EMBED_DEVICE", "").strip()
        and config.read_tuned() is None
    ):
        from .engine import tune

        logger.info("no tune verdict yet — benchmarking devices once (this takes ~a minute)")
        try:
            tune(args.model)
        except Exception as exc:
            logger.warning("auto-tune failed (%s); continuing with the static device order", exc)

    engine = EmbeddingEngine(model_name=args.model, device=args.device)

    # Bind BEFORE loading the model. Loading is minutes long on CPU, and while
    # nothing is listening there is no way for anyone — another VS Code window,
    # the extension's health probe, a second `serve` — to tell "still coming
    # up" from "not running at all". Every one of them would conclude the
    # latter and start yet another server, each loading its own copy of the
    # model and making the machine slower. Binding first fixes both halves:
    # startup becomes observable (/health answers 503 `loading`), and the
    # socket becomes the single-instance lock, so a loser fails fast here
    # instead of racing.
    try:
        server = make_server(args.port, engine)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE and getattr(exc, "winerror", 0) != 10048:
            raise
        print(
            f"vinv-embedder: port {args.port} is already held by another instance "
            "— reusing it rather than loading a second copy of the model.",
            file=sys.stderr,
        )
        return 0

    stop = threading.Event()

    def _shutdown(signum: int, _frame: object) -> None:
        logger.info("received signal %d; shutting down", signum)
        # shutdown() must not be called from the thread running serve_forever
        threading.Thread(target=server.shutdown, daemon=True).start()
        stop.set()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    # serve_forever moves to its own thread so /health can answer throughout
    # the load below, which now runs on the main thread.
    threading.Thread(target=server.serve_forever, daemon=True, name="vinv-embedder-http").start()
    logger.info(
        "listening on http://%s:%d — loading model %s on %s (health reports 503 until ready)",
        config.BIND_HOST,
        args.port,
        engine.model_name,
        engine.device,
    )
    try:
        engine.load()  # first run shows HF download progress on stderr
        logger.info(
            "ready on http://%s:%d (model=%s, device=%s, batch=%d, workers=%d)",
            config.BIND_HOST,
            args.port,
            engine.model_name,
            engine.device,
            engine.batch_size,
            engine.workers,
        )
        stop.wait()
    finally:
        server.shutdown()
        server.server_close()
        engine.close()
        logger.info("shutdown complete")
    return 0


def _cmd_warmup(args: argparse.Namespace) -> int:
    config.apply_cache_env()
    from huggingface_hub import snapshot_download

    revision = config.revision_for(args.model)
    print(
        f"downloading {args.model} (revision={revision or 'latest'}) "
        f"into {config.models_dir()} ...",
        file=sys.stderr,
    )
    config.models_dir().mkdir(parents=True, exist_ok=True)
    path = snapshot_download(
        repo_id=args.model,
        revision=revision,
        cache_dir=str(config.models_dir()),
    )
    print(f"model ready at {path}", file=sys.stderr)
    from .engine import tune

    print("auto-tuning: benchmarking the model on each available device ...", file=sys.stderr)
    verdict = tune(args.model)
    print(
        f"tuned: {verdict['device']} @ {verdict['texts_per_s']} texts/s "
        f"(all: {verdict['all']}) -> {config.tuned_path()}",
        file=sys.stderr,
    )
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    url = f"http://{config.BIND_HOST}:{args.port}/health"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            body = json.loads(resp.read())
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        print(f"vinv-embedder not reachable at {url}: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(body, indent=2))
    return 0 if body.get("status") == "ok" else 1


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "serve":
        return _cmd_serve(args)
    if args.command == "warmup":
        return _cmd_warmup(args)
    if args.command == "status":
        return _cmd_status(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
