import test from "node:test";
import assert from "node:assert/strict";

import { sha256Hex } from "../web/js/device/firmware.js";
import {
  FirmwareLibrary,
  MAX_FIRMWARE_SIZE,
  MIN_FIRMWARE_SIZE,
  firmwareNameFromUrl,
  normalizeSha256,
  normalizeUrl,
  parseSampleStatus,
  validateFirmwareImage,
} from "../web/js/library/library.js";

// Node has no IndexedDB; the library is expected to fall back to memory.
const originalWarn = console.warn;
console.warn = (...args) => {
  if (String(args[0]).includes("固件缓存")) return;
  originalWarn(...args);
};

function makeImage(size = MIN_FIRMWARE_SIZE, { magic = 0xe9, chipId = 9 } = {}) {
  const bytes = new Uint8Array(size);
  bytes[0] = magic;
  new DataView(bytes.buffer).setUint16(12, chipId, true);
  return bytes;
}

function writeCString(bytes, offset, text, width) {
  for (let index = 0; index < Math.min(text.length, width - 1); index++) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}

function writeFactoryPartition(bytes) {
  const position = 0x8000;
  const view = new DataView(bytes.buffer);
  view.setUint16(position, 0x50aa, true);
  bytes[position + 2] = 0;
  bytes[position + 3] = 0;
  view.setUint32(position + 4, 0x10000, true);
  view.setUint32(position + 8, 0x300000, true);
  writeCString(bytes, position + 12, "factory", 16);
  view.setUint16(position + 0x20, 0xffff, true);
}

function makeDescribedImage() {
  const bytes = makeImage(MIN_FIRMWARE_SIZE + 4096);
  writeFactoryPartition(bytes);
  const offset = 0x2000;
  bytes[offset] = 0x32;
  bytes[offset + 1] = 0x54;
  bytes[offset + 2] = 0xcd;
  bytes[offset + 3] = 0xab;
  writeCString(bytes, offset + 0x10, "1.2.3", 32);
  writeCString(bytes, offset + 0x30, "demo-app", 32);
  writeCString(bytes, offset + 0x50, "10:00:00", 16);
  writeCString(bytes, offset + 0x60, "Nov 18 2026", 16);
  writeCString(bytes, offset + 0x70, "v5.5.5", 32);
  return bytes;
}

