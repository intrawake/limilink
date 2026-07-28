import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from main import app


@pytest.mark.asyncio
async def test_concurrency_lock():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:

        async def slow_gemini(*args, **kwargs):
            await asyncio.sleep(0.5)
            mock_process = AsyncMock()
            mock_process.returncode = 0
            mock_process.communicate.return_value = (
                b"mocked response from gemini",
                b"",
            )
            return mock_process

        with patch("main.asyncio.create_subprocess_exec", side_effect=slow_gemini):
            req1 = client.post(
                "/chat", json={"session_id": "test_session", "message": "1"}
            )
            req2 = client.post(
                "/chat", json={"session_id": "test_session", "message": "2"}
            )

            start_time = asyncio.get_event_loop().time()
            _, _ = await asyncio.gather(req1, req2)
            end_time = asyncio.get_event_loop().time()

            # Since they are serialized, it should take at least 1 second total.
            assert end_time - start_time >= 1.0
