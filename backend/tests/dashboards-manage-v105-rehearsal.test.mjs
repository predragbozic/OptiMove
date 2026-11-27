import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";
import pg from "pg";
import { runMigrations } from "../src/migrate.js";
import { asActor, buildDatabase, fixtures, migrationsWithout, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";

const last = "202612061000_training_load_v104_dashboard_page_copy.sql";
const file = "202612071000_training_load_v105_dashboards_manage_bridge.sql";
const record = `migrations_v2/${file}`;
const apiPath = "/api/training-load/dashboards";
const read = (type) => fs.readFileSync(new URL(`../../docs/runbooks/dashboards-manage-v105-${type}.sql`, import.meta.url), "utf8");

async function seedLayers(url, c) {
  const fx = fixtures(c);
  const club = await fx.club("Dashboard Manage rehearsal");
  const team = await fx.team(club);
  const owner = await fx.user("Dashboard admin");
  const coach = await fx.user("Dashboard coach");
  const actor = await fx.user("Dashboard platform");
  await fx.grantPlatform(actor);
  await fx.grantClub(owner, club);
  await fx.grantTeam(coach, team);
  const role = ROLE_IDS.team_coach;
  const versionId = await asActor(url, actor, async (tx) => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    const { rows: [r] } = await tx.query("select revision from public.permission_roles where id=$1", [role]);
    const { rows: [v] } = await tx.query(`insert into public.permission_club_role_versions
      (club_id,system_role_id,based_on_revision,answered_revision,created_by_user_id)
      values ($1,$2,$3,$3,$4) returning id`, [club, role, r.revision, actor]);
    await tx.query(`insert into public.permission_club_role_version_items
      select $1,permission_word from public.permission_role_items where role_id=$2`, [v.id, role]);
    await tx.query(`insert into public.permission_club_role_version_changes
      (version_id,revision_after,kind,performed_by_user_id,basis,reason,items_added)
      values ($1,1,'create',$2,'platform_admin','Rehearsal version',
        array(select permission_word from public.permission_club_role_version_items where version_id=$1))`, [v.id, actor]);
    return v.id;
  });
  const customId = await asActor(url, actor, async (tx) => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'shared')", [[club]]);
    const { rows: [v] } = await tx.query(`insert into public.permission_custom_roles
      (user_id,base_role_id,scope_type,scope_id,club_id,holding_row_table,holding_row_id,holding_row_version,
       frozen_from,frozen_from_revision,created_by_user_id)
      select $1,$2,'team',$3,$4,'user_team_roles',r.id,r.updated_at,'default',p.revision,$5
        from public.user_team_roles r join public.permission_roles p on p.id=$2
       where r.user_id=$1 and r.team_id=$3 returning id`, [coach, role, team, club, actor]);
    await tx.query(`insert into public.permission_custom_role_items
      select $1,permission_word from public.permission_role_items where role_id=$2`, [v.id, role]);
    await tx.query(`insert into public.permission_custom_role_changes
      (custom_role_id,revision_after,kind,performed_by_user_id,basis,reason,items_added)
      values ($1,1,'create',$2,'platform_admin','Rehearsal custom',
        array(select permission_word from public.permission_custom_role_items where custom_role_id=$1))`, [v.id, actor]);
    return v.id;
  });

  await asActor(url, actor, async (tx) => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    const { rows: [changed] } = await tx.query(
      "update public.permission_roles set description=$2, revision=revision+1, updated_at=now() where id=$1 returning revision",
      [role, "Pending dashboard rehearsal default"],
    );
    await tx.query(
      `insert into public.permission_role_changes
         (role_id,revision_after,kind,performed_by_user_id,basis,reason,description_changed)
       values ($1,$2,'change',$3,'platform_admin','Rehearsal pending default',true)`,
      [role, changed.revision, actor],
    );
  });
  const viewer = await fx.user("Dashboard bridge viewer");
  const viewerRole = await asActor(url, actor, async (tx) => {
    const { rows: [role] } = await tx.query(
      "insert into public.permission_roles (owner_scope,name,assignable_club,created_by_user_id) values ('system','Rehearsal Viewer',true,$1) returning id",
      [actor],
    );
    await tx.query("insert into public.permission_role_items (role_id,permission_word,added_by_user_id) values ($1,'org.view',$2)", [role.id, actor]);
    await tx.query(
      `insert into public.permission_role_changes (role_id,revision_after,kind,performed_by_user_id,basis,items_added)
       values ($1,1,'create',$2,'platform_admin',array['org.view'])`,
      [role.id, actor],
    );
    return role.id;
  });
  return { versionId, customId, owner, coach, club, team, actor, viewer, viewerRole };
}

