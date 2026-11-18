import { clear, download, el } from "../shared/dom.js";
import { clamp } from "../shared/format.js";
import { readJson, writeJson } from "../shared/storage.js";

const STORAGE_KEY = "debug.macros";
const MAX_SAVED = 50;
export const MACRO_VERSION = 1;

/**
 * @typedef {{ t: number, kind: "touch", touch: { x: number, y: number, down: boolean } }} MacroTouchEvent
 * @typedef {{ t: number, kind: "key", down: boolean }} MacroKeyEvent
 * @typedef {MacroTouchEvent|MacroKeyEvent} MacroEvent
 * @typedef {{ events: MacroEvent[], duration: number, count: number }} NormalizedMacro
 */

const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

/**
 * Sanitize recorded or imported macro data. Invalid events are dropped,
 * coordinates clamped to the 360 px screen and events sorted by time (equal
 * timestamps keep insertion order, preserving press/release pairs).
 * @param {unknown} input
 * @returns {NormalizedMacro}
 */
export function normalizeMacro(input) {
  const candidates = Array.isArray(input) ? input : Array.isArray(input?.events) ? input.events : [];
  const ordered = [];
  candidates.forEach((event, index) => {
    if (!event || typeof event !== "object") return;
    const time = Number(event.t);
    const t = Number.isFinite(time) ? Math.max(0, time) : 0;
    if (event.kind === "touch") {
      const touch = event.touch ?? event;
      const x = Number(touch.x);
      const y = Number(touch.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      ordered.push({
        index,
        event: {
          t,
          kind: "touch",
          touch: {
            x: clamp(Math.round(x), 0, 359),
            y: clamp(Math.round(y), 0, 359),
            down: Boolean(touch.down),
          },
        },
      });
    } else if (event.kind === "key") {
      ordered.push({ index, event: { t, kind: "key", down: Boolean(event.down) } });
    }
  });
  ordered.sort((a, b) => a.event.t - b.event.t || a.index - b.index);
  const events = ordered.map((item) => item.event);
  return { events, duration: events.length ? events[events.length - 1].t : 0, count: events.length };
}

/**
 * Turn a macro into playback steps with millisecond delays relative to the
 * start. `speed` 2 halves every delay; `from` skips events before that time.
 * @param {unknown} input
 * @param {{ from?: number, speed?: number }} [options]
 * @returns {{ delay: number, event: MacroEvent }[]}
 */
export function scheduleMacro(input, { from = 0, speed = 1 } = {}) {
  const { events } = normalizeMacro(input);
  const start = Number.isFinite(Number(from)) ? Math.max(0, Number(from)) : 0;
  const factor = Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : 1;
  return events
    .filter((event) => event.t >= start)
    .map((event) => ({ delay: Math.max(0, Math.round((event.t - start) / factor)), event }));
}

/**
 * @param {unknown} macro
 * @param {string} [name]
 * @returns {string} JSON document with version, name and normalized events
 */
export function macroToJson(macro, name = "") {
  const normalized = normalizeMacro(macro);
  return JSON.stringify({
    version: MACRO_VERSION,
    name: String(name ?? ""),
    savedAt: Date.now(),
    duration: normalized.duration,
    events: normalized.events,
  });
}

/**
 * @param {string|unknown} text
 * @returns {NormalizedMacro & { name: string, savedAt: number|null }}
 */
export function macroFromJson(text) {
  let data;
  try {
    data = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    throw new Error("宏 JSON 解析失败");
  }
  if (!data || (!Array.isArray(data) && !Array.isArray(data.events))) {
    throw new Error("宏数据缺少 events 数组");
  }
  const normalized = normalizeMacro(data);
  return {
    ...normalized,
    name: typeof data.name === "string" ? data.name : "",
    savedAt: Number.isFinite(Number(data.savedAt)) ? Number(data.savedAt) : null,
  };
}

function formatDuration(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

/**
 * Records touch and side-key events with relative timestamps, replays them on
 * their original schedule, and persists named macros in localStorage.
 */
export class MacroRecorder {
  /** @param {{ onPlay?: (event: MacroEvent) => void, onChange?: () => void }} [options] */
  constructor({ onPlay, onChange } = {}) {
    this.onPlay = onPlay;
    this.onChange = onChange;
    this.recording = false;
    this.playing = false;
    this.events = [];
    this.startedAt = 0;
    /** @type {NormalizedMacro|null} */
    this.macro = null;
    this.name = "";
    this.played = 0;
    this.playTimers = [];
    this.playResolve = null;
  }

  start() {
    if (this.recording) return true;
    this.stopPlay();
    this.recording = true;
    this.events = [];
    this.macro = null;
    this.name = "";
    this.startedAt = now();
    this.#notify();
    return true;
  }

  /**
   * Stop recording and publish the normalized macro.
   * @returns {NormalizedMacro|null}
   */
  stop() {
    if (!this.recording) return this.macro;
    this.recording = false;
    this.macro = normalizeMacro(this.events);
    this.events = [];
    this.#notify();
    return this.macro;
  }

  /** @param {{ x: number, y: number, down: boolean }} touch */
  recordTouch(touch) {
    if (!this.recording || !touch) return;
    this.events.push({
      t: Math.max(0, now() - this.startedAt),
      kind: "touch",
      touch: { x: touch.x, y: touch.y, down: Boolean(touch.down) },
    });
    this.#notify();
  }

  /** @param {boolean} down */
  recordKey(down) {
    if (!this.recording) return;
    this.events.push({ t: Math.max(0, now() - this.startedAt), kind: "key", down: Boolean(down) });
    this.#notify();
  }

  /**
   * Replay a macro (defaults to the last recorded/loaded one). Accepts either
   * `play(macro, { speed })` or `play({ speed })` for the current macro.
   * @param {unknown} [input]
   * @param {{ speed?: number }} [options]
   * @returns {Promise<{ played: number, stopped: boolean }>}
   */
  play(input = this.macro, options = {}) {
    let source = input;
    let speed = options?.speed ?? 1;
    if (source && typeof source === "object" && !Array.isArray(source) && !Array.isArray(source.events) && "speed" in source) {
      speed = source.speed ?? speed;
      source = this.macro;
    }
    if (this.recording) this.stop();
    const normalized = normalizeMacro(source ?? this.macro);
    if (!normalized.events.length) return Promise.resolve({ played: 0, stopped: false });
    this.stopPlay();
    const steps = scheduleMacro(normalized, { speed });
    this.playing = true;
    this.played = 0;
    this.#notify();
    return new Promise((resolve) => {
      this.playResolve = resolve;
      for (const step of steps) {
        this.playTimers.push(setTimeout(() => this.#step(step.event, steps.length), step.delay));
      }
    });
  }

  stopPlay() {
    if (!this.playing) return;
    this.#finishPlay(true);
  }

  /** @returns {{ name: string, savedAt: number, duration: number, count: number }[]} */
  list() {
    return this.#read()
      .map((record) => {
        const normalized = normalizeMacro(record);
        return {
          name: record.name,
          savedAt: Number(record.savedAt) || 0,
          duration: normalized.duration,
          count: normalized.count,
        };
      })
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  /** @param {string} name @returns {object|null} */
  save(name) {
    if (this.recording) return null;
    const source = this.macro;
    if (!source?.events.length) return null;
    const clean = (String(name ?? "").trim() || this.name || `宏 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`).slice(0, 64);
    const record = { name: clean, savedAt: Date.now(), duration: source.duration, events: source.events };
    const list = this.#read().filter((item) => item.name !== clean);
    list.unshift(record);
    writeJson(STORAGE_KEY, list.slice(0, MAX_SAVED));
    this.name = clean;
    this.#notify();
    return { name: clean, savedAt: record.savedAt, duration: record.duration, count: record.events.length };
  }

  /** @param {string} name @returns {(NormalizedMacro & { name: string, savedAt: number|null })|null} */
  load(name) {
    const record = this.#read().find((item) => item.name === name);
    if (!record) return null;
    this.macro = normalizeMacro(record);
    this.name = record.name;
    this.#notify();
    return { ...this.macro, name: record.name, savedAt: Number(record.savedAt) || null };
  }

  /** @param {string} name @returns {boolean} */
  remove(name) {
    const list = this.#read();
    const next = list.filter((item) => item.name !== name);
    if (next.length === list.length) return false;
    writeJson(STORAGE_KEY, next);
    return true;
  }

  /** @returns {string|null} */
  exportJson() {
    if (!this.macro?.events.length) return null;
    return macroToJson(this.macro, this.name);
  }

  /** @param {string} text @returns {NormalizedMacro & { name: string, savedAt: number|null }} */
  importJson(text) {
    const imported = macroFromJson(text);
    this.macro = { events: imported.events, duration: imported.duration, count: imported.count };
    this.name = imported.name;
    this.#notify();
    return imported;
  }

  /** @param {MacroEvent} event @param {number} total */
  #step(event, total) {
    if (!this.playing) return;
    try {
      this.onPlay?.(event);
    } catch (error) {
      console.error(error);
    }
    this.played++;
    if (this.played >= total) this.#finishPlay(false);
    else this.#notify();
  }

  #finishPlay(stopped) {
    if (!this.playing) return;
    this.playing = false;
    for (const timer of this.playTimers) clearTimeout(timer);
    this.playTimers = [];
    const resolve = this.playResolve;
    this.playResolve = null;
    this.#notify();
    resolve?.({ played: this.played, stopped });
  }

  #notify() {
    try {
      this.onChange?.();
    } catch (error) {
      console.error(error);
    }
  }

  #read() {
    const list = readJson(STORAGE_KEY, []);
    if (!Array.isArray(list)) return [];
    return list.filter((item) => item && typeof item.name === "string" && Array.isArray(item.events));
  }
}

/**
 * Macro UI: record/stop/play, save with a name, import/export JSON and the
 * list of persisted macros.
 */
export class MacroPanel {
  /** @param {{ mount?: HTMLElement, recorder?: MacroRecorder }} options */
  constructor({ mount, recorder } = {}) {
    this.recorder = recorder ?? new MacroRecorder();
    const previous = this.recorder.onChange;
    this.recorder.onChange = () => {
      previous?.();
      this.sync();
    };

    this.statusEl = el("span", { class: "macro-status" }, "空闲");
    this.recordButton = el("button", {
      class: "macro-btn macro-record",
      type: "button",
      onclick: () => this.#toggleRecord(),
    }, "录制");
    this.stopButton = el("button", {
      class: "macro-btn macro-stop",
      type: "button",
      onclick: () => this.#stop(),
    }, "停止");
    this.playButton = el("button", {
      class: "macro-btn macro-play",
      type: "button",
      onclick: () => this.#play(),
    }, "回放");
    this.nameInput = el("input", {
      class: "macro-name",
      type: "text",
      placeholder: "宏名称",
      maxlength: "64",
      autocomplete: "off",
    });
    this.saveButton = el("button", {
      class: "macro-btn macro-save",
      type: "button",
      onclick: () => this.#save(),
    }, "保存");
    this.exportButton = el("button", {
      class: "macro-btn macro-export",
      type: "button",
      onclick: () => this.#export(),
    }, "导出");
    const importInput = el("input", { class: "macro-file-input", type: "file", accept: ".json,application/json" });
    importInput.addEventListener("change", () => this.#import(importInput));
    this.listEl = el("ul", { class: "macro-list" });

    this.root = el("section", { class: "macro-panel", "aria-label": "输入宏" },
      el("header", { class: "macro-head" },
        el("h2", { class: "macro-heading" }, "输入宏"),
        this.statusEl),
      el("div", { class: "macro-toolbar" },
        this.recordButton, this.stopButton, this.playButton,
        this.nameInput, this.saveButton, this.exportButton,
        el("label", { class: "macro-btn macro-import" }, "导入", importInput)),
      el("p", { class: "macro-hint" }, "录制圆屏触摸与侧键，按录制时间间隔回放。"),
      this.listEl);

    mount?.append(this.root);
    this.renderList();
    this.sync();
  }

  sync() {
    const recorder = this.recorder;
    const hasMacro = Boolean(recorder.macro?.events.length);
    this.recordButton.disabled = recorder.recording || recorder.playing;
    this.stopButton.disabled = !recorder.recording && !recorder.playing;
    this.playButton.disabled = recorder.recording || recorder.playing || !hasMacro;
    this.saveButton.disabled = recorder.recording || recorder.playing || !hasMacro;
    this.exportButton.disabled = !hasMacro;
    this.nameInput.disabled = recorder.recording || recorder.playing || !hasMacro;
    this.root.classList.toggle("is-recording", recorder.recording);
    this.root.classList.toggle("is-playing", recorder.playing);
    if (recorder.recording) {
      this.statusEl.textContent = `录制中 · ${recorder.events.length} 事件`;
    } else if (recorder.playing) {
      this.statusEl.textContent = `回放中 · ${recorder.played}/${recorder.macro?.count ?? 0}`;
    } else if (hasMacro) {
      this.statusEl.textContent = `已载入 ${recorder.macro.count} 事件 · ${formatDuration(recorder.macro.duration)}`;
    } else {
      this.statusEl.textContent = "空闲";
    }
  }

  renderList() {
    clear(this.listEl);
    const macros = this.recorder.list();
    if (!macros.length) {
      this.listEl.append(el("li", { class: "macro-empty" }, "还没有保存的宏。"));
      return;
    }
    for (const macro of macros) {
      this.listEl.append(el("li", { class: "macro-item" },
        el("div", { class: "macro-item-main" },
          el("span", { class: "macro-item-name" }, macro.name),
          el("span", { class: "macro-item-detail" }, `${formatDuration(macro.duration)} · ${macro.count} 事件`)),
        el("div", { class: "macro-item-actions" },
          el("button", { class: "macro-btn", type: "button", onclick: () => this.#playSaved(macro.name) }, "回放"),
          el("button", { class: "macro-btn", type: "button", onclick: () => this.#load(macro.name) }, "载入"),
          el("button", {
            class: "macro-btn is-danger",
            type: "button",
            onclick: () => {
              this.recorder.remove(macro.name);
              this.renderList();
            },
          }, "删除"))));
    }
  }

  #toggleRecord() {
    if (this.recorder.recording) this.recorder.stop();
    else this.recorder.start();
    this.sync();
  }

  #stop() {
    if (this.recorder.recording) this.recorder.stop();
    else this.recorder.stopPlay();
    this.sync();
  }

  async #play() {
    const result = await this.recorder.play();
    this.sync();
    if (result.played) {
      this.statusEl.textContent = result.stopped
        ? `回放已停止（${result.played} 事件）`
        : `回放完成（${result.played} 事件）`;
    }
  }

  #playSaved(name) {
    if (this.recorder.load(name)) {
      this.nameInput.value = name;
      this.#play();
    }
  }

  #load(name) {
    if (this.recorder.load(name)) {
      this.nameInput.value = name;
      this.sync();
    }
  }

  #save() {
    const saved = this.recorder.save(this.nameInput.value);
    if (saved) {
      this.nameInput.value = saved.name;
      this.renderList();
      this.statusEl.textContent = `已保存「${saved.name}」`;
    } else {
      this.statusEl.textContent = "没有可保存的录制";
    }
  }

  #export() {
    const json = this.recorder.exportJson();
    if (!json) {
      this.statusEl.textContent = "没有可导出的宏";
      return;
    }
    const safe = (this.recorder.name || "macro").replace(/[^\w\u4e00-\u9fa5-]+/g, "_");
    download(new Blob([json], { type: "application/json;charset=utf-8" }), `${safe}.json`);
  }

  async #import(input) {
    const [file] = input.files ?? [];
    input.value = "";
    if (!file) return;
    try {
      const imported = this.recorder.importJson(await file.text());
      this.nameInput.value = imported.name;
      this.sync();
      this.statusEl.textContent = `已导入 ${imported.count} 事件`;
    } catch (error) {
      this.statusEl.textContent = `导入失败：${error?.message ?? error}`;
    }
  }
}
