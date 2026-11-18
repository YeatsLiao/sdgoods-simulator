/**
 * 360×360 RGB565 screen renderer.
 *
 * WebGL2 uploads the packed framebuffer as one RGB565 texture and paints it
 * with a full-screen triangle, so the main thread never converts pixels. When
 * WebGL2 or the RGB565 texture format is unusable, a 2D context expands the
 * frame through a 65536-entry LUT into a reused ImageData.
 *
 * draw() schedules at most one requestAnimationFrame and keeps only the newest
 * buffer; screenshot() flushes the pending frame synchronously before capture.
 * While the page is hidden, requestAnimationFrame may never run, so the same
 * coalescing is driven by a short timer instead, and visibilitychange flushes
 * the newest frame immediately on return.
 */

const SIZE = 360;
const PIXELS = SIZE * SIZE;
// Hidden tabs suspend requestAnimationFrame; paint at a bounded rate instead.
const HIDDEN_FLUSH_MS = 32;

const defaultEnvironment = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (handle) => clearTimeout(handle),
  isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  subscribeVisibility: (handler) => {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
      return () => {};
    }
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  },
};

const CONTEXT_ATTRIBUTES = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  // screenshot() must be able to read the last presented frame in any task.
  preserveDrawingBuffer: true,
  powerPreference: "high-performance",
};

const VERTEX_SHADER = `#version 300 es
out vec2 vUv;
void main() {
  // gl_VertexID 0..2 covers the whole clip space with one oversized triangle.
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D uScreen;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uScreen, vUv).rgb, 1.0);
}`;

const now = () => (typeof performance === "object" && typeof performance.now === "function"
  ? performance.now()
  : Date.now());

function buildLut() {
  const bytes = new Uint8ClampedArray(65536 * 4);
  const five = new Uint8Array(32);
  const six = new Uint8Array(64);
  for (let i = 0; i < five.length; i++) five[i] = Math.round((i * 255) / 31);
  for (let i = 0; i < six.length; i++) six[i] = Math.round((i * 255) / 63);
  for (let value = 0, offset = 0; value < 65536; value++, offset += 4) {
    bytes[offset] = five[value >> 11];
    bytes[offset + 1] = six[(value >> 5) & 63];
    bytes[offset + 2] = five[value & 31];
    bytes[offset + 3] = 255;
  }
  return bytes;
}

const LUT_BYTES = buildLut();
// A word-sized view of the byte LUT: copying words preserves byte order on any
// endianness, and keeps the 2D fallback at one memory write per pixel.
const LUT = new Uint32Array(LUT_BYTES.buffer);

/**
 * Expand packed RGB565 pixels to opaque RGBA8888.
 * The result is `out` itself when `out` has room for every pixel, otherwise a
 * newly allocated array. No per-pixel allocation.
 * @param {Uint16Array} packed RGB565 pixels, top-left origin
 * @param {Uint8ClampedArray} [out] reusable destination
 * @returns {Uint8ClampedArray} RGBA bytes, 4 per pixel
 */
export function rgb565ToRGBA(packed, out) {
  const count = packed ? packed.length : 0;
  const required = count * 4;
  if (!out || !(out.byteLength >= required)) out = new Uint8ClampedArray(required);
  if (out.byteOffset % 4 === 0) {
    const destination = new Uint32Array(out.buffer, out.byteOffset, count);
    for (let i = 0; i < count; i++) destination[i] = LUT[packed[i] & 0xffff];
  } else {
    for (let i = 0, offset = 0; i < count; i++, offset += 4) {
      const source = (packed[i] & 0xffff) * 4;
      out[offset] = LUT_BYTES[source];
      out[offset + 1] = LUT_BYTES[source + 1];
      out[offset + 2] = LUT_BYTES[source + 2];
      out[offset + 3] = LUT_BYTES[source + 3];
    }
  }
  return out;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(`着色器编译失败：${log}`);
  }
  return shader;
}

function linkProgram(gl, vertexSource, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "";
    gl.deleteProgram(program);
    throw new Error(`着色器链接失败：${log}`);
  }
  return program;
}

