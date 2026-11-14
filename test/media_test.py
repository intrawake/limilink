"""Session-pinned media is independent of agent execution; all files are local."""

import struct
import zlib
import io
import wave

import pytest

from test.delivery_test import harness as harness, submit, terminal


def png():
    def chunk(kind, data):
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data))
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00\xff\x40\x40\xff"))
        + chunk(b"IEND", b"")
    )


PNG = png()


def wav(samples=800):
    target = io.BytesIO()
    with wave.open(target, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\0\0" * samples)
    return target.getvalue()


async def upload(client, data=PNG, name="picture.png", number=1, sid="x"):
    return await client.put(
        f"/sessions/{sid}/media/{number:032x}",
        params={"filename": name},
        content=data,
        headers={"Content-Type": "application/octet-stream"},
    )


@pytest.mark.asyncio
async def test_pin_image_audio_replay_and_session_isolation(harness):
    root, cfg, client, event, release = harness
    first = await upload(client)
    assert first.status_code == 201, first.text
    image = first.json()["media"]
    assert image["mime"] == "image/png" and image["size"] == len(PNG)
    response = await upload(client)
    assert response.status_code == 200 and response.json()["media"] == image
    assert (await upload(client, name="different.png")).status_code == 409
    audio = await upload(client, wav(), "voice.wav", 2)
    assert audio.status_code == 201 and audio.json()["media"]["mime"] == "audio/wav"
    listed = (await client.get("/sessions/x/media")).json()
    assert len(listed["media"]) == 2 and listed["revision"]
    assert (await client.get("/sessions/y/media")).json()["media"] == []
    assert (await client.get(image["url"])).content == PNG
    assert (
        await client.get("/sessions/y/media/" + image["id"] + "/content")
    ).status_code == 404
    assert not (root / "x/chat_history.json").exists()


@pytest.mark.asyncio
async def test_audio_range_head_and_download_headers(harness):
    root, cfg, client, event, release = harness
    data = wav()
    response = await upload(client, data, "voice.wav")
    assert response.status_code == 201, response.text
    item = response.json()["media"]
    partial = await client.get(item["url"], headers={"Range": "bytes=44-79"})
    assert partial.status_code == 206 and partial.content == data[44:80]
    assert partial.headers["content-range"] == f"bytes 44-79/{len(data)}"
    assert partial.headers["x-content-type-options"] == "nosniff"
    head = await client.head(item["url"])
    assert (
        head.status_code == 200
        and head.content == b""
        and int(head.headers["content-length"]) == len(data)
    )
    assert (
        await client.get(item["url"], headers={"Range": f"bytes={len(data)}-"})
    ).status_code == 416
    download = await client.get(item["download_url"])
    assert download.content == data and download.headers[
        "content-disposition"
    ].startswith("attachment;")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,data",
    [
        ("evil.svg", b"<svg onload='alert(1)'/>"),
        ("evil.html", b"<!doctype html>"),
        ("empty.png", b""),
    ],
)
async def test_executable_or_unrecognized_content_is_not_pinned(harness, name, data):
    root, cfg, client, event, release = harness
    response = await upload(client, data, name)
    assert response.status_code == 415, response.text
    assert (await client.get("/sessions/x/media")).json()["media"] == []


@pytest.mark.asyncio
async def test_assistant_can_pin_while_its_turn_owns_execution_fence(harness):
    root, cfg, client, event, release = harness
    active = await submit(client, "active writer", 1)
    held = await event()
    response = await upload(client, number=9)
    assert response.status_code == 201, response.text
    assert (await client.get(f"/sessions/x/operations/{active['id']}")).json()[
        "operation"
    ]["state"] == "running"
    release(held)
    assert (await terminal(client, active))["state"] == "succeeded"


@pytest.mark.asyncio
async def test_unicode_name_normalization_and_safe_download_disposition(harness):
    root, cfg, client, event, release = harness
    first = await upload(client, name="cafe\u0301.png")
    assert first.status_code == 201
    item = first.json()["media"]
    assert item["name"] == "caf\u00e9.png"
    assert (await upload(client, name="caf\u00e9.png")).json()["media"] == item
    response = await client.get(item["download_url"])
    assert "filename*=UTF-8''caf%C3%A9.png" in response.headers["content-disposition"]
