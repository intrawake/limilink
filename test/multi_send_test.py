"""Concurrent web sends use existing execution locks; no providers or real signals."""

import asyncio
import json
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
        {"role": "bot", "content": "reply"},
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


@pytest.mark.asyncio
async def test_stop_current_preserves_waiting_followup_and_each_exact_receipt(
    configured,
):
    processes = []
    spawned = [asyncio.Event(), asyncio.Event()]
    waiting_user_recorded = asyncio.Event()
    append = main.append_to_history

    class Process:
        def __init__(self, index):
            self.pid = (
                900000 + index
            )  # Synthetic only: every signal function is patched.
            self.returncode = None
            self.release = asyncio.Event()

        async def communicate(self):
            await self.release.wait()
            if self.returncode is None:
                self.returncode = 0
            return b"fake reply", b""

    async def spawn(*args, **kwargs):
        index = len(processes)
        process = Process(index)
        processes.append(process)
        spawned[index].set()
        return process

    def append_spy(path, role, content, *, request_id=None):
        append(path, role, content, request_id=request_id)
        if role == "user" and request_id == B:
            waiting_user_recorded.set()

    def stop_group(pid, signal):
        process = next(process for process in processes if process.pid == pid)
        process.returncode = -9
        process.release.set()

    transport = httpx.ASGITransport(app=main.app)
    tasks = []
    with (
        patch("main.asyncio.create_subprocess_exec", side_effect=spawn),
        patch("main.append_to_history", side_effect=append_spy),
        patch("main.os.getpgid", side_effect=lambda pid: pid),
        patch("main.os.killpg", side_effect=stop_group) as signal_group,
    ):
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            try:

                def payload(message, request_id):
                    return {
                        "session_id": "session_a",
                        "message": message,
                        "request_id": request_id,
                    }

                first = asyncio.create_task(
                    client.post("/chat", json=payload("same", A))
                )
                tasks.append(first)
                await asyncio.wait_for(spawned[0].wait(), 3)
                second = asyncio.create_task(
                    client.post("/chat", json=payload("same", B))
                )
                tasks.append(second)
                await asyncio.wait_for(waiting_user_recorded.wait(), 3)
                assert len(processes) == 1 and not second.done()
                pending = (
                    await client.get(
                        "/sessions/session_a/snapshot", params={"request_id": B}
                    )
                ).json()
                assert pending["send"] == {
                    "id": B,
                    "state": "running",
                }  # A live owner, NOT proof of execution.
                stopped = await client.post("/chat", json=payload("!stop", STOP))
                assert (
                    stopped.status_code == 200
                    and stopped.json()["reply"] == "Agent process stopped."
                )
                await asyncio.wait_for(spawned[1].wait(), 3)
                assert len(processes) == 2 and not second.done()
                first_response = await asyncio.wait_for(first, 3)
                assert "terminated by signal" in first_response.json()["reply"]
                replay = await client.post("/chat", json=payload("!stop", STOP))
                assert replay.json() == stopped.json()
                assert signal_group.call_count == 1
                processes[1].release.set()
                assert (await asyncio.wait_for(second, 3)).json()[
                    "reply"
                ] == "fake reply"
                for request_id in [A, B, STOP]:
                    send = (
                        await client.get(
                            "/sessions/session_a/snapshot",
                            params={"request_id": request_id},
                        )
                    ).json()["send"]
                    assert send["id"] == request_id and send["state"] == "complete"
                    assert send["outcome"]["status"] == 200
            finally:
                for process in processes:
                    process.release.set()
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    users = [
        item
        for item in json.loads((configured / "session_a/chat_history.json").read_text())
        if item["role"] == "user"
    ]
    assert [item["request_id"] for item in users] == [A, B, STOP]
    assert [item["content"] for item in users] == ["same", "same", "!stop"]
