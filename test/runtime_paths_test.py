"""Path selection never depends on the checkout and never migrates old state."""

import json
from pathlib import Path
import subprocess
import sys

import pytest

from runtime_paths import config_path, get_sessions_dir
from tool.pi_session_trace import find_session_file


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    for name in (
        "LIMILINK_SESSIONS_DIR",
        "LIMILINK_CONFIG",
        "XDG_STATE_HOME",
        "XDG_CONFIG_HOME",
        "PI_CODING_AGENT_DIR",
    ):
        monkeypatch.delenv(name, raising=False)
    return home


@pytest.mark.parametrize("state", [None, "", "relative", "~/relative"])
def test_default_sessions_uses_home_for_unset_or_invalid_xdg(
    isolated, monkeypatch, state
):
    if state is not None:
        monkeypatch.setenv("XDG_STATE_HOME", state)
    expected = isolated / ".local/state/limilink/sessions"
    assert get_sessions_dir({}, "/unrelated/config") == str(expected)
    assert not expected.exists(), "Resolving a path must not create or move state"


def test_absolute_xdg_state_and_cwd_independence(isolated, tmp_path, monkeypatch):
    state = tmp_path / "other-state"
    monkeypatch.setenv("XDG_STATE_HOME", str(state))
    monkeypatch.chdir(tmp_path)
    assert get_sessions_dir({}, "config") == str(state / "limilink/sessions")
    assert config_path() == str(isolated / ".config/limilink/config.sxpb")


@pytest.mark.parametrize(
    "configured", ["../kept-sessions", "/absolute/sessions", "~/explicit-sessions"]
)
def test_config_override_preserves_relative_and_home_semantics(
    isolated, tmp_path, monkeypatch, configured
):
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "ignored"))
    config_dir = isolated / ".config/limilink"
    expected = (
        Path(configured.replace("~", str(isolated))).absolute()
        if not configured.startswith("..")
        else config_dir.parent / "kept-sessions"
    )
    assert get_sessions_dir({"session_dirpath": configured}, str(config_dir)) == str(
        expected
    )


def test_environment_override_wins_over_config_and_xdg(isolated, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("LIMILINK_SESSIONS_DIR", "explicit-sessions")
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "ignored"))
    assert get_sessions_dir({"session_dirpath": "/ignored"}, "/config") == str(
        tmp_path / "explicit-sessions"
    )


def test_empty_overrides_fall_through_to_xdg(isolated, tmp_path, monkeypatch):
    monkeypatch.setenv("LIMILINK_SESSIONS_DIR", "")
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path))
    assert get_sessions_dir({"session_dirpath": ""}, "/config") == str(
        tmp_path / "limilink/sessions"
    )


def test_new_state_root_is_private_without_chmodding_existing_roots(
    tmp_path, monkeypatch
):
    import main
    from fastapi.testclient import TestClient

    root = tmp_path / "new-state/sessions"
    monkeypatch.setattr(main, "get_sessions_dir", lambda *_: str(root))
    with TestClient(main.app):
        assert root.stat().st_mode & 0o777 == 0o700
    root.chmod(0o750)
    with TestClient(main.app):
        assert root.stat().st_mode & 0o777 == 0o750


def test_config_location_override_and_xdg_config(isolated, tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert config_path() == str(tmp_path / "limilink/config.sxpb")
    monkeypatch.setenv("LIMILINK_CONFIG", str(tmp_path / "explicit.sxpb"))
    assert config_path() == str(tmp_path / "explicit.sxpb")


@pytest.mark.parametrize("override", ["default", "config", "environment"])
def test_trace_helper_uses_same_sessions_root_from_unrelated_cwd(
    isolated, tmp_path, monkeypatch, override
):
    state = tmp_path / "state"
    monkeypatch.setenv("XDG_STATE_HOME", str(state))
    config = tmp_path / "config" / "config.sxpb"
    config.parent.mkdir()
    config.write_text("()\n")
    monkeypatch.setenv("LIMILINK_CONFIG", str(config))
    root = state / "limilink/sessions"
    if override == "config":
        config.write_text('(session_dirpath "../configured-sessions")\n')
        root = tmp_path / "configured-sessions"
    elif override == "environment":
        root = tmp_path / "environment-sessions"
        monkeypatch.setenv("LIMILINK_SESSIONS_DIR", str(root))
    journal = root / "session_example/.pi/agent/session/example.jsonl"
    journal.parent.mkdir(parents=True)
    journal.write_text(json.dumps({"type": "session", "cwd": "/prior/location"}) + "\n")
    monkeypatch.chdir(isolated)
    assert find_session_file("session_example") == journal
    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / "tool/pi_session_trace.py"),
            "tool",
            "--session",
            "session_example",
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    assert str(journal) in result.stderr
    assert result.stdout.strip() == "No tool calls found."
