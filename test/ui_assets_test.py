"""Only the current chat shell and its assets remain publicly served."""

from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient

from main import app


class EntryAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        fields = dict(attrs)
        if tag == "script" and fields.get("src"):
            self.urls.append(fields["src"])
        if tag == "link" and fields.get("rel") == "stylesheet":
            self.urls.append(fields["href"])


def test_current_entry_references_only_available_assets():
    ui = Path(__file__).resolve().parents[1] / "src" / "ui"
    with TestClient(app) as client:
        entry = client.get("/")
        assert entry.status_code == 200
        assert entry.content == (ui / "resume.html").read_bytes()
        assets = EntryAssets()
        assets.feed(entry.text)
        assert set(assets.urls) == {
            "/arrange.css",
            "/activity.css",
            "/history-view.js?v=3",
            "/reply-state.js?v=1",
            "/follow.js",
            "/activity.js",
        }
        for url in assets.urls:
            response = client.get(url)
            assert response.status_code == 200
            assert (
                response.content == (ui / urlsplit(url).path.lstrip("/")).read_bytes()
            )


@pytest.mark.parametrize(
    "asset",
    [
        "arrange.js",
        "drawer.js",
        "resume.js",
        "toolbar.js",
        "steady.js",
        "chat.css",
        "drawer.css",
    ],
)
def test_retired_controller_assets_are_absent(asset):
    with TestClient(app) as client:
        assert client.get("/" + asset).status_code == 404