function fixtureFetch(bytes, { statusName = "demo.bin" } = {}) {
  const calls = [];
  const impl = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.endsWith("/api/status")) {
      return new Response(JSON.stringify({ sample: { name: statusName, size: bytes.byteLength } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/demo.bin") || url === "https://example.com/demo.bin") {
      return new Response(bytes.slice(0), { status: 200 });
    }
    return new Response("missing", { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

test("validateFirmwareImage accepts a minimal ESP32-S3 image", () => {
  const result = validateFirmwareImage(makeImage());
  assert.deepEqual(result, { ok: true });
});

test("validateFirmwareImage accepts a view with a non-zero byte offset", () => {
  const backing = new Uint8Array(MIN_FIRMWARE_SIZE + 8);
  const image = makeImage();
  backing.set(image, 8);
  const view = backing.subarray(8);
  assert.equal(view.byteOffset, 8);
  assert.deepEqual(validateFirmwareImage(view), { ok: true });
});

test("validateFirmwareImage rejects undersized files", () => {
  const result = validateFirmwareImage(makeImage(MIN_FIRMWARE_SIZE - 1));
  assert.equal(result.ok, false);
  assert.match(result.error, /64 KiB/);
});

test("validateFirmwareImage rejects files above 32 MiB", () => {
  const result = validateFirmwareImage(new Uint8Array(MAX_FIRMWARE_SIZE + 1));
  assert.equal(result.ok, false);
  assert.match(result.error, /32 MiB/);
});

test("validateFirmwareImage rejects a missing image magic", () => {
  const result = validateFirmwareImage(makeImage(MIN_FIRMWARE_SIZE, { magic: 0x00 }));
  assert.equal(result.ok, false);
  assert.match(result.error, /0xE9/);
});

test("validateFirmwareImage rejects non-S3 chip ids", () => {
  const result = validateFirmwareImage(makeImage(MIN_FIRMWARE_SIZE, { chipId: 0 }));
  assert.equal(result.ok, false);
  assert.match(result.error, /ESP32-S3/);
});

test("validateFirmwareImage rejects non-binary input", () => {
  assert.equal(validateFirmwareImage("not bytes").ok, false);
  assert.equal(validateFirmwareImage(null).ok, false);
});

test("normalizeUrl only accepts absolute http(s) URLs", () => {
  assert.equal(normalizeUrl(" https://example.com/fw.bin "), "https://example.com/fw.bin");
  assert.equal(normalizeUrl("http://127.0.0.1:8767/demo.bin"), "http://127.0.0.1:8767/demo.bin");
  assert.throws(() => normalizeUrl(""), /填写/);
  assert.throws(() => normalizeUrl("demo.bin"), /http/);
  assert.throws(() => normalizeUrl("ftp://example.com/fw.bin"), /http/);
  assert.throws(() => normalizeUrl("javascript:alert(1)"), /http/);
});

test("firmwareNameFromUrl uses the decoded file name and falls back to the host", () => {
  assert.equal(firmwareNameFromUrl("https://example.com/fw/chiikawa%20go.bin"), "chiikawa go.bin");
  assert.equal(firmwareNameFromUrl("https://example.com/"), "example.com");
  assert.equal(firmwareNameFromUrl("not a url"), "外部固件");
});

test("normalizeSha256 normalizes the common prefix and casing", () => {
  const hash = "A".repeat(64);
  assert.equal(normalizeSha256(`sha256:${hash}`), "a".repeat(64));
  assert.equal(normalizeSha256("   "), null);
  assert.equal(normalizeSha256(null), null);
  assert.throws(() => normalizeSha256("abc"), /64 位/);
});

test("parseSampleStatus accepts nested and flat status payloads", () => {
  assert.deepEqual(parseSampleStatus({ demo: { name: "demo.bin", size: 1024 } }), {
    name: "demo.bin",
    size: 1024,
  });
  assert.deepEqual(parseSampleStatus({ name: "示例", size: 2048 }), {
    name: "示例",
    size: 2048,
  });
  assert.deepEqual(parseSampleStatus({ sample: { name: "a.bin" }, sizeBytes: 99 }), {
    name: "a.bin",
    size: 99,
  });
  assert.deepEqual(parseSampleStatus(null), { name: null, size: null });
  assert.deepEqual(parseSampleStatus({ demo: { name: "  ", size: -1 } }), {
    name: null,
    size: null,
  });
});

test("FirmwareLibrary seeds an unremovable sample entry", () => {
  const library = new FirmwareLibrary({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const entries = library.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "sample");
  assert.equal(entries[0].kind, "sample");
  assert.equal(entries[0].name, "谷仓次元屏 · 小智 AI");
  assert.equal(library.remove("sample"), false);
});

test("FirmwareLibrary rejects unsupported files before reading them", async () => {
  const library = new FirmwareLibrary({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(async () => {
    await library.addFile({ size: 1024, name: "tiny.bin", arrayBuffer: async () => new ArrayBuffer(1024) });
  }, /64 KiB/);
  await assert.rejects(async () => {
    await library.addUrl("ftp://example.com/fw.bin");
  }, /http/);
});

test("FirmwareLibrary.prepare rejects unknown and market entries", async () => {
  const library = new FirmwareLibrary({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(() => library.prepare("missing"), /不存在/);
});

test("loadSample reads status metadata, validates and describes the image", async () => {
  const bytes = makeDescribedImage();
  const library = new FirmwareLibrary({ fetchImpl: fixtureFetch(bytes, { statusName: "demo-sample.bin" }) });
  const entry = await library.loadSample();
  assert.equal(entry.id, "sample");
  assert.equal(entry.kind, "sample");
  assert.equal(entry.name, "demo-sample.bin");
  assert.equal(entry.size, bytes.byteLength);
  assert.equal(entry.version, "1.2.3");
  assert.equal(entry.project, "demo-app");
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  assert.ok(entry.lastUsed > 0);
});

test("prepare returns firmware, flat and nested info, and a stable flash key", async () => {
  const bytes = makeDescribedImage();
  const fetchImpl = fixtureFetch(bytes);
  const library = new FirmwareLibrary({ fetchImpl });
  const entry = await library.loadSample();
  const prepared = await library.prepare(entry);
  assert.equal(prepared.flashKey, entry.sha256);
  assert.equal(prepared.entry.id, "sample");
  assert.equal(prepared.firmware.byteLength, bytes.byteLength);
  assert.equal(prepared.info.app.project, "demo-app");
  assert.equal(prepared.info.project, "demo-app");
  assert.equal(prepared.info.version, "1.2.3");
  assert.equal(prepared.info.idf, "v5.5.5");
  assert.ok(Array.isArray(prepared.info.partitions));
  assert.equal(new Uint8Array(prepared.firmware)[0], 0xe9);
});

test("raw returns the original bytes without boot wrapping", async () => {
  const bytes = makeDescribedImage();
  const library = new FirmwareLibrary({ fetchImpl: fixtureFetch(bytes) });
  const entry = await library.loadSample();
  const raw = await library.raw(entry);
  assert.equal(raw.sha256, entry.sha256);
  assert.equal(raw.firmware.byteLength, bytes.byteLength);
  assert.deepEqual([...new Uint8Array(raw.firmware).subarray(0, 8)], [...bytes.subarray(0, 8)]);
  assert.equal(raw.info.app.project, "demo-app");
  await assert.rejects(() => library.raw("missing"), /不存在/);
});

test("addFile validates, hashes and prepares from the in-memory file", async () => {
  const bytes = makeDescribedImage();
  const library = new FirmwareLibrary({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const file = {
    name: "my-firmware.bin",
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice(0).buffer,
  };
  const entry = await library.addFile(file);
  assert.equal(entry.kind, "file");
  assert.equal(entry.name, "my-firmware.bin");
  assert.equal(entry.project, "demo-app");
  assert.equal(entry.id, `file-${entry.sha256.slice(0, 16)}`);
  const prepared = await library.prepare(entry);
  assert.equal(prepared.firmware.byteLength, bytes.byteLength);
  assert.equal(prepared.info.version, "1.2.3");
});

test("addFile rejects a wrong image header before caching", async () => {
  const bytes = makeImage(MIN_FIRMWARE_SIZE, { chipId: 0 });
  const library = new FirmwareLibrary({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(
    () => library.addFile({ name: "bad.bin", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }),
    /ESP32-S3/,
  );
});

test("addUrl verifies an optional SHA-256 and refetches by URL", async () => {
  const bytes = makeDescribedImage();
  const digest = await sha256Hex(bytes);
  const library = new FirmwareLibrary({ fetchImpl: fixtureFetch(bytes) });
  const entry = await library.addUrl("https://example.com/demo.bin", { sha256: digest });
  assert.equal(entry.kind, "url");
  assert.equal(entry.name, "demo.bin");
  assert.equal(entry.sha256, digest);
  const prepared = await library.prepare(entry);
  assert.equal(prepared.flashKey, digest);
});

test("addUrl rejects a SHA-256 mismatch", async () => {
  const bytes = makeDescribedImage();
  const library = new FirmwareLibrary({ fetchImpl: fixtureFetch(bytes) });
  await assert.rejects(
    () => library.addUrl("https://example.com/demo.bin", { sha256: "0".repeat(64) }),
    /SHA-256 校验失败/,
  );
});

test("addUrl surfaces HTTP and CORS failures clearly", async () => {
  const notFound = new FirmwareLibrary({ fetchImpl: async () => new Response("no", { status: 404 }) });
  await assert.rejects(() => notFound.addUrl("https://example.com/missing.bin"), /HTTP 404/);

  const offline = new FirmwareLibrary({
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(() => offline.addUrl("https://example.com/cors.bin"), /跨域/);
});

test("remove keeps the sample entry protected", async () => {
  const bytes = makeDescribedImage();
  const library = new FirmwareLibrary({ fetchImpl: fixtureFetch(bytes) });
  const entry = await library.addUrl("https://example.com/demo.bin");
  assert.equal(library.remove(entry.id), true);
  assert.equal(library.get(entry.id), null);
  assert.equal(library.remove("sample"), false);
  assert.ok(library.list().some((item) => item.kind === "sample"));
});


test("hiding history preserves firmware bytes and opening it restores the record", async () => {
  const bytes=makeDescribedImage();
  const library=new FirmwareLibrary({fetchImpl:async()=>{throw Error("offline");}});
  const entry=await library.addFile({name:"keep.bin",size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer});
  const before=await library.prepare(entry);
  assert.equal(library.hideRecent(entry.id),true);
  assert.equal(library.list().find(item=>item.id===entry.id).recentHidden,true);
  const after=await library.prepare(entry.id);
  assert.equal(after.flashKey,before.flashKey);
  assert.deepEqual(new Uint8Array(after.firmware),new Uint8Array(before.firmware));
  assert.equal(library.list().find(item=>item.id===entry.id).recentHidden,false);
});
