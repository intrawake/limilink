"""Inherited locks survive the proxy's close, without scanning other processes."""

import json
import os
import selectors
import shutil
import subprocess
import sys

import pytest

import session_layout as layout
from session_lease import session_lease


def test_child_lease_survives_parent_close_and_defers_expiry(tmp_path):
    root = tmp_path / "sessions"
    (root / "session_a").mkdir(parents=True)
    layout.queue_session_trash(root, "session_a", now=100)
    child = None
    try:
        with session_lease(root, "session_a") as fd:
            assert fd is not None
            child = subprocess.Popen(
                [sys.executable, "-c", "import sys; sys.stdin.buffer.read(1)"],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                pass_fds=(fd,),
            )
        # Proxy copy is closed. Only the child now retains the original lock.
        with session_lease(root, "session_a", exclusive=True) as exclusive:
            assert exclusive is None
        assert layout.expire_session_trash(root, lambda key: False, now=160) == []
        assert child.stdin is not None
        child.stdin.write(b"x")
        child.stdin.close()
        assert child.wait(timeout=10) == 0
        assert layout.expire_session_trash(root, lambda key: False, now=161) == [
            "session_a"
        ]
        assert layout.trash_deadline(root, "session_a") == 0
        assert (root / ".lease-session_a").is_file()  # Stable inode is retained.
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=10)


def test_lease_rejects_symlinks_and_nonregular_files(tmp_path):
    target = tmp_path / "target"
    target.write_text("keep")
    (tmp_path / ".lease-symlink").symlink_to(target)
    with pytest.raises(OSError), session_lease(tmp_path, "symlink"):
        pass
    os.mkfifo(tmp_path / ".lease-fifo")
    with pytest.raises(ValueError), session_lease(tmp_path, "fifo"):
        pass
    assert target.read_text() == "keep"


def test_actual_pi_wrapper_retains_inherited_lease_offline(tmp_path):
    pi = shutil.which("pi-agent")
    if not pi:
        pytest.skip("Requires the installed Pi wrapper")
    root = tmp_path / "sessions"
    session = root / "session_a"
    session.mkdir(parents=True)
    agent = tmp_path / "agent"
    agent.mkdir()
    env = os.environ.copy()
    env["PI_CODING_AGENT_DIR"] = str(agent)
    child = None
    try:
        with session_lease(root, "session_a") as fd:
            assert fd is not None
            child = subprocess.Popen(
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
                ],
                cwd=session,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                pass_fds=(fd,),
            )
            assert child.stdin is not None and child.stdout is not None
            child.stdin.write(b'{"type":"get_state","id":"lease-probe"}\n')
            child.stdin.flush()
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                assert selector.select(timeout=15), (
                    "Offline Pi did not answer get_state"
                )
                response = json.loads(child.stdout.readline())
            assert response.get("id") == "lease-probe", response
            assert response.get("success") is True, response
        with session_lease(root, "session_a", exclusive=True) as exclusive:
            assert exclusive is None, "Actual Pi launcher closed its inherited lease"
        child.stdin.close()
        assert child.wait(timeout=15) == 0
        with session_lease(root, "session_a", exclusive=True) as exclusive:
            assert exclusive is not None
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=10)
