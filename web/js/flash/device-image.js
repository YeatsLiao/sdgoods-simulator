import { parsePartitionTable } from "../device/firmware.js";
import { isAppPackage } from "./app-package.js";
import { assembleParts } from "./image.js";
import { OTA_SECTOR_SIZE, buildOtadata } from "./otadata.js";

const PARTITION_OFFSET = 0x8000;
const APP_MIN_OFFSET = 0x10000;
const DEFAULT_MAX_SIZE = 32 * 1024 * 1024;

export const APP_TYPE = 0;
export const DATA_TYPE = 1;
export const SUBTYPE_OTA = 0x00;
export const SUBTYPE_NVS = 0x02;
export const SUBTYPE_OTA_0 = 0x10;

function toBytes(value, name) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(`${name} must be an ArrayBuffer or Uint8Array`);
}

/**
 * Read the official partition table without hardcoding slot offsets.
 * @param {ArrayBuffer|Uint8Array} partitionTable
 * @returns {{
 *   partitions: object[],
 *   nvs: object|null,
 *   otadata: object|null,
 *   slots: Array<{slotIndex: number, label: string, offset: number, size: number}>,
 * }}
 */
export function parseSlotLayout(partitionTable) {
  const bytes = toBytes(partitionTable, "partitionTable");
  const partitions = parsePartitionTable(bytes, 0);
  if (!partitions.length) throw new Error("平台分区表为空或格式无效");
  const nvs = partitions.find((entry) => entry.type === DATA_TYPE && entry.subtype === SUBTYPE_NVS) ?? null;
  const otadata = partitions.find((entry) => entry.type === DATA_TYPE && entry.subtype === SUBTYPE_OTA) ?? null;
  const slots = partitions
    .filter((entry) => entry.type === APP_TYPE
      && entry.subtype >= SUBTYPE_OTA_0
      && entry.subtype <= SUBTYPE_OTA_0 + 31)
    .map((entry) => ({
      slotIndex: entry.subtype - SUBTYPE_OTA_0,
      label: entry.label || `ota_${entry.subtype - SUBTYPE_OTA_0}`,
      offset: entry.offset,
      size: entry.size,
    }))
    .sort((a, b) => a.slotIndex - b.slotIndex);
  return { partitions, nvs, otadata, slots };
}

/**
 * Assemble a full flash image that boots `ota_{selected}` through the official
 * bootloader and otadata record. The factory area stays erased; the launcher
 * binary is not part of this simulator.
 * @param {{
 *   bootloader: ArrayBuffer|Uint8Array,
 *   partitionTable: ArrayBuffer|Uint8Array,
 *   seed?: ArrayBuffer|Uint8Array|null,
 *   apps?: Array<{slotIndex: number, bytes: ArrayBuffer|Uint8Array}>,
 *   selected: number,
 *   maxSize?: number,
 * }} options
 * @returns {{
 *   bytes: Uint8Array, used: number, slots: object[],
 *   otadata: object, selected: number,
 * }}
 */
export function buildSlotImage(options = {}) {
  const {
    bootloader,
    partitionTable,
    seed = null,
    apps = [],
    selected,
    maxSize = DEFAULT_MAX_SIZE,
  } = options ?? {};

  const boot = toBytes(bootloader, "bootloader");
  if (boot.byteLength === 0) throw new RangeError("bootloader 不能为空");
  if (boot[0] !== 0xe9) throw new Error("平台 bootloader 镜像头无效");

  const table = toBytes(partitionTable, "partitionTable");
  const layout = parseSlotLayout(table);
  if (!layout.otadata) throw new Error("平台分区表缺少 otadata 分区");
  if (layout.otadata.size < OTA_SECTOR_SIZE) {
    throw new Error("otadata 分区小于一个 4 KiB 扇区");
  }
  if (!layout.slots.length) throw new Error("平台分区表缺少 ota_N 应用槽");
  if (!Number.isInteger(selected)) throw new RangeError("selected must be an integer slot index");
  const selectedSlot = layout.slots.find((entry) => entry.slotIndex === selected);
  if (!selectedSlot) throw new RangeError(`ota_${selected} 不在平台分区表中`);

  const parts = [
    { address: 0, data: boot },
    { address: PARTITION_OFFSET, data: table },
  ];

  if (seed) {
    const seedBytes = toBytes(seed, "seed");
    if (seedBytes.byteLength === 0) throw new RangeError("NVS 预置镜像不能为空");
    if (!layout.nvs) throw new Error("平台分区表缺少 NVS 分区，无法写入网络预置");
    if (seedBytes.byteLength > layout.nvs.size) {
      throw new RangeError("平台 NVS 分区小于网络预置镜像");
    }
    parts.push({ address: layout.nvs.offset, data: seedBytes });
  }

  if (!Array.isArray(apps)) throw new TypeError("apps must be an array");
  const seen = new Set();
  for (const [index, app] of apps.entries()) {
    if (!app || typeof app !== "object") throw new TypeError(`apps[${index}] must be an object`);
    if (!Number.isInteger(app.slotIndex)) {
      throw new RangeError(`apps[${index}].slotIndex must be an integer`);
    }
    if (seen.has(app.slotIndex)) throw new RangeError(`ota_${app.slotIndex} 被重复装入`);
    const slot = layout.slots.find((entry) => entry.slotIndex === app.slotIndex);
    if (!slot) throw new RangeError(`ota_${app.slotIndex} 不在平台分区表中`);
    const bytes = toBytes(app.bytes, `apps[${index}].bytes`);
    if (bytes.byteLength === 0) throw new RangeError(`ota_${app.slotIndex} 的应用镜像为空`);
    if (bytes.byteLength > slot.size) {
      throw new RangeError(
        `应用 ${bytes.byteLength} 字节，超过 ota_${app.slotIndex} 槽容量 ${slot.size} 字节`,
      );
    }
    if (slot.offset < APP_MIN_OFFSET) {
      throw new Error(`ota_${app.slotIndex} 偏移低于应用区起点`);
    }
    if (!isAppPackage(bytes)) {
      throw new Error(`ota_${app.slotIndex} 的内容不是纯 app 包（含分区表或缺少应用描述符）`);
    }
    parts.push({ address: slot.offset, data: bytes });
    seen.add(app.slotIndex);
  }
  if (!seen.has(selected)) throw new Error(`启动槽 ota_${selected} 为空`);

  parts.push({
    address: layout.otadata.offset,
    data: buildOtadata(selected, { sectorSize: OTA_SECTOR_SIZE }),
  });

  const { bytes, used } = assembleParts(parts, { maxSize });
  return { bytes, used, slots: layout.slots, otadata: layout.otadata, selected };
}