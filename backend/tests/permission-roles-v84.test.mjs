// Roles R2, migration v84: the schema, the seed and the database guards
// (docs/ai/roles-r2-contract.md, tests 1-16, 5a and 6 of section 8), by direct
// SQL on disposable databases built from the legacy snapshot and the real
// runner. Each guard case asserts the SQLSTATE and the fixed message.
// The Roles API is roles-api-r2.test.mjs; can() and the twin are
// permission-roles-v84-equivalence.test.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { runMigrations } from "../src/migrate.js";
import { BASIC_ROLE_PERMISSIONS, PERMISSION_GROUPS, PERMISSIONS } from "../src/permissions.js";
import { asActor, buildDatabase, fixtures, migrationsWithout, MIGRATIONS, NIL, ROLE_IDS, RUNBOOKS, V84_FILE, V84_NAME } from "./support/permission-roles-world.mjs";

let db, k, F;
before(async () => {
  db = await buildDatabase({ label: "v84" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
});
after(async () => {
  await k?.end().catch(() => {});
  await db?.drop();
});

const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
async function refused(promise, code, message) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `SQLSTATE ${e.code} (${e.message})`);
    if (message) assert.match(e.message, message);
    return true;
  });
}
// A club with an admin, a team with a coach, a platform admin.
async function world() {
  const club = await F.club();
  const team = await F.team(club);
  const admin = await F.user("admin"); await F.grantClub(admin, club);
  const coach = await F.user("coach"); await F.grantTeam(coach, team);
  const pa = await F.user("pa"); await F.grantPlatform(pa);
  const other = await F.user("other");
  return { club, team, admin, coach, pa, other };
}
// A club role written as the actor would (role, items, change row) in one transaction.
async function clubRole(actor, club, { name = `Role ${crypto.randomBytes(3).toString("hex")}`, items = ["org.view"], club_ = true, team_ = true } = {}) {
  return asActor(db.url, actor, async (c) => {
    const id = (await c.query(`insert into public.permission_roles (owner_scope, owner_club_id, name, assignable_club, assignable_team, created_by_user_id)
                               values ('club', $1, $2, $3, $4, $5) returning id`, [club, name, club_, team_, actor])).rows[0].id;
    for (const w of items) await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, $2, $3)`, [id, w, actor]);
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, items_added)
                   values ($1, 1, 'create', $2, public.permission_actor_basis($2, 'roles.manage', 'club', $3), $4)`, [id, actor, club, items]);
    return id;
  });
}
// An assignment written as the actor would (row and request record).
async function assign(actor, { userId, roleId, scopeType, scopeId, club, basis = "club_admin", expiresAt = null }) {
  return asActor(db.url, actor, async (c) => {
    const id = (await c.query(`insert into public.user_role_assignments (user_id, role_id, scope_type, scope_id, granted_by_user_id, grant_basis, grant_reason, expires_at)
                               values ($1, $2, $3, $4, $5, $6, 'Needed', $7) returning id`, [userId, roleId, scopeType, scopeId, actor, basis, expiresAt])).rows[0].id;
    await c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, assignment_id)
                   values ($1, $2, 'assignment_grant', $3, 'club', $4, $5, $6)`, [crypto.randomUUID(), actor, "a".repeat(64), club, basis, id]);
    return id;
  });
}
const digestOfRoleTables = async (c) => (await c.query(`select
    (select md5(coalesce(string_agg(t::text, ';' order by t.id), '')) from public.user_global_roles t) as g,
    (select md5(coalesce(string_agg(t::text, ';' order by t.id), '')) from public.user_club_roles t) as c,
    (select md5(coalesce(string_agg(t::text, ';' order by t.id), '')) from public.user_team_roles t) as t,
    (select count(*) from public.user_club_roles) + (select count(*) from public.user_team_roles) + (select count(*) from public.user_global_roles) as n`)).rows[0];
const CATALOG_SQL = `select
  (select string_agg(c.relname || ':' || c.relkind::text, ',' order by c.relname) from pg_class c where c.relnamespace = 'public'::regnamespace) as rels,
  (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), ',' order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace = 'public'::regnamespace) as procs,
  (select string_agg(k.conrelid::regclass::text || '.' || k.conname || '=' || pg_get_constraintdef(k.oid), ',' order by k.conrelid::regclass::text, k.conname) from pg_constraint k where k.connamespace = 'public'::regnamespace) as cons,
  (select string_agg(t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgenabled::text, ',' order by t.tgrelid::regclass::text, t.tgname) from pg_trigger t where not t.tgisinternal and t.tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)) as trigs`;

// ---------------------------------------------------------------------------
// Schema and seed
// ---------------------------------------------------------------------------
test("1. v84 applied by the runner rewrites no existing role row; applied twice is the runner's checksum skip; the rollback restores the catalog exactly and v84 applies again", async () => {
  const pre = await buildDatabase({ label: "v84_apply", withoutV84: true });
  const c = new pg.Client({ connectionString: pre.url });
  await c.connect();
  try {
    // Old role rows of every kind, active and not.
    const u = async (n) => (await c.query(`insert into public.users (email, first_name, last_name, full_name, is_active) values ($1,'a','b','a b',true) returning id`, [`${n}-${crypto.randomBytes(3).toString("hex")}@t`])).rows[0].id;
    const club = (await c.query(`insert into public.clubs (name) values ('Pre') returning id`)).rows[0].id;
    const team = (await c.query(`insert into public.teams (club_id, name) values ($1, 'T') returning id`, [club])).rows[0].id;
    const a = await u("a"), b = await u("b"), p = await u("p");
    await c.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true), ($3,$2,'club_admin',false)`, [a, club, b]);
    await c.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true), ($3,$2,'team_coach',false)`, [b, team, a]);
    await c.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true), ($2,'independent_coach',true)`, [p, a]);
    const before = await digestOfRoleTables(c);
    const catalogBefore = (await c.query(CATALOG_SQL)).rows[0];
    await runMigrations({ databaseUrl: pre.url, migrationsRoot: MIGRATIONS });
    assert.deepEqual(await digestOfRoleTables(c), before, "v84 rewrites no row of the three old role tables");
    const recorded = (await c.query(`select checksum from public.schema_migrations where migration_name = $1`, [V84_NAME])).rows;
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].checksum, crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, V84_FILE))).digest("hex"));
    const count = Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count);
    await runMigrations({ databaseUrl: pre.url, migrationsRoot: MIGRATIONS });
    assert.equal(Number((await c.query(`select count(*) from public.schema_migrations`)).rows[0].count), count, "the second run applies nothing");
    // The rollback (the runbook's file), then the catalog equals the one before v84, then v84 again.
    await c.query(fs.readFileSync(path.join(RUNBOOKS, "permission-roles-v84-rollback.sql"), "utf8"));
    assert.deepEqual((await c.query(CATALOG_SQL)).rows[0], catalogBefore, "the catalog after the rollback equals the one before v84");
    assert.deepEqual(await digestOfRoleTables(c), before);
    await runMigrations({ databaseUrl: pre.url, migrationsRoot: MIGRATIONS });
    assert.equal(Number((await c.query(`select count(*) from public.permissions`)).rows[0].count), 52, "v84 applies again");
  } finally {
    await c.end().catch(() => {});
    await pre.drop();
  }
});

