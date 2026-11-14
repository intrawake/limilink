"""Operation ownership regressions. All agent calls are offline local children."""

import asyncio
import json
import os
import socket
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

import main


@pytest_asyncio.fixture
async def harness(test_sessions_dir, tmp_path, monkeypatch):
    root = Path(test_sessions_dir)
    events = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    address = "\0delivery-" + uuid.uuid4().hex
    events.bind(address)
    events.setblocking(False)
    agent = tmp_path / "agent"
    agent.write_text("""#!/usr/bin/env python3
import json, os, socket, sys
from pathlib import Path
p = Path.cwd()
rpc = "rpc" in sys.argv
message = json.loads(sys.stdin.readline()).get("customInstructions", "compact") if rpc else sys.argv[-1]
control = p / ("control-" + str(os.getpid()))
os.mkfifo(control)
fd = os.open(control, os.O_RDWR)
event = dict(session=p.name, message=message, pid=os.getpid(), rpc=rpc,
             model=sys.argv[sys.argv.index("--model")+1], marker=os.environ.get("MARKER"),
             thinking=sys.argv[sys.argv.index("--thinking")+1] if "--thinking" in sys.argv else None)
with open(p / "starts", "a") as f: f.write(json.dumps(event)+"\\n")
s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
s.sendto(json.dumps(event).encode(), "\\0" + os.environ["DELIVERY_EVENTS"])
os.read(fd, 1)
if message in ("fail", "empty"):
    sys.exit(1 if message == "fail" else 0)
if rpc:
    print(json.dumps(dict(type="response", command="compact", success=True, data=dict(summary="ok"))), flush=True)
else:
    assert sys.argv[sys.argv.index('--mode')+1] == 'json'
    print(json.dumps(dict(type='message_end',message=dict(role='assistant',stopReason='stop',content=[dict(type='text',text='reply: '+message)]))),flush=True)
    print(json.dumps(dict(type='agent_settled',aborted=False)),flush=True)
""")
    agent.chmod(0o700)
    cfg = {
        "agent_by_alias": {
            "old": {"harness": "pi", "model": "old-model"},
            "new": {"harness": "pi", "model": "new-model"},
        },
        "pi_agent_exepath": str(agent),
        "env_dict": {"DELIVERY_EVENTS": address[1:]},
    }
    monkeypatch.setattr(main, "load_config", lambda: (cfg, str(tmp_path)))
    for sid in ("x", "y"):
        path = root / sid / ".pi/agent/session"
        path.mkdir(parents=True)
        (path / "fake.jsonl").write_text("{}\n")

    async def event():
        data = await asyncio.wait_for(
            asyncio.get_running_loop().sock_recv(events, 65536), 10
        )
        return json.loads(data)

    def release(e):
        fd = os.open(root / e["session"] / ("control-" + str(e["pid"])), os.O_WRONLY)
        os.write(fd, b"x")
        os.close(fd)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app), base_url="http://test"
    ) as client:
        yield root, cfg, client, event, release
    if hasattr(main, "delivery_owners"):
        owner = main.delivery_owners.pop(str(root.resolve()), None)
        if owner:
            await owner.close()
    events.close()


async def submit(client, text, number, sid="x"):
    response = await client.post(
        f"/sessions/{sid}/operations",
        json={"request_id": f"{number:032x}", "message": text},
    )
    assert response.status_code == 202, response.text
    return response.json()["operation"]


async def terminal(client, op):
    # Scheduling/polling is not an ordering oracle: the child uses explicit FIFO barriers.
    async with asyncio.timeout(10):
        while True:
            response = await client.get(
                f"/sessions/{op['session_id']}/operations/{op['id']}"
            )
            assert response.status_code == 200, response.text
            result = response.json()["operation"]
            if result["state"] not in ("queued", "running"):
                return result
            await asyncio.sleep(0.01)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "first,second",
    [("!compact", "chat"), ("!compact", "!compact"), ("chat", "!compact")],
)
async def test_fifo_compact_and_chat(harness, first, second):
    root, cfg, client, event, release = harness
    a = await submit(client, first, 1)
    started = await event()
    b = await submit(client, second, 2)
    assert b["state"] == "queued"
    assert len((root / "x/starts").read_text().splitlines()) == 1
    assert b["sequence"] > a["sequence"]
    release(started)
    following = await event()
    release(following)
    assert (await terminal(client, a))["state"] == "succeeded"
    assert (await terminal(client, b))["state"] == "succeeded"
    history = json.loads((root / "x/chat_history.json").read_text())
    assert [item["request_id"] for item in history] == [
        a["id"],
        a["id"],
        b["id"],
        b["id"],
    ]


