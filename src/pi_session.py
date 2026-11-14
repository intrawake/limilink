"""Bounded, read-only identity selection for an existing Pi continuation."""

import json
import os
from pathlib import Path
import re
import stat


def continued_session_identity(owner: Path) -> tuple[Path, str] | None:
    """Pin an unambiguous cwd-matching journal, or keep native discovery.

    The host holds its execution fence. Match the stock SDK's mtime selection;
    ambiguous/unreadable metadata never authorizes an observer for another file.
    No journal loading, migration, creation or transcript-body reads occur here.
    """
    directory = owner / ".pi/agent/session"
    for ancestor in (owner / ".pi", owner / ".pi/agent", directory):
        if ancestor.is_symlink():
            return None
    try:
        candidates = []
        for path in directory.glob("*.jsonl"):
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, "rb") as source:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode):
                        return None
                    line = source.readline(1024 * 1024 + 1)
                if len(line) > 1024 * 1024:
                    return None
                header = json.loads(line)
                if not isinstance(header, dict) or header.get("type") != "session":
                    return None
                cwd, identity = header.get("cwd"), header.get("id")
                if (
                    not isinstance(cwd, str)
                    or not os.path.isabs(cwd)
                    or not isinstance(identity, str)
                ):
                    return None
                if os.path.normpath(cwd) != str(owner):
                    continue
                seconds, nanos = divmod(info.st_mtime_ns, 1_000_000_000)
                candidates.append((seconds * 1000 + nanos / 1_000_000, path, identity))
            except (OSError, ValueError):
                return None
        if not candidates:
            return None
        candidates.sort(reverse=True)
        if len(candidates) > 1 and candidates[0][0] == candidates[1][0]:
            return None
        _, path, identity = candidates[0]
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identity):
            return None
        return path, identity
    except OSError:
        return None
