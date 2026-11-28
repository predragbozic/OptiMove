import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";
import { asActor, fixtures, key, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

async function seedNativeRoleLayers(fixture, { includeView = true } = {}) {
  const f = fixtures(fixture.client);
  const club = await f.club("Variables Rename and Archive staging " + key());
  const team = await f.team(club);
  const platform = await f.user("Variables Rename and Archive staging admin");
  const coach = await f.user("Variables Rename and Archive native coach");
  await f.grantPlatform(platform);
  await f.grantTeam(coach, team);
  const versionCoach = await f.user("Variables Rename and Archive version coach");
  await f.grantTeam(versionCoach, team);
  const role = ROLE_IDS.team_coach;
  return asActor(fixture.url, platform, async tx => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    const { rows: [version] } = await tx.query(
      `insert into public.permission_club_role_versions
         (club_id,system_role_id,based_on_revision,answered_revision,created_by_user_id)
       select $1,id,revision,revision,$3 from public.permission_roles where id=$2 returning id`, [club,role,platform],
    );
    await tx.query("insert into public.permission_club_role_version_items select $1,permission_word from public.permission_role_items where role_id=$2 and permission_word<>'tests.results.view' and ($3 or permission_word<>'variables.view')", [version.id,role,includeView]);
    await tx.query(
      `insert into public.permission_club_role_version_changes
         (version_id,revision_after,kind,performed_by_user_id,basis,reason,items_added)
       values($1,1,'create',$2,'platform_admin','Rehearsal version',
         array(select permission_word from public.permission_club_role_version_items where version_id=$1))`, [version.id,platform],
    );
    const { rows: [custom] } = await tx.query(
      `insert into public.permission_custom_roles
        (user_id,base_role_id,scope_type,scope_id,club_id,holding_row_table,holding_row_id,holding_row_version,
        frozen_from,frozen_from_revision,created_by_user_id)
       select $1,$2,'team',$3,$4,'user_team_roles',r.id,r.updated_at,'default',p.revision,$5
       from public.user_team_roles r join public.permission_roles p on p.id=$2
       where r.user_id=$1 and r.team_id=$3 returning id`, [coach,role,team,club,platform],
    );
    await tx.query("insert into public.permission_custom_role_items select $1,permission_word from public.permission_role_items where role_id=$2 and permission_word<>'tests.results.view' and ($3 or permission_word<>'variables.view')", [custom.id,role,includeView]);
    await tx.query(
      `insert into public.permission_custom_role_changes
         (custom_role_id,revision_after,kind,performed_by_user_id,basis,reason,items_added)
       values($1,1,'create',$2,'platform_admin','Rehearsal custom',
         array(select permission_word from public.permission_custom_role_items where custom_role_id=$1))`, [custom.id,platform],
    );
    return { versionId: version.id, customId: custom.id, club, team, platform, coach, versionCoach };
  });
}

function roleData(client) {
  return client.query(
    `select
      (select jsonb_agg(r order by id) from public.permission_roles r) as roles,
      (select jsonb_agg(i order by role_id,permission_word) from public.permission_role_items i) as role_items,
      (select jsonb_agg(a order by role_id,revision_after) from public.permission_role_changes a) as role_audit,
      (select jsonb_agg(r order by id) from public.permission_club_role_versions r) as versions,
      (select jsonb_agg(i order by version_id,permission_word) from public.permission_club_role_version_items i) as version_items,
      (select jsonb_agg(a order by version_id,revision_after) from public.permission_club_role_version_changes a) as version_audit,
      (select jsonb_agg(r order by id) from public.permission_custom_roles r) as custom,
      (select jsonb_agg(i order by custom_role_id,permission_word) from public.permission_custom_role_items i) as custom_items,
      (select jsonb_agg(a order by custom_role_id,revision_after) from public.permission_custom_role_changes a) as custom_audit`,
  ).then(({ rows }) => rows[0]);
}



const previousBuild = "bc8e3995489c711a5aafa5750dd99bc9b0a9608f";
const stagedBuild = "39f40e5b488df3a33f614783112cac65571f2986";
const migration = "202612141000";
const word = "variables.rename_archive";
const read = name => readFile(new URL("../../docs/runbooks/variable-rename-archive-v112-" + name + ".sql", import.meta.url), "utf8");

