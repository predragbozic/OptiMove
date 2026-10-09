import { test } from "node:test";
import assert from "node:assert/strict";
import { createBuilderTiming } from "../src/builderTiming.js";

test("Builder timing measures and accumulates phases independently per request", async () => {
  let clock = 0;
  let header;
  const timing = createBuilderTiming({ setHeader: (name, value) => { assert.equal(name, "Server-Timing"); header = value; }, json: (body) => body }, () => clock);
  assert.equal(await timing.measure("copy", async () => { clock += 7; return "copied"; }), "copied");
  await timing.measure("copy", async () => { clock += 3; });
  await timing.measure("response", async () => { clock += 2; });
  assert.deepEqual(timing.json({ saved: true }), { saved: true });
  assert.equal(header, "copy;dur=10.0, response;dur=2.0, total;dur=12.0");
  const other = createBuilderTiming({ setHeader: (_, value) => { header = value; }, json() {} }, () => clock);
  other.json({});
  assert.equal(header, "total;dur=0.0");
});

test("timing preserves a phase's original error", async () => {
  const error = new Error("Copy failed");
  const timing = createBuilderTiming({ json() {} });
  await assert.rejects(timing.measure("copy", async () => { throw error; }), (actual) => actual === error);
});
