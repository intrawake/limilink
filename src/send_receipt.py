"""Fail-closed per-Send reservations, retained for the session's lifetime.

Exclusive creation elects one owner before chat execution. Completed HTTP
outcomes can be replayed; incomplete/corrupt records never authorize execution.
This supports process restarts, not guaranteed power-loss durability.
"""

import hashlib
import json
import os
import re
import stat
import time
import uuid
from pathlib import Path


class SendConflict(ValueError):
    """An ID was reused with a different message."""


class SendIndeterminate(ValueError):
    """A prior reservation exists but cannot safely be executed or replayed."""


def receipt_path(session: Path, request_id: str, *, create: bool = True) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", request_id):
        raise ValueError("Invalid Send ID")
    directory = session / ".web-requests"
    if create:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink():
        raise SendIndeterminate("Send receipt directory is not a regular directory")
    return directory / f"{request_id}.json"


def read_send(path: Path) -> dict:
    """Read/validate a receipt without creating or reserving anything."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        with os.fdopen(fd) as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise SendIndeterminate("Send receipt is not a regular file")
            saved = json.load(source)
    except FileNotFoundError:
        raise
    except (OSError, ValueError) as exc:
        raise SendIndeterminate(
            "Previous Send receipt is unreadable; it will not be executed again"
        ) from exc
    if (
        not isinstance(saved, dict)
        or saved.get("version") != 1
        or not isinstance(saved.get("message_sha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", saved["message_sha256"])
    ):
        raise SendIndeterminate("Previous Send receipt is invalid")
    if saved.get("state") == "complete":
        outcome = saved.get("outcome")
        if (
            not isinstance(outcome, dict)
            or not isinstance(outcome.get("status"), int)
            or not isinstance(outcome.get("body"), dict)
            or not isinstance(outcome.get("headers", {}), dict)
            or any(
                not isinstance(k, str) or not isinstance(v, str)
                for k, v in outcome.get("headers", {}).items()
            )
            or (
                outcome["status"] == 200
                and not isinstance(outcome["body"].get("reply"), str)
            )
            or (
                outcome["status"] != 200
                and not (
                    400 <= outcome["status"] <= 599 and "detail" in outcome["body"]
                )
            )
        ):
            raise SendIndeterminate("Completed Send receipt is invalid")
    elif saved.get("state") != "running":
        raise SendIndeterminate("Previous Send receipt has an unknown state")
    return saved


def reserve_send(path: Path, message: str) -> tuple[bool, dict]:
    fingerprint = hashlib.sha256(message.encode("utf-8", "surrogatepass")).hexdigest()
    record = {
        "version": 1,
        "message_sha256": fingerprint,
        "state": "running",
        "created_at": time.time(),
    }
    try:
        fd = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
        )
    except FileExistsError:
        try:
            saved = read_send(path)
        except (OSError, ValueError) as exc:
            raise SendIndeterminate("Previous Send receipt cannot be verified") from exc
        if saved["message_sha256"] != fingerprint:
            raise SendConflict("This Send ID is already bound to a different message")
        return False, saved
    # If writing is interrupted, leave even a partial reservation in place.
    # An unreadable record must never be mistaken for permission to start again.
    with os.fdopen(fd, "w") as destination:
        json.dump(record, destination)
        destination.write("\n")
    return True, record


def complete_send(path: Path, reservation: dict, outcome: dict):
    record = {
        **reservation,
        "state": "complete",
        "completed_at": time.time(),
        "outcome": outcome,
    }
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as destination:
            json.dump(record, destination)
            destination.write("\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
