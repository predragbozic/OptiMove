// Roles R4-1 through the real routes (docs/ai/roles-r4-contract.md 4, 7.6, 8 and 14): the Roles API of R2 on v92 -
// the club's ceiling lock as the first lock after the request-key lock on every club-scope write, never on a system
// role's write; unchecked words locked (O6) in every role kind; a copy carries its source's items; the ceiling acting
// through can() on /me; the identical 404 for another club. Disposable database, the real server.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { asActor, buildDatabase, fixtures, key, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const R = "/api/organization/roles";
const VIEW = ["athletes.view", "calendar.view", "dashboards.view", "exercises.use", "load.view.athlete", "load.view.team",
  "presets.use", "programs.view", "tests.results.view", "tests.view", "variables.view"];
let db, k, F, srv, svc;
before(async () => {
  db = await buildDatabase({ label: "r4api", upTo: "all" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
  srv = await startServer(db.url);
  svc = await import("../src/permissionRolesService.js");
});
after(async () => {
  svc?.setRolesStatementRecorderForTests(null);
  await srv?.stop();
  await k?.end().catch(() => {});
  await db?.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const code = (res, status, error) => { assert.equal(res.status, status, res.text); assert.equal(res.body.error, error, res.text); return res.body; };
const hex = () => crypto.randomBytes(3).toString("hex");
async function world() {
  const w = { A: await F.club("A"), B: await F.club("B") };
  w.T1 = await F.team(w.A, "T1");
  const person = async (label, setup = async () => {}) => { const id = await F.user(label); await setup(id); return { id, cookie: await srv.cookieFor(id) }; };
  w.pa = await person("pa", (id) => F.grantPlatform(id));
  w.adminA = await person("adminA", (id) => F.grantClub(id, w.A));
  w.adminB = await person("adminB", (id) => F.grantClub(id, w.B));
  w.coach = await person("coach", (id) => F.grantTeam(id, w.T1));
  w.target = await person("target");
  return w;
}
const createRole = (who, body) => srv.api(who.cookie, R, { method: "POST", body: { requestKey: key(), scopeTypes: ["club", "team"], items: ["org.view"], name: `Role ${hex()}`, ...body } });
const change = (who, roleId, body) => srv.api(who.cookie, `${R}/${roleId}/change`, { method: "POST", body: { requestKey: key(), reason: "Change", ...body } });
const revision = async (roleId) => (await one(`select revision from public.permission_roles where id = $1`, [roleId])).revision;
async function recorded(fn) {
  const seen = [];
  svc.setRolesStatementRecorderForTests((t, params) => seen.push({ t, params }));
  try { return { res: await fn(), seen }; } finally { svc.setRolesStatementRecorderForTests(null); }
}
const ROW_LOCK = /\bfor (update|no key update|share|key share)\b|lock_permission_actor/i;
const WRITE = /^(insert|update|delete)\b/i;

test("1. every club-scope write takes the club's ceiling lock, shared, right after the request-key lock and before every row lock; a system role's write takes none", async () => {
  const w = await world();
  const steps = [];
  const c1 = await recorded(() => createRole(w.adminA, { clubId: w.A })); const role = ok(c1.res).role; steps.push(["create", c1.seen, w.A]);
  const c2 = await recorded(() => change(w.adminA, role.id, { expectedRevision: 1, name: `C ${hex()}` })); ok(c2.res); steps.push(["change", c2.seen, w.A]);
  const c3 = await recorded(() => srv.api(w.adminA.cookie, `${R}/${ROLE_IDS.team_coach}/copy`, { method: "POST", body: { requestKey: key(), clubId: w.A, name: `Copy ${hex()}` } }));
  const copy = ok(c3.res).role; steps.push(["copy", c3.seen, w.A]);
  const c4 = await recorded(() => srv.api(w.adminA.cookie, `${R}/assignments`, { method: "POST", body: { requestKey: key(), reason: "Needed", userId: w.target.id, roleId: role.id, scopeType: "team", scopeId: w.T1 } }));
  const assignment = ok(c4.res).assignment; steps.push(["grant (team scope)", c4.seen, w.A]);
  const c5 = await recorded(() => srv.api(w.adminA.cookie, `${R}/assignments/${assignment.id}/revoke`, { method: "POST", body: { requestKey: key(), reason: "Done", expected: { userId: w.target.id, roleId: role.id } } }));
  ok(c5.res); steps.push(["revoke", c5.seen, w.A]);
  const c6 = await recorded(() => srv.api(w.adminA.cookie, `${R}/${role.id}/archive`, { method: "POST", body: { requestKey: key(), expectedRevision: 2, reason: "Done" } }));
  ok(c6.res); steps.push(["archive", c6.seen, w.A]);
  for (const [name, seen, club] of steps) {
    const texts = seen.map((s) => s.t);
    const requestKeyLock = texts.findIndex((t) => /hashtextextended\('permission_request:'/.test(t));
    const ceiling = texts.findIndex((t) => /lock_club_ceiling/.test(t));
    const firstRow = texts.findIndex((t) => ROW_LOCK.test(t));
    const firstWrite = texts.findIndex((t) => WRITE.test(t));
    assert.ok(requestKeyLock >= 0 && ceiling > requestKeyLock, `${name}: the ceiling lock after the request-key lock\n${texts.join("\n")}`);
    assert.ok(firstRow > ceiling && firstWrite > ceiling, `${name}: the ceiling lock before every row lock and write\n${texts.join("\n")}`);
    assert.equal(texts.filter((t) => /lock_club_ceiling/.test(t)).length, 1, `${name}: one ceiling lock`);
    assert.deepEqual(seen[ceiling].params, [[club], "shared"], name);
  }
  // A system role (global scope) takes no club lock.
  const tcRev = await revision(ROLE_IDS.team_coach);
  const s1 = await recorded(() => change(w.pa, ROLE_IDS.team_coach, { expectedRevision: tcRev, name: `Team coach ${hex()}` }));
  ok(s1.res);
  assert.ok(!s1.seen.some((s) => /lock_club_ceiling/.test(s.t)));
  ok(await change(w.pa, ROLE_IDS.team_coach, { expectedRevision: await revision(ROLE_IDS.team_coach), name: "Team coach" }));
  // R2's copy keeps only checked words: the seeded view words not checked yet are dropped and named "not available yet"
  // (roles V-1 checks variables.view and presets.use, roles V-2 athletes.view, roles V-3 calendar.view, roles V-4
  // tests.view and tests.results.view, so the copy keeps them).
  const CHECKED_VIEW = ["athletes.view", "calendar.view", "dashboards.view", "exercises.use", "load.view.athlete", "load.view.team", "presets.use", "programs.view", "tests.results.view", "tests.view", "variables.view"];
  assert.deepEqual([...copy.items].sort(), ["athletes.manage", "athletes.remove", "calendar.events.manage", "dashboards.manage", "exercises.add", "exercises.remove", "load.activities.manage", "load.estimates.manage", "load.roster.decide", "load.schedule.manage", "org.view", "programs.edit", "programs.rpe_settings", ...CHECKED_VIEW].sort());
  const dropped = ok(c3.res).dropped;
  assert.deepEqual(dropped.filter((d) => d.reason === "not_available_yet").map((d) => d.word).sort(), VIEW.filter((v) => !CHECKED_VIEW.includes(v)));
});

test("2. V-5b: the two Training Load words can be delegated and are marked checked in the catalog", async () => {
  const w = await world();
  const role = ok(await createRole(w.adminA, { clubId: w.A })).role;
  assert.ok(ok(await createRole(w.adminA, { clubId: w.A, items: ["org.view", "load.view.athlete"] })).role.items.includes("load.view.athlete"));
  ok(await change(w.adminA, role.id, { expectedRevision: 1, items: ["org.view", "load.view.team"] }));
  const copy = ok(await srv.api(w.adminA.cookie, `${R}/${ROLE_IDS.team_coach}/copy`, { method: "POST", body: { requestKey: key(), clubId: w.A, name: `Copy ${hex()}` } })).role;
  assert.ok(copy.items.includes("load.view.team"));
  ok(await change(w.adminA, copy.id, { expectedRevision: copy.revision, items: copy.items.filter((x) => x !== "athletes.remove") }));
  const sys = ok(await createRole(w.pa, { name: `System ${hex()}`, scopeTypes: ["club"], items: ["org.view"] })).role;
  // A word that is not storable keeps R2's code.
  code(await change(w.pa, sys.id, { expectedRevision: 1, items: ["org.view", "import.check"] }), 409, "permission_not_honoured");
  // The catalog read tells the screen which words are checked.
  const cat = ok(await srv.api(w.adminA.cookie, `${R}/catalog?clubId=${w.A}`));
  const byWord = Object.fromEntries(cat.permissions.map((p) => [p.word, p]));
  assert.equal(byWord["load.view.team"].storable, true);
  assert.equal(byWord["load.view.team"].checked, true);
  assert.equal(byWord["load.view.athlete"].checked, true);
  assert.equal(byWord["athletes.view"].checked, true);
  assert.equal(byWord["athletes.manage"].checked, true);
});

test("3. the ceiling acts through can(): a closed module disappears from /me for the club's admin and coach, never for a platform admin, and comes back when reopened", async () => {
  const w = await world();
  const me = async (who, ws) => {
    ok(await srv.api(who.cookie, "/api/auth/workspace", { method: "PUT", body: ws }));
    return ok(await srv.api(who.cookie, "/api/auth/me")).user.permissions;
  };
  const before = { admin: await me(w.adminA, { type: "club", scopeId: w.A }), coach: await me(w.coach, { type: "team", scopeId: w.T1 }) };
  assert.ok(before.admin.includes("athletes.manage") && before.coach.includes("athletes.remove"));
  const write = async (sql) => {
    const c = new pg.Client({ connectionString: db.url }); await c.connect();
    try {
      await c.query("begin");
      await c.query(`select set_config('optimove.permission_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [w.pa.id]);
      await c.query(`select public.lock_club_ceiling($1::uuid[], 'exclusive')`, [[w.A]]);
      await c.query(sql[0], [w.A, w.pa.id]);
      await c.query(sql[1], [w.A, w.pa.id]);
      await c.query("commit");
    } finally { await c.end(); }
  };
  await write([`insert into public.club_permission_ceiling (club_id, module_word, closed_by_user_id, reason) values ($1, 'athletes', $2, 'licence')`,
    `insert into public.club_permission_ceiling_changes (club_id, module_word, action, performed_by_user_id, reason) values ($1, 'athletes', 'close', $2, 'licence')`]);
  const closed = { admin: await me(w.adminA, { type: "club", scopeId: w.A }), coach: await me(w.coach, { type: "team", scopeId: w.T1 }) };
  assert.ok(!closed.admin.some((x) => x.startsWith("athletes.")), closed.admin.join());
  assert.ok(!closed.coach.some((x) => x.startsWith("athletes.")), closed.coach.join());
  assert.ok(closed.admin.includes("org.view") && closed.admin.includes("staff.assign"));
  const { loadAuthorizationContext } = await import("../src/authz.js");
  const { can, clubScope } = await import("../src/permissions.js");
  assert.equal(can(await loadAuthorizationContext({ id: w.pa.id, role_hint: null }), "athletes.manage", clubScope(w.A)), true, "a platform admin is never limited");
  await write([`delete from public.club_permission_ceiling where club_id = $1 and module_word = 'athletes' and $2::uuid is not null`,
    `insert into public.club_permission_ceiling_changes (club_id, module_word, action, performed_by_user_id, reason) values ($1, 'athletes', 'open', $2, 'licence')`]);
  assert.deepEqual(await me(w.adminA, { type: "club", scopeId: w.A }), before.admin);
  assert.deepEqual(await me(w.coach, { type: "team", scopeId: w.T1 }), before.coach);
});

test("4. info hiding stays: another club's admin changing a club role answers the identical 404 and takes no club lock", async () => {
  const w = await world();
  const role = ok(await createRole(w.adminA, { clubId: w.A })).role;
  const r = await recorded(() => change(w.adminB, role.id, { expectedRevision: 1, name: `X ${hex()}` }));
  assert.equal(r.res.status, 404);
  assert.deepEqual(r.res.body, { error: "notFound" });
  assert.ok(!r.seen.some((s) => /lock_club_ceiling/.test(s.t)), "the 404 gate runs before any lock (N5)");
  const random = await change(w.adminB, crypto.randomUUID(), { expectedRevision: 1, name: `X ${hex()}` });
  assert.equal(random.status, 404);
  assert.deepEqual(random.body, r.res.body);
});

test("5. H4 through R2's change route (R4-3): a word added to a default the club follows is added to its own Club admin version (default_follow); removing a word from the default Club admin that a club's version still gives answers 409 club_admin_would_lack", async () => {
  const w = await world();
  // Club A gives up athletes.remove: its Team coach version, then its own Club admin version (planted as R4-3 will write them).
  const plant = (roleId) => asActor(db.url, w.pa.id, async (c) => {
    await c.query(`select public.lock_club_ceiling($1::uuid[], 'exclusive')`, [[w.A]]);
    const rev = (await c.query(`select revision from public.permission_roles where id = $1`, [roleId])).rows[0].revision;
    const id = (await c.query(`insert into public.permission_club_role_versions (club_id, system_role_id, based_on_revision, answered_revision, created_by_user_id) values ($1, $2, $3, $3, $4) returning id`, [w.A, roleId, rev, w.pa.id])).rows[0].id;
    const words = (await c.query(`select array(select permission_word from public.permission_role_items where role_id = $1 and permission_word <> 'athletes.remove') as w`, [roleId])).rows[0].w;
    for (const x of words) await c.query(`insert into public.permission_club_role_version_items (version_id, permission_word) values ($1, $2)`, [id, x]);
    await c.query(`insert into public.permission_club_role_version_changes (version_id, revision_after, kind, performed_by_user_id, basis, reason, items_added) values ($1, 1, 'create', $2, 'platform_admin', 'licence', $3)`, [id, w.pa.id, words]);
  });
  await plant(ROLE_IDS.team_coach);
  await plant(ROLE_IDS.club_admin);
  const sys = ok(await createRole(w.pa, { name: `Analyst ${hex()}`, scopeTypes: ["club"], items: ["org.view"] })).role;
  const caVersion = async () => one(`select v.id, v.revision, array(select i.permission_word from public.permission_club_role_version_items i where i.version_id = v.id order by 1) as items
      from public.permission_club_role_versions v where v.club_id = $1 and v.system_role_id = $2 and v.ended_at is null`, [w.A, ROLE_IDS.club_admin]);
  assert.ok(!(await caVersion()).items.includes("athletes.remove"));
  const res = ok(await change(w.pa, sys.id, { expectedRevision: 1, items: ["org.view", "athletes.remove"] }));
  assert.deepEqual(res.clubsTouched.filter((c) => c.clubId === w.A), [{ clubId: w.A, wordsAdded: ["athletes.remove"] }]);
  const after = await caVersion();
  assert.ok(after.items.includes("athletes.remove"));
  assert.equal(after.revision, 2);
  assert.equal((await one(`select kind, basis from public.permission_club_role_version_changes where version_id = $1 and revision_after = 2`, [after.id])).kind, "default_follow");
  ok(await srv.api(w.pa.cookie, `${R}/${sys.id}/archive`, { method: "POST", body: { requestKey: key(), expectedRevision: 2, reason: "Done" } }));
  // N4: club B follows the default Club admin and has its own version of a club-scope system role that holds
  // org.club.edit; taking org.club.edit from the default Club admin would leave B's admin short.
  const sys2 = ok(await createRole(w.pa, { name: `Secretary ${hex()}`, scopeTypes: ["club"], items: ["org.view"] })).role;
  await asActor(db.url, w.pa.id, async (c) => {
    await c.query(`select public.lock_club_ceiling($1::uuid[], 'exclusive')`, [[w.B]]);
    const id = (await c.query(`insert into public.permission_club_role_versions (club_id, system_role_id, based_on_revision, answered_revision, created_by_user_id) values ($1, $2, 1, 1, $3) returning id`, [w.B, sys2.id, w.pa.id])).rows[0].id;
    for (const x of ["org.club.edit", "org.view"]) await c.query(`insert into public.permission_club_role_version_items (version_id, permission_word) values ($1, $2)`, [id, x]);
    await c.query(`insert into public.permission_club_role_version_changes (version_id, revision_after, kind, performed_by_user_id, basis, reason, items_added) values ($1, 1, 'create', $2, 'platform_admin', 'licence', $3)`, [id, w.pa.id, ["org.club.edit", "org.view"]]);
  });
  const caItems = (await one(`select array(select permission_word from public.permission_role_items where role_id = $1 order by 1) as w`, [ROLE_IDS.club_admin])).w;
  const caRev = await revision(ROLE_IDS.club_admin);
  const refused = code(await change(w.pa, ROLE_IDS.club_admin, { expectedRevision: caRev, items: caItems.filter((x) => x !== "org.club.edit") }), 409, "club_admin_would_lack");
  assert.equal(typeof refused.message, "string");
  assert.equal(await revision(ROLE_IDS.club_admin), caRev, "nothing written");
  ok(await srv.api(w.pa.cookie, `${R}/${sys2.id}/archive`, { method: "POST", body: { requestKey: key(), expectedRevision: 1, reason: "Done" } }));
});
