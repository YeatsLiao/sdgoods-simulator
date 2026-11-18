import test from "node:test";
import assert from "node:assert/strict";
import { assembleParts, assembleSingleApp } from "../web/js/flash/image.js";

test("assembleParts sorts segments, fills gaps with erased flash, and reports the used size", () => {
  const { bytes, used } = assembleParts([
    { address: 0x20, data: Uint8Array.of(7) },
    { address: 0, data: Uint8Array.of(1, 2, 3, 4) },
    { address: 0x10, data: Uint8Array.of(9, 9).buffer },
  ]);

  assert.equal(used, 0x21);
  assert.equal(bytes.length, 0x21);
  assert.deepEqual([...bytes.subarray(0, 4)], [1, 2, 3, 4]);
  assert.deepEqual([...bytes.subarray(0x10, 0x12)], [9, 9]);
  assert.deepEqual([...bytes.subarray(0x20, 0x21)], [7]);
  for (let offset = 4; offset < 0x10; offset++) assert.equal(bytes[offset], 0xff);
  for (let offset = 0x12; offset < 0x20; offset++) assert.equal(bytes[offset], 0xff);
});

test("assembleParts allows adjacent segments and empty parts", () => {
  const adjacent = assembleParts([
    { address: 0x100, data: new Uint8Array(8).fill(1) },
    { address: 0x108, data: Uint8Array.of(2) },
  ]);
  assert.equal(adjacent.used, 0x109);
  assert.equal(adjacent.bytes[0x108], 2);

  const empty = assembleParts([]);
  assert.equal(empty.used, 0);
  assert.equal(empty.bytes.length, 0);

  const onlyEmpty = assembleParts([{ address: 0x40, data: new Uint8Array(0) }]);
  assert.equal(onlyEmpty.used, 0);
  assert.equal(onlyEmpty.bytes.length, 0);
});

test("assembleParts rejects overlap", () => {
  assert.throws(() => assembleParts([
    { address: 0x100, data: new Uint8Array(8) },
    { address: 0x104, data: new Uint8Array(1) },
  ]), /overlap/i);
});

test("assembleParts rejects invalid addresses and sizes", () => {
  const part = (address, length = 1) => ({ address, data: new Uint8Array(length) });

  assert.throws(() => assembleParts([part(0x1ff, 2)], { maxSize: 0x200 }), /maxSize/i);
  assert.throws(() => assembleParts([part(-1)]), /address/i);
  assert.throws(() => assembleParts([part(0.5)]), /address/i);
  assert.throws(() => assembleParts([{ address: 0, data: "nope" }]), TypeError);
  assert.throws(() => assembleParts("nope"), TypeError);
  assert.throws(() => assembleParts([part(0)], { maxSize: -1 }), /maxSize/i);

  const exact = assembleParts([part(0x1fe, 2)], { maxSize: 0x200 });
  assert.equal(exact.used, 0x200);
});

test("assembleSingleApp places bootloader, partition table, and app", () => {
  const bootloader = Uint8Array.of(0xe9, 0x01, 0x02, 0x03);
  const partitionTable = Uint8Array.of(0xaa, 0x50, 0x01, 0x02);
  const app = Uint8Array.of(0xe9, 0x09, 0x08, 0x07);

  const { bytes, used } = assembleSingleApp({ bootloader, partitionTable, app });
  assert.equal(used, 0x10004);
  assert.equal(bytes.length, 0x10004);
  assert.deepEqual([...bytes.subarray(0, 4)], [...bootloader]);
  assert.deepEqual([...bytes.subarray(0x8000, 0x8004)], [...partitionTable]);
  assert.deepEqual([...bytes.subarray(0x10000, 0x10004)], [...app]);
  for (let offset = 0x8004; offset < 0x10000; offset += 0x1000) {
    assert.equal(bytes[offset], 0xff);
  }
});

test("assembleSingleApp honors a custom app offset and maxSize", () => {
  const result = assembleSingleApp({
    bootloader: Uint8Array.of(1),
    partitionTable: Uint8Array.of(2),
    app: Uint8Array.of(3, 4),
    offset: 0x20000,
    maxSize: 0x20002,
  });
  assert.equal(result.used, 0x20002);
  assert.deepEqual([...result.bytes.subarray(0x20000, 0x20002)], [3, 4]);
});

test("assembleSingleApp validates the offset, app size, and overlaps", () => {
  const base = {
    bootloader: Uint8Array.of(0xe9),
    partitionTable: Uint8Array.of(0xaa, 0x50),
    app: Uint8Array.of(0xe9),
  };

  assert.throws(() => assembleSingleApp({ ...base, offset: 0x8000 }), /0x10000/);
  assert.throws(() => assembleSingleApp({ ...base, offset: 0.5 }), /0x10000/);
  assert.throws(() => assembleSingleApp({ ...base, app: new Uint8Array(0) }), /empty/i);
  assert.throws(() => assembleSingleApp({ ...base, maxSize: 0x10000 }), /maxSize/i);
  assert.throws(
    () => assembleSingleApp({ ...base, partitionTable: new Uint8Array(0x8001) }),
    /overlap/i,
  );
});
