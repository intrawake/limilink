"""The CLI must not disguise failed startup as a successful service launch."""

import sys

from fastapi import FastAPI
import pytest

import server


def test_uvicorn_startup_failure_exit_is_preserved(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["server.py"])
    monkeypatch.setattr(server, "app", FastAPI())
    monkeypatch.setattr(server, "load_config", lambda: ({}, str(tmp_path)))
    monkeypatch.setattr(server, "get_sessions_dir", lambda *_: str(tmp_path / "state"))
    monkeypatch.setattr(server.signal, "signal", lambda *_: None)
    monkeypatch.setattr(server.atexit, "register", lambda *_: None)
    monkeypatch.setattr(server.otel_setup, "init_otel", lambda *_: None)

    class FailedStartup:
        def __init__(self, config):
            pass

        def run(self):
            raise SystemExit(3)

    monkeypatch.setattr(server.uvicorn, "Server", FailedStartup)
    with pytest.raises(SystemExit) as failure:
        server.main()
    assert failure.value.code == 3
