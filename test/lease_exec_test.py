"""Offline regressions for high-FD Pi lease handoff; no model/provider calls."""

import fcntl
import json
import os
import selectors
import shutil
import signal
import subprocess
import sys

import pytest

from session_lease import pi_lease_command, session_lease


def high_copy(fd):
    return fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 64)


@pytest.mark.parametrize("already_three", [False, True])
def test_exec_handoff_keeps_pid_stdio_env_cwd_and_same_description(
    tmp_path, already_three
):
    root = tmp_path / "sessions"
    report = """
import json, os, sys
fd = os.fstat(3)
old = int(sys.argv[1])
try:
    previous = os.fstat(old)
    old_is_lease = (previous.st_dev, previous.st_ino) == (fd.st_dev, fd.st_ino)
except OSError:
    old_is_lease = False
print(json.dumps(dict(pid=os.getpid(), pgid=os.getpgrp(), cwd=os.getcwd(),
    marker=os.environ.get('HANDOFF_TEST'), stdin=sys.stdin.buffer.read(1).decode(),
    dev=fd.st_dev, ino=fd.st_ino, old_is_lease=old_is_lease)))
"""
    with session_lease(root, "fixture") as fd:
        assert fd is not None
        high = high_copy(fd)
        try:
            original = os.fstat(high)
            command = [sys.executable, "-I", "-S", "-c", report, str(high)]
            if already_three:
                # The first fresh exec relocates; exercise the helper again with
                # FD 3 without replacing pytest's own descriptor table.
                command = pi_lease_command(command, 3)
            child = subprocess.Popen(
                pi_lease_command(command, high),
                pass_fds=(high,),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=tmp_path,
                env={**os.environ, "HANDOFF_TEST": "kept"},
                process_group=0,
            )
            out, err = child.communicate(b"x", timeout=10)
            assert child.returncode == 0, err
            data = json.loads(out)
            assert data == {
                "pid": child.pid,
                "pgid": child.pid,
                "cwd": str(tmp_path),
                "marker": "kept",
                "stdin": "x",
                "dev": original.st_dev,
                "ino": original.st_ino,
                "old_is_lease": False,
            }
        finally:
            os.close(high)


def test_handoff_exec_failure_exits_without_exposing_args_or_unlocking_parent(tmp_path):
    with session_lease(tmp_path, "fixture") as fd:
        assert fd is not None
        high = high_copy(fd)
        try:
            result = subprocess.run(
                pi_lease_command([str(tmp_path / "absent"), "PRIVATE_ARGUMENT"], high),
                pass_fds=(high,),
                capture_output=True,
                timeout=10,
            )
            assert result.returncode == 126
            assert b"PRIVATE_ARGUMENT" not in result.stderr
            with session_lease(tmp_path, "fixture", exclusive=True) as other:
                assert other is None, (
                    "Helper must never LOCK_UN the parent's description"
                )
        finally:
            os.close(high)
    with session_lease(tmp_path, "fixture", exclusive=True) as other:
        assert other is not None


def test_helper_ignores_project_python_startup_hooks(tmp_path):
    marker = tmp_path / "startup-ran"
    (tmp_path / "sitecustomize.py").write_text(
        f"open({str(marker)!r}, 'w').write('bad')"
    )
    with session_lease(tmp_path, "fixture") as fd:
        assert fd is not None
        high = high_copy(fd)
        try:
            result = subprocess.run(
                pi_lease_command(
                    [sys.executable, "-I", "-S", "-c", "print('isolated')"], high
                ),
                pass_fds=(high,),
                capture_output=True,
                timeout=10,
                cwd=tmp_path,
                env={**os.environ, "PYTHONPATH": str(tmp_path)},
            )
            assert result.returncode == 0 and result.stdout == b"isolated\n"
            assert not marker.exists()
        finally:
            os.close(high)


@pytest.mark.parametrize("bad_fd", ["0", "-1", "not-a-number", "99999"])
def test_invalid_lease_descriptor_fails_before_target(tmp_path, bad_fd):
    command = pi_lease_command(
        [sys.executable, "-I", "-S", "-c", "print('SHOULD_NOT_RUN')"], 3
    )
    command[4] = bad_fd
    result = subprocess.run(command, capture_output=True, timeout=10)
    assert result.returncode == 126 and b"SHOULD_NOT_RUN" not in result.stdout


def test_handoff_group_stop_preserves_lease_until_actual_agent_exit(tmp_path):
    child = None
    try:
        with session_lease(tmp_path, "fixture") as fd:
            assert fd is not None
            high = high_copy(fd)
            try:
                child = subprocess.Popen(
                    pi_lease_command(
                        [
                            sys.executable,
                            "-I",
                            "-S",
                            "-c",
                            "import sys;print('ready',flush=True);sys.stdin.buffer.read(1)",
                        ],
                        high,
                    ),
                    pass_fds=(high,),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    process_group=0,
                )
            finally:
                os.close(high)
            assert child.stdout is not None
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                assert selector.select(timeout=10)
                assert child.stdout.readline() == b"ready\n"
        with session_lease(tmp_path, "fixture", exclusive=True) as other:
            assert other is None, (
                "Actual agent must retain the lock after proxy copy closes"
            )
        os.killpg(child.pid, signal.SIGTERM)
        assert child.wait(timeout=10) == -signal.SIGTERM
        with session_lease(tmp_path, "fixture", exclusive=True) as other:
            assert other is not None
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=10)


