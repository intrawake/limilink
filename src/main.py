from __future__ import annotations
import os
import re
import shutil
import subprocess
import asyncio
import json
import signal
import logging
import uuid
from typing import Any
from enum import Enum
import sxpb

try:
    from opentelemetry import trace  # type: ignore

    tracer = trace.get_tracer("limilink")
except ImportError:
    tracer = None
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI()


class HarnessType(str, Enum):
    GEMINI_CLI = "gemini-cli"
    PI = "pi"

    @classmethod
    def from_str(cls, value: str) -> HarnessType:
        if value in ("gemini", "gemini-cli"):
            return cls.GEMINI_CLI
        if value in ("pi", "pi-agent"):
            return cls.PI
        raise ValueError(f"Unsupported harness type: {value}")


# Global tracker for running Gemini CLI processes (session_id -> process)
running_processes: dict[str, asyncio.subprocess.Process] = {}
session_locks: dict[str, asyncio.Lock] = {}


def get_session_lock(session_id: str) -> asyncio.Lock:
    if session_id not in session_locks:
        session_locks[session_id] = asyncio.Lock()
    return session_locks[session_id]


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

    # 4. Create symlinks if configured
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


@app.post("/sessions")
async def create_session(agent: str | None = None):
    cfg, config_dir = load_config()
    sessions_dir = get_sessions_dir(cfg, config_dir)
    session_id = f"session_{uuid.uuid4().hex[:8]}"
    safe_id = sanitize_session_id(session_id)

    # Validate agent if provided
    if agent is not None:
        agent_by_alias = cfg.get("agent_by_alias", {})
        valid_agents = (
            list(HarnessType) + ["gemini", "pi-agent"] + list(agent_by_alias.keys())
        )
        if agent not in valid_agents:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid agent '{agent}'. Supported: {', '.join(sorted(set(valid_agents)))}",
            )

    session_path = os.path.join(sessions_dir, safe_id)
    os.makedirs(session_path, exist_ok=True)

    ensure_session_initialized(session_path, cfg, config_dir)

    # Write .agent_type if an agent was specified
    if agent is not None:
        agent_path = os.path.join(session_path, ".agent_type")
        with open(agent_path, "w") as f:
            f.write(agent)

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
            # Also clean up the per-session tmp dir
            session_tmp = get_session_tmp_dir(session_path)
            if os.path.isdir(session_tmp):
                shutil.rmtree(session_tmp, ignore_errors=True)
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


PI_PROVIDER_NAME = "default-provider"


def write_pi_models_json(
    session_path: str,
    preset: dict[Any, Any],
    cfg: dict[Any, Any],
    model: str,
):
    """Write models.json for a pi-agent session based on the given preset and model."""
    pi_base_url = preset.get("openai_base_url") or cfg.get("pi_agent_openai_base_url")
    if not pi_base_url:
        return
    pi_api_key = preset.get("openai_api_key") or cfg.get("pi_agent_openai_api_key")
    if not pi_api_key:
        return
    models_config = {
        "providers": {
            PI_PROVIDER_NAME: {
                "baseUrl": pi_base_url,
                "apiKey": pi_api_key,
                "api": preset.get("provider_api")
                or cfg.get("pi_agent_provider_api", "openai-completions"),
                "models": [
                    {
                        "id": model,
                        "name": model,
                        "contextWindow": 128000,
                        "maxTokens": 16384,
                        "input": ["text"],
                    }
                ],
            }
        }
    }
    models_json_path = os.path.join(session_path, "models.json")
    with open(models_json_path, "w") as f:
        json.dump(models_config, f, indent=2)


