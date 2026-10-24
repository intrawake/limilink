"""Canonical reply evidence, independent of working/delivery/notification queues."""

import hashlib
import json
import os
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

import main
import session_snapshot as snapshots


def evidence(history):
    raw = json.dumps(history).encode()
    return snapshots.reply_evidence(history, hashlib.sha256(raw).hexdigest())


def test_tokens_identify_occurrences_and_ignore_user_only_append_or_formatting():
    first = [{"role": "bot", "content": "Identical"}]
    token = evidence(first)
    assert token["state"] == "known" and token["index"] == 0
    assert token["token"].startswith("r1:") and len(token["token"]) == 67
    user = first + [{"role": "user", "content": "Waiting"}]
    assert evidence(user) == token
    repeated = user + [{"role": "bot", "content": "Identical"}]
    assert evidence(repeated)["token"] != token["token"]
    assert evidence(repeated)["index"] == 2
    # Byte-level revision changes need not mean a new semantic reply.
    assert snapshots.reply_evidence(first, "formatting-only-revision") == token


def test_prefix_rewrite_changes_token_without_changing_last_reply_text():
    before = [{"role": "user", "content": "Before"}, {"role": "bot", "content": "Same"}]
    after = [{"role": "user", "content": "After"}, before[1]]
    assert evidence(before)["token"] != evidence(after)["token"]
    assert evidence([]) == {"state": "known", "token": None, "index": None}
    assert evidence([{"role": "user", "content": "Only a user"}])["token"] is None


def test_file_cache_skips_unchanged_reads_and_tracks_atomic_replacement(
    tmp_path, monkeypatch
):
    path = tmp_path / "chat_history.json"
    path.write_text('[{"role":"bot","content":"First"}]')
    opens = []
    original = Path.open

    def counted(self, *args, **kwargs):
        if self == path:
            opens.append(self)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", counted)
    first = snapshots.cached_reply_evidence(path)
    assert snapshots.cached_reply_evidence(path) == first
    assert len(opens) == 1
    replacement = tmp_path / "replacement"
    replacement.write_text('[{"role":"bot","content":"Other"}]')
    os.replace(replacement, path)
    assert snapshots.cached_reply_evidence(path)["token"] != first["token"]
    assert len(opens) == 2
    # Callers cannot mutate cached evidence.
    first["token"] = "not a token"
    assert snapshots.cached_reply_evidence(path)["token"].startswith("r1:")


def test_same_size_external_rewrite_is_eventually_rechecked_even_with_coarse_times(
    tmp_path, monkeypatch
):
    path = tmp_path / "chat_history.json"
    path.write_text('[{"role":"bot","content":"First"}]')
    before = snapshots.cached_reply_evidence(path)
    checked_at = snapshots._file_cache[path][1]
    info = path.stat()
    path.write_text('[{"role":"bot","content":"Other"}]')
    os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))
    assert path.stat().st_size == info.st_size
    monkeypatch.setattr(
        snapshots.time,
        "monotonic",
        lambda: checked_at + snapshots.FILE_RECHECK_SECONDS + 1,
    )
    assert snapshots.cached_reply_evidence(path)["token"] != before["token"]


def test_selected_snapshot_refreshes_offscreen_cache_even_if_stat_values_alias(
    tmp_path, monkeypatch
):
    path = tmp_path / "chat_history.json"
    path.write_text('[{"role":"bot","content":"First"}]')
    signature = snapshots._signature(path)
    monkeypatch.setattr(snapshots, "_signature", lambda _: signature)
    before = snapshots.cached_reply_evidence(path)
    path.write_text('[{"role":"bot","content":"Other"}]')
    selected = snapshots.history_snapshot(path, with_reply=True)
    assert selected["reply"]["token"] != before["token"]
    assert snapshots.cached_reply_evidence(path) == selected["reply"]
    saved_token = selected["reply"]["token"]
    selected["reply"]["token"] = "caller mutation"
    assert snapshots.cached_reply_evidence(path)["token"] == saved_token


