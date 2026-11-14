"""Removing pins reclaims copies without touching source files or live streams."""

import asyncio

import pytest
from starlette.requests import Request

import main
import session_media as media
from test.delivery_test import harness as harness
from test.media_test import PNG, upload


@pytest.mark.asyncio
async def test_remove_is_session_scoped_idempotent_and_survives_restart(
    harness, tmp_path
):
    root, cfg, client, event, release = harness
    source = tmp_path / "original.png"
    source.write_bytes(PNG)
    item = (await upload(client, source.read_bytes())).json()["media"]
    path = "/sessions/x/media/" + item["id"]
    before = (await client.get("/sessions/x/media")).json()
    assert (await client.delete(path.replace("/x/", "/y/"))).status_code == 404
    assert (await client.get(item["url"])).content == PNG
    response = await client.delete(path)
    assert response.status_code == 204 and response.content == b""
    assert response.headers["cache-control"] == "private, no-store"
    assert source.read_bytes() == PNG
    assert not (root / "x/.media" / item["id"]).exists()
    tombstone = root / "x/.media" / (".removed-" + item["id"])
    assert not (tombstone / "data").exists()
    after = (await client.get("/sessions/x/media")).json()
    assert after["media"] == [] and after["revision"] != before["revision"]
    for url in (path, item["url"], item["download_url"]):
        assert (await client.get(url)).status_code == 404
    assert (await client.delete(path)).status_code == 204
    owner = main.delivery_owners.pop(str(root.resolve()))
    await owner.close()
    assert (await client.get("/sessions/x/media")).json()["media"] == []
    assert (await upload(client)).status_code == 410
    assert (await upload(client, number=2)).status_code == 201
    assert not (root / "x/chat_history.json").exists()


@pytest.mark.asyncio
async def test_removing_pin_frees_shelf_quota(harness, monkeypatch):
    root, cfg, client, event, release = harness
    monkeypatch.setattr(media, "MAX_ITEMS", 1)
    monkeypatch.setattr(media, "MAX_SESSION_BYTES", len(PNG))
    item = (await upload(client)).json()["media"]
    assert (await upload(client, number=2)).status_code == 409
    assert (await client.delete("/sessions/x/media/" + item["id"])).status_code == 204
    assert (await upload(client, number=2)).status_code == 201


@pytest.mark.asyncio
async def test_open_stream_finishes_after_pin_is_removed(harness):
    root, cfg, client, event, release = harness
    item = (await upload(client)).json()["media"]
    scope = {
        "type": "http",
        "method": "GET",
        "headers": [],
        "asgi": {"spec_version": "2.4"},
    }
    response = main.get_media_store().content("x", item["id"], Request(scope))
    assert (await client.delete("/sessions/x/media/" + item["id"])).status_code == 204
    body = []

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.body":
            body.append(message["body"])

    await response(scope, receive, send)
    assert b"".join(body) == PNG


@pytest.mark.asyncio
async def test_inflight_replay_cannot_resurrect_removed_pin(harness):
    root, cfg, client, event, release = harness
    item = (await upload(client)).json()["media"]
    ready, gate = asyncio.Event(), asyncio.Event()

    async def body():
        yield PNG[:20]
        ready.set()
        await gate.wait()
        yield PNG[20:]

    path = "/sessions/x/media/" + item["id"]
    pending = asyncio.create_task(
        client.put(path + "?filename=picture.png", content=body())
    )
    await ready.wait()
    assert (await client.delete(path)).status_code == 204
    gate.set()
    assert (await pending).status_code == 410
    assert (await client.get("/sessions/x/media")).json()["media"] == []


@pytest.mark.asyncio
async def test_removal_refuses_symlinked_publication(harness, tmp_path):
    root, cfg, client, event, release = harness
    item = (await upload(client)).json()["media"]
    directory = root / "x/.media" / item["id"]
    saved = tmp_path / "saved"
    directory.rename(saved)
    directory.symlink_to(saved, target_is_directory=True)
    assert (await client.delete("/sessions/x/media/" + item["id"])).status_code == 409
    assert (saved / "data").read_bytes() == PNG
