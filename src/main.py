from __future__ import annotations

import aiofiles
import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import time
import threading
import tempfile
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

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field, StrictBool, field_validator
from session_media import MediaStore, PRIVATE as MEDIA_HEADERS

from session_layout import (
    SESSION_STAGING_PREFIX,
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

from delivery import (
    DeliveryOwner,
    ExecutionUncertain,
    current_attempt,
    projecting,
    public,
)
from compact_rpc import CompactRPCError, compact_rpc
from pi_output import PiResponseError, pi_json_reply
from session_lease import SessionLeaseBusy, pi_lease_command, session_lease
from session_snapshot import cached_reply_evidence, history_snapshot
from session_activity import activity_snapshot
from send_receipt import (
    SendConflict,
    SendIndeterminate,
    receipt_path,
    read_send,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def app_lifespan(app: FastAPI):
    owner = get_delivery_owner()
    sweep_session_trash()
    worker = asyncio.create_task(trash_worker())
    try:
        yield
    finally:
        await owner.close()
        delivery_owners.pop(str(owner.root), None)
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


lifecycle_gate = threading.RLock()
session_activity: dict[tuple[str, str], int] = {}
# Exactly one owner per canonical root, independent of HTTP request lifetimes.
delivery_owners: dict[str, DeliveryOwner] = {}


# Media shares lifecycle/root ownership, never the agent execution lane.
media_stores: dict[str, MediaStore] = {}


def project_operation(root: Path, record: dict):
    token = projecting.set(True)
    try:
        path = str(root / record["session_id"])
        append_to_history(path, "user", record["message"], request_id=record["id"])
        outcome = record["outcome"]
        if outcome is not None:
            body = outcome["body"]
            text = body.get("reply", body.get("detail", ""))
            if not isinstance(text, str):
                text = json.dumps(text)
            append_to_history(path, "bot", text, request_id=record["id"])
    finally:
        projecting.reset(token)


def get_delivery_owner() -> DeliveryOwner:
    cfg, config_dir = load_config()
    root = Path(get_sessions_dir(cfg, config_dir)).resolve()
    key = str(root)
    owner = delivery_owners.get(key)
    if (
        owner is not None
        and not owner.closed
        and owner.loop is not asyncio.get_running_loop()
    ):
        if not owner.loop.is_closed():
            raise RuntimeError("Delivery owner belongs to another live event loop")
        os.close(owner.fd)
        owner.closed = True
    if owner is None or owner.closed:
        owner = DeliveryOwner(
            root,
            _process_chat,
            session_admission,
            lambda record: project_operation(root, record),
            recovery_context,
            lambda root, sid: session_admission(root, sid, exclusive=True),
        )
        delivery_owners[key] = owner
    return owner


def admit_operation(session_id, request_id, message, *, create=False, owner=None):
    cfg, _ = load_config()
    limit = cfg.get("session_queue_limit", 16)
    if type(limit) is not int or limit <= 0:
        raise HTTPException(500, "session_queue_limit must be a positive integer")
    return (owner or get_delivery_owner()).admit(
        session_id, request_id, message, limit, create=create
    )


def session_is_busy(root: Path, session_id: str) -> bool:
    owner = delivery_owners.get(str(root.resolve()))
    return bool(
        (owner is not None and owner.busy(session_id))
        or session_activity.get((str(root.resolve()), session_id), 0) > 0
    )


@contextmanager
def session_admission(root: Path, session_id: str, *, exclusive=False):
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
            fd = stack.enter_context(
                session_lease(root, session_id, exclusive=exclusive)
            )
            if fd is None:
                raise HTTPException(
                    status_code=409,
                    detail="Session still has a writer/activity lease; recovery refused."
                    if exclusive
                    else "Session is being deleted.",
                )
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
                    raise ExecutionUncertain(
                        f"Failed to create session resource {link_path}: {e}"
                    ) from e
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
            raise ExecutionUncertain(
                f"Failed to reconcile session resource {link_path}: {e}"
            ) from e


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
                if not entry.startswith(SESSION_STAGING_PREFIX) and os.path.isdir(
                    os.path.join(sessions_dir, entry)
                ):
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
    root.mkdir(parents=True, exist_ok=True)
    # Build on the same filesystem, but outside the discoverable/admissible
    # session namespace. No awaited initializer write follows publication.
    with tempfile.TemporaryDirectory(
        prefix=SESSION_STAGING_PREFIX, dir=root
    ) as staging:
        ensure_session_initialized(
            staging, cfg, config_dir, agent_alias=effective_agent
        )
        async with aiofiles.open(os.path.join(staging, ".agent_type"), "w") as output:
            await output.write(effective_agent)
        model = preset.get("model") or cfg.get("pi_agent_model", "auto")
        async with aiofiles.open(os.path.join(staging, ".model"), "w") as output:
            await output.write(model)

        with lifecycle_gate:
            while (
                os.path.lexists(root / safe_id)
                or trash_deadline(root, safe_id) is not None
            ):
                safe_id = f"session_{uuid.uuid4().hex[:8]}"
            with session_admission(root, safe_id):
                os.rename(staging, root / safe_id)
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


def append_to_history(
    session_path: str, role: str, content: str, *, request_id: str | None = None
):
    # During execution the operation is authoritative. Only project its history
    # after the terminal result is persisted by the owner.
    if current_attempt.get() is not None and not projecting.get():
        return
    os.makedirs(session_path, exist_ok=True)
    history_file = Path(get_history_path(session_path))
    history = history_snapshot(history_file)["history"]
    item = {"role": role, "content": content}
    if request_id is not None:
        item["request_id"] = request_id
        existing = [
            entry
            for entry in history
            if entry.get("role") == role and entry.get("request_id") == request_id
        ]
        if existing:
            if existing != [item]:
                raise ExecutionUncertain(
                    "History operation projection conflicts with its receipt"
                )
            return
    history.append(item)
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
        record = get_delivery_owner().lookup(session_id, request_id)
    except FileNotFoundError:
        return {**result, "state": "missing"}
    except (OSError, ValueError):
        # Read-only compatibility with pre-owner receipts. Never use these to
        # authorize new execution or invent the original exact message.
        try:
            legacy = read_send(
                receipt_path(root / session_id, request_id, create=False)
            )
            if legacy["state"] == "complete":
                return {**result, "state": "complete", "outcome": legacy["outcome"]}
        except (OSError, ValueError):
            pass
        return result
    if record["state"] in ("queued", "running"):
        return {**result, "state": "running"}  # Legacy clients only.
    if record["state"] in ("succeeded", "failed", "cancelled"):
        return {**result, "state": "complete", "outcome": record["outcome"]}
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
            owner = delivery_owners.get(root_id)
            if owner is not None:
                active.update(key for key in owner.lanes if owner.busy(key))
            busy = session_id in active
            if not busy:
                with session_lease(root, session_id, exclusive=True) as fd:
                    busy = fd is None
            if busy:
                active.add(session_id)
            result.update(
                session_id=session_id,
                busy=busy,
                busy_sessions=sorted(active),
                send_identities=True,
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
        except (OSError, json.JSONDecodeError) as exc:
            raise ExecutionUncertain("Pi settings could not be read safely.") from exc

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
    # Explicit legacy/Discord creation adapter; web operation admission is strict.
    owner = get_delivery_owner()
    record, _ = admit_operation(
        session_id, uuid.uuid4().hex, message, create=True, owner=owner
    )
    record = await owner.wait(record)
    outcome = operation_outcome(record)
    if outcome["status"] != 200:
        raise HTTPException(
            outcome["status"],
            outcome["body"].get("detail", "Operation failed"),
            headers=outcome.get("headers"),
        )
    return outcome["body"]["reply"]


async def _process_chat(
    session_id: str, message: str, lease_fd: int, request_id: str | None = None
) -> str:
    try:
        # Secure the session_id to prevent directory traversal
        safe_session_id = sanitize_session_id(session_id)

        cfg, config_dir = load_config()
        attempt = current_attempt.get()
        if attempt is None:
            raise RuntimeError("Session execution requires its delivery owner")
        sessions_dir = str(attempt.root)

        # Create an isolated project directory for this session
        session_path = os.path.join(sessions_dir, safe_session_id)
        os.makedirs(session_path, exist_ok=True)

        def append_user():
            append_to_history(session_path, "user", message, request_id=request_id)

        # Per-session tmp directory so Pi temp files are isolated
        session_tmp = get_session_tmp_dir(session_path)
        os.makedirs(session_tmp, exist_ok=True)

        # Determine agent alias for this session (read before init so agent-specific symlinks are applied)
        agent_by_alias = cfg.get("agent_by_alias", {})
        if not agent_by_alias:
            raise HTTPException(500, "Missing 'agent_by_alias' in config.sxpb")

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

        # Handle agent switching command
        if message.startswith("!agent"):
            append_user()
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
            append_user()
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
            append_user()
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
            append_user()
            parts = message.split(maxsplit=2)

            env_overrides_path = os.path.join(session_path, ".env_overrides.json")
            env_overrides = {}
            if os.path.exists(env_overrides_path):
                try:
                    async with aiofiles.open(env_overrides_path, "r") as f:
                        content = await f.read()
                        env_overrides = json.loads(content)
                except Exception as exc:
                    raise ExecutionUncertain(
                        "Session environment overrides could not be read safely."
                    ) from exc

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
            append_user()
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
                if entry.startswith(SESSION_STAGING_PREFIX):
                    continue
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
            append_user()
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
            append_user()
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
            append_user()
            pi_session_dir = os.path.join(session_path, ".pi", "agent", "session")
            if not os.path.isdir(pi_session_dir) or not any(
                f.endswith(".jsonl") for f in os.listdir(pi_session_dir)
            ):
                reply = "No pi-agent session data found. Send a message first!"
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
                except Exception as exc:
                    raise ExecutionUncertain(
                        "Session environment overrides could not be read safely."
                    ) from exc

            _add_activity_observer(rpc_args, rpc_env, session_path)
            try:
                compact_response = await compact_rpc(
                    [exepath, *rpc_args],
                    lease_fd=lease_fd,
                    fence_fd=attempt.fence_fd,
                    on_spawn=lambda process, owned_attempt=attempt: (
                        owned_attempt.register(process, compact=True)
                    ),
                    cwd=session_path,
                    env=rpc_env,
                    instructions=custom_instructions,
                )

                if compact_response is None:
                    if attempt.stop_requested:
                        reply = "Compaction cancelled."
                    else:
                        raise ExecutionUncertain(
                            "Compaction produced no response; its effects are unconfirmed."
                        )
                elif not compact_response.get("success"):
                    error = compact_response.get("error", "unknown error")
                    preview = error[:500] + "…" if len(error) > 500 else error
                    raise HTTPException(500, f"Compaction failed: {preview}")
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
                if "cleanup could not be confirmed" in str(error):
                    raise ExecutionUncertain(str(error)) from error
                if (
                    attempt.stop_requested
                    and attempt.process is not None
                    and attempt.process.returncode is not None
                ):
                    reply = "Compaction cancelled."
                elif attempt.process is not None:
                    raise ExecutionUncertain(str(error)) from error
                else:
                    raise HTTPException(500, str(error)) from error

            append_to_history(session_path, "bot", reply)
            return reply

        # Catch-all: any message starting with ! is a command; never forward to agent
        if message.strip().startswith("!"):
            append_user()
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
            except Exception as exc:
                raise ExecutionUncertain(
                    "Session environment overrides could not be read safely."
                ) from exc

        # Read-only observer: no change to prompting, stdout or process lifetime.
        _add_activity_observer(agent_args, env, session_path)
        cmd = [exepath] + agent_args + ["--continue", "--mode", "json", "-p", message]

        # Append user message to history
        append_user()

        if tracer:
            span = trace.get_current_span()
            span.set_attribute("limilink.session_id", safe_session_id)
            span.set_attribute("limilink.agent", harness.value)
            span.set_attribute("limilink.message", message)
            span.set_attribute("limilink.model", current_model)

        attempt = current_attempt.get()
        assert attempt is not None
        spawn = asyncio.create_task(
            asyncio.create_subprocess_exec(
                *pi_lease_command(cmd, lease_fd, attempt.fence_fd),
                pass_fds=(lease_fd, attempt.fence_fd),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=session_path,
                env=env,
                process_group=0,
            )
        )
        process = None
        try:
            process = await asyncio.shield(spawn)
            attempt.register(process)
            stdout, stderr = await process.communicate()
        finally:
            # A service shutdown cannot abandon an in-flight spawn. Settle the
            # exact attempt, preserving ordinary process-group signal scope.
            if process is None:
                process = await asyncio.shield(spawn)
                attempt.register(process)
            if process.returncode is None:
                attempt.stop()
                try:
                    async with asyncio.timeout(5):
                        await asyncio.shield(process.wait())
                except (TimeoutError, OSError) as exc:
                    raise ExecutionUncertain(
                        "Agent process cleanup could not be confirmed."
                    ) from exc
            session_tmp = get_session_tmp_dir(session_path)
            if os.path.isdir(session_tmp):
                for entry in os.listdir(session_tmp):
                    entry_path = os.path.join(session_tmp, entry)
                    if os.path.isdir(entry_path) and not os.path.islink(entry_path):
                        shutil.rmtree(entry_path)
                    else:
                        os.unlink(entry_path)

        retcode = process.returncode
        if retcode == 0:
            try:
                reply_text = pi_json_reply(stdout)
            except PiResponseError as error:
                # JSON mode carries request failures in events, not its exit code.
                # Preserve the existing rate/auth/provider error classification.
                retcode, stderr = 1, error.error_message.encode()
            except ValueError as error:
                raise HTTPException(500, f"Agent harness failed: {error}") from error
        if retcode == 0:
            reply_text = re.sub(r".*\n\[Thought: true\]", "", reply_text)
            if not reply_text:
                raise HTTPException(
                    500,
                    "Agent harness failed: pi-agent exited 0 but produced no output.",
                )
        elif retcode is not None and retcode < 0:
            reply_text = f"Process terminated by signal {-retcode}."
        else:
            error_msg = stderr.decode().strip()
            if "\n    at " in error_msg:
                error_msg = error_msg.split("\n    at ")[0].strip()
            if retcode == 173 or any(
                value in error_msg
                for value in ("429", "Rate limit", "TOO_MANY_REQUESTS")
            ):
                raise HTTPException(429, f"Rate limit exceeded: {error_msg}")
            if retcode in (145, 147) or "auth" in error_msg.lower():
                raise HTTPException(
                    403 if retcode == 147 else 401, f"Authentication error: {error_msg}"
                )
            raise HTTPException(500, f"Agent harness failed: {error_msg}")

        # Append bot reply to history
        append_to_history(session_path, "bot", reply_text)

        return reply_text

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Internal error: {e}")
        raise ExecutionUncertain(str(e)) from e


def indeterminate_send(detail: str) -> dict:
    return {"status": 409, "body": {"detail": detail, "code": "send_indeterminate"}}


def send_response(outcome: dict) -> JSONResponse:
    return JSONResponse(
        outcome["body"], status_code=outcome["status"], headers=outcome.get("headers")
    )


def operation_outcome(record):
    if record["state"] in ("indeterminate", "interrupted_not_started"):
        return indeterminate_send(
            (record.get("outcome") or {})
            .get("body", {})
            .get(
                "detail",
                "Operation interrupted or indeterminate; it will not execute again.",
            )
        )
    return record["outcome"]


async def identified_chat(request: ChatRequest) -> JSONResponse:
    assert request.request_id is not None
    try:
        owner = get_delivery_owner()
        try:
            record, _ = admit_operation(
                request.session_id, request.request_id, request.message, owner=owner
            )
        except SendIndeterminate:
            # A validated v1 completion has no exact message/sequence to invent
            # a v2 OP from, but its preserved legacy response is authoritative.
            # Recheck lifecycle under a lease, then compare its exact fingerprint.
            with session_admission(owner.root, request.session_id):
                saved = read_send(owner.path(request.session_id, request.request_id))
                fingerprint = hashlib.sha256(
                    request.message.encode("utf-8", "surrogatepass")
                ).hexdigest()
                if saved["message_sha256"] != fingerprint:
                    raise SendConflict(
                        "This Send ID is already bound to a different message"
                    )
                if saved["state"] != "complete":
                    raise SendIndeterminate(
                        "Previous Send has no confirmed outcome; it will not be executed again."
                    )
                return send_response(saved["outcome"])
        record = await owner.wait(record)
        return send_response(operation_outcome(record))
    except SendConflict as exc:
        return send_response({"status": 409, "body": {"detail": str(exc)}})
    except (SendIndeterminate, OSError, ValueError) as exc:
        return send_response(indeterminate_send(str(exc)))


def recovery_context(path: Path, records: list) -> dict:
    """Read/validate current configuration, never repair it during acknowledgement."""
    from recovery import digest, read_file

    cfg, config_dir = load_config()
    aliases = cfg.get("agent_by_alias")
    if not isinstance(aliases, dict) or not aliases:
        raise ValueError("Recovery requires valid agent configuration")
    evidence = {}
    for name in (
        ".agent_type",
        ".model",
        ".reasoning_effort",
        ".initialized",
        "chat_history.json",
        ".env_overrides.json",
    ):
        raw = read_file(path / name)
        evidence[name] = raw.decode() if raw is not None else None
    agent = (
        evidence[".agent_type"]
        if evidence[".agent_type"] is not None
        else next(iter(aliases))
    )
    if not isinstance(agent, str):
        raise ValueError("Invalid agent alias")
    agent = agent.strip()
    if not agent:
        raise ValueError("Selected agent is empty")
    preset = aliases.get(agent, {})
    if not isinstance(preset, dict):
        raise ValueError("Invalid selected agent configuration")
    HarnessType.from_str(preset.get("harness", agent))
    thinking = evidence[".reasoning_effort"]
    if thinking is not None and thinking.strip() not in VALID_REASONING_LEVELS:
        raise ValueError(
            "Invalid reasoning override; inspect configuration before recovery"
        )
    thinking = (
        thinking.strip() if thinking is not None else preset.get("reasoning_effort")
    )
    if thinking is not None and thinking not in VALID_REASONING_LEVELS:
        raise ValueError("Invalid configured reasoning level")
    history = json.loads(evidence["chat_history.json"] or "[]")
    if not isinstance(history, list) or any(
        not isinstance(item, dict)
        or not isinstance(item.get("role"), str)
        or not isinstance(item.get("content"), str)
        for item in history
    ):
        raise ValueError("History cannot be verified; recovery does not repair history")
    for record in records:
        expected = {"user": record["message"]}
        if record["state"] != "indeterminate" and record["outcome"] is not None:
            body = record["outcome"]["body"]
            text = body.get("reply", body.get("detail", ""))
            expected["bot"] = text if isinstance(text, str) else json.dumps(text)
        for role, content in expected.items():
            found = [
                item
                for item in history
                if item.get("request_id") == record["id"] and item["role"] == role
            ]
            if found and found != [
                {"role": role, "content": content, "request_id": record["id"]}
            ]:
                raise ValueError(
                    "History conflicts with an operation receipt; recovery will not overwrite it"
                )
    overrides = json.loads(evidence[".env_overrides.json"] or "{}")
    if not isinstance(overrides, dict) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in overrides.items()
    ):
        raise ValueError("Invalid environment overrides")
    effective_environment = dict(os.environ)
    effective_environment.update(global_env_dict(cfg))
    preset_environment = preset.get("env_dict", {})
    if isinstance(preset_environment, dict):
        effective_environment.update(
            {
                key: value
                for key, value in preset_environment.items()
                if isinstance(value, str)
            }
        )
    effective_environment.update(overrides)
    for key, value in effective_environment.items():
        if (
            not isinstance(key, str)
            or not isinstance(value, str)
            or not key
            or "=" in key
            or "\0" in key
            or "\0" in value
        ):
            raise ValueError(
                "Effective environment contains an illegal process name or value"
            )
        # Match the process API's filesystem encoding, including surrogateescape.
        os.fsencode(key)
        os.fsencode(value)
    evidence["effective_environment_digest"] = digest(effective_environment)
    if (path / ".pi").is_symlink() or (path / ".pi/agent").is_symlink():
        raise ValueError("Pi configuration directory must not be a symlink")
    settings = read_file(path / ".pi/agent/settings.json")
    if settings is not None and not isinstance(json.loads(settings), dict):
        raise ValueError("Invalid Pi settings; inspect configuration before recovery")
    if (
        settings is not None
        and json.loads(settings).get("defaultThinkingLevel") != thinking
    ):
        raise ValueError(
            "Pi thinking setting differs from effective reasoning; inspect configuration before recovery"
        )
    evidence["settings"] = settings.decode() if settings is not None else None
    links = dict(cfg.get("session_symlink_dict", {}))
    managed = set(links)
    for other in aliases.values():
        managed.update(other.get("session_symlink_dict", {}))
    links.update(preset.get("session_symlink_dict", {}))
    link_evidence = {}
    for name in sorted(managed):
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Resource path escapes session")
        link = path / relative
        if not link.parent.resolve().is_relative_to(path.resolve()):
            raise ValueError("Resource parent escapes session")
        expected = (
            resolve_config_path(str(links[name]), config_dir) if name in links else None
        )
        actual = _absolute_link_target(str(link)) if link.is_symlink() else None
        if actual != expected or (expected is None and os.path.lexists(link)):
            raise ValueError(
                f"Resource {name} does not match selected agent; inspect configuration before recovery"
            )
        link_evidence[name] = {"actual": actual, "expected": expected}
    model = (
        (evidence[".model"] or "").strip()
        or preset.get("model")
        or cfg.get("pi_agent_model", "auto")
    )
    if not isinstance(model, str) or not model.strip():
        raise ValueError("Effective model is invalid")
    return {
        "summary": {
            "agent": agent,
            "model": model,
            "reasoning_effort": thinking,
        },
        "digest": digest(
            {
                "configuration": cfg,
                "config_dir": config_dir,
                "files": evidence,
                "links": link_evidence,
            }
        ),
    }


def get_media_store():
    owner = get_delivery_owner()
    key = str(owner.root)
    store = media_stores.get(key)
    if store is None or store.owner is not owner:
        store = MediaStore(owner, session_admission, lifecycle_gate)
        media_stores[key] = store
    return store


@contextmanager
def media_errors(*, upload=False):
    try:
        yield
    except HTTPException as exc:
        raise HTTPException(
            exc.status_code,
            exc.detail,
            headers={**(exc.headers or {}), **MEDIA_HEADERS},
        ) from exc
    except FileNotFoundError as exc:
        raise HTTPException(
            404, "Session or media publication not found", headers=MEDIA_HEADERS
        ) from exc
    except TimeoutError as exc:
        raise HTTPException(
            408,
            "Media upload timed out; observe the publication ID before explicitly retrying",
            headers=MEDIA_HEADERS,
        ) from exc
    except (OSError, ValueError, TypeError) as exc:
        raise HTTPException(
            507 if upload else 409,
            "Media publication not confirmed; use its exact metadata GET to observe it"
            if upload
            else "Media storage cannot be verified",
            headers=MEDIA_HEADERS,
        ) from exc


@app.put("/sessions/{session_id}/media/{publication_id}")
async def put_media(
    session_id: str,
    publication_id: str,
    request: Request,
    filename: str = Query(default=""),
):
    with media_errors(upload=True):
        item, created = await get_media_store().upload(
            session_id, publication_id, filename, request
        )
        return JSONResponse(
            {"media": item}, status_code=201 if created else 200, headers=MEDIA_HEADERS
        )


@app.get("/sessions/{session_id}/media")
async def list_media(
    session_id: str, revision: str | None = Query(default=None, max_length=64)
):
    with media_errors():
        return JSONResponse(
            get_media_store().listing(session_id, revision), headers=MEDIA_HEADERS
        )


@app.delete("/sessions/{session_id}/media/{publication_id}", status_code=204)
async def remove_media(session_id: str, publication_id: str):
    with media_errors():
        get_media_store().remove(session_id, publication_id)
        return Response(status_code=204, headers=MEDIA_HEADERS)


@app.get("/sessions/{session_id}/media/{publication_id}")
async def get_media(session_id: str, publication_id: str):
    with media_errors():
        return JSONResponse(
            {"media": get_media_store().lookup(session_id, publication_id)},
            headers=MEDIA_HEADERS,
        )


@app.api_route(
    "/sessions/{session_id}/media/{publication_id}/content", methods=["GET", "HEAD"]
)
async def get_media_content(
    session_id: str, publication_id: str, request: Request, download: bool = False
):
    with media_errors():
        return get_media_store().content(session_id, publication_id, request, download)


class RecoveryRequest(BaseModel):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    token: str = Field(pattern=r"^[0-9a-f]{64}$")
    acknowledge_possible_effects: StrictBool


@app.get("/sessions/{session_id}/recovery")
async def get_recovery(
    session_id: str,
    request_id: str | None = Query(default=None, pattern=r"^[0-9a-f]{32}$"),
):
    try:
        return JSONResponse(
            get_delivery_owner().recovery.status(session_id, request_id=request_id),
            headers={"Cache-Control": "no-store"},
        )
    except (OSError, ValueError, TypeError) as exc:
        raise HTTPException(
            409, f"Recovery evidence cannot be verified: {exc}"
        ) from exc


@app.post("/sessions/{session_id}/recovery")
async def post_recovery(session_id: str, request: RecoveryRequest):
    if not request.acknowledge_possible_effects:
        raise HTTPException(
            422, "Explicit acknowledgement of possible prior effects is required"
        )
    try:
        return JSONResponse(
            get_delivery_owner().recovery.status(
                session_id, token=request.token, request_id=request.request_id
            ),
            headers={"Cache-Control": "no-store"},
        )
    except (OSError, ValueError, TypeError) as exc:
        raise HTTPException(
            409, f"Recovery refused; session remains paused: {exc}"
        ) from exc


class OperationRequest(BaseModel):
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    message: str


def operation_error(exc):
    return send_response(indeterminate_send(str(exc)))


@app.post("/sessions/{session_id}/operations")
async def post_operation(session_id: str, request: OperationRequest):
    try:
        record, created = admit_operation(
            session_id, request.request_id, request.message
        )
        return JSONResponse(
            {"operation": public(record)}, status_code=202 if created else 200
        )
    except SendConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except (SendIndeterminate, OSError, ValueError) as exc:
        return operation_error(exc)


@app.get("/sessions/{session_id}/operations")
async def get_operations(session_id: str, request_id: list[str] = Query(default=[])):
    if len(request_id) > 64 or any(
        not re.fullmatch(r"[0-9a-f]{32}", value) for value in request_id
    ):
        raise HTTPException(400, "Supply at most 64 canonical request IDs")
    try:
        from recovery import acknowledged, read_ledger

        owner = get_delivery_owner()
        records = owner.listing(session_id, request_id)
        ledger = read_ledger(owner.root, session_id)
        acknowledged_records = [
            {"id": record["id"], "revision": record["revision"]}
            for record in records
            if record["state"] == "indeterminate"
            and acknowledged(ledger, record["id"], owner.path(session_id, record["id"]))
        ]
        return JSONResponse(
            {
                "operations": records,
                "recovery_required": owner.lane(session_id).paused,
                "recovery_acknowledged": acknowledged_records,
            },
            headers={"Cache-Control": "no-store"},
        )
    except (SendIndeterminate, OSError, ValueError) as exc:
        return operation_error(exc)


@app.get("/sessions/{session_id}/operations/{request_id}")
async def get_operation(session_id: str, request_id: str):
    if not re.fullmatch(r"[0-9a-f]{32}", request_id):
        raise HTTPException(400, "Invalid request ID")
    try:
        return JSONResponse(
            {"operation": public(get_delivery_owner().lookup(session_id, request_id))},
            headers={"Cache-Control": "no-store"},
        )
    except FileNotFoundError as exc:
        raise HTTPException(404, "Operation not found") from exc
    except (SendIndeterminate, OSError, ValueError) as exc:
        return operation_error(exc)


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
        get_delivery_owner().validate_session(session_id)
        with session_admission(root, session_id):
            await _run_notifyme_task(session_id, message)
    except HTTPException:
        # A stale background notification must not recreate a trashed session.
        logger.info("Notification skipped for an unavailable session.")


async def _run_notifyme_task(session_id: str, message: str):
    """Deliver a notification and optionally get an agent response.

    Raw delivery does not wait for execution. Optional reasoning is admitted
    only while the authoritative lane is idle; busy notifications remain raw
    rather than silently becoming queued agent work.
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

    # The idle check and process_chat admission have no intervening await.
    # process_chat is an adapter to the same owner, never another executor.
    owner = get_delivery_owner()
    if owner.busy(safe_id):
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
    get_delivery_owner().validate_session(session_id)
    safe_session_id = session_id
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
