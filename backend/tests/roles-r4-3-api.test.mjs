// Roles R4-3 through the real routes (docs/ai/roles-r4-contract.md sections 3.3-3.5, 7.6, 9, 10, 14): the club's
// ceiling (a platform admin's licence), the club's own versions of system roles with the O3 question, the custom
// roles of one user bound to one holding, drift and "Take it from them too", the identical 404, the request-key
// replay and the uncertain COMMIT, the recorded lock order, and the route-against-route races of 7.6.
// Disposable database, the real server.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { buildDatabase, fixtures, key, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const R = "/api/organization/roles";
let db, k, F, srv, svc;
before(async () => {
  db = await buildDatabase({ label: "r43api", upTo: "all" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
  srv = await startServer(db.url);
  svc = await import("../src/permissionRolesService.js");
});
after(async () => {
  svc?.setRolesStatementRecorderForTests(null);
  svc?.setRolesWriteHoldForTests(null);
  svc?.setRolesBeforeLocksHoldForTests(null);
  svc?.setRolesCommitForTests();
  await srv?.stop();
  await k?.end().catch(() => {});
  await db?.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const code = (res, status, error) => { assert.equal(res.status, status, res.text); assert.equal(res.body.error, error, res.text); return res.body; };
const notFound = (res) => { assert.equal(res.status, 404, res.text); assert.deepEqual(res.body, { error: "notFound" }); };
const hex = () => crypto.randomBytes(3).toString("hex");
const holds = async (userId, word, type, id) => (await one(`select public.user_has_permission($1, $2, $3, $4) as ok`, [userId, word, type, id])).ok;
const revision = async (roleId) => (await one(`select revision from public.permission_roles where id = $1`, [roleId])).revision;
const itemsOf = async (roleId) => (await one(`select array(select permission_word from public.permission_role_items where role_id = $1 order by 1) as w`, [roleId])).w;

async function world() {
  const w = { A: await F.club("A"), B: await F.club("B") };
  w.T1 = await F.team(w.A, "T1");
  w.T2 = await F.team(w.A, "T2");
  w.TB = await F.team(w.B, "TB");
  const person = async (label, setup = async () => {}) => { const id = await F.user(label); await setup(id); return { id, cookie: await srv.cookieFor(id) }; };
  w.pa = await person("pa", (id) => F.grantPlatform(id));
  w.adminA = await person("adminA", (id) => F.grantClub(id, w.A));
  w.adminA2 = await person("adminA2", (id) => F.grantClub(id, w.A));
  w.adminB = await person("adminB", (id) => F.grantClub(id, w.B));
  w.coach = await person("coach", (id) => F.grantTeam(id, w.T1));
  w.coachB = await person("coachB", (id) => F.grantTeam(id, w.TB));
  w.target = await person("target");
  return w;
}
const ceiling = (who, clubId, body) => srv.api(who.cookie, `${R}/clubs/${clubId}/ceiling`, { method: "POST", body: { requestKey: key(), reason: "Licence", ...body } });
const version = (who, roleId, clubId, body) => srv.api(who.cookie, `${R}/${roleId}/clubs/${clubId}/version`, { method: "POST", body: { requestKey: key(), reason: "Our coaches", ...body } });
const answer = (who, roleId, clubId, body) => srv.api(who.cookie, `${R}/${roleId}/clubs/${clubId}/version/answer`, { method: "POST", body: { requestKey: key(), ...body } });
const custom = (who, userId, clubId, body) => srv.api(who.cookie, `${R}/users/${userId}/clubs/${clubId}/custom`, { method: "POST", body: { requestKey: key(), reason: "Only this one", ...body } });
const endCustom = (who, userId, customId, body = {}) => srv.api(who.cookie, `${R}/users/${userId}/custom/${customId}/end`, { method: "POST", body: { requestKey: key(), reason: "Back to the role", ...body } });
const roleChange = (who, roleId, body) => srv.api(who.cookie, `${R}/${roleId}/change`, { method: "POST", body: { requestKey: key(), reason: "Default change", ...body } });
const clubRoles = async (who, clubId) => ok(await srv.api(who.cookie, `${R}/clubs/${clubId}/roles`));
const tcIn = async (who, clubId) => (await clubRoles(who, clubId)).systemRoles.find((r) => r.roleId === ROLE_IDS.team_coach);

async function recorded(fn) {
  const seen = [];
  svc.setRolesStatementRecorderForTests((t, params) => seen.push({ t, params }));
  try { return { res: await fn(), seen }; } finally { svc.setRolesStatementRecorderForTests(null); }
}
const ROW_LOCK = /\bfor (update|no key update|share|key share)\b|lock_permission_actor/i;
const LOCKING = /\bfor (update|no key update|share|key share)\b|lock_permission_actor|lock_club_ceiling|pg_advisory/i;
const WRITE = /^(insert|update|delete)\b/i;
function assertLockOrder(name, seen, club, mode) {
  const texts = seen.map((s) => s.t);
  const requestKeyLock = texts.findIndex((t) => /hashtextextended\('permission_request:'/.test(t));
  const ceilingAt = texts.findIndex((t) => /lock_club_ceiling/.test(t));
  const firstRow = texts.findIndex((t) => ROW_LOCK.test(t));
  const firstWrite = texts.findIndex((t) => WRITE.test(t));
  assert.ok(requestKeyLock >= 0 && ceilingAt > requestKeyLock, `${name}: the ceiling lock after the request-key lock\n${texts.join("\n")}`);
  assert.ok(firstRow > ceilingAt && firstWrite > ceilingAt, `${name}: the ceiling lock before every row lock and write\n${texts.join("\n")}`);
  assert.equal(texts.filter((t) => /lock_club_ceiling/.test(t)).length, 1, `${name}: one ceiling lock`);
  assert.deepEqual(seen[ceilingAt].params, [[club], mode], name);
  // Every lock before the first write (.claude/rules/migrations.md): no locking clause between it and the COMMIT.
  const late = texts.slice(firstWrite).filter((t) => LOCKING.test(t));
  assert.deepEqual(late, [], `${name}: no lock after the first write`);
}

// A hold that stops only the first write that reaches it (the second request passes freely).
function holdFirst(setter) {
  let release;
  const gate = new Promise((r) => { release = r; });
  let reachedResolve;
  const reached = new Promise((r) => { reachedResolve = r; });
  let used = false;
  setter(async () => { if (used) return; used = true; reachedResolve(); await gate; });
  return { reached, release: () => { release(); setter(null); } };
}
// Waits for the hold, or fails at once when the held request finished before reaching it (never a hang).
async function reachedOr(hold, request) {
  const early = await Promise.race([hold.reached.then(() => null), request]);
  if (early) { hold.release(); throw new Error(`the held request finished early: ${early.status} ${early.text}`); }
}
// Waits until some backend of this database waits on a lock.
async function someoneWaits(ms = 4_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const n = (await one(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)).n;
    if (n > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test("1. the ceiling: a platform admin closes and opens a module; the club's admin reads it without who and why; replay, reuse, unchanged, organization, the identical 404", async () => {
  const w = await world();
  const k1 = key();
  const closed = ok(await srv.api(w.pa.cookie, `${R}/clubs/${w.A}/ceiling`, { method: "POST", body: { requestKey: k1, close: ["athletes"], reason: "Licence" } }));
  assert.deepEqual(closed.closed, ["athletes"]);
  assert.equal(closed.modules.find((m) => m.module === "athletes").closed, true);
  assert.equal(await holds(w.coach.id, "athletes.remove", "team", w.T1), false, "the ceiling acts at once");
  assert.equal(await holds(w.adminA.id, "athletes.manage", "club", w.A), false);
  // The same key and body: the current state, written once.
  const again = ok(await srv.api(w.pa.cookie, `${R}/clubs/${w.A}/ceiling`, { method: "POST", body: { requestKey: k1, close: ["athletes"], reason: "Licence" } }));
  assert.equal(again.replayed, true);
  assert.equal((await one(`select count(*)::int as n from public.club_permission_ceiling_changes where club_id = $1`, [w.A])).n, 1);
  code(await srv.api(w.pa.cookie, `${R}/clubs/${w.A}/ceiling`, { method: "POST", body: { requestKey: k1, close: ["calendar"], reason: "Licence" } }), 409, "request_key_reused");
  code(await ceiling(w.pa, w.A, { close: ["athletes"] }), 409, "ceiling_unchanged");
  code(await ceiling(w.pa, w.A, { close: ["organization"] }), 409, "module_not_closable");
  code(await ceiling(w.pa, w.A, { close: ["nope"] }), 400, "invalid_request");
  // The club's admin reads the licence (Q2) without the reason and who; a platform admin with them.
  const asAdmin = ok(await srv.api(w.adminA.cookie, `${R}/clubs/${w.A}/ceiling`));
  const a = asAdmin.modules.find((m) => m.module === "athletes");
  assert.equal(a.closed, true);
  assert.ok(!("reason" in a) && !("history" in asAdmin));
  assert.equal(a.ceilingEffective, true, "athletes.manage acts (Q12)");
  assert.equal(asAdmin.modules.find((m) => m.module === "calendar").ceilingEffective, false, "calendar's words act nowhere yet");
  const asPa = ok(await srv.api(w.pa.cookie, `${R}/clubs/${w.A}/ceiling`));
  assert.equal(asPa.modules.find((m) => m.module === "athletes").reason, "Licence");
  assert.equal(asPa.history.length, 1);
  // Everyone else: the identical 404 (a write by the club's own admin, another club's admin, a coach, a random club).
  const byAdmin = await recorded(() => ceiling(w.adminA, w.A, { open: ["athletes"] }));
  notFound(byAdmin.res);
  assert.deepEqual(byAdmin.seen, [], "the 404 gate runs before the transaction: no lock taken or waited on (N5)");
  notFound(await srv.api(w.adminB.cookie, `${R}/clubs/${w.A}/ceiling`));
  notFound(await srv.api(w.coach.cookie, `${R}/clubs/${w.A}/ceiling`));
  notFound(await srv.api(w.pa.cookie, `${R}/clubs/${crypto.randomUUID()}/ceiling`));
  notFound(await ceiling(w.pa, crypto.randomUUID(), { close: ["athletes"] }));
  // Open again: exactly the earlier answers come back (O1).
  const opened = ok(await ceiling(w.pa, w.A, { open: ["athletes"] }));
  assert.deepEqual(opened.opened, ["athletes"]);
  assert.equal(await holds(w.coach.id, "athletes.remove", "team", w.T1), true);
});

test("2. a club version: made by the club's admin's first change, acting for an old-table coach and an assignment; expectedRevision, O6, Club admin (Q3), H1, the ceiling, the identical 404", async () => {
  const w = await world();
  // A club role assignment of the system role is not possible (basic); an old-table coach is the holder here.
  code(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: 1, remove: ["athletes.remove"] }), 409, "version_changed");
  const made = ok(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: null, remove: ["athletes.remove"] }));
  assert.equal(made.role.state, "own_version");
  assert.equal(made.role.version.revision, 1);
  assert.ok(!made.role.effectiveItems.includes("athletes.remove"));
  assert.equal(await holds(w.coach.id, "athletes.remove", "team", w.T1), false, "every holder in club A");
  assert.equal(await holds(w.coachB.id, "athletes.remove", "team", w.TB), true, "club B follows the default");
  code(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: null, add: ["athletes.remove"] }), 409, "version_changed");
  code(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: 7, add: ["athletes.remove"] }), 409, "version_changed");
  // O6: an unchecked word is neither added nor taken away; a word not in the set cannot be removed.
  code(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: 1, remove: ["calendar.view"] }), 409, "permission_not_available_yet");
  code(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: 1, remove: ["athletes.remove"] }), 400, "invalid_request");
  const back = ok(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: 1, add: ["athletes.remove"] }));
  assert.equal(back.role.version.revision, 2);
  assert.equal(await holds(w.coach.id, "athletes.remove", "team", w.T1), true);
  // Q3: the club's admin never versions Club admin; a platform admin may, and never without staff.assign (H1).
  code(await version(w.adminA, ROLE_IDS.club_admin, w.A, { expectedRevision: null, remove: ["athletes.remove"] }), 409, "admin_not_narrowable");
  code(await version(w.pa, ROLE_IDS.club_admin, w.A, { expectedRevision: null, remove: ["staff.assign"] }), 409, "club_admin_requires");
  // Rule 7 inside the club: Club admin's own version may not lack what Team coach's version gives.
  code(await version(w.pa, ROLE_IDS.club_admin, w.A, { expectedRevision: null, remove: ["athletes.remove"] }), 409, "club_admin_would_lack");
  // The ceiling: a word of a closed module is added by nobody; the closed words a set already carries do not block a
  // change by the club's admin (v95: it would hold them the moment the module opens).
  ok(await ceiling(w.pa, w.A, { close: ["athletes"] }));
  const carried = ok(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: 2, remove: ["org.view"] }));
  assert.ok(carried.role.effectiveItems.includes("athletes.manage") && !carried.role.effectiveItems.includes("org.view"));
  ok(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: 3, add: ["org.view"] }));
  const sysRole = ok(await srv.api(w.pa.cookie, R, { method: "POST", body: { requestKey: key(), name: `Clerk ${hex()}`, scopeTypes: ["club"], items: ["org.view"] } })).role;
  try {
    const refused = code(await version(w.pa, sysRole.id, w.A, { expectedRevision: null, add: ["athletes.manage"] }), 409, "closed_by_club_ceiling");
    assert.deepEqual(refused.words, ["athletes.manage"], "a closed word is added by nobody, a platform admin included");
  } finally {
    ok(await srv.api(w.pa.cookie, `${R}/${sysRole.id}/archive`, { method: "POST", body: { requestKey: key(), expectedRevision: 1, reason: "Done" } }));
  }
  ok(await ceiling(w.pa, w.A, { open: ["athletes"] }));
  // The identical 404: another club's admin, a coach, a club's own role, Platform admin, Independent coach, a random id.
  notFound(await version(w.adminB, ROLE_IDS.team_coach, w.A, { expectedRevision: 2, remove: ["athletes.remove"] }));
  notFound(await version(w.coach, ROLE_IDS.team_coach, w.A, { expectedRevision: 2, remove: ["athletes.remove"] }));
  for (const id of [ROLE_IDS.platform_admin, ROLE_IDS.independent_coach, crypto.randomUUID()]) notFound(await version(w.adminA, id, w.A, { expectedRevision: null, remove: ["athletes.remove"] }));
  const clubRole = ok(await srv.api(w.adminA.cookie, R, { method: "POST", body: { requestKey: key(), clubId: w.A, name: `Helper ${hex()}`, scopeTypes: ["team"], items: ["org.view"] } })).role;
  notFound(await version(w.adminA, clubRole.id, w.A, { expectedRevision: null, add: ["athletes.manage"] }));
  // The read: org.view holders of the club; the club's roles listed beside the system roles.
  const roles = await clubRoles(w.adminA, w.A);
  assert.ok(roles.clubRoles.some((r) => r.roleId === clubRole.id));
  assert.equal(roles.systemRoles.find((r) => r.roleId === ROLE_IDS.club_admin).actions.change, false);
  notFound(await srv.api(w.adminB.cookie, `${R}/clubs/${w.A}/roles`));
  notFound(await srv.api(w.target.cookie, `${R}/clubs/${w.A}/roles`));
});

