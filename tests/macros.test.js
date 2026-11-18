import assert from "node:assert/strict";
import test from "node:test";

import {
  MACRO_VERSION,
  macroFromJson,
  macroToJson,
  normalizeMacro,
  scheduleMacro,
} from "../web/js/debug/macros.js";

const SAMPLE = [
  { t: 0, kind: "key", down: true },
  { t: 100, kind: "touch", touch: { x: 10, y: 20, down: true } },
  { t: 350, kind: "key", down: false },
];

test("normalizeMacro sorts events, clamps coordinates and coerces flags", () => {
  const macro = normalizeMacro([
    { t: 500, kind: "touch", touch: { x: 400, y: -4, down: 1 } },
    { t: -10, kind: "key", down: 0 },
    { t: 120.6, kind: "touch", touch: { x: 180.2, y: 359.6, down: false } },
  ]);
  assert.equal(macro.count, 3);
  assert.deepEqual(macro.events.map((event) => event.t), [0, 120.6, 500]);
  assert.equal(macro.duration, 500);
  assert.deepEqual(macro.events[0], { t: 0, kind: "key", down: false });
  assert.deepEqual(macro.events[2], { t: 500, kind: "touch", touch: { x: 359, y: 0, down: true } });
  assert.equal(macro.events[1].touch.x, 180);
  assert.equal(macro.events[1].touch.y, 359);
});

test("normalizeMacro drops invalid events and accepts an events wrapper", () => {
  const noisy = normalizeMacro([
    { t: 1, kind: "touch", touch: { x: "bad", y: 1 } },
    { t: 2, kind: "wheel" },
    null,
    "not-an-event",
    { t: 3, kind: "key", down: true },
  ]);
  assert.equal(noisy.count, 1);
  assert.equal(noisy.events[0].kind, "key");

  const wrapped = normalizeMacro({ events: SAMPLE, name: "demo" });
  assert.equal(wrapped.count, 3);
  assert.equal(wrapped.duration, 350);

  assert.deepEqual(normalizeMacro(undefined), { events: [], duration: 0, count: 0 });
  assert.deepEqual(normalizeMacro({}), { events: [], duration: 0, count: 0 });
});

test("normalizeMacro keeps press/release order for equal timestamps and does not mutate input", () => {
  const input = [
    { t: 10, kind: "key", down: true },
    { t: 10, kind: "touch", touch: { x: 1, y: 2, down: true } },
    { t: 10, kind: "key", down: false },
  ];
  const macro = normalizeMacro(input);
  assert.deepEqual(macro.events.map((event) => event.kind), ["key", "touch", "key"]);
  assert.equal(input[0].t, 10);
  assert.notEqual(macro.events[1].touch, input[1].touch);
});

test("scheduleMacro produces relative delays, honors speed and from", () => {
  assert.deepEqual(scheduleMacro(SAMPLE).map((step) => step.delay), [0, 100, 350]);
  assert.deepEqual(scheduleMacro(SAMPLE, { speed: 2 }).map((step) => step.delay), [0, 50, 175]);
  assert.deepEqual(scheduleMacro(SAMPLE, { from: 100 }).map((step) => step.delay), [0, 250]);
  assert.deepEqual(scheduleMacro(SAMPLE, { from: 120 }).map((step) => step.delay), [230]);
  assert.deepEqual(scheduleMacro(SAMPLE, { speed: 0 }).map((step) => step.delay), [0, 100, 350]);
  assert.deepEqual(scheduleMacro(SAMPLE, { speed: -1 }).map((step) => step.delay), [0, 100, 350]);
  assert.deepEqual(scheduleMacro(SAMPLE, { from: -50 }).map((step) => step.delay), [0, 100, 350]);
  assert.deepEqual(scheduleMacro(null), []);
});

test("scheduleMacro keeps the normalized event payload", () => {
  const steps = scheduleMacro([
    { t: 40, kind: "touch", touch: { x: 999, y: -3, down: 1 } },
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].delay, 40);
  assert.deepEqual(steps[0].event, { t: 40, kind: "touch", touch: { x: 359, y: 0, down: true } });
});

test("macro JSON round-trips through macroToJson and macroFromJson", () => {
  const json = macroToJson(SAMPLE, "演示宏");
  const document = JSON.parse(json);
  assert.equal(document.version, MACRO_VERSION);
  assert.equal(document.name, "演示宏");
  assert.equal(document.events.length, 3);

  const imported = macroFromJson(json);
  assert.equal(imported.name, "演示宏");
  assert.equal(imported.count, 3);
  assert.equal(imported.duration, 350);
  assert.ok(imported.savedAt > 0);
  assert.deepEqual(imported.events, normalizeMacro(SAMPLE).events);

  const bare = macroFromJson(JSON.stringify(SAMPLE));
  assert.equal(bare.name, "");
  assert.equal(bare.savedAt, null);
  assert.equal(bare.count, 3);
});

test("macroFromJson rejects malformed documents", () => {
  assert.throws(() => macroFromJson("{"), /宏 JSON 解析失败/);
  assert.throws(() => macroFromJson(JSON.stringify({ foo: 1 })), /events/);
  assert.throws(() => macroFromJson(JSON.stringify({ events: "nope" })), /events/);
});
