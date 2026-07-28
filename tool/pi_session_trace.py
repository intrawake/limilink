#!/usr/bin/env python3
"""Inspect events in local pi-agent session JSONL files.

Usage:
    python3 tool/pi_session_trace.py tool [COUNT] [--session PATH_OR_ID]

The first trace selector is ``tool``. Additional event selectors can be added
without changing Limilink's ``!trace SELECTOR`` command shape.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Iterator
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

DEFAULT_COUNT = 10
MAX_COUNT = 100
MAX_SUMMARY_LENGTH = 240


@dataclass
class ToolCall:
    name: str
    call_id: str
    arguments: Any
    timestamp: str | None
    result: Any = None
    result_timestamp: str | None = None
    is_error: bool | None = None


def iter_entries(session_path: Path) -> Iterator[dict[str, Any]]:
    """Yield JSON objects, ignoring blank or malformed lines.

    An active pi process may be appending the final line while this script
    reads it, so a partial final record is not fatal.
    """
    with session_path.open() as session_file:
        for line in session_file:
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict):
                yield entry


def read_tool_calls(session_path: Path) -> list[ToolCall]:
    """Read tool calls and pair them with tool results by call ID."""
    calls: list[ToolCall] = []
    calls_by_id: dict[str, ToolCall] = {}
    results_by_id: dict[str, dict[str, Any]] = {}

    for entry in iter_entries(session_path):
        if entry.get("type") != "message":
            continue
        message = entry.get("message")
        if not isinstance(message, dict):
            continue

        role = message.get("role")
        if role == "assistant":
            content = message.get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if not isinstance(part, dict) or part.get("type") != "toolCall":
                    continue
                call_id = str(part.get("id", ""))
                call = ToolCall(
                    name=str(part.get("name", "?")),
                    call_id=call_id,
                    arguments=part.get("arguments"),
                    timestamp=_optional_string(message.get("timestamp")),
                )
                calls.append(call)
                if call_id:
                    calls_by_id[call_id] = call
                    if call_id in results_by_id:
                        _apply_result(call, results_by_id[call_id])

        elif role == "toolResult":
            call_id = str(message.get("toolCallId", ""))
            if not call_id:
                continue
            results_by_id[call_id] = message
            call = calls_by_id.get(call_id)
            if call is not None:
                _apply_result(call, message)

    return calls


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _apply_result(call: ToolCall, message: dict[str, Any]) -> None:
    call.result = message.get("content")
    call.result_timestamp = _optional_string(message.get("timestamp"))
    is_error = message.get("isError")
    call.is_error = is_error if isinstance(is_error, bool) else None


def extract_input_summary(tool_name: str, arguments: Any) -> str:
    """Describe a tool invocation without dumping its complete arguments."""
    if not isinstance(arguments, dict):
        return _one_line(arguments)

    if tool_name == "bash":
        summary = arguments.get("command", "")
    elif tool_name == "read":
        summary = arguments.get("path", "")
        offset = arguments.get("offset")
        if offset is not None:
            summary = f"{summary}:{offset}"
    elif tool_name == "edit":
        path = arguments.get("path", "")
        edits = arguments.get("edits")
        edit_count = len(edits) if isinstance(edits, list) else 1
        summary = f"{path} ({edit_count} edits)"
    elif tool_name == "write":
        summary = arguments.get("path", "")
    elif tool_name == "search_web":
        summary = arguments.get("query", "")
    elif tool_name == "parallel" or tool_name.endswith(".parallel"):
        tool_uses = arguments.get("tool_uses")
        if isinstance(tool_uses, list):
            names = [
                str(use.get("recipient_name", "?"))
                for use in tool_uses
                if isinstance(use, dict)
            ]
            summary = ", ".join(names)
        else:
            summary = ""
    else:
        first_key = next(iter(arguments), None)
        summary = f"{first_key}={arguments[first_key]}" if first_key is not None else ""

    return _one_line(summary)


def _one_line(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).replace("\t", "<tab>").replace("\r", "\\r").replace("\n", "\\n")
    if len(text) > MAX_SUMMARY_LENGTH:
        return text[: MAX_SUMMARY_LENGTH - 1] + "…"
    return text


def format_compact(call: ToolCall) -> str:
    if call.is_error is None:
        status = "?"
    elif call.is_error:
        status = "E"
    else:
        status = "."
    summary = extract_input_summary(call.name, call.arguments)
    return f"{call.name}\t{status}\t{summary}"


def format_verbose(call: ToolCall) -> str:
    record = asdict(call)
    record["input"] = extract_input_summary(call.name, call.arguments) or None
    return json.dumps(record, ensure_ascii=False)


def find_session_file(session: str | None = None) -> Path | None:
    """Resolve a JSONL path, Limilink session ID, or newest local session."""
    sessions_root = _sessions_root()

    if session:
        candidate = Path(session).expanduser()
        if candidate.is_file():
            return candidate
        if not candidate.exists():
            candidate = sessions_root / session
        return _newest_jsonl(candidate)

    agent_dir = os.environ.get("PI_CODING_AGENT_DIR")
    if agent_dir:
        found = _newest_jsonl(Path(agent_dir).expanduser() / "session")
        if found is not None:
            return found

    return _newest_jsonl(sessions_root)


def _sessions_root() -> Path:
    configured = os.environ.get("LIMILINK_SESSIONS_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path(__file__).resolve().parent.parent / "session"


def _newest_jsonl(path: Path) -> Path | None:
    if path.is_file() and path.suffix == ".jsonl":
        return path
    if not path.is_dir():
        return None

    direct_files = list(path.glob("*.jsonl"))
    nested_files = list(path.glob(".pi/agent/session/*.jsonl"))
    session_files = list(path.glob("session_*/.pi/agent/session/*.jsonl"))
    files = direct_files + nested_files + session_files
    if not files:
        return None
    return max(files, key=lambda item: (item.stat().st_mtime, str(item)))


def count_argument(value: str) -> int:
    try:
        count = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("count must be an integer") from error
    if not 1 <= count <= MAX_COUNT:
        raise argparse.ArgumentTypeError(f"count must be between 1 and {MAX_COUNT}")
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Inspect local pi-agent session traces"
    )
    parser.add_argument("selector", help="Event selector (currently: tool)")
    parser.add_argument(
        "count",
        nargs="?",
        default=DEFAULT_COUNT,
        type=count_argument,
        help=f"number of recent records (default: {DEFAULT_COUNT}, max: {MAX_COUNT})",
    )
    parser.add_argument(
        "--session",
        help="session JSONL path or Limilink session ID (default: newest)",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="emit structured JSONL including full arguments and results",
    )
    args = parser.parse_args(argv)

    if args.selector != "tool":
        parser.error(f"unsupported selector: {args.selector!r} (available: tool)")

    session_path = find_session_file(args.session)
    if session_path is None:
        print("No pi-agent session data found.", file=sys.stderr)
        return 1

    calls = read_tool_calls(session_path)[-args.count :]
    print(f"# session: {session_path}", file=sys.stderr)
    if not calls:
        print("No tool calls found.")
        return 0

    formatter = format_verbose if args.verbose else format_compact
    for call in calls:
        print(formatter(call))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
