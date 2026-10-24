from __future__ import annotations

import aiofiles
import asyncio
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import time
import threading
import uuid
from contextlib import ExitStack, asynccontextmanager, contextmanager, suppress
from enum import Enum
from pathlib import Path
from typing import Any

import sxpb

try:
    from opentelemetry import trace

    tracer = trace.get_tracer("limilink")
except ImportError:
    tracer = None

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, field_validator

from session_layout import (
    InvalidSessionOrder,
    TrashExpired,
    delete_session_now,
    expire_session_trash,
    has_due_trash,
    list_session_details,
    queue_session_trash,
    rename_session,
    reorder_sessions,
    restore_session,
    trash_deadline,
)

from compact_rpc import CompactRPCError, compact_rpc
from session_lease import SessionLeaseBusy, pi_lease_command, session_lease
from session_snapshot import cached_reply_evidence, history_snapshot
from session_activity import activity_snapshot
from send_receipt import (
    SendConflict,
    SendIndeterminate,
    complete_send,
    receipt_path,
    read_send,
    reserve_send,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def app_lifespan(app: FastAPI):
    sweep_session_trash()
    worker = asyncio.create_task(trash_worker())
    try:
        yield
    finally:
        worker.cancel()
        with suppress(asyncio.CancelledError):
            await worker


app = FastAPI(lifespan=app_lifespan)


class HarnessType(str, Enum):
    PI = "pi"

    @classmethod
    def from_str(cls, value: str) -> HarnessType:
        if value in ("pi", "pi-agent"):
            return cls.PI
        raise ValueError(f"Unsupported harness type: {value}")


# Global tracker for running agent harness processes (session_id -> process)
running_processes: dict[str, asyncio.subprocess.Process] = {}
session_locks: dict[str, asyncio.Lock] = {}
lifecycle_gate = threading.RLock()
session_activity: dict[tuple[str, str], int] = {}
active_web_sends: dict[tuple[str, str, str], asyncio.Future[dict]] = {}


def session_is_busy(root: Path, session_id: str) -> bool:
    lock = session_locks.get(session_id)
    return (
        session_activity.get((str(root.resolve()), session_id), 0) > 0
        or session_id in running_processes
        or (lock is not None and lock.locked())
    )


@contextmanager
def session_admission(root: Path, session_id: str):
    key = (str(root.resolve()), session_id)
    with ExitStack() as stack:
        with lifecycle_gate:
            try:
                deadline = trash_deadline(root, session_id)
            except (OSError, ValueError) as exc:
                raise HTTPException(
                    status_code=500, detail="Could not verify session trash state."
                ) from exc
            if deadline is not None:
                raise HTTPException(
                    status_code=409,
                    detail="Session is in trash. Undo before its deadline to continue.",
                )
            fd = stack.enter_context(session_lease(root, session_id))
            if fd is None:
                raise HTTPException(status_code=409, detail="Session is being deleted.")
            session_activity[key] = session_activity.get(key, 0) + 1
        try:
            yield fd
        finally:
            with lifecycle_gate:
                session_activity[key] -= 1
                if not session_activity[key]:
                    del session_activity[key]


def sweep_session_trash():
    try:
        cfg, config_dir = load_config()
        root = Path(get_sessions_dir(cfg, config_dir))
        now = time.time()
        with lifecycle_gate:
            if root.is_dir() and has_due_trash(root, now):
                expire_session_trash(root, lambda key: session_is_busy(root, key), now)
    except (OSError, ValueError):
        logger.exception("Trash cleanup failed; queued state is retained.")


async def trash_worker():
    while True:
        await asyncio.sleep(1)
        sweep_session_trash()


def get_session_lock(session_id: str) -> asyncio.Lock:
    if session_id not in session_locks:
        session_locks[session_id] = asyncio.Lock()
    return session_locks[session_id]


def _add_activity_observer(args: list[str], env: dict[str, str], session_path: str):
    """Bind both normal and compact invocations after configurable env merges."""
    bridge = Path(__file__).resolve().parent.parent / "tool" / "activity-bridge.mjs"
    args.extend(["--extension", str(bridge)])
    owner = Path(session_path).resolve()
    env["LIMILINK_ACTIVITY_PATH"] = str(owner / ".activity.json")
    env["LIMILINK_ACTIVITY_OWNER_CWD"] = str(owner)
    env["LIMILINK_ACTIVITY_SESSION_DIR"] = str(owner / ".pi" / "agent" / "session")


# Base directory for isolated sessions


class ChatRequest(BaseModel):
    message: str
    session_id: str
    request_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")


class ChatResponse(BaseModel):
    reply: str


class NotifymeRequest(BaseModel):
    message: str


class PollResponse(BaseModel):
    messages: list[str]


class SessionListResponse(BaseModel):
    sessions: list[str]


def sanitize_session_id(session_id: str) -> str:
    safe = "".join(c for c in session_id if c.isalnum() or c in ("-", "_"))
    return safe if safe else "session_fallback"


def load_config() -> tuple[dict[Any, Any], str]:
    xdg_config_dirpath = os.environ.get("XDG_CONFIG_HOME", "")
    if not xdg_config_dirpath:
        xdg_config_dirpath = os.path.join(os.path.expanduser("~"), ".config")
    config_filepath = os.environ.get(
        "LIMILINK_CONFIG", os.path.join(xdg_config_dirpath, "limilink", "config.sxpb")
    )
    config_dirpath = os.path.dirname(config_filepath)
    if not os.path.exists(config_filepath):
        return {}, config_dirpath
    with open(config_filepath, "r") as f:
        config_data = sxpb.loads(f.read())
        if not isinstance(config_data, dict):
            print(f"Expected a toplevel mesg while reading config: {config_filepath}")
            return {}, config_dirpath
        return config_data, config_dirpath


def global_env_dict(cfg: dict[Any, Any]) -> dict[str, str]:
    """Resolve the global environment shared by every spawned agent."""
    env: dict[str, str] = {}
    cfg_env_dict = cfg.get("env_dict", {})
    if isinstance(cfg_env_dict, dict):
        for name, value in cfg_env_dict.items():
            if isinstance(value, str):
                env[name] = value
    return env


def get_sessions_dir(cfg: dict[Any, Any], config_dir: str) -> str:
    env_sessions_dir = os.environ.get("LIMILINK_SESSIONS_DIR")
    if env_sessions_dir:
        return os.path.abspath(env_sessions_dir)

    session_dirpath = cfg.get("session_dirpath")
    if session_dirpath:
        session_dirpath = os.path.expanduser(session_dirpath)
        if not os.path.isabs(session_dirpath):
            session_dirpath = os.path.normpath(
                os.path.join(config_dir, session_dirpath)
            )
        return session_dirpath
    # Default to "session" in the project root (assumed to be parent of src)
    return os.path.join(os.path.dirname(__file__), "..", "session")


def get_session_tmp_dir(session_path: str) -> str:
    """Return the per-session tmp directory path."""
    return os.path.join(session_path, "tmp")


def enqueue_unread_message(session_path: str, message: str):
    unread_path = os.path.join(session_path, "unread.json")
    try:
        if os.path.exists(unread_path):
            with open(unread_path, "r") as f:
                messages = json.load(f)
        else:
            messages = []
    except Exception:
        messages = []
    messages.append(message)
    with open(unread_path, "w") as f:
        json.dump(messages, f)


def dequeue_unread_messages(session_path: str) -> list[str]:
    unread_path = os.path.join(session_path, "unread.json")
    try:
        if os.path.exists(unread_path):
            with open(unread_path, "r") as f:
                messages = json.load(f)
            os.remove(unread_path)
            return messages
    except Exception:
        logger.debug("Failed to mark message as read", exc_info=True)
    return []


def resolve_config_path(path: str, config_dir: str) -> str:
    expanded = os.path.expanduser(path)
    if os.path.isabs(expanded):
        return expanded
    return os.path.normpath(os.path.join(config_dir, expanded))


def _absolute_link_target(link_path: str) -> str:
    target = os.readlink(link_path)
    if not os.path.isabs(target):
        target = os.path.join(os.path.dirname(link_path), target)
    return os.path.normpath(target)


def reconcile_session_symlinks(
    session_path: str,
    cfg: dict[Any, Any],
    config_dir: str,
    agent_alias: str | None,
):
    """Create global links and safely replace links owned by agent presets."""
    global_symlinks = cfg.get("session_symlink_dict", {})
    if not isinstance(global_symlinks, dict):
        global_symlinks = {}

    agent_by_alias = cfg.get("agent_by_alias", {})
    if not isinstance(agent_by_alias, dict):
        agent_by_alias = {}

    agent_symlinks_by_alias: dict[str, dict[Any, Any]] = {}
    managed_targets_by_relpath: dict[str, set[str]] = {}
    for alias, preset in agent_by_alias.items():
        if not isinstance(preset, dict):
            continue
        agent_symlinks = preset.get("session_symlink_dict", {})
        if not isinstance(agent_symlinks, dict):
            continue
        agent_symlinks_by_alias[str(alias)] = agent_symlinks
        for relpath, target in agent_symlinks.items():
            managed_targets_by_relpath.setdefault(str(relpath), set()).add(
                resolve_config_path(str(target), config_dir)
            )

    # Global-only links are additive. Limilink never replaces an unrelated path.
    for relpath, target in global_symlinks.items():
        relpath = str(relpath)
        if relpath in managed_targets_by_relpath:
            continue
        link_path = os.path.join(session_path, relpath)
        if os.path.lexists(link_path):
            continue
        try:
            os.makedirs(os.path.dirname(link_path), exist_ok=True)
            os.symlink(resolve_config_path(str(target), config_dir), link_path)
        except Exception as e:
            print(f"Failed to create symlink {link_path}: {e}")

    for relpath, target in global_symlinks.items():
        relpath = str(relpath)
        if relpath in managed_targets_by_relpath:
            managed_targets_by_relpath[relpath].add(
                resolve_config_path(str(target), config_dir)
            )

    selected_symlinks = agent_symlinks_by_alias.get(agent_alias or "", {})
    for relpath, managed_targets in managed_targets_by_relpath.items():
        selected_target = selected_symlinks.get(relpath, global_symlinks.get(relpath))
        desired_target = (
            resolve_config_path(str(selected_target), config_dir)
            if selected_target is not None
            else None
        )
        link_path = os.path.join(session_path, relpath)

        if not os.path.lexists(link_path):
            if desired_target is not None:
                try:
                    os.makedirs(os.path.dirname(link_path), exist_ok=True)
                    os.symlink(desired_target, link_path)
                except Exception as e:
                    print(f"Failed to create symlink {link_path}: {e}")
            continue

        if os.path.islink(link_path):
            current_target = _absolute_link_target(link_path)
            if current_target == desired_target:
                continue
            if current_target not in managed_targets:
                print(f"Refusing to replace unmanaged symlink: {link_path}")
                continue

        try:
            if desired_target is None:
                os.unlink(link_path)
            else:
                # os.replace atomically overwrites managed links and regular files.
                # The latter handles empty auth.json files created by pi-agent.
                replacement_path = f"{link_path}.limilink-{uuid.uuid4().hex}"
                try:
                    os.symlink(desired_target, replacement_path)
                    os.replace(replacement_path, link_path)
                finally:
                    if os.path.lexists(replacement_path):
                        os.unlink(replacement_path)
        except Exception as e:
            print(f"Failed to reconcile symlink {link_path}: {e}")


def ensure_session_initialized(
    session_path: str,
    cfg: dict[Any, Any],
    config_dir: str,
    agent_alias: str | None = None,
):
    init_marker = os.path.join(session_path, ".initialized")
    if os.path.exists(init_marker):
        return

    os.makedirs(os.path.join(session_path, "outbox"), exist_ok=True)
    os.makedirs(os.path.join(session_path, ".pi", "agent"), exist_ok=True)
    reconcile_session_symlinks(session_path, cfg, config_dir, agent_alias)

    with open(init_marker, "a"):
        pass


@app.get("/sessions", response_model=SessionListResponse)
async def list_sessions():
    cfg, config_dir = load_config()
    sessions_dir = get_sessions_dir(cfg, config_dir)
    os.makedirs(sessions_dir, exist_ok=True)
    try:
        sessions = []
        if os.path.exists(sessions_dir):
            for entry in os.listdir(sessions_dir):
                if os.path.isdir(os.path.join(sessions_dir, entry)):
                    sessions.append(entry)
        return {"sessions": sorted(sessions)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class SessionTitleRequest(BaseModel):
    title: str = Field(min_length=1, max_length=160)

    @field_validator("title", mode="before")
    @classmethod
    def trim_title(cls, value: Any):
        return value.strip() if isinstance(value, str) else value


class SessionOrderRequest(BaseModel):
    session_ids: list[str]


def session_layout_root() -> Path:
    cfg, config_dir = load_config()
    root = Path(get_sessions_dir(cfg, config_dir))
    root.mkdir(parents=True, exist_ok=True)
    return root


@app.get("/session-sidebar")
async def session_sidebar():
    try:
        return {
            "sessions": list_session_details(session_layout_root()),
            "server_time": time.time(),
        }
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=500, detail="Could not read session titles and order."
        ) from exc


@app.get("/session-replies")
def session_replies(session_id: list[str] = Query(min_length=1, max_length=8)):
    """Bounded, read-only offscreen evidence; blocking file work stays off-loop."""
    if any(
        not key or len(key) > 255 or key != sanitize_session_id(key)
        for key in session_id
    ):
        raise HTTPException(status_code=400, detail="Invalid session ID")
    cfg, config_dir = load_config()
    root = Path(get_sessions_dir(cfg, config_dir))
    replies = {}
    for key in dict.fromkeys(session_id):
        path = root / key
        replies[key] = (
            cached_reply_evidence(path / "chat_history.json")
            if path.is_dir()
            else {"state": "unknown"}
        )
    return JSONResponse({"replies": replies}, headers={"Cache-Control": "no-store"})


@app.post("/sessions/{session_id}/trash")
async def trash_session(session_id: str):
    if session_id != sanitize_session_id(session_id):
        raise HTTPException(status_code=400, detail="Invalid session ID")
    try:
        with lifecycle_gate:
            root = session_layout_root()
            queue_session_trash(root, session_id)
            return {"sessions": list_session_details(root), "server_time": time.time()}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Session no longer exists") from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=500, detail="Could not move session to trash."
        ) from exc


