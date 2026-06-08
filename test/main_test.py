from __future__ import annotations
import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient
import os
import shutil
from main import app

client = TestClient(app)


def test_list_sessions_empty():
    response = client.get("/sessions")
    assert response.status_code == 200
    assert response.json() == {"sessions": []}


def test_create_session():
    response = client.post("/sessions")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "created"
    session_id = data["session_id"]
    assert session_id.startswith("session_")

    response = client.get("/sessions")
    assert response.status_code == 200
    assert session_id in response.json()["sessions"]


def test_delete_session():
    create_resp = client.post("/sessions")
    assert create_resp.status_code == 200
    session_id = create_resp.json()["session_id"]

    response = client.delete(f"/sessions/{session_id}")
    assert response.status_code == 200
    assert response.json() == {
        "status": "deleted",
        "session_id": session_id,
    }

    response = client.get("/sessions")
    assert response.status_code == 200
    assert session_id not in response.json()["sessions"]


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_chat_endpoint_invokes_gemini(mock_exec, test_sessions_dir):
    # Setup mock subprocess
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response from gemini", b"")
    mock_exec.return_value = mock_process

    preset_config_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "preset", "config.sxpb")
    )
    with patch.dict(os.environ, {"LIMILINK_CONFIG": preset_config_path}):
        # Use TestClient with 'with' block to ensure app startup/shutdown
        with TestClient(app) as c:
            response = c.post(
                "/chat",
                json={"message": "hello test", "session_id": "test_chat_session"},
            )

    assert response.status_code == 200
    assert response.json() == {"reply": "mocked response from gemini"}

    # Verify directory was created and marked as project root
    session_path = os.path.join(test_sessions_dir, "test_chat_session")
    assert os.path.exists(session_path)
    assert os.path.exists(os.path.join(session_path, ".project_root"))

    # Verify the exact command invoked
    mock_exec.assert_called_once()
    called_args = mock_exec.call_args[0]
    # Verify some key arguments
    assert called_args[0] == "gemini"
    assert "--model" in called_args
    # We expect auto as it's the default in the preset config
    assert "auto" in called_args
    assert "-p" in called_args
    assert "hello test" in called_args

    assert mock_exec.call_args[1]["cwd"] == session_path


def test_create_session_initialization(test_sessions_dir):
    # Use the preset config for testing
    preset_config_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "preset", "config.sxpb")
    )
    with patch.dict(os.environ, {"LIMILINK_CONFIG": preset_config_path}):
        response = client.post("/sessions")
        assert response.status_code == 200
        session_id = response.json()["session_id"]

        session_path = os.path.join(test_sessions_dir, session_id)
        assert os.path.exists(session_path)
        assert os.path.exists(os.path.join(session_path, ".initialized"))
        assert os.path.exists(os.path.join(session_path, ".project_root"))
        assert os.path.exists(os.path.join(session_path, "GEMINI.md"))

        # Check for the test_target.txt symlink
        test_target_link = os.path.join(session_path, "test_target.txt")
        assert os.path.islink(test_target_link)
        assert os.path.exists(test_target_link)
        with open(test_target_link, "r") as f:
            assert f.read().strip() == "This is a test target"


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_model_switching(mock_exec):
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    session_id = "test_model_session"

    with TestClient(app) as c:
        # Check current model (default)
        response = c.post("/chat", json={"message": "!model", "session_id": session_id})
        assert response.status_code == 200
        assert "Current model" in response.json()["reply"]

        # Switch model
        response = c.post(
            "/chat",
            json={"message": "!model gemini-3.5-ultra", "session_id": session_id},
        )
        assert response.status_code == 200
        assert "Model switched to: gemini-3.5-ultra" in response.json()["reply"]

        # Verify switching again
        response = c.post("/chat", json={"message": "!model", "session_id": session_id})
        assert response.json()["reply"] == "Current model: gemini-3.5-ultra"

        # Verify next chat uses the new model
        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

        # Check command
        mock_exec.assert_called_once()
        called_args = mock_exec.call_args[0]
        assert "--model" in called_args
        idx = list(called_args).index("--model")
        assert called_args[idx + 1] == "gemini-3.5-ultra"


@pytest.mark.asyncio
@patch("main.load_config")
@patch("main.asyncio.create_subprocess_exec")
async def test_model_switching_with_existing_model_arg(mock_exec, mock_load_config):
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    # Return a mocked config that already has --model
    mock_load_config.return_value = (
        {
            "agent_by_alias": {"gemini-cli": {"harness": "gemini-cli"}},
            "gemini_args": [
                "--approval-mode",
                "plan",
                "--model",
                "gemini-1.5-pro",
                "-p",
            ],
        },
        "/tmp",
    )

    session_id = "test_existing_model_arg_session"

    with TestClient(app) as c:
        # Switch model
        response = c.post(
            "/chat",
            json={"message": "!model gemini-3.5-ultra", "session_id": session_id},
        )
        assert response.status_code == 200

        # Verify next chat uses the new model
        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

        # Check command
        mock_exec.assert_called_once()
        called_args = mock_exec.call_args[0]
        assert "--model" in called_args
        idx = list(called_args).index("--model")
        assert called_args[idx + 1] == "gemini-3.5-ultra"
        # Make sure there is only one --model flag
        assert list(called_args).count("--model") == 1


