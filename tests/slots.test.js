import test from "node:test";
import assert from "node:assert/strict";

import {
  SLOT_COUNT, assignSlot, clearSlot, normalizeSlotState, readSlotState,
  selectSlot, writeSlotState,
} from "../web/js/flash/slots.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function assignment(overrides = {}) {
  return {
    entryId: "file-aaaaaaaaaaaaaaaa",
    sha256: SHA_A,
    name: "SDGOODS_RADIO.bin",
    version: "1.1.0",
    project: "SDGOODS_RADIO",
    size: 3024736,
    ...overrides,
  };
}

test("normalizeSlotState drops malformed assignments and keeps four slots", () => {
  const state = normalizeSlotState({
    slots: [assignment(), null, { name: "bad" }, assignment({ sha256: SHA_B })],
    selected: 3,
  });
  assert.equal(state.slots.length, SLOT_COUNT);
  assert.equal(state.slots[0].sha256, SHA_A);
  assert.equal(state.slots[1], null);
  assert.equal(state.slots[2], null);
  assert.equal(state.slots[3].sha256, SHA_B);
  assert.equal(state.selected, 3);

  assert.deepEqual(normalizeSlotState(null), {
    slots: [null, null, null, null],
    selected: null,
  });
  assert.equal(normalizeSlotState({ slots: [assignment()], selected: 2 }).selected, null);
});

test("assignSlot fills one slot without touching the others", () => {
  const state = normalizeSlotState({ slots: [null, assignment(), null, null], selected: 1 });
  const next = assignSlot(state, 2, assignment({ sha256: SHA_B, name: "bambu.bin" }));
  assert.equal(next.slots[1].sha256, SHA_A);
  assert.equal(next.slots[2].sha256, SHA_B);
  assert.equal(next.slots[2].name, "bambu.bin");
  assert.equal(next.selected, 1);
  assert.equal(state.slots[2], null, "input state is not mutated");

  assert.throws(() => assignSlot(next, 4, assignment()), RangeError);
  assert.throws(() => assignSlot(next, 0, { name: "no hash" }), /SHA-256/);
});

test("clearSlot empties a slot and drops the stale selected pointer", () => {
  let state = normalizeSlotState({ slots: [assignment(), null, null, null], selected: 0 });
  state = clearSlot(state, 0);
  assert.deepEqual(state, { slots: [null, null, null, null], selected: null });
  state = clearSlot(state, 3);
  assert.equal(state.slots[3], null);
});

test("selectSlot refuses empty slots", () => {
  const state = normalizeSlotState({ slots: [assignment(), null, null, null] });
  assert.equal(selectSlot(state, 0).selected, 0);
  assert.throws(() => selectSlot(state, 1), /槽为空/);
});

test("readSlotState falls back to an empty table without localStorage", () => {
  // Node has no localStorage; storage.js swallows the error.
  assert.deepEqual(readSlotState(), { slots: [null, null, null, null], selected: null });
  assert.doesNotThrow(() => writeSlotState({ slots: [assignment()], selected: 0 }));
});