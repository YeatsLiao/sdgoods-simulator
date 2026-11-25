import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMakeupGain,
  createResampler,
  encodeMic32,
  interleaveStereo,
  mixLevel,
  pcm16ToFloat32,
  pcm32ToFloat32,
  trackArrival,
} from "../web/js/audio/codec.js";
import { AudioEngine } from "../web/js/audio/engine.js";

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

// --- loudness makeup -------------------------------------------------------

const MAKEUP_RATE = 48000;

function tone(amplitude, length = 480, frequency = 100) {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / MAKEUP_RATE);
  }
  return samples;
}

function peak(samples) {
  let highest = 0;
  for (const value of samples) highest = Math.max(highest, Math.abs(value));
  return highest;
}

// Decoded music: a few loud transients per chunk over a quiet body, so the peak
// is several times the RMS. Fixed multipliers and peak gates both fail here.
function program(amplitude, length = 480, slowRate = 3) {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const envelope = 0.15 + 0.85 * Math.abs(Math.sin((2 * Math.PI * slowRate * i) / MAKEUP_RATE));
    samples[i] = Math.sin(i * 12.9898) * 43758.5453 % 1 * amplitude * envelope;
  }
  return samples;
}

test("applyMakeupGain lifts a quiet stream toward the target", () => {
  const state = { gain: 1 };
  let chunk;
  const gains = [];
  for (let i = 0; i < 60; i++) {
    chunk = tone(0.01);
    applyMakeupGain(chunk, state);
    gains.push(state.gain);
  }
  assert.ok(state.gain > 6, `gain ${state.gain}`);
  // The old fixed 3x left this signal around -30 dBFS; the target is audible.
  assert.ok(mixLevel(chunk) > 0.05, `rms ${mixLevel(chunk)}`);
  assert.ok(peak(chunk) <= 1);
  // Smoothed attack: never jumps straight to the ceiling, never oscillates.
  assert.ok(gains.every((value, i) => i === 0 || value >= gains[i - 1]));
  assert.ok(gains[0] < gains[9] && gains[9] < gains[59]);
});

// A chunk this loud has no business being boosted; the ceiling only bounds it.
test("applyMakeupGain leaves at-or-above-target signals near unity", () => {
  for (const amplitude of [0.2, 0.6, 0.9]) {
    const state = { gain: 1 };
    for (let i = 0; i < 60; i++) applyMakeupGain(tone(amplitude), state);
    assert.ok(state.gain <= 1.0001, `amplitude ${amplitude} gain ${state.gain}`);
  }
});

// The old gate keyed on peak < 0.05, which muted every program stream whose
// crest factor exceeded ~3 (peak 0.05 sits at RMS 0.017, well under target).
test("applyMakeupGain boosts high-crest program material toward the target", () => {
  // [amplitude, smallest lift that still counts as working]
  for (const [amplitude, minLift] of [[0.05, 6], [0.2, 3], [0.6, 1]]) {
    const state = { gain: 1, peak: 0 };
    let applied = 1;
    for (let i = 0; i < 400; i++) applied = applyMakeupGain(program(amplitude), state);
    const chunk = program(amplitude);
    const before = mixLevel(chunk);
    applyMakeupGain(chunk, state);
    const after = mixLevel(chunk);
    assert.ok(applied > 1.2, `amplitude ${amplitude} applied ${applied}`);
    // The target is unreachable for the quietest material: the ceiling, not the
    // cap, binds first, so the assertion is about the lift rather than the level.
    assert.ok(after >= before * minLift, `amplitude ${amplitude} ${before} -> ${after}`);
    assert.ok(after > 0.05, `amplitude ${amplitude} rms ${after}`);
    assert.ok(peak(chunk) <= 1);
  }
});

test("applyMakeupGain never pushes a sample past full scale", () => {
  const amplitudes = [0.001, 0.01, 0.05, 0.1, 0.3, 0.6, 0.95, 1];
  for (const amplitude of amplitudes) {
    const state = { gain: 1 };
    let highest = 0;
    for (let i = 0; i < 80; i++) {
      const chunk = new Float32Array(512);
      for (let j = 0; j < chunk.length; j++) {
        chunk[j] = (Math.random() * 2 - 1) * amplitude;
      }
      applyMakeupGain(chunk, state);
      highest = Math.max(highest, peak(chunk));
    }
    assert.ok(highest <= 1, `amplitude ${amplitude} peaked at ${highest}`);
  }
});

test("applyMakeupGain keeps unity on silence and recovers from a hot chunk", () => {
  const silent = { gain: 1 };
  for (let i = 0; i < 60; i++) applyMakeupGain(new Float32Array(480), silent);
  assert.equal(silent.gain, 1);

  const state = { gain: 1 };
  for (let i = 0; i < 60; i++) applyMakeupGain(tone(0.01), state);
  const boosted = state.gain;
  assert.ok(boosted > 6);
  // A sudden loud chunk is capped per chunk and the stored gain eases back down.
  let highest = 0;
  for (let i = 0; i < 60; i++) {
    const chunk = tone(0.9);
    applyMakeupGain(chunk, state);
    highest = Math.max(highest, peak(chunk));
  }
  assert.ok(highest <= 1);
  assert.ok(state.gain < boosted && state.gain >= 1);
});

test("applyMakeupGain ignores empty chunks", () => {
  const state = { gain: 4 };
  assert.equal(applyMakeupGain(new Float32Array(0), state), 4);
  assert.equal(state.gain, 4);
  const broken = { gain: Number.NaN };
  applyMakeupGain(tone(0.01), broken);
  assert.ok(broken.gain > 1);
});

