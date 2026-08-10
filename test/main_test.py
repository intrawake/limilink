from __future__ import annotations

import aiofiles
import os
import shutil
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app, ensure_session_initialized, reconcile_session_symlinks

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
    with (
        patch.dict(os.environ, {"LIMILINK_CONFIG": preset_config_path}),
        TestClient(app) as c,
    ):
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


def test_initialization_reconciles_symlinks_only_once(tmp_path):
    session_path = tmp_path / "session"
    session_path.mkdir()
    config = {"agent_by_alias": {"pi-test": {"harness": "pi"}}}

    with patch("main.reconcile_session_symlinks") as mock_reconcile:
        ensure_session_initialized(
            str(session_path), config, str(tmp_path), agent_alias="pi-test"
        )
        ensure_session_initialized(
            str(session_path), config, str(tmp_path), agent_alias="pi-test"
        )

    mock_reconcile.assert_called_once_with(
        str(session_path), config, str(tmp_path), "pi-test"
    )


def _managed_auth_config(first_auth, second_auth):
    return {
        "agent_by_alias": {
            "pi-first": {
                "session_symlink_dict": {".pi/agent/auth.json": str(first_auth)}
            },
            "pi-second": {
                "session_symlink_dict": {".pi/agent/auth.json": str(second_auth)}
            },
        }
    }


def test_reconcile_overwrites_regular_managed_resource(tmp_path):
    first_auth = tmp_path / "first-auth.json"
    second_auth = tmp_path / "second-auth.json"
    first_auth.write_text('{"first": true}')
    second_auth.write_text('{"second": true}')
    session_path = tmp_path / "session"
    auth_path = session_path / ".pi" / "agent" / "auth.json"
    auth_path.parent.mkdir(parents=True)
    auth_path.write_text("{}")

    reconcile_session_symlinks(
        str(session_path),
        _managed_auth_config(first_auth, second_auth),
        str(tmp_path),
        "pi-second",
    )

    assert auth_path.is_symlink()
    assert os.path.realpath(auth_path) == str(second_auth)


def test_reconcile_replaces_managed_symlink(tmp_path):
    first_auth = tmp_path / "first-auth.json"
    second_auth = tmp_path / "second-auth.json"
    first_auth.write_text("{}")
    second_auth.write_text("{}")
    session_path = tmp_path / "session"
    auth_path = session_path / ".pi" / "agent" / "auth.json"
    auth_path.parent.mkdir(parents=True)
    auth_path.symlink_to(first_auth)

    reconcile_session_symlinks(
        str(session_path),
        _managed_auth_config(first_auth, second_auth),
        str(tmp_path),
        "pi-second",
    )

    assert auth_path.is_symlink()
    assert os.path.realpath(auth_path) == str(second_auth)


def test_reconcile_preserves_unmanaged_symlink(tmp_path, capsys):
    first_auth = tmp_path / "first-auth.json"
    second_auth = tmp_path / "second-auth.json"
    unmanaged_auth = tmp_path / "unmanaged-auth.json"
    first_auth.write_text("{}")
    second_auth.write_text("{}")
    unmanaged_auth.write_text("{}")
    session_path = tmp_path / "session"
    auth_path = session_path / ".pi" / "agent" / "auth.json"
    auth_path.parent.mkdir(parents=True)
    auth_path.symlink_to(unmanaged_auth)

    reconcile_session_symlinks(
        str(session_path),
        _managed_auth_config(first_auth, second_auth),
        str(tmp_path),
        "pi-second",
    )

    assert auth_path.is_symlink()
    assert os.path.realpath(auth_path) == str(unmanaged_auth)
    assert "Refusing to replace unmanaged symlink" in capsys.readouterr().out