test("1b. the rollback refuses (23514, nothing changed) once a role was created, an assignment or a change record exists, or a later migration is recorded", async () => {
  const rollback = fs.readFileSync(path.join(RUNBOOKS, "permission-roles-v84-rollback.sql"), "utf8");
  const pre = await buildDatabase({ label: "v84_rb" });
  const c = new pg.Client({ connectionString: pre.url });
  await c.connect();
  try {
    const catalog = (await c.query(CATALOG_SQL)).rows[0];
    // A later migration recorded.
    await c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912310000_later.sql', $1, 'test')`, ["f".repeat(64)]);
    await refused(c.query(rollback), "23514", /later migrations are applied/);
    await c.query("rollback").catch(() => {});
    await c.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/209912310000_later.sql'`);
    // A changed seed (a basic role renamed by a migration-mode write is the only legal way; plant it with triggers off).
    await c.query(`set session_replication_role = replica`);
    await c.query(`update public.permission_roles set description = 'Changed' where id = $1`, [ROLE_IDS.team_coach]);
    await c.query(`reset session_replication_role`);
    await refused(c.query(rollback), "23514", /the seed was changed/);
    await c.query("rollback").catch(() => {});
    await c.query(`set session_replication_role = replica`);
    await c.query(`update public.permission_roles set description = null where id = $1`, [ROLE_IDS.team_coach]);
    // A created role.
    await c.query(`insert into public.permission_roles (owner_scope, name, assignable_club) values ('system', 'Planted', true)`);
    await c.query(`reset session_replication_role`);
    await refused(c.query(rollback), "23514", /a role was created/);
    await c.query("rollback").catch(() => {});
    assert.equal(Number((await c.query(`select count(*) from public.permission_roles`)).rows[0].count), 5, "nothing changed");
    assert.notEqual((await c.query(CATALOG_SQL)).rows[0].rels, null);
    assert.equal((await c.query(CATALOG_SQL)).rows[0].cons, catalog.cons, "the CHECKs are still there");
  } finally {
    await c.end().catch(() => {});
    await pre.drop();
  }
});

test("2. the seed equals the code catalog: 12 modules, 52 words, 89 scope rows, 4 roles, 10 items (Club admin = R1's set plus roles.manage, no accounts.manage); no private scope row; no item for Platform admin or Independent coach; no module-switch table", async () => {
  const modules = (await k.query(`select word, label from public.permission_modules order by sort_order`)).rows;
  assert.deepEqual(modules.map((m) => [m.word, m.label]), PERMISSION_GROUPS.map((g) => [g.key, g.label]));
  const words = (await k.query(`select p.word, p.module_word, p.platform_only, p.system_role_only,
      array(select s.scope_type from public.permission_scope_types s where s.permission_word = p.word order by 1) as types
      from public.permissions p order by p.sort_order`)).rows;
  assert.deepEqual(words.map((w) => w.word), Object.keys(PERMISSIONS));
  for (const w of words) {
    const e = PERMISSIONS[w.word];
    assert.equal(w.module_word, e.module, w.word);
    assert.equal(w.platform_only, e.platformOnly, w.word);
    assert.equal(w.system_role_only, e.systemRoleOnly, w.word);
    assert.deepEqual(w.types, [...e.scopeTypes].sort(), w.word);
  }
  assert.equal(Number((await one(`select count(*) from public.permission_scope_types`)).count), 89);
  assert.equal(Number((await one(`select count(*) from public.permission_scope_types where scope_type = 'private'`)).count), 0);
  const roles = (await k.query(`select id, basic_key, owner_scope, assignable_club, assignable_team, assignable_private, assignable_global from public.permission_roles order by id`)).rows;
  assert.deepEqual(roles.map((r) => [r.id, r.basic_key]), Object.entries(ROLE_IDS).map(([b, id]) => [id, b]).sort());
  const items = async (id) => (await k.query(`select permission_word from public.permission_role_items where role_id = $1 order by 1`, [id])).rows.map((r) => r.permission_word);
  assert.deepEqual(await items(ROLE_IDS.club_admin), [...BASIC_ROLE_PERMISSIONS.club_admin, "roles.manage"].sort());
  assert.deepEqual(await items(ROLE_IDS.team_coach), [...BASIC_ROLE_PERMISSIONS.team_coach].sort());
  assert.deepEqual(await items(ROLE_IDS.platform_admin), []);
  assert.deepEqual(await items(ROLE_IDS.independent_coach), []);
  assert.equal(Number((await one(`select count(*) from public.permission_role_items`)).count), 10);
  assert.equal((await one(`select to_regclass('public.module_switches') as t`)).t, null);
  assert.equal((await one(`select to_regclass('public.module_switch_changes') as t`)).t, null);
});

test("2b. the text rule is a byte-for-byte copy of v40's; the honoured list of the database equals HONOURED_PERMISSIONS", async () => {
  const bodies = (await k.query(`select n.nspname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname, p.proname) in (('public', 'permission_text_ok'), ('training_load', 'source_metric_text_ok'))`)).rows;
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].prosrc, bodies[1].prosrc);
  const { HONOURED_PERMISSIONS } = await import("../src/permissions.js");
  const honoured = (await k.query(`select word from public.permissions where public.permission_word_honoured(word) order by word`)).rows.map((r) => r.word);
  assert.deepEqual(honoured, [...HONOURED_PERMISSIONS].sort());
});

