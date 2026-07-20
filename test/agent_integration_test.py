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
async def test_agent_switch_reconciles_pi_resources(tmp_path, test_sessions_dir):
    """Switching Pi presets replaces auth and clears stale per-agent state."""
    import json
    import os

    first_auth = tmp_path / "first-auth.json"
    second_auth = tmp_path / "second-auth.json"
    first_auth.write_text("{}")
    second_auth.write_text("{}")
    config = {
        "agent_by_alias": {
            "pi-first": {
                "harness": "pi",
                "model": "deepseek-v4-flash",
                "provider": "deepseek",
                "reasoning_effort": "low",
                "session_symlink_dict": {
                    ".pi/agent/auth.json": str(first_auth),
                },
            },
            "pi-second": {
                "harness": "pi",
                "model": "gpt-5.6-sol",
                "provider": "openai-codex",
                "reasoning_effort": "high",
                "session_symlink_dict": {
                    ".pi/agent/auth.json": str(second_auth),
                },
            },
        },
    }

    with patch("main.load_config", return_value=(config, str(tmp_path))):
        with TestClient(app) as c:
            create_response = c.post("/sessions?agent=pi-first")
            session_id = create_response.json()["session_id"]
            session_path = os.path.join(test_sessions_dir, session_id)
            c.post(
                "/chat",
                json={"message": "!model stale-model", "session_id": session_id},
            )
            c.post(
                "/chat",
                json={"message": "!reasoning_effort xhigh", "session_id": session_id},
            )
            models_path = os.path.join(session_path, ".pi", "agent", "models.json")
            with open(models_path, "w") as f:
                json.dump({"providers": {"stale": {}}}, f)

            response = c.post(
                "/chat",
                json={"message": "!agent pi-second", "session_id": session_id},
            )

    assert response.json()["reply"] == "Agent switched to: pi-second"
    auth_link = os.path.join(session_path, ".pi", "agent", "auth.json")
    assert os.path.realpath(auth_link) == str(second_auth)
    assert not os.path.exists(os.path.join(session_path, ".model"))
    assert not os.path.exists(os.path.join(session_path, ".reasoning_effort"))
    assert not os.path.exists(models_path)
    with open(os.path.join(session_path, ".pi", "agent", "settings.json")) as f:
        assert json.load(f)["defaultThinkingLevel"] == "high"


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
async def test_reasoning_effort_gemini_cli(mock_config):
    """!reasoning_effort on gemini-cli harness should say it's pi-only."""
    session_id = "test_reasoning_effort_gemini"

    with TestClient(app) as c:
        response = c.post(
            "/chat",
            json={"message": "!reasoning_effort", "session_id": session_id},
        )
        assert response.status_code == 200
        assert "only available for the pi harness" in response.json()["reply"]


@pytest.mark.asyncio
async def test_reasoning_effort_show_default(mock_config):
    """!reasoning_effort without args on pi harness shows 'not set' when no config."""
    session_id = "test_reasoning_effort_default"

    with TestClient(app) as c:
        # Switch to pi-agent
        c.post(
            "/chat",
            json={"message": "!agent pi-agent", "session_id": session_id},
        )

        response = c.post(
            "/chat",
            json={"message": "!reasoning_effort", "session_id": session_id},
        )
        assert response.status_code == 200
        assert "not set" in response.json()["reply"]


