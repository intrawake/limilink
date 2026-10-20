"""Trash grace, admission, and restart recovery. No provider calls or real waits."""

import asyncio
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import main
import session_layout as layout
from session_lease import session_lease


@pytest.fixture
def root(test_sessions_dir):
    root = Path(test_sessions_dir)
    for key in ["session_a", "session_b", "session_c"]:
        path = root / key
        path.mkdir()
        (path / "chat_history.json").write_text(
            '[{"role":"user","content":"preserve"}]'
        )
    return root


def ids(root):
    return [item["id"] for item in layout.list_session_details(root)]


def test_trash_bottom_replay_and_undo_preserve_files_and_position(root):
    layout.reorder_sessions(root, ["session_c", "session_a", "session_b"])
    original = (root / "session_a/chat_history.json").read_bytes()
    assert layout.queue_session_trash(root, "session_a", now=100) == 160
    assert layout.queue_session_trash(root, "session_a", now=120) == 160
    assert ids(root) == ["session_c", "session_b", "session_a"]
    assert layout.list_session_details(root)[-1]["delete_at"] == 160
    assert layout.expire_session_trash(root, lambda key: False, now=159.9) == []
    assert (root / "session_a/chat_history.json").read_bytes() == original
    layout.restore_session(root, "session_a", now=159.9)
    assert ids(root) == ["session_c", "session_a", "session_b"]
    assert "delete_at" not in layout.list_session_details(root)[1]
    assert (root / "session_a/chat_history.json").read_bytes() == original


def test_active_reorder_preserves_trashed_slot_for_undo(root):
    layout.queue_session_trash(root, "session_b", now=100)
    layout.reorder_sessions(root, ["session_c", "session_a"])
    assert ids(root) == ["session_c", "session_a", "session_b"]
    layout.restore_session(root, "session_b", now=101)
    assert ids(root) == ["session_c", "session_b", "session_a"]


def test_expiry_keeps_tombstone_and_undo_never_reopens_after_cutoff(root):
    layout.queue_session_trash(root, "session_a", now=100)
    assert layout.expire_session_trash(root, lambda key: True, now=160) == []
    with pytest.raises(layout.TrashExpired):
        layout.restore_session(root, "session_a", now=160)
    assert layout.expire_session_trash(root, lambda key: False, now=161) == [
        "session_a"
    ]
    assert not (root / "session_a").exists()
    assert layout.trash_deadline(root, "session_a") == 0
    with pytest.raises(layout.TrashExpired):
        layout.restore_session(root, "session_a", now=162)
    # Renaming/reordering other sessions must not prune the deleted-ID tombstone.
    layout.rename_session(root, "session_b", "B")
    layout.reorder_sessions(root, ["session_c", "session_b"])
    assert layout.trash_deadline(root, "session_a") == 0


def test_failed_queue_write_does_not_delete_or_claim_success(root):
    with patch("session_layout.os.replace", side_effect=OSError("disk full")):
        with pytest.raises(OSError):
            layout.queue_session_trash(root, "session_a", now=100)
    assert layout.trash_deadline(root, "session_a") is None
    assert (root / "session_a/chat_history.json").exists()
    assert not list(root.glob("*.tmp"))


def test_partial_removal_failure_cannot_restore_and_retries_safely(root):
    layout.queue_session_trash(root, "session_a", now=100)
    with patch("session_layout.shutil.rmtree", side_effect=OSError("busy file")):
        assert layout.expire_session_trash(root, lambda key: False, now=160) == []
    assert layout.trash_deadline(root, "session_a") == 0
    with pytest.raises(layout.TrashExpired):
        layout.restore_session(root, "session_a", now=1)  # Even after clock rollback.
    assert layout.expire_session_trash(root, lambda key: False, now=162) == [
        "session_a"
    ]


def test_api_grace_is_server_managed_without_confirmation(root):
    with TestClient(main.app) as client:
        response = client.post("/sessions/session_a/trash")
        assert response.status_code == 200
        data = response.json()
        assert abs(data["sessions"][-1]["delete_at"] - data["server_time"] - 60) < 1
        assert data["sessions"][-1]["id"] == "session_a"
        assert (
            client.post(
                "/chat", json={"session_id": "session_a", "message": "hello"}
            ).status_code
            == 409
        )
        assert client.delete("/sessions/session_a").status_code == 409
        assert client.delete("/sessions/session_a/trash").status_code == 200
        assert ids(root) == ["session_a", "session_b", "session_c"]
        assert client.post("/sessions/missing/trash").status_code == 404
        assert client.post("/sessions/session.a/trash").status_code == 400


def test_restart_recovers_due_deletion_and_stale_requests_cannot_resurrect(root):
    layout.queue_session_trash(root, "session_a", now=time.time() - 120)
    with TestClient(main.app) as client:
        assert not (root / "session_a").exists()  # Startup sweep, before any request.
        assert (
            client.post(
                "/chat", json={"session_id": "session_a", "message": "late"}
            ).status_code
            == 409
        )
        assert client.delete("/sessions/session_a/trash").status_code == 410
        assert (
            client.post(
                "/sessions/session_a/notifyme", json={"message": "late job"}
            ).status_code
            == 200
        )
    assert not (root / "session_a").exists()
    with TestClient(main.app) as fresh:
        assert (
            fresh.post(
                "/chat", json={"session_id": "session_a", "message": "still late"}
            ).status_code
            == 409
        )
    assert not (root / "session_a").exists()


