import test from "node:test";
import assert from "node:assert/strict";
import { Renderer, rgb565ToRGBA } from "../web/js/render/renderer.js";

const SIZE = 360;

function frameOf(color) {
  return new Uint16Array(SIZE * SIZE).fill(color);
}

// A 2D fallback canvas; probeWebGL2() bails out when document is missing.
function fakeCanvas() {
  const drawn = [];
  const context = {
    fillStyle: "",
    fillRect() {},
    createImageData(width, height) {
      context.image = { width, height, data: new Uint8ClampedArray(width * height * 4) };
      return context.image;
    },
    putImageData(image) {
      drawn.push(image);
    },
  };
  return {
    canvas: {
      width: SIZE,
      height: SIZE,
      getContext: (type) => (type === "2d" ? context : null),
      addEventListener() {},
      removeEventListener() {},
      toBlob(callback) {
        callback(new Blob(["png"], { type: "image/png" }));
      },
    },
    context,
    drawn,
  };
}

function controlledEnvironment() {
  let nextHandle = 0;
  let hidden = false;
  const frames = new Map();
  const timers = new Map();
  const listeners = new Set();
  return {
    env: {
      requestFrame(callback) {
        const handle = ++nextHandle;
        frames.set(handle, callback);
        return handle;
      },
      cancelFrame(handle) {
        frames.delete(handle);
      },
      setTimer(callback, delay) {
        const handle = ++nextHandle;
        timers.set(handle, { callback, delay });
        return handle;
      },
      clearTimer(handle) {
        timers.delete(handle);
      },
      isHidden: () => hidden,
      subscribeVisibility(handler) {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    },
    runFrame() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    },
    runTimer() {
      const pending = [...timers.values()];
      timers.clear();
      for (const { callback } of pending) callback();
    },
    setHidden(value) {
      hidden = value;
      for (const handler of [...listeners]) handler();
    },
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size,
  };
}

function makeRenderer() {
  const fake = fakeCanvas();
  const control = controlledEnvironment();
  const renderer = new Renderer(fake.canvas, control.env);
  return { ...fake, renderer, control };
}