@pytest.mark.asyncio
async def test_turn_settings_cross_session_and_replay(harness):
    root, cfg, client, event, release = harness
    a = await submit(client, "a", 1)
    held = await event()
    switch = await submit(client, "!agent new", 2)
    c = await submit(client, "c", 3)
    assert not (root / "x/.agent_type").exists()
    y = await submit(client, "other", 4, "y")
    independent = await event()
    assert independent["session"] == "y"
    release(independent)
    assert (await terminal(client, y))["state"] == "succeeded"
    duplicate = await client.post(
        "/sessions/x/operations", json={"request_id": a["id"], "message": "a"}
    )
    assert duplicate.status_code in (200, 202)
    assert (
        duplicate.json()["operation"]["execution_id"]
        == (await client.get(f"/sessions/x/operations/{a['id']}")).json()["operation"][
            "execution_id"
        ]
    )
    assert (
        await client.post(
            "/sessions/x/operations",
            json={"request_id": a["id"], "message": "conflict"},
        )
    ).status_code == 409
    release(held)
    following = await event()
    assert following["message"] == "c" and following["model"] == "new-model"
    release(following)
    assert (await terminal(client, switch))["state"] == "succeeded"
    assert (await terminal(client, c))["state"] == "succeeded"


@pytest.mark.asyncio
@pytest.mark.parametrize("message", ["fail", "empty"])
async def test_side_effect_failure_never_retries(harness, message):
    root, cfg, client, event, release = harness
    a = await submit(client, message, 1)
    release(await event())
    assert (await terminal(client, a))["state"] == "failed"
    assert len((root / "x/starts").read_text().splitlines()) == 1
    assert (
        await client.post(
            "/sessions/x/operations", json={"request_id": a["id"], "message": message}
        )
    ).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("message", ["chat", "!compact"])
async def test_targeted_stop_preserves_successor_and_replay(harness, message):
    root, cfg, client, event, release = harness
    a = await submit(client, message, 1)
    await event()
    b = await submit(client, "successor", 2)
    stop = await submit(client, "!stop", 3)
    next_started = await event()
    assert next_started["message"] == "successor"
    assert (await terminal(client, a))["state"] == "cancelled"
    assert (await terminal(client, stop))["state"] == "succeeded"
    assert (
        await client.post(
            "/sessions/x/operations",
            json={"request_id": stop["id"], "message": "!stop"},
        )
    ).status_code == 200
    os.kill(next_started["pid"], 0)  # Replaying the stop did not target the successor.
    release(next_started)
    assert (await terminal(client, b))["state"] == "succeeded"


