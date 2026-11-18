import {
  interleaveStereo,
  pcm16ToFloat32,
  pcm32ToFloat32,
  resampleLinear,
} from "./codec.js";

const DEFAULT_RATE = 16000;
const DEFAULT_CHANNELS = 2;
const DEFAULT_BITS = 16;

/**
 * @typedef {Object} AudioFormat
 * @property {number} [rate] 采样率，默认 16000
 * @property {number} [channels] 通道数，默认 2
 * @property {number} [bits] 容器位宽，16 或 32，默认 16
 * @property {boolean} [receive] true 表示麦克风方向，播放时忽略
 */

function toBytes(source) {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  throw new TypeError("需要 ArrayBuffer 或 TypedArray");
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function joinStereo(left, right) {
  const frames = Math.min(left.length, right.length);
  const output = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    output[i * 2] = left[i];
    output[i * 2 + 1] = right[i];
  }
  return output;
}

export class AudioEngine {
  #context = null;
  #worklet = null;
  #gain = null;
  #recording = null;
  #initPromise = null;
  #generation = 0;
  #volume = 1;
  #muted = false;
  #levels = { outRms: 0, outQueued: 0, underruns: 0 };

  /** @returns {boolean} 是否已初始化 */
  get ready() {
    return Boolean(this.#worklet);
  }

  /** @returns {number} AudioContext 实际采样率，未初始化时为 0 */
  get sampleRate() {
    return this.#context?.sampleRate ?? 0;
  }

  /** @returns {{outRms: number, outQueued: number, underruns: number}} */
  get levels() {
    return { ...this.#levels };
  }

  /**
   * 创建 AudioContext 并加载 AudioWorklet。需在用户手势中调用。
   * 可重复调用；并发调用共享同一个初始化过程。
   * @returns {Promise<boolean>}
   */
  init() {
    if (this.#worklet) return Promise.resolve(true);
    if (!this.#initPromise) {
      const generation = ++this.#generation;
      this.#initPromise = this.#setup(generation).catch((error) => {
        if (generation === this.#generation) this.#initPromise = null;
        throw error;
      });
    }
    return this.#initPromise;
  }

  async #setup(generation) {
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Context) throw new Error("当前浏览器不支持 Web Audio，无法播放设备音频");
    let context = null;
    try {
      context = new Context();
      if (!context.audioWorklet) {
        throw new Error("当前环境不支持 AudioWorklet（需要 https 或 localhost）");
      }
      await context.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
      const worklet = new AudioWorkletNode(context, "speaker-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const gain = context.createGain();
      gain.gain.value = this.#muted ? 0 : this.#volume;
      worklet.connect(gain);
      gain.connect(context.destination);
      worklet.port.onmessage = ({ data }) => {
        if (data?.type !== "level") return;
        this.#levels = {
          outRms: data.rms ?? 0,
          outQueued: data.queued ?? 0,
          underruns: data.underruns ?? 0,
        };
      };
      if (context.state === "suspended") await context.resume().catch(() => {});
      if (generation !== this.#generation) {
        // close() invalidated this initialization while addModule/resume was pending.
        await context.close().catch(() => {});
        return false;
      }
      this.#context = context;
      this.#worklet = worklet;
      this.#gain = gain;
      return true;
    } catch (error) {
      await context?.close().catch(() => {});
      throw new Error(`音频初始化失败：${error?.message ?? error}`, { cause: error });
    }
  }

  /**
   * 播放一段 I2sOut PCM。只接受扬声器方向（receive 为 false）。
   * 不等待 AudioContext 状态；未初始化或格式不支持时返回 false。
   * @param {ArrayBuffer | ArrayBufferView} pcm 原始小端 PCM
   * @param {AudioFormat} [format]
   * @returns {boolean}
   */
  play(pcm, format) {
    if (!this.#worklet) return false;
    if (format?.receive) return false;
    try {
      const bytes = toBytes(pcm);
      if (bytes.byteLength === 0) return true;
      if (this.#context.state === "suspended") this.#context.resume().catch(() => {});
      const rate = positive(Number(format?.rate), DEFAULT_RATE);
      const channels = Math.floor(positive(Number(format?.channels), DEFAULT_CHANNELS));
      const bits = positive(Number(format?.bits), DEFAULT_BITS);
      const contextRate = this.#context.sampleRate;
      let samples = bits === 32 ? pcm32ToFloat32(bytes) : pcm16ToFloat32(bytes);
      if (samples.length === 0) return true;
      if (channels <= 1) {
        samples = interleaveStereo(resampleLinear(samples, rate, contextRate), 1);
      } else {
        const frames = Math.floor(samples.length / channels);
        let left = new Float32Array(frames);
        let right = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          left[i] = samples[i * channels];
          right[i] = samples[i * channels + 1];
        }
        left = resampleLinear(left, rate, contextRate);
        right = resampleLinear(right, rate, contextRate);
        samples = joinStereo(left, right);
      }
      this.#worklet.port.postMessage({ samples, channels: 2 }, [samples.buffer]);
      return true;
    } catch {
      return false;
    }
  }

  /** 丢弃已排队的音频（设备重启后调用）。 */
  flush() {
    this.#worklet?.port.postMessage({ type: "flush" });
  }

  /** @param {number} value 0..1 */
  setVolume(value) {
    const next = Number(value);
    if (Number.isFinite(next)) this.#volume = Math.min(1, Math.max(0, next));
    this.#applyGain();
  }

  /** @param {boolean} value */
  setMuted(value) {
    this.#muted = Boolean(value);
    this.#applyGain();
  }

  #applyGain() {
    if (!this.#gain) return;
    this.#gain.gain.setTargetAtTime(
      this.#muted ? 0 : this.#volume,
      this.#context.currentTime,
      0.01,
    );
  }

  /**
   * 录制音轨，接在音量节点之后（静音时录到静音）。需先 init()。
   * @returns {MediaStream | null}
   */
  createRecordingStream() {
    if (!this.#context || !this.#gain) return null;
    if (!this.#recording) {
      this.#recording = this.#context.createMediaStreamDestination();
      this.#gain.connect(this.#recording);
    }
    return this.#recording.stream;
  }

  /**
   * 诊断用测试音，经主音量节点输出。
   * @param {number} [frequency] Hz
   * @param {number} [duration] ms
   * @returns {boolean}
   */
  playTone(frequency = 1000, duration = 200) {
    if (!this.#context || !this.#gain) return false;
    try {
      const oscillator = this.#context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const now = this.#context.currentTime;
      oscillator.connect(this.#gain);
      oscillator.start(now);
      oscillator.stop(now + Math.max(0.01, duration / 1000));
      oscillator.onended = () => oscillator.disconnect();
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    const context = this.#context;
    this.#generation++;
    if (this.#worklet) {
      this.#worklet.port.onmessage = null;
      this.#worklet.port.close();
      this.#worklet.disconnect();
    }
    this.#gain?.disconnect();
    this.#recording?.disconnect();
    this.#context = null;
    this.#worklet = null;
    this.#gain = null;
    this.#recording = null;
    this.#initPromise = null;
    this.#levels = { outRms: 0, outQueued: 0, underruns: 0 };
    if (context && context.state !== "closed") await context.close().catch(() => {});
  }
}
