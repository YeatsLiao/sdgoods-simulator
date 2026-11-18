// Pure PCM helpers. No DOM, no AudioContext: everything here runs in Node tests.
// The emulated board exchanges 16 kHz I2S samples: speaker 16-bit stereo,
// microphone a 16-bit sample left-shifted into a 32-bit container.

/**
 * @typedef {ArrayBuffer | ArrayBufferView} ByteSource
 */

const INT16_SCALE = 32768;
const INT32_SCALE = 2147483648;

function toDataView(source) {
  if (source instanceof ArrayBuffer) return new DataView(source);
  if (ArrayBuffer.isView(source)) {
    return new DataView(source.buffer, source.byteOffset, source.byteLength);
  }
  throw new TypeError("需要 ArrayBuffer 或 TypedArray");
}

/**
 * Decode little-endian signed 16-bit PCM to floats in [-1, 1).
 * A trailing odd byte is ignored.
 * @param {ByteSource} bytes
 * @returns {Float32Array}
 */
export function pcm16ToFloat32(bytes) {
  const view = toDataView(bytes);
  const count = Math.floor(view.byteLength / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = view.getInt16(i * 2, true) / INT16_SCALE;
  }
  return samples;
}

/**
 * Decode little-endian signed 32-bit PCM to floats in [-1, 1].
 * @param {ByteSource} bytes
 * @returns {Float32Array}
 */
export function pcm32ToFloat32(bytes) {
  const view = toDataView(bytes);
  const count = Math.floor(view.byteLength / 4);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = view.getInt32(i * 4, true) / INT32_SCALE;
  }
  return samples;
}

/**
 * Linear resampling. The last output may repeat the final input sample when
 * the target position runs past the end of the buffer.
 * @param {Float32Array} samples
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resampleLinear(samples, fromRate, toRate) {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError("采样率必须为正数");
  if (fromRate === toRate || samples.length === 0) return samples;
  const length = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const output = new Float32Array(length);
  const step = fromRate / toRate;
  const last = samples.length - 1;
  for (let i = 0; i < length; i++) {
    const position = i * step;
    const index = Math.floor(position);
    if (index >= last) {
      output[i] = samples[last];
      continue;
    }
    const fraction = position - index;
    output[i] = samples[index] * (1 - fraction) + samples[index + 1] * fraction;
  }
  return output;
}

/**
 * Interleave mono or stereo frames into a stereo buffer. Mono input is
 * duplicated; extra channels beyond the first two are dropped.
 * @param {Float32Array} samples
 * @param {number} [channels]
 * @returns {Float32Array}
 */
export function interleaveStereo(samples, channels = 1) {
  const count = Math.max(1, Math.floor(channels) || 1);
  const frames = Math.floor(samples.length / count);
  const output = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    output[i * 2] = samples[i * count];
    output[i * 2 + 1] = count > 1 ? samples[i * count + 1] : samples[i];
  }
  return output;
}

/**
 * Pack mono 16 kHz floats as I2sIn 32-bit words: a 16-bit sample shifted left
 * 16 bits, matching the firmware microphone path.
 * Only whole chunks are returned; a trailing partial chunk is dropped.
 * @param {Float32Array} samples
 * @param {{samplesPerChunk?: number}} [options]
 * @returns {Int32Array}
 */
export function encodeMic32(samples, { samplesPerChunk = 320 } = {}) {
  const chunk = Math.floor(samplesPerChunk);
  if (!(chunk > 0)) throw new RangeError("samplesPerChunk 必须为正数");
  const length = Math.floor(samples.length / chunk) * chunk;
  const output = new Int32Array(length);
  for (let i = 0; i < length; i++) {
    const scaled = Math.round(samples[i] * INT16_SCALE);
    const int16 = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
    output[i] = int16 << 16;
  }
  return output;
}

/**
 * RMS level of a block, clamped to 0..1.
 * @param {ArrayLike<number>} samples
 * @returns {number}
 */
export function mixLevel(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  return Number.isFinite(rms) ? Math.min(1, rms) : 0;
}
