"""One-shot JSON output must survive late child notices, not invent replies."""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app
from pi_output import pi_json_reply
from test.pi_output_fixture import json_events, pi_stdout


def assistant(text="reply", reason="stop", blocks=None):
    return {
        "type": "message_end",
        "message": {
            "role": "assistant",
            "stopReason": reason,
            "content": blocks
            if blocks is not None
            else [{"type": "text", "text": text}],
        },
    }


NOTICE = {
    "type": "message_end",
    "message": {
        "role": "custom",
        "customType": "subagent-incremental-child-notify",
        "content": "PRIVATE child notification, not a reply",
    },
}
SETTLED = {"type": "agent_settled", "aborted": False}


def test_final_assistant_survives_notices_before_and_after_settlement():
    assert pi_json_reply(pi_stdout("Final reply", NOTICE)) == "Final reply"
    assert pi_json_reply(json_events(assistant(), NOTICE, SETTLED, NOTICE)) == "reply"
    assert (
        pi_json_reply(pi_stdout("First reply") + pi_stdout("Last reply", NOTICE))
        == "Last reply"
    )


def test_lf_framing_preserves_unicode_separators_and_text_blocks_only():
    blocks = [
        {"type": "thinking", "thinking": "PRIVATE reasoning"},
        {"type": "text", "text": "One\u2028two\u2029three"},
        {"type": "text", "text": "Four"},
    ]
    raw = json_events(assistant(blocks=blocks), SETTLED).replace(b"\n", b"\r\n")
    assert pi_json_reply(raw) == "One\u2028two\u2029three\nFour"


@pytest.mark.parametrize("reason", ["error", "aborted", "length", "toolUse", "pending"])
def test_unsuccessful_or_nonfinal_assistant_cannot_replace_an_earlier_reply(reason):
    raw = pi_stdout("earlier") + json_events(
        {"type": "agent_start"}, assistant(reason=reason), SETTLED
    )
    with pytest.raises(ValueError):
        pi_json_reply(raw)


def test_new_run_or_empty_reply_never_falls_back_to_previous_reply():
    assert (
        pi_json_reply(
            pi_stdout("earlier") + json_events({"type": "agent_start"}, NOTICE, SETTLED)
        )
        == ""
    )
    assert pi_json_reply(pi_stdout("earlier") + pi_stdout("", NOTICE)) == ""
    assert pi_json_reply(json_events(NOTICE, SETTLED)) == ""
    assert pi_json_reply(b"") == ""


@pytest.mark.parametrize(
    "raw",
    [
        b"not JSON\n",
        b"[]\n",
        b"{}\n",
        b"\xff\n",
        b'{"type":"agent_start"}',
        json_events(assistant()),
        json_events(assistant(), {"type": "agent_settled", "aborted": True}),
        json_events(assistant(blocks="invalid"), SETTLED),
        json_events(assistant(blocks=[{"type": "text", "text": 12}]), SETTLED),
        pi_stdout("old") + json_events(assistant("new without settle")),
    ],
)
def test_malformed_or_unsettled_output_fails_closed(raw):
    with pytest.raises(ValueError):
        pi_json_reply(raw)


@pytest.mark.asyncio
async def test_chat_receives_final_reply_despite_late_incremental_child_notice():
    process = AsyncMock()
    process.returncode = 0
    process.communicate.return_value = (
        pi_stdout("Both children finished.", NOTICE),
        b"",
    )
    with (
        patch("main.asyncio.create_subprocess_exec", return_value=process) as spawn,
        TestClient(app) as client,
    ):
        result = client.post(
            "/chat", json={"session_id": "late-notice", "message": "Try two children"}
        )
        assert result.status_code == 200
        assert result.json() == {"reply": "Both children finished."}
        history = client.get("/sessions/late-notice/history").json()["history"]
        assert history[-1] == {"role": "bot", "content": "Both children finished."}
    args = spawn.call_args.args
    assert args[args.index("--mode") + 1] == "json"
    assert args[-2:] == ("-p", "Try two children")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error_message,status",
    [
        ("429 Rate limit exceeded", 429),
        ("Authentication failed", 401),
        ("Provider failed", 500),
    ],
)
async def test_json_provider_error_preserves_rate_and_auth_classification(
    error_message, status
):
    failure = assistant(reason="error")
    failure["message"]["errorMessage"] = error_message
    process = AsyncMock()
    process.returncode = 0
    process.communicate.return_value = (json_events(failure, SETTLED), b"")
    with (
        patch("main.asyncio.create_subprocess_exec", return_value=process),
        TestClient(app) as client,
    ):
        result = client.post(
            "/chat", json={"session_id": "provider-error", "message": "hello"}
        )
        assert result.status_code == status
        assert error_message in result.json()["detail"]


@pytest.mark.asyncio
async def test_chat_does_not_claim_success_on_tool_or_custom_output_alone():
    process = AsyncMock()
    process.returncode = 0
    process.communicate.return_value = (json_events(NOTICE, SETTLED), b"")
    with (
        patch("main.asyncio.create_subprocess_exec", return_value=process),
        TestClient(app) as client,
    ):
        result = client.post(
            "/chat", json={"session_id": "no-reply", "message": "hello"}
        )
        assert result.status_code == 500
        assert "produced no output" in result.json()["detail"]
        history = client.get("/sessions/no-reply/history").json()["history"]
        assert history[-1]["content"] == result.json()["detail"]
        assert all("PRIVATE child" not in row["content"] for row in history)
