const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

const CAPTURE_FPS = 30;
// 360×360 UI text turns to mush below ~4 Mbit/s.
const VIDEO_BITS_PER_SECOND = 4_000_000;

const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

function pickMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of MIME_CANDIDATES) {
    const supported = typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(type);
    if (supported || typeof MediaRecorder.isTypeSupported !== "function") return type;
  }
  return "";
}

/**
 * Canvas recorder: `canvas.captureStream(30)` plus optional audio tracks,
 * packaged as WebM. The caller owns the returned Blob and any download UI.
 */
export class Recorder {
  /** @param {HTMLCanvasElement} canvas @param {{ audioStream?: MediaStream|null }} [options] */
  constructor(canvas, { audioStream = null } = {}) {
    this.canvas = canvas;
    this.audioStream = audioStream;
    this.state = "idle";
    this.mimeType = "";
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.listeners = new Set();
    this.startedAt = 0;
    this.stopResolve = null;
    this.pendingStop = null;
  }

  get recording() {
    return this.state === "recording";
  }

  /**
   * Subscribe to state transitions: `{ state, mimeType, chunks, duration?, size?, error? }`.
   * @param {(detail: Record<string, unknown>) => void} callback
   * @returns {() => void} unsubscribe
   */
  onState(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Start recording. Returns false when capture or MediaRecorder is
   * unavailable, or when a recording is already running.
   * @returns {boolean}
   */
  start() {
    if (this.state !== "idle") return false;
    if (!this.canvas?.captureStream) return false;
    const mimeType = pickMimeType();
    if (!mimeType) return false;
    let stream = null;
    try {
      const video = this.canvas.captureStream(CAPTURE_FPS);
      const tracks = [...video.getVideoTracks()];
      for (const track of this.audioStream?.getAudioTracks?.() ?? []) tracks.push(track);
      if (!tracks.length) return false;
      stream = new MediaStream(tracks);
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
      this.chunks = [];
      this.stream = stream;
      this.recorder = recorder;
      this.mimeType = recorder.mimeType || mimeType;
      this.startedAt = now();
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) this.chunks.push(event.data);
      };
      recorder.onstop = () => {
        if (this.recorder === recorder) this.#finish();
      };
      recorder.onerror = (event) => {
        if (this.recorder !== recorder) return;
        const message = event?.error?.message || "录屏失败";
        console.error("Recorder:", message);
        try {
          recorder.stop();
        } catch {
          // The recorder may already be inactive.
        }
        this.#finish(message);
      };
      recorder.start(1000);
      this.state = "recording";
      this.#emit();
      return true;
    } catch (error) {
      console.error("Recorder.start:", error);
      this.#cleanup(stream);
      this.state = "idle";
      return false;
    }
  }

  /**
   * Stop recording and stop all captured tracks.
   * @returns {Promise<Blob|null>} null when nothing was recorded
   */
  stop() {
    if (this.pendingStop) return this.pendingStop;
    if (this.state !== "recording" || !this.recorder) return Promise.resolve(null);
    const recorder = this.recorder;
    this.state = "stopping";
    this.#emit();
    this.pendingStop = new Promise((resolve) => {
      this.stopResolve = resolve;
    });
    try {
      recorder.stop();
    } catch {
      this.#finish();
    }
    return this.pendingStop;
  }

  /** @param {string} [errorMessage] */
  #finish(errorMessage) {
    const blob = this.chunks.length ? new Blob(this.chunks, { type: this.mimeType || "video/webm" }) : null;
    const duration = this.startedAt ? now() - this.startedAt : 0;
    const resolve = this.stopResolve;
    this.stopResolve = null;
    this.pendingStop = null;
    this.state = "idle";
    this.#cleanup();
    this.#emit({ duration, size: blob?.size ?? 0, error: errorMessage ?? null });
    resolve?.(blob);
  }

  /** @param {MediaStream|null} [stream] */
  #cleanup(stream = this.stream) {
    for (const track of stream?.getTracks?.() ?? []) {
      try {
        track.stop();
      } catch {
        // Stopping an ended track is harmless.
      }
    }
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }

  /** @param {Record<string, unknown>} [extra] */
  #emit(extra = {}) {
    const detail = { state: this.state, mimeType: this.mimeType, chunks: this.chunks.length, ...extra };
    for (const callback of this.listeners) {
      try {
        callback(detail);
      } catch (error) {
        console.error(error);
      }
    }
  }
}
