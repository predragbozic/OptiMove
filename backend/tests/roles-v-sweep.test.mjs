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

test("1. the table covers every module of MODULE_VIEW_WORDS, and the open rows are exactly OPEN_VIEW_MODULES (V-1: data configuration, presets; V-2: athletes; V-3: calendar; V-4: tests)", () => {
  const table = rows();
  assert.deepEqual(table.map((r) => r.module).sort(), Object.keys(MODULE_VIEW_WORDS).sort());
  assert.deepEqual(table.filter((r) => r.open).map((r) => r.module).sort(), [...OPEN_VIEW_MODULES].sort());
  assert.deepEqual([...OPEN_VIEW_MODULES].sort(), ["athletes", "calendar", "data_configuration", "presets", "tests", "tests_results"]);
});

test("2. closed rows: every view word in club_view (and with a forged club preference) = an account with no role; no write lands; no preference is written", async () => {
  const hm = await me(w.all);
  assert.equal(hm.activeWorkspace.type, "club_view");
  assert.deepEqual([...hm.permissions].sort(), ["athletes.view", "calendar.view", "org.view", "presets.use", "tests.results.view", "tests.view", "variables.view"], "/me offers only the words of open modules");
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
    // Pinned, not changed by V-2 (recorded in the plan's section 10): a read the athletes gate hands on unchanged still
    // answers from the account's OLD roles, whatever the active workspace - club B's admin reads its club B athlete's
    // plans while in club_view A, as before V-2. The view role itself gives nothing there.
    assert.equal((await srv.api(w.adminB.cookie, `/api/athletes/${athB.id}/plans`)).status, 200, "mixed hand-on read: club B, its old role, as before");
    assert.equal((await srv.api(w.adminB.cookie, `/api/athletes/${w.athA.id}/plans`)).status, 403, "mixed hand-on read: nothing of club A through the view role");
    // The view role gives no write in club A (organization writes check the old roles, as before V-2; a write for
    // club B, which it administers, is unchanged by the active workspace and is not a V-2 question).
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
