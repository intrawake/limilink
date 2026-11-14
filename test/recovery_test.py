"""Explicit recovery never means retrying uncertain work (offline children only)."""

import json
import uuid

import pytest

from delivery import write_operation
from test.delivery_test import harness as harness, submit, terminal
import main


def interrupted(root):
    path = root / "x/.web-requests"
    path.mkdir()
    for number, state in ((1, "running"), (2, "queued")):
        rid = f"{number:032x}"
        write_operation(
            path / f"{rid}.json",
            dict(
                version=2,
                id=rid,
                session_id="x",
                sequence=number,
                revision=0,
                state=state,
                message="uncertain" if number == 1 else "never start",
                execution_id="old-attempt" if number == 1 else None,
                outcome=None,
            ),
            create=True,
        )


async def preview(client):
    response = await client.get("/sessions/x/recovery")
    assert response.status_code == 200, response.text
    return {**response.json(), "request_id": uuid.uuid4().hex}


async def confirm(client, snapshot, **extra):
    return await client.post(
        "/sessions/x/recovery",
        json={
            "request_id": snapshot["request_id"],
            "token": snapshot["token"],
            "acknowledge_possible_effects": True,
            **extra,
        },
    )


@pytest.mark.asyncio
async def test_recover_preserves_uncertainty_and_never_replays_after_restart(harness):
    root, cfg, client, event, release = harness
    interrupted(root)
    snapshot = await preview(client)
    assert snapshot["recovery_required"] is True
    old = (await client.get("/sessions/x/operations")).json()["operations"]
    assert [op["state"] for op in old] == ["indeterminate", "interrupted_not_started"]
    assert (
        await confirm(client, snapshot, acknowledge_possible_effects=False)
    ).status_code == 422
    response = await confirm(client, snapshot)
    assert response.status_code == 200, response.text
    assert (await preview(client))["recovery_required"] is False
    assert (await client.get("/sessions/x/operations")).json()["operations"] == old
    assert not (root / "x/starts").exists()
    # Repeating an old confirmation observes its receipt, never clears a newer fault.
    assert (await confirm(client, snapshot)).status_code == 200
    owner = main.delivery_owners.pop(str(root.resolve()))
    await owner.close()
    assert (await preview(client))["recovery_required"] is False
    assert not (root / "x/starts").exists()
    replay = await client.post(
        "/sessions/x/operations",
        json={"request_id": old[0]["id"], "message": "uncertain"},
    )
    assert replay.json()["operation"] == old[0]
    new = await submit(client, "only explicit new work", 3)
    start = await event()
    assert start["message"] == "only explicit new work"
    release(start)
    assert (await terminal(client, new))["state"] == "succeeded"
    owner = main.get_delivery_owner()
    owner.uncertain(owner.lane("x"), owner.lookup("x", new["id"]), "a new uncertainty")
    # Old confirmation does not authorize this new indeterminate operation.
    await confirm(client, snapshot)
    assert (await preview(client))["recovery_required"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["history", "configuration", "receipt", "corrupt"])
async def test_stale_review_or_corruption_cannot_unpause(harness, mutation):
    root, cfg, client, event, release = harness
    interrupted(root)
    snapshot = await preview(client)
    if mutation == "history":
        (root / "x/chat_history.json").write_text(
            json.dumps([{"role": "user", "content": "changed"}])
        )
    elif mutation == "configuration":
        (root / "x/.model").write_text("changed-model")
    elif mutation == "receipt":
        path = root / "x/.web-requests" / ("1".zfill(32) + ".json")
        record = json.loads(path.read_text())
        record["revision"] += 1
        path.write_text(json.dumps(record))
    else:
        (root / "x/.web-requests" / ("f" * 32 + ".json")).write_text("{")
    assert (await confirm(client, snapshot)).status_code == 409
    assert main.get_delivery_owner().lane("x").paused
    assert not (root / "x/starts").exists()
