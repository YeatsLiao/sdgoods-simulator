const DB_NAME = "sdgoods-library";
const DB_VERSION = 1;
const STORE_NAME = "firmware";

export const CACHE_DB_NAME = DB_NAME;
export const CACHE_STORE_NAME = STORE_NAME;

let databasePromise = null;

/** @returns {boolean} */
export function isCacheSupported() {
  return typeof indexedDB !== "undefined";
}

function openDatabase() {
  if (!isCacheSupported()) {
    return Promise.reject(new Error("当前浏览器不支持 IndexedDB，无法缓存固件"));
  }
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("无法打开固件缓存"));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("固件缓存被其他页面占用，请关闭其他模拟器页面后重试"));
    };
  });
  return databasePromise;
}

async function withStore(mode, action) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let request;
    try {
      const transaction = database.transaction(STORE_NAME, mode);
      request = action(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => {
        reject(transaction.error ?? request?.error ?? new Error("固件缓存读写失败"));
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error("固件缓存操作被中止"));
      };
    } catch (error) {
      reject(error);
    }
  });
}

function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  throw new TypeError("固件缓存需要 ArrayBuffer 或 TypedArray");
}

/**
 * Cache firmware bytes under a content hash.
 * @param {string} key
 * @param {ArrayBuffer|ArrayBufferView} bytes
 */
export async function putFirmware(key, bytes) {
  if (typeof key !== "string" || !key) throw new Error("固件缓存键无效");
  await withStore("readwrite", (store) => store.put(toArrayBuffer(bytes), key));
}

/**
 * @param {string} key
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function getFirmware(key) {
  if (typeof key !== "string" || !key) return null;
  const value = await withStore("readonly", (store) => store.get(key));
  if (value === undefined || value === null) return null;
  return toArrayBuffer(value);
}

/** @param {string} key */
export async function deleteFirmware(key) {
  if (typeof key !== "string" || !key) return;
  await withStore("readwrite", (store) => store.delete(key));
}

/** @returns {Promise<string[]>} */
export async function listFirmwareKeys() {
  const keys = await withStore("readonly", (store) => store.getAllKeys());
  return Array.isArray(keys) ? keys.map(String) : [];
}

export async function clearFirmware() {
  await withStore("readwrite", (store) => store.clear());
}
