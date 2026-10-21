"""Read bounded observer snapshots; never execute Pi or expose its raw records."""

import hashlib
import json
import os
import stat
import time
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

MAX_BYTES = 512 * 1024


class Record(BaseModel):
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False, strict=True)


class Context(Record):
    basis: Literal["estimate", "last-input"] = "estimate"
    tokens: float | None = Field(default=None, ge=0)
    contextWindow: float = Field(gt=0)
    percent: float | None = Field(default=None, ge=0)
    observedAt: float = Field(ge=0)


class Tool(Record):
    id: str = Field(max_length=240)
    name: str = Field(max_length=120)
    startedAt: float = Field(ge=0)


class Node(Record):
    id: str = Field(max_length=240)
    parentId: str | None = Field(default=None, max_length=240)
    label: str = Field(max_length=160)
    kind: Literal["agent", "workflow", "step"]
    state: str = Field(max_length=40)
    model: str | None = Field(default=None, max_length=200)
    context: Context | None = None
    lastInputTokens: float | None = Field(default=None, ge=0)
    updatedAt: float | None = Field(default=None, ge=0)
    currentTool: str | None = Field(default=None, max_length=120)


class Edge(Record):
    id: str = Field(max_length=240)
    source: str = Field(max_length=240)
    target: str = Field(max_length=240)
    kind: Literal["delegation", "message", "reply", "steer"]
    label: str = Field(max_length=160)
    at: float | None = Field(default=None, ge=0)


class Event(Record):
    id: str = Field(max_length=240)
    at: float = Field(ge=0)
    kind: str = Field(max_length=40)
    label: str = Field(max_length=200)
    nodeId: str | None = Field(default=None, max_length=240)


class Activity(Record):
    version: Literal[1]
    sessionId: str = Field(max_length=240)
    updatedAt: float = Field(ge=0)
    state: Literal["idle", "working", "stopped", "error"]
    model: str | None = Field(default=None, max_length=200)
    context: Context | None = None
    tools: list[Tool] = Field(default_factory=list, max_length=64)
    nodes: list[Node] = Field(default_factory=list, max_length=64)
    edges: list[Edge] = Field(default_factory=list, max_length=128)
    events: list[Event] = Field(default_factory=list, max_length=40)
    subagentsAvailable: bool = False


def activity_snapshot(path: Path, live: bool, revision: str | None = None) -> dict:
    result = {"available": False, "live": live, "serverTime": time.time() * 1000}
    try:
        # Do not follow a replaced snapshot into some unrelated private file.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError("Activity is not a regular file")
            raw = source.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError("Oversized activity snapshot")
        activity = Activity.model_validate(json.loads(raw)).model_dump()
        ids = [node["id"] for node in activity["nodes"]]
        if len(ids) != len(set(ids)) or "parent" not in ids:
            raise ValueError("Invalid graph identity")
        activity["edges"] = [
            edge
            for edge in activity["edges"]
            if edge["source"] in ids and edge["target"] in ids
        ]
        digest = hashlib.sha256(
            json.dumps(activity, sort_keys=True).encode()
        ).hexdigest()
        result.update(available=True, revision=digest)
        if revision != digest:
            result["activity"] = activity
    except FileNotFoundError:
        result["reason"] = (
            "No activity recorded yet. It starts with the next supported agent run."
        )
    except (OSError, ValueError, ValidationError):
        result["reason"] = "Activity is temporarily unavailable."
    return result
