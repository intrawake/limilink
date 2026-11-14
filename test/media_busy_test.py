"""Media deletion protection must not mask an unfenced surviving writer."""

import pytest
from starlette.requests import Request

import main
from session_lease import session_lease
from test.delivery_test import harness as harness
from test.media_test import upload


@pytest.mark.asyncio
async def test_media_plus_foreign_lease_keeps_conservative_busy_until_both_release(
    harness,
):
    root, cfg, client, event, release = harness
    item = (await upload(client)).json()["media"]
    scope = {
        "type": "http",
        "method": "GET",
        "headers": [],
        "asgi": {"spec_version": "2.4"},
    }
    with session_lease(root, "x") as foreign:
        assert foreign is not None
        response = main.get_media_store().content("x", item["id"], Request(scope))
        assert not main.get_delivery_owner().busy("x")
        assert (await client.get("/sessions/x/snapshot")).json()["busy"] is True

        async def receive():
            return {"type": "http.disconnect"}

        async def send(message):
            pass

        await response(scope, receive, send)
        # Our media admission is gone; another holder must still count.
        assert (await client.get("/sessions/x/snapshot")).json()["busy"] is True
    assert (await client.get("/sessions/x/snapshot")).json()["busy"] is False
