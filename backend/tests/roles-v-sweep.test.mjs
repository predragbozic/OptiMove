// Roles V-0 (docs/ai/roles-v-steps-plan.md sections 3 and 4): the fail-closed sweep of the V steps, one row per module.
// Disposable database, the real server. V-0 opens no module, so every row is "closed": an account holding EVERY view word
// in a club_view workspace (and again with a forged `club` preference) gets from each module exactly what an account with
// no role gets, and no write lands anywhere. Each module's V pull request turns its row to "open" and adds the checks of
// the plan's section 4 for it (only the listed reads, club A only, the ceiling, old-vs-new, the word taken away, mutations).
//
// Also proven here, for the V steps to build on:
//   - the old-role baseline: a basic Club admin and Team coach hold every view word of the modules at their club / team
//     (the v92 seed), so the canView() a V step adds in front of a coach workspace takes nothing from them (old-vs-new);
//   - the entry gate over the real authorization context and the real (read-only) workspace resolve, with a module
//     opened only inside this test: the listed read passes with the word, everything else is refused, an account with no
//     view workspace goes on, the licence closes it, and no preference row is written.
// Every name is invented.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { buildDatabase, fixtures, key, startServer } from "./support/permission-roles-world.mjs";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const R = "/api/organization/roles";
let db, k, F, srv, w, mv, authzOf, MODULE_VIEW_WORDS, OPEN_VIEW_MODULES;

const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const person = async (label, setup = async () => {}) => { const id = await F.user(label); await setup(id); return { id, cookie: await srv.cookieFor(id) }; };
const me = async (who) => ok(await srv.api(who.cookie, "/api/auth/me")).user;
const setPref = (who, type, scopeId) => k.query(
  `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id, updated_at) values ($1, $2, $3, now())
   on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id, updated_at = now()`,
  [who.id, type, scopeId]);
const grant = async (who, userId, roleId, scopeType, scopeId) => ok(await srv.api(who.cookie, `${R}/assignments`, { method: "POST", body: {
  requestKey: key(), reason: "Needed", userId, roleId, scopeType, scopeId } })).assignment;
const has = (text, ids) => ids.filter((id) => id && text.includes(String(id)));
// A role of club A holding `words` (planted: the service refuses an unchecked word, O6), given to a new account.
async function holderOf(label, words, scopeType = "club", scopeId = null) {
  const role = ok(await srv.api(w.adminA.cookie, R, { method: "POST", body: {
    requestKey: key(), clubId: w.A, scopeTypes: ["club", "team"], items: ["org.view"], name: `V ${key().slice(0, 6)}` } })).role;
  await k.query(`set session_replication_role = replica`);
  try {
    for (const word of words) await k.query(`insert into public.permission_role_items (role_id, permission_word) values ($1, $2) on conflict do nothing`, [role.id, word]);
  } finally {
    await k.query(`set session_replication_role = origin`);
  }
  const who = await person(label);
  await grant(w.adminA, who.id, role.id, scopeType, scopeId || w.A);
  return who;
}
// Every row count of the application's schemas, in one statement: a write that lands anywhere changes one of them.
const SCHEMAS = ["public", "training", "training_load", "calendar", "tests", "plans", "media"];
async function snapshot() {
  const { rows } = await k.query(
    `select table_schema || '.' || table_name as t,
            (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint as n
       from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema = any($1::text[])
        and table_name not in ('user_sessions', 'app_error_events')
      order by 1`, [SCHEMAS]);
  return Object.fromEntries(rows.map((r) => [r.t, Number(r.n)]));
}
const changed = (a, b) => Object.keys({ ...a, ...b }).filter((t) => a[t] !== b[t]);

