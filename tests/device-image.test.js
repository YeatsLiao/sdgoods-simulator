import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parsePartitionTable } from "../web/js/device/firmware.js";
import { buildSlotImage, parseSlotLayout } from "../web/js/flash/device-image.js";
import { parseOtadata } from "../web/js/flash/otadata.js";

const PLATFORM_TABLE = new Uint8Array(
  readFileSync(new URL("../web/platform/partition-table.bin", import.meta.url)),
);

function appImage(size = 0x1000, project = "radio", version = "1.1.0") {
  const bytes = new Uint8Array(size);
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
  text(offset + 0x10, version, 32);
  text(offset + 0x30, project, 32);
  text(offset + 0x50, "12:00:00", 16);
  text(offset + 0x60, "Nov 18 2026", 16);
  text(offset + 0x70, "v5.5.5", 32);
  return bytes;
}

function fullImage() {
  const app = appImage(0x1000);
  const bytes = new Uint8Array(0x11000).fill(0x00);
  bytes[0] = 0xe9;
  new DataView(bytes.buffer).setUint16(12, 9, true);
  bytes.set(PLATFORM_TABLE.subarray(0, 0xc00), 0x8000);
  bytes.set(app, 0x10000);
  return bytes;
}

function partitionTable(entries) {
  const bytes = new Uint8Array(0xc00);
  const view = new DataView(bytes.buffer);
  entries.forEach((entry, index) => {
    const at = index * 0x20;
    view.setUint16(at, 0x50aa, true);
    bytes[at + 2] = entry.type;
    bytes[at + 3] = entry.subtype;
    view.setUint32(at + 4, entry.offset, true);
    view.setUint32(at + 8, entry.size, true);
    for (let i = 0; i < (entry.label ?? "").length; i++) {
      bytes[at + 12 + i] = entry.label.charCodeAt(i);
    }
  });
  const end = entries.length * 0x20;
  view.setUint16(end, 0xffff, true);
  return bytes;
}

const bootloader = Uint8Array.from([0xe9, 9, 2, 0x5f]);
const seed = Uint8Array.of(1, 2, 3, 4);

test("parseSlotLayout reads the official platform offsets and sizes", () => {
  const layout = parseSlotLayout(PLATFORM_TABLE);
  assert.equal(layout.nvs.offset, 0x9000);
  assert.equal(layout.nvs.size, 0x6000);
  assert.equal(layout.otadata.offset, 0x310000);
  assert.equal(layout.otadata.size, 0x2000);
  assert.deepEqual(layout.slots.map((slot) => slot.slotIndex), [0, 1, 2, 3]);
  assert.deepEqual(
    layout.slots.map((slot) => slot.offset),
    [0x320000, 0x620000, 0x920000, 0xc20000],
  );
  assert.ok(layout.slots.every((slot) => slot.size === 0x300000));
});

test("buildSlotImage places bootloader, table, NVS seed, app, and otadata", () => {
  const app = appImage(0x1000, "radio", "1.1.0");
  const built = buildSlotImage({
    bootloader,
    partitionTable: PLATFORM_TABLE,
    seed,
    apps: [{ slotIndex: 2, bytes: app }],
    selected: 2,
  });

  assert.equal(built.used, 0x920000 + app.byteLength);
  assert.equal(built.bytes[0], 0xe9);
  assert.deepEqual([...built.bytes.subarray(0x8000, 0x8000 + 0x20)],
    [...PLATFORM_TABLE.subarray(0, 0x20)]);
  assert.deepEqual([...built.bytes.subarray(0x9000, 0x9004)], [...seed]);
  assert.deepEqual([...built.bytes.subarray(0x920000, 0x920020)], [...app.subarray(0, 0x20)]);
  assert.equal(built.bytes[0x8fff], 0xff);
  assert.equal(built.bytes[0xf012], 0xff);

  const otadata = built.bytes.subarray(0x310000, 0x312000);
  assert.deepEqual(parseOtadata(otadata), {
    slotIndex: 2,
    otaSeq: 3,
    otaState: 0xffffffff,
    sector: 0,
  });
  for (let offset = 0x1000; offset < 0x2000; offset += 0x800) {
    assert.equal(otadata[offset], 0xff);
  }
  // The factory/launcher area stays erased: the launcher binary is not emulated.
  for (let offset = 0x10000; offset < 0x11000; offset += 0x1000) {
    assert.equal(built.bytes[offset], 0xff);
  }
});

