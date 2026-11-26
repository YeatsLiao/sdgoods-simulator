import { Emitter } from "../shared/emitter.js";

function copyBuffer(value) {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  throw new TypeError("需要 ArrayBuffer 或 TypedArray");
}

export class DeviceSession extends Emitter {
  constructor() {
    super();
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.options = null;
    this.firmware = null;
    this.worker.onmessage = ({ data }) => {
      if (data?.type && data.type !== "log") this.emit(data.type, data);
      else if (data?.type === "log") this.emit("log", data.output);
    };
    this.worker.onerror = (event) => {
      this.emit("error", event.message || "模拟器 Worker 加载失败");
    };
  }

  boot(options) {
    const firmware = copyBuffer(options.firmware);
    const flash = copyBuffer(options.flash);
    const patch = options.flashPatch ?? null;
    const patchData = patch?.data ? copyBuffer(patch.data) : null;
    // Slot boots re-stamp otadata on the restored snapshot so a previous app
    // "return to launcher" request does not brick the next slot boot.
    if (flash && patchData && Number.isSafeInteger(patch.offset) && patch.offset >= 0) {
      const bytes = new Uint8Array(flash);
      if (patch.offset + patchData.byteLength <= bytes.byteLength) {
        bytes.set(new Uint8Array(patchData), patch.offset);
      }
    }
    this.firmware = firmware;
    this.options = { ...options, firmware: null, flash: null, flashPatch: null };
    const transfer = [firmware];
    if (flash) transfer.push(flash);
    if (patchData) transfer.push(patchData);
    this.worker.postMessage({
      type: "boot",
      mode: options.mode,
      firmware,
      flash,
      flashPatch: patchData ? { offset: patch.offset, data: patchData } : null,
      name: options.name ?? "firmware.bin",
      flashKey: options.flashKey ?? "",
      preserveFlash: options.preserveFlash !== false,
    }, transfer);
  }

  stop() {
    this.worker.postMessage({ type: "stop" });
  }

  restart({ clearFlash = false } = {}) {
    // The browser runtime clears by booting without a saved flash image.
    // The native runtime owns flash.bin, so it must reset it in place.
    if (clearFlash && this.firmware && this.options?.mode === "wasm") {
      this.boot({ ...this.options, firmware: this.firmware, flash: null });
      return;
    }
    this.worker.postMessage({ type: "restart", clearFlash });
  }

  touch(touch) {
    this.worker.postMessage({ type: "touch", touch });
  }

  key(down) {
    this.worker.postMessage({ type: "key", down });
  }

  setSpeed(speed) {
    this.worker.postMessage({ type: "setSpeed", speed });
  }

  uart(text) {
    this.worker.postMessage({ type: "uart", text });
  }

  mic(pcm) {
    const copy = copyBuffer(pcm);
    if (copy) this.worker.postMessage({ type: "mic", pcm: copy }, [copy]);
  }

  requestFlash() {
    this.worker.postMessage({ type: "requestFlash" });
  }

  requestRegisters() {
    this.worker.postMessage({ type: "requestRegisters" });
  }

  requestMemory(addr, len) {
    this.worker.postMessage({ type: "requestMemory", addr, len });
  }

  requestGpio() {
    this.worker.postMessage({ type: "requestGpio" });
  }

  loadElf(bytes) {
    const copy = copyBuffer(bytes);
    if (copy) this.worker.postMessage({ type: "loadElf", bytes: copy }, [copy]);
  }

  destroy() {
    this.stop();
    this.worker.terminate();
  }
}
