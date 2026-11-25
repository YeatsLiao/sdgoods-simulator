import { normalizeSoundPreferences } from "./sound-preferences.js";
import { SlotController } from "./slot-controller.js";
import { toArrayBuffer, flatInfo } from "./firmware-info.js";
import { DeviceSession } from "../device/session.js";
import { Renderer } from "../render/renderer.js";
import { Recorder } from "../render/recorder.js";
import { AudioEngine } from "../audio/engine.js";
import { MicCapture } from "../audio/mic.js";
import {
  DirectStreamPlayer,
  isDirectPlayable,
  parseStreamUrl,
} from "../audio/direct.js";
import { FlashStore } from "../flash/store.js";
import { readSlotState } from "../flash/slots.js";
import { FirmwareLibrary } from "../library/library.js";
import { createUI } from "../ui/panels.js";
import { DebugConsole } from "../debug/console.js";
import { StatsPanel } from "../debug/stats.js";
import { Inspector } from "../debug/inspector.js";
import * as macros from "../debug/macros.js";
import { download } from "../shared/dom.js";
import { clamp } from "../shared/format.js";
import { readJson, writeJson } from "../shared/storage.js";

const SIZE = 360;
const AUTO_SAVE_MS = 20000;
// Audio below this share of real time sounds broken even though it plays.
const SLOW_AUDIO_RATIO = 0.6;
// The hint explains a whole run, so it stays up past the toast's own timeout.
const SLOW_AUDIO_HINT_MS = 9000;
const REPLAY_LENGTHS = [2, 4, 8, 16];
const REPLAY_DEFAULT_SECONDS = 4;
// 串口日志按块到达，一行可能被拆开，留一段尾巴保证流地址能被整行解析。
const DIRECT_LOG_TAIL = 400;
// 设备停止送出 I2S 音频超过这个时间，就认为电台已经停了，把声音交还设备。
const DIRECT_SILENT_MS = 4000;

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
    this.slowAudioHintShown = false;
    this.slowAudioHintTimer = 0;
    this.busy = false;
    this.activePointer = undefined;
    this.recorder = null;
    this.recording = false;
    this.micActive = false;
    this.micLevel = 0;
    this.muted = false;
    this.volume = .8;
    this.dev = false;
    this.flashResolvers = [];
    this.autoSave = 0;
    this.levelsTimer = 0;
    this.lastFlashExport = false;
    this.slotController = new SlotController(this);
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
    // Playback strategies were removed from the UI; always start with realtime audio.
    this.applyReplayPrefs(null);
    this.direct = new DirectStreamPlayer();
    this.directFollow = readJson("audioDirect", null)?.follow !== false;
    this.directSource = "";
    this.directErrorShown = "";
    this.logTail = "";
    this.lastDeviceAudioAt = 0;
    this.directUnsubscribe = this.direct.onChange((state) => this.onDirectState(state));
    this.setSoundPreferences(readJson("sound", null), false);
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
    this.renderDirect();
    this.renderLibrary();
    await this.loadStatus();
    const query = new URLSearchParams(location.search);
    if (query.get("dev") === "1") this.setDevMode(true);

    this.levelsTimer = setInterval(() => this.refreshLevels(), 250);
    this.ui.setStatus?.("打开固件即可开始");
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
    this.byId("clear-open")?.addEventListener("click", () => this.restart(true));
    this.byId("screenshot")?.addEventListener("click", () => this.screenshot());
    this.byId("record")?.addEventListener("click", () => this.toggleRecording());
    this.byId("fullscreen")?.addEventListener("click", () => this.fullscreen());
    this.byId("dev")?.addEventListener("click", () => { if (!this.ui.toggleTools?.()) this.setDevMode(true); });
    elements.app.addEventListener("sdg:tools", () => this.setDevMode(true));
    this.byId("mute")?.addEventListener("click", () => this.toggleMute());
    this.byId("volume")?.addEventListener("input", (event) => {
      const value = Number(event.target.value) / 100;
      this.setSoundPreferences({ volume: value, muted: this.muted });
    });
    this.byId("mic")?.addEventListener("click", () => this.toggleMic());
    this.elements.mode?.addEventListener("change", () => {
      if (this.current) this.ui.toast?.("切换运行方式会重新启动当前固件", "info");
      this.switchMode(this.elements.mode.value);
    });

    const file = this.ui.elements.fileInput ?? this.byId("file");
    file?.addEventListener("change", async () => {
      const [selected] = file.files ?? [];
      file.value = "";
      if (selected) await this.addFile(selected);
    });

    const host = this.ui.elements.panelHost ?? this.root;
    host.addEventListener("sdg:library", (event) => {
      const { action, entry, url, sha256 } = event.detail ?? {};
      if (action === "file" && event.detail.file) this.addFile(event.detail.file);
      else if (action === "sample") this.runSample();
      else if (action === "run" && entry) this.runEntry(entry);
      else if (action === "url" && url) this.addUrl(url, sha256);
      else if (action === "hide-history" && entry) {
        this.library.hideRecent(entry.id);
        this.renderLibrary();
        this.ui.toast?.("已移除最近记录，固件数据和当前运行不受影响", "info");
      }
      else if (action === "remove" && entry) {
        this.library.remove(entry.id);
        this.slotController.dropSlotsForEntry(entry.id);
        this.renderLibrary();
      }
    });

    host.addEventListener("sdg:direct", (event) => this.onDirectEvent(event.detail ?? {}));

    this.root.addEventListener("sdg:slots", (event) => {
      const { action, slotIndex, entryId } = event.detail ?? {};
      if (action === "assign") this.slotController.installSlot(slotIndex, entryId);
      else if (action === "launch") this.slotController.launchSlot(slotIndex);
      else if (action === "clear") this.slotController.clearSlot(slotIndex);
      else if (action === "open-launcher") this.slotController.openLauncher();
      else if (action === "close-launcher") this.slotController.closeLauncher();
    });

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
      side.addEventListener("pointercancel", () => this.key(false));
      side.addEventListener("keydown", (event) => {
        if (!["Space", "Enter"].includes(event.code)) return;
        event.preventDefault();
        if (!event.repeat) this.key(true);
      });
      side.addEventListener("keyup", (event) => {
        if (!["Space", "Enter"].includes(event.code)) return;
        event.preventDefault();
        this.key(false);
      });
      side.addEventListener("blur", () => this.key(false));
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
    this.slotController.renderSlots();
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
    if (this.busy || this.sourceLoading) return;
    this.sourceLoading = true;
    this.ui.setPhase?.("preparing");
    this.ui.library?.setBusy?.(true);
    try {
      this.ui.setStatus?.("正在读取示例固件…");
      const entry = await this.library.loadSample();
      this.renderLibrary();
      this.sourceLoading = false;
      await this.runEntry(entry);
    } catch (error) {
      this.fail(error.message || String(error));
    } finally {
      this.sourceLoading = false;
      this.ui.library?.setBusy?.(false);
    }
  }

  async addFile(file) {
    if (this.busy || this.sourceLoading) return;
    this.sourceLoading = true;
    this.ui.setPhase?.("preparing");
    this.ui.library?.setBusy?.(true);
    try {
      this.ui.setStatus?.(`正在读取 ${file.name}`);
      const entry = await this.library.addFile(file);
      this.renderLibrary();
      this.sourceLoading = false;
      await this.runEntry(entry);
    } catch (error) {
      this.fail(error.message || String(error));
    } finally {
      this.sourceLoading = false;
      this.ui.library?.setBusy?.(false);
    }
  }

  async addUrl(url, sha256) {
    if (this.busy || this.sourceLoading) return;
    this.sourceLoading = true;
    this.ui.setPhase?.("preparing");
    this.ui.library?.setBusy?.(true);
    try {
      this.ui.setStatus?.("正在下载固件…");
      const entry = await this.library.addUrl(url, { sha256 });
      this.renderLibrary();
      this.sourceLoading = false;
      await this.runEntry(entry);
    } catch (error) {
      this.fail(error.message || String(error));
    } finally {
      this.sourceLoading = false;
      this.ui.library?.setBusy?.(false);
    }
  }

  async runCurrent() {
    const entry = this.current?.entry ?? this.library.list().find((item) => item.kind === "sample");
    if (entry) await this.runEntry(entry);
    else await this.runSample();
  }

  async runEntry(entryOrId) {
    if (this.busy || this.sourceLoading) return;
    this.ui.setPhase?.("preparing");
    this.busy = true;
    this.ui.showError?.(null);
    this.ui.library?.setBusy?.(true);
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
      this.ui.library?.setCurrent?.(prepared.entry.id);
      const info = flatInfo(prepared.entry, prepared.info, firmware.byteLength);
      this.ui.setFirmwareInfo?.(info);
      this.inspector.clearFault();
      this.inspector.setMode(this.mode);
      this.inspector.setFirmware(info);
      this.inspector.setPartitions(prepared.info?.partitions ?? []);
      this.console.clear();
      this.renderer.reset();
      this.hasFrame = false;
      this.beginRunHintState();
      this.running = true;
      this.ui.setRunning?.(true);
      this.ui.setPhase?.("starting");
      this.ui.launcher?.hide?.();
      this.slotController.renderSlots();
      this.ui.setStatus?.(this.mode === "native" ? "正在启动本机模拟器…" : "正在启动浏览器模拟器…");
      try {
        await this.audio.init();
        this.audio.setVolume(this.volume);
        this.audio.setMuted(this.muted);
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
      if (!this.hasFrame) {
        this.ui.setPhase?.("running");
        this.ui.setStatus?.("运行中");
      }
      this.hasFrame = true;
    });
    session.on("audio", ({ pcm, format }) => {
      this.lastDeviceAudioAt = Date.now();
      this.audio.play(new Uint8Array(pcm), format);
    });
    session.on("audioformat", ({ format }) => {
      if (!format.receive) this.ui.setAudioFormat?.(format);
    });
    session.on("log", (text) => {
      this.console.append(text);
      this.maybeSetupHint(text);
      this.maybeFollowStream(text);
    });
    session.on("status", ({ status }) => this.ui.setStatus?.(status));
    session.on("booted", (event) => {
      this.running = true;
      // A fresh boot starts a new measurement window for both hints.
      this.setupHintShown = false;
      this.slowAudioHintShown = false;
      this.ui.setRunning?.(true);
      this.ui.setPhase?.(this.hasFrame ? "running" : "waiting");
      this.ui.showError?.(null);
      this.ui.setStatus?.(this.hasFrame ? "运行中" : "固件已启动，等待首帧");
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
        audioQueue: this.audio.levels.queueMs,
        audioArrival: this.audio.levels.audioRatio,
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
    this.ui.showSetupHelp?.();
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
    if (this.busy || this.sourceLoading) return;
    if (clearFlash && !await this.ui.confirmClear?.(this.current?.entry?.name ?? "当前固件")) return;
    if (!this.session || !this.current) {
      this.runCurrent();
      return;
    }
    if (clearFlash) {
      await this.flashStore.clear(this.current.flashKey).catch(() => {});
    }
    // A restart is a new run: without `booted` after it (native keeps the
    // session and only reports status), the hint must be able to fire again.
    this.hasFrame = false;
    this.ui.setPhase?.("starting");
    this.beginRunHintState();
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
    // This path boots without a preceding run reset, so the hint state is
    // cleared here; other entries reach it through `booted`.
    this.beginRunHintState();
    this.session = new DeviceSession();
    this.wireSession(this.session);
    this.running = true;
    this.ui.setRunning?.(true);
    this.ui.setPhase?.("starting");
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
    if (this.busy || this.sourceLoading) { this.ui.setMode?.(this.mode); return; }
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
      this.slotController.launchSlot(this.current.slotIndex);
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
    this.elements?.side?.classList.toggle("is-active", Boolean(down));
    this.session?.key(down);
    this.macroRecorder.recordKey(down);
  }

  keyboard(event, down) {
    if (!down && this.keyboardSideDown && ["Space", "Enter"].includes(event.code)) {
      this.keyboardSideDown = false;
      this.key(false);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || document.querySelector("dialog[open]")) return;
    if (event.target?.closest?.("button, input, textarea, select, summary, a, [contenteditable=true]")) return;
    if (event.code === "Space" || event.code === "Enter") {
      event.preventDefault();
      this.keyboardSideDown = down;
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

  setSoundPreferences(value, persist = true) {
    const prefs = normalizeSoundPreferences(value);
    this.volume = prefs.volume;
    this.muted = prefs.muted;
    this.audio.setVolume(prefs.volume);
    this.audio.setMuted(prefs.muted);
    this.direct?.setVolume(prefs.volume);
    this.direct?.setMuted(prefs.muted);
    this.ui.setVolume?.(prefs.volume);
    this.ui.setMuted?.(prefs.muted);
    if (persist) writeJson("sound", prefs);
    return prefs;
  }

  toggleMute() {
    this.setSoundPreferences({ volume: this.volume, muted: !this.muted });
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
    this.ui.setDirectState?.(this.directView());
    // 设备不再往外送音频（退出电台、暂停、关机）时把声音交还设备，别让网页独自响。
    if (this.direct.active && this.directSource === "follow"
      && Date.now() - this.lastDeviceAudioAt > DIRECT_SILENT_MS) {
      this.stopDirect("设备已停止输出，连续收听结束");
    }
    this.ui.setAudioLevels?.({
      out: levels.outRms,
      in: this.micLevel,
      makeup: levels.makeup,
      arrival: levels.audioRatio,
      underruns: levels.underruns,
      queueMs: levels.queueMs,
      prerollMs: levels.prerollMs,
      dropped: levels.dropped,
      external: levels.external,
      capture: levels.capture,
      replay: levels.replay,
    });
    this.maybeSlowAudioHint(levels.audioRatio);
  }

  /**
   * 新会话默认实时互动；保留已保存的连续回放偏好。分段回放供延迟不敏感的声音使用。
   * @param {{auto?: boolean, seconds?: number}|null} stored
   * @returns {{enabled: boolean, target: number}}
   */
  applyReplayPrefs(stored) {
    const seconds = REPLAY_LENGTHS.includes(Number(stored?.seconds))
      ? Number(stored.seconds)
      : REPLAY_DEFAULT_SECONDS;
    const prefs = this.audio.setAutoReplay({ enabled: stored?.auto === true, target: seconds });
    this.ui.setReplayPrefs?.(prefs);
    return prefs;
  }

  saveReplayPrefs() {
    const prefs = this.audio.autoReplay;
    writeJson("audioReplay", { auto: prefs.enabled, seconds: prefs.target });
    this.ui.setReplayPrefs?.(prefs);
    return prefs;
  }

  /** @param {boolean} enabled */
  setAutoReplay(enabled) {
    this.audio.setAutoReplay({ enabled });
    const prefs = this.saveReplayPrefs();
    this.ui.toast?.(
      prefs.enabled
        ? `自动连续回放已开启：每攒满 ${prefs.target} 秒原速连播一段`
        : "已切回实时播放：到达率不足时会断续",
      "info",
    );
    return prefs;
  }

  /** @param {number} seconds 每段时长 */
  setReplayLength(seconds) {
    this.audio.setAutoReplay({ target: seconds });
    const prefs = this.saveReplayPrefs();
    this.ui.toast?.(`每段连续回放 ${prefs.target} 秒`, "info");
    return prefs;
  }

  /**
   * 连续回放：缓存中点击立即播放已攒下的部分；空闲时点击开始缓存一段。
   * 自动模式下攒满与续缓存都由引擎完成，这里只负责手动触发与提示。
   */
  async toggleCapture() {
    if (this.audio.capture.active) {
      const seconds = this.audio.playCapture();
      this.ui.setCaptureActive?.(this.audio.capture.active);
      if (seconds > 0) this.ui.toast?.(`连续回放 ${seconds.toFixed(1)} 秒`, "info");
      else this.ui.toast?.("还没缓存到音频，等设备送出声音后再点", "error");
      return;
    }
    const started = await this.audio.startCapture(this.audio.autoReplay.target);
    this.ui.setCaptureActive?.(started);
  }

  /**
   * 「连续收听」区块的事件入口：跟随开关、停止、手动地址。电台不由面板列，
   * 而是跟着设备串口里报出来的那一路流地址。
   * @param {{action?: string, url?: string, enabled?: boolean}} detail
   */
  onDirectEvent(detail) {
    if (detail.action === "follow") this.setDirectFollow(detail.enabled);
    else if (detail.action === "open") this.playDirect({ url: detail.url, source: "manual" });
    else if (detail.action === "stop") this.stopDirect("已停止连续收听，交还设备音频");
  }

  /** @returns {object} 面板要显示的直连状态，含跟随开关与来源 */
  directView() {
    return { ...this.direct.state, following: this.directFollow, source: this.directSource };
  }

  renderDirect() {
    this.ui.setDirectState?.(this.directView());
  }

  /** @param {boolean} enabled 关掉时只停掉正在播的直连流，不影响设备音频 */
  setDirectFollow(enabled) {
    this.directFollow = Boolean(enabled);
    writeJson("audioDirect", { follow: this.directFollow });
    if (!this.directFollow && this.direct.active && this.directSource === "follow") {
      this.stopDirect("跟随已关闭，交还设备音频");
    }
    this.renderDirect();
    this.ui.toast?.(
      this.directFollow ? "已开启跟随设备电台：设备播哪一路，网页就接哪一路" : "已关闭跟随，只听设备自己算出的声音",
      "info",
    );
    return this.directFollow;
  }

  /**
   * 设备开流时串口会打出 `net: connected, streaming: <url>`。日志按块到达，一行可能
   * 被拆成两块，所以留一小段尾巴再解析。
   * @param {string} text
   */
  maybeFollowStream(text) {
    if (!this.directFollow) return "";
    const chunk = `${this.logTail}${String(text ?? "")}`;
    this.logTail = chunk.slice(-DIRECT_LOG_TAIL);
    const url = parseStreamUrl(chunk);
    if (!url) return "";
    if (url === this.direct.station?.url) return "";
    if (!isDirectPlayable(url)) {
      this.ui.toast?.(`设备切到了 HLS/DASH 地址，网页接不了，仍用设备音频`, "info");
      return "";
    }
    this.playDirect({ url, source: "follow" });
    return url;
  }

  /**
   * 播一路浏览器直连的流，并把输出所有权从设备侧接过来。
   * @param {{url: string, source?: string}} detail
   */
  async playDirect(detail) {
    const url = String(detail.url || "").trim();
    if (!url) {
      this.ui.toast?.("请先填流地址", "error");
      return false;
    }
    const started = await this.direct.play({ url });
    if (!started) {
      // 已被更新的电台取代：新一路自己会接管输出，这里不该报错也不该交还设备。
      if (this.direct.station?.url !== url) return false;
      // 取流失败就把输出交还设备，不能让面板停在「暂停」却什么都听不到。
      this.audio.setExternalAudio(false);
      this.directSource = "";
      this.renderDirect();
      this.ui.toast?.(this.direct.state.error || "无法播放该地址", "error");
      return false;
    }
    this.directSource = detail.source === "manual" ? "manual" : "follow";
    this.lastDeviceAudioAt = Date.now();
    this.audio.setExternalAudio(true);
    this.applyDirectVolume();
    this.renderDirect();
    this.ui.toast?.(`连续收听：${this.direct.station?.name ?? url}`, "info");
    return true;
  }

  /** @param {string} [message] 交还设备音频时给用户的说明 */
  stopDirect(message = "已停止连续收听") {
    if (!this.direct.active) return;
    this.direct.stop();
    this.directSource = "";
    this.audio.setExternalAudio(false);
    this.renderDirect();
    if (message) this.ui.toast?.(message, "info");
  }

  /**
   * 直连播放的异步状态变化（缓冲好了、取流断了）。取流失败时回到设备音频。
   * @param {{error?: string, active?: boolean, playing?: boolean}} state
   */
  onDirectState(state) {
    this.ui.setDirectState?.({ ...state, following: this.directFollow, source: this.directSource });
    if (!state.error) {
      this.directErrorShown = "";
      return;
    }
    if (!state.active || state.error === this.directErrorShown) return;
    this.directErrorShown = state.error;
    this.stopDirect(`${state.error}，已交还设备音频`);
  }

  applyDirectVolume() {
    const value = Number(this.byId("volume")?.value);
    this.direct.setVolume(Number.isFinite(value) ? value / 100 : 1);
    this.direct.setMuted(this.muted);
  }

  /**
   * Reset the once-per-run hint state and retire the previous hint toast, so a
   * retained one cannot swallow the next run's message.
   */
  beginRunHintState() {
    this.setupHintShown = false;
    this.slowAudioHintShown = false;
    clearTimeout(this.slowAudioHintTimer);
    this.clearSlowAudioHintToast();
  }

  /**
   * The emulator cannot always feed the speaker in real time; say so once per
   * run so a quiet-but-working radio stream is not read as broken audio.
   * @param {number|null} ratio seconds of audio that arrived per second of wall time
   * @returns {HTMLElement|null} the hint toast, or null when nothing was shown
   */
  maybeSlowAudioHint(ratio) {
    if (this.slowAudioHintShown || !this.running) return null;
    if (this.audio.externalAudio) return null;
    if (!Number.isFinite(ratio) || ratio >= SLOW_AUDIO_RATIO || ratio <= 0) return null;
    this.slowAudioHintShown = true;
    const node = this.ui.toast?.(
      "模拟速度不足，声音可能断续。可尝试本机加速运行。",
      "info",
    );
    if (!node) return null;
    // Keep it readable, then retire it: a retained toast would swallow the hint
    // on the next run.
    node.dataset.slowAudio = "1";
    clearTimeout(this.slowAudioHintTimer);
    this.slowAudioHintTimer = setTimeout(() => this.clearSlowAudioHintToast(), SLOW_AUDIO_HINT_MS);
    return node;
  }

  // The hint explains a whole run, so it is retired explicitly instead of
  // staying up indefinitely like the error toasts.
  slowAudioHintNodes() {
    const host = this.ui.elements?.toastHost;
    if (!host) return [];
    // A toast that is fading out is already detached from the host but keeps its
    // marker, so both lists are searched before removing.
    return [...host.children, ...host.querySelectorAll(".toast")].filter(
      (node) => node.dataset?.slowAudio === "1",
    );
  }

  clearSlowAudioHintToast() {
    clearTimeout(this.slowAudioHintTimer);
    this.slowAudioHintTimer = 0;
    for (const node of this.slowAudioHintNodes()) node.remove();
  }

  fail(message) {
    this.ui.setPhase?.(this.hasFrame ? "running" : "error");
    this.ui.setStatus?.("操作未完成，请查看提示");
    const actions = this.mode === "native" ? [{
      label: "切换浏览器模式",
      onClick: () => {
        this.mode = "wasm";
        this.ui.setMode?.("wasm");
        this.replayCurrent();
      },
    }] : [];
    actions.push({ label: "重新打开固件", onClick: () => this.ui.showPanel?.("library") });
    if (this.ui.showError) this.ui.showError(message, actions);
    else this.ui.setStatus?.(message);
    this.ui.toast?.(message, "error");
  }
}
