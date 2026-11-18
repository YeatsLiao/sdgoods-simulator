const APP_DESC_SIZE = 0x90;
const PARTITION_OFFSET = 0x8000;
const ENTRY_SIZE = 0x20;
const PARTITION_MAGIC = 0x50aa; // AA 50 on flash, as stored by ESP-IDF.
const END_MAGIC = 0xffff;

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function readCString(bytes, offset, length) {
  let text = "";
  const limit = Math.min(offset + length, bytes.length);
  for (let index = offset; index < limit; index++) {
    const byte = bytes[index];
    if (byte === 0) return text;
    if (byte < 0x20 || byte > 0x7e) return null;
    text += String.fromCharCode(byte);
  }
  return null;
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<string>} Lowercase SHA-256 hex digest.
 */
export async function sha256Hex(buffer) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("crypto.subtle is not available");
  const bytes = bytesOf(buffer);
  if (!bytes) throw new TypeError("sha256Hex expects an ArrayBuffer or Uint8Array");
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Scan a merged image for an esp_app_desc_t record.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{project: string, version: string, time: string, date: string, idf: string, offset: number}|null}
 */
export function parseAppDescriptor(buffer) {
  const bytes = bytesOf(buffer);
  if (!bytes) return null;
  const last = bytes.length - APP_DESC_SIZE;
  for (let offset = 0; offset <= last; offset++) {
    // esp_app_desc_t.magic_word 0xABCD5432 is stored little-endian.
    if (bytes[offset] !== 0x32 || bytes[offset + 1] !== 0x54
      || bytes[offset + 2] !== 0xcd || bytes[offset + 3] !== 0xab) continue;
    const version = readCString(bytes, offset + 0x10, 32);
    const project = readCString(bytes, offset + 0x30, 32);
    const time = readCString(bytes, offset + 0x50, 16);
    const date = readCString(bytes, offset + 0x60, 16);
    const idf = readCString(bytes, offset + 0x70, 32);
    if (version === null || project === null || time === null || date === null || idf === null) continue;
    if (!version.trim() || !project.trim()) continue;
    return { project, version, time, date, idf, offset };
  }
  return null;
}

/**
 * Parse the partition table at `offset` until the 0xFFFF terminator.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {number} [offset]
 * @returns {{label: string, type: number, subtype: number, offset: number, size: number}[]}
 */
export function parsePartitionTable(buffer, offset = PARTITION_OFFSET) {
  const bytes = bytesOf(buffer);
  if (!bytes || !Number.isSafeInteger(offset) || offset < 0) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const partitions = [];
  for (let position = offset; position + ENTRY_SIZE <= bytes.length; position += ENTRY_SIZE) {
    const magic = view.getUint16(position, true);
    if (magic === END_MAGIC || magic !== PARTITION_MAGIC) break;
    let label = "";
    for (let index = position + 12; index < position + 28; index++) {
      const byte = bytes[index];
      if (byte === 0) break;
      label += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "?";
    }
    partitions.push({
      label,
      type: bytes[position + 2],
      subtype: bytes[position + 3],
      offset: view.getUint32(position + 4, true),
      size: view.getUint32(position + 8, true),
    });
  }
  return partitions;
}

/**
 * Best-effort firmware description; malformed input yields empty fields instead of throwing.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{size: number, app: object|null, partitions: object[], error: string|null}}
 */
export function describeFirmware(buffer) {
  const bytes = bytesOf(buffer);
  if (!bytes) {
    return { size: 0, app: null, partitions: [], error: "Invalid firmware data" };
  }
  let app = null;
  let partitions = [];
  try {
    app = parseAppDescriptor(bytes);
  } catch {
    app = null;
  }
  try {
    partitions = parsePartitionTable(bytes);
  } catch {
    partitions = [];
  }
  return {
    size: bytes.byteLength,
    app,
    partitions,
    error: app ? null : "App descriptor not found",
  };
}