// Underruns and muted streams emit digital silence. TARGET_RMS / rms is huge
// there, so without a floor the gain parks at the ceiling and the first sample
// back from silence jumps by that factor.
test("applyMakeupGain holds unity through digital silence", () => {
  for (const value of [0, 1e-9, -1e-9]) {
    const state = { gain: 1 };
    for (let i = 0; i < 300; i++) {
      applyMakeupGain(Float32Array.from({ length: 480 }, (_, index) => (index % 2 ? -value : value)), state);
    }
    assert.equal(state.gain, 1, `value ${value} gain ${state.gain}`);
  }
  // Silence carries no loudness estimate, so it must not lift the boost either.
  const boosted = { gain: 1 };
  for (let i = 0; i < 60; i++) applyMakeupGain(tone(0.01), boosted);
  const before = boosted.gain;
  let applied = 1;
  for (let i = 0; i < 5; i++) applied = applyMakeupGain(new Float32Array(480), boosted);
  assert.ok(applied <= before, `applied ${applied} above previous ${before}`);
  assert.ok(boosted.gain <= before, `stored ${boosted.gain} rose through silence`);
});

// A starved emulator interleaves silent chunks with program chunks. Falling to
// unity through the silence and climbing again per burst was audible pumping.
test("applyMakeupGain freezes the level through silent chunks", () => {
  const state = { gain: 1, peak: 0 };
  for (let i = 0; i < 100; i++) applyMakeupGain(tone(0.01), state);
  const before = state.gain;
  for (let i = 0; i < 30; i++) applyMakeupGain(new Float32Array(480), state);
  assert.equal(state.gain, before);
});

// Chunks arrive every ~5 ms, so a per-chunk peak ceiling made neighbouring
// chunks of the same material differ by several times and every seam clicked.
// A loud transient is allowed to pull the headroom down, but it must not make
// the quiet chunks around it swing.
test("applyMakeupGain holds one level across mixed chunk loudness", () => {
  const state = { gain: 1, peak: 0 };
  const gains = [];
  for (let i = 0; i < 200; i++) {
    gains.push(applyMakeupGain(i % 4 === 0 ? tone(0.2) : tone(0.01), state));
  }
  // After the attack settles, consecutive chunks may only move by the ceiling's
  // peak decay, not by the crest factor between the two kinds of chunk.
  const settled = gains.slice(120);
  const spread = Math.max(...settled) / Math.min(...settled);
  assert.ok(spread < 1.1, `settled spread ${spread}`);
  // The cap is the codec's MAX_MAKEUP; the applied gain may never pass it.
  assert.ok(Math.max(...gains) <= 16);
});

// mixLevel clamps RMS at 1, which would make TARGET_RMS / rms fall below unity
// and pull the stored gain down on material already louder than the target.
test("applyMakeupGain never pulls the stored gain below unity", () => {
  for (const build of [
    (chunk) => { chunk.fill(1); },
    (chunk) => { for (let i = 0; i < chunk.length; i++) chunk[i] = i % 2 ? 1.5 : -1.5; },
    (chunk) => { for (let i = 0; i < chunk.length; i++) chunk[i] = Math.sin(i / 9) * 0.6; },
  ]) {
    const state = { gain: 1 };
    for (let i = 0; i < 300; i++) {
      const chunk = new Float32Array(480);
      build(chunk);
      applyMakeupGain(chunk, state);
    }
    assert.ok(state.gain >= 1 && Number.isFinite(state.gain), `stored ${state.gain}`);
  }
});

// --- streaming resampler ---------------------------------------------------

function sawtooth(length, rate) {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = ((i % 97) / 97) * 2 - 1 + 0.2 * Math.sin((2 * Math.PI * 440 * i) / rate);
  }
  return samples;
}

function maxJump(samples) {
  let jump = 0;
  for (let i = 1; i < samples.length; i++) {
    jump = Math.max(jump, Math.abs(samples[i] - samples[i - 1]));
  }
  return jump;
}

function feed(resampler, source, sizes) {
  const parts = [];
  let offset = 0;
  for (const size of sizes) {
    parts.push(resampler(source.subarray(offset, offset + size)));
    offset += size;
  }
  const joined = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let written = 0;
  for (const part of parts) {
    joined.set(part, written);
    written += part.length;
  }
  return joined;
}

for (const [from, to] of [[48000, 44100], [16000, 48000]]) {
  test(`createResampler ${from}->${to} streams without seam discontinuities`, () => {
    const sizes = Array(Math.ceil((from * 0.5) / 240)).fill(240);
    const input = sawtooth(sizes.reduce((a, b) => a + b, 0), from);
    const single = createResampler(from, to)(input);
    const streamed = feed(createResampler(from, to), input, sizes);
    assert.equal(streamed.length, single.length);
    assert.ok(maxJump(streamed) <= maxJump(single) * 1.0001 + 1e-6);
    for (let i = 0; i < single.length; i++) {
      assert.ok(
        Math.abs(streamed[i] - single[i]) < 1e-6,
        `sample ${i}: ${streamed[i]} != ${single[i]}`,
      );
    }
    // Independent per-chunk resampling restarts the phase at every seam.
    const naive = sizes
      .reduce((accumulator, size) => {
        accumulator.parts.push(createResampler(from, to)(input.subarray(accumulator.offset, accumulator.offset + size)));
        accumulator.offset += size;
        return accumulator;
      }, { parts: [], offset: 0 })
      .parts;
    const naiveLength = naive.reduce((sum, part) => sum + part.length, 0);
    assert.notEqual(naiveLength, single.length);
  });
}

