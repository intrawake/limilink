"""Kernel-owned session liveness, including an inherited agent after restart."""

import fcntl
import os
import stat
import sys
from contextlib import contextmanager
from pathlib import Path


def pi_lease_command(command: list[str], lease_fd: int) -> list[str]:
    """Relocate the lease in a fresh exec-only helper, never in the server."""
    helper = Path(__file__).resolve().parent.parent / "tool" / "lease_exec.py"
    return [sys.executable, "-I", "-S", str(helper), str(lease_fd), "--", *command]


class SessionLeaseBusy(RuntimeError):
    """A proxy request or agent process still owns this session."""


@contextmanager
def session_lease(root: Path, session_id: str, *, exclusive: bool = False):
    # Stable inode OUTSIDE the session directory. Never unlink these lock files:
    # replacing one could allow a second lock while an agent holds the old inode.
    if not session_id or "/" in session_id or session_id in (".", ".."):
        raise ValueError("Invalid session lease ID")
    root.mkdir(parents=True, exist_ok=True)
    fd = os.open(
        root / f".lease-{session_id}",
        os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
    )
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Session lease is not a regular file")
        operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        try:
            fcntl.flock(fd, operation | fcntl.LOCK_NB)
        except BlockingIOError:
            yield None
            return
        yield fd
    finally:
        # Do not LOCK_UN: an agent may share this open-file description through
        # pass_fds. Closing this copy must leave its inherited lock intact.
        os.close(fd)
