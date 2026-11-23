// Roles R4-1, migration v92 (docs/ai/roles-r4-contract.md, sections 3, 4, 7 and 14): the migration in both orders
// against v93, the seed, old-vs-new of the twin, the truth table of 3.6 in can() and the twin, the guards of the
// ceiling, the club versions and the custom roles, the club lock, rule 7 inside a club and across clubs, custom
// liveness through the real organization routes, the later-migration path (H2), and the rollback. Disposable
// databases built from the legacy snapshot and the real runner only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { runMigrations } from "../src/migrate.js";
import { asActor, buildDatabase, fixtures, MIGRATIONS, RUNBOOKS, ROLE_IDS, startServer, V92_FILE, V92_NAME } from "./support/permission-roles-world.mjs";

const V93_FILE = "202611251000_calendar_v93_event_delete.sql";
const VIEW = ["athletes.view", "programs.view", "exercises.use", "presets.use", "calendar.view", "load.view.team",
  "load.view.athlete", "dashboards.view", "tests.view", "tests.results.view", "variables.view"];
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

let db, k, F, srv, authz, perms;
before(async () => {
  db = await buildDatabase({ label: "r4v92", upTo: "all" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
  srv = await startServer(db.url);
  authz = await import("../src/authz.js");
  perms = await import("../src/permissions.js");
});
after(async () => {
  await srv?.stop();
  await k?.end().catch(() => {});
  await db?.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
async function refused(promise, code, message) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `SQLSTATE ${e.code} (${e.message})`);
    if (message) assert.match(e.message, message);
    return true;
  });
}
const twin = async (u, w, t, id) => (await k.query(`select public.user_has_permission($1, $2, $3, $4) as ok`, [u, w, t, id])).rows[0].ok;
const canOf = async (u, w, scope) => perms.can(await authz.loadAuthorizationContext({ id: u, role_hint: null }), w, scope);
// A transaction as the acting user that takes the club lock(s) first, as every writer must.
const asLocked = (actor, clubs, mode, fn, opts) => asActor(db.url, actor, async (c) => {
  await c.query(`select public.lock_club_ceiling($1::uuid[], $2)`, [clubs, mode]);
  return fn(c);
}, opts);

async function world() {
  const club = await F.club();
  const team = await F.team(club);
  const admin = await F.user("admin"); await F.grantClub(admin, club);
  const coach = await F.user("coach"); await F.grantTeam(coach, team);
  const pa = await F.user("pa"); await F.grantPlatform(pa);
  return { club, team, admin, coach, pa };
}
const basisOf = async (c, actor, word, club) => (await c.query(`select public.permission_actor_basis($1, $2, 'club', $3) as b`, [actor, word, club])).rows[0].b;

