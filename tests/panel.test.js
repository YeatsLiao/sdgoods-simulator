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

// --- minimal DOM shell -----------------------------------------------------
// createUI() only needs id lookup, class/dataset handling and text writes.
class Node {}

class FakeNode extends Node {
  constructor(tag, document = globalThis.document) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.attributes = new Map();
    this.style = makeStyle();
    this.dataset = {};
    this.classList = makeClassList(this);
    this.listeners = new Map();
    this._text = "";
    this.textContentWrites = 0;
  }

  get className() {
    return this.classes.join(" ");
  }

  set className(value) {
    this.classes = String(value).split(/\s+/).filter(Boolean);
  }

  get id() {
    return this.attributes.get("id") ?? "";
  }

  append(...nodes) {
    for (const node of nodes.flat()) {
      if (node === null || node === undefined) continue;
      const child = node instanceof Node ? node : new Text(String(node), this.ownerDocument);
      child.parentNode = this;
      this.children.push(child);
      // Keep the id index current: panels.js appends its own subtrees after the
      // shell was registered.
      if (child instanceof FakeNode) this.ownerDocument?.registerTree?.(child);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  prepend(...nodes) {
    const existing = this.children;
    this.children = [];
    this.append(...nodes);
    this.children.push(...existing);
  }

  get options() { return this._options ?? this.children.filter((child) => child.tagName === "OPTION"); }
  set options(value) { this._options = value; }

  remove() {
    const siblings = this.parentNode?.children;
    if (!siblings) return;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (this.tagName === "OPTION" && name === "value") this.value = String(value);
    if (name.startsWith("data-")) {
      this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(value);
    }
  }

  getAttribute(name) {
    if (name.startsWith("data-")) return this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] ?? null;
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  // 面板与宿主之间用 CustomEvent 通信，桩只需把 detail 交给同一节点上的处理器。
  dispatchEvent(event) {
    for (const handler of this.listeners.get(event?.type) ?? []) handler(event);
    return true;
  }

  click() {
    for (const handler of this.listeners.get("click") ?? []) handler({ target: this });
  }

  fire(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler({ type, target: this, ...event });
  }

  querySelectorAll(selector) {
    return collect(this, selectorMatcher(selector));
  }

  querySelector(selector) {
    const wanted = String(selector).trim();
    // `[id="x"]` and `#x` resolve through the id map, like the real lookup does.
    const id = /^#(.+)$/.exec(wanted)?.[1] ?? /^\[id="([^"]+)"\]$/.exec(wanted)?.[1];
    if (id) return this.ownerDocument.getElementById(id);
    if (wanted.startsWith("[") && wanted.endsWith("]")) {
      const [, name, value] = /^\[(\w[\w-]*)="?([^"\]]*)"?\]$/.exec(wanted) ?? [];
      if (!name) return null;
      return collect(this, (node) => node.getAttribute(name) === value)[0] ?? null;
    }
    return collect(this, selectorMatcher(wanted))[0] ?? null;
  }

  get firstElementChild() {
    return this.children.find((child) => child instanceof FakeNode) ?? null;
  }

  contains(node) {
    return node === this || this.children.some((child) => child.contains?.(node));
  }

  // Text is resolved through the subtree so chip assertions read the label.
  get textContent() {
    if (this._text) return this._text;
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
    this.textContentWrites += 1;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: SIZE, height: SIZE };
  }

  focus() { this.ownerDocument.activeElement = this; }
  getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
}

class Text extends Node {
  constructor(value, document = globalThis.document) {
    super();
    this.value = value;
    this.ownerDocument = document;
    this.children = [];
  }

  get textContent() {
    return this.value;
  }
}

// Enough selector support for what createUI() and these tests ask for:
// tag names, `.class`, `[attr="value"]` and compound forms like `span.chip`.
function selectorMatcher(selector) {
  const source = String(selector).trim();
  if (source === "*") return () => true;
  const parts = [];
  const tag = /^[a-zA-Z][\w-]*/.exec(source)?.[0];
  if (tag) parts.push((node) => node.tagName === tag.toUpperCase());
  for (const [, name] of source.matchAll(/\.([\w-]+)/g)) {
    parts.push((node) => node.classList.contains(name));
  }
  for (const [, name, raw] of source.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    parts.push((node) => (raw === undefined ? node.getAttribute(name) !== null : node.getAttribute(name) === raw));
  }
  if (!parts.length) throw new Error(`测试 DOM 桩不支持选择器 ${selector}`);
  return (node) => parts.every((test) => test(node));
}