def test_actual_offline_pi_high_fd_does_not_reach_descendants(tmp_path):
    pi = shutil.which("pi-agent")
    if not pi:
        pytest.skip("Requires the supported installed Node-based Pi launcher")
    session = tmp_path / "work"
    agent = tmp_path / "agent"
    session.mkdir()
    agent.mkdir()
    report_path = tmp_path / "probe.json"
    network = tmp_path / "network-attempts"
    guard = tmp_path / "no-network.mjs"
    guard.write_text(
        "import {Socket} from 'node:net';import{appendFileSync}from'node:fs';"
        f"const deny=()=>{{appendFileSync({json.dumps(str(network))},'blocked');throw new Error('Network forbidden');}};"
        "globalThis.fetch=deny;Socket.prototype.connect=deny;"
    )
    probe = tmp_path / "probe.mjs"
    probe.write_text(
        "import fs from 'node:fs';import {spawnSync} from 'node:child_process';"
        "export default function(pi){pi.on('session_start',()=>{"
        "const st=fs.fstatSync(3),flags=parseInt(fs.readFileSync('/proc/self/fdinfo/3','utf8').match(/^flags:\\s+(\\d+)/m)[1],8);"
        "const program=`const fs=require('fs'),{spawn}=require('child_process');let hasLease=false;"
        "for(const n of fs.readdirSync('/proc/self/fd')){try{const v=fs.fstatSync(+n);if(v.dev===${st.dev}&&v.ino===${st.ino})hasLease=true;}catch{}}"
        "const worker=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore'});worker.unref();"
        "console.log(JSON.stringify({hasLease,worker:worker.pid}));`;"
        "const result=spawnSync(process.execPath,['-e',program],{encoding:'utf8'});"
        "if(result.status!==0)throw new Error('Probe child failed');"
        f"fs.writeFileSync({json.dumps(str(report_path))},JSON.stringify({{pid:process.pid,dev:st.dev,ino:st.ino,cloexec:!!(flags&0o2000000),child:JSON.parse(result.stdout)}}),{{mode:0o600}});"
        "});}"
    )
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(tmp_path),
        "TMPDIR": str(tmp_path),
        "PI_CODING_AGENT_DIR": str(agent),
        "NODE_OPTIONS": f"--import={guard}",
        "NO_COLOR": "1",
    }
    child = None
    worker = None
    try:
        with session_lease(tmp_path, "fixture") as fd:
            assert fd is not None
            high = high_copy(fd)
            try:
                original = os.fstat(high)
                child = subprocess.Popen(
                    pi_lease_command(
                        [
                            pi,
                            "--offline",
                            "--mode",
                            "rpc",
                            "--no-session",
                            "--no-extensions",
                            "--no-skills",
                            "--no-mcp",
                            "--no-approve",
                            "--extension",
                            str(probe),
                        ],
                        high,
                    ),
                    cwd=session,
                    env=env,
                    pass_fds=(high,),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    process_group=0,
                )
            finally:
                os.close(high)
            assert child.stdin is not None and child.stdout is not None
            child.stdin.write(b'{"type":"get_state","id":"high-fd-probe"}\n')
            child.stdin.flush()
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                assert selector.select(timeout=20), "Offline Pi startup did not reply"
                response = json.loads(child.stdout.readline())
            assert response.get("id") == "high-fd-probe" and response.get("success"), (
                response
            )
            data = json.loads(report_path.read_text())
            worker = data["child"]["worker"]
            assert data["pid"] == child.pid
            assert (data["dev"], data["ino"]) == (original.st_dev, original.st_ino)
            assert data["cloexec"] is True, "Supported Node must protect relocated FD 3"
            assert data["child"]["hasLease"] is False, (
                "Tool-like shell/Node children must not retain the lease"
            )
        # Proxy dies/closes its own copies; real Pi must keep the original lock.
        with session_lease(tmp_path, "fixture", exclusive=True) as other:
            assert other is None
        child.stdin.close()
        assert child.wait(timeout=15) == 0
        os.kill(worker, 0)  # Deliberately detached descendant is still alive.
        with session_lease(tmp_path, "fixture", exclusive=True) as other:
            assert other is not None, "Detached work must not block Send after Pi exits"
        assert not network.exists(), (
            "This regression must make no network/provider calls"
        )
        assert (tmp_path / ".lease-fixture").is_file(), (
            "Never replace the stable lease inode"
        )
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=10)
        if worker is None and report_path.exists():
            worker = json.loads(report_path.read_text())["child"]["worker"]
        if worker is not None:
            try:
                os.killpg(worker, signal.SIGTERM)
            except ProcessLookupError:
                pass
