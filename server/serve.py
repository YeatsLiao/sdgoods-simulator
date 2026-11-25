"""Local simulator server: static web assets, sample firmware and WS native mode."""

from __future__ import annotations

import argparse
import atexit
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import webbrowser

SERVER_DIR = Path(__file__).resolve().parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import runtime  # noqa: E402
import relay  # noqa: E402
import ws  # noqa: E402

MAX_TEXT = 64 * 1024
MAX_WORKER_FRAME = 40 * 1024 * 1024
RUNTIME_MIME = {
    "esp_emu.js": "text/javascript; charset=utf-8",
    "esp_emu_bg.wasm": "application/wasm",
}
CHUNK = 1 << 20

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")


def _frame(payload: bytes) -> bytes:
    return len(payload).to_bytes(4, "little") + payload


_bridges: set["NativeBridge"] = set()
_bridges_lock = threading.Lock()


def _close_bridges() -> None:
    with _bridges_lock:
        active = list(_bridges)
    for bridge in active:
        bridge.close()


class NativeBridge:
    """Owns one native_worker child for one WebSocket connection."""

    def __init__(self, handler, socket_: ws.WebSocket) -> None:
        self.handler = handler
        self.ws = socket_
        self.process: subprocess.Popen | None = None
        self.reader: threading.Thread | None = None
        self.done = threading.Event()
        self.closed = False
        self.worker_lock = threading.Lock()
        self._close_lock = threading.Lock()
        self._closed = False
        with _bridges_lock:
            _bridges.add(self)

    def run(self) -> None:
        command = runtime.native_command()
        if command is None:
            self._error("本机加速需要 x86-64 Linux 或装有 Ubuntu 的 WSL，可切换到浏览器模式")
            self.close()
            return
        try:
            unix_root, unix_binary = runtime.install_native(command)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            self._error(f"本机 ESP-EMU 准备失败：{error}")
            self.close()
            return
        argv = [
            *command,
            "python3",
            f"{unix_root}/server/native_worker.py",
            unix_root,
            unix_binary,
        ]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        try:
            self.process = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                creationflags=flags,
            )
        except OSError as error:
            self._error(f"本机 Worker 启动失败：{error}")
            self.close()
            return
        self.reader = threading.Thread(target=self._pump_worker, name="native-out", daemon=True)
        self.reader.start()
        try:
            self._pump_browser()
        except ws.WebSocketError as error:
            self._error(str(error))
        except (OSError, ValueError):
            pass
        finally:
            self.close()

    def _pump_browser(self) -> None:
        while not self.done.is_set():
            message = self.ws.read()
            if message is None:
                return
            opcode, data = message
            if opcode == ws.OP_TEXT:
                if not data:
                    continue
                if len(data) > MAX_TEXT:
                    self._error("控制消息超过 64 KiB")
                    continue
                try:
                    json.loads(data.decode("utf-8"))
                except (UnicodeError, ValueError):
                    self._error("控制消息不是有效的 JSON")
                    continue
                self._to_worker(b"\x04" + data)
            elif opcode == ws.OP_BINARY:
                if not data:
                    continue
                problem = self._validate(data)
                if problem:
                    self._error(problem)
                    continue
                self._to_worker(data)

    def _validate(self, data: bytes) -> str | None:
        kind = data[0]
        size = len(data)
        if kind == 0x10:
            if size < 6:
                return "载入固件消息不完整"
            json_length = int.from_bytes(data[1:5], "little")
            if json_length > MAX_TEXT or 5 + json_length >= size:
                return "载入固件头部无效"
            firmware = size - 5 - json_length
            if firmware > runtime.MAX_FIRMWARE:
                return "固件超过 32 MiB，本机模式无法载入"
        elif kind == 0x11:
            if size - 1 <= 0 or size - 1 > runtime.MAX_FIRMWARE:
                return "ELF 大小无效"
        elif kind == 0x12:
            if size < 10 or size - 9 > runtime.MAX_MIC_FRAME:
                return "麦克风帧大小无效"
        elif kind == 0x13:
            if size - 1 <= 0 or size - 1 > runtime.MAX_FIRMWARE:
                return "Flash 导入大小无效"
        else:
            return f"未知的本机消息类型 0x{kind:02x}"
        return None

    def _to_worker(self, payload: bytes) -> None:
        process = self.process
        if process is None or process.stdin is None:
            raise OSError("本机 Worker 已退出")
        with self.worker_lock:
            process.stdin.write(_frame(payload))
            process.stdin.flush()

    def _pump_worker(self) -> None:
        process = self.process
        stream = process.stdout if process else None
        if stream is None:
            self._finish_reader()
            return
        try:
            while True:
                header = self._read_exact(stream, 4)
                if header is None:
                    break
                length = int.from_bytes(header, "little")
                if length < 1 or length > MAX_WORKER_FRAME:
                    break
                payload = self._read_exact(stream, length)
                if payload is None:
                    break
                if self.closed:
                    continue  # Keep draining so the worker can finish a flash snapshot.
                try:
                    self.ws.send_binary(payload)
                except (OSError, ValueError):
                    self.closed = True
                    self._close_worker_stdin()
        except (OSError, ValueError):
            pass
        finally:
            self._finish_reader()

    @staticmethod
    def _read_exact(stream, count: int) -> bytes | None:
        buffer = bytearray()
        while len(buffer) < count:
            chunk = stream.read(count - len(buffer))
            if not chunk:
                return None
            buffer.extend(chunk)
        return bytes(buffer)

    def _finish_reader(self) -> None:
        self.done.set()
        try:
            self.ws.close()
        except (OSError, ValueError):
            pass
        try:
            self.handler.connection.shutdown(socket.SHUT_RD)
        except OSError:
            pass

    def _close_worker_stdin(self) -> None:
        process = self.process
        if process is None or process.stdin is None:
            return
        with self.worker_lock:
            try:
                process.stdin.close()
            except OSError:
                pass

    def _error(self, message: object) -> None:
        payload = json.dumps(
            {"kind": "error", "message": str(message)}, ensure_ascii=False,
        ).encode("utf-8")
        try:
            self.ws.send_binary(b"\x04" + payload)
        except (OSError, ValueError):
            self.closed = True

    def close(self) -> None:
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
        with _bridges_lock:
            _bridges.discard(self)
        self.done.set()
        self._close_worker_stdin()
        process = self.process
        if process is not None:
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                try:
                    process.terminate()
                    process.wait(timeout=3)
                except (OSError, subprocess.TimeoutExpired):
                    try:
                        process.kill()
                    except OSError:
                        pass
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        pass
        if self.reader is not None:
            self.reader.join(timeout=2)
        try:
            self.ws.close()
        except (OSError, ValueError):
            pass


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "SDGOODSSimulator/1.0"

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, directory=str(runtime.WEB_DIR), **kwargs)

    def log_message(self, format, *args) -> None:
        pass

    def send_header(self, keyword, value) -> None:
        if keyword.lower() == "cache-control":
            self._cache_control = True
        super().send_header(keyword, value)

    def end_headers(self) -> None:
        # Web assets carry no version hash, and the worklet is fetched by URL: a
        # cached copy keeps showing the previous panel after a rebuild.
        if not getattr(self, "_cache_control", False):
            self.send_header("Cache-Control", "no-cache")
        self._cache_control = False
        super().end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path == "/api/status":
            self._json(runtime.status())
        elif path == "/demo.bin":
            self._sample()
        elif path.startswith("/runtime/"):
            self._runtime_file(path[len("/runtime/"):])
        elif path == "/ws/native":
            self._websocket()
        elif path == "/relay" or path.startswith("/relay/"):
            if not relay.serve(self, self.path.split("#", 1)[0][len("/relay"):] or "/"):
                self.send_error(404)
        else:
            super().do_GET()

    def do_HEAD(self) -> None:
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path == "/api/status":
            self._json(runtime.status(), head=True)
        elif path == "/demo.bin":
            self._sample(head=True)
        elif path.startswith("/runtime/"):
            self._runtime_file(path[len("/runtime/"):], head=True)
        else:
            super().do_HEAD()

    def _json(self, payload: dict, head: bool = False) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def _sample(self, head: bool = False) -> None:
        sample = runtime.sample_firmware()
        if sample is None:
            self.send_error(404, "Sample firmware is not built")
            return
        self._send_file(sample, "application/octet-stream", head)

    def _runtime_file(self, name: str, head: bool = False) -> None:
        content_type = RUNTIME_MIME.get(name)
        if content_type is None:
            self.send_error(404)
            return
        path = runtime.RUNTIME_DIR / name
        if not path.is_file():
            self.send_error(404)
            return
        self._send_file(path, content_type, head)

    def _send_file(self, path: Path, content_type: str, head: bool = False) -> None:
        try:
            size = path.stat().st_size
            source = path.open("rb")
        except OSError:
            self.send_error(404)
            return
        with source:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            if head:
                return
            try:
                shutil.copyfileobj(source, self.wfile, CHUNK)
            except OSError:
                pass

    def _same_origin(self) -> bool:
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin", "")
        if not host or not origin or origin == "null":
            return False
        hostname = host
        if hostname.startswith("["):
            hostname = hostname.split("]", 1)[0] + "]"
        elif ":" in hostname:
            hostname = hostname.rsplit(":", 1)[0]
        if hostname.lower() not in ("127.0.0.1", "localhost", "[::1]"):
            return False
        return origin.rstrip("/").lower() == f"http://{host}".lower()

    def _websocket(self) -> None:
        if self.headers.get("Upgrade", "").lower() != "websocket":
            self.send_error(400, "Expected a WebSocket upgrade")
            return
        if not self._same_origin():
            self.send_error(403, "Cross-origin WebSocket is not allowed")
            return
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        try:
            connection = ws.handshake(self)
        except OSError:
            self.close_connection = True
            return
        if connection is None:
            return
        bridge = NativeBridge(self, connection)
        try:
            bridge.run()
        finally:
            self.close_connection = True


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    options = parser.parse_args()
    runtime.install_runtime()
    atexit.register(_close_bridges)
    with Server(("127.0.0.1", options.port), Handler) as server:
        url = f"http://127.0.0.1:{server.server_port}/"
        print(url, flush=True)
        if not options.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