test("3. the O3 question: a default change after the club's version asks once with the difference; keep_mine, question_outdated, accept_default", async () => {
  const w = await world();
  ok(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: null, remove: ["athletes.remove"] }));
  const tcItems = await itemsOf(ROLE_IDS.team_coach);
  const rev0 = await revision(ROLE_IDS.team_coach);
  try {
    ok(await roleChange(w.pa, ROLE_IDS.team_coach, { expectedRevision: rev0, items: tcItems.filter((x) => x !== "athletes.manage") }));
    const q = await tcIn(w.adminA, w.A);
    assert.equal(q.state, "question_pending");
    assert.deepEqual(q.question.defaultChanges, { added: [], removed: ["athletes.manage"] });
    assert.equal((await tcIn(w.adminB, w.B)).state, "follows_default", "no question without a version");
    code(await answer(w.adminA, ROLE_IDS.team_coach, w.A, { systemRevision: rev0, choice: "keep_mine" }), 409, "question_outdated");
    code(await answer(w.adminA, ROLE_IDS.team_coach, w.A, { systemRevision: rev0 + 1, choice: "maybe" }), 400, "invalid_request");
    const kept = ok(await answer(w.adminA, ROLE_IDS.team_coach, w.A, { systemRevision: rev0 + 1, choice: "keep_mine" }));
    assert.equal(kept.role.state, "own_version");
    assert.equal(kept.role.version.answeredRevision, rev0 + 1);
    assert.equal(await holds(w.coach.id, "athletes.manage", "team", w.T1), true, "the club kept its own set");
    code(await answer(w.adminA, ROLE_IDS.team_coach, w.A, { systemRevision: rev0 + 1, choice: "keep_mine" }), 409, "question_outdated");
    // The default changes again: the question comes back (Q6), with the difference since the last answer only.
    ok(await roleChange(w.pa, ROLE_IDS.team_coach, { expectedRevision: rev0 + 1, items: tcItems }));
    assert.deepEqual((await tcIn(w.adminA, w.A)).question.defaultChanges, { added: ["athletes.manage"], removed: [] });
    const accepted = ok(await answer(w.adminA, ROLE_IDS.team_coach, w.A, { systemRevision: rev0 + 2, choice: "accept_default" }));
    assert.equal(accepted.role.state, "follows_default");
    assert.equal(await holds(w.coach.id, "athletes.remove", "team", w.T1), true, "the club follows the default again");
    notFound(await answer(w.adminB, ROLE_IDS.team_coach, w.A, { systemRevision: rev0 + 2, choice: "keep_mine" }));
  } finally {
    const now = await revision(ROLE_IDS.team_coach);
    if (JSON.stringify(await itemsOf(ROLE_IDS.team_coach)) !== JSON.stringify(tcItems)) ok(await roleChange(w.pa, ROLE_IDS.team_coach, { expectedRevision: now, items: tcItems }));
  }
});