@app.delete("/sessions/{session_id}/trash")
async def undo_session_trash(session_id: str):
    if session_id != sanitize_session_id(session_id):
        raise HTTPException(status_code=400, detail="Invalid session ID")
    try:
        with lifecycle_gate:
            root = session_layout_root()
            restore_session(root, session_id)
            return {"sessions": list_session_details(root), "server_time": time.time()}
    except TrashExpired as exc:
        raise HTTPException(status_code=410, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Session no longer exists") from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=500, detail="Could not restore session."
        ) from exc


@app.patch("/sessions/{session_id}/title")
async def update_session_title(session_id: str, request: SessionTitleRequest):
    if session_id != sanitize_session_id(session_id):
        raise HTTPException(status_code=400, detail="Invalid session ID")
    try:
        rename_session(session_layout_root(), session_id, request.title)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Session no longer exists") from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=500, detail="Could not save session title."
        ) from exc
    return {"id": session_id, "title": request.title}


@app.put("/session-sidebar/order")
async def update_session_order(request: SessionOrderRequest):
    try:
        reorder_sessions(session_layout_root(), request.session_ids)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except InvalidSessionOrder as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=500, detail="Could not save session order."
        ) from exc
    return {"status": "saved"}


@app.post("/sessions")
async def create_session(agent: str | None = None):
    cfg, config_dir = load_config()
    sessions_dir = get_sessions_dir(cfg, config_dir)
    session_id = f"session_{uuid.uuid4().hex[:8]}"
    safe_id = sanitize_session_id(session_id)

    agent_by_alias = cfg.get("agent_by_alias", {})
    if not agent_by_alias:
        raise HTTPException(
            status_code=500, detail="Missing 'agent_by_alias' in config.sxpb"
        )

    # Resolve the default before initialization so its agent-specific resources
    # are present from the first message onward.
    effective_agent = agent or next(iter(agent_by_alias))
    valid_agents = list(HarnessType) + ["pi-agent"] + list(agent_by_alias.keys())
    if effective_agent not in valid_agents:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid agent '{effective_agent}'. Supported: {', '.join(sorted(set(valid_agents)))}",
        )

    preset = agent_by_alias.get(effective_agent, {})
    try:
        HarnessType.from_str(preset.get("harness", effective_agent))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    root = Path(sessions_dir)
    with lifecycle_gate:
        while (root / safe_id).exists() or trash_deadline(root, safe_id) is not None:
            safe_id = f"session_{uuid.uuid4().hex[:8]}"
    with session_admission(root, safe_id):
        session_path = os.path.join(sessions_dir, safe_id)
        os.makedirs(session_path, exist_ok=True)

        ensure_session_initialized(
            session_path, cfg, config_dir, agent_alias=effective_agent
        )

        agent_path = os.path.join(session_path, ".agent_type")
        async with aiofiles.open(agent_path, "w") as f:
            await f.write(effective_agent)

        # Persist the resolved model for external tools (diary, etc.)
        preset = agent_by_alias.get(effective_agent, {})
        model = preset.get("model") or cfg.get("pi_agent_model", "auto")
        model_path = os.path.join(session_path, ".model")
        async with aiofiles.open(model_path, "w") as f:
            await f.write(model)

        return {"status": "created", "session_id": safe_id}


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    cfg, config_dir = load_config()
    sessions_dir = get_sessions_dir(cfg, config_dir)
    safe_id = sanitize_session_id(session_id)
    session_path = os.path.join(sessions_dir, safe_id)
    if os.path.exists(session_path) and os.path.isdir(session_path):
        try:
            root = Path(sessions_dir)
            with lifecycle_gate:
                if (
                    session_is_busy(root, safe_id)
                    or trash_deadline(root, safe_id) is not None
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="Session is busy or in trash; queued deletion preserves its Undo window.",
                    )
                delete_session_now(root, safe_id)
            return {"status": "deleted", "session_id": safe_id}
        except HTTPException:
            raise
        except SessionLeaseBusy as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    return {"status": "not_found"}


