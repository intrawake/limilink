#!/usr/bin/env python3
import sys
import os
import json
import urllib.request
import argparse


def load_config():
    try:
        import sxpb
    except ImportError:
        print("Warning: sxpb not found, using default port 8000.", file=sys.stderr)
        return {}

    xdg_config_dirpath = os.environ.get("XDG_CONFIG_HOME", "")
    if not xdg_config_dirpath:
        xdg_config_dirpath = os.path.join(os.path.expanduser("~"), ".config")
    config_filepath = os.environ.get(
        "LIMILINK_CONFIG", os.path.join(xdg_config_dirpath, "limilink", "config.sxpb")
    )
    if not os.path.exists(config_filepath):
        return {}
    try:
        with open(config_filepath, "r") as f:
            config_data = sxpb.loads(f.read())
            if isinstance(config_data, dict):
                return config_data
    except Exception as e:
        print(f"Error reading config: {e}", file=sys.stderr)
    return {}


def find_session_id():
    # Priority 1: Environment variable
    env_sid = os.environ.get("LIMILINK_SESSION")
    if env_sid:
        return env_sid

    def check_dir(d):
        d = os.path.abspath(d)
        while True:
            if os.path.exists(os.path.join(d, ".initialized")):
                return os.path.basename(d)
            parent = os.path.dirname(d)
            if parent == d:
                break
            d = parent
        return None

    # Check logical PWD first (preserves symlinks)
    logical_pwd = os.environ.get("PWD")
    if logical_pwd:
        sid = check_dir(logical_pwd)
        if sid:
            return sid

    # Check physical PWD
    sid = check_dir(os.getcwd())
    if sid:
        return sid

    # Check executable path next
    sid = check_dir(os.path.dirname(os.path.abspath(sys.argv[0])))
    if sid:
        return sid

    return None


def main():
    parser = argparse.ArgumentParser(description="Notify a Limilink session.")
    parser.add_argument(
        "message",
        nargs="*",
        help="The message to send. If not provided, reads from stdin.",
    )
    args = parser.parse_args()

    session_id = find_session_id()
    if not session_id:
        print(
            "Error: Could not determine session_id from PWD or executable path.",
            file=sys.stderr,
        )
        sys.exit(1)

    message = " ".join(args.message)
    if not message:
        message = sys.stdin.read().strip()

    if not message:
        print("Error: No message provided.", file=sys.stderr)
        sys.exit(1)

    cfg = load_config()
    port = int(cfg.get("port", 8000))

    url = f"http://localhost:{port}/sessions/{session_id}/notifyme"
    data = json.dumps({"message": message}).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )

    try:
        with urllib.request.urlopen(req) as response:
            res_data = response.read()
            print(f"Notification successful: {res_data.decode('utf-8')}")
    except Exception as e:
        print(f"Failed to send notification to {url}: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