test("3. v84 refuses to run with a planted row of another word in user_club_roles or user_team_roles (active, then inactive): the fixed message, nothing of v84 remains", async () => {
  const pre = await buildDatabase({ label: "v84_refuse", withoutV84: true });
  const c = new pg.Client({ connectionString: pre.url });
  await c.connect();
  try {
    const u = (await c.query(`insert into public.users (email, first_name, last_name, full_name) values ('w@t','a','b','a b') returning id`)).rows[0].id;
    const club = (await c.query(`insert into public.clubs (name) values ('W') returning id`)).rows[0].id;
    const team = (await c.query(`insert into public.teams (club_id, name) values ($1,'T') returning id`, [club])).rows[0].id;
    const nothingOfV84 = async () => {
      assert.equal((await c.query(`select to_regclass('public.permission_roles') as t`)).rows[0].t, null);
      assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V84_NAME])).rows[0].n, 0);
      assert.equal((await c.query(`select count(*)::int as n from pg_constraint where conname like 'user_%_roles_role_word'`)).rows[0].n, 0);
    };
    for (const active of [true, false]) {
      const row = (await c.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_manager',$3) returning id`, [u, club, active])).rows[0].id;
      await assert.rejects(runMigrations({ databaseUrl: pre.url, migrationsRoot: MIGRATIONS }), (e) => /user_club_roles holds a role word other than club_admin/.test(`${e.message} ${e.cause?.message ?? ""}`));
      await nothingOfV84();
      await c.query(`delete from public.user_club_roles where id = $1`, [row]);
    }
    for (const active of [true, false]) {
      const row = (await c.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_trainer',$3) returning id`, [u, team, active])).rows[0].id;
      await assert.rejects(runMigrations({ databaseUrl: pre.url, migrationsRoot: MIGRATIONS }), (e) => /user_team_roles holds a role word other than team_coach/.test(`${e.message} ${e.cause?.message ?? ""}`));
      await nothingOfV84();
      await c.query(`delete from public.user_team_roles where id = $1`, [row]);
    }
  } finally {
    await c.end().catch(() => {});
    await pre.drop();
  }
});

test("4. after v84 an INSERT or UPDATE of another word into either old table is 23514 by the named constraint", async () => {
  const w = await world();
  await assert.rejects(k.query(`insert into public.user_club_roles (user_id, club_id, role) values ($1,$2,'club_manager')`, [w.other, w.club]), (e) => e.code === "23514" && e.constraint === "user_club_roles_role_word");
  await assert.rejects(k.query(`update public.user_club_roles set role = 'coach' where user_id = $1`, [w.admin]), (e) => e.code === "23514" && e.constraint === "user_club_roles_role_word");
  await assert.rejects(k.query(`insert into public.user_team_roles (user_id, team_id, role) values ($1,$2,'trainer')`, [w.other, w.team]), (e) => e.code === "23514" && e.constraint === "user_team_roles_role_word");
  await assert.rejects(k.query(`update public.user_team_roles set role = 'club_admin' where user_id = $1`, [w.coach]), (e) => e.code === "23514" && e.constraint === "user_team_roles_role_word");
});

test("5. the lookup tables refuse UPDATE, DELETE and TRUNCATE; a word without a scope row, and a scope row that breaks platform_only, fail at COMMIT", async () => {
  await refused(k.query(`update public.permission_modules set label = 'x' where word = 'tests'`), "23514", /permission modules: the list is fixed/);
  await refused(k.query(`delete from public.permission_modules where word = 'tests'`), "23514", /permission modules: the list is fixed/);
  await refused(k.query(`truncate public.permission_modules cascade`), "23514", /permission modules: the list is fixed/);
  for (const t of ["permissions", "permission_scope_types"]) {
    await refused(k.query(`update public.${t} set ${t === "permissions" ? "sort_order = sort_order" : "scope_type = scope_type"}`), "23514", /permissions: the catalog is fixed/);
    await refused(k.query(`delete from public.${t}`), "23514", /permissions: the catalog is fixed/);
    await refused(k.query(`truncate public.${t} cascade`), "23514", /permissions: the catalog is fixed/);
  }
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    await c.query("begin");
    await c.query(`insert into public.permissions (word, module_word, sort_order) values ('tests.extra', 'tests', 99)`);
    await refused(c.query("commit"), "23514", /permissions: the catalog is fixed/);
    await c.query("begin");
    await c.query(`insert into public.permissions (word, module_word, platform_only, sort_order) values ('tests.extra_two', 'tests', true, 98)`);
    await c.query(`insert into public.permission_scope_types (permission_word, scope_type) values ('tests.extra_two', 'club')`);
    await refused(c.query("commit"), "23514", /permissions: the catalog is fixed/);
    assert.equal(Number((await one(`select count(*) from public.permissions`)).count), 52);
  } finally {
    await c.end();
  }
});

test("5a. a later migration's item write (M15): through the runner it commits and raises the revision; without its change row, with an acting user set, or without the schema_migrations row of its name, it fails and nothing remains", async () => {
  const pre = await buildDatabase({ label: "v84_m15" });
  const c = new pg.Client({ connectionString: pre.url });
  await c.connect();
  const name = "209912311200_roles_test_item_write.sql";
  const body = (migrationName) => `
update public.permission_roles set revision = revision + 1, updated_at = now() where id = '${ROLE_IDS.team_coach}';
insert into public.permission_role_changes (role_id, revision_after, kind, migration_name, items_removed)
  select id, revision, 'migration', '${migrationName}', array['athletes.remove'] from public.permission_roles where id = '${ROLE_IDS.team_coach}';
delete from public.permission_role_items where role_id = '${ROLE_IDS.team_coach}' and permission_word = 'athletes.remove';
`;
  const tmp = migrationsWithout([]);
  try {
    // Negative cases first, each in a plain transaction.
    const items = async () => (await c.query(`select array_agg(permission_word order by permission_word) as a from public.permission_role_items where role_id = $1`, [ROLE_IDS.team_coach])).rows[0].a;
    const before = await items();
    // Without the schema_migrations row of that name: fails at COMMIT.
    await c.query("begin");
    await c.query(body(`migrations_v2/${name}`));
    await refused(c.query("commit"), "23514", /permission role change: the record must follow its own change in the same transaction/);
    assert.deepEqual(await items(), before);
    // Without the change row: the item write is refused.
    await c.query("begin");
    await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [ROLE_IDS.team_coach]);
    await refused(c.query(`delete from public.permission_role_items where role_id = $1 and permission_word = 'athletes.remove'`, [ROLE_IDS.team_coach]), "42501", /permission role item: the acting user may not write this role/);
    await c.query("rollback");
    // With an acting user set: the migration row is refused.
    const pa = (await c.query(`insert into public.users (email, first_name, last_name, full_name) values ('m15@t','a','b','a b') returning id`)).rows[0].id;
    await c.query(`insert into public.user_global_roles (user_id, role) values ($1, 'platform_admin')`, [pa]);
    await c.query("begin");
    await c.query(`select set_config('optimove.permission_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [pa]);
    await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [ROLE_IDS.team_coach]);
    await refused(c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, migration_name, items_removed)
        select id, revision, 'migration', 'migrations_v2/${name}', array['athletes.remove'] from public.permission_roles where id = $1`, [ROLE_IDS.team_coach]),
    "23514", /permission role change: the record must follow its own change in the same transaction/);
    await c.query("rollback");
    assert.deepEqual(await items(), before);
    // Through the runner: commits.
    fs.writeFileSync(path.join(tmp.dir, name), body(`migrations_v2/${name}`));
    await runMigrations({ databaseUrl: pre.url, migrationsRoot: tmp.dir });
    assert.deepEqual(await items(), ["athletes.manage", "org.view"]);
    const role = (await c.query(`select revision from public.permission_roles where id = $1`, [ROLE_IDS.team_coach])).rows[0];
    assert.equal(role.revision, 2);
    const change = (await c.query(`select kind, performed_by_user_id, basis, migration_name from public.permission_role_changes where role_id = $1`, [ROLE_IDS.team_coach])).rows[0];
    assert.deepEqual(change, { kind: "migration", performed_by_user_id: null, basis: null, migration_name: `migrations_v2/${name}` });
  } finally {
    tmp.cleanup();
    await c.end().catch(() => {});
    await pre.drop();
  }
});

