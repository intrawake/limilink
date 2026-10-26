"""Snapshot polling is read-only, revisioned, and independent of a chat POST."""

import asyncio
import json
import stat
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

import main
from session_lease import session_lease
from session_snapshot import history_snapshot


@pytest.fixture
def root(test_sessions_dir):
    root = Path(test_sessions_dir)
    for key in ["session_a", "session_b"]:
        session = root / key
        session.mkdir()
        (session / "chat_history.json").write_text('[{"role":"bot","content":"First"}]')
    return root


@pytest.fixture
def client():
    with TestClient(main.app) as client:
        yield client


def test_snapshot_revision_omits_unchanged_history_but_always_returns_activity(
    client, root
):
    response = client.get("/sessions/session_a/snapshot")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    data = response.json()
    assert data["history"] == [{"role": "bot", "content": "First"}]
    assert not data["busy"]
    revision = data["revision"]
    with main.session_admission(root, "session_a"):
        busy = client.get(
            "/sessions/session_a/snapshot", params={"revision": revision}
        ).json()
        assert "history" not in busy
        assert busy["busy"]
        assert "session_a" in busy["busy_sessions"]
    idle = client.get(
        "/sessions/session_a/snapshot", params={"revision": revision}
    ).json()
    assert "history" not in idle
    assert not idle["busy"]
    assert idle["revision"] == revision
    with main.session_admission(root, "session_b"):
        other = client.get(
            "/sessions/session_a/snapshot", params={"revision": revision}
        ).json()
        assert not other["busy"]
        assert "session_b" in other["busy_sessions"]


def test_snapshot_sees_an_inherited_agent_lease_without_request_counter(client, root):
    with session_lease(root, "session_a"):
        assert client.get("/sessions/session_a/snapshot").json()["busy"]
    assert not client.get("/sessions/session_a/snapshot").json()["busy"]


def test_digest_tracks_actual_content_not_size_or_timestamp(client, root):
    path = root / "session_a/chat_history.json"
    first = client.get("/sessions/session_a/snapshot").json()
    old_stat = path.stat()
    path.write_text('[{"role":"bot","content":"Other"}]')  # Same byte count.
    import os

    os.utime(path, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns))
    assert path.stat().st_size == old_stat.st_size
    changed = client.get(
        "/sessions/session_a/snapshot", params={"revision": first["revision"]}
    ).json()
    assert changed["revision"] != first["revision"]
    assert changed["history"] == [{"role": "bot", "content": "Other"}]


def test_revision_survives_fresh_client_and_legacy_history_contract_is_unchanged(
    client, root
):
    first = client.get("/sessions/session_a/snapshot").json()
    with TestClient(main.app) as fresh:
        same = fresh.get(
            "/sessions/session_a/snapshot", params={"revision": first["revision"]}
        ).json()
    assert same["revision"] == first["revision"]
    assert "history" not in same
    assert client.get("/sessions/session_a/history").json() == {
        "history": first["history"]
    }


def test_snapshot_never_consumes_discord_notification_queue(client, root):
    unread = root / "session_a/unread.json"
    unread.write_text(json.dumps(["background notification"]))
    original = unread.read_bytes()
    for _ in range(2):
        assert client.get("/sessions/session_a/snapshot").status_code == 200
    assert unread.read_bytes() == original
    assert client.get("/sessions/session_a/poll").json() == {
        "messages": ["background notification"]
    }


@pytest.mark.parametrize("raw", ["{", "{}", '[{"role":"bot"}]'])
def test_malformed_history_is_an_error_not_an_authoritative_empty_view(
    client, root, raw
):
    path = root / "session_a/chat_history.json"
    path.write_text(raw)
    response = client.get("/sessions/session_a/snapshot")
    assert response.status_code == 500
    assert "history" not in response.json()
    with pytest.raises(ValueError):
        main.append_to_history(str(path.parent), "user", "do not erase the old bytes")
    assert path.read_text() == raw


def test_read_failure_returns_error_without_changing_any_history(client, root):
    path = root / "session_a/chat_history.json"
    before = path.read_bytes()
    with patch("session_snapshot.Path.read_bytes", side_effect=PermissionError):
        assert client.get("/sessions/session_a/snapshot").status_code == 500
    assert path.read_bytes() == before


def test_missing_or_invalid_snapshot_target_never_creates_session(client, root):
    assert client.get("/sessions/missing/snapshot").status_code == 404
    assert not (root / "missing").exists()
    assert client.get("/sessions/session.a/snapshot").status_code == 400


def test_history_append_is_atomic_and_failure_preserves_previous_snapshot(root):
    path = root / "session_a/chat_history.json"
    before = path.read_bytes()
    revision = history_snapshot(path)["revision"]
    with patch("main.os.replace", side_effect=OSError("disk full")):
        with pytest.raises(OSError):
            main.append_to_history(str(path.parent), "bot", "new reply")
    assert path.read_bytes() == before
    assert history_snapshot(path, revision) == {"revision": revision}
    assert not list(path.parent.glob(".history.*.tmp"))
    main.append_to_history(str(path.parent), "bot", "new reply")
    assert history_snapshot(path)["revision"] != revision
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


@pytest.mark.asyncio
async def test_snapshot_observes_work_from_another_client_while_post_is_pending(root):
    started, release = asyncio.Event(), asyncio.Event()

    async def blocked_chat(session_id, message, lease_fd, request_id=None):
        main.append_to_history(str(root / session_id), "user", message)
        started.set()
        await release.wait()
        main.append_to_history(str(root / session_id), "bot", "Finished elsewhere")
        return "Finished elsewhere"

    with patch("main._process_chat", side_effect=blocked_chat):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as client:
            task = asyncio.create_task(
                client.post(
                    "/chat", json={"session_id": "session_a", "message": "hello"}
                )
            )
            await started.wait()
            working = (await client.get("/sessions/session_a/snapshot")).json()
            assert working["busy"]
            assert working["history"][-1] == {"role": "user", "content": "hello"}
            release.set()
            assert (await task).status_code == 200
            done = (
                await client.get(
                    "/sessions/session_a/snapshot",
                    params={"revision": working["revision"]},
                )
            ).json()
            assert not done["busy"]
            assert done["history"][-1] == {
                "role": "bot",
                "content": "Finished elsewhere",
            }
