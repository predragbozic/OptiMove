import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { needsModuleMocksRelaunch, relaunchWithModuleMocks } from "./support/relaunch-with-module-mocks.mjs";

if (needsModuleMocksRelaunch()) {
  test("workspace hierarchy with isolated database mocks", () => {
    relaunchWithModuleMocks(import.meta.url);
  });
} else {
  const calls = [];
  mock.module("../src/db.js", { namedExports: { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: sql.includes("public.teams") ? [{ id: "team-a", name: "First Team", club_id: "club-a" }] : [{ id: "club-a", name: "My Club" }] };
  } } });
  const { loadAvailableWorkspaces } = await import("../src/workspace.js");
  const authz = { platformRoles: [], clubRoles: [], teamRoles: [], isIndependentCoach: false, isAthlete: false };
  test("team workspace includes its real parent club without granting club access", async () => {
    const rows = await loadAvailableWorkspaces({ ...authz, teamRoles: [{ role: "team_coach", teamId: "team-a" }] });
    assert.deepEqual(rows, [{ type: "team", scopeId: "team-a", clubId: "club-a", label: "First Team", role: "team_coach" }]);
    assert.deepEqual(calls.at(-1).params, [["team-a"]]);
    assert.match(calls.at(-1).sql, /select id, name, club_id/);
    assert.match(calls.at(-1).sql, /coalesce\(is_active, true\)/);
  });
  test("club admins still do not acquire team workspaces without a team role", async () => {
    const rows = await loadAvailableWorkspaces({ ...authz, clubRoles: [{ role: "club_admin", clubId: "club-a" }] });
    assert.deepEqual(rows, [{ type: "club", scopeId: "club-a", label: "My Club", role: "club_admin" }]);
  });
  test("an account with no active roles gets no hierarchy or queries", async () => {
    const count = calls.length;
    assert.deepEqual(await loadAvailableWorkspaces(authz), []);
    assert.equal(calls.length, count);
  });
}
