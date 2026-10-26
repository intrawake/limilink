#!/usr/bin/env python3
"""Run an isolated, seeded sidebar preview on localhost:11012 (no model access)."""

import argparse
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from contextlib import ExitStack
from unittest.mock import patch

import uvicorn


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fake-chat",
        action="store_true",
        help="Use delayed local echo replies for browser live-update checks",
    )
    parser.add_argument(
        "--history-size",
        type=int,
        default=1,
        help="Seed this many messages in session_c for recent-history checks (1–5000)",
    )
    args = parser.parse_args()
    if not 1 <= args.history_size <= 5000:
        parser.error("--history-size must be between 1 and 5000")
    with tempfile.TemporaryDirectory(prefix="limilink-sidebar-") as directory:
        root = Path(directory)
        sessions = root / "sessions"
        sessions.mkdir()
        for suffix in "abc":
            session = sessions / f"session_{suffix}"
            session.mkdir()
            (session / "chat_history.json").write_text(
                json.dumps([{"role": "bot", "content": f"History {suffix.upper()}"}])
            )
        if args.history_size > 1:
            long_history = [{"role": "bot", "content": "History C"}] + [
                {
                    "role": "bot" if index % 2 else "user",
                    "content": f"Fixture message {index}: "
                    + "Long conversation text. " * 12,
                }
                for index in range(1, args.history_size)
            ]
            (sessions / "session_c" / "chat_history.json").write_text(
                json.dumps(long_history)
            )
        (sessions / ".session-layout.json").write_text(
            json.dumps(
                {
                    "titles": {
                        "session_a": "Alpha",
                        "session_b": "Beta",
                        "session_c": "Gamma",
                    },
                    "order": ["session_a", "session_b", "session_c"],
                }
            )
        )
        config = root / "config.sxpb"
        config.write_text(
            "(agent_by_alias () (pi-test (harness pi) (model test-model)))\n"
            "(pi_agent_exepath /bin/false)\n"
        )
        os.environ["LIMILINK_CONFIG"] = str(config)
        os.environ["LIMILINK_SESSIONS_DIR"] = str(sessions)
        os.environ["OTEL_TRACES_EXPORTER"] = "none"
        os.environ["OTEL_LOGS_EXPORTER"] = "none"
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
        import main

        with ExitStack() as overrides:
            if args.fake_chat:
                active_replies: dict[str, asyncio.Event] = {}

                async def fake_chat(
                    session_id: str,
                    message: str,
                    lease_fd: int,
                    request_id: str | None = None,
                ) -> str:
                    path = str(sessions / session_id)
                    main.append_to_history(path, "user", message, request_id=request_id)
                    if message.strip() == "!stop":
                        active = active_replies.get(session_id)
                        if active is not None:
                            active.set()
                        reply = (
                            "Agent process stopped."
                            if active is not None
                            else "No active agent process found for this session."
                        )
                    else:
                        async with main.get_session_lock(session_id):
                            active = asyncio.Event()
                            active_replies[session_id] = active
                            try:
                                try:
                                    await asyncio.wait_for(active.wait(), timeout=3)
                                    reply = "Fixture reply stopped."
                                except TimeoutError:
                                    reply = f"Fixture reply: {message}"
                            finally:
                                if active_replies.get(session_id) is active:
                                    del active_replies[session_id]
                    main.append_to_history(path, "bot", reply)
                    return reply

                overrides.enter_context(patch.object(main, "_process_chat", fake_chat))
            uvicorn.run(main.app, host="127.0.0.1", port=11012)


if __name__ == "__main__":
    main()
