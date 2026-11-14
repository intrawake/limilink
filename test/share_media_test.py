"""Publication helper streams local bytes once; no live uploads or retries."""

import io
import json
import os
import urllib.error

import pytest

from tool import share_media
from test.media_test import PNG


def arguments(path):
    return [
        str(path),
        "--session",
        "x",
        "--publication-id",
        "1" * 32,
        "--server",
        "http://127.0.0.1:11018",
    ]


def test_streaming_upload_identity_printed_before_transport(
    tmp_path, monkeypatch, capsys
):
    path = tmp_path / "cat photo.png"
    path.write_bytes(PNG)
    observed = []

    def transport(request, timeout):
        assert "Publication ID: " + "1" * 32 in capsys.readouterr().err
        assert request.method == "PUT" and "filename=cat+photo.png" in request.full_url
        assert int(request.headers["Content-length"]) == len(PNG)
        assert not isinstance(request.data, bytes)
        assert request.data.read(5) + request.data.read() == PNG
        assert request.data.read() == b""
        observed.append(request)
        return io.BytesIO(
            json.dumps(
                {
                    "media": {
                        "id": "1" * 32,
                        "session_id": "x",
                        "size": len(PNG),
                        "url": "/sessions/x/media/" + "1" * 32 + "/content",
                    }
                }
            ).encode()
        )

    monkeypatch.setattr(share_media.urllib.request, "urlopen", transport)
    assert share_media.main(arguments(path)) == 0
    assert json.loads(capsys.readouterr().out)["id"] == "1" * 32
    assert len(observed) == 1 and observed[0].data.source.closed


def test_lost_response_never_retries_and_reports_exact_observation_path(
    tmp_path, monkeypatch, capsys
):
    path = tmp_path / "picture.png"
    path.write_bytes(PNG)
    calls = []

    def transport(request, timeout):
        calls.append(request)
        raise urllib.error.URLError("lost response")

    monkeypatch.setattr(share_media.urllib.request, "urlopen", transport)
    assert share_media.main(arguments(path)) == 1
    result = capsys.readouterr()
    assert (
        result.out == "" and "Observe GET /sessions/x/media/" + "1" * 32 in result.err
    )
    assert "No automatic retry" in result.err
    assert len(calls) == 1 and calls[0].data.source.closed


@pytest.mark.parametrize(
    "kind", ["fifo", "empty", "directory", "external", "invalid-id"]
)
def test_invalid_inputs_are_refused_before_transport(tmp_path, monkeypatch, kind):
    path = tmp_path / "input"
    if kind == "fifo":
        os.mkfifo(path)
    elif kind == "directory":
        path.mkdir()
    else:
        path.write_bytes(b"" if kind == "empty" else PNG)
    args = arguments(path)
    if kind == "external":
        args[-1] = "https://example.invalid"
    if kind == "invalid-id":
        args[4] = "not-canonical"

    def forbidden(*args, **kwargs):
        pytest.fail("invalid media input reached transport")

    monkeypatch.setattr(share_media.urllib.request, "urlopen", forbidden)
    assert share_media.main(args) == 2


def test_reader_is_bounded_and_detects_shortening():
    source = share_media.SizedReader(io.BytesIO(b"abcdef"), 3)
    assert source.read(100) == b"abc" and source.read() == b""
    source = share_media.SizedReader(io.BytesIO(b"a"), 2)
    assert source.read() == b"a"
    with pytest.raises(OSError, match="shortened"):
        source.read()