// One row per module (the plan's section 2): the reads a V step will list and the writes it must keep closed. `open`
// is false for every row in V-0; a module's V pull request sets it and adds its own checks.
function rows() {
  const q = "from=2026-11-01&to=2026-11-30";
  return [
    { module: "data_configuration", open: false,
      reads: ["/api/training-load/sources/metrics/variables"],
      writes: [["POST", "/api/training-load/sources/metrics/variables", { name: "x" }]] },
    { module: "presets", open: false,
      reads: ["/api/taxonomy/node-presets", "/api/taxonomy/template-tags", "/api/training-activity/session-types"],
      writes: [["POST", "/api/taxonomy/node-presets", { name: "x" }], ["POST", "/api/training-activity/session-types", { name: "x" }]] },
    { module: "athletes", open: false,
      reads: ["/api/athletes", `/api/athletes/${w.athA.id}/plans`, "/api/positions"],
      writes: [["POST", "/api/organization/athletes", { fullName: "Nova Vsweep", clubId: w.A }]] },
    { module: "calendar", open: false,
      reads: [`/api/calendar?${q}`, "/api/calendar/events/types", `/api/calendar/settings?clubId=${w.A}`],
      writes: [["POST", "/api/calendar/events", { title: "x", clubId: w.A }]] },
    { module: "tests", open: false,
      reads: ["/api/tests/library", "/api/tests/schedules", "/api/tests/weekly"],
      writes: [["POST", "/api/tests/schedules", { name: "x" }]] },
    { module: "tests_results", open: false,
      reads: ["/api/tests/results"], writes: [] },
    { module: "load_team", open: false,
      reads: [`/api/training-load/calendar?${q}`, "/api/training-load/external-schedules"],
      writes: [["POST", "/api/training-load/external-schedules", { name: "x" }]] },
    { module: "load_athlete", open: false,
      reads: ["/api/training-load/weekly", `/api/training-activity?${q}`, `/api/training-load/metrics/results?${q}`],
      writes: [["POST", "/api/training-load/metrics/events", {}]] },
    { module: "dashboards", open: false,
      reads: ["/api/training-load/dashboards", "/api/training-load/dashboards/active"],
      writes: [["POST", "/api/training-load/dashboards", { name: "x" }]] },
    { module: "programs", open: false,
      reads: ["/api/templates", "/api/builder/drafts", "/api/builder/weekly-plans"],
      writes: [["POST", "/api/builder/plans", { name: "x" }]] },
    { module: "exercises", open: false,
      reads: ["/api/exercises", "/api/exercise-collections"],
      writes: [["POST", "/api/exercises", { name: "x" }]] },
  ];
}
// Imports has no view word (R4 Q16): closed for a view workspace in every V step.
const ALWAYS_CLOSED = () => [`/api/training-load/gpexe/teams/${w.TA1}/status`, `/api/training-load/gpexe/teams/${w.TA1}/candidates`];

