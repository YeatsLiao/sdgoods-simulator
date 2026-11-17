"""Bridge native ESP-EMU's LCD bus and local input to the browser server."""

import json
from pathlib import Path
import socket
import struct
import subprocess
import sys
import threading
import time
import zlib


def varint(value):
    encoded = bytearray()
    while value >= 128:
        encoded.append((value & 127) | 128)
        value >>= 7
    return bytes(encoded) + bytes([value])


def number(tag, value):
    return varint(tag * 8) + varint(value)


def packet(tag, data):
    return varint(tag * 8 + 2) + varint(len(data)) + data


def fields(data):
    cursor = 0

    def read():
        nonlocal cursor
        result = shift = 0
        while True:
            byte = data[cursor]
            cursor += 1
            result |= (byte & 127) << shift
            if byte < 128:
                return result
            shift += 7

    result = {}
    while cursor < len(data):
        key = read()
        if key & 7 == 0:
            result[key >> 3] = read()
        elif key & 7 == 2:
            length = read()
            result[key >> 3] = data[cursor:cursor + length]
            cursor += length
        else:
            raise ValueError(f"Unsupported co-simulation field {key}")
    return result


def registration():
    lcd = packet(3, number(1, 21))
    touch = packet(2, number(1, 0x15) + number(2, 10) + number(3, 11))
    key = packet(1, number(1, 1 << 6))
    claims = b"".join(packet(3, claim) for claim in (lcd, touch, key))
    return packet(4, number(1, 1) + packet(2, b"sdgoods") + claims)


class Bridge:
    def __init__(self):
        self.output_lock = threading.Lock()
        self.compressor = zlib.compressobj(level=1)
        self.bus_lock = threading.Lock()
        self.touch_lock = threading.Lock()
        self.stopping = threading.Event()
        self.bus = None
        self.touch = (0, 0, False)
        self.release = None
        self.sampled = False
        self.register = 0
        self.clock = 0

    def emit(self, kind, data):
        with self.output_lock:
            output = sys.stdout.buffer
            header = struct.pack("<I", len(data) + 1) + kind
            compressed = self.compressor.compress(header)
            compressed += self.compressor.compress(data)
            compressed += self.compressor.flush(zlib.Z_SYNC_FLUSH)
            output.write(compressed)
            output.flush()

    def finish_output(self):
        with self.output_lock:
            sys.stdout.buffer.write(self.compressor.flush())
            sys.stdout.buffer.flush()

    def send(self, data):
        with self.bus_lock:
            self.bus.sendall(struct.pack("<I", len(data)) + data)

    def read_touch(self, transaction):
        write = transaction.get(3, b"")
        if write:
            self.register = write[0]
        count = transaction.get(4, 0)
        with self.touch_lock:
            x, y, down = self.touch
            x, y = 359 - y, x
            report = bytes((down, x >> 8, x & 255, y >> 8, y & 255))
            result = bytes(
                report[index - 2] if 2 <= index < 7 else 0
                for index in range(self.register, self.register + count)
            )
            self.register += count
            if count and down and self.register >= 7:
                self.sampled = True
                if self.release is not None:
                    self.touch, self.release = self.release, None
        return result

    def input_loop(self):
        try:
            for line in sys.stdin.buffer:
                command = json.loads(line)
                if command["type"] == "key":
                    drive = number(1, 6) + number(2, not command["down"])
                    self.send(number(1, self.clock) + packet(6, drive))
                    continue
                touch = command["touch"]
                next_touch = (touch["x"], touch["y"], touch["down"])
                with self.touch_lock:
                    if not next_touch[2] and self.touch[2] and not self.sampled:
                        self.release = next_touch
                        continue
                    if next_touch[2] and (not self.touch[2] or self.release is not None):
                        self.sampled = False
                    self.release = None
                    self.touch = next_touch
        except (OSError, ValueError):
            pass
        finally:
            self.stopping.set()
            try:
                self.bus.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def reply(self, request, op, data):
        response = number(1, request[1]) + number(2, 1) + packet(3, data) + number(4, op)
        self.send(packet(8, response))

    def run_bus(self, bus):
        self.bus = bus
        bus.settimeout(None)
        # A CST816S poll may require two small synchronous I²C replies.
        # Send each immediately so TCP cannot hold the firmware at a bus boundary.
        bus.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.send(registration())
        threading.Thread(target=self.input_loop, daemon=True).start()
        with bus.makefile("rb") as stream:
            while not self.stopping.is_set():
                header = stream.read(4)
                if not header:
                    return
                length, = struct.unpack("<I", header)
                frame = stream.read(length)
                if hasattr(socket, "TCP_QUICKACK"):
                    bus.setsockopt(socket.IPPROTO_TCP, socket.TCP_QUICKACK, 1)
                topic_length, = struct.unpack_from("<H", frame)
                if frame[2:11] == b"SIM/CLOCK":
                    continue
                message = fields(frame[2 + topic_length:])
                self.clock = message.get(1, self.clock)
                if 5 in message:
                    ack = fields(message[5])
                    if not ack.get(5):
                        raise RuntimeError(ack.get(6, b"Board registration refused").decode())
                if 7 not in message:
                    continue
                request = fields(message[7])
                if 2 in request:
                    self.reply(request, 1, self.read_touch(fields(request[2])))
                elif 3 in request:
                    spi = fields(request[3])
                    if spi.get(4):
                        self.reply(request, 2, bytes(spi[4]))
                    self.emit(b"S", request[3])

    def run(self, binary, firmware):
        # ESP-EMU waits for a board peer when a co-simulation socket is supplied.
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        process = subprocess.Popen(
            [binary, "--chip", "esp32s3", "--firmware", firmware,
             "--cosim-tcp", f"127.0.0.1:{port}"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        def logs():
            for line in process.stdout:
                self.emit(b"L", line)

        thread = threading.Thread(target=logs, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 8
            while True:
                try:
                    bus = socket.create_connection(("127.0.0.1", port), timeout=1)
                    break
                except OSError:
                    if process.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError("ESP-EMU did not open its board socket")
                    time.sleep(0.03)
            with bus:
                self.run_bus(bus)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            thread.join(timeout=1)


if __name__ == "__main__":
    bridge = Bridge()
    try:
        binary, firmware = map(str, map(Path, sys.argv[1:]))
        bridge.run(binary, firmware)
    except (OSError, RuntimeError, ValueError) as error:
        if not bridge.stopping.is_set():
            bridge.emit(b"E", str(error).encode())
    finally:
        bridge.finish_output()
