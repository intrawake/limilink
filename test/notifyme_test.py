import importlib.util
import os
import sys
from unittest.mock import patch


def load_notifyme_module():
    tool_path = os.path.join(os.path.dirname(__file__), "..", "tool", "notifyme.py")
    spec = importlib.util.spec_from_file_location("notifyme", tool_path)
    assert spec is not None
    assert spec.loader is not None
    notifyme = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(notifyme)
    return notifyme


def test_find_session_id_logical_pwd():
    notifyme = load_notifyme_module()

    logical_pwd = "/fake/logical/workspace/session_123/bin"

    with (
        patch.dict(os.environ, {"PWD": logical_pwd}, clear=True),
        patch("os.path.exists") as mock_exists,
        patch("os.getcwd", return_value="/tmp/physical/path"),
    ):

        def fake_exists(path):
            # Simulate finding .initialized in the parent directory of logical PWD
            return path == "/fake/logical/workspace/session_123/.initialized"

        mock_exists.side_effect = fake_exists

        session_id = notifyme.find_session_id()
        assert session_id == "session_123"


def test_find_session_id_physical_pwd():
    notifyme = load_notifyme_module()

    physical_pwd = "/tmp/physical/workspace/session_456/src/deep/dir"

    with (
        patch.dict(os.environ, clear=True),
        patch("os.path.exists") as mock_exists,
        patch("os.getcwd", return_value=physical_pwd),
    ):

        def fake_exists(path):
            return path == "/tmp/physical/workspace/session_456/.initialized"

        mock_exists.side_effect = fake_exists

        session_id = notifyme.find_session_id()
        assert session_id == "session_456"


def test_find_session_id_executable_path():
    notifyme = load_notifyme_module()

    exec_path = "/opt/sessions/session_789/bin/notifyme.py"

    with (
        patch.dict(os.environ, clear=True),
        patch("os.path.exists") as mock_exists,
        patch("os.getcwd", return_value="/tmp/unrelated/path"),
        patch.object(sys, "argv", [exec_path]),
    ):

        def fake_exists(path):
            return path == "/opt/sessions/session_789/.initialized"

        mock_exists.side_effect = fake_exists

        session_id = notifyme.find_session_id()
        assert session_id == "session_789"


def test_find_session_id_not_found():
    notifyme = load_notifyme_module()

    with (
        patch.dict(os.environ, clear=True),
        patch("os.path.exists", return_value=False),
        patch("os.getcwd", return_value="/tmp/unrelated/path"),
        patch.object(sys, "argv", ["/usr/bin/notifyme"]),
    ):
        session_id = notifyme.find_session_id()
        assert session_id is None
