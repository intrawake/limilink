"""Relocation orchestration/failure gates; SDK contract has a separate native smoke."""

import fcntl
import hashlib
import json
import os
from pathlib import Path

import pytest

from runtime_paths import assert_state_ready
from tool import relocate_state as move


def fingerprint(path):
    raw = path.read_bytes()
    rows = [json.loads(line) for line in raw.splitlines()]
    digest = hashlib.sha256(json.dumps(rows[1:]).encode()).hexdigest()
    return {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "entries": digest,
        "context": digest,
    }


@pytest.fixture
def setup(tmp_path, monkeypatch):
    old, new, package = (tmp_path / name for name in ("old", "new", "package"))
    old.mkdir()
    package.mkdir()
    (old / ".delivery-owner").touch()
    session = old / "session_a"
    journals = session / ".pi/agent/session"
    journals.mkdir(parents=True)
    source = journals / "original.jsonl"
    source.write_text(
        json.dumps(
            {"type": "session", "version": 3, "id": "fixture-id", "cwd": str(session)}
        )
        + "\n"
        + json.dumps(
            {
                "type": "message",
                "message": {"role": "user", "content": "original context"},
            }
        )
        + "\n"
    )
    (old / ".lease-session_a").touch()
    (old / ".execution-session_a").touch()
    (session / ".activity.json").write_text('{"fixture":"old observation"}')
    family = session / ".activity-sessions"
    family.mkdir()
    (family / "slot-000.json").write_text('{"state":"closed"}')
    (old / "channel_sessions.json").write_text('{"42":"session_a"}')
    (session / "chat_history.json").write_text('[{"role":"user","content":"keep me"}]')

    def fake_sdk(_package, mode, jobs):
        results = []
        for job in jobs:
            if mode == "verify":
                assert Path(job["file"]).exists()
                results.append(job["fingerprint"])
                continue
            path = Path(job["source"])
            result = fingerprint(path)
            if mode == "fork":
                assert result == job["expected"]
                target = Path(job["directory"])
                target.mkdir(exist_ok=True)
                rows = [json.loads(line) for line in path.read_text().splitlines()]
                rows[0].update(cwd=job["cwd"], parentSession=str(path))
                output = target / "fork.jsonl"
                output.write_text("".join(json.dumps(row) + "\n" for row in rows))
                result["file"] = str(output)
            results.append(result)
        return {"version": "fixture", "results": results}

    monkeypatch.setattr(move, "sdk", fake_sdk)
    return old, new, package, source


def snapshot(root):
    return {
        str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()
    }


def test_dry_run_is_nonmutating_and_roundtrip_keeps_latest_work(setup):
    old, new, package, source = setup
    before, inode = snapshot(old), (old / ".lease-session_a").stat().st_ino
    assert move.relocate(old, new, package)["state"] == "planned"
    assert snapshot(old) == before and not new.exists()
    report = move.relocate(old, new, package, apply=True, workers_finished=True)
    assert not old.exists() and report["state"] == "complete"
    row = report["sessions"][0]
    archived = new / row["original_archive"]
    assert archived.read_bytes() == before[str(source.relative_to(old))]
    assert (new / ".lease-session_a").stat().st_ino == inode
    assert (new / "channel_sessions.json").read_bytes() == before[
        "channel_sessions.json"
    ]
    assert not (new / "session_a/.activity-sessions").exists()
    assert (new / row["archive"] / ".activity-sessions/slot-000.json").exists()
    current = new / "session_a/.pi/agent/session/fork.jsonl"
    assert current.stat().st_mode & 0o777 == 0o600
    with current.open("a") as out:
        out.write(
            json.dumps(
                {
                    "type": "message",
                    "message": {"role": "user", "content": "post-move work"},
                }
            )
            + "\n"
        )
    latest = current.read_bytes()
    reverse = move.relocate(new, old, package, apply=True, workers_finished=True)
    assert (old / "session_a/.pi/agent/session/fork.jsonl").read_text().find(
        "post-move work"
    ) >= 0
    assert (old / reverse["sessions"][0]["original_archive"]).read_bytes() == latest
    assert_state_ready(old)


