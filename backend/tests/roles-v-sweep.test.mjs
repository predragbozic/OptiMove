// Roles V-0 (docs/ai/roles-v-steps-plan.md sections 3 and 4): the fail-closed sweep of the V steps, one row per module.
// Disposable database, the real server. A closed row: an account holding EVERY view word in a club_view workspace (and
// again with a forged `club` preference) gets from that module exactly what an account with no role gets, and no write
// lands anywhere. Each module's V pull request turns its row to "open" and adds the checks of the plan's section 4 for it
// (only the listed reads, club A only, the ceiling, old-vs-new, the word taken away). V-1 opens data_configuration (test
// 5) and presets (test 6); V-3 opens the calendar (test 7); V-2 opens athletes (test 8); V-4 opens Tests (test 9).
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
// A role of a club holding `words` (planted: the service refuses an unchecked word, O6), made by that club's admin.
async function roleOf(words, { admin = w.adminA, club = w.A } = {}) {
  const role = ok(await srv.api(admin.cookie, R, { method: "POST", body: {
    requestKey: key(), clubId: club, scopeTypes: ["club", "team"], items: ["org.view"], name: `V ${key().slice(0, 6)}` } })).role;
  await k.query(`set session_replication_role = replica`);
  try {
    for (const word of words) await k.query(`insert into public.permission_role_items (role_id, permission_word) values ($1, $2) on conflict do nothing`, [role.id, word]);
  } finally {
    await k.query(`set session_replication_role = origin`);
  }
  return role;
}
// A role of club A holding `words`, given to a new account.
async function holderOf(label, words, scopeType = "club", scopeId = null) {
  const role = await roleOf(words);
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
    { module: "data_configuration", open: true,
      reads: ["/api/training-load/sources/metrics/variables"],
      writes: [["POST", "/api/training-load/sources/metrics/variables", { name: "x" }]] },
    { module: "presets", open: true,
      reads: ["/api/taxonomy/node-presets", "/api/taxonomy/template-tags", "/api/training-activity/session-types"],
      writes: [["POST", "/api/taxonomy/node-presets", { name: "x" }], ["POST", "/api/training-activity/session-types", { name: "x" }]] },
    { module: "athletes", open: true,
      reads: ["/api/athletes", `/api/athletes/${w.athA.id}/plans`, "/api/positions"],
      writes: [["POST", "/api/organization/athletes", { fullName: "Nova Vsweep", clubId: w.A }]] },
    { module: "calendar", open: true,
      reads: [`/api/calendar?${q}`, "/api/calendar/events/types", `/api/calendar/settings?clubId=${w.A}`],
      writes: [["POST", "/api/calendar/events", { title: "x", clubId: w.A }]] },
    { module: "tests", open: true,
      reads: ["/api/tests/library", "/api/tests/schedules", "/api/tests/weekly"],
      writes: [["POST", "/api/tests/schedules", { name: "x" }]] },
    { module: "tests_results", open: true,
      reads: ["/api/tests/results"], writes: [] },
    { module: "load_team", open: false,
      reads: [`/api/training-load/calendar?${q}`, "/api/training-load/external-schedules"],
      writes: [["POST", "/api/training-load/external-schedules", { name: "x" }]] },
    { module: "load_athlete", open: false,
      reads: ["/api/training-load/weekly", `/api/training-activity?${q}`, `/api/training-load/metrics/results?${q}`],
      writes: [["POST", "/api/training-load/metrics/events", {}]] },
    { module: "dashboards", open: true,
      reads: ["/api/training-load/dashboards", "/api/training-load/dashboards/active"],
      writes: [["POST", "/api/training-load/dashboards", { name: "x" }]] },
    { module: "programs", open: true,
      reads: ["/api/templates", "/api/builder/drafts", "/api/builder/weekly-plans"],
      writes: [["POST", "/api/builder/plans", { name: "x" }]] },
    { module: "exercises", open: true,
      reads: ["/api/exercises", "/api/exercise-collections"],
      writes: [["POST", "/api/exercises", { name: "x" }]] },
  ];
}
// Imports has no view word (R4 Q16): closed for a view workspace in every V step.
const ALWAYS_CLOSED = () => [`/api/training-load/gpexe/teams/${w.TA1}/status`, `/api/training-load/gpexe/teams/${w.TA1}/candidates`];

const ORIGINAL_DASHBOARD_PAGES_ENABLED = process.env.DASHBOARD_PAGES_ENABLED;
const ORIGINAL_DASHBOARD_REFERENCES_ENABLED = process.env.DASHBOARD_REFERENCES_ENABLED;