async def process_chat(session_id: str, message: str) -> str:
    try:
        # Secure the session_id to prevent directory traversal
        safe_session_id = sanitize_session_id(session_id)

        cfg, config_dir = load_config()
        sessions_dir = get_sessions_dir(cfg, config_dir)

        # Create an isolated project directory for this session
        session_path = os.path.join(sessions_dir, safe_session_id)
        os.makedirs(session_path, exist_ok=True)

        # Per-session tmp directory so pi/gemini-cli temp files are isolated
        session_tmp = get_session_tmp_dir(session_path)
        os.makedirs(session_tmp, exist_ok=True)

        # Ensure session initialized
        ensure_session_initialized(session_path, cfg, config_dir)

        # Determine agent alias for this session
        agent_by_alias = cfg.get("agent_by_alias", {})
        if not agent_by_alias:
            raise RuntimeError("Missing 'agent_by_alias' in config.sxpb")

        agent_path = os.path.join(session_path, ".agent_type")
        if os.path.exists(agent_path):
            with open(agent_path, "r") as f:
                agent_alias = f.read().strip()
        else:
            # Default to the first agent defined in the config
            agent_alias = list(agent_by_alias.keys())[0]

        # Resolve preset if it exists
        preset = agent_by_alias.get(agent_alias, {})

        # Determine and normalize harness
        harness_str = preset.get("harness", agent_alias)
        try:
            harness = HarnessType.from_str(harness_str)
        except ValueError:
            # Fallback for old/direct values if not in agent_by_alias
            harness = HarnessType.GEMINI_CLI  # Default fallback

        # Determine model for this session
        model_path = os.path.join(session_path, ".model")
        current_model = None
        if os.path.exists(model_path):
            with open(model_path, "r") as f:
                current_model = f.read().strip()

        if not current_model:
            if preset.get("model"):
                current_model = preset.get("model")
            elif harness == HarnessType.PI:
                current_model = cfg.get("pi_agent_model", "auto")
            else:
                current_model = "auto"

        # Handle stop command
        if message.strip() == "!stop":
            append_to_history(session_path, "user", message)
            process = running_processes.get(safe_session_id)
            if process:
                try:
                    # Kill the whole process group to ensure sub-commands are stopped
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                    reply = "Gemini CLI process stopped."
                except Exception as e:
                    reply = f"Failed to stop process: {e}"
            else:
                reply = "No active Gemini CLI process found for this session."
            append_to_history(session_path, "bot", reply)
            return reply

        # Handle agent switching command
        if message.startswith("!agent"):
            append_to_history(session_path, "user", message)
            parts = message.split(maxsplit=1)
            agent_path = os.path.join(session_path, ".agent_type")
            if len(parts) == 1:
                # Default to the first agent defined in the config
                current_agent_str = list(agent_by_alias.keys())[0]
                if os.path.exists(agent_path):
                    with open(agent_path, "r") as f:
                        current_agent_str = f.read().strip()
                reply = f"Current agent: {current_agent_str}"
                append_to_history(session_path, "bot", reply)
                return reply
            new_agent = parts[1].strip()

            # Valid agents are aliases OR raw harness types
            valid_agents = (
                list(HarnessType) + ["gemini", "pi-agent"] + list(agent_by_alias.keys())
            )
            if new_agent not in valid_agents:
                reply = f"Invalid agent. Supported aliases or harnesses: {', '.join(valid_agents)}"
                append_to_history(session_path, "bot", reply)
                return reply
            with open(agent_path, "w") as f:
                f.write(new_agent)

            # If switching to a pi harness, regenerate models.json for the new preset
            new_preset = agent_by_alias.get(new_agent, {})
            new_harness_str = new_preset.get("harness", new_agent)
            try:
                new_harness = HarnessType.from_str(new_harness_str)
            except ValueError:
                new_harness = HarnessType.GEMINI_CLI
            if new_harness == HarnessType.PI:
                new_model = new_preset.get("model") or cfg.get("pi_agent_model", "auto")
                write_pi_models_json(session_path, new_preset, cfg, new_model)

            reply = f"Agent switched to: {new_agent}"
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

            # If current harness is pi, regenerate models.json with the new model
            if harness == HarnessType.PI:
                write_pi_models_json(session_path, preset, cfg, new_model)

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

        # Handle stat command (pi harness only)
        if message.strip() == "!stat":
            append_to_history(session_path, "user", message)
            if harness != HarnessType.PI:
                reply = "!stat is only available for the pi harness."
                append_to_history(session_path, "bot", reply)
                return reply

            pi_agent_dir = os.path.join(session_path, ".pi-agent")
            jsonl_files = (
                sorted([f for f in os.listdir(pi_agent_dir) if f.endswith(".jsonl")])
                if os.path.isdir(pi_agent_dir)
                else []
            )
            if not jsonl_files:
                reply = "No pi-agent session data found. Send a message first!"
                append_to_history(session_path, "bot", reply)
                return reply

            stat_script = os.path.normpath(
                os.path.join(
                    os.path.dirname(__file__), "..", "tool", "pi_session_stat.py"
                )
            )
            try:
                stat_env = os.environ.copy()
                stat_env["PI_CODING_AGENT_DIR"] = session_path
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

        env = os.environ.copy()
        env["LIMILINK_SESSION"] = safe_session_id
        env["TMPDIR"] = get_session_tmp_dir(session_path)

        if harness == HarnessType.PI:
            pi_base_url = preset.get("openai_base_url") or cfg.get(
                "pi_agent_openai_base_url"
            )
            if not pi_base_url:
                raise RuntimeError(
                    "Missing 'pi_agent_openai_base_url' in config.sxpb. Cannot start pi-agent without an LLM endpoint."
                )

            pi_api_key = preset.get("openai_api_key") or cfg.get(
                "pi_agent_openai_api_key"
            )
            if not pi_api_key:
                raise RuntimeError(
                    "Missing 'pi_agent_openai_api_key' in config.sxpb. Cannot start pi-agent without an API key."
                )

            # Write models.json only if it doesn't exist yet (first run).
            # Subsequent changes go through !agent / !model which rewrite it.
            models_json_path = os.path.join(session_path, "models.json")
            if not os.path.exists(models_json_path):
                write_pi_models_json(session_path, preset, cfg, current_model)

            exepath = cfg.get("pi_agent_exepath", "pi-agent")

            # pi-agent env vars
            env["PI_CODING_AGENT_DIR"] = session_path

            # Build pi-agent args
            agent_args = []
            agent_args += ["--provider", PI_PROVIDER_NAME]
            agent_args += ["--model", current_model]
            agent_args += ["--session-dir", ".pi-agent"]
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

            cmd = [exepath] + agent_args + ["--continue", "-p", message]
        else:
            exepath = cfg.get("gemini_exepath", "gemini")
            args = preset.get("args") or cfg.get(
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

        # Merge preset env_dict if present
        preset_env_dict = preset.get("env_dict", {})
        if isinstance(preset_env_dict, dict):
            for name, value in preset_env_dict.items():
                if isinstance(value, str):
                    env[name] = value

        # Inject system.md path if configured (for gemini-cli)
        if harness == HarnessType.GEMINI_CLI:
            system_md_rel = cfg.get("gemini_system_md")
            if system_md_rel:
                system_md_rel = os.path.expanduser(system_md_rel)
                system_md_abs = (
                    system_md_rel
                    if os.path.isabs(system_md_rel)
                    else os.path.abspath(os.path.join(config_dir, system_md_rel))
                )
                env["GEMINI_SYSTEM_MD"] = system_md_abs
            elif "GEMINI_SYSTEM_MD" in env and not os.path.isabs(
                env["GEMINI_SYSTEM_MD"]
            ):
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

        if tracer:
            span = trace.get_current_span()
            span.set_attribute("limilink.session_id", safe_session_id)
            span.set_attribute("limilink.agent", harness.value)
            span.set_attribute("limilink.message", message)
            span.set_attribute("limilink.model", current_model)

        lock = get_session_lock(safe_session_id)
        async with lock:
            max_attempts = 3 if harness == HarnessType.PI else 1
            for attempt in range(max_attempts):
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
                    if not reply_text and harness == HarnessType.PI:
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
                print(f"Gemini CLI Error: {error_msg}")
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
                    status_code=500, detail=f"Gemini CLI failed: {error_msg}"
                )

        # Append bot reply to history
        append_to_history(session_path, "bot", reply_text)

        return reply_text

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Internal error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    try:
        reply_text = await process_chat(request.session_id, request.message)
        return {"reply": reply_text}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Internal error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def run_notifyme_task(session_id: str, message: str):
    try:
        reply_text = await process_chat(session_id, message)
        cfg, config_dir = load_config()
        sessions_dir = get_sessions_dir(cfg, config_dir)
        session_path = os.path.join(sessions_dir, sanitize_session_id(session_id))
        enqueue_unread_message(session_path, reply_text)
    except Exception as e:
        logging.error(f"Notifyme task failed for {session_id}: {e}")
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
