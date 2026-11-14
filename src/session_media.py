"""Immutable session media publications, independent of chat execution.

Private filesystem storage is not an authentication system. These routes use
Limilink's existing deployment perimeter. Header recognition is not decoding.
"""

from __future__ import annotations

import asyncio
from contextlib import ExitStack, contextmanager
import hashlib
import json
import math
import os
import re
import shutil
import stat
import threading
import time
import unicodedata
from urllib.parse import quote
import uuid

from fastapi import HTTPException
from starlette.responses import StreamingResponse

MAX_BYTES = 64 * 1024**2
MAX_SESSION_BYTES = 512 * 1024**2
MAX_ITEMS = 128
MAX_UPLOADS = 2
UPLOAD_SECONDS = 120
PREFIX_BYTES = 65536
PRIVATE = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}
MIMES = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/mp4",
    "audio/flac",
}


def fail(status, message):
    raise HTTPException(status, message, headers=PRIVATE)


def identity(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
        fail(400, "Invalid media publication ID")
    return value


def filename(value):
    value = unicodedata.normalize("NFC", value)
    try:
        encoded = value.encode("utf-8")
    except UnicodeError:
        fail(400, "Display filename must be valid Unicode")
    if (
        not value
        or value in (".", "..")
        or len(value) > 160
        or len(encoded) > 640
        or any(
            char in "/\\" or unicodedata.category(char).startswith("C")
            for char in value
        )
    ):
        fail(400, "Use a short display filename without paths or control characters")
    return value


def recognize(head, tail, size):
    if (
        size >= 33
        and head.startswith(b"\x89PNG\r\n\x1a\n")
        and head[8:16] == b"\0\0\0\rIHDR"
        and int.from_bytes(head[16:20], "big")
        and int.from_bytes(head[20:24], "big")
    ):
        return "image/png"
    if size >= 8 and head.startswith(b"\xff\xd8\xff") and tail.endswith(b"\xff\xd9"):
        return "image/jpeg"
    if (
        size >= 14
        and head[:6] in (b"GIF87a", b"GIF89a")
        and int.from_bytes(head[6:8], "little")
        and int.from_bytes(head[8:10], "little")
        and tail.endswith(b";")
    ):
        return "image/gif"
    if (
        size >= 20
        and head[:4] == b"RIFF"
        and int.from_bytes(head[4:8], "little") + 8 == size
    ):
        if head[8:12] == b"WEBP" and head[12:16] in (b"VP8 ", b"VP8L", b"VP8X"):
            return "image/webp"
        if size >= 44 and head[8:12] == b"WAVE" and b"fmt " in head and b"data" in head:
            return "audio/wav"
    if size > 42 and head[:8] in (b"fLaC\x00\x00\x00\x22", b"fLaC\x80\x00\x00\x22"):
        return "audio/flac"
    if (
        size >= 28
        and head.startswith(b"OggS\0")
        and b"theora" not in head
        and any(marker in head for marker in (b"OpusHead", b"\x01vorbis", b"\x7fFLAC"))
    ):
        return "audio/ogg"
    if (
        size >= 20
        and head[4:8] == b"ftyp"
        and head[8:12] in (b"M4A ", b"M4B ")
        and 16 <= int.from_bytes(head[:4], "big") <= min(len(head), 4096)
    ):
        return "audio/mp4"
    offset = 0
    if head.startswith(b"ID3"):
        if (
            len(head) < 10
            or head[3] not in (2, 3, 4)
            or head[4] == 255
            or any(value & 128 for value in head[6:10])
        ):
            fail(415, "Unsupported or truncated audio tag")
        offset = 10 + sum(
            value << shift for value, shift in zip(head[6:10], (21, 14, 7, 0))
        )
        if head[3] == 4 and head[5] & 16:
            offset += 10
    frame = head[offset : offset + 4]
    if (
        len(frame) == 4
        and frame[0] == 255
        and frame[1] & 224 == 224
        and (frame[1] >> 3) & 3 != 1
        and (frame[1] >> 1) & 3 != 0
        and frame[2] >> 4 not in (0, 15)
        and (frame[2] >> 2) & 3 != 3
        and size > offset + 4
    ):
        return "audio/mpeg"
    fail(
        415,
        "Unsupported/truncated media. Use PNG, JPEG, GIF, WebP, MP3, WAV, Ogg audio, M4A or FLAC; SVG/HTML are not supported",
    )


def open_dir(stack, parent, name, *, create=False):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
    fd = os.open(
        name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent
    )
    stack.callback(os.close, fd)
    return fd


def open_file(parent, name):
    fd = os.open(
        name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent
    )
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        fail(409, "Media storage contains a nonregular file")
    return fd


def public(sid, value):
    url = f"/sessions/{quote(sid, safe='')}/media/{value['id']}/content"
    return {**value, "url": url, "download_url": url + "?download=1"}


def metadata_at(directory, rid, sid):
    with os.fdopen(open_file(directory, "metadata.json"), "rb") as source:
        raw = source.read(16385)
    if len(raw) > 16384:
        fail(409, "Media metadata is oversized")
    try:
        value = json.loads(raw)
    except ValueError:
        fail(409, "Media metadata cannot be verified")
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "version",
            "id",
            "session_id",
            "name",
            "mime",
            "size",
            "sha256",
            "created_at",
        }
        or type(value.get("version")) is not int
        or value.get("version") != 1
        or value.get("id") != rid
        or value.get("session_id") != sid
        or value.get("mime") not in MIMES
        or type(value.get("size")) is not int
        or not 0 < value["size"] <= MAX_BYTES
        or not isinstance(value.get("sha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"])
        or type(value.get("created_at")) not in (float, int)
        or not math.isfinite(value["created_at"])
        or value["created_at"] <= 0
        or not isinstance(value.get("name"), str)
        or filename(value["name"]) != value["name"]
    ):
        fail(409, "Media metadata cannot be verified")
    fd = open_file(directory, "data")
    try:
        if os.fstat(fd).st_size != value["size"]:
            fail(409, "Media bytes disagree with metadata")
    finally:
        os.close(fd)
    return public(sid, value)


