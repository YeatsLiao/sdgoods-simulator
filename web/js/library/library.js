import { formatBytes } from "../shared/format.js";
import { readJson, writeJson } from "../shared/storage.js";
import { toBootImage } from "../flash/app-package.js";
import { deleteFirmware, getFirmware, putFirmware } from "./cache.js";

export const MIN_FIRMWARE_SIZE = 64 * 1024;
export const MAX_FIRMWARE_SIZE = 32 * 1024 * 1024;

const STORAGE_KEY = "library.entries";
const SAMPLE_ID = "sample";
const SAMPLE_NAME = "Chiikawa GO 示例";
const SAMPLE_SOURCE = "/demo.bin";
const STATUS_URL = "/api/status";
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const ENTRY_KINDS = new Set(["sample", "file", "url", "market"]);

let firmwareHelpersPromise = null;

/** Kept lazy so the library module is importable before the parser module lands. */
function loadFirmwareHelpers() {
  firmwareHelpersPromise ??= import("../device/firmware.js").catch((error) => {
    firmwareHelpersPromise = null;
    const reason = error?.message ?? String(error);
    throw new Error(`固件解析模块不可用（web/js/device/firmware.js）：${reason}`);
  });
  return firmwareHelpersPromise;
}

function dataView(bytes) {
  if (bytes instanceof DataView) return bytes;
  if (bytes instanceof ArrayBuffer) return new DataView(bytes);
  if (ArrayBuffer.isView(bytes)) return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return null;
}

/**
 * Structural ESP32-S3 image check. The simulator only needs the image header;
 * an app descriptor or partition table is reported later by describeFirmware.
 * @param {ArrayBuffer|ArrayBufferView} bytes
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateFirmwareImage(bytes) {
  const view = dataView(bytes);
  if (!view) return { ok: false, error: "固件数据格式无效，需要二进制文件" };
  const length = view.byteLength;
  if (length < MIN_FIRMWARE_SIZE) {
    return {
      ok: false,
      error: `固件仅 ${formatBytes(length)}，至少需要 64 KiB。请选择合并后的整机镜像。`,
    };
  }
  if (length > MAX_FIRMWARE_SIZE) {
    return { ok: false, error: "固件超过 32 MiB，模拟器无法载入" };
  }
  if (view.getUint8(0) !== 0xe9) {
    return {
      ok: false,
      error: "不是 ESP32-S3 固件：缺少 0xE9 镜像头。请选择从 0x0 开始的整机 BIN。",
    };
  }
  const chipId = view.getUint16(12, true);
  if (chipId !== 9) {
    return { ok: false, error: `芯片型号不是 ESP32-S3（镜像头芯片 ID 为 ${chipId}）` };
  }
  return { ok: true };
}

/**
 * @param {string} value
 * @returns {string} Normalized absolute http(s) URL.
 */
export function normalizeUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("请先填写固件链接");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("链接格式无效，需要完整的 http(s) 地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只支持 http(s) 链接");
  }
  return url.href;
}

/** @param {string} value */
export function firmwareNameFromUrl(value) {
  try {
    const url = new URL(normalizeUrl(value));
    const last = url.pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
    return url.hostname || "外部固件";
  } catch {
    return "外部固件";
  }
}

/**
 * @param {string|null|undefined} value
 * @returns {string|null} Lowercase hash, or null when absent.
 */
export function normalizeSha256(value) {
  if (value === undefined || value === null) return null;
  const text = String(value)
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
  if (!text) return null;
  if (!SHA256_PATTERN.test(text)) {
    throw new Error("SHA-256 格式无效：需要 64 位十六进制字符");
  }
  return text;
}

/**
 * Accept the plausible `/api/status` shapes of the local server.
 * @param {unknown} payload
 * @returns {{ name: string|null, size: number|null }}
 */
export function parseSampleStatus(payload) {
  const result = { name: null, size: null };
  if (!payload || typeof payload !== "object") return result;
  const candidates = [payload.demo, payload.sample, payload.firmware, payload].filter(
    (value) => value && typeof value === "object",
  );
  for (const candidate of candidates) {
    if (!result.name && typeof candidate.name === "string" && candidate.name.trim()) {
      result.name = candidate.name.trim();
    }
    const rawSize = Number(candidate.size ?? candidate.sizeBytes ?? candidate.bytes);
    if (!result.size && Number.isFinite(rawSize) && rawSize > 0) {
      result.size = Math.floor(rawSize);
    }
    if (result.name && result.size) break;
  }
  return result;
}

function normalizeStoredEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || !raw.id) return null;
  const kind = ENTRY_KINDS.has(raw.kind) ? raw.kind : "file";
  return {
    id: raw.id,
    name: raw.name || "未命名固件",
    kind,
    size: Number.isFinite(raw.size) && raw.size > 0 ? Math.floor(raw.size) : 0,
    version: typeof raw.version === "string" ? raw.version : "",
    project: typeof raw.project === "string" ? raw.project : "",
    source: typeof raw.source === "string" ? raw.source : "",
    lastUsed: Number.isFinite(raw.lastUsed) ? raw.lastUsed : 0,
    recentHidden: raw.recentHidden === true,
    sha256:
      typeof raw.sha256 === "string" && SHA256_PATTERN.test(raw.sha256)
        ? raw.sha256.toLowerCase()
        : "",
  };
}

function createSampleEntry() {
  return {
    id: SAMPLE_ID,
    name: SAMPLE_NAME,
    kind: "sample",
    size: 0,
    version: "",
    project: "",
    source: SAMPLE_SOURCE,
    lastUsed: 0,
    sha256: "",
  };
}

function describeSafe(describeFirmware, firmware) {
  try {
    const described = describeFirmware(firmware);
    if (described && typeof described === "object") {
      const app = described.app && typeof described.app === "object" ? described.app : null;
      return {
        ...described,
        app,
        project: typeof app?.project === "string" ? app.project : "",
        version: typeof app?.version === "string" ? app.version : "",
        idf: typeof app?.idf === "string" ? app.idf : "",
        size: firmware.byteLength,
      };
    }
  } catch {
    // Header validation already passed; descriptor metadata is optional.
  }
  return {
    error: "App descriptor not found",
    app: null,
    partitions: [],
    project: "",
    version: "",
    idf: "",
    size: firmware.byteLength,
  };
}