class HistoryItem(BaseModel):
    role: str
    content: str


class HistoryResponse(BaseModel):
    history: list[HistoryItem]


def get_history_path(session_path: str) -> str:
    return os.path.join(session_path, "chat_history.json")


def load_session_history(session_path: str) -> list[dict[Any, Any]]:
    history_file = get_history_path(session_path)
    if os.path.exists(history_file):
        try:
            with open(history_file, "r") as f:
                return json.load(f)
        except Exception:
            return []
    return []


def append_to_history(session_path: str, role: str, content: str):
    os.makedirs(session_path, exist_ok=True)
    history_file = Path(get_history_path(session_path))
    history = history_snapshot(history_file)["history"]
    history.append({"role": role, "content": content})
    temporary = history_file.with_name(f".history.{uuid.uuid4().hex}.tmp")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(history, output)
        os.replace(temporary, history_file)
    finally:
        temporary.unlink(missing_ok=True)


@app.get("/sessions/{session_id}/history", response_model=HistoryResponse)
async def get_session_history(session_id: str):
    cfg, config_dir = load_config()
    sessions_dir = get_sessions_dir(cfg, config_dir)
    safe_id = sanitize_session_id(session_id)
    session_path = os.path.join(sessions_dir, safe_id)
    if not os.path.exists(session_path):
        return {"history": []}
    return {"history": load_session_history(session_path)}


def send_snapshot(root: Path, session_id: str, request_id: str) -> dict:
    result = {"id": request_id, "state": "indeterminate"}
    try:
        record = read_send(receipt_path(root / session_id, request_id, create=False))
    except FileNotFoundError:
        return {**result, "state": "missing"}
    except (OSError, ValueError):
        return result
    if record["state"] == "complete":
        return {**result, "state": "complete", "outcome": record["outcome"]}
    future = active_web_sends.get((str(root.resolve()), session_id, request_id))
    if future is not None and not future.done() and future.get_loop().is_running():
        return {**result, "state": "running"}
    return result


