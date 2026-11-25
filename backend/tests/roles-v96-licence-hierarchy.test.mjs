// Roles v96, the licence hierarchy (P-4; docs/runbooks/roles-licence-hierarchy-v96.md; docs/ai/roles-v-steps-plan.md
// 12.1): Training Load is the parent of Dashboards, Imports and Data configuration. A closed parent closes its children
// for the club; a child can still be closed on its own; the stored ceiling rows are never rewritten.
//   0. the JavaScript twin (MODULE_PARENTS, effectiveClosedModules) equals the database's for every module and every
//      combination of the four stored rows;
//   1. the migration's round trip (sha256, md5, privileges, rollback, re-apply, refusals);
//   2. the twin of can() and can() itself agree: with Training Load closed a child word is refused at club and team
//      scope, the parent's own words too; a child closed alone leaves the parent open; a platform admin is unchanged;
//   3. the owner's production shape (the four rows stored): unchanged by v96; reopening the parent keeps the children
//      closed on their own;
//   4. rule 7 and R2's dominance read the effective ceiling (looser with the parent closed), and the stricter half;
//   5. the API: the licence view's parent / closedByParent / effectivelyClosed, the writer storing only what it is
//      asked to, /me's closed modules, and Data configuration closed for the club's admin with the parent.
// Disposable database built from the legacy snapshot and the real runner.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { runMigrations } from "../src/migrate.js";
import { MODULE_PARENTS, effectiveClosedModules } from "../src/permissionModules.js";
import { asActor, buildDatabase, fixtures, key, MIGRATIONS, RUNBOOKS, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

const V96_FILE = "202611281000_roles_v96_licence_hierarchy.sql";
const V96_NAME = `migrations_v2/${V96_FILE}`;
const BEFORE_MD5 = {
  user_has_permission: "3ee2c276f7caf9fb50066aa753e7c079",
  permission_club_rule7_ok: "0f97c7a6c365e73e19c649bfe1a304b5",
  permission_actor_holds_in_club: "da8b90ab31b0a96d13e8d263d7b42770",
};
const V96_MD5 = {
  user_has_permission: "6f3ae322a169fe73fb1dcb336e1b768d",
  permission_club_rule7_ok: "73f962702edc2c76f276f3f3501c3aad",
  permission_actor_holds_in_club: "0a2cfed0d1a498d9b214be799add36f3",
  permission_club_module_closed: "1ddbaf5d0eca6e9ec8656cd9fb43067c",
  permission_module_parent: "103605328dfc0a41c773939889db97f9",
};
const FAMILY = ["training_load", "dashboards", "imports", "data_configuration"];

let db, k, F, app;
before(async () => {
  db = await buildDatabase({ label: "v96", upTo: "all" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
  // First, so that the app's own pool (db.js, read by authz.js in test 2) talks to this database.
  app = await startServer(db.url);
});
after(async () => {
  await app?.stop();
  await k?.end().catch(() => {});
  await db?.drop();
});

const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
async function refused(promise, code) {
  await assert.rejects(promise, (e) => { assert.equal(e.code, code, `SQLSTATE ${e.code} (${e.message})`); return true; });
}
const md5s = async () => Object.fromEntries((await k.query(`select proname, md5(prosrc) as m from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)`,
  [Object.keys(V96_MD5)])).rows.map((r) => [r.proname, r.m]));
const twin = async (u, w, t, id) => (await one(`select public.user_has_permission($1, $2, $3, $4) as ok`, [u, w, t, id])).ok;
const holdsInClub = async (u, w, club) => (await one(`select public.permission_actor_holds_in_club($1, $2, $3) as ok`, [u, w, club])).ok;
const asLocked = (actor, clubs, mode, fn) => asActor(db.url, actor, async (c) => {
  await c.query(`select public.lock_club_ceiling($1::uuid[], $2)`, [clubs, mode]);
  return fn(c);
});
const basisOf = async (c, actor, word, club) => (await c.query(`select public.permission_actor_basis($1, $2, 'club', $3) as b`, [actor, word, club])).rows[0].b;

async function setModule(pa, club, module, action) {
  await asLocked(pa, [club], "exclusive", async (c) => {
    if (action === "close") await c.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, $2, $3, 'licence')`, [club, module, pa]);
    else await c.query(`delete from public.club_permission_ceiling where club_id = $1 and module_word = $2`, [club, module]);
    await c.query(`insert into public.club_permission_ceiling_changes (club_id, module_word, action, performed_by_user_id, reason) values ($1, $2, $3, $4, 'licence')`, [club, module, action, pa]);
  });
}
async function makeVersion(actor, club, roleId, { add = [], remove = [] } = {}) {
  return asLocked(actor, [club], "exclusive", async (c) => {
    const rev = (await c.query(`select revision from public.permission_roles where id = $1`, [roleId])).rows[0].revision;
    const id = (await c.query(`insert into public.permission_club_role_versions (club_id, system_role_id, based_on_revision, answered_revision, created_by_user_id)
        values ($1, $2, $3, $3, $4) returning id`, [club, roleId, rev, actor])).rows[0].id;
    const base = (await c.query(`select array(select permission_word from public.permission_role_items where role_id = $1) as w`, [roleId])).rows[0].w;
    const items = [...new Set([...base.filter((w) => !remove.includes(w)), ...add])];
    for (const w of items) await c.query(`insert into public.permission_club_role_version_items (version_id, permission_word) values ($1, $2)`, [id, w]);
    await c.query(`insert into public.permission_club_role_version_changes (version_id, revision_after, kind, performed_by_user_id, basis, reason, items_added)
        values ($1, 1, 'create', $2, $3, 'club change', $4)`, [id, actor, await basisOf(c, actor, "roles.manage", club), items]);
    return id;
  });
}
async function world() {
  const club = await F.club();
  const team = await F.team(club);
  const admin = await F.user("admin"); await F.grantClub(admin, club);
  const coach = await F.user("coach"); await F.grantTeam(coach, team);
  const pa = await F.user("pa"); await F.grantPlatform(pa);
  return { club, team, admin, coach, pa };
}

test("0. the JavaScript twin equals the database: the parent of every module, and the closed modules of every combination of the four stored rows", async () => {
  const modules = (await k.query(`select word, public.permission_module_parent(word) as parent from public.permission_modules order by word`)).rows;
  assert.ok(modules.length >= FAMILY.length);
  for (const m of modules) assert.equal(MODULE_PARENTS[m.word] ?? null, m.parent, `parent of ${m.word}`);
  assert.deepEqual(Object.keys(MODULE_PARENTS).sort(), ["dashboards", "data_configuration", "imports"]);
  // Every child and parent named by the hierarchy is a module of the catalog, and a parent is never itself a child.
  const words = new Set(modules.map((m) => m.word));
  for (const [child, parent] of Object.entries(MODULE_PARENTS)) {
    assert.ok(words.has(child), `${child} is in permission_modules`);
    assert.ok(words.has(parent), `${parent} is in permission_modules`);
    assert.equal(MODULE_PARENTS[parent], undefined, `${parent} has no parent (one level only)`);
  }
  const w = await world();
  let stored = [];
  for (let mask = 0; mask < 16; mask += 1) {
    const want = FAMILY.filter((_, i) => mask & (1 << i));
    for (const m of stored.filter((x) => !want.includes(x))) await setModule(w.pa, w.club, m, "open");
    for (const m of want.filter((x) => !stored.includes(x))) await setModule(w.pa, w.club, m, "close");
    stored = want;
    const sqlStored = (await one(`select public.permission_club_closed_modules($1) as m`, [w.club])).m;
    assert.deepEqual([...sqlStored].sort(), [...want].sort(), "the stored rows are exactly what was closed");
    const sqlClosed = (await k.query(`select word from public.permission_modules where public.permission_club_module_closed($1, word) order by word`, [w.club])).rows.map((r) => r.word);
    assert.deepEqual(effectiveClosedModules(sqlStored), sqlClosed, `combination ${want.join(",") || "(none)"}`);
  }
  for (const m of stored) await setModule(w.pa, w.club, m, "open");
  assert.equal(await one(`select public.permission_club_module_closed(null, 'dashboards') as x`).then((r) => r.x), false, "a null club has no ceiling");
});

test("1. the migration: v96 recorded with the file's sha256, the bodies v96's and not executable by PUBLIC; the rollback restores the bodies before it; re-applied; refused after a later migration and over a changed body", async () => {
  const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, V96_FILE))).digest("hex");
  assert.equal((await one(`select checksum from public.schema_migrations where migration_name = $1`, [V96_NAME])).checksum, sha);
  assert.deepEqual(await md5s(), V96_MD5);
  for (const f of ["permission_module_parent(text)", "permission_club_module_closed(uuid, text)"]) {
    assert.equal((await one(`select has_function_privilege('public', $1, 'execute') as x`, [`public.${f}`])).x, false, f);
  }
  const rollback = fs.readFileSync(path.join(RUNBOOKS, "roles-licence-hierarchy-v96-rollback.sql"), "utf8");
  const w = await world();
  await setModule(w.pa, w.club, "training_load", "close");
  assert.equal(await twin(w.admin, "variables.view", "club", w.club), false, "v96: the child is closed with its parent");
  await k.query(rollback);
  assert.deepEqual(await md5s(), BEFORE_MD5);
  assert.equal((await one(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V96_NAME])).n, 0);
  assert.equal(await twin(w.admin, "variables.view", "club", w.club), true, "before v96 the child stayed open");
  await runMigrations({ databaseUrl: db.url, migrationsRoot: MIGRATIONS });
  assert.deepEqual(await md5s(), V96_MD5);
  assert.equal(await twin(w.admin, "variables.view", "club", w.club), false);
  // A later migration recorded: refused, nothing changed.
  await k.query(`insert into public.schema_migrations (migration_name, checksum, applied_at, runner_version)
    values ('migrations_v2/209912310000_later.sql', repeat('a', 64), now() + interval '1 hour', 'test')`);
  try {
    await refused(k.query(rollback), "23514");
    await k.query("rollback").catch(() => {});
  } finally {
    await k.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/209912310000_later.sql'`);
  }
  assert.deepEqual(await md5s(), V96_MD5);
  // A body that is not v96's: refused.
  await k.query(`create or replace function public.permission_module_parent(p_module text) returns text
    language sql immutable set search_path = pg_catalog, public as $$ select null::text $$`);
  await refused(k.query(rollback), "23514");
  await k.query("rollback").catch(() => {});
  const parent = fs.readFileSync(path.join(MIGRATIONS, V96_FILE), "utf8").match(/create function public\.permission_module_parent[\s\S]*?\n {2}\$\$;/)[0];
  await k.query(parent.replace("create function", "create or replace function"));
  assert.deepEqual(await md5s(), V96_MD5);
  await setModule(w.pa, w.club, "training_load", "open");
});

test("1b. the migration refuses, changing nothing, when a body it replaces is not the one it expects", async () => {
  const pre = await buildDatabase({ label: "v96_refuse", upTo: "all", skip: [V96_FILE] });
  const c = new pg.Client({ connectionString: pre.url });
  await c.connect();
  try {
    await c.query(`create or replace function public.permission_club_rule7_ok(p_club uuid) returns boolean
      language sql stable set search_path = pg_catalog, public as $$ select true $$`);
    await assert.rejects(runMigrations({ databaseUrl: pre.url, migrationsRoot: MIGRATIONS }), /roles_v96_licence_hierarchy\.sql" \(SQLSTATE 23514\)/);
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V96_NAME])).rows[0].n, 0);
    assert.equal((await c.query(`select to_regprocedure('public.permission_module_parent(text)') is null as x`)).rows[0].x, true);
  } finally {
    await c.end().catch(() => {});
    await pre.drop();
  }
});

