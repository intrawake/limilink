from fastapi.testclient import TestClient
from main import app
from unittest.mock import patch, AsyncMock
import pytest


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_thought_strip(mock_exec):
    mock_process = AsyncMock()
    mock_process.returncode = 0

    text = 'I am currently thinking about saying hello.\n[Thought: true]hello!\nThat seems sufficient to fulfill the request. Wait, I should say "world!" too.\n[Thought: true]world!'
    mock_process.communicate.return_value = (text.encode(), b"")
    mock_exec.return_value = mock_process

    session_id = "test_thought_strip_session"

    with TestClient(app) as c:
        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200
        assert response.json()["reply"] == "hello!\nworld!"


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_thought_strip_embedded(mock_exec):
    mock_process = AsyncMock()
    mock_process.returncode = 0

    text = "This is a test [Thought: true] embedded in a line."
    mock_process.communicate.return_value = (text.encode(), b"")
    mock_exec.return_value = mock_process

    session_id = "test_thought_strip_embedded_session"

    with TestClient(app) as c:
        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200
        assert response.json()["reply"] == text


@pytest.mark.asyncio
@patch("main.asyncio.create_subprocess_exec")
async def test_thought_strip_start(mock_exec):
    mock_process = AsyncMock()
    mock_process.returncode = 0

    text = "[Thought: true]hello!\nThat seems sufficient.\n[Thought: true]world!"
    mock_process.communicate.return_value = (text.encode(), b"")
    mock_exec.return_value = mock_process

    session_id = "test_thought_strip_start_session"

    with TestClient(app) as c:
        response = c.post("/chat", json={"message": "hello", "session_id": session_id})
        assert response.status_code == 200
        assert response.json()["reply"] == "[Thought: true]hello!\nworld!"
