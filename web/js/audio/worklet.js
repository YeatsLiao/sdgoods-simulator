// AudioWorklet global scope: this file must stay self-contained (no imports,
// no DOM). Both processors talk to the main thread through this.port.

const SPEAKER_BUFFER_SECONDS = 2;
const LEVEL_SECONDS = 0.1;
// Network streams often arrive well below full scale; apply a fixed makeup
// gain so the simulator speaker is usable without clipping loud material.
const SPEAKER_GAIN = 3;
const MIC_RATE = 16000;
const MIC_CHUNK = 320;

class SpeakerProcessor extends AudioWorkletProcessor {
  #ring;
  #capacity;
  #read = 0;
  #write = 0;
  #available = 0;
  #underruns = 0;
  #starved = true;
  #levelSeconds = 0;
  #levelSum = 0;
  #levelCount = 0;

  constructor() {
    super();
    this.#capacity = Math.max(1, Math.ceil(sampleRate * SPEAKER_BUFFER_SECONDS));
    this.#ring = new Float32Array(this.#capacity * 2);
    this.port.onmessage = ({ data }) => this.#receive(data);
  }

  #receive(message) {
    if (!message) return;
    if (message.type === "flush") {
      this.#read = 0;
      this.#write = 0;
      this.#available = 0;
      this.#starved = true;
      return;
    }
    const samples = message.samples;
    if (!samples || samples.length === 0) return;
    const channels = Math.max(1, Math.floor(message.channels) || 2);
    const frames = Math.floor(samples.length / channels);
    if (frames === 0) return;
    const start = frames > this.#capacity ? frames - this.#capacity : 0;
    const count = frames - start;
    const overflow = this.#available + count - this.#capacity;
    if (overflow > 0) {
      // Keep the newest audio: dropping the oldest frames bounds latency after
      // the tab was throttled or the emulator burst-finished a scene.
      this.#read = (this.#read + overflow) % this.#capacity;
      this.#available -= overflow;
    }
    for (let i = start; i < frames; i++) {
      const base = i * channels;
      const left = Math.max(-1, Math.min(1, samples[base] * SPEAKER_GAIN));
      const right = channels > 1
        ? Math.max(-1, Math.min(1, samples[base + 1] * SPEAKER_GAIN))
        : left;
      const offset = this.#write * 2;
      this.#ring[offset] = left;
      this.#ring[offset + 1] = right;
      this.#write = (this.#write + 1) % this.#capacity;
      this.#available++;
    }
    this.#starved = false;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0];
    const right = output.length > 1 ? output[1] : null;
    const frames = left.length;
    if (this.#available < frames && !this.#starved) {
      this.#underruns++;
      this.#starved = true;
    }
    let sum = 0;
    for (let i = 0; i < frames; i++) {
      let l = 0;
      let r = 0;
      if (this.#available > 0) {
        const offset = this.#read * 2;
        l = this.#ring[offset];
        r = this.#ring[offset + 1];
        this.#read = (this.#read + 1) % this.#capacity;
        this.#available--;
      }
      left[i] = l;
      if (right) right[i] = r;
      sum += l * l + r * r;
    }
    this.#levelSum += sum;
    this.#levelCount += frames * 2;
    this.#levelSeconds += frames / sampleRate;
    if (this.#levelSeconds >= LEVEL_SECONDS) {
      this.port.postMessage({
        type: "level",
        rms: this.#levelCount ? Math.min(1, Math.sqrt(this.#levelSum / this.#levelCount)) : 0,
        queued: this.#available,
        underruns: this.#underruns,
      });
      this.#levelSeconds = 0;
      this.#levelSum = 0;
      this.#levelCount = 0;
    }
    return true;
  }
}

class MicProcessor extends AudioWorkletProcessor {
  #step;
  #cursor = 0;
  #base = 0;
  #tail = 0;
  #chunk = new Float32Array(MIC_CHUNK);
  #fill = 0;
  #levelSeconds = 0;
  #levelSum = 0;
  #levelCount = 0;

  constructor() {
    super();
    // Input samples consumed per 16 kHz output sample; linear interpolation is
    // sufficient for speech and keeps the chunk cadence exact.
    this.#step = sampleRate / MIC_RATE;
  }

  #push(value) {
    this.#chunk[this.#fill++] = value;
    this.#levelSum += value * value;
    this.#levelCount++;
    if (this.#fill === MIC_CHUNK) {
      const samples = this.#chunk;
      this.port.postMessage({ type: "data", samples }, [samples.buffer]);
      this.#chunk = new Float32Array(MIC_CHUNK);
      this.#fill = 0;
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      const start = this.#base;
      const last = start + channel.length - 1;
      // The cursor is an absolute input position, so interpolation stays
      // continuous across 128-frame blocks without extra buffering.
      while (this.#cursor < last) {
        const position = Math.floor(this.#cursor);
        const fraction = this.#cursor - position;
        let value;
        if (position < start) {
          value = this.#tail * (1 - fraction) + channel[0] * fraction;
        } else {
          const index = position - start;
          value = channel[index] * (1 - fraction) + channel[index + 1] * fraction;
        }
        this.#push(value);
        this.#cursor += this.#step;
      }
      this.#tail = channel[channel.length - 1];
      this.#base = start + channel.length;
      this.#levelSeconds += channel.length / sampleRate;
      if (this.#levelSeconds >= LEVEL_SECONDS) {
        this.port.postMessage({
          type: "level",
          rms: this.#levelCount ? Math.min(1, Math.sqrt(this.#levelSum / this.#levelCount)) : 0,
        });
        this.#levelSeconds = 0;
        this.#levelSum = 0;
        this.#levelCount = 0;
      }
    }
    return true;
  }
}

registerProcessor("speaker-processor", SpeakerProcessor);
registerProcessor("mic-processor", MicProcessor);
