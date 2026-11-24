// Roles V-0 (docs/ai/roles-v-steps-plan.md sections 3 and 4): the fail-closed sweep of the V steps, one row per module.
// Disposable database, the real server. A closed row: an account holding EVERY view word in a club_view workspace (and
// again with a forged `club` preference) gets from that module exactly what an account with no role gets, and no write
// lands anywhere. Each module's V pull request turns its row to "open" and adds the checks of the plan's section 4 for it
// (only the listed reads, club A only, the ceiling, old-vs-new, the word taken away). V-1 opens data_configuration (test
// 5) and presets (test 6).
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

test("1. the table covers every module of MODULE_VIEW_WORDS, and the open rows are exactly OPEN_VIEW_MODULES (V-1: data configuration, presets)", () => {
  const table = rows();
  assert.deepEqual(table.map((r) => r.module).sort(), Object.keys(MODULE_VIEW_WORDS).sort());
  assert.deepEqual(table.filter((r) => r.open).map((r) => r.module).sort(), [...OPEN_VIEW_MODULES].sort());
  assert.deepEqual([...OPEN_VIEW_MODULES].sort(), ["data_configuration", "presets"]);
});

test("2. closed rows: every view word in club_view (and with a forged club preference) = an account with no role; no write lands; no preference is written", async () => {
  const hm = await me(w.all);
  assert.equal(hm.activeWorkspace.type, "club_view");
  assert.deepEqual([...hm.permissions].sort(), ["org.view", "presets.use", "variables.view"], "/me offers only the words of open modules");
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
// V-1: the open rows (the plan's sections 2.1, 2.2 and 4).
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