def metadata(parent, rid, sid):
    with ExitStack() as stack:
        return metadata_at(open_dir(stack, parent, rid), rid, sid)


class MediaStream(StreamingResponse):
    """Own the opened FD and leases even if streaming never starts or fails."""

    def __init__(self, stack, fd, item, request, download):
        self.ownership = stack
        total = item["size"]
        start, length, status = 0, total, 200
        tag = '"' + item["sha256"] + '"'
        headers = {
            **PRIVATE,
            "Accept-Ranges": "bytes",
            "ETag": tag,
            "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
            "Content-Disposition": ("attachment" if download else "inline")
            + "; filename=\"media\"; filename*=UTF-8''"
            + quote(item["name"], safe=""),
        }
        match = request.headers.get("if-none-match", "")
        if any(value.strip() in (tag, "W/" + tag, "*") for value in match.split(",")):
            status, length = 304, 0
        elif request.method != "HEAD" and request.headers.get("if-range", tag) == tag:
            value = request.headers.get("range", "")
            found = (
                re.fullmatch(r"bytes=(\d*)-(\d*)", value) if len(value) <= 128 else None
            )
            if found and (found[1] or found[2]):
                left, right = found.groups()
                if left:
                    start = int(left)
                    end = min(int(right), total - 1) if right else total - 1
                else:
                    suffix = int(right)
                    start, end = max(0, total - suffix), total - 1
                    if suffix == 0:
                        start = total
                if start >= total or end < start:
                    status, length = 416, 0
                    headers["Content-Range"] = f"bytes */{total}"
                else:
                    status, length = 206, end - start + 1
                    headers["Content-Range"] = f"bytes {start}-{end}/{total}"
        headers["Content-Length"] = str(length)

        def chunks():
            os.lseek(fd, start, os.SEEK_SET)
            remaining = length if request.method != "HEAD" else 0
            while remaining:
                data = os.read(fd, min(65536, remaining))
                if not data:
                    raise OSError("Media changed during transfer")
                remaining -= len(data)
                yield data

        super().__init__(
            chunks(), status_code=status, media_type=item["mime"], headers=headers
        )

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.ownership.close()


