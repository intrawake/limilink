from __future__ import annotations
import pytest
import json
import os
from unittest.mock import patch, AsyncMock, MagicMock
import httpx
from main import app, get_session_lock


PI_CONFIG = {
    "agent_by_alias": {
        "pi-test": {
            "harness": "pi",
            "model": "test-model",
        }
    },
    "pi_agent_exepath": "pi-agent",
}

GEMINI_CONFIG = {
    "agent_by_alias": {
        "gemini-test": {
            "harness": "gemini-cli",
            "model": "test-model",
        }
    },
}


def _make_rpc_process(response_data: dict | None = None):
    """Create a mock subprocess that emits a compact RPC response on stdout."""
    mock_process = AsyncMock()
    # stdin.write / close / kill are sync in production (real asyncio subprocess)
    mock_process.stdin = AsyncMock()
    mock_process.stdin.write = MagicMock()
    mock_process.stdin.close = MagicMock()
    mock_process.kill = MagicMock()

    if response_data is not None:
        line = json.dumps(response_data).encode() + b"\n"
    else:
        line = b""

    mock_process.stdout = AsyncMock()
    mock_process.stdout.readline = AsyncMock(side_effect=[line, b""])
    mock_process.stderr = AsyncMock()
    return mock_process


def _create_pi_session(test_sessions_dir: str, session_id: str):
    """Create a pi session with agent type and fake JSONL data."""
    session_path = os.path.join(test_sessions_dir, session_id)
    os.makedirs(session_path, exist_ok=True)
    with open(os.path.join(session_path, ".agent_type"), "w") as f:
        f.write("pi-test")
    pi_session_dir = os.path.join(session_path, ".pi", "agent", "session")
    os.makedirs(pi_session_dir, exist_ok=True)
    with open(os.path.join(pi_session_dir, "fake.jsonl"), "w") as f:
        f.write("{}\n")
    return session_path


@pytest.mark.asyncio
async def test_compact_rejects_non_pi_harness(test_sessions_dir):
    session_id = "test_compact_gemini"
    session_path = os.path.join(test_sessions_dir, session_id)
    os.makedirs(session_path, exist_ok=True)
    with open(os.path.join(session_path, ".agent_type"), "w") as f:
        f.write("gemini-test")

    with patch("main.load_config", return_value=(GEMINI_CONFIG, "/test")):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat", json={"message": "!compact", "session_id": session_id}
            )

    assert response.status_code == 200
    assert "only available for the pi harness" in response.json()["reply"]


@pytest.mark.asyncio
async def test_compact_no_session_data(test_sessions_dir):
    session_id = "test_compact_nodata"
    session_path = os.path.join(test_sessions_dir, session_id)
    os.makedirs(session_path, exist_ok=True)
    with open(os.path.join(session_path, ".agent_type"), "w") as f:
        f.write("pi-test")

    with patch("main.load_config", return_value=(PI_CONFIG, "/test")):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat", json={"message": "!compact", "session_id": session_id}
            )

    assert response.status_code == 200
    assert "No pi-agent session data found" in response.json()["reply"]


@pytest.mark.asyncio
async def test_compact_success(test_sessions_dir):
    session_id = "test_compact_ok"
    _create_pi_session(test_sessions_dir, session_id)

    rpc_response = {
        "type": "response",
        "command": "compact",
        "success": True,
        "data": {
            "summary": "## Goal\nTest summary",
            "firstKeptEntryId": "abc123",
            "tokensBefore": 150000,
            "estimatedTokensAfter": 32000,
        },
    }
    mock_process = _make_rpc_process(rpc_response)

    with (
        patch("main.load_config", return_value=(PI_CONFIG, "/test")),
        patch("main.asyncio.create_subprocess_exec", return_value=mock_process),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat", json={"message": "!compact", "session_id": session_id}
            )

    assert response.status_code == 200
    reply = response.json()["reply"]
    assert "150000" in reply
    assert "32000" in reply
    assert "Test summary" in reply

    # Verify RPC command sent
    written = mock_process.stdin.write.call_args[0][0]
    cmd = json.loads(written.decode())
    assert cmd["type"] == "compact"
    assert "customInstructions" not in cmd