@pytest.mark.asyncio
async def test_reasoning_effort_show_from_preset_before_first_chat(mock_config):
    """!reasoning_effort shows preset value even before first chat writes settings.json."""
    # Override to have a preset with reasoning_effort
    mock_config.return_value = (
        {
            "agent_by_alias": {
                "pi-test": {
                    "harness": "pi",
                    "model": "test-model",
                    "reasoning_effort": "high",
                    "openai_base_url": "http://test:11435/v1",
                    "openai_api_key": "sk-test",
                },
            },
        },
        "/test/config/dir",
    )

    session_id = "test_reasoning_preset_show"

    with TestClient(app) as c:
        # Switch to the agent with reasoning_effort preset
        c.post(
            "/chat",
            json={"message": "!agent pi-test", "session_id": session_id},
        )

        # Query reasoning effort BEFORE any actual chat (settings.json won't exist yet)
        response = c.post(
            "/chat",
            json={"message": "!reasoning_effort", "session_id": session_id},
        )
        assert response.status_code == 200
        assert "Current reasoning level: high" in response.json()["reply"]


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_reasoning_effort_set_and_query(
    mock_exec, mock_config, test_sessions_dir
):
    """!reasoning_effort persists and is passed explicitly to Pi."""
    import os as _os

    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"ok", b"")
    mock_exec.return_value = mock_process

    session_id = "test_reasoning_effort_set"
    session_path = _os.path.join(test_sessions_dir, session_id)

    with TestClient(app) as c:
        # Switch to pi-agent
        c.post(
            "/chat",
            json={"message": "!agent pi-agent", "session_id": session_id},
        )

        # Set to high
        response = c.post(
            "/chat",
            json={
                "message": "!reasoning_effort high",
                "session_id": session_id,
            },
        )
        assert response.status_code == 200
        assert "Reasoning level set to: high" in response.json()["reply"]

        # Query shows high
        response = c.post(
            "/chat",
            json={"message": "!reasoning_effort", "session_id": session_id},
        )
        assert response.status_code == 200
        assert "Current reasoning level: high" in response.json()["reply"]

        # Switch to xhigh
        response = c.post(
            "/chat",
            json={
                "message": "!reasoning_effort xhigh",
                "session_id": session_id,
            },
        )
        assert response.status_code == 200
        assert "Reasoning level set to: xhigh" in response.json()["reply"]

        response = c.post(
            "/chat",
            json={"message": "!reasoning_effort", "session_id": session_id},
        )
        assert "Current reasoning level: xhigh" in response.json()["reply"]

        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

    cmd = list(mock_exec.call_args[0])
    thinking_index = cmd.index("--thinking")
    assert cmd[thinking_index + 1] == "xhigh"

    # Verify settings.json was written
    settings_path = _os.path.join(session_path, ".pi", "agent", "settings.json")
    assert _os.path.exists(settings_path)
    import json as _json

    with open(settings_path) as f:
        settings = _json.load(f)
    assert settings["defaultThinkingLevel"] == "xhigh"


@pytest.mark.asyncio
async def test_reasoning_effort_invalid(mock_config):
    """!reasoning_effort with invalid level should reject."""
    session_id = "test_reasoning_effort_invalid"

    with TestClient(app) as c:
        # Switch to pi-agent
        c.post(
            "/chat",
            json={"message": "!agent pi-agent", "session_id": session_id},
        )

        response = c.post(
            "/chat",
            json={
                "message": "!reasoning_effort turbo",
                "session_id": session_id,
            },
        )
        assert response.status_code == 200
        assert "Invalid reasoning level" in response.json()["reply"]


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_reasoning_effort_in_preset_writes_settings(
    mock_exec, mock_config, test_sessions_dir
):
    """Pi session with reasoning_effort in preset writes settings.json on first run."""
    import os as _os

    mock_process = AsyncMock()
    mock_process.returncode = 0
    mock_process.communicate.return_value = (b"ok", b"")
    mock_exec.return_value = mock_process

    # Override the mock_config to include a preset with reasoning_effort
    mock_config.return_value = (
        {
            "agent_by_alias": {
                "pi-test": {
                    "harness": "pi",
                    "model": "test-model",
                    "reasoning_effort": "high",
                    "openai_base_url": "http://test:11435/v1",
                    "openai_api_key": "sk-test",
                },
            },
        },
        "/test/config/dir",
    )

    session_id = "test_reasoning_preset"
    session_path = _os.path.join(test_sessions_dir, session_id)

    with TestClient(app) as c:
        # Use the agent
        c.post(
            "/chat",
            json={"message": "!agent pi-test", "session_id": session_id},
        )

        # Send a chat to trigger first-run model/settings writes
        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200

    # settings.json should exist with high
    settings_path = _os.path.join(session_path, ".pi", "agent", "settings.json")
    assert _os.path.exists(settings_path)
    import json as _json

    with open(settings_path) as f:
        settings = _json.load(f)
    assert settings["defaultThinkingLevel"] == "high"

    cmd = list(mock_exec.call_args[0])
    thinking_index = cmd.index("--thinking")
    assert cmd[thinking_index + 1] == "high"


@pytest.mark.asyncio
async def test_write_pi_settings_json_synchronizes_level(
    mock_config, test_sessions_dir
):
    """Reasoning synchronization updates its key and preserves other settings."""
    import os as _os
    import json as _json

    session_id = "test_settings_sync"
    session_path = _os.path.join(test_sessions_dir, session_id)
    settings_dir = _os.path.join(session_path, ".pi", "agent")
    _os.makedirs(settings_dir, exist_ok=True)

    settings_path = _os.path.join(settings_dir, "settings.json")
    with open(settings_path, "w") as f:
        _json.dump({"defaultThinkingLevel": "low", "theme": "dark"}, f)

    from main import write_pi_settings_json

    write_pi_settings_json(session_path, "high")

    with open(settings_path) as f:
        settings = _json.load(f)
    assert settings == {"defaultThinkingLevel": "high", "theme": "dark"}


