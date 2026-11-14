#!/usr/bin/env python3
"""Explicit, same-filesystem session-root cutover. Dry-run unless --apply.

Stop both services and all session writers first. Rollback is the same command
with roots reversed, using the current authoritative tree. No service controls,
config edits, journal header rewrites, automatic recovery, or provider calls.
"""

from contextlib import ExitStack
import argparse
import fcntl
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

PENDING = ".relocation-pending.json"
ACTIVITY = (".activity.json", ".activity.json.tmp", ".activity-sessions")


def regular(path):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError(f"Not a regular file: {path}")


def directory(path):
    if not stat.S_ISDIR(path.lstat().st_mode):
        raise ValueError(f"Not a canonical directory: {path}")


def json_file(path):
    regular(path)
    return json.loads(path.read_text())


def sdk(package, mode, jobs):
    result = subprocess.run(
        ["node", str(Path(__file__).with_name("relocate_pi.mjs"))],
        input=json.dumps({"package": str(package), "mode": mode, "jobs": jobs}),
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"Pi SDK {mode} failed: {result.stderr.strip()}")
    return json.loads(result.stdout)


def sync(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def persist(path, report):
    temporary = path.with_name(path.name + ".tmp")
    with open(
        temporary, "x", opener=lambda p, flags: os.open(p, flags, 0o600)
    ) as output:
        json.dump(report, output, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def stopped(root):
    for name in ("server.pid", "bot.pid"):
        path = root / name
        if not path.exists() and not path.is_symlink():
            continue
        regular(path)
        value = path.read_text().strip()
        if not value.isdecimal() or int(value) < 1:
            raise ValueError(f"Malformed service PID marker: {path}")
        try:
            os.kill(int(value), 0)
        except ProcessLookupError:
            continue
        # PermissionError deliberately refuses, never means 'not running'.
        raise ValueError(f"Service PID {value} may still be alive: {path}")


def inspect_session(session, old_root, new_root):
    activity = []
    for name in ACTIVITY:
        path = session / name
        if path.is_symlink():
            raise ValueError(f"Symlinked Activity control: {path}")
        if path.exists():
            directory(path) if name == ".activity-sessions" else regular(path)
            activity.append(name)
    family = session / ".activity-sessions"
    if family.exists():
        directory(family)
        for slot in family.glob("slot-*.json"):
            observation = json_file(slot)
            if (
                not isinstance(observation, dict)
                or observation.get("state") != "closed"
            ):
                raise ValueError(
                    f"Child observer is not closed; inspect before cutover: {slot}"
                )
    if (session / ".relocation").is_symlink():
        raise ValueError(f"Symlinked relocation archive: {session}")
    journals = session / ".pi/agent/session"
    for parent in (session / ".pi", session / ".pi/agent", journals):
        if parent.is_symlink():
            raise ValueError(f"Symlinked Pi journal ancestor: {parent}")
        if parent.exists():
            directory(parent)
    matches, files = [], list(journals.glob("*.jsonl"))
    for path in files:
        regular(path)
        with path.open() as source:
            header = json.loads(source.readline(1024 * 1024))
        if not isinstance(header, dict) or header.get("type") != "session":
            raise ValueError(f"Invalid Pi header: {path}")
        cwd = header.get("cwd")
        if isinstance(cwd, str) and os.path.normpath(cwd) == str(session):
            seconds, nanos = divmod(path.stat().st_mtime_ns, 1_000_000_000)
            # Match the SDK's millisecond clock; ties refuse instead of guessing.
            matches.append((seconds * 1000 + nanos / 1_000_000, path, header))
    if files and not matches:
        raise ValueError(f"No Pi journal matches current cwd: {session}")
    if (
        len(matches) > 1
        and sorted(row[0] for row in matches)[-1]
        == sorted(row[0] for row in matches)[-2]
    ):
        raise ValueError(f"Ambiguous most-recent Pi journal: {session}")
    item = {"session": session.name, "activity": activity}
    if matches:
        _, source, header = max(matches)
        item.update(
            source=str(source.relative_to(old_root)),
            id=header["id"],
            cwd=str(new_root / session.name),
        )
    return item


def relocate(old, new, package, *, apply=False, workers_finished=False):
    # Resolve beforehand, but never follow a symlink used as either root.
    old, new, package = (Path(os.path.abspath(p)) for p in (old, new, package))
    directory(old)
    if old.is_symlink() or new.is_symlink():
        raise ValueError("Root symlinks are unsupported")
    old = old.resolve()
    new = new.parent.resolve(strict=True) / new.name
    package = package.resolve(strict=True)
    if new.exists() or old == new or old in new.parents or new in old.parents:
        raise ValueError("Destination must be absent and roots must not overlap")
    if old.stat().st_dev != new.parent.stat().st_dev:
        raise ValueError(
            "Cross-filesystem moves are unsupported; no copy was attempted"
        )
    if (
        Path.cwd() == old
        or old in Path.cwd().parents
        or package == old
        or old in package.parents
    ):
        raise ValueError(
            "Invocation cwd and Pi package must be outside the moving root"
        )
    if (old / PENDING).exists() or (old / PENDING).is_symlink():
        raise ValueError(
            f"Incomplete relocation: inspect {old / PENDING}; do not restart"
        )
    if apply and not workers_finished:
        raise ValueError(
            "--apply requires --workers-finished after stopping both services and all child/manual writers"
        )
    if os.geteuid() == 0:
        raise ValueError("Run as the state owner, not root")
    if old.stat().st_uid != os.geteuid():
        raise ValueError("Session root belongs to another account")
    with ExitStack() as locks:
        owner = old / ".delivery-owner"
        regular(owner)  # A real initialized root has this stable lock inode.
        paths = (
            [owner] + sorted(old.glob(".lease-*")) + sorted(old.glob(".execution-*"))
        )
        for path in paths:
            regular(path)
            fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
            locks.callback(os.close, fd)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise BlockingIOError(f"Held writer lock: {path}") from error
        stopped(old)
        items = []
        for path in sorted(old.iterdir()):
            if path.name.startswith(".initializing-"):
                raise ValueError(f"Unfinished session initialization: {path}")
            if path.is_symlink():
                raise ValueError(f"Symlinked root entry: {path}")
            if path.is_dir():
                if not path.name or any(
                    not (c.isalnum() or c in "-_") for c in path.name
                ):
                    raise ValueError(f"Unexpected directory in session root: {path}")
                items.append(inspect_session(path, old, new))
        jobs = [
            dict(source=str(old / row["source"]), id=row["id"])
            for row in items
            if "source" in row
        ]
        checked = sdk(package, "inspect", jobs)
        for row, result in zip(
            (r for r in items if "source" in r), checked["results"], strict=True
        ):
            row["expected"] = result
        operation = uuid.uuid4().hex
        for row in items:
            row["archive"] = str(Path(row["session"]) / ".relocation" / operation)
        report = {
            "version": 1,
            "operation": operation,
            "from": str(old),
            "to": str(new),
            "pi_version": checked["version"],
            "sessions": items,
            "state": "planned",
        }
        if not apply:
            return report
        root = old
        marker = root / PENDING
        report["state"] = "pending"
        try:
            persist(marker, report)  # Startup interlock before ANY staging mutation.
            for row in items:
                archive = old / row["archive"]
                archive.mkdir(mode=0o700, parents=True, exist_ok=False)
                if "source" in row:
                    stage = archive / "next-session"
                    stage.mkdir(mode=0o700)
                    result = sdk(
                        package,
                        "fork",
                        [
                            dict(
                                source=str(old / row["source"]),
                                id=row["id"],
                                cwd=row["cwd"],
                                directory=str(stage),
                                expected=row["expected"],
                            )
                        ],
                    )["results"][0]
                    fork = Path(result["file"])
                    if fork.parent != stage or not fork.is_file():
                        raise ValueError(
                            "SDK returned an unexpected staged journal path"
                        )
                    fork.chmod(0o600)
                    sync(fork)
                    sync(stage)
                    row["fork_name"] = fork.name
                row["progress"] = "staged"
                persist(marker, report)
            os.rename(old, new)
            root, marker = new, new / PENDING
            sync(old.parent)
            sync(new.parent)
            for row in items:
                session, archive = new / row["session"], new / row["archive"]
                if "source" in row:
                    active = session / ".pi/agent/session"
                    os.rename(active, archive / "previous-session")
                    os.rename(archive / "next-session", active)
                    row["original_archive"] = str(
                        (
                            archive / "previous-session" / Path(row["source"]).name
                        ).relative_to(new)
                    )
                    fingerprint = {
                        key: row["expected"][key] for key in ("entries", "context")
                    }
                    sdk(
                        package,
                        "verify",
                        [
                            dict(
                                cwd=row["cwd"],
                                directory=str(active),
                                id=row["id"],
                                file=str(active / row["fork_name"]),
                                fingerprint=fingerprint,
                            )
                        ],
                    )
                for name in row["activity"]:
                    os.rename(session / name, archive / name)
                sync(archive)
                sync(archive.parent)
                sync(session)
                if "source" in row:
                    sync(session / ".pi/agent")
                row["progress"] = "complete"
                persist(marker, report)
            report["state"] = "complete"
            persist(marker, report)
            completed = root / f".relocation-{operation}.json"
            os.rename(marker, completed)
            marker = completed  # Diagnostic pointer must follow the committed rename.
            sync(root)
            report["report"] = str(completed)
            return report
        except BaseException:
            status = (
                "Final durability confirmation failed; data promotion is complete and the pending startup interlock is absent."
                if marker.name != PENDING
                else "Relocation incomplete; inspect the pending report/interlock."
            )
            print(
                f"{status} DO NOT RESTART. Root: {root}; report: {marker}. No automatic rollback was attempted.",
                file=sys.stderr,
            )
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--pi-package", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--workers-finished", action="store_true")
    args = parser.parse_args()
    try:
        report = relocate(
            args.source,
            args.destination,
            args.pi_package,
            apply=args.apply,
            workers_finished=args.workers_finished,
        )
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        print(f"Refused/failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
