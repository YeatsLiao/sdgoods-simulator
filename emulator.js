import init, { WasmEmulator } from "./runtime/esp_emu.js";
import { fields, register, reply, unpack } from "./wire.js";
import { Panel, SIZE } from "./panel.js";

const peer = "sdgoods-dimension-screen";
const panel = new Panel();
const empty = new Uint8Array();
const QUEUE_DELAY_MS = 32;
const BATCH_INSTRUCTIONS = 30000;
let emulator;
let timeCredit = 0;
let previousTick = 0;
let touch = { x: 0, y: 0, down: false };
let touchSampled = false;
let pendingRelease = null;
let touchRegister = 0;
let touchReads = 0;
let frames = 0;
let pendingFrame;

function readTouch(transaction) {
  const write = transaction[3] ?? empty;
  if (write.length) touchRegister = write[0];
  const rawX = SIZE - 1 - touch.y;
  const rawY = touch.x;
  const report = [touch.down ? 1 : 0, rawX >> 8, rawX & 255, rawY >> 8, rawY & 255];
  const length = transaction[4] ?? 0;
  const response = Uint8Array.from({ length }, () => report[touchRegister++ - 2] ?? 0);
  if (length) {
    touchReads++;
    if (touch.down && touchRegister >= 7) {
      touchSampled = true;
      if (pendingRelease) {
        touch = pendingRelease;
        pendingRelease = null;
      }
    }
  }
  return response;
}

function setTouch(next) {
  if (!next.down && touch.down && !touchSampled) {
    // Preserve quick clicks until the firmware has polled one complete report.
    pendingRelease = next;
    return;
  }
  if (next.down && (!touch.down || pendingRelease)) touchSampled = false;
  pendingRelease = null;
  touch = next;
}

function drainBus() {
  let frame;
  while ((frame = emulator.cosim_take_outbound())?.length) {
    if (frame[2] !== 0x40) continue; // Skip broadcast events that have no board listeners.
    const [topic, payload] = unpack(frame);
    if (topic !== `@${peer}`) continue;
    const message = fields(payload);
    if (message[5]) {
      const ack = fields(message[5]);
      if (!ack[1]) throw new Error(new TextDecoder().decode(ack[2] ?? empty) || "外设注册失败");
    }
    if (!message[7]) continue;
    const request = fields(message[7]);
    if (request[3]) {
      const transfer = fields(request[3]);
      panel.transfer(transfer);
      if (panel.dirty) {
        pendingFrame = panel.pixels.slice();
        panel.dirty = false;
      }
      if (transfer[4]) emulator.cosim_push_inbound(peer, reply(request[1], 2, new Uint8Array(transfer[4])));
    }
    if (request[2]) {
      emulator.cosim_push_inbound(peer, reply(request[1], 1, readTouch(fields(request[2]))));
    }
  }
}

function tick() {
  try {
    const started = performance.now();
    const deadline = started + 18;
    timeCredit = Math.min(QUEUE_DELAY_MS, timeCredit + started - previousTick);
    previousTick = started;
    let output = "";
    while (timeCredit >= 1 && performance.now() < deadline) {
      emulator.cosim_service();
      const before = emulator.cycles();
      const cyclesPerUs = emulator.cycles_per_us();
      output += emulator.run_batch(BATCH_INSTRUCTIONS);
      drainBus();
      if (emulator.faulted()) throw new Error(emulator.fault_report());
      const elapsed = emulator.cycles() - before;
      timeCredit -= elapsed >= 0 ? elapsed / cyclesPerUs / 1000 : timeCredit;
    }
    if (output) postMessage({ type: "log", output });
    if (pendingFrame) {
      const pixels = pendingFrame;
      postMessage({ type: "frame", pixels, touchReads, frame: ++frames }, [pixels.buffer]);
      pendingFrame = null;
    }
    const remaining = timeCredit + performance.now() - started;
    setTimeout(tick, Math.max(0, 1 - remaining));
  } catch (error) {
    postMessage({ type: "error", message: error.message || String(error) });
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "touch") {
      setTouch(data.touch);
    } else if (data.type === "key") {
      emulator?.gpio_set_input(6, !data.down);
    } else if (data.type === "boot") {
      await init();
      emulator = new WasmEmulator("esp32s3");
      emulator.load_default_rom();
      emulator.set_boot_from_rom(true);
      emulator.load_firmware(new Uint8Array(data.firmware));
      emulator.cosim_attach(1000);
      emulator.cosim_push_inbound(peer, register(peer));
      emulator.cosim_service();
      drainBus();
      postMessage({ type: "booted" });
      previousTick = performance.now();
      tick();
    }
  } catch (error) {
    postMessage({ type: "error", message: error.message || String(error) });
  }
};
