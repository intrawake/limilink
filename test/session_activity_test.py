"""Activity is bounded, read-only, revisioned and separate from chat readiness."""

import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import main
from session_activity import MAX_BYTES, activity_snapshot
from session_lease import session_lease


@pytest.fixture
def recorded(test_sessions_dir):
    session = Path(test_sessions_dir) / "session_a"
    session.mkdir()
    snapshot = {
        "version": 1,
        "sessionId": "pi-id",
        "updatedAt": 1000,
        "state": "working",
        "model": "test/model",
        "context": {
            "tokens": 500,
            "contextWindow": 1000,
            "percent": 50,
            "observedAt": 900,
        },
        "tools": [{"id": "tool-1", "name": "read", "startedAt": 950}],
        "nodes": [
            {"id": "parent", "label": "Assistant", "kind": "agent", "state": "working"}
        ],
        "edges": [],
        "events": [],
        "subagentsAvailable": True,
    }
    path = session / ".activity.json"
    path.write_text(json.dumps(snapshot))
    return path, snapshot


def test_session_observation_whitelist_ancestry_and_revision(recorded):
    path, snapshot = recorded
    snapshot["sessionTracking"] = {
        "available": True,
        "limited": False,
        "token": "SECRET",
    }
    snapshot["nodes"].append(
        {
            "id": "session:child",
            "parentId": "parent",
            "label": "Child session 12345678",
            "kind": "agent",
            "state": "working",
            "lastInputTokens": 300,
            "observation": {
                "basis": "pi-session-events",
                "status": "open",
                "ancestry": "file-reference",
                "observedAt": 950,
                "omitted": 2,
                "modelBasis": "response",
                "selectedModel": "selected/model",
                "modelObservedAt": 900,
                "lastInputObservedAt": 900,
                "invalidated": "compaction",
                "sessionFile": "/PRIVATE/journal",
                "token": "SECRET",
                "args": {"secret": "SECRET"},
            },
        }
    )
    snapshot["edges"] = [
        {
            "id": "ancestry",
            "source": "parent",
            "target": "session:child",
            "kind": "ancestry",
            "label": "Header parent file (historical)",
        }
    ]
    path.write_text(json.dumps(snapshot))
    before = path.read_bytes()
    result = activity_snapshot(path, True)
    assert result["available"]
    assert result["activity"]["sessionTracking"] == {
        "available": True,
        "limited": False,
    }
    observation = result["activity"]["nodes"][1]["observation"]
    assert observation["lastInputObservedAt"] == 900
    assert observation["modelBasis"] == "response"
    assert observation["invalidated"] == "compaction"
    assert result["activity"]["edges"][0]["kind"] == "ancestry"
    assert "SECRET" not in json.dumps(result) and "/PRIVATE" not in json.dumps(result)
    assert path.read_bytes() == before
    snapshot["nodes"][1]["observation"]["status"] = "closed"
    path.write_text(json.dumps(snapshot))
    assert (
        activity_snapshot(path, True, result["revision"])["revision"]
        != result["revision"]
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("basis", "guessed"),
        ("status", "completed"),
        ("ancestry", "delegated"),
        ("omitted", -1),
        ("modelBasis", "billed"),
        ("observedAt", float("inf")),
    ],
)
def test_malformed_session_observation_fails_closed(recorded, field, value):
    path, snapshot = recorded
    snapshot["nodes"][0]["observation"] = {
        "basis": "pi-session-events",
        "status": "open",
        "ancestry": "unresolved",
        "observedAt": 1,
        "omitted": 0,
        field: value,
    }
    path.write_text(json.dumps(snapshot))
    assert not activity_snapshot(path, False)["available"]


def test_activity_assets_are_separate_and_loaded_after_chat():
    with TestClient(main.app) as client:
        html = client.get("/").text
        assert 'id="activity-panel"' in html
        assert html.index('src="/follow.js"') < html.index('src="/activity.js"')
        assert 'href="/activity.css"' in html
        assert client.get("/activity.js").status_code == 200
        assert client.get("/activity.css").status_code == 200


def test_usage_summaries_pass_existing_event_contract_without_new_fields(recorded):
    path, snapshot = recorded
    label = "Model response · Input 1,234 · Output 56 · Cache read 8,000 · Cache write 0 tokens"
    snapshot["events"] = [
        {
            "id": "usage-1",
            "at": 999,
            "kind": "model",
            "label": label,
            "nodeId": "parent",
        }
    ]
    path.write_text(json.dumps(snapshot))
    with TestClient(main.app) as client:
        result = client.get("/sessions/session_a/activity").json()
    assert result["available"]
    assert result["activity"]["events"][0]["label"] == label
    assert result["activity"]["events"][0]["kind"] == "model"


