const DEFAULT_MAX_SIZE = 32 * 1024 * 1024;
const PARTITION_OFFSET = 0x8000;
const APP_MIN_OFFSET = 0x10000;

function toBytes(value, name) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(`${name} must be an ArrayBuffer or Uint8Array`);
}

/**
 * Merge addressed segments into one image. Gaps are filled with 0xFF, matching
 * erased flash, so NVS and other data partitions start in their reset state.
 * @param {{address: number, data: ArrayBuffer|Uint8Array}[]} parts
 * @param {{maxSize?: number}} [options]
 * @returns {{bytes: Uint8Array, used: number}} `used` is the end of the highest segment.
 */
export function assembleParts(parts, options = {}) {
  const { maxSize = DEFAULT_MAX_SIZE } = options ?? {};
  if (!Array.isArray(parts)) throw new TypeError("parts must be an array");
  if (!Number.isSafeInteger(maxSize) || maxSize < 0) {
    throw new RangeError("maxSize must be a non-negative integer");
  }
  const ranges = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part || typeof part !== "object") throw new TypeError(`parts[${index}] must be an object`);
    if (!Number.isSafeInteger(part.address) || part.address < 0) {
      throw new RangeError(`parts[${index}].address must be a non-negative integer`);
    }
    const data = toBytes(part.data, `parts[${index}].data`);
    const end = part.address + data.byteLength;
    if (end > maxSize) {
      throw new RangeError(
        `parts[${index}] ends at 0x${end.toString(16)}, past maxSize 0x${maxSize.toString(16)}`,
      );
    }
    if (data.byteLength) ranges.push({ address: part.address, data, end });
  }
  ranges.sort((a, b) => a.address - b.address);
  let used = 0;
  for (let index = 0; index < ranges.length; index++) {
    if (index > 0 && ranges[index].address < ranges[index - 1].end) {
      throw new RangeError(`parts overlap at 0x${ranges[index].address.toString(16)}`);
    }
    used = ranges[index].end;
  }
  const bytes = new Uint8Array(used);
  bytes.fill(0xff);
  for (const range of ranges) bytes.set(range.data, range.address);
  return { bytes, used };
}

/**
 * Build the single-app image used by market app packages.
 * @param {{
 *   bootloader: ArrayBuffer|Uint8Array,
 *   partitionTable: ArrayBuffer|Uint8Array,
 *   app: ArrayBuffer|Uint8Array,
 *   offset?: number,
 *   maxSize?: number,
 * }} options
 * @returns {{bytes: Uint8Array, used: number}}
 */
export function assembleSingleApp(options = {}) {
  const {
    bootloader,
    partitionTable,
    app,
    offset = APP_MIN_OFFSET,
    maxSize = DEFAULT_MAX_SIZE,
  } = options ?? {};
  if (!Number.isSafeInteger(offset) || offset < APP_MIN_OFFSET) {
    throw new RangeError("app offset must be an integer >= 0x10000");
  }
  const appBytes = toBytes(app, "app");
  if (appBytes.byteLength === 0) throw new RangeError("app image must not be empty");
  return assembleParts([
    { address: 0, data: bootloader },
    { address: PARTITION_OFFSET, data: partitionTable },
    { address: offset, data: appBytes },
  ], { maxSize });
}