test("6. row-level security and the revokes: as a role without ownership, every table and every function of v84 is refused", async () => {
  const role = `optimove_test_r2_${crypto.randomBytes(4).toString("hex")}`;
  await k.query(`create role ${role} nologin`);
  try {
    const tables = ["permission_modules", "permissions", "permission_scope_types", "permission_roles", "permission_role_items", "permission_role_module_display", "permission_role_changes", "user_role_assignments", "permission_requests"];
    for (const t of tables) {
      assert.equal((await one(`select relrowsecurity as on from pg_class where oid = $1::regclass`, [`public.${t}`])).on, true, `${t}: row-level security`);
      await k.query("begin");
      await k.query(`set local role ${role}`);
      await refused(k.query(`select 1 from public.${t} limit 1`), "42501");
      await k.query("rollback");
    }
    const fns = (await k.query(`select p.oid::regprocedure::text as f from pg_proc p where p.pronamespace = 'public'::regnamespace
        and (p.proname like 'permission%' or p.proname in ('user_has_permission', 'user_holds_role_items', 'lock_permission_actor') or p.proname like 'user_role_assignments%')`)).rows.map((r) => r.f);
    assert.ok(fns.length >= 29, `the v84 functions (${fns.length})`);
    for (const f of fns) assert.equal((await one(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, f])).ok, false, f);
    for (const t of tables) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) assert.equal((await one(`select has_table_privilege($1, $2, $3) as ok`, [role, `public.${t}`, priv])).ok, false, `${t} ${priv}`);
    }
  } finally {
    await k.query("rollback").catch(() => {});
    await k.query(`drop role ${role}`);
  }
});

// ---------------------------------------------------------------------------
// Guards, direct SQL
// ---------------------------------------------------------------------------
test("8. no acting user, a malformed one, one of another transaction (a session-level SET): 42501 on every guarded table", async () => {
  const w = await world();
  const role = await clubRole(w.admin, w.club);
  const writes = [
    (c) => c.query(`insert into public.permission_roles (owner_scope, owner_club_id, name, assignable_club, created_by_user_id) values ('club', $1, 'X8', true, $2)`, [w.club, w.admin]),
    (c) => c.query(`insert into public.user_role_assignments (user_id, role_id, scope_type, scope_id, granted_by_user_id, grant_basis, grant_reason) values ($1,$2,'club',$3,$4,'club_admin','x')`, [w.other, role, w.club, w.admin]),
    (c) => c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, assignment_id)
                    values (gen_random_uuid(), $1, 'assignment_grant', repeat('a',64), 'club', $2, 'club_admin', gen_random_uuid())`, [w.admin, w.club]),
    (c) => c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis) values ($1, 1, 'create', $2, 'club_admin')`, [role, w.admin]),
  ];
  for (const [i, write] of writes.entries()) {
    await refused(asActor(db.url, null, write), "42501", /permissions: no acting user is set for this transaction/, `write ${i} without actor`);
    await refused(asActor(db.url, w.admin, write, { actor: "not-a-user" }), "42501", /permissions: no acting user is set for this transaction/);
    // A session-level SET of an earlier transaction.
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      await c.query(`select set_config('optimove.permission_actor', $1 || ':1', false)`, [w.admin]);
      await c.query("begin");
      await refused(write(c), "42501", /permissions: no acting user is set for this transaction/);
      await c.query("rollback");
    } finally {
      await c.end();
    }
  }
});

test("9. a role naming another user; a club's role by another club's admin, by a team coach, by an inactive admin: 42501", async () => {
  const w = await world();
  const otherClub = await F.club();
  const otherAdmin = await F.user("other-admin"); await F.grantClub(otherAdmin, otherClub);
  const inactive = await F.user("inactive-admin"); await F.grantClub(inactive, w.club); await k.query(`update public.users set is_active = false where id = $1`, [inactive]);
  const insert = (actor, createdBy) => asActor(db.url, actor, (c) => c.query(`insert into public.permission_roles (owner_scope, owner_club_id, name, assignable_club, created_by_user_id) values ('club', $1, $2, true, $3)`, [w.club, `R9 ${crypto.randomBytes(2).toString("hex")}`, createdBy]));
  const MSG = /permission role: the acting user may not write this role/;
  await refused(insert(w.admin, w.other), "42501", MSG);
  await refused(insert(otherAdmin, otherAdmin), "42501", MSG);
  await refused(insert(w.coach, w.coach), "42501", MSG);
  await refused(insert(inactive, inactive), "42501", MSG);
  // A system role by a club's admin.
  await refused(asActor(db.url, w.admin, (c) => c.query(`insert into public.permission_roles (owner_scope, name, assignable_club, created_by_user_id) values ('system', 'Sys9', true, $1)`, [w.admin])), "42501", MSG);
});

