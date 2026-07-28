import os
import shutil
import tempfile

import pytest

# Set a safe default for LIMILINK_SESSIONS_DIR during test discovery and imports.
# This prevents top-level code from touching the live session directory.
_discovery_sessions_dir = tempfile.mkdtemp(prefix="limilink_test_discovery_")
os.environ["LIMILINK_SESSIONS_DIR"] = _discovery_sessions_dir


@pytest.fixture(autouse=True)
def test_sessions_dir(tmp_path, monkeypatch):
    """Fixture to provide a clean, temporary sessions directory for each test."""
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()

    # Set the environment variable so all code uses the temporary sessions directory.
    monkeypatch.setenv("LIMILINK_SESSIONS_DIR", str(sessions_dir))

    # Also keep patching for safety.
    monkeypatch.setattr(
        "main.get_sessions_dir", lambda cfg, config_dir: str(sessions_dir)
    )

    return str(sessions_dir)


def pytest_unconfigure(config):
    """Cleanup discovery directory after tests are done."""
    if os.path.exists(_discovery_sessions_dir):
        shutil.rmtree(_discovery_sessions_dir)