def test_compaction_clears_context_and_changes_poll_revision(recorded):
    path, snapshot = recorded
    previous = activity_snapshot(path, False)
    snapshot["context"] = None
    snapshot["events"] = [
        {
            "id": "compact-1",
            "at": 1001,
            "kind": "context",
            "label": "Context compacted",
            "nodeId": "parent",
        }
    ]
    path.write_text(json.dumps(snapshot))
    result = activity_snapshot(path, False, previous["revision"])
    assert result["available"]
    assert result["revision"] != previous["revision"]
    assert result["activity"]["context"] is None
    assert result["activity"]["nodes"][0]["context"] is None
    assert result["activity"]["events"][0]["label"] == "Context compacted"


@pytest.mark.parametrize(
    "state", ["running", "finished", "failed", "stopped", "unknown"]
)
def test_nested_tool_events_preserve_whitelisted_parent_and_state(recorded, state):
    path, snapshot = recorded
    snapshot["events"] = [
        {
            "id": "tool:outer",
            "at": 100,
            "kind": "tool",
            "label": "Running codemode",
            "nodeId": "parent",
            "state": "running",
        },
        {
            "id": "tool:child",
            "at": 101,
            "kind": "tool",
            "label": "read",
            "nodeId": "parent",
            "parentEventId": "tool:outer",
            "state": state,
            "args": "SECRET",
            "result": "SECRET",
        },
    ]
    path.write_text(json.dumps(snapshot))
    result = activity_snapshot(path, False)
    assert result["available"]
    child = result["activity"]["events"][1]
    assert child["parentEventId"] == "tool:outer"
    assert child["state"] == state
    assert "SECRET" not in json.dumps(result)
    before = result["revision"]
    snapshot["events"][1]["state"] = "finished" if state != "finished" else "failed"
    path.write_text(json.dumps(snapshot))
    assert activity_snapshot(path, False, before)["revision"] != before


@pytest.mark.parametrize("extra", [{"parentEventId": "x" * 241}, {"state": "invented"}])
def test_malformed_nested_metadata_is_unavailable_not_an_execution_error(
    recorded, extra
):
    path, snapshot = recorded
    snapshot["events"] = [
        {"id": "tool:x", "at": 100, "kind": "tool", "label": "read", **extra}
    ]
    path.write_text(json.dumps(snapshot))
    assert not activity_snapshot(path, False)["available"]


def test_orphan_event_parent_is_not_mistaken_for_an_agent_node_reference(recorded):
    path, snapshot = recorded
    snapshot["events"] = [
        {
            "id": "tool:child",
            "at": 100,
            "kind": "tool",
            "label": "Finished read",
            "parentEventId": "tool:evicted",
            "state": "finished",
        }
    ]
    path.write_text(json.dumps(snapshot))
    result = activity_snapshot(path, False)
    assert result["available"]
    assert result["activity"]["events"][0]["parentEventId"] == "tool:evicted"


def test_snapshot_revision_and_whitelist(recorded):
    path, snapshot = recorded
    snapshot["mailboxPath"] = "/private/path"
    snapshot["nodes"][0]["capabilityToken"] = "secret"
    snapshot["tools"][0]["args"] = {"token": "secret"}
    path.write_text(json.dumps(snapshot))
    original = path.read_bytes()
    result = activity_snapshot(path, True)
    assert result["available"] and result["live"]
    assert "secret" not in json.dumps(result)
    assert "/private/path" not in json.dumps(result)
    assert result["activity"]["context"]["percent"] == 50
    unchanged = activity_snapshot(path, False, result["revision"])
    assert unchanged["available"] and not unchanged["live"]
    assert "activity" not in unchanged
    assert path.read_bytes() == original


def test_endpoint_uses_only_selected_session_and_observes_inherited_lease(recorded):
    path, _ = recorded
    root = path.parent.parent
    with TestClient(main.app) as client:
        first = client.get("/sessions/session_a/activity")
        assert first.status_code == 200
        assert first.headers["cache-control"] == "no-store"
        assert not first.json()["live"]
        with session_lease(root, "session_a"):
            assert client.get("/sessions/session_a/activity").json()["live"]
        assert client.get("/sessions/session.a/activity").status_code == 400
        assert client.get("/sessions/missing/activity").status_code == 404
        assert not (root / "missing").exists()
        other = root / "session_b"
        other.mkdir()
        assert not client.get("/sessions/session_b/activity").json()["available"]
        assert not (other / ".activity.json").exists()


