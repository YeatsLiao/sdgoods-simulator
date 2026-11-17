"""Start the local-only SDGOODS simulator and install its pinned ESP-EMU runtime."""

import argparse
from hashlib import sha256
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import tarfile
import tempfile
import threading
from urllib.request import urlopen
from uuid import UUID
import webbrowser

ROOT = Path(__file__).resolve().parent
DEMO = ROOT.parent / "sdgoods-chiikawa-go/dist/chiikawa-go-demo-full.bin"
VERSION = "1.1.0"
ARCHIVE_NAME = f"esp-emu-{VERSION}-wasm"
ARCHIVE_URL = f"https://github.com/espressif/esp-emulator/releases/download/v{VERSION}/{ARCHIVE_NAME}.tar.gz"
ARCHIVE_SHA = "948abc2efcc9e254d01609e0856df856eec21f164bb7c7042e6e1471f71c051c"
RUNTIME_FILES = ("esp_emu.js", "esp_emu_bg.wasm")
NATIVE_ARCHIVE = f"esp-emu-{VERSION}-x86_64-unknown-linux-gnu"
NATIVE_SHA = "bcb940dcf48aa6a1b62dbdc4abc37f05431710f4040d9e2504723a5ea4fd5de9"
MAX_FIRMWARE = 32 * 1024 * 1024
install_lock = threading.Lock()
sessions_lock = threading.Lock()
sessions = {}


def release_archive(name, checksum):
    url = ARCHIVE_URL.replace(f"{ARCHIVE_NAME}.tar.gz", f"{name}.tar.gz")
    with urlopen(url, timeout=60) as response:
        archive = response.read()
    if sha256(archive).hexdigest() != checksum:
        raise RuntimeError("ESP-EMU archive checksum mismatch")
    return tarfile.open(fileobj=BytesIO(archive), mode="r:gz")


def native_command():
    if platform.system() == "Linux" and platform.machine() == "x86_64":
        return []
    wsl = shutil.which("wsl.exe")
    if not wsl or platform.machine().upper() != "AMD64":
        return None
    try:
        output = subprocess.check_output([wsl, "--list", "--quiet"], stderr=subprocess.DEVNULL, timeout=4)
        names = output.decode("utf-16-le").replace("\ufeff", "").splitlines()
        distro = next((name.strip() for name in names if name.strip().lower().startswith("ubuntu")), None)
        if distro:
            return [wsl, "--distribution", distro, "--exec"]
    except (OSError, subprocess.SubprocessError, UnicodeError):
        pass
    return None


def install_native(command):
    binary = ROOT / "runtime" / f"esp-emu-{VERSION}-linux"
    with install_lock:
        if not binary.is_file():
            print(f"Downloading native ESP-EMU {VERSION} …", flush=True)
            with (
                release_archive(NATIVE_ARCHIVE, NATIVE_SHA) as package,
                package.extractfile(f"{NATIVE_ARCHIVE}/esp-emu") as source,
            ):
                temp = binary.with_suffix(".download")
                temp.write_bytes(source.read())
                temp.chmod(0o755)
                temp.replace(binary)
        if command:
            unix_root = subprocess.check_output(
                [*command, "wslpath", "-a", str(ROOT)], timeout=20, stderr=subprocess.DEVNULL,
            ).decode().strip()
        else:
            unix_root = str(ROOT)
    return unix_root, binary.name


def install_runtime():
    runtime = ROOT / "runtime"
    marker = runtime / f"release-{VERSION}"
    if marker.is_file() and all((runtime / name).is_file() for name in RUNTIME_FILES):
        return
    runtime.mkdir(exist_ok=True)
    print(f"Downloading ESP-EMU {VERSION} …", flush=True)
    with release_archive(ARCHIVE_NAME, ARCHIVE_SHA) as package:
        for name in RUNTIME_FILES:
            with package.extractfile(f"{ARCHIVE_NAME}/www/pkg/{name}") as source:
                (runtime / name).write_bytes(source.read())
    marker.touch()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        if path.split("?", 1)[0] == "/demo.bin":
            return str(DEMO)
        return super().translate_path(path)

    def do_GET(self):
        if self.path == "/native/status":
            payload = json.dumps({"available": self.server.native is not None}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            super().do_GET()

    def do_POST(self):
        # Only this localhost page may start emulators or drive their inputs.
        if self.headers.get("Origin") != f"http://{self.headers.get('Host')}":
            self.send_error(403)
            return
        try:
            part, endpoint, action, identifier = self.path.split("/")
            if part or endpoint != "native":
                raise ValueError
            identifier = UUID(identifier).hex
            size = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self.send_error(400)
            return
        if action == "run" and 0 < size <= MAX_FIRMWARE:
            self.run_native(identifier, self.rfile.read(size))
        elif action == "input" and 0 < size <= 256:
            self.native_input(identifier, self.rfile.read(size))
        elif action == "stop" and size == 0:
            with sessions_lock:
                process = sessions.pop(identifier, None)
                if process is not None:
                    process.stdin.close()
            self.send_response(204)
            self.end_headers()
        else:
            self.send_error(400)

    def native_input(self, identifier, payload):
        try:
            value = json.loads(payload)
            if value["type"] == "touch":
                touch = value["touch"]
                if not all(type(touch[k]) is int and 0 <= touch[k] < 360 for k in ("x", "y")):
                    raise ValueError
                if type(touch["down"]) is not bool:
                    raise ValueError
            elif value["type"] != "key" or type(value["down"]) is not bool:
                raise ValueError
        except (KeyError, TypeError, ValueError):
            self.send_error(400)
            return
        with sessions_lock:
            process = sessions.get(identifier)
            try:
                if process is not None:
                    process.stdin.write(json.dumps(value).encode() + b"\n")
            except OSError:
                pass
        self.send_response(204)
        self.end_headers()

    def run_native(self, identifier, firmware):
        command = self.server.native
        if command is None:
            self.send_error(503, "Native ESP-EMU needs x86-64 Linux or Ubuntu WSL")
            return
        try:
            unix_root, binary = install_native(command)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            self.send_error(503, "Native ESP-EMU could not start", explain=str(error))
            return
        with tempfile.TemporaryDirectory(prefix="flash-", dir=ROOT / "runtime") as work:
            flash = Path(work) / "firmware.bin"
            flash.write_bytes(firmware)
            target = f"{unix_root}/runtime/{flash.parent.name}/{flash.name}"
            with subprocess.Popen(
                [*command, "python3", f"{unix_root}/native_bridge.py",
                 f"{unix_root}/runtime/{binary}", target],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
            ) as process:
                with sessions_lock:
                    sessions[identifier] = process
                try:
                    self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    while chunk := process.stdout.read(65536):
                        self.wfile.write(chunk)
                except OSError:
                    pass
                finally:
                    with sessions_lock:
                        sessions.pop(identifier, None)
                        process.stdin.close()
                    try:
                        process.wait(timeout=4)
                    except subprocess.TimeoutExpired:
                        process.kill()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    options = parser.parse_args()
    install_runtime()
    with ThreadingHTTPServer(("127.0.0.1", options.port), Handler) as server:
        server.native = native_command()
        url = f"http://127.0.0.1:{server.server_port}/"
        print(url, flush=True)
        if not options.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
