import { el } from "../shared/dom.js";
import { formatBytes, formatHex } from "../shared/format.js";

/**
 * @typedef {Object} InspectorCallbacks
 * @property {() => void} [onFlash] Export the current virtual flash.
 * @property {() => void} [onClearFlash] Erase the current virtual flash.
 * @property {(bytes: ArrayBuffer) => void} [onImportFlash] Import a full flash image.
 * @property {(bytes: ArrayBuffer) => void} [onElf] Load an ELF for symbolization.
 * @property {() => void} [onRegisters] Request a register snapshot.
 * @property {(addr: number, len: number) => void} [onMemory] Read emulated memory.
 * @property {() => void} [onGpio] Request a GPIO snapshot.
 */

// ESP-EMU returns hart 0 as a0..a15 followed by these special registers.
const POSITIONAL_REGISTERS = [
  ...Array.from({ length: 16 }, (_, index) => `a${index}`),
  "PS", "SAR", "WINDOWBASE", "WINDOWSTART", "EXCCAUSE", "EXCVADDR", "EPC1", "LBEG", "LEND", "LCOUNT",
];
const REGISTER_ORDER = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11", "a12", "a13", "a14", "a15",
  "PC", "PS", "SAR", "WINDOWBASE", "WINDOWSTART", "EXCCAUSE", "EXCVADDR", "EPC1", "LBEG", "LEND", "LCOUNT"];

const KNOWN_PINS = new Map([
  [3, "功放使能"],
  [6, "侧键"],
  [10, "触摸 SCL"],
  [11, "触摸 SDA"],
  [17, "麦克风 DIN"],
  [21, "LCD CS"],
  [38, "I2S WS"],
  [47, "扬声器 DOUT"],
  [48, "I2S BCLK"],
]);

const MEMORY_LENGTHS = [16, 32, 64, 128, 256, 512, 1024, 4096];
const MODE_LABELS = { wasm: "浏览器 WASM", native: "本机加速" };

function emptyState(text) {
  return el("p", { class: "inspector-empty" }, text);
}

/** @param {number} value */
function hexAddress(value) {
  return `0x${formatHex(Number(value) >>> 0, 8)}`;
}