test("createResampler returns equal-rate input untouched", () => {
  const input = Float32Array.from([0.1, -0.25, 0.75]);
  const resampler = createResampler(16000, 16000);
  approx(resampler(input), input);
  // The engine writes makeup gain into the returned array, so an equal-rate
  // pass must not hand back the caller's own buffer.
  assert.notEqual(resampler(input), input);
});

// A chunk shorter than one output step cannot emit a sample every call; the
// phase has to carry over so the total still matches the rate ratio.
test("createResampler carries the phase through chunks shorter than one step", () => {
  const resampler = createResampler(48000, 16000); // step 3
  const lengths = [];
  for (let i = 0; i < 9; i++) lengths.push(resampler(Float32Array.from([0.5, 0.6])).length);
  assert.equal(lengths.reduce((a, b) => a + b, 0), 6); // 18 source samples / 3
  assert.deepEqual(lengths, [1, 1, 0, 1, 1, 0, 1, 1, 0]);
});

// Keeping the cursor relative to the previous chunk is what stops it from
// growing without bound in a long-running stream.
test("createResampler keeps its cursor bounded over a long run", () => {
  const resampler = createResampler(48000, 44100);
  const chunk = new Float32Array(480).fill(0.25);
  let produced = 0;
  for (let i = 0; i < 100000; i++) produced += resampler(chunk).length;
  // Exactly 100000 * 480 * 44100 / 48000 frames: no drift, no NaN.
  assert.equal(produced, 44100000);
  const tail = resampler(Float32Array.from({ length: 480 }, (_, index) => index / 480));
  assert.ok(tail.every((value) => Number.isFinite(value)));
});

test("createResampler handles empty chunks and invalid rates", () => {
  const resampler = createResampler(48000, 44100);
  assert.equal(resampler(new Float32Array(0)).length, 0);
  // A single sample is enough to emit the output that starts at position 0.
  assert.equal(resampler(Float32Array.from([0.5])).length, 1);
  const after = resampler(Float32Array.from([0.5, 0.6, 0.7]));
  assert.ok(after.length >= 2);
  assert.throws(() => createResampler(0, 44100), RangeError);
  assert.throws(() => createResampler(48000, -1), RangeError);
});

// --- arrival tracking ------------------------------------------------------

test("trackArrival reports audio seconds per wall-clock second", () => {
  const state = { started: Number.NaN, seconds: 0, ratio: null };
  assert.equal(state.ratio, null);
  // First window opens on the first chunk.
  assert.equal(trackArrival(state, 0.005, 1000), null);
  assert.ok(Number.isFinite(state.started));
  for (let time = 1000; time <= 2000; time += 50) trackArrival(state, 0.0075, time);
  assert.ok(Math.abs(state.ratio - 0.15) < 0.02, `ratio ${state.ratio}`);
  // Later windows are normalised to their own one second of wall time.
  for (let time = 2000; time <= 4000; time += 50) trackArrival(state, 0.05, time);
  assert.ok(Math.abs(state.ratio - 1) < 0.02, `ratio ${state.ratio}`);
});

test("trackArrival keeps the last ratio inside an unfinished window", () => {
  const state = { started: Number.NaN, seconds: 0, ratio: null };
  for (let time = 0; time <= 1500; time += 20) trackArrival(state, 0.001, time);
  const settled = state.ratio;
  assert.ok(settled > 0);
  trackArrival(state, 0.001, 1520);
  assert.equal(state.ratio, settled);
});

test("trackArrival ignores non-finite and negative durations", () => {
  const state = { started: Number.NaN, seconds: 0, ratio: null };
  trackArrival(state, Number.NaN, 0);
  trackArrival(state, -5, 0);
  assert.equal(state.seconds, 0);
});

// Clock going backwards must not publish a ratio for an unfinished window.
test("trackArrival survives a non-advancing clock", () => {
  const state = { started: Number.NaN, seconds: 0, ratio: null };
  trackArrival(state, 0.5, 5000);
  assert.equal(trackArrival(state, 0.5, 4000), null);
  assert.ok(state.seconds > 0);
  // The same instant repeated accumulates audio but never closes a window.
  for (let i = 0; i < 20; i++) assert.equal(trackArrival(state, 0.5, 4000), null);
});

// --- engine playback -------------------------------------------------------
// Minimal Web Audio stand-in: just enough surface for init() to succeed in
// Node, so play() can be driven and its postMessage payloads asserted.

class FakePort {
  constructor() {
    this.messages = [];
  }

  postMessage(message) {
    // Copy before returning: the transferred buffer is detached right after,
    // exactly as structured clone behaves in a browser.
    this.messages.push({
      ...message,
      samples: message.samples ? Float32Array.from(message.samples) : undefined,
    });
  }

  close() {}

  get last() {
    return this.messages[this.messages.length - 1];
  }
}

const stubContexts = [];

