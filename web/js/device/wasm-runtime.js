import { Panel, SIZE } from "./panel.js";
import {
  fields, unpackFrame, register, reply, parseI2sFormat, parseI2sOut, i2sIn,
} from "./protocol.js";
import { describeFirmware } from "./firmware.js";

const PEER = "sdgoods-dimension-screen";
const BATCH = 30000;
const QUEUE_DELAY_MS = 32;
const textEncoder = new TextEncoder();

function base64(bytes) {
  let out = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(out);
}

export class WasmRuntime {
  constructor({ emit }) {
    this.emit = emit;
    this.panel = new Panel();
    this.emulator = null;
    this.base = null;
    this.name = "firmware.bin";
    this.flashKey = "";
    this.generation = 0;
    this.timer = 0;
    this.stopped = true;
    this.faulted = false;
    this.frames = 0;
    this.touchState = { x: 0, y: 0, down: false };
    this.touchSampled = false;
    this.pendingRelease = null;
    this.touchRegister = 0;
    this.touchReads = 0;
    this.formats = { tx: null, rx: null };
    this.timeCredit = 0;
    this.speed = 1;
    this.previousTick = 0;
    this.statsAt = 0;
    this.statsFrames = 0;
    this.statsCycles = 0;
  }

  async start(options) {
    clearTimeout(this.timer);
    this.timer = 0;
    try {
      this.emulator?.free?.();
    } catch {
      // A previous instance may already be gone.
    }
    this.emulator = null;
    this.stopped = false;
    this.faulted = false;
    this.name = options.name ?? "firmware.bin";
    this.flashKey = options.flashKey ?? "";
    this.base = new Uint8Array(options.firmware);
    const image = options.flash ? new Uint8Array(options.flash) : this.base;
    const generation = ++this.generation;

    const module = await import(new URL("../../runtime/esp_emu.js", import.meta.url).href);
    await module.default();
    const emulator = new module.WasmEmulator("esp32s3");
    emulator.load_default_rom();
    emulator.set_boot_from_rom(true);
    emulator.set_panic_intercept(true);
    emulator.load_firmware(image);
    const relayUrl = this.relayUrl();
    if (relayUrl && typeof emulator.net_set_relay === "function") {
      try {
        emulator.net_set_relay(relayUrl);
      } catch (error) {
        this.emit("status", { status: `本机网络中继不可用：${error.message || error}` });
      }
    }
    emulator.cosim_attach(1000);
    emulator.cosim_push_inbound(PEER, register(PEER));
    emulator.cosim_service();
    this.emulator = emulator;
    this.panel.reset();
    this.frames = 0;
    this.statsAt = performance.now();
    this.statsFrames = 0;
    this.statsCycles = 0;
    this.drainBus();

    const info = describeFirmware(image);
    this.emit("booted", {
      info: { name: this.name, mode: "wasm", size: image.byteLength },
      firmware: info,
    });
    this.emit("status", { status: "固件已载入" });
    this.previousTick = performance.now();
    this.tick(generation);
  }

