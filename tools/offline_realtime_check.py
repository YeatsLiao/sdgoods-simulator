"""Offline check for the native worker's SIM/CLOCK handling and realTime ratio.

No ESP-EMU, no network, no browser: synthetic co-sim frames are fed straight to
Session._handle_frame(), and _stats_loop() is driven with a patched monotonic
clock so every reported stats event is deterministic.

    python tools/offline_realtime_check.py
"""

from __future__ import annotations

import json
import struct
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import native_worker as nw  # noqa: E402


class FakeOutput:
    """Collects the framed events a real Output would write to stdout."""

    def __init__(self) -> None:
        self.events: list[dict] = []
        self.audio: list[bytes] = []
        self.frames: list[bytes] = []
        self.broken = False

    def send(self, kind: int, payload: bytes = b"") -> None:
        if kind == nw.WIRE_AUDIO:
            self.audio.append(payload)
        elif kind == nw.WIRE_FRAME:
            self.frames.append(payload)

    def event(self, kind: str, **values) -> None:
        self.events.append({"kind": kind, **values})

    def log(self, data: bytes) -> None:
        pass

    def error(self, message: object) -> None:
        self.event("error", message=str(message))

    def stats(self) -> list[dict]:
        return [event["stats"] for event in self.events if event["kind"] == "stats"]


def topic_frame(topic: str, payload: bytes) -> bytes:
    encoded = topic.encode("utf-8")
    return struct.pack("<H", len(encoded)) + encoded + payload


def clock_message(sim_time_ns: int) -> bytes:
    """A SIM/CLOCK broadcast: EmulatorMessage envelope, field 1 is sim time ns."""
    return nw.number(1, sim_time_ns) + nw.number(3, 1_000_000)


def emu_message(sim_time_ns: int, *, body: bytes = b"") -> bytes:
    return nw.number(1, sim_time_ns) + body


