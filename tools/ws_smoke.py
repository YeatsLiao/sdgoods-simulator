"""Tiny stdlib WebSocket client used to smoke-test /ws/native."""

from __future__ import annotations

import argparse
import base64
from hashlib import sha1, sha256
import json
import os
from pathlib import Path
import socket
import struct
import sys
import time
from urllib.parse import urlsplit

WIRE_FRAME = 0x01
WIRE_AUDIO = 0x02
WIRE_LOG = 0x03
WIRE_EVENT = 0x04
WIRE_FLASH = 0x05
WIRE_LOAD = 0x10
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def mask_bytes(data: bytes, mask: bytes) -> bytes:
    result = bytearray(data)
    for start in range(0, len(result), 1 << 16):
        end = min(start + (1 << 16), len(result))
        size = end - start
        key = (mask * (size // 4 + 1))[:size]
        value = int.from_bytes(result[start:end], "big") ^ int.from_bytes(key, "big")
        result[start:end] = value.to_bytes(size, "big")
    return bytes(result)


class Client:
    def __init__(self, url: str, origin: str, timeout: float = 10.0) -> None:
        parts = urlsplit(url)
        if parts.scheme != "ws":
            raise SystemExit("ws_smoke only supports ws:// URLs")
        host = parts.hostname or "127.0.0.1"
        port = parts.port or 80
        path = parts.path or "/"
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(1.0)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Origin: {origin}\r\n"
            "\r\n"
        )
        self.sock.sendall(request.encode())
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise SystemExit("WebSocket handshake closed early")
            response += chunk
        head = response.split(b"\r\n\r\n", 1)[0].decode("latin1")
        if " 101 " not in head.splitlines()[0]:
            raise SystemExit(head)
        expected = base64.b64encode(sha1((key + GUID).encode()).digest()).decode()
        if expected not in head:
            raise SystemExit("bad Sec-WebSocket-Accept")
        self.pending = response.split(b"\r\n\r\n", 1)[1]

    def send_frame(self, opcode: int, payload: bytes) -> None:
        size = len(payload)
        if size < 126:
            header = bytes((0x80 | opcode, 0x80 | size))
        elif size <= 0xFFFF:
            header = bytes((0x80 | opcode, 0xFE)) + struct.pack(">H", size)
        else:
            header = bytes((0x80 | opcode, 0xFF)) + struct.pack(">Q", size)
        mask = os.urandom(4)
        self.sock.settimeout(30.0)
        self.sock.sendall(header + mask + mask_bytes(payload, mask))
        self.sock.settimeout(1.0)

    def send_text(self, text: str) -> None:
        self.send_frame(0x1, text.encode())

    def send_load(self, name: str, firmware: bytes, flash_key: str) -> None:
        meta = json.dumps({
            "name": name,
            "size": len(firmware),
            "sha256": flash_key,
            "flashKey": flash_key,
            "preserveFlash": True,
        }).encode()
        payload = bytes((WIRE_LOAD,)) + struct.pack("<I", len(meta)) + meta + firmware
        self.send_frame(0x2, payload)

    def _read_exact(self, count: int) -> bytes:
        buffer = bytearray(self.pending)
        self.pending = b""
        while len(buffer) < count:
            chunk = self.sock.recv(count - len(buffer))
            if not chunk:
                self.eof = True
                raise EOFError
            buffer.extend(chunk)
        data = bytes(buffer[:count])
        self.pending = bytes(buffer[count:])
        return data

    def read_frame(self, timeout: float) -> tuple[int, bytes] | None:
        self.sock.settimeout(timeout)
        try:
            header = self._read_exact(2)
        except socket.timeout:
            return None
        except EOFError:
            return None
        fin = bool(header[0] & 0x80)
        opcode = header[0] & 0x0F
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_exact(8))[0]
        payload = self._read_exact(length) if length else b""
        if opcode == 0x9:
            self.send_frame(0xA, payload)
            return 0xA, b""
        if opcode == 0x8:
            self.eof = True
            return None
        if not fin:
            raise SystemExit("unexpected fragmented server frame")
        return opcode, payload

    def close(self) -> None:
        try:
            self.send_frame(0x8, struct.pack(">H", 1000))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


def default_firmware() -> Path:
    base = Path(__file__).resolve().parent.parent / ".." / "sdgoods-chiikawa-go" / "dist"
    for name in ("chiikawa-go-demo-0.1.1-full.bin", "chiikawa-go-demo-full.bin"):
        candidate = (base / name).resolve()
        if candidate.is_file():
            return candidate
    raise SystemExit("sample firmware not found; pass --firmware")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="ws://127.0.0.1:8766/ws/native")
    parser.add_argument("--origin", default="")
    parser.add_argument("--firmware", default="")
    parser.add_argument("--seconds", type=float, default=12.0, help="run time after boot")
    parser.add_argument("--flash", action="store_true", help="request a flash export")
    parser.add_argument("--restart", action="store_true", help="send a restart after boot")
    parser.add_argument("--quiet", action="store_true")
    options = parser.parse_args()

    firmware_path = Path(options.firmware) if options.firmware else default_firmware()
    firmware = firmware_path.read_bytes()
    origin = options.origin
    if not origin:
        parts = urlsplit(options.url)
        origin = f"http://{parts.hostname}:{parts.port or 80}"
    client = Client(options.url, origin)
    print(f"connected {options.url} ({len(firmware)} bytes)")
    digest = sha256(firmware).hexdigest()
    client.send_load(firmware_path.name, firmware, digest)

    booted = False
    frames = 0
    logs = 0
    audio = 0
    flash_size = 0
    restart_sent = False
    flash_sent = False
    deadline = time.monotonic() + 40
    quiet_until = 0.0
    exit_ok = False
    while time.monotonic() < deadline:
        message = client.read_frame(0.5)
        if message is None:
            if client.eof or (booted and time.monotonic() > quiet_until):
                break
            continue
        _, data = message
        if not data:
            continue
        kind, payload = data[0], data[1:]
        if kind == WIRE_LOG:
            logs += 1
            text = payload.decode("utf-8", "replace")
            if not options.quiet and logs <= 20:
                print("log:", text.rstrip())
        elif kind == WIRE_FRAME:
            frames += 1
        elif kind == WIRE_AUDIO:
            audio += 1
        elif kind == WIRE_FLASH:
            flash_size = len(payload)
            print(f"flash: {flash_size} bytes")
        elif kind == WIRE_EVENT:
            event = json.loads(payload.decode("utf-8"))
            name = event.get("kind")
            if name == "booted":
                booted = True
                print("booted:", event.get("info"))
                quiet_until = time.monotonic() + options.seconds
                if options.restart and not restart_sent:
                    client.send_text(json.dumps({"type": "restart", "clearFlash": False}))
                    restart_sent = True
                if options.flash and not flash_sent:
                    client.send_text(json.dumps({"type": "flash"}))
                    flash_sent = True
            elif name == "stats":
                if not options.quiet:
                    print("stats:", event.get("stats"))
            else:
                print("event:", event)
                if name == "reset":
                    exit_ok = True
        if booted and time.monotonic() > quiet_until and (frames or logs):
            break
    client.close()
    print(
        f"summary booted={booted} frames={frames} logs={logs} audio={audio} "
        f"flash={flash_size} restart={restart_sent} reset={exit_ok}"
    )
    return 0 if booted or frames or logs else 1


if __name__ == "__main__":
    sys.exit(main())
