"""Tests for default agent selection and agent_by_alias validation."""

from __future__ import annotations
import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient
from main import app


@pytest.fixture
def mock_config_pi_first():
    """Config where pi-agent is the first agent in agent_by_alias."""
    with patch("main.load_config") as mock:
        mock.return_value = (
            {
                "agent_by_alias": {
                    "pi-agent": {
                        "harness": "pi",
                        "model": "auto",
                    },
                    "gemini-cli": {
                        "harness": "gemini-cli",
                    },
                },
                "pi_agent_openai_base_url": "http://test-host:11435/v1",
                "pi_agent_openai_api_key": "test-sk-key",
            },
            "/test/config/dir",
        )
        yield mock


@pytest.fixture
def mock_config_missing_agent_by_alias():
    """Config with no agent_by_alias key at all."""
    with patch("main.load_config") as mock:
        mock.return_value = (
            {
                # agent_by_alias intentionally missing
            },
            "/test/config/dir",
        )
        yield mock


@pytest.fixture
def mock_config_empty_agent_by_alias():
    """Config with an empty agent_by_alias dict."""
    with patch("main.load_config") as mock:
        mock.return_value = (
            {
                "agent_by_alias": {},
            },
            "/test/config/dir",
        )
        yield mock


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_default_agent_is_first_in_agent_by_alias(
    mock_exec, mock_config_pi_first
):
    """After !new session (no .agent_type file), !agent should report
    the *first* agent listed in agent_by_alias, not a hardcoded default."""
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    session_id = "test_default_agent_first"

    with TestClient(app) as c:
        # Create a fresh session (equivalent to !new)
        create_resp = c.post(f"/sessions/{session_id}")
        assert create_resp.status_code == 200

        # Ask for the current agent — should be first in agent_by_alias
        response = c.post(
            "/chat",
            json={"message": "!agent", "session_id": session_id},
        )
        assert response.status_code == 200
        # pi-agent is the first key in the mocked config
        assert response.json()["reply"] == "Current agent: pi-agent"


@pytest.mark.asyncio
async def test_chat_fails_when_agent_by_alias_missing(
    mock_config_missing_agent_by_alias,
):
    """Calling /chat should return 500 when agent_by_alias is not defined
    at all in config.sxpb."""
    session_id = "test_missing_agent_by_alias"

    with TestClient(app) as c:
        response = c.post(
            "/chat",
            json={"message": "hello", "session_id": session_id},
        )
        assert response.status_code == 500
        detail = response.json()["detail"]
        assert "agent_by_alias" in detail.lower()


@pytest.mark.asyncio
async def test_chat_fails_when_agent_by_alias_empty(
    mock_config_empty_agent_by_alias,
):
    """Calling /chat should return 500 when agent_by_alias is defined
    but contains zero entries."""
    session_id = "test_empty_agent_by_alias"

    with TestClient(app) as c:
        response = c.post(
            "/chat",
            json={"message": "hello", "session_id": session_id},
        )
        assert response.status_code == 500
        detail = response.json()["detail"]
        assert "agent_by_alias" in detail.lower()
