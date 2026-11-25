// AudioWorklet global scope: this file must stay self-contained (no imports,
// no DOM). Both processors talk to the main thread through this.port.

const SPEAKER_BUFFER_SECONDS = 3;
// The emulator can deliver far less audio than real time (radio measures
// ~0.35x), and no buffering changes that: the duty cycle equals the arrival
// ratio. What the pre-roll controls is the shape of the shortfall. Playing as
// soon as one 128-frame block lands turns 0.35x into a 2.7 ms gate, which
// sounds like harsh noise; waiting for a backlog plays the same bytes as
// complete phrases separated by silence, which the ear can follow.
//
// The backlog is latency, so it starts small and doubles per gap. A stream the
// emulator keeps up with stays near the floor; a starved one climbs to the
// ceiling. The ceiling is a phrase of speech rather than a word because the
// complaint this answers is "one chop after another": at 1 s of backlog the
// listener gets ~1.4 s of unbroken audio every ~3.3 s, about thirteen
// transitions a minute instead of the twenty-three a 0.6 s ceiling produces.
// Longer still would only stretch the silence, not the duty cycle.
const SPEAKER_PREROLL_MIN_SECONDS = 0.06;
const SPEAKER_PREROLL_MAX_SECONDS = 1;
const SPEAKER_STEADY_SECONDS = 2;
// A burst that runs the buffer to the last sample stops on a hard cut. Ending it
// a little early lets the fade close it, and the held-back frames simply start
// the next burst.
const SPEAKER_LOW_WATER_SECONDS = 0.03;
// Bursts start and end on a hard sample boundary, which clicks. A few
// milliseconds of ramp costs nothing on the audio thread and removes it.
const SPEAKER_FADE_SECONDS = 0.005;
const SPEAKER_FADE_FLOOR = 1e-3;
const LEVEL_SECONDS = 0.1;
const MIC_RATE = 16000;
const MIC_CHUNK = 320;

class SpeakerProcessor extends AudioWorkletProcessor {
  #ring;
  #capacity;
  #read = 0;
  #write = 0;
  #available = 0;
  #underruns = 0;
  #playing = false;
  #preroll;
  #prerollMin;
  #prerollMax;
  #lowWater;
  #gapped = false;
  #draining = false;
  #steadyReports = 0;
  #fade = 0;
  #fadeStep;
  #levelSeconds = 0;
  #levelSum = 0;
  #levelCount = 0;
  #live = true;
  #queueLimit;
  #dropped = 0;

  constructor() {
    super();
    this.#capacity = Math.max(1, Math.ceil(sampleRate * SPEAKER_BUFFER_SECONDS));
    const frames = (seconds) => Math.min(this.#capacity, Math.max(1, Math.ceil(sampleRate * seconds)));
    this.#prerollMin = frames(SPEAKER_PREROLL_MIN_SECONDS);
    this.#prerollMax = frames(SPEAKER_PREROLL_MAX_SECONDS);
    this.#preroll = this.#prerollMin;
    this.#lowWater = frames(SPEAKER_LOW_WATER_SECONDS);
    this.#fadeStep = 1 / Math.max(1, sampleRate * SPEAKER_FADE_SECONDS);
    this.#ring = new Float32Array(this.#capacity * 2);
    this.#queueLimit = this.#capacity;
    this.port.onmessage = ({ data }) => this.#receive(data);
  }

  #reset() {
    this.#read = 0;
    this.#write = 0;
    this.#available = 0;
    this.#playing = false;
    this.#draining = false;
    this.#fade = 0;
  }

