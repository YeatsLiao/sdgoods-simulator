import test from "node:test";
import assert from "node:assert/strict";

import {
  OTA_SECTOR_SIZE, buildOtadata, crc32Le, parseOtadata,
} from "../web/js/flash/otadata.js";

test("crc32Le matches the ESP-IDF esp_rom_crc32_le test vector", () => {
  const original = Uint8Array.from([
    0x01, 0x21, 0x09, 0xff, 0x63, 0x65, 0x72, 0x74, 0x69, 0x66, 0x69, 0x63, 0x61, 0x74,
    0x65, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe5, 0x00, 0xff, 0xff, 0x06, 0xba, 0xe7, 0xa1,
  ]);
  assert.equal(crc32Le(original), 0xd4dc5010);
  // esp_rom_crc32_le inverts in and out, so empty input returns ~0.
  assert.equal(crc32Le(new Uint8Array(0)), 0xffffffff);
});

test("buildOtadata writes an ota_seq record for the requested slot", () => {
  const bytes = buildOtadata(0);
  assert.equal(bytes.byteLength, OTA_SECTOR_SIZE);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 1);
  for (let offset = 4; offset < 24; offset++) assert.equal(bytes[offset], 0);
  assert.equal(view.getUint32(24, true), 0xffffffff);
  // bootloader_common_ota_select_crc CRCs the 4-byte ota_seq field only.
  assert.equal(view.getUint32(28, true), crc32Le(bytes.subarray(0, 4)));
  assert.equal(view.getUint32(28, true), 0x4743989a);
  assert.equal(bytes[32], 0xff);
  assert.equal(bytes[OTA_SECTOR_SIZE - 1], 0xff);

  assert.deepEqual(parseOtadata(bytes), {
    slotIndex: 0,
    otaSeq: 1,
    otaState: 0xffffffff,
    sector: 0,
  });
  assert.equal(parseOtadata(buildOtadata(3)).slotIndex, 3);
});

test("parseOtadata treats erased or corrupted records as factory boot", () => {
  assert.equal(parseOtadata(new Uint8Array(OTA_SECTOR_SIZE).fill(0xff)), null);
  const corrupted = buildOtadata(1);
  corrupted[28] ^= 0xff;
  assert.equal(parseOtadata(corrupted), null);
  assert.equal(parseOtadata(new Uint8Array(0)), null);
});

test("parseOtadata prefers the valid sector with the highest sequence", () => {
  const bytes = new Uint8Array(OTA_SECTOR_SIZE * 2).fill(0xff);
  bytes.set(buildOtadata(0), 0);
  bytes.set(buildOtadata(2), OTA_SECTOR_SIZE);
  assert.deepEqual(parseOtadata(bytes), {
    slotIndex: 2,
    otaSeq: 3,
    otaState: 0xffffffff,
    sector: 1,
  });

  const firstOnly = new Uint8Array(OTA_SECTOR_SIZE * 2).fill(0xff);
  firstOnly.set(buildOtadata(1), 0);
  assert.equal(parseOtadata(firstOnly).slotIndex, 1);
});

test("buildOtadata rejects invalid slots and sector sizes", () => {
  assert.throws(() => buildOtadata(-1), RangeError);
  assert.throws(() => buildOtadata(0.5), RangeError);
  assert.throws(() => buildOtadata(0, { sectorSize: 16 }), RangeError);
});