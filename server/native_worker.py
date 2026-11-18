"""Persistent ESP-EMU session worker.

Runs under Linux/WSL. stdin/stdout carry length-prefixed frames; stdout is a
binary channel only, so every diagnostic goes through the framed log/event
messages. See docs/PROTOCOL.md for the wire types.
"""

from __future__ import annotations

import base64
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

WIRE_FRAME = 0x01
WIRE_AUDIO = 0x02
WIRE_LOG = 0x03
WIRE_EVENT = 0x04
WIRE_FLASH = 0x05

WIRE_LOAD = 0x10
WIRE_ELF = 0x11
WIRE_MIC = 0x12

PEER = "sdgoods-dimension-screen"

MAX_FIRMWARE = 32 * 1024 * 1024
MAX_FLASH = 32 * 1024 * 1024
MAX_UART = 64 * 1024
MAX_WORKER_FRAME = 48 * 1024 * 1024
FLASH_SIZES = {0: 1, 1: 2, 2: 4, 3: 8, 4: 16, 5: 32, 6: 64, 7: 128}
FLASH_KEY_PATTERN = re.compile(r"^(?:slot-\d+-)?[0-9a-f]{8,64}$")
# Slot boots use `slot-<index>-<sha256>` so each slot/app pair keeps its own
# flash session while switching firmware does not reset another app's data.
SPEAKER_DEFAULT = {"receive": False, "rate": 16000, "channels": 2, "bits": 16}


def varint(value: int) -> bytes:
    encoded = bytearray()
    while value >= 128:
        encoded.append((value & 127) | 128)
        value >>= 7
    return bytes(encoded) + bytes((value,))


def number(tag: int, value: int) -> bytes:
    return varint(tag * 8) + varint(value)


def packet(tag: int, data: bytes) -> bytes:
    return varint(tag * 8 + 2) + varint(len(data)) + data


def fields(data: bytes) -> dict:
    cursor = 0
    result: dict[int, object] = {}

    def read() -> int:
        nonlocal cursor
        value = shift = 0
        while True:
            if cursor >= len(data):
                raise ValueError("外设消息被截断")
            byte = data[cursor]
            cursor += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
            shift += 7
            if shift > 63:
                raise ValueError("外设消息 varint 过长")

    while cursor < len(data):
        key = read()
        wire_type = key & 7
        tag = key >> 3
        if wire_type == 0:
            result[tag] = read()
        elif wire_type == 2:
            length = read()
            if cursor + length > len(data):
                raise ValueError("外设消息长度错误")
            result[tag] = data[cursor:cursor + length]
            cursor += length
        else:
            raise ValueError(f"不支持的外设字段 {wire_type}")
    return result


def flash_size_for(firmware: bytes) -> int:
    if len(firmware) >= 4:
        code = (firmware[3] >> 4) & 0x0F
        megabytes = FLASH_SIZES.get(code)
        if megabytes:
            return min(megabytes, 32) * 1024 * 1024
    return 4 * 1024 * 1024


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
        reservation.bind(("127.0.0.1", 0))
        return reservation.getsockname()[1]


def write_atomic(path: Path, data: bytes) -> None:
    temp = path.with_name(path.name + ".new")
    temp.write_bytes(data)
    os.replace(temp, path)


