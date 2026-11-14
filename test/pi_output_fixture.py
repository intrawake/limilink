"""Canonical completed invocation for subprocess mocks; never a plain-text fallback."""

import json


def json_events(*events):
    return b"".join(
        json.dumps(event, ensure_ascii=False).encode() + b"\n" for event in events
    )


def pi_stdout(text, *tail):
    return json_events(
        {"type": "session", "version": 3, "id": "fixture"},
        {"type": "agent_start"},
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "stopReason": "stop",
                "content": [{"type": "text", "text": text}],
            },
        },
        {"type": "agent_settled", "aborted": False},
        *tail,
    )
