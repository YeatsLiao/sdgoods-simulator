// Pure PCM helpers. No DOM, no AudioContext: everything here runs in Node tests.
// The emulated board exchanges 16 kHz I2S samples: speaker 16-bit stereo,
// microphone a 16-bit sample left-shifted into a 32-bit container.

/**
 * @typedef {ArrayBuffer | ArrayBufferView} ByteSource
 */

const INT16_SCALE = 32768;
const INT32_SCALE = 2147483648;

// Loudness makeup. Network streams reach the emulator far below full scale, and
// a fixed multiplier is either useless on quiet streams or clips loud ones.
const TARGET_RMS = 0.12;
const MIN_MAKEUP = 1;
// Quiet internet radio measures RMS 0.0065 with peaks under 0.02, so the useful
// ceiling is set by headroom, not by this cap. It only stops a genuinely
// zero-valued estimate from lifting the noise floor without limit.
const MAX_MAKEUP = 16;
// Below this RMS a chunk is treated as already loud enough: lifting it to the
// target would only trade headroom for no perceived gain. Stays under the
// target so the loop settles instead of hunting around 0.12.
const LOUD_ENOUGH_RMS = TARGET_RMS * 0.8;
const PEAK_CEILING = 0.9;
// One 16-bit LSB, with room for float error. A chunk below this is digital
// silence (an underrun or a muted stream), where any finite target/rms ratio is
// meaningless and would drive the gain to the ceiling.
const SILENCE_RMS = 1 / 65536;
// The starved emulator hands over ~5 ms chunks, so a per-chunk peak ceiling made
// neighbouring chunks differ by 3x and the seams read as crackle. The headroom
// now follows a decaying peak instead.
const PEAK_DECAY_PER_CHUNK = 0.995;
const ATTACK_PER_CHUNK = 0.04;
// Roughly 90 chunks per second at 48 kHz, so both coefficients settle in a
// few hundred milliseconds of program audio.
const RELEASE_PER_CHUNK = 0.02;

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
 * Stateful linear resampler for one channel of a continuous stream.
 *
 * Device audio arrives as many short chunks. Resampling each chunk from
 * sample zero restarts the phase at every boundary and injects a click; this
 * keeps the cursor and the previous samples so seams interpolate through.
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {(samples: Float32Array) => Float32Array}
 */
export function createResampler(fromRate, toRate) {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError("采样率必须为正数");
  // Callers mutate the result in place (makeup gain does), so the equal-rate
  // pass still has to hand back a copy rather than the caller's own array.
  if (fromRate === toRate) return (samples) => Float32Array.from(samples);
  const step = fromRate / toRate;
  // The cursor is the next read position relative to the previous chunk's last
  // sample, so it stays in [-1, 0) instead of growing with the stream. Keeping
  // that phase is what removes the click every chunk boundary used to add.
  let cursor = 0;
  let tail = 0;
  return (samples) => {
    const last = samples.length - 1;
    if (last < 0) return new Float32Array(0);
    const count = Math.max(0, Math.floor((last - cursor) / step) + 1);
    const output = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const position = cursor + i * step;
      const index = Math.floor(position);
      const fraction = position - index;
      const before = index < 0 ? tail : samples[index];
      // The newest sample has no right neighbour yet; hold it flat and let the
      // next chunk finish that interpolation instead of inventing a value.
      const after = index + 1 <= last ? samples[index + 1] : before;
      output[i] = before + (after - before) * fraction;
    }
    cursor += count * step - samples.length;
    tail = samples[last];
    return output;
  };
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

/**
 * Lift a decoded chunk toward the loudness target and apply it in place.
 *
 * Gain only ever rises above unity, so the firmware's own volume still
 * controls the level; it stops at the headroom the chunk peak allows, and it
 * moves a fixed fraction per chunk (fast up, slow down) so the boost settles
 * within a second even when the emulator delivers short, sparse chunks.
 * @param {Float32Array} samples interleaved float samples, modified in place
 * @param {{gain: number}} state gain carried across chunks
 * @returns {number} gain applied to this chunk
 */
export function applyMakeupGain(samples, state) {
  if (!(state.gain > 0)) state.gain = MIN_MAKEUP;
  if (!(state.peak >= 0)) state.peak = 0;
  if (!samples || samples.length === 0) return state.gain;
  let peak = 0;
  let squareSum = 0;
  for (let i = 0; i < samples.length; i++) {
    const magnitude = samples[i] < 0 ? -samples[i] : samples[i];
    if (magnitude > peak) peak = magnitude;
    squareSum += samples[i] * samples[i];
  }
  // Unclamped RMS: mixLevel caps at 1, which would make a chunk of rare
  // out-of-range samples look exactly full scale and pull TARGET_RMS / loudness
  // below unity, silently overriding the firmware volume.
  const loudness = Math.sqrt(squareSum / samples.length);
  state.peak = Math.max(peak, state.peak * PEAK_DECAY_PER_CHUNK);
  const ceiling = state.peak > 0 ? PEAK_CEILING / state.peak : MAX_MAKEUP;
  let wanted;
  if (!(loudness > SILENCE_RMS)) {
    // Digital silence carries no loudness information. Freezing keeps the level
    // steady across the emulator's dropouts; falling to unity would pump.
    wanted = state.gain;
  } else if (loudness >= LOUD_ENOUGH_RMS) {
    wanted = MIN_MAKEUP;
  } else {
    wanted = Math.max(MIN_MAKEUP, Math.min(MAX_MAKEUP, TARGET_RMS / loudness));
  }
  const rate = wanted > state.gain ? ATTACK_PER_CHUNK : RELEASE_PER_CHUNK;
  state.gain += (wanted - state.gain) * rate;
  // The smoothed gain may still overshoot a sudden peak; cap it per chunk.
  const gain = Math.min(state.gain, ceiling);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return gain;
}

/**
 * Accumulate how much audio actually arrives compared with wall time. A ratio
 * below 1 means the emulator produced less program audio than real time needs,
 * which the speaker fills with silence.
 * @param {{started: number, seconds: number, ratio: number|null}} state
 * @param {number} seconds audio seconds delivered by this chunk
 * @param {number} now monotonic clock in ms
 * @returns {number|null} ratio of the last completed window
 */
export function trackArrival(state, seconds, now) {
  if (!Number.isFinite(state.started)) state.started = now;
  state.seconds += Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const elapsed = (now - state.started) / 1000;
  if (elapsed >= 1) {
    // The first window is measured from the first chunk, later ones from the
    // window boundary, so a late start does not dilute every ratio after it.
    state.ratio = Math.min(2, state.seconds / (state.ratio === null ? elapsed : 1));
    state.started = now;
    state.seconds = 0;
  }
  return state.ratio;
}
