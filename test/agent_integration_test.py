from __future__ import annotations
import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient
from main import app


@pytest.fixture
def mock_config():
    with patch("main.load_config") as mock:
        mock.return_value = (
            {
                "agent_by_alias": {
                    "gemini-cli": {"harness": "gemini-cli"},
                    "pi-agent": {"harness": "pi"},
                },
                "pi_agent_openai_base_url": "http://test-host:11435/v1",
                "pi_agent_openai_api_key": "test-sk-key",
            },
            "/test/config/dir",
        )
        yield mock


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_agent_switching(mock_exec, mock_config):
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    session_id = "test_agent_switch_session"

    with TestClient(app) as c:
        # Check current agent (default should be gemini-cli)
        response = c.post("/chat", json={"message": "!agent", "session_id": session_id})
        assert response.status_code == 200
        assert "Current agent: gemini-cli" in response.json()["reply"]

        # Switch agent
        response = c.post(
            "/chat",
            json={"message": "!agent pi-agent", "session_id": session_id},
        )
        assert response.status_code == 200
        assert "Agent switched to: pi-agent" in response.json()["reply"]

        # Verify next chat uses the new agent and has correct argument order
        # We also want to check that models.json is generated
        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

        # Verify the command invoked for pi-agent
        mock_exec.assert_called_once()
        cmd = mock_exec.call_args[0]

        # Proper order for pi-agent: [exe] [flags] -p [message]
        # Flags like --model, --session-dir, --system-prompt MUST come before -p
        cmd_list = list(cmd)
        p_index = cmd_list.index("-p")

        assert "--model" in cmd_list
        assert cmd_list.index("--model") < p_index

        assert "--session-dir" in cmd_list
        assert cmd_list.index("--session-dir") < p_index

        assert cmd_list[-1] == "hello"
        assert cmd_list[-2] == "-p"


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_pi_agent_env_vars(mock_exec, mock_config):
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    session_id = "test_pi_agent_env_session"

    with TestClient(app) as c:
        # Switch to pi-agent
        c.post("/chat", json={"message": "!agent pi-agent", "session_id": session_id})

        # Chat
        c.post("/chat", json={"message": "hello", "session_id": session_id})

    # Check env vars passed to subprocess
    env = mock_exec.call_args[1]["env"]
    assert "PI_CODING_AGENT_DIR" in env
    # API key is delivered via models.json, not env vars
    assert "OPENAI_API_KEY" not in env


@pytest.mark.asyncio
async def test_stat_gemini_cli_harness(mock_config):
    """!stat on gemini-cli harness should say it's pi-only."""
    session_id = "test_stat_gemini"

    with TestClient(app) as c:
        response = c.post(
            "/chat",
            json={"message": "!stat", "session_id": session_id},
        )
        assert response.status_code == 200
        assert "only available for the pi harness" in response.json()["reply"]


@pytest.mark.asyncio
async def test_stat_pi_no_data(mock_config):
    """!stat on pi-agent with no .pi-agent dir should say no data."""
    session_id = "test_stat_pi_no_data"

    with TestClient(app) as c:
        # Switch to pi-agent
        c.post(
            "/chat",
            json={"message": "!agent pi-agent", "session_id": session_id},
        )

        # Try stat without any chat history
        response = c.post(
            "/chat",
            json={"message": "!stat", "session_id": session_id},
        )
        assert response.status_code == 200
        assert "No pi-agent session data found" in response.json()["reply"]


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_stat_pi_with_data(mock_exec, mock_config, test_sessions_dir):
    """!stat on pi-agent with jsonl data should return stat output."""
    import os as _os

    session_id = "test_stat_pi_data"
    session_path = _os.path.join(test_sessions_dir, session_id)
    pi_agent_dir = _os.path.join(session_path, ".pi-agent")
    _os.makedirs(pi_agent_dir, exist_ok=True)

    # Mark session as pi-agent and create dummy jsonl
    _os.makedirs(session_path, exist_ok=True)
    with open(_os.path.join(session_path, ".agent_type"), "w") as f:
        f.write("pi-agent")
    with open(_os.path.join(pi_agent_dir, "test.jsonl"), "w") as f:
        f.write('{"type":"session","cwd":"/test"}\n')

    # Mock the stat subprocess (called by !stat, not the LLM)
    stat_process = AsyncMock()
    stat_process.returncode = 0
    stat_process.communicate.return_value = (
        b"Session: test.jsonl\nModel: auto\nContext Window: 128,000 tokens\n",
        b"",
    )

    # The first call to create_subprocess_exec is the stat script;
    # later calls would be the LLM but !stat returns early.
    mock_exec.return_value = stat_process

    with TestClient(app) as c:
        response = c.post(
            "/chat",
            json={"message": "!stat", "session_id": session_id},
        )
        assert response.status_code == 200
        reply = response.json()["reply"]
        assert "Session: test.jsonl" in reply
        assert "Context Window" in reply

    # Verify stat subprocess was called with correct args
    mock_exec.assert_called_once()
    cmd = mock_exec.call_args[0]
    assert cmd[0] == "python3"
    assert cmd[1].endswith("pi_session_stat.py")
    assert cmd[2].endswith("test.jsonl")