class MediaStore:
    def __init__(self, owner, admission, gate):
        self.owner, self.root, self.admission, self.gate = (
            owner,
            owner.root,
            admission,
            gate,
        )
        self.inflight = 0
        self.locks = {}
        self.cleaned = set()

    def lock(self, sid):
        return self.locks.setdefault(sid, threading.RLock())

    @contextmanager
    def scope(self, sid, *, create=False):
        if self.owner.closed:
            fail(503, "Service is closing")
        self.owner.validate_session(sid)
        with ExitStack() as stack:
            # Retain THIS root owner's description for the entire upload/stream.
            # A replacement owner cannot clean stages while it is still alive.
            stack.callback(os.close, os.dup(self.owner.fd))
            stack.enter_context(self.admission(self.root, sid))
            root = open_dir(stack, None, self.root)
            session = open_dir(stack, root, sid)
            try:
                directory = open_dir(stack, session, ".media", create=create)
            except FileNotFoundError:
                if create:
                    raise
                directory = None
            yield stack, directory, session

    def records(self, directory, sid):
        if directory is None:
            return []
        items = []
        for name in os.listdir(directory):
            if re.fullmatch(r"\.(?:stage|removed)-[0-9a-f]{32}", name):
                continue
            if not re.fullmatch(r"[0-9a-f]{32}", name):
                fail(409, "Media storage contains an unverified entry")
            items.append(metadata(directory, name, sid))
            if len(items) > MAX_ITEMS:
                fail(409, "Media shelf exceeds its verified item limit")
        return sorted(items, key=lambda value: (value["created_at"], value["id"]))

    def listing(self, sid, revision=None):
        with self.scope(sid) as (_, directory, _session), self.lock(sid):
            items = self.records(directory, sid)
            current = hashlib.sha256(
                json.dumps(items, sort_keys=True).encode()
            ).hexdigest()
            return (
                {"revision": current, "unchanged": True}
                if revision == current
                else {"revision": current, "media": items}
            )

    def lookup(self, sid, rid):
        identity(rid)
        with self.scope(sid) as (_, directory, _session), self.lock(sid):
            if directory is None:
                fail(404, "Media publication not found")
            return metadata(directory, rid, sid)

    def remove(self, sid, rid):
        identity(rid)
        with self.scope(sid) as (_, directory, session), self.gate, self.lock(sid):
            if directory is None:
                fail(404, "Media publication not found")
            removed = ".removed-" + rid
            with ExitStack() as stack:
                try:
                    publication = open_dir(stack, directory, removed)
                except FileNotFoundError:
                    publication = open_dir(stack, directory, rid)
                    metadata_at(publication, rid, sid)
                    # Atomically hide the pin before reclaiming its copied bytes.
                    os.rename(rid, removed, src_dir_fd=directory, dst_dir_fd=directory)
                os.fsync(directory)
                os.fsync(session)
                try:
                    os.unlink("data", dir_fd=publication)
                except FileNotFoundError:
                    pass
                os.fsync(publication)
                # Retain the small metadata tombstone: an old upload retry must
                # never resurrect a pin the user explicitly removed.

    def content(self, sid, rid, request, download=False):
        identity(rid)
        scope = self.scope(sid)
        with ExitStack() as setup:
            resources, directory, _session = setup.enter_context(scope)
            if directory is None:
                fail(404, "Media publication not found")
            with self.lock(sid):
                publication = open_dir(resources, directory, rid)
                item = metadata_at(publication, rid, sid)
                fd = open_file(publication, "data")
                resources.callback(os.close, fd)
                if os.fstat(fd).st_size != item["size"]:
                    fail(409, "Media changed before transfer")
            response = MediaStream(setup, fd, item, request, download)
            response.ownership = setup.pop_all()
            return response

    async def upload(self, sid, rid, name, request):
        identity(rid)
        name = filename(name)
        if request.headers.get("content-encoding", "identity").lower() != "identity":
            fail(415, "Encoded uploads are unsupported")
        declared = request.headers.get("content-length")
        if declared is not None and (
            not re.fullmatch(r"\d{1,20}", declared) or int(declared) > MAX_BYTES
        ):
            fail(413, "Upload exceeds the media byte limit")
        if self.inflight >= MAX_UPLOADS:
            fail(503, "Media upload slots are busy; no upload was started")
        self.inflight += 1
        try:
            with self.scope(sid, create=True) as (_, directory, session):
                assert directory is not None
                # Only once per session/owner, before this owner starts uploads.
                with self.lock(sid):
                    if sid not in self.cleaned:
                        for old in os.listdir(directory):
                            if re.fullmatch(r"\.stage-[0-9a-f]{32}", old):
                                shutil.rmtree(old, dir_fd=directory)
                        self.cleaned.add(sid)
                stage = ".stage-" + uuid.uuid4().hex
                os.mkdir(stage, 0o700, dir_fd=directory)
                try:
                    with ExitStack() as temporary:
                        stage_fd = open_dir(temporary, directory, stage)
                        fd = os.open(
                            "data",
                            os.O_WRONLY
                            | os.O_CREAT
                            | os.O_EXCL
                            | os.O_NOFOLLOW
                            | os.O_CLOEXEC,
                            0o600,
                            dir_fd=stage_fd,
                        )
                        digest = hashlib.sha256()
                        prefix, tail, size = b"", b"", 0
                        with os.fdopen(fd, "wb") as output:
                            async with asyncio.timeout(UPLOAD_SECONDS):
                                async for chunk in request.stream():
                                    size += len(chunk)
                                    if size > MAX_BYTES:
                                        fail(413, "Upload exceeds the media byte limit")
                                    digest.update(chunk)
                                    prefix += chunk[
                                        : max(0, PREFIX_BYTES - len(prefix))
                                    ]
                                    tail = (tail + chunk[-16:])[-16:]
                                    output.write(chunk)
                            if declared is not None and size != int(declared):
                                fail(400, "Uploaded bytes disagree with Content-Length")
                            mime = recognize(prefix, tail, size)
                            output.flush()
                            os.fsync(output.fileno())
                        item = {
                            "version": 1,
                            "id": rid,
                            "session_id": sid,
                            "name": name,
                            "mime": mime,
                            "size": size,
                            "sha256": digest.hexdigest(),
                            "created_at": time.time(),
                        }
                        meta_fd = os.open(
                            "metadata.json",
                            os.O_WRONLY
                            | os.O_CREAT
                            | os.O_EXCL
                            | os.O_NOFOLLOW
                            | os.O_CLOEXEC,
                            0o600,
                            dir_fd=stage_fd,
                        )
                        with os.fdopen(meta_fd, "w") as output:
                            json.dump(item, output)
                            output.flush()
                            os.fsync(output.fileno())
                        os.fsync(stage_fd)
                        # No awaited I/O while holding lifecycle/commit gates.
                        with self.gate, self.admission(self.root, sid), self.lock(sid):
                            if self.owner.closed:
                                fail(
                                    503,
                                    "Service closed before media commit; observe publication ID",
                                )
                            self.owner.validate_session(sid)
                            try:
                                os.stat(
                                    ".removed-" + rid,
                                    dir_fd=directory,
                                    follow_symlinks=False,
                                )
                            except FileNotFoundError:
                                pass
                            else:
                                fail(
                                    410,
                                    "This pin was removed; use a new publication ID",
                                )
                            items = self.records(directory, sid)
                            old = next(
                                (item for item in items if item["id"] == rid), None
                            )
                            if old is not None:
                                if any(
                                    old[key] != item[key]
                                    for key in ("name", "mime", "size", "sha256")
                                ):
                                    fail(
                                        409,
                                        "Publication ID already binds different media",
                                    )
                                return old, False
                            if (
                                len(items) >= MAX_ITEMS
                                or sum(item["size"] for item in items) + size
                                > MAX_SESSION_BYTES
                            ):
                                fail(409, "Session media shelf is full")
                            os.rename(
                                stage, rid, src_dir_fd=directory, dst_dir_fd=directory
                            )
                            os.fsync(directory)
                            os.fsync(session)
                        return public(sid, item), True
                finally:
                    # A renamed final publication is never removed on uncertainty.
                    try:
                        shutil.rmtree(stage, dir_fd=directory)
                    except FileNotFoundError:
                        pass
        finally:
            self.inflight -= 1
