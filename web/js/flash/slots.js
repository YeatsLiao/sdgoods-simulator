import { readJson, writeJson } from "../shared/storage.js";

export const SLOT_COUNT = 4;
export const SLOT_STATE_KEY = "slots.state";

const SHA_PATTERN = /^[0-9a-f]{64}$/;

function emptySlots(count) {
  return Array.from({ length: count }, () => null);
}

/**
 * Keep only the metadata small enough for localStorage; firmware bytes live in
 * the SHA-256 addressed IndexedDB cache.
 */
function normalizeAssignment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const sha256 = typeof raw.sha256 === "string" ? raw.sha256.toLowerCase() : "";
  if (!SHA_PATTERN.test(sha256)) return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;
  return {
    entryId: typeof raw.entryId === "string" ? raw.entryId : "",
    sha256,
    name,
    version: typeof raw.version === "string" ? raw.version : "",
    project: typeof raw.project === "string" ? raw.project : "",
    size: Number.isFinite(raw.size) && raw.size > 0 ? Math.floor(raw.size) : 0,
  };
}

/**
 * @param {unknown} raw Stored state, an array of assignments, or null.
 * @param {number} [count]
 * @returns {{slots: Array<object|null>, selected: number|null}}
 */
export function normalizeSlotState(raw, count = SLOT_COUNT) {
  if (!Number.isInteger(count) || count <= 0) throw new RangeError("slot count must be positive");
  const slots = emptySlots(count);
  const source = Array.isArray(raw) ? raw : Array.isArray(raw?.slots) ? raw.slots : [];
  for (let index = 0; index < Math.min(count, source.length); index++) {
    slots[index] = normalizeAssignment(source[index]);
  }
  let selected = Number.isInteger(raw?.selected) && raw.selected >= 0 && raw.selected < count
    ? raw.selected
    : null;
  if (selected !== null && !slots[selected]) selected = null;
  return { slots, selected };
}

/** @returns {{slots: Array<object|null>, selected: number|null}} */
export function readSlotState(count = SLOT_COUNT) {
  return normalizeSlotState(readJson(SLOT_STATE_KEY, null), count);
}

export function writeSlotState(state) {
  writeJson(SLOT_STATE_KEY, normalizeSlotState(state));
}

/**
 * @param {{slots: Array<object|null>, selected: number|null}} state
 * @param {number} slotIndex
 * @param {object} app
 */
export function assignSlot(state, slotIndex, app) {
  const next = normalizeSlotState(state);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= next.slots.length) {
    throw new RangeError("slotIndex 超出范围");
  }
  next.slots[slotIndex] = normalizeAssignment({ ...app, sha256: app?.sha256 });
  if (!next.slots[slotIndex]) throw new Error("槽元数据无效：需要纯 app 包名称与 SHA-256");
  return next;
}

/** @param {{slots: Array<object|null>, selected: number|null}} state */
export function clearSlot(state, slotIndex) {
  const next = normalizeSlotState(state);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= next.slots.length) {
    throw new RangeError("slotIndex 超出范围");
  }
  next.slots[slotIndex] = null;
  if (next.selected === slotIndex) next.selected = null;
  return next;
}

/** @param {{slots: Array<object|null>, selected: number|null}} state */
export function selectSlot(state, slotIndex) {
  const next = normalizeSlotState(state);
  if (!next.slots[slotIndex]) throw new Error("槽为空，无法记录为启动槽");
  next.selected = slotIndex;
  return next;
}