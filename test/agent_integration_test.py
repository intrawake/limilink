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
    assert "OPENAI_API_KEY" in env
    assert env["OPENAI_API_KEY"] == "test-sk-key"
