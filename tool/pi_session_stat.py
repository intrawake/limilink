#!/usr/bin/env python3
"""
pi_session_stat.py — Show context window usage for a pi-agent session.

Pure JSONL parsing with context window from pi-agent --list-models.
No SDK, no LLM calls, no session creation.

Usage:
    python3 pi_session_stat.py [session.jsonl]

If no path given, auto-detects from PI_CODING_AGENT_DIR env var.
"""

import json
import os
import subprocess
import sys
from pathlib import Path


def find_session_file():
    agent_dir = os.environ.get("PI_CODING_AGENT_DIR")
    if agent_dir:
        session_dir = Path(agent_dir) / "session"
        if session_dir.is_dir():
            files = sorted(session_dir.glob("*.jsonl"))
            if files:
                return files[-1]

    home_sessions = Path.home() / ".pi" / "agent" / "sessions"
    if home_sessions.is_dir():
        newest = None
        newest_mtime = 0
        for d in home_sessions.iterdir():
            if not d.is_dir():
                continue
            for f in d.glob("*.jsonl"):
                mtime = f.stat().st_mtime
                if mtime > newest_mtime:
                    newest_mtime = mtime
                    newest = f
        if newest:
            return newest

    return None


def context_window_from_pi(pi_agent_dir, provider, model_id):
    """Get context window label from pi-agent --list-models."""
    pi_agent_exe = os.environ.get("PI_AGENT_EXE", "pi-agent")
    env = {**os.environ, "PI_CODING_AGENT_DIR": pi_agent_dir}
    try:
        result = subprocess.run(
            [pi_agent_exe, "--list-models"],
            capture_output=True,
            text=True,
            timeout=5,
            env=env,
            check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None

    if result.returncode != 0:
        return None

    for line in result.stdout.strip().splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[0] == provider and parts[1] == model_id:
            return parts[2]
    return None


def main():
    session_path = sys.argv[1] if len(sys.argv) > 1 else find_session_file()
    if not session_path:
        print(
            "No session file found. Pass a path or set PI_CODING_AGENT_DIR.",
            file=sys.stderr,
        )
        sys.exit(1)

    session_path = Path(session_path)
    if not session_path.exists():
        print(f"File not found: {session_path}", file=sys.stderr)
        sys.exit(1)

    header = None
    last_usage = None
    last_model = None
    last_provider = None
    message_count = 0
    assistant_count = 0
    tool_call_count = 0
    total_cumulative_tokens = 0
    total_cost = 0.0

    with open(session_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            if entry.get("type") == "session":
                header = entry
                continue

            if entry.get("type") == "message" and "message" in entry:
                message_count += 1
                msg = entry["message"]

                if msg.get("role") == "assistant":
                    assistant_count += 1
                    content = msg.get("content", [])
                    if isinstance(content, list):
                        tool_call_count += sum(
                            1 for c in content if c.get("type") == "toolCall"
                        )

                    usage = msg.get("usage")
                    if usage:
                        last_usage = usage
                        last_model = msg.get("model")
                        last_provider = msg.get("provider")
                        total_cumulative_tokens += usage.get("totalTokens", 0)
                        cost = usage.get("cost", {})
                        if isinstance(cost, dict):
                            total_cost += cost.get("total", 0)

    pi_agent_dir = os.environ.get("PI_CODING_AGENT_DIR")
    context_label = None
    if pi_agent_dir and last_provider and last_model:
        context_label = context_window_from_pi(pi_agent_dir, last_provider, last_model)

    print(f"Session: {session_path.name}")
    if header and header.get("cwd"):
        print(f"CWD: {header['cwd']}")
    provider_prefix = f"{last_provider}/" if last_provider else ""
    print(f"Model: {provider_prefix}{last_model or '(unknown)'}")
    print(
        f"Context Window: {context_label + ' tokens' if context_label else 'unknown'}"
    )

    if last_usage:
        context_used = last_usage.get("totalTokens", 0)
        print(f"Context Used: {context_used:,} tokens")
        print(
            f"  (input: {last_usage.get('input', 0):,}, cacheRead: {last_usage.get('cacheRead', 0):,}, output: {last_usage.get('output', 0):,})"
        )
    else:
        print("Context Used: unknown (no assistant response with usage data)")

    print(f"\nMessages: {message_count} ({assistant_count} assistant)")
    print(f"Tool Calls: {tool_call_count}")
    print(f"Cumulative Tokens: {total_cumulative_tokens:,}")
    print(f"Total Cost: ${total_cost:.4f}")


if __name__ == "__main__":
    main()
