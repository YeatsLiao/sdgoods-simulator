import { fields } from "./wire.js";
import { Panel } from "./panel.js";

const panel = new Panel();
const decoder = new TextDecoder();
const identifier = crypto.randomUUID();
let frame = 0;
let pending = new Uint8Array();
let log = "";
let lastLog = 0;
let inputQueue = [];
let sending = false;

async function sendInputs() {
  sending = true;
  try {
    while (inputQueue.length) {
      await fetch(`./native/input/${identifier}`, {
        method: "POST",
        body: JSON.stringify(inputQueue.shift()),
      });
    }
  } finally {
    sending = false;
  }
}

function receive(chunk) {
  const bytes = pending.length ? new Uint8Array(pending.length + chunk.length) : chunk;
  if (pending.length) {
    bytes.set(pending);
    bytes.set(chunk, pending.length);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = view.getUint32(offset, true);
    if (!length || length > 1024 * 1024) throw new Error("本机模拟器返回了无效的数据包");
    if (offset + 4 + length > bytes.length) break;
    const kind = bytes[offset + 4];
    const data = bytes.subarray(offset + 5, offset + 4 + length);
    if (kind === 83) {
      panel.transfer(fields(data));
      if (panel.dirty) {
        const pixels = panel.pixels.slice();
        postMessage({ type: "frame", pixels, frame: ++frame }, [pixels.buffer]);
        panel.dirty = false;
      }
    } else if (kind === 76) {
      log += decoder.decode(data);
    } else if (kind === 69) {
      throw new Error(decoder.decode(data));
    }
    offset += 4 + length;
  }
  pending = bytes.slice(offset);
  const now = performance.now();
  if (log && now - lastLog >= 50) {
    postMessage({ type: "log", output: log });
    log = "";
    lastLog = now;
  }
}

async function boot(firmware) {
  postMessage({ type: "session", identifier });
  const response = await fetch(`./native/run/${identifier}`, { method: "POST", body: firmware });
  if (!response.ok) throw new Error(`本机加速启动失败（HTTP ${response.status}），可以切换浏览器模式`);
  postMessage({ type: "booted" });
  const stream = response.body.pipeThrough(new DecompressionStream("deflate")).getReader();
  while (true) {
    const { done, value } = await stream.read();
    if (done) break;
    receive(value);
  }
  throw new Error("本机模拟器已退出");
}

self.onmessage = ({ data }) => {
  if (data.type === "boot") {
    boot(data.firmware).catch((error) => postMessage({ type: "error", message: error.message }));
    return;
  }
  // Coalesce moves while keeping press and release in order.
  const previous = inputQueue.at(-1);
  if (data.type === "touch" && data.touch.down && previous?.type === "touch" && previous.touch.down) {
    inputQueue[inputQueue.length - 1] = data;
  } else {
    inputQueue.push(data);
  }
  if (!sending) sendInputs().catch(() => { inputQueue = []; });
};
