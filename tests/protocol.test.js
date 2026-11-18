import test from "node:test";
import assert from "node:assert/strict";
import {
  WIRE, bytesField, decodeAudio, decodeFrame, decodeLoad, encodeAudio, encodeFrame,
  encodeLoad, fields, i2sIn, numberField, parseI2sFormat, parseI2sOut, register, reply,
} from "../web/js/device/protocol.js";

test("protobuf fields round trip", () => {
  const bytes = Uint8Array.from([...numberField(1, 300), ...bytesField(2, Uint8Array.of(1, 2, 3))]);
  const value = fields(bytes);
  assert.equal(value[1], 300);
  assert.deepEqual([...value[2]], [1, 2, 3]);
});

test("registration carries display, touch, key and audio claims", () => {
  const value = fields(fields(register("peer"))[4]);
  assert.equal(value[1], 1);
  assert.equal(new TextDecoder().decode(value[2]), "peer");
  const audio = fields(fields(value[3])[17]);
  assert.equal(audio[1], 48);
  assert.equal(audio[2], 38);
  assert.equal(audio[3], 47);
  assert.equal(audio[4], 17);
});

test("bus reply shape", () => {
  const value = fields(fields(reply(7, 2, Uint8Array.of(9)))[8]);
  assert.equal(value[1], 7);
  assert.equal(value[2], 1);
  assert.deepEqual([...value[3]], [9]);
  assert.equal(value[4], 2);
});

test("i2s format and output", () => {
  const format = Uint8Array.from([
    ...numberField(1, 0), ...numberField(2, 16000), ...numberField(3, 2), ...numberField(4, 16),
  ]);
  assert.deepEqual(parseI2sFormat(format), { receive: false, rate: 16000, channels: 2, bits: 16 });
  const pcm = Uint8Array.of(1, 2, 3, 4);
  assert.deepEqual([...parseI2sOut(Uint8Array.from(bytesField(1, pcm)))], [1, 2, 3, 4]);
  const inbound = fields(i2sIn(pcm));
  assert.deepEqual([...fields(inbound[31])[1]], [1, 2, 3, 4]);
});

test("browser wire messages", () => {
  const firmware = Uint8Array.of(0xe9, 1, 2, 3);
  const loaded = decodeLoad(encodeLoad({ name: "a.bin", size: 4 }, firmware));
  assert.equal(loaded.json.name, "a.bin");
  assert.deepEqual([...loaded.firmware], [...firmware]);

  const audio = decodeAudio(encodeAudio({ rate: 16000, channels: 2, bits: 16, receive: false, pcm: Uint8Array.of(5, 6) }));
  assert.equal(audio.rate, 16000);
  assert.equal(audio.channels, 2);
  assert.equal(audio.receive, false);
  assert.deepEqual([...audio.pcm], [5, 6]);

  const frame = decodeFrame(encodeFrame(12, Uint8Array.of(7, 8)));
  assert.equal(frame.frame, 12);
  assert.deepEqual([...frame.transfer], [7, 8]);
  assert.equal(WIRE.FRAME, 1);
});