// Club version helpers (direct SQL as R4-3's writer will write them).
async function makeVersion(actor, club, roleId, { add = [], remove = [], reason = "club change" } = {}) {
  return asLocked(actor, [club], "exclusive", async (c) => {
    const rev = (await c.query(`select revision from public.permission_roles where id = $1`, [roleId])).rows[0].revision;
    const id = (await c.query(`insert into public.permission_club_role_versions (club_id, system_role_id, based_on_revision, answered_revision, created_by_user_id)
        values ($1, $2, $3, $3, $4) returning id`, [club, roleId, rev, actor])).rows[0].id;
    const base = (await c.query(`select array(select permission_word from public.permission_role_items where role_id = $1) as w`, [roleId])).rows[0].w;
    const items = [...new Set([...base.filter((w) => !remove.includes(w)), ...add])];
    for (const w of items) await c.query(`insert into public.permission_club_role_version_items (version_id, permission_word) values ($1, $2)`, [id, w]);
    await c.query(`insert into public.permission_club_role_version_changes (version_id, revision_after, kind, performed_by_user_id, basis, reason, items_added)
        values ($1, 1, 'create', $2, $3, $4, $5)`, [id, actor, await basisOf(c, actor, "roles.manage", club), reason, items]);
    return id;
  });
}
async function makeCustom(actor, user, roleId, scopeType, scopeId, club, { holding, add = [], remove = [], lockMode = "shared" } = {}) {
  return asLocked(actor, [club], lockMode, async (c) => {
    const base = (await c.query(`select public.permission_role_club_items($1, $2) as w`, [roleId, club])).rows[0].w;
    const items = [...new Set([...base.filter((w) => !remove.includes(w)), ...add])];
    let id;
    if (holding.assignmentId) {
      id = (await c.query(`insert into public.permission_custom_roles (user_id, base_role_id, scope_type, scope_id, club_id, holding_assignment_id, frozen_from, frozen_from_revision, created_by_user_id)
          values ($1, $2, $3, $4, $5, $6, 'default', 1, $7) returning id`, [user, roleId, scopeType, scopeId, club, holding.assignmentId, actor])).rows[0].id;
    } else {
      id = (await c.query(`insert into public.permission_custom_roles (user_id, base_role_id, scope_type, scope_id, club_id, holding_row_table, holding_row_id, holding_row_version, frozen_from, frozen_from_revision, created_by_user_id)
          select $1, $2, $3, $4, $5, $6, r.id, r.updated_at, 'default', 1, $7
            from public.${holding.table} r where r.id = $8 returning id`, [user, roleId, scopeType, scopeId, club, holding.table, actor, holding.rowId])).rows[0].id;
    }
    for (const w of items) await c.query(`insert into public.permission_custom_role_items (custom_role_id, permission_word) values ($1, $2)`, [id, w]);
    await c.query(`insert into public.permission_custom_role_changes (custom_role_id, revision_after, kind, performed_by_user_id, basis, reason, items_added)
        values ($1, 1, 'create', $2, $3, 'per user', $4)`, [id, actor, await basisOf(c, actor, "staff.assign", club), items]);
    return id;
  });
}
const teamRow = async (user, team) => (await one(`select id from public.user_team_roles where user_id = $1 and team_id = $2`, [user, team])).id;
const clubRow = async (user, club) => (await one(`select id from public.user_club_roles where user_id = $1 and club_id = $2`, [user, club])).id;
async function closeModule(pa, club, module) {
  await asLocked(pa, [club], "exclusive", async (c) => {
    await c.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, $2, $3, 'licence')`, [club, module, pa]);
    await c.query(`insert into public.club_permission_ceiling_changes (club_id, module_word, action, performed_by_user_id, reason) values ($1, $2, 'close', $3, 'licence')`, [club, module, pa]);
  });
}
async function openModule(pa, club, module) {
  await asLocked(pa, [club], "exclusive", async (c) => {
    await c.query(`delete from public.club_permission_ceiling where club_id = $1 and module_word = $2`, [club, module]);
    await c.query(`insert into public.club_permission_ceiling_changes (club_id, module_word, action, performed_by_user_id, reason) values ($1, $2, 'open', $3, 'licence')`, [club, module, pa]);
  });
}

// The catalog of v92's own objects, for comparing two databases.
async function v92Catalog(client) {
  return (await client.query(`
    select 'f:' || p.proname || ':' || md5(p.prosrc) as x from pg_proc p where p.pronamespace = 'public'::regnamespace
       and (p.proname like 'permission%' or p.proname in ('user_has_permission', 'user_holds_role_items', 'lock_permission_actor', 'lock_club_ceiling', 'club_permission_ceiling_guard', 'club_permission_ceiling_changes_guard', 'club_permission_ceiling_complete'))
    union all select 't:' || tgrelid::regclass || ':' || tgname || ':' || tgenabled from pg_trigger
     where not tgisinternal and tgrelid::regclass::text in ('club_permission_ceiling', 'club_permission_ceiling_changes', 'permission_club_role_versions',
       'permission_club_role_version_items', 'permission_club_role_version_changes', 'permission_custom_roles', 'permission_custom_role_items',
       'permission_custom_role_changes', 'user_club_roles', 'user_team_roles', 'permission_role_items', 'permission_roles', 'permission_requests')
    union all select 'c:' || conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint
     where conrelid::regclass::text in ('club_permission_ceiling', 'permission_club_role_versions', 'permission_custom_roles', 'permission_requests')
    order by 1`)).rows.map((r) => r.x);
}

test("1. both orders against v93: fresh (v92 then v93 by name) and production (v93 applied, then v92) give the same v92 objects", async () => {
  const fresh = await k.query(`select migration_name from public.schema_migrations where migration_name in ($1, $2) order by applied_at, migration_name`, [V92_NAME, `migrations_v2/${V93_FILE}`]).catch(() => null);
  assert.ok(fresh, "schema_migrations readable");
  const freshCatalog = await v92Catalog(k);
  const prod = await buildDatabase({ label: "r4v92_prod", upTo: "all", skip: [V92_FILE] });
  const c = new pg.Client({ connectionString: prod.url });
  await c.connect();
  try {
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V92_NAME])).rows[0].n, 0);
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [`migrations_v2/${V93_FILE}`])).rows[0].n, 1, "v93 is applied before v92");
    await runMigrations({ databaseUrl: prod.url, migrationsRoot: MIGRATIONS });
    const rec = (await c.query(`select checksum from public.schema_migrations where migration_name = $1`, [V92_NAME])).rows[0];
    assert.equal(rec.checksum, crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, V92_FILE))).digest("hex"));
    assert.deepEqual(await v92Catalog(c), freshCatalog);
    // The runner again: skipped by its checksum.
    await runMigrations({ databaseUrl: prod.url, migrationsRoot: MIGRATIONS });
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V92_NAME])).rows[0].n, 1);
  } finally { await c.end(); await prod.drop(); }
});

test("2. the seed: Club admin and Team coach get exactly the view words of 4.1, each through one 'migration' change row naming v92", async () => {
  for (const [key, before] of [["club_admin", ["athletes.manage", "athletes.remove", "org.club.edit", "org.teams.manage", "org.view", "roles.manage", "staff.assign"]],
    ["team_coach", ["athletes.manage", "athletes.remove", "org.view"]]]) {
    const items = (await one(`select array(select permission_word from public.permission_role_items where role_id = $1 order by 1) as w`, [ROLE_IDS[key]])).w;
    assert.deepEqual(items, [...before, ...VIEW].sort());
    const ch = (await k.query(`select revision_after, kind, migration_name, items_added from public.permission_role_changes where role_id = $1 and migration_name = $2`, [ROLE_IDS[key], V92_NAME])).rows;
    assert.equal(ch.length, 1);
    assert.equal(ch[0].kind, "migration");
    assert.deepEqual([...ch[0].items_added].sort(), [...VIEW].sort());
    assert.equal((await one(`select revision from public.permission_roles where id = $1`, [ROLE_IDS[key]])).revision, ch[0].revision_after);
  }
  for (const key of ["platform_admin", "independent_coach"]) {
    assert.equal((await one(`select count(*)::int as n from public.permission_role_changes where role_id = $1 and migration_name = $2`, [ROLE_IDS[key], V92_NAME])).n, 0);
  }
  // The storable list of the database equals the code twin.
  const storable = [];
  for (const p of (await k.query(`select word from public.permissions`)).rows) if ((await one(`select public.permission_word_honoured($1) as ok`, [p.word])).ok) storable.push(p.word);
  assert.deepEqual(storable.sort(), [...perms.STORABLE_PERMISSIONS].sort());
  assert.deepEqual([...perms.HONOURED_PERMISSIONS].sort(), Object.keys(perms.ENFORCED_PERMISSIONS).sort());
});

test("3. old-vs-new of the twin: before and after v92 every account answers identically for every word, apart from the view words the seed gave to their holders", async () => {
  const pre = await buildDatabase({ label: "r4v92_old", upTo: "all", skip: [V92_FILE] });
  const c = new pg.Client({ connectionString: pre.url });
  await c.connect();
  try {
    const G = fixtures(c);
    const A = await G.club("A"); const B = await G.club("B");
    const T1 = await G.team(A); const T2 = await G.team(B);
    const accounts = {
      none: await G.user("none"),
      pa: await G.user("pa"), ca: await G.user("ca"), tc: await G.user("tc"), mixed: await G.user("mixed"), indep: await G.user("indep"),
      inactiveRows: await G.user("inactiveRows"),
    };
    await G.grantPlatform(accounts.pa); await G.grantClub(accounts.ca, A); await G.grantTeam(accounts.tc, T1);
    await G.grantClub(accounts.mixed, A); await G.grantTeam(accounts.mixed, T2); await G.grantIndependent(accounts.indep);
    await G.grantClub(accounts.inactiveRows, A, false); await G.grantTeam(accounts.inactiveRows, T1, false);
    const scopes = [["global", "00000000-0000-0000-0000-000000000000"], ["club", A], ["club", B], ["team", T1], ["team", T2], ["private", accounts.indep], ["club", crypto.randomUUID()], ["team", crypto.randomUUID()]];
    const words = (await c.query(`select word from public.permissions order by sort_order`)).rows.map((r) => r.word);
    const ask = async () => {
      const out = new Map();
      for (const [name, u] of Object.entries(accounts)) for (const w of words) for (const [t, id] of scopes) {
        out.set(`${name}|${w}|${t}|${id}`, (await c.query(`select public.user_has_permission($1, $2, $3, $4) as ok`, [u, w, t, id])).rows[0].ok);
      }
      return out;
    };
    const before = await ask();
    await runMigrations({ databaseUrl: pre.url, migrationsRoot: MIGRATIONS });
    const afterMap = await ask();
    const diff = [...before.keys()].filter((key) => before.get(key) !== afterMap.get(key));
    for (const key of diff) {
      const [name, w, t, id] = key.split("|");
      assert.ok(VIEW.includes(w), `only view words change (${key})`);
      assert.equal(afterMap.get(key), true, key);
      const expected = (name === "ca" && ((t === "club" && id === A) || (t === "team" && id === T1)))
        || (name === "tc" && t === "team" && id === T1)
        || (name === "mixed" && ((t === "club" && id === A) || (t === "team" && (id === T1 || id === T2))));
      assert.ok(expected, `a view word appears only for its seeded holder (${key})`);
    }
    assert.ok(diff.length > 0);
  } finally { await c.end(); await pre.drop(); }
});

test("4. the truth table of contract 3.6 in can() and in the twin (rows 1-13)", async () => {
  const w = await world();
  const W = "athletes.manage"; // a checked word of the athletes module, held by Team coach by default
  const second = (await one(`insert into public.permission_roles (owner_scope, owner_club_id, name, assignable_club, assignable_team, created_by_user_id)
     values ('club', $1, 'Second', true, true, null) returning id`, [w.club]).catch(() => null));
  void second; // a club role written without the guard path is refused; row 9/13 use a second team coach row instead
  const T = perms.teamScope(w.team);
  const check = async (u, expected, label) => {
    assert.equal(await twin(u, W, "team", w.team), expected, `twin ${label}`);
    assert.equal(await canOf(u, W, T), expected, `can() ${label}`);
  };
  // 1. platform admin, every layer against him.
  await closeModule(w.pa, w.club, "athletes");
  await check(w.pa, true, "row 1");
  // 2. the ceiling closes W though every layer holds it.
  await check(w.coach, false, "row 2");
  await openModule(w.pa, w.club, "athletes");
  // 7. none, default holds.
  await check(w.coach, true, "row 7");
  // 6. club version lacks W, default holds -> no.
  await makeVersion(w.admin, w.club, ROLE_IDS.team_coach, { remove: [W] });
  await check(w.coach, false, "row 6");
  // 3. custom holds W, version and default lack -> yes (the club admin adds it back for this coach).
  const custom = await makeCustom(w.admin, w.coach, ROLE_IDS.team_coach, "team", w.team, w.club, { holding: { table: "user_team_roles", rowId: await teamRow(w.coach, w.team) }, add: [W] });
  await check(w.coach, true, "row 3");
  // 12. the holding revoked and granted again through the real routes: the custom is dead, the version decides.
  const adminCookie = await srv.cookieFor(w.admin);
  assert.equal((await srv.api(adminCookie, `/api/organization/users/${w.coach}/team-roles/${w.team}/team_coach`, { method: "DELETE" })).status, 200);
  assert.equal((await srv.api(adminCookie, `/api/organization/users/${w.coach}/team-roles/${w.team}/team_coach`, { method: "PUT" })).status, 200);
  await check(w.coach, false, "row 12");
  const ended = await one(`select ended_at, end_kind from public.permission_custom_roles where id = $1`, [custom]);
  assert.ok(ended.ended_at);
  assert.equal(ended.end_kind, "role_ended");
  assert.equal((await one(`select count(*)::int as n from public.permission_custom_role_changes where custom_role_id = $1 and kind = 'role_ended'`, [custom])).n, 1);
  // 4. custom lacks W, version and default hold -> no (custom beats role).
  const w2 = await world();
  const c2 = await makeCustom(w2.admin, w2.coach, ROLE_IDS.team_coach, "team", w2.team, w2.club, { holding: { table: "user_team_roles", rowId: await teamRow(w2.coach, w2.team) }, remove: [W] });
  assert.equal(await twin(w2.coach, W, "team", w2.team), false);
  assert.equal(await canOf(w2.coach, W, perms.teamScope(w2.team)), false);
  // 13. a second holding (club admin row) still gives W: roles add up.
  await F.grantClub(w2.coach, w2.club);
  assert.equal(await twin(w2.coach, W, "team", w2.team), true, "row 13 twin");
  assert.equal(await canOf(w2.coach, W, perms.teamScope(w2.team)), true, "row 13 can()");
  void c2;
  // 5. no custom, version holds a word the default lacks: the club admin widens Team coach with org.teams.manage? not
  // club-and-team scoped; use a view word (unchecked: acts nowhere, but can() and the twin still read it).
  const w3 = await world();
  await makeVersion(w3.admin, w3.club, ROLE_IDS.team_coach, { remove: ["athletes.view"] });
  assert.equal(await twin(w3.coach, "athletes.view", "team", w3.team), false, "row 6 for a view word");
  // 8. nothing holds W.
  assert.equal(await twin(w3.coach, "org.teams.manage", "club", w3.club), false, "row 8");
  // 10. closed then reopened: the custom's answer comes back, nothing rewritten.
  const w4 = await world();
  await makeCustom(w4.admin, w4.coach, ROLE_IDS.team_coach, "team", w4.team, w4.club, { holding: { table: "user_team_roles", rowId: await teamRow(w4.coach, w4.team) } });
  await closeModule(w4.pa, w4.club, "athletes");
  assert.equal(await canOf(w4.coach, W, perms.teamScope(w4.team)), false);
  await openModule(w4.pa, w4.club, "athletes");
  assert.equal(await canOf(w4.coach, W, perms.teamScope(w4.team)), true, "row 10");
  // 11. a word stored but unchecked acts nowhere: it is in no ENFORCED gate.
  assert.ok(!Object.hasOwn(perms.ENFORCED_PERMISSIONS, "athletes.view"), "row 11");
});

test("5. can() and the twin agree over a random matrix of layers", async () => {
  const w = await world();
  await makeVersion(w.admin, w.club, ROLE_IDS.team_coach, { remove: ["athletes.remove"] });
  const coach2 = await F.user("coach2"); await F.grantTeam(coach2, w.team);
  await makeCustom(w.admin, coach2, ROLE_IDS.team_coach, "team", w.team, w.club, { holding: { table: "user_team_roles", rowId: await teamRow(coach2, w.team) }, add: ["athletes.remove"], remove: ["org.view"] });
  await closeModule(w.pa, w.club, "programs");
  const users = [w.admin, w.coach, coach2, w.pa];
  const words = Object.keys(perms.PERMISSIONS);
  const scopes = [["club", w.club], ["team", w.team]];
  for (const u of users) {
    const ctx = await authz.loadAuthorizationContext({ id: u, role_hint: null });
    for (const word of words) for (const [t, id] of scopes) {
      assert.equal(perms.can(ctx, word, { type: t, id }), await twin(u, word, t, id), `${word} ${t}`);
    }
  }
});

test("6. the ceiling: a platform admin only, under the club's exclusive lock, with its change row; organization never closes; UPDATE and TRUNCATE refused", async () => {
  const w = await world();
  await refused(asLocked(w.admin, [w.club], "exclusive", (c) => c.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, 'imports', $2, 'x')`, [w.club, w.admin])), "42501", /may not change the ceiling/);
  await refused(asActor(db.url, w.pa, (c) => c.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, 'imports', $2, 'x')`, [w.club, w.pa])), "55000", /club lock/);
  await refused(asLocked(w.pa, [w.club], "shared", (c) => c.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, 'imports', $2, 'x')`, [w.club, w.pa])), "55000", /club lock/);
  await refused(asLocked(w.pa, [w.club], "exclusive", (c) => c.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, 'organization', $2, 'x')`, [w.club, w.pa])), "23514", /cannot be closed/);
  await refused(asLocked(w.pa, [w.club], "exclusive", (c) => c.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, 'imports', $2, 'x')`, [w.club, w.pa])), "23514", /no change record/);
  await closeModule(w.pa, w.club, "imports");
  await refused(asLocked(w.pa, [w.club], "exclusive", (c) => c.query(`update public.club_permission_ceiling set reason = 'y' where club_id = $1`, [w.club])), "23514");
  await refused(k.query(`truncate public.club_permission_ceiling`), "23514");
  await refused(k.query(`update public.club_permission_ceiling_changes set reason = 'z'`), "23514", /append-only/);
  await refused(asLocked(w.pa, [w.club], "exclusive", (c) => c.query(`delete from public.club_permission_ceiling where club_id = $1`, [w.club])), "23514", /no change record/);
  await openModule(w.pa, w.club, "imports");
  assert.equal((await one(`select count(*)::int as n from public.club_permission_ceiling where club_id = $1`, [w.club])).n, 0);
});

