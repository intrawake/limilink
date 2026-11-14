"""Real service death, surviving inherited writer, explicit settlement/recovery."""

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from delivery import lock_file
from test.delivery_test import harness as harness, submit, terminal
from test.recovery_test import confirm, preview
import main


@pytest.mark.asyncio
@pytest.mark.parametrize("message", ["ordinary", "!compact"])
async def test_crash_survivor_blocks_recovery_then_only_new_work_can_run(
    harness, message
):
    root, cfg, client, event, release = harness
    code = """import asyncio,json,sys,main
main.load_config=lambda:(json.loads(sys.argv[1]), '/unused')
async def run():
    main.admit_operation('x', 'a'*32, sys.argv[2])
    main.admit_operation('x', 'b'*32, 'must never resume')
    await asyncio.Event().wait()
asyncio.run(run())
"""
    service = subprocess.Popen(
        [sys.executable, "-c", code, json.dumps(cfg), message],
        env={**os.environ, "PYTHONPATH": str(Path(main.__file__).parent)},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    held = None
    released = False
    try:
        held = await event()
        service.kill()
        await asyncio.to_thread(service.wait, 10)
        assert lock_file(root / ".execution-x") is None
        response = await client.get("/sessions/x/recovery")
        assert response.status_code == 409, response.text
        blocked = await client.post(
            "/sessions/x/recovery",
            json={
                "request_id": "d" * 32,
                "token": "f" * 64,
                "acknowledge_possible_effects": True,
            },
        )
        assert blocked.status_code == 409
        assert len((root / "x/starts").read_text().splitlines()) == 1
        before = {p: p.read_bytes() for p in (root / "x/.web-requests").glob("*.json")}
        # Explicitly let only this offline test child exit, never signal a live writer.
        release(held)
        released = True
        async with asyncio.timeout(10):
            while True:
                fd = lock_file(root / ".execution-x")
                if fd is not None:
                    os.close(fd)
                    break
                await asyncio.sleep(0.01)
        snapshot = await preview(client)
        assert snapshot["uncertain_ids"] == ["a" * 32]
        assert (await confirm(client, snapshot)).status_code == 200
        assert all(p.read_bytes() == raw for p, raw in before.items())
        assert len((root / "x/starts").read_text().splitlines()) == 1
        # New service owner honors committed acknowledgement without replaying.
        owner = main.delivery_owners.pop(str(root.resolve()))
        await owner.close()
        assert (await preview(client))["recovery_required"] is False
        operations = (await client.get("/sessions/x/operations")).json()["operations"]
        assert [op["state"] for op in operations] == [
            "indeterminate",
            "interrupted_not_started",
        ]
        new = await submit(client, "explicit new message", 3)
        following = await event()
        assert following["message"] == "explicit new message"
        release(following)
        assert (await terminal(client, new))["state"] == "succeeded"
        assert len((root / "x/starts").read_text().splitlines()) == 2
    finally:
        if service.poll() is None:
            service.kill()
            service.wait(10)
        if held and not released:
            import signal

            os.kill(held["pid"], signal.SIGKILL)
        assert service.stderr is not None
        service.stderr.close()
