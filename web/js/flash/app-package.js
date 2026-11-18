import { describeFirmware, parsePartitionTable } from "../device/firmware.js";
import { assembleSingleApp } from "./image.js";

const PLATFORM_ROOT = new URL("../../platform/", import.meta.url);
const ASSETS_ROOT = new URL("../../assets/", import.meta.url);
const FACTORY_OFFSET = 0x10000;
const MAX_APP_BYTES = 3040870;
let bootAssetsPromise = null;
let bootAssetsFetch = null;

function bytesOf(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("固件必须是 ArrayBuffer 或 TypedArray");
}

function withFlatInfo(info) {
  const app = info.app;
  return {
    ...info,
    project: typeof app?.project === "string" ? app.project : "",
    version: typeof app?.version === "string" ? app.version : "",
    idf: typeof app?.idf === "string" ? app.idf : "",
  };
}

/**
 * App packages start with an application image at offset 0 and have no
 * partition table. Full images keep the bootloader at 0 and the partition
 * table at 0x8000.
 */
export function isAppPackage(buffer) {
  const info = describeFirmware(buffer);
  return Boolean(info.app && info.partitions.length === 0 && info.app.offset < FACTORY_OFFSET);
}

async function fetchAsset(fetchImpl, base, name) {
  const url = new URL(name, base);
  const response = await fetchImpl(url.href, { cache: "no-cache" });
  if (!response.ok) throw new Error(`模拟器资源不可用：${name}（HTTP ${response.status}）`);
  return new Uint8Array(await response.arrayBuffer());
}

async function loadBootAssets(fetchImpl) {
  if (bootAssetsPromise && bootAssetsFetch === fetchImpl) return bootAssetsPromise;
  bootAssetsFetch = fetchImpl;
  bootAssetsPromise = Promise.all([
    fetchAsset(fetchImpl, PLATFORM_ROOT, "bootloader.bin"),
    fetchAsset(fetchImpl, PLATFORM_ROOT, "partition-table.bin"),
    fetchAsset(fetchImpl, ASSETS_ROOT, "nvs-seed.bin"),
  ]).catch((error) => {
    bootAssetsPromise = null;
    bootAssetsFetch = null;
    throw error;
  });
  return bootAssetsPromise;
}

/**
 * Official platform boot assets, shared by the factory debug image and the
 * OTA slot images. The returned arrays are cached and must not be mutated.
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{bootloader: Uint8Array, partitionTable: Uint8Array, seed: Uint8Array}>}
 */
export async function loadPlatformAssets({ fetchImpl = globalThis.fetch } = {}) {
  const [bootloader, partitionTable, seed] = await loadBootAssets(fetchImpl);
  return { bootloader, partitionTable, seed };
}

function isBlank(region) {
  for (const byte of region) if (byte !== 0xff) return false;
  return true;
}

/**
 * Write the simulator's virtual Wi-Fi credentials into a blank NVS partition.
 * The emulator's AP is fixed (myssid / mypassword), so firmware that reads the
 * common SDGOODS namespaces connects to the host network without provisioning.
 */
function seedNetwork(bytes, partitions, seed) {
  const nvs = partitions.find((entry) => entry.type === 1 && entry.subtype === 2);
  if (!nvs) return;
  if (nvs.size < seed.byteLength) throw new Error("平台 NVS 分区小于网络预置镜像");
  const region = bytes.subarray(nvs.offset, nvs.offset + nvs.size);
  if (!isBlank(region)) return;
  bytes.set(seed, nvs.offset);
}

/**
 * Turn a market app-only image into a directly bootable factory image.
 * @param {ArrayBuffer|Uint8Array} firmware
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{firmware: ArrayBuffer, info: object, appPackage: boolean}>}
 */
export async function toBootImage(firmware, { fetchImpl = globalThis.fetch } = {}) {
  const bytes = bytesOf(firmware);
  const info = describeFirmware(bytes);
  if (info.partitions.length > 0) {
    const copy = new Uint8Array(bytes);
    const nvs = info.partitions.find((entry) => entry.type === 1 && entry.subtype === 2);
    if (nvs && isBlank(copy.subarray(nvs.offset, nvs.offset + nvs.size))) {
      try {
        const seed = await fetchAsset(fetchImpl, ASSETS_ROOT, "nvs-seed.bin");
        if (seed.byteLength <= nvs.size) copy.set(seed, nvs.offset);
      } catch {
        // A full image still boots without the optional network seed.
      }
    }
    return {
      firmware: copy.buffer,
      info: withFlatInfo(info),
      appPackage: false,
    };
  }
  if (!info.app) throw new Error("固件缺少应用描述符，无法识别为 ESP32-S3 应用");
  if (info.app.offset >= FACTORY_OFFSET) {
    throw new Error("固件既不是整机镜像，也不是可识别的纯 app 包");
  }
  if (bytes.byteLength > MAX_APP_BYTES) {
    throw new Error(`纯 app 包 ${bytes.byteLength} 字节，超过平台单槽上限 ${MAX_APP_BYTES} 字节`);
  }

  const [bootloader, partitionTable, seed] = await loadBootAssets(fetchImpl);
  if (bootloader[0] !== 0xe9) throw new Error("平台 bootloader.bin 镜像头无效");
  const platformPartitions = parsePartitionTable(partitionTable, 0);
  const factory = platformPartitions.find(
    (entry) => entry.type === 0 && entry.offset === FACTORY_OFFSET,
  );
  if (!factory || factory.size < bytes.byteLength) {
    throw new Error("平台分区表的 factory 槽无法容纳这个 app 包");
  }

  const assembled = assembleSingleApp({
    bootloader,
    partitionTable,
    app: bytes,
    offset: FACTORY_OFFSET,
    maxSize: 32 * 1024 * 1024,
  });
  seedNetwork(assembled.bytes, platformPartitions, seed);
  const bootInfo = withFlatInfo(describeFirmware(assembled.bytes));
  bootInfo.appPackage = true;
  return {
    firmware: assembled.bytes.buffer.slice(assembled.bytes.byteOffset, assembled.bytes.byteOffset + assembled.bytes.byteLength),
    info: bootInfo,
    appPackage: true,
  };
}