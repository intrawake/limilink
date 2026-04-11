import argparse
import uvicorn
import sys
import os
import atexit
import signal
import logging
from main import load_config, get_sessions_dir


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
    args, unknown = parser.parse_known_args()

    os.environ["LIMILINK_CONFIG"] = args.config

    cfg, config_dir = load_config()

    port = 8000
    if cfg:
        port = int(cfg.get("port", port))

    if args.port is not None:
        port = args.port

    sessions_dir = get_sessions_dir(cfg, config_dir)
    os.makedirs(sessions_dir, exist_ok=True)
    pid_file = os.path.join(sessions_dir, "server.pid")

    with open(pid_file, "w") as f:
        f.write(str(os.getpid()))

    def cleanup():
        if os.path.exists(pid_file):
            os.remove(pid_file)

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
        lifespan="off",
    )
    server = uvicorn.Server(config)
    logging.getLogger("uvicorn.access").addFilter(EndpointFilter())

    try:
        server.run()
    except (KeyboardInterrupt, SystemExit):
        pass
    except Exception:
        import traceback

        traceback.print_exc()
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
