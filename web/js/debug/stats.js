import { el } from "../shared/dom.js";

const TRANSPORTS = {
  wasm: "浏览器 WASM",
  ws: "本机 WebSocket",
  native: "本机加速",
};

const METRICS = [
  { key: "fps", label: "FPS", aliases: ["fps"], format: (value) => `${fixed(value, 1)}` },
  { key: "frameMs", label: "帧耗时", aliases: ["frameMs", "frameTime", "drawMs"], format: (value) => `${fixed(value, 1)} ms` },
  { key: "mips", label: "模拟 MIPS", aliases: ["mips"], format: (value) => fixed(value, 1) },
  { key: "realTime", label: "实时倍率", aliases: ["realTime", "realtime"], format: (value) => `${fixed(value, 2)}×` },
  { key: "frames", label: "帧数", aliases: ["frames", "frame"], format: integer },
  { key: "transport", label: "传输", aliases: ["transport"], format: (value) => TRANSPORTS[value] ?? String(value) },
  { key: "dropped", label: "丢帧", aliases: ["dropped", "droppedFrames"], format: integer },
  { key: "audioQueue", label: "音频队列", aliases: ["audioQueue", "queueMs", "bufferMs", "audio.queue"], format: (value) => `${integer(value)} ms`, optional: true },
  { key: "audioUnderruns", label: "音频欠载", aliases: ["audioUnderruns", "underruns", "underrun", "audio.underruns"], format: integer, optional: true },
];

const FLASH_MS = 650;

function fixed(value, digits) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "—";
}

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.round(number)) : "—";
}

/** @param {Record<string, unknown>} source @param {string} path */
function lookup(source, path) {
  let value = source;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

/** @param {Record<string, unknown>} stats @param {string[]} aliases */
function resolve(stats, aliases) {
  for (const alias of aliases) {
    const value = lookup(stats, alias);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Compact performance readout. Unknown fields render as "—"; audio cards stay
 * hidden until the first update that carries audio values.
 */
export class StatsPanel {
  /** @param {{ mount?: HTMLElement }} options */
  constructor({ mount } = {}) {
    this.last = new Map();
    this.updated = false;
    /** @type {Map<string, { root: HTMLElement, valueEl: HTMLElement, timer: number }>} */
    this.cards = new Map();

    this.grid = el("div", { class: "stats-grid" });
    for (const metric of METRICS) {
      const valueEl = el("span", { class: "stats-value" }, "—");
      const root = el("div", {
        class: "stats-card",
        dataset: { metric: metric.key },
        hidden: metric.optional ? "" : null,
      }, el("span", { class: "stats-label" }, metric.label), valueEl);
      this.cards.set(metric.key, { root, valueEl, timer: 0 });
      this.grid.append(root);
    }

    this.root = el("section", { class: "stats-panel", "aria-label": "性能统计" },
      el("header", { class: "stats-head" }, el("h2", { class: "stats-heading" }, "性能统计")),
      this.grid);
    mount?.append(this.root);
  }

  /**
   * Merge one stats snapshot. Values come from runtime stats and may include
   * renderer (frameMs, dropped) or audio (audioQueue, audioUnderruns) extras.
   * @param {Record<string, unknown>} stats
   */
  update(stats) {
    if (!stats || typeof stats !== "object") return;
    const source = stats.stats && typeof stats.stats === "object" ? stats.stats : stats;
    for (const metric of METRICS) {
      const value = resolve(source, metric.aliases);
      const card = this.cards.get(metric.key);
      if (!card) continue;
      if (value === undefined) {
        if (!metric.optional || !card.root.hidden) card.valueEl.textContent = "—";
        this.last.delete(metric.key);
        continue;
      }
      if (metric.optional) card.root.hidden = false;
      const text = metric.format(value);
      if (card.valueEl.textContent !== text) card.valueEl.textContent = text;
      if (this.updated && !Object.is(this.last.get(metric.key), value)) this.#flash(card);
      this.last.set(metric.key, value);
    }
    this.updated = true;
  }

  /** @param {{ root: HTMLElement, timer: number }} card */
  #flash(card) {
    card.root.classList.remove("is-flash");
    // Force a reflow so repeated changes restart the CSS animation.
    void card.root.offsetWidth;
    card.root.classList.add("is-flash");
    clearTimeout(card.timer);
    card.timer = setTimeout(() => card.root.classList.remove("is-flash"), FLASH_MS);
  }
}