@app.get("/sessions/{session_id}/snapshot")
async def get_session_snapshot(
    session_id: str,
    revision: str | None = None,
    request_id: str | None = Query(default=None, pattern=r"^[0-9a-f]{32}$"),
):
    if session_id != sanitize_session_id(session_id):
        raise HTTPException(status_code=400, detail="Invalid session ID")
    cfg, config_dir = load_config()
    root = Path(get_sessions_dir(cfg, config_dir))
    try:
        with lifecycle_gate:
            path = root / session_id
            if not path.is_dir():
                raise HTTPException(status_code=404, detail="Session no longer exists")
            result = history_snapshot(
                path / "chat_history.json", revision, with_reply=True
            )
            root_id = str(root.resolve())
            active = {
                key
                for (owner, key), count in session_activity.items()
                if owner == root_id and count > 0
            }
            active.update(running_processes)
            active.update(key for key, lock in session_locks.items() if lock.locked())
            busy = session_id in active
            if not busy:
                with session_lease(root, session_id, exclusive=True) as fd:
                    busy = fd is None
            if busy:
                active.add(session_id)
            result.update(
                session_id=session_id, busy=busy, busy_sessions=sorted(active)
            )
            if request_id is not None:
                result["send"] = send_snapshot(root, session_id, request_id)
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
    except HTTPException:
        raise
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=500, detail="Could not read conversation state."
        ) from exc


@app.get("/sessions/{session_id}/activity")
async def get_session_activity(session_id: str, revision: str | None = None):
    if session_id != sanitize_session_id(session_id):
        raise HTTPException(status_code=400, detail="Invalid session ID")
    cfg, config_dir = load_config()
    root = Path(get_sessions_dir(cfg, config_dir))
    with lifecycle_gate:
        path = root / session_id
        if not path.is_dir():
            raise HTTPException(status_code=404, detail="Session no longer exists")
        busy = session_is_busy(root, session_id)
        if not busy:
            with session_lease(root, session_id, exclusive=True) as fd:
                busy = fd is None
        result = activity_snapshot(path / ".activity.json", busy, revision)
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


VALID_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]


def get_reasoning_effort_override(session_path: str) -> str | None:
    override_path = os.path.join(session_path, ".reasoning_effort")
    try:
        with open(override_path) as f:
            level = f.read().strip()
        return level if level in VALID_REASONING_LEVELS else None
    except FileNotFoundError:
        return None


def set_reasoning_effort_override(session_path: str, level: str | None):
    override_path = os.path.join(session_path, ".reasoning_effort")
    if level is None:
        if os.path.exists(override_path):
            os.unlink(override_path)
        return
    with open(override_path, "w") as f:
        f.write(level)


def write_pi_settings_json(session_path: str, reasoning_effort: str | None):
    """Synchronize Pi's default thinking level while preserving other settings."""
    settings_path = os.path.join(session_path, ".pi", "agent", "settings.json")
    settings = {}
    if os.path.exists(settings_path):
        try:
            with open(settings_path) as f:
                settings = json.load(f)
        except (OSError, json.JSONDecodeError):
            settings = {}

    if reasoning_effort is None:
        settings.pop("defaultThinkingLevel", None)
    else:
        settings["defaultThinkingLevel"] = reasoning_effort

    if not settings:
        if os.path.exists(settings_path):
            os.unlink(settings_path)
        return

    os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    with open(settings_path, "w") as f:
        json.dump(settings, f, indent=2)


async def process_chat(session_id: str, message: str) -> str:
    cfg, config_dir = load_config()
    root = Path(get_sessions_dir(cfg, config_dir))
    safe_id = sanitize_session_id(session_id)
    with session_admission(root, safe_id) as lease_fd:
        return await _process_chat(session_id, message, lease_fd)