test("rgb565ToRGBA expands known RGB565 colors", () => {
  const rgba = rgb565ToRGBA(Uint16Array.of(0x0000, 0xffff, 0xf800, 0x07e0, 0x001f));
  assert.equal(rgba.length, 5 * 4);
  assert.deepEqual([...rgba.subarray(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...rgba.subarray(4, 8)], [255, 255, 255, 255]);
  assert.deepEqual([...rgba.subarray(8, 12)], [255, 0, 0, 255]);
  assert.deepEqual([...rgba.subarray(12, 16)], [0, 255, 0, 255]);
  assert.deepEqual([...rgba.subarray(16, 20)], [0, 0, 255, 255]);
});

test("rgb565ToRGBA returns four bytes per pixel for a full frame", () => {
  const rgba = rgb565ToRGBA(new Uint16Array(SIZE * SIZE));
  assert.ok(rgba instanceof Uint8ClampedArray);
  assert.equal(rgba.length, SIZE * SIZE * 4);
  assert.equal(rgba[0], 0);
  assert.equal(rgba[3], 255);
});

test("rgb565ToRGBA reuses a provided output buffer", () => {
  const out = new Uint8ClampedArray(2 * 4);
  const first = rgb565ToRGBA(Uint16Array.of(0xf800, 0x001f), out);
  assert.equal(first, out);
  assert.deepEqual([...out], [255, 0, 0, 255, 0, 0, 255, 255]);

  const second = rgb565ToRGBA(Uint16Array.of(0x07e0, 0x0000), out);
  assert.equal(second, out);
  assert.deepEqual([...out], [0, 255, 0, 255, 0, 0, 0, 255]);
});

test("rgb565ToRGBA allocates when the provided buffer is too small", () => {
  const small = new Uint8ClampedArray(4);
  const rgba = rgb565ToRGBA(Uint16Array.of(0xffff, 0xffff), small);
  assert.notEqual(rgba, small);
  assert.equal(rgba.length, 8);
  assert.deepEqual([...rgba], [255, 255, 255, 255, 255, 255, 255, 255]);
});

test("rgb565ToRGBA handles an unaligned output view", () => {
  const backing = new Uint8ClampedArray(2 + 2 * 4);
  const out = backing.subarray(2);
  const rgba = rgb565ToRGBA(Uint16Array.of(0xf800, 0x001f), out);
  assert.equal(rgba, out);
  assert.deepEqual([...out], [255, 0, 0, 255, 0, 0, 255, 255]);
  assert.deepEqual([...backing.subarray(0, 2)], [0, 0]);
});

test("draws the first frame through the animation frame and counts it", () => {
  const { renderer, control, drawn } = makeRenderer();
  renderer.draw(frameOf(0xf800));
  assert.equal(renderer.stats.frames, 0);
  assert.equal(renderer.stats.dropped, 0);
  assert.equal(control.pendingFrames(), 1);
  control.runFrame();
  assert.equal(renderer.stats.frames, 1);
  assert.equal(renderer.stats.dropped, 0);
  assert.equal(drawn.length, 1);
  assert.deepEqual([...drawn.at(-1).data.subarray(0, 3)], [255, 0, 0]);
});

test("paints through the timer fallback while the page is hidden", () => {
  const { renderer, control, drawn } = makeRenderer();
  control.setHidden(true);
  renderer.draw(frameOf(0x07e0));
  assert.equal(control.pendingFrames(), 0);
  assert.equal(control.pendingTimers(), 1);
  assert.equal(renderer.stats.frames, 0);
  control.runTimer();
  assert.equal(renderer.stats.frames, 1);
  assert.equal(renderer.stats.dropped, 0);
  assert.deepEqual([...drawn.at(-1).data.subarray(0, 3)], [0, 255, 0]);
});

test("moves a queued animation frame onto the timer when the page hides", () => {
  const { renderer, control } = makeRenderer();
  renderer.draw(frameOf(0xf800));
  assert.equal(control.pendingFrames(), 1);
  control.setHidden(true);
  assert.equal(control.pendingFrames(), 0);
  assert.equal(control.pendingTimers(), 1);
  control.runTimer();
  assert.equal(renderer.stats.frames, 1);
});

test("flushes the newest frame immediately when the page becomes visible", () => {
  const { renderer, control, drawn } = makeRenderer();
  control.setHidden(true);
  renderer.draw(frameOf(0x001f));
  assert.equal(renderer.stats.frames, 0);
  control.setHidden(false);
  assert.equal(renderer.stats.frames, 1);
  assert.equal(control.pendingTimers(), 0);
  assert.equal(control.pendingFrames(), 0);
  assert.deepEqual([...drawn.at(-1).data.subarray(0, 3)], [0, 0, 255]);
  control.runTimer();
  assert.equal(renderer.stats.frames, 1);
});

test("coalesces multiple queued frames and paints only the newest", () => {
  const { renderer, control, drawn } = makeRenderer();
  renderer.draw(frameOf(0xf800));
  renderer.draw(frameOf(0x07e0));
  renderer.draw(frameOf(0x001f));
  assert.equal(renderer.stats.dropped, 2);
  assert.equal(control.pendingFrames(), 1);
  control.runFrame();
  assert.equal(renderer.stats.frames, 1);
  assert.equal(drawn.length, 1);
  assert.deepEqual([...drawn.at(-1).data.subarray(0, 3)], [0, 0, 255]);
});

test("screenshot flushes a frame queued while hidden", async () => {
  const { renderer, control } = makeRenderer();
  control.setHidden(true);
  renderer.draw(frameOf(0xf800));
  assert.equal(control.pendingTimers(), 1);
  const blob = await renderer.screenshot();
  assert.equal(renderer.stats.frames, 1);
  assert.equal(control.pendingTimers(), 0);
  assert.equal(blob.type, "image/png");
  control.runTimer();
  assert.equal(renderer.stats.frames, 1);
});