@pytest.mark.parametrize("raw", ["{", "{}", '[{"role":"bot"}]', "\ud800"])
def test_malformed_is_unknown_not_no_reply(tmp_path, raw):
    path = tmp_path / "chat_history.json"
    path.write_bytes(raw.encode("utf-8", errors="surrogatepass"))
    assert snapshots.cached_reply_evidence(path) == {"state": "unknown"}


def test_read_limit_race_and_read_failure_are_unknown(tmp_path, monkeypatch):
    path = tmp_path / "chat_history.json"
    path.write_text('[{"role":"bot","content":"A reply"}]')
    monkeypatch.setattr(snapshots, "REPLY_HISTORY_LIMIT", 4)
    assert snapshots.cached_reply_evidence(path) == {"state": "unknown"}
    monkeypatch.setattr(snapshots, "REPLY_HISTORY_LIMIT", 8 * 1024 * 1024)
    snapshots._file_cache.pop(path, None)
    signature = snapshots._signature(path)
    calls = 0

    def changing(_):
        nonlocal calls
        calls += 1
        return signature if calls == 1 else signature[:-1] + (signature[-1] + 1,)

    monkeypatch.setattr(snapshots, "_signature", changing)
    assert snapshots.cached_reply_evidence(path) == {"state": "unknown"}
    monkeypatch.setattr(snapshots, "_signature", lambda _: signature)
    monkeypatch.setattr(
        Path, "open", lambda *args, **kwargs: (_ for _ in ()).throw(FileNotFoundError())
    )
    assert snapshots.cached_reply_evidence(path) == {"state": "unknown"}


def test_missing_history_is_known_null_only_for_an_existing_session(tmp_path):
    assert snapshots.cached_reply_evidence(tmp_path / "chat_history.json") == {
        "state": "known",
        "token": None,
        "index": None,
    }
    assert snapshots.cached_reply_evidence(tmp_path / "missing/chat_history.json") == {
        "state": "unknown"
    }


def test_caches_are_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(snapshots, "CACHE_LIMIT", 2)
    for index in range(5):
        path = tmp_path / f"{index}.json"
        path.write_text(json.dumps([{"role": "bot", "content": str(index)}]))
        snapshots.cached_reply_evidence(path)
    assert len(snapshots._file_cache) <= 2
    assert len(snapshots._reply_cache) <= 2


def test_batch_and_selected_snapshot_share_evidence_without_reading_queues(
    test_sessions_dir, monkeypatch
):
    root = Path(test_sessions_dir)
    path = root / "session_a"
    path.mkdir()
    main.append_to_history(str(path), "bot", "Canonical reply")
    queue = path / "unread.json"
    queue.write_text('["queue only"]')
    original = queue.read_bytes()
    with TestClient(main.app) as client:
        selected = client.get("/sessions/session_a/snapshot").json()
        assert selected["reply"]["token"]
        revision = selected["revision"]
        same = client.get(
            "/sessions/session_a/snapshot", params={"revision": revision}
        ).json()
        assert same["reply"] == selected["reply"] and "history" not in same

        # The batch seam does not acquire either global lifecycle or layout locks.
        class ForbiddenGate:
            def __enter__(self):
                raise AssertionError("aggregate must not acquire the global gate")

            def __exit__(self, *args):
                pass

        monkeypatch.setattr(main, "lifecycle_gate", ForbiddenGate())
        response = client.get(
            "/session-replies",
            params=[("session_id", "session_a"), ("session_id", "missing")],
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == {
            "replies": {"session_a": selected["reply"], "missing": {"state": "unknown"}}
        }
        assert queue.read_bytes() == original
        assert not (root / "missing").exists()
        assert (
            "Canonical reply" not in response.text
            and "chat_history" not in response.text
        )


def test_batch_input_is_bounded_and_validated(test_sessions_dir):
    with TestClient(main.app) as client:
        assert client.get("/session-replies").status_code == 422
        assert (
            client.get(
                "/session-replies", params=[("session_id", str(i)) for i in range(9)]
            ).status_code
            == 422
        )
        assert (
            client.get(
                "/session-replies", params={"session_id": "../private"}
            ).status_code
            == 400
        )
        assert client.get(
            "/session-replies", params=[("session_id", "missing")] * 2
        ).json() == {"replies": {"missing": {"state": "unknown"}}}