test("4. a custom role of an old-table coach: frozen, live only through its holding (copied in SQL), the user view, the (custom) mark, custom_exists / custom_changed, O5, self, the identical 404", async () => {
  const w = await world();
  const made = ok(await custom(w.adminA, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: null, remove: ["athletes.remove"] }));
  assert.equal(made.custom.name, "Team coach (custom)");
  assert.deepEqual(made.custom.removed, ["athletes.remove"]);
  assert.equal(made.custom.frozenFrom.kind, "default");
  assert.equal(await holds(w.coach.id, "athletes.remove", "team", w.T1), false, "a word taken away really does not act");
  assert.equal(await holds(w.coach.id, "athletes.manage", "team", w.T1), true);
  // The holding version is exactly the row's updated_at (never a JavaScript Date round trip).
  assert.equal((await one(`select c.holding_row_version = r.updated_at as same from public.permission_custom_roles c join public.user_team_roles r on r.id = c.holding_row_id where c.id = $1`, [made.custom.id])).same, true);
  assert.match(made.custom.holding.rowVersion, /\.\d{6}|:\d\d[+-]/);
  // Frozen: a later club version does not reach it.
  ok(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: null, remove: ["athletes.manage"] }));
  assert.equal(await holds(w.coach.id, "athletes.manage", "team", w.T1), true, "the custom beats the club version");
  code(await custom(w.adminA, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: null, add: ["athletes.remove"] }), 409, "custom_exists");
  code(await custom(w.adminA, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: 3, add: ["athletes.remove"] }), 409, "custom_changed");
  const changed = ok(await custom(w.adminA, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: 1, add: ["athletes.remove"] }));
  assert.equal(changed.custom.revision, 2);
  // The user view and the assignments list carry the custom.
  const view = ok(await srv.api(w.adminA.cookie, `${R}/users/${w.coach.id}/clubs/${w.A}`));
  const h = view.holdings.find((x) => x.roleId === ROLE_IDS.team_coach);
  assert.equal(h.custom.id, made.custom.id);
  assert.equal(h.displayName, "Team coach (custom)");
  assert.deepEqual(h.custom.added, ["athletes.manage"], "the difference from the club's version now");
  const list = ok(await srv.api(w.adminA.cookie, `${R}/assignments?clubId=${w.A}&userId=${w.coach.id}`));
  const row = list.assignments.find((x) => x.roleId === ROLE_IDS.team_coach);
  assert.equal(row.custom, true);
  assert.equal(row.displayName, "Team coach (custom)");
  // O5 / Q13: only a platform admin narrows an admin; nobody changes their own rights.
  code(await custom(w.adminA, w.adminA2.id, w.A, { roleId: ROLE_IDS.club_admin, scopeType: "club", scopeId: w.A, expectedRevision: null, remove: ["athletes.remove"] }), 409, "admin_not_narrowable");
  code(await custom(w.adminA, w.adminA.id, w.A, { roleId: ROLE_IDS.club_admin, scopeType: "club", scopeId: w.A, expectedRevision: null, remove: ["athletes.remove"] }), 409, "self_custom");
  const paMade = ok(await custom(w.pa, w.adminA2.id, w.A, { roleId: ROLE_IDS.club_admin, scopeType: "club", scopeId: w.A, expectedRevision: null, remove: ["org.club.edit"] }));
  assert.equal(await holds(w.adminA2.id, "org.club.edit", "club", w.A), false);
  code(await custom(w.pa, w.adminA2.id, w.A, { roleId: ROLE_IDS.club_admin, scopeType: "club", scopeId: w.A, expectedRevision: 1, remove: ["staff.assign"] }), 409, "club_admin_requires");
  code(await endCustom(w.adminA, w.adminA2.id, paMade.custom.id), 409, "admin_not_narrowable");
  // O5 reaches every role of a club admin, not only Club admin itself: adminA2 also coaches T1 (no database guard
  // knows this; the service is the only one).
  await F.grantTeam(w.adminA2.id, w.T1);
  code(await custom(w.adminA, w.adminA2.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: null, remove: ["athletes.remove"] }), 409, "admin_not_narrowable");
  const paTc = ok(await custom(w.pa, w.adminA2.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: null, remove: ["athletes.remove"] }));
  code(await srv.api(w.adminA.cookie, `${R}/${ROLE_IDS.team_coach}/clubs/${w.A}/custom-word-removal`, { method: "POST", body: { requestKey: key(), reason: "x", word: "org.view", customIds: [paTc.custom.id] } }), 409, "admin_not_narrowable");
  code(await endCustom(w.adminA, w.adminA2.id, paTc.custom.id), 409, "admin_not_narrowable");
  // A role the user does not hold there, another club's team, another club's admin, a random user: 404.
  notFound(await custom(w.adminA, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T2, expectedRevision: null, remove: ["athletes.remove"] }));
  notFound(await custom(w.adminA, w.coachB.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.TB, expectedRevision: null, remove: ["athletes.remove"] }));
  notFound(await custom(w.adminB, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: 2, remove: ["athletes.remove"] }));
  notFound(await custom(w.adminA, crypto.randomUUID(), w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: null, remove: ["athletes.remove"] }));
  notFound(await srv.api(w.adminB.cookie, `${R}/users/${w.coach.id}/clubs/${w.A}`));
  notFound(await srv.api(w.adminA.cookie, `${R}/users/${w.coachB.id}/clubs/${w.A}`));
  notFound(await srv.api(w.coach.cookie, `${R}/users/${w.coach.id}/clubs/${w.A}`));
  notFound(await endCustom(w.adminB, w.coach.id, made.custom.id));
  notFound(await endCustom(w.adminA, w.coachB.id, made.custom.id));
  // Back to the club's role.
  const ended = ok(await endCustom(w.adminA, w.coach.id, made.custom.id));
  assert.equal(ended.custom.endKind, "reassigned");
  assert.equal(await holds(w.coach.id, "athletes.manage", "team", w.T1), false, "the club version decides again");
  code(await endCustom(w.adminA, w.coach.id, made.custom.id), 409, "custom_changed");
});