test("2. the twin and can() agree: Training Load closed closes its children at club and team scope; a child closed alone leaves the parent; a platform admin is never limited", async () => {
  const w = await world();
  const { loadAuthorizationContext } = await import("../src/authz.js");
  const { can } = await import("../src/permissions.js");
  const words = ["load.view.team", "load.view.athlete", "variables.view", "dashboards.view", "calendar.view", "presets.use"];
  const check = async (label, expected) => {
    for (const [user, scopeType, scopeId] of [[w.admin, "club", w.club], [w.admin, "team", w.team], [w.coach, "team", w.team]]) {
      const authz = await loadAuthorizationContext({ id: user });
      for (const word of words) {
        const sql = await twin(user, word, scopeType, scopeId);
        const js = can(authz, word, { type: scopeType, id: scopeId });
        assert.equal(js, sql, `${label}: can() and the twin, ${word} at ${scopeType}`);
        assert.equal(sql, expected[word], `${label}: ${word} at ${scopeType}`);
      }
    }
    for (const word of words) assert.equal(await twin(w.pa, word, "club", w.club), true, `${label}: platform admin, ${word}`);
  };
  const open = Object.fromEntries(words.map((x) => [x, true]));
  await check("all open", open);
  await setModule(w.pa, w.club, "training_load", "close");
  await check("Training Load closed", { ...open, "load.view.team": false, "load.view.athlete": false, "variables.view": false, "dashboards.view": false });
  await setModule(w.pa, w.club, "training_load", "open");
  await setModule(w.pa, w.club, "data_configuration", "close");
  await check("Data configuration closed alone", { ...open, "variables.view": false });
  await setModule(w.pa, w.club, "data_configuration", "open");
  await check("all open again", open);
});