function fakeContext(sampleRate) {
  const gainNode = {
    value: 0,
    setTargetAtTime(value) {
      gainNode.value = value;
    },
  };
  const sources = [];
  return {
    sampleRate,
    state: "suspended",
    destination: {},
    currentTime: 0,
    audioWorklet: { addModule: async () => {} },
    resume: async () => {},
    close: async () => {},
    createGain: () => ({ gain: gainNode, connect() {}, disconnect() {} }),
    createMediaStreamDestination: () => ({ stream: {}, disconnect() {} }),
    sources,
    createBuffer: (channels, frames, rate) => {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      return {
        length: frames,
        sampleRate: rate,
        duration: frames / rate,
        getChannelData: (index) => data[index],
      };
    },
    createBufferSource: () => {
      const node = {
        buffer: null,
        started: 0,
        stopped: 0,
        when: null,
        onended: null,
        connect() {},
        disconnect() {},
        start(when = 0) {
          node.started += 1;
          node.when = when;
        },
        stop() {
          node.stopped += 1;
        },
      };
      sources.push(node);
      return node;
    },
  };
}

/** @param {{sampleRate?: number}} [options] @returns {Promise<{engine: AudioEngine, ports: FakePort[]}>} */
async function readyEngine({ sampleRate = 48000 } = {}) {
  const ports = installAudioStub(sampleRate);
  const engine = new AudioEngine();
  assert.equal(await engine.init(), true);
  return { engine, ports };
}

// engine.js calls `new AudioContext()` and `new AudioWorkletNode(...)`, so both
// stubs have to be constructor functions.
function installAudioStub(sampleRate) {
  const ports = [];
  globalThis.AudioContext = function StubAudioContext() {
    Object.assign(this, fakeContext(sampleRate));
    stubContexts.push(this);
  };
  globalThis.AudioWorkletNode = function StubWorkletNode() {
    const port = new FakePort();
    ports.push(port);
    this.port = port;
    this.connect = () => {};
    this.disconnect = () => {};
  };
  return ports;
}

function int16BytesFor(values) {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setInt16(index * 2, value, true));
  return bytes;
}

test("AudioEngine.play returns false before init and for the mic direction", async () => {
  const engine = new AudioEngine();
  assert.equal(engine.ready, false);
  assert.equal(engine.play(int16BytesFor([1, 2, 3]), { rate: 48000 }), false);
  const { engine: live } = await readyEngine();
  assert.equal(live.play(int16BytesFor([1, 2, 3]), { receive: true }), false);
});

test("AudioEngine.play sends stereo float frames to the worklet", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 48000 });
  // Same rate as the context, so the resampler is an identity pass-through.
  const pcm = int16BytesFor([0, 8192, 0, -8192, 0, 16384]);
  assert.equal(engine.play(pcm, { rate: 48000, channels: 2, bits: 16 }), true);
  const message = ports[ports.length - 1].last;
  assert.equal(message.channels, 2);
  assert.ok(message.samples instanceof Float32Array);
  assert.equal(message.samples.length, 6);
  approx(
    Float32Array.from(message.samples.slice(0, 4), (value) => Math.round(value * 1e5) / 1e5),
    Float32Array.from([0, 0.25, 0, -0.25]),
    1e-4,
  );
});

test("AudioEngine captures device audio and replays it as one continuous buffer", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 48000 });
  const context = stubContexts[stubContexts.length - 1];
  const port = ports[ports.length - 1];
  // One 10 ms stereo chunk at the context rate.
  const chunk = () => int16BytesFor(Array.from({ length: 960 }, (_, i) => (i % 2 ? 8192 : -8192)));
  const send = () => engine.play(chunk(), { rate: 48000, channels: 2, bits: 16 });

  assert.equal(engine.capture.active, false);
  assert.equal(await engine.startCapture(1), true);
  assert.equal(engine.capture.target, 1);
  for (let i = 0; i < 50; i++) assert.equal(send(), true);
  assert.equal(
    port.messages.filter((message) => message.samples).length,
    0,
    "captured audio must not also feed the live ring",
  );
  assert.deepEqual(
    port.messages.filter((message) => message.type === "live").map((message) => message.on),
    [false],
    "the ring is parked for the whole capture",
  );
  assert.ok(Math.abs(engine.capture.seconds - 0.5) < 1e-6, `seconds=${engine.capture.seconds}`);
  assert.equal(engine.capture.active, true, "the target is not reached yet");

  for (let i = 0; i < 50; i++) send();
  assert.equal(engine.capture.active, false, "reaching the target plays the cache");
  assert.equal(context.sources.length, 1);
  const [source] = context.sources;
  assert.equal(source.started, 1);
  assert.equal(source.buffer.sampleRate, 48000);
  assert.ok(Math.abs(source.buffer.duration - 1) < 1e-6, `duration=${source.buffer.duration}`);
  const leftData = source.buffer.getChannelData(0);
  const rightData = source.buffer.getChannelData(1);
  assert.equal(Math.abs(leftData[0]), 0, "the phrase opens on a ramp instead of a click");
  assert.equal(Math.abs(leftData[leftData.length - 1]), 0, "and closes on one");
  assert.ok(leftData.slice(240, -240).every((value) => Math.abs(value) === 0.25));
  assert.ok(rightData.slice(240, -240).every((value) => Math.abs(value) === 0.25));

  // Stopping early plays the partial cache and hands the device back to live output.
  assert.equal(await engine.startCapture(30), true);
  send();
  assert.ok(Math.abs(engine.playCapture() - 0.01) < 1e-6);
  assert.equal(context.sources.length, 2);
  assert.equal(engine.capture.active, false);
  send();
  assert.ok(port.last.samples, "live playback resumes after the replay");
});

