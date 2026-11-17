import { SIZE } from "./panel.js";

const get = (id) => document.getElementById(id);
const screen = get("screen");
const context = screen.getContext("2d");
const status = get("status");
const log = get("log");
const reset = get("reset");
const mode = get("mode");
let worker;
let firmware;
let name;
let activePointer;
let request = 0;
let drawJob = 0;
let nextFrame;
let nativeSession;

const checkNative = fetch("./native/status")
  .then((response) => response.ok && response.json())
  .then((native) => {
    if (!native?.available) return;
    mode.add(new Option("本机加速", "native"), 0);
    mode.value = "native";
  }).catch(() => {});

function stop() {
  worker?.terminate();
  if (nativeSession) {
    fetch(`./native/stop/${nativeSession}`, { method: "POST", keepalive: true }).catch(() => {});
    nativeSession = null;
  }
}

function boot() {
  stop();
  cancelAnimationFrame(drawJob);
  drawJob = 0;
  nextFrame = null;
  activePointer = undefined;
  context.clearRect(0, 0, SIZE, SIZE);
  delete screen.dataset.frame;
  delete screen.dataset.touchReads;
  log.textContent = "";
  const native = mode.value === "native";
  status.textContent = native ? `正在用本机加速启动 ${name}` : `正在启动 ${name}`;
  reset.disabled = false;
  worker = new Worker(native ? "./native.js" : "./emulator.js", { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "frame") {
      nextFrame = data;
      if (!drawJob) {
        drawJob = requestAnimationFrame(() => {
          drawJob = 0;
          context.putImageData(new ImageData(nextFrame.pixels, SIZE, SIZE), 0, 0);
          if (!screen.dataset.frame) status.textContent = `运行中 · ${name}`;
          screen.dataset.frame = nextFrame.frame;
          if (nextFrame.touchReads !== undefined) screen.dataset.touchReads = nextFrame.touchReads;
          nextFrame = null;
        });
      }
    } else if (data.type === "session") {
      nativeSession = data.identifier;
    } else if (data.type === "log") {
      log.textContent = (log.textContent + data.output).slice(-24000);
    } else if (data.type === "booted") {
      status.textContent = "固件已载入，等待屏幕输出";
    } else if (data.type === "error") {
      status.textContent = data.message;
    }
  };
  worker.onerror = (event) => { status.textContent = event.message || "模拟器加载失败，请运行本地启动脚本"; };
  const copy = firmware.slice(0);
  worker.postMessage({ type: "boot", firmware: copy }, [copy]);
}

async function load(label, read) {
  const current = ++request;
  status.textContent = `正在读取 ${label}`;
  try {
    const bytes = await read();
    await checkNative;
    if (current !== request) return;
    if (bytes.byteLength < 0x10000 || bytes.byteLength > 32 * 1024 * 1024) {
      throw new Error("整机 BIN 大小超出支持范围");
    }
    const header = new DataView(bytes);
    if (header.getUint8(0) !== 0xe9 || header.getUint16(12, true) !== 9) {
      throw new Error("请选择 ESP32-S3 整机 BIN");
    }
    if (header.getUint16(0x8000, true) !== 0x50aa) {
      throw new Error("在 0x8000 找不到分区表，请选择合并后的整机 BIN");
    }
    firmware = bytes;
    name = label;
    boot();
  } catch (error) {
    if (current === request) status.textContent = error.message;
  }
}

get("demo").onclick = () => load("Chiikawa GO", async () => {
  const response = await fetch("./demo.bin");
  if (!response.ok) throw new Error("找不到示例整机包，请手动选择 BIN");
  return response.arrayBuffer();
});
get("file").onchange = ({ target }) => {
  const [file] = target.files;
  if (file) load(file.name, () => file.arrayBuffer());
  target.value = "";
};
reset.onclick = () => { request++; boot(); };
mode.onchange = () => { if (firmware) reset.click(); };
window.addEventListener("pagehide", stop);
window.addEventListener("pageshow", (event) => {
  if (event.persisted && firmware) boot();
});

function sendTouch(event, down) {
  const bounds = screen.getBoundingClientRect();
  const coordinate = (value, start, extent) => Math.max(0, Math.min(SIZE - 1, Math.floor((value - start) * SIZE / extent)));
  worker?.postMessage({ type: "touch", touch: {
    x: coordinate(event.clientX, bounds.left, bounds.width),
    y: coordinate(event.clientY, bounds.top, bounds.height),
    down,
  } });
}

screen.onpointerdown = (event) => {
  if (activePointer !== undefined || event.button !== 0 || !screen.dataset.frame) return;
  activePointer = event.pointerId;
  screen.setPointerCapture(event.pointerId);
  sendTouch(event, true);
};
screen.onpointermove = (event) => {
  if (activePointer === event.pointerId) sendTouch(event, true);
};
function release(event) {
  if (activePointer !== event.pointerId) return;
  activePointer = undefined;
  sendTouch(event, false);
}
screen.onpointerup = screen.onpointercancel = screen.onlostpointercapture = release;

const side = get("side");
const key = (down) => worker?.postMessage({ type: "key", down });
side.onpointerdown = (event) => {
  if (event.button !== 0) return;
  side.setPointerCapture(event.pointerId);
  key(true);
};
side.onlostpointercapture = () => key(false);
side.onkeydown = (event) => {
  if (event.key === " " || event.key === "Enter") key(true);
};
side.onkeyup = side.onblur = () => key(false);
