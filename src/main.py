from __future__ import annotations
import os
import re
import shutil
import subprocess
import asyncio
import json
import signal
from typing import Any
import sxpb
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI()

# Global tracker for running Gemini CLI processes (session_id -> process)
running_processes: dict[str, asyncio.subprocess.Process] = {}

# Base directory for isolated sessions


class ChatRequest(BaseModel):
    message: str
    session_id: str


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


def get_sessions_dir(cfg: dict[Any, Any], config_dir: str) -> str:
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
        pass
    return []


def ensure_session_initialized(session_path: str, cfg: dict[Any, Any], config_dir: str):
    # Marker to avoid re-initialization
    init_marker = os.path.join(session_path, ".initialized")
    if os.path.exists(init_marker):
        return

    # 1. Mark it as a project root so gemini-cli scopes history to this folder
    project_root_marker = os.path.join(session_path, ".project_root")
    if not os.path.exists(project_root_marker):
        with open(project_root_marker, "a"):
            pass

    # 2. Copy workspace GEMINI.md if configured
    workspace_md_rel = cfg.get("gemini_workspace_md")
    if workspace_md_rel:
        workspace_md_rel = os.path.expanduser(workspace_md_rel)
        workspace_md_abs = (
            workspace_md_rel
            if os.path.isabs(workspace_md_rel)
            else os.path.normpath(os.path.join(config_dir, workspace_md_rel))
        )
        if os.path.exists(workspace_md_abs):
            target_md = os.path.join(session_path, "GEMINI.md")
            if not os.path.exists(target_md):
                shutil.copy2(workspace_md_abs, target_md)

    # 3. Create symlinks if configured
    symlinks = cfg.get("workspace_symlink_by_basename", {})
    if isinstance(symlinks, dict):
        for basename, target in symlinks.items():
            target_expanded = os.path.expanduser(target)
            target_abs = (
                target_expanded
                if os.path.isabs(target_expanded)
                else os.path.normpath(os.path.join(config_dir, target_expanded))
            )
            link_path = os.path.join(session_path, basename)
            if not os.path.exists(link_path) and not os.path.islink(link_path):
                try:
                    os.makedirs(os.path.dirname(link_path), exist_ok=True)
                    os.symlink(target_abs, link_path)
                except Exception as e:
                    print(f"Failed to create symlink {link_path} -> {target_abs}: {e}")

    # 4. Create an outbox directory for file sending
    os.makedirs(os.path.join(session_path, "outbox"), exist_ok=True)

    # 5. Mark as initialized
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


@app.post("/sessions/{session_id}")
async def create_session(session_id: str):
    cfg, config_dir = load_config()
    sessions_dir = get_sessions_dir(cfg, config_dir)
    safe_id = sanitize_session_id(session_id)
    session_path = os.path.join(sessions_dir, safe_id)
    os.makedirs(session_path, exist_ok=True)

    ensure_session_initialized(session_path, cfg, config_dir)

    return {"status": "created", "session_id": safe_id}


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    cfg, config_dir = load_config()
    sessions_dir = get_sessions_dir(cfg, config_dir)
    safe_id = sanitize_session_id(session_id)
    session_path = os.path.join(sessions_dir, safe_id)
    if os.path.exists(session_path) and os.path.isdir(session_path):
        try:
            shutil.rmtree(session_path)
            return {"status": "deleted", "session_id": safe_id}
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
    history = load_session_history(session_path)
    history.append({"role": role, "content": content})
    with open(get_history_path(session_path), "w") as f:
        json.dump(history, f)


@app.get("/sessions/{session_id}/history", response_model=HistoryResponse)
async def get_session_history(session_id: str):
    cfg, config_dir = load_config()
    sessions_dir = get_sessions_dir(cfg, config_dir)
    safe_id = sanitize_session_id(session_id)
    session_path = os.path.join(sessions_dir, safe_id)
    if not os.path.exists(session_path):
        return {"history": []}
    return {"history": load_session_history(session_path)}


