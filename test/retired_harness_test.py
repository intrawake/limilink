"""Retired harnesses are rejected without changing existing session identity."""

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app


CONFIG = {"agent_by_alias": {"pi-test": {"harness": "pi", "model": "test-model"}}}


@pytest.mark.parametrize("agent", ["gemini", "gemini-cli"])
def test_retired_harness_cannot_create_session(agent, test_sessions_dir):
    with (
        patch("main.load_config", return_value=(CONFIG, "/test")),
        TestClient(app) as c,
    ):
        response = c.post("/sessions", params={"agent": agent})
    assert response.status_code == 400
    assert not list(Path(test_sessions_dir).iterdir())


def test_configured_retired_harness_is_rejected(test_sessions_dir):
    config = {"agent_by_alias": {"retired": {"harness": "gemini-cli"}}}
    with (
        patch("main.load_config", return_value=(config, "/test")),
        TestClient(app) as c,
    ):
        response = c.post("/sessions")
    assert response.status_code == 400
    assert "Unsupported harness" in response.json()["detail"]


@pytest.mark.parametrize("alias", ["gemini-cli", "gemini-custom", "missing-agent"])
def test_old_session_can_explicitly_switch_to_pi(alias, tmp_path, test_sessions_dir):
    session = Path(test_sessions_dir) / "old-session"
    session.mkdir()
    (session / ".agent_type").write_text(alias)
    history = '[{"role":"user","content":"keep this history"}]'
    (session / "chat_history.json").write_text(history)
    with (
        patch("main.load_config", return_value=(CONFIG, str(tmp_path))),
        patch("main.asyncio.create_subprocess_exec") as launch,
        TestClient(app) as c,
    ):
        response = c.post(
            "/chat", json={"session_id": session.name, "message": "hello"}
        )
        assert response.status_code == 400
        assert "!agent <pi-alias>" in response.json()["detail"]
        launch.assert_not_called()
        assert (session / ".agent_type").read_text() == alias
        assert (session / "chat_history.json").read_text() == history

        response = c.post(
            "/chat", json={"session_id": session.name, "message": "!agent pi-test"}
        )
        assert response.json()["reply"] == "Agent switched to: pi-test"
        assert (session / ".agent_type").read_text() == "pi-test"
        assert "keep this history" in (session / "chat_history.json").read_text()
        response = c.post(
            "/chat", json={"session_id": session.name, "message": "!model"}
        )
        assert response.json()["reply"] == "Current model: test-model"
        launch.assert_not_called()


def test_cannot_switch_to_configured_retired_harness(test_sessions_dir):
    config = {
        "agent_by_alias": {
            **CONFIG["agent_by_alias"],
            "retired": {"harness": "gemini-cli"},
        }
    }
    with (
        patch("main.load_config", return_value=(config, "/test")),
        TestClient(app) as c,
    ):
        created = c.post("/sessions")
        session_id = created.json()["session_id"]
        response = c.post(
            "/chat", json={"session_id": session_id, "message": "!agent retired"}
        )
    assert "Only Pi is supported" in response.json()["reply"]
    assert (
        Path(test_sessions_dir) / session_id / ".agent_type"
    ).read_text() == "pi-test"