test("AudioEngine auto replay chains phrases and keeps the next one caching", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 48000 });
  const context = stubContexts[stubContexts.length - 1];
  const port = ports[ports.length - 1];
  const chunk = () => int16BytesFor(Array.from({ length: 960 }, (_, i) => (i % 2 ? 8192 : -8192)));
  const send = () => engine.play(chunk(), { rate: 48000, channels: 2, bits: 16 });
  const liveMessages = () => port.messages.filter((m) => m.type === "live").map((m) => m.on);

  assert.deepEqual(engine.setAutoReplay({ enabled: true, target: 1 }), { enabled: true, target: 1 });
  assert.equal(engine.capture.active, false, "nothing is cached before the device speaks");
  for (let i = 0; i < 100; i++) send();
  assert.equal(context.sources.length, 1, "the first full phrase plays by itself");
  assert.equal(engine.capture.active, true, "auto mode re-arms while the phrase plays");
  assert.equal(engine.replay.active, true);
  assert.ok(Math.abs(engine.replay.remaining - 1) < 1e-6);
  assert.equal(port.messages.filter((m) => m.samples).length, 0);
  assert.deepEqual(liveMessages(), [false]);

  // A second phrase completes before the first ends: it must start at its tail.
  for (let i = 0; i < 100; i++) send();
  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[1].when, 1, "chained onto the previous phrase, no gap");
  assert.ok(Math.abs(engine.replay.remaining - 2) < 1e-6);

  // The meters describe what the listener hears, not the parked ring.
  const levels = engine.levels;
  // 0.25 minus the two 5 ms edge ramps.
  assert.ok(Math.abs(levels.outRms - 0.25) < 0.002, `rms=${levels.outRms}`);
  assert.equal(levels.outQueued, Math.round(levels.replay.remaining * 48000));
  assert.equal(levels.replay.seconds, 1);

  context.currentTime = 2.5;
  assert.equal(engine.replay.active, false, "the tail passes and the phrase is over");
  assert.equal(engine.levels.outRms, 0);
  assert.deepEqual(engine.setAutoReplay({ enabled: false }), { enabled: false, target: 1 });
  assert.equal(engine.capture.active, false, "turning auto off drops the partial cache");
  send();
  assert.ok(port.last.samples, "the device goes back to the live ring");
  assert.deepEqual(liveMessages(), [false, true]);
});

test("AudioEngine.flush stops a playing phrase and releases its source", async () => {
  const { engine } = await readyEngine({ sampleRate: 48000 });
  const context = stubContexts[stubContexts.length - 1];
  engine.setAutoReplay({ enabled: true, target: 1 });
  const chunk = () => int16BytesFor(Array.from({ length: 960 }, (_, i) => (i % 2 ? 8192 : -8192)));
  for (let i = 0; i < 100; i++) engine.play(chunk(), { rate: 48000, channels: 2, bits: 16 });
  const [source] = context.sources;
  assert.equal(engine.replay.active, true);
  engine.flush();
  assert.equal(source.stopped, 1, "a restart must not keep playing the old phrase");
  assert.equal(source.onended, null);
  assert.equal(engine.replay.active, false);
  assert.equal(engine.capture.active, false);
});

test("AudioEngine.capture clamps the target and flush drops a partial cache", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 48000 });
  const context = stubContexts[stubContexts.length - 1];
  const port = ports[ports.length - 1];
  assert.equal(await engine.startCapture(0.2), true);
  assert.equal(engine.capture.target, 1, "the target never drops below one second");
  await engine.startCapture(999);
  assert.equal(engine.capture.target, 30, "nor grows past thirty seconds");
  engine.play(int16BytesFor([0, 8192, 0, -8192]), { rate: 48000, channels: 2, bits: 16 });
  assert.ok(engine.capture.seconds > 0);
  engine.flush();
  assert.equal(engine.capture.active, false);
  assert.equal(engine.playCapture(), 0);
  assert.equal(context.sources.length, 0, "a flushed cache plays nothing");
  engine.play(int16BytesFor([0, 8192, 0, -8192]), { rate: 48000, channels: 2, bits: 16 });
  assert.equal(port.last.samples.length, 4, "the device goes back to live output");
});

test("AudioEngine.play duplicates mono into both speaker channels", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 16000 });
  const ok = engine.play(int16BytesFor([8192, -8192, 16384]), { rate: 16000, channels: 1 });
  assert.equal(ok, true);
  const samples = ports[ports.length - 1].last.samples;
  assert.equal(samples.length, 6);
  for (let i = 0; i < 3; i++) assert.equal(samples[i * 2], samples[i * 2 + 1]);
});

// The device can report a wider container; only the first two channels reach
// the speaker, and each keeps its own resampler phase.
test("AudioEngine.play uses the first two of four channels", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 48000 });
  const frames = 200;
  const values = [];
  for (let i = 0; i < frames; i++) values.push(4000, 8000, 12000, 16000);
  assert.equal(engine.play(int16BytesFor(values), { rate: 48000, channels: 4 }), true);
  const samples = ports[ports.length - 1].last.samples;
  assert.equal(samples.length, frames * 2);
  const ratio = samples[1] / samples[0];
  assert.ok(ratio > 1.5 && ratio < 2.5, `channel ratio ${ratio}`);
});

test("AudioEngine.play decodes 32-bit containers", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 48000 });
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 1073741824, true);
  view.setInt32(4, -536870912, true);
  assert.equal(engine.play(bytes, { rate: 48000, channels: 2, bits: 32 }), true);
  const samples = ports[ports.length - 1].last.samples;
  assert.equal(samples.length, 2);
  approx(Float32Array.from(samples), Float32Array.from([0.5, -0.25]), 1e-6);
});

