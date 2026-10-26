"""Per-ID at-most-once chat admission; no providers or text deduplication."""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
from send_receipt import complete_send, receipt_path, reserve_send
from session_layout import expire_session_trash, queue_session_trash


A = "a" * 32
B = "b" * 32


@pytest.fixture
def root(test_sessions_dir):
    root = Path(test_sessions_dir)
    (root / "session_a").mkdir()
    (root / "session_a/chat_history.json").write_text("[]")
    return root


@pytest.fixture
def calls(root, monkeypatch):
    calls = []

    async def fake_chat(
        session_id: str, message: str, lease_fd: int, request_id=None
    ) -> str:
        calls.append((session_id, message))
        main.append_to_history(str(root / session_id), "user", message)
        main.append_to_history(str(root / session_id), "bot", f"reply: {message}")
        return f"reply: {message}"

    monkeypatch.setattr(main, "_process_chat", fake_chat)
    return calls


def body(request_id=A, message="hello"):
    return {"session_id": "session_a", "message": message, "request_id": request_id}


def history(root):
    return json.loads((root / "session_a/chat_history.json").read_text())


@pytest.mark.asyncio
async def test_concurrent_and_completed_replay_invoke_chat_once(root):
    started, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def blocked(session_id, message, lease_fd, request_id=None):
        calls.append(message)
        main.append_to_history(str(root / session_id), "user", message)
        started.set()
        await release.wait()
        main.append_to_history(str(root / session_id), "bot", "single reply")
        return "single reply"

    with patch("main._process_chat", side_effect=blocked):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            first = asyncio.create_task(client.post("/chat", json=body()))
            await started.wait()
            duplicate = asyncio.create_task(client.post("/chat", json=body()))
            await asyncio.sleep(0)
            assert not duplicate.done()
            assert calls == ["hello"]
            release.set()
            one, two = await asyncio.gather(first, duplicate)
            assert one.status_code == two.status_code == 200
            assert one.json() == two.json() == {"reply": "single reply"}
            assert (await client.post("/chat", json=body())).json() == one.json()
    assert len(history(root)) == 2
    assert calls == ["hello"]
    assert not main.active_web_sends
    assert not main.session_activity
    with TestClient(main.app) as fresh, patch("main._process_chat") as forbidden:
        assert fresh.post("/chat", json=body()).json() == {"reply": "single reply"}
        forbidden.assert_not_called()


def test_different_ids_and_legacy_requests_preserve_identical_intentional_messages(
    root, calls
):
    with TestClient(main.app) as client:
        for request in [body(A), body(B), body(None), body(None)]:
            assert client.post("/chat", json=request).status_code == 200
    assert len(calls) == 4
    assert [entry["content"] for entry in history(root) if entry["role"] == "user"] == [
        "hello"
    ] * 4


@pytest.mark.asyncio
async def test_same_id_different_exact_message_conflicts_while_running_and_completed(
    root,
):
    started, release = asyncio.Event(), asyncio.Event()

    async def blocked(*args):
        started.set()
        await release.wait()
        return "reply"

    with patch("main._process_chat", side_effect=blocked):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            first = asyncio.create_task(
                client.post("/chat", json=body(message=" hello "))
            )
            await started.wait()
            assert (
                await client.post("/chat", json=body(message="hello"))
            ).status_code == 409
            release.set()
            assert (await first).status_code == 200
            assert (
                await client.post("/chat", json=body(message="hello"))
            ).status_code == 409


def test_errors_and_headers_are_cached_without_reinvocation(root):
    async def rejected(*args):
        raise HTTPException(
            status_code=429, detail={"reason": "fixture"}, headers={"Retry-After": "7"}
        )

    with (
        patch("main._process_chat", side_effect=rejected) as invoke,
        TestClient(main.app) as client,
    ):
        for _ in range(2):
            response = client.post("/chat", json=body())
            assert response.status_code == 429
            assert response.headers["retry-after"] == "7"
            assert response.json() == {"detail": {"reason": "fixture"}}
    assert invoke.call_count == 1


@pytest.mark.asyncio
async def test_cancelling_duplicate_waiter_does_not_cancel_owner(root):
    started, release = asyncio.Event(), asyncio.Event()

    async def blocked(*args):
        started.set()
        await release.wait()
        return "finished"

    with patch("main._process_chat", side_effect=blocked) as invoke:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            first = asyncio.create_task(client.post("/chat", json=body()))
            await started.wait()
            duplicate = asyncio.create_task(client.post("/chat", json=body()))
            await asyncio.sleep(0)
            duplicate.cancel()
            with pytest.raises(asyncio.CancelledError):
                await duplicate
            assert not first.done()
            release.set()
            assert (await first).json() == {"reply": "finished"}
    assert invoke.call_count == 1
    assert not main.active_web_sends


@pytest.mark.asyncio
async def test_owner_cancellation_unblocks_waiters_but_never_permits_reexecution(root):
    started = asyncio.Event()

    async def blocked(*args):
        started.set()
        await asyncio.Event().wait()

    with patch("main._process_chat", side_effect=blocked) as invoke:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            first = asyncio.create_task(client.post("/chat", json=body()))
            await started.wait()
            duplicate = asyncio.create_task(client.post("/chat", json=body()))
            await asyncio.sleep(0)
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first
            response = await asyncio.wait_for(duplicate, timeout=1)
            assert response.status_code == 409
            assert response.json()["code"] == "send_indeterminate"
            assert (await client.post("/chat", json=body())).status_code == 409
    assert invoke.call_count == 1
    assert not main.active_web_sends
    assert not main.session_activity


