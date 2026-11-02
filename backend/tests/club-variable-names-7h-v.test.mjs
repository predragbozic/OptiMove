// 7h-V (C127, J14 O2 (a) and its 7h-V section; the Rukovodilac's V1–V7 of
// 2026-11-02): an active coach of an active team of a club, in that team's
// workspace, reads the name and unit of the club's own variables in that
// team's activity results - only the club-owned definitions of the team's own
// club that appear in the facts it already reads (GET
// /api/training-activity/:activityId, `variableNamesById`). Everyone else gets
// {}. The Metrics Core catalog (catalogVisibilitySql) is not touched. The
// activity roster names only the variables of the team's own club (a club
// variable of another club reads with no key, label or short label, for every
// basis). A team dashboard can never hold a club variable, so it has nothing
// to name.
//
// How another club's variable reaches a team's results (J14's 7h-V section,
// correcting O2's membership wording): an activity's facts come only from
// metric events of the identical owner (the v2 trigger
// activity_metric_event_links_check_owner), and the measurement write admits
// every definition the writer's role-wide catalog shows - so a user who also
// administers club B (or a platform admin) and coaches team A1 can record B's
// variable in A1's results. This suite writes it exactly that way, through the
// real routes.
//
// Through the real server on a disposable database (T1 kind: disposable).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb } from "./_gpexe-disposable-db.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const DAY = "2026-09-08";
const HTML_LABEL = `<img src=x onerror="alert(1)"> Club "Load" & more`;

let db;
let k;
let server;
let apiBase;
let createSession;
let appPool;
let mappingService;
const W = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "names7hv" });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  mappingService = await import("../src/sourceMetricMappingService.js");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  await world();
});