def test_create_session_with_agent_symlinks(test_sessions_dir):
    """Creating a session with an agent applies both global and agent-specific
    session_symlink_dict entries."""
    preset_config_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "preset", "config.sxpb")
    )
    with patch.dict(os.environ, {"LIMILINK_CONFIG": preset_config_path}):
        response = client.post("/sessions?agent=gemini-cli")
        assert response.status_code == 200
        session_id = response.json()["session_id"]

        session_path = os.path.join(test_sessions_dir, session_id)

        # Global symlinks present
        global_link = os.path.join(session_path, "test_target.txt")
        assert os.path.islink(global_link)
        assert os.path.exists(global_link)

        # Agent-specific symlink present
        agent_link = os.path.join(session_path, "agent_specific_link.txt")
        assert os.path.islink(agent_link)
        assert os.path.exists(agent_link)
        with open(agent_link, "r") as f:
            assert f.read().strip() == "This is an agent-specific test target"


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

    # Return a mocked config that already has --model in preset args
    mock_load_config.return_value = (
        {
            "agent_by_alias": {
                "gemini-cli": {
                    "harness": "gemini-cli",
                    "args": ["--model", "gemini-1.5-pro"],
                }
            },
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
@patch("main.load_config")
@patch("main.asyncio.create_subprocess_exec")
async def test_pi_harness_passes_approve(mock_exec, mock_load_config):
    """Pi sessions should use the configured provider and trust generated .pi resources."""
    mock_load_config.return_value = (
        {
            "agent_by_alias": {
                "pi-gpt": {
                    "harness": "pi",
                    "provider": "openai-codex",
                    "model": "gpt-5.5",
                }
            },
            "pi_agent_exepath": "pi-agent",
        },
        "/test/config/dir",
    )

    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    with TestClient(app) as c:
        response = c.post(
            "/chat", json={"message": "hello", "session_id": "test_pi_approve_session"}
        )

    assert response.status_code == 200
    mock_exec.assert_called_once()
    called_args = mock_exec.call_args[0]
    assert called_args[0] == "pi-agent"
    assert "--approve" in called_args
    provider_idx = list(called_args).index("--provider")
    assert called_args[provider_idx + 1] == "openai-codex"


@pytest.mark.asyncio
@patch("main.load_config")
@patch("main.asyncio.create_subprocess_exec")
async def test_pi_readonly_restricts_tools(mock_exec, mock_load_config):
    """Pi readonly_mode_on should pass --no-tools --tools read,search_web instead of --approve."""
    mock_load_config.return_value = (
        {
            "agent_by_alias": {
                "pi-readonly": {
                    "harness": "pi",
                    "provider": "openai-codex",
                    "model": "gpt-5.5",
                    "readonly_mode_on": True,
                }
            },
            "pi_agent_exepath": "pi-agent",
        },
        "/test/config/dir",
    )

    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    with TestClient(app) as c:
        response = c.post(
            "/chat",
            json={"message": "hello", "session_id": "test_pi_readonly_session"},
        )

    assert response.status_code == 200
    mock_exec.assert_called_once()
    called_args = mock_exec.call_args[0]
    assert "--no-tools" in called_args
    assert "--tools" in called_args
    tools_idx = list(called_args).index("--tools")
    assert called_args[tools_idx + 1] == "read,grep,find,ls"
    assert "--approve" not in called_args


@pytest.mark.asyncio
@patch("main.load_config")
@patch("main.asyncio.create_subprocess_exec")
async def test_gemini_default_yolo(mock_exec, mock_load_config):
    """Gemini without readonly_mode_on should pass --yolo."""
    mock_load_config.return_value = (
        {
            "agent_by_alias": {"gemini-cli": {"harness": "gemini-cli"}},
        },
        "/test/config/dir",
    )

    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    with TestClient(app) as c:
        response = c.post(
            "/chat",
            json={"message": "hello", "session_id": "test_gemini_yolo_session"},
        )

    assert response.status_code == 200
    mock_exec.assert_called_once()
    called_args = mock_exec.call_args[0]
    assert "--yolo" in called_args
    assert "--approval-mode" not in called_args


@pytest.mark.asyncio
@patch("main.load_config")
@patch("main.asyncio.create_subprocess_exec")
async def test_gemini_readonly_plan(mock_exec, mock_load_config):
    """Gemini readonly_mode_on should pass --approval-mode plan instead of --yolo."""
    mock_load_config.return_value = (
        {
            "agent_by_alias": {
                "gemini-readonly": {
                    "harness": "gemini-cli",
                    "readonly_mode_on": True,
                }
            },
        },
        "/test/config/dir",
    )

    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    with TestClient(app) as c:
        response = c.post(
            "/chat",
            json={"message": "hello", "session_id": "test_gemini_readonly_session"},
        )

    assert response.status_code == 200
    mock_exec.assert_called_once()
    called_args = mock_exec.call_args[0]
    assert "--approval-mode" in called_args
    am_idx = list(called_args).index("--approval-mode")
    assert called_args[am_idx + 1] == "plan"
    assert "--yolo" not in called_args


@pytest.mark.asyncio
@patch("main.load_config")
@patch("main.asyncio.create_subprocess_exec")
async def test_gemini_preset_args_are_merged(mock_exec, mock_load_config):
    """Gemini preset args should be merged with generated approval flags."""
    mock_load_config.return_value = (
        {
            "agent_by_alias": {
                "gemini-custom": {
                    "harness": "gemini-cli",
                    "args": ["--my-custom-flag"],
                }
            },
        },
        "/test/config/dir",
    )

    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    with TestClient(app) as c:
        response = c.post(
            "/chat",
            json={
                "message": "hello",
                "session_id": "test_gemini_custom_args_session",
            },
        )

    assert response.status_code == 200
    mock_exec.assert_called_once()
    called_args = mock_exec.call_args[0]
    assert "--my-custom-flag" in called_args
    # Generated approval flags still come through
    assert "--yolo" in called_args
    # --resume latest injected by code
    assert "--resume" in called_args


@pytest.mark.asyncio
@patch("main.load_config")
@patch("main.asyncio.create_subprocess_exec")
async def test_gemini_node_args_used(mock_exec, mock_load_config):
    """Gemini without preset args should use gemini_node_args from config."""
    mock_load_config.return_value = (
        {
            "agent_by_alias": {"gemini-cli": {"harness": "gemini-cli"}},
            "gemini_node_args": ["--no-warnings=DEP0040", "--", "/path/to/gemini"],
        },
        "/test/config/dir",
    )

    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    with TestClient(app) as c:
        response = c.post(
            "/chat",
            json={"message": "hello", "session_id": "test_gemini_node_args_session"},
        )

    assert response.status_code == 200
    mock_exec.assert_called_once()
    called_args = mock_exec.call_args[0]
    assert "--no-warnings=DEP0040" in called_args
    assert "--yolo" in called_args


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
@patch("main.asyncio.create_subprocess_exec")
async def test_tmpdir_isolation_and_cleanup(mock_exec, test_sessions_dir):
    """TMPDIR is set to a per-session tmp/ dir and cleaned up after each request.

    Verifies the isolation story: pi/gemini-cli temp files go into
    <session>/tmp/ instead of polluting the system /tmp, and that directory
    is wiped after every chat request completes.
    """
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"ok", b"")
    mock_exec.return_value = mock_process

    session_id = "test_tmpdir_session"
    session_path = os.path.join(test_sessions_dir, session_id)
    expected_tmpdir = os.path.join(session_path, "tmp")

    with TestClient(app) as c:
        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

    # TMPDIR was injected into the subprocess env
    mock_exec.assert_called_once()
    env = mock_exec.call_args[1]["env"]
    assert env["TMPDIR"] == expected_tmpdir

    # tmp dir was created before the subprocess ran
    assert os.path.isdir(expected_tmpdir)

    # After the request completed, the tmp dir should be empty (but still exist)
    assert os.path.isdir(expected_tmpdir)
    assert os.listdir(expected_tmpdir) == []


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_session_delete_cleans_tmpdir(mock_exec, test_sessions_dir):
    """Deleting a session removes its tmp/ directory."""
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"ok", b"")
    mock_exec.return_value = mock_process

    session_id = "test_delete_tmpdir_session"
    session_path = os.path.join(test_sessions_dir, session_id)
    expected_tmpdir = os.path.join(session_path, "tmp")

    with TestClient(app) as c:
        # Create and use the session so tmp/ gets created
        c.post("/sessions")
        c.post("/chat", json={"message": "hello", "session_id": session_id})

        # Create a dummy file in tmp/ to simulate a leaked temp file
        dummy_file = os.path.join(expected_tmpdir, "leaked.log")
        async with aiofiles.open(dummy_file, "w") as f:
            await f.write("should be cleaned up")
        assert os.path.exists(dummy_file)

        # Delete the session
        resp = c.delete(f"/sessions/{session_id}")
        assert resp.status_code == 200

    # Session dir and tmp dir are gone
    assert not os.path.exists(session_path)
    assert not os.path.exists(expected_tmpdir)