@pytest.mark.parametrize("raw", ["", "{", '{"version":1,"state":"other"}'])
def test_corrupt_reservation_fails_closed_and_is_never_overwritten(root, raw):
    path = receipt_path(root / "session_a", A)
    path.write_text(raw)
    with TestClient(main.app) as client, patch("main._process_chat") as forbidden:
        response = client.post("/chat", json=body())
        assert response.status_code == 409
        assert response.json()["code"] == "send_indeterminate"
        forbidden.assert_not_called()
    assert path.read_text() == raw


def test_orphan_running_reservation_after_restart_never_executes(root):
    path = receipt_path(root / "session_a", A)
    assert reserve_send(path, "hello")[0]
    with TestClient(main.app) as client, patch("main._process_chat") as forbidden:
        response = client.post("/chat", json=body())
        assert response.status_code == 409
        forbidden.assert_not_called()
    assert json.loads(path.read_text())["state"] == "running"


def test_terminal_write_failure_does_not_allow_a_second_invocation(root, calls):
    with TestClient(main.app) as client:
        with patch("main.complete_send", side_effect=OSError("disk full")):
            first = client.post("/chat", json=body())
        assert first.status_code == 409
        assert first.json()["code"] == "send_indeterminate"
        assert client.post("/chat", json=body()).status_code == 409
    assert len(calls) == 1
    assert len(history(root)) == 2
    assert (
        json.loads(receipt_path(root / "session_a", A).read_text())["state"]
        == "running"
    )


def test_partial_reservation_write_is_retained_and_never_executes(root, calls):
    with TestClient(main.app) as client:
        with patch("send_receipt.json.dump", side_effect=OSError("disk full")):
            assert client.post("/chat", json=body()).status_code == 409
        assert client.post("/chat", json=body()).status_code == 409
    assert calls == []
    assert receipt_path(root / "session_a", A).read_bytes() == b""


@pytest.mark.asyncio
async def test_trash_waits_for_execution_and_receipt_persistence_then_rejects_stale_replay(
    root,
):
    started, release = asyncio.Event(), asyncio.Event()

    async def blocked(*args):
        started.set()
        await release.wait()
        return "done"

    from send_receipt import complete_send

    def saving(path, reservation, outcome):
        assert expire_session_trash(root, lambda key: False, now=200) == []
        assert (root / "session_a").is_dir()
        complete_send(path, reservation, outcome)

    with (
        patch("main._process_chat", side_effect=blocked),
        patch("main.complete_send", side_effect=saving),
    ):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            first = asyncio.create_task(client.post("/chat", json=body()))
            await started.wait()
            queue_session_trash(root, "session_a", now=100)
            assert expire_session_trash(root, lambda key: False, now=200) == []
            release.set()
            assert (await first).status_code == 200
            assert expire_session_trash(root, lambda key: False, now=200) == [
                "session_a"
            ]
            assert (await client.post("/chat", json=body())).status_code == 409
    assert not (root / "session_a").exists()


@pytest.mark.parametrize("request_id", ["x", "A" * 32, "a" * 31, "../" * 11])
def test_invalid_ids_are_rejected_before_admission(root, request_id):
    with TestClient(main.app) as client:
        assert client.post("/chat", json=body(request_id)).status_code == 422
    assert not (root / "session_a/.web-requests").exists()


def test_same_id_is_scoped_to_session_and_does_not_deduplicate_text_globally(
    root, calls
):
    (root / "session_b").mkdir()
    with TestClient(main.app) as client:
        assert client.post("/chat", json=body()).status_code == 200
        other = {**body(), "session_id": "session_b"}
        assert client.post("/chat", json=other).status_code == 200
    assert calls == [("session_a", "hello"), ("session_b", "hello")]


def test_failed_terminal_replace_leaves_original_reservation_and_no_temp_files(root):
    path = receipt_path(root / "session_a", A)
    _, record = reserve_send(path, "hello")
    original = path.read_bytes()
    with patch("send_receipt.os.replace", side_effect=OSError("disk error")):
        with pytest.raises(OSError):
            complete_send(path, record, {"status": 200, "body": {"reply": "done"}})
    assert path.read_bytes() == original
    assert not list(path.parent.glob("*.tmp"))
    assert reserve_send(path, "hello")[0] is False


def test_reservation_elects_one_owner_across_separate_processes(root):
    path = receipt_path(root / "session_a", A)
    reader, writer = os.pipe()
    code = (
        "import json,os,sys; from pathlib import Path; "
        "from send_receipt import reserve_send,SendIndeterminate; "
        "os.read(int(sys.argv[2]),1); "
        "\ntry: print(json.dumps({'owner':reserve_send(Path(sys.argv[1]),'hello')[0]}))"
        "\nexcept SendIndeterminate: print(json.dumps({'owner':False,'indeterminate':True}))"
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    children = []
    try:
        for _ in range(2):
            children.append(
                subprocess.Popen(
                    [sys.executable, "-c", code, str(path), str(reader)],
                    pass_fds=(reader,),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=env,
                )
            )
        os.write(writer, b"xx")
        results = []
        for child in children:
            stdout, stderr = child.communicate(timeout=10)
            assert child.returncode == 0, stderr.decode()
            results.append(json.loads(stdout))
        assert sum(result["owner"] for result in results) == 1
        assert reserve_send(path, "hello")[0] is False
    finally:
        os.close(reader)
        os.close(writer)
        for child in children:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=10)
