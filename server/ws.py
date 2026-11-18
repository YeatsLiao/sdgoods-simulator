"""Minimal server-side WebSocket (RFC 6455) used after an HTTP upgrade."""

from __future__ import annotations

import base64
from hashlib import sha1
import struct
import threading
from typing import Optional, Tuple

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE = 40 * 1024 * 1024

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

_CHUNK = 1 << 16


class WebSocketError(Exception):
    """A malformed or oversized WebSocket frame from the browser."""


def _unmask(data: bytes, mask: bytes) -> bytes:
    # Chunked big-int XOR keeps 32 MiB load frames out of a per-byte Python loop.
    result = bytearray(data)
    for start in range(0, len(result), _CHUNK):
        end = min(start + _CHUNK, len(result))
        size = end - start
        key = (mask * (size // 4 + 1))[:size]
        value = int.from_bytes(result[start:end], "big") ^ int.from_bytes(key, "big")
        result[start:end] = value.to_bytes(size, "big")
    return bytes(result)


def handshake(handler) -> Optional["WebSocket"]:
    """Complete a 101 upgrade on a BaseHTTPRequestHandler, or send 400."""
    upgrade = handler.headers.get("Upgrade", "")
    connection = {token.strip().lower() for token in handler.headers.get("Connection", "").split(",")}
    version = handler.headers.get("Sec-WebSocket-Version", "")
    key = handler.headers.get("Sec-WebSocket-Key", "")
    try:
        valid_key = len(base64.b64decode(key, validate=True)) == 16
    except (ValueError, TypeError):
        valid_key = False
    if upgrade.lower() != "websocket" or "upgrade" not in connection or version != "13" or not valid_key:
        handler.send_error(400, "Expected a WebSocket upgrade")
        return None
    accept = base64.b64encode(sha1((key + GUID).encode()).digest()).decode()
    handler.send_response(101, "Switching Protocols")
    handler.send_header("Upgrade", "websocket")
    handler.send_header("Connection", "Upgrade")
    handler.send_header("Sec-WebSocket-Accept", accept)
    handler.end_headers()
    handler.wfile.flush()
    handler.close_connection = True
    return WebSocket(handler)


class WebSocket:
    """One upgraded connection. read() runs on the HTTP handler thread."""

    def __init__(self, handler) -> None:
        self._reader = handler.rfile
        self._writer = handler.wfile
        self._lock = threading.RLock()
        self._closed = False
        self._fragment_opcode: Optional[int] = None
        self._fragments: list[bytes] = []
        self._fragment_size = 0

    def _read_exact(self, count: int) -> Optional[bytes]:
        if count == 0:
            return b""
        data = self._reader.read(count)
        if data is None or len(data) != count:
            return None
        return data

    def read(self) -> Optional[Tuple[int, bytes]]:
        """Return (opcode, payload) for one full data message, None on close."""
        while True:
            header = self._read_exact(2)
            if header is None:
                return None
            if header[0] & 0x70:
                raise WebSocketError("WebSocket 扩展位未协商")
            fin = bool(header[0] & 0x80)
            opcode = header[0] & 0x0F
            masked = bool(header[1] & 0x80)
            length = header[1] & 0x7F
            if length == 126:
                raw = self._read_exact(2)
                if raw is None:
                    return None
                length = struct.unpack(">H", raw)[0]
            elif length == 127:
                raw = self._read_exact(8)
                if raw is None:
                    return None
                length = struct.unpack(">Q", raw)[0]
            if length > MAX_MESSAGE:
                raise WebSocketError("WebSocket 消息超过 40 MiB")
            if not masked:
                raise WebSocketError("客户端 WebSocket 帧必须掩码")
            if opcode >= OP_CLOSE and (not fin or length > 125):
                raise WebSocketError("WebSocket 控制帧无效")
            mask = self._read_exact(4)
            if mask is None:
                return None
            payload = self._read_exact(length)
            if payload is None:
                return None
            if length:
                payload = _unmask(payload, mask)

            if opcode == OP_CLOSE:
                with self._lock:
                    if not self._closed:
                        self._send_frame(OP_CLOSE, payload[:125])
                        self._closed = True
                return None
            if opcode == OP_PING:
                self._send_frame(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CONT:
                if self._fragment_opcode is None:
                    raise WebSocketError("WebSocket 续帧没有起始帧")
                self._fragment_size += len(payload)
                if self._fragment_size > MAX_MESSAGE:
                    raise WebSocketError("WebSocket 消息超过 40 MiB")
                self._fragments.append(payload)
                if not fin:
                    continue
                message = b"".join(self._fragments)
                result_opcode = self._fragment_opcode
                self._fragment_opcode = None
                self._fragments = []
                self._fragment_size = 0
                return result_opcode, message
            if opcode in (OP_TEXT, OP_BINARY):
                if self._fragment_opcode is not None:
                    raise WebSocketError("WebSocket 分片消息尚未结束")
                if fin:
                    return opcode, payload
                if length > MAX_MESSAGE:
                    raise WebSocketError("WebSocket 消息超过 40 MiB")
                self._fragment_opcode = opcode
                self._fragments = [payload]
                self._fragment_size = length
                continue
            raise WebSocketError("未知的 WebSocket 帧类型")

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        size = len(payload)
        if size < 126:
            header = bytes((0x80 | opcode, size))
        elif size <= 0xFFFF:
            header = bytes((0x80 | opcode, 126)) + struct.pack(">H", size)
        else:
            header = bytes((0x80 | opcode, 127)) + struct.pack(">Q", size)
        with self._lock:
            if self._closed and opcode != OP_CLOSE:
                return
            self._writer.write(header + payload)
            self._writer.flush()

    def send_binary(self, data) -> None:
        self._send_frame(OP_BINARY, bytes(data))

    def send_text(self, data) -> None:
        if isinstance(data, str):
            data = data.encode("utf-8")
        self._send_frame(OP_TEXT, bytes(data))

    def close(self, code: int = 1000, reason: str = "") -> None:
        with self._lock:
            if self._closed:
                return
            payload = struct.pack(">H", code) + reason.encode("utf-8")[:123]
            try:
                self._send_frame(OP_CLOSE, payload)
            finally:
                self._closed = True