@pytest.mark.asyncio
@patch("main.load_config")
@patch("main.asyncio.create_subprocess_exec")
async def test_env_vars_canonical_env_dict(mock_exec, mock_load_config):
    """The top-level ``env_dict`` is injected."""
    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"mocked response", b"")
    mock_exec.return_value = mock_process

    mock_load_config.return_value = (
        {
            "agent_by_alias": {"gemini-cli": {"harness": "gemini-cli"}},
            "env_dict": {"MY_VAR": "my_val"},
        },
        "/tmp",
    )

    with TestClient(app) as c:
        response = c.post(
            "/chat", json={"message": "hello", "session_id": "test_env_canonical"}
        )
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


def test_index_page_served():
    """The web UI is served at /."""
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers.get("content-type", "")
    assert "Limilink Proxy" in response.text


def test_ui_session_create_flow():
    """Test the exact flow the browser JS performs: list → POST /sessions → use session_id."""
    # 1. List sessions (initially empty)
    response = client.get("/sessions")
    assert response.status_code == 200
    initial_sessions = response.json()["sessions"]

    # 2. Create a new session via POST /sessions (no session_id in URL)
    response = client.post("/sessions")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "created"
    session_id = data["session_id"]
    assert session_id.startswith("session_")

    # 3. Verify it shows up in the session list
    response = client.get("/sessions")
    assert response.status_code == 200
    assert session_id in response.json()["sessions"]

    # 4. Create another session; both should be listed
    response = client.post("/sessions")
    assert response.status_code == 200
    session_id2 = response.json()["session_id"]
    assert session_id2 != session_id

    response = client.get("/sessions")
    sessions = response.json()["sessions"]
    assert session_id in sessions
    assert session_id2 in sessions
    assert len(sessions) == len(initial_sessions) + 2


