"""Media publication boundaries, interruption, quota and filesystem safety."""

import asyncio
import os

import pytest

import main
import session_media as media
from session_lease import session_lease
from test.delivery_test import harness as harness
from test.media_test import PNG, upload


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name", ["../secret.png", "a/b.png", "a\\b.png", "bad\nname.png", ".", "x" * 161]
)
async def test_display_names_never_become_filesystem_paths(harness, name):
    root, cfg, client, event, release = harness
    response = await upload(client, name=name)
    assert response.status_code == 400, response.text
    assert not (root / "x/.media").exists()


@pytest.mark.asyncio
async def test_quota_exact_observation_even_when_full_and_no_partial_publication(
    harness, monkeypatch
):
    root, cfg, client, event, release = harness
    monkeypatch.setattr(media, "MAX_ITEMS", 1)
    assert (await upload(client)).status_code == 201
    assert (await upload(client)).status_code == 200
    assert (await upload(client, number=2)).status_code == 409
    assert len((await client.get("/sessions/x/media")).json()["media"]) == 1
    assert not list((root / "x/.media").glob(".stage-*"))


@pytest.mark.asyncio
async def test_two_near_quota_commits_cannot_both_pass(harness, monkeypatch):
    root, cfg, client, event, release = harness
    monkeypatch.setattr(media, "MAX_SESSION_BYTES", len(PNG))
    gate, ready = asyncio.Event(), asyncio.Queue()

    async def body():
        yield PNG[:20]
        ready.put_nowait(True)
        await gate.wait()
        yield PNG[20:]

    async def send(number):
        return await client.put(
            f"/sessions/x/media/{number:032x}?filename=picture.png", content=body()
        )

    tasks = [asyncio.create_task(send(number)) for number in (1, 2)]
    await ready.get()
    await ready.get()
    gate.set()
    results = await asyncio.gather(*tasks)
    assert sorted(response.status_code for response in results) == [201, 409]
    assert len((await client.get("/sessions/x/media")).json()["media"]) == 1
    assert main.get_media_store().inflight == 0


@pytest.mark.asyncio
async def test_stream_cap_timeout_disconnect_and_slot_cleanup(harness, monkeypatch):
    root, cfg, client, event, release = harness
    monkeypatch.setattr(media, "MAX_BYTES", len(PNG))
    assert (await upload(client)).status_code == 201
    assert (await upload(client, PNG + b"x", number=2)).status_code == 413

    async def too_big():
        yield PNG
        yield b"x"

    response = await client.put(
        "/sessions/x/media/" + "3" * 32 + "?filename=picture.png", content=too_big()
    )
    assert response.status_code == 413

    async def disconnected():
        yield PNG[:16]
        raise RuntimeError("test upload disconnected")

    with pytest.raises(RuntimeError, match="test upload disconnected"):
        await client.put(
            "/sessions/x/media/" + "4" * 32 + "?filename=picture.png",
            content=disconnected(),
        )
    monkeypatch.setattr(media, "UPLOAD_SECONDS", 0.01)

    async def stalled():
        yield PNG[:16]
        await asyncio.Event().wait()

    response = await client.put(
        "/sessions/x/media/" + "5" * 32 + "?filename=picture.png", content=stalled()
    )
    assert response.status_code == 408
    assert main.get_media_store().inflight == 0
    assert not list((root / "x/.media").glob(".stage-*"))
    with session_lease(root, "x", exclusive=True) as fd:
        assert fd is not None


@pytest.mark.asyncio
async def test_trash_during_upload_blocks_commit_and_undo_restores_existing_pins(
    harness,
):
    root, cfg, client, event, release = harness
    assert (await upload(client)).status_code == 201
    ready, gate = asyncio.Event(), asyncio.Event()

    async def body():
        yield PNG[:20]
        ready.set()
        await gate.wait()
        yield PNG[20:]

    task = asyncio.create_task(
        client.put(
            "/sessions/x/media/" + "2" * 32 + "?filename=picture.png", content=body()
        )
    )
    await ready.wait()
    assert (await client.post("/sessions/x/trash")).status_code == 200
    gate.set()
    assert (await task).status_code == 409
    assert (await client.get("/sessions/x/media")).status_code == 409
    assert (await client.delete("/sessions/x/trash")).status_code == 200
    items = (await client.get("/sessions/x/media")).json()["media"]
    assert len(items) == 1 and (await client.get(items[0]["url"])).content == PNG
    assert (await client.delete("/sessions/x")).status_code == 200
    assert (await client.get(items[0]["url"])).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", [1, 4])
async def test_fsync_failure_never_removes_an_already_published_pin(
    harness, monkeypatch, phase
):
    root, cfg, client, event, release = harness
    fsync = media.os.fsync
    count = 0

    def fail(fd):
        nonlocal count
        count += 1
        if count == phase:
            raise OSError("injected fsync failure")
        return fsync(fd)

    monkeypatch.setattr(media.os, "fsync", fail)
    response = await upload(client)
    assert response.status_code == 507
    monkeypatch.setattr(media.os, "fsync", fsync)
    exact = await client.get("/sessions/x/media/" + f"{1:032x}")
    assert exact.status_code == (404 if phase == 1 else 200)
    if phase == 4:
        assert (await client.get(exact.json()["media"]["url"])).content == PNG
    assert not list((root / "x/.media").glob(".stage-*"))
    assert main.get_media_store().inflight == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "part", ["session", "shelf", "publication", "metadata", "data", "fifo"]
)
async def test_no_symlink_or_special_file_escape(harness, tmp_path, part):
    root, cfg, client, event, release = harness
    response = await upload(client)
    assert response.status_code == 201
    item = response.json()["media"]
    publication = root / "x/.media" / item["id"]
    outside = tmp_path / "private"
    outside.mkdir()
    (outside / "data").write_bytes(b"private outside bytes")
    if part == "session":
        os.rename(root / "x", root / "real_x")
        (root / "x").symlink_to(root / "real_x", target_is_directory=True)
    elif part == "shelf":
        os.rename(root / "x/.media", root / "x/real_media")
        (root / "x/.media").symlink_to(root / "x/real_media", target_is_directory=True)
    elif part == "publication":
        os.rename(publication, root / "x/saved_publication")
        publication.symlink_to(outside, target_is_directory=True)
    elif part in ("metadata", "data"):
        target = publication / ("metadata.json" if part == "metadata" else "data")
        target.unlink()  # Only this disposable test's own file.
        target.symlink_to(outside / "data")
    else:
        (publication / "data").unlink()  # Only this disposable test's own file.
        os.mkfifo(publication / "data")
    response = await client.get(item["url"])
    assert response.status_code in (400, 409), response.text
    assert b"private outside bytes" not in response.content
    with session_lease(root, "x", exclusive=True) as fd:
        assert fd is not None