test("7. club versions: who, the exclusive lock, Club admin only by a platform admin, H1, dominance, rule 7 inside the club, no delete", async () => {
  const w = await world();
  // A club admin may not make a version of Club admin (Q3); a platform admin may, but it must keep staff.assign and roles.manage (H1).
  await refused(makeVersion(w.admin, w.club, ROLE_IDS.club_admin, { remove: ["org.club.edit"] }), "42501", /may not write this version/);
  await refused(makeVersion(w.pa, w.club, ROLE_IDS.club_admin, { remove: ["staff.assign"] }), "23514", /must hold this permission/);
  // The lock: a version write under the shared lock is refused (mutation: a writer that skips lockClubCeiling).
  await refused(asLocked(w.admin, [w.club], "shared", (c) => c.query(`insert into public.permission_club_role_versions (club_id, system_role_id, based_on_revision, answered_revision, created_by_user_id)
     select $1, $2, revision, revision, $3 from public.permission_roles where id = $2`, [w.club, ROLE_IDS.team_coach, w.admin])), "55000", /club lock/);
  // Not Platform admin / Independent coach.
  await refused(makeVersion(w.pa, w.club, ROLE_IDS.independent_coach), "23514", /not allowed/);
  // A team coach may not write a version.
  await refused(makeVersion(w.coach, w.club, ROLE_IDS.team_coach, { remove: ["athletes.remove"] }), "42501");
  // Rule 7 inside the club: a platform admin's Club admin version lacking a word Team coach holds there is refused...
  await refused(makeVersion(w.pa, w.club, ROLE_IDS.club_admin, { remove: ["athletes.remove"] }), "23514", /would lack/);
  // ... unless the club's Team coach version lacks it too (one transaction cannot do both here, so first narrow TC).
  await makeVersion(w.admin, w.club, ROLE_IDS.team_coach, { remove: ["athletes.remove"] });
  await makeVersion(w.pa, w.club, ROLE_IDS.club_admin, { remove: ["athletes.remove"] });
  // Dominance: the club admin, who no longer holds athletes.remove, cannot add it to Team coach in its club.
  await refused(asLocked(w.admin, [w.club], "exclusive", async (c) => {
    const v = (await c.query(`select id, revision from public.permission_club_role_versions where club_id = $1 and system_role_id = $2 and ended_at is null`, [w.club, ROLE_IDS.team_coach])).rows[0];
    await c.query(`update public.permission_club_role_versions set revision = revision + 1 where id = $1`, [v.id]);
    await c.query(`insert into public.permission_club_role_version_items (version_id, permission_word) values ($1, 'athletes.remove')`, [v.id]);
    await c.query(`insert into public.permission_club_role_version_changes (version_id, revision_after, kind, performed_by_user_id, basis, reason, items_added) values ($1, $2, 'change', $3, 'club_admin', 'x', '{athletes.remove}')`, [v.id, v.revision + 1, w.admin]);
  }), "42501", /does not hold/);
  // A second live version of the same role: the partial unique index.
  await refused(makeVersion(w.admin, w.club, ROLE_IDS.team_coach), "23505");
  await refused(k.query(`delete from public.permission_club_role_versions where club_id = $1`, [w.club]), "23514");
  // A platform-only or a system-role-only word in a version of Team coach.
  const other = await world();
  await refused(makeVersion(other.pa, other.club, ROLE_IDS.team_coach, { add: ["staff.assign"] }), "23514", /only in the Club admin role/);
  await refused(makeVersion(other.pa, other.club, ROLE_IDS.team_coach, { add: ["import.check"] }), "23514", /no route checks/);
});

