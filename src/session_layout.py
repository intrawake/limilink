"""Session display metadata. Directory names remain the stable session IDs."""

from __future__ import annotations

import json
import logging
import math
import os
import shutil
import time
import threading
import uuid
from pathlib import Path
from typing import Callable

from session_lease import SessionLeaseBusy, session_lease


_layout_lock = threading.Lock()
_LAYOUT_FILE = ".session-layout.json"
logger = logging.getLogger(__name__)


class InvalidSessionOrder(ValueError):
    """A caller supplied an invalid ordering, rather than damaged metadata."""


def _session_ids(root: Path) -> list[str]:
    return sorted(path.name for path in root.iterdir() if path.is_dir())


def _read(root: Path) -> dict:
    try:
        data = json.loads((root / _LAYOUT_FILE).read_text())
    except FileNotFoundError:
        return {"titles": {}, "order": [], "trash_deadlines": {}}
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("titles"), dict)
        or not isinstance(data.get("order"), list)
        or any(
            not isinstance(k, str) or not isinstance(v, str)
            for k, v in data["titles"].items()
        )
        or any(not isinstance(value, str) for value in data["order"])
    ):
        raise ValueError("Invalid session layout metadata")
    deadlines = data.setdefault("trash_deadlines", {})
    if not isinstance(deadlines, dict) or any(
        not isinstance(key, str)
        or isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        for key, value in deadlines.items()
    ):
        raise ValueError("Invalid session trash metadata")
    return data


def _prune(data: dict, live: list[str]) -> dict:
    return {
        "titles": {key: value for key, value in data["titles"].items() if key in live},
        "order": list(dict.fromkeys(key for key in data["order"] if key in live)),
        # Retain deadlines for deleted IDs as tombstones against stale send/notify.
        "trash_deadlines": data["trash_deadlines"],
    }


def _write(root: Path, data: dict):
    temporary = root / f"{_LAYOUT_FILE}.{uuid.uuid4().hex}.tmp"
    try:
        with temporary.open("x") as output:
            json.dump(data, output, ensure_ascii=False)
            output.write("\n")
        os.replace(temporary, root / _LAYOUT_FILE)
    finally:
        temporary.unlink(missing_ok=True)


def list_session_details(root: Path) -> list[dict]:
    with _layout_lock:
        live = _session_ids(root)
        data = _prune(_read(root), live)
        order = data["order"] + [key for key in live if key not in data["order"]]
        active = [key for key in order if key not in data["trash_deadlines"]]
        trashed = sorted(
            (key for key in order if key in data["trash_deadlines"]),
            key=lambda key: data["trash_deadlines"][key],
        )
        return [
            {
                "id": key,
                "title": data["titles"].get(key, key),
                **(
                    {"delete_at": data["trash_deadlines"][key]}
                    if key in trashed
                    else {}
                ),
            }
            for key in active + trashed
        ]


def rename_session(root: Path, session_id: str, title: str):
    with _layout_lock:
        live = _session_ids(root)
        if session_id not in live:
            raise FileNotFoundError(session_id)
        data = _prune(_read(root), live)
        data["titles"][session_id] = title
        _write(root, data)


def reorder_sessions(root: Path, session_ids: list[str]):
    with _layout_lock:
        live = _session_ids(root)
        if len(session_ids) != len(set(session_ids)):
            raise InvalidSessionOrder("Session order contains duplicate IDs")
        if any(key not in live for key in session_ids):
            raise FileNotFoundError("Session list changed; refresh and try again")
        data = _prune(_read(root), live)
        # Reorder active slots without losing a trashed session's Undo position.
        previous = list(dict.fromkeys(data["order"] + live))
        active_order = iter(
            dict.fromkeys(
                key
                for key in session_ids + previous
                if key not in data["trash_deadlines"]
            )
        )
        data["order"] = [
            key if key in data["trash_deadlines"] else next(active_order)
            for key in previous
        ]
        _write(root, data)


class TrashExpired(ValueError):
    """The server-side Undo deadline has passed."""


def trash_deadline(root: Path, session_id: str) -> float | None:
    with _layout_lock:
        return _read(root)["trash_deadlines"].get(session_id)


def queue_session_trash(root: Path, session_id: str, now: float | None = None) -> float:
    with _layout_lock:
        live = _session_ids(root)
        if session_id not in live:
            raise FileNotFoundError(session_id)
        data = _prune(_read(root), live)
        # Repeated taps/replays never extend the existing Undo window.
        deadline = data["trash_deadlines"].setdefault(
            session_id, (time.time() if now is None else now) + 60
        )
        _write(root, data)
        return deadline


def restore_session(root: Path, session_id: str, now: float | None = None):
    with _layout_lock:
        data = _read(root)
        deadline = data["trash_deadlines"].get(session_id)
        if deadline is not None and deadline <= (time.time() if now is None else now):
            raise TrashExpired("The Undo window has ended")
        if not (root / session_id).is_dir():
            raise FileNotFoundError(session_id)
        if deadline is not None:
            del data["trash_deadlines"][session_id]
            _write(root, _prune(data, _session_ids(root)))


def delete_session_now(root: Path, session_id: str):
    """Legacy explicit deletion. The caller must gate admission and busy checks."""
    with _layout_lock, session_lease(root, session_id, exclusive=True) as fd:
        if fd is None:
            raise SessionLeaseBusy("Session still has an active request or agent.")
        data = _read(root)
        data["trash_deadlines"][session_id] = 0
        # Persist the tombstone BEFORE irreversible removal, even on partial failure.
        _write(root, data)
        shutil.rmtree(root / session_id)
        _write(root, _prune(data, _session_ids(root)))


def has_due_trash(root: Path, now: float) -> bool:
    with _layout_lock:
        data = _read(root)
        return any(
            deadline <= now and (root / key).is_dir()
            for key, deadline in data["trash_deadlines"].items()
        )


def expire_session_trash(
    root: Path, is_busy: Callable[[str], bool], now: float | None = None
) -> list[str]:
    """Delete only due, idle sessions; retained deadlines prevent resurrection."""
    now = time.time() if now is None else now
    with _layout_lock:
        data = _read(root)
        removed = []
        for key in _session_ids(root):
            deadline = data["trash_deadlines"].get(key)
            if deadline is None or deadline > now:
                continue
            try:
                with session_lease(root, key, exclusive=True) as fd:
                    if fd is None or is_busy(key):
                        continue
                    # Commit before removal. Zero cannot become Undoable again
                    # if the wall clock moves backward after a partial failure.
                    data["trash_deadlines"][key] = 0
                    _write(root, data)
                    shutil.rmtree(root / key)
                    data = _prune(data, _session_ids(root))
                    _write(root, data)
            except OSError as exc:
                logger.warning("Could not delete trashed session %s: %s", key, exc)
                continue
            removed.append(key)
        return removed
