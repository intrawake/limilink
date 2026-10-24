"""Transpile the favicon source into the ignored dist directory."""

import argparse
from collections import UserDict
import os
from pathlib import Path
import tempfile
import xml.etree.ElementTree as ET

import sxpb

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "ui" / "favicon.svg.sxpb"
OUTPUT = ROOT / "dist" / "favicon.svg"
SVG_TAG = "{http://www.w3.org/2000/svg}svg"


def compile_svg(source: Path) -> str:
    document = sxpb.load(str(source), precise=True)
    if not isinstance(document, UserDict):
        raise ValueError(f"Expected an SVG document in {source}")
    content = sxpb.to_xml(document).rstrip("\n") + "\n"
    if ET.fromstring(content).tag != SVG_TAG:
        raise ValueError(f"Expected an SVG root in {source}")
    return content


def write_svg(path: Path, content: str):
    """Replace atomically so the static server never reads a partial SVG."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, prefix=".svg-", delete=False
        ) as output:
            temporary = Path(output.name)
            output.write(content)
        temporary.chmod(0o644)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check the built favicon")
    args = parser.parse_args(argv)
    content = compile_svg(SOURCE)
    current = OUTPUT.is_file() and OUTPUT.read_text(encoding="utf-8") == content
    if args.check and not current:
        parser.exit(1, "Missing or stale dist/favicon.svg; run pdm run build.\n")
    if not args.check and not current:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        write_svg(OUTPUT, content)
    print(f"Favicon {'checked' if args.check else 'built'}.")


if __name__ == "__main__":
    main()
