import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def test_sessions_dir(tmp_path, monkeypatch):
    """Fixture to provide a clean, temporary sessions directory for each test."""
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    monkeypatch.setattr(
        "main.get_sessions_dir", lambda cfg, config_dir: str(sessions_dir)
    )
    return str(sessions_dir)


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_429_propagation_from_retcode(mock_exec):
    mock_process = AsyncMock()
    mock_process.returncode = 173  # 429 % 256
    mock_process.communicate.return_value = (b"", b"Rate limit exceeded.")
    mock_exec.return_value = mock_process

    with TestClient(app) as c:
        response = c.post("/chat", json={"message": "hello", "session_id": "test_429"})

    assert response.status_code == 429
    assert "Rate limit exceeded" in response.json()["detail"]


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_429_propagation_from_stderr(mock_exec):
    mock_process = AsyncMock()
    mock_process.returncode = 1
    mock_process.communicate.return_value = (b"", b"Error 429: Too Many Requests")
    mock_exec.return_value = mock_process

    with TestClient(app) as c:
        response = c.post(
            "/chat", json={"message": "hello", "session_id": "test_429_stderr"}
        )

    assert response.status_code == 429
    assert "Too Many Requests" in response.json()["detail"]


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_401_propagation_from_retcode(mock_exec):
    mock_process = AsyncMock()
    mock_process.returncode = 145  # 401 % 256
    mock_process.communicate.return_value = (b"", b"Authentication failed.")
    mock_exec.return_value = mock_process

    with TestClient(app) as c:
        response = c.post("/chat", json={"message": "hello", "session_id": "test_401"})

    assert response.status_code == 401
    assert "Authentication error" in response.json()["detail"]


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_403_propagation_from_retcode(mock_exec):
    mock_process = AsyncMock()
    mock_process.returncode = 147  # 403 % 256
    mock_process.communicate.return_value = (b"", b"Access denied.")
    mock_exec.return_value = mock_process

    with TestClient(app) as c:
        response = c.post("/chat", json={"message": "hello", "session_id": "test_403"})

    assert response.status_code == 403
    assert "Authentication error" in response.json()["detail"]
