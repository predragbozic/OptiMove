import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";
import { buildDatabase, fixtures, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

const v105 = "202612071000_training_load_v105_dashboards_manage_bridge.sql";
const path = "/api/training-load/dashboards";

async function selectWorkspace(db, userId, type, scopeId = null) {
  await db.query(
    `insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values ($1,$2,$3)
     on conflict(user_id) do update set workspace_type=excluded.workspace_type,scope_id=excluded.scope_id`,
    [userId, type, scopeId],
  );
}

test("real Dashboard routes preserve standalone-team authorization and private ownership while checking native writes", async () => {
  const database = await buildDatabase({ label: "dashboard_manage_scope", upTo: v105 });
  const sql = new pg.Client({ connectionString: database.url });
  let server, bridge;
  const priorFlag = process.env.DASHBOARD_PAGES_ENABLED;
  const priorDatabase = process.env.DATABASE_URL;
  const priorBuild = process.env.P1_PREVIOUS_BUILD_SHA;
  try {
    await sql.connect();
    const f = fixtures(sql);
    // Exercise the nullable team shape accepted by the authorization code. This fixture only uses disposable schema.
    await sql.query("alter table public.teams alter column club_id drop not null");
    const standalone = await f.team(null, "Standalone team");
    const club = await f.club("Dashboard club");
    const admin = await f.user("Club and independent coach");
    const coach = await f.user("Standalone team coach");
    const platform = await f.user("Platform admin");
    await f.grantClub(admin, club);
    await f.grantIndependent(admin);
    await f.grantTeam(coach, standalone);
    await f.grantPlatform(platform);
    await selectWorkspace(sql, admin, "club", club);
    await selectWorkspace(sql, coach, "team", standalone);
    await selectWorkspace(sql, platform, "platform");
    await sql.query("update training_load.dashboard_pages_activation set enabled=true where singleton");
    process.env.DASHBOARD_PAGES_ENABLED = "true";
    server = await startServer(database.url);
    const teamCookie = await server.cookieFor(coach);
    const clubCookie = await server.cookieFor(admin);
    const platformCookie = await server.cookieFor(platform);
    const use = async () => (await sql.query("select first_checked_write_at from training_load.dashboards_manage_v105_use where singleton")).rows[0].first_checked_write_at;

    const source = await server.api(platformCookie, path, { method: "POST", body: { name: "OptiMove template", ownerScope: "system" } });
    assert.equal(source.status, 201, source.text);
    const clonePath = `${path}/${source.body.dashboard.id}/clone`;
    const clone = (teamId) => server.api(platformCookie, clonePath, {
      method: "POST", body: { name: "Standalone team dashboard", ownerScope: "team", ownerTeamId: teamId },
    });
    const allowed = await clone(standalone);
    assert.equal(allowed.status, 201, allowed.text);
    assert.equal((await clone(randomUUID())).status, 404);
    assert.equal(await use(), null);
    const pages = `${path}/${allowed.body.dashboard.id}/pages`;
    const listed = await server.api(teamCookie, pages);
    assert.equal(listed.status, 200, listed.text);
    const body = {
      requestId: randomUUID(), requestIssuedAt: listed.body.requestIssuedAt,
      expectedPagesRevision: listed.body.pagesRevision, input: { name: "Checked standalone Page" },
    };
    const created = await server.api(teamCookie, pages, { method: "POST", body });
    assert.equal(created.status, 200, created.text);
    const first = await use();
    assert.ok(first instanceof Date);
    assert.deepEqual(await server.api(teamCookie, pages, { method: "POST", body }), created);
    assert.deepEqual(await use(), first);
    const teamCreate = await server.api(teamCookie, path, { method: "POST", body: { name: "Coach dashboard", ownerScope: "team", ownerTeamId: standalone } });
    assert.equal(teamCreate.status, 201, teamCreate.text);

    const personal = await server.api(clubCookie, path, { method: "POST", body: { name: "Club-bound personal dashboard" } });
    assert.equal(personal.status, 201, personal.text);
    assert.equal(personal.body.dashboard.owner_scope, "user");
    assert.equal(personal.body.dashboard.data_workspace_scope_id, club);
    const personalPath = `${path}/${personal.body.dashboard.id}`;
    const patch = { method: "PATCH", body: { name: "Updated by the owner", expectedRevision: personal.body.dashboard.revision } };
    const original = (await sql.query("select pg_get_functiondef('public.permission_word_honoured(text)'::regprocedure) as source")).rows[0].source;
    const unstage = original.replace(", 'dashboards.manage'", "");
    assert.notEqual(unstage, original);
    await sql.query(unstage);
    try {
      const denied = await server.api(clubCookie, personalPath, patch);
      assert.equal(denied.status, 404, denied.text);
      await selectWorkspace(sql, admin, "private_coach");
      const own = await server.api(clubCookie, personalPath, patch);
      assert.equal(own.status, 200, own.text);
      assert.equal(own.body.dashboard.name, patch.body.name);
      assert.deepEqual(await use(), first);
    } finally {
      await sql.query(original);
    }

    const scopedTeam = await f.team(club, "Dashboard scope team");
    const scopedCoach = await f.user("Dashboard Manage assignment coach");
    await f.grantTeam(scopedCoach, scopedTeam);
    await selectWorkspace(sql, scopedCoach, "team", scopedTeam);
    const viewer = await server.cookieFor(scopedCoach);
    const target = await server.api(viewer, path, { method: "POST", body: { name: "Dashboard reversible role", ownerScope: "team", ownerTeamId: scopedTeam } });
    assert.equal(target.status, 201, target.text);
    const targetPath = `${path}/${target.body.dashboard.id}`;
    const catalog = await server.api(platformCookie, `/api/organization/roles/catalog?clubId=${club}`);
    const permission = catalog.body.permissions.find(item => item.word === "dashboards.manage");
    assert.deepEqual([permission?.storable, permission?.honoured, permission?.checked], [true, true, true]);
    const originalWords = (await server.api(viewer, "/api/auth/me")).body.user.permissions;
    assert.ok(originalWords.includes("dashboards.manage"));
    assert.equal((await server.api(viewer, targetPath)).body.canManage, true);
    assert.equal((await server.api(viewer, path)).body.canCreateDashboard, true);

    const targetPages = await server.api(viewer, `${targetPath}/pages`);
    assert.equal(targetPages.status, 200, targetPages.text);
    const home = targetPages.body.pages.find(page => page.is_home);
    assert.ok(home);
    const copyPath = `${targetPath}/pages/${home.id}/copy`;
    const copyRequest = {
      method: "POST", body: {
        requestId: randomUUID(), requestIssuedAt: targetPages.body.requestIssuedAt,
        expectedPagesRevision: targetPages.body.pagesRevision,
        input: { name: "Receipt before role change", sourceRevision: home.revision, widgetRevisions: {} },
      },
    };
    const receipt = await server.api(viewer, copyPath, copyRequest);
    assert.equal(receipt.status, 200, receipt.text);

    const bridgeCommit = process.env.OPTIMOVE_DASHBOARDS_BRIDGE_SHA;
    if (bridgeCommit) {
      process.env.P1_PREVIOUS_BUILD_SHA = bridgeCommit;
      bridge = await previousDashboardServer(database.url, { DASHBOARD_PAGES_ENABLED: "true" });
      assert.equal(bridge.commit, bridgeCommit);
      console.log("Exact Dashboard Manage bridge build:", bridge.commit);
    }
    const bridgeApi = (target, options = {}) => fetch(bridge.baseUrl + target, {
      method: options.method,
      headers: { Cookie: viewer, ...(options.body ? { "Content-Type": "application/json" } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (bridge) {
      const me = await bridgeApi("/api/auth/me");
      assert.equal(me.status, 200);
      assert.ok(!(await me.json()).user.permissions.includes("dashboards.manage"));
      const before = await bridgeApi(targetPath);
      assert.equal(before.status, 200);
      assert.equal((await before.json()).canManage, undefined);
    }

    const change = (expectedRevision, effect) => server.api(platformCookie, `/api/organization/roles/${ROLE_IDS.team_coach}/clubs/${club}/version`, {
      method: "POST", body: { requestKey: randomUUID(), expectedRevision, reason: "Adjust Dashboard Manage", ...effect },
    });
    const removed = await change(null, { remove: ["dashboards.manage"] });
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual((await server.api(viewer, "/api/auth/me")).body.user.permissions, originalWords.filter(word => word !== "dashboards.manage"));
    const detail = await server.api(viewer, targetPath);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.canManage, false);
    assert.equal((await server.api(viewer, `${targetPath}/pages`)).body.canManage, false);
    assert.equal((await server.api(viewer, path)).body.canCreateDashboard, false);
    const offeredName = { expectedRevision: target.body.dashboard.revision, name: "Name granted after restore" };
    assert.equal((await server.api(viewer, targetPath, { method: "PATCH", body: offeredName })).status, 404);
    const deniedReceipt = await server.api(viewer, copyPath, copyRequest);
    assert.equal(deniedReceipt.status, 404, deniedReceipt.text);
    if (bridge) {
      const oldDeniedReceipt = await bridgeApi(copyPath, copyRequest);
      assert.equal(oldDeniedReceipt.status, 404);
      assert.equal(await oldDeniedReceipt.text(), deniedReceipt.text);
      const denied = await bridgeApi(targetPath, { method: "PATCH", body: offeredName });
      const missing = await bridgeApi(`${path}/${randomUUID()}`, { method: "PATCH", body: offeredName });
      assert.equal(denied.status, 404);
      assert.equal(missing.status, 404);
      assert.equal(await denied.text(), await missing.text());
    }
    assert.equal((await server.api(viewer, `${path}/active`, { method: "POST", body: { dashboardId: target.body.dashboard.id } })).status, 200);
    assert.equal((await server.api(viewer, `${path}/active`, { method: "DELETE" })).status, 200);
    const restored = await change(removed.body.role.version.revision, { add: ["dashboards.manage"] });
    assert.equal(restored.status, 200, restored.text);
    assert.deepEqual((await server.api(viewer, "/api/auth/me")).body.user.permissions, originalWords);
    assert.equal((await server.api(viewer, targetPath)).body.canManage, true);
    assert.deepEqual(await server.api(viewer, copyPath, copyRequest), receipt);
    if (bridge) {
      const bridgeReceipt = await bridgeApi(copyPath, copyRequest);
      assert.equal(bridgeReceipt.status, 200);
      assert.equal(await bridgeReceipt.text(), receipt.text);
    }
    const written = await server.api(viewer, targetPath, { method: "PATCH", body: offeredName });
    assert.equal(written.status, 200, written.text);
    if (bridge) {
      const visible = await bridgeApi(targetPath);
      assert.equal(visible.status, 200);
      const latest = (await visible.json()).dashboard;
      assert.equal(latest.name, offeredName.name);
      const bridgeWrite = await bridgeApi(targetPath, {
        method: "PATCH", body: { name: "Written by the bridge after restore", expectedRevision: latest.revision },
      });
      assert.equal(bridgeWrite.status, 200, await bridgeWrite.text());
      const read = await server.api(viewer, targetPath);
      assert.equal(read.body.dashboard.name, "Written by the bridge after restore");
    }

  } finally {
    await bridge?.stop();
    await server?.stop();
    if (priorBuild === undefined) delete process.env.P1_PREVIOUS_BUILD_SHA;
    else process.env.P1_PREVIOUS_BUILD_SHA = priorBuild;
    if (priorFlag === undefined) delete process.env.DASHBOARD_PAGES_ENABLED;
    else process.env.DASHBOARD_PAGES_ENABLED = priorFlag;
    if (priorDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabase;
    await sql.end().catch(() => {});
    await database.drop();
  }
});
