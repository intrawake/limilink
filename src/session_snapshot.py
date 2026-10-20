"""Non-destructive snapshots of the history actually stored on disk."""

import hashlib
import json
from pathlib import Path


def history_snapshot(path: Path, revision: str | None = None) -> dict:
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        raw = b"[]"
    history = json.loads(raw)
    if not isinstance(history, list) or any(
        not isinstance(item, dict)
        or not isinstance(item.get("role"), str)
        or not isinstance(item.get("content"), str)
        for item in history
    ):
        raise ValueError("Invalid conversation history")
    digest = hashlib.sha256(raw).hexdigest()
    result: dict = {"revision": digest}
    if revision != digest:
        result["history"] = history
    return result
