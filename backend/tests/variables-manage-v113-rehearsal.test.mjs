import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";
import { asActor, fixtures, key, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

async function seedNativeRoleLayers(fixture, { teamRole = false } = {}) {
  const f = fixtures(fixture.client);
  const club = await f.club("Variables Manage staging " + key());
  const team = await f.team(club);
  const platform = await f.user("Variables Manage staging admin");
  const coach = await f.user("Variables Manage native coach");
  await f.grantPlatform(platform);
  if (teamRole) await f.grantTeam(coach, team);
  else await f.grantClub(coach, club);
  const versionCoach = await f.user("Variables Manage version coach");
  if (teamRole) await f.grantTeam(versionCoach, team);
  else await f.grantClub(versionCoach, club);
  const role = teamRole ? ROLE_IDS.team_coach : ROLE_IDS.club_admin;
  const scope = teamRole ? { type: 'team', id: team, table: 'user_team_roles', column: 'team_id' } : { type: 'club', id: club, table: 'user_club_roles', column: 'club_id' };
  return asActor(fixture.url, platform, async tx => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    const { rows: [version] } = await tx.query(
      `insert into public.permission_club_role_versions
         (club_id,system_role_id,based_on_revision,answered_revision,created_by_user_id)
       select $1,id,revision,revision,$3 from public.permission_roles where id=$2 returning id`, [club,role,platform],
    );
    await tx.query("insert into public.permission_club_role_version_items select $1,permission_word from public.permission_role_items where role_id=$2", [version.id,role]);
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
       select $1,$2,'${scope.type}',$3,$4,'${scope.table}',r.id,r.updated_at,'default',p.revision,$5
       from public.${scope.table} r join public.permission_roles p on p.id=$2
       where r.user_id=$1 and r.${scope.column}=$3 returning id`, [coach,role,scope.id,club,platform],
    );
    await tx.query("insert into public.permission_custom_role_items select $1,permission_word from public.permission_role_items where role_id=$2", [custom.id,role]);
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



const stagedBuild = "e4fd0132c1e3bf56d81e658a057949fba9cf943c";
const previousBuild = "904458d0590f84d01e5c13df6109a9a4ce770d36";
const migration = "202612151000";
const word = "variables.manage";
const read = name => readFile(new URL("../../docs/runbooks/variables-manage-v113-" + name + ".sql", import.meta.url), "utf8");

test("v113 applies, rolls back and restores the audited Variables catalogue", async () => {
  const fixture = await createPagesDatabase({ through: "202612141000", label: "variables_rename_v113" });
  const { client } = fixture;
  const check = row => assert.ok(Object.values(row).every(value => value === true), JSON.stringify(row));
  const marker = async () => (await client.query("select first_checked_write_at from training_load.variables_manage_v113_use")).rows[0].first_checked_write_at;
  const catalogue = async () => (await client.query(
    "select relname,relkind,relrowsecurity from pg_class where relnamespace='training_load'::regnamespace order by relname,relkind",
  )).rows;
  try {
    const { versionId, customId, club, team, platform, coach } = await seedNativeRoleLayers(fixture);
    await seedNativeRoleLayers(fixture, { teamRole: true });
    await client.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'platform',null)", [platform]);
    await client.query("update training_load.variable_rename_archive_v112_use set first_checked_write_at=clock_timestamp()");
    const beforeCatalogue = await catalogue();
    const beforeRoles = await roleData(client);
    const rollback = await read("rollback");
    const preflight = await read("preflight");
    check((await client.query(preflight)).rows[0]);
    await client.query("begin");
    try {
      await client.query("alter table public.permission_role_items disable trigger permission_role_items_guard");
      await client.query("delete from public.permission_role_items where role_id=$1 and permission_word='variables.view'", [ROLE_IDS.club_admin]);
      assert.equal((await client.query(preflight)).rows[0].exact_native_seed_roles, false);
    } finally {
      await client.query("rollback");
    }

    await fixture.applyThrough(migration);
    const installed = await catalogue();
    assert.notDeepEqual(installed, beforeCatalogue);
    check((await client.query(await read("postcheck")))[0].rows[0]);
    const { rows: seed } = await client.query("select layer,id,words from training_load.variables_manage_v113_seed order by layer,id");
    assert.deepEqual(seed.filter(row => row.layer !== "role"), [
      { layer: "custom", id: customId, words: [word] },
      { layer: "version", id: versionId, words: [word] },
    ]);
    assert.equal(seed.filter(row => row.layer === "role").length, 1);
    assert.equal(await marker(), null);
    await assert.rejects(client.query("delete from training_load.variables_manage_v113_use"), /immutable/);
    await assert.rejects(client.query("truncate training_load.variables_manage_v113_use"), /immutable/);
    await assert.rejects(client.query("update training_load.variables_manage_v113_use set first_checked_write_at=null"), /immutable/);
    await client.query("begin");
    try {
      await client.query("update training_load.variables_manage_v113_use set first_checked_write_at=clock_timestamp()");
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
        + " select id,revision+100,'migration','migrations_v2/202612151000_training_load_v113_variables_manage_bridge.sql',array['variables.manage']"
        + " from public.permission_roles r where not exists("
        + "select 1 from training_load.variables_manage_v113_seed s where s.layer='role' and s.id=r.id) order by r.id limit 1",
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
    assert.equal((await client.query("select * from training_load.variable_rename_archive_v112_use where first_checked_write_at is not null")).rowCount, 1);
    await fixture.applyThrough(migration);
    assert.deepEqual(await catalogue(), installed);
    check((await client.query(await read("postcheck")))[0].rows[0]);

    const later = "migrations_v2/202612151100_variables_rename_archive_rehearsal.sql";
    await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version,applied_at)"
      + " values($1,repeat('0',64),'test',now()-interval '1 day')", [later]);
    await assert.rejects(client.query(rollback), /later migration/);
    await client.query("rollback");
    await client.query("delete from public.schema_migrations where migration_name=$1", [later]);


    await client.query("update training_load.variables_manage_v113_use set first_checked_write_at=clock_timestamp()");
    const firstUsed = await marker();
    assert.ok(firstUsed);
    await assert.rejects(client.query(rollback), /refuses checked Variables Manage writer use/);
    await client.query("rollback");
    assert.deepEqual(await marker(), firstUsed);
  } finally {
    await fixture.drop();
  }
});

test("v113 old and current Settings and native variable operations share an exact disposable cutover", async () => {
  const fixture = await createPagesDatabase({ through: "202612141000", label: "vars_overlap_v113" });
  const { client } = fixture;
  let current, previous, staged;
  const priorReferences = process.env.DASHBOARD_REFERENCES_ENABLED;
  process.env.DASHBOARD_REFERENCES_ENABLED = 'true';
  try {
    const { versionId, customId, club, platform, coach, versionCoach } = await seedNativeRoleLayers(fixture);
    await fixture.applyThrough(migration);
    const f = fixtures(client);
    const clubAdmin = await f.user("Variables Manage club admin");
    await f.grantClub(clubAdmin, club);
    await client.query(
      "insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'platform',null),($2,'club',$3),($4,'club',$3),($5,'club',$3)",
      [platform, coach, club, clubAdmin, versionCoach],
    );
    const marker = async () => (await client.query("select first_checked_write_at from training_load.variables_manage_v113_use")).rows[0].first_checked_write_at;
    current = await startServer(fixture.url);
    previous = await previousDashboardServer(fixture.url, { DASHBOARD_REFERENCES_ENABLED: 'true' }, previousBuild);
    staged = await previousDashboardServer(fixture.url, { DASHBOARD_REFERENCES_ENABLED: 'true' }, stagedBuild);
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
    const roleId = ROLE_IDS.club_admin;
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
        [root + "/users/" + coach + "/clubs/" + club + "/custom", { roleId, scopeType: "club", scopeId: club, expectedRevision: roles.custom_revision, remove: [word] }],
      ]) {
        const rejected = await call(server, path, { requestKey: key(), reason: "Variables Manage is staged", ...input });
        assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
        assert.equal(rejected.body.error, "permission_not_available_yet");
      }
      const allowed = await call(server, root + "/" + roleId + "/change", {
        requestKey: key(), reason: "Keep staged word", expectedRevision: roles.role_revision,
        items: roles.items, description: "Variables Manage overlap " + key(),
      });
      assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    }

    const adminCookie = await current.cookieFor(clubAdmin);
    const path = "/api/training-load/sources/metrics/variables";
    const input = { requestKey: key(), label: "Old cutover variable", unit: "m", levels: ["session"], dailyAggregationMethod: "sum" };
    const response = await fetch(previous.baseUrl + path, {
      method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify(input),
    });
    const made = await response.json();
    assert.equal(response.status, 201, JSON.stringify(made));
    assert.equal(await marker(), null);
    const replay = await current.api(adminCookie, path, { method: "POST", body: input });
    assert.ok([200, 201].includes(replay.status), JSON.stringify(replay.body));
    assert.equal(replay.body.variable.id, made.variable.id);
    assert.equal(await marker(), null, "An existing receipt does not record first use");
    const references = "/api/training-load/reference-tables";
    const oldTable = { requestId: key(), name: "Old reference table" };
    const priorTableResponse = await fetch(previous.baseUrl + references, {
      method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify(oldTable),
    });
    const priorTable = await priorTableResponse.json();
    assert.equal(priorTableResponse.status, 201, JSON.stringify(priorTable));
    const tableReplay = await current.api(adminCookie, references, { method: "POST", body: oldTable });
    assert.equal(tableReplay.status, 201, JSON.stringify(tableReplay.body));
    assert.deepEqual(tableReplay.body, priorTable);
    assert.equal(await marker(), null);
    const checkedTable = await current.api(adminCookie, references, {
      method: "POST", body: { requestId: key(), name: "Checked reference table" },
    });
    assert.equal(checkedTable.status, 201, JSON.stringify(checkedTable.body));
    const firstUsed = await marker();
    assert.ok(firstUsed, "First checked reference-table receipt records use");
    const checked = await current.api(adminCookie, path, {
      method: "POST", body: { ...input, label: "Checked cutover variable", requestKey: key() },
    });
    assert.equal(checked.status, 201, JSON.stringify(checked.body));
    assert.deepEqual(await marker(), firstUsed);

    const publicCatalog = await call(current, root + "/catalog?clubId=" + club);
    assert.equal(publicCatalog.status, 200);
    assert.equal(publicCatalog.body.permissions.find(entry => entry.word === word)?.checked, true);
    assert.equal(publicCatalog.body.permissions.find(entry => entry.word === "variables.rename_archive")?.checked, true);
    assert.equal(publicCatalog.body.permissions.find(entry => entry.word === "mappings.manage")?.checked, true);

    const createInput = label => ({ ...input, label, requestKey: key() });
    const receipts = async () => (await client.query(
      "select count(*)::int as count from training_load.metric_variable_requests",
    )).rows[0].count;
    for (const layer of [
      { id: versionId, user: versionCoach, path: root + "/" + roleId + "/clubs/" + club + "/version",
        table: "permission_club_role_versions", auditTable: "permission_club_role_version_changes", auditKey: "version_id", receipt: "role", context: {} },
      { id: customId, user: coach, path: root + "/users/" + coach + "/clubs/" + club + "/custom",
        table: "permission_custom_roles", auditTable: "permission_custom_role_changes", auditKey: "custom_role_id", receipt: "custom",
        context: { roleId, scopeType: "club", scopeId: club } },
    ]) {
      const actorCookie = await current.cookieFor(layer.user);
      const permissions = async () => {
        const me = await current.api(actorCookie, "/api/auth/me");
        assert.equal(me.status, 200, me.text);
        return me.body.user.permissions;
      };
      const original = await permissions();
      assert.ok([word, "variables.view", "variables.rename_archive", "tests.view"].every(entry => original.includes(entry)));
      const change = async direction => {
        const { rows: [{ revision }] } = await client.query("select revision from public." + layer.table + " where id=$1", [layer.id]);
        const auditCount = async () => (await client.query(
          "select count(*)::int as count from public." + layer.auditTable + " where " + layer.auditKey + "=$1", [layer.id],
        )).rows[0].count;
        const before = await auditCount();
        const patch = { requestKey: key(), expectedRevision: revision, reason: "Review full Variables Manage", [direction]: [word], ...layer.context };
        const saved = await call(current, layer.path, patch);
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        assert.equal(await auditCount(), before + 1);
        const persisted = await roleData(client);
        const repeated = await call(staged, layer.path, patch);
        assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
        assert.ok(saved.body[layer.receipt]);
        assert.deepEqual(repeated.body, { [layer.receipt]: saved.body[layer.receipt], replayed: true });
        assert.deepEqual(await roleData(client), persisted);
      };
      const candidate = createInput("Scoped variable " + key());
      await change("remove");
      assert.deepEqual(await permissions(), original.filter(entry => entry !== word));
      const readable = await current.api(actorCookie, path + "/" + made.variable.id);
      assert.equal(readable.status, 200, readable.text);
      const beforeDenied = await receipts();
      const denied = await current.api(actorCookie, path, { method: "POST", body: candidate });
      assert.equal(denied.status, 404, denied.text);
      assert.equal(await receipts(), beforeDenied);
      await change("add");
      assert.deepEqual(await permissions(), original);
      const restored = await current.api(actorCookie, path, { method: "POST", body: candidate });
      assert.equal(restored.status, 201, restored.text);
      assert.equal(await receipts(), beforeDenied + 1);
    }

    await assert.rejects(client.query(await read("rollback")), /refuses checked Variables Manage writer use/);
    await client.query("rollback");
    assert.deepEqual(await marker(), firstUsed);
  } finally {
    if (priorReferences === undefined) delete process.env.DASHBOARD_REFERENCES_ENABLED;
    else process.env.DASHBOARD_REFERENCES_ENABLED = priorReferences;
    try {
      await Promise.all([previous?.stop(), staged?.stop()]);
    } finally {
      try { await current?.stop(); } finally { await fixture.drop(); }
    }
  }
});