@pytest.mark.asyncio
@pytest.mark.parametrize("message", ["spawn", "!compact"])
async def test_stop_during_spawn_is_bound_before_process_exists(
    harness, monkeypatch, message
):
    root, cfg, client, event, release = harness
    spawning, proceed = asyncio.Event(), asyncio.Event()
    real = asyncio.create_subprocess_exec

    async def delayed(*args, **kwargs):
        spawning.set()
        await proceed.wait()
        return await real(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", delayed)
    a = await submit(client, message, 1)
    await spawning.wait()
    b = await submit(client, "next", 2)
    stop = await submit(client, "!stop", 3)
    proceed.set()
    assert (await terminal(client, a))["state"] == "cancelled"
    assert (await terminal(client, stop))["state"] == "succeeded"
    following = await event()
    if following["message"] != "next":
        following = await event()  # Target may report startup just before its signal.
    assert following["message"] == "next"
    release(following)
    assert (await terminal(client, b))["state"] == "succeeded"


@pytest.mark.asyncio
async def test_capacity_duplicates_stop_and_strict_identity(harness):
    root, cfg, client, event, release = harness
    cfg["session_queue_limit"] = 1
    await submit(client, "held", 1)
    await event()
    b = await submit(client, "queued", 2)
    assert (
        await client.post(
            "/sessions/x/operations",
            json={"request_id": "f" * 32, "message": "not sent"},
        )
    ).status_code == 429
    assert (
        await client.post(
            "/sessions/x/operations", json={"request_id": b["id"], "message": "queued"}
        )
    ).status_code == 200
    stop = await submit(client, "!stop", 3)
    next_started = await event()
    release(next_started)
    assert (await terminal(client, b))["state"] == "succeeded"
    assert (await terminal(client, stop))["state"] == "succeeded"
    for sid, status in (("missing", 404), ("x!", 400)):
        response = await client.post(
            f"/sessions/{sid}/operations",
            json={"request_id": "e" * 32, "message": "unsent"},
        )
        assert response.status_code == status
    assert not (root / "missing").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("message", ["chat", "!compact"])
async def test_service_crash_classifies_without_resuming_and_keeps_fence(
    harness, message
):
    import subprocess
    import sys
    from delivery import lock_file

    root, cfg, client, event, release = harness
    code = """import asyncio,json,sys,main
main.load_config=lambda:(json.loads(sys.argv[1]), "/unused")
async def run():
    main.admit_operation("x", "a"*32, sys.argv[2])
    main.admit_operation("x", "b"*32, "never start")
    await asyncio.Event().wait()
asyncio.run(run())
"""
    service = subprocess.Popen(
        [sys.executable, "-c", code, json.dumps(cfg), message],
        env={**os.environ, "PYTHONPATH": str(Path(main.__file__).parent)},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    started = None
    try:
        started = await event()
        service.kill()
        await asyncio.to_thread(service.wait, 10)
        # The old writer, not the crashed service, retains BOTH ownership locks.
        assert lock_file(root / ".execution-x") is None
        from session_lease import session_lease

        with session_lease(root, "x", exclusive=True) as fd:
            assert fd is None
        running = (await client.get("/sessions/x/operations/" + "a" * 32)).json()[
            "operation"
        ]
        queued = (await client.get("/sessions/x/operations/" + "b" * 32)).json()[
            "operation"
        ]
        assert running["state"] == "indeterminate"
        assert queued["state"] == "interrupted_not_started"
        assert (
            await client.post(
                "/sessions/x/operations",
                json={"request_id": "a" * 32, "message": message},
            )
        ).json()["operation"]["state"] == "indeterminate"
        assert (
            await client.post(
                "/sessions/x/operations",
                json={"request_id": "c" * 32, "message": "blocked"},
            )
        ).status_code == 409
        assert len((root / "x/starts").read_text().splitlines()) == 1
    finally:
        if service.poll() is None:
            service.kill()
            service.wait(10)
        if started:
            # Only the test's own offline writer, never a live process.
            import signal

            os.kill(started["pid"], signal.SIGKILL)
        assert service.stderr is not None
        service.stderr.close()


@pytest.mark.asyncio
async def test_second_owner_fails_startup_then_clean_startup_succeeds(harness):
    import subprocess
    import sys

    root, cfg, client, event, release = harness
    main.get_delivery_owner()
    code = """import asyncio,json,sys,main
main.load_config=lambda:(json.loads(sys.argv[1]), "/unused")
async def run():
    async with main.app_lifespan(main.app): pass
asyncio.run(run())
"""

    def run():
        return subprocess.run(
            [sys.executable, "-c", code, json.dumps(cfg)],
            capture_output=True,
            env={**os.environ, "PYTHONPATH": str(Path(main.__file__).parent)},
            timeout=10,
        )

    refused = await asyncio.to_thread(run)
    assert refused.returncode != 0 and b"already owns" in refused.stderr
    await main.get_delivery_owner().close()
    accepted = await asyncio.to_thread(run)
    assert accepted.returncode == 0, accepted.stderr.decode()


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["accept", "start", "result"])
async def test_storage_failure_never_spawns_or_advances_unsafe_lane(
    harness, monkeypatch, phase
):
    import delivery

    root, cfg, client, event, release = harness
    original = delivery.write_operation

    def broken(path, record, *, create=False):
        if (
            (phase == "accept" and create)
            or (phase == "start" and record["state"] == "running")
            or (phase == "result" and record["state"] in ("succeeded", "indeterminate"))
        ):
            if create:
                path.touch()  # Partial exclusive acceptance remains a tombstone.
            raise OSError("injected disk full")
        return original(path, record, create=create)

    monkeypatch.setattr(delivery, "write_operation", broken)
    if phase == "accept":
        response = await client.post(
            "/sessions/x/operations",
            json={"request_id": "a" * 32, "message": "not accepted"},
        )
        assert (
            response.status_code == 409
            and response.json()["code"] == "send_indeterminate"
        )
        assert not (root / "x/starts").exists()
        monkeypatch.setattr(delivery, "write_operation", original)
        assert (
            await client.post(
                "/sessions/x/operations",
                json={"request_id": "a" * 32, "message": "not accepted"},
            )
        ).status_code == 409
    else:
        a = await submit(client, "a", 1)
        if phase == "result":
            held = await event()
            b = await submit(client, "must wait", 2)
            release(held)
        result = await terminal(client, a)
        assert result["state"] == "indeterminate"
        assert (
            await client.post(
                "/sessions/x/operations",
                json={"request_id": "e" * 32, "message": "refused"},
            )
        ).status_code == 409
        if phase == "start":
            assert not (root / "x/starts").exists()
        else:
            assert len((root / "x/starts").read_text().splitlines()) == 1
            assert (await client.get(f"/sessions/x/operations/{b['id']}")).json()[
                "operation"
            ]["state"] == "interrupted_not_started"


@pytest.mark.asyncio
async def test_partial_configuration_and_history_projection_pause_lane(
    harness, monkeypatch
):
    root, cfg, client, event, release = harness

    def fail(*args, **kwargs):
        raise OSError("partial resource change")

    monkeypatch.setattr(main, "reconcile_session_symlinks", fail)
    a = await submit(client, "!agent new", 1)
    assert (await terminal(client, a))["state"] == "indeterminate"
    assert (
        await client.post(
            "/sessions/x/operations",
            json={"request_id": "e" * 32, "message": "no mixed resources"},
        )
    ).status_code == 409
    assert not (root / "x/starts").exists()


@pytest.mark.asyncio
async def test_corrupt_projection_does_not_erase_history_or_release_followup(harness):
    root, cfg, client, event, release = harness
    a = await submit(client, "a", 1)
    held = await event()
    b = await submit(client, "queued", 2)
    (root / "x/chat_history.json").write_text("{")
    release(held)
    assert (await terminal(client, a))["state"] == "indeterminate"
    assert (root / "x/chat_history.json").read_text() == "{"
    assert (await client.get(f"/sessions/x/operations/{b['id']}")).json()["operation"][
        "state"
    ] == "interrupted_not_started"
    assert len((root / "x/starts").read_text().splitlines()) == 1


@pytest.mark.asyncio
async def test_legacy_http_disconnect_does_not_cancel_service_owned_execution(harness):
    root, cfg, client, event, release = harness
    request = asyncio.create_task(
        client.post(
            "/chat", json={"session_id": "x", "request_id": "a" * 32, "message": "held"}
        )
    )
    held = await event()
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request
    assert (await client.get("/sessions/x/operations/" + "a" * 32)).json()["operation"][
        "state"
    ] == "running"
    release(held)
    result = await terminal(client, {"session_id": "x", "id": "a" * 32})
    assert result["state"] == "succeeded"
    assert (
        await client.post(
            "/chat", json={"session_id": "x", "request_id": "a" * 32, "message": "held"}
        )
    ).json() == {"reply": "reply: held"}
    assert len((root / "x/starts").read_text().splitlines()) == 1


@pytest.mark.asyncio
async def test_notify_raw_delivery_skips_busy_reasoning_and_uses_owner_when_idle(
    harness,
):
    root, cfg, client, event, release = harness
    a = await submit(client, "held", 1)
    held = await event()
    await main.run_notifyme_task("x", "raw while busy")
    assert main.dequeue_unread_messages(str(root / "x")) == ["raw while busy"]
    assert len((root / "x/starts").read_text().splitlines()) == 1
    release(held)
    await terminal(client, a)
    notification = asyncio.create_task(main.run_notifyme_task("x", "idle notification"))
    reasoning = await event()
    release(reasoning)
    await notification
    assert main.dequeue_unread_messages(str(root / "x")) == [
        "idle notification",
        "reply: idle notification",
    ]
    ops = (await client.get("/sessions/x/operations")).json()["operations"]
    assert [op["message"] for op in ops] == ["held", "idle notification"]


@pytest.mark.asyncio
async def test_discord_legacy_adapter_cannot_bypass_session_owner(harness, monkeypatch):
    from contextlib import asynccontextmanager
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    import demo.discord_bot as bot

    root, cfg, client, event, release = harness
    a = await submit(client, "held", 1)
    held = await event()
    monkeypatch.setattr(bot, "sessions_dir", str(root))
    monkeypatch.setattr(bot, "channel_sessions", {"42": "x"})
    reply_sender = AsyncMock()
    monkeypatch.setattr(bot, "send_limilink_reply", reply_sender)
    monkeypatch.setattr(
        bot.httpx,
        "AsyncClient",
        lambda **kwargs: httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ),
    )

    @asynccontextmanager
    async def typing():
        yield

    channel = SimpleNamespace(
        name="limilink-offline-test", id=42, typing=typing, send=AsyncMock()
    )
    message = SimpleNamespace(author=object(), channel=channel, content="!agent new")
    task = asyncio.create_task(bot.on_message(message))
    async with asyncio.timeout(10):
        while True:
            ops = (await client.get("/sessions/x/operations")).json()["operations"]
            if len(ops) == 2:
                break
            await asyncio.sleep(0.01)
    assert ops[1]["message"] == "!agent new" and ops[1]["state"] == "queued"
    assert not (root / "x/.agent_type").exists()
    c = await submit(client, "after discord switch", 3)
    release(held)
    following = await event()
    assert following["model"] == "new-model"
    release(following)
    assert (await terminal(client, c))["state"] == "succeeded"
    await task
    reply_sender.assert_awaited_once_with(channel, "Agent switched to: new", "x")
    assert (await terminal(client, a))["state"] == "succeeded"


