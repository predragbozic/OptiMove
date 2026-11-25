import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { needsModuleMocksRelaunch, relaunchWithModuleMocks } from "./support/relaunch-with-module-mocks.mjs";

if (needsModuleMocksRelaunch()) {
  test("roster workspace scope with isolated database mocks", () => {
    relaunchWithModuleMocks(import.meta.url);
  });
} else {
  let workspace;
  let captured;
  mock.module("../src/db.js", { namedExports: { query: async (sql, params) => { captured = { sql, params }; return { rows: [] }; } } });
  mock.module("../src/workspace.js", { namedExports: {
    resolveActiveWorkspace: async () => ({ workspace }),
    // moduleView.js (the athletes gate, roles V-2) reads these; an account without a role assignment never calls them.
    rememberCheckedCoachWorkspace: () => { throw new Error("No coach permission gate in this isolated test"); },
    rememberReadOnlyWorkspace: () => { throw new Error('No gate handoff in this isolated route-handler test'); },
    VIEW_WORKSPACE_TYPES: new Set(["club_view", "team_view"]),
    pickFallbackWorkspace: () => null,
    resolveActiveWorkspaceReadOnly: async () => ({ workspace, availableWorkspaces: [] }),
  } });
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
      // Roles V-2: the predicate's two athletes.view id arrays ($2 clubs, $3 teams; none without a role row here).
      assert.deepEqual(filter.params, ["coach-1", [], [], `${type}-a`]);
      assert.match(filter.sql, /user_team_roles/);
      assert.ok(filter.sql.includes(`am.${type}_id = $4`));
      assert.ok(filter.sql.includes(`am.membership_type = '${type}'`));
      assert.match(filter.sql, /am.status = 'active'/);
    }
  });
  test("platform/no workspace yields no combined roster; athlete workspace stays self-only", () => {
    for (const selected of [null, { type: "platform" }, { type: "unknown" }]) assert.match(athleteRosterScope(request(true), selected).sql, /and false/);
    const own = athleteRosterScope(request(), { type: "athlete" });
    assert.deepEqual(own.params, ["coach-1", [], [], "athlete-self"]);
    assert.match(own.sql, /and a.id = \$4/);
  });
  test("V-2: a view workspace reads its memberships only through the athletes gate's pass; otherwise and false", () => {
    for (const type of ["club_view", "team_view"]) {
      const w = { type, scopeId: "scope-a" };
      const base = type === "club_view" ? "club" : "team";
      // No gate pass, another module's pass, or a pass for another workspace object: fail closed.
      for (const moduleView of [undefined, { module: "presets", workspace: w, scope: { type: base, id: "scope-a" } },
        { module: "athletes", workspace: { ...w }, scope: { type: base, id: "scope-a" } }]) {
        const r = { ...request(true), moduleView };
        assert.deepEqual(athleteRosterScope(r, w), { sql: "and false", params: [] });
      }
      const pass = { ...request(), moduleView: { module: "athletes", workspace: w, scope: { type: base, id: "scope-a" } } };
      const filter = athleteRosterScope(pass, w);
      assert.deepEqual(filter.params, ["scope-a"]);
      assert.ok(filter.sql.includes(`am.membership_type = '${base}'`));
      assert.ok(filter.sql.includes(`am.${base}_id = $1::uuid`));
      assert.match(filter.sql, /am.status = 'active'/);
      assert.doesNotMatch(filter.sql, /user_(club|team)_roles/);
    }
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
