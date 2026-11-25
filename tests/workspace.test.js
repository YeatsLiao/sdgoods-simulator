import test from "node:test";
import assert from "node:assert/strict";
import { initialWorkspace, workspaceTransition, droppedFirmware } from "../web/js/app/workspace-state.js";
import { App } from "../web/js/app/app.js";

test("side key feedback follows press and release sent to the device", () => {
  const sent = [], visuals = [], recorded = [];
  const app = {
    elements: { side: { classList: { toggle: (name, down) => visuals.push([name, down]) } } },
    session: { key: (down) => sent.push(down) },
    macroRecorder: { recordKey: (down) => recorded.push(down) },
  };
  App.prototype.key.call(app, true);
  App.prototype.key.call(app, false);
  assert.deepEqual(sent, [true, false]);
  assert.deepEqual(recorded, sent);
  assert.deepEqual(visuals, [["is-active", true], ["is-active", false]]);
});

test("new audio preferences default to realtime and preserve an explicit replay preference", () => {
  const app = { audio: { setAutoReplay: (settings) => settings }, ui: {} };
  assert.equal(App.prototype.applyReplayPrefs.call(app, null).enabled, false);
  assert.equal(App.prototype.applyReplayPrefs.call(app, { auto: true, seconds: 8 }).enabled, true);
});

test("first frame closes the import panel after boot, but boot alone does not", () => {
  let state = workspaceTransition(initialWorkspace, { type: "phase", phase: "preparing" });
  state = workspaceTransition(state, { type: "phase", phase: "starting" });
  state = workspaceTransition(state, { type: "phase", phase: "waiting" });
  assert.equal(state.open, true);
  state = workspaceTransition(state, { type: "phase", phase: "running" });
  assert.equal(state.open, false);
});

test("a tool explicitly opened during boot survives the first frame", () => {
  let state = workspaceTransition(initialWorkspace, { type: "phase", phase: "preparing" });
  state = workspaceTransition(state, { type: "panel", panel: "console" });
  state = workspaceTransition(state, { type: "phase", phase: "running" });
  assert.equal(state.panel, "console");
  assert.equal(state.open, true);
});

test("failed boot keeps import controls available and can retry", () => {
  let state = workspaceTransition(initialWorkspace, { type: "phase", phase: "preparing" });
  state = workspaceTransition(state, { type: "phase", phase: "error" });
  assert.equal(state.open, true);
  state = workspaceTransition(state, { type: "phase", phase: "preparing" });
  assert.equal(state.phase, "preparing");
});

test("file drops accept one BIN within flash capacity", () => {
  const file = { name: "demo.BIN", size: 100000 };
  assert.equal(droppedFirmware([file]).file, file);
  assert.match(droppedFirmware([]).error, /一个/);
  assert.match(droppedFirmware([file, file]).error, /一个/);
  assert.match(droppedFirmware([{ name: "readme.txt", size: 100 }]).error, /bin/);
  assert.match(droppedFirmware([{ name: "large.bin", size: 32 * 1024 * 1024 + 1 }]).error, /32 MB/);
});

test("cancelling clear data never clears flash or resets the session", async () => {
  const actions = [];
  const app = {
    ui: { confirmClear: async () => false },
    current: { entry: { name: "demo.bin" }, flashKey: "test" },
    session: { restart: () => actions.push("restart") },
    flashStore: { clear: () => actions.push("clear") },
  };
  await App.prototype.restart.call(app, true);
  assert.deepEqual(actions, []);
});

test("ordinary restart preserves flash and waits for a new frame", async () => {
  const actions = [];
  const app = {
    ui: { confirmClear: () => { throw new Error("unexpected confirmation"); }, setPhase: (p) => actions.push(p), setStatus() {} },
    current: { entry: { name: "demo.bin" }, flashKey: "test" },
    session: { restart: (options) => actions.push(options) },
    flashStore: { clear: () => { throw new Error("unexpected clear"); } },
    renderer: { reset() {} }, console: { append() {} }, beginRunHintState() {}, hasFrame: true,
  };
  await App.prototype.restart.call(app, false);
  assert.equal(app.hasFrame, false);
  assert.deepEqual(actions, ["starting", { clearFlash: false }]);
});

test("confirmed clear removes only the current flash key before reset", async () => {
  const actions = [];
  const app = {
    ui: { confirmClear: async () => true, setPhase() {}, setStatus() {} },
    current: { entry: { name: "demo.bin" }, flashKey: "demo-key" },
    session: { restart: (options) => actions.push(options) },
    flashStore: { clear: async (key) => actions.push(key) },
    renderer: { reset() {} }, console: { append() {} }, beginRunHintState() {},
  };
  await App.prototype.restart.call(app, true);
  assert.deepEqual(actions, ["demo-key", { clearFlash: true }]);
});

test("a held keyboard side key releases even when focus moves to a control", () => {
  const keys = [];
  const app = { keyboardSideDown: true, key: (down) => keys.push(down) };
  App.prototype.keyboard.call(app, { code: "Space", target: { tagName: "BUTTON" } }, false);
  assert.deepEqual(keys, [false]);
  assert.equal(app.keyboardSideDown, false);
});

test("keyboard activation of controls never drives the virtual side key", () => {
  const previous = globalThis.document;
  globalThis.document = { querySelector: () => null };
  try {
    const app = { key() { throw new Error("side key must not be driven"); } };
    for (const tagName of ["BUTTON", "SUMMARY", "INPUT", "SELECT", "A"]) {
      App.prototype.keyboard.call(app, { target: { tagName, closest: () => ({}) }, code: "Enter", key: "Enter" }, true);
    }
  } finally { globalThis.document = previous; }
});

test("session boot waits for display and audio format cannot overwrite run status", () => {
  const callbacks = new Map();
  const phases = [];
  const statuses = [];
  const app = {
    ui: { setPhase: (p) => phases.push(p), setStatus: (s) => statuses.push(s), setRunning() {}, showError() {}, setAudioFormat() {} },
    firmwareInfo: () => null,
    renderer: { draw() {} },
    hasFrame: false,
  };
  App.prototype.wireSession.call(app, { on: (event, callback) => callbacks.set(event, callback) });
  callbacks.get("booted")({});
  assert.deepEqual(phases, ["waiting"]);
  callbacks.get("frame")({ packed: new Uint16Array(360 * 360).buffer });
  assert.deepEqual(phases, ["waiting", "running"]);
  callbacks.get("audioformat")({ format: { receive: false, rate: 48000, bits: 16 } });
  assert.equal(statuses.at(-1), "运行中");
});