@pytest.mark.asyncio
async def test_unconfirmed_real_inherited_writer_pauses_lane(harness, monkeypatch):
    import subprocess
    import sys
    from delivery import current_attempt

    root, cfg, client, event, release = harness
    children = []

    async def premature(session_id, message, lease_fd, request_id=None):
        attempt = current_attempt.get()
        assert attempt is not None
        child = subprocess.Popen(
            [sys.executable, "-c", "import sys;sys.stdin.buffer.read(1)"],
            pass_fds=(lease_fd, attempt.fence_fd),
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        children.append(child)
        return "Adapter returned without settling its inherited writer"

    monkeypatch.setattr(main, "_process_chat", premature)
    try:
        a = await submit(client, "real leftover", 1)
        assert (await terminal(client, a))["state"] == "indeterminate"
        assert (
            await client.post(
                "/sessions/x/operations",
                json={"request_id": "e" * 32, "message": "must not start"},
            )
        ).status_code == 409
        assert children[0].poll() is None
    finally:
        for child in children:
            child.stdin.close()
            await asyncio.to_thread(child.wait, 10)


@pytest.mark.asyncio
async def test_operation_list_bounds_exact_lookup_and_revisions(harness):
    root, cfg, client, event, release = harness
    first = await submit(client, "!unknown", 1)
    done = await terminal(client, first)
    assert done["revision"] > first["revision"]
    for index in range(2, 68):
        op = await submit(client, "!unknown", index)
        await terminal(client, op)
    listed = (await client.get("/sessions/x/operations")).json()["operations"]
    assert len(listed) == 64 and listed[0]["sequence"] == 3
    exact = (
        await client.get(
            "/sessions/x/operations",
            params=[("request_id", first["id"]), ("request_id", "f" * 32)],
        )
    ).json()["operations"]
    assert [op["id"] for op in exact] == [first["id"]]
    assert (
        await client.get(
            "/sessions/x/operations", params=[("request_id", first["id"])] * 65
        )
    ).status_code == 400
    history = json.loads((root / "x/chat_history.json").read_text())
    assert len(history) == 134
    # The authoritative operation replays; projection cannot duplicate either role.
    assert (
        await client.post(
            "/sessions/x/operations",
            json={"request_id": first["id"], "message": "!unknown"},
        )
    ).status_code == 200
    assert json.loads((root / "x/chat_history.json").read_text()) == history


@pytest.mark.asyncio
async def test_model_reasoning_and_environment_resolve_only_at_turn(harness):
    root, cfg, client, event, release = harness
    a = await submit(client, "held", 1)
    held = await event()
    await submit(client, "!model explicit-model", 2)
    await submit(client, "!reasoning_effort high", 3)
    await submit(client, "!env MARKER turn-value", 4)
    c = await submit(client, "after settings", 5)
    assert not any(
        (root / "x" / name).exists()
        for name in (".model", ".reasoning_effort", ".env_overrides.json")
    )
    assert held["model"] == "old-model" and held["marker"] is None
    release(held)
    following = await event()
    assert following["model"] == "explicit-model"
    assert following["marker"] == "turn-value" and following["thinking"] == "high"
    release(following)
    assert (await terminal(client, c))["state"] == "succeeded"
    assert (await terminal(client, a))["state"] == "succeeded"


@pytest.mark.asyncio
@pytest.mark.parametrize("file", [".env_overrides.json", ".pi/agent/settings.json"])
async def test_unreadable_turn_settings_pause_without_fallback(harness, file):
    root, cfg, client, event, release = harness
    path = root / "x" / file
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{")
    a = await submit(client, "must not run with guessed settings", 1)
    assert (await terminal(client, a))["state"] == "indeterminate"
    assert path.read_text() == "{"
    assert not (root / "x/starts").exists()


@pytest.mark.asyncio
async def test_corrupt_operation_lookup_pauses_future_mutations(harness):
    root, cfg, client, event, release = harness
    a = await submit(client, "!unknown", 1)
    await terminal(client, a)
    path = root / "x/.web-requests" / (a["id"] + ".json")
    path.write_text("{")
    response = await client.get("/sessions/x/operations/" + a["id"])
    assert (
        response.status_code == 409 and response.json()["code"] == "send_indeterminate"
    )
    assert (
        await client.post(
            "/sessions/x/operations",
            json={"request_id": "e" * 32, "message": "refused"},
        )
    ).status_code == 409
    assert path.read_text() == "{" and not (root / "x/starts").exists()


@pytest.mark.asyncio
async def test_recovery_rebuilds_result_projection_but_never_executes(harness):
    root, cfg, client, event, release = harness
    a = await submit(client, "once", 1)
    release(await event())
    await terminal(client, a)
    original = json.loads((root / "x/chat_history.json").read_text())
    await main.get_delivery_owner().close()
    (
        root / "x/chat_history.json"
    ).unlink()  # Simulates a crash between result and projection.
    recovered = (await client.get("/sessions/x/operations/" + a["id"])).json()[
        "operation"
    ]
    assert recovered["state"] == "succeeded"
    assert json.loads((root / "x/chat_history.json").read_text()) == original
    assert len((root / "x/starts").read_text().splitlines()) == 1


@pytest.mark.asyncio
async def test_accepted_work_and_legacy_waiter_stay_bound_to_canonical_root(
    harness, monkeypatch, tmp_path
):
    root, cfg, client, event, release = harness
    request = asyncio.create_task(
        client.post(
            "/chat", json={"session_id": "x", "request_id": "a" * 32, "message": "held"}
        )
    )
    held = await event()
    queued = await submit(client, "same accepted root", 2)
    owner = main.get_delivery_owner()
    other = tmp_path / "different-configured-root"
    monkeypatch.setattr(main, "get_sessions_dir", lambda *args: str(other))
    release(held)
    assert (await request).json() == {"reply": "reply: held"}
    following = await event()
    assert following["message"] == "same accepted root"
    release(following)
    assert (await owner.wait(queued))["state"] == "succeeded"
    assert not other.exists()
    assert len(json.loads((root / "x/chat_history.json").read_text())) == 4


@asynccontextmanager
async def surviving_review_writer(root):
    """A different process retains real kernel ownership, without an owner attempt."""
    import subprocess
    import sys

    code = """import sys
from pathlib import Path
from delivery import lock_file
from session_lease import session_lease
root=Path(sys.argv[1])
with session_lease(root, 'x'):
    fd=lock_file(root / '.execution-x')
    assert fd is not None
    print('owned', flush=True)
    sys.stdin.buffer.read(1)
"""
    child = subprocess.Popen(
        [sys.executable, "-c", code, str(root)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "PYTHONPATH": str(Path(main.__file__).parent)},
    )
    assert (
        child.stdout is not None
        and child.stdin is not None
        and child.stderr is not None
    )
    try:
        assert (
            await asyncio.wait_for(asyncio.to_thread(child.stdout.readline), 10)
            == b"owned\n"
        )
        yield child
    finally:
        child.stdin.close()
        await asyncio.to_thread(child.wait, 10)
        child.stdout.close()
        child.stderr.close()


@pytest.mark.asyncio
async def test_review_no_target_stop_cannot_project_beside_surviving_writer(harness):
    from delivery import lock_file

    root, cfg, client, event, release = harness
    history = root / "x/chat_history.json"
    history.write_text("[]")
    async with surviving_review_writer(root) as child:
        stop = await asyncio.wait_for(submit(client, "!stop", 101), 1)
        # A metadata-only warning must remain visible in the browser's existing
        # non-success presentation; succeeded outcomes rely on projected history.
        assert stop["state"] == "failed"
        assert stop["outcome"]["status"] == 409
        assert "earlier writer" in stop["outcome"]["body"]["detail"]
        assert "not stopped" in stop["outcome"]["body"]["detail"]
        assert history.read_text() == "[]"
        assert lock_file(root / ".execution-x") is None and child.poll() is None
        replay = await client.post(
            "/sessions/x/operations",
            json={"request_id": stop["id"], "message": "!stop"},
        )
        assert replay.status_code == 200
        assert replay.json()["operation"]["outcome"] == stop["outcome"]
        polled = (await client.get("/sessions/x/operations/" + stop["id"])).json()[
            "operation"
        ]
        assert polled["state"] == "failed" and polled["outcome"] == stop["outcome"]
        assert history.read_text() == "[]"
    # A later safe startup can rebuild the omitted projection, never execution.
    await main.get_delivery_owner().close()
    assert (await client.get("/sessions/x/operations/" + stop["id"])).status_code == 200
    assert len(json.loads(history.read_text())) == 2


@pytest.mark.asyncio
async def test_review_close_queued_interruptions_cannot_project_without_fence(harness):
    from delivery import read_operation

    root, cfg, client, event, release = harness
    history = root / "x/chat_history.json"
    history.write_text("[]")
    owner = main.get_delivery_owner()
    owner.lane("x")  # Initialize before the separate writer acquires its fence.
    async with surviving_review_writer(root) as child:
        # No yield: close cancels the worker before its first turn.
        for index in (101, 102):
            owner.admit("x", f"{index:032x}", "never started")
        await owner.close()
        assert history.read_text() == "[]"
        assert child.poll() is None
        for index in (101, 102):
            assert (
                read_operation(owner.path("x", f"{index:032x}"))["state"]
                == "interrupted_not_started"
            )


@pytest.mark.asyncio
async def test_review_creation_is_unpublished_until_all_configuration_is_ready(
    harness, monkeypatch
):
    from contextlib import asynccontextmanager

    root, cfg, client, event, release = harness
    entering, proceed = asyncio.Event(), asyncio.Event()
    original_open, original_uuid = main.aiofiles.open, main.uuid.uuid4
    generated = []

    def capture_uuid():
        value = original_uuid()
        generated.append(value)
        return value

    @asynccontextmanager
    async def paused_open(path, *args, **kwargs):
        async with original_open(path, *args, **kwargs) as output:
            if Path(path).name == ".agent_type" and not entering.is_set():
                entering.set()
                await proceed.wait()
            yield output

    monkeypatch.setattr(main.uuid, "uuid4", capture_uuid)
    monkeypatch.setattr(main.aiofiles, "open", paused_open)
    creating = asyncio.create_task(client.post("/sessions"))
    try:
        await asyncio.wait_for(entering.wait(), 10)
        expected = "session_" + generated[0].hex[:8]
        assert (await client.get("/sessions")).json()["sessions"] == ["x", "y"]
        assert {
            row["id"]
            for row in (await client.get("/session-sidebar")).json()["sessions"]
        } == {"x", "y"}
        assert not (root / expected).exists()
        refused = await client.post(
            f"/sessions/{expected}/operations",
            json={"request_id": "d" * 32, "message": "!agent new"},
        )
        assert refused.status_code == 404
    finally:
        proceed.set()
        created = await creating
    assert created.status_code == 200
    sid = created.json()["session_id"]
    switch = await submit(client, "!agent new", 103, sid)
    assert (await terminal(client, switch))["state"] == "succeeded"
    chat = await submit(client, "after initialized switch", 104, sid)
    started = await event()
    assert started["session"] == sid and started["model"] == "new-model"
    release(started)
    assert (await terminal(client, chat))["state"] == "succeeded"
    assert (root / sid / ".agent_type").read_text() == "new"
