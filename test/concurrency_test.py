import pytest
import asyncio
import socket
import httpx
import multiprocessing
import time
import os
import stat
import uvicorn
from main import app


def get_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def run_server(port, test_sessions_dir, config_path):
    os.environ["LIMILINK_SESSIONS_DIR"] = test_sessions_dir
    os.environ["LIMILINK_CONFIG"] = config_path
    # Run uvicorn without reload so it runs in this very process cleanly
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="error")


@pytest.fixture
def slow_gemini_config(tmp_path):
    mock_gemini = tmp_path / "mock_gemini.sh"
    mock_gemini.write_text("#!/bin/bash\nsleep 1\necho 'mocked response'")
    mock_gemini.chmod(mock_gemini.stat().st_mode | stat.S_IEXEC)

    config_path = tmp_path / "config.sxpb"
    config_path.write_text(f'(gemini_exepath "{mock_gemini}")')

    return str(config_path)


@pytest.fixture
def test_server(test_sessions_dir, slow_gemini_config):
    port = get_free_port()
    proc = multiprocessing.Process(
        target=run_server,
        args=(port, test_sessions_dir, slow_gemini_config),
        daemon=True,
    )
    proc.start()

    # Wait for server to be ready
    for _ in range(30):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                break
        except (OSError, ConnectionRefusedError):
            time.sleep(0.1)

    yield port
    proc.terminate()
    proc.join()


@pytest.mark.asyncio
async def test_concurrency_lock_real_server(test_server):
    port = test_server

    async def fetch(client, i):
        response = await client.post(
            f"http://127.0.0.1:{port}/chat",
            json={"session_id": "test_concurrency_session", "message": f"Hello {i}"},
            timeout=10.0,
        )
        return response

    async with httpx.AsyncClient() as client:
        start_time = asyncio.get_event_loop().time()

        results = await asyncio.gather(fetch(client, 1), fetch(client, 2))

        end_time = asyncio.get_event_loop().time()

        assert results[0].status_code == 200
        assert results[1].status_code == 200
        assert "mocked response" in results[0].json()["reply"]
        assert "mocked response" in results[1].json()["reply"]

        # 2 requests taking 1 sec each, fully serialized, should take >= 2 secs
        assert (end_time - start_time) >= 2.0
