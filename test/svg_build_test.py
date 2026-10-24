"""Single-source favicon builds using owned temporary checkout layouts."""

import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

import pytest

from tool import build_svg

SOURCE = """(svg
 (@xmlns http://www.w3.org/2000/svg)
 (@viewBox "0 0 64 64")
 (($)
  (title "A & B < C")
  (rect (@width 64) (@height 64) (@fill #ff746c))
 )
)
"""


@pytest.fixture
def checkout(tmp_path, monkeypatch):
    root = tmp_path / "checkout"
    source = root / "src" / "ui" / "favicon.svg.sxpb"
    source.parent.mkdir(parents=True)
    source.write_text(SOURCE)
    output = root / "dist" / "favicon.svg"
    monkeypatch.setattr(build_svg, "SOURCE", source)
    monkeypatch.setattr(build_svg, "OUTPUT", output)
    return source, output


def test_single_authoritative_source_and_dist_destination():
    assert list((build_svg.ROOT / "src").rglob("*.svg.sxpb")) == [build_svg.SOURCE]
    assert build_svg.OUTPUT == build_svg.ROOT / "dist" / "favicon.svg"


def test_conversion_preserves_namespace_order_and_text(checkout):
    source, _ = checkout
    content = build_svg.compile_svg(source)
    assert content == build_svg.compile_svg(source)
    root = ET.fromstring(content)
    assert root.tag == build_svg.SVG_TAG
    assert root.attrib["viewBox"] == "0 0 64 64"
    assert [child.tag.rsplit("}", 1)[-1] for child in root] == ["title", "rect"]
    assert root[0].text == "A & B < C"
    assert root[1].attrib["fill"] == "#ff746c"


@pytest.mark.parametrize("existing", [None, "stale output"])
def test_check_never_creates_or_changes_output(checkout, existing):
    _, output = checkout
    if existing is not None:
        output.parent.mkdir()
        output.write_text(existing)
    with pytest.raises(SystemExit) as error:
        build_svg.main(["--check"])
    assert error.value.code == 1
    if existing is None:
        assert not output.parent.exists()
    else:
        assert output.read_text() == existing
        assert list(output.parent.iterdir()) == [output]


def test_build_is_idempotent_and_writes_only_to_dist(checkout):
    source, output = checkout
    original = source.read_bytes(), source.stat().st_mtime_ns
    build_svg.main([])
    expected, modified = output.read_bytes(), output.stat().st_mtime_ns
    build_svg.main([])
    build_svg.main(["--check"])
    assert output.read_bytes() == expected
    assert output.stat().st_mtime_ns == modified
    assert output.stat().st_mode & 0o777 == 0o644
    assert (source.read_bytes(), source.stat().st_mtime_ns) == original
    assert list(source.parent.iterdir()) == [source]
    assert list(output.parent.iterdir()) == [output]


@pytest.mark.parametrize("existing", [False, True])
def test_invalid_source_cannot_create_or_replace_output(checkout, existing):
    source, output = checkout
    source.write_text('(html (title "Wrong root"))')
    if existing:
        output.parent.mkdir()
        output.write_text("keep existing output")
    with pytest.raises(ValueError, match="Expected an SVG root"):
        build_svg.main([])
    if existing:
        assert output.read_text() == "keep existing output"
        assert list(output.parent.iterdir()) == [output]
    else:
        assert not output.parent.exists()


def test_failed_replace_preserves_output_and_cleans_temporary(checkout, monkeypatch):
    _, output = checkout
    output.parent.mkdir()
    output.write_text("old")

    def fail(*args):
        raise OSError("synthetic replace failure")

    monkeypatch.setattr(build_svg.os, "replace", fail)
    with pytest.raises(OSError, match="synthetic replace failure"):
        build_svg.main([])
    assert output.read_text() == "old"
    assert list(output.parent.iterdir()) == [output]


def test_cli_builds_fresh_checkout_from_another_directory(checkout, tmp_path):
    source, output = checkout
    script = source.parents[2] / "tool" / "build_svg.py"
    script.parent.mkdir()
    shutil.copyfile(build_svg.__file__, script)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    for args in [[], ["--check"]]:
        result = subprocess.run(
            [sys.executable, str(script), *args],
            cwd=elsewhere,
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert result.returncode == 0, result.stderr
    assert output.read_text() == build_svg.compile_svg(source)
    assert list(source.parent.iterdir()) == [source]


def test_route_never_falls_back_to_ui_and_recovers_after_build(tmp_path, monkeypatch):
    from fastapi.staticfiles import StaticFiles
    from fastapi.testclient import TestClient
    from starlette.routing import Mount
    import main

    ui = tmp_path / "ui"
    ui.mkdir()
    (ui / "favicon.svg").write_text("stale UI favicon")
    (ui / "probe.txt").write_text("static mount active")
    output = tmp_path / "dist" / "favicon.svg"
    monkeypatch.setattr(main, "FAVICON_PATH", output)
    mount = next(
        route
        for route in main.app.routes
        if isinstance(route, Mount) and route.name == "static"
    )
    monkeypatch.setattr(mount, "app", StaticFiles(directory=ui))
    with TestClient(main.app) as client:
        assert client.get("/probe.txt").text == "static mount active"
        assert client.get("/favicon.svg").status_code == 404
        assert not output.parent.exists()
        output.parent.mkdir()
        content = build_svg.compile_svg(build_svg.SOURCE)
        output.write_text(content)
        response = client.get("/favicon.svg?v=12")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("image/svg+xml")
        assert response.text == content
        (output.parent / "private.txt").write_text("not a public dist mount")
        assert client.get("/dist/private.txt").status_code == 404
        assert client.get("/private.txt").status_code == 404
        output.unlink()
        assert client.get("/favicon.svg").status_code == 404
