import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Coach Home's calendar: GET /api/athletes/today?date= (one day's overview)
// and GET /api/athletes/training-days?from=&to= (the dots of one month grid).
// Both are read-only and use the same roster scope as the Home overview
// (athlete-roster-scope.test.mjs); the database and the workspace are mocked,
// the same pattern as that suite.
if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  test("Home calendar routes with isolated database mocks", () => {
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", "--test-isolation=none", fileURLToPath(import.meta.url)], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  let workspace = { type: "club", scopeId: "club-a" };
  let calls = [];
  let answer = [];
  mock.module("../src/db.js", { namedExports: { query: async (sql, params) => { calls.push({ sql, params }); return { rows: answer }; } } });
  mock.module("../src/workspace.js", { namedExports: { resolveActiveWorkspace: async () => ({ workspace }) } });
  const { default: router } = await import("../src/routes/athletes.js");
  const request = (query = {}) => ({ user: { id: "coach-1" }, authz: { platformRoles: ["platform_admin"], athleteId: null }, query });

  function handlerFor(path) {
    return router.stack.find((layer) => layer.route?.path === path && layer.route.methods.get).route.stack[0].handle;
  }

  async function call(path, query) {
    calls = [];
    let status = 200;
    let body;
    const res = { status(code) { status = code; return res; }, json(value) { body = value; return res; } };
    await handlerFor(path)(request(query), res, (error) => { throw error; });
    return { status, body };
  }

  test("1. /today without a date keeps the server's own today and its old shape", async () => {
    answer = [{ athlete_uuid: "u1", athlete_id: "17", athlete_name: "Ana", session_count: 2, item_count: 5 }];
    const { status, body } = await call("/today", {});
    assert.equal(status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /where date = current_date/);
    assert.deepEqual(calls[0].params, ["club-a"]);
    assert.equal(body.date, undefined);
    assert.equal(body.rows[0].hasTrainingToday, true);
    assert.equal(body.rows[0].sessionCount, 2);
  });

  test("2. /today?date= reads that one day through a bound parameter, after the roster scope's own parameters", async () => {
    answer = [];
    const { status, body } = await call("/today", { date: "2026-10-24" });
    assert.equal(status, 200);
    assert.doesNotMatch(calls[0].sql, /current_date/);
    assert.match(calls[0].sql, /where date = \$2::date/);
    assert.match(calls[0].sql, /am\.club_id = \$1/);
    assert.deepEqual(calls[0].params, ["club-a", "2026-10-24"]);
    assert.equal(body.date, "2026-10-24");
    assert.deepEqual(body.rows, []);
  });

  test("3. /today refuses a date that is not a real calendar day, before any query", async () => {
    for (const date of ["2026-02-30", "2026-13-01", "26-10-24", "2026-10-24T00:00", "x' or 1=1 --", "2026-10-24,2026-10-25"]) {
      const { status, body } = await call("/today", { date });
      assert.equal(status, 400, date);
      assert.match(body.error, /valid YYYY-MM-DD/);
      assert.equal(calls.length, 0, `no query for ${date}`);
    }
    const repeated = await call("/today", { date: ["2026-10-24", "2026-10-25"] });
    assert.equal(repeated.status, 400);
    assert.equal(calls.length, 0);
  });

  test("4. /training-days counts athletes with a session per day inside the roster scope", async () => {
    answer = [{ day: "2026-10-20", athlete_count: "3" }, { day: "2026-10-22", athlete_count: "1" }];
    const { status, body } = await call("/training-days", { from: "2026-09-28", to: "2026-11-08" });
    assert.equal(status, 200);
    assert.equal(calls.length, 1);
    const { sql, params } = calls[0];
    assert.match(sql, /from plans\.v_weekly_plan_items i/);
    assert.match(sql, /join public\.athletes a on a\.id = i\.athlete_uuid/);
    assert.match(sql, /i\.date between \$2::date and \$3::date/);
    assert.match(sql, /i\.plan_session_id is not null/);
    assert.match(sql, /coalesce\(a\.is_active, true\)/);
    assert.match(sql, /count\(distinct a\.id\)/);
    assert.match(sql, /am\.club_id = \$1/);
    assert.deepEqual(params, ["club-a", "2026-09-28", "2026-11-08"]);
    assert.deepEqual(body, { from: "2026-09-28", to: "2026-11-08", days: [{ date: "2026-10-20", athleteCount: 3 }, { date: "2026-10-22", athleteCount: 1 }] });
  });

  test("5. /training-days refuses a missing, invalid, backwards or longer-than-six-weeks range, before any query", async () => {
    const refused = [
      {},
      { from: "2026-10-01" },
      { from: "2026-10-01", to: "2026-10-32" },
      { from: "2026-10-10", to: "2026-10-09" },
      { from: "2026-09-28", to: "2026-11-09" },
    ];
    for (const query of refused) {
      const { status } = await call("/training-days", query);
      assert.equal(status, 400, JSON.stringify(query));
      assert.equal(calls.length, 0, `no query for ${JSON.stringify(query)}`);
    }
    answer = [];
    assert.equal((await call("/training-days", { from: "2026-10-22", to: "2026-10-22" })).status, 200, "one day is a valid range");
    assert.equal((await call("/training-days", { from: "2026-09-28", to: "2026-11-08" })).status, 200, "exactly 42 days is a valid range");
  });

  test("6. a private coach reads only their own roster and a platform workspace reads none, on both routes", async () => {
    answer = [];
    workspace = { type: "private_coach" };
    await call("/training-days", { from: "2026-10-01", to: "2026-10-31" });
    assert.match(calls[0].sql, /ua\.user_id = \$1/);
    assert.deepEqual(calls[0].params, ["coach-1", "2026-10-01", "2026-10-31"]);
    await call("/today", { date: "2026-10-24" });
    assert.deepEqual(calls[0].params, ["coach-1", "2026-10-24"]);
    workspace = { type: "platform" };
    await call("/training-days", { from: "2026-10-01", to: "2026-10-31" });
    assert.match(calls[0].sql, /and false/);
    workspace = { type: "club", scopeId: "club-a" };
  });
}
