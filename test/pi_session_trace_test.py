from __future__ import annotations

import json
from pathlib import Path

from tool.pi_session_trace import (
    extract_input_summary,
    find_session_file,
    format_compact,
    main,
    read_tool_calls,
)


def write_jsonl(path: Path, entries: list[object], malformed: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as output:
        for entry in entries:
            output.write(json.dumps(entry) + "\n")
        if malformed:
            output.write('{"type":"message"')


def assistant_call(call_id: str, name: str, arguments: object) -> dict[str, object]:
    return {
        "type": "message",
        "message": {
            "role": "assistant",
            "timestamp": f"call-{call_id}",
            "content": [
                {
                    "type": "toolCall",
                    "id": call_id,
                    "name": name,
                    "arguments": arguments,
                }
            ],
        },
    }


def tool_result(call_id: str, is_error: bool, content: object) -> dict[str, object]:
    return {
        "type": "message",
        "message": {
            "role": "toolResult",
            "toolCallId": call_id,
            "toolName": "test",
            "isError": is_error,
            "timestamp": f"result-{call_id}",
            "content": content,
        },
    }


def test_read_tool_calls_pairs_results_and_ignores_partial_line(tmp_path):
    session_path = tmp_path / "session.jsonl"
    write_jsonl(
        session_path,
        [
            {"type": "session", "version": 3},
            tool_result("early", False, [{"type": "text", "text": "done"}]),
            assistant_call("early", "read", {"path": "first.txt"}),
            assistant_call("failed", "bash", {"command": "false"}),
            tool_result("failed", True, [{"type": "text", "text": "failed"}]),
            {"type": "compaction", "summary": "irrelevant"},
            assistant_call("pending", "mystery", {"value": "x"}),
        ],
        malformed=True,
    )

    calls = read_tool_calls(session_path)

    assert [call.call_id for call in calls] == ["early", "failed", "pending"]
    assert calls[0].is_error is False
    assert calls[0].result_timestamp == "result-early"
    assert calls[1].is_error is True
    assert calls[2].is_error is None
    assert format_compact(calls[0]) == "read\t.\tfirst.txt"
    assert format_compact(calls[1]) == "bash\tE\tfalse"
    assert format_compact(calls[2]) == "mystery\t?\tvalue=x"


def test_extract_input_summary_handles_known_and_parallel_tools():
    assert extract_input_summary("read", {"path": "notes.txt", "offset": 7}) == (
        "notes.txt:7"
    )
    assert (
        extract_input_summary("edit", {"path": "main.py", "edits": [{}, {}]})
        == "main.py (2 edits)"
    )
    assert (
        extract_input_summary(
            "multi_tool_use.parallel",
            {
                "tool_uses": [
                    {"recipient_name": "functions.read"},
                    {"recipient_name": "functions.bash"},
                ]
            },
        )
        == "functions.read, functions.bash"
    )
    assert extract_input_summary("bash", {"command": "one\ntwo\tthree"}) == (
        "one\\ntwo<tab>three"
    )


def test_find_session_file_uses_newest_jsonl(tmp_path, monkeypatch):
    older = tmp_path / "session_old" / ".pi" / "agent" / "session" / "old.jsonl"
    newer = tmp_path / "session_new" / ".pi" / "agent" / "session" / "new.jsonl"
    write_jsonl(older, [])
    write_jsonl(newer, [])
    older.touch()
    newer.touch()
    older_mtime = newer.stat().st_mtime - 10
    older.chmod(0o600)
    import os

    os.utime(older, (older_mtime, older_mtime))
    monkeypatch.setenv("LIMILINK_SESSIONS_DIR", str(tmp_path))
    monkeypatch.delenv("PI_CODING_AGENT_DIR", raising=False)

    assert find_session_file() == newer
    assert find_session_file("session_old") == older
    assert find_session_file(str(newer)) == newer


def test_main_prints_last_calls_in_chronological_order(tmp_path, capsys):
    session_path = tmp_path / "session.jsonl"
    write_jsonl(
        session_path,
        [
            assistant_call("1", "read", {"path": "one"}),
            assistant_call("2", "read", {"path": "two"}),
            assistant_call("3", "read", {"path": "three"}),
        ],
    )

    assert main(["tool", "2", "--session", str(session_path)]) == 0

    captured = capsys.readouterr()
    assert captured.out.splitlines() == ["read\t?\ttwo", "read\t?\tthree"]
    assert f"# session: {session_path}" in captured.err


def test_main_verbose_emits_structured_jsonl(tmp_path, capsys):
    session_path = tmp_path / "session.jsonl"
    write_jsonl(
        session_path,
        [
            assistant_call("1", "write", {"path": "one", "content": "secret"}),
            tool_result("1", False, [{"type": "text", "text": "ok"}]),
        ],
    )

    assert main(["tool", "1", "--session", str(session_path), "-v"]) == 0

    record = json.loads(capsys.readouterr().out)
    assert record["name"] == "write"
    assert record["arguments"]["content"] == "secret"
    assert record["result"][0]["text"] == "ok"
    assert record["is_error"] is False
