"""Real local RPC fixtures through the lease launcher; never call providers."""

import asyncio
import json
import os
import signal
import sys
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

import compact_rpc as rpc
from main import app
from session_lease import session_lease

RESPONSE = {
    "type": "response",
    "command": "compact",
    "success": True,
    "data": {"summary": "saved", "tokensBefore": 200, "estimatedTokensAfter": 50},
}


@pytest_asyncio.fixture
async def children(monkeypatch):
    """Record real ownership and rescue fixtures on failure, never other agents."""
    processes = []
    pipes = []
    real_spawn = asyncio.create_subprocess_exec
    loop = asyncio.get_running_loop()
    real_pipe = loop.connect_read_pipe

    async def spawn(*args, **kwargs):
        process = await real_spawn(*args, **kwargs)
        processes.append(process)
        return process

    async def connect(*args, **kwargs):
        result = await real_pipe(*args, **kwargs)
        pipes.append(result[0])
        return result

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(loop, "connect_read_pipe", connect)
    yield processes
    leaked = [process for process in processes if process.returncode is None]
    unclosed = [pipe for pipe in pipes if not pipe.is_closing()]
    for pipe in pipes:
        pipe.close()
    for process in processes:
        if process.stdin and not process.stdin.transport.is_closing():
            process.stdin.transport.abort()
        if process.returncode is None:
            process.kill()
        async with asyncio.timeout(3):
            # Bypass any test-local wait fault injection, using the public method.
            await asyncio.subprocess.Process.wait(process)
    assert not leaked, "RPC helper left an owned process running"
    assert not unclosed, "RPC helper left its local stdout transport open"


async def invoke(tmp_path, body, **options):
    command = [sys.executable, "-I", "-S", "-c", body]
    try:
        with session_lease(tmp_path, "fixture") as fd:
            assert fd is not None
            try:
                return await rpc.compact_rpc(
                    command, lease_fd=fd, cwd=str(tmp_path), env={}, **options
                )
            finally:
                with session_lease(tmp_path, "fixture", exclusive=True) as exclusive:
                    assert exclusive is None, (
                        "Child cleanup unlocked the parent's lease"
                    )
    finally:
        with session_lease(tmp_path, "fixture", exclusive=True) as exclusive:
            assert exclusive is not None, "Child retained the lease after cleanup"


def emit(response=RESPONSE, before="", after=""):
    return (
        "import json,os,sys,time\njson.loads(sys.stdin.readline())\n"
        + before
        + f"\nos.write(1, {json.dumps(response).encode()!r} + b'\\n')\n"
        + after
    )


@pytest.mark.asyncio
async def test_large_fragmented_response_and_stderr_pressure(tmp_path, children):
    body = r"""
import json,os,sys,time
request=json.loads(sys.stdin.readline())
assert request['customInstructions'] == 'keep the contract'
os.write(2, b'PRIVATE_STDERR' * 200000)
response=dict(type='response',command='compact',success=True,
    data=dict(summary='x' * 250000,tokensBefore=300000,estimatedTokensAfter=60000))
wire=(json.dumps(response)+'\n').encode()
for start in range(0,len(wire),3000): os.write(1,wire[start:start+3000])
time.sleep(60)
"""
    result = await invoke(tmp_path, body, instructions="keep the contract")
    assert result is not None and len(result["data"]["summary"]) == 250000
    assert len(children) == 1 and children[0].returncode is not None
    assert children[0].stdout is None and children[0].stderr is None
    assert children[0].stdin.transport.is_closing()


@pytest.mark.asyncio
@pytest.mark.parametrize("terminated", [False, True])
async def test_oversized_line_is_bounded_and_reaped(tmp_path, children, terminated):
    body = "import os,sys,time\nsys.stdin.readline()\nos.write(1,b'x'*10000"
    body += "+b'\\n')" if terminated else ")"
    body += "\ntime.sleep(60)\n"
    with pytest.raises(rpc.CompactRPCError, match="size limit"):
        await invoke(tmp_path, body, max_line_bytes=4096)
    assert children[0].returncode is not None


@pytest.mark.asyncio
async def test_cumulative_output_limit(tmp_path, children):
    body = "import os,sys,time\nsys.stdin.readline()\nos.write(1,b'{}\\n'*10000)\ntime.sleep(60)"
    with pytest.raises(rpc.CompactRPCError, match="size limit"):
        await invoke(tmp_path, body, max_output_bytes=4096)


