import test from "node:test";
import assert from "node:assert/strict";
import { FirmwarePower, powerRuntimeExit } from "../web/js/app/power-state.js";
import { App } from "../web/js/app/app.js";
import { WasmRuntime } from "../web/js/device/wasm-runtime.js";

test("power state follows complete BSP messages across arbitrary UART chunks", () => {
 const power = new FirmwarePower();
 assert.deepEqual(power.push("I (966) power: entering de"), []);
 assert.deepEqual(power.push("ep sleep (wake on power key press, lowest power)\n"), ["deep"]);
 assert.deepEqual(power.push("I (1) power: screen suspended (low power)\nI (2) power: screen resumed\n"), ["suspended", "on"]);
 assert.deepEqual(power.push("I (3) power: entering light sleep (wake on power key press)\nI (4) power: resumed from light sleep (screen lit)\n"), ["light", "on"]);
});

test("other firmware text, user messages and preview labels never switch power", () => {
 const power = new FirmwarePower();
 assert.deepEqual(power.push("Power Off\nI (1) demo: entering deep sleep\nDEBUG: power: screen resumed\n"), []);
 assert.deepEqual(power.push("  #4  0x42001234 in sdgoods_power_off () at bsp/power.c:10\n"), ["off"]);
 assert.equal(powerRuntimeExit("on", "ESP-EMU 已退出"), false);
 assert.equal(powerRuntimeExit("deep", "ESP-EMU 已退出（代码 0）"), true);
 assert.equal(powerRuntimeExit("deep", "网络连接失败"), false);
});

test("wake press keeps current firmware and restarts once on release without clearing data", () => {
 const calls = [];
 const app = { powerState: "deep", current: { flashKey: "same-firmware" }, elements: {}, session: { key:()=>assert.fail("dead runtime must not receive GPIO") }, restart: clear=>calls.push(clear) };
 App.prototype.key.call(app, true);
 assert.deepEqual(calls, []);
 App.prototype.key.call(app, false);
 App.prototype.key.call(app, false);
 assert.deepEqual(calls, [false]);
 assert.equal(app.current.flashKey, "same-firmware");
});

test("normal firmware navigation and suspended screens still get the real key", () => {
 for (const state of ["on", "suspended", "light"]) {
  const keys=[];const app={powerState:state,elements:{},session:{key:down=>keys.push(down)},macroRecorder:{recordKey(){}}};
  App.prototype.key.call(app,true);App.prototype.key.call(app,false);
  assert.deepEqual(keys,[true,false]);
 }
});

test("WASM restart resumes scheduling after a sleep-related emulator fault", async()=>{
 const runtime=new WasmRuntime({emit(){}});const calls=[];
 runtime.faulted=true;runtime.stopped=false;runtime.emulator={restart(){calls.push("restart");},cycles(){return 0;}};
 runtime.tick=generation=>calls.push(generation);
 await runtime.restart();
 assert.equal(runtime.faulted,false);assert.equal(runtime.stopped,false);assert.deepEqual(calls,["restart",1]);
});
