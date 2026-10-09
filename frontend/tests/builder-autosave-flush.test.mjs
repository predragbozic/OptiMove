import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const coordinator = source.slice(source.indexOf("const builderAutosaveTimers"), source.indexOf("let builderSearchTimer"));
function fixture(submit) {
  const timers = new Map();
  let next = 0;
  const errors = [];
  const context = vm.createContext({
    FormData: class { constructor(form) { return Object.entries(form.values); } },
    rememberBuilderItemEdit() {}, clearBuilderItemEdits() {},
    submitBuilderFormAction: submit, loadBuilderExercises() {}, renderBuilder() {},
    renderBuilderSectionItems: () => true, renderBuilderAddFeedback() {},
    renderBuilderError: (error) => errors.push(error),
    setTimeout: (callback) => { timers.set(++next, callback); return next; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(`${coordinator}\nglobalThis.api = { scheduleBuilderItemAutosave, flushBuilderAutosaves, cancelBuilderAutosaves, cancelBuilderItemAutosave };`, context);
  return { ...context.api, timers, errors };
}

test("flush saves debounced forms without waiting for the timer", async () => {
  const calls = [];
  const instance = fixture(async (form) => { calls.push(form.dataset.itemId); });
  instance.scheduleBuilderItemAutosave({ dataset: { itemId: "a" }, values: { reps: "12" } });
  instance.scheduleBuilderItemAutosave({ dataset: { itemId: "b" }, values: { sets: "3" } });
  await instance.flushBuilderAutosaves();
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(instance.timers.size, 0);
});

test("a failed autosave remains retryable and a failed flush rejects", async () => {
  let calls = 0;
  const instance = fixture(async () => { if (++calls === 1) throw new Error("Offline"); });
  instance.scheduleBuilderItemAutosave({ dataset: { itemId: "a" }, values: { reps: "12" } });
  await assert.rejects(instance.flushBuilderAutosaves(), /Offline/);
  await instance.flushBuilderAutosaves();
  assert.equal(calls, 2);
  assert.equal(instance.errors.length, 1);
});

test("discard cancels pending timers rather than sending the last unsaved change", async () => {
  const instance = fixture(async () => assert.fail("Must not save discarded changes"));
  instance.scheduleBuilderItemAutosave({ dataset: { itemId: "a" }, values: { reps: "12" } });
  await instance.cancelBuilderAutosaves();
  await instance.flushBuilderAutosaves();
  assert.equal(instance.timers.size, 0);
});

test("deleting one item cancels only that item's queued timer", async () => {
  const calls = [];
  const instance = fixture(async (form) => { calls.push(form.dataset.itemId); });
  instance.scheduleBuilderItemAutosave({ dataset: { itemId: "a" }, values: { reps: "12" } });
  instance.scheduleBuilderItemAutosave({ dataset: { itemId: "b" }, values: { reps: "8" } });
  await instance.cancelBuilderItemAutosave("a");
  await instance.flushBuilderAutosaves();
  assert.deepEqual(calls, ["b"]);
});
