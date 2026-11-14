"""Activity receives the same exact existing journal the CLI is told to open."""

import json
import os

import pytest

import main
from pi_session import continued_session_identity


def journal(owner, name="root", identity="root-id", **extra):
    directory = owner / ".pi/agent/session"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (name + ".jsonl")
    path.write_text(
        json.dumps(
            {
                "type": "session",
                "version": 3,
                "id": identity,
                "cwd": str(owner),
                **extra,
            }
        )
        + "\n"
    )
    return path


def test_launch_pins_existing_fork_for_cli_and_observer(tmp_path):
    owner = tmp_path / "session"
    path = journal(owner, parentSession="/old/root.jsonl")
    args, env = (
        [],
        {
            "LIMILINK_ACTIVITY_ROOT_FILE": "/inherited",
            "LIMILINK_ACTIVITY_ROOT_ID": "foreign",
        },
    )
    main._add_activity_observer(args, env, str(owner))
    assert args[args.index("--session") + 1] == str(path)
    assert "--continue" not in args
    assert env["LIMILINK_ACTIVITY_ROOT_FILE"] == str(path)
    assert env["LIMILINK_ACTIVITY_ROOT_ID"] == "root-id"


def test_new_or_uncertain_session_keeps_native_discovery_and_clears_pin(tmp_path):
    owner = tmp_path / "session"
    owner.mkdir()
    for corrupt in [
        None,
        "{}\n",
        "\n"
        + json.dumps({"type": "session", "id": "root-id", "cwd": str(owner)})
        + "\n",
    ]:
        if corrupt is not None:
            path = journal(owner)
            path.write_text(corrupt)
        args, env = (
            [],
            {"LIMILINK_ACTIVITY_ROOT_FILE": "/old", "LIMILINK_ACTIVITY_ROOT_ID": "old"},
        )
        main._add_activity_observer(args, env, str(owner))
        assert "--continue" in args and "--session" not in args
        assert (
            "LIMILINK_ACTIVITY_ROOT_FILE" not in env
            and "LIMILINK_ACTIVITY_ROOT_ID" not in env
        )


def test_matching_cwd_and_sdk_mtime_order_are_required(tmp_path):
    owner = tmp_path / "session"
    first = journal(owner, "first", "first-id")
    latest = journal(owner, "latest", "latest-id")
    foreign = journal(owner, "foreign", "foreign-id", cwd="/another/session")
    stamp = first.stat().st_mtime - 10
    os.utime(first, (stamp, stamp))
    assert foreign.exists() and continued_session_identity(owner) == (
        latest,
        "latest-id",
    )
    os.utime(first, ns=(latest.stat().st_atime_ns, latest.stat().st_mtime_ns))
    assert continued_session_identity(owner) is None


@pytest.mark.parametrize(
    "kind", ["unsupported-id", "symlink", "invalid-JSON", "oversized"]
)
def test_uncertain_newer_file_never_changes_continuation_to_older_one(tmp_path, kind):
    owner = tmp_path / "session"
    older = journal(owner, "older")
    newer = journal(
        owner, "newer", "unsupported.id" if kind == "unsupported-id" else "new-id"
    )
    stamp = older.stat().st_mtime - 10
    os.utime(older, (stamp, stamp))
    if kind == "symlink":
        copy = newer.with_name("saved")
        newer.rename(copy)
        newer.symlink_to(copy.name)
    elif kind == "invalid-JSON":
        newer.write_text("{broken\n")
    elif kind == "oversized":
        newer.write_text(" " * (1024 * 1024 + 1))
    assert continued_session_identity(owner) is None
