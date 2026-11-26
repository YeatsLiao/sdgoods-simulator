import test from "node:test";
import assert from "node:assert/strict";
import { WasmRuntime } from "../web/js/device/wasm-runtime.js";

test("browser speed accepts supported targets and drops old timing debt", () => {
  const runtime = new WasmRuntime({ emit() {} });
  assert.equal(runtime.speed, 1);
  runtime.timeCredit = 16;
  runtime.setSpeed(2);
  assert.equal(runtime.speed, 2);
  assert.equal(runtime.timeCredit, 0);
  runtime.setSpeed(10);
  assert.equal(runtime.speed, 2);
});

test("speed target changes how many emulated milliseconds are scheduled", (context) => {
  context.mock.method(performance, "now", () => 15);
  for (const speed of [1, 2]) {
    const runtime = new WasmRuntime({ emit() {} });
    let cycles = 0;
    runtime.speed = speed;
    runtime.stopped = false;
    runtime.previousTick = 5;
    runtime.emulator = {
      cosim_service() {},
      cycles: () => cycles,
      cycles_per_us: () => 1,
      run_batch: () => { cycles += 1000; return ""; },
      faulted: () => false,
    };
    runtime.drainBus = () => {};
    runtime.tick(runtime.generation);
    clearTimeout(runtime.timer);
    assert.equal(cycles, speed * 10000);
  }
});
