"""Format recognition and publication edge cases; no codec/provider dependency."""

import asyncio
import struct

from fastapi import HTTPException
import pytest

import main
import session_media as media
from test.delivery_test import harness as harness
from test.media_test import PNG, upload, wav


def riff(kind, payload):
    body = kind + payload
    return b"RIFF" + struct.pack("<I", len(body)) + body


@pytest.mark.parametrize(
    "data,mime",
    [
        (PNG, "image/png"),
        (wav(), "audio/wav"),
        (b"\xff\xd8\xff\xe0JFIFtest\xff\xd9", "image/jpeg"),
        (b"GIF89a\x01\0\x01\0\0\0\0;", "image/gif"),
        (riff(b"WEBP", b"VP8L" + b"\0" * 8), "image/webp"),
        (b"\xff\xfb\x90\0" + b"\0" * 20, "audio/mpeg"),
        (b"ID3\x04\0\0\0\0\0\0\xff\xfb\x90\0" + b"\0" * 20, "audio/mpeg"),
        (b"OggS\0" + b"\0" * 22 + b"OpusHead" + b"\0" * 10, "audio/ogg"),
        (struct.pack(">I", 24) + b"ftypM4A " + b"\0" * 20, "audio/mp4"),
        (b"fLaC\x80\0\0\x22" + b"\0" * 35, "audio/flac"),
    ],
)
def test_bounded_signature_recognition_not_full_decoding(data, mime):
    # Some fixtures are structural headers, not complete playable encodings.
    assert media.recognize(data[:65536], data[-16:], len(data)) == mime


@pytest.mark.parametrize(
    "data",
    [
        b"ID3",
        b"ID3\x04\0\0\0\0\0\0",
        b"\x89PNG\r\n\x1a\n",
        b"OggS\0" + b"\0" * 22 + b"theora",
        struct.pack(">I", 24) + b"ftypisom" + b"\0" * 20,
        riff(b"WAVE", b"invalid"),
        b"<svg/>",
        b"<!doctype html>",
    ],
)
def test_unrecognized_or_video_headers_rejected(data):
    with pytest.raises(HTTPException) as error:
        media.recognize(data, data[-16:], len(data))
    assert error.value.status_code == 415


@pytest.mark.asyncio
async def test_global_upload_slots_fail_fast_without_blocking_reads(harness):
    root, cfg, client, event, release = harness
    ready, gate = asyncio.Queue(), asyncio.Event()

    async def body():
        yield PNG[:20]
        ready.put_nowait(True)
        await gate.wait()
        yield PNG[20:]

    tasks = [
        asyncio.create_task(
            client.put(
                f"/sessions/x/media/{number:032x}?filename=picture.png", content=body()
            )
        )
        for number in (1, 2)
    ]
    await ready.get()
    await ready.get()
    # Busy is conservative session liveness, not proof an agent is thinking.
    assert (await client.get("/sessions/x/snapshot")).json()["busy"] is True
    assert not main.get_delivery_owner().busy("x")
    response = await upload(client, number=3)
    assert (
        response.status_code == 503
        and (await client.get("/sessions/x/media")).json()["media"] == []
    )
    gate.set()
    results = await asyncio.gather(*tasks)
    assert all(response.status_code == 201 for response in results)
    assert main.get_media_store().inflight == 0


@pytest.mark.asyncio
async def test_exact_concurrent_reuse_and_restart_cleanup_keep_original_pin(harness):
    root, cfg, client, event, release = harness
    results = await asyncio.gather(upload(client), upload(client))
    assert sorted(response.status_code for response in results) == [200, 201]
    item = results[0].json()["media"]
    assert results[1].json()["media"] == item
    stage = root / "x/.media" / (".stage-" + "f" * 32)
    stage.mkdir()
    (stage / "data").write_bytes(b"abandoned partial upload")
    owner = main.delivery_owners.pop(str(root.resolve()))
    await owner.close()
    assert (await client.get(item["url"])).content == PNG
    assert (await upload(client, number=2)).status_code == 201
    assert not stage.exists()
    assert (await client.get(item["url"])).content == PNG


@pytest.mark.asyncio
async def test_encoding_declared_length_and_corrupt_metadata_are_not_silently_accepted(
    harness,
):
    root, cfg, client, event, release = harness
    path = "/sessions/x/media/" + "1" * 32 + "?filename=picture.png"
    response = await client.put(path, content=PNG, headers={"Content-Encoding": "gzip"})
    assert response.status_code == 415
    response = await client.put(
        path, content=PNG, headers={"Content-Length": str(len(PNG) + 1)}
    )
    assert response.status_code == 400
    assert (await upload(client)).status_code == 201
    publication = root / "x/.media" / ("1".zfill(32))
    (publication / "metadata.json").write_text("{")
    assert (await client.get("/sessions/x/media")).status_code == 409
    assert (await upload(client, number=2)).status_code == 409
