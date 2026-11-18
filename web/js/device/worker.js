import { WasmRuntime } from "./wasm-runtime.js";
import { NativeRuntime } from "./native-runtime.js";

let runtime = null;
let queue = [];

function emit(type, payload, transfer) {
  self.postMessage({ type, ...payload }, transfer ?? []);
}

async function boot(message) {
  runtime?.stop?.();
  runtime = message.mode === "native"
    ? new NativeRuntime({ emit })
    : new WasmRuntime({ emit });
  await runtime.start(message);
  const pending = queue;
  queue = [];
  for (const item of pending) runtime[item.type]?.(item);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "boot") {
      queue = [];
      await boot(data);
      return;
    }
    if (data.type === "stop") {
      runtime?.stop?.();
      return;
    }
    if (!runtime) {
      queue.push(data);
      return;
    }
    const method = data.type;
    if (method === "touch") runtime.touch(data.touch);
    else if (method === "key") runtime.key(data.down);
    else if (method === "uart") runtime.uart(data.text);
    else if (method === "mic") runtime.mic(data.pcm);
    else if (method === "restart") runtime.restart({ clearFlash: data.clearFlash });
    else if (method === "requestFlash") runtime.requestFlash();
    else if (method === "requestRegisters") runtime.requestRegisters();
    else if (method === "requestMemory") runtime.requestMemory(data.addr, data.len);
    else if (method === "requestGpio") runtime.requestGpio();
    else if (method === "loadElf") runtime.loadElf(data.bytes);
  } catch (error) {
    emit("error", { message: error.message || String(error) });
  }
};