test("10. every immutable column of a role, a skipped revision, the Platform admin row, an archived role, un-archive, an archive while an active assignment exists (and it passes once revoked or lapsed)", async () => {
  const w = await world();
  const role = await clubRole(w.admin, w.club, { items: ["org.view"] });
  const NOT_ALLOWED = /permission role: this change is not allowed/;
  const update = (actor, sql, params = []) => asActor(db.url, actor, (c) => c.query(sql, params), { rollback: true });
  // Each immutable column: refused (by the guard, or first by a CHECK that ties it to another column).
  for (const [col, value] of [["owner_scope", "'system'"], ["owner_club_id", "null"], ["is_basic", "true"], ["created_by_user_id", `'${w.pa}'`], ["copied_from_role_id", `'${ROLE_IDS.team_coach}'`], ["copied_from_revision", "1"], ["created_at", "now() - interval '1 day'"], ["id", "gen_random_uuid()"]]) {
    await assert.rejects(update(w.admin, `update public.permission_roles set revision = revision + 1, ${col} = ${value} where id = $1`, [role]), (e) => e.code === "23514", col);
  }
  await refused(update(w.admin, `update public.permission_roles set revision = revision + 1, created_by_user_id = $2 where id = $1`, [role, w.pa]), "23514", NOT_ALLOWED);
  await refused(update(w.admin, `update public.permission_roles set revision = revision + 2 where id = $1`, [role]), "23514", NOT_ALLOWED);
  await refused(update(w.pa, `update public.permission_roles set revision = revision + 1, name = 'PA' where id = $1`, [ROLE_IDS.platform_admin]), "23514", NOT_ALLOWED);
  // An assignment of the role blocks its archive; revoked, it does not.
  const assignment = await assign(w.admin, { userId: w.other, roleId: role, scopeType: "club", scopeId: w.club, club: w.club });
  const archive = (actor) => asActor(db.url, actor, async (c) => {
    await c.query(`update public.permission_roles set revision = revision + 1, archived_at = now(), archived_by_user_id = $2 where id = $1`, [role, actor]);
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason) select id, revision, 'archive', $2, 'club_admin', 'Done' from public.permission_roles where id = $1`, [role, actor]);
  });
  await refused(archive(w.admin), "23514", /permission role: a role that is assigned cannot be archived/);
  await asActor(db.url, w.admin, async (c) => {
    await c.query(`update public.user_role_assignments set revoked_at = now(), revoked_by_user_id = $2, revoke_kind = 'revoked', revoke_reason = 'Done' where id = $1`, [assignment, w.admin]);
    await c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, assignment_id)
                   values (gen_random_uuid(), $1, 'assignment_revoke', repeat('b',64), 'club', $2, 'club_admin', $3)`, [w.admin, w.club, assignment]);
  });
  await archive(w.admin);
  // An archived role takes no change and is never un-archived.
  await refused(update(w.admin, `update public.permission_roles set revision = revision + 1, name = 'Again' where id = $1`, [role]), "23514", NOT_ALLOWED);
  await refused(update(w.admin, `update public.permission_roles set revision = revision + 1, archived_at = null, archived_by_user_id = null where id = $1`, [role]), "23514", NOT_ALLOWED);
  // A lapsed assignment does not block an archive (D4).
  const role2 = await clubRole(w.admin, w.club);
  const lapsing = await assign(w.admin, { userId: w.other, roleId: role2, scopeType: "club", scopeId: w.club, club: w.club, expiresAt: new Date(Date.now() + 1500).toISOString() });
  assert.ok(lapsing);
  await new Promise((r) => setTimeout(r, 1700));
  await asActor(db.url, w.admin, async (c) => {
    await c.query(`update public.permission_roles set revision = revision + 1, archived_at = now(), archived_by_user_id = $2 where id = $1`, [role2, w.admin]);
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason) select id, revision, 'archive', $2, 'club_admin', 'Done' from public.permission_roles where id = $1`, [role2, w.admin]);
  });
  // Roles are never deleted.
  await refused(k.query(`delete from public.permission_roles where id = $1`, [role]), "23514", /permission role: roles are archived, never deleted/);
  await refused(k.query(`truncate public.permission_roles cascade`), "23514", /permission role: roles are archived, never deleted/);
});

test("11. items: a platform-only word; each system-role-only word in a club's role and in another system role; an unhonoured word in a basic, a system and a club's role; a scope mismatch; an item without the role's update in the same transaction; an item written inside a savepoint; a non-basic role assignable for private", async () => {
  const w = await world();
  const role = await clubRole(w.admin, w.club, { items: [] });
  const sysRole = await asActor(db.url, w.pa, async (c) => {
    const id = (await c.query(`insert into public.permission_roles (owner_scope, name, assignable_club, assignable_team, created_by_user_id) values ('system', $1, true, true, $2) returning id`, [`Sys ${crypto.randomBytes(2).toString("hex")}`, w.pa])).rows[0].id;
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis) values ($1, 1, 'create', $2, 'platform_admin')`, [id, w.pa]);
    return id;
  });
  const addItem = (actor, roleId, word) => asActor(db.url, actor, async (c) => {
    await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [roleId]);
    await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, $2, $3)`, [roleId, word, actor]);
  }, { rollback: true });
  await refused(addItem(w.admin, role, "platform.admin"), "23514", /permission role item: a platform-only permission belongs to no role/);
  for (const word of ["accounts.manage", "staff.assign", "roles.manage"]) {
    await refused(addItem(w.admin, role, word), "23514", /permission role item: this permission exists only in the Club admin role/);
    await refused(addItem(w.pa, sysRole, word), "23514", /permission role item: this permission exists only in the Club admin role/);
    await refused(addItem(w.pa, ROLE_IDS.team_coach, word), "23514", /permission role item: this permission exists only in the Club admin role/);
  }
  for (const [actor, roleId] of [[w.pa, ROLE_IDS.club_admin], [w.pa, sysRole], [w.admin, role]]) {
    await refused(addItem(actor, roleId, "programs.view"), "23514", /permission role item: no route checks this permission yet/);
  }
  // org.teams.manage is club-only; the role is assignable for a team too.
  await refused(addItem(w.admin, role, "org.teams.manage"), "23514", /permission role item: the permission does not cover the role's scope types/);
  // Without the role's update in the same transaction.
  await refused(asActor(db.url, w.admin, (c) => c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, 'org.view', $2)`, [role, w.admin])), "42501", /permission role item: the acting user may not write this role/);
  // Inside a savepoint: the role row carries the subtransaction's id.
  await refused(asActor(db.url, w.admin, async (c) => {
    await c.query("savepoint s");
    await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [role]);
    await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, 'org.view', $2)`, [role, w.admin]);
  }), "42501", /permission role item: the acting user may not write this role/);
  // A non-basic role assignable for a private workspace.
  await refused(asActor(db.url, w.pa, (c) => c.query(`insert into public.permission_roles (owner_scope, name, assignable_private, created_by_user_id) values ('system', 'Private11', true, $1)`, [w.pa])), "23514", /permission role: this change is not allowed/);
});

test("12. rule 7: removing staff.assign, then roles.manage, from Club admin; a word removed from Club admin while Team coach holds it; read from the catalog, not from assignable_*; fired by an archive too; accounts.manage is not required and not seeded", async () => {
  const w = await world();
  const removeFromClubAdmin = (word) => asActor(db.url, w.pa, async (c) => {
    await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [ROLE_IDS.club_admin]);
    await c.query(`delete from public.permission_role_items where role_id = $1 and permission_word = $2`, [ROLE_IDS.club_admin, word]);
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason, items_removed)
                   select id, revision, 'change', $2, 'platform_admin', 'Rule 7', array[$3] from public.permission_roles where id = $1`, [ROLE_IDS.club_admin, w.pa, word]);
  }, { rollback: false });
  await refused(removeFromClubAdmin("staff.assign"), "23514", /permission role item: the Club admin role must hold this permission/);
  await refused(removeFromClubAdmin("roles.manage"), "23514", /permission role item: the Club admin role must hold this permission/);
  // athletes.manage is held by Team coach (assignable for a team only): the catalog says the word has a club scope, so Club admin must keep it.
  await refused(removeFromClubAdmin("athletes.manage"), "23514", /permission role item: a system role holds a permission the Club admin role lacks/);
  // org.club.edit is held by no other system role: removing it from Club admin passes.
  await removeFromClubAdmin("org.club.edit");
  const items = (await k.query(`select permission_word from public.permission_role_items where role_id = $1 order by 1`, [ROLE_IDS.club_admin])).rows.map((r) => r.permission_word);
  assert.ok(!items.includes("accounts.manage"), "accounts.manage is not seeded");
  // Put it back (a system role made later could otherwise not hold it).
  await asActor(db.url, w.pa, async (c) => {
    await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [ROLE_IDS.club_admin]);
    await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, 'org.club.edit', $2)`, [ROLE_IDS.club_admin, w.pa]);
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason, items_added)
                   select id, revision, 'change', $2, 'platform_admin', 'Back', array['org.club.edit'] from public.permission_roles where id = $1`, [ROLE_IDS.club_admin, w.pa]);
  });
});

