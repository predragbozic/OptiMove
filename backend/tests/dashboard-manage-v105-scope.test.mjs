import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { buildDatabase, fixtures, startServer } from "./support/permission-roles-world.mjs";

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
  let server;
  const priorFlag = process.env.DASHBOARD_PAGES_ENABLED;
  const priorDatabase = process.env.DATABASE_URL;
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
  } finally {
    await server?.stop();
    if (priorFlag === undefined) delete process.env.DASHBOARD_PAGES_ENABLED;
    else process.env.DASHBOARD_PAGES_ENABLED = priorFlag;
    if (priorDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabase;
    await sql.end().catch(() => {});
    await database.drop();
  }
});