test("v112 applies, rolls back and restores the audited Variables catalogue", async () => {
  const fixture = await createPagesDatabase({ through: "202612131000", label: "variables_rename_v112" });
  const { client } = fixture;
  const check = row => assert.ok(Object.values(row).every(value => value === true), JSON.stringify(row));
  const marker = async () => (await client.query("select first_checked_write_at from training_load.variable_rename_archive_v112_use")).rows[0].first_checked_write_at;
  const catalogue = async () => (await client.query(
    "select relname,relkind,relrowsecurity from pg_class where relnamespace='training_load'::regnamespace order by relname,relkind",
  )).rows;
  try {
    const { versionId, customId, club, team, platform, coach, versionCoach } = await seedNativeRoleLayers(fixture);
    await seedNativeRoleLayers(fixture, { includeView: false });
    await client.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'platform',null)", [platform]);
    await client.query("update tests.schedule_manage_bridge_use set first_checked_write_at=clock_timestamp()");
    const beforeCatalogue = await catalogue();
    const beforeRoles = await roleData(client);
    const rollback = await read("rollback");
    const preflight = await read("preflight");
    check((await client.query(preflight)).rows[0]);
    await client.query("begin");
    try {
      await client.query("alter table public.permission_role_items disable trigger permission_role_items_guard");
      await client.query("delete from public.permission_role_items where role_id=$1 and permission_word='variables.view'", [ROLE_IDS.team_coach]);
      assert.equal((await client.query(preflight)).rows[0].exact_native_seed_roles, false);
    } finally {
      await client.query("rollback");
    }

    await fixture.applyThrough(migration);
    const installed = await catalogue();
    assert.notDeepEqual(installed, beforeCatalogue);
    check((await client.query(await read("postcheck")))[0].rows[0]);
    const { rows: seed } = await client.query("select layer,id,words from training_load.variable_rename_archive_v112_seed order by layer,id");
    assert.deepEqual(seed.filter(row => row.layer !== "role"), [
      { layer: "custom", id: customId, words: [word] },
      { layer: "version", id: versionId, words: [word] },
    ]);
    assert.equal(seed.filter(row => row.layer === "role").length, 2);
    assert.equal(await marker(), null);
    await assert.rejects(client.query("delete from training_load.variable_rename_archive_v112_use"), /immutable/);
    await assert.rejects(client.query("truncate training_load.variable_rename_archive_v112_use"), /immutable/);
    await assert.rejects(client.query("update training_load.variable_rename_archive_v112_use set first_checked_write_at=null"), /immutable/);
    await client.query("begin");
    try {
      await client.query("update training_load.variable_rename_archive_v112_use set first_checked_write_at=clock_timestamp()");
      assert.ok(await marker());
    } finally {
      await client.query("rollback");
    }
    assert.equal(await marker(), null);

    await client.query("begin");
    try {
      await client.query("alter table public.permission_role_changes disable trigger permission_role_changes_guard; alter table public.permission_role_changes disable trigger permission_role_changes_complete");
      const extra = await client.query(
        "insert into public.permission_role_changes(role_id,revision_after,kind,migration_name,items_added)"
        + " select id,revision+100,'migration','migrations_v2/202612141000_training_load_v112_variable_rename_archive_bridge.sql',array['variables.rename_archive']"
        + " from public.permission_roles r where not exists("
        + "select 1 from training_load.variable_rename_archive_v112_seed s where s.layer='role' and s.id=r.id) order by r.id limit 1",
      );
      assert.equal(extra.rowCount, 1);
      await client.query("alter table public.permission_role_changes enable trigger permission_role_changes_guard; alter table public.permission_role_changes enable trigger permission_role_changes_complete");
      await assert.rejects(client.query(rollback), /staged audit entry changed/);
    } finally {
      await client.query("rollback");
    }
    await client.query(rollback);
    assert.deepEqual(await catalogue(), beforeCatalogue);
    assert.deepEqual(await roleData(client), beforeRoles);
    assert.equal((await client.query("select * from tests.schedule_manage_bridge_use where first_checked_write_at is not null")).rowCount, 1);
    await fixture.applyThrough(migration);
    assert.deepEqual(await catalogue(), installed);
    check((await client.query(await read("postcheck")))[0].rows[0]);

    const later = "migrations_v2/202612141100_variables_rename_archive_rehearsal.sql";
    await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version,applied_at)"
      + " values($1,repeat('0',64),'test',now()-interval '1 day')", [later]);
    await assert.rejects(client.query(rollback), /later migration/);
    await client.query("rollback");
    await client.query("delete from public.schema_migrations where migration_name=$1", [later]);


    await client.query("update training_load.variable_rename_archive_v112_use set first_checked_write_at=clock_timestamp()");
    const firstUsed = await marker();
    assert.ok(firstUsed);
    await assert.rejects(client.query(rollback), /refuses checked Variables Rename and Archive writer use/);
    await client.query("rollback");
    assert.deepEqual(await marker(), firstUsed);
  } finally {
    await fixture.drop();
  }
});

