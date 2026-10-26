// The older Metrics Core catalog API (/api/training-load/metrics) and the
// canonical variables (owner decision of 2026-10-26, discovery document C98,
// superseding part of C82): a system or club definition is created and
// changed only through the canonical-variable admin API (M3-0). The older
// create, cosmetic edit, level change, archive and new version answer an
// authorized caller 409 canonical_variable_read_only and write nothing; a
// definition, domain, category or structure link that is missing, not
// visible or not the caller's to manage answers the identical 404 (ADR-006);
// team and user definitions keep every older capability. Through the real
// HTTP stack, on a disposable optimove_tests_gpexe_* database migrated
// through the current migrations (never OPTIMOVE).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN } from "./_gpexe-disposable-db.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const OLD = "/api/training-load/metrics";
const NEW = "/api/training-load/sources/metrics";
const READ_ONLY = { error: "System and club variables can only be changed in Training Load > Data configuration.", code: "canonical_variable_read_only" };
const DEFINITION_404 = JSON.stringify({ error: "Metric definition not found." });
const NODE_404 = JSON.stringify({ error: "Not found." });

let db, k, server, base, appPool, createSession;
const W = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "cguard" });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  appPool = (await import("../src/db.js")).pool;
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await world();
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) await Promise.race([appPool.end(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await k?.end().catch(() => {});
  await db?.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

// ---------------------------------------------------------------------------
// helpers
const uid = () => crypto.randomBytes(4).toString("hex");
const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
const rows = async (sql, params = []) => (await k.query(sql, params)).rows;

// `raw` sends a body exactly as given, declared as JSON (an unreadable body).
async function api(path, { method = "GET", body, raw, who, prefix = OLD, signal } = {}) {
  const sendsBody = body !== undefined || raw !== undefined;
  const res = await fetch(`${base}${prefix}${path}`, {
    method,
    signal,
    headers: { ...(sendsBody ? { "Content-Type": "application/json" } : {}), ...(who ? { Cookie: who.cookie } : {}) },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

async function user(label) {
  return (await one(`insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,true) returning id`, [`${label}-${uid()}@test.local`, label])).id;
}
async function workspace(userId, type, scopeId) {
  await k.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
    on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (id) => `optimove_session=${await createSession(id)}`;
async function account(label, { global = [], clubAdminOf = null, teamCoachOf = null, ws }) {
  const id = await user(label);
  for (const role of global) await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,$2,true)`, [id, role]);
  if (clubAdminOf) await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubAdminOf]);
  if (teamCoachOf) await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamCoachOf]);
  await workspace(id, ws[0], ws[1]);
  return { id, cookie: await cookieFor(id) };
}

// Everything an older write could touch for one definition, and the totals of
// every Metrics Core definition table: a refused write must leave both equal.
async function snapshot(definitionId) {
  return {
    definition: await one(`select * from training_load.metric_definitions where id = $1`, [definitionId]),
    versions: await rows(`select * from training_load.metric_definition_versions where metric_definition_id = $1 order by version_number`, [definitionId]),
    levels: await rows(`select * from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 order by scope_level`, [definitionId]),
    totals: await one(`select (select count(*) from training_load.metric_definitions)::int as definitions,
      (select count(*) from training_load.metric_definition_versions)::int as versions,
      (select count(*) from training_load.metric_definition_scope_capabilities)::int as levels,
      (select count(*) from training_load.metric_variable_requests)::int as requests`),
  };
}

const OLDER_WRITES = [
  ["PATCH a name", (id) => ({ path: `/definitions/${id}`, method: "PATCH", body: { label: "Renamed", shortLabel: "RN", description: "changed" } })],
  ["PUT the levels", (id) => ({ path: `/definitions/${id}/scope-capabilities`, method: "PUT", body: { scopeCapabilities: ["session", "component", "day"] } })],
  ["POST an archive", (id) => ({ path: `/definitions/${id}/archive`, method: "POST", body: {} })],
  ["POST a new version", (id) => ({ path: `/definitions/${id}/versions`, method: "POST", body: { valueType: "text", unit: "x y", reason: "bypass" } })],
];

async function world() {
  W.clubA = (await one(`insert into public.clubs (name) values ($1) returning id`, [`Club A ${uid()}`])).id;
  W.clubB = (await one(`insert into public.clubs (name) values ($1) returning id`, [`Club B ${uid()}`])).id;
  W.teamA = (await one(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [W.clubA, `Team ${uid()}`])).id;
  W.pa = await account("platform-admin", { global: ["platform_admin"], ws: ["platform", null] });
  W.paInClubA = await account("platform-admin-club", { global: ["platform_admin"], clubAdminOf: W.clubA, ws: ["club", W.clubA] });
  W.caA = await account("club-admin-a", { clubAdminOf: W.clubA, ws: ["club", W.clubA] });
  W.caB = await account("club-admin-b", { clubAdminOf: W.clubB, ws: ["club", W.clubB] });
  W.coach = await account("team-coach", { teamCoachOf: W.teamA, ws: ["team", W.teamA] });
  W.privateCoach = await account("private-coach", { global: ["independent_coach"], ws: ["private_coach", null] });

  // Canonical variables made the sanctioned way (M3-0) ...
  const made = async (who, label) => {
    const res = await api("/variables", { method: "POST", who, prefix: NEW, body: { requestKey: crypto.randomUUID(), label, unit: "m", levels: ["session"], dailyAggregationMethod: "sum" } });
    assert.equal(res.status, 201, res.text);
    return res.body.variable.id;
  };
  W.system = await made(W.pa, `System distance ${uid()}`);
  W.club = await made(W.caA, `Club distance ${uid()}`);
  // ... and a system definition as the older API wrote one before C98 (no
  // request record): the rule follows the owner scope, not the creation path.
  W.legacy = (await one(`insert into training_load.metric_definitions (key, label, owner_scope) values ($1,'Legacy system','system') returning id`, [`legacy_${uid()}`])).id;
  const legacyVersion = (await one(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type) values ($1,1,'m','numeric') returning id`, [W.legacy])).id;
  await k.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [legacyVersion, W.legacy]);
  await k.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1,'session')`, [W.legacy]);
}

// ---------------------------------------------------------------------------
test("1. every older write of a system or club definition answers an authorized caller 409 canonical_variable_read_only and changes nothing - whoever made it, in whichever workspace", async () => {
  const cases = [
    [W.pa, W.system, "platform admin, system variable"],
    [W.paInClubA, W.system, "platform admin in a club workspace, system variable"],
    [W.pa, W.club, "platform admin, club variable"],
    [W.paInClubA, W.club, "platform admin in that club's workspace, club variable"],
    [W.caA, W.club, "the owning club's admin, club variable"],
    [W.pa, W.legacy, "platform admin, a system definition the older API wrote before C98"],
  ];
  for (const [who, id, label] of cases) {
    for (const [name, make] of OLDER_WRITES) {
      const before_ = await snapshot(id);
      const { path, method, body } = make(id);
      const res = await api(path, { method, body, who });
      assert.equal(res.status, 409, `${label} / ${name}: ${res.text}`);
      assert.deepEqual(res.body, READ_ONLY, `${label} / ${name}`);
      assert.deepEqual(await snapshot(id), before_, `${label} / ${name}: nothing changed`);
    }
  }
});

test("2. creating a system or club definition through the older API: 409 for a caller allowed that scope, nothing written; the existing 403 for a caller who is not", async () => {
  const before_ = await snapshot(W.system);
  const body = (over) => ({ key: `bypass_${uid()}`, label: "Bypass", valueType: "numeric", unit: "m", scopeCapabilities: ["session"], ...over });
  for (const [who, over, label] of [
    [W.pa, { ownerScope: "system" }, "platform admin, system"],
    [W.pa, { ownerScope: "club", ownerClubId: W.clubA }, "platform admin, club"],
    [W.caA, { ownerScope: "club", ownerClubId: W.clubA }, "club admin, own club"],
  ]) {
    const res = await api("/definitions", { method: "POST", who, body: body(over) });
    assert.equal(res.status, 409, `${label}: ${res.text}`);
    assert.deepEqual(res.body, READ_ONLY, label);
  }
  assert.deepEqual((await snapshot(W.system)).totals, before_.totals, "no definition, version, level or request row was written");
  const coachSystem = await api("/definitions", { method: "POST", who: W.coach, body: body({ ownerScope: "system" }) });
  assert.deepEqual([coachSystem.status, coachSystem.body], [403, { error: "Only a platform administrator can create shared system-wide catalog content." }]);
  const otherClub = await api("/definitions", { method: "POST", who: W.caA, body: body({ ownerScope: "club", ownerClubId: W.clubB }) });
  assert.deepEqual([otherClub.status, otherClub.body], [403, { error: "That club is outside your access." }]);
  assert.deepEqual((await snapshot(W.system)).totals, before_.totals);
});

test("3. ADR-006: a definition that is missing, malformed, another club's, visible but not the caller's to manage, or not visible at all answers the byte-identical 404 - never 403, never the 409 that would confirm a canonical variable", async () => {
  const teamDef = await api("/definitions", { method: "POST", who: W.coach, body: { key: `team_${uid()}`, label: "Team metric", ownerScope: "team", ownerTeamId: W.teamA, valueType: "numeric", unit: "m", scopeCapabilities: ["session"] } });
  assert.equal(teamDef.status, 201, teamDef.text);
  const cases = [
    [W.caA, crypto.randomUUID(), "missing"],
    [W.caA, "not-a-uuid", "malformed"],
    [W.caB, W.club, "another club's club variable"],
    [W.coach, W.system, "a system variable a coach sees but may not manage"],
    [W.coach, W.club, "a club variable a team coach of that club does not even see"],
    [W.privateCoach, teamDef.body.row.id, "a team definition outside the caller's access"],
    [W.caB, teamDef.body.row.id, "another club's team definition"],
  ];
  for (const [who, id, label] of cases) {
    for (const [name, make] of OLDER_WRITES) {
      const before_ = id === "not-a-uuid" ? null : await snapshot(id);
      const { path, method, body } = make(id);
      const res = await api(path, { method, body, who });
      assert.equal(res.status, 404, `${label} / ${name}: ${res.text}`);
      assert.equal(res.text, DEFINITION_404, `${label} / ${name}`);
      if (before_) assert.deepEqual(await snapshot(id), before_, `${label} / ${name}: nothing changed`);
    }
  }
});

test("3b. the two writers that take a body (levels, a new version): the right is decided before the body - every missing, malformed, hidden or not-manageable id answers the identical 404 and every canonical variable the 409 whatever the body (none, empty, wrong, valid); only a definition the caller may write gets the body's 400; an unreadable body is refused before any route, identically for every id; nothing is ever written by a refusal", async () => {
  const teamDef = await api("/definitions", { method: "POST", who: W.coach, body: { key: `body_team_${uid()}`, label: "Body team", ownerScope: "team", ownerTeamId: W.teamA, valueType: "numeric", unit: "m", scopeCapabilities: ["session"] } });
  const userDef = await api("/definitions", { method: "POST", who: W.privateCoach, body: { key: `body_user_${uid()}`, label: "Body user", ownerScope: "user", valueType: "numeric", unit: "m", scopeCapabilities: ["session"] } });
  for (const res of [teamDef, userDef]) assert.equal(res.status, 201, res.text);
  const TEAM = teamDef.body.row.id;
  const USER = userDef.body.row.id;
  const world_ = async () => ({ system: await snapshot(W.system), club: await snapshot(W.club), team: await snapshot(TEAM), user: await snapshot(USER) });

  const BODIES = {
    levels: {
      path: (id) => `/definitions/${id}/scope-capabilities`,
      method: "PUT",
      invalid: [["no body", {}], ["an empty object", { body: {} }], ["an array", { body: [] }], ["not an array", { body: { scopeCapabilities: "session" } }], ["an unknown level", { body: { scopeCapabilities: ["bogus"] } }], ["null levels", { body: { scopeCapabilities: null } }]],
      valid: { body: { scopeCapabilities: ["session", "component"] } },
    },
    version: {
      path: (id) => `/definitions/${id}/versions`,
      method: "POST",
      invalid: [["no body", {}], ["an empty object", { body: {} }], ["an array", { body: [] }], ["an unknown value type", { body: { valueType: "bogus", unit: "m" } }], ["bounds reversed", { body: { valueType: "numeric", unit: "m", minValue: 5, maxValue: 1 } }], ["a condition that is not an object", { body: { valueType: "numeric", unit: "m", conditionDescription: "x" } }]],
      valid: { body: { valueType: "numeric", unit: "km" } },
    },
  };
  const NOT_WRITABLE = [
    [W.coach, crypto.randomUUID(), 404, "a missing id"],
    [W.coach, "not-a-uuid", 404, "a malformed id"],
    [W.caB, W.club, 404, "another club's club variable (hidden)"],
    [W.privateCoach, TEAM, 404, "someone's team definition (hidden)"],
    [W.caB, TEAM, 404, "another club's team definition (hidden)"],
    [W.coach, W.system, 404, "a system variable a coach sees but may not manage"],
    [W.coach, USER, 404, "another coach's own definition (hidden)"],
    [W.pa, W.system, 409, "a platform admin on a system variable"],
    [W.paInClubA, W.club, 409, "a platform admin in the club's workspace on its club variable"],
    [W.caA, W.club, 409, "the club's admin on its club variable"],
  ];
  for (const [writer, spec] of Object.entries(BODIES)) {
    for (const [who, id, status, label] of NOT_WRITABLE) {
      for (const [bodyName, opts] of [...spec.invalid, ["a valid body", spec.valid]]) {
        const before_ = await world_();
        const res = await api(spec.path(id), { method: spec.method, who, ...opts });
        if (status === 404) assert.deepEqual([res.status, res.text], [404, DEFINITION_404], `${writer} / ${label} / ${bodyName}`);
        else assert.deepEqual([res.status, res.body], [409, READ_ONLY], `${writer} / ${label} / ${bodyName}`);
        assert.deepEqual(await world_(), before_, `${writer} / ${label} / ${bodyName}: nothing written`);
      }
    }
    // A definition the caller may write: the body is judged, and refused
    // with its own 400 before anything is written.
    for (const [who, id, label] of [[W.coach, TEAM, "a team coach on the team's definition"], [W.pa, TEAM, "a platform admin on a team definition"], [W.privateCoach, USER, "a private coach on their own definition"]]) {
      for (const [bodyName, opts] of spec.invalid) {
        const before_ = await world_();
        const res = await api(spec.path(id), { method: spec.method, who, ...opts });
        assert.equal(res.status, 400, `${writer} / ${label} / ${bodyName}: ${res.text}`);
        assert.equal(typeof res.body?.error, "string", `${writer} / ${label} / ${bodyName}: a validation sentence`);
        assert.notEqual(res.text, DEFINITION_404);
        assert.deepEqual(await world_(), before_, `${writer} / ${label} / ${bodyName}: nothing written`);
      }
    }
    // An unreadable body never reaches a route: the app-wide JSON parser
    // answers the same 400 whatever the id and whoever asks.
    const unreadable = [];
    for (const [who, id] of [...NOT_WRITABLE.map(([w, i]) => [w, i]), [W.coach, TEAM], [null, W.system]]) {
      const before_ = await world_();
      const res = await api(spec.path(id), { method: spec.method, who: who || undefined, raw: "{not json" });
      unreadable.push([res.status, res.text]);
      assert.deepEqual(await world_(), before_, `${writer} / unreadable body: nothing written`);
    }
    assert.equal(new Set(unreadable.map((x) => JSON.stringify(x))).size, 1, `${writer}: one answer for every id and caller`);
    assert.equal(unreadable[0][0], 400);
    assert.equal(JSON.parse(unreadable[0][1]).error, "invalid_json");
  }
  // The valid bodies still write for those who may.
  const levels = await api(BODIES.levels.path(TEAM), { method: "PUT", who: W.coach, ...BODIES.levels.valid });
  assert.deepEqual([levels.status, levels.body.row?.scope_capabilities], [200, ["component", "session"]], levels.text);
  const version = await api(BODIES.version.path(USER), { method: "POST", who: W.privateCoach, ...BODIES.version.valid });
  assert.deepEqual([version.status, version.body.row?.version_number], [201, 2], version.text);
});


test("4. ADR-006 across the catalog: archiving a domain or category and deleting a structure link the caller may not manage - not visible, or visible but not theirs - answer exactly like a missing or malformed id and change nothing; the owner still can", async () => {
  const TABLE = { domain: "metric_domains", category: "metric_categories", "structure link": "metric_structure_links" };
  const make = async (who, owner) => {
    const domain = await api("/domains", { method: "POST", who, body: { name: `Domain ${uid()}`, ...owner } });
    const category = await api("/categories", { method: "POST", who, body: { name: `Category ${uid()}`, ...owner } });
    const link = await api("/structure-links", { method: "POST", who, body: { metricDefinitionId: W.system, ...owner } });
    for (const res of [domain, category, link]) assert.equal(res.status, 201, res.text);
    return [["domain", domain.body.row.id], ["category", category.body.row.id], ["structure link", link.body.row.id]];
  };
  const groups = [
    // Another club's rows: not visible to the caller at all.
    [W.caA, { ownerScope: "club", ownerClubId: W.clubA }, [W.caB], "another club's"],
    // System rows: every caller sees them, only a platform admin manages them.
    [W.pa, { ownerScope: "system" }, [W.coach, W.caB, W.privateCoach], "a visible system"],
  ];
  for (const [owner, ownerBody, refused, label] of groups) {
    for (const [kind, id] of await make(owner, ownerBody)) {
      const path = kind === "domain" ? (x) => `/domains/${x}/archive` : kind === "category" ? (x) => `/categories/${x}/archive` : (x) => `/structure-links/${x}`;
      const method = kind === "structure link" ? "DELETE" : "POST";
      const call = (target, who) => api(path(target), { method, who, body: method === "POST" ? {} : undefined });
      const before_ = await one(`select * from training_load.${TABLE[kind]} where id = $1`, [id]);
      for (const who of refused) {
        const answers = [];
        for (const target of [id, crypto.randomUUID(), "not-a-uuid"]) {
          const res = await call(target, who);
          answers.push([res.status, res.text]);
        }
        assert.deepEqual(answers, [[404, NODE_404], [404, NODE_404], [404, NODE_404]], `${label} ${kind}: not yours = missing = malformed`);
        // Read right after the refusals, before the owner's own write could
        // produce the same end state: the row is exactly as it was.
        assert.deepEqual(await one(`select * from training_load.${TABLE[kind]} where id = $1`, [id]), before_, `${label} ${kind}: a refused call changed nothing`);
      }
      const own = await call(id, owner);
      assert.equal(own.status, 200, `${label} ${kind}: the owner still can (${own.text})`);
      const afterOwn = await one(`select * from training_load.${TABLE[kind]} where id = $1`, [id]);
      if (kind === "structure link") assert.equal(afterOwn, undefined, `${label} link: deleted by its owner`);
      else assert.equal(afterOwn.is_active, false, `${label} ${kind}: archived by its owner`);
    }
  }
});

test("5. team and user definitions keep every older capability: create, cosmetic edit, levels, a new version and an archive, for their own managers and for a platform admin", async () => {
  const flows = [
    [W.coach, { ownerScope: "team", ownerTeamId: W.teamA }, "a team coach's team definition"],
    [W.privateCoach, { ownerScope: "user" }, "a private coach's own definition"],
    [W.pa, { ownerScope: "team", ownerTeamId: W.teamA }, "a platform admin's team definition"],
  ];
  for (const [who, owner, label] of flows) {
    const created = await api("/definitions", { method: "POST", who, body: { key: `own_${uid()}`, label: "Own metric", valueType: "numeric", unit: "m", scopeCapabilities: ["session"], ...owner } });
    assert.equal(created.status, 201, `${label}: ${created.text}`);
    const id = created.body.row.id;
    const patched = await api(`/definitions/${id}`, { method: "PATCH", who, body: { label: "Own metric renamed" } });
    assert.deepEqual([patched.status, patched.body.row?.label], [200, "Own metric renamed"], label);
    const levels = await api(`/definitions/${id}/scope-capabilities`, { method: "PUT", who, body: { scopeCapabilities: ["session", "component"] } });
    assert.deepEqual([levels.status, levels.body.row?.scope_capabilities], [200, ["component", "session"]], label);
    const version = await api(`/definitions/${id}/versions`, { method: "POST", who, body: { valueType: "numeric", unit: "km" } });
    assert.deepEqual([version.status, version.body.row?.version_number], [201, 2], label);
    const archived = await api(`/definitions/${id}/archive`, { method: "POST", who, body: {} });
    assert.deepEqual([archived.status, archived.body.row?.state], [200, "archived"], label);
  }
  // A platform admin still manages a team definition someone else made.
  const coachMade = await api("/definitions", { method: "POST", who: W.coach, body: { key: `coach_${uid()}`, label: "Coach metric", ownerScope: "team", ownerTeamId: W.teamA, valueType: "numeric", unit: "m" } });
  assert.equal((await api(`/definitions/${coachMade.body.row.id}`, { method: "PATCH", who: W.pa, body: { label: "Fixed by support" } })).status, 200);
});

test("6. what the older API still does around canonical variables: lists and reads them, a per-user hide, classification links - and the admin API (M3-0) still creates and versions them", async () => {
  const list = await api(`/definitions?limit=100`, { who: W.caA });
  assert.equal(list.status, 200);
  for (const id of [W.system, W.club]) assert.ok(list.body.rows.some((r) => r.id === id), "listed");
  assert.equal((await api(`/definitions/${W.club}`, { who: W.caA })).status, 200);
  assert.equal((await api(`/definitions/${W.system}/hide`, { method: "POST", who: W.coach })).status, 200);
  assert.equal((await api(`/definitions/${W.system}/hide`, { method: "DELETE", who: W.coach })).status, 200);
  const link = await api("/structure-links", { method: "POST", who: W.coach, body: { metricDefinitionId: W.system, ownerScope: "user" } });
  assert.equal(link.status, 201, link.text);
  assert.equal((await api(`/structure-links/${link.body.row.id}`, { method: "DELETE", who: W.coach })).status, 200);
  // M3-0 is untouched by the guard.
  const detail = await api(`/variables/${W.club}`, { who: W.caA, prefix: NEW });
  const version = await api(`/variables/${W.club}/versions`, { method: "POST", who: W.caA, prefix: NEW, body: {
    requestKey: crypto.randomUUID(), expectedCurrentVersionId: detail.body.variable.currentVersion.id, unit: "km", dailyAggregationMethod: "sum", reason: "after the guard",
  } });
  assert.equal(version.status, 201, version.text);
  assert.equal((await api(`/variables/${W.club}`, { who: W.caA, prefix: NEW })).body.variable.label, detail.body.variable.label, "the name the older API tried to change is unchanged");
});

test("7. a refused write releases its definition lock and its connection: right after each refusal the row can be locked at once, and many refusals in a row leave the pool usable", async () => {
  const rowIsFree = async () => {
    await k.query("begin");
    try {
      await k.query(`set local lock_timeout = '50ms'`);
      await k.query(`select id from training_load.metric_definitions where id = $1 for update`, [W.system]);
      return true;
    } catch (error) {
      if (error.code === "55P03") return false;
      throw error;
    } finally {
      await k.query("rollback");
    }
  };
  // The three writers that lock the definition row FOR UPDATE: a refused
  // 409 (authorized caller) and a refused 404 (a coach who sees the row but
  // may not manage it) leave no lock behind.
  for (const [name, make] of OLDER_WRITES.filter(([n]) => n !== "PATCH a name")) {
    for (const [who, status] of [[W.pa, 409], [W.coach, 404]]) {
      for (let i = 0; i < 3; i += 1) {
        const { path, method, body } = make(W.system);
        assert.equal((await api(path, { method, body, who })).status, status, name);
        assert.equal(await rowIsFree(), true, `${name}: no lock is left behind (${status}, refusal ${i + 1})`);
      }
    }
  }
  for (let i = 0; i < 25; i += 1) {
    const { path, method, body } = OLDER_WRITES[i % OLDER_WRITES.length][1](W.system);
    assert.equal((await api(path, { method, body, who: W.pa })).status, 409);
  }
  assert.equal(await rowIsFree(), true);
  assert.equal((await api(`/definitions/${W.system}`, { who: W.pa })).status, 200, "the app still answers");
});

// Backends of the app waiting for a row lock on a definition (k's own query
// never matches: it runs no FOR UPDATE while this is asked). Inside k's open
// transaction the activity view is a snapshot, so it is cleared first.
async function waitersOnDefinitions() {
  await k.query("select pg_stat_clear_snapshot()");
  return (await one(`select count(*)::int as n from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
      and query ilike '%training_load.metric_definitions%for update%'`)).n;
}
async function untilWaiting(n) {
  for (let i = 0; i < 200; i += 1) {
    if (await waitersOnDefinitions() >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`expected ${n} request(s) waiting on the definition lock`);
}

test("7b. a refusal never waits for the definition lock: while another transaction holds it, a caller who may not manage the row gets the 404 and an authorized caller the 409 at once, nobody queues on the row; a legitimate team write still waits and then succeeds", async () => {
  const teamDef = await api("/definitions", { method: "POST", who: W.coach, body: { key: `wait_${uid()}`, label: "Wait metric", ownerScope: "team", ownerTeamId: W.teamA, valueType: "numeric", unit: "m", scopeCapabilities: ["session"] } });
  assert.equal(teamDef.status, 201, teamDef.text);
  const teamId = teamDef.body.row.id;
  await k.query("begin");
  try {
    await k.query(`select id from training_load.metric_definitions where id = any($1::uuid[]) for update`, [[W.system, W.club, teamId]]);
    const refusals = [
      [W.coach, W.system, 404, "a coach on a visible system variable"],
      [W.caB, W.club, 404, "another club's admin on a club variable"],
      [W.privateCoach, teamId, 404, "a private coach on someone's team definition"],
      [W.pa, W.system, 409, "a platform admin on a system variable"],
      [W.caA, W.club, 409, "the club's admin on its club variable"],
    ];
    for (const [who, id, status, label] of refusals) {
      for (const [name, make] of OLDER_WRITES) {
        const { path, method, body } = make(id);
        const res = await api(path, { method, body, who, signal: AbortSignal.timeout(5_000) });
        assert.equal(res.status, status, `${label} / ${name}: ${res.text}`);
      }
    }
    assert.equal(await waitersOnDefinitions(), 0, "no refused request is left queued on the lock");
    // The lock still serializes a write the caller may make.
    const pending = api(`/definitions/${teamId}/scope-capabilities`, { method: "PUT", who: W.coach, body: { scopeCapabilities: ["session", "component"] } });
    await untilWaiting(1);
    await k.query("rollback");
    const res = await pending;
    assert.deepEqual([res.status, res.body.row?.scope_capabilities], [200, ["component", "session"]], res.text);
  } finally {
    await k.query("rollback").catch(() => {});
  }
});

test("7c. the decision is made again on the row read under the lock: a team or user definition that became canonical, or another's, while its write waited answers 409 / 404, writes nothing and leaves no lock", async () => {
  const rowIsFree = async (id) => {
    await k.query("begin");
    try {
      await k.query(`set local lock_timeout = '50ms'`);
      await k.query(`select id from training_load.metric_definitions where id = $1 for update`, [id]);
      return true;
    } catch (error) {
      if (error.code === "55P03") return false;
      throw error;
    } finally {
      await k.query("rollback");
    }
  };
  const other = await user("someone-else");
  // A platform admin may manage the row before and after it turns canonical
  // (so the 409); the private coach loses the right when it is given away
  // (so the 404, decided before any 409).
  const changes = [
    [W.pa, "became a system variable", `update training_load.metric_definitions set owner_scope = 'system', owner_user_id = null where id = $1`, 409],
    [W.privateCoach, "was given to another user", `update training_load.metric_definitions set owner_user_id = '${other}' where id = $1`, 404],
  ];
  for (const [name, make] of OLDER_WRITES.filter(([n]) => n !== "PATCH a name")) {
    for (const [who, change, sql, status] of changes) {
      const created = await api("/definitions", { method: "POST", who: W.privateCoach, body: { key: `race_${uid()}`, label: "Race metric", ownerScope: "user", valueType: "numeric", unit: "m", scopeCapabilities: ["session"] } });
      assert.equal(created.status, 201, created.text);
      const id = created.body.row.id;
      await k.query("begin");
      let pending;
      let before_;
      try {
        await k.query(`select id from training_load.metric_definitions where id = $1 for update`, [id]);
        const { path, method, body } = make(id);
        // It passes the unlocked check, then waits for the row.
        pending = api(path, { method, body, who });
        await untilWaiting(1);
        await k.query(sql, [id]);
        // Taken while the write still waits: anything it wrote before
        // refusing would show up against this.
        before_ = await snapshot(id);
        await k.query("commit");
      } catch (error) {
        await k.query("rollback").catch(() => {});
        throw error;
      }
      const res = await pending;
      assert.equal(res.status, status, `${name}, ${change}: ${res.text}`);
      if (status === 409) assert.deepEqual(res.body, READ_ONLY, `${name}, ${change}`);
      else assert.equal(res.text, DEFINITION_404, `${name}, ${change}`);
      assert.deepEqual(await snapshot(id), before_, `${name}, ${change}: nothing written`);
      assert.equal(await rowIsFree(id), true, `${name}, ${change}: no lock left behind`);
    }
  }
});

test("8. no identity: a coach in an athlete workspace or an anonymous caller is refused before any definition is looked up", async () => {
  const anon = await api(`/definitions/${W.system}`, { method: "PATCH", body: { label: "x" } });
  assert.equal(anon.status, 401);
  const athleteId = await user("athlete");
  await workspace(athleteId, "athlete", null);
  const athlete = { cookie: await cookieFor(athleteId) };
  for (const id of [W.system, crypto.randomUUID()]) {
    const res = await api(`/definitions/${id}`, { method: "PATCH", who: athlete, body: { label: "x" } });
    assert.deepEqual([res.status, res.body], [403, { error: "Forbidden" }], "the same answer for an existing and a missing id");
  }
});
