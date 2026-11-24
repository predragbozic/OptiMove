// Roles v95 (docs/runbooks/roles-closed-module-dominance-v95.md): R2's dominance in the club version and custom role
// guards no longer fails on a word of a module the club's licence closes - such a word passes only when the acting user
// holds it through its own club holdings with the ceiling left out. The migration's round trip (apply, rollback to
// v92's bodies, the same write refused under them, re-apply, the rollback's refusals), the fix with a closed module
// that carries seeded words, the stricter half (a closed word the admin would not hold), open modules and a platform
// admin unchanged, and the helper itself. Disposable database built from the legacy snapshot and the real runner.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { runMigrations } from "../src/migrate.js";
import { asActor, buildDatabase, fixtures, MIGRATIONS, RUNBOOKS, ROLE_IDS } from "./support/permission-roles-world.mjs";

const V95_FILE = "202611271000_roles_v95_closed_module_dominance.sql";
const V95_NAME = `migrations_v2/${V95_FILE}`;
const V92_MD5 = {
  permission_club_role_version_items_guard: "d98a0076818f143a932b5f8f835c8635",
  permission_club_role_versions_complete: "4bd61e03b5ebd341588d31140c919387",
  permission_custom_role_items_guard: "4b9b0f8d193a412ebc4b1235397a69d2",
  permission_custom_roles_complete: "c8ea92473b20abb89bdccc59a01c5932",
};
const V95_MD5 = {
  permission_actor_holds_in_club: "da8b90ab31b0a96d13e8d263d7b42770",
  permission_club_role_version_items_guard: "bec037f372b4afb9334cd56f31916aa7",
  permission_club_role_versions_complete: "b9c58f7a95deb48d89e1626700fe7e08",
  permission_custom_role_items_guard: "1b2833cefe8e83ece62f039d8e122e49",
  permission_custom_roles_complete: "d3f4777620765d2ea9270bddf82b6893",
};