@pytest.mark.parametrize(
    "raw", ["{", "[]", "{}", '{"version":2}', "x" * (MAX_BYTES + 1)]
)
def test_malformed_or_oversized_snapshot_is_unavailable_not_chat_error(recorded, raw):
    path, _ = recorded
    path.write_text(raw)
    result = activity_snapshot(path, True)
    assert not result["available"]
    assert "activity" not in result
    assert path.read_text() == raw


def test_unknown_context_is_not_zero_and_bad_edges_are_not_invented(recorded):
    path, snapshot = recorded
    snapshot["context"]["tokens"] = None
    snapshot["context"]["percent"] = None
    snapshot["edges"] = [
        {
            "id": "e",
            "source": "parent",
            "target": "unknown",
            "kind": "reply",
            "label": "reply",
        }
    ]
    path.write_text(json.dumps(snapshot))
    result = activity_snapshot(path, False)
    assert result["activity"]["context"]["tokens"] is None
    assert result["activity"]["context"]["percent"] is None
    assert not result["activity"]["edges"]


@pytest.mark.parametrize("mutation", ["nonfinite", "many", "duplicate", "missing-root"])
def test_invalid_graph_and_nonfinite_values_fail_closed(recorded, mutation):
    path, snapshot = recorded
    if mutation == "nonfinite":
        snapshot["context"]["tokens"] = float("nan")
    elif mutation == "many":
        snapshot["nodes"] *= 65
    elif mutation == "duplicate":
        snapshot["nodes"] *= 2
    else:
        snapshot["nodes"] = []
    path.write_text(json.dumps(snapshot))
    assert not activity_snapshot(path, True)["available"]


def test_missing_symlink_fifo_and_read_failures_are_safe(recorded):
    path, _ = recorded
    missing = path.with_name("missing.json")
    assert not activity_snapshot(missing, False)["available"]
    link = path.with_name("link.json")
    link.symlink_to(path)
    assert not activity_snapshot(link, False)["available"]
    fifo = path.with_name("fifo")
    os.mkfifo(fifo)
    assert not activity_snapshot(fifo, False)["available"]
    with patch("session_activity.os.open", side_effect=PermissionError):
        assert not activity_snapshot(path, True)["available"]


def test_agent_launch_preserves_print_mode_and_binds_observer_after_env_merges(
    recorded,
):
    path, _ = recorded
    owner = path.parent.resolve()
    (owner / ".env_overrides.json").write_text(
        json.dumps({"LIMILINK_ACTIVITY_PATH": "/wrong-session"})
    )
    config = {
        "agent_by_alias": {"pi-test": {"harness": "pi", "model": "fixture"}},
        "env_dict": {"LIMILINK_ACTIVITY_OWNER_CWD": "/wrong-owner"},
    }
    process = AsyncMock()
    process.returncode = 0
    process.communicate.return_value = (b"Normal reply", b"")
    with (
        patch("main.load_config", return_value=(config, str(owner.parent))),
        patch("main.asyncio.create_subprocess_exec", return_value=process) as spawn,
        TestClient(main.app) as client,
    ):
        response = client.post(
            "/chat", json={"session_id": "session_a", "message": "hello"}
        )
    assert response.json()["reply"] == "Normal reply"
    args = spawn.call_args.args
    assert args[-2:] == ("-p", "hello")
    assert "--mode" not in args
    extension = Path(args[args.index("--extension") + 1])
    assert extension.name == "activity-bridge.mjs" and extension.is_absolute()
    env = spawn.call_args.kwargs["env"]
    assert env["LIMILINK_ACTIVITY_PATH"] == str(owner / ".activity.json")
    assert env["LIMILINK_ACTIVITY_OWNER_CWD"] == str(owner)
    assert env["LIMILINK_ACTIVITY_SESSION_DIR"] == str(owner / ".pi/agent/session")


def test_activity_failure_does_not_break_conversation(recorded):
    path, _ = recorded
    (path.parent / "chat_history.json").write_text(
        '[{"role":"bot","content":"Still here"}]'
    )
    path.write_text("corrupt")
    with TestClient(main.app) as client:
        assert not client.get("/sessions/session_a/activity").json()["available"]
        assert (
            client.get("/sessions/session_a/snapshot").json()["history"][0]["content"]
            == "Still here"
        )
