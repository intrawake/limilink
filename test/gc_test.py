from __future__ import annotations
import os
import time
import json
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_gc_no_args_shows_usage(test_sessions_dir):
    """!gc with no args shows usage message."""
    resp = client.post("/chat", json={"message": "!gc", "session_id": "gc_usage"})
    assert resp.status_code == 200
    assert "Usage:" in resp.json()["reply"]


def test_gc_bad_unit(test_sessions_dir):
    """!gc with an unsupported unit shows error."""
    resp = client.post(
        "/chat", json={"message": "!gc week 2", "session_id": "gc_bad_unit"}
    )
    assert resp.status_code == 200
    assert "Unsupported unit" in resp.json()["reply"]
    assert "day" in resp.json()["reply"]


def test_gc_bad_number(test_sessions_dir):
    """!gc day with a non-numeric value shows error."""
    resp = client.post(
        "/chat", json={"message": "!gc day abc", "session_id": "gc_bad_num"}
    )
    assert resp.status_code == 200
    assert "Invalid number" in resp.json()["reply"]


def test_gc_negative_days(test_sessions_dir):
    """!gc day with negative days shows error."""
    resp = client.post("/chat", json={"message": "!gc day -1", "session_id": "gc_neg"})
    assert resp.status_code == 200
    assert ">= 0" in resp.json()["reply"]


def test_gc_zero_days_deletes_all(test_sessions_dir):
    """!gc day 0 deletes all sessions."""
    # Create a session
    create_resp = client.post("/sessions")
    assert create_resp.status_code == 200
    sid = create_resp.json()["session_id"]
    sess_path = os.path.join(test_sessions_dir, sid)
    assert os.path.isdir(sess_path)

    # GC with 0 days should delete it
    resp = client.post("/chat", json={"message": "!gc day 0", "session_id": "gc_zero"})
    assert resp.status_code == 200
    assert "Deleted" in resp.json()["reply"] or "stale session" in resp.json()["reply"]
    assert not os.path.exists(sess_path)


def test_gc_preserves_recent_sessions(test_sessions_dir):
    """!gc day with a large number preserves recent sessions."""
    # Create a session
    create_resp = client.post("/sessions")
    assert create_resp.status_code == 200
    sid = create_resp.json()["session_id"]
    sess_path = os.path.join(test_sessions_dir, sid)
    assert os.path.isdir(sess_path)

    # GC with 365 days should NOT delete it (it was just created)
    resp = client.post(
        "/chat", json={"message": "!gc day 365", "session_id": "gc_preserve"}
    )
    assert resp.status_code == 200
    assert "No stale sessions found" in resp.json()["reply"]
    assert os.path.isdir(sess_path)


def test_gc_deletes_only_stale_session(test_sessions_dir):
    """!gc day deletes only sessions older than threshold."""
    # Create two sessions
    c1 = client.post("/sessions")
    c2 = client.post("/sessions")
    sid_keep = c1.json()["session_id"]
    sid_delete = c2.json()["session_id"]
    path_keep = os.path.join(test_sessions_dir, sid_keep)
    path_delete = os.path.join(test_sessions_dir, sid_delete)

    # Artificially age sid_delete: set chat_history.json mtime to 1 year ago
    old_time = time.time() - (366 * 86400)
    hist_path = os.path.join(path_delete, "chat_history.json")
    with open(hist_path, "w") as f:
        json.dump([], f)
    os.utime(hist_path, (old_time, old_time))
    os.utime(path_delete, (old_time, old_time))

    # GC with 365 days should delete sid_delete but keep sid_keep
    resp = client.post(
        "/chat", json={"message": "!gc day 365", "session_id": "gc_stale"}
    )
    assert resp.status_code == 200
    reply = resp.json()["reply"]
    assert "Deleted" in reply
    assert sid_delete in reply
    assert sid_keep not in reply
    assert os.path.isdir(path_keep)
    assert not os.path.exists(path_delete)


def test_gc_skips_active_sessions(test_sessions_dir, monkeypatch):
    """!gc skips sessions with active running processes."""
    # Create a session and mark it as "active"
    create_resp = client.post("/sessions")
    sid = create_resp.json()["session_id"]
    sess_path = os.path.join(test_sessions_dir, sid)

    # Artificially age it
    old_time = time.time() - (366 * 86400)
    hist_path = os.path.join(sess_path, "chat_history.json")
    with open(hist_path, "w") as f:
        json.dump([], f)
    os.utime(hist_path, (old_time, old_time))
    os.utime(sess_path, (old_time, old_time))

    # Simulate the session having an active process
    import main

    # Use a mock object as running process entry
    from unittest.mock import AsyncMock

    main.running_processes[sid] = AsyncMock()  # type: ignore[assignment]

    resp = client.post(
        "/chat",
        json={"message": "!gc day 0", "session_id": "gc_active"},
    )
    assert resp.status_code == 200
    reply = resp.json()["reply"]
    assert "Skipped" in reply
    assert sid in reply
    assert os.path.isdir(sess_path)

    # Clean up
    del main.running_processes[sid]


def test_gc_uses_directory_mtime_fallback(test_sessions_dir):
    """!gc falls back to directory mtime when chat_history.json is missing."""
    # Create a session without a chat_history.json
    create_resp = client.post("/sessions")
    sid = create_resp.json()["session_id"]
    sess_path = os.path.join(test_sessions_dir, sid)

    # Remove chat_history.json if it exists
    hist_path = os.path.join(sess_path, "chat_history.json")
    if os.path.exists(hist_path):
        os.unlink(hist_path)

    # Artificially age the directory
    old_time = time.time() - (10 * 86400)
    os.utime(sess_path, (old_time, old_time))

    # GC with 5 days should delete it
    resp = client.post(
        "/chat", json={"message": "!gc day 5", "session_id": "gc_fallback"}
    )
    assert resp.status_code == 200
    assert "Deleted" in resp.json()["reply"]
    assert not os.path.exists(sess_path)


def test_gc_preserves_non_session_dirs(test_sessions_dir):
    """!gc ignores non-directory entries in the sessions dir."""
    # Create a file in sessions_dir (like bot.pid, channel_sessions.json)
    some_file = os.path.join(test_sessions_dir, "bot.pid")
    with open(some_file, "w") as f:
        f.write("12345")

    resp = client.post(
        "/chat", json={"message": "!gc day 0", "session_id": "gc_non_dir"}
    )
    assert resp.status_code == 200
    # file should still exist
    assert os.path.exists(some_file)