function hashToString(value) {
  if (typeof value === "string") return value.toLowerCase();
  if (ArrayBuffer.isView(value)) {
    return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  throw new Error("固件 SHA-256 计算结果格式无效");
}

export class FirmwareLibrary {
  #entries;
  #files;
  #fetch;
  #samplePromise = null;

  /**
   * @param {{ fetchImpl?: typeof fetch }} [options]
   */
  constructor({ fetchImpl } = {}) {
    this.#fetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof this.#fetch !== "function") {
      throw new Error("当前环境不支持 fetch，无法读取固件");
    }
    this.#files = new Map();
    this.#entries = this.#loadEntries();
  }

  #loadEntries() {
    const stored = readJson(STORAGE_KEY, null);
    const entries = Array.isArray(stored)
      ? stored.map(normalizeStoredEntry).filter(Boolean)
      : [];
    let sample = entries.find((entry) => entry.id === SAMPLE_ID);
    if (!sample) {
      sample = createSampleEntry();
      entries.unshift(sample);
    } else {
      sample.kind = "sample";
      sample.source = SAMPLE_SOURCE;
      if (!sample.name) sample.name = SAMPLE_NAME;
    }
    return entries;
  }

  #persist() {
    writeJson(STORAGE_KEY, this.#entries);
  }

  #find(id) {
    return this.#entries.find((entry) => entry.id === id) ?? null;
  }

  #copy(entry) {
    return { ...entry };
  }

  /**
   * Favorites first, then most recently used, then name.
   * @returns {Array<object>}
   */
  list() {
    return [...this.#entries]
      .sort((a, b) => {
        if (a.lastUsed !== b.lastUsed) return b.lastUsed - a.lastUsed;
        if ((a.kind === "sample") !== (b.kind === "sample")) return a.kind === "sample" ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-CN");
      })
      .map((entry) => this.#copy(entry));
  }

  /** @param {string} id */
  get(id) {
    const entry = this.#find(id);
    return entry ? this.#copy(entry) : null;
  }

  async #fetchSampleStatus() {
    try {
      const response = await this.#fetch(STATUS_URL, { cache: "no-store" });
      if (!response.ok) return { name: null, size: null };
      return parseSampleStatus(await response.json());
    } catch {
      return { name: null, size: null };
    }
  }

  async #fetchBytes(url, purpose) {
    let response;
    try {
      response = await this.#fetch(url, { cache: "no-cache" });
    } catch {
      if (purpose === "sample") {
        throw new Error("无法读取示例固件。请通过 server/serve.py 启动本地服务后重试。");
      }
      throw new Error(
        "无法下载固件：网络错误，或目标服务器未允许跨域（CORS）。可以先下载到本地，再选择文件。",
      );
    }
    if (!response.ok) {
      if (purpose === "sample") {
        throw new Error(
          `示例固件不可用（HTTP ${response.status}）。请通过 server/serve.py 启动本地服务后重试。`,
        );
      }
      const suffix = response.statusText ? ` ${response.statusText}` : "";
      throw new Error(`下载固件失败：HTTP ${response.status}${suffix}`);
    }
    const length = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > MAX_FIRMWARE_SIZE) {
      throw new Error("固件超过 32 MiB，模拟器无法载入");
    }
    return response.arrayBuffer();
  }

  async #readSample() {
    const [firmware, metadata] = await Promise.all([
      this.#fetchBytes(SAMPLE_SOURCE, "sample"),
      this.#fetchSampleStatus(),
    ]);
    const validation = validateFirmwareImage(firmware);
    if (!validation.ok) throw new Error(`示例固件无效：${validation.error}`);
    return { firmware, metadata };
  }

  async #hash(firmware) {
    const { sha256Hex } = await loadFirmwareHelpers();
    return hashToString(await sha256Hex(firmware));
  }

  async #describe(firmware) {
    const { describeFirmware } = await loadFirmwareHelpers();
    return describeSafe(describeFirmware, firmware);
  }

  #applyMetadata(entry, firmware, info, sha) {
    entry.size = firmware.byteLength;
    entry.sha256 = sha;
    if (typeof info.version === "string" && info.version) entry.version = info.version;
    if (typeof info.project === "string" && info.project) entry.project = info.project;
    entry.lastUsed = Date.now();
    entry.recentHidden = false;
  }

  #adoptSampleMetadata(entry, metadata) {
    if (metadata?.name) entry.name = metadata.name;
  }

  async #store(entry, firmware, { cache = true } = {}) {
    if (!entry.sha256) throw new Error("固件哈希缺失，无法缓存");
    if (cache) {
      try {
        await putFirmware(entry.sha256, firmware);
      } catch (error) {
        // Private browsing or quota limits: run from memory, skip persistence.
        console.warn("固件缓存不可用", error);
      }
    }
    this.#persist();
    return this.#copy(entry);
  }

  /**
   * Fetch the built-in sample, verify it, cache it by SHA-256 and refresh its entry.
   * @returns {Promise<object>}
   */
  async loadSample() {
    this.#samplePromise ??= this.#loadSample().finally(() => {
      this.#samplePromise = null;
    });
    return this.#samplePromise;
  }

  async #loadSample() {
    const { firmware, metadata } = await this.#readSample();
    const [info, sha] = await Promise.all([this.#describe(firmware), this.#hash(firmware)]);
    const entry = this.#find(SAMPLE_ID) ?? createSampleEntry();
    if (!this.#find(SAMPLE_ID)) this.#entries.unshift(entry);
    this.#adoptSampleMetadata(entry, metadata);
    this.#applyMetadata(entry, firmware, info, sha);
    return this.#store(entry, firmware);
  }

  /**
   * @param {File|Blob & { name?: string }} file
   * @returns {Promise<object>}
   */
  async addFile(file) {
    if (!file || typeof file.arrayBuffer !== "function") {
      throw new Error("请选择固件文件");
    }
    if (Number.isFinite(file.size)) {
      if (file.size < MIN_FIRMWARE_SIZE) {
        throw new Error(`固件仅 ${formatBytes(file.size)}，至少需要 64 KiB。`);
      }
      if (file.size > MAX_FIRMWARE_SIZE) {
        throw new Error("固件超过 32 MiB，模拟器无法载入");
      }
    }
    const firmware = await file.arrayBuffer();
    const validation = validateFirmwareImage(firmware);
    if (!validation.ok) throw new Error(validation.error);
    const [info, sha] = await Promise.all([this.#describe(firmware), this.#hash(firmware)]);
    const fileName = typeof file.name === "string" && file.name.trim() ? file.name : "本地固件";
    let entry = this.#find(`file-${sha.slice(0, 16)}`);
    if (!entry) {
      entry = {
        id: `file-${sha.slice(0, 16)}`,
        name: fileName,
        kind: "file",
        size: firmware.byteLength,
        version: "",
        project: "",
        source: fileName,
        lastUsed: 0,
        sha256: "",
      };
      this.#entries.push(entry);
    } else {
      entry.name = fileName;
      entry.source = fileName;
    }
    this.#files.set(entry.id, file);
    this.#applyMetadata(entry, firmware, info, sha);
    return this.#store(entry, firmware);
  }

  /**
   * @param {string} url
   * @param {{ sha256?: string }} [options]
   * @returns {Promise<object>}
   */
  async addUrl(url, { sha256 } = {}) {
    const source = normalizeUrl(url);
    const expected = normalizeSha256(sha256);
    const firmware = await this.#fetchBytes(source, "url");
    const validation = validateFirmwareImage(firmware);
    if (!validation.ok) throw new Error(validation.error);
    const sha = await this.#hash(firmware);
    if (expected && sha !== expected) {
      throw new Error(
        `SHA-256 校验失败：期望 ${expected.slice(0, 12)}…，实际 ${sha.slice(0, 12)}…`,
      );
    }
    const info = await this.#describe(firmware);
    let entry = this.#find(`url-${sha.slice(0, 16)}`);
    if (!entry) {
      entry = {
        id: `url-${sha.slice(0, 16)}`,
        name: firmwareNameFromUrl(source),
        kind: "url",
        size: firmware.byteLength,
        version: "",
        project: "",
        source,
        lastUsed: 0,
        sha256: "",
      };
      this.#entries.push(entry);
    } else {
      entry.source = source;
    }
    this.#applyMetadata(entry, firmware, info, sha);
    return this.#store(entry, firmware);
  }

  async #restoreBytes(entry) {
    if (entry.kind === "sample") {
      const { firmware, metadata } = await this.#readSample();
      this.#adoptSampleMetadata(entry, metadata);
      return firmware;
    }
    if (entry.kind === "url") {
      if (!entry.source) throw new Error("固件链接缺失，请移除后重新添加");
      return this.#fetchBytes(entry.source, "url");
    }
    const file = this.#files.get(entry.id);
    if (file) return file.arrayBuffer();
    throw new Error("固件内容不在本地缓存中，请重新选择该文件");
  }

  /**
   * Resolve an entry to validated bytes, preferring the content-addressed cache.
   * @param {object} entry
   */
  async #resolve(entry) {
    let firmware = entry.sha256 ? await getFirmware(entry.sha256).catch(() => null) : null;
    let sha = entry.sha256;
    const fromCache = Boolean(firmware);
    if (!firmware) {
      firmware = await this.#restoreBytes(entry);
      const validation = validateFirmwareImage(firmware);
      if (!validation.ok) throw new Error(validation.error);
      const fetchedSha = await this.#hash(firmware);
      if (entry.kind === "url" && entry.sha256 && fetchedSha !== entry.sha256) {
        throw new Error("链接内容与已缓存的固件不一致（SHA-256 不同），请移除条目后重新添加");
      }
      sha = fetchedSha;
    } else {
      const validation = validateFirmwareImage(firmware);
      if (!validation.ok) throw new Error(`本地缓存已损坏：${validation.error}`);
    }
    const info = await this.#describe(firmware);
    this.#applyMetadata(entry, firmware, info, sha);
    return { firmware, sha, info, fromCache };
  }

  #entry(entryOrId) {
    const id = typeof entryOrId === "string" ? entryOrId : entryOrId?.id;
    const entry = this.#find(id);
    if (!entry) throw new Error("固件条目不存在，可能已被移除");
    if (entry.kind === "market") throw new Error("官方市场接入将在后续版本提供");
    return entry;
  }

  /**
   * Resolve firmware bytes for booting. Uses the content-addressed cache first.
   * @param {string|object} entryOrId
   * @returns {Promise<{ entry: object, firmware: ArrayBuffer, info: object, flashKey: string }>}
   */
  async prepare(entryOrId) {
    const entry = this.#entry(entryOrId);
    const { firmware, sha, info, fromCache } = await this.#resolve(entry);
    const boot = await toBootImage(firmware, { fetchImpl: this.#fetch });
    const saved = await this.#store(entry, firmware, { cache: !fromCache });
    return { entry: saved, firmware: boot.firmware, info: boot.info, flashKey: sha };
  }

  /**
   * Original firmware bytes (no factory/slot wrapping), used when installing a
   * pure app package into an OTA slot.
   * @param {string|object} entryOrId
   * @returns {Promise<{ entry: object, firmware: ArrayBuffer, sha256: string, info: object }>}
   */
  async raw(entryOrId) {
    const entry = this.#entry(entryOrId);
    const { firmware, sha, info, fromCache } = await this.#resolve(entry);
    const saved = await this.#store(entry, firmware, { cache: !fromCache });
    return { entry: saved, firmware, sha256: sha, info };
  }

  /**
   * @param {string} id
   * @returns {boolean} False when the entry is missing.
   */
  hideRecent(id) {
    const entry = this.#find(id);
    if (!entry) return false;
    entry.recentHidden = true;
    this.#persist();
    return true;
  }

  remove(id) {
    if (id === SAMPLE_ID) return false;
    const index = this.#entries.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const [entry] = this.#entries.splice(index, 1);
    this.#files.delete(entry.id);
    this.#persist();
    if (entry.sha256 && !this.#entries.some((other) => other.sha256 === entry.sha256)) {
      deleteFirmware(entry.sha256).catch(() => {});
    }
    return true;
  }
}