async def _process_chat(session_id: str, message: str, lease_fd: int) -> str:
    try:
        # Secure the session_id to prevent directory traversal
        safe_session_id = sanitize_session_id(session_id)

        cfg, config_dir = load_config()
        sessions_dir = get_sessions_dir(cfg, config_dir)

        # Create an isolated project directory for this session
        session_path = os.path.join(sessions_dir, safe_session_id)
        os.makedirs(session_path, exist_ok=True)

        # Per-session tmp directory so Pi temp files are isolated
        session_tmp = get_session_tmp_dir(session_path)
        os.makedirs(session_tmp, exist_ok=True)

        # Determine agent alias for this session (read before init so agent-specific symlinks are applied)
        agent_by_alias = cfg.get("agent_by_alias", {})
        if not agent_by_alias:
            raise RuntimeError("Missing 'agent_by_alias' in config.sxpb")

        agent_path = os.path.join(session_path, ".agent_type")
        if os.path.exists(agent_path):
            async with aiofiles.open(agent_path, "r") as f:
                agent_alias = (await f.read()).strip()
        else:
            # Default to the first agent defined in the config
            agent_alias = next(iter(agent_by_alias))

        # Ensure session initialized (with agent-specific symlinks if known)
        ensure_session_initialized(
            session_path, cfg, config_dir, agent_alias=agent_alias
        )

        # Resolve preset if it exists
        preset = agent_by_alias.get(agent_alias, {})

        # Keep !agent and !stop usable for retired sessions; never switch silently.
        try:
            harness = HarnessType.from_str(preset.get("harness", agent_alias))
        except ValueError:
            harness = None

        # Determine model for this session
        model_path = os.path.join(session_path, ".model")
        current_model = None
        if os.path.exists(model_path):
            async with aiofiles.open(model_path, "r") as f:
                current_model = (await f.read()).strip()

        if not current_model:
            if preset.get("model"):
                current_model = preset.get("model")
            else:
                current_model = cfg.get("pi_agent_model", "auto")

        # A session override takes precedence over the selected agent preset and
        # survives Limilink restarts. Switching agents clears the override.
        current_reasoning_effort = get_reasoning_effort_override(session_path)
        if current_reasoning_effort is None:
            current_reasoning_effort = preset.get("reasoning_effort")

        # Handle stop command
        if message.strip() == "!stop":
            append_to_history(session_path, "user", message)
            process = running_processes.get(safe_session_id)
            if process:
                try:
                    # Kill the whole process group to ensure sub-commands are stopped
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                    reply = "Agent process stopped."
                except Exception as e:
                    reply = f"Failed to stop process: {e}"
            else:
                reply = "No active agent process found for this session."
            append_to_history(session_path, "bot", reply)
            return reply

        # Handle agent switching command
        if message.startswith("!agent"):
            append_to_history(session_path, "user", message)
            parts = message.split(maxsplit=1)
            agent_path = os.path.join(session_path, ".agent_type")
            if len(parts) == 1:
                # Default to the first agent defined in the config
                current_agent_str = next(iter(agent_by_alias))
                if os.path.exists(agent_path):
                    async with aiofiles.open(agent_path, "r") as f:
                        current_agent_str = (await f.read()).strip()
                reply = f"Current agent: {current_agent_str}"
                append_to_history(session_path, "bot", reply)
                return reply
            new_agent = parts[1].strip()

            # Valid agents are aliases OR raw harness types
            valid_agents = (
                list(HarnessType) + ["pi-agent"] + list(agent_by_alias.keys())
            )
            if new_agent not in valid_agents:
                reply = f"Invalid agent. Supported aliases or harnesses: {', '.join(valid_agents)}"
                append_to_history(session_path, "bot", reply)
                return reply
            new_preset = agent_by_alias.get(new_agent, {})
            try:
                HarnessType.from_str(new_preset.get("harness", new_agent))
            except ValueError:
                reply = "Unsupported harness. Only Pi is supported."
                append_to_history(session_path, "bot", reply)
                return reply

            async with aiofiles.open(agent_path, "w") as f:
                await f.write(new_agent)

            # Agent presets own their auth/resources and defaults.
            reconcile_session_symlinks(session_path, cfg, config_dir, new_agent)
            if os.path.exists(model_path):
                os.unlink(model_path)
            set_reasoning_effort_override(session_path, None)
            write_pi_settings_json(session_path, new_preset.get("reasoning_effort"))

            reply = f"Agent switched to: {new_agent}"
            append_to_history(session_path, "bot", reply)
            return reply

        if harness is None:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported agent '{agent_alias}'. Only Pi is supported; use !agent <pi-alias> to continue this session.",
            )

        # Handle model switching command
        if message.startswith("!model"):
            append_to_history(session_path, "user", message)
            parts = message.split(maxsplit=1)
            if len(parts) == 1:
                reply = f"Current model: {current_model}"
                append_to_history(session_path, "bot", reply)
                return reply
            new_model = parts[1].strip()
            async with aiofiles.open(model_path, "w") as f:
                await f.write(new_model)

            reply = f"Model switched to: {new_model}"
            append_to_history(session_path, "bot", reply)
            return reply

        # Handle reasoning effort command (pi harness only)
        if message.startswith("!reasoning_effort"):
            append_to_history(session_path, "user", message)
            parts = message.split(maxsplit=1)

            if len(parts) == 1:
                reply = f"Current reasoning level: {current_reasoning_effort or 'not set (using provider default)'}"
                append_to_history(session_path, "bot", reply)
                return reply

            level = parts[1].strip()
            if level not in VALID_REASONING_LEVELS:
                reply = f"Invalid reasoning level: {level}. Valid: {', '.join(VALID_REASONING_LEVELS)}"
                append_to_history(session_path, "bot", reply)
                return reply

            set_reasoning_effort_override(session_path, level)
            current_reasoning_effort = level
            write_pi_settings_json(session_path, level)

            reply = f"Reasoning level set to: {level}"
            append_to_history(session_path, "bot", reply)
            return reply

        # Handle env command
        if message.startswith("!env"):
            append_to_history(session_path, "user", message)
            parts = message.split(maxsplit=2)

            env_overrides_path = os.path.join(session_path, ".env_overrides.json")
            env_overrides = {}
            if os.path.exists(env_overrides_path):
                try:
                    async with aiofiles.open(env_overrides_path, "r") as f:
                        content = await f.read()
                        env_overrides = json.loads(content)
                except Exception:
                    logger.debug(
                        "Failed to load env_overrides, using empty", exc_info=True
                    )

            if len(parts) == 1:
                reply = "Usage: !env <VAR_NAME> [VALUE]"
                append_to_history(session_path, "bot", reply)
                return reply

            var_name = parts[1]
            if len(parts) == 2:
                # To show the current value, we need to build the base env
                env = os.environ.copy()
                env.update(global_env_dict(cfg))
                env.update(env_overrides)
                current_val = env.get(var_name)

                if current_val is None:
                    reply = f"{var_name} is not set"
                else:
                    reply = f"{var_name}={current_val}"
                append_to_history(session_path, "bot", reply)
                return reply

            var_value = parts[2]
            env_overrides[var_name] = var_value
            async with aiofiles.open(env_overrides_path, "w") as f:
                await f.write(json.dumps(env_overrides))
            reply = f"Environment variable {var_name} set to: {var_value}"
            append_to_history(session_path, "bot", reply)
            return reply

        # Handle garbage collection command
        if message.startswith("!gc"):
            append_to_history(session_path, "user", message)
            parts = message.split(maxsplit=2)
            if len(parts) < 3:
                reply = "Usage: !gc day <N>  (delete sessions inactive for N days)"
                append_to_history(session_path, "bot", reply)
                return reply
            unit = parts[1]
            if unit != "day":
                reply = f"Unsupported unit '{unit}'. Only 'day' is supported. Usage: !gc day <N>"
                append_to_history(session_path, "bot", reply)
                return reply
            try:
                n_days = int(parts[2])
                if n_days < 0:
                    reply = "Number of days must be >= 0."
                    append_to_history(session_path, "bot", reply)
                    return reply
            except ValueError:
                reply = f"Invalid number '{parts[2]}'. Usage: !gc day <N>"
                append_to_history(session_path, "bot", reply)
                return reply

            cutoff = time.time() - (n_days * 86400)
            deleted = []
            skipped_active = []
            for entry in os.listdir(sessions_dir):
                entry_path = os.path.join(sessions_dir, entry)
                if not os.path.isdir(entry_path):
                    continue
                # Never bypass active work or a queued session's grace period.
                with lifecycle_gate:
                    if (
                        session_is_busy(Path(sessions_dir), entry)
                        or trash_deadline(Path(sessions_dir), entry) is not None
                    ):
                        skipped_active.append(entry)
                        continue
                # Use chat_history.json mtime as the last-activity timestamp
                history_file = get_history_path(entry_path)
                if os.path.exists(history_file):
                    last_activity = os.path.getmtime(history_file)
                else:
                    last_activity = os.path.getmtime(entry_path)
                if last_activity < cutoff:
                    try:
                        with lifecycle_gate:
                            if (
                                session_is_busy(Path(sessions_dir), entry)
                                or trash_deadline(Path(sessions_dir), entry) is not None
                            ):
                                skipped_active.append(entry)
                                continue
                            delete_session_now(Path(sessions_dir), entry)
                        deleted.append(entry)
                    except SessionLeaseBusy:
                        skipped_active.append(entry)
                    except Exception as e:
                        reply = f"Failed to delete session '{entry}': {e}"
                        append_to_history(session_path, "bot", reply)
                        return reply

            lines = []
            if deleted:
                lines.append(
                    f"🧹 Deleted {len(deleted)} stale session(s) (inactive > {n_days} day(s)):"
                )
                for sid in deleted:
                    lines.append(f"  - `{sid}`")
            else:
                lines.append(f"No stale sessions found (inactive > {n_days} day(s)).")
            if skipped_active:
                lines.append(
                    f"Skipped {len(skipped_active)} busy or trashed session(s): {', '.join(f'`{s}`' for s in skipped_active)}"
                )
            reply = "\n".join(lines)
            append_to_history(session_path, "bot", reply)
            return reply

        # Handle trace command (pi harness only)
        stripped_message = message.strip()
        if stripped_message == "!trace" or stripped_message.startswith("!trace "):
            append_to_history(session_path, "user", message)
            parts = stripped_message.split()
            if len(parts) not in (2, 3):
                reply = "Usage: !trace tool [COUNT]"
                append_to_history(session_path, "bot", reply)
                return reply
            if parts[1] != "tool":
                reply = f"Unsupported trace selector '{parts[1]}'. Available: tool"
                append_to_history(session_path, "bot", reply)
                return reply

            count = 10
            if len(parts) == 3:
                try:
                    count = int(parts[2])
                except ValueError:
                    reply = "COUNT must be an integer between 1 and 100."
                    append_to_history(session_path, "bot", reply)
                    return reply
                if not 1 <= count <= 100:
                    reply = "COUNT must be an integer between 1 and 100."
                    append_to_history(session_path, "bot", reply)
                    return reply

            pi_session_dir = os.path.join(session_path, ".pi", "agent", "session")
            jsonl_paths = (
                [
                    os.path.join(pi_session_dir, name)
                    for name in os.listdir(pi_session_dir)
                    if name.endswith(".jsonl")
                ]
                if os.path.isdir(pi_session_dir)
                else []
            )
            if not jsonl_paths:
                reply = "No pi-agent session data found. Send a message first!"
                append_to_history(session_path, "bot", reply)
                return reply
            jsonl_path = max(jsonl_paths, key=os.path.getmtime)

            trace_script = os.path.normpath(
                os.path.join(
                    os.path.dirname(__file__), "..", "tool", "pi_session_trace.py"
                )
            )
            try:
                trace_result = await asyncio.create_subprocess_exec(
                    "python3",
                    trace_script,
                    "tool",
                    str(count),
                    "--session",
                    jsonl_path,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=session_path,
                )
                stdout, stderr = await trace_result.communicate()
                if trace_result.returncode == 0:
                    reply = stdout.decode().strip()
                else:
                    reply = f"Trace failed: {stderr.decode().strip()}"
            except Exception as e:
                reply = f"Trace error: {e}"
            append_to_history(session_path, "bot", reply)
            return reply

        # Handle stat command (pi harness only)
        if message.strip() == "!stat":
            append_to_history(session_path, "user", message)
            pi_agent_dir = os.path.join(session_path, ".pi", "agent", "session")
            if not os.path.isdir(pi_agent_dir):
                reply = "No pi-agent session data found. Send a message first!"
                append_to_history(session_path, "bot", reply)
                return reply

            all_jsonl = [f for f in os.listdir(pi_agent_dir) if f.endswith(".jsonl")]

            # Prefer the "main" session file -- one with a matching sibling
            # directory (same basename sans .jsonl). Falls back to
            # alphabetically last to avoid orphaned fork/clone artifacts.
            def has_sibling_dir(name):
                return os.path.isdir(
                    os.path.join(pi_agent_dir, name.removesuffix(".jsonl"))
                )

            main_candidates = [f for f in all_jsonl if has_sibling_dir(f)]
            jsonl_files = sorted(main_candidates if main_candidates else all_jsonl)
            if not jsonl_files:
                reply = "No usable pi-agent session JSONL found."
                append_to_history(session_path, "bot", reply)
                return reply

            stat_script = os.path.normpath(
                os.path.join(
                    os.path.dirname(__file__), "..", "tool", "pi_session_stat.py"
                )
            )
            try:
                stat_env = os.environ.copy()
                stat_env["PI_CODING_AGENT_DIR"] = os.path.join(
                    session_path, ".pi", "agent"
                )
                stat_result = await asyncio.create_subprocess_exec(
                    "python3",
                    stat_script,
                    os.path.join(pi_agent_dir, jsonl_files[-1]),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=session_path,
                    env=stat_env,
                )
                stdout, stderr = await stat_result.communicate()
                if stat_result.returncode == 0:
                    reply = stdout.decode().strip()
                else:
                    reply = f"Stat failed: {stderr.decode().strip()}"
            except Exception as e:
                reply = f"Stat error: {e}"
            append_to_history(session_path, "bot", reply)
            return reply

        # Handle compact command (pi harness only)
        stripped_message = message.strip()
        if stripped_message == "!compact" or stripped_message.startswith("!compact "):
            append_to_history(session_path, "user", message)
            pi_session_dir = os.path.join(session_path, ".pi", "agent", "session")
            if not os.path.isdir(pi_session_dir) or not any(
                f.endswith(".jsonl") for f in os.listdir(pi_session_dir)
            ):
                reply = "No pi-agent session data found. Send a message first!"
                append_to_history(session_path, "bot", reply)
                return reply

            lock = get_session_lock(safe_session_id)
            if lock.locked():
                reply = "Session is busy \u2014 wait for the current request to finish."
                append_to_history(session_path, "bot", reply)
                return reply

            custom_instructions = None
            parts = stripped_message.split(maxsplit=1)
            if len(parts) == 2:
                custom_instructions = parts[1].strip()

            pi_agent_dir = os.path.join(session_path, ".pi", "agent")
            write_pi_settings_json(session_path, current_reasoning_effort)

            exepath = cfg.get("pi_agent_exepath", "pi-agent")
            rpc_args = ["--approve", "--mode", "rpc", "--continue"]
            provider_name = preset.get("provider")
            if provider_name:
                rpc_args += ["--provider", provider_name]
            rpc_args += ["--model", current_model]
            if current_reasoning_effort:
                rpc_args += ["--thinking", current_reasoning_effort]
            rpc_args += ["--session-dir", ".pi/agent/session"]

            rpc_env = os.environ.copy()
            rpc_env["PI_CODING_AGENT_DIR"] = pi_agent_dir
            rpc_env["TMPDIR"] = get_session_tmp_dir(session_path)
            rpc_env.update(global_env_dict(cfg))
            preset_env_dict = preset.get("env_dict", {})
            if isinstance(preset_env_dict, dict):
                for name, value in preset_env_dict.items():
                    if isinstance(value, str):
                        rpc_env[name] = value
            env_overrides_path = os.path.join(session_path, ".env_overrides.json")
            if os.path.exists(env_overrides_path):
                try:
                    async with aiofiles.open(env_overrides_path, "r") as f:
                        for k, v in json.loads(await f.read()).items():
                            rpc_env[k] = v
                except Exception:
                    logger.debug(
                        "Failed to load rpc env_overrides, using empty", exc_info=True
                    )

            _add_activity_observer(rpc_args, rpc_env, session_path)
            try:
                compact_response = await compact_rpc(
                    [exepath, *rpc_args],
                    lease_fd=lease_fd,
                    cwd=session_path,
                    env=rpc_env,
                    instructions=custom_instructions,
                )

                if compact_response is None:
                    reply = "Compaction produced no response."
                elif not compact_response.get("success"):
                    error = compact_response.get("error", "unknown error")
                    preview = error[:500] + "…" if len(error) > 500 else error
                    reply = f"Compaction failed: {preview}"
                else:
                    data = compact_response.get("data", {})
                    tokens_before = data.get("tokensBefore", "?")
                    tokens_after = data.get("estimatedTokensAfter", "?")
                    summary = data.get("summary", "")
                    reply = f"\u2705 Compacted: {tokens_before} \u2192 ~{tokens_after} tokens"
                    if summary:
                        preview = (
                            summary[:500] + "\u2026" if len(summary) > 500 else summary
                        )
                        reply += f"\n\n{preview}"
            except CompactRPCError as error:
                reply = str(error)
            except Exception:
                logger.warning("Unexpected compact RPC failure")
                reply = "Compaction failed."

            append_to_history(session_path, "bot", reply)
            return reply

        # Catch-all: any message starting with ! is a command; never forward to agent
        if message.strip().startswith("!"):
            append_to_history(session_path, "user", message)
            reply = f"Unknown command: {message.strip().split()[0]}"
            append_to_history(session_path, "bot", reply)
            return reply

        env = os.environ.copy()
        env["LIMILINK_SESSION"] = safe_session_id
        env["TMPDIR"] = get_session_tmp_dir(session_path)

        pi_agent_dir = os.path.join(session_path, ".pi", "agent")

        # Synchronize Limilink's thinking default while preserving other Pi
        # settings. Provider and model metadata remain user-owned resources.
        write_pi_settings_json(session_path, current_reasoning_effort)

        exepath = cfg.get("pi_agent_exepath", "pi-agent")

        # pi-agent env vars
        env["PI_CODING_AGENT_DIR"] = pi_agent_dir

        # Build pi-agent args
        is_readonly = preset.get("readonly_mode_on", False)
        if is_readonly:
            agent_args = ["--no-tools", "--tools", "read,grep,find,ls"]
        else:
            agent_args = ["--approve"]
        provider_name = preset.get("provider")
        if provider_name:
            agent_args += ["--provider", provider_name]
        agent_args += ["--model", current_model]
        if current_reasoning_effort:
            # A continued Pi session restores its recorded thinking level in
            # preference to defaults, so this must be an explicit CLI option.
            agent_args += ["--thinking", current_reasoning_effort]
        agent_args += ["--session-dir", ".pi/agent/session"]
        # Specification of --session on the first run of a new session directory
        # causes "No session found matching..." error. pi-agent should just
        # use the isolated directory naturally.

        if os.path.exists(os.path.join(session_path, "SYSTEM.md")):
            agent_args += [
                "--system-prompt",
                os.path.abspath(os.path.join(session_path, "SYSTEM.md")),
            ]
        if os.path.exists(os.path.join(session_path, "ENTITY.md")):
            agent_args += [
                "--append-system-prompt",
                os.path.abspath(os.path.join(session_path, "ENTITY.md")),
            ]

        # Add configured global environment variables (shared by all agents)
        env.update(global_env_dict(cfg))

        # Merge preset env_dict if present
        preset_env_dict = preset.get("env_dict", {})
        if isinstance(preset_env_dict, dict):
            for name, value in preset_env_dict.items():
                if isinstance(value, str):
                    env[name] = value

        # Apply session environment overrides
        env_overrides_path = os.path.join(session_path, ".env_overrides.json")
        if os.path.exists(env_overrides_path):
            try:
                async with aiofiles.open(env_overrides_path, "r") as f:
                    env_overrides = json.loads(await f.read())
                for k, v in env_overrides.items():
                    env[k] = v
            except Exception:
                logger.debug(
                    "Failed to apply env_overrides, continuing without", exc_info=True
                )

        # Read-only observer: no change to prompting, stdout or process lifetime.
        _add_activity_observer(agent_args, env, session_path)
        cmd = [exepath] + agent_args + ["--continue", "-p", message]

        # Append user message to history
        append_to_history(session_path, "user", message)

        if tracer:
            span = trace.get_current_span()
            span.set_attribute("limilink.session_id", safe_session_id)
            span.set_attribute("limilink.agent", harness.value)
            span.set_attribute("limilink.message", message)
            span.set_attribute("limilink.model", current_model)

        lock = get_session_lock(safe_session_id)
        async with lock:
            max_attempts = 3
            for attempt in range(max_attempts):
                process = await asyncio.create_subprocess_exec(
                    *pi_lease_command(cmd, lease_fd),
                    pass_fds=(lease_fd,),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=session_path,  # Execute within the isolated directory
                    env=env,
                    process_group=0,  # Create a new process group for easy cleanup
                )

                running_processes[safe_session_id] = process
                try:
                    if tracer:
                        with tracer.start_as_current_span("agent_execute") as subspan:
                            subspan.set_attribute("agent.command", " ".join(cmd))
                            stdout, stderr = await process.communicate()
                    else:
                        stdout, stderr = await process.communicate()
                finally:
                    if running_processes.get(safe_session_id) == process:
                        del running_processes[safe_session_id]
                    # Clean up session tmp files after each request
                    session_tmp = get_session_tmp_dir(session_path)
                    if os.path.isdir(session_tmp):
                        for entry in os.listdir(session_tmp):
                            entry_path = os.path.join(session_tmp, entry)
                            try:
                                if os.path.isfile(entry_path) or os.path.islink(
                                    entry_path
                                ):
                                    os.unlink(entry_path)
                                elif os.path.isdir(entry_path):
                                    shutil.rmtree(entry_path)
                            except OSError:
                                pass

                retcode = process.returncode
                if retcode is None or retcode == 0:
                    reply_text = stdout.decode().strip()
                    reply_text = re.sub(r".*\n\[Thought: true\]", "", reply_text)
                    if not reply_text:
                        retcode = 1
                        error_msg = "pi-agent exited 0 but produced no output."
                    else:
                        break  # Success
                elif retcode < 0:
                    # Process was terminated by a signal (e.g., via !stop)
                    reply_text = f"Process terminated by signal {-retcode}."
                    break  # Do not retry on signal
                else:
                    error_msg = stderr.decode().strip()
                    if "\n    at " in error_msg:
                        error_msg = error_msg.split("\n    at ")[0].strip()

                if attempt < max_attempts - 1:
                    print(
                        f"Agent failed (retcode={retcode}, error={error_msg}). Retrying {attempt + 1}/{max_attempts}..."
                    )
                    await asyncio.sleep(2**attempt)
                    continue

                # If we reach here, it failed after max attempts
                print(f"Agent harness error: {error_msg}")
                # Propagate common status codes (mapped to retcode % 256)
                # 173 = 429 % 256
                if (
                    retcode == 173
                    or "429" in error_msg
                    or "Rate limit" in error_msg
                    or "TOO_MANY_REQUESTS" in error_msg
                ):
                    raise HTTPException(
                        status_code=429, detail=f"Rate limit exceeded: {error_msg}"
                    )
                # 145 = 401 % 256, 147 = 403 % 256
                if retcode in (145, 147) or "auth" in error_msg.lower():
                    sc = 401
                    if retcode == 147:
                        sc = 403
                    raise HTTPException(
                        status_code=sc,
                        detail=f"Authentication error: {error_msg}",
                    )
                raise HTTPException(
                    status_code=500, detail=f"Agent harness failed: {error_msg}"
                )

        # Append bot reply to history
        append_to_history(session_path, "bot", reply_text)

        return reply_text

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Internal error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def indeterminate_send(detail: str) -> dict:
    return {"status": 409, "body": {"detail": detail, "code": "send_indeterminate"}}


