import { clear, download, el } from "../shared/dom.js";
import { timestamp } from "../shared/format.js";

const MAX_LINES = 5000;
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

const FILTERS = [
  ["", "全部"],
  ["E", "错误"],
  ["W", "警告"],
  ["I", "信息"],
  ["D", "调试"],
];

/**
 * @typedef {{ time: string, level: "I"|"W"|"E"|"D", text: string, uptime?: number, cmd?: boolean, node?: HTMLElement }} ConsoleEntry
 */

/**
 * Classify one UART line. ESP-IDF writes `LEVEL (uptime) tag: message`;
 * bare lines (ROM output, backtraces) stay informational unless they clearly
 * announce a failure.
 * @param {string} text
 * @returns {{ level: "I"|"W"|"E"|"D", uptime?: number }}
 */
export function classifyLine(text) {
  const idf = /^\s*([IWEDV])\s*\((\d+)\)/.exec(text);
  if (idf) {
    return { level: /** @type {"I"|"W"|"E"|"D"} */ (idf[1] === "V" ? "D" : idf[1]), uptime: Number(idf[2]) };
  }
  if (/^(ERROR|FATAL|E)[:\s]/i.test(text) || /Guru Meditation|panic'ed|abort\(\)|assert failed/i.test(text)) {
    return { level: "E" };
  }
  if (/^(WARN|WARNING|W)[:\s]/i.test(text)) return { level: "W" };
  if (/^(DEBUG|VERBOSE|D|V)[:\s]/i.test(text)) return { level: "D" };
  return { level: "I" };
}

/**
 * Strip ANSI escapes and carriage returns without touching other text.
 * @param {string} text
 */
export function stripAnsi(text) {
  return String(text).replace(CSI, "").replace(/\r/g, "");
}

/**
 * UART console with level filters, search, pause, download and an input row.
 * `append` is safe to call from any thread wrapper; DOM work is main-thread only.
 */
export class DebugConsole {
  /** @param {{ mount?: HTMLElement, onSend?: (text: string) => void }} options */
  constructor({ mount, onSend } = {}) {
    this.onSend = onSend;
    /** @type {ConsoleEntry[]} */
    this.entries = [];
    this.query = "";
    this.level = "";
    this.paused = false;

    this.countEl = el("span", { class: "console-count" }, `0 / ${MAX_LINES}`);
    this.pauseButton = el("button", {
      class: "console-btn console-pause",
      type: "button",
      title: "暂停时不追加新日志",
      onclick: () => this.setPaused(!this.paused),
    }, "暂停");
    this.searchInput = el("input", {
      class: "console-search",
      type: "search",
      placeholder: "搜索日志",
      "aria-label": "搜索日志",
      autocomplete: "off",
      oninput: ({ target }) => this.search(target.value),
    });
    this.levelSelect = el("select", {
      class: "console-filter",
      "aria-label": "日志级别",
      onchange: ({ target }) => {
        this.level = target.value;
        this.#refresh();
      },
    }, FILTERS.map(([value, label]) => el("option", { value }, label)));

    this.linesEl = el("ol", { class: "console-lines", role: "log", "aria-live": "polite" });
    this.inputEl = el("input", {
      class: "console-input",
      type: "text",
      placeholder: "发送串口命令",
      "aria-label": "串口命令输入",
      autocomplete: "off",
      spellcheck: "false",
    });

    const toolbar = el("div", { class: "console-toolbar" },
      el("div", { class: "console-actions" },
        this.pauseButton,
        el("button", {
          class: "console-btn console-clear",
          type: "button",
          onclick: () => this.clear(),
        }, "清空"),
        el("button", {
          class: "console-btn console-download",
          type: "button",
          onclick: () => this.download(),
        }, "下载"),
      ),
      el("div", { class: "console-tools" }, this.searchInput, this.levelSelect, this.countEl),
    );

    const sendRow = el("form", {
      class: "console-input-row",
      onsubmit: (event) => {
        event.preventDefault();
        this.#send();
      },
    }, this.inputEl, el("button", { class: "console-send", type: "submit" }, "发送"));

    this.root = el("section", { class: "console-panel", "aria-label": "串口日志" },
      toolbar, this.linesEl, sendRow);
    mount?.append(this.root);
  }