  #receive(message) {
    if (!message) return;
    if (message.type === "latency") {
      const interactive = message.mode === "interactive";
      this.#prerollMin = Math.ceil(sampleRate * (interactive ? 0.02 : SPEAKER_PREROLL_MIN_SECONDS));
      this.#prerollMax = Math.ceil(sampleRate * (interactive ? 0.08 : SPEAKER_PREROLL_MAX_SECONDS));
      this.#preroll = this.#prerollMin;
      this.#lowWater = Math.ceil(sampleRate * (interactive ? 0.005 : SPEAKER_LOW_WATER_SECONDS));
      this.#queueLimit = interactive ? Math.ceil(sampleRate * 0.12) : this.#capacity;
      this.#gapped = false;
      this.#steadyReports = 0;
      this.#reset();
      return;
    }
    if (message.type === "flush") {
      this.#reset();
      return;
    }
    if (message.type === "live") {
      this.#live = message.on !== false;
      if (!this.#live) this.#reset();
      return;
    }
    const samples = message.samples;
    if (!samples || samples.length === 0) return;
    const channels = Math.max(1, Math.floor(message.channels) || 2);
    const frames = Math.floor(samples.length / channels);
    if (frames === 0) return;
    const start = frames > this.#queueLimit ? frames - this.#queueLimit : 0;
    this.#dropped += start;
    const count = frames - start;
    const overflow = this.#available + count - this.#queueLimit;
    if (overflow > 0) {
      // Keep the newest audio: dropping the oldest frames bounds latency after
      // the tab was throttled or the emulator burst-finished a scene.
      this.#read = (this.#read + overflow) % this.#capacity;
      this.#available -= overflow;
      this.#dropped += overflow;
    }
    for (let i = start; i < frames; i++) {
      const base = i * channels;
      // Loudness makeup happens on the main thread; clamp only as a guard.
      const left = Math.max(-1, Math.min(1, samples[base]));
      const right = channels > 1 ? Math.max(-1, Math.min(1, samples[base + 1])) : left;
      const offset = this.#write * 2;
      this.#ring[offset] = left;
      this.#ring[offset + 1] = right;
      this.#write = (this.#write + 1) % this.#capacity;
      this.#available++;
    }
    // Back above the low-water mark, so a burst that was fading out gets to
    // continue instead of staying closed with audio in hand.
    if (this.#available > this.#lowWater) this.#draining = false;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0];
    const right = output.length > 1 ? output[1] : null;
    const frames = left.length;
    if (!this.#live) {
      // A capture or a continuous replay owns the speaker. The ring is idle by
      // design here, so it must not count as underruns or move the pre-roll.
      left.fill(0);
      if (right) right.fill(0);
      this.#reportLevel(frames, 0);
      return true;
    }
    if (!this.#playing) {
      // Idle until a pre-roll backlog exists; the emulator's 5 ms chunks must
      // not each start a 2.7 ms burst.
      if (this.#available >= this.#preroll) this.#playing = true;
    }
    let sum = 0;
    for (let i = 0; i < frames; i++) {
      let l = 0;
      let r = 0;
      const live = this.#playing && this.#available > 0;
      // Below the low-water mark the burst is ending, so the fade closes over
      // the frames still queued instead of cutting at the last sample.
      if (live && this.#available <= this.#lowWater) this.#draining = true;
      if (live) {
        const offset = this.#read * 2;
        l = this.#ring[offset];
        r = this.#ring[offset + 1];
        this.#read = (this.#read + 1) % this.#capacity;
        this.#available--;
      }
      if (live && !this.#draining) {
        this.#fade = Math.min(1, this.#fade + this.#fadeStep);
      } else if (this.#fade > SPEAKER_FADE_FLOOR) {
        this.#fade -= this.#fade * this.#fadeStep;
      } else {
        this.#fade = 0;
      }
      l *= this.#fade;
      r *= this.#fade;
      left[i] = l;
      if (right) right[i] = r;
      sum += l * l + r * r;
    }
    if (this.#playing && this.#available === 0) {
      // One episode per burst, not per render quantum: the count is the number
      // of gaps the listener hears.
      this.#underruns++;
      this.#playing = false;
      this.#draining = false;
      this.#gapped = true;
    }
    this.#reportLevel(frames, sum);
    return true;
  }

  #reportLevel(frames, sum) {
    this.#levelSum += sum;
    this.#levelCount += frames * 2;
    this.#levelSeconds += frames / sampleRate;
    if (this.#levelSeconds < LEVEL_SECONDS) return;
    if (this.#live) {
      if (this.#gapped) {
        this.#preroll = Math.min(this.#prerollMax, this.#preroll * 2);
        this.#gapped = false;
        this.#steadyReports = 0;
      } else if (this.#playing && this.#preroll > this.#prerollMin) {
        // A gap-free stretch proves the emulator is keeping up: give the
        // latency back.
        if (++this.#steadyReports >= SPEAKER_STEADY_SECONDS / LEVEL_SECONDS) {
          this.#preroll = Math.max(this.#prerollMin, this.#preroll * 0.5);
          this.#steadyReports = 0;
        }
      } else {
        this.#steadyReports = 0;
      }
    }
    this.port.postMessage({
      type: "level",
      rms: this.#levelCount ? Math.min(1, Math.sqrt(this.#levelSum / this.#levelCount)) : 0,
      queued: this.#available,
      prerollMs: this.#preroll / sampleRate * 1000,
      dropped: this.#dropped,
      underruns: this.#underruns,
    });
    this.#levelSeconds = 0;
    this.#levelSum = 0;
    this.#levelCount = 0;
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
