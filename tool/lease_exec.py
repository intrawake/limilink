#!/usr/bin/env python3
"""Exec-only lease handoff for the supported Node-based Pi launcher.

Node/libuv marks FD 3 close-on-exec at startup, but its inherited-FD scan can
stop at a hole above FD 15. Move the lease into that protected range BEFORE
executing Pi; do not set CLOEXEC here, which would drop the lock from Pi itself.
This is a tested Node-runtime contract, not portable arbitrary-wrapper support.
Run with isolated Python (-I -S); never preexec_fn inside the threaded server.
"""

import os
import stat
import sys


def main(argv: list[str]) -> int:
    try:
        if len(argv) < 3 or argv[1] != "--":
            raise ValueError("Invalid lease handoff")
        fd = int(argv[0])
        if fd < 3 or not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Invalid lease descriptor")
        if fd != 3:
            os.dup2(fd, 3, inheritable=True)
            os.close(fd)
        else:
            os.set_inheritable(3, True)
        # Same PID, cwd, environment, stdio and open-file description/flock.
        # The configured launcher must exec Node, not spawn background workers
        # before Node initializes its descriptor inheritance policy.
        os.execvpe(argv[2], argv[2:], os.environ)
    except (OSError, ValueError):
        print("Could not start Pi with its session lease.", file=sys.stderr)
        return 126
    return 126  # exec never returns on success


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