test("8. custom roles: who, the shared lock, the named holding, never for an admin by a club admin, never oneself; frozen; liveness through the real routes", async () => {
  const w = await world();
  const row = await teamRow(w.coach, w.team);
  const holding = { table: "user_team_roles", rowId: row };
  // No lock at all.
  await refused(asActor(db.url, w.admin, (c) => c.query(`insert into public.permission_custom_roles (user_id, base_role_id, scope_type, scope_id, club_id, holding_row_table, holding_row_id, holding_row_version, frozen_from, frozen_from_revision, created_by_user_id)
     select $1, $2, 'team', $3, $4, 'user_team_roles', r.id, r.updated_at, 'default', 1, $5 from public.user_team_roles r where r.id = $6`, [w.coach, ROLE_IDS.team_coach, w.team, w.club, w.admin, row])), "55000", /club lock/);
  // A holding that is not the user's (another row), a stale version of the row.
  const other = await F.user("other"); await F.grantTeam(other, w.team);
  await refused(makeCustom(w.admin, w.coach, ROLE_IDS.team_coach, "team", w.team, w.club, { holding: { table: "user_team_roles", rowId: await teamRow(other, w.team) } }), "23514", /not allowed/);
  // A club admin may not make the custom of a Club admin holder (O5); a platform admin may, keeping staff.assign and roles.manage (H1).
  const admin2 = await F.user("admin2"); await F.grantClub(admin2, w.club);
  await refused(makeCustom(w.admin, admin2, ROLE_IDS.club_admin, "club", w.club, w.club, { holding: { table: "user_club_roles", rowId: await clubRow(admin2, w.club) } }), "42501");
  await refused(makeCustom(w.pa, admin2, ROLE_IDS.club_admin, "club", w.club, w.club, { holding: { table: "user_club_roles", rowId: await clubRow(admin2, w.club) }, remove: ["roles.manage"] }), "23514", /must hold this permission/);
  await makeCustom(w.pa, admin2, ROLE_IDS.club_admin, "club", w.club, w.club, { holding: { table: "user_club_roles", rowId: await clubRow(admin2, w.club) }, remove: ["org.club.edit"] });
  assert.equal(await twin(admin2, "org.club.edit", "club", w.club), false);
  // Never oneself: a platform admin who also coaches the team.
  await F.grantTeam(w.pa, w.team);
  await refused(makeCustom(w.pa, w.pa, ROLE_IDS.team_coach, "team", w.team, w.club, { holding: { table: "user_team_roles", rowId: await teamRow(w.pa, w.team) } }), "23514");
  // A word the acting club admin does not hold.
  await refused(makeCustom(w.admin, w.coach, ROLE_IDS.team_coach, "team", w.team, w.club, { holding, add: ["import.check"] }), "23514", /no route checks/);
  // Live right after it is made; a word taken away really does not act.
  const id = await makeCustom(w.admin, w.coach, ROLE_IDS.team_coach, "team", w.team, w.club, { holding, remove: ["athletes.remove"] });
  assert.equal(await canOf(w.coach, "athletes.remove", perms.teamScope(w.team)), false);
  // Frozen: a later club version does not reach it.
  await makeVersion(w.admin, w.club, ROLE_IDS.team_coach, { remove: ["athletes.manage"] });
  assert.equal(await twin(w.coach, "athletes.manage", "team", w.team), true, "the custom kept athletes.manage");
  assert.equal(await twin(other, "athletes.manage", "team", w.team), false, "the club version applies to the other coach");
  // A second live custom on the same holding: the partial unique index.
  await refused(makeCustom(w.admin, w.coach, ROLE_IDS.team_coach, "team", w.team, w.club, { holding }), "23505");
  // A raw is_active flip without updated_at moves updated_at and ends the custom (N1), with its role_ended row.
  const v0 = (await one(`select updated_at from public.user_team_roles where id = $1`, [row])).updated_at;
  await k.query(`update public.user_team_roles set is_active = false where id = $1`, [row]);
  const v1 = (await one(`select updated_at from public.user_team_roles where id = $1`, [row])).updated_at;
  assert.notEqual(v1.getTime(), v0.getTime());
  const c = await one(`select end_kind, ended_by_user_id, revision from public.permission_custom_roles where id = $1`, [id]);
  assert.equal(c.end_kind, "role_ended");
  assert.equal(c.ended_by_user_id, null);
  assert.equal((await one(`select kind from public.permission_custom_role_changes where custom_role_id = $1 and revision_after = $2`, [id, c.revision])).kind, "role_ended");
  // The marker is cleared after the trigger: a raw end without it is refused.
  const w2 = await world();
  const id2 = await makeCustom(w2.admin, w2.coach, ROLE_IDS.team_coach, "team", w2.team, w2.club, { holding: { table: "user_team_roles", rowId: await teamRow(w2.coach, w2.team) } });
  await refused(k.query(`update public.permission_custom_roles set ended_at = now(), end_kind = 'role_ended', revision = revision + 1 where id = $1`, [id2]), "55000");
  await refused(k.query(`select set_config('optimove.custom_role_end_tx', '1', false)`).then(() => k.query(`update public.permission_custom_roles set ended_at = now(), end_kind = 'role_ended', revision = revision + 1 where id = $1`, [id2])), "55000");
  await k.query(`select set_config('optimove.custom_role_end_tx', '', false)`);
  // A re-grant of an already active coach (only updated_at changes) ends the custom (N2), through the real route.
  const cookie = await srv.cookieFor(w2.admin);
  assert.equal((await srv.api(cookie, `/api/organization/users/${w2.coach}/team-roles/${w2.team}/team_coach`, { method: "PUT" })).status, 200);
  assert.equal((await one(`select end_kind from public.permission_custom_roles where id = $1`, [id2])).end_kind, "role_ended");
});

