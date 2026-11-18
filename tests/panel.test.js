import test from "node:test";
import assert from "node:assert/strict";
import { Panel, SIZE } from "../web/js/device/panel.js";

function header(command, more = true) {
  return { 3: Uint8Array.of(0x02, 0x00, command, 0x00), 12: more ? 1 : undefined };
}

function payload(bytes, more = true) {
  return { 3: Uint8Array.from(bytes), 12: more ? 1 : undefined };
}

function setWindow(panel, axis, start, end) {
  panel.transfer(header(axis));
  panel.transfer(payload([start >> 8, start & 0xff, end >> 8, end & 0xff], false));
}

function pixels(...colors) {
  const bytes = [];
  for (const color of colors) bytes.push(color >> 8, color & 0xff);
  return bytes;
}

test("decodes 0x2A/0x2B windows and a 0x2C pixel write", () => {
  const panel = new Panel();
  assert.equal(panel.packed.length, SIZE * SIZE);
  assert.equal(panel.takeFrame(), null);

  setWindow(panel, 0x2a, 0, 0);
  setWindow(panel, 0x2b, 0, 0);
  panel.transfer(header(0x2c));
  panel.transfer(payload(pixels(0xf800), false));

  assert.equal(panel.packed[0], 0xf800);
  const frame = panel.takeFrame();
  assert.ok(frame instanceof Uint16Array);
  assert.equal(frame.length, SIZE * SIZE);
  assert.equal(frame[0], 0xf800);
  assert.equal(panel.takeFrame(), null);
});

test("accepts a command header and pixel data in one transfer", () => {
  const panel = new Panel();
  setWindow(panel, 0x2a, 0, 0);
  setWindow(panel, 0x2b, 0, 0);

  panel.transfer({ 3: Uint8Array.of(0x02, 0x00, 0x2c, 0x00, 0x07, 0xe0), 12: 0 });

  assert.equal(panel.packed[0], 0x07e0);
  assert.equal(panel.takeFrame()[0], 0x07e0);
});

test("assembles window parameters split across continuation transfers", () => {
  const panel = new Panel();
  panel.transfer(header(0x2a));
  panel.transfer(payload([0x00, 0x01], true));
  panel.transfer(payload([0x00, 0x01], false));
  panel.transfer(header(0x2b));
  panel.transfer(payload([0x00, 0x02, 0x00, 0x02], false));
  panel.transfer(header(0x2c));
  panel.transfer(payload(pixels(0x1234), false));

  assert.equal(panel.packed[2 * SIZE + 1], 0x1234);
  assert.equal(panel.dirty, true);
});

test("keeps a partial window open until 0x3C continues it", () => {
  const panel = new Panel();
  setWindow(panel, 0x2a, 10, 11);
  setWindow(panel, 0x2b, 5, 6);

  panel.transfer(header(0x2c));
  panel.transfer(payload(pixels(0x1111, 0x2222, 0x3333), false));
  assert.equal(panel.dirty, false);
  assert.equal(panel.takeFrame(), null);

  panel.transfer(header(0x3c));
  panel.transfer(payload(pixels(0x4444), false));
  assert.equal(panel.dirty, true);

  const frame = panel.takeFrame();
  assert.equal(frame[5 * SIZE + 10], 0x1111);
  assert.equal(frame[5 * SIZE + 11], 0x2222);
  assert.equal(frame[6 * SIZE + 10], 0x3333);
  assert.equal(frame[6 * SIZE + 11], 0x4444);
});

test("carries an odd byte across continuation transfers", () => {
  const panel = new Panel();
  setWindow(panel, 0x2a, 0, 0);
  setWindow(panel, 0x2b, 0, 0);

  panel.transfer(header(0x2c));
  panel.transfer(payload([0xf8]));
  assert.equal(panel.dirty, false);
  assert.equal(panel.takeFrame(), null);

  panel.transfer(payload([0x00], false));
  assert.equal(panel.dirty, true);
  assert.equal(panel.packed[0], 0xf800);
  assert.equal(panel.takeFrame()[0], 0xf800);
});

test("clips pixels outside the panel and marks dirty only after the last row", () => {
  const panel = new Panel();
  setWindow(panel, 0x2a, 358, 361);
  setWindow(panel, 0x2b, 358, 359);

  panel.transfer(header(0x2c));
  panel.transfer(payload(pixels(0x0101, 0x0202, 0x0303, 0x0404)));
  assert.equal(panel.dirty, false);

  panel.transfer(payload(pixels(0x0505, 0x0606, 0x0707, 0x0808), false));
  assert.equal(panel.dirty, true);

  const frame = panel.takeFrame();
  assert.equal(frame.length, SIZE * SIZE);
  assert.equal(frame[358 * SIZE + 358], 0x0101);
  assert.equal(frame[358 * SIZE + 359], 0x0202);
  assert.equal(frame[359 * SIZE + 358], 0x0505);
  assert.equal(frame[359 * SIZE + 359], 0x0606);
  for (const clipped of [0x0303, 0x0404, 0x0707, 0x0808]) {
    assert.equal(frame.includes(clipped), false);
  }
});

test("takeFrame returns a copy and clears dirty", () => {
  const panel = new Panel();
  setWindow(panel, 0x2a, 0, 0);
  setWindow(panel, 0x2b, 0, 0);
  panel.transfer(header(0x2c));
  panel.transfer(payload(pixels(0x1234), false));

  const frame = panel.takeFrame();
  assert.notEqual(frame, panel.packed);
  assert.notEqual(frame.buffer, panel.packed.buffer);
  frame[0] = 0;
  assert.equal(panel.packed[0], 0x1234);
  assert.equal(panel.takeFrame(), null);
});

test("reset clears transfer state, half bytes, and dirty without reallocating", () => {
  const panel = new Panel();
  const buffer = panel.packed;
  setWindow(panel, 0x2a, 2, 3);
  setWindow(panel, 0x2b, 4, 5);
  panel.transfer(header(0x2c));
  panel.transfer(payload([0x12]));

  panel.reset();
  assert.equal(panel.packed, buffer);
  assert.equal(panel.dirty, false);
  assert.equal(panel.takeFrame(), null);
  assert.equal(panel.command, 0);
  assert.equal(panel.headerBytes, 0);
  assert.equal(panel.highByte, null);

  panel.transfer(header(0x2c));
  panel.transfer(payload(pixels(0x3456), false));
  assert.equal(panel.packed[0], 0x3456);
  assert.equal(panel.dirty, false);
});