@pytest.mark.asyncio
async def test_write_pi_settings_json_clears_level(test_sessions_dir):
    """Selecting a preset without reasoning removes the stale default."""
    import os as _os
    import json as _json

    session_id = "test_settings_clear"
    session_path = _os.path.join(test_sessions_dir, session_id)
    settings_dir = _os.path.join(session_path, ".pi", "agent")
    _os.makedirs(settings_dir, exist_ok=True)
    settings_path = _os.path.join(settings_dir, "settings.json")
    with open(settings_path, "w") as f:
        _json.dump({"defaultThinkingLevel": "high", "theme": "dark"}, f)

    from main import write_pi_settings_json

    write_pi_settings_json(session_path, None)

    with open(settings_path) as f:
        assert _json.load(f) == {"theme": "dark"}


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_stat_pi_with_data(mock_exec, mock_config, test_sessions_dir):
    """!stat on pi-agent with jsonl data should return stat output."""
    import os as _os

    session_id = "test_stat_pi_data"
    session_path = _os.path.join(test_sessions_dir, session_id)
    pi_agent_dir = _os.path.join(session_path, ".pi", "agent", "session")
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


@pytest.mark.asyncio
async def test_trace_gemini_cli_harness(mock_config):
    """!trace on gemini-cli harness should say it is pi-only."""
    with TestClient(app) as c:
        response = c.post(
            "/chat",
            json={"message": "!trace tool 5", "session_id": "test_trace_gemini"},
        )

    assert response.status_code == 200
    assert "only available for the pi harness" in response.json()["reply"]


@pytest.mark.asyncio
async def test_trace_pi_validates_command(mock_config):
    """!trace validates selectors and counts before looking for session data."""
    session_id = "test_trace_validation"
    with TestClient(app) as c:
        c.post(
            "/chat",
            json={"message": "!agent pi-agent", "session_id": session_id},
        )
        usage = c.post("/chat", json={"message": "!trace", "session_id": session_id})
        selector = c.post(
            "/chat",
            json={"message": "!trace message 5", "session_id": session_id},
        )
        count = c.post(
            "/chat",
            json={"message": "!trace tool 0", "session_id": session_id},
        )

    assert usage.json()["reply"] == "Usage: !trace tool [COUNT]"
    assert "Unsupported trace selector 'message'" in selector.json()["reply"]
    assert count.json()["reply"] == "COUNT must be an integer between 1 and 100."


@pytest.mark.asyncio
async def test_trace_pi_no_data(mock_config):
    """!trace reports when a pi session has no JSONL yet."""
    session_id = "test_trace_no_data"
    with TestClient(app) as c:
        c.post(
            "/chat",
            json={"message": "!agent pi-agent", "session_id": session_id},
        )
        response = c.post(
            "/chat",
            json={"message": "!trace tool 5", "session_id": session_id},
        )

    assert response.status_code == 200
    assert "No pi-agent session data found" in response.json()["reply"]


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_trace_pi_with_data(mock_exec, mock_config, test_sessions_dir):
    """!trace invokes the local trace script for the current pi session."""
    import os as _os

    session_id = "test_trace_pi_data"
    session_path = _os.path.join(test_sessions_dir, session_id)
    pi_session_dir = _os.path.join(session_path, ".pi", "agent", "session")
    _os.makedirs(pi_session_dir, exist_ok=True)
    with open(_os.path.join(session_path, ".agent_type"), "w") as output:
        output.write("pi-agent")
    jsonl_path = _os.path.join(pi_session_dir, "test.jsonl")
    with open(jsonl_path, "w") as output:
        output.write('{"type":"session","cwd":"/test"}\n')

    trace_process = AsyncMock()
    trace_process.returncode = 0
    trace_process.communicate.return_value = (b"read\t.\tMEMORY.md\n", b"")
    mock_exec.return_value = trace_process

    with TestClient(app) as c:
        response = c.post(
            "/chat",
            json={"message": "!trace tool 5", "session_id": session_id},
        )

    assert response.status_code == 200
    assert response.json()["reply"] == "read\t.\tMEMORY.md"
    mock_exec.assert_called_once()
    cmd = mock_exec.call_args[0]
    assert cmd[0] == "python3"
    assert cmd[1].endswith("pi_session_trace.py")
    assert cmd[2:5] == ("tool", "5", "--session")
    assert cmd[5] == jsonl_path
