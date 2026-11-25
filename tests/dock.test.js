import test from "node:test";
import assert from "node:assert/strict";
import { dockGeometry, DEFAULT_DOCK } from "../web/js/ui/dock.js";

test("dock starts at the bottom and keeps independent saved dimensions", () => {
  assert.deepEqual(dockGeometry(DEFAULT_DOCK), DEFAULT_DOCK);
  assert.deepEqual(dockGeometry({ position: "right", width: 490, height: 280 }), { position: "right", width: 490, height: 280 });
});
test("dock ignores unsupported positions and non-finite stored dimensions", () => {
  assert.deepEqual(dockGeometry({ position: "floating", width: Infinity, height: "broken" }), DEFAULT_DOCK);
});
test("dock clamps dragging to usable minimums and viewport maximums", () => {
  assert.deepEqual(dockGeometry({ width: -20, height: -20 }), { position: "bottom", width: 320, height: 210 });
  const size = dockGeometry({ position: "right", width: 2000, height: 2000 }, { width: 1280, height: 720 });
  assert.equal(size.width, 576);
  assert.equal(size.height, 432);
});
test("a temporarily narrow window never reduces the desktop minimum below controls", () => {
  const size = dockGeometry({ width: 600, height: 500 }, { width: 390, height: 300 });
  assert.equal(size.width, 320);
  assert.equal(size.height, 210);
});