before(async () => {
  db = await buildDatabase({ label: "rvsweep", upTo: "all" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  F = fixtures(k);
  await k.query("update training_load.dashboard_pages_activation set enabled=true where singleton");
  process.env.DASHBOARD_PAGES_ENABLED = "true";
  process.env.DASHBOARD_REFERENCES_ENABLED = "true";
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
  if (ORIGINAL_DASHBOARD_PAGES_ENABLED === undefined) delete process.env.DASHBOARD_PAGES_ENABLED;
  else process.env.DASHBOARD_PAGES_ENABLED = ORIGINAL_DASHBOARD_PAGES_ENABLED;
  if (ORIGINAL_DASHBOARD_REFERENCES_ENABLED === undefined) delete process.env.DASHBOARD_REFERENCES_ENABLED;
  else process.env.DASHBOARD_REFERENCES_ENABLED = ORIGINAL_DASHBOARD_REFERENCES_ENABLED;
});

test("1. the table covers every module of MODULE_VIEW_WORDS, and the open rows are exactly OPEN_VIEW_MODULES (V-1: data configuration, presets; V-2: athletes; V-3: calendar; V-4: tests)", () => {
  const table = rows();
  assert.deepEqual(table.map((r) => r.module).sort(), Object.keys(MODULE_VIEW_WORDS).sort());
  assert.deepEqual(table.filter((r) => r.open).map((r) => r.module).sort(), [...OPEN_VIEW_MODULES].sort());
  assert.deepEqual([...OPEN_VIEW_MODULES].sort(), ["athletes", "calendar", "dashboards", "data_configuration", "exercises", "presets", "programs", "tests", "tests_results"]);
});

test("2. closed rows: every view word in club_view (and with a forged club preference) = an account with no role; no write lands; no preference is written", async () => {
  const hm = await me(w.all);
  assert.equal(hm.activeWorkspace.type, "club_view");
  assert.deepEqual([...hm.permissions].sort(), ["athletes.view", "calendar.view", "dashboards.view", "exercises.use", "org.view", "presets.use", "programs.view", "tests.results.view", "tests.view", "variables.view"], "/me offers only the words of open modules");
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

// ---------------------------------------------------------------------------------------------------------------------
// V-1 and V-3: the open rows (the plan's sections 2.1, 2.2, 2.4 and 4).
// ---------------------------------------------------------------------------------------------------------------------
const M = "/api/training-load/sources/metrics";
const RANDOM_ID = "6f0e8a52-8d0b-4a8e-9b51-3a3c0e0c0b11";
const ceiling = async (pa, close, open) => ok(await srv.api(pa.cookie, `${R}/clubs/${w.A}/ceiling`, { method: "POST", body: { requestKey: key(), close, open, reason: "V-1 test" } }));
const idsOf = (list) => list.map((r) => String(r.id));
const sameAsNobody = async (who, p, label) => {
  const a = await srv.api(who.cookie, p);
  const b = await srv.api(w.nobody.cookie, p);
  assert.equal(a.status, b.status, `${label} ${p}: ${a.status} vs ${b.status}`);
  assert.equal(a.text.split(who.id).join("<me>"), b.text.split(w.nobody.id).join("<me>"), `${label} ${p}`);
};
async function writesLandNothing(who, writes, status) {
  for (const [method, p, body] of writes) {
    const before = await snapshot();
    const a = await srv.api(who.cookie, p, { method, body });
    assert.equal(a.status, status, `${method} ${p}: ${a.status} ${a.text.slice(0, 160)}`);
    assert.deepEqual(changed(before, await snapshot()), [], `${method} ${p}: nothing written`);
  }
}

test("5. data configuration (variables.view): club_view and team_view read the club's and the system variables in C99's reduced shape, read only; another club, the admin reads and every write are the identical 404; the word and the licence close it", async () => {
  const pa = await person("paV1", (id) => F.grantPlatform(id));
  const vbody = (label) => ({ requestKey: key(), label, unit: "m", levels: ["session", "drill"], dailyAggregationMethod: "sum" });
  const sys = ok(await srv.api(pa.cookie, `${M}/variables`, { method: "POST", body: vbody(`Sys distance ${key().slice(0, 6)}`) }), 201).variable;
  const varA = ok(await srv.api(w.adminA.cookie, `${M}/variables`, { method: "POST", body: vbody(`Alpha distance ${key().slice(0, 6)}`) }), 201).variable;
  const varB = ok(await srv.api(w.adminB.cookie, `${M}/variables`, { method: "POST", body: vbody(`Beta distance ${key().slice(0, 6)}`) }), 201).variable;
  const catA = ok(await srv.api(w.adminA.cookie, `${M}/classification/categories`, { method: "POST", body: { requestKey: key(), name: `Alpha load ${key().slice(0, 6)}` } }), 201);
  const catB = ok(await srv.api(w.adminB.cookie, `${M}/classification/categories`, { method: "POST", body: { requestKey: key(), name: `Beta load ${key().slice(0, 6)}` } }), 201);
  const nodeId = (r) => String((r.category || r.node || r).id);
  const clubHolder = await holderOf("dcClub", ["variables.view"]);
  const teamHolder = await holderOf("dcTeam", ["variables.view"], "team", w.TA1);
  const coachShape = ok(await srv.api(w.coachA.cookie, `${M}/variables/${varA.id}`)).variable;
  for (const [who, label] of [[clubHolder, "club_view"], [teamHolder, "team_view"]]) {
    const own = ok(await srv.api(who.cookie, `${M}/variables`)).variables;
    assert.deepEqual(idsOf(own), [String(varA.id)], `${label}: the club's own variables only`);
    const system = ok(await srv.api(who.cookie, `${M}/variables?scope=system`)).variables;
    assert.ok(idsOf(system).includes(String(sys.id)), `${label}: the system reference`);
    for (const v of [...own, ...system]) {
      assert.equal(v.editable, false, `${label}: read only`);
      assert.deepEqual(v.actions, [], `${label}: no action`);
      assert.equal(v.currentVersion, undefined, `${label}: the reduced view (no versions)`);
    }
    const one = ok(await srv.api(who.cookie, `${M}/variables/${varA.id}`)).variable;
    assert.deepEqual(Object.keys(one).sort(), Object.keys(coachShape).sort(), `${label}: C99's coach shape`);
    assert.equal(one.editable, false);
    for (const id of [varB.id, RANDOM_ID]) {
      const r = await srv.api(who.cookie, `${M}/variables/${id}`);
      assert.deepEqual([r.status, r.body], [404, { error: "notFound" }], `${label}: another club's variable is the identical 404`);
    }
    const tree = ok(await srv.api(who.cookie, `${M}/classification`));
    assert.ok(idsOf(tree.categories).includes(nodeId(catA)) && !idsOf(tree.categories).includes(nodeId(catB)), `${label}: the club's categories, never another club's`);
    for (const node of [...tree.domains, ...tree.categories, ...tree.categoryDomains]) {
      assert.equal(node.editable, false, `${label}: the classification read only`);
      assert.deepEqual(node.actions, []);
    }
    for (const p of [`${M}/fields`, `${M}/mappings`, `${M}/targets`, `${M}/board`, `${M}/variables/key-suggestion?label=Speed`,
      `${M}/conversions`, `${M}/activations`, `${M}/field-inventory`, `${M}/confirmations`]) {
      const r = await srv.api(who.cookie, p);
      assert.equal(r.status, 404, `${label} ${p}`);
    }
    await sameAsNobody(who, `${M}/fields`, label);
    await writesLandNothing(who, [
      ["POST", `${M}/variables`, vbody("Nope")],
      ["POST", `${M}/variables/${varA.id}/rename`, { requestKey: key(), label: "Nope" }],
      ["POST", `${M}/variables/${varA.id}/archive`, { requestKey: key() }],
      ["POST", `${M}/variables/${sys.id}/hide`, { requestKey: key() }],
    ], 404);
  }
  // The coach paths keep their answers with the word (old-vs-new): the club admin's admin view, the team coach's own club variable.
  assert.equal(ok(await srv.api(w.adminA.cookie, `${M}/variables/${varA.id}`)).variable.editable, true);
  assert.equal(coachShape.editable, true);
  // The word taken away: an account holding only presets.use reads nothing here.
  const other = await holderOf("dcOther", ["presets.use"]);
  await sameAsNobody(other, `${M}/variables`, "no word");
  await sameAsNobody(other, `${M}/variables/${varA.id}`, "no word");
  // The licence closes the module for the role holder and for the club's old roles alike; reopened, all read again.
  await ceiling(pa, ["data_configuration"], []);
  try {
    for (const who of [clubHolder, teamHolder, w.adminA, w.coachA]) {
      const r = await srv.api(who.cookie, `${M}/variables`);
      assert.deepEqual([r.status, r.body], [404, { error: "notFound" }], "closed by the licence");
    }
    assert.equal((await srv.api(w.adminB.cookie, `${M}/variables`)).status, 200, "another club keeps it");
  } finally {
    await ceiling(pa, [], ["data_configuration"]);
  }
  for (const who of [clubHolder, w.adminA, w.coachA]) assert.equal((await srv.api(who.cookie, `${M}/variables`)).status, 200, "reopened");
});

test("6. tags, presets and session types (presets.use): a view workspace reads the system rows and its club's (and teams') or team's only, never as a manager; every write is refused and lands nothing; a mixed account sees the view club only; the word and the licence close it", async () => {
  const pa = await person("paV1p", (id) => F.grantPlatform(id));
  const T = "/api/taxonomy";
  const make = async (who, p, body) => {
    const r = await srv.api(who.cookie, p, { method: "POST", body });
    assert.equal(r.status, 201, r.text);
    return r.body.preset || r.body.tag || r.body.row;
  };
  const n = (s) => `${s} ${key().slice(0, 6)}`;
  const sysP = await make(pa, `${T}/node-presets`, { nodeType: "domain", name: n("Sys preset"), scope: "system" });
  const aClubP = await make(w.adminA, `${T}/node-presets`, { nodeType: "domain", name: n("Alpha preset"), scope: "club", clubId: w.A });
  const aTeamP = await make(w.adminA, `${T}/node-presets`, { nodeType: "domain", name: n("Alpha team preset"), scope: "team", teamId: w.TA1 });
  const aUserP = await make(w.adminA, `${T}/node-presets`, { nodeType: "domain", name: n("Own preset") });
  const bClubP = await make(w.adminB, `${T}/node-presets`, { nodeType: "domain", name: n("Beta preset"), scope: "club", clubId: w.B });
  const aTag = await make(w.adminA, `${T}/template-tags`, { name: n("Alpha tag"), scope: "club", clubId: w.A });
  const bTag = await make(w.adminB, `${T}/template-tags`, { name: n("Beta tag"), scope: "club", clubId: w.B });
  const aLib = await make(w.adminA, `${T}/library/tag`, { name: n("Alpha lib"), scope: "club", clubId: w.A });
  const bLib = await make(w.adminB, `${T}/library/tag`, { name: n("Beta lib"), scope: "club", clubId: w.B });
  const ST = "/api/training-activity/session-types";
  const aType = ok(await srv.api(w.adminA.cookie, ST, { method: "POST", body: { requestKey: key(), label: n("Alpha type") } })).type;
  const bType = ok(await srv.api(w.adminB.cookie, ST, { method: "POST", body: { requestKey: key(), label: n("Beta type") } })).type;

  const read = async (who) => ({
    presets: ok(await srv.api(who.cookie, `${T}/node-presets`)).presets,
    tags: ok(await srv.api(who.cookie, `${T}/template-tags`)).tags,
    lib: ok(await srv.api(who.cookie, `${T}/library/tag`)).rows,
    types: ok(await srv.api(who.cookie, ST)),
  });
  const clubHolder = await holderOf("prClub", ["presets.use"]);
  const teamHolder = await holderOf("prTeam", ["presets.use"], "team", w.TA1);
  const c = await read(clubHolder);
  assert.deepEqual(idsOf(c.presets).filter((id) => [sysP, aClubP, aTeamP, aUserP, bClubP].some((p) => String(p.id) === id)).sort(),
    idsOf([sysP, aClubP, aTeamP]).sort(), "club_view: system, the club's and its teams' rows; never another club's or a person's own");
  assert.ok(c.presets.every((p) => p.can_manage === false), "never as a manager");
  assert.ok(idsOf(c.tags).includes(String(aTag.id)) && !idsOf(c.tags).includes(String(bTag.id)));
  assert.ok(idsOf(c.lib).includes(String(aLib.id)) && !idsOf(c.lib).includes(String(bLib.id)));
  assert.ok(c.types.types.some((t) => t.key === aType.key) && !c.types.types.some((t) => t.key === bType.key), "the club's session types");
  assert.ok(c.types.types.every((t) => t.editable === false) && c.types.canAdd === null, "session types read only");
  const t = await read(teamHolder);
  assert.deepEqual(idsOf(t.presets).filter((id) => [sysP, aClubP, aTeamP, aUserP, bClubP].some((p) => String(p.id) === id)).sort(),
    idsOf([sysP, aTeamP]).sort(), "team_view: system and the team's rows");
  assert.ok(t.types.types.some((x) => x.key === aType.key), "team_view: its team's club's session types");
  // Every library kind's view read is valid SQL and gives the club's row of that kind (the security review's LOW 4).
  // (An attractor cannot be created through the route today - its table's NOT NULL kind column is never filled, a
  // 500 that predates V-1 - so for that kind only the read is checked.)
  for (const kind of ["domain", "category", "section", "tag", "attractor"]) {
    const row = kind === "attractor" ? null : await make(w.adminA, `${T}/library/${kind}`, { name: n(`Alpha ${kind}`), scope: "club", clubId: w.A });
    for (const who of [clubHolder, teamHolder]) {
      const rows = ok(await srv.api(who.cookie, `${T}/library/${kind}`)).rows;
      if (row) assert.equal(idsOf(rows).includes(String(row.id)), who === clubHolder, `${kind}: the club's row for club_view only`);
      assert.ok(rows.every((r) => r.can_manage === false), kind);
    }
  }
  // An archived team's rows are not "its teams" (as the other V-1 reads, and as no team_view is offered for it).
  const archivedTeam = await F.team(w.A, "TA-archived");
  const archivedP = await make(w.adminA, `${T}/node-presets`, { nodeType: "domain", name: n("Archived team preset"), scope: "team", teamId: archivedTeam });
  await k.query(`update public.teams set is_active = false where id = $1`, [archivedTeam]);
  assert.ok(!idsOf(ok(await srv.api(clubHolder.cookie, `${T}/node-presets`)).presets).includes(String(archivedP.id)), "no archived team's preset");
  // The coach path's can() compares canonical ids: a club id sent in upper case is accepted as before V-1.
  const upper = await make(w.adminA, `${T}/node-presets`, { nodeType: "domain", name: n("Upper id preset"), scope: "club", clubId: String(w.A).toUpperCase() });
  assert.equal(String(upper.owner_club_id), String(w.A).toLowerCase());
  assert.equal((await srv.api(w.adminA.cookie, `${T}/node-presets`, { method: "POST", body: { nodeType: "domain", name: "Nope", scope: "club", clubId: "not-a-uuid" } })).status, 403,
    "a club id that is not a uuid is outside the caller's access");
  // Only the three reads; every write answers what requireCoach / the session-type router answer, and lands nothing.
  for (const who of [clubHolder, teamHolder]) {
    assert.equal((await srv.api(who.cookie, `${T}/library/bogus`)).status, 403, "a kind not on the list");
    await writesLandNothing(who, [
      ["POST", `${T}/node-presets`, { nodeType: "domain", name: "Nope", scope: "club", clubId: w.A }],
      ["PATCH", `${T}/node-presets/${aClubP.id}`, { name: "Nope" }],
      ["DELETE", `${T}/node-presets/${sysP.id}`, undefined],
      ["DELETE", `${T}/template-tags/${aTag.id}`, undefined],
      ["POST", `${T}/library/tag`, { name: "Nope", scope: "club", clubId: w.A }],
    ], 403);
    await writesLandNothing(who, [
      ["POST", ST, { requestKey: key(), label: "Nope" }],
      ["POST", `${ST}/${aType.key}/rename`, { requestKey: key(), label: "Nope" }],
      ["POST", `${ST}/${aType.key}/archive`, { requestKey: key() }],
    ], 404);
  }
  // Old-vs-new for the coaches (they hold the word): the club admin keeps every row it managed, the team coach its team's.
  // (Today's list leaves a team's rows out for a club admin without a team role, while it may manage them; unchanged.)
  const adminRows = idsOf(ok(await srv.api(w.adminA.cookie, `${T}/node-presets`)).presets);
  for (const p of [sysP, aClubP, aUserP]) assert.ok(adminRows.includes(String(p.id)), "club admin");
  assert.ok(!adminRows.includes(String(bClubP.id)) && !adminRows.includes(String(aTeamP.id)));
  const coachRows = idsOf(ok(await srv.api(w.coachA.cookie, `${T}/node-presets`)).presets);
  assert.ok(coachRows.includes(String(aTeamP.id)) && coachRows.includes(String(sysP.id)) && !coachRows.includes(String(aClubP.id)), "team coach");
  // A mixed account: club A's admin who also holds a club B role, in club_view B, sees club B's rows only.
  const roleB = await roleOf(["presets.use"], { admin: w.adminB, club: w.B });
  await grant(w.adminB, w.adminA.id, roleB.id, "club", w.B);
  // A stored club B preference: without an old role there, workspace.js maps it to club_view B.
  await setPref(w.adminA, "club", w.B);
  try {
    assert.equal((await me(w.adminA)).activeWorkspace.type, "club_view");
    const mixed = idsOf(ok(await srv.api(w.adminA.cookie, `${T}/node-presets`)).presets);
    assert.ok(mixed.includes(String(bClubP.id)), "club B's row");
    for (const p of [aClubP, aTeamP, aUserP]) assert.ok(!mixed.includes(String(p.id)), "never club A's or its own rows in club B's view");
    assert.equal((await srv.api(w.adminA.cookie, `${T}/node-presets`, { method: "POST", body: { nodeType: "domain", name: "Nope", scope: "club", clubId: w.A } })).status, 403,
      "no write from a view workspace, even for the club it administers");
  } finally {
    await setPref(w.adminA, "club", w.A);
  }
  // The word taken away.
  const other = await holderOf("prOther", ["variables.view"]);
  await sameAsNobody(other, `${T}/node-presets`, "no word");
  await sameAsNobody(other, ST, "no word");
  // The licence: closed for club A, the role holders are refused and the old roles keep only the system and own rows.
  await ceiling(pa, ["presets"], []);
  try {
    for (const who of [clubHolder, teamHolder]) {
      assert.equal((await srv.api(who.cookie, `${T}/node-presets`)).status, 403);
      assert.equal((await srv.api(who.cookie, ST)).status, 404);
    }
    const closed = idsOf(ok(await srv.api(w.adminA.cookie, `${T}/node-presets`)).presets);
    assert.ok(closed.includes(String(sysP.id)) && closed.includes(String(aUserP.id)), "system and own rows stay");
    assert.ok(!closed.includes(String(aClubP.id)) && !closed.includes(String(aTeamP.id)), "the club's rows are closed");
    assert.equal((await srv.api(w.adminA.cookie, `${T}/node-presets/${aClubP.id}`, { method: "PATCH", body: { name: "Nope" } })).status, 403);
    const types = ok(await srv.api(w.adminA.cookie, ST));
    assert.ok(!types.types.some((x) => x.key === aType.key) && types.canAdd === null, "the club's session types closed");
    assert.equal((await srv.api(w.adminB.cookie, `${T}/node-presets`)).status, 200, "another club keeps it");
  } finally {
    await ceiling(pa, [], ["presets"]);
  }
  assert.equal((await srv.api(clubHolder.cookie, `${T}/node-presets`)).status, 200, "reopened");
});

// ---------------------------------------------------------------------------------------------------------------------
// V-3: the calendar (the plan's sections 2.4 and 4).
// ---------------------------------------------------------------------------------------------------------------------
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const eventCards = (cal) => cal.days.flatMap((d) => d.items).filter((i) => i.kind === "event");
const withoutAthleteTargets = (ev) => {
  const { hiddenAthleteTargets: _h, ...rest } = ev;
  return { ...rest, targets: rest.targets.filter((t) => t.kind !== "athlete") };
};
// The same status and body as an account with no role (its own id masked).
async function sameAsNobodyWrite(who, method, p, body) {
  const before = await snapshot();
  const a = await srv.api(who.cookie, p, { method, body });
  const b = await srv.api(w.nobody.cookie, p, { method, body });
  assert.equal(a.status, b.status, `${method} ${p}: ${a.status} ${a.text.slice(0, 160)} vs ${b.status} ${b.text.slice(0, 160)}`);
  assert.equal(a.text.split(who.id).join("<me>"), b.text.split(w.nobody.id).join("<me>"), `${method} ${p}`);
  assert.deepEqual(changed(before, await snapshot()), [], `${method} ${p}: nothing written`);
}

test("7. the calendar (calendar.view): club_view and team_view read their club's or team's calendar, the event types and the reduced event view, never managing, never naming an athlete without athletes.view (P-1); another club's event, the questions, the settings and every write answer what they answered before; the word and the licence close it for role holders and coaches alike", async () => {
  const pa = await person("paV3", (id) => F.grantPlatform(id));
  const today = new Date().toISOString().slice(0, 10);
  const day = addDays(today, 1);
  const q = `from=${today}&to=${addDays(today, 6)}`;
  const typeOf = async (who) => {
    const types = ok(await srv.api(who.cookie, "/api/calendar/events/types")).types;
    return (types.find((t) => t.key === "training") || types[0]).id;
  };
  // The fixture's clubs are raw rows: give them their calendar catalog, as the organization route does.
  for (const club of [w.A, w.B]) await k.query(`select calendar.seed_club_event_types($1)`, [club]);
  const SECRET = "Vsweep secret note";
  const evA = ok(await srv.api(w.adminA.cookie, "/api/calendar/events", { method: "POST", body: {
    requestKey: key(), eventTypeId: await typeOf(w.adminA), title: "Alpha session", day, timezone: "UTC", notes: SECRET,
    targets: [{ kind: "team", id: w.TA1 }, { kind: "athlete", id: w.athA.id }] } }), 201).event;
  const evB = ok(await srv.api(w.adminB.cookie, "/api/calendar/events", { method: "POST", body: {
    requestKey: key(), eventTypeId: await typeOf(w.adminB), title: "Beta session", day, timezone: "UTC",
    targets: [{ kind: "team", id: w.TB1 }] } }), 201).event;
  const E = "/api/calendar/events";
  const clubHolder = await holderOf("calClubV3", ["calendar.view"]);
  const teamHolder = await holderOf("calTeamV3", ["calendar.view"], "team", w.TA1);
  // Since roles V-2 opened athletes.view, a view workspace holding it may see the athletes' names here too (P-1).
  const namesHolder = await holderOf("calNamesV3", ["calendar.view", "athletes.view"]);
  // The reduced view a team coach of TA1 gets today of a club-owned event it may not manage (the shape to match).
  const coachReduced = ok(await srv.api(w.coachA.cookie, `${E}/${evA.id}`)).event;
  assert.equal(coachReduced.canManage, false);
  const adminTypes = ok(await srv.api(w.adminA.cookie, `${E}/types`)).types.map((t) => String(t.id)).sort();

  const before = await snapshot();
  for (const [who, label] of [[clubHolder, "club_view"], [teamHolder, "team_view"], [namesHolder, "club_view + athletes.view"]]) {
    const raw = await srv.api(who.cookie, `/api/calendar?${q}&include=athletes`);
    const cal = ok(raw);
    assert.equal(cal.workspace.type, label === "team_view" ? "team_view" : "club_view", label);
    const events = eventCards(cal);
    const names = label.includes("athletes.view");
    assert.ok(events.some((e) => String(e.eventId) === String(evA.id)), `${label}: the club's event`);
    assert.ok(!raw.text.includes(String(evB.id)) && !raw.text.includes(String(w.B)) && !raw.text.includes(String(w.TB1)), `${label}: nothing of club B`);
    if (names) {
      assert.ok(raw.text.includes("Vsweepalpha"), `${label}: the athletes' names (P-1, athletes.view)`);
    } else {
      assert.ok(!raw.text.includes("Vsweepalpha"), `${label}: no athlete name (P-1)`);
      assert.ok(!raw.text.includes(String(w.athA.id)), `${label}: no athlete id either (P-1: counts only)`);
    }
    assert.ok(events.find((e) => String(e.eventId) === String(evA.id)).athleteCount > 0, `${label}: the count stays`);
    assert.ok(!raw.text.includes(SECRET), `${label}: no notes`);
    for (const e of events) assert.deepEqual([e.canManage, e.notes, e.details, e.eventTypeId], [false, undefined, undefined, undefined], label);
    if (!names) {
      assert.ok(cal.days.flatMap((d) => d.items).every((i) => !("athletes" in i)), `${label}: include=athletes left out`);
      // Nor an athlete filter (P-1): filtering by an athlete id, real or not, answers the unfiltered calendar, so the
      // answer never tells whether that athlete has events.
      const plain = (await srv.api(who.cookie, `/api/calendar?${q}`)).text;
      for (const id of [w.athA.id, crypto.randomUUID()]) {
        const filtered = await srv.api(who.cookie, `/api/calendar?${q}&athleteIds=${id}`);
        assert.equal(filtered.status, 200, `${label}: athleteIds`);
        assert.equal(filtered.text, plain, `${label}: athleteIds is ignored without the athletes' names`);
      }
    }
    assert.ok(cal.teams.some((t) => String(t.teamId) === String(w.TA1)), `${label}: its teams`);
    // The event types: club A's catalog (the admin's), never another club's.
    assert.deepEqual(ok(await srv.api(who.cookie, `${E}/types`)).types.map((t) => String(t.id)).sort(), adminTypes, `${label}: club A's types`);
    // The reduced event view: the team coach's own reduced view, its athlete targets counted instead of named.
    const one = await srv.api(who.cookie, `${E}/${evA.id}`);
    const ev = ok(one).event;
    assert.equal(ev.canManage, false);
    assert.ok(!one.text.includes(SECRET), `${label}: no note`);
    if (names) {
      assert.ok(one.text.includes(String(w.athA.id)) && !ev.hiddenAthleteTargets, `${label}: the athlete target shown (P-1, athletes.view)`);
    } else {
      assert.ok(!one.text.includes("Vsweepalpha") && !one.text.includes(String(w.athA.id)), `${label}: no name, no athlete id`);
      assert.equal(ev.hiddenAthleteTargets, 1, `${label}: the athlete target counted`);
    }
    assert.deepEqual(withoutAthleteTargets(ev), withoutAthleteTargets(coachReduced), `${label}: the reduced view a non-manager gets`);
    // Another club's event and a missing one: the identical 404.
    for (const id of [evB.id, RANDOM_ID]) {
      const r = await srv.api(who.cookie, `${E}/${id}`);
      assert.deepEqual([r.status, r.body], [404, { error: "notFound", message: "Not found." }], `${label}: ${id}`);
    }
    // Not listed: the questions and the settings answer what an account with no role gets.
    await sameAsNobody(who, `${E}/${evA.id}/questions`, label);
    await sameAsNobody(who, `/api/calendar/settings`, label);
  }
  assert.deepEqual(changed(before, await snapshot()), [], "no read wrote anything (no preference, no row)");

  // Every write answers what it answered an account with no role, and lands nothing.
  const types = await typeOf(w.adminA);
  for (const who of [clubHolder, teamHolder]) {
    for (const [method, p, body] of [
      ["POST", E, { requestKey: key(), eventTypeId: types, title: "Nope", day, timezone: "UTC", targets: [{ kind: "team", id: w.TA1 }] }],
      ["PATCH", `${E}/${evA.id}`, { requestKey: key(), expectedRevision: evA.revision, title: "Nope" }],
      ["POST", `${E}/${evA.id}/cancel`, { requestKey: key(), expectedRevision: evA.revision, reason: "Nope" }],
      ["POST", `${E}/${evA.id}/delete`, { requestKey: key(), expectedRevision: evA.revision }],
      ["POST", `${E}/${evA.id}/sessions`, { requestKey: key(), expectedRevision: evA.revision, sessionIds: [] }],
      ["POST", `${E}/${evA.id}/activities`, { requestKey: key(), expectedRevision: evA.revision, activityId: RANDOM_ID }],
      ["POST", `${E}/${evA.id}/fields`, { requestKey: key(), expectedRevision: evA.revision, values: [] }],
      ["POST", `${E}/${evA.id}/questions`, { requestKey: key(), expectedRevision: evA.revision, kind: "rpe" }],
      ["POST", "/api/calendar/settings/types", { requestKey: key(), label: "Nope", kind: "training" }],
    ]) await sameAsNobodyWrite(who, method, p, body);
  }

  // A forged `club` preference resolves to club_view and reads the same.
  await setPref(clubHolder, "club", w.A);
  assert.equal((await me(clubHolder)).activeWorkspace.type, "club_view");
  assert.ok(eventCards(ok(await srv.api(clubHolder.cookie, `/api/calendar?${q}`))).every((e) => e.canManage === false));
  // A mixed account: club B's admin holding club A's calendar role, in club_view A, reads club A only, managing nothing.
  const roleA = await roleOf(["calendar.view"]);
  await grant(w.adminA, w.adminB.id, roleA.id, "club", w.A);
  await setPref(w.adminB, "club", w.A);
  try {
    assert.equal((await me(w.adminB)).activeWorkspace.type, "club_view");
    const raw = await srv.api(w.adminB.cookie, `/api/calendar?${q}`);
    const events = eventCards(ok(raw));
    assert.ok(events.some((e) => String(e.eventId) === String(evA.id)) && !raw.text.includes(String(evB.id)), "club A's events, never club B's");
    assert.ok(events.every((e) => e.canManage === false));
    assert.equal((await srv.api(w.adminB.cookie, `${E}/${evB.id}`)).status, 404, "its own club's event is not read through club A's view");
    await sameAsNobodyWrite(w.adminB, "POST", `${E}/${evB.id}/cancel`, { requestKey: key(), expectedRevision: evB.revision, reason: "Nope" });
  } finally {
    await setPref(w.adminB, "club", w.B);
  }
  // Old-vs-new: the club admin manages its event as before, the team coach reads it.
  const managed = ok(await srv.api(w.adminA.cookie, `${E}/${evA.id}`)).event;
  assert.deepEqual([managed.canManage, managed.notes], [true, SECRET]);
  assert.ok(eventCards(ok(await srv.api(w.coachA.cookie, `/api/calendar?${q}`))).some((e) => String(e.eventId) === String(evA.id)));
  // The word taken away.
  const other = await holderOf("calOtherV3", ["presets.use"]);
  await sameAsNobody(other, `/api/calendar?${q}`, "no word");
  await sameAsNobody(other, `${E}/types`, "no word");
  await sameAsNobody(other, `${E}/${evA.id}`, "no word");
  // The licence closes the module for the role holders and for the club's old roles (reads and writes) alike.
  await ceiling(pa, ["calendar"], []);
  try {
    for (const who of [clubHolder, teamHolder, w.adminA, w.coachA]) {
      await sameAsNobody(who, `/api/calendar?${q}`, "closed by the licence");
      await sameAsNobody(who, `${E}/${evA.id}`, "closed by the licence");
    }
    await sameAsNobodyWrite(w.adminA, "POST", `${E}/${evA.id}/cancel`, { requestKey: key(), expectedRevision: evA.revision, reason: "Nope" });
    await sameAsNobodyWrite(w.adminA, "POST", E, { requestKey: key(), eventTypeId: types, title: "Nope", day, timezone: "UTC", targets: [{ kind: "team", id: w.TA1 }] });
    await sameAsNobody(w.adminA, "/api/calendar/settings", "closed by the licence");
    // The athlete's own questions have no coach side: a coach still gets an empty list, not the module's refusal.
    assert.deepEqual(ok(await srv.api(w.adminA.cookie, "/api/calendar/questions/mine")), { questions: [] });
    assert.equal((await srv.api(w.adminB.cookie, `/api/calendar?${q}`)).status, 200, "another club keeps it");
  } finally {
    await ceiling(pa, [], ["calendar"]);
  }
  for (const who of [clubHolder, w.adminA, w.coachA]) assert.equal((await srv.api(who.cookie, `/api/calendar?${q}`)).status, 200, "reopened");
});

// ---------------------------------------------------------------------------------------------------------------------
// V-2: athletes (the plan's sections 2.3 and 9).
// ---------------------------------------------------------------------------------------------------------------------
test("8. athletes (athletes.view): a view workspace reads its club's or team's athletes (list without plan counts, the organization's reduced rows, positions) and nothing else; another club never; every write lands nothing; a mixed account sees the view club only; the word and the licence close it for role holders and old roles alike", async () => {
  const pa = await person("paV2", (id) => F.grantPlatform(id));
  const mk = async (who, body) => ok(await srv.api(who.cookie, "/api/organization/athletes", { method: "POST", body }), 201).athlete;
  const athA2 = await mk(w.adminA, { fullName: "Lena Vtwoclub", clubId: w.A });
  const athB = await mk(w.adminB, { fullName: "Ivo Vtwobeta", clubId: w.B, teamId: w.TB1 });
  const athGone = await mk(w.adminA, { fullName: "Sara Vtwoarchived", clubId: w.A });
  await k.query(`update public.athlete_memberships set status = 'archived', archived_at = now() where athlete_id = $1`, [athGone.id]);
  // The creator's own private-coach link (athletes.view does not gate a private relationship, R4 Q10) is ended, so the
  // club admins below read their athletes through their club role only - the branch the word narrows.
  await k.query(`update public.user_athletes set is_active = false where user_id = any($1::uuid[]) and relationship_type = 'coach'`, [[w.adminA.id, w.adminB.id]]);
  const clubIds = [String(w.athA.id), String(athA2.id)].sort();
  const teamIds = [String(w.athA.id)];
  const foreign = [String(athB.id), "Vtwobeta", String(athGone.id), "Vtwoarchived"];
  const listIds = async (who) => ok(await srv.api(who.cookie, "/api/athletes")).adminRows.map((r) => String(r.athlete_uuid)).sort();
  const orgOf = async (who) => ok(await srv.api(who.cookie, "/api/organization"));
  const { VIEW_ATHLETE_KEYS } = await import("../src/routes/organization.js");

  // Old-vs-new for the coaches (the basic roles hold the word): unchanged lists, with their plan counts.
  const adminRows = ok(await srv.api(w.adminA.cookie, "/api/athletes")).adminRows;
  assert.deepEqual(adminRows.map((r) => String(r.athlete_uuid)).sort(), clubIds, "club admin A: club A's athletes");
  assert.ok(adminRows.every((r) => typeof r.weekly_plan_count === "number" && typeof r.program_count === "number"));
  assert.deepEqual(await listIds(w.coachA), teamIds, "team coach TA1: its team's athletes");
  assert.equal((await srv.api(w.adminA.cookie, `/api/athletes/${w.athA.id}/plans`)).status, 200);
  assert.equal((await srv.api(w.adminA.cookie, `/api/athletes/${athB.id}/plans`)).status, 403, "never another club's athlete");

  const clubHolder = await holderOf("atClub", ["athletes.view"]);
  const teamHolder = await holderOf("atTeam", ["athletes.view"], "team", w.TA1);
  for (const [who, label, expected] of [[clubHolder, "club_view", clubIds], [teamHolder, "team_view", teamIds]]) {
    assert.ok((await me(who)).permissions.includes("athletes.view"), `${label}: /me offers the word`);
    const prefBefore = (await k.query(`select * from public.user_workspace_preferences where user_id = $1`, [who.id])).rows;
    const list = ok(await srv.api(who.cookie, "/api/athletes"));
    assert.deepEqual(list.adminRows.map((r) => String(r.athlete_uuid)).sort(), expected, `${label}: the workspace's athletes`);
    assert.ok(list.adminRows.every((r) => r.weekly_plan_count === null && r.program_count === null), `${label}: no plan counts (programs.view)`);
    assert.deepEqual(has(JSON.stringify(list), foreign), [], `${label}: nothing of another club or an archived membership`);
    const org = await orgOf(who);
    assert.deepEqual(org.athletes.map((a) => String(a.id)).sort(), expected, `${label}: the organization's athletes`);
    for (const a of org.athletes) {
      assert.deepEqual(Object.keys(a), [...VIEW_ATHLETE_KEYS], `${label}: the reduced row`);
      assert.ok(a.memberships.every((m) => String(m.clubId) === String(w.A) && m.status === "active"), `${label}: this club's memberships only`);
    }
    assert.deepEqual(has(JSON.stringify(org), foreign), [], label);
    assert.deepEqual([org.canCreateAthlete, org.manageableClubIds, org.accessRequests, org.joinLinks], [false, [], [], []], `${label}: nothing to manage`);
    const positions = ok(await srv.api(who.cookie, "/api/positions"));
    assert.equal(positions.canAdd, null, `${label}: positions read only`);
    assert.ok(positions.positions.every((p) => p.editable === false && p.actions.length === 0));
    const assignments = ok(await srv.api(who.cookie, "/api/positions/athletes"));
    assert.deepEqual([assignments.clubId, assignments.canSet], [String(w.A), false], `${label}: its club's assignments, read only`);
    // Not athletes.view, or plan data: what an account with no role gets.
    for (const p of ["/api/athletes/today", "/api/athletes/training-days?from=2026-11-01&to=2026-11-30",
      `/api/athletes/${w.athA.id}/plans`, `/api/athletes/${w.athA.id}/program-data`, `/api/athletes/${athB.id}/plans`, "/api/athlete-profile"]) {
      await sameAsNobody(who, p, label);
    }
    const prefAfter = (await k.query(`select * from public.user_workspace_preferences where user_id = $1`, [who.id])).rows;
    assert.deepEqual(prefAfter, prefBefore, `${label}: no preference written by a read`);
    await writesLandNothing(who, [["POST", "/api/organization/athletes", { fullName: "Nope Vtwo", clubId: w.A }],
      ["PUT", `/api/organization/athletes/${w.athA.id}`, { fullName: "Nope Vtwo" }]], 403);
    await writesLandNothing(who, [["POST", "/api/positions", { requestKey: key(), name: "Nope" }],
      ["PUT", `/api/positions/athletes/${w.athA.id}`, { requestKey: key(), positionId: null }]], 404);
  }
  // A mixed account: club B's admin, holding athletes.view in club A, in club_view A: club A's athletes only.
  const roleA = await roleOf(["athletes.view"]);
  await grant(w.adminA, w.adminB.id, roleA.id, "club", w.A);
  await setPref(w.adminB, "club", w.A);
  try {
    assert.equal((await me(w.adminB)).activeWorkspace.type, "club_view");
    assert.deepEqual(await listIds(w.adminB), clubIds, "mixed: club A's list");
    const org = await orgOf(w.adminB);
    assert.deepEqual(org.athletes.map((a) => String(a.id)).sort(), clubIds, "mixed: club A's organization athletes");
    assert.deepEqual(has(JSON.stringify(org), foreign), [], "mixed: nothing of club B");
    // Central handoff supersedes V-2's recorded legacy fallback: old roles elsewhere give no authority here.
    assert.equal((await srv.api(w.adminB.cookie, `/api/athletes/${athB.id}/plans`)).status, 403, "central handoff: old club B role gives no authority in club_view A");
    assert.equal((await srv.api(w.adminB.cookie, `/api/athletes/${w.athA.id}/plans`)).status, 403, "mixed hand-on read: nothing of club A through the view role");
    // Neither club A's view role nor club B's old role can write from club_view A.
    await writesLandNothing(w.adminB, [["POST", "/api/organization/athletes", { fullName: "Nope Vtwo", clubId: w.A }],
      ["PUT", `/api/organization/athletes/${w.athA.id}`, { fullName: "Nope Vtwo" }]], 403);
  } finally {
    await setPref(w.adminB, "club", w.B);
  }
  assert.deepEqual(await listIds(w.adminB), [String(athB.id)], "back in club B");
  // The word taken away: an account holding only presets.use gets the empty answers of today.
  const other = await holderOf("atOther", ["presets.use"]);
  await sameAsNobody(other, "/api/athletes", "no word");
  assert.deepEqual((await orgOf(other)).athletes, [], "no word: no organization athletes");
  assert.equal((await srv.api(other.cookie, "/api/positions/athletes")).status, 404, "no word: no positions");
  // The two branches the word never narrows (R4 Q10): a private-coach link and the athlete's own login.
  const privateCoach = await person("atPrivate");
  await k.query(`insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1, $2, 'coach', true)`, [privateCoach.id, w.athA.id]);
  const ownLogin = await person("atOwn");
  await k.query(`update public.athletes set user_id = $1 where id = $2`, [ownLogin.id, athA2.id]);
  for (const [who, id, label] of [[privateCoach, w.athA.id, "private-coach link"], [ownLogin, athA2.id, "own login"]]) {
    assert.equal((await srv.api(who.cookie, `/api/athletes/${id}/plans`)).status, 200, `${label}: as before V-2`);
  }
  // The licence closes Athletes for club A: the role holders AND the club's old roles lose every reader of the word.
  await ceiling(pa, ["athletes"], []);
  try {
    for (const [who, id, label] of [[privateCoach, w.athA.id, "private-coach link"], [ownLogin, athA2.id, "own login"]]) {
      assert.equal((await srv.api(who.cookie, `/api/athletes/${id}/plans`)).status, 200, `licence: the ${label} is not narrowed by the word`);
    }
    for (const who of [clubHolder, teamHolder]) {
      await sameAsNobody(who, "/api/athletes", "licence");
      assert.deepEqual((await orgOf(who)).athletes, [], "licence: no organization athletes");
      assert.equal((await srv.api(who.cookie, "/api/positions/athletes")).status, 404);
    }
    assert.deepEqual(await listIds(w.adminA), [], "licence: the club admin's list is empty");
    assert.deepEqual(await listIds(w.coachA), [], "licence: the team coach's list is empty");
    assert.deepEqual((await orgOf(w.adminA)).athletes.filter((a) => a.has_active_access).map((a) => String(a.id)), [], "licence: no active organization athletes");
    assert.equal((await srv.api(w.adminA.cookie, `/api/athletes/${w.athA.id}/plans`)).status, 403, "licence: the access predicate closes");
    assert.equal((await srv.api(w.adminA.cookie, "/api/positions/athletes")).status, 404, "licence: positions closed");
    assert.deepEqual(await listIds(w.adminB), [String(athB.id)], "another club keeps it");
    assert.equal((await srv.api(pa.cookie, `/api/athletes/${w.athA.id}/plans`)).status, 200, "a platform admin is never limited");
  } finally {
    await ceiling(pa, [], ["athletes"]);
  }
  assert.deepEqual(await listIds(w.adminA), clubIds, "reopened");
  assert.deepEqual(await listIds(clubHolder), clubIds, "reopened for the holder");
});

// ---------------------------------------------------------------------------------------------------------------------
// V-4: Tests (the plan's sections 2.5 and 4).
// ---------------------------------------------------------------------------------------------------------------------
const mondayOf = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

test("9. Tests (tests.view, tests.results.view): club_view and team_view read their club's or team's schedules, library and week, and with the results word the results and the per-athlete group; never the group link's token, never an athlete's name or id without athletes.view; Today, every write and another club's schedule answer what they answered before; a mixed account sees only the view club; the words and the licence close it", async () => {
  const pa = await person("paV4", (id) => F.grantPlatform(id));
  const { WELLNESS_TEST_VERSION_ID } = await import("../src/testsScheduleWriter.js");
  const today = new Date().toISOString().slice(0, 10);
  const T = "/api/tests";
  const body = (targets) => ({ testVersionId: WELLNESS_TEST_VERSION_ID, scheduleKind: "one_time", timezone: "UTC", startDate: today, opensTime: "00:00", closesTime: "23:59", targets });
  // An athlete of team TA1 with a login, who answers today's check-in.
  const tessa = ok(await srv.api(w.adminA.cookie, "/api/organization/athletes", { method: "POST", body: { fullName: "Tessa Vsweeptest", clubId: w.A, teamId: w.TA1 } }), 201).athlete;
  const athUser = await person("athV4");
  await k.query(`update public.athletes set user_id = $1 where id = $2`, [athUser.id, tessa.id]);
  const schedA = ok(await srv.api(w.adminA.cookie, `${T}/schedules`, { method: "POST", body: body([{ kind: "team", id: w.TA1 }, { kind: "athlete", id: tessa.id }]) }), 201).schedule;
  const schedB = ok(await srv.api(w.adminB.cookie, `${T}/schedules`, { method: "POST", body: body([{ kind: "team", id: w.TB1 }]) }), 201).schedule;
  // The team's own schedule (its coach's, in the team workspace): a team view reads the team's schedules, as its coach.
  const schedT = ok(await srv.api(w.coachA.cookie, `${T}/schedules`, { method: "POST", body: body([{ kind: "team", id: w.TA1 }, { kind: "athlete", id: tessa.id }]) }), 201).schedule;
  const link = ok(await srv.api(w.adminA.cookie, `${T}/schedules/${schedA.id}/link`, { method: "POST", body: {} }), 201).link;
  const todayRows = ok(await srv.api(athUser.cookie, `${T}/athlete/today`)).assignments;
  assert.equal(todayRows.length, 2, "both check-ins of today");
  const assessments = [];
  for (const row of todayRows) {
    assessments.push(ok(await srv.api(athUser.cookie, `${T}/assignments/${row.assignmentId}/submit`, { method: "POST",
      body: { values: { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: false } } })).assessmentId);
  }
  assert.ok(assessments.every(Boolean), "both answered");
  const assignment = todayRows[0];
  // Which result belongs to which schedule (the club admin reads both).
  const resultOf = Object.fromEntries(ok(await srv.api(w.adminA.cookie, `${T}/results`)).results.map((r) => [String(r.scheduleId), String(r.assessmentId)]));
  assert.ok(resultOf[String(schedA.id)] && resultOf[String(schedT.id)], "a completed result of each schedule");

  const clubHolder = await holderOf("tsClubV4", ["tests.view", "tests.results.view"]);
  const teamHolder = await holderOf("tsTeamV4", ["tests.view", "tests.results.view"], "team", w.TA1);
  const schedOnly = await holderOf("tsSchedV4", ["tests.view"]);
  const resultsOnly = await holderOf("tsResV4", ["tests.results.view"]);
  const secretFree = (label, r) => {
    assert.ok(!r.text.includes(link.publicToken), `${label}: never the group link's token`);
    assert.ok(!r.text.includes("Vsweeptest") && !r.text.includes(String(tessa.id)), `${label}: no athlete name or id (P-1)`);
    assert.ok(!r.text.includes(String(schedB.id)) && !r.text.includes(String(w.B)), `${label}: nothing of club B`);
  };
  // With athletes.view (open since V-2), P-1 lets the names in: the schedule's athlete target and the results' names;
  // never the group link's token and never club B.
  const namesHolder = await holderOf("tsNamesV4", ["tests.view", "tests.results.view", "athletes.view"]);
  const namedDetail = await srv.api(namesHolder.cookie, `${T}/schedules/${schedA.id}`);
  assert.ok(ok(namedDetail).targets.some((t) => t.kind === "athlete" && String(t.id) === String(tessa.id)), "athletes.view: the athlete target shown");
  assert.equal(namedDetail.body.hiddenAthleteTargets, undefined);
  const namedResults = await srv.api(namesHolder.cookie, `${T}/results`);
  assert.ok(ok(namedResults).results.some((r) => /Vsweeptest/.test(String(r.athleteName))), "athletes.view: the results name the athlete");
  for (const r of [namedDetail, namedResults]) {
    assert.ok(!r.text.includes(link.publicToken) && !r.text.includes(String(schedB.id)) && !r.text.includes(String(w.B)), "athletes.view: still no token, nothing of club B");
  }

  const before = await snapshot();
  for (const [who, label, own, hidden] of [[clubHolder, "club_view", schedA, null], [teamHolder, "team_view", schedT, schedA]]) {
    const assessmentId = resultOf[String(own.id)];
    for (const p of [`${T}/library`, `${T}/schedules`, `${T}/weekly?weekStart=${mondayOf(today)}`]) {
      const r = await srv.api(who.cookie, p);
      ok(r);
      secretFree(`${label} ${p}`, r);
    }
    const listed = idsOf(ok(await srv.api(who.cookie, `${T}/schedules`)).schedules);
    assert.ok(listed.includes(String(own.id)) && listed.includes(String(schedT.id)), `${label}: its schedules (a club view also its teams')`);
    // A team view, like its team's coach, does not read the club's own schedules.
    if (hidden) {
      assert.ok(!listed.includes(String(hidden.id)), `${label}: not the club's own schedule`);
      assert.deepEqual((await srv.api(who.cookie, `${T}/schedules/${hidden.id}`)).status, 404);
    }
    const week = await srv.api(who.cookie, `${T}/weekly?weekStart=${mondayOf(today)}`);
    assert.ok(ok(week).days.some((d) => d.sessions.some((x) => String(x.scheduleId) === String(own.id))), `${label}: the week shows it`);
    const one = await srv.api(who.cookie, `${T}/schedules/${own.id}`);
    const detail = ok(one);
    secretFree(`${label} detail`, one);
    assert.equal(detail.link, undefined, `${label}: no link block`);
    assert.equal(detail.readOnly, true);
    assert.equal(detail.hiddenAthleteTargets, 1, `${label}: the athlete target is counted`);
    assert.ok(detail.targets.every((t) => t.kind !== "athlete"));
    for (const id of [schedB.id, RANDOM_ID]) {
      const r = await srv.api(who.cookie, `${T}/schedules/${id}`);
      assert.deepEqual([r.status, r.body], [404, { error: "Schedule not found." }], `${label}: another club's schedule is the 404 of a missing one`);
    }
    const group = await srv.api(who.cookie, `${T}/schedules/${own.id}/group?date=${today}`);
    secretFree(`${label} group`, group);
    assert.ok(ok(group).group.athletes.length > 0 && ok(group).group.athletes.every((a) => a.athleteName === null && a.athleteId === null && a.assignmentId === undefined), `${label}: the group without names or assignment ids`);
    const results = await srv.api(who.cookie, `${T}/results`);
    secretFree(`${label} results`, results);
    const rows = ok(results).results;
    assert.ok(rows.some((r) => String(r.assessmentId) === String(assessmentId)), `${label}: its result`);
    if (hidden) assert.ok(!rows.some((r) => String(r.assessmentId) === resultOf[String(hidden.id)]), `${label}: not the club's own schedule's result`);
    assert.ok(rows.every((r) => r.athleteName === null && r.athleteId === null));
    const res1 = await srv.api(who.cookie, `${T}/results/${assessmentId}`);
    secretFree(`${label} result`, res1);
    assert.equal(ok(res1).athleteName, null);
    await sameAsNobody(who, `${T}/today`, label);
    await sameAsNobody(who, `${T}/athlete/today`, label);
  }
  assert.deepEqual(changed(before, await snapshot()), [], "no read wrote anything (no occurrence, no preference)");
  // Every write answers what it answers an account with no coach role, and lands nothing.
  for (const who of [clubHolder, teamHolder]) {
    for (const [method, p, b] of [
      ["POST", `${T}/schedules`, body([{ kind: "team", id: w.TA1 }])],
      ["POST", `${T}/schedules/bulk`, { testVersionId: WELLNESS_TEST_VERSION_ID, timezone: "UTC", opensTime: "06:00", closesTime: "22:00", dates: [today], targets: [{ kind: "team", id: w.TA1 }] }],
      ["PATCH", `${T}/schedules/${schedA.id}`, { status: "paused" }],
      ["DELETE", `${T}/schedules/${schedA.id}`, undefined],
      ["POST", `${T}/schedules/${schedA.id}/link`, {}],
      ["POST", `${T}/links/${link.id}/revoke`, {}],
      ["POST", `${T}/schedules/${schedA.id}/remind`, { assignmentIds: [assignment.assignmentId] }],
    ]) await sameAsNobodyWrite(who, method, p, b);
  }
  // One word without the other: the schedule without results (its week counts no result); results alone open nothing.
  ok(await srv.api(schedOnly.cookie, `${T}/schedules`));
  const schedWeek = ok(await srv.api(schedOnly.cookie, `${T}/weekly?weekStart=${mondayOf(today)}`));
  const sessions = schedWeek.days.flatMap((d) => d.sessions);
  assert.ok(sessions.some((x) => String(x.scheduleId) === String(schedA.id)) && sessions.every((x) => x.resultsCount === 0), "no result counted without tests.results.view");
  assert.ok(ok(await srv.api(clubHolder.cookie, `${T}/weekly?weekStart=${mondayOf(today)}`)).days.flatMap((d) => d.sessions).some((x) => x.resultsCount > 0), "counted with it");
  for (const p of [`${T}/results`, `${T}/results/${resultOf[String(schedA.id)]}`, `${T}/schedules/${schedA.id}/group?date=${today}`]) await sameAsNobody(schedOnly, p, "tests.view only");
  for (const p of [`${T}/schedules`, `${T}/library`, `${T}/results`]) await sameAsNobody(resultsOnly, p, "tests.results.view only");
  // A forged club preference resolves to club_view and reads the same.
  await setPref(clubHolder, "club", w.A);
  assert.equal((await me(clubHolder)).activeWorkspace.type, "club_view");
  assert.ok(idsOf(ok(await srv.api(clubHolder.cookie, `${T}/schedules`)).schedules).includes(String(schedA.id)));
  // A mixed account: club B's admin holding club A's Tests role, in club_view A, reads club A only (before V-4 it passed
  // requireCoachWorkspace and read every club it administers).
  const roleA = await roleOf(["tests.view", "tests.results.view"]);
  await grant(w.adminA, w.adminB.id, roleA.id, "club", w.A);
  await setPref(w.adminB, "club", w.A);
  try {
    assert.equal((await me(w.adminB)).activeWorkspace.type, "club_view");
    const list = await srv.api(w.adminB.cookie, `${T}/schedules`);
    assert.ok(idsOf(ok(list).schedules).includes(String(schedA.id)) && !list.text.includes(String(schedB.id)), "club A's, never club B's");
    assert.equal((await srv.api(w.adminB.cookie, `${T}/schedules/${schedB.id}`)).status, 404, "its own club's schedule is not read through club A's view");
    await sameAsNobodyWrite(w.adminB, "POST", `${T}/schedules/${schedB.id}/link`, {});
  } finally {
    await setPref(w.adminB, "club", w.B);
  }
  // Old-vs-new (the coaches hold both words): the club admin still sees the link, the names and the scores; the team
  // coach its team's schedule, group, results and Today. (The Tests suites tests-module-*, tests-weekly-calendar and
  // tests-manual-reminder are the full regression of the coach paths.)
  const adminDetail = ok(await srv.api(w.adminA.cookie, `${T}/schedules/${schedA.id}`));
  assert.equal(adminDetail.link.publicToken, link.publicToken);
  assert.ok(ok(await srv.api(w.adminA.cookie, `${T}/results`)).results.some((r) => r.athleteName === "Tessa Vsweeptest"));
  const adminGroup = ok(await srv.api(w.adminA.cookie, `${T}/schedules/${schedA.id}/group?date=${today}`)).group;
  assert.ok(adminGroup.athletes.some((a) => a.athleteName === "Tessa Vsweeptest" && a.assignmentId && a.wellnessScore != null), "the admin's group: names, ids, scores");
  assert.equal(adminGroup.resultsHidden, undefined);
  const coachList = idsOf(ok(await srv.api(w.coachA.cookie, `${T}/schedules`)).schedules);
  assert.ok(coachList.includes(String(schedT.id)) && !coachList.includes(String(schedA.id)) && !coachList.includes(String(schedB.id)), "the team coach: its team's schedules, as before");
  assert.ok(ok(await srv.api(w.coachA.cookie, `${T}/results`)).results.some((r) => r.athleteName === "Tessa Vsweeptest" && String(r.scheduleId) === String(schedT.id)));
  assert.ok(ok(await srv.api(w.coachA.cookie, `${T}/today`)).groups.some((g) => g.athletes.some((a) => a.wellnessScore != null)), "the coach's Today with scores");
  // The licence closes Tests for the role holders and for the club's own admin (reads and writes); club B keeps it.
  await ceiling(pa, ["tests"], []);
  try {
    for (const who of [clubHolder, teamHolder]) await sameAsNobody(who, `${T}/schedules`, "closed by the licence");
    assert.ok(!idsOf(ok(await srv.api(w.adminA.cookie, `${T}/schedules`)).schedules).includes(String(schedA.id)), "the club admin's list leaves club A out");
    assert.equal((await srv.api(w.adminA.cookie, `${T}/schedules/${schedA.id}`)).status, 404);
    assert.equal((await srv.api(w.adminA.cookie, `${T}/results/${resultOf[String(schedA.id)]}`)).status, 404);
    const beforeWrite = await snapshot();
    assert.equal((await srv.api(w.adminA.cookie, `${T}/schedules`, { method: "POST", body: body([{ kind: "team", id: w.TA1 }]) })).status, 403, "no new schedule in a closed club");
    assert.equal((await srv.api(w.adminA.cookie, `${T}/schedules/${schedA.id}/link`, { method: "POST", body: {} })).status, 404);
    assert.deepEqual(changed(beforeWrite, await snapshot()), [], "nothing written");
    assert.ok(idsOf(ok(await srv.api(w.adminB.cookie, `${T}/schedules`)).schedules).includes(String(schedB.id)), "another club keeps it");
  } finally {
    await ceiling(pa, [], ["tests"]);
  }
  assert.ok(idsOf(ok(await srv.api(w.adminA.cookie, `${T}/schedules`)).schedules).includes(String(schedA.id)), "reopened");
});

async function handoffRowState(){
 const names=Object.keys(await snapshot());const state={};for(const name of names){const [schema,table]=name.split('.');if(!/^[a-z_0-9]+$/.test(schema)||!/^[a-z_0-9]+$/.test(table))throw Error('Unexpected test table');state[name]=(await k.query("select md5(coalesce(string_agg(to_jsonb(t)::text,chr(10) order by to_jsonb(t)::text),'')) digest from "+schema+'.'+table+' t')).rows[0].digest;}return state;
}

// One real-route sweep over every currently mounted module entry gate, including organization.
test('10. mixed-account central handoff: both view workspaces answer like the SAME actor without old roles across modules, with no writes',async()=>{
 const role=await roleOf(Object.values(MODULE_VIEW_WORDS));
 const who=await person('mixedBoundary',async id=>{await F.grantClub(id,w.B);await F.grantTeam(id,w.TB1);await F.grantIndependent(id);await F.grantPlatform(id);});
 await grant(w.adminA,who.id,role.id,'club',w.A);await grant(w.adminA,who.id,role.id,'team',w.TA1);
 const athlete=ok(await srv.api(w.adminB.cookie,'/api/organization/athletes',{method:'POST',body:{fullName:'Boundary Beta',clubId:w.B,teamId:w.TB1}}),201).athlete;
 const personal=ok(await srv.api(w.adminB.cookie,'/api/organization/athletes',{method:'POST',body:{fullName:'Boundary Personal',clubId:w.B}}),201).athlete;
 await k.query("insert into public.user_athletes(user_id,athlete_id,relationship_type,is_active) values($1,$2,'coach',true)",[who.id,personal.id]);
 await k.query('update public.athletes set user_id=$1 where id=$2',[who.id,personal.id]);
 const routes=[
  ['GET','/api/athletes/'+personal.id+'/plans'],
  ['GET','/api/tests/athlete/upcoming'],
  ['GET','/api/tests/athlete/history'],
  ['GET','/api/athletes/'+athlete.id+'/plans'],['GET','/api/admin/athletes/'+athlete.id+'/program-data'],
  ['GET','/api/athletes/today'],['GET','/api/athletes/training-days?from=2026-11-01&to=2026-11-30'],
  ['POST','/api/organization/athletes',{fullName:'Must not exist',clubId:w.B}],
  ['PUT','/api/organization/athletes/'+athlete.id,{fullName:'Must not change'}],
  ['POST','/api/training-load/sources/metrics/variables',{name:'Never',valueType:'numeric'}],
  ['POST','/api/taxonomy/node-presets',{name:'Never'}],['POST','/api/training-activity/session-types',{name:'Never'}],
  ['POST','/api/positions',{requestKey:key(),name:'Never'}],
  ['GET','/api/calendar/settings?clubId='+w.B],['POST','/api/calendar/events',{title:'Never',clubId:w.B}],
  ['GET','/api/tests/today'],['POST','/api/tests/schedules',{name:'Never'}],
  ...['/api/athletes','/api/training-load/sources/metrics','/api/taxonomy','/api/positions','/api/calendar','/api/tests'].map(p=>['GET',p+'/not-a-real-route'])
 ];
 const replies=async()=>{const out=[];for(const [method,path,body] of routes){const r=await srv.api(who.cookie,path,{method,...(body?{body}:{})});out.push({method,path,status:r.status,text:r.text});}return out;};
 for(const [type,scope]of [['club',w.A],['team',w.TA1]]){
  await setPref(who,type,scope);assert.equal((await me(who)).activeWorkspace.type,type+'_view');
  const before=await snapshot(),beforeRows=await handoffRowState(),pref=(await k.query('select * from public.user_workspace_preferences where user_id=$1',[who.id])).rows;
  const mixed=await replies();assert.equal(mixed[0].status,200,'actor-owned relationship remains as for the same actor without old roles');assert.deepEqual(mixed.slice(1,3).map(r=>r.status),[200,200],'own Tests routes retain verified athlete identity');assert.ok(mixed.every(r=>r.status!==500),'no exception masquerades as refusal');assert.deepEqual(changed(before,await snapshot()),[],'no inserted/deleted row across schemas');assert.deepEqual(await handoffRowState(),beforeRows,'no existing row changed across application schemas');
  assert.equal((await k.query('select full_name from public.athletes where id=$1',[athlete.id])).rows[0].full_name,'Boundary Beta','no existing athlete update');
  assert.deepEqual((await k.query('select * from public.user_workspace_preferences where user_id=$1',[who.id])).rows,pref,'no workspace preference write');
  try{
   for(const table of ['user_global_roles','user_club_roles','user_team_roles'])await k.query('update public.'+table+' set is_active=false where user_id=$1',[who.id]);
   const roleless=await replies();assert.deepEqual(mixed,roleless,type+'_view uses no old authority but preserves route-specific response');
  }finally{for(const table of ['user_global_roles','user_club_roles','user_team_roles'])await k.query('update public.'+table+' set is_active=true where user_id=$1',[who.id]);}
  assert.ok((await srv.api(who.cookie,'/api/auth/me')).body.user.availableWorkspaces.some(v=>v.type==='platform'),'auth still has the actual role roster');
 }
});

// V-6: dashboards (the plan's sections 2.7, 4 and 13).
// ---------------------------------------------------------------------------------------------------------------------
const D = "/api/training-load/dashboards";
const seriesOf = (answer, widgetId) => answer.widgets.find((x) => String(x.widgetId) === String(widgetId)).series;

test("11. dashboards (dashboards.view): club_view and team_view list, open and query the system templates and their own shared dashboards, read only, over their own data; an athlete-level widget answers 'restricted' without load.view.athlete; another club's, a private or a missing dashboard is the identical 404; every write (POST/DELETE /active included) answers what it answered before and lands nothing, also for a mixed account; the word and the licence close it for role holders and coaches alike", async () => {
  const pa = await person("paV6", (id) => F.grantPlatform(id));
  const today = new Date().toISOString().slice(0, 10);
  const body = { dateFrom: today, dateTo: today };
  const board = async (who, name, extra = {}) => ok(await srv.api(who.cookie, D, { method: "POST", body: { name, ...extra } }), 201).dashboard;
  let order = 0;
  const widget = async (who, d, groupBy) => {
    order += 1;
    const fresh = ok(await srv.api(who.cookie, `${D}/${d.id}`)).dashboard;
    const wd = ok(await srv.api(who.cookie, `${D}/${d.id}/widgets`, { method: "POST", body: {
      expectedDashboardRevision: fresh.revision, widgetType: "table", title: `W ${groupBy}`, widgetOrder: order, x: 0, y: (order - 1) * 4, width: 6, height: 4, mobileOrder: order, groupBy } }), 201);
    ok(await srv.api(who.cookie, `${D}/${d.id}/widgets/${wd.widgetId}/series`, { method: "POST", body: {
      expectedWidgetRevision: 1, seriesOrder: 1, ...(groupBy === "cohort"
        ? { builtInSeriesKey: "session_count", dataScopeLevel: "day", analyticalAggregation: "sum" }
        : { builtInSeriesKey: "rpe", dataScopeLevel: "session", analyticalAggregation: "avg" }) } }), 201);
    return wd.widgetId;
  };
  const dA = await board(w.adminA, "Alpha board", { ownerScope: "club", ownerClubId: w.A });
  const cohortW = await widget(w.adminA, dA, "cohort");
  const athleteW = await widget(w.adminA, dA, "athlete");
  const dayW = await widget(w.adminA, dA, "day");
  const dPriv = await board(w.adminA, "Alpha private");
  const dT = await board(w.coachA, "Alpha team board", { ownerScope: "team", ownerTeamId: w.TA1 });
  const dB = await board(w.adminB, "Beta board", { ownerScope: "club", ownerClubId: w.B });
  const tSys = (await k.query(`select * from training_load.create_dashboard('Shared template', null, 'system', null, null, null, null, null, true, $1, null)`, [pa.id])).rows[0];
  const pageOf = async (d) => (await k.query(`select id from training_load.dashboard_pages where dashboard_id = $1 order by position limit 1`, [d.id])).rows[0].id;
  const pageA = await pageOf(dA);
  const pageB = await pageOf(dB);
  // One session in each club today (club A: one athlete of club A; club B: one athlete of club B).
  const athB = ok(await srv.api(w.adminB.cookie, "/api/organization/athletes", { method: "POST", body: { fullName: "Lena Vsweepbeta", clubId: w.B, teamId: w.TB1 } }), 201).athlete;
  for (const [club, athleteId, by] of [[w.A, w.athA.id, w.adminA.id], [w.B, athB.id, w.adminB.id]]) {
    const act = (await k.query(`insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_club_id, origin, lifecycle_state, created_by_user_id)
      values ('training_session', 'Vsweep session', $1, $2, 'UTC', 'club', $3, 'manual', 'confirmed', $4) returning id`, [today, `${today}T09:00:00Z`, club, by])).rows[0].id;
    await k.query(`insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1, $2, $3, 'UTC', 'participated')`, [act, athleteId, today]);
  }
  const adminAnswer = ok(await srv.api(w.adminA.cookie, `${D}/${dA.id}/query`, { method: "POST", body }));
  assert.equal(seriesOf(adminAnswer, cohortW)[0].status, "ok", "the coach's cohort total");
  const cohortValue = seriesOf(adminAnswer, cohortW)[0].data.current;
  assert.equal(seriesOf(adminAnswer, athleteW)[0].status, "ok", "old-vs-new: the coach keeps its per-athlete widget");

  const clubHolder = await holderOf("dbClubV6", ["dashboards.view"]);
  const teamHolder = await holderOf("dbTeamV6", ["dashboards.view"], "team", w.TA1);
  // load.view.athlete is not open in a view workspace until Training Load's V step: still restricted here.
  const athleteWordHolder = await holderOf("dbNamesV6", ["dashboards.view", "load.view.athlete", "athletes.view"]);
  const before = await snapshot();
  for (const [who, label, own, others] of [
    [clubHolder, "club_view", [dA], [dB, dPriv, dT]],
    [teamHolder, "team_view", [dT], [dA, dB, dPriv]],
    [athleteWordHolder, "club_view + load.view.athlete", [dA], [dB, dPriv, dT]],
  ]) {
    const raw = await srv.api(who.cookie, `${D}?includeTemplates=true&includeArchived=true`);
    const listed = idsOf(ok(raw).dashboards);
    for (const d of [...own, tSys]) assert.ok(listed.includes(String(d.id)), `${label}: lists ${d.name}`);
    for (const d of others) assert.ok(!listed.includes(String(d.id)), `${label}: never ${d.name}`);
    assert.ok(!raw.text.includes(String(w.B)) && !raw.text.includes(String(w.TB1)), `${label}: nothing of club B`);
    assert.deepEqual(ok(await srv.api(who.cookie, `${D}/active`)), { activeDashboard: null }, `${label}: no selection`);
    for (const d of own) {
      assert.equal(ok(await srv.api(who.cookie, `${D}/${d.id}`)).dashboard.id, d.id, `${label}: opens its dashboard`);
      const pages = ok(await srv.api(who.cookie, `${D}/${d.id}/pages`));
      assert.equal(pages.canManage, false, `${label}: pages read only`);
    }
    for (const id of [...others.map((d) => d.id), RANDOM_ID]) {
      const r = await srv.api(who.cookie, `${D}/${id}`);
      const m = await srv.api(who.cookie, `${D}/${RANDOM_ID}`);
      assert.deepEqual([r.status, r.body], [m.status, m.body], `${label}: ${id} is the identical 404`);
      assert.equal(r.status, 404);
    }
    const pageMissing = await srv.api(who.cookie, `${D}/${RANDOM_ID}/pages/${RANDOM_ID}`);
    const pageForeign = await srv.api(who.cookie, `${D}/${dB.id}/pages/${pageB}`);
    assert.deepEqual([pageForeign.status, pageForeign.text], [pageMissing.status, pageMissing.text], `${label}: another club's page is the identical 404`);
    assert.equal((await srv.api(who.cookie, `${D}/${tSys.id}/query`, { method: "POST", body })).status, 409, `${label}: a template answers templateRequiresClone`);
  }
  for (const who of [clubHolder, athleteWordHolder]) {
    const raw = await srv.api(who.cookie, `${D}/${dA.id}/query`, { method: "POST", body });
    const answer = ok(raw);
    assert.equal(seriesOf(answer, cohortW)[0].status, "ok", "the cohort total is answered");
    assert.deepEqual(seriesOf(answer, cohortW)[0].data.current, cohortValue, "club A's data only, as the coach's total (ADR-002)");
    for (const wid of [athleteW, dayW]) {
      assert.deepEqual(seriesOf(answer, wid).map((s) => [s.status, s.error, s.data]), [["restricted", "namedAthletesRequired", null]], "a per-athlete widget is never queried");
    }
    assert.ok(!raw.text.includes(String(w.athA.id)) && !raw.text.includes(String(athB.id)), "no athlete id anywhere");
    // An athlete filter turns a cohort total into one athlete's data: restricted too.
    const filtered = ok(await srv.api(who.cookie, `${D}/${dA.id}/query`, { method: "POST", body: { ...body, athleteIds: [w.athA.id] } }));
    assert.equal(seriesOf(filtered, cohortW)[0].status, "restricted");
    const shell = ok(await srv.api(who.cookie, `${D}/${dA.id}/query`, { method: "POST", body: { ...body, shellFilter: { clubIds: [], teamIds: [], athleteIds: [w.athA.id] } } }));
    assert.equal(seriesOf(shell, cohortW)[0].status, "restricted");
    // The page query: the same rule.
    const page = ok(await srv.api(who.cookie, `${D}/${dA.id}/pages/${pageA}/query`, { method: "POST", body }));
    assert.equal(seriesOf(page, cohortW)[0].status, "ok");
    assert.equal(seriesOf(page, athleteW)[0].status, "restricted");
  }
  assert.deepEqual(changed(before, await snapshot()), [], "no read wrote anything (no preference, no row)");

  // The athletes a filter names are athlete-level data too (the security review's HIGH): a dashboard default filter
  // and a widget override that name athA are returned without them by every config read, to the coach with them.
  const dF = await board(w.adminA, "Alpha filtered board", { ownerScope: "club", ownerClubId: w.A, defaultFilter: { athleteIds: [w.athA.id] } });
  const fresh = ok(await srv.api(w.adminA.cookie, `${D}/${dF.id}`)).dashboard;
  ok(await srv.api(w.adminA.cookie, `${D}/${dF.id}/widgets`, { method: "POST", body: {
    expectedDashboardRevision: fresh.revision, widgetType: "table", title: "Filtered", widgetOrder: 1, x: 0, y: 0, width: 6, height: 4, mobileOrder: 1,
    groupBy: "cohort", localFilterOverride: { athleteIds: [w.athA.id] } } }), 201);
  const pageF = await pageOf(dF);
  const configReads = [`${D}/${dF.id}`, `${D}/${dF.id}/pages`, `${D}/${dF.id}/pages/${pageF}`];
  for (const who of [clubHolder, athleteWordHolder]) {
    for (const p of configReads) {
      const r = await srv.api(who.cookie, p);
      assert.equal(r.status, 200, `${p}: ${r.text.slice(0, 160)}`);
      assert.ok(!r.text.includes(String(w.athA.id)), `${p}: no athlete id in a filter`);
    }
    const one = ok(await srv.api(who.cookie, `${D}/${dF.id}`));
    assert.deepEqual(one.dashboard.default_filter, { athleteIds: null }, "the filter's other keys stay, its athletes do not");
    assert.equal(one.widgets[0].local_filter_override.athleteIds, null);
  }
  for (const p of configReads) assert.ok((await srv.api(w.adminA.cookie, p)).text.includes(String(w.athA.id)), `${p}: the coach keeps its filter (old-vs-new)`);
  // A dashboard default filter that names athletes makes its cohort total one athlete's data: restricted (the code
  // review's MEDIUM: only the request and shell filters were proven).
  const filtered = ok(await srv.api(clubHolder.cookie, `${D}/${dF.id}/query`, { method: "POST", body }));
  assert.ok(filtered.widgets.every((x) => x.series.every((sr) => sr.status === "restricted")), "a default filter naming athletes");
  // A cohort widget whose series aggregates with "none" answers one row per athlete: restricted too.
  const fresh2 = ok(await srv.api(w.adminA.cookie, `${D}/${dA.id}`)).dashboard;
  const noneW = ok(await srv.api(w.adminA.cookie, `${D}/${dA.id}/widgets`, { method: "POST", body: {
    expectedDashboardRevision: fresh2.revision, widgetType: "table", title: "None", widgetOrder: 50, x: 0, y: 40, width: 6, height: 4, mobileOrder: 50, groupBy: "cohort" } }), 201).widgetId;
  ok(await srv.api(w.adminA.cookie, `${D}/${dA.id}/widgets/${noneW}/series`, { method: "POST", body: {
    expectedWidgetRevision: 1, seriesOrder: 1, builtInSeriesKey: "rpe", dataScopeLevel: "session", analyticalAggregation: "none" } }), 201);
  const withNone = ok(await srv.api(clubHolder.cookie, `${D}/${dA.id}/query`, { method: "POST", body }));
  assert.deepEqual(seriesOf(withNone, noneW).map((sr) => sr.status), ["restricted"], "aggregation none under cohort");
  assert.equal(seriesOf(withNone, cohortW)[0].status, "ok");
  assert.equal(seriesOf(ok(await srv.api(w.adminA.cookie, `${D}/${dA.id}/query`, { method: "POST", body })), noneW)[0].status, "ok", "the coach keeps it");
  // GET /active: a selection made earlier (under an old role) is answered only when the view may see that dashboard.
  for (const [d, expected] of [[dPriv, null], [dA, String(dA.id)]]) {
    await k.query(`delete from training_load.dashboard_active_selection where user_id = $1`, [clubHolder.id]);
    await k.query(`set session_replication_role = replica`);
    try {
      await k.query(`insert into training_load.dashboard_active_selection (user_id, workspace_type, scope_id, dashboard_id) values ($1, 'club', $2, $3)`, [clubHolder.id, w.A, d.id]);
    } finally {
      await k.query(`set session_replication_role = origin`);
    }
    const active = ok(await srv.api(clubHolder.cookie, `${D}/active`)).activeDashboard;
    assert.equal(active ? String(active.dashboard_id) : null, expected, `GET /active for ${d.name}`);
  }
  await k.query(`delete from training_load.dashboard_active_selection where user_id = $1`, [clubHolder.id]);

  // Every write answers what it answered an account with no role, and lands nothing.
  for (const who of [clubHolder, teamHolder]) {
    for (const [method, p, wbody] of [
      ["POST", D, { name: "Nope" }],
      ["POST", D, { name: "Nope", ownerScope: "club", ownerClubId: w.A }],
      ["POST", `${D}/${tSys.id}/clone`, { name: "Nope" }],
      ["PATCH", `${D}/${dA.id}`, { expectedRevision: dA.revision, name: "Nope" }],
      ["POST", `${D}/${dA.id}/archive`, { expectedRevision: dA.revision }],
      ["DELETE", `${D}/${dA.id}`, { expectedRevision: dA.revision }],
      ["POST", `${D}/active`, { dashboardId: dA.id }],
      ["DELETE", `${D}/active`, undefined],
      ["POST", `${D}/${dA.id}/widgets`, { expectedDashboardRevision: 1, widgetType: "table", title: "Nope", widgetOrder: 99, x: 0, y: 0, width: 6, height: 4, mobileOrder: 99 }],
      ["POST", `${D}/${dA.id}/pages`, { requestId: key(), requestIssuedAt: new Date().toISOString(), expectedPagesRevision: 1, input: { name: "Nope" } }],
      ["GET", `${D}/${dA.id}/pages/requests/${RANDOM_ID}`, undefined],
    ]) await sameAsNobodyWrite(who, method, p, wbody);
  }
  // A forged `club` preference resolves to club_view and reads the same.
  await setPref(clubHolder, "club", w.A);
  assert.equal((await me(clubHolder)).activeWorkspace.type, "club_view");
  assert.ok(idsOf(ok(await srv.api(clubHolder.cookie, D)).dashboards).includes(String(dA.id)));
  // A mixed account: club B's admin holding club A's dashboards role, in club_view A, reads club A only and writes nothing,
  // not even its own club B's dashboard.
  const roleA = await roleOf(["dashboards.view"]);
  await grant(w.adminA, w.adminB.id, roleA.id, "club", w.A);
  await setPref(w.adminB, "club", w.A);
  try {
    assert.equal((await me(w.adminB)).activeWorkspace.type, "club_view");
    const listed = idsOf(ok(await srv.api(w.adminB.cookie, D)).dashboards);
    assert.ok(listed.includes(String(dA.id)) && !listed.includes(String(dB.id)), "club A's dashboards, never club B's");
    assert.equal((await srv.api(w.adminB.cookie, `${D}/${dB.id}`)).status, 404, "its own club's dashboard is not read through club A's view");
    await sameAsNobodyWrite(w.adminB, "PATCH", `${D}/${dB.id}`, { expectedRevision: dB.revision, name: "Nope" });
    await sameAsNobodyWrite(w.adminB, "POST", D, { name: "Nope", ownerScope: "club", ownerClubId: w.B });
    await sameAsNobodyWrite(w.adminB, "POST", `${D}/${dB.id}/pages`, { requestId: key(), requestIssuedAt: new Date().toISOString(), expectedPagesRevision: 1, input: { name: "Nope" } });
  } finally {
    await setPref(w.adminB, "club", w.B);
  }
  // A platform admin holding club A's dashboards role, in club_view A: limited like anyone there (no shortcut); the
  // pages read never offers managing (canManageDashboardRow's view line).
  const paView = await person("paViewV6", (id) => F.grantPlatform(id));
  await grant(w.adminA, paView.id, roleA.id, "club", w.A);
  await setPref(paView, "club", w.A);
  assert.equal((await me(paView)).activeWorkspace.type, "club_view");
  const paListed = idsOf(ok(await srv.api(paView.cookie, D)).dashboards);
  assert.ok(paListed.includes(String(dA.id)) && !paListed.includes(String(dB.id)) && !paListed.includes(String(dPriv.id)), "no platform shortcut in a view workspace");
  assert.equal(ok(await srv.api(paView.cookie, `${D}/${dA.id}/pages`)).canManage, false, "never offered managing");
  assert.equal(ok(await srv.api(paView.cookie, `${D}/${dA.id}/pages/${pageA}`)).canManage, false);
  const { id: definitionId } = (await k.query(`insert into training_load.metric_definitions
    (key,label,owner_scope,state,created_by_user_id)
    values('v6_reference_distance','Reference distance','system','active',$1) returning id`, [w.adminA.id])).rows[0];
  const { id: versionId } = (await k.query(`insert into training_load.metric_definition_versions
    (metric_definition_id,version_number,unit,value_type,daily_aggregation_method,created_by_user_id)
    values($1,1,'m','numeric','sum',$2) returning id`, [definitionId, w.adminA.id])).rows[0];
  await k.query("update training_load.metric_definitions set current_version_id=$2 where id=$1", [definitionId, versionId]);
  await k.query("insert into training_load.metric_definition_scope_capabilities values($1,'session')", [definitionId]);
  order += 1;
  const { id: referenceWidgetId, revision } = (await k.query(`insert into training_load.dashboard_widgets
    (dashboard_id,widget_type,title,widget_order,x,y,width,height,mobile_order,group_by)
    values($1,'bar_chart','Team reference',$2,0,$3,6,4,$2,'cohort') returning id,revision`, [dA.id, order, (order - 1) * 4])).rows[0];
  await k.query(`select * from training_load.add_series($1,$2,0,$3,null,null,'primary',null,null,
    'all_with_conflicts',null,'session','sum')`, [referenceWidgetId, revision, definitionId]);
  const { id: referenceSeriesId } = (await k.query("select id from training_load.dashboard_widget_series where widget_id=$1", [referenceWidgetId])).rows[0];
  const referenceConfig = {
    schemaVersion: 1, source: "teamAverage", mode: "overlay", clubId: w.A, teamId: w.TA1,
    axes: [{ seriesId: referenceSeriesId, valueKeys: ["teamAverage"] }]
  };
  await k.query("update training_load.dashboard_widgets set presentation_config=$2 where id=$1",
    [referenceWidgetId, { schemaVersion: 1, referenceConfig }]);
  for (const path of [`${D}/${dA.id}`, `${D}/${dA.id}/pages/${pageA}`]) {
    const adminWidget = ok(await srv.api(w.adminA.cookie, path)).widgets.find(widget => widget.id === referenceWidgetId);
    assert.deepEqual(adminWidget.presentation_config.referenceConfig, referenceConfig);
    const viewWidget = ok(await srv.api(paView.cookie, path)).widgets.find(widget => widget.id === referenceWidgetId);
    assert.equal("referenceConfig" in viewWidget.presentation_config, false);
    const viewQuery = ok(await srv.api(paView.cookie, path + "/query", { method: "POST", body }));
    const result = viewQuery.widgets.find(widget => widget.widgetId === referenceWidgetId);
    assert.ok(result);
    assert.equal(Object.hasOwn(result.presentation_config ?? {}, "referenceConfig"), false);
    assert.equal(Object.hasOwn(result, "references"), false);
  }
  // Old-vs-new: the coaches keep their dashboards, managing as before.
  const adminList = idsOf(ok(await srv.api(w.adminA.cookie, D)).dashboards);
  for (const d of [dA, dPriv, tSys]) assert.ok(adminList.includes(String(d.id)), `club admin lists ${d.name}`);
  assert.equal(ok(await srv.api(w.adminA.cookie, `${D}/${dA.id}/pages`)).canManage, true);
  assert.ok(idsOf(ok(await srv.api(w.coachA.cookie, D)).dashboards).includes(String(dT.id)));
  // The word taken away.
  const other = await holderOf("dbOtherV6", ["presets.use"]);
  await sameAsNobody(other, D, "no word");
  await sameAsNobody(other, `${D}/${dA.id}`, "no word");
  await sameAsNobody(other, `${D}/${dA.id}/pages`, "no word");
  // The licence closes the module for the role holders and for the club's old roles (reads and writes) alike.
  await ceiling(pa, ["dashboards"], []);
  try {
    for (const who of [clubHolder, teamHolder, w.adminA, w.coachA]) {
      await sameAsNobody(who, D, "closed by the licence");
      await sameAsNobody(who, `${D}/${dA.id}`, "closed by the licence");
      await sameAsNobody(who, `${D}/${dA.id}/pages`, "closed by the licence");
    }
    await sameAsNobodyWrite(w.adminA, "PATCH", `${D}/${dA.id}`, { expectedRevision: dA.revision, name: "Nope" });
    await sameAsNobodyWrite(w.adminA, "POST", `${D}/${dA.id}/pages`, { requestId: key(), requestIssuedAt: new Date().toISOString(), expectedPagesRevision: 1, input: { name: "Nope" } });
    // A create resolves no workspace: it asks the word at its owner (the code review's HIGH).
    await sameAsNobodyWrite(w.adminA, "POST", D, { name: "Nope", ownerScope: "club", ownerClubId: w.A });
    await sameAsNobodyWrite(w.coachA, "POST", D, { name: "Nope", ownerScope: "team", ownerTeamId: w.TA1 });
    assert.equal((await srv.api(w.adminB.cookie, D)).status, 200, "another club keeps it");
    assert.equal((await srv.api(w.adminB.cookie, D, { method: "POST", body: { name: "Beta again", ownerScope: "club", ownerClubId: w.B } })).status, 201, "another club still creates");
  } finally {
    await ceiling(pa, [], ["dashboards"]);
  }
  for (const who of [clubHolder, w.adminA, w.coachA]) assert.equal((await srv.api(who.cookie, D)).status, 200, "reopened");
});

// V-7: Programs and Exercises (the plan's "V-7 design"; P-1, P-2).
// ---------------------------------------------------------------------------------------------------------------------
test("12. programs (programs.view) and exercises (exercises.use): a view workspace reads its club's or team's athletes' published programs (with athletes.view too), the public Program Library and the system exercise library, read only; never a draft, another club, its own items or a write; the word and the licence close both modules for role holders and coaches alike", async () => {
  const pa = await person("paV7", (id) => F.grantPlatform(id));
  const one = async (sql, params) => (await k.query(sql, params)).rows[0];
  const mk = async (who, body) => ok(await srv.api(who.cookie, "/api/organization/athletes", { method: "POST", body }), 201).athlete;
  const athB = await mk(w.adminB, { fullName: "Ivo Vsevenbeta", clubId: w.B, teamId: w.TB1 });
  const codeOf = async (id) => (await one(`select athlete_id from public.athletes where id = $1`, [id])).athlete_id;
  const codeA = await codeOf(w.athA.id);
  const codeB = await codeOf(athB.id);
  const program = async (by, athleteId, name, status) => (await one(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, is_template, is_active, status)
     values ('program', $1, $2, $3, false, true, $4) returning id`, [by, athleteId, name, status])).id;
  const progActive = await program(w.adminA.id, w.athA.id, "Vseven active block", "active");
  const progDraft = await program(w.adminA.id, w.athA.id, "Vseven draft block", "draft");
  const progArchived = await program(w.adminA.id, w.athA.id, "Vseven archived block", "archived");
  const progB = await program(w.adminB.id, athB.id, "Vseven beta block", "active");
  const template = async (by, name, visibility, status) => (await one(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template, library_scope, visibility, status, is_active)
     values ('program', $1, $2, true, 'optimove', $3, $4, true) returning id`, [by, name, visibility, status])).id;
  const tplPublic = await template(w.coachA.id, "Vseven public template", "public", "active");
  const tplPrivate = await template(w.adminB.id, "Vseven private template", "private", "active");
  const tplDraft = await template(w.coachA.id, "Vseven public draft template", "public", "draft");
  const exercise = async (name, scope, owner, active) => (await one(
    `insert into library.exercises (name, owner_scope, owner_user_id, is_active) values ($1, $2, $3, $4) returning id`,
    [name, scope, owner, active])).id;
  const exSystem = await exercise("Vseven system squat", "system", null, true);
  const exArchived = await exercise("Vseven archived lunge", "system", null, false);
  const exOwn = await exercise("Vseven own drill", "user", w.adminB.id, true);
  const hiddenForeign = [String(progDraft), String(progArchived), String(progB), "Vseven draft", "Vseven archived", "Vsevenbeta",
    String(tplPrivate), String(tplDraft), String(exArchived), String(exOwn), "Vseven own drill"];
  const programIds = async (who, code) => ok(await srv.api(who.cookie, `/api/athletes/${code}/program-data?program=__all_programs__`))
    .programs.map((p) => String(p.id)).sort();
  const templateIds = async (who) => ok(await srv.api(who.cookie, "/api/templates?scope=all")).templates.map((t) => String(t.plan_id));
  const exerciseIds = async (who, q = "") => ok(await srv.api(who.cookie, `/api/exercises?limit=500${q}`)).exercises.map((e) => String(e.id));
  const { VIEW_TEMPLATE_HIDDEN_KEYS } = await import("../src/routes/templates.js");
  const MISSING = "6f0e8a52-8d0b-4a8e-9b51-3a3c0e0c0b12";

  // Old-vs-new: the basic roles (they hold both words) keep every program, the Builder and the library.
  assert.deepEqual(await programIds(w.adminA, codeA), [progActive, progArchived, progDraft].map(String).sort(), "club admin: every program, drafts too");
  assert.equal((await srv.api(w.adminA.cookie, "/api/builder/drafts")).status, 200);
  assert.equal((await srv.api(w.coachA.cookie, "/api/builder/drafts")).status, 200);
  assert.ok((await exerciseIds(w.adminA)).includes(String(exSystem)));
  assert.ok((await exerciseIds(w.adminB)).includes(String(exOwn)), "a coach keeps its own exercises");
  assert.equal((await srv.api(w.adminA.cookie, `/api/athletes/${codeB}/program-data`)).status, 403, "never another club's athlete");

  const clubHolder = await holderOf("pgClub", ["programs.view", "athletes.view", "exercises.use"]);
  const teamHolder = await holderOf("pgTeam", ["programs.view", "athletes.view", "exercises.use"], "team", w.TA1);
  for (const [who, label] of [[clubHolder, "club_view"], [teamHolder, "team_view"]]) {
    const words = (await me(who)).permissions;
    assert.ok(words.includes("programs.view") && words.includes("exercises.use"), `${label}: /me offers both words`);
    const prefBefore = (await k.query(`select * from public.user_workspace_preferences where user_id = $1`, [who.id])).rows;
    // An athlete's programs: published only, its club's or team's athlete only.
    const data = ok(await srv.api(who.cookie, `/api/athletes/${codeA}/program-data?program=__all_programs__`));
    assert.deepEqual(data.programs.map((p) => String(p.id)), [String(progActive)], `${label}: the published program only`);
    const chooser = data.adminRows.map((r) => r.athlete_id);
    assert.ok(chooser.includes(codeA) && !chooser.includes(codeB), `${label}: the chooser lists its own athletes only (${chooser})`);
    assert.deepEqual(has(JSON.stringify(data), hiddenForeign), [], `${label}: no draft, archived or foreign program`);
    for (const code of [codeB, "NOPE-404"]) await sameAsNobody(who, `/api/athletes/${code}/program-data`, `${label} another club / missing`);
    // The public Program Library only.
    const list = ok(await srv.api(who.cookie, "/api/templates?scope=all"));
    assert.deepEqual(list.templates.map((t) => String(t.plan_id)), [String(tplPublic)], `${label}: the public template only`);
    for (const t of list.templates) for (const hidden of VIEW_TEMPLATE_HIDDEN_KEYS) assert.ok(!Object.hasOwn(t, hidden), `${label}: no ${hidden}`);
    const options = ok(await srv.api(who.cookie, "/api/templates/options"));
    assert.ok(!JSON.stringify(options).includes("@"), `${label}: no e-mail in the options`);
    assert.equal((await srv.api(who.cookie, `/api/plans/${tplPublic}/program`)).status, 200, `${label}: the public template's program`);
    assert.equal((await srv.api(who.cookie, `/api/templates/${tplPublic}/reviews`)).status, 200);
    const privateAnswer = await srv.api(who.cookie, `/api/plans/${tplPrivate}/program`);
    const missingAnswer = await srv.api(who.cookie, `/api/plans/${MISSING}/program`);
    assert.deepEqual([privateAnswer.status, privateAnswer.text], [403, JSON.stringify({ error: "Forbidden" })], `${label}: a private template`);
    assert.deepEqual([missingAnswer.status, missingAnswer.text], [privateAnswer.status, privateAnswer.text], `${label}: missing = not allowed`);
    assert.equal((await srv.api(who.cookie, `/api/plans/${tplDraft}/program`)).status, 403, `${label}: a draft template`);
    assert.equal((await srv.api(who.cookie, `/api/templates/${tplPrivate}/reviews`)).status, 404, `${label}: a private template's reviews`);
    // The system exercise library only, read only.
    const exList = ok(await srv.api(who.cookie, "/api/exercises?limit=500&kind=mine&visibility=all&lockedPreviews=1"));
    assert.ok(exList.exercises.some((e) => String(e.id) === String(exSystem)), `${label}: the system exercise`);
    assert.ok(exList.exercises.every((e) => e.owner_scope === "system" && e.is_active && !e.can_edit && !e.can_copy && !e.is_favorite && !e.is_hidden), `${label}: system, active, read only`);
    assert.deepEqual([exList.canManageCollections, exList.lockedPreviews], [false, []]);
    assert.deepEqual(has(JSON.stringify(exList), hiddenForeign), [], `${label}: no archived or own exercise`);
    const detail = ok(await srv.api(who.cookie, `/api/exercises/${exSystem}`));
    assert.deepEqual([detail.canEdit, detail.canCopy], [false, false], `${label}: nothing to edit or copy`);
    const ownAnswer = await srv.api(who.cookie, `/api/exercises/${exOwn}`);
    const missingEx = await srv.api(who.cookie, `/api/exercises/${MISSING}`);
    assert.deepEqual([ownAnswer.status, ownAnswer.text], [missingEx.status, missingEx.text], `${label}: someone's own exercise = a missing one`);
    assert.equal(ownAnswer.status, 404);
    assert.equal((await srv.api(who.cookie, "/api/exercises/options")).status, 200);
    // Not listed: what it answered before, or requireCoach's 403.
    for (const p of [`/api/athletes/${codeA}/plans`, `/api/plans/${progActive}/weekly`, `/api/templates/${tplPublic}/access-requests`]) {
      await sameAsNobody(who, p, `${label} unlisted`);
    }
    for (const p of ["/api/builder/drafts", "/api/builder/weekly-plans", "/api/exercise-collections", "/api/exercise-collections/catalog", "/api/exercises/owners"]) {
      const a = await srv.api(who.cookie, p);
      assert.deepEqual([a.status, a.text], [403, JSON.stringify({ error: "Forbidden" })], `${label} ${p}`);
    }
    const prefAfter = (await k.query(`select * from public.user_workspace_preferences where user_id = $1`, [who.id])).rows;
    assert.deepEqual(prefAfter, prefBefore, `${label}: no preference written by a read`);
    await writesLandNothing(who, [
      ["POST", `/api/templates/${tplPublic}/use`, {}], ["POST", `/api/templates/${tplPublic}/reviews`, { rating: 5 }],
      ["PATCH", `/api/templates/${tplPublic}/metadata`, { name: "Nope" }], ["POST", `/api/templates/${tplPublic}/assignments`, { athleteIds: [w.athA.id] }],
      ["POST", "/api/builder/plans", { name: "Nope" }], ["POST", "/api/exercises", { name: "Nope" }],
      ["POST", `/api/exercises/${exSystem}/favorite`, {}], ["POST", `/api/exercises/${exSystem}/hidden`, { hidden: true }],
      ["POST", "/api/exercise-collections", { name: "Nope" }],
    ], 403);
  }
  // programs.view without athletes.view (P-1): the library, never an athlete's page.
  const libraryOnly = await holderOf("pgLibrary", ["programs.view"]);
  assert.deepEqual(await templateIds(libraryOnly), [String(tplPublic)]);
  await sameAsNobody(libraryOnly, `/api/athletes/${codeA}/program-data`, "no athletes.view");
  // The word taken away: an account holding only athletes.view gets today's answers.
  const athletesOnly = await holderOf("pgNoWord", ["athletes.view"]);
  for (const p of [`/api/athletes/${codeA}/program-data`, "/api/templates?scope=all", `/api/plans/${tplPublic}/program`]) await sameAsNobody(athletesOnly, p, "no word");
  for (const p of ["/api/exercises", `/api/exercises/${exSystem}`]) assert.equal((await srv.api(athletesOnly.cookie, p)).status, 403, `no word ${p}`);
  // A mixed account: club B's admin with a view role in club A, in club_view A: nothing of its own or of club B.
  const roleA = await roleOf(["programs.view", "athletes.view", "exercises.use"]);
  await grant(w.adminA, w.adminB.id, roleA.id, "club", w.A);
  await setPref(w.adminB, "club", w.A);
  try {
    assert.equal((await me(w.adminB)).activeWorkspace.type, "club_view");
    assert.deepEqual(await templateIds(w.adminB), [String(tplPublic)], "mixed: never its own private template");
    assert.ok(!(await exerciseIds(w.adminB)).includes(String(exOwn)), "mixed: never its own exercise");
    assert.equal((await srv.api(w.adminB.cookie, `/api/exercises/${exOwn}`)).status, 404, "mixed: its own exercise's detail is not a view read");
    assert.ok(!JSON.stringify(ok(await srv.api(w.adminB.cookie, "/api/templates/options"))).includes("Vseven private"), "mixed: no option of its own private template");
    assert.equal((await srv.api(w.adminB.cookie, `/api/athletes/${codeB}/program-data`)).status, 403, "mixed: never club B's athlete through the view");
    assert.deepEqual(await programIds(w.adminB, codeA), [String(progActive)], "mixed: club A's published program");
    await writesLandNothing(w.adminB, [["POST", "/api/builder/plans", { name: "Nope" }], ["POST", "/api/exercises", { name: "Nope" }],
      ["PATCH", `/api/templates/${tplPrivate}/metadata`, { name: "Nope" }]], 403);
  } finally {
    await setPref(w.adminB, "club", w.B);
  }
  assert.ok((await templateIds(w.adminB)).includes(String(tplPrivate)), "back in club B: its own template");
  // An independent coach who is also club A's admin, in its private workspace: the module gate does not apply there, so
  // the athlete branch of the plan reads (programViewScopes) is what the licence narrows; its own work is untouched.
  const dual = await person("pgDual", async (id) => { await F.grantClub(id, w.A); await F.grantIndependent(id); });
  await setPref(dual, "private_coach", null);
  assert.equal((await me(dual)).activeWorkspace.type, "private_coach");
  assert.equal((await srv.api(dual.cookie, `/api/athletes/${codeA}/plans`)).status, 200, "dual: club A's athlete through its club role");
  // The licence closes Programs and Exercises for club A: role holders AND the club's coaches lose them; another club and a
  // platform admin keep them.
  await ceiling(pa, ["programs", "exercises"], []);
  try {
    assert.equal((await srv.api(dual.cookie, `/api/athletes/${codeA}/plans`)).status, 403, "licence: the club branch of the plan reads closes outside a club workspace too");
    assert.equal((await srv.api(dual.cookie, `/api/plans/${progActive}/weekly`)).status, 403, "licence: canAccessPlan's athlete branch closes");
    assert.equal((await srv.api(dual.cookie, "/api/builder/drafts")).status, 200, "licence: its own Builder stays (private workspace)");
    await sameAsNobody(clubHolder, `/api/athletes/${codeA}/program-data`, "licence");
    await sameAsNobody(clubHolder, "/api/templates?scope=all", "licence");
    assert.equal((await srv.api(clubHolder.cookie, "/api/exercises")).status, 403, "licence: no exercise library");
    for (const who of [w.adminA, w.coachA]) {
      for (const p of ["/api/builder/drafts", "/api/templates", "/api/exercises", "/api/exercise-collections", `/api/athletes/${codeA}/plans`, `/api/plans/${tplPublic}/program`]) {
        const a = await srv.api(who.cookie, p);
        assert.equal(a.status, 403, `licence: ${p} closed for a coach of club A`);
      }
    }
    await writesLandNothing(w.adminA, [["POST", "/api/builder/plans", { name: "Nope" }], ["POST", "/api/exercises", { name: "Nope" }]], 403);
    assert.equal((await srv.api(w.adminB.cookie, "/api/builder/drafts")).status, 200, "another club keeps it");
    assert.equal((await srv.api(pa.cookie, "/api/builder/drafts")).status, 200, "a platform admin is never limited");
    assert.ok((await programIds(pa, codeA)).includes(String(progActive)), "a platform admin reads the plans");
  } finally {
    await ceiling(pa, [], ["programs", "exercises"]);
  }
  assert.equal((await srv.api(w.adminA.cookie, "/api/builder/drafts")).status, 200, "reopened");
  assert.deepEqual(await programIds(clubHolder, codeA), [String(progActive)], "reopened for the holder");
});

// The manager's request (2026-11-25): /api/templates has no requireCoach, so an athlete account reads the public Program
// Library today. Pinned, so a V step cannot change it by accident.
test("10. an athlete account's GET /api/templates is today's answer: 200 with exactly the templates its athlete library access opens", async () => {
  const one = async (sql, params) => (await k.query(sql, params)).rows[0];
  const ath = await one(`insert into public.athletes (athlete_id, first_name, last_name, full_name) values ('V7-ATH', 'Nina', 'Vsevenath', 'Nina Vsevenath') returning id`, []);
  const athleteUser = await person("v7Athlete");
  await k.query(`update public.athletes set user_id = $1 where id = $2`, [athleteUser.id, ath.id]);
  await k.query(`insert into public.athlete_library_access (athlete_id, can_view_optimove_library, free_only, require_approval) values ($1, true, true, false)`, [ath.id]);
  const template = async (name, direct) => (await one(
    `insert into plans.plans (plan_type, created_by_user_id, name, is_template, library_scope, visibility, status, is_active, is_free, athlete_can_view_directly)
     values ('program', $1, $2, true, 'optimove', 'public', 'active', true, true, $3) returning id`, [w.coachA.id, name, direct])).id;
  const open = await template("V10 athlete open template", true);
  const coachOnly = await template("V10 coach only template", false);
  for (const q of ["", "?scope=all", "?scope=optimove"]) {
    const a = await srv.api(athleteUser.cookie, `/api/templates${q}`);
    assert.equal(a.status, 200, a.text);
    const ids = a.body.templates.map((t) => String(t.plan_id));
    assert.equal(ids.includes(String(open)), q !== "", `${q}: the template its optimove library access opens (the default scope is my_programs)`);
    assert.ok(!ids.includes(String(coachOnly)), `${q}: never a template not open to athletes directly`);
    assert.ok(a.body.templates.every((t) => Object.hasOwn(t, "creator_email")), `${q}: the athlete's rows are unchanged (no view reduction)`);
    assert.deepEqual(a.body.allowedScopes, ["my_programs", "optimove"], `${q}: its scopes`);
  }
});