test("13. a role or item write without its change row fails at COMMIT; a change row that disagrees with the items fails at COMMIT", async () => {
  const w = await world();
  const role = await clubRole(w.admin, w.club);
  await refused(asActor(db.url, w.admin, (c) => c.query(`update public.permission_roles set revision = revision + 1, name = 'No record' where id = $1`, [role])), "23514", /permission role: the change has no change record/);
  await refused(asActor(db.url, w.admin, async (c) => {
    await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [role]);
    await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, 'athletes.manage', $2)`, [role, w.admin]);
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason, items_added)
                   select id, revision, 'change', $2, 'club_admin', 'Wrong', array['athletes.remove'] from public.permission_roles where id = $1`, [role, w.admin]);
  }), "23514", /permission role change: the record must follow its own change in the same transaction/);
});

test("14. assignments: each refusal of contract 2.7 (one case per row); the UPDATE rule; 'replaced' refused by the CHECK; an expired stamp with its replacing row passes without its own request record, alone it fails at COMMIT", async () => {
  const w = await world();
  const role = await clubRole(w.admin, w.club, { items: ["org.view"] });
  const insert = (actor, row) => asActor(db.url, actor, async (c) => {
    const id = (await c.query(`insert into public.user_role_assignments (user_id, role_id, scope_type, scope_id, granted_by_user_id, grant_basis, grant_reason)
                               values ($1, $2, $3, $4, $5, $6, 'Needed') returning id`, [row.userId ?? w.other, row.roleId ?? role, row.scopeType ?? "club", row.scopeId ?? w.club, row.grantedBy ?? actor, row.basis ?? "club_admin"])).rows[0].id;
    await c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, assignment_id)
                   values (gen_random_uuid(), $1, 'assignment_grant', repeat('c',64), 'club', $2, $3, $4)`, [actor, w.club, row.basis ?? "club_admin", id]);
    return id;
  });
  await refused(insert(w.admin, { grantedBy: w.pa }), "42501", /role assignment: the row names another user than the acting user/);
  await refused(insert(w.coach, {}), "42501", /role assignment: the acting user may not assign roles here/);
  await refused(insert(w.admin, { basis: "platform_admin" }), "42501", /role assignment: the acting user may not assign roles here/);
  // Ceiling and dominance: a role holding a word the admin lacks (the platform admin removed org.club.edit from Club admin? no - a role with athletes.remove the admin holds; make one with a word Club admin does not hold).
  const paRole = await asActor(db.url, w.pa, async (c) => {
    const id = (await c.query(`insert into public.permission_roles (owner_scope, owner_club_id, name, assignable_club, created_by_user_id) values ('club', $1, $2, true, $3) returning id`, [w.club, `PA role ${crypto.randomBytes(2).toString("hex")}`, w.pa])).rows[0].id;
    await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, 'org.view', $2)`, [id, w.pa]);
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, items_added) values ($1, 1, 'create', $2, 'platform_admin', array['org.view'])`, [id, w.pa]);
    return id;
  });
  // Take org.view out of Club admin's reach for this admin: the admin's club role is fine, so make a second admin whose answer lacks the word - a coach's team scope cannot assign. Dominance is shown through a team assignment by an admin of another club below.
  assert.ok(paRole);
  await refused(insert(w.admin, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.team }), "23514", /role assignment: this role is not assigned here/);
  await refused(insert(w.pa, { scopeType: "global", scopeId: NIL, basis: "platform_admin" }), "23514", /role assignment: this role is not assigned here/);
  await refused(insert(w.pa, { scopeType: "private", scopeId: w.other, basis: "platform_admin" }), "23514", /role assignment: this role is not assigned here/);
  const clubOnly = await clubRole(w.admin, w.club, { items: ["org.view"], team_: false });
  await refused(insert(w.admin, { roleId: clubOnly, scopeType: "team", scopeId: w.team }), "23514", /role assignment: the role cannot be assigned for this scope/);
  const otherClub = await F.club();
  const otherAdmin = await F.user("oa"); await F.grantClub(otherAdmin, otherClub);
  await refused(asActor(db.url, otherAdmin, (c) => c.query(`insert into public.user_role_assignments (user_id, role_id, scope_type, scope_id, granted_by_user_id, grant_basis, grant_reason)
       values ($1, $2, 'club', $3, $4, 'club_admin', 'x')`, [w.other, role, otherClub, otherAdmin])), "23514", /role assignment: the role cannot be assigned for this scope/);
  const inactive = await F.user("inactive"); await k.query(`update public.users set is_active = false where id = $1`, [inactive]);
  await refused(insert(w.admin, { userId: inactive }), "23514", /role assignment: the user or the scope takes no assignment/);
  await refused(insert(w.admin, { userId: w.admin }), "23514", /role assignment: nobody assigns a role to themselves/);
  // Dominance: an admin of club B who does not hold athletes.remove there... every Club admin holds it; so a coach-made role is impossible. The service suite covers role_exceeds_your_permissions; here the database refusal: Club admin loses org.club.edit while a club's role holds it.
  const editRole = await clubRole(w.admin, w.club, { items: ["org.club.edit"], team_: false });
  await asActor(db.url, w.pa, async (c) => {
    await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [ROLE_IDS.club_admin]);
    await c.query(`delete from public.permission_role_items where role_id = $1 and permission_word = 'org.club.edit'`, [ROLE_IDS.club_admin]);
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason, items_removed)
                   select id, revision, 'change', $2, 'platform_admin', 'Dominance', array['org.club.edit'] from public.permission_roles where id = $1`, [ROLE_IDS.club_admin, w.pa]);
  });
  try {
    await refused(insert(w.admin, { roleId: editRole }), "42501", /role assignment: the acting user does not hold every permission of this role/);
  } finally {
    await asActor(db.url, w.pa, async (c) => {
      await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [ROLE_IDS.club_admin]);
      await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, 'org.club.edit', $2)`, [ROLE_IDS.club_admin, w.pa]);
      await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason, items_added)
                     select id, revision, 'change', $2, 'platform_admin', 'Back', array['org.club.edit'] from public.permission_roles where id = $1`, [ROLE_IDS.club_admin, w.pa]);
    });
  }
  // The UPDATE rule.
  const a = await insert(w.admin, {});
  await refused(asActor(db.url, w.admin, (c) => c.query(`update public.user_role_assignments set display_title = 'x' where id = $1`, [a])), "23514", /role assignment: only a revocation may change the row/);
  await refused(asActor(db.url, w.coach, (c) => c.query(`update public.user_role_assignments set revoked_at = now(), revoked_by_user_id = $2, revoke_kind = 'revoked', revoke_reason = 'x' where id = $1`, [a, w.coach])), "42501", /role assignment: the acting user may not revoke this assignment/);
  await assert.rejects(asActor(db.url, w.admin, (c) => c.query(`update public.user_role_assignments set revoked_at = now(), revoked_by_user_id = $2, revoke_kind = 'replaced', revoke_reason = 'x' where id = $1`, [a, w.admin])), (e) => e.code === "23514");
  // A revocation without its request record fails at COMMIT.
  await refused(asActor(db.url, w.admin, (c) => c.query(`update public.user_role_assignments set revoked_at = now(), revoked_by_user_id = $2, revoke_kind = 'revoked', revoke_reason = 'x' where id = $1`, [a, w.admin])), "23514", /role assignment: the write has no request record/);
  // Deleted never.
  await refused(k.query(`delete from public.user_role_assignments where id = $1`, [a]), "23514", /role assignment: assignments are revoked, never deleted/);
  // D4: an expired stamp with its replacing row passes without a request record of its own; alone it fails.
  const lapsing = await asActor(db.url, w.admin, async (c) => {
    const id = (await c.query(`insert into public.user_role_assignments (user_id, role_id, scope_type, scope_id, granted_by_user_id, grant_basis, grant_reason, expires_at)
                               values ($1, $2, 'team', $3, $4, 'club_admin', 'Short', now() + interval '1 second') returning id`, [w.other, role, w.team, w.admin])).rows[0].id;
    await c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, assignment_id)
                   values (gen_random_uuid(), $1, 'assignment_grant', repeat('d',64), 'club', $2, 'club_admin', $3)`, [w.admin, w.club, id]);
    return id;
  });
  await new Promise((r) => setTimeout(r, 1200));
  await refused(asActor(db.url, w.admin, (c) => c.query(`update public.user_role_assignments set revoked_at = now(), revoked_by_user_id = $2, revoke_kind = 'expired' where id = $1`, [lapsing, w.admin])), "23514", /role assignment: the write has no request record/);
  await asActor(db.url, w.admin, async (c) => {
    await c.query(`update public.user_role_assignments set revoked_at = now(), revoked_by_user_id = $2, revoke_kind = 'expired' where id = $1`, [lapsing, w.admin]);
    const id = (await c.query(`insert into public.user_role_assignments (user_id, role_id, scope_type, scope_id, granted_by_user_id, grant_basis, grant_reason)
                               values ($1, $2, 'team', $3, $4, 'club_admin', 'Again') returning id`, [w.other, role, w.team, w.admin])).rows[0].id;
    await c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, assignment_id)
                   values (gen_random_uuid(), $1, 'assignment_grant', repeat('e',64), 'club', $2, 'club_admin', $3)`, [w.admin, w.club, id]);
  });
  // An expired stamp on a row that has not lapsed is refused.
  const live = await insert(w.admin, { scopeType: "team", scopeId: w.team, roleId: clubOnly === role ? role : (await clubRole(w.admin, w.club)) });
  await refused(asActor(db.url, w.admin, (c) => c.query(`update public.user_role_assignments set revoked_at = now(), revoked_by_user_id = $2, revoke_kind = 'expired' where id = $1`, [live, w.admin])), "23514", /role assignment: only a revocation may change the row/);
});

