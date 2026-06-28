"""Tests for default agent selection and agent_by_alias validation."""

from __future__ import annotations
import os
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
    """After a fresh session (no .agent_type file), !agent should report
    the *first* agent listed in agent_by_alias, not a hardcoded default."""
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    with TestClient(app) as c:
        # Create a fresh session (server generates the ID)
        create_resp = c.post("/sessions")
        assert create_resp.status_code == 200
        session_id = create_resp.json()["session_id"]

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


def test_create_session_with_valid_agent(mock_config_pi_first, test_sessions_dir):
    """POST /sessions?agent=<valid> should create the session,
    return its ID, and write the .agent_type file."""
    with TestClient(app) as c:
        response = c.post("/sessions?agent=gemini-cli")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "created"
        session_id = data["session_id"]
        assert session_id.startswith("session_")

    # Verify .agent_type was written with the correct agent
    session_path = os.path.join(test_sessions_dir, session_id)
    agent_file = os.path.join(session_path, ".agent_type")
    assert os.path.exists(agent_file)
    with open(agent_file) as f:
        assert f.read().strip() == "gemini-cli"


def test_create_session_with_invalid_agent_fails(mock_config_pi_first):
    """POST /sessions?agent=<bogus> should return 400."""
    with TestClient(app) as c:
        response = c.post("/sessions?agent=nonexistent-agent")
        assert response.status_code == 400
        detail = response.json()["detail"]
        assert "Invalid agent" in detail
        assert "nonexistent-agent" in detail


def test_create_session_with_pi_agent(mock_config_pi_first, test_sessions_dir):
    """POST /sessions?agent=pi-agent should work."""
    with TestClient(app) as c:
        response = c.post("/sessions?agent=pi-agent")
        assert response.status_code == 200
        session_id = response.json()["session_id"]

    session_path = os.path.join(test_sessions_dir, session_id)
    agent_file = os.path.join(session_path, ".agent_type")
    assert os.path.exists(agent_file)
    with open(agent_file) as f:
        assert f.read().strip() == "pi-agent"


def test_create_session_without_agent_no_agent_type(
    mock_config_pi_first, test_sessions_dir
):
    """POST /sessions without agent param should NOT create .agent_type."""
    with TestClient(app) as c:
        response = c.post("/sessions")
        assert response.status_code == 200
        session_id = response.json()["session_id"]

    session_path = os.path.join(test_sessions_dir, session_id)
    agent_file = os.path.join(session_path, ".agent_type")
    assert not os.path.exists(agent_file)


def test_new_session_returns_unique_ids(mock_config_pi_first, test_sessions_dir):
    """POST /sessions twice should return different session IDs."""
    with TestClient(app) as c:
        id1 = c.post("/sessions").json()["session_id"]
        id2 = c.post("/sessions").json()["session_id"]
    assert id1 != id2
    assert id1.startswith("session_")
    assert id2.startswith("session_")

    # Both should exist on disk
    assert os.path.isdir(os.path.join(test_sessions_dir, id1))
    assert os.path.isdir(os.path.join(test_sessions_dir, id2))


@pytest.fixture
def mock_config_pi_with_token_limits():
    """Config where pi-agent preset has custom token_ctx_limit and token_gen_limit."""
    with patch("main.load_config") as mock:
        mock.return_value = (
            {
                "agent_by_alias": {
                    "pi-big": {
                        "harness": "pi",
                        "model": "big-model",
                        "token_ctx_limit": 200000,
                        "token_gen_limit": 8192,
                    },
                },
                "pi_agent_openai_base_url": "http://test-host:11435/v1",
                "pi_agent_openai_api_key": "test-sk-key",
            },
            "/test/config/dir",
        )
        yield mock


@pytest.fixture
def mock_config_pi_default_limits():
    """Config where pi-agent preset has no token limits set (should use defaults)."""
    with patch("main.load_config") as mock:
        mock.return_value = (
            {
                "agent_by_alias": {
                    "pi-default": {
                        "harness": "pi",
                        "model": "auto",
                    },
                },
                "pi_agent_openai_base_url": "http://test-host:11435/v1",
                "pi_agent_openai_api_key": "test-sk-key",
            },
            "/test/config/dir",
        )
        yield mock


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_models_json_uses_custom_token_limits(
    mock_exec, mock_config_pi_with_token_limits, test_sessions_dir
):
    """models.json should use per-agent token_ctx_limit and token_gen_limit."""
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"ok", b"")
    mock_exec.return_value = mock_process

    import json

    with TestClient(app) as c:
        create_resp = c.post("/sessions?agent=pi-big")
        assert create_resp.status_code == 200
        session_id = create_resp.json()["session_id"]

        # Trigger chat to generate models.json
        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

    # Verify models.json has custom limits
    session_path = os.path.join(test_sessions_dir, session_id)
    models_path = os.path.join(session_path, ".pi", "agent", "models.json")
    assert os.path.exists(models_path)
    with open(models_path) as f:
        models = json.load(f)
    provider = models["providers"]["default-provider"]
    model = provider["models"][0]
    assert model["contextWindow"] == 200000
    assert model["maxTokens"] == 8192


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_models_json_uses_default_token_limits(
    mock_exec, mock_config_pi_default_limits, test_sessions_dir
):
    """models.json should default to 128000/16384 when token limits aren't configured."""
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"ok", b"")
    mock_exec.return_value = mock_process

    import json

    with TestClient(app) as c:
        create_resp = c.post("/sessions?agent=pi-default")
        assert create_resp.status_code == 200
        session_id = create_resp.json()["session_id"]

        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

    session_path = os.path.join(test_sessions_dir, session_id)
    models_path = os.path.join(session_path, ".pi", "agent", "models.json")
    assert os.path.exists(models_path)
    with open(models_path) as f:
        models = json.load(f)
    provider = models["providers"]["default-provider"]
    model = provider["models"][0]
    assert model["contextWindow"] == 128000
    assert model["maxTokens"] == 16384