test("v112 old and current Settings and native variable operations share an exact disposable cutover", async () => {
  const fixture = await createPagesDatabase({ through: "202612131000", label: "vars_overlap_v112" });
  const { client } = fixture;
  let current, previous, staged;
  try {
    const { versionId, customId, club, team, platform, coach } = await seedNativeRoleLayers(fixture);
    await fixture.applyThrough(migration);
    const f = fixtures(client);
    const clubAdmin = await f.user("Variables Rename and Archive club admin");
    await f.grantClub(clubAdmin, club);
    await client.query(
      "insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'platform',null),($2,'team',$3),($4,'club',$5),($6,'team',$3)",
      [platform, coach, team, clubAdmin, club, versionCoach],
    );
    const marker = async () => (await client.query("select first_checked_write_at from training_load.variable_rename_archive_v112_use")).rows[0].first_checked_write_at;
    current = await startServer(fixture.url);
    previous = await previousDashboardServer(fixture.url, {}, previousBuild);
    staged = await previousDashboardServer(fixture.url, {}, stagedBuild);
    const cookie = await current.cookieFor(platform);
    const root = "/api/organization/roles";
    async function call(server, path, body) {
      if (server.api) return server.api(cookie, path, { method: body ? "POST" : "GET", body });
      const response = await fetch(server.baseUrl + path, {
        method: body ? "POST" : "GET",
        headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }
    const roleId = ROLE_IDS.team_coach;
    for (const server of [previous, staged]) {
      const { rows: [roles] } = await client.query(
        "select (select revision from public.permission_roles where id=$1) as role_revision,"
        + " (select revision from public.permission_club_role_versions where id=$2) as version_revision,"
        + " (select revision from public.permission_custom_roles where id=$3) as custom_revision,"
        + " array(select permission_word from public.permission_role_items where role_id=$1 order by 1) as items",
        [roleId, versionId, customId],
      );
      const catalog = await call(server, root + "/catalog?clubId=" + club);
      assert.equal(catalog.status, 200);
      assert.equal(catalog.body.permissions.find(entry => entry.word === word)?.checked, false);
      for (const [path, input] of [
        [root + "/" + roleId + "/change", { expectedRevision: roles.role_revision, items: roles.items.filter(item => item !== word) }],
        [root + "/" + roleId + "/clubs/" + club + "/version", { expectedRevision: roles.version_revision, remove: [word] }],
        [root + "/users/" + coach + "/clubs/" + club + "/custom", { roleId, scopeType: "team", scopeId: team, expectedRevision: roles.custom_revision, remove: [word] }],
      ]) {
        const rejected = await call(server, path, { requestKey: key(), reason: "Variables Rename and Archive is staged", ...input });
        assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
        assert.equal(rejected.body.error, "permission_not_available_yet");
      }
      const allowed = await call(server, root + "/" + roleId + "/change", {
        requestKey: key(), reason: "Keep staged word", expectedRevision: roles.role_revision,
        items: roles.items, description: "Variables Rename and Archive overlap " + key(),
      });
      assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    }

    const coachCookie = await current.cookieFor(coach);
    const adminCookie = await current.cookieFor(clubAdmin);
    const metrics = "/api/training-load/sources/metrics/variables";
    async function request(server, actorCookie, path, body) {
      const method = body === undefined ? "GET" : "POST";
      if (server === current) return current.api(actorCookie, path, { method, body });
      const response = await fetch(server.baseUrl + path, {
        method,
        headers: { Cookie: actorCookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: JSON.parse(text), text };
    }
    const made = await request(previous, adminCookie, metrics, {
      requestKey: key(), label: "Cutover variable", unit: "m", levels: ["session"], dailyAggregationMethod: "sum",
    });
    assert.equal(made.status, 201, made.text);
    const id = made.body.variable.id;
    const path = metrics + "/" + id;
    async function change(server, action, body, expected = 200) {
      const result = await request(server, coachCookie, path + "/" + action, body);
      assert.equal(result.status, expected, result.text);
      return result.body;
    }
    const oldRead = await request(previous, coachCookie, path);
    assert.equal(oldRead.status, 200, oldRead.text);
    const oldRename = { requestKey: key(), labelsToken: oldRead.body.variable.labelsToken, label: "Old server name" };
    await change(previous, "rename", oldRename);
    const icons = (await import("../src/iconKeys.js")).ICON_KEYS;
    const [oldIcon, nextIcon] = [...icons];
    assert.ok(oldIcon && nextIcon);
    await change(previous, "icon", { requestKey: key(), expectedIconKey: null, iconKey: oldIcon });
    await change(previous, "archive", { requestKey: key(), reason: "Old server archive" });
    await change(previous, "restore", { requestKey: key() });
    assert.equal(await marker(), null, "the pre-bridge writer does not stamp v112");

    const replay = await change(current, "rename", oldRename);
    assert.equal(replay.replayed, true);
    assert.equal(await marker(), null, "a replay is not a new checked write");
    const checked = await request(current, coachCookie, path);
    assert.equal(checked.status, 200, checked.text);
    const firstRequest = { requestKey: key(), labelsToken: checked.body.variable.labelsToken, label: "Checked name" };
    await change(current, "rename", firstRequest);
    const firstUsed = await marker();
    assert.ok(firstUsed);
    await change(current, "icon", { requestKey: key(), expectedIconKey: oldIcon, iconKey: nextIcon });
    await change(current, "archive", { requestKey: key(), reason: "Checked archive" });
    await change(current, "restore", { requestKey: key() });
    const [final] = (await client.query(
      "select label, icon_url, state from training_load.metric_definitions where id=$1", [id],
    )).rows;
    assert.deepEqual(final, { label: "Checked name", icon_url: "icon:" + nextIcon, state: "active" });

    const exposedCatalog = await call(current, root + "/catalog?clubId=" + club);
    assert.equal(exposedCatalog.status, 200);
    assert.equal(exposedCatalog.body.permissions.find(entry => entry.word === word)?.checked, true);
    assert.equal(exposedCatalog.body.permissions.find(entry => entry.word === "variables.manage")?.checked, false);
    const snapshot = async () => (await client.query(
      "select d.label,d.icon_url,d.state,"
      + " (select count(*)::int from training_load.metric_variable_changes where metric_definition_id=d.id) as changes,"
      + " (select count(*)::int from training_load.metric_variable_requests where metric_definition_id=d.id) as receipts"
      + " from training_load.metric_definitions d where id=$1", [id],
    )).rows[0];
    let icon = nextIcon;
    for (const layer of [
      { id: versionId, cookie: await current.cookieFor(versionCoach), path: root + "/" + roleId + "/clubs/" + club + "/version",
        table: "permission_club_role_versions", auditTable: "permission_club_role_version_changes", auditKey: "version_id", context: {} },
      { id: customId, cookie: coachCookie, path: root + "/users/" + coach + "/clubs/" + club + "/custom",
        table: "permission_custom_roles", auditTable: "permission_custom_role_changes", auditKey: "custom_role_id",
        context: { roleId, scopeType: "team", scopeId: team } },
    ]) {
      const permissions = async () => {
        const me = await current.api(layer.cookie, "/api/auth/me");
        assert.equal(me.status, 200, me.text);
        return me.body.user.permissions;
      };
      const originalWords = await permissions();
      assert.ok(originalWords.includes(word) && originalWords.includes("variables.view") && originalWords.includes("tests.view"));
      const revise = async direction => {
        const { rows: [{ revision }] } = await client.query("select revision from public." + layer.table + " where id=$1", [layer.id]);
        const auditCount = async () => (await client.query(
          "select count(*)::int as count from public." + layer.auditTable + " where " + layer.auditKey + "=$1",
          [layer.id],
        )).rows[0].count;
        const before = await auditCount();
        const input = { requestKey: key(), expectedRevision: revision, reason: "Review Variables Rename and Archive", [direction]: [word], ...layer.context };
        const saved = await call(current, layer.path, input);
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        assert.equal(await auditCount(), before + 1);
        const stored = await roleData(client);
        const repeated = await call(staged, layer.path, input);
        assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
        assert.deepEqual(repeated.body, { ...saved.body, replayed: true });
        assert.equal(await auditCount(), before + 1);
        assert.deepEqual(await roleData(client), stored);
      };
      const next = icon === oldIcon ? nextIcon : oldIcon;
      const iconPath = path + "/icon";
      const draft = { requestKey: key(), expectedIconKey: icon, iconKey: next };
      const before = await snapshot();
      await revise("remove");
      assert.deepEqual(await permissions(), originalWords.filter(entry => entry !== word));
      const readScope = await request(current, layer.cookie, path);
      assert.equal(readScope.status, 200, readScope.text);
      const denied = await request(current, layer.cookie, iconPath, draft);
      const missing = await request(current, layer.cookie, metrics + "/" + key() + "/icon", draft);
      assert.deepEqual([denied.status, denied.text], [404, missing.text]);
      assert.equal(missing.status, 404, missing.text);
      assert.deepEqual(await snapshot(), before);
      await revise("add");
      assert.deepEqual(await permissions(), originalWords);
      const accepted = await request(current, layer.cookie, iconPath, draft);
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(accepted.body.variable.icon, next);
      const after = await snapshot();
      assert.deepEqual(after, { ...before, icon_url: "icon:" + next, changes: before.changes + 1, receipts: before.receipts + 1 });
      icon = next;
    }

    assert.deepEqual(await marker(), firstUsed);
    await assert.rejects(client.query(await read("rollback")), /refuses checked Variables Rename and Archive writer use/);
    await client.query("rollback");
    assert.deepEqual(await marker(), firstUsed);
  } finally {
    try {
      await Promise.all([previous?.stop(), staged?.stop()]);
    } finally {
      try { await current?.stop(); } finally { await fixture.drop(); }
    }
  }
});
