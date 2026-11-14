import argparse
import atexit
import logging
import os
from contextlib import asynccontextmanager
import signal
import sys

import uvicorn

import otel_setup
from main import app, get_sessions_dir, load_config


class EndpointFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return "/poll" not in record.getMessage()


def main():
    parser = argparse.ArgumentParser(description="Limilink Web Server")
    parser.add_argument(
        "--port", type=int, default=None, help="Port to run the server on"
    )
    xdg_config_dirpath = os.environ.get("XDG_CONFIG_HOME", "")
    if not xdg_config_dirpath:
        xdg_config_dirpath = os.path.join(os.path.expanduser("~"), ".config")
    parser.add_argument(
        "--config",
        type=str,
        default=os.path.join(xdg_config_dirpath, "limilink", "config.sxpb"),
        help="Path to config.sxpb",
    )
    args, _ = parser.parse_known_args()

    os.environ["LIMILINK_CONFIG"] = args.config

    cfg, config_dir = load_config()

    otel_setup.init_otel("limilink-server", cfg)
    if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        try:
            from opentelemetry.instrumentation.fastapi import (
                FastAPIInstrumentor,
            )

            FastAPIInstrumentor.instrument_app(app)
        except ImportError:
            print("OpenTelemetry FastAPI instrumentation not installed.")

    port = 8000
    if cfg:
        port = int(cfg.get("port", port))

    if args.port is not None:
        port = args.port

    sessions_dir = get_sessions_dir(cfg, config_dir)
    os.makedirs(sessions_dir, exist_ok=True)
    pid_file = os.path.join(sessions_dir, "server.pid")

    def cleanup():
        try:
            with open(pid_file) as source:
                mine = source.read() == str(os.getpid())
            if mine:
                os.remove(pid_file)
        except FileNotFoundError:
            pass
        # No root-wide tmp sweep: a writer inherited across a server crash may
        # still own those files. Its execution adapter owns per-turn cleanup.

    owner_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def server_lifespan(application):
        # Claim the root BEFORE publishing a PID or changing any session state.
        async with owner_lifespan(application):
            with open(pid_file, "w") as output:
                output.write(str(os.getpid()))
            try:
                yield
            finally:
                cleanup()

    app.router.lifespan_context = server_lifespan

    atexit.register(cleanup)

    def signal_handler(signum, frame):
        cleanup()
        sys.exit(0)

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    print(f"Starting server on port {port}...")

    config = uvicorn.Config(
        "main:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        log_level="info",
        lifespan="on",
        log_config=None,
    )
    server = uvicorn.Server(config)
    logging.getLogger("uvicorn.access").addFilter(EndpointFilter())

    try:
        server.run()
    except (KeyboardInterrupt, SystemExit):
        pass
    except Exception as e:
        print(f"Server error: {e}")
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