test("3. the owner's production shape (Training Load and its three children stored as closed): unchanged by v96; reopening the parent keeps the children closed on their own", async () => {
  const w = await world();
  for (const m of FAMILY) await setModule(w.pa, w.club, m, "close");
  assert.deepEqual([...(await one(`select public.permission_club_closed_modules($1) as m`, [w.club])).m].sort(), [...FAMILY].sort());
  for (const word of ["load.view.team", "variables.view", "dashboards.view"]) assert.equal(await twin(w.admin, word, "club", w.club), false, word);
  await setModule(w.pa, w.club, "training_load", "open");
  assert.equal(await twin(w.admin, "load.view.team", "club", w.club), true, "the parent's own words are back");
  assert.equal(await twin(w.admin, "variables.view", "club", w.club), false, "the child closed on its own stays closed");
  assert.equal(await twin(w.coach, "dashboards.view", "team", w.team), false);
  for (const m of ["dashboards", "imports", "data_configuration"]) await setModule(w.pa, w.club, m, "open");
  assert.equal(await twin(w.admin, "variables.view", "club", w.club), true);
});

test("4. rule 7 and R2's dominance read the effective ceiling: with Training Load closed a child word may leave Club admin and still be given by the club's admin; the stricter half holds", async () => {
  const w = await world();
  await setModule(w.pa, w.club, "training_load", "close");
  // Rule 7 leaves out an effectively closed module: a platform admin's Club admin version without variables.view,
  // while Team coach (default) carries it, passes only because data_configuration is closed through its parent.
  // Rule 7 still holds for a word that is NOT a child: a Club admin version without calendar.view (Team coach carries
  // it, Calendar is open) is refused, with only the parent's row stored.
  await refused(makeVersion(w.pa, w.club, ROLE_IDS.club_admin, { remove: ["calendar.view"] }), "23514");
  await makeVersion(w.pa, w.club, ROLE_IDS.club_admin, { remove: ["variables.view"] });
  // That Club admin version is allowed only by v96's rule 7 (Team coach, by default, still carries variables.view). The
  // rollback refuses (the bodies come back) rather than leave this club breaking v92's rule 7.
  const rollback = fs.readFileSync(path.join(RUNBOOKS, "roles-licence-hierarchy-v96-rollback.sql"), "utf8");
  await assert.rejects(k.query(rollback), (e) => e.code === "23514" && /a club breaks rule 7 without the hierarchy/.test(e.message));
  await k.query("rollback").catch(() => {});
  assert.deepEqual(await md5s(), V96_MD5, "nothing rolled back");
  assert.equal(await holdsInClub(w.admin, "variables.view", w.club), false, "the admin would not hold it when the parent opens");
  // The stricter half: the club's admin cannot give a closed child word it would not hold.
  await refused(makeVersion(w.admin, w.club, ROLE_IDS.team_coach, { remove: ["athletes.remove"] }), "42501");
  // Without it in the set, the same write passes (the other closed words, load.view.*, are held through the parent).
  assert.equal(await holdsInClub(w.admin, "load.view.team", w.club), true);
  await makeVersion(w.admin, w.club, ROLE_IDS.team_coach, { remove: ["athletes.remove", "variables.view"] });
});