test("5. liveness (7a): a revoke and a re-grant of the coach row through the real routes end the custom (role_ended); an R2 assignment revoked and given again: the stale custom is ended by the next write; still held through another role (Q14)", async () => {
  const w = await world();
  const made = ok(await custom(w.adminA, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: null, remove: ["athletes.remove"] }));
  assert.equal(await holds(w.coach.id, "athletes.remove", "team", w.T1), false);
  ok(await srv.api(w.adminA.cookie, `/api/organization/users/${w.coach.id}/team-roles/${w.T1}/team_coach`, { method: "DELETE" }));
  ok(await srv.api(w.adminA.cookie, `/api/organization/users/${w.coach.id}/team-roles/${w.T1}/team_coach`, { method: "PUT" }));
  assert.equal(await holds(w.coach.id, "athletes.remove", "team", w.T1), true, "the custom died with its holding");
  const row = await one(`select ended_at is not null as ended, end_kind from public.permission_custom_roles where id = $1`, [made.custom.id]);
  assert.deepEqual(row, { ended: true, end_kind: "role_ended" });
  assert.equal((await one(`select count(*)::int as n from public.permission_custom_role_changes where custom_role_id = $1 and kind = 'role_ended'`, [made.custom.id])).n, 1);
  // A new custom on the new holding.
  ok(await custom(w.adminA, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: null, remove: ["athletes.manage"] }));
  // An R2 club role held at club scope, which reaches T1 too.
  const helper = ok(await srv.api(w.adminA.cookie, R, { method: "POST", body: { requestKey: key(), clubId: w.A, name: `Helper ${hex()}`, scopeTypes: ["club", "team"], items: ["athletes.manage", "org.view"] } })).role;
  const grant = async () => ok(await srv.api(w.adminA.cookie, `${R}/assignments`, { method: "POST", body: { requestKey: key(), reason: "Needed", userId: w.coach.id, roleId: helper.id, scopeType: "club", scopeId: w.A } })).assignment;
  const a1 = await grant();
  // Q14: the team coach custom takes athletes.manage, the helper role still gives it.
  const view = ok(await srv.api(w.adminA.cookie, `${R}/users/${w.coach.id}/clubs/${w.A}`));
  const tc = view.holdings.find((x) => x.roleId === ROLE_IDS.team_coach);
  assert.deepEqual(tc.stillHeldThrough, [{ word: "athletes.manage", roles: [helper.name] }]);
  assert.equal(await holds(w.coach.id, "athletes.manage", "team", w.T1), true, "roles add up (Q14)");
  // A custom of the assignment, then the assignment revoked and given again: the old custom is dead at once and
  // ended ('reset') by the next custom write on that key.
  const c1 = ok(await custom(w.adminA, w.coach.id, w.A, { roleId: helper.id, scopeType: "club", scopeId: w.A, expectedRevision: null, remove: ["athletes.manage"] }));
  assert.equal(c1.custom.frozenFrom.kind, "club_role");
  assert.equal(await holds(w.coach.id, "athletes.manage", "club", w.A), false);
  ok(await srv.api(w.adminA.cookie, `${R}/assignments/${a1.id}/revoke`, { method: "POST", body: { requestKey: key(), reason: "Done", expected: { userId: w.coach.id, roleId: helper.id } } }));
  await grant();
  assert.equal(await holds(w.coach.id, "athletes.manage", "club", w.A), true, "a dead custom gives nothing and takes nothing");
  assert.equal((await one(`select ended_at from public.permission_custom_roles where id = $1`, [c1.custom.id])).ended_at, null, "dead, not yet ended");
  const c2 = ok(await custom(w.adminA, w.coach.id, w.A, { roleId: helper.id, scopeType: "club", scopeId: w.A, expectedRevision: null, remove: ["org.view"] }));
  assert.notEqual(c2.custom.id, c1.custom.id);
  assert.equal((await one(`select end_kind from public.permission_custom_roles where id = $1`, [c1.custom.id])).end_kind, "reset");
  // A revocation that landed before the write: the custom of a role no longer held is refused as not found (section 10).
  const rows = await one(`select id from public.user_role_assignments where user_id = $1 and role_id = $2 and revoked_at is null`, [w.coach.id, helper.id]);
  ok(await srv.api(w.adminA.cookie, `${R}/assignments/${rows.id}/revoke`, { method: "POST", body: { requestKey: key(), reason: "Done", expected: { userId: w.coach.id, roleId: helper.id } } }));
  notFound(await custom(w.adminA, w.coach.id, w.A, { roleId: helper.id, scopeType: "club", scopeId: w.A, expectedRevision: 1, add: ["org.view"] }));
});