def read_varint(data: bytes, cursor: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = data[cursor]
        cursor += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, cursor
        shift += 7


def claims_of(register: bytes) -> list[bytes]:
    """Extract every repeated claim packet (Register field 3) from raw bytes.

    The project's minimal decoder keeps only the last occurrence of a repeated
    field, so claims are read straight off the Register payload.
    """
    out: list[bytes] = []
    cursor = 0
    while cursor < len(register):
        key, cursor = read_varint(register, cursor)
        tag, wire_type = key >> 3, key & 7
        if wire_type == 0:
            _, cursor = read_varint(register, cursor)
        elif wire_type == 2:
            length, cursor = read_varint(register, cursor)
            chunk = register[cursor:cursor + length]
            cursor += length
            if tag == 3:
                out.append(chunk)
        else:
            raise AssertionError(f"unexpected register wire type {wire_type}")
    return out


def spi_request(sim_time_ns: int, correlation: int, read_data: bytes) -> bytes:
    transfer = nw.number(1, correlation) + nw.packet(4, read_data)
    request = nw.number(1, correlation) + nw.packet(3, transfer)
    return emu_message(sim_time_ns, body=nw.packet(7, request))


def i2s_out(sim_time_ns: int, pcm: bytes) -> bytes:
    return emu_message(sim_time_ns, body=nw.packet(30, nw.packet(1, pcm)))


def i2s_format(sim_time_ns: int, *, receive: bool, rate: int, channels: int, bits: int) -> bytes:
    body = (
        nw.number(1, 1 if receive else 0)
        + nw.number(2, rate)
        + nw.number(3, channels)
        + nw.number(4, bits)
    )
    return emu_message(sim_time_ns, body=nw.packet(29, body))


def registration_ack(sim_time_ns: int, *, accepted: bool) -> bytes:
    ack = nw.number(1, 1 if accepted else 0) + nw.number(5, 1 if accepted else 0)
    if not accepted:
        ack += nw.packet(6, b"Board registration refused")
    return emu_message(sim_time_ns, body=nw.packet(5, ack))


class FakeWorker:
    def __init__(self) -> None:
        self.output = FakeOutput()
        self.binary = Path("/nonexistent/esp-emu")


class FakeClock:
    """Monotonic-time stand-in that turns each stats window into a fixed length.

    Every armed read advances by one window, so the loop sees elapsed == seconds
    and the reported ratio is exactly the simulated-seconds delta over them.
    """

    def __init__(self, start: float = 1_000.0) -> None:
        self.now = start
        # The loop reads monotonic() once before its first wait; that read has
        # no window before it, so one extra step is pre-armed.
        self.armed = 1
        self.step = 0.0

    def advance(self, seconds: float) -> None:
        """Arm one more window of `seconds` for each remaining monotonic() read."""
        self.armed += 1
        self.step = seconds

    def monotonic(self) -> float:
        if self.armed:
            self.armed -= 1
            self.now += self.step
        return self.now


class StatsHarness:
    """Drive one long-running Session._stats_loop with windows of our choosing.

    The production loop body does all the arithmetic; only time.monotonic() and
    the stop wait are patched, so nothing here re-implements the code under test.
    Keeping a single thread matters: its baseline and its high-water mark after a
    firmware reset are exactly what a real session reports.
    """

    def __init__(self, session: nw.Session, clock: FakeClock) -> None:
        self.session = session
        self.clock = clock
        # The loop parks in wait() twice per window: before it timestamps the
        # window start and after it has sent the report. Only the first park is
        # released by hand; the second one ends the loop.
        self.parks = 0
        self.release = threading.Event()
        self.stop = False
        self.original_wait = session.stopping.wait
        self.real_monotonic = nw.time.monotonic
        session.stopping.wait = self._wait  # type: ignore[method-assign]
        nw.time.monotonic = clock.monotonic  # type: ignore[assignment]
        self.thread = threading.Thread(target=session._stats_loop, daemon=True)
        self.thread.start()
        # The loop takes its first timestamp, then parks in the patched wait().
        self._await_park()

    def _wait(self, timeout=None):
        if self.stop:
            return True
        self.parks += 1
        if self.parks > 1:
            return True
        self.release.wait(5)
        self.release.clear()
        return False

    def _await_park(self) -> None:
        deadline = time.monotonic() + 5
        while self.parks == 0:
            if time.monotonic() > deadline:
                raise AssertionError("stats loop did not park in wait()")
            time.sleep(0.001)

    def window(self, seconds: float) -> dict:
        """Advance the wall clock by `seconds` and return that stats report."""
        events = self.session.worker.output
        before = len(events.stats())
        self._await_park()
        self.parks = 0
        self.clock.advance(seconds)
        self.release.set()
        deadline = time.monotonic() + 5
        while len(events.stats()) <= before:
            if time.monotonic() > deadline:
                raise AssertionError("stats loop did not report")
            time.sleep(0.001)
        return events.stats()[-1]

    def close(self) -> None:
        self.stop = True
        self.release.set()
        self.thread.join(timeout=5)
        self.session.stopping.wait = self.original_wait  # type: ignore[method-assign]
        nw.time.monotonic = self.real_monotonic  # type: ignore[assignment]


def make_session() -> tuple[nw.Session, FakeClock]:
    """A session with no filesystem side effects: nothing here touches Flash."""
    session = nw.Session(
        FakeWorker(), ROOT, ROOT / "flash.bin", None, "fw.bin", 1234, 4 * 1024 * 1024,
    )
    return session, FakeClock()


def new_session() -> nw.Session:
    return make_session()[0]


FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}{(' — ' + detail) if detail else ''}")
    if not condition:
        FAILURES.append(label)


