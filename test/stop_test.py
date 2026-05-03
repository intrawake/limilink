import pytest
from unittest.mock import patch, AsyncMock
import signal
import asyncio
import httpx
from main import app, running_processes


@pytest.mark.asyncio
async def test_stop_command_logic():
    session_id = "test_stop_session"

    # Mock the process
    mock_process = AsyncMock()
    mock_process.pid = 12345
    mock_process.returncode = -signal.SIGKILL

    # We want communicate to hang until we say so
    stop_event = asyncio.Event()

    async def mocked_communicate():
        await stop_event.wait()
        return b"", b""

    mock_process.communicate.side_effect = mocked_communicate

    transport = httpx.ASGITransport(app=app)
    with (
        patch("main.asyncio.create_subprocess_exec", return_value=mock_process),
        patch("os.killpg") as mock_killpg,
        patch("os.getpgid", return_value=54321),
    ):
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            # 1. Start a chat request (it will hang on communicate)
            chat_task = asyncio.create_task(
                ac.post(
                    "/chat", json={"message": "slow request", "session_id": session_id}
                )
            )

            # Wait a bit to ensure it's "running"
            await asyncio.sleep(0.1)
            assert session_id in running_processes

            # 2. Send !stop command
            stop_response = await ac.post(
                "/chat", json={"message": "!stop", "session_id": session_id}
            )

            assert stop_response.status_code == 200
            assert stop_response.json()["reply"] == "Gemini CLI process stopped."

            # Verify killpg was called with the right PGID
            mock_killpg.assert_called_once_with(54321, signal.SIGKILL)

            # Now allow the first request to finish (simulating it being killed)
            stop_event.set()

            chat_response = await chat_task
            assert chat_response.status_code == 200
            assert "terminated by signal 9" in chat_response.json()["reply"]

            # Verify it's removed from tracker
            assert session_id not in running_processes


@pytest.mark.asyncio
async def test_stop_command_no_process():
    session_id = "test_stop_no_proc_session"

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.post(
            "/chat", json={"message": "!stop", "session_id": session_id}
        )

        assert response.status_code == 200
        assert (
            response.json()["reply"]
            == "No active Gemini CLI process found for this session."
        )
