import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  test("roster workspace scope with isolated database mocks", () => {
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", "--test-isolation=none", fileURLToPath(import.meta.url)], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  let workspace;
  let captured;
  mock.module("../src/db.js", { namedExports: { query: async (sql, params) => { captured = { sql, params }; return { rows: [] }; } } });
  mock.module("../src/workspace.js", { namedExports: { resolveActiveWorkspace: async () => ({ workspace }) } });
  const { athleteRosterScope } = await import("../src/athleteRosterScope.js");
  const { default: router } = await import("../src/routes/athletes.js");
  const request = (admin = false) => ({ user: { id: "coach-1" }, authz: { platformRoles: admin ? ["platform_admin"] : [], athleteId: "athlete-self" } });

  test("private roster uses only this coach's active private relationship even for a global admin", () => {
    const filter = athleteRosterScope(request(true), { type: "private_coach" });
    assert.deepEqual(filter.params, ["coach-1"]);
    assert.match(filter.sql, /user_athletes.*ua.user_id = \$1.*ua.is_active = true/);
  });
  test("club/team membership narrows rather than replaces normal authorization", () => {
    for (const type of ["club", "team"]) {
      const filter = athleteRosterScope(request(), { type, scopeId: `${type}-a` });
      assert.deepEqual(filter.params, ["coach-1", `${type}-a`]);
      assert.match(filter.sql, /user_team_roles/);
      assert.ok(filter.sql.includes(`am.${type}_id = $2`));
      assert.ok(filter.sql.includes(`am.membership_type = '${type}'`));
      assert.match(filter.sql, /am.status = 'active'/);
    }
  });
  test("platform/no workspace yields no combined roster; athlete workspace stays self-only", () => {
    for (const selected of [null, { type: "platform" }, { type: "unknown" }]) assert.match(athleteRosterScope(request(true), selected).sql, /and false/);
    const own = athleteRosterScope(request(), { type: "athlete" });
    assert.deepEqual(own.params, ["coach-1", "athlete-self"]);
    assert.match(own.sql, /and a.id = \$2/);
  });
  test("both roster and Home overview resolve the workspace and scope their SQL", async () => {
    workspace = { type: "club", scopeId: "club-a" };
    for (const path of ["/", "/today"]) {
      const handler = router.stack.find((layer) => layer.route?.path === path && layer.route.methods.get).route.stack[0].handle;
      let body;
      await handler(request(true), { json: (value) => { body = value; } }, (error) => { throw error; });
      assert.deepEqual(captured.params, ["club-a"]);
      assert.match(captured.sql, /am.club_id = \$1/);
      assert.ok(body);
    }
  });
}
