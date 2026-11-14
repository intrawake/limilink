import httpx
import pytest

from main import app


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
            == "No active agent process found for this session."
        )