after(async () => {
  mappingService?.setMappingReadFaultForTests(null);
  mappingService?.setMappingReadBoundsForTests();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) await appPool.end();
  if (k) await k.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

// ---------------------------------------------------------------------------
// HTTP and the world
// ---------------------------------------------------------------------------
const uid = () => crypto.randomBytes(5).toString("hex");
async function call(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const one = async (sql, params) => (await k.query(sql, params)).rows[0];

async function user(label) {
  return (await one(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${uid()}@test.local`, label])).id;
}
async function workspace(userId, type, scopeId) {
  await k.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
const club = async (name) => (await one(`insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const team = async (clubId) => (await one(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;
async function person(label, { platform = false, clubAdminOf = [], coachOf = [], ws }) {
  const id = await user(label);
  if (platform) await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  for (const c of clubAdminOf) await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, c]);
  for (const t of coachOf) await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, t]);
  if (ws) await workspace(id, ws[0], ws[1]);
  return { id, cookie: await cookieFor(id) };
}
async function athleteIn(clubId, teamId, { withUser = false } = {}) {
  const userId = withUser ? await user("athlete") : null;
  const id = (await one(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,$2,$2,'UTC') returning id`, [userId, `Athlete ${uid()}`])).id;
  // A member since before the session's day, so the athlete is on its roster.
  await k.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [id, clubId, teamId]);
  if (!withUser) return { id };
  await workspace(userId, "athlete", null);
  return { id, userId, cookie: await cookieFor(userId) };
}
// A canonical variable through the M3-0 API, in the caller's workspace.
async function variable(cookie, over = {}) {
  const res = await call("/api/training-load/sources/metrics/variables", {
    method: "POST", cookie,
    body: { requestKey: crypto.randomUUID(), label: `Club Sprint ${uid()}`, unit: "m", levels: ["session"], dailyAggregationMethod: "sum", ...over },
  });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.variable.id, versionId: res.body.variable.currentVersion.id, label: res.body.variable.label };
}
// One measurement event in the writer's active workspace, through the real
// route (which materializes its activity). Returns the activity id.
async function recorded(writer, athleteId, variables, value = 100) {
  const ev = await call("/api/training-load/metrics/events", {
    method: "POST", cookie: writer.cookie,
    body: {
      requestKey: `k-${uid()}`, occurredDate: DAY, scopeLevel: "session",
      participants: [{ athleteId, timezone: "UTC", values: variables.map((v, i) => ({ metricDefinitionId: v.id, metricDefinitionVersionId: v.versionId, value: value + i })) }],
    },
  });
  assert.equal(ev.status, 201, ev.text);
  // The event write materializes its activity in the same answer.
  assert.ok(ev.body.eventId && ev.body.activityId, ev.text.slice(0, 300));
  return ev.body.activityId;
}
const read = (who, activityId) => call(`/api/training-activity/${activityId}`, { cookie: who.cookie });
const names = async (who, activityId) => {
  const res = await read(who, activityId);
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.variableNamesById && typeof res.body.variableNamesById === "object" && !Array.isArray(res.body.variableNamesById), "variableNamesById is always an object");
  return res.body;
};
const factIds = (body) => [...new Set(body.facts.filter((f) => f.factKind === "metric_value").map((f) => f.detail.metricDefinitionId))].sort();
const entryOf = (v) => ({ label: v.label, shortLabel: v.shortLabel ?? null, unit: v.unit ?? "m" });

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.clubC = await club("Club C");
  W.teamA1 = await team(W.clubA);
  W.teamA2 = await team(W.clubA);
  W.teamB1 = await team(W.clubB);
  W.teamC1 = await team(W.clubC);
  W.pa = await person("platform-admin", { platform: true, ws: ["platform", null] });
  W.caA = await person("club-admin-a", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  W.caB = await person("club-admin-b", { clubAdminOf: [W.clubB], ws: ["club", W.clubB] });
  W.caC = await person("club-admin-c", { clubAdminOf: [W.clubC], ws: ["club", W.clubC] });
  W.coachA1 = await person("coach-a1", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  W.coachA2 = await person("coach-a2", { coachOf: [W.teamA2], ws: ["team", W.teamA2] });
  W.coachB1 = await person("coach-b1", { coachOf: [W.teamB1], ws: ["team", W.teamB1] });
  W.coachC1 = await person("coach-c1", { coachOf: [W.teamC1], ws: ["team", W.teamC1] });
  W.coachA1A2 = await person("coach-a1-a2", { coachOf: [W.teamA1, W.teamA2], ws: ["team", W.teamA2] });
  W.coachA1B1 = await person("coach-a1-b1", { coachOf: [W.teamA1, W.teamB1], ws: ["team", W.teamB1] });
  W.caBcoachA1 = await person("club-admin-b-coach-a1", { clubAdminOf: [W.clubB], coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  W.caAcoachA1 = await person("club-admin-a-coach-a1", { clubAdminOf: [W.clubA], coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  W.paCoachA1 = await person("platform-admin-coach-a1", { platform: true, coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  W.paCoachB1 = await person("platform-admin-coach-b1", { platform: true, coachOf: [W.teamB1], ws: ["team", W.teamB1] });
  W.paCoachC1 = await person("platform-admin-coach-c1", { platform: true, coachOf: [W.teamC1], ws: ["team", W.teamC1] });
  W.athA1 = await athleteIn(W.clubA, W.teamA1, { withUser: true });
  W.athB1 = await athleteIn(W.clubB, W.teamB1);
  W.athC1 = await athleteIn(W.clubC, W.teamC1);

  W.sysVar = await variable(W.pa.cookie, { label: `System Load ${uid()}`, unit: "AU" });
  W.clubVarA = { ...await variable(W.caA.cookie, { label: `Club A Sprint ${uid()}`, shortLabel: "A Spr", unit: "m" }), shortLabel: "A Spr", unit: "m" };
  W.clubVarA2 = await variable(W.caA.cookie, { label: `Club A Unused ${uid()}` });
  W.clubVarHtml = { ...await variable(W.caA.cookie, { label: HTML_LABEL, unit: "km/h" }), unit: "km/h" };
  W.clubVarB = { ...await variable(W.caB.cookie, { label: `Club B Burst ${uid()}`, unit: "count" }), unit: "count" };
  W.clubVarB2 = await variable(W.caB.cookie, { label: `Club B Brake ${uid()}`, unit: "count" });
  W.clubVarC = { ...await variable(W.caC.cookie, { label: `Club C Speed ${uid()}`, unit: "km/h" }), unit: "km/h" };
  const teamDef = await call("/api/training-load/metrics/definitions", {
    method: "POST", cookie: W.coachA1.cookie,
    body: { key: `team_a1_${uid()}`, label: `Team A1 Jumps ${uid()}`, ownerScope: "team", ownerTeamId: W.teamA1, unit: "count", valueType: "numeric", scopeCapabilities: ["session"] },
  });
  assert.equal(teamDef.status, 201, teamDef.text);
  W.teamVarA1 = { id: teamDef.body.row.id, versionId: teamDef.body.row.current_version_id, label: teamDef.body.row.label };

  // X: A1's session with the system, team, two club-A and two club-B
  // variables, written by a platform admin who coaches A1, in A1's workspace.
  W.actX = await recorded(W.paCoachA1, W.athA1.id, [W.sysVar, W.clubVarA, W.clubVarHtml, W.clubVarB, W.clubVarB2, W.teamVarA1]);
  // Y: A1's session with club B's variable, written by club B's admin who
  // coaches A1, in A1's workspace (the role-wide catalog admits it).
  W.actY = await recorded(W.caBcoachA1, W.athA1.id, [W.sysVar, W.clubVarB]);
  // Z: B1's session carrying a club-A and a club-B variable.
  W.actZ = await recorded(W.paCoachB1, W.athB1.id, [W.clubVarA, W.clubVarB]);
  // V: C1's session, then club C is archived.
  W.actV = await recorded(W.paCoachC1, W.athC1.id, [W.clubVarC]);
  await k.query(`update public.clubs set is_active = false where id = $1`, [W.clubC]);
}

// ---------------------------------------------------------------------------
test("1. a pure coach of A1, in A1's workspace, gets the name and unit of exactly the club-A variables in the activity's facts; never another club's, the system's, the team's, or a club-A variable that is not in the results; the facts are unchanged", async () => {
  const body = await names(W.coachA1, W.actX);
  assert.deepEqual(body.variableNamesById, {
    [W.clubVarA.id]: entryOf(W.clubVarA),
    [W.clubVarHtml.id]: { label: HTML_LABEL, shortLabel: null, unit: "km/h" },
  });
  assert.deepEqual(factIds(body), [W.sysVar.id, W.clubVarA.id, W.clubVarHtml.id, W.clubVarB.id, W.clubVarB2.id, W.teamVarA1.id].sort(), "the facts still carry every value");
  for (const absent of [W.clubVarA2.id, W.clubVarB.id, W.clubVarB2.id, W.sysVar.id, W.teamVarA1.id]) assert.equal(body.variableNamesById[absent], undefined);
  for (const entry of Object.values(body.variableNamesById)) assert.deepEqual(Object.keys(entry).sort(), ["label", "shortLabel", "unit"], "only the name and the unit");
  // The session written by club B's admin who coaches A1: B's variable is in
  // A1's results (the path this suite proves), and A1's coach gets no name.
  const y = await names(W.coachA1, W.actY);
  assert.ok(factIds(y).includes(W.clubVarB.id), "club B's variable is in A1's results");
  assert.deepEqual(y.variableNamesById, {});
});

test("2. a coach of another club's team and a coach of another team of the same club get the activity's identical 404", async () => {
  const missing = await call(`/api/training-activity/${crypto.randomUUID()}`, { cookie: W.coachA1.cookie });
  assert.equal(missing.status, 404);
  for (const who of [W.coachB1, W.coachA2]) {
    const res = await read(who, W.actX);
    assert.equal(res.status, 404, res.text);
    assert.deepEqual(res.body, missing.body);
  }
});

test("3. the same coach in a second team's workspace: a coach of A1 and A2 in A2's workspace, and a coach of A1 and B1 in B1's workspace, get A1's 404; on B1's own session the B1 workspace names club B's variable and not club A's", async () => {
  for (const who of [W.coachA1A2, W.coachA1B1]) assert.equal((await read(who, W.actX)).status, 404);
  const z = await names(W.coachA1B1, W.actZ);
  assert.deepEqual(z.variableNamesById, { [W.clubVarB.id]: entryOf(W.clubVarB) });
  assert.deepEqual(factIds(z), [W.clubVarA.id, W.clubVarB.id].sort());
  assert.deepEqual((await names(W.coachB1, W.actZ)).variableNamesById, { [W.clubVarB.id]: entryOf(W.clubVarB) });
});

test("4. a coach of a team whose club is archived still reads the session, but gets no name (C99 needs an active club); so does a platform admin who coaches that team", async () => {
  for (const who of [W.coachC1, W.paCoachC1]) {
    const body = await names(who, W.actV);
    assert.deepEqual(body.variableNamesById, {});
    assert.deepEqual(factIds(body), [W.clubVarC.id]);
  }
});

test("5. outside a team workspace nobody gets a name, whatever the activity holds: club A's admin in A's workspace (D8), a platform admin in the platform workspace, and the athlete on their own result; the facts are unchanged", async () => {
  for (const who of [W.caA, W.pa]) {
    const body = await names(who, W.actX);
    assert.deepEqual(body.variableNamesById, {});
    assert.equal(factIds(body).length, 6);
  }
  const own = await names(W.athA1, W.actX);
  assert.deepEqual(own.variableNamesById, {});
  assert.equal(factIds(own).length, 6, "the athlete's own facts");
});

test("6. a coach of A1 who also holds a stronger role (club A's admin, a platform admin, or club B's admin) in A1's workspace is named club A's variables by the same rule, and never club B's", async () => {
  const expected = { [W.clubVarA.id]: entryOf(W.clubVarA), [W.clubVarHtml.id]: { label: HTML_LABEL, shortLabel: null, unit: "km/h" } };
  for (const who of [W.caAcoachA1, W.paCoachA1, W.caBcoachA1]) assert.deepEqual((await names(who, W.actX)).variableNamesById, expected);
});

test("7. the catalog is not touched: A1's coach still does not list, read or write club A's variable through Metrics Core", async () => {
  const listed = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const q = cursor ? `?limit=100&cursorLabel=${encodeURIComponent(cursor.label)}&cursorId=${encodeURIComponent(cursor.id)}` : "?limit=100";
    const res = await call(`/api/training-load/metrics/definitions${q}`, { cookie: W.coachA1.cookie });
    assert.equal(res.status, 200, res.text);
    listed.push(...res.body.rows.map((r) => r.id));
    if (!res.body.nextCursor) break;
    cursor = res.body.nextCursor;
  }
  assert.ok(listed.includes(W.sysVar.id) && listed.includes(W.teamVarA1.id), "the catalog itself is read");
  for (const hidden of [W.clubVarA.id, W.clubVarB.id]) assert.ok(!listed.includes(hidden));
  assert.equal((await call(`/api/training-load/metrics/definitions/${W.clubVarA.id}`, { cookie: W.coachA1.cookie })).status, 404);
  const write = await call("/api/training-load/metrics/events", {
    method: "POST", cookie: W.coachA1.cookie,
    body: { requestKey: `k-${uid()}`, occurredDate: DAY, scopeLevel: "session", participants: [{ athleteId: W.athA1.id, timezone: "UTC", values: [{ metricDefinitionId: W.clubVarA.id, metricDefinitionVersionId: W.clubVarA.versionId, value: 1 }] }] },
  });
  assert.equal(write.status, 404, write.text);
});

test("8. the roster names only the team's own club's variables, for every basis: another club's variable has no key, label or short label, each in a column of its own; the team's club, the system and the team variables keep theirs", async () => {
  const viewers = [W.coachA1, W.caA, W.pa, W.paCoachA1];
  for (const who of viewers) {
    const res = await call(`/api/training-activity/${W.actX}/roster`, { cookie: who.cookie });
    assert.equal(res.status, 200, res.text);
    const athletes = [...(res.body.athletes ?? []), ...(res.body.recordedOutsideRoster ?? [])];
    const athlete = athletes.find((a) => String(a.athleteId) === String(W.athA1.id));
    assert.ok(athlete, `the athlete is on the roster (${who === W.pa ? "platform" : "viewer"})`);
    const byLabel = new Map(athlete.values.map((v) => [v.label, v]));
    assert.ok(byLabel.has(W.clubVarA.label) && byLabel.get(W.clubVarA.label).metricKey && !byLabel.get(W.clubVarA.label).metricKey.startsWith("#"), "club A's variable keeps its key and name");
    assert.ok(byLabel.has(W.sysVar.label), "the system variable keeps its name");
    assert.ok(byLabel.has(W.teamVarA1.label) && !byLabel.get(W.teamVarA1.label).metricKey.startsWith("#"), "the team's own variable keeps its key and name");
    const unnamed = athlete.values.filter((v) => v.label === null);
    assert.equal(unnamed.length, 2, "both club-B variables are unnamed");
    for (const v of unnamed) {
      assert.equal(v.shortLabel, null);
      assert.match(v.metricKey, /^#unnamed-\d+$/);
    }
    assert.notEqual(unnamed[0].metricKey, unnamed[1].metricKey, "each unnamed variable keeps a column of its own");
    assert.ok(!JSON.stringify(res.body).includes(W.clubVarB.label) && !JSON.stringify(res.body).includes(W.clubVarB2.label), "club B's names are nowhere in the answer");
  }
});

test("9. a team dashboard cannot hold a club variable (the v16 rule), so there is nothing to name: binding club A's variable on A1's dashboard is the identical 404, even for a platform admin who coaches A1", async () => {
  const D = "/api/training-load/dashboards";
  for (const who of [W.coachA1, W.paCoachA1]) {
    const dashboard = await call(D, { method: "POST", cookie: who.cookie, body: { name: `7h-V ${uid()}` } });
    assert.equal(dashboard.status, 201, dashboard.text);
    const d = dashboard.body.dashboard;
    const widget = await call(`${D}/${d.id}/widgets`, { method: "POST", cookie: who.cookie, body: { expectedDashboardRevision: d.revision, widgetType: "table", title: "W", widgetOrder: 1, x: 0, y: 0, width: 6, height: 4, mobileOrder: 1 } });
    assert.ok(widget.status < 400, widget.text);
    const series = await call(`${D}/${d.id}/widgets/${widget.body.widgetId}/series`, {
      method: "POST", cookie: who.cookie,
      body: { expectedWidgetRevision: 1, seriesOrder: 1, metricDefinitionId: W.clubVarA.id, dataScopeLevel: "session", analyticalAggregation: "sum", aggregationRolePolicy: "standalone_only", coveragePolicy: "any" },
    });
    assert.equal(series.status, 404, series.text);
    assert.equal(series.body.message, "Metric not found.");
  }
});

test("10. names are data: a label with markup comes back verbatim (the screens escape it)", async () => {
  const body = await names(W.coachA1, W.actX);
  assert.equal(body.variableNamesById[W.clubVarHtml.id].label, HTML_LABEL);
});

test("11. the C99 check's errors propagate: a read bound reached is the stable 503 database_busy, a broken read a 500 - never an answer with an empty name map; once the database answers again the names come back", async () => {
  mappingService.setMappingReadBoundsForTests({ answerTimeoutMs: 300 });
  mappingService.setMappingReadFaultForTests(async (client) => { await client.query("select pg_sleep(1)"); });
  try {
    const busy = await read(W.coachA1, W.actX);
    assert.equal(busy.status, 503, busy.text);
    assert.equal(busy.body.error, "database_busy");
    assert.equal(busy.body.variableNamesById, undefined);
  } finally {
    mappingService.setMappingReadFaultForTests(null);
    mappingService.setMappingReadBoundsForTests();
  }
  mappingService.setMappingReadFaultForTests(async () => { throw new Error("broken read"); });
  try {
    const broken = await read(W.coachA1, W.actX);
    assert.equal(broken.status, 500, broken.text);
    assert.equal(broken.body.variableNamesById, undefined);
  } finally {
    mappingService.setMappingReadFaultForTests(null);
  }
  // Only a caller the check concerns can meet it: club A's admin in A's
  // workspace never asks it (no read fault reaches that answer).
  mappingService.setMappingReadFaultForTests(async () => { throw new Error("must not be asked"); });
  try {
    assert.deepEqual((await names(W.caA, W.actX)).variableNamesById, {});
    assert.deepEqual((await names(W.coachA1, W.actY)).variableNamesById, {}, "a session with no club-A variable never asks it either");
  } finally {
    mappingService.setMappingReadFaultForTests(null);
  }
  assert.ok((await names(W.coachA1, W.actX)).variableNamesById[W.clubVarA.id]);
});

test("12. an administrator with no coach role on the team gets no team workspace, so no name: club A's admin whose preference names A1 falls back to the club workspace and reads {}; a coach whose role on A1 is revoked no longer reads A1's session as its coach", async () => {
  const stale = await person("club-admin-a-stale-team-pref", { clubAdminOf: [W.clubA], ws: ["team", W.teamA1] });
  const body = await names(stale, W.actX);
  assert.deepEqual(body.variableNamesById, {}, "the club workspace it falls back to names nothing");
  const revoked = await person("coach-a1-revoked", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  assert.ok((await names(revoked, W.actX)).variableNamesById[W.clubVarA.id], "named while the role is active");
  await k.query(`update public.user_team_roles set is_active = false where user_id = $1`, [revoked.id]);
  const after = await read(revoked, W.actX);
  assert.notEqual(after.status, 200, after.text);
  assert.equal(after.body.variableNamesById, undefined);
});

test("13. a team with members cannot be moved to another club, not even by raw SQL (the route refuses it as team_club_fixed, the database by the memberships' foreign key): the old club's names stay the team's and the new club's never become them", async () => {
  const teamA3 = await team(W.clubA);
  const coachA3 = await person("coach-a3", { coachOf: [teamA3], ws: ["team", teamA3] });
  const writer = await person("platform-admin-coach-a3", { platform: true, coachOf: [teamA3], ws: ["team", teamA3] });
  const ath = await athleteIn(W.clubA, teamA3);
  const act = await recorded(writer, ath.id, [W.clubVarA, W.clubVarB]);
  assert.deepEqual((await names(coachA3, act)).variableNamesById, { [W.clubVarA.id]: entryOf(W.clubVarA) });
  await assert.rejects(k.query(`update public.teams set club_id = $2 where id = $1`, [teamA3, W.clubB]), (e) => e.code === "23503" && /athlete_memberships_team_club_fkey/.test(e.message));
  assert.deepEqual((await names(coachA3, act)).variableNamesById, { [W.clubVarA.id]: entryOf(W.clubVarA) }, "nothing moved");
});

test("14. the roster's placeholder columns are numbered by the sorted definition ids, the same for every viewer and every read", async () => {
  const keysFor = async (who) => {
    const res = await call(`/api/training-activity/${W.actX}/roster`, { cookie: who.cookie });
    assert.equal(res.status, 200, res.text);
    const athlete = [...res.body.athletes, ...(res.body.recordedOutsideRoster ?? [])].find((a) => String(a.athleteId) === String(W.athA1.id));
    return athlete.values.filter((v) => v.label === null).map((v) => `${v.metricKey}=${v.value}`).sort();
  };
  const first = await keysFor(W.coachA1);
  const sortedIds = [W.clubVarB.id, W.clubVarB2.id].sort();
  const valueOf = (id) => (id === W.clubVarB.id ? 103 : 104); // X's values: sysVar 100, clubVarA 101, clubVarHtml 102, clubVarB 103, clubVarB2 104
  assert.deepEqual(first, sortedIds.map((id, i) => `#unnamed-${i + 1}=${valueOf(id)}`).sort());
  for (const who of [W.coachA1, W.caA, W.pa]) assert.deepEqual(await keysFor(who), first);
});