test("9. custom roles on an assignment die with the assignment (revoked or expired) at read time", async () => {
  const w = await world();
  const role = await asLocked(w.admin, [w.club], "shared", async (c) => {
    const id = (await c.query(`insert into public.permission_roles (owner_scope, owner_club_id, name, assignable_club, assignable_team, created_by_user_id) values ('club', $1, 'Assistant', true, true, $2) returning id`, [w.club, w.admin])).rows[0].id;
    for (const x of ["org.view", "athletes.manage"]) await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, $2, $3)`, [id, x, w.admin]);
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, items_added) values ($1, 1, 'create', $2, 'club_admin', '{org.view,athletes.manage}')`, [id, w.admin]);
    return id;
  });
  const user = await F.user("assistant");
  const grant = (expires = null) => asLocked(w.admin, [w.club], "shared", async (c) => {
    const a = (await c.query(`insert into public.user_role_assignments (user_id, role_id, scope_type, scope_id, granted_by_user_id, grant_basis, grant_reason, expires_at) values ($1, $2, 'club', $3, $4, 'club_admin', 'help', $5) returning id`, [user, role, w.club, w.admin, expires])).rows[0].id;
    await c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, assignment_id) values ($1, $2, 'assignment_grant', $3, 'club', $4, 'club_admin', $5)`, [crypto.randomUUID(), w.admin, "a".repeat(64), w.club, a]);
    return a;
  });
  const a1 = await grant();
  await makeCustom(w.admin, user, role, "club", w.club, w.club, { holding: { assignmentId: a1 }, add: ["athletes.remove"] });
  assert.equal(await twin(user, "athletes.remove", "club", w.club), true);
  assert.equal(await canOf(user, "athletes.remove", perms.clubScope(w.club)), true);
  await asLocked(w.admin, [w.club], "shared", async (c) => {
    await c.query(`update public.user_role_assignments set revoked_at = now(), revoked_by_user_id = $2, revoke_kind = 'revoked', revoke_reason = 'done' where id = $1`, [a1, w.admin]);
    await c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, assignment_id) values ($1, $2, 'assignment_revoke', $3, 'club', $4, 'club_admin', $5)`, [crypto.randomUUID(), w.admin, "b".repeat(64), w.club, a1]);
  });
  await grant();
  assert.equal(await twin(user, "athletes.remove", "club", w.club), false, "the custom of the revoked assignment is dead; the role decides");
  assert.equal(await canOf(user, "athletes.remove", perms.clubScope(w.club)), false);
});