@pytest.mark.asyncio
async def test_silent_timeout_and_input_backpressure(tmp_path, children):
    for instructions in [None, "x" * 1000000]:
        # The second command cannot drain because this fixture never reads stdin.
        with pytest.raises(rpc.CompactRPCError, match="timed out"):
            await invoke(
                tmp_path,
                "import time; time.sleep(60)",
                instructions=instructions,
                timeout=0.2,
            )
    assert len(children) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("stdout", [b"", b"noise\n[]\n{bad json}\n", b"\xff\n"])
async def test_missing_and_non_json_output(tmp_path, children, stdout):
    assert (
        await invoke(
            tmp_path, f"import os,sys;sys.stdin.readline();os.write(1,{stdout!r})"
        )
        is None
    )


@pytest.mark.asyncio
async def test_final_line_without_newline_and_rpc_failure(tmp_path, children):
    response = {
        "type": "response",
        "command": "compact",
        "success": False,
        "error": "Quota reached",
    }
    body = (
        "import os,sys;sys.stdin.readline();os.write(1,"
        + repr(json.dumps(response).encode())
        + ")"
    )
    assert await invoke(tmp_path, body) == response


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data", [{"summary": 12}, {"summary": "ok", "tokensBefore": -1}, []]
)
async def test_invalid_matching_response(tmp_path, children, data):
    with pytest.raises(rpc.CompactRPCError, match="invalid response"):
        await invoke(tmp_path, emit({**RESPONSE, "data": data}, after="time.sleep(60)"))


@pytest.mark.asyncio
async def test_spawn_failure_is_generic_and_closes_pipe(tmp_path, children):
    with session_lease(tmp_path, "fixture") as fd:
        with pytest.raises(rpc.CompactRPCError) as failure:
            await rpc.compact_rpc(
                [str(tmp_path / "not-an-executable")],
                lease_fd=fd,
                cwd=str(tmp_path / "PRIVATE_MISSING_DIRECTORY"),
                env={},
            )
    assert str(failure.value) == "Compaction could not complete."
    assert not children


@pytest.mark.asyncio
async def test_stdin_failure_is_generic_and_reaped(tmp_path, children, monkeypatch):
    real_spawn = asyncio.create_subprocess_exec

    async def spawn(*args, **kwargs):
        process = await real_spawn(*args, **kwargs)

        def broken(_):
            raise BrokenPipeError("PRIVATE_STDIN_DETAIL")

        monkeypatch.setattr(process.stdin, "write", broken)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    with pytest.raises(rpc.CompactRPCError, match="could not complete"):
        await invoke(tmp_path, "import time;time.sleep(60)")


