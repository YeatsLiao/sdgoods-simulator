/**
 * ESP-IDF OTA selection records stored in the `otadata` partition.
 *
 * Each 4 KiB sector holds one `esp_ota_select_entry_t`:
 *   u32 ota_seq; u8 seq_label[20]; u32 ota_state; u32 crc;
 * The bootloader picks the sector with the highest valid sequence and boots
 * `ota_{ota_seq - 1}`; an all-0xFF partition means "boot factory".
 *
 * ESP-IDF 5.5 computes the CRC over `&ota_seq, 4` only (see
 * bootloader_common_ota_select_crc), not over the whole entry.
 */

export const OTA_ENTRY_SIZE = 32;
export const OTA_SECTOR_SIZE = 0x1000;
export const OTA_SEQ_EMPTY = 0xffffffff;
export const OTA_STATE_UNDEFINED = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function toBytes(value, name) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(`${name} must be an ArrayBuffer or Uint8Array`);
}

/**
 * ESP-IDF `crc32_le` (esp_rom_crc32_le): reflected CRC-32 with the seed applied
 * raw and inverted on both ends. `crc32Le(bytes)` therefore equals
 * `crc32_le(0xFFFFFFFF, bytes)` — note this is *not* zlib's crc32(data).
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {number} [initial] Seed value, 0xFFFFFFFF for a fresh CRC.
 * @returns {number}
 */
export function crc32Le(buffer, initial = 0xffffffff) {
  const bytes = toBytes(buffer, "buffer");
  let crc = (initial ^ 0xffffffff) >>> 0;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build one otadata sector that selects `ota_{slotIndex}`.
 * The unused second sector stays erased (0xFF) — gaps do that in the image.
 * @param {number} slotIndex 0-based ota_N index.
 * @param {{ sectorSize?: number }} [options]
 * @returns {Uint8Array}
 */
export function buildOtadata(slotIndex, { sectorSize = OTA_SECTOR_SIZE } = {}) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= OTA_SEQ_EMPTY - 1) {
    throw new RangeError("slotIndex must be a non-negative integer");
  }
  if (!Number.isInteger(sectorSize) || sectorSize < OTA_ENTRY_SIZE) {
    throw new RangeError("sectorSize must be an integer >= 32");
  }
  const bytes = new Uint8Array(sectorSize);
  bytes.fill(0xff);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, slotIndex + 1, true);
  // seq_label stays zero; the erased fill above is wiped explicitly.
  bytes.fill(0, 4, 24);
  view.setUint32(24, OTA_STATE_UNDEFINED, true);
  view.setUint32(28, crc32Le(bytes.subarray(0, 4)), true);
  return bytes;
}

/**
 * Parse the otadata partition and return the selected slot.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {{ sectorSize?: number }} [options]
 * @returns {{ slotIndex: number, otaSeq: number, otaState: number, sector: number }|null}
 *   Null when no sector holds a valid record (factory boot).
 */
export function parseOtadata(buffer, { sectorSize = OTA_SECTOR_SIZE } = {}) {
  const bytes = toBytes(buffer, "buffer");
  if (!Number.isInteger(sectorSize) || sectorSize < OTA_ENTRY_SIZE) {
    throw new RangeError("sectorSize must be an integer >= 32");
  }
  const sectors = Math.min(2, Math.floor(bytes.byteLength / sectorSize));
  const entries = [];
  for (let sector = 0; sector < sectors; sector++) {
    const base = sector * sectorSize;
    const view = new DataView(bytes.buffer, bytes.byteOffset + base, OTA_ENTRY_SIZE);
    const otaSeq = view.getUint32(0, true);
    const otaState = view.getUint32(24, true);
    const crc = view.getUint32(28, true);
    if (otaSeq === OTA_SEQ_EMPTY) continue;
    if (crc !== crc32Le(bytes.subarray(base, base + 4))) continue;
    entries.push({ slotIndex: otaSeq - 1, otaSeq, otaState, sector });
  }
  if (!entries.length) return null;
  // The IDF bootloader uses the highest sequence; our writer increments by one.
  entries.sort((a, b) => b.otaSeq - a.otaSeq);
  return entries[0];
}