def test_old_buggy_url_returns_error():
    """POST /sessions/<name> has no handler — the frontend must use POST /sessions.
    This guards against regressing to the old bug where the UI POSTed to a
    timestamp-based URL that the server didn't recognize."""
    response = client.post("/sessions/session_20250613_120000")
    assert (
        response.status_code == 405
    )  # Method Not Allowed (no POST route for this path)


def test_html_uses_correct_create_endpoint():
    """The frontend HTML must use POST /sessions (not /sessions/<name>)."""
    response = client.get("/")
    html = response.text
    # Should contain the correct endpoint (used in both the + button and auto-create)
    assert html.count("fetch('/sessions', { method: 'POST' })") >= 2
    # Should NOT use string concatenation with POST to create sessions
    # (The old bug: fetch('/sessions/' + name, { method: 'POST' }))
    post_lines = [line for line in html.split("\n") if "method: 'POST'" in line]
    for line in post_lines:
        assert "'/sessions/' +" not in line, (
            f"old buggy POST pattern found: {line.strip()}"
        )


@pytest.mark.asyncio
async def test_run_notifyme_task_lock_held_skips_agent(test_sessions_dir):
    """When session lock is held, raw notification is enqueued but agent is skipped."""
    from main import run_notifyme_task

    session_id = "session_test_lockheld"
    session_path = os.path.join(test_sessions_dir, session_id)
    os.makedirs(session_path, exist_ok=True)

    mock_lock = MagicMock()
    mock_lock.locked.return_value = True

    with (
        patch("main.process_chat") as mock_process_chat,
        patch("main.enqueue_unread_message") as mock_enqueue,
        patch("main.get_session_lock", return_value=mock_lock),
    ):
        await run_notifyme_task(session_id, "background command finished")

        # Raw notification always delivered.
        mock_enqueue.assert_called_once_with(
            session_path, "background command finished"
        )
        # Agent must NOT be called — lock is held by an active chat.
        mock_process_chat.assert_not_called()


