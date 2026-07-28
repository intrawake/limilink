"""Tests for default agent selection and agent_by_alias validation."""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import aiofiles

import pytest
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


def test_create_session_without_agent_persists_default(
    mock_config_pi_first, test_sessions_dir
):
    """POST /sessions resolves and persists the first configured agent."""
    with TestClient(app) as c:
        response = c.post("/sessions")
        assert response.status_code == 200
        session_id = response.json()["session_id"]

    session_path = os.path.join(test_sessions_dir, session_id)
    agent_file = os.path.join(session_path, ".agent_type")
    assert os.path.exists(agent_file)
    with open(agent_file) as f:
        assert f.read().strip() == "pi-agent"


def test_default_agent_resources_exist_before_first_chat(tmp_path, test_sessions_dir):
    """An implicit default agent gets its auth link during session creation."""
    auth_path = tmp_path / "deepseek-auth.json"
    auth_path.write_text("{}")
    config = {
        "agent_by_alias": {
            "pi-auth": {
                "harness": "pi",
                "model": "deepseek-v4-flash",
                "provider": "deepseek",
                "session_symlink_dict": {
                    ".pi/agent/auth.json": str(auth_path),
                },
            },
        },
    }

    with (
        patch("main.load_config", return_value=(config, str(tmp_path))),
        TestClient(app) as c,
    ):
        response = c.post("/sessions")

    assert response.status_code == 200
    session_path = os.path.join(test_sessions_dir, response.json()["session_id"])
    auth_link = os.path.join(session_path, ".pi", "agent", "auth.json")
    assert os.path.islink(auth_link)
    assert os.path.realpath(auth_link) == str(auth_path)


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
    """Config where pi-agent preset has no token limits set (unknown provider)."""
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


@pytest.fixture
def mock_config_pi_named_provider_no_limits():
    """Config where pi-agent preset uses a named provider without token limits."""
    with patch("main.load_config") as mock:
        mock.return_value = (
            {
                "agent_by_alias": {
                    "pi-ds": {
                        "harness": "pi",
                        "model": "deepseek-v4-pro",
                        "provider": "deepseek",
                    },
                },
                "pi_agent_openai_base_url": "http://test-host:11435/v1",
                "pi_agent_openai_api_key": "test-sk-key",
            },
            "/test/config/dir",
        )
        yield mock


@pytest.fixture
def mock_config_pi_named_provider_with_limits():
    """Config where pi-agent preset uses a named provider with explicit token limits."""
    with patch("main.load_config") as mock:
        mock.return_value = (
            {
                "agent_by_alias": {
                    "pi-oai": {
                        "harness": "pi",
                        "model": "gpt-5.6-sol",
                        "provider": "openai-codex",
                        "token_ctx_limit": 333000,
                        "token_gen_limit": 7777,
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
    async with aiofiles.open(models_path) as f:
        models = json.loads(await f.read())
    provider = models["providers"]["default-provider"]
    model = provider["models"][0]
    assert model["contextWindow"] == 200000
    assert model["maxTokens"] == 8192


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_models_json_omits_limits_for_unknown_provider(
    mock_exec, mock_config_pi_default_limits, test_sessions_dir
):
    """models.json should write model entry without limits when not configured."""
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
    async with aiofiles.open(models_path) as f:
        models = json.loads(await f.read())
    provider = models["providers"]["default-provider"]
    model = provider["models"][0]
    assert model["id"] == "auto"
    assert "contextWindow" not in model
    assert "maxTokens" not in model


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_models_json_named_provider_no_models_array(
    mock_exec, mock_config_pi_named_provider_no_limits, test_sessions_dir
):
    """Named provider without limits should omit the models array entirely."""
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"ok", b"")
    mock_exec.return_value = mock_process

    import json

    with TestClient(app) as c:
        create_resp = c.post("/sessions?agent=pi-ds")
        assert create_resp.status_code == 200
        session_id = create_resp.json()["session_id"]

        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

    session_path = os.path.join(test_sessions_dir, session_id)
    models_path = os.path.join(session_path, ".pi", "agent", "models.json")
    assert os.path.exists(models_path)
    async with aiofiles.open(models_path) as f:
        models = json.loads(await f.read())
    provider = models["providers"]["deepseek"]
    assert "models" not in provider
    assert provider["baseUrl"] == "http://test-host:11435/v1"


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_models_json_named_provider_with_explicit_limits(
    mock_exec, mock_config_pi_named_provider_with_limits, test_sessions_dir
):
    """Named provider with explicit limits should write model entry with overrides."""
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"ok", b"")
    mock_exec.return_value = mock_process

    import json

    with TestClient(app) as c:
        create_resp = c.post("/sessions?agent=pi-oai")
        assert create_resp.status_code == 200
        session_id = create_resp.json()["session_id"]

        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

    session_path = os.path.join(test_sessions_dir, session_id)
    models_path = os.path.join(session_path, ".pi", "agent", "models.json")
    assert os.path.exists(models_path)
    async with aiofiles.open(models_path) as f:
        models = json.loads(await f.read())
    provider = models["providers"]["openai-codex"]
    model = provider["models"][0]
    assert model["id"] == "gpt-5.6-sol"
    assert model["contextWindow"] == 333000
    assert model["maxTokens"] == 7777