async function grantIndependentAccess(url, admin, data) {
  const { actor, viewer, viewerRole, club, owner } = data;
  const newAdmin = await fixtures(admin).user("Dashboard bridge new club admin");
  await asActor(url, actor, async (tx) => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    const { rows: [assignment] } = await tx.query(
      `insert into public.user_role_assignments (user_id,role_id,scope_type,scope_id,granted_by_user_id,grant_basis,grant_reason)
       values ($1,$2,'club',$3,$4,'platform_admin','Independent grant after v105') returning id`,
      [viewer, viewerRole, club, actor],
    );
    await tx.query(
      `insert into public.permission_requests (request_key,requested_by_user_id,operation,request_hash,owner_scope,owner_club_id,basis,assignment_id)
       values ($1,$2,'assignment_grant',$3,'club',$4,'platform_admin',$5)`,
      [randomUUID(), actor, "a".repeat(64), club, assignment.id],
    );
    await tx.query("delete from public.user_club_roles where user_id=$1 and club_id=$2 and role='club_admin'", [owner, club]);
    await fixtures(tx).grantClub(newAdmin, club);
  });
  return newAdmin;
}

async function accessSnapshot(client, clubId) {
  return (await client.query(
    `select (select jsonb_agg(to_jsonb(r) order by r.id) from public.user_club_roles r where r.club_id=$1) native_roles,
       (select jsonb_agg(to_jsonb(a) order by a.id) from public.user_role_assignments a where a.scope_club_id=$1) assignments,
       (select jsonb_agg(to_jsonb(p) order by p.id) from public.permission_requests p where p.owner_club_id=$1) receipts`,
    [clubId],
  )).rows[0];
}

async function snapshot(c) {
  const { rows } = await c.query(`select
    (select jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl) order by p.oid::regprocedure::text)
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('calendar','training_load') or n.nspname='public' and p.proname='permission_word_honoured') as bodies,
    (select jsonb_agg(to_jsonb(x) order by table_name,ordinal_position) from information_schema.columns x where table_schema in ('calendar','training_load')) as columns,
    (select jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid))
       order by t.tgrelid::regclass::text,t.tgname)
       from pg_trigger t where not t.tgisinternal and (t.tgrelid::regclass::text like 'calendar.%' or t.tgrelid::regclass::text like 'training_load.%' or t.tgname like 'permission_%')) as triggers,
    (select jsonb_agg(to_jsonb(r) order by r.id) from public.permission_roles r) as roles,
    (select jsonb_agg(to_jsonb(v) order by v.id) from public.permission_club_role_versions v) as versions,
    (select jsonb_agg(to_jsonb(c) order by c.id) from public.permission_custom_roles c) as customs,
    (select jsonb_agg(to_jsonb(i) order by i.role_id,i.permission_word) from public.permission_role_items i) as role_items,
    (select jsonb_agg(to_jsonb(i) order by i.version_id,i.permission_word) from public.permission_club_role_version_items i) as version_items,
    (select jsonb_agg(to_jsonb(i) order by i.custom_role_id,i.permission_word) from public.permission_custom_role_items i) as custom_items,
    (select jsonb_agg(to_jsonb(a) order by a.id) from public.permission_role_changes a) as role_changes,
    (select jsonb_agg(to_jsonb(a) order by a.id) from public.permission_club_role_version_changes a) as version_changes,
    (select jsonb_agg(to_jsonb(a) order by a.id) from public.permission_custom_role_changes a) as custom_changes`);
  // Dropping new columns preserves their discarded attnums; only live user columns make up this catalogue.
  return rows[0];
}


async function firstUse(client) {
  return (await client.query("select first_checked_write_at from training_load.dashboards_manage_v105_use where singleton")).rows[0].first_checked_write_at;
}

