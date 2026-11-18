import { Panel } from "./panel.js";
import {
  WIRE, fields, concatBytes, decodeAudio, decodeEvent, decodeFrame,
  encodeLoad, encodeMic,
} from "./protocol.js";

const decoder = new TextDecoder();

function encodeBase64(bytes) {
  let out = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(out);
}

export class NativeRuntime {
  constructor({ emit }) {
    this.emit = emit;
    this.panel = new Panel();
    this.ws = null;
    this.stopping = false;
    this.frames = 0;
    this.statsAt = 0;
    this.statsFrames = 0;
    this.formats = { tx: null, rx: null };
    this.booted = false;
    this.name = "firmware.bin";
    this.flashKey = "";
    this.statsTimer = 0;
  }

  start(options) {
    this.stopping = false;
    this.booted = false;
    this.name = options.name ?? "firmware.bin";
    this.flashKey = options.flashKey ?? "";
    this.panel.reset();
    const url = new URL("/ws/native", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      this.ws = socket;
      socket.onopen = () => {
        const json = {
          name: this.name,
          size: options.firmware.byteLength,
          sha256: options.flashKey || "",
          flashKey: options.flashKey || "",
          preserveFlash: options.preserveFlash !== false,
        };
        if (options.flashPatch?.data) {
          json.flashPatch = {
            offset: options.flashPatch.offset,
            data: encodeBase64(new Uint8Array(options.flashPatch.data)),
          };
        }
        socket.send(encodeLoad(json, new Uint8Array(options.firmware)));
        this.emit("status", { status: "本机模拟器已连接，正在载入固件" });
        this.statsAt = performance.now();
        this.statsTimer = setInterval(() => this.reportStats(), 1000);
        settled = true;
        resolve();
      };
      socket.onmessage = ({ data }) => {
        try {
          this.receive(new Uint8Array(data));
        } catch (error) {
          this.emit("error", { message: error.message || String(error) });
        }
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("本机加速连接失败，可以切换到浏览器模式"));
        } else {
          this.emit("error", { message: "本机加速连接出错，可以切换到浏览器模式" });
        }
      };
      socket.onclose = () => {
        clearInterval(this.statsTimer);
        this.statsTimer = 0;
        if (!this.stopping) {
          this.emit("error", { message: "本机模拟器已断开" });
        }
      };
    });
  }

  receive(bytes) {
    const type = bytes[0];
    if (type === WIRE.FRAME) {
      const { frame, transfer } = decodeFrame(bytes);
      this.panel.transfer(fields(transfer));
      const packed = this.panel.takeFrame();
      if (packed) {
        this.frames++;
        this.emit("frame", { packed: packed.buffer, frame }, [packed.buffer]);
      }
      return;
    }
    if (type === WIRE.AUDIO) {
      const audio = decodeAudio(bytes.subarray(1));
      const copy = new Uint8Array(audio.pcm);
      this.emit("audio", {
        pcm: copy.buffer,
        format: {
          receive: audio.receive,
          rate: audio.rate,
          channels: audio.channels,
          bits: audio.bits,
        },
      }, [copy.buffer]);
      return;
    }
    if (type === WIRE.LOG) {
      this.emit("log", { output: decoder.decode(bytes.subarray(1)) });
      return;
    }
    if (type === WIRE.FLASH) {
      const copy = bytes.slice(1);
      this.emit("flash", { bytes: copy.buffer }, [copy.buffer]);
      return;
    }
    if (type === WIRE.EVENT) {
      const event = decodeEvent(bytes.subarray(1));
      this.handleEvent(event);
    }
  }

  handleEvent(event) {
    if (event.kind === "booted") {
      this.booted = true;
      this.panel.reset();
      this.emit("booted", { info: event.info ?? { name: this.name, mode: "native" } });
      return;
    }
    if (event.kind === "reset") {
      this.panel.reset();
      this.emit("status", { status: "已重启，Flash 数据保留" });
      return;
    }
    if (event.kind === "status") {
      this.emit("status", { status: event.message ?? "" });
      return;
    }
    if (event.kind === "error") {
      this.emit("error", { message: event.message ?? "本机模拟器出错" });
      return;
    }
    if (event.kind === "fault") {
      this.emit("fault", { report: event.report ?? event.message ?? "固件异常" });
      return;
    }
    if (event.kind === "audioformat") {
      const format = event.format;
      if (format) {
        this.formats[format.receive ? "rx" : "tx"] = format;
        this.emit("audioformat", { format });
      }
      return;
    }
    if (event.kind === "registers" || event.kind === "memory" || event.kind === "gpio") {
      this.emit(event.kind, { data: event.data });
      return;
    }
    if (event.kind === "stats" && !this.booted) {
      this.emit("stats", { stats: event.stats });
    }
  }

  reportStats() {
    const now = performance.now();
    const seconds = Math.max(0.001, (now - this.statsAt) / 1000);
    const fps = (this.frames - this.statsFrames) / seconds;
    this.statsAt = now;
    this.statsFrames = this.frames;
    this.emit("stats", {
      stats: { fps, frames: this.frames, transport: "ws", mips: null, realTime: null },
    });
  }

  sendJson(value) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(value));
  }

  sendBytes(bytes) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  touch(touch) {
    this.sendJson({ type: "touch", touch });
  }

  key(down) {
    this.sendJson({ type: "key", down });
  }

  uart(text) {
    this.sendJson({ type: "uart", text });
  }

  mic(pcm) {
    this.sendBytes(encodeMic({ pcm }));
  }

  restart({ clearFlash = false } = {}) {
    this.sendJson({ type: "restart", clearFlash });
  }

  requestFlash() {
    this.sendJson({ type: "flash" });
  }

  requestRegisters() {
    this.sendJson({ type: "registers" });
  }

  requestMemory(addr, len) {
    this.sendJson({ type: "memory", addr, len });
  }

  requestGpio() {
    this.sendJson({ type: "gpio" });
  }

  loadElf(bytes) {
    this.sendBytes(concatBytes(Uint8Array.of(WIRE.ELF), new Uint8Array(bytes)));
    this.emit("status", { status: "ELF 已发送，重新载入固件后生效" });
  }

  stop() {
    this.stopping = true;
    clearInterval(this.statsTimer);
    this.statsTimer = 0;
    try {
      this.sendJson({ type: "stop" });
      this.ws?.close();
    } catch {
      // Closing a dead socket is harmless.
    }
    this.ws = null;
    this.panel.reset();
  }
}
