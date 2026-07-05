#!/usr/bin/env python3
"""
pi_session_stat.py — Show context window usage for a pi-agent session.

Pure JSONL parsing + models.json lookup. No SDK, no LLM calls, no session creation.

Usage:
    python3 pi_session_stat.py [session.jsonl]

If no path given, auto-detects from PI_CODING_AGENT_DIR env var.
"""

import json
import os
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


def find_models_json(session_path):
    agent_dir = os.environ.get("PI_CODING_AGENT_DIR")
    if agent_dir:
        p = Path(agent_dir) / "models.json"
        if p.exists():
            return json.loads(p.read_text())

    if session_path:
        p = Path(session_path).parent.parent / "models.json"
        if p.exists():
            return json.loads(p.read_text())

    p = Path.home() / ".pi" / "agent" / "models.json"
    if p.exists():
        return json.loads(p.read_text())

    return None


def lookup_context_window(models_json, provider, model_id):
    if not models_json or "providers" not in models_json:
        return None
    prov = models_json["providers"].get(provider)
    if not prov or "models" not in prov:
        return None
    for m in prov["models"]:
        if m.get("id") == model_id:
            return m.get("contextWindow")
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

    models_json = find_models_json(session_path)
    context_window = None
    if last_provider and last_model:
        context_window = lookup_context_window(models_json, last_provider, last_model)

    print(f"Session: {session_path.name}")
    if header and header.get("cwd"):
        print(f"CWD: {header['cwd']}")
    provider_prefix = f"{last_provider}/" if last_provider else ""
    print(f"Model: {provider_prefix}{last_model or '(unknown)'}")
    print(
        f"Context Window: {f'{context_window:,}' if context_window else 'unknown'} tokens"
    )

    if last_usage:
        context_used = last_usage.get("totalTokens", 0)
        pct = f" ({context_used / context_window * 100:.1f}%)" if context_window else ""
        print(f"Context Used: {context_used:,} tokens{pct}")
        if context_window:
            print(f"Context Remaining: {context_window - context_used:,} tokens")
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
