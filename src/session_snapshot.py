"""Read-only canonical history snapshots and bounded offscreen reply evidence."""

from collections import OrderedDict
import hashlib
import json
from pathlib import Path
import stat
import threading
import time

CACHE_LIMIT = 256
REPLY_HISTORY_LIMIT = 8 * 1024 * 1024
FILE_RECHECK_SECONDS = 30
_cache_lock = threading.Lock()
_reply_cache: OrderedDict[str, dict] = OrderedDict()
_file_cache: OrderedDict[Path, tuple[tuple, float, dict]] = OrderedDict()


def _history(raw: bytes) -> list[dict]:
    history = json.loads(raw)
    if not isinstance(history, list) or any(
        not isinstance(item, dict)
        or not isinstance(item.get("role"), str)
        or not isinstance(item.get("content"), str)
        for item in history
    ):
        raise ValueError("Invalid conversation history")
    return history


def _remember(cache: OrderedDict, key, value):
    with _cache_lock:
        cache[key] = value
        cache.move_to_end(key)
        while len(cache) > CACHE_LIMIT:
            cache.popitem(last=False)


def reply_evidence(history: list[dict], revision: str) -> dict:
    """Identify a current bot-reply occurrence, not a durable completion event."""
    with _cache_lock:
        if revision in _reply_cache:
            _reply_cache.move_to_end(revision)
            return _reply_cache[revision].copy()
    index = next(
        (i for i in range(len(history) - 1, -1, -1) if history[i]["role"] == "bot"),
        None,
    )
    token = None
    if index is not None:
        digest = hashlib.sha256(b"limilink-canonical-reply-v1\0")
        for position, item in enumerate(history[: index + 1]):
            pair = json.dumps(
                [item["role"], item["content"]],
                separators=(",", ":"),
                ensure_ascii=True,
            )
            digest.update(f"{position}:".encode("ascii"))
            digest.update(pair.encode("ascii"))
            digest.update(b"\n")
        token = "r1:" + digest.hexdigest()
    result = {"state": "known", "token": token, "index": index}
    _remember(_reply_cache, revision, result)
    return result.copy()


def history_snapshot(
    path: Path, revision: str | None = None, *, with_reply: bool = False
) -> dict:
    before = None
    if with_reply:
        try:
            before = _signature(path)
        except (OSError, ValueError):
            pass
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        raw = b"[]"
    history = _history(raw)
    digest = hashlib.sha256(raw).hexdigest()
    result: dict = {"revision": digest}
    if revision != digest:
        result["history"] = history
    if with_reply:
        result["reply"] = reply_evidence(history, digest)
        if before is not None:
            try:
                if _signature(path) == before:
                    _remember(
                        _file_cache,
                        path,
                        (before, time.monotonic(), result["reply"].copy()),
                    )
            except (OSError, ValueError):
                pass
    return result


def _signature(path: Path) -> tuple:
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Not a regular history file")
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def cached_reply_evidence(path: Path) -> dict:
    """No side effects, global lifecycle lock, or unbounded history read."""
    unknown = {"state": "unknown"}
    before = None
    try:
        before = _signature(path)
        now = time.monotonic()
        with _cache_lock:
            cached = _file_cache.get(path)
            # Atomic application writes change inode. Periodic rechecks also cover
            # same-size external writes on filesystems with coarse timestamps.
            if (
                cached is not None
                and cached[0] == before
                and now - cached[1] < FILE_RECHECK_SECONDS
            ):
                _file_cache.move_to_end(path)
                return cached[2].copy()
        result = unknown
        if before[2] <= REPLY_HISTORY_LIMIT:
            with path.open("rb") as source:
                raw = source.read(REPLY_HISTORY_LIMIT + 1)
            if len(raw) > REPLY_HISTORY_LIMIT or _signature(path) != before:
                return unknown
            try:
                history = _history(raw)
            except ValueError:
                pass
            else:
                result = reply_evidence(history, hashlib.sha256(raw).hexdigest())
        _remember(_file_cache, path, (before, now, result))
        return result.copy()
    except FileNotFoundError:
        # An existing, newly created session need not have a history file yet.
        if before is None and path.parent.is_dir():
            return {"state": "known", "token": None, "index": None}
        return unknown
    except (OSError, ValueError):
        return unknown