def test_restart_keeps_future_deadline_and_lease_or_io_error_defers(root):
    deadline = layout.queue_session_trash(root, "session_a")
    with TestClient(main.app):
        assert layout.trash_deadline(root, "session_a") == deadline
    layout.queue_session_trash(root, "session_b", now=time.time() - 120)
    with session_lease(root, "session_b"):
        main.sweep_session_trash()
        assert (root / "session_b/chat_history.json").exists()
    with patch("session_lease.fcntl.flock", side_effect=OSError("lock unavailable")):
        main.sweep_session_trash()
        assert (root / "session_b/chat_history.json").exists()
    main.sweep_session_trash()
    assert not (root / "session_b").exists()


@pytest.mark.asyncio
async def test_admission_covers_work_before_execution_lock_and_completion(root):
    admitted, finish = asyncio.Event(), asyncio.Event()

    async def before_execution_lock(*args):
        admitted.set()
        await finish.wait()
        return "completed reply"

    with patch("main._process_chat", side_effect=before_execution_lock):
        task = asyncio.create_task(main.process_chat("session_a", "hello"))
        await admitted.wait()
        layout.queue_session_trash(root, "session_a", now=time.time() - 120)
        main.sweep_session_trash()
        assert (root / "session_a/chat_history.json").exists()
        finish.set()
        assert await task == "completed reply"
        main.sweep_session_trash()
    assert not (root / "session_a").exists()
    assert not main.session_activity


def test_gc_cannot_bypass_grace_and_explicit_creation_avoids_tombstones(root):
    layout.queue_session_trash(root, "session_a")
    with TestClient(main.app) as client:
        response = client.post(
            "/chat", json={"session_id": "gc_caller", "message": "!gc day 0"}
        )
        assert response.status_code == 200
        assert (root / "session_a/chat_history.json").exists()
        assert (root / "gc_caller").exists()
        assert not (root / "session_b").exists()
        dead = root / "session_deadbeef"
        dead.mkdir()
        layout.delete_session_now(root, dead.name)
        with patch(
            "main.uuid.uuid4",
            side_effect=[
                SimpleNamespace(hex="deadbeef00"),
                SimpleNamespace(hex="cafebabe00"),
            ],
        ):
            response = client.post("/sessions")
        assert response.status_code == 200
        assert response.json()["session_id"] == "session_cafebabe"
        assert not dead.exists()


def test_lifespan_cancels_and_awaits_owned_worker(root):
    closed = threading.Event()

    async def worker():
        try:
            await asyncio.Event().wait()
        finally:
            closed.set()

    with patch("main.trash_worker", side_effect=worker), TestClient(main.app) as client:
        assert client.get("/sessions").status_code == 200
        assert not closed.is_set()
    assert closed.is_set()


def test_corrupt_trash_metadata_fails_closed(root):
    (root / ".session-layout.json").write_text(
        json.dumps(
            {
                "titles": {},
                "order": [],
                "trash_deadlines": {"session_a": "not-a-deadline"},
            }
        )
    )
    with TestClient(main.app) as client:
        assert client.post("/sessions/session_a/trash").status_code == 500
        assert client.delete("/sessions/session_a/trash").status_code == 500
        assert (
            client.post(
                "/chat", json={"session_id": "session_a", "message": "hello"}
            ).status_code
            == 500
        )
    assert (root / "session_a/chat_history.json").exists()


def test_newly_trashed_session_goes_last_and_deadline_replay_does_not_reorder(root):
    layout.queue_session_trash(root, "session_a", now=100)
    layout.queue_session_trash(root, "session_b", now=101)
    assert ids(root) == ["session_c", "session_a", "session_b"]
    layout.queue_session_trash(root, "session_a", now=102)
    assert ids(root) == ["session_c", "session_a", "session_b"]


@pytest.mark.asyncio
async def test_notification_admission_covers_final_delivery(root):
    admitted, finish = asyncio.Event(), asyncio.Event()

    async def delivery(*args):
        admitted.set()
        await finish.wait()

    with patch("main._run_notifyme_task", side_effect=delivery):
        task = asyncio.create_task(main.run_notifyme_task("session_a", "job done"))
        await admitted.wait()
        layout.queue_session_trash(root, "session_a", now=time.time() - 120)
        main.sweep_session_trash()
        assert (root / "session_a").exists()
        finish.set()
        await task
        main.sweep_session_trash()
    assert not (root / "session_a").exists()


def test_agent_inherits_lease_independently_of_environment_overrides(root):
    from unittest.mock import AsyncMock

    config = {
        "agent_by_alias": {"pi-test": {"harness": "pi", "model": "test-model"}},
        "env_dict": {"LIMILINK_SESSION": "forged", "LIMILINK_SESSION_ROOT": "/forged"},
    }
    process = AsyncMock()
    process.returncode = 0
    process.communicate.return_value = (b"reply", b"")
    with (
        patch("main.load_config", return_value=(config, str(root))),
        patch("main.asyncio.create_subprocess_exec", return_value=process) as launch,
        TestClient(main.app) as client,
    ):
        response = client.post(
            "/chat", json={"session_id": "session_a", "message": "hello"}
        )
    assert response.status_code == 200
    assert len(launch.call_args.kwargs["pass_fds"]) == 1
    assert isinstance(launch.call_args.kwargs["pass_fds"][0], int)
    assert launch.call_args.kwargs["env"]["LIMILINK_SESSION"] == "forged"
