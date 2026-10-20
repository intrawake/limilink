"""Persistent titles/order never change session IDs or conversation files."""

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import main
import session_layout
from main import app


@pytest.fixture
def client():
    with TestClient(app) as client:
        yield client


@pytest.fixture
def root(test_sessions_dir):
    root = Path(test_sessions_dir)
    for name in ["session_a", "session_b", "session_c"]:
        session = root / name
        session.mkdir()
        (session / "chat_history.json").write_text(
            '[{"role":"user","content":"keep me"}]'
        )
    return root


def details(client):
    response = client.get("/session-sidebar")
    assert response.status_code == 200
    return response.json()["sessions"]


def test_legacy_list_is_unchanged_and_default_titles_need_no_migration(client, root):
    expected = sorted(path.name for path in root.iterdir())
    assert client.get("/sessions").json() == {"sessions": expected}
    assert details(client) == [{"id": key, "title": key} for key in expected]
    assert not (root / ".session-layout.json").exists()


def test_titles_and_order_persist_across_clients_without_renaming_directories(
    client, root
):
    before = (root / "session_a/chat_history.json").read_bytes()
    response = client.patch(
        "/sessions/session_a/title", json={"title": "  First case 🕵️  "}
    )
    assert response.json() == {"id": "session_a", "title": "First case 🕵️"}
    response = client.put(
        "/session-sidebar/order",
        json={"session_ids": ["session_c", "session_a", "session_b"]},
    )
    assert response.status_code == 200
    with TestClient(app) as fresh:
        assert details(fresh) == [
            {"id": "session_c", "title": "session_c"},
            {"id": "session_a", "title": "First case 🕵️"},
            {"id": "session_b", "title": "session_b"},
        ]
    assert (root / "session_a/chat_history.json").read_bytes() == before
    assert sorted(path.name for path in root.iterdir() if path.is_dir()) == [
        "session_a",
        "session_b",
        "session_c",
    ]
    assert client.get("/sessions").json()["sessions"] == [
        "session_a",
        "session_b",
        "session_c",
    ]


@pytest.mark.parametrize("title", ["", "   ", "x" * 161, None, 123])
def test_invalid_titles_do_not_write_metadata(client, root, title):
    assert (
        client.patch("/sessions/session_a/title", json={"title": title}).status_code
        == 422
    )
    assert not (root / ".session-layout.json").exists()


def test_duplicate_titles_are_allowed(client, root):
    for key in ["session_a", "session_b"]:
        assert (
            client.patch(
                f"/sessions/{key}/title", json={"title": "Same name"}
            ).status_code
            == 200
        )
    assert [item["title"] for item in details(client)][:2] == ["Same name", "Same name"]


def test_invalid_targets_and_orders_do_not_write_metadata(client, root):
    assert (
        client.patch("/sessions/missing/title", json={"title": "Nope"}).status_code
        == 404
    )
    assert (
        client.patch("/sessions/session.a/title", json={"title": "Nope"}).status_code
        == 400
    )
    assert (
        client.put(
            "/session-sidebar/order", json={"session_ids": ["session_a", "session_a"]}
        ).status_code
        == 400
    )
    assert (
        client.put(
            "/session-sidebar/order", json={"session_ids": ["missing"]}
        ).status_code
        == 409
    )
    assert not (root / ".session-layout.json").exists()


def test_new_and_removed_directories_reconcile_without_metadata_hooks(client, root):
    assert (
        client.put(
            "/session-sidebar/order", json={"session_ids": ["session_c"]}
        ).status_code
        == 200
    )
    (root / "session_new").mkdir()
    assert [item["id"] for item in details(client)] == [
        "session_c",
        "session_a",
        "session_b",
        "session_new",
    ]
    # A stale tab's reorder must retain the session created since it fetched.
    assert (
        client.put(
            "/session-sidebar/order",
            json={"session_ids": ["session_b", "session_c", "session_a"]},
        ).status_code
        == 200
    )
    assert [item["id"] for item in details(client)][-1] == "session_new"
    assert (
        client.patch(
            "/sessions/session_b/title", json={"title": "Delete me"}
        ).status_code
        == 200
    )
    assert client.delete("/sessions/session_b").status_code == 200
    saved = json.loads((root / ".session-layout.json").read_text())
    assert "session_b" not in saved["titles"]
    assert "session_b" not in saved["order"]
    assert "session_b" not in [item["id"] for item in details(client)]


def test_failed_replace_keeps_previous_metadata_and_cleans_temp(client, root):
    assert (
        client.patch("/sessions/session_a/title", json={"title": "Before"}).status_code
        == 200
    )
    original = (root / ".session-layout.json").read_bytes()
    with patch("session_layout.os.replace", side_effect=OSError("disk error")):
        assert (
            client.patch(
                "/sessions/session_a/title", json={"title": "After"}
            ).status_code
            == 500
        )
    assert (root / ".session-layout.json").read_bytes() == original
    assert not list(root.glob("*.tmp"))


@pytest.mark.parametrize("broken", ["{", "[]", '{"titles":[],"order":[]}'])
def test_corrupt_metadata_fails_loudly_without_overwriting(client, root, broken):
    path = root / ".session-layout.json"
    path.write_text(broken)
    assert client.get("/session-sidebar").status_code == 500
    assert (
        client.patch("/sessions/session_a/title", json={"title": "New"}).status_code
        == 500
    )
    assert (
        client.put(
            "/session-sidebar/order", json={"session_ids": ["session_a"]}
        ).status_code
        == 500
    )
    assert path.read_text() == broken


def test_simultaneous_renames_and_order_save_keep_each_other(root):
    order = ["session_c", "session_a", "session_b"]
    with ThreadPoolExecutor(max_workers=3) as pool:
        jobs = [
            pool.submit(session_layout.rename_session, root, "session_a", "A"),
            pool.submit(session_layout.rename_session, root, "session_b", "B"),
            pool.submit(session_layout.reorder_sessions, root, order),
        ]
        for job in jobs:
            job.result()
    assert session_layout.list_session_details(root) == [
        {"id": "session_c", "title": "session_c"},
        {"id": "session_a", "title": "A"},
        {"id": "session_b", "title": "B"},
    ]


def test_busy_session_cannot_be_deleted(client, root):
    lock = asyncio.Lock()
    asyncio.run(lock.acquire())
    with patch.dict(main.session_locks, {"session_a": lock}):
        response = client.delete("/sessions/session_a")
    assert response.status_code == 409
    assert (root / "session_a/chat_history.json").exists()