@pytest.mark.parametrize(
    "name", [".delivery-owner", ".lease-session_a", ".execution-session_a"]
)
def test_held_locks_refuse_without_mutation(setup, name):
    old, new, package, _ = setup
    before = snapshot(old)
    with (old / name).open("r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(BlockingIOError):
            move.relocate(old, new, package, apply=True, workers_finished=True)
    assert snapshot(old) == before and not new.exists()


@pytest.mark.parametrize("value", ["alive", "malformed"])
def test_service_pid_refuses(setup, value):
    old, new, package, _ = setup
    (old / "bot.pid").write_text(str(os.getpid()) if value == "alive" else "not a pid")
    with pytest.raises(ValueError):
        move.relocate(old, new, package)
    assert not (old / move.PENDING).exists()


def test_open_child_observer_and_wrong_cwd_refuse(setup):
    old, new, package, source = setup
    slot = old / "session_a/.activity-sessions/slot-000.json"
    slot.write_text('{"state":"idle"}')
    with pytest.raises(ValueError, match="not closed"):
        move.relocate(old, new, package)
    slot.write_text('{"state":"closed"}')
    rows = source.read_text().splitlines()
    header = json.loads(rows[0])
    header["cwd"] = "/foreign"
    source.write_text(json.dumps(header) + "\n" + rows[1] + "\n")
    with pytest.raises(ValueError, match="No Pi journal"):
        move.relocate(old, new, package)


@pytest.mark.parametrize(
    "kind",
    [
        "destination",
        "overlap",
        "nested-cwd",
        "symlink-lock",
        "symlink-journal",
        "symlink-archive",
    ],
)
def test_unsafe_paths_refuse(setup, monkeypatch, kind):
    old, new, package, source = setup
    if kind == "destination":
        new.mkdir()
    if kind == "overlap":
        new = old / "inside"
    if kind == "nested-cwd":
        monkeypatch.chdir(old / "session_a")
    if kind == "symlink-lock":
        path = old / ".delivery-owner"
        path.rename(old / "saved-lock")
        path.symlink_to("saved-lock")
    if kind == "symlink-journal":
        source.rename(source.with_name("saved"))
        source.symlink_to("saved")
    if kind == "symlink-archive":
        (old / "session_a/.relocation").symlink_to(package, target_is_directory=True)
    with pytest.raises((ValueError, OSError)):
        move.relocate(old, new, package, apply=True, workers_finished=True)
    assert not (old / move.PENDING).exists()


@pytest.mark.parametrize("stage", ["fork", "promote"])
def test_partial_failures_leave_interlock_and_do_not_rollback(
    setup, monkeypatch, stage
):
    old, new, package, _ = setup
    original_sdk, original_rename = move.sdk, move.os.rename

    def sdk(*args):
        if stage == "fork" and args[1] == "fork":
            raise RuntimeError("injected fork failure")
        return original_sdk(*args)

    def rename(source, target):
        if stage == "promote" and Path(source).name == "next-session":
            raise OSError("injected promotion failure")
        return original_rename(source, target)

    monkeypatch.setattr(move, "sdk", sdk)
    monkeypatch.setattr(move.os, "rename", rename)
    with pytest.raises((RuntimeError, OSError), match="injected"):
        move.relocate(old, new, package, apply=True, workers_finished=True)
    current = old if stage == "fork" else new
    assert current.exists() and (current / move.PENDING).exists()
    with pytest.raises(RuntimeError, match="incomplete"):
        assert_state_ready(current)
    other = new if current == old else old
    with pytest.raises(ValueError, match="Incomplete"):
        move.relocate(current, other, package, apply=True, workers_finished=True)


def test_syncs_archive_parent_before_completion(setup, monkeypatch):
    old, new, package, _ = setup
    calls = []
    original = move.sync

    def sync(path):
        calls.append(Path(path))
        original(path)

    monkeypatch.setattr(move, "sync", sync)
    report = move.relocate(old, new, package, apply=True, workers_finished=True)
    parent = (new / report["sessions"][0]["archive"]).parent
    assert parent in calls and calls.index(parent) < calls.index(new)


def test_initial_report_failure_reports_interlocked_root(setup, monkeypatch, capsys):
    old, new, package, _ = setup
    original = move.persist

    def persist(path, report):
        original(path, report)
        raise OSError("injected initial report sync failure")

    monkeypatch.setattr(move, "persist", persist)
    with pytest.raises(OSError, match="initial report"):
        move.relocate(old, new, package, apply=True, workers_finished=True)
    assert not new.exists()
    assert str(old / move.PENDING) in capsys.readouterr().err
    with pytest.raises(RuntimeError):
        assert_state_ready(old)


def test_final_sync_failure_reports_completed_path_without_fake_interlock(
    setup, monkeypatch, capsys
):
    old, new, package, _ = setup
    original = move.sync

    def sync(path):
        if (
            Path(path) == new
            and list(new.glob(".relocation-*.json"))
            and not (new / move.PENDING).exists()
        ):
            raise OSError("injected final sync failure")
        original(path)

    monkeypatch.setattr(move, "sync", sync)
    with pytest.raises(OSError, match="final sync"):
        move.relocate(old, new, package, apply=True, workers_finished=True)
    completed = next(new.glob(".relocation-*.json"))
    error = capsys.readouterr().err
    assert str(completed) in error and "interlock is absent" in error
    assert_state_ready(new)
    assert not old.exists()


def test_empty_sessions_and_ambiguous_mtimes(setup):
    old, new, package, source = setup
    (old / "session_empty").mkdir()
    assert len(move.relocate(old, new, package)["sessions"]) == 2
    duplicate = source.with_name("duplicate.jsonl")
    duplicate.write_bytes(source.read_bytes())
    os.utime(duplicate, ns=(source.stat().st_atime_ns, source.stat().st_mtime_ns))
    with pytest.raises(ValueError, match="Ambiguous"):
        move.relocate(old, new, package)