  /**
   * Append UART text. Lines are split, ANSI escapes removed and the buffer is
   * capped at 5000 lines. While paused, lines are buffered but not rendered.
   * @param {string} text
   * @returns {number} number of accepted lines
   */
  append(text) {
    if (text === null || text === undefined) return 0;
    let added = 0;
    for (const line of stripAnsi(text).split("\n")) {
      if (!line.trim()) continue;
      this.#push(line);
      added++;
    }
    return added;
  }

  clear() {
    this.entries = [];
    clear(this.linesEl);
    this.#updateCount();
  }

  /** @param {boolean} paused */
  setPaused(paused) {
    this.paused = Boolean(paused);
    this.pauseButton.textContent = this.paused ? "继续" : "暂停";
    this.pauseButton.classList.toggle("is-active", this.paused);
    this.root.classList.toggle("is-paused", this.paused);
    if (!this.paused) this.#renderAll();
    return this.paused;
  }

  /**
   * Download the raw log (original firmware text, without UI timestamps).
   * @returns {number} exported line count
   */
  download() {
    const body = this.entries.map((entry) => entry.text).join("\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    download(new Blob([body], { type: "text/plain;charset=utf-8" }), `uart-${stamp}.log`);
    return this.entries.length;
  }

  /**
   * Filter visible lines. Matches text case-insensitively.
   * @param {string} query
   * @returns {number} matching line count
   */
  search(query) {
    this.query = String(query ?? "").trim().toLowerCase();
    this.#refresh();
    return this.#visibleCount();
  }

  #push(text, extra = {}) {
    const { level, uptime } = classifyLine(text);
    /** @type {ConsoleEntry} */
    const entry = { time: timestamp(), level, text, uptime, ...extra };
    this.entries.push(entry);
    while (this.entries.length > MAX_LINES) {
      this.entries.shift()?.node?.remove();
    }
    if (!this.paused && this.#matches(entry)) {
      entry.node = this.#renderLine(entry);
      this.linesEl.append(entry.node);
      this.#scrollToBottom();
    }
    this.#updateCount();
  }

  #send() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    this.#push(`> ${text}`, { cmd: true });
    try {
      this.onSend?.(text);
    } catch (error) {
      this.#push(`发送失败：${error?.message ?? error}`);
    }
    this.inputEl.focus();
  }

  #matches(entry) {
    if (this.level && entry.level !== this.level) return false;
    if (!this.query) return true;
    return entry.text.toLowerCase().includes(this.query);
  }

  #visibleCount() {
    if (!this.level && !this.query) return this.entries.length;
    return this.entries.filter((entry) => this.#matches(entry)).length;
  }

  #refresh() {
    this.#renderAll();
    this.#scrollToBottom();
  }

  #renderAll() {
    const fragment = document.createDocumentFragment();
    for (const entry of this.entries) {
      entry.node = undefined;
      if (this.#matches(entry)) {
        entry.node = this.#renderLine(entry);
        fragment.append(entry.node);
      }
    }
    clear(this.linesEl);
    this.linesEl.append(fragment);
    this.#updateCount();
  }

  /** @param {ConsoleEntry} entry */
  #renderLine(entry) {
    const levelClass = `console-line-${entry.level.toLowerCase()}`;
    const text = el("span", { class: "console-text" });
    if (this.query) {
      let from = 0;
      const lower = entry.text.toLowerCase();
      while (from <= entry.text.length) {
        const at = lower.indexOf(this.query, from);
        if (at < 0) {
          text.append(entry.text.slice(from));
          break;
        }
        if (at > from) text.append(entry.text.slice(from, at));
        text.append(el("mark", { class: "console-hit" }, entry.text.slice(at, at + this.query.length)));
        from = at + this.query.length;
      }
    } else {
      text.textContent = entry.text;
    }
    const time = el("span", {
      class: "console-time",
      title: entry.uptime === undefined ? "" : `${entry.uptime} ms`,
    }, entry.time);
    return el("li", {
      class: `console-line ${levelClass}${entry.cmd ? " console-line-cmd" : ""}`,
    }, time, el("span", { class: "console-tag" }, entry.level), text);
  }

  #updateCount() {
    const visible = this.#visibleCount();
    this.countEl.textContent = visible === this.entries.length
      ? `${this.entries.length} / ${MAX_LINES}`
      : `${visible} / ${this.entries.length}`;
  }

  #scrollToBottom() {
    if (this.paused) return;
    this.linesEl.scrollTop = this.linesEl.scrollHeight;
  }
}