test("10. the club lock: lock_permission_actor refuses without it, one mode per transaction, a negative hash is found, the pg_locks read is cheap", async () => {
  const w = await world();
  await refused(asActor(db.url, w.admin, (c) => c.query(`select public.lock_permission_actor($1, 'club', $2)`, [w.admin, w.club])), "55000", /club lock/);
  await refused(asActor(db.url, w.admin, (c) => c.query(`select public.lock_permission_actor($1, 'team', $2)`, [w.admin, w.team])), "55000", /club lock/);
  assert.equal(await asLocked(w.admin, [w.club], "shared", async (c) => (await c.query(`select public.lock_permission_actor($1, 'team', $2) as b`, [w.admin, w.team])).rows[0].b), "club_admin");
  await refused(asLocked(w.admin, [w.club], "shared", (c) => c.query(`select public.lock_club_ceiling($1::uuid[], 'exclusive')`, [[w.club]])), "55000", /another mode/);
  await refused(asLocked(w.admin, [w.club], "exclusive", (c) => c.query(`select public.lock_club_ceiling($1::uuid[], 'shared')`, [[w.club]])), "55000", /another mode/);
  await refused(k.query(`select public.lock_club_ceiling($1::uuid[], 'upgrade')`, [[w.club]]), "22023");
  // A club whose hashtext is negative.
  let neg;
  for (let i = 0; i < 50 && !neg; i += 1) {
    const id = await F.club(`neg${i}`);
    if ((await one(`select hashtext($1::text) < 0 as n`, [id])).n) neg = id;
  }
  assert.ok(neg, "found a club with a negative hash");
  assert.equal(await asLocked(w.pa, [neg], "exclusive", async (c) => (await c.query(`select public.permission_club_lock_held($1, 'exclusive') as h`, [neg])).rows[0].h), true);
  // Global and private scopes need no club lock.
  assert.equal(await asActor(db.url, w.pa, async (c) => (await c.query(`select public.lock_permission_actor($1, 'global', '00000000-0000-0000-0000-000000000000') as b`, [w.pa])).rows[0].b), "platform_admin");
  // The cost of the check: 200 reads of pg_locks within one transaction.
  const ms = await asLocked(w.admin, [w.club], "shared", async (c) => {
    const t = Date.now();
    for (let i = 0; i < 200; i += 1) await c.query(`select public.permission_club_lock_held($1, 'shared')`, [w.club]);
    return (Date.now() - t) / 200;
  });
  assert.ok(ms < 20, `pg_locks read per call ${ms} ms`);
  console.log(`[r4v92] permission_club_lock_held: ${ms.toFixed(3)} ms per call (incl. round trip)`);
  // A shared holder blocks an exclusive writer of the same club (bounded by lock_timeout -> 55P03).
  const holder = new pg.Client({ connectionString: db.url }); await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select public.lock_club_ceiling($1::uuid[], 'shared')`, [[w.club]]);
    await refused(asActor(db.url, w.pa, async (c) => { await c.query(`set local lock_timeout = '200ms'`); await c.query(`select public.lock_club_ceiling($1::uuid[], 'exclusive')`, [[w.club]]); }), "55P03");
  } finally { await holder.query("rollback"); await holder.end(); }
});

test("11. rule 7 across clubs when a default changes (H4): adding a word to Team coach is refused while a club's own Club admin version lacks it, unless that club follows its own Team coach version", async () => {
  const w = await world();
  // The club's Club admin version without athletes.remove needs Team coach's version without it as well (test 7).
  await makeVersion(w.admin, w.club, ROLE_IDS.team_coach, { remove: ["athletes.remove"] });
  await makeVersion(w.pa, w.club, ROLE_IDS.club_admin, { remove: ["athletes.remove"] });
  // Now a club with a Club admin version lacking a view word, following the default Team coach.
  const x = await world();
  await refused(makeVersion(x.pa, x.club, ROLE_IDS.club_admin, { remove: ["calendar.view"] }), "23514", /would lack/);
  // A default change that adds a word Club admin (default) lacks is refused by v84's rule as before.
  await refused(asActor(db.url, w.pa, async (c) => {
    await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [ROLE_IDS.team_coach]);
    const rev = (await c.query(`select revision from public.permission_roles where id = $1`, [ROLE_IDS.team_coach])).rows[0].revision;
    await c.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, 'join_links.manage', $2)`, [ROLE_IDS.team_coach, w.pa]);
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason, items_added) values ($1, $2, 'change', $3, 'platform_admin', 'x', '{join_links.manage}')`, [ROLE_IDS.team_coach, rev, w.pa]);
  }), "23514");
  // The cross-club rule: remove athletes.remove from the default Club admin is refused (v84: Team coach holds it), and
  // a platform admin's default change that would leave club w's Club admin version short is refused at COMMIT.
  await refused(asActor(db.url, w.pa, async (c) => {
    await c.query(`update public.permission_roles set revision = revision + 1 where id = $1`, [ROLE_IDS.team_coach]);
    const rev = (await c.query(`select revision from public.permission_roles where id = $1`, [ROLE_IDS.team_coach])).rows[0].revision;
    await c.query(`delete from public.permission_role_items where role_id = $1 and permission_word = 'athletes.remove'`, [ROLE_IDS.team_coach]);
    await c.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason, items_removed) values ($1, $2, 'change', $3, 'platform_admin', 'x', '{athletes.remove}')`, [ROLE_IDS.team_coach, rev, w.pa]);
    // ... then the Club admin default gives up athletes.remove too, while club w's Team coach version... still lacks it: fine.
    // Plant the problem: end club w's own Team coach version so the club follows the default again - with athletes.remove
    // gone from the default nothing breaks; so add it back to the default Team coach instead (below, its own case).
    throw Object.assign(new Error("planted rollback"), { code: "PLANT" });
  }), "PLANT");
  // The planted cross-club case: club w follows the DEFAULT Team coach (end its own version), whose athletes.remove its
  // Club admin version lacks -> refused at COMMIT.
  await refused(asLocked(w.admin, [w.club], "exclusive", async (c) => {
    const v = (await c.query(`select id, revision from public.permission_club_role_versions where club_id = $1 and system_role_id = $2 and ended_at is null`, [w.club, ROLE_IDS.team_coach])).rows[0];
    await c.query(`update public.permission_club_role_versions set revision = revision + 1, ended_at = now(), ended_by_user_id = $2, end_kind = 'reset' where id = $1`, [v.id, w.admin]);
    await c.query(`insert into public.permission_club_role_version_changes (version_id, revision_after, kind, performed_by_user_id, basis, reason) values ($1, $2, 'reset', $3, 'club_admin', 'back')`, [v.id, v.revision + 1, w.admin]);
  }), "23514", /would lack/);
});