  relayUrl() {
    try {
      if (self.location.hostname !== "127.0.0.1" && self.location.hostname !== "localhost") return "";
      const url = new URL("/relay", self.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.href;
    } catch {
      return "";
    }
  }

  stop() {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = 0;
    try {
      this.emulator?.free?.();
    } catch {
      // The emulator may already be freed after a fault.
    }
    this.emulator = null;
  }

  setSpeed(speed) {
    if (![1, 1.5, 2].includes(speed) || this.speed === speed) return;
    this.speed = speed;
    this.timeCredit = 0;
    this.previousTick = performance.now();
  }

  async restart({ clearFlash = false } = {}) {
    this.panel.reset();
    if (clearFlash) {
      await this.start({
        firmware: this.base, flash: null, name: this.name, flashKey: this.flashKey, mode: "wasm",
      });
      return;
    }
    try {
      this.emulator.restart();
      clearTimeout(this.timer);
      this.faulted = false;
      this.stopped = false;
      this.timeCredit = 0;
      this.previousTick = performance.now();
      this.statsAt = this.previousTick;
      this.statsCycles = this.emulator.cycles();
      this.statsFrames = this.frames;
      this.tick(++this.generation);
      this.emit("status", { status: "已重启，Flash 数据保留" });
    } catch (error) {
      const flash = this.emulator?.flash_state?.();
      await this.start({
        firmware: this.base,
        flash: flash ?? null,
        name: this.name,
        flashKey: this.flashKey,
        mode: "wasm",
      });
      this.emit("status", { status: `已重新启动：${error.message || error}` });
    }
  }

  touch(touch) {
    if (!this.emulator) return;
    const next = { ...touch };
    if (!next.down && this.touchState.down && !this.touchSampled) {
      this.pendingRelease = next;
      return;
    }
    if (next.down && (!this.touchState.down || this.pendingRelease)) this.touchSampled = false;
    this.pendingRelease = null;
    this.touchState = next;
  }

  key(down) {
    this.emulator?.gpio_set_input(6, !down);
  }

  uart(text) {
    if (!this.emulator || !text) return;
    this.emulator.uart_input(textEncoder.encode(text));
  }

  mic(pcm) {
    if (!this.emulator || !pcm) return;
    this.emulator.cosim_push_inbound(PEER, i2sIn(new Uint8Array(pcm)));
  }

  requestFlash() {
    const flash = this.emulator?.flash_state?.();
    if (!flash) return;
    const copy = new Uint8Array(flash);
    this.emit("flash", { bytes: copy.buffer }, [copy.buffer]);
  }

  requestRegisters() {
    if (!this.emulator) return;
    try {
      this.emit("registers", { data: this.emulator.registers() });
    } catch (error) {
      this.emit("error", { message: `读取寄存器失败：${error.message || error}` });
    }
  }

  requestMemory(addr, len) {
    if (!this.emulator) return;
    const length = Math.max(1, Math.min(4096, Number(len) || 64));
    try {
      const bytes = this.emulator.read_memory(Number(addr) >>> 0, length);
      this.emit("memory", { data: { addr: Number(addr) >>> 0, bytes: base64(bytes) } });
    } catch (error) {
      this.emit("error", { message: `读取内存失败：${error.message || error}` });
    }
  }

  requestGpio() {
    if (!this.emulator) return;
    try {
      this.emit("gpio", { data: this.emulator.gpio_state() });
    } catch (error) {
      this.emit("error", { message: `读取 GPIO 失败：${error.message || error}` });
    }
  }

  loadElf(bytes) {
    if (!this.emulator) return;
    try {
      this.emulator.load_app_elf(new Uint8Array(bytes));
      this.emit("status", { status: "ELF 已载入，崩溃时将输出符号化回溯" });
    } catch (error) {
      this.emit("error", { message: `载入 ELF 失败：${error.message || error}` });
    }
  }

  tick(generation) {
    if (this.stopped || generation !== this.generation) return;
    try {
      const started = performance.now();
      const deadline = started + 18;
      this.timeCredit = Math.min(QUEUE_DELAY_MS, this.timeCredit + (started - this.previousTick) * this.speed);
      this.previousTick = started;
      let output = "";
      while (this.timeCredit >= 1 && performance.now() < deadline) {
        const emulator = this.emulator;
        if (!emulator) return;
        emulator.cosim_service();
        const before = emulator.cycles();
        const cyclesPerUs = emulator.cycles_per_us();
        output += emulator.run_batch(BATCH);
        this.drainBus();
        const elapsed = emulator.cycles() - before;
        this.timeCredit -= elapsed >= 0 ? elapsed / cyclesPerUs / 1000 : this.timeCredit;
      }
      if (output) this.emit("log", { output });
      const frame = this.panel.takeFrame();
      if (frame) {
        this.frames++;
        this.emit("frame", { packed: frame.buffer, frame: this.frames }, [frame.buffer]);
      }
      if (this.emulator?.faulted()) {
        const report = this.emulator.fault_report?.() ?? "固件发生异常";
        this.faulted = true;
        this.emit("fault", { report });
        this.emit("error", { message: report });
        this.emit("status", { status: "固件已暂停，请查看日志或重启" });
        return;
      }
      this.reportStats(generation);
      const elapsed = performance.now() - started;
      const delay = Math.max(0, (1 - this.timeCredit) / this.speed - elapsed);
      this.timer = setTimeout(() => this.tick(generation), delay);
    } catch (error) {
      this.emit("error", { message: error.message || String(error) });
    }
  }

  reportStats(generation) {
    if (generation !== this.generation) return;
    const now = performance.now();
    if (now - this.statsAt < 1000) return;
    const seconds = (now - this.statsAt) / 1000;
    const emulator = this.emulator;
    const cycles = emulator?.cycles?.() ?? 0;
    const fps = (this.frames - this.statsFrames) / seconds;
    const cyclesPerSecond = (cycles - this.statsCycles) / seconds;
    this.statsAt = now;
    this.statsFrames = this.frames;
    this.statsCycles = cycles;
    this.emit("stats", {
      stats: {
        fps,
        frames: this.frames,
        mips: cyclesPerSecond / 1e6,
        realTime: cyclesPerSecond / (emulator?.cycles_per_us?.() || 1) / 1e6,
        transport: "wasm",
        touchReads: this.touchReads,
      },
    });
  }

  drainBus() {
    const emulator = this.emulator;
    if (!emulator) return;
    let frame;
    while ((frame = emulator.cosim_take_outbound())?.length) {
      const [topic, payload] = unpackFrame(frame);
      const message = fields(payload);
      if (message[5]) {
        const ack = fields(message[5]);
        if (!ack[1] && !ack[5]) {
          throw new Error(new TextDecoder().decode(ack[2] ?? ack[6] ?? new Uint8Array()) || "外设注册失败");
        }
      }
      if (message[29]) {
        const format = parseI2sFormat(message[29]);
        this.formats[format.receive ? "rx" : "tx"] = format;
        this.emit("audioformat", { format });
      }
      if (message[30]) {
        const pcm = parseI2sOut(message[30]);
        if (pcm.length) {
          const copy = new Uint8Array(pcm);
          this.emit("audio", {
            pcm: copy.buffer,
            format: this.formats.tx ?? { receive: false, rate: 16000, channels: 2, bits: 16 },
          }, [copy.buffer]);
        }
      }
      if (!message[7]) continue;
      const request = fields(message[7]);
      if (request[3]) {
        const transfer = fields(request[3]);
        this.panel.transfer(transfer);
        if (transfer[4]) {
          emulator.cosim_push_inbound(PEER, reply(request[1], 2, new Uint8Array(transfer[4])));
        }
      }
      if (request[2]) {
        emulator.cosim_push_inbound(PEER, reply(request[1], 1, this.readTouch(fields(request[2]))));
      }
    }
  }

  readTouch(transaction) {
    const write = transaction[3] ?? new Uint8Array(0);
    if (write.length) this.touchRegister = write[0];
    const rawX = SIZE - 1 - this.touchState.y;
    const rawY = this.touchState.x;
    const report = [this.touchState.down ? 1 : 0, rawX >> 8, rawX & 255, rawY >> 8, rawY & 255];
    const length = transaction[4] ?? 0;
    const response = Uint8Array.from({ length }, () => report[this.touchRegister++ - 2] ?? 0);
    if (length) {
      this.touchReads++;
      if (this.touchState.down && this.touchRegister >= 7) {
        this.touchSampled = true;
        if (this.pendingRelease) {
          this.touchState = this.pendingRelease;
          this.pendingRelease = null;
        }
      }
    }
    return response;
  }
}
