import { DeviceSession } from "../device/session.js";
import { describeFirmware } from "../device/firmware.js";
import { Renderer } from "../render/renderer.js";
import { Recorder } from "../render/recorder.js";
import { AudioEngine } from "../audio/engine.js";
import { MicCapture } from "../audio/mic.js";
import { FlashStore } from "../flash/store.js";
import { isAppPackage, loadPlatformAssets } from "../flash/app-package.js";
import { buildSlotImage, parseSlotLayout } from "../flash/device-image.js";
import { OTA_SECTOR_SIZE } from "../flash/otadata.js";
import {
  assignSlot, clearSlot, readSlotState, selectSlot, writeSlotState,
} from "../flash/slots.js";
import { getFirmware } from "../library/cache.js";
import { FirmwareLibrary } from "../library/library.js";
import { createUI } from "../ui/panels.js";
import { DebugConsole } from "../debug/console.js";
import { StatsPanel } from "../debug/stats.js";
import { Inspector } from "../debug/inspector.js";
import * as macros from "../debug/macros.js";
import { download } from "../shared/dom.js";
import { clamp, formatBytes } from "../shared/format.js";

const SIZE = 360;
const AUTO_SAVE_MS = 20000;

function toArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  throw new TypeError("固件数据格式不正确");
}

function flatInfo(entry, info, size) {
  const app = info?.app ?? {};
  return {
    name: entry?.name ?? "firmware.bin",
    project: app.project ?? entry?.project ?? "—",
    version: app.version ?? entry?.version ?? "—",
    idf: app.idf ?? "—",
    size: size ?? entry?.size ?? 0,
  };
}

export class App {
  constructor(root) {
    this.root = root;
    this.ui = null;
    this.elements = {};
    this.session = null;
    this.current = null;
    this.mode = "wasm";
    this.nativeAvailable = false;
    this.running = false;
    this.hasFrame = false;
    this.setupHintShown = false;
    this.busy = false;
    this.activePointer = undefined;
    this.recorder = null;
    this.recording = false;
    this.micActive = false;
    this.micLevel = 0;
    this.muted = false;
    this.dev = false;
    this.flashResolvers = [];
    this.autoSave = 0;
    this.levelsTimer = 0;
    this.lastFlashExport = false;
    this.slots = readSlotState();
    this.slotLayout = null;
    this.platformPromise = null;
  }

  async init() {
    this.ui = createUI(this.root);
    this.elements = this.ui.elements ?? {};
    this.elements.canvas ??= document.getElementById("screen");
    this.elements.side ??= document.getElementById("side");
    this.elements.mode ??= document.getElementById("mode");
    if (!this.elements.canvas) throw new Error("页面缺少 360×360 画布");

    this.renderer = new Renderer(this.elements.canvas);
    this.audio = new AudioEngine();
    this.mic = new MicCapture();
    this.flashStore = new FlashStore();
    this.library = new FirmwareLibrary();
    this.console = new DebugConsole({
      mount: this.ui.elements.consoleMount ?? document.querySelector(".console-mount"),
      onSend: (text) => this.sendUart(text),
    });
    this.statsPanel = new StatsPanel({
      mount: this.ui.elements.statsMount ?? document.querySelector(".stats-mount"),
    });
    this.inspector = new Inspector({
      mount: this.ui.elements.inspectorMount ?? document.querySelector(".inspector-mount"),
      callbacks: {
        onFlash: () => this.requestFlash(true),
        onClearFlash: () => this.restart(true),
        onImportFlash: (bytes) => this.importFlash(bytes),
        onElf: (bytes) => this.session?.loadElf(bytes),
        onRegisters: () => this.session?.requestRegisters(),
        onMemory: (addr, len) => this.session?.requestMemory(addr, len),
        onGpio: () => this.session?.requestGpio(),
      },
    });
    this.macroRecorder = new macros.MacroRecorder({ onPlay: (event) => this.playMacro(event) });
    if (macros.MacroPanel) {
      this.macroPanel = new macros.MacroPanel({
        mount: this.ui.elements.macroMount ?? document.querySelector(".macro-mount"),
        recorder: this.macroRecorder,
      });
    }

    this.mic.on("data", (chunk) => this.session?.mic(chunk.buffer));
    this.mic.on("level", ({ rms }) => { this.micLevel = rms; });
    this.mic.on("error", (message) => this.ui.toast?.(message, "error"));

    this.bind();
    this.renderLibrary();
    await this.loadStatus();
    const query = new URLSearchParams(location.search);
    if (query.get("dev") === "1") this.setDevMode(true);
    this.ui.onboarding?.show?.();
    this.levelsTimer = setInterval(() => this.refreshLevels(), 250);
    this.ui.setStatus?.("选择一个玩法开始");
  }