test("15. append-only: UPDATE, DELETE and TRUNCATE of the change record and the request record", async () => {
  const w = await world();
  await clubRole(w.admin, w.club);
  await refused(k.query(`update public.permission_role_changes set reason = 'x'`), "23514", /permission role change: the record is append-only/);
  await refused(k.query(`delete from public.permission_role_changes`), "23514", /permission role change: the record is append-only/);
  await refused(k.query(`truncate public.permission_role_changes cascade`), "23514", /permission role change: the record is append-only/);
  const role = await clubRole(w.admin, w.club);
  await assign(w.admin, { userId: w.other, roleId: role, scopeType: "club", scopeId: w.club, club: w.club });
  await refused(k.query(`update public.permission_requests set request_hash = repeat('f', 64)`), "23514", /permission request: the record is append-only/);
  await refused(k.query(`delete from public.permission_requests`), "23514", /permission request: the record is append-only/);
  await refused(k.query(`truncate public.permission_requests cascade`), "23514", /permission request: the record is append-only/);
});

test("16. a multi-row VALUES, an INSERT ... SELECT and a data-modifying CTE cannot write two change rows, or two request rows, for one operation", async () => {
  const w = await world();
  const role = await clubRole(w.admin, w.club);
  const twoChanges = [
    `insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason, name_before, name_after)
       select $1, revision, 'change', $2::uuid, 'club_admin', 'x', 'a', 'b' from public.permission_roles where id = $1
       union all select $1, revision, 'change', $2::uuid, 'club_admin', 'y', 'a', 'c' from public.permission_roles where id = $1`,
    `with a as (insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason, name_before, name_after)
        select $1, revision, 'change', $2::uuid, 'club_admin', 'x', 'a', 'b' from public.permission_roles where id = $1 returning id)
     insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason, name_before, name_after)
        select $1, revision, 'change', $2::uuid, 'club_admin', 'y', 'a', 'c' from public.permission_roles where id = $1`,
  ];
  for (const sql of twoChanges) {
    await assert.rejects(asActor(db.url, w.admin, async (c) => {
      await c.query(`update public.permission_roles set revision = revision + 1, name = name || '!' where id = $1`, [role]);
      await c.query(sql, [role, w.admin]);
    }), (e) => e.code === "23505" && e.constraint === "permission_role_changes_revision_key");
  }
  await assert.rejects(asActor(db.url, w.admin, async (c) => {
    const a = (await c.query(`insert into public.user_role_assignments (user_id, role_id, scope_type, scope_id, granted_by_user_id, grant_basis, grant_reason)
        values ($1, $2, 'club', $3, $4, 'club_admin', 'x') returning id`, [w.other, role, w.club, w.admin])).rows[0].id;
    await c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, assignment_id)
                   values (gen_random_uuid(), $1, 'assignment_grant', repeat('a',64), 'club', $2, 'club_admin', $3),
                          (gen_random_uuid(), $1, 'assignment_grant', repeat('b',64), 'club', $2, 'club_admin', $3)`, [w.admin, w.club, a]);
  }), (e) => e.code === "23505" && e.constraint === "permission_requests_assignment_operation_key");
});

test("10b. a scope type removed from a role that was assigned (the role's own row): 23514", async () => {
  const w = await world();
  const role = await clubRole(w.admin, w.club, { items: ["org.view"] });
  await assign(w.admin, { userId: w.other, roleId: role, scopeType: "club", scopeId: w.club, club: w.club });
  await refused(asActor(db.url, w.admin, async (c) => {
    await c.query(`update public.permission_roles set revision = revision + 1, assignable_team = false where id = $1`, [role]);
  }, { rollback: true }), "23514", /permission role: a scope type cannot be removed once the role was assigned/);
});

test("11b. ceiling and dominance in the database: a club's admin adds a word it does not hold; edits a role that holds a word it lacks (42501)", async () => {
  const w = await world();
  const paRole = await asActor(db.url, w.pa, async (c) => {
    const id = (await c.query(`insert into public.permission_roles (owner_scope, owner_club_id, name, assignable_club, created_by_user_id) values ('club', $1, $2, true, $3) returning id`, [w.club, `Dom ${crypto.randomBytes(2).toString("hex")}`, w.pa])).rows[0].id;
    await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, 'org.club.edit', $2)`, [id, w.pa]);
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, items_added) values ($1, 1, 'create', $2, 'platform_admin', array['org.club.edit'])`, [id, w.pa]);
    return id;
  });
  const own = await clubRole(w.admin, w.club, { items: ["org.view"], team_: false });
  const setClubAdmin = async (add) => asActor(db.url, w.pa, async (c) => {
    await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [ROLE_IDS.club_admin]);
    if (add) await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, 'org.club.edit', $2)`, [ROLE_IDS.club_admin, w.pa]);
    else await c.query(`delete from public.permission_role_items where role_id = $1 and permission_word = 'org.club.edit'`, [ROLE_IDS.club_admin]);
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason, items_added, items_removed)
                   select id, revision, 'change', $2, 'platform_admin', 'Ceiling', $3, $4 from public.permission_roles where id = $1`,
    [ROLE_IDS.club_admin, w.pa, add ? ["org.club.edit"] : [], add ? [] : ["org.club.edit"]]);
  });
  await setClubAdmin(false);
  try {
    await refused(asActor(db.url, w.admin, async (c) => {
      await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [own]);
      await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, 'org.club.edit', $2)`, [own, w.admin]);
    }, { rollback: true }), "42501", /permission role item: the acting user does not hold this permission/);
    await refused(asActor(db.url, w.admin, async (c) => {
      await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [paRole]);
      await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, 'org.view', $2)`, [paRole, w.admin]);
    }, { rollback: true }), "42501", /permission role item: the acting user does not hold every permission of this role/);
  } finally {
    await setClubAdmin(true);
  }
});

test("15b. the request record: it names its acting user and the basis the database derives (42501), and follows its own operation in the same transaction (23514)", async () => {
  const w = await world();
  const role = await clubRole(w.admin, w.club);
  const a = await assign(w.admin, { userId: w.other, roleId: role, scopeType: "club", scopeId: w.club, club: w.club });
  const request = (actor, { by = actor, basis = "club_admin", assignment = a } = {}) => asActor(db.url, actor, (c) => c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, assignment_id)
      values (gen_random_uuid(), $1, 'assignment_revoke', repeat('9',64), 'club', $2, $3, $4)`, [by, w.club, basis, assignment]), { rollback: true });
  await refused(request(w.admin, { by: w.pa }), "42501", /permission request: the acting user may not write this request/);
  await refused(request(w.admin, { basis: "platform_admin" }), "42501", /permission request: the acting user may not write this request/);
  await refused(request(w.coach), "42501", /permission request: the acting user may not write this request/);
  await refused(request(w.admin), "23514", /permission request: the request must follow its own operation in the same transaction/);
});