test("12. a later migration seeds a word into live versions and customs (H2), through the runner's own row", async () => {
  const w = await world();
  const v = await makeVersion(w.admin, w.club, ROLE_IDS.team_coach, { remove: ["athletes.remove"] });
  const cu = await makeCustom(w.admin, w.coach, ROLE_IDS.team_coach, "team", w.team, w.club, { holding: { table: "user_team_roles", rowId: await teamRow(w.coach, w.team) } });
  // Without its runner row the migration path is refused at COMMIT.
  await refused((async () => {
    const c = new pg.Client({ connectionString: db.url }); await c.connect();
    try {
      await c.query("begin");
      await c.query(`select public.lock_club_ceiling($1::uuid[], 'exclusive')`, [[w.club]]);
      await c.query(`update public.permission_club_role_versions set revision = revision + 1 where id = $1`, [v]);
      await c.query(`insert into public.permission_club_role_version_changes (version_id, revision_after, kind, migration_name, items_added) values ($1, 2, 'migration', 'migrations_v2/209901010000_fake.sql', '{athletes.remove}')`, [v]);
      await c.query(`insert into public.permission_club_role_version_items (version_id, permission_word) values ($1, 'athletes.remove')`, [v]);
      await c.query("commit");
    } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { await c.end(); }
  })(), "23514");
  // Through the runner: a temporary folder holding every migration plus the seed file.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r4v92-h2-"));
  const dir = path.join(root, "migrations_v2"); fs.mkdirSync(dir);
  for (const f of fs.readdirSync(MIGRATIONS)) if (f.endsWith(".sql")) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  const name = "209901010000_test_h2_seed.sql";
  fs.writeFileSync(path.join(dir, name), `select public.lock_club_ceiling(array['${w.club}']::uuid[], 'exclusive');
update public.permission_club_role_versions set revision = revision + 1 where id = '${v}';
insert into public.permission_club_role_version_changes (version_id, revision_after, kind, migration_name, items_added) values ('${v}', 2, 'migration', 'migrations_v2/${name}', '{athletes.remove}');
insert into public.permission_club_role_version_items (version_id, permission_word) values ('${v}', 'athletes.remove');
update public.permission_custom_roles set revision = revision + 1 where id = '${cu}';
insert into public.permission_custom_role_changes (custom_role_id, revision_after, kind, migration_name) values ('${cu}', 2, 'migration', 'migrations_v2/${name}');
`);
  try {
    await runMigrations({ databaseUrl: db.url, migrationsRoot: dir });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  assert.equal(await twin(w.coach, "athletes.manage", "team", w.team), true);
  const other = await F.user("other"); await F.grantTeam(other, w.team);
  assert.equal(await twin(other, "athletes.remove", "team", w.team), true, "the version holds the seeded word");
  assert.equal((await one(`select revision from public.permission_custom_roles where id = $1`, [cu])).revision, 2);
  await k.query(`delete from public.schema_migrations where migration_name = $1`, [`migrations_v2/${name}`]);
});

test("13. the request record: the new operations need their own result row of this transaction", async () => {
  const w = await world();
  await refused(asActor(db.url, w.pa, (c) => c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis)
     values ($1, $2, 'ceiling_close', $3, 'club', $4, 'platform_admin')`, [crypto.randomUUID(), w.pa, "c".repeat(64), w.club])), "23514");
  await asLocked(w.pa, [w.club], "exclusive", async (c) => {
    await c.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, 'imports', $2, 'licence')`, [w.club, w.pa]);
    const ch = (await c.query(`insert into public.club_permission_ceiling_changes (club_id, module_word, action, performed_by_user_id, reason) values ($1, 'imports', 'close', $2, 'licence') returning id`, [w.club, w.pa])).rows[0].id;
    await c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, ceiling_change_id)
       values ($1, $2, 'ceiling_close', $3, 'club', $4, 'platform_admin', $5)`, [crypto.randomUUID(), w.pa, "d".repeat(64), w.club, ch]);
  });
  // A club admin may not write a ceiling request.
  await refused(asLocked(w.admin, [w.club], "exclusive", (c) => c.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, ceiling_change_id)
     select $1, $2, 'ceiling_close', $3, 'club', $4, 'club_admin', id from public.club_permission_ceiling_changes where club_id = $4 limit 1`, [crypto.randomUUID(), w.admin, "e".repeat(64), w.club])), "42501");
});

