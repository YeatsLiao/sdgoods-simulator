const DB_NAME = "sdgoods-flash";
const STORE = "snapshots";
const MAGIC = 0x4c464453; // "SDFL" little-endian
const CHUNK = 4096;
const MAX_FLASH = 32 * 1024 * 1024;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const request = action(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function compress(bytes) {
  if (typeof CompressionStream === "undefined") return { data: bytes, compressed: false };
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return { data: new Uint8Array(await new Response(stream).arrayBuffer()), compressed: true };
  } catch {
    return { data: bytes, compressed: false };
  }
}

async function decompress(bytes, compressed) {
  if (!compressed) return bytes;
  if (typeof DecompressionStream === "undefined") throw new Error("浏览器不支持解压 Flash 快照");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function sameChunk(base, flash, offset, length) {
  if (offset + length > flash.length) return false;
  for (let i = 0; i < length; i++) {
    const a = offset + i < base.length ? base[offset + i] : 0;
    if (a !== flash[offset + i]) return false;
  }
  return true;
}

function serialize(base, flash) {
  const chunks = [];
  for (let offset = 0; offset < flash.length; offset += CHUNK) {
    const length = Math.min(CHUNK, flash.length - offset);
    if (sameChunk(base, flash, offset, length)) continue;
    chunks.push({ offset, data: flash.slice(offset, offset + length) });
  }
  const size = Math.max(flash.length, base.length);
  const header = 20 + chunks.length * 6;
  const total = header + chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, base.length, true);
  view.setUint32(12, size, true);
  view.setUint32(16, chunks.length, true);
  let offset = 20;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.offset, true);
    view.setUint16(offset + 4, chunk.data.length, true);
    out.set(chunk.data, offset + 6);
    offset += 6 + chunk.data.length;
  }
  return out;
}

function parse(base, snapshot) {
  const view = new DataView(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength);
  if (view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) !== 1) {
    throw new Error("Flash 快照格式不匹配");
  }
  const baseSize = view.getUint32(8, true);
  const size = view.getUint32(12, true);
  const chunks = view.getUint32(16, true);
  if (size > MAX_FLASH || chunks > size / CHUNK + 1) throw new Error("Flash 快照损坏");
  const out = new Uint8Array(size);
  out.set(base.subarray(0, Math.min(baseSize, base.length)));
  let offset = 20;
  for (let i = 0; i < chunks; i++) {
    const at = view.getUint32(offset, true);
    const length = view.getUint16(offset + 4, true);
    const end = offset + 6 + length;
    if (end > snapshot.length || at + length > size) throw new Error("Flash 快照越界");
    out.set(snapshot.subarray(offset + 6, end), at);
    offset = end;
  }
  return out;
}

export class FlashStore {
  async save(key, base, flash) {
    if (!key || !indexedDB) return;
    const baseBytes = new Uint8Array(base);
    const flashBytes = new Uint8Array(flash);
    if (flashBytes.length > MAX_FLASH) throw new Error("Flash 数据超过 32 MB");
    const snapshot = serialize(baseBytes, flashBytes);
    const packed = await compress(snapshot);
    await withStore("readwrite", (store) => store.put({
      key,
      savedAt: Date.now(),
      compressed: packed.compressed,
      data: packed.data.buffer,
    }));
  }

  async load(key, base) {
    if (!key || !indexedDB) return null;
    const record = await withStore("readonly", (store) => store.get(key));
    if (!record) return null;
    try {
      const snapshot = await decompress(new Uint8Array(record.data), record.compressed);
      return parse(new Uint8Array(base), snapshot);
    } catch {
      return null;
    }
  }

  async clear(key) {
    if (!key || !indexedDB) return;
    await withStore("readwrite", (store) => store.delete(key));
  }

  async list() {
    if (!indexedDB) return [];
    const records = await withStore("readonly", (store) => store.getAll());
    return records.map(({ key, savedAt }) => ({ key, savedAt }));
  }
}
