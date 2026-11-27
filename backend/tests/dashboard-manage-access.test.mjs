import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { needsModuleMocksRelaunch, relaunchWithModuleMocks } from "./support/relaunch-with-module-mocks.mjs";

if (needsModuleMocksRelaunch()) {
  test("Dashboard Manage access records distinct, ordered write scopes", () => relaunchWithModuleMocks(import.meta.url));
} else {
  mock.module("../src/db.js", { namedExports: {
    pool: { connect() { throw new Error("Inventory must not connect"); } },
    query: async () => { throw new Error("Dashboard Manage must use the caller’s transaction client"); },
  } });
  const {
    dashboardManageRightsStillHold, dashboardOwnerWriteScope, dashboardWorkspaceWriteScope,
    lockDashboardActor, lockDashboardManageCeilings,
  } = await import("../src/dashboardManageAccess.js");

  const userId = "10000000-0000-4000-8000-000000000001";
  const clubId = "20000000-0000-4000-8000-000000000001";
  const anotherClub = "20000000-0000-4000-8000-000000000002";
  const teamId = "30000000-0000-4000-8000-000000000001";
  const actor = { user: { id: userId }, authz: { platformRoles: [] } };

  test("the target owner and active workspace are distinct native scopes", () => {
    assert.deepEqual(dashboardOwnerWriteScope({ owner_scope: "team", owner_team_id: teamId }), { type: "team", id: teamId });
    assert.equal(dashboardOwnerWriteScope({ owner_scope: "user", data_workspace_type: "club", data_workspace_scope_id: clubId }), null);
    assert.deepEqual(dashboardWorkspaceWriteScope({ type: "club", scopeId: clubId }), { type: "club", id: clubId });
    assert.equal(dashboardWorkspaceWriteScope({ type: "club", dataWorkspaceScopeId: clubId, view: true }), null);
    assert.equal(dashboardWorkspaceWriteScope({ type: "club_view", scopeId: clubId }), null);
  });

  test("a Legacy clone locks both club ceilings before identity and checks source View and destination Manage", async () => {
    const calls = [];
    const run = async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith("select club_id")) return { rows: [{ club_id: anotherClub }] };
      if (sql.includes(" as allowed")) return { rows: [{ allowed: true }] };
      return { rows: [] };
    };
    const source = { type: "club", id: clubId };
    const destination = { type: "team", id: teamId };
    const scopes = await lockDashboardManageCeilings(run, [destination, source, destination]);
    await lockDashboardActor(run, actor);
    assert.equal(await dashboardManageRightsStillHold(run, actor, scopes, { viewOnly: [source] }), true);

    assert.deepEqual(calls[1].params, [[clubId, anotherClub], "shared"]);
    const labels = calls.map(({ sql }) => {
      if (sql.includes("lock_club_ceiling")) return "ceiling";
      if (sql.includes("from public.users")) return "user";
      if (sql.includes("lock_permission_actor")) return "actor";
      if (sql.includes("as allowed")) return "rights";
      return null;
    });
    assert.deepEqual(labels.filter(Boolean), ["ceiling", "user", "actor", "rights", "actor", "rights"]);
    const rights = calls.filter(({ sql }) => sql.includes("as allowed"));
    assert.deepEqual(rights.map(({ params }) => params), [[userId, "club", clubId, false], [userId, "team", teamId, true]]);
    assert.match(rights[1].sql, /permission_word_honoured\('dashboards\.manage'\)/);
    assert.match(rights[1].sql, /user_has_permission\(\$1,'dashboards\.view'/);
    assert.match(rights[1].sql, /user_has_permission\(\$1,'dashboards\.manage'/);
  });

  test("a nonexistent team, native refusal, and unchecked role hint supply no dashboard write right", async () => {
    const missing = await lockDashboardManageCeilings(async () => ({ rows: [] }), [{ type: "team", id: teamId }]);
    assert.equal(missing, null);
    assert.equal(await dashboardManageRightsStillHold(async () => { throw new Error("Missing scope should stop"); }, actor, missing), false);

    const pretending = { ...actor, authz: { roleHint: "platform_admin", platformRoles: [] } };
    const run = async sql => ({ rows: sql.includes(" as allowed") ? [{ allowed: false }] : [] });
    assert.equal(await dashboardManageRightsStillHold(run, pretending, [{ type: "club", id: clubId }]), false);
  });
  test("each mounted write or receipt route is accounted for, including preferences and POST reads", async () => {
    const { default: legacy } = await import("../src/routes/trainingLoadDashboard.js");
    const { createPagesRouter, PAGE_ROUTE_MATRIX } = await import("../src/dashboardPages/router.js");
    const { createSimpleSaveRouter } = await import("../src/dashboardSimple/saveRouter.js");
    const { createReferenceBindingRouter } = await import("../src/dashboardReferences/bindingRouter.js");
    const pool = { connect() { throw new Error("Inventory must not connect"); } };
    const routes = router => router.stack.flatMap(layer => layer.route
      ? Object.keys(layer.route.methods).map(method => method + " " + layer.route.path)
      : []).sort();

    assert.deepEqual(routes(legacy).filter(entry => !entry.startsWith("get ")), [
      "delete /:dashboardId",
      "delete /:dashboardId/widgets/:widgetId",
      "delete /:dashboardId/widgets/:widgetId/series/:seriesId",
      "delete /active",
      "patch /:dashboardId",
      "patch /:dashboardId/widgets/:widgetId",
      "patch /:dashboardId/widgets/:widgetId/layout",
      "patch /:dashboardId/widgets/:widgetId/series/:seriesId",
      "post /",
      "post /:dashboardId/archive",
      "post /:dashboardId/clone",
      "post /:dashboardId/query",
      "post /:dashboardId/widgets",
      "post /:dashboardId/widgets/:widgetId/series",
      "post /:dashboardId/widgets/:widgetId/series/:seriesId/resolve",
      "post /active",
      "put /:dashboardId/layout",
      "put /:dashboardId/widgets/:widgetId/series/reorder",
    ].sort());
    assert.deepEqual(routes(createPagesRouter({ pool })), PAGE_ROUTE_MATRIX.map(parts => parts.join(" ")).sort());
    const stub = () => { throw new Error("Inventory must not call a service"); };
    assert.deepEqual(routes(createSimpleSaveRouter({ service: { save: stub, status: stub } })), [
      "post /requests/status", "post /widgets", "put /widgets/:widgetId",
    ]);
    assert.deepEqual(routes(createReferenceBindingRouter()), [
      "get /:dashboardId/widgets/:widgetId", "put /:dashboardId/widgets/:widgetId",
    ]);
  });

}
