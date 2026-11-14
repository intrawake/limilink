"""Exercise ASGI lifetime directly; buffered clients alone cannot prove it."""

import os

import pytest
from starlette.requests import ClientDisconnect, Request

import main
import session_media as media
from session_lease import session_lease
from test.delivery_test import harness as harness
from test.media_test import PNG, upload


@pytest.mark.asyncio
@pytest.mark.parametrize("before_body", [True, False])
async def test_send_failure_releases_opened_fd_and_lease_even_before_first_chunk(
    harness, before_body
):
    root, cfg, client, event, release = harness
    item = (await upload(client)).json()["media"]
    scope = {
        "type": "http",
        "method": "GET",
        "headers": [],
        "asgi": {"spec_version": "2.4"},
    }
    response = main.get_media_store().content("x", item["id"], Request(scope))
    busy = []

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == (
            "http.response.start" if before_body else "http.response.body"
        ):
            with session_lease(root, "x", exclusive=True) as fd:
                busy.append(fd is None)
            raise ConnectionResetError("test client disconnected")

    with pytest.raises(ClientDisconnect):
        await response(scope, receive, send)
    assert busy == [True]
    with session_lease(root, "x", exclusive=True) as fd:
        assert fd is not None


@pytest.mark.asyncio
async def test_content_remains_anchored_to_opened_fd_after_path_replacement(
    harness, tmp_path
):
    root, cfg, client, event, release = harness
    item = (await upload(client)).json()["media"]
    scope = {
        "type": "http",
        "method": "GET",
        "headers": [],
        "asgi": {"spec_version": "2.4"},
    }
    response = main.get_media_store().content("x", item["id"], Request(scope))
    data = root / "x/.media" / item["id"] / "data"
    os.rename(data, data.with_name("saved-original"))
    outside = tmp_path / "outside-secret"
    outside.write_bytes(b"never serve this")
    data.symlink_to(outside)
    body = []

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.body":
            body.append(message["body"])

    await response(scope, receive, send)
    assert b"".join(body) == PNG
    with session_lease(root, "x", exclusive=True) as fd:
        assert fd is not None


@pytest.mark.asyncio
async def test_setup_constructor_failure_releases_every_lease(harness, monkeypatch):
    root, cfg, client, event, release = harness
    item = (await upload(client)).json()["media"]

    def fail(*args, **kwargs):
        raise ValueError("injected response setup failure")

    monkeypatch.setattr(media, "MediaStream", fail)
    assert (await client.get(item["url"])).status_code == 409
    with session_lease(root, "x", exclusive=True) as fd:
        assert fd is not None


@pytest.mark.asyncio
async def test_ranges_etag_head_and_exact_lengths(harness):
    root, cfg, client, event, release = harness
    item = (await upload(client)).json()["media"]
    url = item["url"]
    tag = '"' + item["sha256"] + '"'
    cases = [
        ("bytes=0-0", 206, PNG[:1]),
        ("bytes=1-", 206, PNG[1:]),
        ("bytes=-7", 206, PNG[-7:]),
        ("bytes=-9999", 206, PNG),
        ("bytes=1-9999", 206, PNG[1:]),
        ("bytes=-0", 416, b""),
        (f"bytes={len(PNG)}-", 416, b""),
        ("bytes=9-2", 416, b""),
        ("bytes=a-b", 200, PNG),
        ("bytes=0-2,7-8", 200, PNG),
        ("bytes=" + "9" * 150 + "-", 200, PNG),
    ]
    for value, status, expected in cases:
        response = await client.get(url, headers={"Range": value})
        assert response.status_code == status and response.content == expected
        assert int(response.headers["content-length"]) == len(expected)
    response = await client.get(
        url, headers={"If-None-Match": tag, "Range": "bytes=0-0"}
    )
    assert response.status_code == 304 and response.content == b""
    response = await client.get(
        url, headers={"If-Range": '"stale"', "Range": "bytes=0-0"}
    )
    assert response.status_code == 200 and response.content == PNG
    response = await client.get(url, headers={"If-Range": tag, "Range": "bytes=0-0"})
    assert response.status_code == 206 and response.content == PNG[:1]
    response = await client.head(url, headers={"Range": "bytes=0-0"})
    assert (
        response.status_code == 200
        and int(response.headers["content-length"]) == len(PNG)
        and response.content == b""
    )
