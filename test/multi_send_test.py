"""Concurrent web sends use existing execution locks; no providers or real signals."""

from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

import main
from session_snapshot import reply_evidence

A, B, STOP = "a" * 32, "b" * 32, "c" * 32


@pytest.fixture
def configured(test_sessions_dir, monkeypatch):
    root = Path(test_sessions_dir)
    (root / "session_a").mkdir()
    (root / "session_a" / "chat_history.json").write_text("[]")
    monkeypatch.setattr(
        main,
        "load_config",
        lambda: (
            {
                "agent_by_alias": {"pi-test": {"harness": "pi", "model": "fake"}},
                "pi_agent_exepath": "/bin/false",
            },
            str(root.parent),
        ),
    )
    return root


def test_optional_identity_preserves_idless_history_and_reply_tokens(tmp_path):
    main.append_to_history(str(tmp_path), "user", "same")
    main.append_to_history(str(tmp_path), "bot", "reply", request_id=A)
    before = main.load_session_history(str(tmp_path))
    assert before == [
        {"role": "user", "content": "same"},
        {"role": "bot", "content": "reply", "request_id": A},
    ]
    tagged = [dict(item) for item in before]
    tagged[0]["request_id"] = A
    assert reply_evidence(before, "without-send-id") == reply_evidence(
        tagged, "with-send-id"
    )
    main.append_to_history(str(tmp_path), "user", "same", request_id=B)
    assert main.load_session_history(str(tmp_path))[-1] == {
        "role": "user",
        "content": "same",
        "request_id": B,
    }


@pytest.mark.asyncio
async def test_command_identity_and_replay_do_not_duplicate_history(configured):
    transport = httpx.ASGITransport(app=main.app)
    payload = {"session_id": "session_a", "message": "!unknown", "request_id": A}
    with patch("main.asyncio.create_subprocess_exec") as forbidden:
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            first = await client.post("/chat", json=payload)
            second = await client.post("/chat", json=payload)
            snapshot = (await client.get("/sessions/session_a/snapshot")).json()
            legacy = (await client.get("/sessions/session_a/history")).json()
    assert first.status_code == 200 and first.json() == second.json()
    forbidden.assert_not_called()
    assert snapshot["send_identities"] is True
    users = [item for item in snapshot["history"] if item["role"] == "user"]
    assert users == [{"role": "user", "content": "!unknown", "request_id": A}]
    # Keep the old /history role/content projection for existing clients.
    assert all("request_id" not in item for item in legacy["history"])
