#!/usr/bin/env python3
"""Copy a local image/audio file into the current Limilink session's pinned shelf."""

import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import re
import stat
import sys
from urllib.parse import quote, urlencode, urlsplit
import urllib.request
import uuid

try:
    from .notifyme import find_session_id, load_config
except ImportError:
    from notifyme import find_session_id, load_config

MAX_BYTES = 64 * 1024**2


class SizedReader:
    """Never send beyond the fstat-sized file if another process appends to it."""

    def __init__(self, source, size):
        self.source, self.remaining = source, size

    def read(self, count=-1):
        if count == 0 or not self.remaining:
            return b""
        data = self.source.read(
            self.remaining if count < 0 else min(count, self.remaining)
        )
        if not data:
            raise OSError("Source file shortened during upload")
        self.remaining -= len(data)
        return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument(
        "--session", help="Canonical session ID (default: current session)"
    )
    parser.add_argument(
        "--publication-id",
        help="Explicit 32-hex identity for deliberate reuse; never retried automatically",
    )
    parser.add_argument(
        "--server", help="Loopback API base URL (default: configured local port)"
    )
    args = parser.parse_args(argv)
    try:
        sid = args.session or find_session_id()
        if not sid or any(not (char.isalnum() or char in "-_") for char in sid):
            raise ValueError(
                "Choose a canonical --session or run inside a Limilink session"
            )
        rid = args.publication_id or uuid.uuid4().hex
        if not re.fullmatch(r"[0-9a-f]{32}", rid):
            raise ValueError(
                "--publication-id must be 32 lowercase hexadecimal characters"
            )
        server = (
            args.server or f"http://127.0.0.1:{int(load_config().get('port', 8000))}"
        )
        parsed = urlsplit(server)
        if (
            parsed.scheme not in ("http", "https")
            or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path not in ("", "/")
        ):
            raise ValueError(
                "--server must address the local loopback API, not an external upload service"
            )
        path = f"/sessions/{quote(sid, safe='')}/media/{rid}"
        with ExitStack() as resources:
            fd = os.open(args.file, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
            resources.callback(os.close, fd)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_BYTES:
                raise ValueError(
                    "Choose a nonempty regular media file of at most 64 MiB"
                )
            source = resources.enter_context(os.fdopen(fd, "rb", closefd=False))
            url = (
                server.rstrip("/")
                + path
                + "?"
                + urlencode({"filename": args.file.name})
            )
            # Print/flush identity BEFORE transport. Response loss must be observed,
            # never resolved by silently selecting a new publication ID or retrying.
            print(
                f"Publication ID: {rid}\nObserve: GET {path}",
                file=sys.stderr,
                flush=True,
            )
            request = urllib.request.Request(
                url,
                data=SizedReader(source, info.st_size),
                method="PUT",
                headers={
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(info.st_size),
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=125) as response:
                    raw = response.read(16385)
                if len(raw) > 16384:
                    raise ValueError("Oversized upload response")
                result = json.loads(raw)["media"]
                if (
                    not isinstance(result, dict)
                    or result.get("id") != rid
                    or result.get("session_id") != sid
                    or result.get("size") != info.st_size
                    or result.get("url") != path + "/content"
                ):
                    raise ValueError("Upload response does not match this publication")
                print(json.dumps(result, ensure_ascii=True))
                return 0
            except (OSError, ValueError, KeyError, TypeError) as exc:
                print(
                    f"Upload not confirmed: {exc}\nObserve GET {path} before any explicit retry. Absence is not final while an earlier request may still commit. No automatic retry was made.",
                    file=sys.stderr,
                )
                return 1
    except (OSError, ValueError) as exc:
        print(f"Media upload refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