@pytest.mark.asyncio
async def test_run_notifyme_task_lock_free_calls_agent(test_sessions_dir):
    """When session lock is free, both raw notification and agent response are enqueued."""
    from main import run_notifyme_task

    session_id = "session_test_lockfree"
    session_path = os.path.join(test_sessions_dir, session_id)
    os.makedirs(session_path, exist_ok=True)

    mock_lock = MagicMock()
    mock_lock.locked.return_value = False

    with (
        patch("main.process_chat") as mock_process_chat,
        patch("main.enqueue_unread_message") as mock_enqueue,
        patch("main.get_session_lock", return_value=mock_lock),
    ):
        mock_process_chat.return_value = "looks like it finished successfully"

        await run_notifyme_task(session_id, "background command finished")

        # Raw notification enqueued first.
        mock_enqueue.assert_any_call(session_path, "background command finished")
        # Agent called.
        mock_process_chat.assert_called_once_with(
            session_id, "background command finished"
        )
        # Agent response enqueued second.
        mock_enqueue.assert_any_call(
            session_path, "looks like it finished successfully"
        )
        assert mock_enqueue.call_count == 2


@pytest.mark.asyncio
async def test_run_notifyme_task_agent_error_still_delivers_raw(test_sessions_dir):
    """When agent fails, raw notification is still delivered."""
    from main import run_notifyme_task

    session_id = "session_test_agentfail"
    session_path = os.path.join(test_sessions_dir, session_id)
    os.makedirs(session_path, exist_ok=True)

    mock_lock = MagicMock()
    mock_lock.locked.return_value = False

    with (
        patch("main.process_chat") as mock_process_chat,
        patch("main.enqueue_unread_message") as mock_enqueue,
        patch("main.get_session_lock", return_value=mock_lock),
    ):
        mock_process_chat.side_effect = RuntimeError("agent exploded")

        await run_notifyme_task(session_id, "background command finished")

        # Raw notification still delivered.
        mock_enqueue.assert_any_call(session_path, "background command finished")
        # Error message enqueued as follow-up.
        assert any(
            "agent exploded" in str(call) for call in mock_enqueue.call_args_list
        )


@patch("main.load_config")
def test_unrecognized_exclamation_command_not_forwarded(mock_load_config):
    """Unrecognized ! commands return an error and are never forwarded to the agent."""
    mock_load_config.return_value = (
        {"agent_by_alias": {"gemini-cli": {"harness": "gemini-cli"}}},
        "/fake/config/dir",
    )
    session_id = "test_bang_unknown"
    response = client.post(
        "/chat", json={"message": "!nonexistent_cmd", "session_id": session_id}
    )
    assert response.status_code == 200
    assert response.json()["reply"] == "Unknown command: !nonexistent_cmd"