def send_response(outcome: dict) -> JSONResponse:
    return JSONResponse(
        outcome["body"], status_code=outcome["status"], headers=outcome.get("headers")
    )


async def identified_chat(request: ChatRequest) -> JSONResponse:
    assert request.request_id is not None
    cfg, config_dir = load_config()
    root = Path(get_sessions_dir(cfg, config_dir))
    safe_id = sanitize_session_id(request.session_id)
    key = (str(root.resolve()), safe_id, request.request_id)
    with session_admission(root, safe_id) as lease_fd:
        try:
            with lifecycle_gate:
                path = receipt_path(root / safe_id, request.request_id)
                owner, reservation = reserve_send(path, request.message)
                if not owner:
                    if reservation["state"] == "complete":
                        logger.info(
                            "Replayed completed Send %s for %s",
                            request.request_id,
                            safe_id,
                        )
                        return send_response(reservation["outcome"])
                    future = active_web_sends.get(key)
                    if (
                        future is None
                        or future.get_loop() is not asyncio.get_running_loop()
                    ):
                        return send_response(
                            indeterminate_send(
                                "This Send was already reserved but has no live response. Check the conversation; it will not be executed again."
                            )
                        )
                    logger.info(
                        "Joined active Send %s for %s", request.request_id, safe_id
                    )
                else:
                    future = asyncio.get_running_loop().create_future()
                    active_web_sends[key] = future
                    logger.info("Reserved Send %s for %s", request.request_id, safe_id)
        except SendConflict as exc:
            return send_response({"status": 409, "body": {"detail": str(exc)}})
        except (SendIndeterminate, OSError, ValueError) as exc:
            logger.warning(
                "Could not verify Send %s for %s: %s", request.request_id, safe_id, exc
            )
            return send_response(
                indeterminate_send(
                    "The Send receipt could not be verified. Check the conversation; it will not be executed automatically."
                )
            )

        if not owner:
            return send_response(await asyncio.shield(future))

        try:
            outcome: dict
            try:
                reply = await _process_chat(
                    request.session_id, request.message, lease_fd
                )
                outcome = {"status": 200, "body": {"reply": reply}}
            except HTTPException as exc:
                outcome = {
                    "status": exc.status_code,
                    "body": {"detail": exc.detail},
                    "headers": exc.headers or {},
                }
            except Exception as exc:
                logger.exception("Send %s failed for %s", request.request_id, safe_id)
                outcome = {"status": 500, "body": {"detail": str(exc)}}
            try:
                complete_send(path, reservation, outcome)
            except (OSError, ValueError, TypeError):
                logger.exception(
                    "Could not save outcome for Send %s", request.request_id
                )
                outcome = indeterminate_send(
                    "This Send's replay outcome could not be saved. Check the conversation before sending again."
                )
            if not future.done():
                future.set_result(outcome)
            return send_response(outcome)
        except asyncio.CancelledError:
            # Keep the reservation: cancellation does not prove the agent stopped.
            if not future.done():
                future.set_result(
                    indeterminate_send(
                        "The original Send was interrupted. Check the conversation; it will not be executed again."
                    )
                )
            raise
        finally:
            with lifecycle_gate:
                if active_web_sends.get(key) is future:
                    del active_web_sends[key]


