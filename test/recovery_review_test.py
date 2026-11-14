"""Regressions for independently reproduced recovery review findings."""

import json

import pytest

import delivery
from test.delivery_test import harness as harness, submit, terminal
from test.recovery_test import interrupted, preview, confirm
from session_lease import session_lease
import main


@pytest.mark.asyncio
async def test_pause_before_worker_first_turn_settles_unstarted_and_releases_lease(
    harness, monkeypatch
):
    root, cfg, client, event, release = harness
    owner = main.get_delivery_owner()
    original = delivery.write_operation

    def fail_stop_start(path, record, **kwargs):
        if record["message"] == "!stop" and record["state"] == "running":
            raise OSError("injected stop-start write failure")
        return original(path, record, **kwargs)

    monkeypatch.setattr(delivery, "write_operation", fail_stop_start)
    # Both admissions happen before the worker gets any scheduling turn.
    queued, _ = owner.admit("x", "1" * 32, "must not run")
    waiter = owner.lane("x").futures[queued["id"]]
    stop, _ = owner.admit("x", "2" * 32, "!stop")
    assert stop["state"] == "indeterminate"
    monkeypatch.setattr(delivery, "write_operation", original)
    task = owner.lane("x").task
    assert task is not None
    await task
    assert not owner.lane("x").queue
    assert waiter.done() and waiter.result()["state"] == "interrupted_not_started"
    assert not owner.lane("x").unpersisted
    with session_lease(root, "x", exclusive=True) as fd:
        assert fd is not None
    assert not (root / "x/starts").exists()
    snapshot = await preview(client)
    assert (await confirm(client, snapshot)).status_code == 200
    new = await submit(client, "explicit new work", 3)
    release(await event())
    assert (await terminal(client, new))["state"] == "succeeded"
    assert len((root / "x/starts").read_text().splitlines()) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source,key,value",
    [
        ("override", "A=B", "value"),
        ("override", "", "value"),
        ("override", "A\0B", "value"),
        ("override", "A", "value\0"),
        ("global", "A=B", "value"),
        ("preset", "A", "value\0"),
    ],
)
async def test_unrepresentable_effective_environment_cannot_be_acknowledged(
    harness, source, key, value
):
    root, cfg, client, event, release = harness
    interrupted(root)
    if source == "override":
        path = root / "x/.env_overrides.json"
        path.write_text(json.dumps({key: value}))
    elif source == "global":
        cfg.setdefault("env_dict", {})[key] = value
    else:
        cfg["agent_by_alias"]["old"].setdefault("env_dict", {})[key] = value
    response = await client.get("/sessions/x/recovery")
    assert response.status_code == 409, response.text
    assert "environment" in response.json()["detail"].lower()
    assert main.get_delivery_owner().lane("x").paused
    assert not (root / "x/.delivery-recovery.json").exists()
    assert not (root / "x/starts").exists()