@pytest.mark.asyncio
@patch("main.load_config")
@patch("main.asyncio.create_subprocess_exec")
async def test_resume_flag_injection(mock_exec, mock_load_config):
    # Setup mock config with gemini-cli as the agent (--resume is gemini-cli-specific)
    mock_load_config.return_value = (
        {
            "agent_by_alias": {"gemini-cli": {"harness": "gemini-cli"}},
        },
        "/test/config/dir",
    )

    # Setup mock subprocess
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    session_id = "test_resume_session"

    with TestClient(app) as c:
        # Send a message
        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

    # Verify the exact command invoked includes --resume latest
    mock_exec.assert_called_once()
    called_args = mock_exec.call_args[0]

    # Check that --resume latest is present
    assert "--resume" in called_args
    idx = list(called_args).index("--resume")
    assert called_args[idx + 1] == "latest"


@pytest.mark.asyncio
async def test_project_root_creation_on_chat(test_sessions_dir):
    session_id = "test_project_root_session"
    session_path = os.path.join(test_sessions_dir, session_id)

    # Ensure directory does not exist
    if os.path.exists(session_path):
        shutil.rmtree(session_path)

    with patch("main.asyncio.create_subprocess_exec") as mock_exec:
        mock_process = AsyncMock()
        mock_process.returncode = 0
        mock_process.communicate.return_value = (b"ok", b"")
        mock_exec.return_value = mock_process

        with TestClient(app) as c:
            response = c.post(
                "/chat", json={"message": "hello", "session_id": session_id}
            )
            assert response.status_code == 200

    # Verify directory and .project_root exist
    assert os.path.exists(session_path)
    assert os.path.exists(os.path.join(session_path, ".project_root"))


@pytest.mark.asyncio
@patch("main.load_config")
@patch("main.asyncio.create_subprocess_exec")
async def test_env_vars_injection(mock_exec, mock_load_config):
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    # Mock config with both gemini_env (list) and gemini_env_dict (dict)
    mock_load_config.return_value = (
        {
            "agent_by_alias": {"gemini-cli": {"harness": "gemini-cli"}},
            "gemini_env": [{"name": "VAR_LIST", "value": "val_list"}],
            "gemini_env_dict": {"VAR_DICT": "val_dict", "VAR_OVERRIDE": "new_val"},
            "gemini_args": ["-p"],
        },
        "/tmp",
    )

    # Also test override logic (if both specify same var)
    # The current implementation processes list then dict, so dict wins.

    session_id = "test_env_session"

    with TestClient(app) as c:
        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

    # Check command env
    mock_exec.assert_called_once()
    env = mock_exec.call_args[1]["env"]

    assert env["VAR_LIST"] == "val_list"
    assert env["VAR_DICT"] == "val_dict"
    assert env["VAR_OVERRIDE"] == "new_val"


@pytest.mark.asyncio
@patch("main.load_config")
@patch("main.asyncio.create_subprocess_exec")
async def test_env_vars_dict_only(mock_exec, mock_load_config):
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    mock_load_config.return_value = (
        {
            "agent_by_alias": {"gemini-cli": {"harness": "gemini-cli"}},
            "gemini_env_dict": {"MY_VAR": "my_val"},
        },
        "/tmp",
    )

    session_id = "test_env_dict_session"

    with TestClient(app) as c:
        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

    env = mock_exec.call_args[1]["env"]
    assert env["MY_VAR"] == "my_val"


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_env_command(mock_exec):
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    session_id = "test_env_command_session"

    with TestClient(app) as c:
        # Check an unset env var
        response = c.post(
            "/chat", json={"message": "!env SOME_TEST_VAR", "session_id": session_id}
        )
        assert response.status_code == 200
        assert "SOME_TEST_VAR is not set" in response.json()["reply"]

        # Set an env var
        response = c.post(
            "/chat",
            json={
                "message": "!env SOME_TEST_VAR test_value_123",
                "session_id": session_id,
            },
        )
        assert response.status_code == 200
        assert (
            "Environment variable SOME_TEST_VAR set to: test_value_123"
            in response.json()["reply"]
        )

        # Verify it is set
        response = c.post(
            "/chat", json={"message": "!env SOME_TEST_VAR", "session_id": session_id}
        )
        assert response.json()["reply"] == "SOME_TEST_VAR=test_value_123"

        # Verify next chat uses the new env var
        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

        # Check command
        mock_exec.assert_called_once()
        env = mock_exec.call_args[1]["env"]
        assert env.get("SOME_TEST_VAR") == "test_value_123"
