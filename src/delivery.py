"""Single-root operation owner. Files survive restart; work is never resumed.

Kernel locks, not the HTTP task, own writer exclusion. This is deliberately a
single-service, process-restart contract, not a distributed/durable broker.
"""

from __future__ import annotations

import asyncio
import contextvars
import fcntl
import json
import os
import re
import signal
import stat
import uuid
from collections import deque
from contextlib import ExitStack
from pathlib import Path
from typing import Callable

from fastapi import HTTPException

from send_receipt import SendConflict, SendIndeterminate, read_send, receipt_path
from recovery import Recovery, acknowledged, read_ledger

TERMINAL = {
    "succeeded",
    "failed",
    "cancelled",
    "interrupted_not_started",
    "indeterminate",
}
STATES = TERMINAL | {"queued", "running"}
current_attempt: contextvars.ContextVar[Attempt | None] = contextvars.ContextVar(
    "delivery_attempt", default=None
)
projecting: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "delivery_projecting", default=False
)


class ExecutionUncertain(RuntimeError):
    """Effects/configuration or writer settlement cannot safely be confirmed."""


def lock_file(path: Path) -> int | None:
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Owner lock is not a regular file")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            return None
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_operation(path: Path) -> dict:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        with os.fdopen(fd) as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise ValueError("Operation is not a regular file")
            record = json.load(source)
        if (
            not isinstance(record, dict)
            or record.get("version") != 2
            or record.get("id") != path.stem
            or not re.fullmatch(r"[0-9a-f]{32}", record["id"])
            or not isinstance(record.get("session_id"), str)
            or record["session_id"] != path.parent.parent.name
            or not isinstance(record.get("message"), str)
            or "execution_id" not in record
            or "outcome" not in record
            or type(record.get("sequence")) is not int
            or record["sequence"] < 0
            or type(record.get("revision")) is not int
            or record["revision"] < 0
            or record.get("state") not in STATES
            or not (
                record.get("execution_id") is None
                or isinstance(record["execution_id"], str)
            )
        ):
            raise ValueError("Invalid operation identity/state")
        outcome = record.get("outcome")
        if outcome is not None and (
            not isinstance(outcome, dict)
            or type(outcome.get("status")) is not int
            or not isinstance(outcome.get("body"), dict)
        ):
            raise ValueError("Invalid operation outcome")
        if record["state"] in {"succeeded", "failed"} and outcome is None:
            raise ValueError("Missing operation outcome")
        if outcome is not None:
            status, body = outcome["status"], outcome["body"]
            if not (
                (status == 200 and isinstance(body.get("reply"), str))
                or (400 <= status <= 599 and "detail" in body)
            ):
                raise ValueError("Invalid operation outcome body")
            if (record["state"] == "succeeded" and status != 200) or (
                record["state"] == "failed" and status == 200
            ):
                raise ValueError("Outcome disagrees with terminal state")
        if record["state"] == "running" and record["execution_id"] is None:
            raise ValueError("Missing execution identity")
        if record["state"] in ("queued", "running") and outcome is not None:
            raise ValueError("Nonterminal operation has an outcome")
        if record["state"] == "queued" and record["execution_id"] is not None:
            raise ValueError("Queued operation already has an execution identity")
        return record
    except FileNotFoundError:
        raise
    except (OSError, ValueError, TypeError, KeyError, RecursionError) as exc:
        raise SendIndeterminate(
            "Operation receipt cannot be verified; it will not be executed again."
        ) from exc


def write_operation(path: Path, record: dict, *, create: bool = False):
    if create:
        # A partial acceptance remains as a tombstone: never execute an ID whose
        # acceptance could not be proved, even if the write returned an error.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(record, output)
        return
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(record, output)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def public(record: dict) -> dict:
    result = {
        key: record[key]
        for key in (
            "id",
            "session_id",
            "sequence",
            "revision",
            "state",
            "message",
            "execution_id",
            "outcome",
        )
    }
    if result["outcome"] is not None:
        body = result["outcome"]["body"]
        if "detail" in body and not isinstance(body["detail"], str):
            result["outcome"] = {
                **result["outcome"],
                "body": {**body, "detail": json.dumps(body["detail"])},
            }
    return result