test("AudioEngine.play ignores empty payloads without posting", async () => {
  const { engine, ports } = await readyEngine();
  const port = ports[ports.length - 1];
  const before = port.messages.length;
  assert.equal(engine.play(new Uint8Array(0), { rate: 48000 }), true);
  // Half a 16-bit sample decodes to nothing.
  assert.equal(engine.play(new Uint8Array(1), { rate: 48000 }), true);
  assert.equal(port.messages.length, before);
});

test("AudioEngine.play falls back to 16 kHz stereo on missing format fields", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 16000 });
  assert.equal(engine.play(int16BytesFor([1000, 2000, 3000, 4000]), undefined), true);
  assert.equal(ports[ports.length - 1].last.samples.length, 4);
});

// Resampling plus makeup gain is the actual radio path: 48 kHz program audio
// into a 44.1 kHz context must not clip and must settle near the loudness target.
test("AudioEngine.play resamples across chunk seams and never clips", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 44100 });
  const port = ports[ports.length - 1];
  const frames = 240;
  let highest = 0;
  let total = 0;
  for (let chunk = 0; chunk < 120; chunk++) {
    const values = [];
    for (let i = 0; i < frames; i++) {
      const t = chunk * frames + i;
      const left = Math.round(300 * Math.sin((2 * Math.PI * 440 * t) / 48000));
      values.push(left, -left);
    }
    assert.equal(engine.play(int16BytesFor(values), { rate: 48000, channels: 2 }), true);
    const samples = port.last.samples;
    total += samples.length / 2;
    for (const value of samples) highest = Math.max(highest, Math.abs(value));
  }
  assert.ok(highest <= 1, `peak ${highest}`);
  // Output length tracks 44100/48000 over the whole run instead of losing
  // samples at every chunk boundary.
  const expected = 120 * frames * (44100 / 48000);
  assert.ok(Math.abs(total - expected) < expected * 0.02, `frames ${total} vs ${expected}`);
  assert.ok(engine.levels.makeup > 1, `makeup ${engine.levels.makeup}`);
});

// Decoded music sits far below the target in RMS while its peaks stay modest,
// which is exactly where the old peak gate left the stream unboosted.
test("AudioEngine.play lifts high-crest program audio toward the target", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 48000 });
  const port = ports[ports.length - 1];
  const chunk = () => {
    const values = [];
    for (let i = 0; i < 480; i++) {
      const envelope = 0.15 + 0.85 * Math.abs(Math.sin((2 * Math.PI * 3 * i) / 48000));
      const sample = 0.05 * envelope * (Math.sin(i * 12.9898) * 43758.5453 % 1);
      values.push(Math.round(sample * 32767), Math.round(-sample * 32767));
    }
    return int16BytesFor(values);
  };
  engine.play(chunk(), { rate: 48000, channels: 2 });
  const first = mixLevel(port.last.samples);
  let highest = 0;
  for (let i = 0; i < 200; i++) {
    engine.play(chunk(), { rate: 48000, channels: 2 });
    for (const value of port.last.samples) highest = Math.max(highest, Math.abs(value));
  }
  const settled = mixLevel(port.last.samples);
  assert.ok(settled > 0.05, `settled rms ${settled}`);
  assert.ok(settled > first * 4, `first ${first} settled ${settled}`);
  assert.ok(highest <= 1, `peak ${highest}`);
});

test("AudioEngine.play rebuilds resamplers when the format changes", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 48000 });
  const port = ports[ports.length - 1];
  const run = (rate, frames) => {
    const values = [];
    for (let i = 0; i < frames * 2; i++) values.push(Math.round(2000 * Math.sin(i / 11)));
    engine.play(int16BytesFor(values), { rate, channels: 2 });
    return port.last.samples.length / 2;
  };
  run(48000, 240);
  assert.equal(port.last.samples.length / 2, 240);
  // A fresh resampler starts at phase 0 and cannot emit an output that needs a
  // sample from the next chunk, so the first block lands just under the ratio.
  const firstBlock = run(16000, 100);
  assert.ok(firstBlock >= 298 && firstBlock <= 300, `first upsampled block ${firstBlock}`);
  const secondBlock = run(16000, 100);
  assert.ok(secondBlock >= 300 && secondBlock <= 302, `second upsampled block ${secondBlock}`);
  run(48000, 240);
  assert.equal(port.last.samples.length / 2, 240);
});

test("AudioEngine.flush resets makeup, arrival and resampler state", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 48000 });
  const port = ports[ports.length - 1];
  const quiet = () => {
    const values = [];
    for (let i = 0; i < 480; i++) values.push(Math.round(150 * Math.sin(i / 7)), Math.round(150 * Math.cos(i / 5)));
    return int16BytesFor(values);
  };
  for (let i = 0; i < 80; i++) engine.play(quiet(), { rate: 48000, channels: 2 });
  const boosted = engine.levels.makeup;
  assert.ok(boosted > 2, `makeup ${boosted}`);

  engine.flush();
  assert.equal(engine.levels.makeup, 1);
  assert.equal(engine.levels.audioRatio, null);
  assert.equal(port.messages.at(-1).type, "flush");
  assert.equal(port.messages.at(-1).samples, undefined);

  // After flush the boost restarts from unity instead of inheriting the level,
  // easing back at the attack rate rather than snapping to the ceiling.
  engine.play(quiet(), { rate: 48000, channels: 2 });
  const restarted = engine.levels.makeup;
  assert.ok(restarted < boosted, `restarted ${restarted} vs boosted ${boosted}`);
  assert.ok(restarted >= 1, `restarted ${restarted}`);
  assert.ok(mixLevel(port.last.samples) > 0, "post-flush chunk still audible");
});