@pytest.mark.asyncio
async def test_compact_with_custom_instructions(test_sessions_dir):
    session_id = "test_compact_custom"
    _create_pi_session(test_sessions_dir, session_id)

    rpc_response = {
        "type": "response",
        "command": "compact",
        "success": True,
        "data": {
            "summary": "Focused summary",
            "tokensBefore": 80000,
            "estimatedTokensAfter": 20000,
        },
    }
    mock_process = _make_rpc_process(rpc_response)

    with (
        patch("main.load_config", return_value=(PI_CONFIG, "/test")),
        patch("main.asyncio.create_subprocess_exec", return_value=mock_process),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat",
                json={
                    "message": "!compact focus on code changes",
                    "session_id": session_id,
                },
            )

    assert response.status_code == 200
    written = mock_process.stdin.write.call_args[0][0]
    cmd = json.loads(written.decode())
    assert cmd["type"] == "compact"
    assert cmd["customInstructions"] == "focus on code changes"


@pytest.mark.asyncio
async def test_compact_failure_response(test_sessions_dir):
    session_id = "test_compact_fail"
    _create_pi_session(test_sessions_dir, session_id)

    rpc_response = {
        "type": "response",
        "command": "compact",
        "success": False,
        "error": "API quota exceeded",
    }
    mock_process = _make_rpc_process(rpc_response)

    with (
        patch("main.load_config", return_value=(PI_CONFIG, "/test")),
        patch("main.asyncio.create_subprocess_exec", return_value=mock_process),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat", json={"message": "!compact", "session_id": session_id}
            )

    assert response.status_code == 200
    assert "Compaction failed" in response.json()["reply"]
    assert "API quota exceeded" in response.json()["reply"]


@pytest.mark.asyncio
async def test_compact_no_response(test_sessions_dir):
    session_id = "test_compact_noresp"
    _create_pi_session(test_sessions_dir, session_id)

    # stdout closes immediately with no data
    mock_process = _make_rpc_process(None)

    with (
        patch("main.load_config", return_value=(PI_CONFIG, "/test")),
        patch("main.asyncio.create_subprocess_exec", return_value=mock_process),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat", json={"message": "!compact", "session_id": session_id}
            )

    assert response.status_code == 200
    assert "produced no response" in response.json()["reply"]


@pytest.mark.asyncio
async def test_compact_session_busy(test_sessions_dir):
    session_id = "test_compact_busy"
    _create_pi_session(test_sessions_dir, session_id)

    # Acquire the lock to simulate a busy session
    lock = get_session_lock(session_id)
    await lock.acquire()
    try:
        with patch("main.load_config", return_value=(PI_CONFIG, "/test")):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://test"
            ) as ac:
                response = await ac.post(
                    "/chat", json={"message": "!compact", "session_id": session_id}
                )

        assert response.status_code == 200
        assert "busy" in response.json()["reply"]
    finally:
        lock.release()


@pytest.mark.asyncio
async def test_compact_rpc_args(test_sessions_dir):
    """Verify the RPC subprocess receives correct pi-agent arguments."""
    session_id = "test_compact_args"
    _create_pi_session(test_sessions_dir, session_id)

    rpc_response = {
        "type": "response",
        "command": "compact",
        "success": True,
        "data": {"summary": "ok", "tokensBefore": 100, "estimatedTokensAfter": 50},
    }
    mock_process = _make_rpc_process(rpc_response)

    config = {
        "agent_by_alias": {
            "pi-test": {
                "harness": "pi",
                "model": "test-model",
                "provider": "openai-codex",
                "reasoning_effort": "high",
            }
        },
        "pi_agent_exepath": "pi-agent",
    }

    with (
        patch("main.load_config", return_value=(config, "/test")),
        patch(
            "main.asyncio.create_subprocess_exec", return_value=mock_process
        ) as mock_exec,
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat", json={"message": "!compact", "session_id": session_id}
            )

    assert response.status_code == 200
    called_args = mock_exec.call_args[0]
    assert called_args[0] == "pi-agent"
    assert "--mode" in called_args
    assert "rpc" in called_args
    assert "--continue" in called_args
    assert "--approve" in called_args
    provider_idx = list(called_args).index("--provider")
    assert called_args[provider_idx + 1] == "openai-codex"
    thinking_idx = list(called_args).index("--thinking")
    assert called_args[thinking_idx + 1] == "high"
