import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Keep the normal test command working without enabling mocks for the whole suite.
if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  test("exercise search pagination with isolated database mocks", () => {
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", "--test-isolation=none", fileURLToPath(import.meta.url)], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
let captured;
const exercises = Array.from({ length: 40 }, (_, index) => ({ id: `ex-${index}`, name: `Squat ${index}` }));
mock.module("../src/db.js", { namedExports: { query: async (sql, params) => {
  captured = { sql, params };
  const limit = params.at(-2);
  const offset = params.at(-1);
  return { rows: exercises.slice(offset, offset + limit) };
} } });
const { default: router } = await import("../src/routes/exercises.js");
const handler = router.stack.find((layer) => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle;
async function search(query) {
  let body;
  await handler({ query, user: { id: "coach" } }, { json: (data) => { body = data; } }, (error) => { throw error; });
  return body;
}

test("exercise search passes stable ordering and page offsets to SQL", async () => {
  const first = await search({ search: "Squat", limit: "18" });
  assert.deepEqual(first.exercises, exercises.slice(0, 18));
  assert.equal(first.hasMore, true);
  assert.deepEqual(captured.params, ["coach", "%Squat%", 19, 0]);
  assert.match(captured.sql, /e\.name, e\.id\s+limit \$3 offset \$4/);
  const second = await search({ search: "Squat", limit: "18", offset: "18" });
  const last = await search({ search: "Squat", limit: "18", offset: "36" });
  assert.deepEqual([...first.exercises, ...second.exercises, ...last.exercises], exercises);
  assert.equal(last.hasMore, false);
});

test("invalid offsets use the first page", async () => {
  for (const offset of ["-1", "abc", "1.5", "Infinity"]) {
    await search({ limit: "18", offset });
    assert.equal(captured.params.at(-1), 0);
  }
});
}