let db, k, F;
before(async () => {
  db = await buildDatabase({ label: "v95", upTo: "all" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
});
after(async () => {
  await k?.end().catch(() => {});
  await db?.drop();
});

const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
async function refused(promise, code) {
  await assert.rejects(promise, (e) => { assert.equal(e.code, code, `SQLSTATE ${e.code} (${e.message})`); return true; });
}
const md5s = async () => Object.fromEntries((await k.query(`select proname, md5(prosrc) as m from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)`,
  [Object.keys(V95_MD5)])).rows.map((r) => [r.proname, r.m]));
const twin = async (u, w, t, id) => (await one(`select public.user_has_permission($1, $2, $3, $4) as ok`, [u, w, t, id])).ok;
const holdsInClub = async (u, w, club) => (await one(`select public.permission_actor_holds_in_club($1, $2, $3) as ok`, [u, w, club])).ok;
const asLocked = (actor, clubs, mode, fn) => asActor(db.url, actor, async (c) => {
  await c.query(`select public.lock_club_ceiling($1::uuid[], $2)`, [clubs, mode]);
  return fn(c);
});
const basisOf = async (c, actor, word, club) => (await c.query(`select public.permission_actor_basis($1, $2, 'club', $3) as b`, [actor, word, club])).rows[0].b;
const itemsOf = async (roleId) => (await one(`select array(select permission_word from public.permission_role_items where role_id = $1 order by 1) as w`, [roleId])).w;

// The writers of R4-3, as direct SQL.
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
async function makeCustom(actor, user, team, club, { add = [], remove = [] } = {}) {
  return asLocked(actor, [club], "shared", async (c) => {
    const base = (await c.query(`select public.permission_role_club_items($1, $2) as w`, [ROLE_IDS.team_coach, club])).rows[0].w;
    const items = [...new Set([...base.filter((w) => !remove.includes(w)), ...add])];
    const id = (await c.query(`insert into public.permission_custom_roles (user_id, base_role_id, scope_type, scope_id, club_id, holding_row_table, holding_row_id, holding_row_version, frozen_from, frozen_from_revision, created_by_user_id)
        select $1, $2, 'team', $3, $4, 'user_team_roles', r.id, r.updated_at, 'default', 1, $5
          from public.user_team_roles r where r.user_id = $1 and r.team_id = $3 returning id`, [user, ROLE_IDS.team_coach, team, club, actor])).rows[0].id;
    for (const w of items) await c.query(`insert into public.permission_custom_role_items (custom_role_id, permission_word) values ($1, $2)`, [id, w]);
    await c.query(`insert into public.permission_custom_role_changes (custom_role_id, revision_after, kind, performed_by_user_id, basis, reason, items_added)
        values ($1, 1, 'create', $2, $3, 'per user', $4)`, [id, actor, await basisOf(c, actor, "staff.assign", club), items]);
    return id;
  });
}
async function setModule(pa, club, module, action) {
  await asLocked(pa, [club], "exclusive", async (c) => {
    if (action === "close") await c.query(`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, $2, $3, 'licence')`, [club, module, pa]);
    else await c.query(`delete from public.club_permission_ceiling where club_id = $1 and module_word = $2`, [club, module]);
    await c.query(`insert into public.club_permission_ceiling_changes (club_id, module_word, action, performed_by_user_id, reason) values ($1, $2, $3, $4, 'licence')`, [club, module, action, pa]);
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

test("0. the seeded words this suite relies on: Team coach and Club admin carry the Tests and Calendar view words", async () => {
  for (const role of [ROLE_IDS.team_coach, ROLE_IDS.club_admin]) {
    const items = await itemsOf(role);
    for (const w of ["tests.view", "calendar.view"]) assert.ok(items.includes(w), `${role} holds ${w}`);
  }
});

test("1. the migration: v95 recorded with the file's sha256, the bodies v95's; the rollback restores v92's and the same write is refused under them; re-applied; the rollback refuses after a later migration and over a changed body", async () => {
  const sha = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, V95_FILE))).digest("hex");
  assert.equal((await one(`select checksum from public.schema_migrations where migration_name = $1`, [V95_NAME])).checksum, sha);
  assert.deepEqual(await md5s(), V95_MD5);
  assert.equal(await one(`select has_function_privilege('public', 'public.permission_actor_holds_in_club(uuid, text, uuid)', 'execute') as x`).then((r) => r.x), false);
  const rollback = fs.readFileSync(path.join(RUNBOOKS, "roles-closed-module-dominance-v95-rollback.sql"), "utf8");
  const w = await world();
  await setModule(w.pa, w.club, "tests", "close");
  await k.query(rollback);
  const back = await md5s();
  assert.equal(back.permission_actor_holds_in_club, undefined);
  for (const [f, m] of Object.entries(V92_MD5)) assert.equal(back[f], m, f);
  assert.equal((await one(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V95_NAME])).n, 0);
  // Under v92's bodies the club's admin cannot version Team coach while Tests is closed (it carries tests.view).
  await refused(makeVersion(w.admin, w.club, ROLE_IDS.team_coach, { remove: ["athletes.remove"] }), "42501");
  await runMigrations({ databaseUrl: db.url, migrationsRoot: MIGRATIONS });
  assert.deepEqual(await md5s(), V95_MD5);
  await makeVersion(w.admin, w.club, ROLE_IDS.team_coach, { remove: ["athletes.remove"] });
  // A later migration recorded: refused, nothing changed.
  await k.query(`insert into public.schema_migrations (migration_name, checksum, applied_at, runner_version)
    values ('migrations_v2/209912310000_later.sql', repeat('a', 64), now() + interval '1 hour', 'test')`);
  try {
    await refused(k.query(rollback), "23514");
    await k.query("rollback").catch(() => {});
  } finally {
    await k.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/209912310000_later.sql'`);
  }
  assert.deepEqual(await md5s(), V95_MD5);
  // A body that is not v95's: refused.
  await k.query(`create or replace function public.permission_actor_holds_in_club(p_actor uuid, p_word text, p_club uuid) returns boolean
    language sql stable set search_path = pg_catalog, public as $$ select false $$`);
  await refused(k.query(rollback), "23514");
  await k.query("rollback").catch(() => {});
  const helper = fs.readFileSync(path.join(MIGRATIONS, V95_FILE), "utf8").match(/create function public\.permission_actor_holds_in_club[\s\S]*?\n {2}\$\$;/)[0];
  await k.query(helper.replace("create function", "create or replace function"));
  assert.deepEqual(await md5s(), V95_MD5);
});

test("2. the fix: with Tests closed, the club's admin makes a club version and a custom role that carry tests.view; reopened, the words act again", async () => {
  const w = await world();
  await setModule(w.pa, w.club, "tests", "close");
  assert.equal(await twin(w.admin, "tests.view", "club", w.club), false, "the admin does not hold it now");
  assert.equal(await holdsInClub(w.admin, "tests.view", w.club), true, "but would the moment Tests opens");
  await makeVersion(w.admin, w.club, ROLE_IDS.team_coach, { remove: ["athletes.remove"] });
  await makeCustom(w.admin, w.coach, w.team, w.club, { remove: ["athletes.manage"] });
  assert.equal(await twin(w.coach, "tests.view", "team", w.team), false, "the ceiling still decides (step 6)");
  await setModule(w.pa, w.club, "tests", "open");
  assert.equal(await twin(w.coach, "tests.view", "team", w.team), true, "reopened: exactly what was recorded (O1)");
  assert.equal(await twin(w.coach, "athletes.manage", "team", w.team), false);
});

test("3. the stricter half: a closed word the club's admin would NOT hold when the module opens is still refused, in a version and in a custom", async () => {
  const w = await world();
  await setModule(w.pa, w.club, "tests", "close");
  // A platform admin gives the club a Club admin version without the Tests words (rule 7 leaves the closed module out).
  await makeVersion(w.pa, w.club, ROLE_IDS.club_admin, { remove: ["tests.view", "tests.results.view"] });
  assert.equal(await holdsInClub(w.admin, "tests.view", w.club), false);
  await refused(makeVersion(w.admin, w.club, ROLE_IDS.team_coach, { remove: ["athletes.remove"] }), "42501");
  await refused(makeCustom(w.admin, w.coach, w.team, w.club, { remove: ["athletes.manage"] }), "42501");
  // Without the Tests words in the set, the same writes pass.
  await makeCustom(w.admin, w.coach, w.team, w.club, { remove: ["tests.view", "tests.results.view"] });
});

test("3b. club-scope holdings only: a club admin who also coaches a team of the club, and would hold a closed word only through that team role, cannot put it into a custom", async () => {
  const w = await world();
  await setModule(w.pa, w.club, "tests", "close");
  await makeVersion(w.pa, w.club, ROLE_IDS.club_admin, { remove: ["tests.view", "tests.results.view"] });
  await F.grantTeam(w.admin, w.team);
  assert.equal(await one(`select exists (select 1 from public.permission_user_holdings($1) h where h.scope_type = 'team' and h.scope_id = $2 and 'tests.view' = any (h.words)) as x`, [w.admin, w.team]).then((r) => r.x), true,
    "the admin holds tests.view through the team role");
  assert.equal(await holdsInClub(w.admin, "tests.view", w.club), false, "a team holding never counts for the club");
  await refused(makeCustom(w.admin, w.coach, w.team, w.club, { remove: ["athletes.manage"] }), "42501");
});

test("4. unchanged: an open word the admin does not hold is refused; a platform admin is never limited; another club's admin and an inactive one hold nothing", async () => {
  const w = await world();
  // The club gives up athletes.remove in Team coach and Club admin (a platform admin's versions).
  await makeVersion(w.pa, w.club, ROLE_IDS.team_coach, { remove: ["athletes.remove"] });
  const caVersion = await makeVersion(w.pa, w.club, ROLE_IDS.club_admin, { remove: ["athletes.remove"] });
  assert.ok(caVersion);
  assert.equal(await holdsInClub(w.admin, "athletes.remove", w.club), false, "an open module: the twin alone");
  await refused(makeCustom(w.admin, w.coach, w.team, w.club, { add: ["athletes.remove"] }), "42501");
  await setModule(w.pa, w.club, "tests", "close");
  await makeCustom(w.pa, w.coach, w.team, w.club, { add: ["athletes.remove"] });
  const other = await world();
  assert.equal(await holdsInClub(other.admin, "tests.view", w.club), false, "another club's admin");
  await k.query(`update public.users set is_active = false where id = $1`, [w.admin]);
  assert.equal(await holdsInClub(w.admin, "tests.view", w.club), false, "an inactive user");
  assert.equal(await holdsInClub(w.pa, "tests.view", w.club), true, "a platform admin");
});
