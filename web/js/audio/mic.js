import { Emitter } from "../shared/emitter.js";
import { encodeMic32 } from "./codec.js";

const MIC_CONSTRAINTS = Object.freeze({
  audio: {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
});

const DEFAULT_SAMPLES_PER_CHUNK = 320;

function describeMicError(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "麦克风权限被拒绝，请在浏览器地址栏或系统设置中允许访问麦克风";
    case "NotFoundError":
    case "OverconstrainedError":
      return "没有找到可用的麦克风设备";
    case "NotReadableError":
      return "麦克风被其他程序占用或无法读取";
    default:
      return `无法打开麦克风：${error?.message ?? error}`;
  }
}

export class MicCapture extends Emitter {
  #samplesPerChunk;
  #context = null;
  #stream = null;
  #source = null;
  #worklet = null;
  #sink = null;
  #starting = null;
  #generation = 0;

  /** @param {{samplesPerChunk?: number}} [options] */
  constructor({ samplesPerChunk = DEFAULT_SAMPLES_PER_CHUNK } = {}) {
    super();
    this.#samplesPerChunk = samplesPerChunk;
  }

  get active() {
    return Boolean(this.#worklet);
  }

  /**
   * 请求麦克风并开始采集。失败时触发 error 事件并抛出带中文说明的错误。
   * @returns {Promise<boolean>}
   */
  start() {
    if (this.#worklet) return Promise.resolve(true);
    if (!this.#starting) {
      const generation = ++this.#generation;
      this.#starting = (async () => {
        try {
          return await this.#open(generation);
        } catch (error) {
          const message = describeMicError(error);
          this.emit("error", message);
          throw new Error(message, { cause: error });
        } finally {
          if (generation === this.#generation) this.#starting = null;
        }
      })();
    }
    return this.#starting;
  }

  async #open(generation) {
    const media = globalThis.navigator?.mediaDevices;
    if (!media?.getUserMedia) throw new Error("浏览器不支持麦克风采集");
    const stream = await media.getUserMedia(MIC_CONSTRAINTS);
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Context) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error("当前浏览器不支持 Web Audio");
    }
    const context = new Context();
    try {
      if (!context.audioWorklet) {
        throw new Error("当前环境不支持 AudioWorklet（需要 https 或 localhost）");
      }
      await context.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, "mic-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
      });
      // A muted sink keeps the graph pulling the worklet; a node with no path
      // to the destination may be garbage collected or never processed.
      const sink = context.createGain();
      sink.gain.value = 0;
      worklet.port.onmessage = ({ data }) => this.#receive(data);
      source.connect(worklet);
      worklet.connect(sink);
      sink.connect(context.destination);
      if (context.state === "suspended") await context.resume();
      if (generation !== this.#generation) {
        // stop() ran while the permission prompt or worklet load was pending.
        for (const track of stream.getTracks()) track.stop();
        await context.close().catch(() => {});
        return false;
      }
      this.#stream = stream;
      this.#context = context;
      this.#source = source;
      this.#worklet = worklet;
      this.#sink = sink;
      return true;
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      await context.close().catch(() => {});
      throw error;
    }
  }

  #receive(message) {
    if (!this.#worklet || !message) return;
    if (message.type === "data") {
      const chunk = encodeMic32(message.samples, { samplesPerChunk: this.#samplesPerChunk });
      if (chunk.length) this.emit("data", chunk);
    } else if (message.type === "level") {
      this.emit("level", { rms: message.rms ?? 0 });
    }
  }

  async stop() {
    this.#generation++;
    this.#starting = null;
    const context = this.#context;
    const worklet = this.#worklet;
    const source = this.#source;
    const sink = this.#sink;
    const stream = this.#stream;
    this.#context = null;
    this.#worklet = null;
    this.#source = null;
    this.#sink = null;
    this.#stream = null;
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.close();
      worklet.disconnect();
    }
    source?.disconnect();
    sink?.disconnect();
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (context && context.state !== "closed") await context.close().catch(() => {});
  }
}