@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    try:
        if request.request_id is not None:
            return await identified_chat(request)
        reply_text = await process_chat(request.session_id, request.message)
        return {"reply": reply_text}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Internal error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def run_notifyme_task(session_id: str, message: str):
    cfg, config_dir = load_config()
    root = Path(get_sessions_dir(cfg, config_dir))
    try:
        with session_admission(root, sanitize_session_id(session_id)):
            await _run_notifyme_task(session_id, message)
    except HTTPException:
        # A stale background notification must not recreate a trashed session.
        logger.info("Notification skipped for an unavailable session.")


async def _run_notifyme_task(session_id: str, message: str):
    """Deliver a notification and optionally get an agent response.

    The raw notification is enqueued immediately so it always appears
    without waiting for session locks. Then we try to acquire the session
    lock with a short timeout — if free, the agent processes the notification
    and its response arrives as a follow-up message.
    """
    safe_id = sanitize_session_id(session_id)
    try:
        cfg, config_dir = load_config()
        sessions_dir = get_sessions_dir(cfg, config_dir)
        session_path = os.path.join(sessions_dir, safe_id)
        # Always deliver the raw notification immediately.
        enqueue_unread_message(session_path, message)
    except Exception as e:
        logger.error(f"Notifyme enqueue failed for {session_id}: {e}")
        return

    # Try to get an agent response, but skip if the session is busy.
    # Don't acquire the lock ourselves — process_chat handles its own locking,
    # and asyncio.Lock is not reentrant so holding it here would deadlock.
    lock = get_session_lock(safe_id)
    if lock.locked():
        return  # Active chat in progress, raw notification already delivered.
    try:
        reply_text = await process_chat(session_id, message)
        enqueue_unread_message(session_path, reply_text)
    except Exception as e:
        logger.error(f"Notifyme agent response failed for {session_id}: {e}")
        try:
            error_msg = str(e)
            if isinstance(e, HTTPException):
                error_msg = f"Error {e.status_code}: {e.detail}"
            enqueue_unread_message(session_path, f"❌ Chat failed: {error_msg}")
        except Exception:
            logger.debug(
                "Failed to enqueue error notification, dropping", exc_info=True
            )


