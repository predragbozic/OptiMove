import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { needsModuleMocksRelaunch, relaunchWithModuleMocks } from "./support/relaunch-with-module-mocks.mjs";

// Keep the normal test command working without enabling mocks for the whole suite.
if (needsModuleMocksRelaunch()) {
  test("exercise search pagination with isolated database mocks", () => {
    relaunchWithModuleMocks(import.meta.url);
  });
} else {
let captured;
const mediaLookups = [];
const exercises = Array.from({ length: 40 }, (_, index) => ({ id: `ex-${index}`, name: `Squat ${index}` }));
// The library search runs through queryWithoutJit (933b0fae: JIT off for the search). The only
// plain query() on that path is the media lookup of the found rows (decorateMediaRows); it finds
// no media selection here. Any other plain query() fails the test.
mock.module("../src/db.js", { namedExports: { pool: {},
  query: async (sql, params) => {
    if (/from library\.exercises m where id=any\(\$1::uuid\[\]\)/.test(sql)) {
      mediaLookups.push(params[0]);
      return { rows: [] };
    }
    throw new Error(`the exercise search must not use query() (JIT on): ${sql.slice(0, 80)}`);
  },
  queryWithoutJit: async (sql, params) => {
    captured = { sql, params };
    const limit = params.at(-2);
    const offset = params.at(-1);
    return { rows: exercises.slice(offset, offset + limit) };
  } } });
const { default: router } = await import("../src/routes/exercises.js");
const handler = router.stack.find((layer) => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle;
async function search(query) {
  let body;
  await handler({ query, user: { id: "coach" }, authz: { platformRoles: [] } }, { json: (data) => { body = data; } }, (error) => { throw error; });
  return body;
}

test("exercise search passes stable ordering and page offsets to SQL", async () => {
  const first = await search({ search: "Squat", limit: "18" });
  assert.deepEqual(first.exercises, exercises.slice(0, 18));
  assert.equal(first.hasMore, true);
  assert.deepEqual(captured.params, ["coach", "%Squat%", "Squat", 19, 0]);
  assert.match(captured.sql, /e\.name, e\.id\s+limit \$4 offset \$5/);
  const second = await search({ search: "Squat", limit: "18", offset: "18" });
  const last = await search({ search: "Squat", limit: "18", offset: "36" });
  assert.deepEqual([...first.exercises, ...second.exercises, ...last.exercises], exercises);
  assert.equal(last.hasMore, false);
  // the media lookup asks for exactly the ids of the returned page
  assert.deepEqual(mediaLookups.at(-1), exercises.slice(36).map((e) => e.id));
});

test("invalid offsets use the first page", async () => {
  for (const offset of ["-1", "abc", "1.5", "Infinity"]) {
    await search({ limit: "18", offset });
    assert.equal(captured.params.at(-1), 0);
  }
});

test("name/code exact matches and name prefixes precede substring matches", async () => {
  await search({ search: "knee", limit: "18", purpose: "Strength" });
  assert.deepEqual(captured.params, ["coach", "%knee%", "knee", "Strength", 19, 0]);
  // the English name ranks like the name (6e39b347)
  assert.match(captured.sql, /order by case\s+when lower\(e\.name\) = lower\(\$3\) or lower\(e\.name_en\) = lower\(\$3\) or lower\(e\.exercise_code\) = lower\(\$3\) then 0\s+when left\(lower\(e\.name\), length\(\$3\)\) = lower\(\$3\) or left\(lower\(e\.name_en\), length\(\$3\)\) = lower\(\$3\) then 1\s+else 2\s+end,/);
  assert.match(captured.sql, /effective_classification\."purposes" \? \$4/);
  assert.match(captured.sql, /limit \$5 offset \$6/);
});

test("an empty query retains the original code ordering", async () => {
  await search({ limit: "18" });
  assert.deepEqual(captured.params, ["coach", 19, 0]);
  assert.doesNotMatch(captured.sql, /order by case/);
  assert.match(captured.sql, /limit \$2 offset \$3/);
});
}