test("buildSlotImage keeps multiple apps in their own slots", () => {
  const appA = appImage(0x1000, "radio");
  const appB = appImage(0x2000, "bambu");
  const built = buildSlotImage({
    bootloader,
    partitionTable: PLATFORM_TABLE,
    apps: [
      { slotIndex: 1, bytes: appB },
      { slotIndex: 0, bytes: appA },
    ],
    selected: 1,
  });
  assert.equal(built.used, 0x620000 + appB.byteLength);
  assert.deepEqual([...built.bytes.subarray(0x320000, 0x320004)], [...appA.subarray(0, 4)]);
  assert.deepEqual([...built.bytes.subarray(0x620000, 0x620004)], [...appB.subarray(0, 4)]);
  assert.equal(parseOtadata(built.bytes.subarray(0x310000, 0x312000)).slotIndex, 1);
});

test("buildSlotImage validates the selected slot and app packages", () => {
  const base = { bootloader, partitionTable: PLATFORM_TABLE, seed };
  assert.throws(() => buildSlotImage({ ...base, apps: [], selected: 0 }), /为空/);
  assert.throws(() => buildSlotImage({ ...base, apps: [{ slotIndex: 0, bytes: appImage() }] }), /selected/);
  assert.throws(
    () => buildSlotImage({ ...base, apps: [{ slotIndex: 4, bytes: appImage() }], selected: 4 }),
    /不在平台分区表/,
  );
  assert.throws(
    () => buildSlotImage({
      ...base,
      apps: [
        { slotIndex: 0, bytes: appImage() },
        { slotIndex: 0, bytes: appImage() },
      ],
      selected: 0,
    }),
    /重复/,
  );
  assert.throws(
    () => buildSlotImage({ ...base, apps: [{ slotIndex: 0, bytes: appImage(0x300001) }], selected: 0 }),
    /超过 ota_0 槽容量/,
  );
  assert.throws(
    () => buildSlotImage({ ...base, apps: [{ slotIndex: 0, bytes: fullImage() }], selected: 0 }),
    /纯 app 包/,
  );
  assert.throws(
    () => buildSlotImage({ ...base, apps: [{ slotIndex: 0, bytes: new Uint8Array(0) }], selected: 0 }),
    /为空/,
  );
  assert.throws(
    () => buildSlotImage({
      bootloader, partitionTable: PLATFORM_TABLE, apps: [{ slotIndex: 0, bytes: appImage() }], seed: new Uint8Array(0x6001), selected: 0,
    }),
    /NVS 分区小于/,
  );
});

test("buildSlotImage requires an otadata partition", () => {
  const table = partitionTable([
    { label: "nvs", type: 1, subtype: 2, offset: 0x9000, size: 0x6000 },
    { label: "ota_0", type: 0, subtype: 0x10, offset: 0x11000, size: 0x10000 },
  ]);
  assert.deepEqual(parsePartitionTable(table, 0).map((entry) => entry.label), ["nvs", "ota_0"]);
  assert.throws(
    () => buildSlotImage({ bootloader, partitionTable: table, apps: [{ slotIndex: 0, bytes: appImage() }], selected: 0 }),
    /otadata/,
  );
});

test("buildSlotImage rejects a bootloader without the ESP32 image header", () => {
  assert.throws(
    () => buildSlotImage({
      bootloader: Uint8Array.of(0, 1, 2),
      partitionTable: PLATFORM_TABLE,
      apps: [{ slotIndex: 0, bytes: appImage() }],
      selected: 0,
    }),
    /bootloader/,
  );
});