test("AudioEngine.close releases state and play stops accepting audio", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 48000 });
  const port = ports[ports.length - 1];
  const quiet = Float32Array.from({ length: 960 }, (_, i) => 0.004 * Math.sin(i / 7));
  const values = [];
  for (const sample of quiet) values.push(Math.round(sample * 32768));
  for (let i = 0; i < 80; i++) engine.play(int16BytesFor(values), { rate: 48000, channels: 2 });
  assert.ok(engine.levels.makeup > 2);
  await engine.close();
  assert.equal(engine.ready, false);
  assert.equal(engine.sampleRate, 0);
  assert.equal(engine.levels.makeup, 1);
  assert.equal(engine.levels.audioRatio, null);
  assert.equal(engine.play(int16BytesFor(values), { rate: 48000, channels: 2 }), false);
  assert.equal(port.messages.filter((message) => message.samples).length, 80);
});

// Installs a worklet stub whose port runs `onMessage` instead of queueing, for
// assertions about the transfer list and about port failures.
async function engineWithPort(onMessage) {
  globalThis.AudioContext = function StubAudioContext() {
    Object.assign(this, fakeContext(48000));
  };
  globalThis.AudioWorkletNode = function StubWorkletNode() {
    this.port = { postMessage: onMessage, close() {} };
    this.connect = () => {};
    this.disconnect = () => {};
  };
  const engine = new AudioEngine();
  assert.equal(await engine.init(), true);
  return engine;
}

// A real transfer detaches the buffer, so anything reading it afterwards would
// send silence to the speaker. The stub keeps the buffer alive and records the
// list instead.
test("AudioEngine.play transfers the sample buffer to the worklet", async () => {
  const transfers = [];
  const engine = await engineWithPort((message, transfer) => {
    if (message.samples) transfers.push({ transfer, buffer: message.samples.buffer });
  });
  engine.play(int16BytesFor([1000, 2000, 3000, 4000]), { rate: 48000, channels: 2 });
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].transfer.length, 1);
  // The whole payload is handed over as a transferable, not copied.
  assert.equal(transfers[0].transfer[0], transfers[0].buffer);
});

test("AudioEngine.play keeps working when the worklet port fails", async () => {
  let failing = false;
  const engine = await engineWithPort(() => {
    if (failing) throw new Error("port closed");
  });
  const pcm = int16BytesFor([1000, 2000, 3000, 4000]);
  assert.equal(engine.play(pcm, { rate: 48000, channels: 2 }), true);
  failing = true;
  // A per-chunk failure must not be rethrown into the device event handler.
  assert.equal(engine.play(pcm, { rate: 48000, channels: 2 }), false);
  assert.equal(engine.play(pcm, { rate: 48000, channels: 2 }), false);
});

// --- speaker worklet -------------------------------------------------------

let speakerProcessor = null;

async function loadSpeakerProcessor() {
  if (speakerProcessor) return speakerProcessor;
  const registered = {};
  class FakePort {
    constructor() {
      this.messages = [];
      this.onmessage = null;
    }

    postMessage(message) {
      this.messages.push(message);
    }
  }
  // worklet.js targets the AudioWorklet global scope and reads sampleRate as a
  // free variable when a processor is constructed, so stubbing the scope before
  // the first import lets Node drive the real ring buffer.
  globalThis.sampleRate = 48000;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = new FakePort();
    }
  };
  globalThis.registerProcessor = (name, processor) => {
    registered[name] = processor;
  };
  await import("../web/js/audio/worklet.js");
  speakerProcessor = registered["speaker-processor"];
  return speakerProcessor;
}

test("interactive speaker drops stale bursts and bounds adaptive preroll", async () => {
  const Speaker = await loadSpeakerProcessor();
  const processor = new Speaker();
  const send = (message) => processor.port.onmessage({ data: message });
  send({ type: "latency", mode: "interactive" });
  const samples = new Float32Array(48000 * 2).fill(0.5);
  send({ samples, channels: 2 });
  for (let i = 0; i < 40; i++) processor.process([], [[new Float32Array(128), new Float32Array(128)]]);
  let report = processor.port.messages.filter((m) => m.type === "level").at(-1);
  assert.ok(report.queued <= 48000 * 0.12);
  assert.ok(report.dropped >= 48000 * 0.88);
  for (let burst = 0; burst < 8; burst++) {
    send({ samples: new Float32Array(4800 * 2).fill(0.4), channels: 2 });
    for (let i = 0; i < 80; i++) processor.process([], [[new Float32Array(128), new Float32Array(128)]]);
  }
  report = processor.port.messages.filter((m) => m.type === "level").at(-1);
  assert.ok(report.prerollMs <= 80, `preroll ${report.prerollMs} ms`);
});

test("switching from chained replay to live stops every scheduled phrase immediately", async () => {
  const { engine, ports } = await readyEngine({ sampleRate: 48000 });
  const context = stubContexts.at(-1);
  engine.setAutoReplay({ enabled: true, target: 1 });
  const chunk = int16BytesFor(Array.from({ length: 960 }, (_, i) => i % 2 ? 8192 : -8192));
  for (let i = 0; i < 200; i++) engine.play(chunk, { rate: 48000, channels: 2, bits: 16 });
  assert.equal(context.sources.length, 2);
  engine.setAutoReplay({ enabled: false });
  assert.ok(context.sources.every((source) => source.stopped === 1 && source.onended === null));
  assert.equal(engine.replay.active, false);
  assert.equal(engine.capture.active, false);
  assert.equal(ports.at(-1).last.type, "latency");
  assert.equal(ports.at(-1).last.mode, "interactive");
});

