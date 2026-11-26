"""Build a static browser-only release, with an optional approved demo BIN."""
import argparse
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New output directory")
    parser.add_argument("--demo", type=Path, default=runtime.SAMPLE_FIRMWARE, help="Override the bundled demo BIN")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Choose a new output directory")
    sample = {}
    if args.demo:
        size = args.demo.stat().st_size
        with args.demo.open("rb") as source:
            header = source.read(24)
        if not (64 * 1024 <= size <= runtime.MAX_FIRMWARE and header[:1] == b"\xe9"
                and header[12:14] == b"\x09\x00"):
            parser.error("Expected an ESP32-S3 BIN between 64 KiB and 32 MiB")
        sample = {"name": args.demo.name, "size": size}

    runtime.install_runtime()
    root = args.output
    root.mkdir(parents=True)
    shutil.copyfile(runtime.WEB_DIR / "index.html", root / "index.html")
    for name in ("css", "js", "platform"):
        shutil.copytree(runtime.WEB_DIR / name, root / name)
    shutil.copytree(runtime.WEB_DIR / "assets", root / "assets",
                    ignore=shutil.ignore_patterns("silver-shell-v1.png", "prompt.txt"))
    (root / "runtime").mkdir()
    for name in runtime.RUNTIME_FILES:
        shutil.copyfile(runtime.RUNTIME_DIR / name, root / "runtime" / name)
    (root / "api").mkdir()
    (root / "api" / "status").write_text(
        json.dumps({"static": True, "native": False, "sample": sample}, ensure_ascii=False),
        encoding="utf-8",
    )
    if args.demo:
        shutil.copyfile(args.demo, root / "demo.bin")
        demo_notices = root / "demo"
        demo_notices.mkdir()
        for notice in ("README.md", "LICENSE", "NOTICE"):
            shutil.copyfile(runtime.SAMPLE_FIRMWARE.parent / notice, demo_notices / notice)
    (root / ".nojekyll").touch()


if __name__ == "__main__":
    main()