class WebGLSurface {
  constructor(gl, width, height) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    this.program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.texture = gl.createTexture();
    this.vao = gl.createVertexArray();
    if (!this.texture || !this.vao) throw new Error("WebGL 资源创建失败");
    this.textureReady = false;

    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uScreen"), 0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Source row 0 is the top scanline; flipping at upload lets the shader use
    // v=0 at the bottom of the screen.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    this.clear();
  }

  clear() {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** @param {Uint16Array} packed width × height RGB565 pixels */
  draw(packed) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.textureReady) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height,
        gl.RGB, gl.UNSIGNED_SHORT_5_6_5, packed);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB565, this.width, this.height, 0,
        gl.RGB, gl.UNSIGNED_SHORT_5_6_5, packed);
      this.textureReady = true;
    }
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

/**
 * Verify WebGL2 + RGB565 + this shader pipeline on a throwaway canvas before
 * the real canvas is locked to the "webgl2" context mode. Once locked, a 2D
 * context can never be created on that canvas, so this probe is the only
 * reliable point for a clean 2D fallback.
 */
function probeWebGL2() {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
  let gl = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    gl = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
    if (!gl) return false;
    const surface = new WebGLSurface(gl, 2, 2);
    surface.draw(Uint16Array.of(0xf800, 0x07e0, 0x001f, 0xffff));
    if (gl.getError() !== gl.NO_ERROR) return false;
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    // Flipped upload: the texture's bottom row is the source's last row, so
    // the bottom-left pixel must be blue, not red.
    return pixel[0] < 16 && pixel[2] > 239 && pixel[3] > 239;
  } catch {
    return false;
  } finally {
    try {
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // Releasing the probe context is best-effort.
    }
  }
}