/** @param {unknown} value */
function formatRegister(value) {
  if (typeof value === "number") return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
  if (typeof value === "bigint") return `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
  return String(value);
}

/** @param {any} data @returns {{ name: string, value: number|string|bigint }[]} */
function normalizeRegisters(data) {
  if (!data) return [];
  const source = data.registers ?? data.regs ?? data.data ?? data;
  if (Array.isArray(source) || ArrayBuffer.isView(source)) {
    return [...source].map((value, index) => ({
      name: POSITIONAL_REGISTERS[index] ?? `r${index}`,
      value,
    }));
  }
  if (typeof source !== "object") return [];
  const rank = (name) => {
    const index = REGISTER_ORDER.indexOf(String(name).toUpperCase());
    return index < 0 ? REGISTER_ORDER.length : index;
  };
  return Object.entries(source)
    .filter(([, value]) => typeof value === "number" || typeof value === "bigint" || typeof value === "string")
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** @param {Uint8Array|ArrayBuffer|ArrayBufferView|number[]|string|null|undefined} bytes */
function toBytes(bytes) {
  if (!bytes) return new Uint8Array(0);
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Array.isArray(bytes)) return Uint8Array.from(bytes.map((value) => Number(value) & 0xff));
  if (typeof bytes === "string") {
    try {
      return Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0));
    } catch {
      return new Uint8Array(0);
    }
  }
  return new Uint8Array(0);
}

/** @param {number} addr @param {Uint8Array} bytes */
function hexdump(addr, bytes) {
  if (!bytes.length) return "（无数据）";
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.subarray(offset, offset + 16);
    const hex = Array.from(chunk, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = Array.from(chunk, (byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".")).join("");
    lines.push(`${(addr + offset).toString(16).toUpperCase().padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return lines.join("\n");
}

/** @param {unknown} type */
function partitionTypeName(type) {
  if (type === 0 || type === "app" || type === "0x00") return "app";
  if (type === 1 || type === "data" || type === "0x01") return "data";
  if (typeof type === "number") return `0x${type.toString(16).toUpperCase().padStart(2, "0")}`;
  return type === undefined || type === null || type === "" ? "—" : String(type);
}

/** @param {unknown} subtype */
function partitionSubtypeName(subtype) {
  if (subtype === undefined || subtype === null || subtype === "") return "";
  if (typeof subtype === "number") return `0x${subtype.toString(16).toUpperCase().padStart(2, "0")}`;
  return String(subtype);
}

/**
 * @param {number[]} quad `[out_lo, out_hi, enable_lo, enable_hi]`
 * @returns {{ pin: number, level: boolean, enable: boolean }[]}
 */
function decodeGpioQuad(quad) {
  const [outLo = 0, outHi = 0, enableLo = 0, enableHi = 0] = quad;
  const bit = (lo, hi, pin) => ((pin < 32 ? lo >>> pin : hi >>> (pin - 32)) & 1) === 1;
  const pins = new Set(KNOWN_PINS.keys());
  for (let pin = 0; pin < 64; pin++) {
    if (bit(outLo, outHi, pin) || bit(enableLo, enableHi, pin)) pins.add(pin);
  }
  return [...pins].sort((a, b) => a - b).map((pin) => {
    const enable = bit(enableLo, enableHi, pin);
    return {
      pin,
      enable,
      level: enable ? bit(outLo, outHi, pin) : undefined,
    };
  });
}

/** @param {any} data @returns {{ pin: number, level: boolean|undefined, enable: boolean }[]} */
function normalizeGpio(data) {
  if (!data) return [];
  if (Array.isArray(data) || ArrayBuffer.isView(data)) {
    const values = [...data];
    if (values.length === 4 && values.every((value) => typeof value === "number")) {
      return decodeGpioQuad(values);
    }
    if (values.every((value) => typeof value === "number" || typeof value === "boolean")) {
      return values.map((value, pin) => ({ pin, level: Boolean(value), enable: true }));
    }
    return values
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const pin = Number(item.pin ?? item.gpio);
        if (!Number.isInteger(pin)) return null;
        const level = item.level ?? item.value ?? item.out;
        return { pin, level: level === undefined ? undefined : Boolean(level), enable: item.enable !== false };
      })
      .filter(Boolean);
  }
  if (typeof data !== "object") return [];
  if (Array.isArray(data.inputs) || Array.isArray(data.outputs)) {
    const entries = [];
    const collect = (items, enable) => {
      for (const item of items ?? []) {
        const pin = typeof item === "object" ? Number(item?.pin ?? item?.gpio) : Number(item);
        if (!Number.isInteger(pin)) continue;
        const level = typeof item === "object" ? item.level ?? item.value : undefined;
        entries.push({ pin, level: level === undefined ? undefined : Boolean(level), enable });
      }
    };
    collect(data.inputs, false);
    collect(data.outputs, true);
    return entries.sort((a, b) => a.pin - b.pin);
  }
  const source = data.pins ?? data.states ?? data.data ?? data;
  if (Array.isArray(source) || ArrayBuffer.isView(source)) return normalizeGpio(source);
  return Object.entries(source)
    .map(([key, value]) => {
      const pin = Number(String(key).replace(/^gpio/i, ""));
      if (!Number.isInteger(pin)) return null;
      if (value && typeof value === "object") {
        const level = value.level ?? value.value ?? value.out;
        return {
          pin,
          level: level === undefined ? undefined : Boolean(level),
          enable: value.enable ?? (value.direction ? value.direction === "out" || value.direction === "output" : true),
        };
      }
      return { pin, level: Boolean(value), enable: true };
    })
    .filter(Boolean)
    .sort((a, b) => a.pin - b.pin);
}

/**
 * Device inspector: firmware, partitions, registers, GPIO, memory, flash and
 * ELF. Registers and memory are unavailable in native mode (no bus access
 * outside the WASM build), so call `setMode("native")` to gate those sections.
 */