before(async () => {
  db = await buildDatabase({ label: "rvsweep", upTo: "all" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
  srv = await startServer(db.url);
  mv = await import("../src/moduleView.js");
  ({ MODULE_VIEW_WORDS, OPEN_VIEW_MODULES } = mv);
  const { loadAuthorizationContext } = await import("../src/authz.js");
  authzOf = (who) => loadAuthorizationContext({ id: who.id });
  w = { A: await F.club("Alpha"), B: await F.club("Beta") };
  w.TA1 = await F.team(w.A, "TA1");
  w.TB1 = await F.team(w.B, "TB1");
  w.adminA = await person("adminA", (id) => F.grantClub(id, w.A));
  w.adminB = await person("adminB", (id) => F.grantClub(id, w.B));
  w.coachA = await person("coachA", (id) => F.grantTeam(id, w.TA1));
  w.nobody = await person("nobody");
  w.athA = ok(await srv.api(w.adminA.cookie, "/api/organization/athletes", { method: "POST", body: { fullName: "Mira Vsweepalpha", clubId: w.A, teamId: w.TA1 } }), 201).athlete;
  w.idsA = [w.A, w.TA1, w.athA.id, "Vsweepalpha", w.adminA.id, w.coachA.id];
  w.all = await holderOf("allViews", Object.values(MODULE_VIEW_WORDS));
});
after(async () => {
  await srv?.stop();
  await k?.end().catch(() => {});
  await db?.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

test("1. the table covers every module of MODULE_VIEW_WORDS, and the open rows are exactly OPEN_VIEW_MODULES (none in V-0)", () => {
  const table = rows();
  assert.deepEqual(table.map((r) => r.module).sort(), Object.keys(MODULE_VIEW_WORDS).sort());
  assert.deepEqual(table.filter((r) => r.open).map((r) => r.module).sort(), [...OPEN_VIEW_MODULES].sort());
  assert.deepEqual(OPEN_VIEW_MODULES, []);
});

test("2. closed rows: every view word in club_view (and with a forged club preference) = an account with no role; no write lands; no preference is written", async () => {
  const hm = await me(w.all);
  assert.equal(hm.activeWorkspace.type, "club_view");
  assert.deepEqual(hm.permissions, ["org.view"], "/me offers no word of a module that has not opened");
  const norm = (who, text) => text.split(who.id).join("<me>");
  for (const forged of [false, true]) {
    if (forged) await setPref(w.all, "club", w.A);
    const prefBefore = (await k.query(`select workspace_type, scope_id, updated_at from public.user_workspace_preferences where user_id = $1`, [w.all.id])).rows;
    for (const row of rows().filter((r) => !r.open)) {
      for (const p of [...row.reads, ...ALWAYS_CLOSED()]) {
        const a = await srv.api(w.all.cookie, p);
        const b = await srv.api(w.nobody.cookie, p);
        assert.equal(a.status, b.status, `${row.module} ${p}: ${a.status} ${a.text.slice(0, 160)} vs ${b.status} ${b.text.slice(0, 160)}`);
        assert.equal(norm(w.all, a.text), norm(w.nobody, b.text), `${row.module} ${p}: the same answer as an account with no role`);
        assert.deepEqual(has(a.text, w.idsA.filter((id) => !p.includes(String(id)))), [], `${row.module} ${p}`);
      }
      for (const [method, p, body] of row.writes) {
        const before = await snapshot();
        const a = await srv.api(w.all.cookie, p, { method, body });
        assert.ok(a.status >= 400, `${row.module} ${method} ${p}: ${a.status} ${a.text.slice(0, 160)}`);
        assert.deepEqual(changed(before, await snapshot()), [], `${row.module} ${method} ${p}: nothing written`);
      }
    }
    const prefAfter = (await k.query(`select workspace_type, scope_id, updated_at from public.user_workspace_preferences where user_id = $1`, [w.all.id])).rows;
    assert.deepEqual(prefAfter, prefBefore, "no preference written by any module read");
    assert.equal((await me(w.all)).activeWorkspace.type, "club_view");
  }
});

test("3. the old-role baseline: a basic Club admin (club A) and Team coach (TA1) hold every module's view word there, in can() and in its SQL twin", async () => {
  const admin = await authzOf(w.adminA);
  const coach = await authzOf(w.coachA);
  const missing = [];
  for (const [module, word] of Object.entries(MODULE_VIEW_WORDS)) {
    if (!mv.canView(admin, { type: "club", scopeId: w.A }, module)) missing.push(`club_admin ${module}`);
    if (!mv.canView(coach, { type: "team", scopeId: w.TA1 }, module)) missing.push(`team_coach ${module}`);
    const twinAdmin = (await k.query(`select public.user_has_permission($1, $2, 'club', $3) as ok`, [w.adminA.id, word, w.A])).rows[0].ok;
    const twinCoach = (await k.query(`select public.user_has_permission($1, $2, 'team', $3) as ok`, [w.coachA.id, word, w.TA1])).rows[0].ok;
    if (!twinAdmin) missing.push(`twin club_admin ${word}`);
    if (!twinCoach) missing.push(`twin team_coach ${word}`);
  }
  assert.deepEqual(missing, [], "a V step's canView() in front of a coach workspace takes nothing from a basic role");
  assert.equal(mv.canView(admin, { type: "club", scopeId: w.B }, "calendar"), false, "another club");
  assert.equal(mv.canView(coach, { type: "club", scopeId: w.A }, "calendar"), false, "a team coach has no club-scope word");
});

// The gate over the real chain: authz from the database, the real read-only resolve; a module opened only here.
async function gateAnswer(who, method, path, { open = ["calendar"] } = {}) {
  const gate = mv.viewEntryGate("calendar", [{ method: "GET", path: "/" }], { open });
  const req = { user: { id: who.id }, authz: await authzOf(who), method, path };
  const out = { status: null, next: false, moduleView: null, error: null };
  const res = { status(s) { out.status = s; return this; }, json() { return this; } };
  await gate(req, res, (error) => { out.next = true; out.error = error || null; out.moduleView = req.moduleView || null; });
  return out;
}

test("4. the entry gate on the real chain: with the word the listed read passes in club A's scope; a write, no word or a closed module is refused; others go on; nothing is written", async () => {
  const holder = await holderOf("calHolder", ["calendar.view"]);
  const other = await holderOf("testsHolder", ["tests.view"]);
  const prefBefore = await snapshot();
  const read = await gateAnswer(holder, "GET", "/");
  assert.equal(read.next, true);
  assert.equal(read.error, null);
  assert.deepEqual(read.moduleView.scope, { type: "club", id: String(w.A) });
  assert.equal(read.moduleView.workspace.type, "club_view");
  assert.equal((await gateAnswer(holder, "POST", "/")).status, 403, "a write");
  assert.equal((await gateAnswer(holder, "GET", "/settings")).status, 403, "a read not on the list");
  assert.equal((await gateAnswer(other, "GET", "/")).status, 403, "another module's word");
  assert.equal((await gateAnswer(holder, "GET", "/", { open: [] })).status, 403, "a module not open");
  for (const who of [w.adminA, w.coachA, w.nobody]) {
    const r = await gateAnswer(who, "POST", "/");
    assert.equal(r.next, true, "an account without a view workspace goes on as today");
    assert.equal(r.moduleView, null);
  }
  assert.deepEqual(changed(prefBefore, await snapshot()), [], "the gate wrote nothing (no preference, no row)");
  // The licence: club A closes the calendar; the holder is refused (can()'s step 6, inside canView()).
  const pa = await person("pa", (id) => F.grantPlatform(id));
  ok(await srv.api(pa.cookie, `${R}/clubs/${w.A}/ceiling`, { method: "POST", body: { requestKey: key(), close: ["calendar"], open: [], reason: "No calendar" } }));
  assert.equal((await gateAnswer(holder, "GET", "/")).status, 403, "closed by the licence");
  ok(await srv.api(pa.cookie, `${R}/clubs/${w.A}/ceiling`, { method: "POST", body: { requestKey: key(), close: [], open: ["calendar"], reason: "Back" } }));
  assert.equal((await gateAnswer(holder, "GET", "/")).next, true, "reopened");
});
