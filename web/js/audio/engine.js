import {
  applyMakeupGain,
  createResampler,
  interleaveStereo,
  pcm16ToFloat32,
  pcm32ToFloat32,
  trackArrival,
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

const monotonicMs = () => globalThis.performance?.now?.() ?? Date.now();

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
  #lastPlayError = null;
  #makeup = { gain: 1, peak: 0 };
  #makeupApplied = 1;
  #arrival = { started: Number.NaN, seconds: 0, ratio: null };
  #resamplerKey = "";
  #resamplerNodes = null;
  #capture = null;
  #replay = null;
  #replaySources = new Set();
  #auto = { enabled: false, target: 4 };
  #live = true;
  #external = false;

  /** @returns {boolean} 是否已初始化 */
  get ready() {
    return Boolean(this.#worklet);
  }

  /** @returns {number} AudioContext 实际采样率，未初始化时为 0 */
  get sampleRate() {
    return this.#context?.sampleRate ?? 0;
  }

  /**
   * @returns {{outRms: number, outQueued: number, underruns: number,
   *   makeup: number, audioRatio: number|null,
   *   capture: {active: boolean, seconds: number, target: number},
   *   replay: {active: boolean, remaining: number, seconds: number}}}
   */
  get levels() {
    const replay = this.replay;
    const levels = {
      ...this.#levels,
      makeup: this.#makeupApplied,
      audioRatio: this.#arrival.ratio,
      external: this.#external,
      capture: this.capture,
      replay,
      queueMs: this.sampleRate ? this.#levels.outQueued / this.sampleRate * 1000 : null,
    };
    if (replay.active) {
      // The live ring is parked while a buffer plays, so its readings would say
      // "silent" about audio the listener is actually hearing.
      levels.outRms = this.#replay.rms;
      levels.outQueued = Math.round(replay.remaining * this.sampleRate);
    }
    return levels;
  }

  /**
   * 连续回放用的缓存状态。模拟器每墙钟秒只算出 0.2–0.35 秒音频，原速实时播放
   * 必然断续；把同一段字节攒满目标时长再一次播完，才是原速且连续的声音。
   * @returns {{active: boolean, seconds: number, target: number}}
   */
  get capture() {
    if (!this.#capture) return { active: false, seconds: 0, target: 0 };
    return {
      active: true,
      seconds: this.#capture.frames / this.#capture.rate,
      target: this.#capture.target,
    };
  }

  /**
   * 正在连续播放的缓冲段。remaining 按 AudioContext 时钟计算，段尾归零。
   * @returns {{active: boolean, remaining: number, seconds: number}}
   */
  get replay() {
    const replay = this.#replay;
    if (!replay || !this.#context) return { active: false, remaining: 0, seconds: 0 };
    const remaining = replay.endsAt - this.#context.currentTime;
    if (remaining <= 0) return { active: false, remaining: 0, seconds: replay.seconds };
    return { active: true, remaining, seconds: replay.seconds };
  }

  /** @returns {{enabled: boolean, target: number}} 自动连续回放设置 */
  get autoReplay() {
    return { ...this.#auto };
  }

  /**
   * 自动连续回放：设备每送出音频就缓存，攒满一段原速连播，播完接着缓存下一段。
   * 关闭时丢弃旧缓存并停止所有已排队回放，立即回到实时环形缓冲。
   * @param {{enabled?: boolean, target?: number}} [options]
   * @returns {{enabled: boolean, target: number}}
   */
  setAutoReplay(options = {}) {
    if (options.enabled !== undefined) this.#auto.enabled = Boolean(options.enabled);
    const target = Number(options.target);
    if (Number.isFinite(target) && target > 0) {
      this.#auto.target = Math.min(30, Math.max(1, target));
      // Retarget in place: audio already cached stays usable.
      if (this.#capture) this.#capture.target = this.#auto.target;
    }
    if (!this.#auto.enabled) {
      this.#capture = null;
      this.#stopReplay();
      this.#syncLive();
    }
    if (options.enabled !== undefined) {
      this.#worklet?.port.postMessage({ type: "latency", mode: this.#auto.enabled ? "buffered" : "interactive" });
    }
    return this.autoReplay;
  }

  /** @returns {boolean} 是否由浏览器直连音源占用输出 */
  get externalAudio() {
    return this.#external;
  }

  /**
   * 把输出交给浏览器直连音源：设备 PCM 只统计到达率，不再解码、重采样或入环，
   * 环形缓冲同时停放。这样直连播放期间不会有两路声音，也省下无用的浏览器 CPU。
   * @param {boolean} value
   * @returns {boolean} 生效后的状态
   */
  setExternalAudio(value) {
    const next = Boolean(value);
    if (next === this.#external) return this.#external;
    this.#external = next;
    if (next) {
      this.#capture = null;
      this.#stopReplay();
      this.#resetStream();
    }
    this.#syncLive();
    return this.#external;
  }

  /**
   * 开始缓存设备音频；缓存期间暂停实时输出，攒够目标时长后自动连续播放。
   * @param {number} [seconds] 目标音频秒数，1–30
   * @returns {Promise<boolean>} 是否已开始
   */
  async startCapture(seconds = this.#auto.target) {
    if (!(await this.init())) return false;
    const target = Math.min(30, Math.max(1, Number(seconds) || this.#auto.target));
    this.#capture = { rate: this.#context.sampleRate, chunks: [], frames: 0, target };
    this.#syncLive();
    return true;
  }

  /**
   * 结束缓存并连续播放已攒下的音频。上一段还没播完时接在其段尾，两段之间无缝。
   * @returns {number} 实际播放的秒数，没有内容时为 0
   */
  playCapture() {
    const capture = this.#capture;
    this.#capture = null;
    if (!capture || !capture.frames || !this.#context) {
      this.#syncLive();
      return 0;
    }
    const seconds = capture.frames / capture.rate;
    const buffer = this.#context.createBuffer(2, capture.frames, capture.rate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    // A phrase starts and ends wherever the device happened to be, which clicks
    // at full amplitude. The same few milliseconds of ramp the live ring uses.
    const fade = Math.max(1, Math.min(Math.round(capture.rate * 0.005), Math.floor(capture.frames / 2)));
    let at = 0;
    let energy = 0;
    for (const chunk of capture.chunks) {
      for (let i = 0; i + 1 < chunk.length; i += 2) {
        const edge = Math.min(at, capture.frames - 1 - at);
        const gain = edge < fade ? edge / fade : 1;
        left[at] = chunk[i] * gain;
        right[at] = chunk[i + 1] * gain;
        energy += left[at] * left[at] + right[at] * right[at];
        at += 1;
      }
    }
    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#gain);
    const now = this.#context.currentTime;
    const when = Math.max(now, this.#replay?.endsAt ?? now);
    source.start(when);
    this.#replaySources.add(source);
    source.onended = () => {
      source.disconnect();
      this.#replaySources.delete(source);
      if (this.#replay?.source === source) this.#replay = null;
      this.#syncLive();
    };
    this.#replay = {
      source,
      endsAt: when + seconds,
      seconds,
      rms: Math.min(1, Math.sqrt(energy / Math.max(1, at * 2))),
    };
    this.#syncLive();
    return seconds;
  }

  /** 丢弃缓存（设备重启或换固件时调用）。 */
  clearCapture() {
    this.#capture = null;
    this.#syncLive();
  }

  /**
   * 实时环形缓冲只在没有缓存、也没有连续回放时才接音频：否则同一段字节会被
   * 播两遍，而空闲的环还会把设计中的静音记成欠载。
   */
  #syncLive() {
    const live = !this.#external && !this.#capture && !this.replay.active;
    if (live === this.#live) return;
    this.#live = live;
    this.#worklet?.port.postMessage({ type: "live", on: live });
  }

  #stopReplay() {
    this.#replay = null;
    for (const source of this.#replaySources) {
      source.onended = null;
      try { source.stop(); source.disconnect(); } catch { /* Already ended. */ }
    }
    this.#replaySources.clear();
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
      context = new Context({ latencyHint: "interactive" });
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
          prerollMs: data.prerollMs ?? null,
          dropped: data.dropped ?? 0,
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
      worklet.port.postMessage({ type: "latency", mode: this.#auto.enabled ? "buffered" : "interactive" });
      // 新建的环形缓冲默认是实时的，这里按当前归属重新停放一次。
      this.#live = true;
      this.#syncLive();
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
      if (this.#external) {
        // 直连取流期间设备 PCM 只计入到达率：不解码、不重采样、不入环，
        // 也不唤醒 AudioContext，省下的都是白花的浏览器 CPU。
        const rate = positive(Number(format?.rate), DEFAULT_RATE);
        const channels = Math.floor(positive(Number(format?.channels), DEFAULT_CHANNELS));
        const bits = positive(Number(format?.bits), DEFAULT_BITS);
        const frames = Math.floor(bytes.byteLength / (channels * Math.max(1, bits / 8)));
        trackArrival(this.#arrival, frames / rate, monotonicMs());
        return true;
      }
      if (this.#context.state === "suspended") this.#context.resume().catch(() => {});
      const rate = positive(Number(format?.rate), DEFAULT_RATE);
      const channels = Math.floor(positive(Number(format?.channels), DEFAULT_CHANNELS));
      const bits = positive(Number(format?.bits), DEFAULT_BITS);
      const contextRate = this.#context.sampleRate;
      let samples = bits === 32 ? pcm32ToFloat32(bytes) : pcm16ToFloat32(bytes);
      if (samples.length === 0) return true;
      const seconds = Math.floor(samples.length / Math.max(1, channels)) / rate;
      const nodes = this.#streamResamplers(rate, channels, contextRate);
      if (channels <= 1) {
        samples = interleaveStereo(nodes[0](samples), 1);
      } else {
        // Only the first two channels reach the speaker; a wider container is
        // de-interleaved so every channel keeps its own resampler phase.
        const frames = Math.floor(samples.length / channels);
        const monoLeft = new Float32Array(frames);
        const monoRight = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          monoLeft[i] = samples[i * channels];
          monoRight[i] = samples[i * channels + 1];
        }
        samples = joinStereo(nodes[0](monoLeft), nodes[1](monoRight));
      }
      // The returned gain is what this chunk actually got: the stored gain is
      // smoothed and may still sit above the headroom ceiling.
      this.#makeupApplied = applyMakeupGain(samples, this.#makeup);
      trackArrival(this.#arrival, seconds, monotonicMs());
      if (!this.#capture && this.#auto.enabled) {
        this.#capture = {
          rate: contextRate,
          chunks: [],
          frames: 0,
          target: this.#auto.target,
        };
        this.#syncLive();
      }
      if (this.#capture) {
        // Captured chunks stay out of the live ring: playing them twice, once
        // chopped and once whole, would only add the chop back.
        this.#capture.chunks.push(samples);
        this.#capture.frames += samples.length / 2;
        if (this.#capture.frames / this.#capture.rate >= this.#capture.target) {
          this.playCapture();
          if (this.#auto.enabled) {
            // Keep the pipeline full while the previous phrase is still playing.
            this.#capture = {
              rate: contextRate,
              chunks: [],
              frames: 0,
              target: this.#auto.target,
            };
            this.#syncLive();
          }
        }
        return true;
      }
      // onended normally unparks the ring, but a suspended context can swallow
      // it; live audio arriving is itself proof the ring may run again.
      this.#syncLive();
      this.#worklet.port.postMessage({ samples, channels: 2 }, [samples.buffer]);
      return true;
    } catch (error) {
      this.#reportPlayError(error);
      return false;
    }
  }

  /**
   * One streaming resampler per channel, kept while the format is stable so
   * chunk seams interpolate instead of restarting the phase.
   * @param {number} rate source rate of this chunk
   * @param {number} channels
   * @param {number} contextRate AudioContext rate
   */
  #streamResamplers(rate, channels, contextRate) {
    const used = channels <= 1 ? 1 : 2;
    const key = `${rate}/${used}/${contextRate}`;
    if (this.#resamplerKey !== key) {
      this.#resamplerKey = key;
      this.#resamplerNodes = Array.from(
        { length: used },
        () => createResampler(rate, contextRate),
      );
    }
    return this.#resamplerNodes;
  }

  // play() runs ~60 times a second: report each distinct message once per
  // stream, so flush()/close() let a fault that returns after a restart show up.
  #reportPlayError(error) {
    const message = error?.message ?? String(error);
    if (message === this.#lastPlayError) return;
    this.#lastPlayError = message;
    console.error("[audio] play failed:", message);
  }

  #resetStream() {
    this.#resamplerKey = "";
    this.#resamplerNodes = null;
    this.#makeup = { gain: 1, peak: 0 };
    this.#makeupApplied = 1;
    this.#arrival = { started: Number.NaN, seconds: 0, ratio: null };
    this.#lastPlayError = null;
  }

  /** 丢弃已排队的音频（设备重启后调用）。 */
  flush() {
    this.#resetStream();
    this.#capture = null;
    this.#stopReplay();
    this.#syncLive();
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
    this.#capture = null;
    this.#stopReplay();
    this.#live = true;
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
    this.#resetStream();
    if (context && context.state !== "closed") await context.close().catch(() => {});
  }
}