export class Inspector {
  /** @param {{ mount?: HTMLElement, callbacks?: InspectorCallbacks }} options */
  constructor({ mount, callbacks = {} } = {}) {
    this.callbacks = callbacks;
    this.mode = "";
    this.modeEl = el("span", { class: "inspector-mode" }, "—");

    this.firmwareValues = new Map();
    const firmwareList = el("div", { class: "inspector-kv" });
    for (const [key, label] of [["name", "名称"], ["project", "工程"], ["version", "版本"], ["idf", "IDF"], ["size", "大小"]]) {
      const value = el("span", { class: "inspector-kv-value" }, "—");
      this.firmwareValues.set(key, value);
      firmwareList.append(el("div", { class: "inspector-kv-row" },
        el("span", { class: "inspector-kv-key" }, label), value));
    }

    this.partitionBody = el("tbody");
    const partitionTable = el("div", { class: "inspector-table-wrap" },
      el("table", { class: "inspector-table" },
        el("thead", {}, el("tr", {},
          el("th", {}, "名称"), el("th", {}, "类型"), el("th", {}, "偏移"), el("th", {}, "大小"))),
        this.partitionBody));
    this.#renderPartitions([]);

    const registers = this.#section("寄存器", "本机模式暂不支持寄存器读取，请切换到浏览器 WASM 模式。");
    this.registersSection = registers;
    this.registersEl = el("div", { class: "inspector-registers" }, emptyState("尚未读取，点击「读取」获取 Xtensa 寄存器。"));
    registers.body.append(this.registersEl);
    const readRegisters = el("button", { class: "inspector-btn", type: "button", onclick: () => this.callbacks.onRegisters?.() }, "读取");
    registers.actionsEl.append(readRegisters);

    const gpio = this.#section("GPIO");
    this.gpioEl = el("div", { class: "inspector-gpio" }, emptyState("尚未读取，点击「刷新」获取 GPIO 输出状态。"));
    this.gpioHint = el("p", { class: "inspector-hint", hidden: "" },
      "输出电平来自 GPIO 输出寄存器；纯输入引脚的实际电平不可读。");
    gpio.body.append(this.gpioEl, this.gpioHint);
    gpio.actionsEl.append(el("button", { class: "inspector-btn", type: "button", onclick: () => this.callbacks.onGpio?.() }, "刷新"));

    const memory = this.#section("内存", "本机模式暂不支持内存读取，请切换到浏览器 WASM 模式。");
    this.memorySection = memory;
    this.addrInput = el("input", {
      class: "inspector-input inspector-addr",
      type: "text",
      value: "0x3FC88000",
      spellcheck: "false",
      "aria-label": "内存地址（十六进制）",
    });
    this.lengthSelect = el("select", { class: "inspector-input inspector-length", "aria-label": "读取长度" },
      MEMORY_LENGTHS.map((length) => el("option", { value: String(length), selected: length === 64 ? "" : null }, `${length} B`)));
    this.hexdumpEl = el("pre", { class: "inspector-hexdump" }, "尚未读取内存。");
    this.memoryHint = el("p", { class: "inspector-hint" }, "地址为十六进制；单次最多读取 4096 字节。");
    const memoryForm = el("div", { class: "inspector-memory-form" },
      this.addrInput, this.lengthSelect,
      el("button", { class: "inspector-btn", type: "button", onclick: () => this.#requestMemory() }, "读取"));
    memory.body.append(memoryForm, this.memoryHint, this.hexdumpEl);

    const flash = this.#section("Flash");
    this.flashHint = el("p", { class: "inspector-hint" }, "导出为完整 Flash 镜像；导入与清除会覆盖当前虚拟 Flash。");
    const exportButton = el("button", { class: "inspector-btn", type: "button", onclick: () => this.callbacks.onFlash?.() }, "导出 Flash");
    exportButton.disabled = typeof callbacks.onFlash !== "function";
    const importInput = el("input", { class: "inspector-file-input", type: "file", accept: ".bin,application/octet-stream" });
    importInput.addEventListener("change", async () => {
      const [file] = importInput.files ?? [];
      importInput.value = "";
      if (!file) return;
      try {
        const buffer = await file.arrayBuffer();
        if (buffer.byteLength > 32 * 1024 * 1024) throw new Error("Flash 镜像超过 32 MiB");
        this.callbacks.onImportFlash?.(buffer);
        this.#hint(this.flashHint, `已导入 ${file.name}`);
      } catch (error) {
        this.#hint(this.flashHint, `导入失败：${error?.message ?? error}`, true);
      }
    });
    const importLabel = el("label", { class: "inspector-btn inspector-file" }, "导入 Flash", importInput);
    const clearButton = el("button", { class: "inspector-btn is-danger", type: "button", onclick: () => this.callbacks.onClearFlash?.() }, "清除 Flash");
    clearButton.disabled = typeof callbacks.onClearFlash !== "function";
    flash.body.append(el("div", { class: "inspector-actions-inline" }, exportButton, importLabel, clearButton), this.flashHint);

    const elf = this.#section("ELF 符号");
    this.elfStatus = el("span", { class: "inspector-elf-status" }, "未选择 ELF");
    const elfInput = el("input", { class: "inspector-file-input", type: "file", accept: ".elf" });
    elfInput.addEventListener("change", async () => {
      const [file] = elfInput.files ?? [];
      elfInput.value = "";
      if (!file) return;
      try {
        const buffer = await file.arrayBuffer();
        if (buffer.byteLength > 32 * 1024 * 1024) throw new Error("ELF 超过 32 MiB");
        this.callbacks.onElf?.(buffer);
        this.elfStatus.textContent = `已选择 ${file.name}`;
        this.elfStatus.classList.remove("is-error");
      } catch (error) {
        this.elfStatus.textContent = `载入失败：${error?.message ?? error}`;
        this.elfStatus.classList.add("is-error");
      }
    });
    elf.body.append(
      el("div", { class: "inspector-actions-inline" },
        el("label", { class: "inspector-btn inspector-file" }, "选择 ELF", elfInput), this.elfStatus),
      el("p", { class: "inspector-hint" }, "载入后崩溃回溯会附带函数名与行号；本机模式下的 ELF 在重新载入固件后生效。"));

    this.faultPre = el("pre", { class: "inspector-fault" }, "");
    this.faultSection = el("section", { class: "inspector-section inspector-fault-section", hidden: "" },
      el("header", { class: "inspector-section-head" },
        el("h3", { class: "inspector-title" }, "崩溃报告"),
        el("div", { class: "inspector-actions" },
          el("button", { class: "inspector-btn", type: "button", onclick: () => this.#copyFault() }, "复制"),
          el("button", { class: "inspector-btn", type: "button", onclick: () => this.clearFault() }, "清除"))),
      el("div", { class: "inspector-body" }, this.faultPre));

    this.root = el("section", { class: "inspector-panel", "aria-label": "设备检查器" },
      el("header", { class: "inspector-head" },
        el("h2", { class: "inspector-heading" }, "设备检查器"), this.modeEl),
      el("section", { class: "inspector-section" },
        el("header", { class: "inspector-section-head" }, el("h3", { class: "inspector-title" }, "固件信息")),
        el("div", { class: "inspector-body" }, firmwareList)),
      el("section", { class: "inspector-section" },
        el("header", { class: "inspector-section-head" }, el("h3", { class: "inspector-title" }, "分区表")),
        el("div", { class: "inspector-body" }, partitionTable)),
      registers.section,
      gpio.section,
      memory.section,
      flash.section,
      elf.section,
      this.faultSection);

    mount?.append(this.root);
  }

  /**
   * @param {string} title
   * @param {string} [unsupportedMessage]
   */
  #section(title, unsupportedMessage = "本机模式暂不支持该调试项。") {
    const body = el("div", { class: "inspector-body" });
    const actionsEl = el("div", { class: "inspector-actions" });
    const note = el("p", { class: "inspector-note", hidden: "" }, unsupportedMessage);
    const section = el("section", { class: "inspector-section" },
      el("header", { class: "inspector-section-head" }, el("h3", { class: "inspector-title" }, title), actionsEl),
      body, note);
    return { section, body, actionsEl, note };
  }

  /** @param {Record<string, unknown>|null|undefined} payload */
  setFirmware(payload) {
    if (!payload) return;
    const info = payload.info && typeof payload.info === "object" ? payload.info : payload;
    const nested = [
      info.firmware?.app,
      info.app,
      payload.app,
      payload.firmware?.app,
      info.firmware,
      payload.firmware,
    ].find((value) => value && typeof value === "object") ?? {};
    const pick = (keys) => {
      for (const key of keys) {
        const value = info[key] ?? nested[key];
        if (value !== undefined && value !== null && value !== "") return value;
      }
      return undefined;
    };
    const values = {
      name: pick(["name", "file"]),
      project: pick(["project"]),
      version: pick(["version"]),
      idf: pick(["idf"]),
      size: pick(["size"]),
    };
    for (const [key, value] of Object.entries(values)) {
      const target = this.firmwareValues.get(key);
      if (!target) continue;
      target.textContent = value === undefined
        ? "—"
        : key === "size" ? formatBytes(Number(value)) : String(value);
    }
    const mode = pick(["mode"]);
    if (mode) this.setMode(String(mode));
  }

  /** @param {{ label?: string, name?: string, type?: unknown, subtype?: unknown, offset?: number, size?: number }[]|null|undefined} partitions */
  setPartitions(partitions) {
    const list = Array.isArray(partitions) ? partitions : Array.isArray(partitions?.partitions) ? partitions.partitions : [];
    this.#renderPartitions(list);
  }

  /** @param {Iterable<number>|Record<string, number>|{ registers?: unknown, regs?: unknown }|null|undefined} data */
  setRegisters(data) {
    const registers = normalizeRegisters(data);
    this.registersEl.replaceChildren();
    if (!registers.length) {
      this.registersEl.append(emptyState("没有可用的寄存器数据。"));
      return;
    }
    for (const register of registers) {
      this.registersEl.append(el("div", { class: "inspector-reg" },
        el("span", { class: "inspector-reg-name" }, register.name),
        el("span", {
          class: "inspector-reg-value",
          title: typeof register.value === "number" ? String(register.value >>> 0) : "",
        }, formatRegister(register.value))));
    }
  }

  /** @param {{ pin: number, level?: boolean, enable?: boolean }[]|Uint32Array|Record<string, unknown>|null|undefined} data */
  setGpio(data) {
    const pins = normalizeGpio(data);
    this.gpioEl.replaceChildren();
    if (!pins.length) {
      this.gpioEl.append(emptyState("没有可用的 GPIO 状态。"));
      this.gpioHint.hidden = true;
      return;
    }
    for (const pin of pins) {
      const known = KNOWN_PINS.get(pin.pin);
      const dotClass = pin.level === undefined ? "is-input" : pin.level ? "is-high" : "is-low";
      const isInput = !pin.enable;
      const stateText = pin.level === undefined
        ? "输入"
        : `${pin.level ? "高" : "低"} · ${isInput ? "输入" : "输出"}`;
      this.gpioEl.append(el("div", { class: "inspector-pin", title: `GPIO${pin.pin}` },
        el("span", { class: `inspector-pin-dot ${dotClass}` }),
        el("span", { class: "inspector-pin-name" }, known ? `GPIO${pin.pin} ${known}` : `GPIO${pin.pin}`),
        el("span", { class: "inspector-pin-value" }, stateText)));
    }
    this.gpioHint.hidden = false;
  }

  /** @param {{ addr: number, bytes: Uint8Array|ArrayBuffer|string|number[]|null|undefined }} data */
  setMemory(data) {
    if (!data) return;
    const payload = data.data && typeof data.data === "object" && !("addr" in data) ? data.data : data;
    const addr = Number(payload.addr) >>> 0;
    const bytes = toBytes(payload.bytes);
    this.addrInput.value = hexAddress(addr);
    this.hexdumpEl.textContent = hexdump(addr, bytes);
    this.#hint(this.memoryHint, `已读取 ${bytes.length} 字节 @ ${hexAddress(addr)}`);
  }

  /** @param {string|{ report?: string }|null|undefined} report */
  setFault(report) {
    const text = report && typeof report === "object" ? report.report : report;
    this.faultPre.textContent = text ? String(text) : "固件发生异常。";
    this.faultSection.hidden = false;
  }

  clearFault() {
    this.faultPre.textContent = "";
    this.faultSection.hidden = true;
  }

  /**
   * "native" disables register and memory sections; "wasm" re-enables them.
   * @param {"wasm"|"native"|string} mode
   */
  setMode(mode) {
    this.mode = mode ?? "";
    this.modeEl.textContent = MODE_LABELS[this.mode] ?? (this.mode || "—");
    const supported = this.mode !== "native";
    this.#setSupported(this.registersSection, supported);
    this.#setSupported(this.memorySection, supported);
  }

  /** @param {{ section: HTMLElement, note: HTMLElement }} parts @param {boolean} supported */
  #setSupported(parts, supported) {
    parts.section.classList.toggle("is-unsupported", !supported);
    parts.note.hidden = supported;
    for (const control of parts.section.querySelectorAll("button, input, select")) {
      control.disabled = !supported;
    }
  }

  #requestMemory() {
    const raw = this.addrInput.value.trim().replace(/^0x/i, "").replace(/_/g, "");
    if (!/^[0-9a-f]+$/i.test(raw)) {
      this.#hint(this.memoryHint, "地址无效：请输入十六进制地址，例如 0x3FC88000。", true);
      this.addrInput.focus();
      return;
    }
    const addr = parseInt(raw, 16);
    if (!Number.isInteger(addr) || addr < 0 || addr > 0xffffffff) {
      this.#hint(this.memoryHint, "地址超出 32 位范围。", true);
      this.addrInput.focus();
      return;
    }
    const length = Number(this.lengthSelect.value) || 64;
    this.#hint(this.memoryHint, `正在读取 ${length} 字节…`);
    this.callbacks.onMemory?.(addr, length);
  }

  /** @param {unknown[]} partitions */
  #renderPartitions(partitions) {
    this.partitionBody.replaceChildren();
    if (!partitions.length) {
      this.partitionBody.append(el("tr", { class: "inspector-empty-row" },
        el("td", { colspan: "4" }, "暂无分区数据")));
      return;
    }
    for (const partition of partitions) {
      const offset = partition.offset ?? partition.addr ?? partition.start;
      const size = partition.size ?? partition.length;
      const type = partitionTypeName(partition.type);
      const subtype = partitionSubtypeName(partition.subtype);
      this.partitionBody.append(el("tr", {},
        el("td", {}, String(partition.label ?? partition.name ?? "—")),
        el("td", {}, subtype ? `${type} · ${subtype}` : type),
        el("td", { class: "inspector-num", title: typeof offset === "number" ? `0x${formatHex(offset, 8)}` : "" },
          typeof offset === "number" ? `0x${formatHex(offset, 6)}` : offset === undefined ? "—" : String(offset)),
        el("td", { class: "inspector-num", title: typeof size === "number" ? `0x${formatHex(size, 8)}` : "" },
          typeof size === "number" ? formatBytes(size) : size === undefined ? "—" : String(size))));
    }
  }

  /** @param {HTMLElement} hint @param {string} message @param {boolean} [error] */
  #hint(hint, message, error = false) {
    hint.textContent = message;
    hint.classList.toggle("is-error", error);
  }

  async #copyFault() {
    const text = this.faultPre.textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.faultSection.classList.add("is-copied");
      setTimeout(() => this.faultSection.classList.remove("is-copied"), 1200);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(this.faultPre);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }
}
