import test from "node:test";
import assert from "node:assert/strict";
import {
  describeFirmware,
  parseAppDescriptor,
  parsePartitionTable,
  sha256Hex,
} from "../web/js/device/firmware.js";

const encoder = new TextEncoder();

function writeText(bytes, offset, length, text) {
  const value = encoder.encode(text);
  if (value.length >= length) throw new Error(`text does not fit: ${text}`);
  bytes.set(value, offset);
}

function writeDescriptor(bytes, offset, values) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, 0xabcd5432, true);
  writeText(bytes, offset + 0x10, 32, values.version);
  writeText(bytes, offset + 0x30, 32, values.project);
  writeText(bytes, offset + 0x50, 16, values.time);
  writeText(bytes, offset + 0x60, 16, values.date);
  writeText(bytes, offset + 0x70, 32, values.idf);
}

function writePartition(bytes, offset, values) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes[offset] = 0xaa;
  bytes[offset + 1] = 0x50;
  bytes[offset + 2] = values.type;
  bytes[offset + 3] = values.subtype;
  view.setUint32(offset + 4, values.offset, true);
  view.setUint32(offset + 8, values.size, true);
  writeText(bytes, offset + 12, 16, values.label);
}

function writeTableEnd(bytes, offset) {
  bytes.fill(0xff, offset, offset + 0x20);
}

const DESCRIPTOR = {
  version: "0.1.1",
  project: "chiikawa-go",
  time: "22:22:41",
  date: "Nov 17 2026",
  idf: "v5.5.5",
};

test("sha256Hex hashes bytes in the browser and Node", async () => {
  assert.equal(
    await sha256Hex(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    await sha256Hex(encoder.encode("abc").buffer),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("parseAppDescriptor finds a descriptor in a merged image", () => {
  const image = new Uint8Array(0x9000);
  writeDescriptor(image, 0x20, DESCRIPTOR);

  assert.deepEqual(parseAppDescriptor(image), { ...DESCRIPTOR, offset: 0x20 });
  assert.deepEqual(parseAppDescriptor(image.buffer), { ...DESCRIPTOR, offset: 0x20 });
});

test("parseAppDescriptor skips garbage and keeps scanning", () => {
  const image = new Uint8Array(0x800);
  writeDescriptor(image, 0x20, DESCRIPTOR);
  image.fill(0xc3, 0x24, 0x24 + 0x90);
  new DataView(image.buffer).setUint32(0x20, 0xabcd5432, true);
  writeDescriptor(image, 0x200, { ...DESCRIPTOR, version: "2.0.0" });

  assert.equal(parseAppDescriptor(image).offset, 0x200);
  assert.equal(parseAppDescriptor(image).version, "2.0.0");
});

test("parseAppDescriptor requires null-terminated printable strings", () => {
  const image = new Uint8Array(0x200);
  writeDescriptor(image, 0x20, DESCRIPTOR);
  image.fill(0x41, 0x30, 0x50); // version field without a terminator
  assert.equal(parseAppDescriptor(image), null);

  const truncated = new Uint8Array(0x40);
  truncated.set(Uint8Array.of(0x32, 0x54, 0xcd, 0xab), 0x20);
  assert.equal(parseAppDescriptor(truncated), null);
  assert.equal(parseAppDescriptor(null), null);
});

test("parsePartitionTable reads entries until the 0xFFFF terminator", () => {
  const image = new Uint8Array(0x9000);
  writePartition(image, 0x8000, { label: "nvs", type: 1, subtype: 2, offset: 0x9000, size: 0x6000 });
  writePartition(image, 0x8020, { label: "otadata", type: 1, subtype: 0, offset: 0xe000, size: 0x2000 });
  writePartition(image, 0x8040, { label: "app0", type: 0, subtype: 0x10, offset: 0x10000, size: 0x300000 });
  writeTableEnd(image, 0x8060);
  writePartition(image, 0x8080, { label: "ignored", type: 9, subtype: 9, offset: 0, size: 0 });

  assert.deepEqual(parsePartitionTable(image), [
    { label: "nvs", type: 1, subtype: 2, offset: 0x9000, size: 0x6000 },
    { label: "otadata", type: 1, subtype: 0, offset: 0xe000, size: 0x2000 },
    { label: "app0", type: 0, subtype: 0x10, offset: 0x10000, size: 0x300000 },
  ]);
});

test("parsePartitionTable accepts a custom offset and malformed data", () => {
  const image = new Uint8Array(0x200);
  writePartition(image, 0x100, { label: "factory", type: 0, subtype: 0, offset: 0x10000, size: 0x400000 });
  writeTableEnd(image, 0x120);

  assert.deepEqual(parsePartitionTable(image, 0x100), [
    { label: "factory", type: 0, subtype: 0, offset: 0x10000, size: 0x400000 },
  ]);
  assert.deepEqual(parsePartitionTable(image), []);
  assert.deepEqual(parsePartitionTable(new Uint8Array(0x8010)), []);
  assert.deepEqual(parsePartitionTable(null), []);
});

test("describeFirmware combines metadata and tolerates malformed images", () => {
  const image = new Uint8Array(0x9000);
  writeDescriptor(image, 0x20, DESCRIPTOR);
  writePartition(image, 0x8000, { label: "factory", type: 0, subtype: 0, offset: 0x10000, size: 0x400000 });
  writeTableEnd(image, 0x8020);

  const info = describeFirmware(image);
  assert.equal(info.size, image.byteLength);
  assert.equal(info.error, null);
  assert.equal(info.app.offset, 0x20);
  assert.equal(info.app.project, "chiikawa-go");
  assert.equal(info.partitions.length, 1);
  assert.equal(info.partitions[0].label, "factory");

  const malformed = describeFirmware(new Uint8Array(12));
  assert.equal(malformed.size, 12);
  assert.equal(malformed.app, null);
  assert.deepEqual(malformed.partitions, []);
  assert.ok(malformed.error);

  assert.doesNotThrow(() => describeFirmware(null));
  assert.equal(describeFirmware(null).size, 0);
});
