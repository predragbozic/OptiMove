import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  test("resumable drafts with isolated database mocks", () => {
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", "--test-isolation=none", fileURLToPath(import.meta.url)], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  let captured;
  mock.module("../src/db.js", { namedExports: { pool: {}, query: async (sql, params) => {
    captured = { sql, params };
    return { rows: [{ group_key: "edit-1", plan_ids: ["edit-1"], plan_type: "weekly", athlete_names: ["Athlete"], week_start: "2026-10-05", name: "Week" }] };
  } } });
  mock.module("../src/access.js", { namedExports: { athleteAccessPredicate() {}, canAccessAllAthletes() {}, canAccessPlan() {} } });
  mock.module("../src/realtime.js", { namedExports: { emitRealtimeEvent() {} } });
  mock.module("../src/trainingLoadAccess.js", { namedExports: { isAthleteInWorkspaceScope() {}, resolveExternalScheduleWorkspaceScope() {} } });
  const { default: router } = await import("../src/routes/builder.js");
  const handler = router.stack.find((layer) => layer.route?.path === "/drafts" && layer.route.methods.get).route.stack[0].handle;
  test("draft picker includes inactive edit drafts, keeps ownership/status filters, and separates them from batches", async () => {
    let body;
    await handler({ user: { id: "coach-1" } }, { json: (value) => { body = value; } }, (error) => { throw error; });
    assert.deepEqual(captured.params, ["coach-1"]);
    assert.match(captured.sql, /p\.created_by_user_id = \$1/);
    assert.match(captured.sql, /p\.source_type in \('builder', 'builder_edit_draft'\)/);
    assert.match(captured.sql, /p\.status = 'draft'/);
    assert.match(captured.sql, /coalesce\(p\.is_active, true\) or coalesce\(p\.is_edit_draft, false\)/);
    assert.match(captured.sql, /case when coalesce\(p\.is_edit_draft, false\) then p\.id::text/);
    assert.equal(body.drafts[0].openPlanId, "edit-1");
    assert.deepEqual(body.drafts[0].planIds, ["edit-1"]);
  });
}