function collect(root, match) {
  const found = [];
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (!(child instanceof FakeNode)) continue;
      if (match(child)) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

// Enough of CSSStyleDeclaration for the meter fills and the volume slider.
function makeStyle() {
  const properties = new Map();
  return {
    setProperty(name, value) {
      properties.set(name, value);
    },
    getPropertyValue(name) {
      return properties.get(name) ?? "";
    },
  };
}

function makeClassList(node) {
  node.classes = [];
  const sync = (names) => {
    node.classes = names;
  };
  return {
    add(...names) {
      sync([...new Set([...node.classes, ...names])]);
    },
    remove(...names) {
      sync(node.classes.filter((name) => !names.includes(name)));
    },
    contains(name) {
      return node.classes.includes(name);
    },
    toggle(name, force) {
      const on = force === undefined ? !node.classes.includes(name) : Boolean(force);
      if (on) sync([...new Set([...node.classes, name])]);
      else sync(node.classes.filter((item) => item !== name));
      return on;
    },
  };
}

class FakeDocument {
  constructor(root) {
    this.nodes = new Map();
    this.body = new FakeNode("body", this);
    if (root) this.registerTree(root);
  }

  registerTree(node) {
    if (!(node instanceof FakeNode)) return;
    // `id` is an attribute getter, so registering before the tree is attached
    // still makes getElementById() work.
    if (node.id) this.nodes.set(node.id, node);
    for (const child of node.children ?? []) this.registerTree(child);
  }

  createElement(tag) {
    return new FakeNode(tag, this);
  }

  createElementNS(_ns, tag) {
    return new FakeNode(tag, this);
  }

  createTextNode(value) {
    return new Text(value, this);
  }

  getElementById(id) {
    return this.nodes.get(id) ?? null;
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  get activeElement() {
    return this._activeElement ?? null;
  }
  set activeElement(node) { this._activeElement = node; }
}

// Factory helpers take the document explicitly: nodes built before the stub is
// installed must not fall back to a global that does not exist yet.
function button(document, id, label, extra = {}) {
  const node = new FakeNode("button", document);
  node.setAttribute("id", id);
  node.className = `btn ${extra.className ?? ""}`.trim();
  if (label) node.append(new Text(label, document));
  if (extra.iconOnly) node.classList.add("btn-icon");
  return node;
}

function input(document, id, type, extra = {}) {
  const node = new FakeNode("input", document);
  node.setAttribute("id", id);
  node.setAttribute("type", type);
  node.value = extra.value ?? "";
  node.className = extra.className ?? "";
  return node;
}

function select(document, id, options) {
  const node = new FakeNode("select", document);
  node.setAttribute("id", id);
  node.options = options.map((option) => {
    const item = new FakeNode("option", document);
    item.value = option.value;
    item.disabled = Boolean(option.disabled);
    item.append(new Text(option.label, document));
    return item;
  });
  for (const item of node.options) node.append(item);
  node.value = node.options[0].value;
  return node;
}

function mount(document, id, className) {
  const node = new FakeNode("div", document);
  node.setAttribute("id", id);
  node.className = className;
  return node;
}

function buildShell() {
  const document = new FakeDocument();
  const app = new FakeNode("div", document);
  app.setAttribute("id", "app");
  app.className = "app";
  document.registerTree(app);
  app.append(
    button(document, "open-firmware", "打开 BIN"),
    button(document, "try-sample", "试玩示例"),
    button(document, "recent-open", "最近使用"),
    button(document, "change-firmware", "更换"),
    button(document, "sound-open", "声音"),
    button(document, "settings-open", "帮助与设置"),
    button(document, "clear-open", "清除数据"),
    button(document, "setup-open", "配网帮助"),
    mount(document, "device-more", "device-more"),
    mount(document, "workspace-panel", "panel-column"),
    mount(document, "workspace-panel-title", ""),
    button(document, "panel-close", "收起工作面板"),
    mount(document, "drop-overlay", ""),
    mount(document, "screen-state", ""),
    mount(document, "screen-state-hint", ""),
    mount(document, "status", "status"),
    mount(document, "status-text", "status-text"),
    mount(document, "firmware-meta", "current-firmware"),
    mount(document, "firmware-name", "firmware-name"),
    mount(document, "firmware-version", "chip firmware-version"),
    select(document, "mode", [{ value: "wasm" }, { value: "native", disabled: true }]),
    button(document, "dev", "开发者"),
    button(document, "share", "", { iconOnly: true }),
    mount(document, "tabs", "tabs-host"),
    mount(document, "panel-host", "panel-host"),
    mount(document, "launcher", "launcher"),
    mount(document, "launcher-overlay", "launcher-overlay"),
    mount(document, "launcher-list", "launcher-list"),
    mount(document, "launcher-hint", "launcher-hint"),
    button(document, "launcher-close", "", { iconOnly: true }),
    button(document, "run", "运行"),
    button(document, "restart", "重启"),
    button(document, "reset", "清除数据"),
    button(document, "mute", "", { iconOnly: true }),
    input(document, "volume", "range", { value: "80" }),
    button(document, "screenshot", "", { iconOnly: true }),
    button(document, "record", "录屏"),
    button(document, "fullscreen", "", { iconOnly: true }),
    input(document, "file", "file"),
    mount(document, "run-cta", "run-cta"),
    button(document, "run-cta-button", "运行示例固件"),
    mount(document, "touch-overlay", "touch-overlay"),
    mount(document, "touch-dot", "touch-dot"),
    mount(document, "touch-readout", "touch-readout"),
    mount(document, "onboarding", "onboarding"),
    mount(document, "onboarding-native", "mode-state"),
    button(document, "onboarding-close", "", { iconOnly: true }),
    button(document, "onboarding-sample", "运行示例固件"),
    button(document, "onboarding-file", "选择本地固件"),
    button(document, "onboarding-url", "使用固件链接"),
    mount(document, "error-card", "error-card"),
    mount(document, "error-message", "error-message"),
    mount(document, "error-actions", "error-actions"),
    button(document, "error-close", "", { iconOnly: true }),
  );
  const canvas = new FakeNode("canvas", document);
  canvas.setAttribute("id", "screen");
  const side = new FakeNode("button", document);
  side.setAttribute("id", "side");
  app.append(canvas, side);
  document.registerTree(app);

  document.root = app;
  document.canvas = canvas;
  document.window = { location: { href: "http://127.0.0.1:8765/" }, addEventListener() {} };
  return { app, document, canvas };
}

async function withDom(run, workbench = false) {
  const shell = buildShell();
  if (workbench) shell.app.append(mount(shell.document, "sidebar-library", ""), mount(shell.document, "sidebar-mode", ""), button(shell.document, "dock-open", "串口日志"), button(shell.document, "mobile-recent", "最近"));
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    CustomEvent: globalThis.CustomEvent,
    Element: globalThis.Element,
    Node: globalThis.Node,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  // Nodes created while the stub is installed resolve their owner document from
  // the global, so they can answer id lookups like a real tree.
  globalThis.document = shell.document;
  globalThis.window = shell.document.window;
  globalThis.Node = Node;
  globalThis.Element = FakeNode;
  globalThis.CustomEvent = class {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  };
  globalThis.requestAnimationFrame = () => 0;
  try {
    // panels.js is imported inside the stub so its top-level DOM reads resolve.
    const { createUI } = await import("../web/js/ui/panels.js");
    return await run(createUI(shell.document.getElementById("app")), shell);
  } finally {
    Object.assign(globalThis, previous);
  }
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

test("microphone level is shown only while enabled and resets on stop", async () => {
  await withDom(async (ui, { document }) => {
    const level = document.getElementById("audio-in-level");
    assert.equal(level.hidden, true);
    ui.setMicActive(true); ui.setAudioLevels({ in: .42 });
    assert.equal(level.hidden, false);
    assert.equal(level.dataset.level, "0.42");
    assert.equal(ui.elements.mic.getAttribute("aria-pressed"), "true");
    ui.setMicActive(false);
    assert.equal(level.hidden, true);
    assert.equal(level.dataset.level, "0.00");
  });
});

test("audio strategy controls are absent from the interface", async () => {
  await withDom(async (ui, { document }) => {
    for (const id of ["audio-playback", "audio-auto", "audio-length", "audio-capture", "panel-audio"]) assert.equal(document.getElementById(id), null);
    ui.showPanel("sound");
    assert.equal(document.getElementById("app").dataset.surface, "tools");
    assert.equal(document.getElementById("tabs").hidden, false);
  });
});

test("stats panel keeps text metrics and dashes unmeasured ratios", async () => {
  await withDom(async (_ui, shell) => {
    // The same card grid formats numbers and strings, and a numeric coercion in
    // the lookup would silently blank the transport row.
    const { StatsPanel } = await import("../web/js/debug/stats.js");
    const panel = new StatsPanel({ mount: shell.app });
    const text = (key) => panel.grid.children
      .find((node) => node.dataset.metric === key)
      .children[1].textContent;

    panel.update({ stats: { fps: 24, transport: "ws", realTime: null } });
    assert.equal(text("transport"), "本机 WebSocket");
    assert.equal(text("fps"), "24.0");
    assert.equal(text("realTime"), "—");

    panel.update({ stats: { transport: "wasm", realTime: 0.62, audioArrival: 0.13 } });
    assert.equal(text("transport"), "浏览器 WASM");
    assert.equal(text("realTime"), "0.62×");
    assert.equal(text("audioArrival"), "13%");
  });
});

test("showcase starts with tools closed and keeps the sample action in the library flow", async () => {
  await withDom(async (ui, { document }) => {
    assert.equal(document.getElementById('workspace-panel').hidden, true);
    const actions = [];
    ui.elements.panelHost.addEventListener('sdg:library', event => actions.push(event.detail.action));
    document.getElementById('try-sample').click();
    assert.deepEqual(actions, ['sample']);
    ui.library.setBusy(true);
    assert.equal(document.getElementById('open-firmware').disabled, true);
    assert.equal(document.getElementById('try-sample').disabled, true);
    ui.library.setBusy(false);
    assert.equal(document.getElementById('try-sample').disabled, false);
    document.getElementById('sound-open').click();
    assert.equal(document.getElementById('panel-sound').hidden, false);
    assert.equal(document.getElementById('workspace-panel').hidden, false);
  });
});

test("recent items omit metadata and changing firmware opens the shared file input", async () => {
  await withDom(async (ui, { document }) => {
    ui.library.render([{id:'one',name:'demo.bin',kind:'file',size:12345,project:'technical',version:'1.0',lastUsed:Date.now()}]);
    const text=ui.elements.libraryList.textContent;
    assert.match(text,/demo.bin/);
    assert.doesNotMatch(text,/technical|1\.0|刚刚|12345/);
    let clicks=0;
    ui.elements.fileInput.addEventListener('click',()=>clicks++);
    document.getElementById('open-firmware').click();
    assert.equal(clicks,1);
    document.getElementById('sound-open').click();
    assert.equal(document.getElementById('panel-sound').hidden,false);
    assert.equal(document.getElementById('panel-audio'),null);
    assert.equal(document.getElementById('tabs').hidden,false);
    ui.showPanel('console');
    assert.equal(document.getElementById('tabs').hidden,false);
    assert.equal(document.getElementById('tab-library').hidden,true);
  });
});

test("device input keeps docked developer tools open while lightweight surfaces close outside", async () => {
  await withDom(async (ui, { app, document, canvas }) => {
    ui.showPanel('console');
    app.fire('pointerdown',{target:canvas});
    assert.equal(document.getElementById('workspace-panel').hidden,false);
    assert.equal(app.dataset.surface,'tools');
    ui.showPanel('library');
    app.fire('pointerdown',{target:canvas});
    assert.equal(document.getElementById('workspace-panel').hidden,true);
  });
});


test("workbench keeps history and runtime controls accessible independently of tools", async () => {
  await withDom(async (ui, { document }) => {
    assert.equal(ui.elements.libraryList.parentNode, document.getElementById("sidebar-library"));
    assert.equal(ui.elements.mode.parentNode, document.getElementById("sidebar-mode"));
    ui.library.render([{ id: "local", name: "local.bin", kind: "file" }]);
    ui.showPanel("console");
    assert.match(ui.elements.libraryList.textContent, /local.bin/);
    assert.equal(ui.elements.mode.parentNode, document.getElementById("sidebar-mode"));
    ui.library.setBusy(true);
    assert.equal(ui.elements.libraryList.querySelector("button").disabled, true);
    ui.library.setBusy(false);
    assert.equal(ui.elements.libraryList.querySelector("button").disabled, false);
  }, true);
});

test("bottom dock requests App developer mode once and collapses without changing firmware", async () => {
  await withDom(async (ui, { app, document }) => {
    let requests = 0;
    app.addEventListener("sdg:tools", () => { requests++; ui.showPanel("console"); });
    const dock = document.getElementById("dock-open");
    dock.click();
    assert.equal(requests, 1);
    assert.equal(dock.getAttribute("aria-expanded"), "true");
    dock.click();
    assert.equal(requests, 1);
    assert.equal(document.getElementById("workspace-panel").hidden, true);
    assert.equal(dock.getAttribute("aria-expanded"), "false");
    assert.equal(ui.elements.mode.parentNode, document.getElementById("sidebar-mode"));
  }, true);
});


test("settings groups current firmware, safe reset and help without audio diagnostics", async () => {
  await withDom(async (ui, { document }) => {
    ui.setFirmwareInfo({ name: "active.bin" });
    document.getElementById("sound-open").click();
    ui.showPanel("settings");
    const settings = document.getElementById("panel-settings");
    assert.equal(settings.hidden, false);
    assert.match(settings.textContent, /active.bin/);
    assert.doesNotMatch(settings.textContent, /关于次元屏/);
    ui.showPanel("about");
    const about = document.getElementById("panel-about");
    assert.equal(about.querySelectorAll("a").length, 2);
    assert.match(about.textContent, /重启保留/);
    assert.equal(document.getElementById("panel-audio"), null);
    let clears = 0;
    document.getElementById("clear-open").addEventListener("click", () => clears++);
    document.getElementById("reset-layout").click();
    assert.equal(clears, 0);
    assert.equal(ui.elements.reset.parentNode.classList.contains("settings-group"), true);
  });
});

test("current firmware selection survives history rendering and emits one run action", async () => {
  await withDom(async (ui) => {
    const entries = [{ id: "one", name: "one.bin", kind: "file" }, { id: "two", name: "two.bin", kind: "file" }];
    ui.library.setCurrent("two"); ui.library.render(entries);
    const rows = ui.elements.libraryList.querySelectorAll(".recent-row");
    assert.equal(rows[0].classList.contains("is-current"), false);
    assert.equal(rows[1].classList.contains("is-current"), true);
    const actions = [];
    ui.elements.panelHost.addEventListener("sdg:library", event => actions.push(event.detail));
    rows[1].querySelector("button").click();
    assert.equal(actions.length, 1);
    assert.equal(actions[0].entry.id, "two");
    ui.library.setCurrent("one");
    assert.equal(rows[0].querySelector("button").getAttribute("aria-current"), "true");
  });
});


test("long firmware names keep their version and extension independently of truncated prefix", async () => {
  await withDom(async (ui) => {
    const name = "chiikawa-go-demo-0.1.1-full.bin";
    ui.library.render([{ id: "long", name, kind: "file" }]);
    const run = ui.elements.libraryList.querySelector("button");
    assert.equal(run.getAttribute("title"), name);
    assert.equal(run.querySelector(".recent-name-tail").textContent, name.slice(-14));
    assert.equal(run.querySelector(".recent-name-prefix").textContent + run.querySelector(".recent-name-tail").textContent, name);
  });
});


test("runtime choices explain their requirements and reflect native availability", async () => {
  await withDom(async (ui, { document }) => {
    ui.setNativeAvailable(false); ui.setMode("wasm");
    assert.equal(document.getElementById("mode-native").disabled, true);
    assert.match(document.getElementById("mode-description").textContent, /无需 WSL/);
    ui.setNativeAvailable(true); ui.setMode("native");
    assert.equal(document.getElementById("mode-native").getAttribute("aria-checked"), "true");
    assert.match(document.getElementById("mode-description").textContent, /Ubuntu WSL/);
  }, true);
});

test("provisioning detection never opens a panel or steals a selected tool", async () => {
  await withDom(async (ui, { app, document }) => {
    assert.equal(document.getElementById("workspace-panel").hidden, true);
    ui.showSetupHelp();
    assert.equal(document.getElementById("workspace-panel").hidden, true);
    assert.equal(document.getElementById("setup-open").hidden, false);
    ui.showPanel("console"); ui.showSetupHelp();
    assert.equal(document.getElementById("panel-console").hidden, false);
    assert.equal(app.dataset.surface, "tools");
  });
});


test("changing runtime dispatches once and clicking the selected choice does nothing", async () => {
  await withDom(async (ui, { document }) => {
    ui.setNativeAvailable(true); ui.setMode("wasm");
    let changes = 0;
    ui.elements.mode.addEventListener("change", () => changes++);
    document.getElementById("mode-native").click();
    document.getElementById("mode-native").click();
    assert.equal(changes, 1);
    assert.equal(ui.elements.mode.value, "native");
    assert.equal(document.getElementById("mode-native").getAttribute("aria-checked"), "true");
  }, true);
});


test("history removal emits only hide-history and recording gives explicit state", async () => {
  await withDom(async (ui, { document }) => {
    ui.library.render([{id:"one",name:"one.bin",kind:"file"}]);
    const actions=[];
    ui.elements.panelHost.addEventListener("sdg:library", e=>actions.push(e.detail));
    ui.elements.libraryList.querySelector(".recent-hide").click();
    assert.equal(actions.length,1);
    assert.equal(actions[0].action,"hide-history");
    ui.setRecording(true);
    assert.match(document.getElementById("record").textContent,/停止录屏/);
    assert.equal(document.getElementById("record").getAttribute("aria-pressed"),"true");
    ui.setRecording(false);
    assert.doesNotMatch(document.getElementById("record").textContent,/停止/);
  });
});