class Output:
    """Framed stdout writer shared by the reader, bus, log and stats threads."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stream = sys.stdout.buffer
        self.broken = False

    def send(self, kind: int, payload: bytes = b"") -> None:
        with self._lock:
            if self.broken:
                return
            try:
                self._stream.write(struct.pack("<I", len(payload) + 1))
                self._stream.write(bytes((kind,)))
                self._stream.write(payload)
                self._stream.flush()
            except (BrokenPipeError, OSError):
                self.broken = True

    def event(self, kind: str, **values) -> None:
        message = json.dumps({"kind": kind, **values}, ensure_ascii=False, separators=(",", ":"))
        self.send(WIRE_EVENT, message.encode("utf-8"))

    def log(self, data: bytes) -> None:
        self.send(WIRE_LOG, data)

    def error(self, message: object) -> None:
        self.event("error", message=str(message))


def registration() -> bytes:
    lcd = packet(3, number(1, 21))
    touch = packet(2, number(1, 0x15) + number(2, 10) + number(3, 11))
    key = packet(1, number(1, 1 << 6))
    audio = packet(17, number(1, 48) + number(2, 38) + number(3, 47) + number(4, 17))
    claims = b"".join(packet(3, claim) for claim in (lcd, touch, key, audio))
    return packet(4, number(1, 1) + packet(2, PEER.encode()) + claims)


class Session:
    """One ESP-EMU process plus its co-simulation connection and inputs."""

    def __init__(
        self,
        worker: "Worker",
        directory: Path,
        flash: Path,
        elf: Path | None,
        name: str,
        size: int,
        flash_size: int,
    ) -> None:
        self.worker = worker
        self.output = worker.output
        self.directory = directory
        self.flash = flash
        self.elf = elf
        self.name = name
        self.size = size
        self.flash_size = flash_size
        self.process: subprocess.Popen | None = None
        self.bus: socket.socket | None = None
        self.cosim_port = 0
        self.control_port = 0

        self._bus_lock = threading.Lock()
        self._touch_lock = threading.Lock()
        self._stdin_lock = threading.Lock()
        self._stats_lock = threading.Lock()

        self.touch = (0, 0, False)
        self.pending_release = None
        self.sampled = False
        self.register = 0
        self.clock = 0
        self.out_format: dict | None = None
        self.mic_format: dict | None = None
        self.frames = 0

        self.stopping = threading.Event()
        self.threads: list[threading.Thread] = []

    def start(self) -> None:
        self.cosim_port = free_port()
        self.control_port = free_port()
        argv = [
            str(self.worker.binary),
            "--chip", "esp32s3",
            "--firmware", str(self.flash),
            "--cosim-tcp", f"127.0.0.1:{self.cosim_port}",
            "--control-tcp", f"127.0.0.1:{self.control_port}",
            "--save-state",
            "--net", "user",
        ]
        if self.elf is not None and self.elf.is_file() and self.elf.stat().st_size:
            argv += ["--elf", str(self.elf)]
        try:
            self.process = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=0,
            )
        except OSError as error:
            raise RuntimeError(f"无法启动 ESP-EMU：{error}") from error
        self.threads = [
            threading.Thread(target=self._log_loop, name="emu-log", daemon=True),
            threading.Thread(target=self._bus_loop, name="emu-bus", daemon=True),
            threading.Thread(target=self._stats_loop, name="emu-stats", daemon=True),
        ]
        for thread in self.threads:
            thread.start()

    def _log_loop(self) -> None:
        stream = self.process.stdout if self.process else None
        if stream is None:
            return
        try:
            for line in iter(stream.readline, b""):
                self.output.log(line)
        except (OSError, ValueError):
            pass
        finally:
            if not self.stopping.is_set():
                code = self.process.poll() if self.process else None
                suffix = f"（代码 {code}）" if code is not None else ""
                self.output.error(f"ESP-EMU 已退出{suffix}")

    def _bus_loop(self) -> None:
        deadline = time.monotonic() + 30
        bus = None
        while not self.stopping.is_set():
            try:
                bus = socket.create_connection(("127.0.0.1", self.cosim_port), timeout=1)
                break
            except OSError:
                if self.process is not None and self.process.poll() is not None:
                    self.output.error("ESP-EMU 启动失败，请查看日志")
                    return
                if time.monotonic() >= deadline:
                    self.output.error("ESP-EMU 未能打开协同仿真端口")
                    return
                time.sleep(0.03)
        if bus is None:
            return
        self.bus = bus
        try:
            bus.settimeout(None)
            bus.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self._send(registration())
            self.output.event("booted", info={"name": self.name, "size": self.size, "mode": "native"})
            with bus.makefile("rb") as stream:
                while not self.stopping.is_set():
                    header = stream.read(4)
                    if len(header) != 4:
                        break
                    length = struct.unpack("<I", header)[0]
                    if length <= 0 or length > MAX_WORKER_FRAME:
                        raise ValueError("协同仿真帧长度无效")
                    frame = stream.read(length)
                    if len(frame) != length:
                        break
                    self._handle_frame(frame)
        except (OSError, ValueError) as error:
            if not self.stopping.is_set():
                self.output.error(f"协同仿真连接中断：{error}")
        finally:
            try:
                bus.close()
            except OSError:
                pass
            self.bus = None

    def _handle_frame(self, frame: bytes) -> None:
        if len(frame) < 2:
            return
        topic_length = struct.unpack_from("<H", frame)[0]
        if 2 + topic_length > len(frame):
            return
        topic = frame[2:2 + topic_length]
        if topic == b"SIM/CLOCK":
            return
        message = fields(frame[2 + topic_length:])
        self.clock = message.get(1, self.clock)
        if 5 in message:
            ack = fields(message[5])
            if not ack.get(5):
                reason = ack.get(6, b"Board registration refused")
                raise ValueError(reason.decode("utf-8", "replace"))
        if 29 in message:
            raw = fields(message[29])
            fmt = {
                "receive": bool(raw.get(1)),
                "rate": raw.get(2, 0),
                "channels": raw.get(3, 0),
                "bits": raw.get(4, 0),
            }
            if fmt["receive"]:
                self.mic_format = fmt
            else:
                self.out_format = fmt
            self.output.event("audioformat", format=fmt)
        if 30 in message:
            pcm = fields(message[30]).get(1, b"")
            if pcm:
                self._emit_audio(pcm)
        if 7 not in message:
            return
        request = fields(message[7])
        if 2 in request:
            self.reply(request, 1, self._read_touch(fields(request[2])))
        elif 3 in request:
            transfer = request[3]
            spi = fields(transfer)
            if spi.get(4):
                self.reply(request, 2, bytes(spi[4]))
            self._emit_frame(transfer)

    def _emit_audio(self, pcm: bytes) -> None:
        fmt = self.out_format or SPEAKER_DEFAULT
        header = struct.pack(
            "<IBBBB",
            int(fmt.get("rate") or 16000),
            int(fmt.get("channels") or 2),
            int(fmt.get("bits") or 16),
            1 if fmt.get("receive") else 0,
            0,
        )
        self.output.send(WIRE_AUDIO, header + pcm)

    def _emit_frame(self, transfer: bytes) -> None:
        with self._stats_lock:
            self.frames += 1
            counter = self.frames & 0xFFFFFFFF
        self.output.send(WIRE_FRAME, struct.pack("<I", counter) + transfer)

    def _read_touch(self, transaction: dict) -> bytes:
        write = transaction.get(3, b"")
        if write:
            self.register = write[0]
        count = transaction.get(4, 0)
        with self._touch_lock:
            x, y, down = self.touch
            x, y = 359 - y, x
            report = bytes((1 if down else 0, x >> 8, x & 255, y >> 8, y & 255))
            result = bytes(
                report[index - 2] if 2 <= index < 7 else 0
                for index in range(self.register, self.register + count)
            )
            self.register += count
            if count and down and self.register >= 7:
                self.sampled = True
                if self.pending_release is not None:
                    self.touch, self.pending_release = self.pending_release, None
        return result

    def set_touch(self, touch: dict) -> None:
        x, y, down = int(touch["x"]), int(touch["y"]), bool(touch["down"])
        if not (0 <= x < 360 and 0 <= y < 360):
            raise ValueError("触摸坐标越界")
        next_touch = (x, y, down)
        with self._touch_lock:
            if not down and self.touch[2] and not self.sampled:
                self.pending_release = next_touch
                return
            if down and (not self.touch[2] or self.pending_release is not None):
                self.sampled = False
            self.pending_release = None
            self.touch = next_touch

    def reset_input(self) -> None:
        with self._touch_lock:
            self.pending_release = None
            self.sampled = False
            self.register = 0

    def key(self, down: bool) -> None:
        drive = number(1, 6) + number(2, 0 if down else 1)
        self._send(number(1, self.clock) + packet(6, drive))

    def uart(self, text: str) -> None:
        if not self.process or not self.process.stdin:
            return
        with self._stdin_lock:
            try:
                self.process.stdin.write(text.encode("utf-8") + b"\n")
                self.process.stdin.flush()
            except (BrokenPipeError, OSError):
                pass

    def mic(self, pcm: bytes) -> None:
        if pcm:
            self._send(packet(31, packet(1, pcm)))

    def reply(self, request: dict, op: int, data: bytes) -> None:
        response = number(1, int(request.get(1, 0))) + number(2, 1)
        response += packet(3, data) + number(4, op)
        self._send(packet(8, response))

    def _send(self, data: bytes) -> None:
        with self._bus_lock:
            if self.bus is None:
                return
            try:
                self.bus.sendall(struct.pack("<I", len(data)) + data)
            except OSError:
                pass

    def control(self, command: str, timeout: float = 5.0, wait: float = 5.0) -> str:
        deadline = time.monotonic() + wait
        while True:
            try:
                with socket.create_connection(
                    ("127.0.0.1", self.control_port), timeout=timeout,
                ) as channel:
                    channel.sendall(command.encode("utf-8") + b"\n")
                    channel.settimeout(timeout)
                    with channel.makefile("rb") as stream:
                        line = stream.readline(4096)
                break
            except ConnectionRefusedError:
                # The co-sim socket opens before the control listener in some boots.
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)
        if not line:
            raise RuntimeError("控制通道没有响应")
        text = line.decode("utf-8", "replace").strip()
        if text.lower().startswith("err"):
            raise RuntimeError(text)
        return text

    def read_flash(self, timeout: float = 60.0) -> bytes:
        handle, temp_name = tempfile.mkstemp(prefix="esp-emu-flash-", suffix=".bin")
        os.close(handle)
        temp = Path(temp_name)
        try:
            self.control(f"read-region 0 {self.flash_size} {temp_name}", timeout=timeout)
            data = temp.read_bytes()
            if not data:
                raise RuntimeError("Flash 快照为空")
            if len(data) > MAX_FLASH:
                raise RuntimeError("Flash 快照超过 32 MiB")
            write_atomic(self.flash, data)
            return data
        finally:
            temp.unlink(missing_ok=True)

    def _stats_loop(self) -> None:
        last = time.monotonic()
        last_frames = 0
        while not self.stopping.wait(1.0):
            now = time.monotonic()
            with self._stats_lock:
                frames = self.frames
            elapsed = max(0.001, now - last)
            fps = (frames - last_frames) / elapsed
            last, last_frames = now, frames
            self.output.event("stats", stats={
                "fps": round(fps, 2),
                "frames": frames,
                "transport": "ws",
            })

    def stop(self, snapshot: bool = True) -> bytes | None:
        self.stopping.set()
        snapshot_data = None
        if snapshot and self.process is not None and self.process.poll() is None:
            try:
                snapshot_data = self.read_flash()
            except (OSError, RuntimeError):
                # --save-state still writes the firmware file on graceful exit.
                pass
        if self.bus is not None:
            try:
                self.bus.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                self.bus.close()
            except OSError:
                pass
        process = self.process
        if process is not None:
            if process.stdin is not None:
                try:
                    process.stdin.close()
                except OSError:
                    pass
            try:
                process.wait(timeout=3)
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
        for thread in self.threads:
            if thread is not threading.current_thread():
                thread.join(timeout=2)
        return snapshot_data


class Worker:
    def __init__(self, root: Path, binary: Path) -> None:
        self.root = root
        self.binary = binary
        self.sessions = root / "runtime" / "sessions"
        self.sessions.mkdir(parents=True, exist_ok=True)
        self.output = Output()
        self.lock = threading.RLock()
        self.stopping = threading.Event()
        self.session: Session | None = None
        self.firmware: dict | None = None
        self.elf: bytes | None = None
        self.pending_flash: bytes | None = None
        self.flash_path: Path | None = None

    def run(self) -> None:
        signal.signal(signal.SIGTERM, self._on_signal)
        signal.signal(signal.SIGINT, self._on_signal)
        stdin = sys.stdin.fileno()
        pending = bytearray()
        while not self.stopping.is_set() and not self.output.broken:
            try:
                readable, _, _ = select.select([stdin], [], [], 0.2)
            except (OSError, ValueError):
                break
            if not readable:
                continue
            try:
                chunk = os.read(stdin, 1 << 16)
            except OSError:
                break
            if not chunk:
                break
            pending.extend(chunk)
            while True:
                frame = self._take_frame(pending)
                if frame is None:
                    break
                kind, payload = frame
                try:
                    self._dispatch(kind, payload)
                except Exception as error:  # A bad command must not end the session.
                    self.output.error(error)
        self.shutdown()

    @staticmethod
    def _take_frame(buffer: bytearray) -> tuple[int, bytes] | None:
        if len(buffer) < 4:
            return None
        length = struct.unpack_from("<I", buffer)[0]
        if length < 1 or length > MAX_WORKER_FRAME:
            raise ValueError("控制帧长度无效")
        if len(buffer) < 4 + length:
            return None
        kind = buffer[4]
        payload = bytes(buffer[5:4 + length])
        del buffer[:4 + length]
        return kind, payload

    def _dispatch(self, kind: int, payload: bytes) -> None:
        if kind == WIRE_LOAD:
            if len(payload) < 4:
                raise ValueError("载入消息不完整")
            json_length = struct.unpack_from("<I", payload)[0]
            if json_length > 64 * 1024 or 4 + json_length > len(payload):
                raise ValueError("载入消息头部无效")
            meta = json.loads(payload[4:4 + json_length].decode("utf-8"))
            self.load(meta, payload[4 + json_length:])
        elif kind == WIRE_ELF:
            self.load_elf(payload)
        elif kind == WIRE_MIC:
            if len(payload) < 8:
                raise ValueError("麦克风帧不完整")
            self.mic(payload[8:])
        elif kind == WIRE_EVENT:
            self.control(json.loads(payload.decode("utf-8")))
        elif kind == 0x13:
            self.import_flash(payload)
        else:
            raise ValueError(f"未知控制帧类型 0x{kind:02x}")

    @staticmethod
    def _flash_key(value: object, digest: str) -> str:
        text = str(value or "").strip().lower()
        if FLASH_KEY_PATTERN.fullmatch(text):
            return text
        return digest[:16]

    @staticmethod
    def _apply_flash_patch(flash: Path, patch: object) -> None:
        """Optionally rewrite a small region (slot boots re-stamp otadata)."""
        if patch is None:
            return
        if not isinstance(patch, dict):
            raise ValueError("flashPatch 格式无效")
        offset = patch.get("offset")
        data = patch.get("data")
        if not isinstance(offset, int) or offset < 0 or not isinstance(data, str):
            raise ValueError("flashPatch 格式无效")
        try:
            raw = base64.b64decode(data, validate=True)
        except ValueError as error:
            raise ValueError("flashPatch 数据无效") from error
        if len(raw) > 64 * 1024:
            raise ValueError("flashPatch 超过 64 KiB")
        if offset + len(raw) > flash.stat().st_size:
            raise ValueError("flashPatch 超出 Flash 镜像")
        with flash.open("r+b") as handle:
            handle.seek(offset)
            handle.write(raw)

    def load(self, meta: dict, firmware: bytes) -> None:
        if not firmware:
            raise ValueError("固件为空")
        if len(firmware) > MAX_FIRMWARE:
            raise ValueError("固件超过 32 MiB")
        if firmware[0] != 0xE9:
            raise ValueError("固件缺少 ESP32 镜像头")
        name = str(meta.get("name") or "firmware.bin")[:200]
        preserve = meta.get("preserveFlash") is not False
        digest = sha256(firmware).hexdigest()
        flash_key = self._flash_key(meta.get("flashKey") or meta.get("sha256"), digest)
        flash_bytes = flash_size_for(firmware)
        with self.lock:
            self.output.event("status", message="正在启动本机模拟器")
            self._stop_current(export=False)
            directory = self.sessions / flash_key
            directory.mkdir(parents=True, exist_ok=True)
            base = directory / "base.bin"
            flash = directory / "flash.bin"
            elf = directory / "app.elf"

            base_changed = True
            if base.is_file() and base.stat().st_size == len(firmware):
                base_changed = sha256(base.read_bytes()).hexdigest() != digest
            if base_changed:
                write_atomic(base, firmware)
            if self.pending_flash is not None:
                write_atomic(flash, self.pending_flash)
                self.pending_flash = None
            elif base_changed or not flash.is_file() or not preserve:
                shutil.copyfile(base, flash)
            self._apply_flash_patch(flash, meta.get("flashPatch"))
            if self.elf:
                write_atomic(elf, self.elf)

            self.firmware = {
                "name": name,
                "size": len(firmware),
                "flash_key": flash_key,
                "flash_bytes": flash_bytes,
                "directory": directory,
                "flash": flash,
                "elf": elf,
            }
            self.flash_path = flash
            self._start_session()

    def _start_session(self) -> None:
        if self.firmware is None:
            raise ValueError("尚未载入固件")
        info = self.firmware
        session = Session(
            self,
            info["directory"],
            info["flash"],
            info["elf"] if info["elf"].is_file() else None,
            info["name"],
            info["size"],
            info["flash_bytes"],
        )
        try:
            session.start()
        except Exception:
            session.stop(snapshot=False)
            raise
        self.session = session

    def _stop_current(self, export: bool) -> bytes | None:
        session, self.session = self.session, None
        if session is None:
            return None
        data = session.stop(snapshot=True)
        if export:
            if data is None and session.flash.is_file():
                data = session.flash.read_bytes()
            if data:
                self.output.send(WIRE_FLASH, data)
        return data

    def control(self, message: dict) -> None:
        kind = message.get("type")
        if kind == "touch":
            session = self.session
            if session:
                session.set_touch(message.get("touch") or {})
        elif kind == "key":
            session = self.session
            if session:
                session.key(bool(message.get("down")))
        elif kind == "uart":
            session = self.session
            if session:
                text = str(message.get("text") or "")[:MAX_UART]
                session.uart(text)
        elif kind == "restart":
            self.restart(clear_flash=bool(message.get("clearFlash")))
        elif kind == "clearFlash":
            self.restart(clear_flash=True)
        elif kind == "stop":
            with self.lock:
                self._stop_current(export=True)
                self.output.event("status", message="已停止")
        elif kind == "flash":
            self.request_flash()
        elif kind in ("registers", "memory", "gpio"):
            self.output.error("本机模式暂不支持该调试项")
        else:
            raise ValueError(f"未知控制消息 {kind}")

    def request_flash(self) -> None:
        with self.lock:
            session = self.session
            if session is not None:
                self.output.send(WIRE_FLASH, session.read_flash())
                return
            if self.flash_path is not None and self.flash_path.is_file():
                self.output.send(WIRE_FLASH, self.flash_path.read_bytes())
                return
        raise ValueError("没有可导出的 Flash")

    def restart(self, clear_flash: bool = False) -> None:
        with self.lock:
            session = self.session
            if session is None:
                raise ValueError("本机模拟器尚未启动")
            if clear_flash:
                session.stop(snapshot=False)
                self.session = None
                base = session.directory / "base.bin"
                session.flash.unlink(missing_ok=True)
                shutil.copyfile(base, session.flash)
                self._start_session()
                self.output.event("reset")
                self.output.event("status", message="Flash 已清除并重新启动")
                return
            try:
                session.control("reset")
            except (OSError, RuntimeError):
                session.stop(snapshot=True)
                self.session = None
                self._start_session()
            else:
                session.reset_input()
            self.output.event("reset")
            self.output.event("status", message="已重启，Flash 数据保留")

    def import_flash(self, data: bytes) -> None:
        if not data:
            raise ValueError("Flash 数据为空")
        if len(data) > MAX_FLASH:
            raise ValueError("Flash 数据超过 32 MiB")
        with self.lock:
            self.pending_flash = data
            if self.session is None or self.firmware is None:
                self.output.event("status", message="Flash 已载入，等待固件")
                return
            self.session.stop(snapshot=False)
            self.session = None
            write_atomic(self.firmware["flash"], data)
            self.pending_flash = None
            self._start_session()
            self.output.event("reset")
            self.output.event("status", message="Flash 已导入并重新启动")

    def load_elf(self, data: bytes) -> None:
        if not data:
            raise ValueError("ELF 数据为空")
        if len(data) > MAX_FIRMWARE:
            raise ValueError("ELF 超过 32 MiB")
        if not data.startswith(b"\x7fELF"):
            raise ValueError("不是有效的 ELF 文件")
        with self.lock:
            self.elf = data
            if self.firmware is not None:
                write_atomic(self.firmware["elf"], data)
            if self.session is not None:
                self.output.event("status", message="ELF 已载入，重新启动固件后生效")
            else:
                self.output.event("status", message="ELF 已载入")

    def mic(self, pcm: bytes) -> None:
        if len(pcm) > 64 * 1024:
            raise ValueError("麦克风帧超过 64 KiB")
        session = self.session
        if session is not None:
            session.mic(pcm)

    def _on_signal(self, signum, frame) -> None:
        self.stopping.set()

    def shutdown(self) -> None:
        self.stopping.set()
        with self.lock:
            self._stop_current(export=False)


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: native_worker.py <root> <esp-emu binary>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    binary = Path(sys.argv[2])
    if not root.is_dir() or not binary.is_file():
        print("native_worker: root or ESP-EMU binary is missing", file=sys.stderr)
        return 2
    worker = Worker(root, binary)
    try:
        worker.run()
    except (OSError, ValueError, RuntimeError) as error:
        worker.output.error(error)
        worker.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