test("4b. before v96 (its bodies rolled back) the same Club admin version is refused by rule 7: the child stayed open", async () => {
  const pre = await buildDatabase({ label: "v96_rule7", upTo: "all", skip: [V96_FILE] });
  const c = new pg.Client({ connectionString: pre.url });
  await c.connect();
  try {
    const G = fixtures(c);
    const club = await G.club();
    const pa = await G.user("pa"); await G.grantPlatform(pa);
    const locked = (fn) => asActor(pre.url, pa, async (x) => { await x.query(`select public.lock_club_ceiling($1::uuid[], 'exclusive')`, [[club]]); return fn(x); });
    await locked(async (x) => {
      await x.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, 'training_load', $2, 'licence')`, [club, pa]);
      await x.query(`insert into public.club_permission_ceiling_changes (club_id, module_word, action, performed_by_user_id, reason) values ($1, 'training_load', 'close', $2, 'licence')`, [club, pa]);
    });
    await refused(locked(async (x) => {
      const rev = (await x.query(`select revision from public.permission_roles where id = $1`, [ROLE_IDS.club_admin])).rows[0].revision;
      const id = (await x.query(`insert into public.permission_club_role_versions (club_id, system_role_id, based_on_revision, answered_revision, created_by_user_id)
          values ($1, $2, $3, $3, $4) returning id`, [club, ROLE_IDS.club_admin, rev, pa])).rows[0].id;
      const items = (await x.query(`select array(select permission_word from public.permission_role_items where role_id = $1 and permission_word <> 'variables.view') as w`, [ROLE_IDS.club_admin])).rows[0].w;
      for (const word of items) await x.query(`insert into public.permission_club_role_version_items (version_id, permission_word) values ($1, $2)`, [id, word]);
      await x.query(`insert into public.permission_club_role_version_changes (version_id, revision_after, kind, performed_by_user_id, basis, reason, items_added)
          values ($1, 1, 'create', $2, 'platform_admin', 'club change', $3)`, [id, pa, items]);
      await x.query("set constraints all immediate");
    }), "23514");
  } finally {
    await c.end().catch(() => {});
    await pre.drop();
  }
});

test("5. the API: the licence view names each child's parent and whether it is closed through it; the writer stores only what it is asked; /me lists the effective closed modules; Data configuration answers the club's admin the identical 404 while its parent is closed", async () => {
  const w = await world();
  const pa = await app.cookieFor(w.pa);
  const admin = await app.cookieFor(w.admin);
  const base = `/api/organization/roles/clubs/${w.club}/ceiling`;
  const variables = "/api/training-load/sources/metrics/variables";
  assert.equal((await app.api(admin, variables)).status, 200, "open: the club admin reads Data configuration");
  const closed = await app.api(pa, base, { method: "POST", body: { requestKey: key(), close: ["training_load"], reason: "Licence test" } });
  assert.equal(closed.status, 200, closed.text);
  assert.deepEqual([...(await one(`select public.permission_club_closed_modules($1) as m`, [w.club])).m], ["training_load"], "only the asked row is stored");
  const view = (await app.api(pa, base)).body;
  const row = (m) => view.modules.find((x) => x.module === m);
  assert.deepEqual({ ...row("training_load"), closedAt: undefined, reason: undefined, closedBy: undefined, label: undefined },
    // ceilingEffective: no load.* word is checked until V-5b, but closing Training Load closes Data configuration
    // (variables.view is checked since V-1), so the parent's row follows the licence.
    { module: "training_load", closed: true, closedAt: undefined, ceilingEffective: true, parent: null, closedByParent: false, effectivelyClosed: true, reason: undefined, closedBy: undefined, label: undefined });
  for (const child of ["dashboards", "imports", "data_configuration"]) {
    assert.equal(row(child).parent, "training_load");
    assert.equal(row(child).closed, false, `${child}: no row of its own`);
    assert.equal(row(child).closedByParent, true);
    assert.equal(row(child).effectivelyClosed, true);
  }
  assert.equal(row("calendar").parent, null);
  assert.equal(row("calendar").effectivelyClosed, false);
  const me = (await app.api(admin, "/api/auth/me")).body.user;
  assert.equal(me.activeWorkspace?.type, "club");
  for (const m of FAMILY) assert.ok((me.closedModules || []).includes(m), `/me lists ${m}`);
  const refused404 = await app.api(admin, variables);
  const missing = await app.api(admin, `${variables}/${crypto.randomUUID()}`);
  assert.equal(refused404.status, 404);
  assert.deepEqual(refused404.body, missing.body, "the identical 404");
  // The club's roles read and the role writers use the effective set: the roles screen locks the children's words, and
  // a club version that adds a child word is refused as outside the licence (R4-3's closed_by_club_ceiling).
  const roles = await app.api(admin, `/api/organization/roles/clubs/${w.club}/roles`);
  assert.equal(roles.status, 200, roles.text);
  assert.deepEqual(roles.body.closedModules, [...FAMILY].sort());
  const coachVersion = await app.api(pa, `/api/organization/roles/${ROLE_IDS.team_coach}/clubs/${w.club}/version`, {
    method: "POST", body: { requestKey: key(), expectedRevision: null, remove: ["variables.view"], reason: "Licence test" },
  });
  assert.equal(coachVersion.status, 200, coachVersion.text);
  const addChild = await app.api(admin, `/api/organization/roles/${ROLE_IDS.team_coach}/clubs/${w.club}/version`, {
    method: "POST", body: { requestKey: key(), expectedRevision: coachVersion.body.version?.revision ?? 1, add: ["variables.view"], reason: "Licence test" },
  });
  assert.equal(addChild.status, 409, addChild.text);
  assert.equal(addChild.body.error, "closed_by_club_ceiling");
  // A child cannot be "opened" while it has no row: the writer answers that nothing changed.
  const noop = await app.api(pa, base, { method: "POST", body: { requestKey: key(), open: ["data_configuration"], reason: "Licence test" } });
  assert.equal(noop.status, 409);
  assert.equal(noop.body.code ?? noop.body.error, "ceiling_unchanged");
  const reopened = await app.api(pa, base, { method: "POST", body: { requestKey: key(), open: ["training_load"], reason: "Licence test" } });
  assert.equal(reopened.status, 200, reopened.text);
  assert.equal((await app.api(admin, variables)).status, 200, "reopened: Data configuration is back");
});

test("5b. putting Training Load back is refused cleanly (409 club_admin_would_lack, nothing changed) when the club's Club admin version dropped a child word while only the parent was closed", async () => {
  const w = await world();
  const pa = await app.cookieFor(w.pa);
  const base = `/api/organization/roles/clubs/${w.club}/ceiling`;
  const close = await app.api(pa, base, { method: "POST", body: { requestKey: key(), close: ["training_load"], reason: "Licence test" } });
  assert.equal(close.status, 200, close.text);
  // Rule 7 leaves Data configuration out while it is closed through its parent: the version passes.
  const version = await app.api(pa, `/api/organization/roles/${ROLE_IDS.club_admin}/clubs/${w.club}/version`, {
    method: "POST", body: { requestKey: key(), expectedRevision: null, remove: ["variables.view"], reason: "Licence test" },
  });
  assert.equal(version.status, 200, version.text);
  // Putting Training Load back makes variables.view live again while Team coach (default) carries it: refused at the
  // deferred rule 7, before the COMMIT, as a stable 409 - never a 500 or "outcome unknown".
  const reopen = await app.api(pa, base, { method: "POST", body: { requestKey: key(), open: ["training_load"], reason: "Licence test" } });
  assert.equal(reopen.status, 409, reopen.text);
  assert.equal(reopen.body.error, "club_admin_would_lack");
  assert.deepEqual([...(await one(`select public.permission_club_closed_modules($1) as m`, [w.club])).m], ["training_load"], "nothing changed");
  assert.equal((await one(`select count(*)::int as n from public.club_permission_ceiling_changes where club_id = $1`, [w.club])).n, 1, "no change row written");
});