test("speaker ring parks without counting underruns while a replay owns the output", async () => {
  const Speaker = await loadSpeakerProcessor();
  const processor = new Speaker();
  const frames = 128;
  const render = () => {
    const channels = [new Float32Array(frames), new Float32Array(frames)];
    processor.process([], [channels]);
    let loudest = 0;
    for (const channel of channels) {
      for (const value of channel) loudest = Math.max(loudest, Math.abs(value));
    }
    return loudest;
  };
  const prime = () => processor.port.onmessage({
    data: {
      samples: Float32Array.from({ length: 12 * 480 }, (_, i) => (i % 2 ? -0.5 : 0.5)),
      channels: 2,
    },
  });
  const levels = () => processor.port.messages.filter((m) => m.type === "level").at(-1);

  prime();
  assert.ok(render() > 0);
  processor.port.onmessage({ data: { type: "live", on: false } });
  // 120 quanta is 0.32 s: past the straddling 100 ms window, so the last report
  // covers parked output only.
  for (let i = 0; i < 120; i++) assert.equal(render(), 0, "a parked ring outputs silence");
  const parked = levels();
  assert.equal(parked.underruns, 0, "silence by design is not an underrun");
  assert.equal(parked.rms, 0);
  assert.equal(parked.queued, 0);

  processor.port.onmessage({ data: { type: "live", on: true } });
  prime();
  assert.ok(render() > 0, "live playback resumes once the replay is done");
});

test("speaker pre-roll gates bursts and grows while the emulator starves", async () => {
  const Speaker = await loadSpeakerProcessor();
  const processor = new Speaker();
  const frames = 128;
  // 60 ms of pre-roll at the stubbed 48 kHz, in 240-frame (5 ms) emulator chunks.
  const PREROLL_CHUNKS = 12;
  const send = (count) => processor.port.onmessage({
    data: {
      samples: Float32Array.from({ length: count * 480 }, (_, index) => (index % 2 ? -0.5 : 0.5)),
      channels: 2,
    },
  });
  const render = () => {
    // AudioWorklet hands process() outputs[outputIndex][channelIndex].
    const channels = [new Float32Array(frames), new Float32Array(frames)];
    processor.process([], [channels]);
    let loudest = 0;
    for (const channel of channels) {
      for (const value of channel) loudest = Math.max(loudest, Math.abs(value));
    }
    return loudest;
  };
  const tick = (quanta) => {
    for (let i = 0; i < quanta; i++) render();
  };
  const gaps = () => processor.port.messages.filter((m) => m.type === "level").at(-1)?.underruns;

  // One 5 ms chunk is below even the smallest pre-roll: it must not start a burst.
  send(1);
  assert.equal(render(), 0, "one short chunk stays behind the pre-roll");

  // A backlog over the floor plays, and draining it counts as one gap rather
  // than one underrun per render quantum. 45 quanta cover the drain, the fade
  // out and the 100 ms level report that carries the count.
  send(PREROLL_CHUNKS);
  assert.ok(render() > 0, "a backlog past the pre-roll plays");
  tick(45);
  assert.equal(gaps(), 1, `gaps ${gaps()}`);
  assert.equal(render(), 0, "stays silent until re-primed");

  // The gap doubles the pre-roll, so the same backlog that just played is now
  // held back, and a starved stream turns into long bursts instead of clicks.
  tick(40);
  send(PREROLL_CHUNKS + 4);
  assert.equal(render(), 0, "pre-roll grew past the backlog");
  send(10);
  assert.ok(render() > 0, "a larger backlog plays again");

  processor.port.onmessage({ data: { type: "flush" } });
  assert.equal(render(), 0, "flush re-arms the pre-roll");
});

// The fade only closes a burst that is really ending. If the emulator refills
// the backlog first, the same burst has to open up again instead of staying
// muted with audio in hand.
test("speaker reopens a burst that was fading out when the backlog recovers", async () => {
  const Speaker = await loadSpeakerProcessor();
  const processor = new Speaker();
  const frames = 128;
  const send = (chunks) => processor.port.onmessage({
    data: {
      samples: Float32Array.from({ length: chunks * 480 }, (_, index) => (index % 2 ? -0.5 : 0.5)),
      channels: 2,
    },
  });
  const render = () => {
    const channels = [new Float32Array(frames), new Float32Array(frames)];
    processor.process([], [channels]);
    let loudest = 0;
    for (const channel of channels) {
      for (const value of channel) loudest = Math.max(loudest, Math.abs(value));
    }
    return loudest;
  };

  send(12);
  assert.ok(render() > 0, "burst started");
  // 12 more quanta drain it to the 30 ms low-water mark, where the fade closes.
  for (let i = 0; i < 12; i++) render();
  send(10);
  let loudest = 0;
  for (let i = 0; i < 10; i++) loudest = Math.max(loudest, render());
  assert.ok(loudest > 0.4, `recovered level ${loudest}`);
  assert.equal(
    processor.port.messages.filter((m) => m.type === "level").at(-1)?.underruns ?? 0,
    0,
    "a recovered backlog is not a gap",
  );
});
