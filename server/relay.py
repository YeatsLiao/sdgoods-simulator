"""Built-in esp-emu-relay subset for browser mode: TCP, UDP and DNS over WebSocket."""

from __future__ import annotations

import base64
import json
import socket
import struct
import threading
import time
from urllib.parse import parse_qs, urlsplit

import ws

RELAY_VERSION = "1.0.0"
CONNECT_TIMEOUT = 10
UDP_IDLE = 300
CHUNK = 16 * 1024


def _query(path: str) -> tuple[str, dict[str, str]]:
    parts = urlsplit(path)
    query = {key: values[0] for key, values in parse_qs(parts.query).items() if values}
    return parts.path, query


def _host_port(query: dict[str, str]) -> tuple[str, int] | None:
    host = query.get("host", "").strip()
    try:
        port = int(query.get("port", ""))
    except ValueError:
        return None
    if not host or len(host) > 253 or not 0 < port < 65536:
        return None
    return host, port


def _read_dns_name(message: bytes, offset: int) -> tuple[str, int]:
    labels = []
    while offset < len(message):
        length = message[offset]
        offset += 1
        if length == 0:
            break
        if length & 0xC0:
            break
        labels.append(message[offset:offset + length].decode("ascii", "replace"))
        offset += length
    return ".".join(labels), offset


def dns_answer(query: bytes) -> bytes:
    if len(query) < 12:
        return b""
    question, offset = _read_dns_name(query, 12)
    if offset + 4 > len(query):
        return b""
    qtype, qclass = struct.unpack(">HH", query[offset:offset + 4])
    end = offset + 4
    body = query[12:end]
    addresses = []
    if qtype == 1 and question:
        try:
            for item in socket.getaddrinfo(question, None, socket.AF_INET, socket.SOCK_STREAM):
                address = item[4][0]
                if address not in addresses:
                    addresses.append(address)
        except (OSError, UnicodeError):
            pass
    header = query[:2] + struct.pack(">HHHHH", 0x8180, 1, len(addresses), 0, 0)
    answer = b"".join(
        b"\xc0\x0c" + struct.pack(">HHIH", 1, qclass, 60, 4) + socket.inet_aton(address)
        for address in addresses
    )
    return header + body + answer


class TcpFlow:
    def __init__(self, connection: ws.WebSocket, target: tuple[str, int]) -> None:
        self.connection = connection
        self.target = target
        self.socket: socket.socket | None = None
        self.closed = threading.Event()

    def run(self) -> None:
        try:
            self.socket = socket.create_connection(self.target, timeout=CONNECT_TIMEOUT)
            self.socket.settimeout(None)
            self.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            self.connection.close(1011)
            return
        reader = threading.Thread(target=self._read_socket, name="relay-tcp", daemon=True)
        reader.start()
        try:
            while not self.closed.is_set():
                message = self.connection.read()
                if message is None:
                    break
                opcode, data = message
                if opcode == ws.OP_TEXT:
                    continue
                if not data:
                    try:
                        self.socket.shutdown(socket.SHUT_WR)
                    except OSError:
                        break
                    continue
                try:
                    self.socket.sendall(data)
                except OSError:
                    break
        except (ws.WebSocketError, OSError, ValueError):
            pass
        finally:
            self._stop()

    def _read_socket(self) -> None:
        try:
            while not self.closed.is_set() and self.socket is not None:
                data = self.socket.recv(CHUNK)
                if not data:
                    self.connection.send_binary(b"")
                    time.sleep(0.05)
                    self.connection.close(1000)
                    break
                self.connection.send_binary(data)
        except (OSError, ValueError):
            try:
                self.connection.close(1011)
            except (OSError, ValueError):
                pass
        finally:
            self._stop()

    def _stop(self) -> None:
        if self.closed.is_set():
            return
        self.closed.set()
        if self.socket is not None:
            try:
                self.socket.close()
            except OSError:
                pass
        try:
            self.connection.close(1000)
        except (OSError, ValueError):
            pass


class UdpFlow:
    def __init__(self, connection: ws.WebSocket, target: tuple[str, int]) -> None:
        self.connection = connection
        self.target = target
        self.socket: socket.socket | None = None
        self.closed = threading.Event()

    def run(self) -> None:
        try:
            address = socket.getaddrinfo(self.target[0], self.target[1], socket.AF_INET, socket.SOCK_DGRAM)[0][4]
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.socket.settimeout(1)
            self.socket.connect(address)
        except (OSError, IndexError):
            self.connection.close(1011)
            return
        reader = threading.Thread(target=self._read_socket, name="relay-udp", daemon=True)
        reader.start()
        try:
            while not self.closed.is_set():
                message = self.connection.read()
                if message is None:
                    break
                opcode, data = message
                if opcode == ws.OP_BINARY and data:
                    try:
                        self.socket.send(data)
                    except OSError:
                        break
        except (ws.WebSocketError, OSError, ValueError):
            pass
        finally:
            self._stop()

    def _read_socket(self) -> None:
        deadline = time.monotonic() + UDP_IDLE
        try:
            while not self.closed.is_set() and time.monotonic() < deadline:
                try:
                    data = self.socket.recv(65535)
                except socket.timeout:
                    continue
                except OSError:
                    break
                deadline = time.monotonic() + UDP_IDLE
                self.connection.send_binary(data)
        finally:
            self._stop()

    def _stop(self) -> None:
        if self.closed.is_set():
            return
        self.closed.set()
        if self.socket is not None:
            try:
                self.socket.close()
            except OSError:
                pass
        try:
            self.connection.close(1000)
        except (OSError, ValueError):
            pass


def serve(handler, path: str) -> bool:
    """Handle one relay request. Returns False when the path is not ours."""
    route, query = _query(path)
    if route == "/version":
        body = json.dumps({"name": "esp-emu-relay", "version": RELAY_VERSION}).encode()
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
        return True
    if route == "/dns":
        encoded = query.get("dns", "")
        try:
            padded = encoded + "=" * (-len(encoded) % 4)
            query_bytes = base64.urlsafe_b64decode(padded)
        except (ValueError, TypeError):
            handler.send_error(400, "Invalid dns query")
            return True
        body = dns_answer(query_bytes)
        handler.send_response(200 if body else 400)
        handler.send_header("Content-Type", "application/dns-message")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        if body:
            handler.wfile.write(body)
        return True
    target = _host_port(query)
    if route in ("/tcp", "/udp") and handler.headers.get("Upgrade", "").lower() != "websocket":
        if target is None:
            handler.send_error(403, "Invalid target")
        else:
            handler.send_response(204)
            handler.send_header("Content-Length", "0")
            handler.end_headers()
        return True
    if route == "/listen":
        connection = _upgrade(handler)
        if connection is None:
            return True
        try:
            while connection.read() is not None:
                pass
        except (ws.WebSocketError, OSError, ValueError):
            pass
        return True
    if route not in ("/tcp", "/udp"):
        return False
    if target is None:
        handler.send_error(403, "Invalid target")
        return True
    connection = _upgrade(handler)
    if connection is None:
        return True
    flow = TcpFlow(connection, target) if route == "/tcp" else UdpFlow(connection, target)
    flow.run()
    return True


def _upgrade(handler) -> ws.WebSocket | None:
    origin = handler.headers.get("Origin", "")
    if origin:
        host = urlsplit(origin).hostname
        if host not in ("127.0.0.1", "localhost", "::1"):
            handler.send_error(403, "Origin not allowed")
            return None
    try:
        handler.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except OSError:
        pass
    return ws.handshake(handler)