export class Renderer {
  #onFrame = () => {
    this.pending = null;
    this.#flush();
  };

  #onTimer = () => {
    this.timer = null;
    this.#flush();
  };

  #onVisibilityChange = () => {
    if (!this.env.isHidden()) {
      // Returning to view must present the newest frame now, not on a later
      // animation frame that the browser may delay.
      this.#cancelScheduled();
      this.#flush();
      return;
    }
    // rAF is suspended while hidden; move a queued paint onto the timer path.
    if (this.pending !== null) {
      this.env.cancelFrame(this.pending);
      this.pending = null;
      if (this.latest) this.timer = this.env.setTimer(this.#onTimer, HIDDEN_FLUSH_MS);
    }
  };

  #onContextLost = (event) => {
    // Preventing the default keeps the door open for a browser restore.
    event.preventDefault();
    this.webglLost = true;
  };

  #onContextRestored = () => this.#restoreWebGL();

  /**
   * @param {HTMLCanvasElement} canvas 360×360 target canvas; width/height are owned by the page
   * @param {Partial<typeof defaultEnvironment>} [environment] scheduling hooks, injectable for tests
   */
  constructor(canvas, environment = {}) {
    if (!canvas) throw new TypeError("Renderer 需要 360×360 画布");
    this.canvas = canvas;
    this.env = { ...defaultEnvironment, ...environment };
    this.type = "2d";
    this.frames = 0;
    this.drawMs = 0;
    this.dropped = 0;
    /** @type {number|null} pending requestAnimationFrame handle */
    this.pending = null;
    /** @type {number|null} pending hidden-mode timer handle */
    this.timer = null;
    /** @type {Uint16Array|null} newest frame not drawn yet */
    this.latest = null;
    /** @type {Uint16Array|null} frame kept for repaint after context restore */
    this.last = null;
    this.gl = null;
    this.surface = null;
    this.context = null;
    this.image = null;
    this.webglLost = false;

    if (probeWebGL2()) {
      try {
        const gl = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
        if (gl) {
          this.surface = new WebGLSurface(gl, SIZE, SIZE);
          this.gl = gl;
          this.type = "webgl";
          canvas.addEventListener("webglcontextlost", this.#onContextLost, false);
          canvas.addEventListener("webglcontextrestored", this.#onContextRestored, false);
        }
      } catch (error) {
        console.warn("Renderer: WebGL2 初始化失败，尝试 2D 回退", error);
        this.gl = null;
        this.surface = null;
      }
    }
    if (this.type !== "webgl") this.#init2D();
    this.env.subscribeVisibility(this.#onVisibilityChange);
  }

  /** @returns {{frames: number, drawMs: number, dropped: number}} */
  get stats() {
    return { frames: this.frames, drawMs: this.drawMs, dropped: this.dropped };
  }

  /**
   * Queue a frame. At most one paint is outstanding — requestAnimationFrame
   * while visible, a short timer while hidden — and frames arriving before it
   * runs replace the queued one and count as dropped.
   * The buffer is kept by reference (the newest is also kept for repaint after
   * a WebGL context restore), so callers must hand over an immutable buffer.
   * @param {Uint16Array} packed 360×360 RGB565 pixels, top-left origin
   */
  draw(packed) {
    if (!packed || packed.length !== PIXELS) {
      throw new RangeError(`帧数据长度应为 ${PIXELS}，收到 ${packed?.length ?? 0}`);
    }
    if (this.type === "webgl" && this.webglLost) {
      // Keep the newest frame only; the restore handler repaints it.
      this.latest = packed;
      return;
    }
    if (this.pending !== null || this.timer !== null) {
      this.dropped += 1;
      this.latest = packed;
      return;
    }
    this.latest = packed;
    if (this.env.isHidden()) {
      // rAF does not fire in hidden tabs; coalesce through a short timer so
      // the newest frame still reaches the canvas.
      this.timer = this.env.setTimer(this.#onTimer, HIDDEN_FLUSH_MS);
    } else {
      this.pending = this.env.requestFrame(this.#onFrame);
    }
  }

  /** Clear the screen to black and reset frame counters. */
  reset() {
    this.#cancelScheduled();
    this.latest = null;
    this.last = null;
    this.frames = 0;
    this.drawMs = 0;
    this.dropped = 0;
    if (this.type === "webgl") this.surface.clear();
    else this.#clear2D();
  }

  /**
   * Draw any queued frame synchronously, then capture the canvas as PNG.
   * @returns {Promise<Blob>}
   */
  async screenshot() {
    this.#cancelScheduled();
    if (this.latest) this.#flush();
    if (this.type === "webgl") {
      try {
        this.gl.finish();
      } catch {
        // A lost context has nothing left to finish.
      }
    }
    const canvas = this.canvas;
    if (typeof canvas.toBlob === "function") {
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("截图失败：无法生成 PNG"))), "image/png");
      });
    }
    const response = await fetch(canvas.toDataURL("image/png"));
    return response.blob();
  }

  /**
   * @param {number} [fps]
   * @returns {MediaStream}
   */
  captureStream(fps = 30) {
    return this.canvas.captureStream(fps);
  }

  #cancelScheduled() {
    if (this.pending !== null) {
      this.env.cancelFrame(this.pending);
      this.pending = null;
    }
    if (this.timer !== null) {
      this.env.clearTimer(this.timer);
      this.timer = null;
    }
  }

  #flush() {
    const packed = this.latest;
    if (!packed) return;
    if (this.type === "webgl" && (this.webglLost || !this.surface)) return;
    this.latest = null;
    this.#drawFrame(packed);
  }

  #drawFrame(packed) {
    const started = now();
    if (this.type === "webgl") this.surface.draw(packed);
    else this.#draw2D(packed);
    this.drawMs = now() - started;
    this.frames += 1;
    this.last = packed;
  }

  #draw2D(packed) {
    rgb565ToRGBA(packed, this.image.data);
    this.context.putImageData(this.image, 0, 0);
  }

  #init2D() {
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("画布已被其他上下文占用，无法创建 2D 渲染上下文");
    this.context = context;
    this.image = context.createImageData(SIZE, SIZE);
    this.#clear2D();
  }

  #clear2D() {
    this.context.fillStyle = "#000000";
    this.context.fillRect(0, 0, SIZE, SIZE);
  }

  #restoreWebGL() {
    if (this.type !== "webgl" || !this.gl) return;
    try {
      this.surface = new WebGLSurface(this.gl, SIZE, SIZE);
    } catch (error) {
      console.error("Renderer: WebGL2 上下文恢复失败", error);
      return;
    }
    this.webglLost = false;
    const frame = this.latest ?? this.last;
    this.latest = null;
    if (!frame) return;
    try {
      this.#drawFrame(frame);
    } catch (error) {
      console.error("Renderer: WebGL2 恢复后重绘失败", error);
    }
  }
}
