"""Read-only per-ID outcomes, not guessed acknowledgement from busy/history."""

import asyncio
import json
import os
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

import main
from send_receipt import complete_send, receipt_path, reserve_send

A = "a" * 32
B = "b" * 32


@pytest.fixture
def root(test_sessions_dir):
    root = Path(test_sessions_dir)
    for name in ["session_a", "session_b"]:
        (root / name).mkdir()
        (root / name / "chat_history.json").write_text("[]")
    return root


@pytest.fixture
def client():
    with TestClient(main.app) as client:
        yield client


def peek(client, request_id=A, session="session_a", **params):
    return client.get(
        f"/sessions/{session}/snapshot", params={"request_id": request_id, **params}
    )


def test_missing_receipt_lookup_never_creates_or_reserves(client, root):
    before = (root / "session_a/chat_history.json").read_bytes()
    with patch("main._process_chat") as forbidden:
        for _ in range(2):
            assert peek(client).json()["send"] == {"id": A, "state": "missing"}
        assert peek(client, session="absent").status_code == 404
        forbidden.assert_not_called()
    assert not (root / "session_a/.web-requests").exists()
    assert not (root / "absent").exists()
    assert (root / "session_a/chat_history.json").read_bytes() == before


def test_invalid_query_id_rejected_before_lookup(client, root):
    assert peek(client, "A" * 32).status_code == 422
    assert not (root / "session_a/.web-requests").exists()


@pytest.mark.parametrize("status", [200, 429])
def test_completed_outcome_is_available_even_with_unchanged_history(
    client, root, status
):
    first = client.get("/sessions/session_a/snapshot").json()
    path = receipt_path(root / "session_a", A)
    _, reservation = reserve_send(path, "hello")
    assert peek(client).json()["send"]["state"] == "indeterminate"
    outcome = {
        "status": status,
        "body": {"reply": "ok"} if status == 200 else {"detail": "fixture refusal"},
    }
    complete_send(path, reservation, outcome)
    original = path.read_bytes()
    data = peek(client, revision=first["revision"]).json()
    assert "history" not in data
    assert data["send"] == {"id": A, "state": "complete", "outcome": outcome}
    assert path.read_bytes() == original
    assert peek(client, session="session_b").json()["send"]["state"] == "missing"
    assert not (root / "session_b/.web-requests").exists()


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "{",
        json.dumps(
            {
                "version": 1,
                "message_sha256": "broken",
                "state": "complete",
                "outcome": {"status": 200, "body": {"reply": "not proof"}},
            }
        ),
    ],
)
def test_corrupt_receipt_is_indeterminate_not_a_false_ack(client, root, raw):
    path = receipt_path(root / "session_a", A)
    path.write_text(raw)
    assert peek(client).json()["send"] == {"id": A, "state": "indeterminate"}
    assert path.read_text() == raw


def test_unreadable_and_nonregular_receipts_are_indeterminate(client, root):
    with patch("main.read_send", side_effect=PermissionError):
        assert peek(client).json()["send"]["state"] == "indeterminate"
    path = receipt_path(root / "session_a", A)
    os.mkfifo(path)
    assert peek(client).json()["send"]["state"] == "indeterminate"


@pytest.mark.asyncio
async def test_live_owner_proves_only_matching_id_and_cancellation_makes_it_indeterminate(
    root,
):
    started = asyncio.Event()

    async def blocked(session_id, message, lease_fd, request_id=None):
        main.append_to_history(str(root / session_id), "user", message)
        started.set()
        await asyncio.Event().wait()

    with patch("main._process_chat", side_effect=blocked) as execute:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            owner = asyncio.create_task(
                client.post(
                    "/chat",
                    json={
                        "session_id": "session_a",
                        "message": "hello",
                        "request_id": A,
                    },
                )
            )
            await started.wait()
            matching = (
                await client.get(
                    "/sessions/session_a/snapshot", params={"request_id": A}
                )
            ).json()
            unrelated = (
                await client.get(
                    "/sessions/session_a/snapshot", params={"request_id": B}
                )
            ).json()
            assert matching["send"] == {"id": A, "state": "running"}
            assert unrelated["busy"] and unrelated["history"] == [
                {"role": "user", "content": "hello"}
            ]
            assert unrelated["send"] == {"id": B, "state": "missing"}
            owner.cancel()
            with pytest.raises(asyncio.CancelledError):
                await owner
            orphan = (
                await client.get(
                    "/sessions/session_a/snapshot", params={"request_id": A}
                )
            ).json()
            assert orphan["send"] == {"id": A, "state": "indeterminate"}
    assert execute.call_count == 1
    assert (
        json.loads(receipt_path(root / "session_a", A).read_text())["state"]
        == "running"
    )