@pytest.mark.asyncio
async def test_cancel_during_reading_releases_owned_lease(
    tmp_path, children, monkeypatch
):
    real_read = rpc._read_response
    reading = asyncio.Event()

    async def read(*args, **kwargs):
        reading.set()
        return await real_read(*args, **kwargs)

    monkeypatch.setattr(rpc, "_read_response", read)
    task = asyncio.create_task(
        invoke(tmp_path, "import sys,time;sys.stdin.readline();time.sleep(60)")
    )
    await asyncio.wait_for(reading.wait(), 3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert children[0].returncode is not None
    with session_lease(tmp_path, "fixture", exclusive=True) as fd:
        assert fd is not None


@pytest.mark.asyncio
async def test_cancel_during_acquisition_keeps_future_child_owned(
    tmp_path, children, monkeypatch
):
    real_spawn = asyncio.create_subprocess_exec
    acquired, release = asyncio.Event(), asyncio.Event()

    async def delayed(*args, **kwargs):
        process = await real_spawn(*args, **kwargs)
        acquired.set()
        await release.wait()
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", delayed)
    task = asyncio.create_task(
        invoke(tmp_path, "import sys,time;sys.stdin.readline();time.sleep(60)")
    )
    await asyncio.wait_for(acquired.wait(), 3)
    task.cancel()
    await asyncio.sleep(0)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done() and children[0].returncode is None
    with session_lease(tmp_path, "fixture", exclusive=True) as fd:
        assert fd is None
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert children[0].returncode is not None
    with session_lease(tmp_path, "fixture", exclusive=True) as fd:
        assert fd is not None


@pytest.mark.asyncio
async def test_repeated_cancellation_during_cleanup(tmp_path, children, monkeypatch):
    real_spawn = asyncio.create_subprocess_exec
    reaping, release = asyncio.Event(), asyncio.Event()

    async def spawn(*args, **kwargs):
        process = await real_spawn(*args, **kwargs)
        wait = process.wait

        async def delayed_wait():
            reaping.set()
            await release.wait()
            return await wait()

        monkeypatch.setattr(process, "wait", delayed_wait)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    task = asyncio.create_task(invoke(tmp_path, emit(after="time.sleep(60)")))
    await asyncio.wait_for(reaping.wait(), 3)
    for _ in range(3):
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert children[0].returncode is not None


@pytest.mark.asyncio
async def test_cleanup_deadline_is_not_reported_as_success(
    tmp_path, children, monkeypatch, caplog
):
    real_spawn = asyncio.create_subprocess_exec

    async def spawn(*args, **kwargs):
        process = await real_spawn(*args, **kwargs)

        async def stalled_wait():
            await asyncio.Event().wait()

        monkeypatch.setattr(process, "wait", stalled_wait)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    with pytest.raises(rpc.CompactRPCError, match="cleanup could not be confirmed"):
        await invoke(tmp_path, emit(after="time.sleep(60)"), cleanup_timeout=0.05)
    assert "cleanup unconfirmed" in caplog.text


@pytest.mark.asyncio
async def test_descendant_holding_stdout_does_not_hold_cleanup(tmp_path, children):
    marker = tmp_path / "output-holder.json"
    body = """
import json,os,subprocess,sys,time
sys.stdin.readline()
os.set_inheritable(3,False)
child=subprocess.Popen([sys.executable,'-I','-S','-c','import time;time.sleep(60)','compact-output-holder'],
    stdin=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True,start_new_session=True)
with open(MARKER,'w') as f: json.dump([child.pid,open('/proc/'+str(child.pid)+'/stat').read().split()[21]],f)
os.write(1,RESPONSE)
""".replace("MARKER", repr(str(marker))).replace(
        "RESPONSE", repr(json.dumps(RESPONSE).encode() + b"\n")
    )
    holder = None
    try:
        async with asyncio.timeout(3):
            result = await invoke(tmp_path, body)
        holder, start = json.loads(marker.read_text())
        assert result == RESPONSE and children[0].returncode is not None
        assert Path(f"/proc/{holder}/stat").read_text().split()[21] == start
        os.kill(holder, 0)  # Helper must not signal its descendant.
    finally:
        if marker.exists():
            holder, start = json.loads(marker.read_text())
            stat = Path(f"/proc/{holder}/stat")
            if stat.exists() and stat.read_text().split()[21] == start:
                os.kill(
                    holder, signal.SIGTERM
                )  # Owned fixture only, after identity check.


@pytest.mark.asyncio
async def test_route_large_compact_response_and_saved_receipt(
    tmp_path, test_sessions_dir, children, monkeypatch
):
    sid = "compact_large_fixture"
    owner = Path(test_sessions_dir) / sid
    (owner / ".pi/agent/session").mkdir(parents=True)
    (owner / ".agent_type").write_text("pi-fixture")
    (owner / ".pi/agent/session/fixture.jsonl").write_text("{}\n")
    executable = tmp_path / "fake-pi"
    base_data = RESPONSE["data"]
    assert isinstance(base_data, dict)
    response = {**RESPONSE, "data": {**base_data, "summary": "x" * 250000}}
    executable.write_text(
        f"#!{sys.executable}\n" + emit(response, after="time.sleep(60)")
    )
    executable.chmod(0o700)
    monkeypatch.setattr(
        "main.load_config",
        lambda: (
            {
                "agent_by_alias": {"pi-fixture": {"harness": "pi", "model": "fixture"}},
                "pi_agent_exepath": str(executable),
            },
            "/fixture",
        ),
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        result = await client.post(
            "/chat",
            json={"session_id": sid, "message": "!compact", "request_id": "a" * 32},
        )
        assert result.status_code == 200
        reply = result.json()["reply"]
        assert reply.startswith("✅ Compacted: 200 → ~50 tokens") and len(reply) < 600
        snapshot = (
            await client.get(f"/sessions/{sid}/snapshot?request_id={'a' * 32}")
        ).json()
        assert snapshot["busy"] is False
        assert snapshot["send"]["state"] == "complete"
        assert snapshot["send"]["outcome"]["body"]["reply"] == reply
    with session_lease(Path(test_sessions_dir), sid, exclusive=True) as fd:
        assert fd is not None