test("6. Q15: a word taken from a club version names the customs that still hold it; the drift read; Take it from them too; replay; the identical 404", async () => {
  const w = await world();
  const c = ok(await custom(w.adminA, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: null, remove: ["athletes.manage"] }));
  const v = ok(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: null, remove: ["athletes.remove"] }));
  assert.deepEqual(v.customsStillHolding.map((x) => [x.customId, x.words]), [[c.custom.id, ["athletes.remove"]]]);
  const drift = ok(await srv.api(w.adminA.cookie, `${R}/clubs/${w.A}/custom-drift`));
  assert.deepEqual(drift.customs.map((x) => [x.customId, x.words]), [[c.custom.id, ["athletes.remove"]]]);
  notFound(await srv.api(w.adminB.cookie, `${R}/clubs/${w.A}/custom-drift`));
  const removal = (who, body) => srv.api(who.cookie, `${R}/${ROLE_IDS.team_coach}/clubs/${w.A}/custom-word-removal`, { method: "POST", body: { reason: "Not any more", ...body } });
  code(await removal(w.adminA, { requestKey: key(), word: "calendar.view", customIds: [c.custom.id] }), 409, "permission_not_available_yet");
  notFound(await removal(w.adminB, { requestKey: key(), word: "athletes.remove", customIds: [c.custom.id] }));
  notFound(await removal(w.adminA, { requestKey: key(), word: "athletes.remove", customIds: [crypto.randomUUID()] }));
  const k1 = key();
  const done = ok(await removal(w.adminA, { requestKey: k1, word: "athletes.remove", customIds: [c.custom.id] }));
  assert.deepEqual(done.customs.map((x) => x.id), [c.custom.id]);
  assert.ok(!done.customs[0].items.includes("athletes.remove"));
  assert.equal(await holds(w.coach.id, "athletes.remove", "team", w.T1), false);
  const replay = ok(await removal(w.adminA, { requestKey: k1, word: "athletes.remove", customIds: [c.custom.id] }));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.customs.map((x) => x.revision), [2]);
  code(await removal(w.adminA, { requestKey: key(), word: "athletes.remove", customIds: [c.custom.id] }), 409, "custom_changed");
  assert.deepEqual(ok(await srv.api(w.adminA.cookie, `${R}/clubs/${w.A}/custom-drift`)).customs, []);
  // A custom whose holding ended (an R2 assignment revoked: dead, not yet ended) is not listed as drift.
  const helper = ok(await srv.api(w.adminA.cookie, R, { method: "POST", body: { requestKey: key(), clubId: w.A, name: `Helper ${hex()}`, scopeTypes: ["team"], items: ["athletes.manage", "org.view"] } })).role;
  const a = ok(await srv.api(w.adminA.cookie, `${R}/assignments`, { method: "POST", body: { requestKey: key(), reason: "Needed", userId: w.target.id, roleId: helper.id, scopeType: "team", scopeId: w.T2 } })).assignment;
  const hc = ok(await custom(w.adminA, w.target.id, w.A, { roleId: helper.id, scopeType: "team", scopeId: w.T2, expectedRevision: null, remove: ["org.view"] }));
  ok(await srv.api(w.adminA.cookie, `${R}/${helper.id}/change`, { method: "POST", body: { requestKey: key(), reason: "Less", expectedRevision: 1, items: ["org.view"] } }));
  assert.deepEqual(ok(await srv.api(w.adminA.cookie, `${R}/clubs/${w.A}/custom-drift`)).customs.map((x) => [x.customId, x.words]), [[hc.custom.id, ["athletes.manage"]]]);
  ok(await srv.api(w.adminA.cookie, `${R}/assignments/${a.id}/revoke`, { method: "POST", body: { requestKey: key(), reason: "Done", expected: { userId: w.target.id, roleId: helper.id } } }));
  assert.deepEqual(ok(await srv.api(w.adminA.cookie, `${R}/clubs/${w.A}/custom-drift`)).customs, [], "a dead custom is no drift");
});