async def process_chat(session_id: str, message: str) -> str:
    try:
        # Secure the session_id to prevent directory traversal
        safe_session_id = sanitize_session_id(session_id)

        cfg, config_dir = load_config()
        sessions_dir = get_sessions_dir(cfg, config_dir)

        # Create an isolated project directory for this session
        session_path = os.path.join(sessions_dir, safe_session_id)
        os.makedirs(session_path, exist_ok=True)

        # Ensure session initialized
        ensure_session_initialized(session_path, cfg, config_dir)

        exepath = cfg.get("gemini_exepath", "gemini")
        # Determine model for this session
        model_path = os.path.join(session_path, ".model")
        current_model = None
        if os.path.exists(model_path):
            with open(model_path, "r") as f:
                current_model = f.read().strip()

        if not current_model:
            current_model = cfg.get("gemini_model", "auto")

        # Handle stop command
        if message.strip() == "!stop":
            append_to_history(session_path, "user", message)
            process = running_processes.get(safe_session_id)
            if process:
                try:
                    # Kill the whole process group to ensure sub-commands are stopped
                    os.killpg(os.getpgid(process.pid), signal.SIGTERM)
                    reply = "Gemini CLI process stopped."
                except Exception as e:
                    reply = f"Failed to stop process: {e}"
            else:
                reply = "No active Gemini CLI process found for this session."
            append_to_history(session_path, "bot", reply)
            return reply

        # Handle model switching command
        if message.startswith("!model"):
            append_to_history(session_path, "user", message)
            parts = message.split(maxsplit=1)
            if len(parts) == 1:
                reply = f"Current model: {current_model}"
                append_to_history(session_path, "bot", reply)
                return reply
            new_model = parts[1].strip()
            with open(model_path, "w") as f:
                f.write(new_model)
            reply = f"Model switched to: {new_model}"
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
                    with open(env_overrides_path, "r") as f:
                        env_overrides = json.load(f)
                except Exception:
                    pass

            if len(parts) == 1:
                reply = "Usage: !env <VAR_NAME> [VALUE]"
                append_to_history(session_path, "bot", reply)
                return reply

            var_name = parts[1]
            if len(parts) == 2:
                # To show the current value, we need to build the base env
                env = os.environ.copy()
                cfg_env = cfg.get("gemini_env", [])
                if isinstance(cfg_env, list):
                    for env_var in cfg_env:
                        if (
                            isinstance(env_var, dict)
                            and "name" in env_var
                            and "value" in env_var
                        ):
                            env[env_var["name"]] = env_var["value"]
                cfg_env_dict = cfg.get("gemini_env_dict", {})
                if isinstance(cfg_env_dict, dict):
                    for name, value in cfg_env_dict.items():
                        if isinstance(value, str):
                            env[name] = value

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
            with open(env_overrides_path, "w") as f:
                json.dump(env_overrides, f)
            reply = f"Environment variable {var_name} set to: {var_value}"
            append_to_history(session_path, "bot", reply)
            return reply

        args = cfg.get(
            "gemini_args",
            [
                "--approval-mode",
                "plan",
                "--resume",
                "latest",
                "-p",
            ],
        )

        # Inject --model into args if not already present or replace it
        if "--model" in args:
            new_args = list(args)
            for idx, arg in enumerate(new_args):
                if arg == "--model" and idx + 1 < len(new_args):
                    new_args[idx + 1] = current_model
                    break
            args = new_args
        else:
            args += ["--model", current_model]

        # Inject --resume latest if not already present
        if "--resume" not in args:
            args += ["--resume", "latest"]

        cmd = [exepath] + args + ["-p", message]

        env = os.environ.copy()
        env["LIMILINK_SESSION"] = safe_session_id

        # Add configured environment variables (list format)
        cfg_env = cfg.get("gemini_env", [])
        if isinstance(cfg_env, list):
            for env_var in cfg_env:
                if (
                    isinstance(env_var, dict)
                    and "name" in env_var
                    and "value" in env_var
                ):
                    env[env_var["name"]] = env_var["value"]

        # Add configured environment variables (dict format)
        cfg_env_dict = cfg.get("gemini_env_dict", {})
        if isinstance(cfg_env_dict, dict):
            for name, value in cfg_env_dict.items():
                if isinstance(value, str):
                    env[name] = value

        # Inject system.md path if configured
        system_md_rel = cfg.get("gemini_system_md")
        if system_md_rel:
            system_md_rel = os.path.expanduser(system_md_rel)
            system_md_abs = (
                system_md_rel
                if os.path.isabs(system_md_rel)
                else os.path.abspath(os.path.join(config_dir, system_md_rel))
            )
            env["GEMINI_SYSTEM_MD"] = system_md_abs
        elif "GEMINI_SYSTEM_MD" in env and not os.path.isabs(env["GEMINI_SYSTEM_MD"]):
            # Fallback path logic if it was provided directly in env list
            env["GEMINI_SYSTEM_MD"] = os.path.normpath(
                os.path.join(config_dir, env["GEMINI_SYSTEM_MD"])
            )

        # Apply session environment overrides
        env_overrides_path = os.path.join(session_path, ".env_overrides.json")
        if os.path.exists(env_overrides_path):
            try:
                with open(env_overrides_path, "r") as f:
                    env_overrides = json.load(f)
                for k, v in env_overrides.items():
                    env[k] = v
            except Exception:
                pass

        # Append user message to history
        append_to_history(session_path, "user", message)

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=session_path,  # Execute within the isolated directory
            env=env,
            process_group=0,  # Create a new process group for easy cleanup
        )

        running_processes[safe_session_id] = process
        try:
            stdout, stderr = await process.communicate()
        finally:
            if running_processes.get(safe_session_id) == process:
                del running_processes[safe_session_id]

        retcode = process.returncode
        if retcode is None or retcode == 0:
            reply_text = stdout.decode().strip()
            reply_text = re.sub(r".*\n\[Thought: true\]", "", reply_text)
        elif retcode < 0:
            # Process was terminated by a signal (e.g., via !stop)
            reply_text = f"Process terminated by signal {-retcode}."
        else:
            error_msg = stderr.decode().strip()
            print(f"Gemini CLI Error: {error_msg}")
            # Propagate common status codes (mapped to retcode % 256)
            # 173 = 429 % 256
            if retcode == 173 or "429" in error_msg or "Rate limit" in error_msg:
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
                status_code=500, detail=f"Gemini CLI failed: {error_msg}"
            )

        # Append bot reply to history
        append_to_history(session_path, "bot", reply_text)

        return reply_text

    except HTTPException:
        raise
    except Exception as e:
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    try:
        reply_text = await process_chat(request.session_id, request.message)
        return {"reply": reply_text}
    except HTTPException:
        raise
    except Exception as e:
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


async def run_notifyme_task(session_id: str, message: str):
    try:
        reply_text = await process_chat(session_id, message)
        cfg, config_dir = load_config()
        sessions_dir = get_sessions_dir(cfg, config_dir)
        session_path = os.path.join(sessions_dir, sanitize_session_id(session_id))
        enqueue_unread_message(session_path, reply_text)
    except Exception as e:
        print(f"Notifyme task failed for {session_id}: {e}")
        try:
            cfg, config_dir = load_config()
            sessions_dir = get_sessions_dir(cfg, config_dir)
            session_path = os.path.join(sessions_dir, sanitize_session_id(session_id))
            error_msg = str(e)
            if isinstance(e, HTTPException):
                error_msg = f"Error {e.status_code}: {e.detail}"
            enqueue_unread_message(session_path, f"❌ Chat failed: {error_msg}")
        except Exception:
            pass


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


# Mount a simple static directory if needed later for the UI
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
