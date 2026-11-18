import test from "node:test";
import assert from "node:assert/strict";

import {
  encodeMic32,
  interleaveStereo,
  mixLevel,
  pcm16ToFloat32,
  pcm32ToFloat32,
  resampleLinear,
} from "../web/js/audio/codec.js";

function int16Bytes(values) {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setInt16(index * 2, value, true));
  return bytes;
}

function int32Bytes(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return bytes;
}

function unaligned(bytes, offset) {
  const buffer = new Uint8Array(bytes.length + offset);
  buffer.set(bytes, offset);
  return buffer.subarray(offset);
}

function approx(actual, expected, epsilon = 1e-7) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= epsilon,
      `sample ${i}: ${actual[i]} != ${expected[i]}`,
    );
  }
}

test("pcm16ToFloat32 decodes little-endian samples", () => {
  const bytes = int16Bytes([0, 1, -1, 32767, -32768]);
  approx(pcm16ToFloat32(bytes), [0, 1 / 32768, -1 / 32768, 32767 / 32768, -1]);
});

test("pcm16ToFloat32 accepts ArrayBuffer, offsets and trailing bytes", () => {
  const bytes = int16Bytes([100, -100]);
  approx(pcm16ToFloat32(unaligned(bytes, 3)), [100 / 32768, -100 / 32768]);
  approx(pcm16ToFloat32(Int16Array.from([256, -256])), [256 / 32768, -256 / 32768]);
  approx(pcm16ToFloat32(new Uint8Array(5)), [0, 0]);
});

test("pcm16ToFloat32 rejects non-buffer input", () => {
  assert.throws(() => pcm16ToFloat32("nope"), TypeError);
});

test("pcm32ToFloat32 normalizes by 2^31", () => {
  const bytes = int32Bytes([0, 1, -1, 1073741824, -1073741824, 2147483647, -2147483648]);
  approx(pcm32ToFloat32(bytes), [
    0,
    1 / 2147483648,
    -1 / 2147483648,
    0.5,
    -0.5,
    2147483647 / 2147483648,
    -1,
  ]);
});

test("pcm32ToFloat32 reads 16-bit samples shifted into the upper half", () => {
  const bytes = int32Bytes([12345 << 16, -12345 << 16]);
  approx(pcm32ToFloat32(unaligned(bytes, 1)), [12345 / 32768, -12345 / 32768]);
  approx(pcm32ToFloat32(new Uint8Array(13)), [0, 0, 0]);
});

test("resampleLinear returns the input when rates match", () => {
  const input = Float32Array.from([0.1, -0.25, 0.75]);
  const output = resampleLinear(input, 16000, 16000);
  assert.equal(output.length, input.length);
  assert.deepEqual(Array.from(output), Array.from(input));
});

test("resampleLinear upsamples with linear interpolation", () => {
  const output = resampleLinear(Float32Array.from([0, 1]), 16000, 32000);
  assert.equal(output.length, 4);
  approx(output, [0, 0.5, 1, 1]);
});

test("resampleLinear downsamples to the expected length", () => {
  const input = Float32Array.from([0, 1, 2, 3, 4, 5]);
  const output = resampleLinear(input, 48000, 16000);
  assert.equal(output.length, 2);
  approx(output, [0, 3]);
});

test("resampleLinear handles empty input", () => {
  assert.equal(resampleLinear(new Float32Array(0), 16000, 48000).length, 0);
  assert.throws(() => resampleLinear(new Float32Array(1), 0, 16000), RangeError);
});

test("interleaveStereo duplicates mono into both channels", () => {
  const output = interleaveStereo(Float32Array.from([0.1, -0.2]), 1);
  assert.equal(output.length, 4);
  approx(output, Float32Array.from([0.1, 0.1, -0.2, -0.2]));
});

test("interleaveStereo keeps stereo samples and copies the buffer", () => {
  const input = Float32Array.from([0.1, 0.2, -0.3, -0.4]);
  const output = interleaveStereo(input, 2);
  approx(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output.buffer, input.buffer);
});

// samplesPerChunk: 1 keeps every input sample so the value mapping can be
// checked directly; the default 320 drops anything that is not a full chunk.
test("encodeMic32 shifts 16-bit samples into the upper half", () => {
  const output = encodeMic32(Float32Array.from([-1, 1, 0, 0.5, -0.5]), { samplesPerChunk: 1 });
  assert.ok(output instanceof Int32Array);
  assert.deepEqual(
    Array.from(output),
    [-2147483648, 32767 << 16, 0, 16384 << 16, -16384 << 16],
  );
});

test("encodeMic32 saturates out-of-range values", () => {
  const output = encodeMic32(Float32Array.from([2, -2, 1.5, -1.5]), { samplesPerChunk: 1 });
  assert.deepEqual(
    Array.from(output),
    [32767 << 16, -32768 << 16, 32767 << 16, -32768 << 16],
  );
});

test("encodeMic32 rounds to the nearest 16-bit value", () => {
  const output = encodeMic32(Float32Array.from([0.1, -0.1]), { samplesPerChunk: 1 });
  // 0.1 * 32768 = 3276.8 rounds to 3277.
  assert.deepEqual(Array.from(output), [3277 << 16, -3277 << 16]);
});

test("encodeMic32 returns complete chunks only", () => {
  const input = new Float32Array(1000);
  input[0] = 0.5;
  input[999] = 1;
  const output = encodeMic32(input);
  assert.equal(output.length, 960);
  assert.equal(output[0], 16384 << 16);
  assert.equal(output[959], 0);
  assert.equal(encodeMic32(input, { samplesPerChunk: 160 }).length, 960);
  assert.equal(encodeMic32(input, { samplesPerChunk: 400 }).length, 800);
  assert.equal(encodeMic32(new Float32Array(0)).length, 0);
  assert.throws(() => encodeMic32(input, { samplesPerChunk: 0 }), RangeError);
});

test("encodeMic32 output decodes back through pcm32ToFloat32", () => {
  const original = Float32Array.from([0.25, -0.5, 0.125]);
  const encoded = encodeMic32(original, { samplesPerChunk: 1 });
  approx(pcm32ToFloat32(encoded), original);
  approx(pcm32ToFloat32(encoded.buffer), original);
});

test("mixLevel reports RMS clamped to 0..1", () => {
  assert.equal(mixLevel(new Float32Array(0)), 0);
  approx([mixLevel(Float32Array.from([0, 0]))], [0]);
  approx([mixLevel(Float32Array.from([0.5, -0.5]))], [0.5]);
  approx([mixLevel(Float32Array.from([1, -1]))], [1]);
  approx([mixLevel(Float32Array.from([2, -2]))], [1]);
});
