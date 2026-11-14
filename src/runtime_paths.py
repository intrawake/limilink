"""Filesystem locations shared by the server, Discord bridge and CLI helpers."""

from __future__ import annotations

import os
from typing import Any


def config_path() -> str:
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.environ.get(
        "LIMILINK_CONFIG", os.path.join(base, "limilink", "config.sxpb")
    )


def assert_state_ready(root) -> None:
    marker = os.path.join(root, ".relocation-pending.json")
    if os.path.lexists(marker):
        raise RuntimeError(
            f"Session relocation is incomplete; inspect {marker}; do not start services"
        )


def get_sessions_dir(cfg: dict[Any, Any], config_dir: str) -> str:
    explicit = os.environ.get("LIMILINK_SESSIONS_DIR")
    if explicit:
        return os.path.abspath(explicit)

    configured = cfg.get("session_dirpath")
    if configured:
        configured = os.path.expanduser(configured)
        if not os.path.isabs(configured):
            configured = os.path.normpath(os.path.join(config_dir, configured))
        return configured

    base = os.environ.get("XDG_STATE_HOME", "")
    # XDG base directories must be absolute; relative/empty values are unset.
    if not os.path.isabs(base):
        base = os.path.expanduser("~/.local/state")
    return os.path.join(base, "limilink", "sessions")
