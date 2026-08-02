import { test } from "node:test";
import assert from "node:assert/strict";
import { runCleanupSteps } from "./_test-cleanup.mjs";

// Proves the invariant this helper exists for: a standard `npm test` run
// must never go green while a cleanup step silently failed and left
// fixture data behind. No database or server involved - this is a pure
// unit test of the step-runner's own control flow.

test("runCleanupSteps runs every step even when an earlier one throws", async () => {
  const ran = [];
  await assert.rejects(
    runCleanupSteps([
      ["first", async () => { ran.push("first"); }],
      ["second (fails)", async () => { ran.push("second"); throw new Error("boom"); }],
      ["third", async () => { ran.push("third"); }],
    ]),
  );
  assert.deepEqual(ran, ["first", "second", "third"], "a failure in one step must not skip the steps after it");
});

test("runCleanupSteps rejects with an AggregateError describing every failed step, once all steps have run", async () => {
  await assert.rejects(
    runCleanupSteps([
      ["ok", async () => {}],
      ["fails-a", async () => { throw new Error("A broke"); }],
      ["fails-b", async () => { throw new Error("B broke"); }],
    ]),
    (error) => {
      assert.ok(error instanceof AggregateError, "must reject with an AggregateError, not a plain Error");
      assert.equal(error.errors.length, 2, "must include one entry per failed step, not just the first");
      assert.ok(error.errors[0].message.includes("fails-a"), "each collected error must be traceable to its step label");
      assert.ok(error.errors[0].message.includes("A broke"));
      assert.ok(error.errors[1].message.includes("fails-b"));
      assert.ok(error.errors[1].message.includes("B broke"));
      return true;
    },
  );
});

test("runCleanupSteps resolves with no error when every step succeeds", async () => {
  const ran = [];
  await runCleanupSteps([
    ["a", async () => { ran.push("a"); }],
    ["b", async () => { ran.push("b"); }],
    ["c", async () => { ran.push("c"); }],
  ]);
  assert.deepEqual(ran, ["a", "b", "c"]);
});

test("runCleanupSteps propagates a failure even when it's the very last step", async () => {
  const ran = [];
  await assert.rejects(
    runCleanupSteps([
      ["a", async () => { ran.push("a"); }],
      ["b", async () => { ran.push("b"); }],
      ["c (fails)", async () => { ran.push("c"); throw new Error("late failure"); }],
    ]),
  );
  assert.deepEqual(ran, ["a", "b", "c"], "a failure in the last step must still surface, not be silently dropped");
});
