"""Recovery preconditions, legacy evidence and atomic acknowledgement faults."""

import os

import pytest

from test.delivery_test import harness as harness, submit, terminal
from test.recovery_test import interrupted, preview, confirm
from recovery import ledger_path
from send_receipt import receipt_path, reserve_send
from session_lease import session_lease
import main


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind",
    [
        "receipt",
        "history",
        "settings",
        "environment",
        "ledger",
        "resource",
        "unpersisted",
    ],
)
async def test_invalid_evidence_is_blocked_without_repair(harness, kind):
    root, cfg, client, event, release = harness
    interrupted(root)
    await preview(client)
    if kind == "receipt":
        (root / "x/.web-requests" / ("f" * 32 + ".json")).write_text("{")
    elif kind == "history":
        (root / "x/chat_history.json").write_text("{")
    elif kind == "settings":
        (root / "x/.pi/agent/settings.json").write_text("[]")
    elif kind == "environment":
        (root / "x/.env_overrides.json").write_text('{"x":42}')
    elif kind == "ledger":
        ledger_path(root, "x").write_text("{")
    elif kind == "resource":
        cfg["agent_by_alias"]["old"]["session_symlink_dict"] = {
            "auth.json": "/expected"
        }
        (root / "x/auth.json").symlink_to("/wrong")
    else:
        main.get_delivery_owner().lane("x").unpersisted["a" * 32] = {}
    before = {
        p: p.read_bytes()
        for p in (root / "x").rglob("*")
        if p.is_file() and not p.is_symlink()
    }
    response = await client.get("/sessions/x/recovery")
    assert response.status_code == 409, response.text
    assert main.get_delivery_owner().lane("x").paused
    assert all(p.read_bytes() == raw for p, raw in before.items())
    assert not (root / "x/starts").exists()


@pytest.mark.asyncio
async def test_atomic_commit_failure_stays_paused_then_lost_response_is_observable(
    harness, monkeypatch
):
    import recovery

    root, cfg, client, event, release = harness
    interrupted(root)
    snapshot = await preview(client)
    replace = recovery.os.replace

    def fail(*args):
        raise OSError("injected commit failure")

    monkeypatch.setattr(recovery.os, "replace", fail)
    assert (await confirm(client, snapshot)).status_code == 409
    assert main.get_delivery_owner().lane("x").paused
    assert not ledger_path(root, "x").exists()
    monkeypatch.setattr(recovery.os, "replace", replace)
    assert (await confirm(client, snapshot)).status_code == 200
    lookup = await client.get(
        "/sessions/x/recovery", params={"request_id": snapshot["request_id"]}
    )
    assert lookup.json()["confirmation"]["acknowledged"] is True
    assert (await confirm(client, {**snapshot, "token": "f" * 64})).status_code == 409
    owner = main.delivery_owners.pop(str(root.resolve()))
    await owner.close()
    assert (await confirm(client, snapshot)).json()["confirmation"][
        "acknowledged"
    ] is True
    assert (await preview(client))["recovery_required"] is False
    assert not (root / "x/starts").exists()


@pytest.mark.asyncio
async def test_exclusive_lease_and_fence_both_required(harness):
    from delivery import lock_file

    root, cfg, client, event, release = harness
    interrupted(root)
    snapshot = await preview(client)
    before = (root / "x/chat_history.json").read_bytes()
    # A legacy survivor may hold only a lifecycle lease, not the new fence.
    with session_lease(root, "x") as fd:
        assert fd is not None
        assert (await client.get("/sessions/x/recovery")).status_code == 409
        assert (await confirm(client, snapshot)).status_code == 409
    fence = lock_file(root / ".execution-x")
    assert fence is not None
    try:
        assert (await client.get("/sessions/x/recovery")).status_code == 409
        assert (await confirm(client, snapshot)).status_code == 409
    finally:
        os.close(fence)
    assert (root / "x/chat_history.json").read_bytes() == before
    assert (await confirm(client, snapshot)).status_code == 200


@pytest.mark.asyncio
async def test_legacy_unknown_acknowledgement_survives_every_lookup_and_restart(
    harness,
):
    root, cfg, client, event, release = harness
    path = receipt_path(root / "x", "a" * 32)
    reserve_send(path, "legacy unknown")
    snapshot = await preview(client)
    old = path.read_bytes()
    assert (await confirm(client, snapshot)).status_code == 200
    for restart in (False, True):
        if restart:
            owner = main.delivery_owners.pop(str(root.resolve()))
            await owner.close()
        response = await client.get("/sessions/x/operations")
        assert response.status_code == 200 and response.json()["operations"] == []
        assert response.json()["recovery_required"] is False
        exact = await client.get(
            "/sessions/x/operations", params={"request_id": "a" * 32}
        )
        assert exact.status_code == 200 and exact.json()["operations"] == []
        # Legacy same-ID replay still refuses uncertainty, but never re-pauses.
        response = await client.post(
            "/chat",
            json={
                "session_id": "x",
                "request_id": "a" * 32,
                "message": "legacy unknown",
            },
        )
        assert response.status_code == 409
        assert (await preview(client))["recovery_required"] is False
        assert path.read_bytes() == old
    # Even byte-only edits invalidate exact acknowledgement coverage.
    path.write_bytes(old + b"\n")
    owner = main.delivery_owners.pop(str(root.resolve()))
    await owner.close()
    assert (await preview(client))["recovery_required"] is True


@pytest.mark.asyncio
async def test_live_fault_settles_queued_waiters_but_recovery_never_releases_them(
    harness,
):
    from delivery import ExecutionUncertain

    root, cfg, client, event, release = harness
    active = await submit(client, "active", 1)
    held = await event()
    queued = await submit(client, "never start", 2)
    owner = main.get_delivery_owner()
    queued_waiter = owner.lane("x").futures[queued["id"]]
    # Existing in-flight adapter finishes, but terminal projection fails once.
    project = owner.project

    def fail_projection(record):
        raise ExecutionUncertain("injected outcome projection failure")

    owner.project = fail_projection
    release(held)
    assert (await terminal(client, active))["state"] == "indeterminate"
    assert (await queued_waiter)["state"] == "interrupted_not_started"
    assert not owner.lane("x").queue
    owner.project = project
    snapshot = await preview(client)
    assert (await confirm(client, snapshot)).status_code == 200
    assert len((root / "x/starts").read_text().splitlines()) == 1
    new = await submit(client, "new only", 3)
    release(await event())
    assert (await terminal(client, new))["state"] == "succeeded"


@pytest.mark.asyncio
@pytest.mark.parametrize("ack", [False, 0, 1, "true", None])
async def test_acknowledgement_must_be_literal_boolean_true(harness, ack):
    root, cfg, client, event, release = harness
    interrupted(root)
    snapshot = await preview(client)
    assert (
        await confirm(client, snapshot, acknowledge_possible_effects=ack)
    ).status_code == 422
    assert main.get_delivery_owner().lane("x").paused