@app.post("/sessions/{session_id}/notifyme")
async def notifyme_session(session_id: str, request: NotifymeRequest):
    safe_session_id = sanitize_session_id(session_id)
    # Start the chat asynchronously
    asyncio.create_task(run_notifyme_task(safe_session_id, request.message))
    return {"status": "notifyme_initiated"}


@app.get("/sessions/{session_id}/poll", response_model=PollResponse)
async def poll_session(session_id: str):
    safe_session_id = sanitize_session_id(session_id)
    cfg, config_dir = load_config()
    sessions_dir = get_sessions_dir(cfg, config_dir)
    session_path = os.path.join(sessions_dir, safe_session_id)
    if not os.path.exists(session_path):
        return {"messages": []}
    messages = dequeue_unread_messages(session_path)
    return {"messages": messages}


FAVICON_PATH = Path(__file__).resolve().parents[1] / "dist" / "favicon.svg"


@app.get("/favicon.svg", include_in_schema=False)
async def favicon_svg():
    if not FAVICON_PATH.is_file():
        raise HTTPException(status_code=404, detail="Favicon not built")
    return FileResponse(FAVICON_PATH, media_type="image/svg+xml")


# Serve the session sidebar and chat UI.
static_dir = os.path.join(os.path.dirname(__file__), "ui")
if os.path.exists(static_dir):

    @app.get("/", include_in_schema=False)
    async def session_ui():
        return FileResponse(os.path.join(static_dir, "resume.html"))

    app.mount("/", StaticFiles(directory=static_dir), name="static")
