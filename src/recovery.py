"""Explicit acknowledgement of settled, uncertain work; never execution/replay.

The ledger covers exact receipt bytes, not a blanket 'unpaused' flag. Storage
has the delivery owner's process-restart contract, not power-loss durability.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid

from fastapi import HTTPException

from send_receipt import SendIndeterminate, read_send


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def read_file(path: Path, *, missing=None):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except FileNotFoundError:
        return missing
    with os.fdopen(fd, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError(f"Not a regular recovery evidence file: {path.name}")
        return source.read()


def file_digest(path):
    raw = read_file(path)
    if raw is None:
        raise ValueError("Recovery evidence disappeared")
    return hashlib.sha256(raw).hexdigest()


def ledger_path(root, sid):
    return root / sid / ".delivery-recovery.json"


def read_ledger(root, sid):
    raw = read_file(ledger_path(root, sid))
    if raw is None:
        return {
            "version": 1,
            "session_id": sid,
            "acknowledged": {},
            "confirmations": {},
        }
    value = json.loads(raw)

    def hex32(value):
        return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{32}", value)

    def hex64(value):
        return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value)

    if (
        not isinstance(value, dict)
        or type(value.get("version")) is not int
        or value.get("version") != 1
        or value.get("session_id") != sid
        or not isinstance(value.get("acknowledged"), dict)
        or not isinstance(value.get("confirmations"), dict)
        or any(
            not hex32(key) or not hex64(item)
            for key, item in value["acknowledged"].items()
        )
        or any(
            not hex32(key)
            or not isinstance(item, dict)
            or not hex64(item.get("token"))
            or item.get("result") != {"acknowledged": True}
            for key, item in value["confirmations"].items()
        )
    ):
        raise ValueError("Recovery acknowledgement ledger cannot be verified")
    return value


def write_ledger(root, sid, value):
    path = ledger_path(root, sid)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        fd = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
        )
        with os.fdopen(fd, "w") as output:
            json.dump(value, output)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def acknowledged(ledger, rid, path):
    return ledger["acknowledged"].get(rid) == file_digest(path)


class Recovery:
    def __init__(self, owner, context, admission):
        self.owner = owner
        self.context = context
        self.admission = admission
        self.nonce = uuid.uuid4().hex

    def status(self, sid, *, token=None, request_id=None):
        """Both phases use the same non-waiting ownership/precondition checks."""
        from delivery import lock_file, read_operation

        owner = self.owner
        if owner.closed:
            raise HTTPException(503, "Delivery service is closing")
        owner.validate_session(sid)
        lane = owner.lane(sid)
        with owner.admission(owner.root, sid):
            ledger = read_ledger(owner.root, sid)
            saved = ledger["confirmations"].get(request_id)
            # Replay/lookup observes an immutable receipt, never a new unpause.
            if saved is not None:
                if token is not None and saved["token"] != token:
                    raise HTTPException(
                        409, "Recovery ID already binds a different review"
                    )
                return {
                    "recovery_required": lane.paused,
                    "confirmation": saved["result"],
                }
            if not lane.paused:
                if token is not None:
                    raise HTTPException(409, "Review is stale; session is not paused")
                return {"recovery_required": False}
        # Exclusive lease ALSO excludes old/unfenced legacy lease holders. Never
        # upgrade/nest it under our own separately opened shared admission lease.
        with self.admission(owner.root, sid):
            if lane.active or lane.queue or (lane.task and not lane.task.done()):
                raise HTTPException(
                    409, "Execution is still settling; review again after it settles"
                )
            if lane.unpersisted:
                raise HTTPException(
                    409,
                    "Unpersisted operation evidence needs storage repair; recovery refused",
                )
            fence = lock_file(owner.root / f".execution-{sid}")
            if fence is None:
                raise HTTPException(
                    409,
                    "An earlier writer still owns this session; it was not stopped. Recovery refused",
                )
            try:
                ledger = read_ledger(owner.root, sid)
                directory = owner.root / sid / ".web-requests"
                if directory.is_symlink() or (
                    directory.exists() and not directory.is_dir()
                ):
                    raise ValueError(
                        "Operation directory must be a canonical directory"
                    )
                records, evidence, uncertain = [], {}, {}
                for path in sorted(directory.glob("*.json")):
                    if not re.fullmatch(r"[0-9a-f]{32}", path.stem):
                        raise ValueError("Noncanonical operation receipt identity")
                    try:
                        record = read_operation(path)
                        records.append(record)
                        if record["state"] in ("queued", "running"):
                            raise HTTPException(
                                409,
                                "Nonterminal receipt may still be pending; recovery refused",
                            )
                        needs_ack = record["state"] == "indeterminate"
                        rid = record["id"]
                    except SendIndeterminate:
                        record = read_send(path)
                        needs_ack = record["state"] != "complete"
                        rid = path.stem
                    evidence[rid] = file_digest(path)
                    if needs_ack:
                        uncertain[rid] = evidence[rid]
                if not set(ledger["acknowledged"]).issubset(evidence):
                    raise ValueError(
                        "Previously acknowledged operation evidence is missing"
                    )
                context = self.context(owner.root / sid, records)
                review = {
                    "owner": self.nonce,
                    "root": str(owner.root),
                    "session_id": sid,
                    "receipts": evidence,
                    "ledger": ledger,
                    "context": context,
                }
                current = digest(review)
                if token is None:
                    return {
                        "recovery_required": True,
                        "token": current,
                        "uncertain_ids": sorted(uncertain),
                        "configuration": context["summary"],
                        "warning": "Past effects remain unknown. Recovery allows only new messages; no interrupted work will be retried.",
                    }
                if token != current:
                    raise HTTPException(
                        409,
                        "Recovery review changed. Review this session again before confirming",
                    )
                updated = {
                    **ledger,
                    "acknowledged": {**ledger["acknowledged"], **uncertain},
                    "confirmations": {
                        **ledger["confirmations"],
                        request_id: {"token": token, "result": {"acknowledged": True}},
                    },
                }
                # Only acknowledgement metadata changes. No history/config repair.
                # Commit first; any failure leaves memory admission paused.
                write_ledger(owner.root, sid, updated)
                lane.paused = False
                return {
                    "recovery_required": False,
                    "confirmation": {"acknowledged": True},
                }
            finally:
                os.close(fence)