  async loadStatus() {
    let status = null;
    try {
      const response = await fetch("./api/status", { cache: "no-store" });
      if (response.ok) status = await response.json();
    } catch {
      status = null;
    }
    this.nativeAvailable = Boolean(status?.native);
    this.ui.setNativeAvailable?.(this.nativeAvailable);
    this.mode = this.ui.setMode?.(this.nativeAvailable ? "native" : "wasm")
      ?? (this.nativeAvailable ? "native" : "wasm");
    if (status?.sample?.name) {
      this.ui.setStatus?.(`示例：${status.sample.name}`);
    }
  }

  bind() {
    const elements = this.elements;
    this.byId("run")?.addEventListener("click", () => this.runCurrent());
    this.byId("restart")?.addEventListener("click", () => this.restart(false));
    this.byId("reset")?.addEventListener("click", () => this.restart(true));
    this.byId("screenshot")?.addEventListener("click", () => this.screenshot());
    this.byId("record")?.addEventListener("click", () => this.toggleRecording());
    this.byId("fullscreen")?.addEventListener("click", () => this.fullscreen());
    this.byId("dev")?.addEventListener("click", () => this.setDevMode(!this.dev));
    this.byId("mute")?.addEventListener("click", () => this.toggleMute());
    this.byId("volume")?.addEventListener("input", (event) => this.audio.setVolume(Number(event.target.value) / 100));
    this.byId("mic")?.addEventListener("click", () => this.toggleMic());
    this.elements.mode?.addEventListener("change", () => this.switchMode(this.elements.mode.value));

    const file = this.ui.elements.fileInput ?? this.byId("file");
    file?.addEventListener("change", async () => {
      const [selected] = file.files ?? [];
      file.value = "";
      if (selected) await this.addFile(selected);
    });

    const host = this.ui.elements.panelHost ?? this.root;
    host.addEventListener("sdg:library", (event) => {
      const { action, entry, url, sha256 } = event.detail ?? {};
      if (action === "sample") this.runSample();
      else if (action === "run" && entry) this.runEntry(entry);
      else if (action === "url" && url) this.addUrl(url, sha256);
      else if (action === "remove" && entry) {
        this.library.remove(entry.id);
        this.dropSlotsForEntry(entry.id);
        this.renderLibrary();
      }
    });

    this.root.addEventListener("sdg:slots", (event) => {
      const { action, slotIndex, entryId } = event.detail ?? {};
      if (action === "assign") this.installSlot(slotIndex, entryId);
      else if (action === "launch") this.launchSlot(slotIndex);
      else if (action === "clear") this.clearSlot(slotIndex);
      else if (action === "open-launcher") this.openLauncher();
      else if (action === "close-launcher") this.closeLauncher();
    });
    this.byId("launcher")?.addEventListener("click", () => this.openLauncher());

    const screen = elements.canvas;
    screen.addEventListener("pointerdown", (event) => this.touchStart(event));
    screen.addEventListener("pointermove", (event) => this.touchMove(event));
    screen.addEventListener("pointerup", (event) => this.touchEnd(event));
    screen.addEventListener("pointercancel", (event) => this.touchEnd(event));
    screen.addEventListener("lostpointercapture", (event) => this.touchEnd(event));

    const side = elements.side;
    if (side) {
      side.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        side.setPointerCapture(event.pointerId);
        this.key(true);
      });
      side.addEventListener("lostpointercapture", () => this.key(false));
      side.addEventListener("pointerup", () => this.key(false));
    }

    window.addEventListener("keydown", (event) => this.keyboard(event, true));
    window.addEventListener("keyup", (event) => this.keyboard(event, false));
    // Native mode persists flash in its session directory; only the browser
    // runtime needs a snapshot before the page goes away.
    window.addEventListener("pagehide", () => {
      if (this.mode === "wasm") this.requestFlash(false);
    });
    document.addEventListener("visibilitychange", () => {
      if (this.mode === "wasm" && document.visibilityState === "hidden") this.requestFlash(false);
    });
  }

  byId(id) {
    return this.elements[id] ?? document.getElementById(id);
  }

  renderLibrary() {
    this.ui.library?.render?.(this.library.list());
    this.renderSlots();
  }

  ensureSlotLayout() {
    this.platformPromise ??= loadPlatformAssets()
      .then((assets) => {
        const layout = parseSlotLayout(assets.partitionTable);
        this.slotLayout = layout;
        this.renderSlots();
        return { ...assets, layout };
      })
      .catch((error) => {
        this.platformPromise = null;
        throw error;
      });
    return this.platformPromise;
  }

  slotView() {
    const layout = this.slotLayout?.slots ?? [];
    const byIndex = new Map(layout.map((slot) => [slot.slotIndex, slot]));
    const count = layout.length || this.slots.slots.length;
    const slots = [];
    for (let index = 0; index < count; index++) {
      const partition = byIndex.get(index);
      slots.push({
        slotIndex: index,
        offset: partition?.offset ?? null,
        size: partition?.size ?? null,
        app: this.slots.slots[index] ?? null,
      });
    }
    return {
      slots,
      selected: this.slots.selected,
      runningSlot: this.session ? this.current?.slotIndex ?? null : null,
      entries: this.library.list(),
      busy: this.busy,
    };
  }

  renderSlots() {
    if (!this.ui?.slots) return;
    const view = this.slotView();
    this.ui.slots.render?.(view);
    if (this.ui.launcher?.visible) this.ui.launcher.render?.(view);
  }

  async openLauncher() {
    if (this.busy) return;
    if (this.session) {
      await this.saveBeforeStop();
      this.stopSession();
    }
    this.renderSlots();
    this.ui.launcher?.show?.(this.slotView());
    this.ui.setStatus?.("启动器：从 OTA 槽启动应用");
  }

  closeLauncher() {
    this.ui.launcher?.hide?.();
    this.ui.setStatus?.(this.session ? "运行中" : "选择一个玩法开始");
  }

  async dropSlotsForEntry(entryId) {
    let changed = false;
    for (let index = 0; index < this.slots.slots.length; index++) {
      if (this.slots.slots[index]?.entryId === entryId) {
        this.slots = clearSlot(this.slots, index);
        changed = true;
      }
    }
    if (!changed) return;
    writeSlotState(this.slots);
    this.renderSlots();
    this.ui.toast?.("固件已移除，引用它的应用槽已清空", "warning");
  }

  async installSlot(slotIndex, entryId) {
    if (this.busy) return;
    if (!entryId) {
      this.ui.toast?.("请先选择一个固件条目", "warning");
      return;
    }
    this.busy = true;
    this.ui.showError?.(null);
    this.ui.library?.setBusy?.(true);
    this.renderSlots();
    try {
      const { layout } = await this.ensureSlotLayout();
      const slot = layout.slots.find((item) => item.slotIndex === slotIndex);
      if (!slot) throw new Error(`平台分区表没有 OTA${slotIndex} 槽`);
      const raw = await this.library.raw(entryId);
      const bytes = new Uint8Array(raw.firmware);
      if (!isAppPackage(bytes)) {
        throw new Error("整机镜像不能装入 OTA 槽，请选择纯 app 包（无分区表、描述符在 0x10000 之前）");
      }
      if (bytes.byteLength > slot.size) {
        throw new Error(
          `应用 ${formatBytes(bytes.byteLength)} 超过 OTA${slotIndex} 槽容量 ${formatBytes(slot.size)}`,
        );
      }
      const app = raw.info?.app ?? {};
      this.slots = assignSlot(this.slots, slotIndex, {
        entryId: raw.entry.id,
        sha256: raw.sha256,
        name: raw.entry.name,
        version: (typeof app.version === "string" && app.version) || raw.entry.version || "",
        project: (typeof app.project === "string" && app.project) || raw.entry.project || "",
        size: bytes.byteLength,
      });
      writeSlotState(this.slots);
      this.renderLibrary();
      this.ui.toast?.(`已装入 OTA${slotIndex}：${raw.entry.name}`, "success");
      this.ui.setStatus?.(`OTA${slotIndex} 已装入 ${raw.entry.name}`);
    } catch (error) {
      this.fail(error.message || String(error));
    } finally {
      this.busy = false;
      this.ui.library?.setBusy?.(false);
      this.renderSlots();
    }
  }

  async resolveSlotApp(assignment, slotIndex) {
    let firmware = assignment.sha256
      ? await getFirmware(assignment.sha256).catch(() => null)
      : null;
    let entry = null;
    let info = null;
    let sha = assignment.sha256;
    if (!firmware && assignment.entryId) {
      const raw = await this.library.raw(assignment.entryId).catch(() => null);
      if (raw) {
        firmware = raw.firmware;
        entry = raw.entry;
        info = raw.info;
        sha = raw.sha256;
      }
    }
    if (!firmware) {
      throw new Error(`OTA${slotIndex} 的固件缓存已丢失（${assignment.name}），请重新装入`);
    }
    if (sha && sha !== assignment.sha256) {
      throw new Error(`OTA${slotIndex} 的固件与槽记录不一致，请重新装入`);
    }
    info ??= describeFirmware(firmware);
    entry ??= {
      id: assignment.entryId,
      name: assignment.name,
      version: assignment.version,
      project: assignment.project,
      kind: "file",
      size: assignment.size,
    };
    return { entry, firmware, info, sha256: assignment.sha256 };
  }

  /** Slot boots re-stamp otadata on the restored snapshot (see DeviceSession). */
  otadataPatch(built) {
    const size = Math.max(OTA_SECTOR_SIZE, built.otadata.size);
    const data = new Uint8Array(size).fill(0xff);
    data.set(built.bytes.subarray(built.otadata.offset, built.otadata.offset + OTA_SECTOR_SIZE));
    return { offset: built.otadata.offset, data };
  }

  async launchSlot(slotIndex) {
    if (this.busy) return;
    const assignment = this.slots.slots[slotIndex];
    if (!assignment) {
      this.ui.toast?.(`OTA${slotIndex} 是空槽`, "warning");
      return;
    }
    this.busy = true;
    this.ui.showError?.(null);
    this.ui.library?.setBusy?.(true);
    this.ui.onboarding?.hide?.();
    try {
      const { bootloader, partitionTable, seed, layout } = await this.ensureSlotLayout();
      const slot = layout.slots.find((item) => item.slotIndex === slotIndex);
      if (!slot) throw new Error(`平台分区表没有 OTA${slotIndex} 槽`);

      const selectedApp = await this.resolveSlotApp(assignment, slotIndex);
      const apps = [{ slotIndex, bytes: new Uint8Array(selectedApp.firmware) }];
      for (let index = 0; index < this.slots.slots.length; index++) {
        if (index === slotIndex) continue;
        const item = this.slots.slots[index];
        if (!item) continue;
        const raw = await this.resolveSlotApp(item, index);
        apps.push({ slotIndex: index, bytes: new Uint8Array(raw.firmware) });
      }

      const built = buildSlotImage({ bootloader, partitionTable, seed, apps, selected: slotIndex });
      const firmware = toArrayBuffer(built.bytes);
      const flashKey = `slot-${slotIndex}-${assignment.sha256}`;
      this.ui.setStatus?.(`正在从 OTA${slotIndex} 启动 ${assignment.name}`);

      if (this.session) {
        await this.saveBeforeStop();
        this.stopSession();
      }
      const flash = this.mode === "wasm"
        ? await this.flashStore.load(flashKey, firmware).catch(() => null)
        : null;
      const flashPatch = this.otadataPatch(built);

      this.current = {
        entry: selectedApp.entry,
        firmware,
        info: selectedApp.info,
        flashKey,
        slotIndex,
      };
      const info = this.firmwareInfo();
      this.ui.setFirmwareInfo?.(info);
      this.inspector.clearFault();
      this.inspector.setMode(this.mode);
      this.inspector.setFirmware(info);
      this.inspector.setPartitions(describeFirmware(firmware).partitions);
      this.console.clear();
      this.renderer.reset();
      this.hasFrame = false;
      this.setupHintShown = false;
      this.running = true;
      this.ui.setRunning?.(true);
      this.ui.launcher?.hide?.();
      this.ui.setStatus?.(this.mode === "native" ? "正在启动本机模拟器…" : "正在启动浏览器模拟器…");
      try {
        await this.audio.init();
        this.audio.setVolume(0.8);
      } catch (error) {
        this.ui.toast?.(`音频未启用：${error.message || error}`, "error");
      }
      this.session = new DeviceSession();
      this.wireSession(this.session);
      this.session.boot({
        mode: this.mode,
        firmware: this.current.firmware,
        flash,
        flashPatch,
        name: `${selectedApp.entry.name} · OTA${slotIndex}`,
        flashKey,
        preserveFlash: true,
      });
      this.startAutoSave();
      this.slots = selectSlot(this.slots, slotIndex);
      writeSlotState(this.slots);
      this.renderSlots();
    } catch (error) {
      this.fail(error.message || String(error));
      this.ui.launcher?.show?.(this.slotView());
    } finally {
      this.busy = false;
      this.ui.library?.setBusy?.(false);
      this.renderSlots();
    }
  }

  async clearSlot(slotIndex) {
    if (this.busy) return;
    if (!this.slots.slots[slotIndex]) return;
    this.slots = clearSlot(this.slots, slotIndex);
    writeSlotState(this.slots);
    if (this.current?.slotIndex === slotIndex) {
      await this.openLauncher();
    } else {
      this.renderSlots();
    }
    this.ui.toast?.(`已清空 OTA${slotIndex}`, "info");
  }

  firmwareInfo() {
    const current = this.current;
    if (!current) return null;
    const entry = current.slotIndex === null || current.slotIndex === undefined
      ? current.entry
      : { ...current.entry, name: `${current.entry.name} · OTA${current.slotIndex}` };
    return flatInfo(entry, current.info, current.firmware.byteLength);
  }

  async runSample() {
    try {
      this.ui.setStatus?.("正在读取示例固件…");
      const entry = await this.library.loadSample();
      this.renderLibrary();
      await this.runEntry(entry);
    } catch (error) {
      this.fail(error.message || String(error));
    }
  }

  async addFile(file) {
    try {
      this.ui.setStatus?.(`正在读取 ${file.name}`);
      const entry = await this.library.addFile(file);
      this.renderLibrary();
      await this.runEntry(entry);
    } catch (error) {
      this.fail(error.message || String(error));
    }
  }

  async addUrl(url, sha256) {
    try {
      this.ui.setStatus?.("正在下载固件…");
      const entry = await this.library.addUrl(url, { sha256 });
      this.renderLibrary();
      await this.runEntry(entry);
    } catch (error) {
      this.fail(error.message || String(error));
    }
  }

  async runCurrent() {
    const entry = this.current?.entry ?? this.library.list().find((item) => item.kind === "sample");
    if (entry) await this.runEntry(entry);
    else await this.runSample();
  }

  async runEntry(entryOrId) {
    if (this.busy) return;
    this.busy = true;
    this.ui.showError?.(null);
    this.ui.library?.setBusy?.(true);
    this.ui.onboarding?.hide?.();
    try {
      const prepared = await this.library.prepare(entryOrId);
      const firmware = toArrayBuffer(prepared.firmware);
      this.renderLibrary();
      const flashKey = prepared.flashKey;
      this.ui.setStatus?.(`正在准备 ${prepared.entry.name}`);
      if (this.session) {
        await this.saveBeforeStop();
        this.stopSession();
      }
      const flash = this.mode === "wasm"
        ? await this.flashStore.load(flashKey, firmware).catch(() => null)
        : null;
      this.current = { entry: prepared.entry, firmware, info: prepared.info, flashKey, slotIndex: null };
      const info = flatInfo(prepared.entry, prepared.info, firmware.byteLength);
      this.ui.setFirmwareInfo?.(info);
      this.inspector.clearFault();
      this.inspector.setMode(this.mode);
      this.inspector.setFirmware(info);
      this.inspector.setPartitions(prepared.info?.partitions ?? []);
      this.console.clear();
      this.renderer.reset();
      this.hasFrame = false;
      this.setupHintShown = false;
      this.running = true;
      this.ui.setRunning?.(true);
      this.ui.launcher?.hide?.();
      this.renderSlots();
      this.ui.setStatus?.(this.mode === "native" ? "正在启动本机模拟器…" : "正在启动浏览器模拟器…");
      try {
        await this.audio.init();
        this.audio.setVolume(0.8);
      } catch (error) {
        this.ui.toast?.(`音频未启用：${error.message || error}`, "error");
      }
      this.session = new DeviceSession();
      this.wireSession(this.session);
      this.session.boot({
        mode: this.mode,
        firmware: this.current.firmware,
        flash,
        name: prepared.entry.name,
        flashKey,
        preserveFlash: true,
      });
      this.startAutoSave();
    } catch (error) {
      this.fail(error.message || String(error));
    } finally {
      this.busy = false;
      this.ui.library?.setBusy?.(false);
    }
  }

  wireSession(session) {
    session.on("frame", ({ packed }) => {
      this.renderer.draw(new Uint16Array(packed));
      this.hasFrame = true;
    });
    session.on("audio", ({ pcm, format }) => {
      this.audio.play(new Uint8Array(pcm), format);
    });
    session.on("audioformat", ({ format }) => {
      this.ui.setStatus?.(format.receive
        ? `麦克风 ${format.rate} Hz / ${format.bits} bit`
        : `扬声器 ${format.rate} Hz / ${format.bits} bit`);
    });
    session.on("log", (text) => {
      this.console.append(text);
      this.maybeSetupHint(text);
    });
    session.on("status", ({ status }) => this.ui.setStatus?.(status));
    session.on("booted", (event) => {
      this.running = true;
      this.ui.setRunning?.(true);
      this.ui.showError?.(null);
      this.ui.setStatus?.("运行中");
      const info = this.firmwareInfo();
      if (info) {
        this.ui.setFirmwareInfo?.(info);
        this.inspector.setFirmware(info);
      }
      if (event.firmware) {
        this.inspector.setPartitions(event.firmware.partitions ?? []);
      }
    });
    session.on("error", ({ message }) => {
      this.ui.setRunning?.(false);
      this.fail(message);
    });
    session.on("fault", ({ report }) => {
      this.inspector.setFault(report);
      this.ui.setStatus?.("固件异常，已保留日志");
    });
    session.on("stats", ({ stats }) => {
      this.statsPanel.update({
        ...stats,
        drawMs: this.renderer.stats?.drawMs,
        dropped: this.renderer.stats?.dropped,
        audioQueue: this.audio.levels.outQueued,
        audioUnderruns: this.audio.levels.underruns,
      });
    });
    session.on("flash", ({ bytes }) => this.handleFlash(bytes));
    session.on("registers", ({ data }) => this.inspector.setRegisters(data));
    session.on("memory", ({ data }) => this.inspector.setMemory(data));
    session.on("gpio", ({ data }) => this.inspector.setGpio(data));
  }

  maybeSetupHint(text) {
    if (this.setupHintShown) return;
    if (!/enter setup mode|AP started|http server up/i.test(text)) return;
    this.setupHintShown = true;
    this.ui.toast?.("设备已进入配网：Wi-Fi 选 myssid，密码 mypassword", "info");
  }

  startAutoSave() {
    clearInterval(this.autoSave);
    if (this.mode !== "wasm") return;
    this.autoSave = setInterval(() => this.requestFlash(false), AUTO_SAVE_MS);
  }

  saveBeforeStop() {
    if (this.mode !== "wasm" || !this.session) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this.flashResolvers.push(finish);
      this.session.requestFlash();
      setTimeout(finish, 1200);
    });
  }

  stopSession() {
    clearInterval(this.autoSave);
    this.autoSave = 0;
    this.flashResolvers = [];
    if (this.micActive) this.toggleMic(false);
    this.session?.destroy?.();
    this.session = null;
    this.running = false;
    this.hasFrame = false;
    this.renderer.reset();
    this.ui.setRunning?.(false);
  }

  async restart(clearFlash) {
    if (!this.session || !this.current) {
      this.runCurrent();
      return;
    }
    if (clearFlash) {
      await this.flashStore.clear(this.current.flashKey).catch(() => {});
    }
    this.renderer.reset();
    this.console.append(clearFlash ? "— 恢复出厂，重新启动 —" : "— 重启，保留数据 —");
    this.session.restart({ clearFlash });
    this.ui.setStatus?.(clearFlash ? "已清除 Flash，正在重启" : "正在重启");
  }

  async importFlash(bytes) {
    if (!this.current) return;
    if (this.mode !== "wasm") {
      this.fail("本机模式暂不支持导入 Flash，请切换到浏览器模式");
      return;
    }
    await this.saveBeforeStop();
    this.stopSession();
    const firmware = this.current.firmware;
    this.session = new DeviceSession();
    this.wireSession(this.session);
    this.running = true;
    this.ui.setRunning?.(true);
    this.session.boot({
      mode: "wasm",
      firmware,
      flash: toArrayBuffer(bytes),
      name: this.current.entry.name,
      flashKey: this.current.flashKey,
      preserveFlash: true,
    });
    this.startAutoSave();
    this.ui.setStatus?.("已导入 Flash，正在启动");
  }

  async requestFlash(exportFile) {
    if (!this.session || !this.current) return;
    this.lastFlashExport = Boolean(exportFile);
    this.session.requestFlash();
    if (exportFile) this.ui.setStatus?.("正在导出 Flash…");
  }

  async handleFlash(bytes) {
    const resolvers = this.flashResolvers;
    this.flashResolvers = [];
    for (const resolve of resolvers) resolve();
    if (this.lastFlashExport) {
      this.lastFlashExport = false;
      download(new Blob([bytes], { type: "application/octet-stream" }),
        `${(this.current?.entry.name ?? "flash").replace(/\.bin$/i, "")}-flash.bin`);
      this.ui.toast?.("Flash 已导出");
      return;
    }
    if (this.mode === "wasm" && this.current) {
      await this.flashStore.save(this.current.flashKey, this.current.firmware, bytes).catch(() => {});
    }
  }

  switchMode(mode) {
    if (mode === "native" && !this.nativeAvailable) {
      this.ui.toast?.("本机加速不可用，请使用浏览器模式", "error");
      this.ui.setMode?.("wasm");
      return;
    }
    this.mode = this.ui.setMode?.(mode) ?? mode;
    this.inspector.setMode(mode);
    this.replayCurrent();
  }

  replayCurrent() {
    if (!this.current) return;
    if (this.current.slotIndex !== null && this.current.slotIndex !== undefined) {
      this.launchSlot(this.current.slotIndex);
    } else {
      this.runEntry(this.current.entry);
    }
  }

  setDevMode(on) {
    this.dev = Boolean(on);
    this.ui.setDevMode?.(this.dev);
    if (this.dev) this.ui.showPanel?.("console");
  }

  screenPoint(event) {
    const bounds = this.elements.canvas.getBoundingClientRect();
    return {
      x: clamp(Math.floor((event.clientX - bounds.left) * SIZE / bounds.width), 0, SIZE - 1),
      y: clamp(Math.floor((event.clientY - bounds.top) * SIZE / bounds.height), 0, SIZE - 1),
    };
  }

  touchStart(event) {
    if (this.activePointer !== undefined || event.button !== 0 || !this.session || !this.hasFrame) return;
    this.activePointer = event.pointerId;
    this.elements.canvas.setPointerCapture(event.pointerId);
    const touch = { ...this.screenPoint(event), down: true };
    this.session.touch(touch);
    this.macroRecorder.recordTouch(touch);
  }

  touchMove(event) {
    if (this.activePointer !== event.pointerId || !this.session) return;
    const touch = { ...this.screenPoint(event), down: true };
    this.session.touch(touch);
    this.macroRecorder.recordTouch(touch);
  }

  touchEnd(event) {
    if (this.activePointer !== event.pointerId) return;
    this.activePointer = undefined;
    const touch = { ...this.screenPoint(event), down: false };
    this.session?.touch(touch);
    this.macroRecorder.recordTouch(touch);
  }

  key(down) {
    this.session?.key(down);
    this.macroRecorder.recordKey(down);
  }

  keyboard(event, down) {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)) return;
    if (event.code === "Space" || event.code === "Enter") {
      event.preventDefault();
      this.key(down);
    } else if (down && event.key.toLowerCase() === "r") {
      this.restart(false);
    } else if (down && event.key.toLowerCase() === "s") {
      this.screenshot();
    } else if (down && event.key.toLowerCase() === "f") {
      this.fullscreen();
    } else if (down && event.key.toLowerCase() === "d") {
      this.setDevMode(!this.dev);
    }
  }

  playMacro(event) {
    if (event.kind === "touch") this.session?.touch(event.touch);
    else if (event.kind === "key") this.session?.key(event.down);
  }

  sendUart(text) {
    if (!this.session) return;
    const line = text.endsWith("\n") ? text : `${text}\n`;
    this.session.uart(line);
    this.console.append(`> ${text}`);
  }

  async screenshot() {
    try {
      const blob = await this.renderer.screenshot();
      const name = (this.current?.entry.name ?? "screen").replace(/\.bin$/i, "");
      download(blob, `${name}-${Date.now()}.png`);
      this.ui.toast?.("截图已保存");
    } catch (error) {
      this.fail(`截图失败：${error.message || error}`);
    }
  }

  async toggleRecording() {
    try {
      if (this.recording) {
        const blob = await this.recorder?.stop();
        this.recorder = null;
        this.recording = false;
        this.ui.setRecording?.(false);
        if (blob) {
          const name = (this.current?.entry.name ?? "screen").replace(/\.bin$/i, "");
          download(blob, `${name}-${Date.now()}.webm`);
          this.ui.toast?.("录屏已保存");
        }
        return;
      }
      await this.audio.init().catch(() => {});
      const audioStream = this.audio.createRecordingStream();
      this.recorder = new Recorder(this.elements.canvas, { audioStream });
      const started = this.recorder.start();
      this.recording = Boolean(started);
      this.ui.setRecording?.(this.recording);
      if (!started) {
        this.recorder = null;
        this.ui.toast?.("当前浏览器不支持录屏", "error");
      }
    } catch (error) {
      this.fail(`录屏失败：${error.message || error}`);
    }
  }

  fullscreen() {
    const target = this.elements.device ?? this.elements.canvas.parentElement ?? this.elements.canvas;
    target.requestFullscreen?.().catch(() => {});
  }

  toggleMute() {
    this.muted = !this.muted;
    this.audio.setMuted(this.muted);
    this.ui.setMuted?.(this.muted);
  }

  async toggleMic(force) {
    const next = typeof force === "boolean" ? force : !this.micActive;
    if (next === this.micActive) return;
    if (next) {
      try {
        await this.mic.start();
        this.micActive = true;
      } catch (error) {
        this.micActive = false;
        this.ui.toast?.(error.message || "麦克风启动失败", "error");
      }
    } else {
      await this.mic.stop().catch(() => {});
      this.micActive = false;
    }
    this.ui.setMicActive?.(this.micActive);
  }

  refreshLevels() {
    const levels = this.audio.levels;
    this.ui.setAudioLevels?.({ out: levels.outRms, in: this.micLevel });
  }

  fail(message) {
    const actions = this.mode === "native" ? [{
      label: "切换浏览器模式",
      onClick: () => {
        this.mode = "wasm";
        this.ui.setMode?.("wasm");
        this.replayCurrent();
      },
    }] : [];
    if (this.ui.showError) this.ui.showError(message, actions);
    else this.ui.setStatus?.(message);
    this.ui.toast?.(message, "error");
  }
}