test("11. v95 end to end: with Calendar closed (its view word sits in Team coach and Club admin), the club's admin still makes and changes a club version and a custom role", async () => {
  const w = await world();
  ok(await ceiling(w.pa, w.A, { close: ["calendar"] }));
  const v = ok(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: null, remove: ["athletes.remove"] }));
  assert.ok(v.role.effectiveItems.includes("calendar.view"), "the closed word stays in the set, recorded");
  const c = ok(await custom(w.adminA, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: null, remove: ["athletes.manage"] }));
  assert.ok(c.custom.items.includes("calendar.view"));
  assert.equal(await holds(w.coach.id, "calendar.view", "team", w.T1), false, "the licence still decides");
  ok(await custom(w.adminA, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: 1, add: ["athletes.manage"] }));
  ok(await ceiling(w.pa, w.A, { open: ["calendar"] }));
  assert.equal(await holds(w.coach.id, "athletes.remove", "team", w.T1), false, "the club version acts");
});

test("7. H4 at the route: a club whose Club admin version is made after the default writer read its list loses the race as try_again, never a 40P01; the version writer and the default writer serialize", async () => {
  const w = await world();
  const sys = ok(await srv.api(w.pa.cookie, R, { method: "POST", body: { requestKey: key(), name: `Analyst ${hex()}`, scopeTypes: ["club"], items: ["org.view"] } })).role;
  try {
    // The version writer of club A holds every system role FOR SHARE; the default writer (no club with a Club admin
    // version yet, so no club lock) waits on its role's FOR UPDATE, then finds a version it did not lock.
    const hold = holdFirst(svc.setRolesWriteHoldForTests);
    const vReq = version(w.pa, ROLE_IDS.club_admin, w.A, { expectedRevision: null, remove: ["org.club.edit"] });
    await reachedOr(hold, vReq);
    const dReq = roleChange(w.pa, sys.id, { expectedRevision: 1, items: ["org.view", "org.club.edit"] });
    assert.ok(await someoneWaits(), "the default writer waits on the version writer");
    hold.release();
    ok(await vReq);
    code(await dReq, 409, "try_again");
    assert.equal(await revision(sys.id), 1, "nothing written");
    // Retried, it locks club A first and follows it.
    const res = ok(await roleChange(w.pa, sys.id, { expectedRevision: 1, items: ["org.view", "org.club.edit"] }));
    assert.ok(res.clubsTouched.some((x) => x.clubId === w.A), JSON.stringify(res.clubsTouched));
  } finally {
    ok(await srv.api(w.pa.cookie, `${R}/${sys.id}/archive`, { method: "POST", body: { requestKey: key(), expectedRevision: await revision(sys.id), reason: "Done" } }));
  }
});

