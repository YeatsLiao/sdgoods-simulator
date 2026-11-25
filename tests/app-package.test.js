import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { describeFirmware, parsePartitionTable } from "../web/js/device/firmware.js";
import { isAppPackage, toBootImage } from "../web/js/flash/app-package.js";

const MIN = 64 * 1024;
const SEED = new Uint8Array(readFileSync(new URL("../web/assets/nvs-seed.bin", import.meta.url)));

function appImage() {
  const bytes = new Uint8Array(MIN + 4096);
  bytes[0] = 0xe9;
  new DataView(bytes.buffer).setUint16(12, 9, true);
  const offset = 0x20;
  bytes[offset] = 0x32;
  bytes[offset + 1] = 0x54;
  bytes[offset + 2] = 0xcd;
  bytes[offset + 3] = 0xab;
  const text = (at, value, width) => {
    for (let i = 0; i < Math.min(value.length, width - 1); i++) {
      bytes[at + i] = value.charCodeAt(i);
    }
  };
  text(offset + 0x10, "1.0.0", 32);
  text(offset + 0x30, "radio", 32);
  text(offset + 0x50, "12:00:00", 16);
  text(offset + 0x60, "Nov 18 2026", 16);
  text(offset + 0x70, "v5.5.5", 32);
  return bytes;
}

function partitionFile() {
  const bytes = new Uint8Array(0xc00);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x50aa, true);
  bytes[2] = 1;
  bytes[3] = 2;
  view.setUint32(4, 0x9000, true);
  view.setUint32(8, 0x6000, true);
  for (let i = 0; i < 3; i++) bytes[12 + i] = "nvs".charCodeAt(i);
  view.setUint16(0x20, 0x50aa, true);
  bytes[0x22] = 0;
  bytes[0x23] = 0;
  view.setUint32(0x24, 0x10000, true);
  view.setUint32(0x28, 0x300000, true);
  for (let i = 0; i < 8; i++) bytes[0x2c + i] = "launcher".charCodeAt(i);
  view.setUint16(0x40, 0xffff, true);
  return bytes;
}

function platformFetch() {
  return async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("bootloader.bin")) {
      const bytes = new Uint8Array(64);
      bytes[0] = 0xe9;
      return new Response(bytes, { status: 200 });
    }
    if (url.endsWith("partition-table.bin")) {
      return new Response(partitionFile(), { status: 200 });
    }
    if (url.endsWith("nvs-seed.bin")) {
      return new Response(SEED.slice(0), { status: 200 });
    }
    return new Response("missing", { status: 404 });
  };
}

test("isAppPackage distinguishes app-only from full images", () => {
  assert.equal(isAppPackage(appImage()), true);
  assert.equal(isAppPackage(partitionFile()), false);
});

test("toBootImage keeps a full image untouched", async () => {
  const full = new Uint8Array(0x9000);
  full.set(partitionFile().subarray(0, 0x20), 0x8000);
  const result = await toBootImage(full);
  assert.equal(result.appPackage, false);
  assert.equal(result.firmware.byteLength, full.byteLength);
});

test("toBootImage leaves a populated full image untouched", async () => {
  const full = new Uint8Array(0x10000).fill(0xff);
  full.set(partitionFile().subarray(0, 0x60), 0x8000);
  full[0x9000] = 0x01;
  const result = await toBootImage(full, { fetchImpl: platformFetch() });
  assert.equal(result.appPackage, false);
  assert.equal(result.firmware.byteLength, full.byteLength);
  assert.equal(new Uint8Array(result.firmware)[0x9000], 0x01);
});

test("toBootImage seeds a blank NVS in a full image", async () => {
  const full = new Uint8Array(0x10000).fill(0xff);
  full.set(partitionFile().subarray(0, 0x60), 0x8000);
  const result = await toBootImage(full, { fetchImpl: platformFetch() });
  const bytes = new Uint8Array(result.firmware);
  assert.deepEqual([...bytes.subarray(0x9000, 0x9000 + SEED.byteLength)], [...SEED]);
});

test("Xiaozhi layouts seed nvs and preserve the preceding nvsfactory partition", async () => {
  const full = new Uint8Array(0x10000).fill(0xff);
  const table = partitionFile();
  table.fill(0, 12, 28);
  table.set(new TextEncoder().encode("nvsfactory"), 12);
  const view = new DataView(table.buffer);
  view.setUint32(8, 0x1000, true);
  view.setUint16(0x40, 0x50aa, true);
  table[0x42] = 1;
  table[0x43] = 2;
  view.setUint32(0x44, 0xa000, true);
  view.setUint32(0x48, 0x6000, true);
  table.fill(0, 0x4c, 0x5c);
  table.set(new TextEncoder().encode("nvs"), 0x4c);
  view.setUint16(0x60, 0xffff, true);
  full.set(table, 0x8000);
  const result = new Uint8Array((await toBootImage(full, { fetchImpl: platformFetch() })).firmware);
  assert.ok(result.subarray(0x9000, 0xa000).every((byte) => byte === 0xff));
  assert.deepEqual(result.subarray(0xa000, 0x10000), SEED);
  assert.ok(full.subarray(0xa000).every((byte) => byte === 0xff), "source firmware must stay unchanged");
  // A populated Wi-Fi partition must also be kept, even if factory is blank.
  full[0xa000] = 0xfe;
  const preserved = new Uint8Array((await toBootImage(full, { fetchImpl: platformFetch() })).firmware);
  assert.equal(preserved[0xa000], 0xfe);
  assert.ok(preserved.subarray(0x9000, 0xa000).every((byte) => byte === 0xff));
});

test("toBootImage wraps an app package with the platform bootloader and table", async () => {
  const app = appImage();
  const result = await toBootImage(app, { fetchImpl: platformFetch() });
  assert.equal(result.appPackage, true);
  const bytes = new Uint8Array(result.firmware);
  assert.equal(bytes[0], 0xe9);
  const partitions = parsePartitionTable(bytes);
  assert.equal(partitions[0].label, "nvs");
  assert.equal(partitions[1].label, "launcher");
  assert.equal(partitions[1].offset, 0x10000);
  const info = describeFirmware(bytes);
  assert.equal(info.app.project, "radio");
  assert.equal(info.app.offset, 0x10020);
});

test("toBootImage seeds a blank NVS with the virtual Wi-Fi credentials", async () => {
  const result = await toBootImage(appImage(), { fetchImpl: platformFetch() });
  const bytes = new Uint8Array(result.firmware);
  assert.deepEqual([...bytes.subarray(0x9000, 0x9000 + SEED.byteLength)], [...SEED]);
  assert.equal(bytes[0x8c00], 0xff);
  assert.equal(bytes[0x8fff], 0xff);
  const nvs = bytes.subarray(0x9000, 0xF000);
  assert.ok(nvs.some((byte) => byte !== 0xff));
  assert.ok(new TextDecoder().decode(nvs).includes("myssid"));
});

test("toBootImage reports a missing NVS seed asset", async () => {
  const fetchImpl = platformFetch();
  await assert.rejects(
    () => toBootImage(appImage(), {
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("nvs-seed.bin")) return new Response("missing", { status: 404 });
        return fetchImpl(input);
      },
    }),
    /nvs-seed\.bin/,
  );
});