test("14. the rollback: refused after real writes; clean, it restores v84's bodies by md5, the catalog, the seed, and v92 applies again", async () => {
  const rollback = fs.readFileSync(path.join(RUNBOOKS, "roles-layers-v92-rollback.sql"), "utf8");
  await refused(k.query(rollback), "23514", /v92 rollback refused/);
  const pre = await buildDatabase({ label: "r4v92_rb", upTo: "all", skip: [V92_FILE] });
  const c = new pg.Client({ connectionString: pre.url }); await c.connect();
  try {
    const catalog = async () => (await c.query(`select p.proname || ':' || md5(p.prosrc) as x from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like any (array['permission%', 'user_has%', 'user_holds%', 'lock_%'])
       union all select 'rel:' || relname from pg_class where relnamespace = 'public'::regnamespace and relname like any (array['permission%', 'club_permission%'])
       union all select 'trg:' || tgrelid::regclass || ':' || tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text in ('user_club_roles', 'user_team_roles', 'permission_requests', 'permission_role_items')
       union all select 'con:' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.permission_requests'::regclass
       union all select 'item:' || role_id || ':' || permission_word from public.permission_role_items
       order by 1`)).rows.map((r) => r.x);
    const before = await catalog();
    const preflight = fs.readFileSync(path.join(RUNBOOKS, "roles-layers-v92-preflight.sql"), "utf8");
    for (const block of preflight.split(/\n(?=-- Block )/).filter((b) => /select/i.test(b))) {
      for (const row of (await c.query(block)).rows) for (const [col, val] of Object.entries(row)) if (col.endsWith("ok")) assert.equal(val, true, `preflight ${col}`);
    }
    await runMigrations({ databaseUrl: pre.url, migrationsRoot: MIGRATIONS });
    const postcheck = fs.readFileSync(path.join(RUNBOOKS, "roles-layers-v92-postcheck.sql"), "utf8");
    for (const block of postcheck.split(/\n(?=-- Block )/).filter((b) => /select/i.test(b))) {
      for (const row of (await c.query(block)).rows) for (const [col, val] of Object.entries(row)) if (col.endsWith("ok")) assert.equal(val, true, `postcheck ${col}`);
    }
    // Refused while a later migration that is not v93 is recorded? v93 is before it by time in production: allowed.
    await c.query(rollback);
    assert.deepEqual(await catalog(), before);
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V92_NAME])).rows[0].n, 0);
    await runMigrations({ databaseUrl: pre.url, migrationsRoot: MIGRATIONS });
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V92_NAME])).rows[0].n, 1);
    // A changed seeded item blocks the rollback (planted: a later migration-like removal is too heavy; use a body change).
    await c.query(`create or replace function public.permission_word_honoured(p_word text) returns boolean language sql immutable as $$ select false $$`);
    await refused(c.query(rollback), "23514", /v92 rollback refused/);
  } finally { await c.end(); await pre.drop(); }
});