test("8. races of 7.6: ceiling close against a guarded write, a version change against a custom made from it, two versions of different roles, a ceiling close against a club archive - one waits, no 40P01", async () => {
  const w = await world();
  const helper = ok(await srv.api(w.adminA.cookie, R, { method: "POST", body: { requestKey: key(), clubId: w.A, name: `Helper ${hex()}`, scopeTypes: ["team"], items: ["org.view"] } })).role;
  // (a) A ceiling close (exclusive) holds; an R2 assignment in the club (shared) waits, then passes.
  let hold = holdFirst(svc.setRolesWriteHoldForTests);
  let first = ceiling(w.pa, w.A, { close: ["messages"] });
  await reachedOr(hold, first);
  let second = srv.api(w.adminA.cookie, `${R}/assignments`, { method: "POST", body: { requestKey: key(), reason: "Needed", userId: w.target.id, roleId: helper.id, scopeType: "team", scopeId: w.T1 } });
  assert.ok(await someoneWaits());
  hold.release();
  ok(await first);
  ok(await second);
  // (b) A version change (exclusive) holds; a custom made from that role (shared) waits and freezes the new revision.
  hold = holdFirst(svc.setRolesWriteHoldForTests);
  first = version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: null, remove: ["athletes.remove"] });
  await reachedOr(hold, first);
  second = custom(w.adminA, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: null, remove: ["athletes.manage"] });
  assert.ok(await someoneWaits());
  hold.release();
  const v = ok(await first);
  const c = ok(await second);
  assert.equal(c.custom.frozenFrom.kind, "club_version");
  assert.equal(c.custom.frozenFrom.versionId, v.role.version.id);
  assert.ok(!c.custom.items.includes("athletes.remove") && !c.custom.items.includes("athletes.manage"));
  // (c) Two club version writers of different roles in the same club: one waits, both commit.
  const sys = ok(await srv.api(w.pa.cookie, R, { method: "POST", body: { requestKey: key(), name: `Scout ${hex()}`, scopeTypes: ["club"], items: ["org.view", "athletes.manage"] } })).role;
  try {
    hold = holdFirst(svc.setRolesWriteHoldForTests);
    first = version(w.adminA, sys.id, w.A, { expectedRevision: null, remove: ["athletes.manage"] });
    await reachedOr(hold, first);
    second = version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: 1, add: ["athletes.remove"] });
    assert.ok(await someoneWaits());
    hold.release();
    ok(await first);
    ok(await second);
  } finally {
    ok(await srv.api(w.pa.cookie, `${R}/${sys.id}/archive`, { method: "POST", body: { requestKey: key(), expectedRevision: 1, reason: "Done" } }));
  }
  // (d) A ceiling close holds the club row FOR SHARE; the club archive waits for it, then archives.
  const C = await F.club("C");
  hold = holdFirst(svc.setRolesWriteHoldForTests);
  first = ceiling(w.pa, C, { close: ["messages"] });
  await reachedOr(hold, first);
  second = srv.api(w.pa.cookie, `/api/organization/clubs/${C}`, { method: "DELETE" });
  assert.ok(await someoneWaits(), "the archive waits on the ceiling writer");
  hold.release();
  ok(await first);
  ok(await second);
  // The other order: the archive lands after the gate, before the locks - the ceiling writer answers the identical 404.
  const D = await F.club("D");
  hold = holdFirst(svc.setRolesBeforeLocksHoldForTests);
  first = ceiling(w.pa, D, { close: ["messages"] });
  await reachedOr(hold, first);
  ok(await srv.api(w.pa.cookie, `/api/organization/clubs/${D}`, { method: "DELETE" }));
  hold.release();
  notFound(await first);
  assert.equal((await one(`select count(*)::int as n from public.club_permission_ceiling where club_id = $1`, [D])).n, 0);
  // (e) A custom against the target's revocation: the revocation waits on the custom writer's users lock; the
  // custom made just before it ends with it (role_ended).
  hold = holdFirst(svc.setRolesWriteHoldForTests);
  first = custom(w.adminA, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: 1, add: ["athletes.manage"] });
  await reachedOr(hold, first);
  second = srv.api(w.adminA.cookie, `/api/organization/users/${w.coach.id}/team-roles/${w.T1}/team_coach`, { method: "DELETE" });
  assert.ok(await someoneWaits());
  hold.release();
  ok(await first);
  ok(await second);
  assert.equal((await one(`select end_kind from public.permission_custom_roles where id = $1`, [c.custom.id])).end_kind, "role_ended");
});

