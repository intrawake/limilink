#!/usr/bin/env python3
"""Exec-only lease handoff for the supported Node-based Pi launcher.

Node/libuv marks low inherited FDs close-on-exec at startup, but its scan can
stop at a hole above FD 15. Move the lease and optional execution fence to
FDs 3/4 BEFORE executing Pi; CLOEXEC here would drop the locks from Pi itself.
This is a tested Node-runtime contract, not portable arbitrary-wrapper support.
Run with isolated Python (-I -S); never preexec_fn inside the threaded server.
"""

import fcntl
import os
import stat
import sys


def main(argv: list[str]) -> int:
    try:
        if len(argv) < 3 or argv[1] != "--":
            raise ValueError("Invalid lease handoff")
        descriptors = [int(value) for value in argv[0].split(",")]
        if not 1 <= len(descriptors) <= 2 or len(set(descriptors)) != len(descriptors):
            raise ValueError("Invalid ownership descriptors")
        for fd in descriptors:
            if fd < 3 or not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError("Invalid ownership descriptor")
        # Copy first: the incoming lease/fence may already occupy a destination.
        copies = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 64) for fd in descriptors]
        for fd in descriptors:
            os.close(fd)
        for destination, source in enumerate(copies, 3):
            os.dup2(source, destination, inheritable=True)
            os.close(source)
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