def main() -> int:
    print(f"python {sys.version.split()[0]} · {ROOT}")

    # --- 1. frame decoding -------------------------------------------------
    session = new_session()

    # A SIM/CLOCK broadcast is a clock tick, not a bus request: it must advance
    # the clock and emit nothing.
    session._handle_frame(topic_frame("SIM/CLOCK", clock_message(2_000_000_000)))
    check("SIM/CLOCK advances the clock", session.clock == 2_000_000_000, f"clock={session.clock}")
    check("SIM/CLOCK produces no audio/frame/ack", session.worker.output.events == [])

    # Registration ack (accepted) plus an SPI transaction with a reply payload.
    peer_topic = "@sdgoods-dimension-screen/SPI"
    session._handle_frame(topic_frame(peer_topic, registration_ack(3_000_000_000, accepted=True)))
    check("ack frame updates clock", session.clock == 3_000_000_000, f"clock={session.clock}")
    session._handle_frame(topic_frame(peer_topic, spi_request(4_000_000_000, 77, b"\x01\x02")))
    check("SPI frame updates clock", session.clock == 4_000_000_000, f"clock={session.clock}")
    check("SPI frame emitted one display frame", len(session.worker.output.frames) == 1)

    # I2S format then PCM out.
    session._handle_frame(
        topic_frame(peer_topic, i2s_format(5_000_000_000, receive=False, rate=48000, channels=2, bits=16))
    )
    session._handle_frame(topic_frame(peer_topic, i2s_out(6_000_000_000, bytes(range(8)))))
    formats = [event for event in session.worker.output.events if event["kind"] == "audioformat"]
    check("I2S format reported", formats and formats[-1]["format"]["rate"] == 48000, str(formats[-1:]))
    check("I2S out emitted audio", len(session.worker.output.audio) == 1)
    header = struct.unpack_from("<IBBBB", session.worker.output.audio[0])
    check("audio header uses the new format", header[:3] == (48000, 2, 16), str(header))

    # Empty payload: fields(b"") is {} and must leave the clock untouched.
    before = session.clock
    session._handle_frame(topic_frame(peer_topic, b""))
    check("empty payload keeps clock", session.clock == before, f"clock={session.clock}")

    # Refused registration still raises on the bus thread (unchanged behaviour).
    raised = False
    try:
        session._handle_frame(topic_frame(peer_topic, registration_ack(7_000_000_000, accepted=False)))
    except ValueError as error:
        raised = "refused" in str(error)
    check("refused registration raises", raised)

    # key()/reply() timestamps come from the tracked clock.
    sent: list[bytes] = []
    session.bus = None

    def capture(data: bytes) -> None:
        sent.append(data)

    session._send = capture  # type: ignore[method-assign]
    session.key(True)
    decoded = nw.fields(sent[-1])
    check("key() stamps the tracked clock", decoded.get(1) == 7_000_000_000, str(decoded.get(1)))

    # --- 2. registration claims -------------------------------------------
    register = nw.fields(nw.registration())[4]
    outer = nw.fields(register)
    check(
        "registration keeps protocol version and peer name",
        outer[1] == 1 and outer[2] == nw.PEER.encode(),
        str(outer[1]),
    )
    # The four claim packets repeat in field 3, so the last occurrence is I2S.
    spi = nw.fields(nw.fields(claims_of(register)[0])[3])
    touch = nw.fields(nw.fields(claims_of(register)[1])[2])
    gpio = nw.fields(nw.fields(claims_of(register)[2])[1])
    audio = nw.fields(nw.fields(claims_of(register)[3])[17])
    check(
        "claims unchanged (SPI 21 / I2C 0x15 SCL10 SDA11 / GPIO6 / I2S 48·38·47·17)",
        len(claims_of(register)) == 4
        and spi[1] == 21
        and (touch[1], touch[2], touch[3]) == (0x15, 10, 11)
        and gpio[1] == 1 << 6
        and (audio[1], audio[2], audio[3], audio[4]) == (48, 38, 47, 17),
    )

    # --- 3. realTime arithmetic --------------------------------------------
    # One long-running stats thread is driven instead of restarting the loop per
    # window, so its baseline and high-water mark behave exactly as in production.
    fresh, fresh_clock = make_session()
    harness = StatsHarness(fresh, fresh_clock)
    try:
        # A session that never saw a clock message reports null, not 0.
        first = harness.window(1.0)
        check("no clock at all -> null", first["realTime"] is None, json.dumps(first))

        # The window that only records the baseline still has no rate to show.
        fresh._handle_frame(topic_frame("SIM/CLOCK", clock_message(1_000_000_000)))
        second = harness.window(1.0)
        check("baseline window without a delta -> null", second["realTime"] is None, json.dumps(second))

        fresh._handle_frame(topic_frame("SIM/CLOCK", clock_message(1_600_000_000)))
        third = harness.window(1.0)
        check("0.6 s sim in 1 s wall -> 0.6", third["realTime"] == 0.6, json.dumps(third))

        fresh._handle_frame(topic_frame("SIM/CLOCK", clock_message(2_600_000_000)))
        fourth = harness.window(1.0)
        check("exactly real time -> 1.0", fourth["realTime"] == 1.0, json.dumps(fourth))

        # Faster than real time must not be clamped away.
        fresh._handle_frame(topic_frame("SIM/CLOCK", clock_message(4_600_000_000)))
        fifth = harness.window(1.0)
        check("2.0x reported as-is", fifth["realTime"] == 2.0, json.dumps(fifth))

        # A stalled emulator (clock frozen) yields null rather than 0.
        sixth = harness.window(1.0)
        check("frozen clock -> null", sixth["realTime"] is None, json.dumps(sixth))

        # Firmware reset rewinds sim time to zero: neither a negative ratio nor
        # the inflated one an unsigned subtraction would report.
        fresh._handle_frame(topic_frame("SIM/CLOCK", clock_message(0)))
        seventh = harness.window(1.0)
        check("reset window -> null", seventh["realTime"] is None, json.dumps(seventh))

        # The rewind alone must not look like 4.6 s of progress in 1 s.
        eighth = harness.window(1.0)
        check("window right after reset -> null", eighth["realTime"] is None, json.dumps(eighth))

        # The high-water mark keeps the post-reset windows honest until the clock
        # passes it again, then deltas resume normally.
        fresh._handle_frame(topic_frame("SIM/CLOCK", clock_message(300_000_000)))
        ninth = harness.window(1.0)
        check("still below the high-water mark -> null", ninth["realTime"] is None, json.dumps(ninth))

        fresh._handle_frame(topic_frame("SIM/CLOCK", clock_message(4_800_000_000)))
        tenth = harness.window(1.0)
        check("equal to the high-water mark -> null", tenth["realTime"] is None, json.dumps(tenth))

        fresh._handle_frame(topic_frame("SIM/CLOCK", clock_message(5_600_000_000)))
        eleventh = harness.window(1.0)
        check("past the high-water mark -> 0.8", eleventh["realTime"] == 0.8, json.dumps(eleventh))

        # A short window must not divide by zero: 0.5 ms of sim time in 0.1 ms
        # of wall clock is 5x, and the loop clamps elapsed to at least 1 ms.
        fresh._handle_frame(topic_frame("SIM/CLOCK", clock_message(5_600_100_000)))
        twelfth = harness.window(0.0001)
        check("0.1 ms sim in a clamped 1 ms window -> 0.1", twelfth["realTime"] == 0.1, json.dumps(twelfth))
    finally:
        harness.close()

    # A truncated varint inside a clock broadcast must not kill the bus thread.
    ok = True
    try:
        session._handle_frame(topic_frame("SIM/CLOCK", b"\x08\x80"))
    except Exception as error:  # noqa: BLE001
        ok = False
        print("   exception:", error)
    check("malformed clock broadcast ignored", ok)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed: {FAILURES}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