async function selectWorkspace(c, user, type, scope) {
  await c.query(
    `insert into public.user_workspace_preferences(user_id,workspace_type,scope_id)
     values($1,$2,$3) on conflict(user_id) do update set workspace_type=excluded.workspace_type,scope_id=excluded.scope_id`,
    [user, type, scope],
  );
}

async function prepareCopy(api, cookie, dashboardId, homeId) {
  const pages = await api(cookie, `${apiPath}/${dashboardId}/pages`);
  assert.equal(pages.status, 200, pages.text);
  const home = pages.body.pages.find((page) => page.id === homeId);
  assert.ok(home);
  return {
    requestId: randomUUID(),
    requestIssuedAt: pages.body.requestIssuedAt,
    expectedPagesRevision: pages.body.pagesRevision,
    input: { name: "Duplicate page", sourceRevision: home.revision, widgetRevisions: {} },
  };
}

async function apiForOld(old, cookie, path, { method = "GET", body } = {}) {
  const response = await fetch(old.baseUrl + path, {
    method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text };
}

test("v105 checks both predecessors and restores the exact catalogue, layers and role evidence", async () => {
  const db = await buildDatabase({ label: "dashboard_manage_catalog", upTo: last });
  const admin = new pg.Client({ connectionString: db.url });
  const staged = migrationsWithout([], file);
  try {
    await admin.connect();
    const data = await seedLayers(db.url, admin);
    const original = await snapshot(admin);
    const checks = await admin.query(read("preflight"));
    assert.deepEqual(checks.flatMap((result) => Object.values(result.rows[0])), [true, true, true, true, true]);
    const dependency = `migrations_v2/${last}`;
    const saved = (await admin.query("select checksum from public.schema_migrations where migration_name=$1", [dependency])).rows[0].checksum;
    await admin.query("update public.schema_migrations set checksum=$2 where migration_name=$1", [dependency, "0".repeat(64)]);
    await assert.rejects(runMigrations({ databaseUrl: db.url, migrationsRoot: staged.dir }), /checksum/i);
    await admin.query("update public.schema_migrations set checksum=$2 where migration_name=$1", [dependency, saved]);

    await runMigrations({ databaseUrl: db.url, migrationsRoot: staged.dir });
    const post = await admin.query(read("postcheck"));
    assert.equal(post[0].rows[0].migration_name, record);
    assert.match(post[0].rows[0].checksum, /^[a-f0-9]{64}$/);
    assert.deepEqual(post[1].rows, [{ first_checked_write_at: null }]);
    assert.deepEqual(post[2].rows.map(({ layer, seeded }) => [layer, Number(seeded)]), [["custom", 1], ["role", 2], ["version", 1]]);
    assert.deepEqual(post[3].rows, [{ v105_permission_body_matches: true, word_storable: true }]);
    const newer = "migrations_v2/209912311000_dashboard_rehearsal.sql";
    await admin.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values($1,repeat('b',64),'test')", [newer]);
    await assert.rejects(admin.query(read("rollback")), /later migration/);
    await admin.query("rollback");
    await admin.query("delete from public.schema_migrations where migration_name=$1", [newer]);
    await admin.query("begin");
    await admin.query("select set_config('optimove.permission_actor',$1||':'||pg_current_xact_id()::text,true)", [data.actor]);
    await admin.query("update public.permission_roles set revision=revision+1,updated_at=now() where id=$1", [ROLE_IDS.team_coach]);
    await assert.rejects(admin.query(read("rollback")), /seeded layer changed/);
    await admin.query("rollback");
    const newAdmin = await grantIndependentAccess(db.url, admin, data);
    const access = await accessSnapshot(admin, data.club);
    assert.deepEqual(access.native_roles.map((row) => row.user_id), [newAdmin]);
    assert.deepEqual(access.assignments.map((row) => row.user_id), [data.viewer]);
    await admin.query(read("rollback"));
    assert.deepEqual(await snapshot(admin), original);
    assert.deepEqual(await accessSnapshot(admin, data.club), access);
    await runMigrations({ databaseUrl: db.url, migrationsRoot: staged.dir });
    assert.deepEqual((await admin.query(read("postcheck")))[3].rows, [{ v105_permission_body_matches: true, word_storable: true }]);
  } finally {
    await admin.end().catch(() => {});
    staged.cleanup();
    await db.drop();
  }
});

test("old page-copy receipts replay without v105 use; denied writes leave no marker; native writes mark and stop rollback", {
  skip: !process.env.OPTIMOVE_DASHBOARDS_PREVIOUS_SHA,
}, async () => {
  const db = await buildDatabase({ label: "dashboard_manage_http", upTo: last });
  const admin = new pg.Client({ connectionString: db.url });
  const staged = migrationsWithout([], file);
  let old, bridge;
  const previous = process.env.P1_PREVIOUS_BUILD_SHA;
  const pagesEnv = process.env.DASHBOARD_PAGES_ENABLED;
  const databaseEnv = process.env.DATABASE_URL;
  try {
    await admin.connect();
    const fx = fixtures(admin);
    const club = await fx.club();
    const owner = await fx.user("Dashboard club admin");
    await fx.grantClub(owner, club);
    await fx.grantIndependent(owner);
    await admin.query("alter table public.teams alter column club_id drop not null");
    const standalone = (await admin.query("insert into public.teams(name) values('Standalone dashboard team') returning id")).rows[0].id;
    const coach = await fx.user("Standalone dashboard coach");
    await fx.grantTeam(coach, standalone);
    await selectWorkspace(admin, coach, "team", standalone);
    const platform = await fx.user("Dashboard support admin");
    await fx.grantPlatform(platform);
    await selectWorkspace(admin, platform, "platform", null);
    await selectWorkspace(admin, owner, "club", club);
    await admin.query("update training_load.dashboard_pages_activation set enabled=true where singleton");
    process.env.P1_PREVIOUS_BUILD_SHA = process.env.OPTIMOVE_DASHBOARDS_PREVIOUS_SHA;
    process.env.DASHBOARD_PAGES_ENABLED = "true";
    process.env.DATABASE_URL = db.url;
    const { createSession } = await import("../src/auth.js");
    const cookieFor = async (user) => `optimove_session=${await createSession(user, admin)}`;
    const cookie = await cookieFor(owner);
    const teamCookie = await cookieFor(coach);
    const platformCookie = await cookieFor(platform);
    old = await previousDashboardServer(db.url, { DASHBOARD_PAGES_ENABLED: "true" });
    assert.equal(old.commit, process.env.OPTIMOVE_DASHBOARDS_PREVIOUS_SHA);
    console.log("Exact previous Dashboard Manage build:", old.commit);
    const oldApi = (session, target, options) => apiForOld(old, session, target, options);
    const creation = await oldApi(cookie, apiPath, { method: "POST", body: { name: "Worked before the bridge", ownerScope: "club", ownerClubId: club } });
    assert.equal(creation.status, 201, creation.text);
    const dashboard = creation.body.dashboard;
    const personal = await oldApi(cookie, apiPath, { method: "POST", body: { name: "Club-bound personal dashboard" } });
    assert.equal(personal.status, 201, personal.text);
    assert.equal(personal.body.dashboard.owner_scope, "user");
    assert.equal(personal.body.dashboard.data_workspace_scope_id, club);
    const teamRequest = { name: "Standalone predecessor", ownerScope: "team", ownerTeamId: standalone };
    const oldTeam = await oldApi(teamCookie, apiPath, { method: "POST", body: teamRequest });
    assert.equal(oldTeam.status, 201, oldTeam.text);
    const system = await oldApi(platformCookie, apiPath, { method: "POST", body: { name: "Standalone source template", ownerScope: "system", isTemplate: true } });
    assert.equal(system.status, 201, system.text);
    const { id: home } = (await admin.query(
      "select id from training_load.dashboard_pages where dashboard_id=$1 and is_home", [dashboard.id],
    )).rows[0];
    const copyPath = `${apiPath}/${dashboard.id}/pages/${home}/copy`;
    const oldRequest = await prepareCopy(oldApi, cookie, dashboard.id, home);
    const oldCopy = await oldApi(cookie, copyPath, { method: "POST", body: oldRequest });
    assert.equal(oldCopy.status, 200, oldCopy.text);
    await runMigrations({ databaseUrl: db.url, migrationsRoot: staged.dir });
    assert.equal(await firstUse(admin), null);
    bridge = await startServer(db.url);
    const oldAfterMigration = await oldApi(cookie, copyPath, { method: "POST", body: oldRequest });
    assert.deepEqual(oldAfterMigration, oldCopy);
    const replay = await bridge.api(cookie, copyPath, { method: "POST", body: oldRequest });
    assert.deepEqual(replay, oldCopy);
    assert.equal(await firstUse(admin), null, "pre-bridge replay did not set the first-use marker");

    await selectWorkspace(admin, owner, "private_coach", null);
    try {
      const personalPath = `${apiPath}/${personal.body.dashboard.id}`;
      const oldPatch = await oldApi(cookie, personalPath, { method: "PATCH", body: { name: "Personal predecessor", expectedRevision: personal.body.dashboard.revision } });
      assert.equal(oldPatch.status, 200, oldPatch.text);
      const newPatch = await bridge.api(cookie, personalPath, { method: "PATCH", body: { name: "Personal bridge", expectedRevision: oldPatch.body.dashboard.revision } });
      assert.equal(newPatch.status, oldPatch.status, newPatch.text);
      assert.equal(newPatch.body.dashboard.name, "Personal bridge");
      assert.equal(await firstUse(admin), null);
    } finally {
      await selectWorkspace(admin, owner, "club", club);
    }

    const clonePath = `${apiPath}/${system.body.dashboard.id}/clone`;
    const clone = await bridge.api(platformCookie, clonePath, { method: "POST", body: { name: "Valid standalone clone", ownerScope: "team", ownerTeamId: standalone } });
    assert.equal(clone.status, 201, clone.text);
    const missingTeam = await bridge.api(platformCookie, clonePath, { method: "POST", body: { name: "Missing standalone clone", ownerScope: "team", ownerTeamId: randomUUID() } });
    assert.equal(missingTeam.status, 404, missingTeam.text);
    assert.equal(await firstUse(admin), null, "a platform override does not count as a checked native write");

    const bad = await bridge.api(cookie, copyPath, {
      method: "POST", body: { ...oldRequest, requestId: randomUUID() },
    });
    assert.equal(bad.status, 409, bad.text);
    assert.equal(await firstUse(admin), null, "a refused write did not set the marker");

    const invalidOwner = await fx.user("Unrelated club admin");
    const outside = await fx.club();
    await fx.grantClub(invalidOwner, outside);
    await selectWorkspace(admin, invalidOwner, "club", outside);
    const outsideCookie = await bridge.cookieFor(invalidOwner);
    const missing = await bridge.api(outsideCookie, `${apiPath}/${randomUUID()}/pages/${home}/copy`, { method: "POST", body: oldRequest });
    const foreign = await bridge.api(outsideCookie, copyPath, { method: "POST", body: oldRequest });
    assert.equal(missing.status, 404);
    assert.deepEqual(foreign, missing);
    assert.equal(await firstUse(admin), null);

    const fresh = await prepareCopy(bridge.api, cookie, dashboard.id, home);
    fresh.input.name = "Native checked page copy";
    const native = await bridge.api(cookie, copyPath, { method: "POST", body: fresh });
    assert.equal(native.status, 200, native.text);
    const marked = await firstUse(admin);
    assert.ok(marked instanceof Date, "a sanctioned native Page copy must set the marker");
    assert.deepEqual(await bridge.api(cookie, copyPath, { method: "POST", body: fresh }), native);
    assert.deepEqual(await firstUse(admin), marked);
    const newTeam = await bridge.api(teamCookie, apiPath, { method: "POST", body: { ...teamRequest, name: "Standalone bridge" } });
    assert.equal(newTeam.status, oldTeam.status, newTeam.text);
    assert.equal(newTeam.body.dashboard.owner_team_id, standalone);
    await assert.rejects(admin.query(read("rollback")), /bridge writer was used/);
    await admin.query("rollback");
  } finally {
    if (previous === undefined) delete process.env.P1_PREVIOUS_BUILD_SHA;
    else process.env.P1_PREVIOUS_BUILD_SHA = previous;
    if (pagesEnv === undefined) delete process.env.DASHBOARD_PAGES_ENABLED;
    else process.env.DASHBOARD_PAGES_ENABLED = pagesEnv;
    if (databaseEnv === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseEnv;
    await bridge?.stop();
    await old?.stop();
    await admin.end().catch(() => {});
    staged.cleanup();
    await db.drop();
  }
});