class Attempt:
    def __init__(self, execution_id: str, fence_fd: int, root: Path):
        self.id = execution_id
        self.fence_fd = fence_fd
        self.root = root
        self.process = None
        self.compact = False
        self.stop_requested = False
        self.stops: list[dict] = []
        self.signal_error: Exception | None = None

    def register(self, process, *, compact=False):
        self.process = process
        self.compact = compact
        if self.stop_requested:
            self.signal()

    def signal(self):
        process = self.process
        if process is None or process.returncode is not None:
            return
        try:
            if self.compact:
                process.kill()  # Preserve compact's direct-child signal scope.
            else:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError as exc:
            self.signal_error = exc

    def stop(self):
        self.stop_requested = True
        self.signal()


class Lane:
    def __init__(self):
        self.sequence = 0
        self.queue: deque[tuple[dict, ExitStack, int]] = deque()
        self.task: asyncio.Task | None = None
        self.active: Attempt | None = None
        self.paused = False
        self.futures: dict[str, asyncio.Future] = {}
        self.unpersisted: dict[str, dict] = {}


class DeliveryOwner:
    def __init__(
        self,
        root: Path,
        execute: Callable,
        admission: Callable,
        project: Callable,
        recovery_context: Callable | None = None,
        recovery_admission: Callable | None = None,
    ):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        fd = lock_file(self.root / ".delivery-owner")
        if fd is None:
            raise RuntimeError(
                "Another delivery service already owns this sessions root"
            )
        self.fd: int = fd
        self.loop = asyncio.get_running_loop()
        self.execute = execute
        self.admission = admission
        self.project = project
        self.lanes: dict[str, Lane] = {}
        self.closed = False
        self.recovery = Recovery(
            self,
            recovery_context or (lambda path, records: {"summary": {}}),
            recovery_admission or admission,
        )
        try:
            # Recover/classify everything at startup, not upon an eventual retry.
            for session in self.root.iterdir():
                if (
                    session.is_dir()
                    and not session.is_symlink()
                    and (session / ".web-requests").exists()
                ):
                    self.lane(session.name)
        except BaseException:
            os.close(self.fd)
            self.closed = True
            raise

    def validate_session(self, session_id: str, *, create=False):
        if not session_id or any(not (c.isalnum() or c in "-_") for c in session_id):
            raise HTTPException(400, "Invalid session ID")
        path = self.root / session_id
        if path.is_symlink():
            raise HTTPException(400, "Session must be a canonical directory")
        if not path.is_dir() and not create:
            raise HTTPException(404, "Session no longer exists; message not accepted")

    def path(self, sid, rid, *, create=False):
        return receipt_path(self.root / sid, rid, create=create)

    def lane(self, sid) -> Lane:
        if sid in self.lanes:
            return self.lanes[sid]
        lane = Lane()
        self.lanes[sid] = lane
        directory = self.root / sid / ".web-requests"
        if directory.is_symlink():
            lane.paused = True
            return lane
        records = []
        try:
            ledger = read_ledger(self.root, sid)
        except (OSError, ValueError, TypeError):
            lane.paused = True
            ledger = {"acknowledged": {}}
        seen = set()
        for path in directory.glob("*.json"):
            seen.add(path.stem)
            try:
                record = read_operation(path)
                records.append(record)
                lane.sequence = max(lane.sequence, record["sequence"] + 1)
                if record["state"] in ("queued", "running"):
                    state = (
                        "interrupted_not_started"
                        if record["state"] == "queued"
                        else "indeterminate"
                    )
                    self.transition(
                        record,
                        state,
                        {
                            "status": 409,
                            "body": {
                                "detail": "Service interrupted; this operation will not resume automatically."
                            },
                        },
                    )
                if record["state"] == "indeterminate" and not acknowledged(
                    ledger, record["id"], path
                ):
                    lane.paused = True
            except (OSError, ValueError):
                try:
                    legacy = read_send(path)
                    if legacy["state"] != "complete":
                        lane.paused = lane.paused or not acknowledged(
                            ledger, path.stem, path
                        )
                except (OSError, ValueError):
                    lane.paused = True
        if not set(ledger["acknowledged"]).issubset(seen):
            lane.paused = True
        # Rebuild only projections, never execution. Even this session mutation
        # must not overlap a writer inherited across the old service's death.
        fence = lock_file(self.root / f".execution-{sid}")
        if fence is None:
            lane.paused = True
        else:
            try:
                for record in sorted(records, key=lambda r: r["sequence"]):
                    if (
                        record["state"] in TERMINAL
                        and record["state"] != "indeterminate"
                    ):
                        self.project(record)
            except (OSError, ValueError, ExecutionUncertain):
                lane.paused = True
            finally:
                os.close(fence)
        return lane

    def busy(self, sid):
        lane = self.lanes.get(sid)
        return bool(lane and (lane.active or lane.queue or lane.paused))

    def transition(self, record, state, outcome=None):
        updated = {
            **record,
            "state": state,
            "revision": record["revision"] + 1,
            "outcome": outcome,
        }
        write_operation(self.path(record["session_id"], record["id"]), updated)
        record.update(updated)

    def lookup(self, sid, rid):
        self.validate_session(sid)
        lane = self.lane(sid)
        if rid in lane.unpersisted:
            return lane.unpersisted[rid]
        path = self.path(sid, rid)
        try:
            record = read_operation(path)
            if record["state"] == "indeterminate" and not acknowledged(
                read_ledger(self.root, sid), rid, path
            ):
                lane.paused = True
            return record
        except SendIndeterminate:
            try:
                legacy = read_send(path)
                if legacy["state"] != "complete" and not acknowledged(
                    read_ledger(self.root, sid), rid, path
                ):
                    lane.paused = True
            except (OSError, ValueError):
                lane.paused = True
            raise

    def listing(self, sid, ids):
        self.validate_session(sid)
        self.lane(sid)
        if ids:
            records = []
            for rid in ids:
                try:
                    records.append(self.lookup(sid, rid))
                except FileNotFoundError:
                    pass
                except SendIndeterminate:
                    path = self.path(sid, rid)
                    if read_send(path)["state"] != "complete" and not acknowledged(
                        read_ledger(self.root, sid), rid, path
                    ):
                        raise
        else:
            records = []
            for path in (self.root / sid / ".web-requests").glob("*.json"):
                try:
                    records.append(self.lookup(sid, path.stem))
                except SendIndeterminate:
                    # Legacy completed receipts have no exact message/sequence;
                    # keep their read-only legacy projection, not invented OPs.
                    if read_send(path)["state"] != "complete" and not acknowledged(
                        read_ledger(self.root, sid), path.stem, path
                    ):
                        raise
            terminals = sorted(
                (r for r in records if r["state"] in TERMINAL),
                key=lambda r: r["sequence"],
            )[-64:]
            records = [r for r in records if r["state"] not in TERMINAL] + terminals
        return [public(r) for r in sorted(records, key=lambda r: r["sequence"])]

    def admit(self, sid, rid, message, limit=16, *, create=False):
        if self.closed:
            raise HTTPException(503, "Service is shutting down; message not accepted")
        self.validate_session(sid, create=create)
        lane = self.lane(sid)
        stack = ExitStack()
        try:
            lease_fd = stack.enter_context(self.admission(self.root, sid))
            if create:
                (self.root / sid).mkdir(exist_ok=True)
            path = self.path(sid, rid, create=True)
            try:
                existing = self.lookup(sid, rid)
            except FileNotFoundError:
                existing = None
            if existing is not None:
                if existing["message"] != message:
                    raise SendConflict(
                        "This operation ID is already bound to a different message"
                    )
                return existing, False
            stop = message.strip() == "!stop"
            if lane.paused and not stop:
                raise HTTPException(
                    409,
                    "Session execution is indeterminate/paused; message not accepted. Explicit recovery is required.",
                )
            # Reserve one active slot even before the worker's first scheduling turn.
            waiting = max(0, len(lane.queue) - 1)
            if not stop and waiting >= limit:
                raise HTTPException(
                    429,
                    f"Session queue is full ({limit} waiting); message not accepted. Keep your text and try explicitly later.",
                )
            record = dict(
                version=2,
                id=rid,
                session_id=sid,
                sequence=lane.sequence,
                revision=0,
                state="queued",
                message=message,
                execution_id=None,
                outcome=None,
            )
            if stop:
                record["stop_target"] = lane.active.id if lane.active else None
            try:
                write_operation(path, record, create=True)
            except (OSError, ValueError, TypeError):
                lane.paused = True
                raise SendIndeterminate(
                    "Acceptance could not be persisted; do not automatically resend."
                ) from None
            lane.sequence += 1
            lane.futures[rid] = self.loop.create_future()
            if stop:
                record["execution_id"] = uuid.uuid4().hex
                try:
                    self.transition(record, "running")
                except (OSError, ValueError, TypeError):
                    self.uncertain(
                        lane,
                        record,
                        "Stop start could not be persisted; target was not signalled.",
                    )
                    return record, True
                # Register and signal synchronously with admission: never capture
                # a successor after an await or replay.
                if lane.active:
                    lane.active.stops.append(record)
                    lane.active.stop()
                else:
                    # No owned target does not prove an old writer is gone.
                    # Keep control admission responsive; metadata may settle now,
                    # but history must wait for exclusive execution ownership.
                    fence = None
                    try:
                        fence = lock_file(self.root / f".execution-{sid}")
                        if fence is None:
                            # Success replies are normally presented through
                            # history. This unprojectable warning must instead
                            # use the browser's visible non-success outcome path.
                            state = "failed"
                            outcome = {
                                "status": 409,
                                "body": {
                                    "detail": "No active execution owned by this service; an earlier writer may still own this session and was not stopped."
                                },
                            }
                        else:
                            state = "succeeded"
                            outcome = {
                                "status": 200,
                                "body": {
                                    "reply": "No active agent process found for this session."
                                },
                            }
                        self.finish(lane, record, state, outcome, fence_fd=fence)
                    except Exception as exc:
                        self.uncertain(
                            lane, record, f"Stop outcome publication failed: {exc}"
                        )
                    finally:
                        if fence is not None:
                            os.close(fence)
                return record, True
            lane.queue.append((record, stack.pop_all(), lease_fd))
            if lane.task is None or lane.task.done():
                lane.task = self.loop.create_task(self.work(sid, lane))
            return record, True
        finally:
            stack.close()

    def finish(self, lane, record, state, outcome, *, fence_fd: int | None):
        self.transition(record, state, outcome)
        if fence_fd is not None:
            self.project(record)
        # Without a fence only authoritative metadata is settled. A later safe
        # startup can idempotently rebuild the omitted history projection.
        future = lane.futures.pop(record["id"], None)
        if future is not None and not future.done():
            future.set_result(record)

    def uncertain(self, lane, record, detail):
        lane.paused = True
        outcome = {
            "status": 409,
            "body": {"detail": detail, "code": "send_indeterminate"},
        }
        try:
            self.transition(record, "indeterminate", outcome)
        except (OSError, ValueError, TypeError):
            record.update(
                state="indeterminate", revision=record["revision"] + 1, outcome=outcome
            )
            lane.unpersisted[record["id"]] = record
        future = lane.futures.pop(record["id"], None)
        if future is not None and not future.done():
            future.set_result(record)

    def interrupt_unstarted(self, lane):
        """Settle proven-unstarted work without a history projection or spawn."""
        while lane.queue:
            queued, ownership, _ = lane.queue[0]
            try:
                self.finish(
                    lane,
                    queued,
                    "interrupted_not_started",
                    {
                        "status": 409,
                        "body": {
                            "detail": "Lane paused before execution; this operation will not resume."
                        },
                    },
                    fence_fd=None,
                )
            except Exception:
                self.uncertain(
                    lane, queued, "Unstarted outcome could not be persisted."
                )
                break  # Keep ownership/evidence until repair/close.
            lane.queue.popleft()
            ownership.close()

    async def work(self, sid, lane):
        if lane.paused:
            # A synchronous control/admission fault can pause us before our
            # very first scheduling turn. There is no active attempt to settle.
            self.interrupt_unstarted(lane)
            return
        while lane.queue and not lane.paused:
            record, stack, lease_fd = lane.queue[0]
            fence = None
            token = None
            attempt = None
            try:
                while fence is None:
                    fence = lock_file(self.root / f".execution-{sid}")
                    if fence is None:
                        await asyncio.sleep(
                            0.05
                        )  # Kernel ownership, never timeout/steal.
                record["execution_id"] = uuid.uuid4().hex
                self.transition(record, "running")  # Must persist BEFORE effects/spawn.
                attempt = Attempt(record["execution_id"], fence, self.root)
                lane.active = attempt  # Registered before the first asynchronous spawn.
                token = current_attempt.set(attempt)
                try:
                    reply = await self.execute(
                        sid, record["message"], lease_fd, record["id"]
                    )
                    outcome = {"status": 200, "body": {"reply": reply}}
                    state = "succeeded"
                except HTTPException as exc:
                    outcome = {
                        "status": exc.status_code,
                        "body": {"detail": exc.detail},
                        "headers": exc.headers or {},
                    }
                    state = "failed"
                if attempt.signal_error:
                    raise ExecutionUncertain(
                        "Stop signal failed; writer cleanup is unconfirmed."
                    )
                # The adapter has reaped its writer. Verify no inherited copy is
                # still writing before publishing a safe terminal or advancing.
                os.close(fence)
                fence = None
                probe = lock_file(self.root / f".execution-{sid}")
                if probe is None:
                    raise ExecutionUncertain("Writer cleanup could not be confirmed.")
                fence = probe
                if attempt.stop_requested and attempt.process is not None:
                    state = "cancelled"
                self.finish(lane, record, state, outcome, fence_fd=fence)
                for stop in attempt.stops:
                    reply = (
                        "Agent process stopped."
                        if attempt.process is not None
                        else "No active agent process found for this session."
                    )
                    self.finish(
                        lane,
                        stop,
                        "succeeded",
                        {"status": 200, "body": {"reply": reply}},
                        fence_fd=fence,
                    )
            except asyncio.CancelledError:
                self.uncertain(
                    lane,
                    record,
                    "Service interrupted; writer settlement or effects are unconfirmed.",
                )
                if attempt:
                    for stop in attempt.stops:
                        self.uncertain(
                            lane,
                            stop,
                            "Service interrupted before target cleanup was confirmed.",
                        )
                raise
            except Exception as exc:
                self.uncertain(lane, record, f"Execution lane paused: {exc}")
                if attempt:
                    for stop in attempt.stops:
                        self.uncertain(
                            lane, stop, "Target cleanup could not be confirmed."
                        )
            finally:
                if token is not None:
                    current_attempt.reset(token)
                lane.active = None
                try:
                    if fence is not None:
                        os.close(fence)
                    stack.close()
                except Exception as exc:
                    self.uncertain(
                        lane, record, f"Ownership cleanup could not be confirmed: {exc}"
                    )
                lane.queue.popleft()
                if lane.paused:
                    self.interrupt_unstarted(lane)

    async def wait(self, record):
        lane = self.lane(record["session_id"])
        future = lane.futures.get(record["id"])
        if future is not None:
            return await asyncio.shield(future)
        return record

    async def close(self):
        if self.closed:
            return
        self.closed = True
        tasks = [
            lane.task
            for lane in self.lanes.values()
            if lane.task and not lane.task.done()
        ]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for sid, lane in self.lanes.items():
            fence = lock_file(self.root / f".execution-{sid}")
            try:
                while lane.queue:
                    record, stack, _ = lane.queue.popleft()
                    try:
                        self.finish(
                            lane,
                            record,
                            "interrupted_not_started",
                            {
                                "status": 409,
                                "body": {
                                    "detail": "Service stopped before execution; will not resume."
                                },
                            },
                            fence_fd=fence,
                        )
                    except Exception:
                        lane.paused = True
                    stack.close()
            finally:
                if fence is not None:
                    os.close(fence)
        os.close(self.fd)
