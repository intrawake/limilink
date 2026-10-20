"""Bounded, single-command Pi compaction with ownership of its output pipe."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, BinaryIO

from session_lease import pi_lease_command

logger = logging.getLogger(__name__)
CHUNK_BYTES = 64 * 1024
MAX_LINE_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 32 * 1024 * 1024
RPC_TIMEOUT = 15 * 60
CLEANUP_TIMEOUT = 5


class CompactRPCError(RuntimeError):
    """A fixed public failure message, never a raw transport exception."""


def _response(line: bytes | bytearray) -> dict[str, Any] | None:
    try:
        event = json.loads(line)
    except (ValueError, UnicodeError):
        return None  # Bounded non-JSON startup chatter is not the response.
    except RecursionError:
        raise CompactRPCError("Compaction returned an invalid response.") from None
    if not isinstance(event, dict) or event.get("type") != "response":
        return None
    if event.get("command") != "compact":
        return None
    valid = isinstance(event.get("success"), bool)
    if event.get("success") is True:
        data = event.get("data")
        valid = valid and isinstance(data, dict)
        if isinstance(data, dict):
            valid = valid and isinstance(data.get("summary", ""), str)
            for key in ("tokensBefore", "estimatedTokensAfter"):
                if key in data:
                    valid = valid and type(data[key]) is int and data[key] >= 0
    else:
        valid = valid and isinstance(event.get("error", "unknown error"), str)
    if not valid:
        raise CompactRPCError("Compaction returned an invalid response.")
    return event


async def _read_response(
    reader: asyncio.StreamReader, max_line_bytes: int, max_output_bytes: int
) -> dict[str, Any] | None:
    pending = bytearray()
    received = 0
    while chunk := await reader.read(CHUNK_BYTES):
        received += len(chunk)
        if received > max_output_bytes:
            raise CompactRPCError("Compaction response exceeded the size limit.")
        parts = chunk.split(b"\n")
        for index, part in enumerate(parts):
            pending.extend(part)
            if len(pending) > max_line_bytes:
                raise CompactRPCError("Compaction response exceeded the size limit.")
            if index < len(parts) - 1:
                response = _response(pending)
                pending.clear()
                if response is not None:
                    return response
    return _response(pending) if pending else None


async def _settle(task: asyncio.Task[None], cancelled: bool) -> None:
    """Retain cleanup despite repeated cancellation, then propagate cancellation."""
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
        except Exception:
            break  # Retrieve the failure below, without swallowing cancellation.
    # Retrieve cleanup failures even if cancellation raced its completion.
    error = task.exception() if not task.cancelled() else None
    if cancelled:
        if error:
            logger.warning("Compact RPC cleanup failed during cancellation")
        raise asyncio.CancelledError
    task.result()


async def compact_rpc(
    command: list[str],
    *,
    lease_fd: int,
    cwd: str,
    env: dict[str, str],
    instructions: str | None = None,
    timeout: float = RPC_TIMEOUT,
    cleanup_timeout: float = CLEANUP_TIMEOUT,
    max_line_bytes: int = MAX_LINE_BYTES,
    max_output_bytes: int = MAX_OUTPUT_BYTES,
) -> dict[str, Any] | None:
    """No retries or descendant signals. OS launch stalls have no hard time bound.

    Stdout belongs to this helper, not Process: closing its public read transport
    does not wait for descendant-held pipe ends. Stderr is unused and discarded.
    """
    request = {"type": "compact"}
    if instructions:
        request["customInstructions"] = instructions
    payload = (json.dumps(request) + "\n").encode()
    if len(payload) > max_line_bytes:
        raise CompactRPCError("Compaction instructions exceeded the size limit.")

    read_fd: int | None = None
    write_fd: int | None = None
    source: BinaryIO | None = None
    output: asyncio.ReadTransport | None = None
    spawn: asyncio.Task[asyncio.subprocess.Process] | None = None

    async def cleanup() -> None:
        process = None
        try:
            if spawn is not None:
                # Cancellation during acquisition cannot discard a future child.
                # Keep the caller's lease alive until launch resolves.
                try:
                    process = await spawn
                except (Exception, asyncio.CancelledError):
                    pass  # The interaction already reports launch failure.
        finally:
            if write_fd is not None:
                os.close(write_fd)
            if output is not None:
                output.close()
            if source is not None:
                source.close()
            elif read_fd is not None:
                os.close(read_fd)
        if process is None:
            return
        if process.stdin is not None and not process.stdin.transport.is_closing():
            # Discard pending input; neither descendants nor a stopped reader
            # may hold cleanup hostage waiting for stdin to flush.
            process.stdin.transport.abort()
        try:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass  # It exited between returncode and kill(); still reap.
            async with asyncio.timeout(cleanup_timeout):
                await process.wait()
        except (TimeoutError, OSError):
            logger.warning("Compact RPC cleanup unconfirmed (pid %s)", process.pid)
            raise CompactRPCError(
                "Compaction process cleanup could not be confirmed."
            ) from None

    cancelled = False
    try:
        async with asyncio.timeout(timeout):
            read_fd, write_fd = os.pipe()
            source = os.fdopen(read_fd, "rb", buffering=0)
            read_fd = None  # Owned by source from here onward.
            reader = asyncio.StreamReader()
            output, _ = await asyncio.get_running_loop().connect_read_pipe(
                lambda: asyncio.StreamReaderProtocol(reader), source
            )
            spawn = asyncio.create_task(
                asyncio.create_subprocess_exec(
                    *pi_lease_command(command, lease_fd),
                    pass_fds=(lease_fd,),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=write_fd,
                    stderr=asyncio.subprocess.DEVNULL,
                    cwd=cwd,
                    env=env,
                )
            )
            process = await asyncio.shield(spawn)
            os.close(write_fd)
            write_fd = None
            if process.stdin is None:
                raise CompactRPCError("Compaction could not start.")
            process.stdin.write(payload)
            await process.stdin.drain()
            return await _read_response(reader, max_line_bytes, max_output_bytes)
    except asyncio.CancelledError:
        cancelled = True
        raise
    except TimeoutError:
        raise CompactRPCError("Compaction timed out.") from None
    except (OSError, ValueError):
        raise CompactRPCError("Compaction could not complete.") from None
    finally:
        await _settle(asyncio.create_task(cleanup()), cancelled)