test("9. recorded lock order: every R4-3 write takes R2's request-key lock, then the club's ceiling lock (exclusive for the ceiling and versions, shared for customs), then rows, and no lock after its first write; a default change with default_follow takes its clubs' exclusive locks first", async () => {
  const w = await world();
  const steps = [];
  let r = await recorded(() => ceiling(w.pa, w.A, { close: ["messages"] })); ok(r.res); steps.push(["ceiling", r.seen, w.A, "exclusive"]);
  r = await recorded(() => version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: null, remove: ["athletes.remove"] })); ok(r.res); steps.push(["version create", r.seen, w.A, "exclusive"]);
  r = await recorded(() => version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: 1, add: ["athletes.remove"] })); ok(r.res); steps.push(["version change", r.seen, w.A, "exclusive"]);
  const c = await recorded(() => custom(w.adminA, w.coach.id, w.A, { roleId: ROLE_IDS.team_coach, scopeType: "team", scopeId: w.T1, expectedRevision: null, remove: ["athletes.remove"] }));
  const made = ok(c.res); steps.push(["custom", c.seen, w.A, "shared"]);
  ok(await version(w.adminA, ROLE_IDS.team_coach, w.A, { expectedRevision: 2, remove: ["athletes.manage"] }));
  r = await recorded(() => srv.api(w.adminA.cookie, `${R}/${ROLE_IDS.team_coach}/clubs/${w.A}/custom-word-removal`, { method: "POST", body: { requestKey: key(), reason: "x", word: "athletes.manage", customIds: [made.custom.id] } }));
  ok(r.res); steps.push(["word removal", r.seen, w.A, "shared"]);
  r = await recorded(() => endCustom(w.adminA, w.coach.id, made.custom.id)); ok(r.res); steps.push(["end", r.seen, w.A, "shared"]);
  for (const [name, seen, club, mode] of steps) assertLockOrder(name, seen, club, mode);
  // The version writer locks every system role FOR SHARE (H4): lock_permission_actor's seventh argument.
  const lockCall = steps[1][1].find((s) => /lock_permission_actor/.test(s.t));
  assert.equal(lockCall.params[6], true);
  const customLock = steps[3][1].find((s) => /lock_permission_actor/.test(s.t));
  assert.equal(customLock.params[6], false);
  // Both users rows in one statement, before the holding row and the custom rows.
  const texts = steps[3][1].map((s) => s.t);
  const users = texts.findIndex((t) => /from public\.users u where u\.id = any/.test(t));
  const holding = texts.findIndex((t) => /from public\.user_team_roles r where r\.user_id/.test(t));
  const customs = texts.findIndex((t) => /from public\.permission_custom_roles c where c\.user_id/.test(t));
  assert.ok(users >= 0 && users < holding && holding < customs && customs < texts.findIndex((t) => /lock_permission_actor/.test(t)), texts.join("\n"));
  // A default change that follows a club takes that club's exclusive lock before any row.
  ok(await version(w.pa, ROLE_IDS.club_admin, w.A, { expectedRevision: null, remove: ["org.club.edit"] }));
  const sys = ok(await srv.api(w.pa.cookie, R, { method: "POST", body: { requestKey: key(), name: `Analyst ${hex()}`, scopeTypes: ["club"], items: ["org.view"] } })).role;
  try {
    // Club B has its own Club admin version without org.club.edit AND its own version of the changed role: it does not
    // follow the change, so nothing is added there (7.2, H4).
    ok(await version(w.pa, ROLE_IDS.club_admin, w.B, { expectedRevision: null, remove: ["org.club.edit"] }));
    ok(await version(w.pa, sys.id, w.B, { expectedRevision: null, add: ["org.teams.manage"] }));
    const d = await recorded(() => roleChange(w.pa, sys.id, { expectedRevision: 1, items: ["org.view", "org.club.edit"] }));
    const body = ok(d.res);
    assert.ok(body.clubsTouched.some((x) => x.clubId === w.A && x.wordsAdded.includes("org.club.edit")));
    assert.ok(!body.clubsTouched.some((x) => x.clubId === w.B), JSON.stringify(body.clubsTouched));
    assert.ok(!(await one(`select array(select i.permission_word from public.permission_club_role_version_items i join public.permission_club_role_versions v on v.id = i.version_id
        where v.club_id = $1 and v.system_role_id = $2 and v.ended_at is null) as w`, [w.B, ROLE_IDS.club_admin])).w.includes("org.club.edit"));
    const dt = d.seen.map((s) => s.t);
    const at = dt.findIndex((t) => /lock_club_ceiling/.test(t));
    assert.ok(at >= 0 && at < dt.findIndex((t) => ROW_LOCK.test(t)), dt.join("\n"));
    assert.equal(d.seen[at].params[1], "exclusive");
    assert.ok(d.seen[at].params[0].includes(w.A));
  } finally {
    ok(await srv.api(w.pa.cookie, `${R}/${sys.id}/archive`, { method: "POST", body: { requestKey: key(), expectedRevision: 2, reason: "Done" } }));
  }
});

test("10. the uncertain COMMIT: an answer lost after a COMMIT that happened is verified by the request record; one that did not happen is 503 outcome_unknown and the same key writes it once", async () => {
  const w = await world();
  const lostAfter = { fault: (raw) => raw.query("commit").then(() => { throw new Error("the answer was lost"); }) };
  svc.setRolesCommitForTests(lostAfter);
  let res;
  try { res = ok(await ceiling(w.pa, w.A, { close: ["messages"] })); } finally { svc.setRolesCommitForTests(); }
  assert.equal(res.verified_after_commit_error, true);
  assert.equal((await one(`select count(*)::int as n from public.club_permission_ceiling where club_id = $1`, [w.A])).n, 1);
  const k1 = key();
  svc.setRolesCommitForTests({ fault: () => Promise.reject(new Error("never sent")) });
  try {
    code(await srv.api(w.adminA.cookie, `${R}/${ROLE_IDS.team_coach}/clubs/${w.A}/version`, { method: "POST", body: { requestKey: k1, reason: "x", expectedRevision: null, remove: ["athletes.remove"] } }), 503, "outcome_unknown");
  } finally { svc.setRolesCommitForTests(); }
  assert.equal((await one(`select count(*)::int as n from public.permission_club_role_versions where club_id = $1`, [w.A])).n, 0);
  const done = ok(await srv.api(w.adminA.cookie, `${R}/${ROLE_IDS.team_coach}/clubs/${w.A}/version`, { method: "POST", body: { requestKey: k1, reason: "x", expectedRevision: null, remove: ["athletes.remove"] } }));
  assert.equal(done.replayed, false);
  const again = ok(await srv.api(w.adminA.cookie, `${R}/${ROLE_IDS.team_coach}/clubs/${w.A}/version`, { method: "POST", body: { requestKey: k1, reason: "x", expectedRevision: null, remove: ["athletes.remove"] } }));
  assert.equal(again.replayed, true);
  assert.equal(again.role.version.revision, 1);
  // A replay re-evaluates the caller's standing inside its transaction: the admin's row switched off after the request's
  // gate passed (and after BEGIN), the same key answers the identical 404, never the saved answer.
  svc.setRolesAfterBeginHoldForTests(async () => {
    await k.query(`update public.user_club_roles set is_active = false where user_id = $1 and club_id = $2`, [w.adminA.id, w.A]);
  });
  try {
    notFound(await srv.api(w.adminA.cookie, `${R}/${ROLE_IDS.team_coach}/clubs/${w.A}/version`, { method: "POST", body: { requestKey: k1, reason: "x", expectedRevision: null, remove: ["athletes.remove"] } }));
  } finally {
    svc.setRolesAfterBeginHoldForTests(null);
  }
});
