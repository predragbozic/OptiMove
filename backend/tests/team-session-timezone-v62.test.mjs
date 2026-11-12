// v62 (mixed_timezones (b)): a team's session time zone. The importer uses it ONLY for a session whose GPS units report several
// zones; a single-zone session keeps its own zone (an away match keeps its real local time). Platform admin only, with a
// reason, under the team's import lock; an append-only history. Through the real server on a disposable database; GPEXE is
// the fake server3 source; the import is the real approval.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle as makeFixtureBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding } from "./support/mapped-world.mjs";
import { buildGpexeImportPlan, GpexeMappingError } from "../src/gpexeImportMapper.js";

const makeBundle = (options) => makeFixtureBundle({ detailsDrills: [0, 1], ...options });

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const D1 = "2026-09-14";
let src;
let connections;
let resolver;
let db;
let admin;
let server;
let apiBase;
let service;
let createSession;
let appPool;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "tz62", migrations: GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events")) }); // every migration but the error-tracking one (an injected failure would be recorded as a row)
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  process.env.SOURCE_CREDENTIAL_KEYS = (await import("../src/sourceCredentialCrypto.js")).generateKeyEntry(1);
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
  connections = await import("../src/sourceConnectionService.js");
  resolver = await import("../src/sourceImportCredentialResolver.js");
  src = createFakeSource();
  connections.setSourceFetchForTests(src.fetchImpl);
  resolver.setImportSourceFetchForTests(src.fetchImpl);
  service.setGpexeClientFactory(() => { throw new Error("TRAP: the legacy client factory was called for a bound team"); });
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  service?.setGpexeClientFactory(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  if (ORIGINAL_KEYS === undefined) delete process.env.SOURCE_CREDENTIAL_KEYS; else process.env.SOURCE_CREDENTIAL_KEYS = ORIGINAL_KEYS;
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_SWITCH === undefined) delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  else process.env.GPEXE_IMPORT_APPLY_ENABLED = ORIGINAL_SWITCH;
});

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load/gpexe${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

async function makeUser(label) {
  return (await admin.query(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${Math.random().toString(16).slice(2)}@test.local`, label])).rows[0].id;
}
async function setWorkspace(userId, type, scopeId) {
  await admin.query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [userId, type, scopeId],
  );
}
async function coachOf(teamId, label = "coach") {
  const id = await makeUser(label);
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}
async function platformAdmin() {
  const id = await makeUser("platform admin");
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}
async function clubAdminOf(clubId) {
  const id = await makeUser("club admin");
  await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await setWorkspace(id, "club", clubId);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}

// A session of athletes 101 and 102 whose tracks report `zones` (one per athlete; the fixture's own zone is Europe/Sarajevo).
function bundleOf({ sessionId, zones = ["Europe/Sarajevo", "Europe/Sarajevo"], hour = 8, ids = [101, 102], gpexeTeamId = 77 }) {
  const byId = Object.fromEntries(standardAthletes().map((a) => [a.id, a]));
  const athletes = ids.map((id, i) => {
    const a = structuredClone(byId[id]);
    a.tracks = [sessionId * 10 + i];
    for (const part of a.parts) delete part.track;
    return a;
  });
  const bundle = makeBundle({ sessionId, gpexeTeamId, start: `2026-09-14T${String(hour).padStart(2, "0")}:08:12`, updatedOn: "2026-09-14T20:18:09.337", athletes });
  ids.forEach((id, i) => { bundle.tracks[String(sessionId * 10 + i)].timezone = zones[i]; });
  return bundle;
}

let nextGpexeTeamId = 7600;
async function setupTeam() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A101", "B102", "C103", "D", "E", "F105"] });
  const [a, b, c] = org.athleteIds;
  // The roster counts a membership only from its start: the pilot org adds athletes "now", after the sessions imported here.
  await admin.query(`delete from public.athlete_memberships where team_id = $1`, [org.teamId]);
  for (const athleteId of org.athleteIds) {
    await admin.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athleteId, org.clubId, org.teamId]);
  }
  const coach = await coachOf(org.teamId);
  const padmin = await platformAdmin();
  const cadmin = await clubAdminOf(org.clubId);
  const sourceTeamId = String(nextGpexeTeamId++);
  assert.equal((await api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: sourceTeamId } })).status, 200);
  src.show(sourceTeamId);
  const { bindingId } = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId });
  await enableTeamImportSwitch(admin, org.teamId);
  await activateBinding(admin, bindingId);
  for (const [gpexeAthleteId, athleteId] of [["101", a], ["102", b], ["103", c]]) {
    assert.equal((await api(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId, athleteId } })).status, 201);
  }
  return { ...org, coach, padmin, cadmin, sourceTeamId, bindingId };
}

async function checkNow(team, bundles) {
  src.serve(team.sourceTeamId, bundles);
  const started = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body: { from: D1, to: D1 } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 200; i += 1) {
    const r = await api(`/teams/${team.teamId}/checks/${started.body.check.id}`, { cookie: team.coach.cookie });
    if (r.body.check?.status !== "running") {
      assert.equal(r.body.check.status, "succeeded", JSON.stringify(r.body.check));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("check did not finish");
}

async function listFor(team, { cookie = team.padmin.cookie, includeSuperseded = false } = {}) {
  return (await api(`/teams/${team.teamId}/candidates${includeSuperseded ? "?includeSuperseded=true" : ""}`, { cookie })).body.candidates;
}

async function withSwitchOn(fn) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await fn();
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
    service.setApprovalObserver(null);
    service.setApprovalCommitForTests(null);
  }
}

// One session found, reviewed and imported through the real batch approval. Returns the imported candidate.
async function importSession(team, sessionId, { hour = 8, zones } = {}) {
  await checkNow(team, [bundleOf({ sessionId, hour, zones })]);
  const cand = (await listFor(team)).find((c) => c.gpexeTeamSessionId === String(sessionId) && c.status === "pending");
  assert.ok(cand, "a pending candidate");
  const imported = await withSwitchOn(async () => api(`/teams/${team.teamId}/imports`, {
    method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } },
  }));
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.body.results[0].outcome, "imported", imported.text);
  const approval = (await admin.query(`select id, metric_event_id, activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id])).rows[0];
  return { approvalId: approval.id, candidateId: cand.id, sessionId: String(sessionId), eventId: approval.metric_event_id, activityId: approval.activity_id, previewHash: cand.previewHash };
}

async function booleansOf(client, sql) {
  const results = [].concat(await client.query(sql));
  const out = [];
  for (const res of results) for (const row of res.rows) for (const [k, v] of Object.entries(row)) if (typeof v === "boolean") out.push([k, v]);
  return out;
}
async function catalogOf(client) {
  const tables = ["gpexe_team_session_timezones", "gpexe_team_session_timezone_history", "gpexe_team_settings"];
  const triggers = (await client.query(
    `select c.relname || '.' || t.tgname || ' :: ' || pg_get_triggerdef(t.oid) as d from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname = any($1) and not t.tgisinternal order by 1`, [tables])).rows.map((r) => r.d);
  const constraints = (await client.query(
    `select c.relname || '.' || conname || ' :: ' || pg_get_constraintdef(k.oid) as d from pg_constraint k join pg_class c on c.oid = k.conrelid where c.relname = any($1) order by 1`, [tables])).rows.map((r) => r.d);
  const columns = (await client.query(
    `select table_name || '.' || column_name || ' ' || data_type || ' ' || coalesce(column_default, '') || ' ' || is_nullable as d from information_schema.columns
      where table_schema in ('training', 'training_load') and table_name = any($1) order by table_name, ordinal_position`, [tables])).rows.map((r) => r.d);
  const functions = (await client.query(
    `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(p.prosrc) || ' ' || pg_get_function_result(p.oid) as d
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('training_load', 'training') order by 1`)).rows.map((r) => r.d);
  const relations = (await client.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'training_load' order by 1`)).rows.map((r) => r.relname);
  return { triggers, constraints, columns, functions, relations };
}


const RUNBOOK = (name) => new URL(`../../docs/runbooks/${name}`, import.meta.url);
const V62 = "migrations_v2/202611111200_training_load_v62_team_session_timezone.sql";
const sliceTo = (needle) => GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes(needle)) + 1);
const tzPath = (team) => `/teams/${team.teamId}/session-timezone`;
const setZone = (team, timezone, { cookie = team.padmin.cookie, reason = "the team plays in Bosnia" } = {}) =>
  api(tzPath(team), { method: "PUT", cookie, body: { timezone, reason } });
const historyCount = async (teamId) => (await admin.query(`select count(*)::int n from training_load.gpexe_team_session_timezone_history where owner_team_id = $1`, [teamId])).rows[0].n;
const candidateOf = async (team, sessionId) => (await listFor(team)).find((c) => c.gpexeTeamSessionId === String(sessionId) && c.status !== "superseded");
const detailOf = async (team, id) => (await api(`/teams/${team.teamId}/candidates/${id}`, { cookie: team.padmin.cookie })).body.candidate;

test("1. the mapper: a mixed session is refused without the team's zone and uses it when set; each participant keeps its own zone", () => {
  const mixed = bundleOf({ sessionId: 1, zones: ["Europe/Sarajevo", "Europe/Stockholm"] });
  assert.throws(() => buildGpexeImportPlan(mixed, { metricSpecs: [] }), (e) => e instanceof GpexeMappingError && e.code === "mixed_timezones");
  assert.throws(() => buildGpexeImportPlan(mixed, { metricSpecs: [], teamTimezone: "Mars/Olympus" }), (e) => e.code === "mixed_timezones", "an unknown team zone is no zone");
  const plan = buildGpexeImportPlan(mixed, { metricSpecs: [], teamTimezone: "Europe/London" });
  assert.equal(plan.event.timezone, "Europe/London");
  assert.equal(plan.event.timezoneSource, "team");
  assert.deepEqual(plan.event.trackTimezones, ["Europe/Sarajevo", "Europe/Stockholm"]);
  assert.match(plan.event.name, / 2026-09-14 09:08$/, "the name's time in the team's zone (08:08:12 UTC is 09:08 in London)");
  assert.deepEqual(plan.participants.map((p) => p.timezone), ["Europe/Sarajevo", "Europe/Stockholm"], "every participant keeps its own track's zone");
});

test("2. the mapper: a single-zone session keeps its own zone whatever the team's zone; its event is byte for byte the same", () => {
  const away = bundleOf({ sessionId: 2, zones: ["Europe/London", "Europe/London"] });
  const without = buildGpexeImportPlan(away, { metricSpecs: [] });
  const withZone = buildGpexeImportPlan(away, { metricSpecs: [], teamTimezone: "Europe/Sarajevo" });
  assert.equal(withZone.event.timezone, "Europe/London");
  assert.deepEqual(withZone.event, without.event, "no timezoneSource, no trackTimezones, the same name and date");
});

test("3. the route: a platform admin sets, changes and clears the zone with a reason; the same value writes nothing; the history keeps every step", async () => {
  const team = await setupTeam();
  let r = await api(tzPath(team), { cookie: team.padmin.cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sessionTimezone, { current: null, history: [] });
  r = await setZone(team, "Europe/Sarajevo");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.sessionTimezone.current.timezone, "Europe/Sarajevo");
  assert.equal(r.body.sessionTimezone.current.reason, "the team plays in Bosnia");
  assert.equal(await historyCount(team.teamId), 1);
  assert.equal((await setZone(team, "Europe/Sarajevo", { reason: "again" })).status, 200);
  assert.equal(await historyCount(team.teamId), 1, "the same value writes nothing");
  assert.equal((await setZone(team, "Europe/Belgrade", { reason: "moved" })).status, 200);
  r = await setZone(team, null, { reason: "not needed" });
  assert.equal(r.status, 200);
  assert.equal(r.body.sessionTimezone.current.timezone, null);
  assert.deepEqual(r.body.sessionTimezone.history.map((h) => h.timezone), [null, "Europe/Belgrade", "Europe/Sarajevo"]);
});

test("4. the route refuses, writing nothing: no reason, a blank or too long reason, an unknown or malformed zone, a missing field", async () => {
  const team = await setupTeam();
  for (const [body, code] of [
    [{ timezone: "Europe/Sarajevo" }, "reason_required"],
    [{ timezone: "Europe/Sarajevo", reason: "   " }, "reason_required"],
    [{ timezone: "Europe/Sarajevo", reason: "x".repeat(501) }, "reason_required"],
    [{ timezone: "Mars/Olympus", reason: "r" }, "invalid_timezone"],
    [{ timezone: "Europe/Sarajevo'; drop table x; --", reason: "r" }, "invalid_timezone"],
    [{ timezone: 42, reason: "r" }, "invalid_timezone"],
    [{ reason: "r" }, "invalid_timezone"],
  ]) {
    const r = await api(tzPath(team), { method: "PUT", cookie: team.padmin.cookie, body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, code, JSON.stringify(body));
  }
  assert.equal(await historyCount(team.teamId), 0);
});

test("5. who: a coach and a club admin get the settings' 403 (read and write); another team, a missing team and an archived team get the identical 404", async () => {
  const team = await setupTeam();
  for (const who of [team.coach, team.cadmin]) {
    assert.equal((await api(tzPath(team), { cookie: who.cookie })).status, 403);
    assert.equal((await setZone(team, "Europe/Sarajevo", { cookie: who.cookie })).status, 403);
  }
  const other = await setupTeam();
  const foreign = await api(tzPath(other), { cookie: team.coach.cookie });
  const missing = await api(`/teams/00000000-0000-4000-8000-000000000000/session-timezone`, { cookie: team.coach.cookie });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.text, missing.text, "the identical 404");
  await admin.query(`update public.teams set is_active = false where id = $1`, [other.teamId]);
  const archived = await api(tzPath(other), { method: "PUT", cookie: other.padmin.cookie, body: { timezone: "Europe/Sarajevo", reason: "r" } });
  assert.equal(archived.status, 404);
  assert.equal(archived.text, missing.text);
  assert.equal(await historyCount(team.teamId) + await historyCount(other.teamId), 0, "nothing was written");
});

test("6. under a running check, preview or import of the team (its import lock held) the write answers 409 gpexe_change_busy and writes nothing", async () => {
  const team = await setupTeam();
  const holder = await newClient();
  try {
    await holder.query("begin");
    await holder.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`gpexe-import-team:${String(team.teamId).toLowerCase()}`]);
    const r = await setZone(team, "Europe/Sarajevo");
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.error, "gpexe_change_busy");
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  assert.equal(await historyCount(team.teamId), 0);
});

test("7. the database: an unknown zone, a moved team, a delete, a history edit and a TRUNCATE are refused; a raw write without the team lock free is refused", async () => {
  const team = await setupTeam();
  const c = await newClient();
  try {
    await assert.rejects(c.query(`insert into training_load.gpexe_team_session_timezones (owner_team_id, timezone, set_by_user_id, reason) values ($1, 'Mars/Olympus', $2, 'r')`, [team.teamId, team.padmin.id]), (e) => e.code === "23514" && e.constraint === "gpexe_team_session_timezones_known_zone");
    await c.query(`insert into training_load.gpexe_team_session_timezones (owner_team_id, timezone, set_by_user_id, reason) values ($1, 'Europe/Sarajevo', $2, 'r')`, [team.teamId, team.padmin.id]);
    const other = await setupTeam();
    await assert.rejects(c.query(`update training_load.gpexe_team_session_timezones set owner_team_id = $2 where owner_team_id = $1`, [team.teamId, other.teamId]), (e) => e.constraint === "gpexe_team_session_timezones_team_final");
    await assert.rejects(c.query(`delete from training_load.gpexe_team_session_timezones where owner_team_id = $1`, [team.teamId]), /never deleted/);
    await assert.rejects(c.query(`truncate training_load.gpexe_team_session_timezones`), /TRUNCATE refused/);
    await assert.rejects(c.query(`update training_load.gpexe_team_session_timezone_history set reason = 'x'`), /append-only/);
    await assert.rejects(c.query(`delete from training_load.gpexe_team_session_timezone_history`), /append-only/);
    await assert.rejects(c.query(`truncate training_load.gpexe_team_session_timezone_history`), /TRUNCATE refused/);
    const holder = await newClient();
    try {
      await holder.query("begin");
      await holder.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`gpexe-import-team:${String(team.teamId).toLowerCase()}`]);
      await assert.rejects(c.query(`update training_load.gpexe_team_session_timezones set timezone = 'Europe/Belgrade', reason = 'raw' where owner_team_id = $1`, [team.teamId]), /is running for team/);
    } finally {
      await holder.query("rollback").catch(() => {});
      await holder.end();
    }
  } finally {
    await c.end();
  }
  assert.equal(await historyCount(team.teamId), 1, "only the one accepted insert");
});

test("8. a mixed session through the real check and approval: blocked without a zone; with the team's zone it previews (saying which zone and why) and imports with the event in the team's zone and each participant in its own", async () => {
  const team = await setupTeam();
  const zones = ["Europe/Sarajevo", "Europe/Stockholm"];
  await checkNow(team, [bundleOf({ sessionId: 9801, zones })]);
  let cand = await candidateOf(team, 9801);
  assert.equal((await detailOf(team, cand.id)).preview.blocked?.code, "mixed_timezones");
  assert.equal((await setZone(team, "Europe/London")).status, 200);
  const s = await importSession(team, 9801, { zones });
  const det = await detailOf(team, s.candidateId);
  assert.equal(det.preview.session.timezone, "Europe/London");
  assert.equal(det.preview.session.timezoneSource, "team");
  assert.deepEqual(det.preview.session.trackTimezones, ["Europe/Sarajevo", "Europe/Stockholm"]);
  const ev = (await admin.query(`select event_timezone_snapshot, event_name as name from training_load.metric_events where id = $1`, [s.eventId])).rows[0];
  assert.equal(ev.event_timezone_snapshot, "Europe/London");
  assert.match(ev.name, / 2026-09-14 09:08$/);
  const parts = (await admin.query(`select athlete_timezone_snapshot z from training_load.metric_event_participants where event_id = $1 order by 1`, [s.eventId])).rows.map((r) => r.z);
  assert.deepEqual(parts, ["Europe/Sarajevo", "Europe/Stockholm"]);
});

test("9. an imported single-zone away session is unchanged after the team's zone is set: the same preview hash, the same event, nothing to review", async () => {
  const team = await setupTeam();
  const zones = ["Europe/London", "Europe/London"];
  const s = await importSession(team, 9802, { zones });
  // The stored hash of the imported row (never rewritten); test 13 compares freshly computed previews.
  const hashBefore = (await admin.query(`select preview_hash from training_load.gpexe_import_candidates where id = $1`, [s.candidateId])).rows[0].preview_hash;
  assert.equal((await setZone(team, "Europe/Sarajevo")).status, 200);
  await checkNow(team, [bundleOf({ sessionId: 9802, zones })]);
  const after = (await listFor(team)).filter((c) => c.gpexeTeamSessionId === "9802");
  assert.equal(after.length, 1, "no new version of the session");
  assert.equal(after[0].status, "imported");
  const det = await detailOf(team, after[0].id);
  assert.equal(det.preview.session.timezoneSource, undefined, "a single-zone session's summary is unchanged");
  assert.equal((await admin.query(`select preview_hash from training_load.gpexe_import_candidates where id = $1`, [s.candidateId])).rows[0].preview_hash, hashBefore);
  assert.equal((await admin.query(`select event_timezone_snapshot from training_load.metric_events where id = $1`, [s.eventId])).rows[0].event_timezone_snapshot, "Europe/London");
});

test("10. the edge: an imported single-zone session re-sent with a track in another zone maps to the team's zone and is refused as event_changed (needs review), never silently moved", async () => {
  const team = await setupTeam();
  const s = await importSession(team, 9803, { zones: ["Europe/London", "Europe/London"] });
  assert.equal((await setZone(team, "Europe/Sarajevo")).status, 200);
  await checkNow(team, [bundleOf({ sessionId: 9803, zones: ["Europe/London", "Europe/Stockholm"] })]);
  const cand = (await listFor(team)).find((c) => c.gpexeTeamSessionId === "9803" && c.status !== "imported" && c.status !== "superseded");
  assert.ok(cand, "the changed session is a new version");
  const det = await detailOf(team, cand.id);
  assert.equal(det.preview.status, "blocked");
  assert.equal(det.preview.blocked.code, "event_changed");
  assert.equal((await admin.query(`select event_timezone_snapshot from training_load.metric_events where id = $1`, [s.eventId])).rows[0].event_timezone_snapshot, "Europe/London", "the imported event is untouched");
});

test("12. the Mappings preview over a mixed session passes the same gates as its import: 409 mixed_timezones without the team's zone, 200 with it", async () => {
  const team = await setupTeam();
  const zones = ["Europe/Sarajevo", "Europe/Stockholm"];
  await checkNow(team, [bundleOf({ sessionId: 9804, zones })]);
  const cand = await candidateOf(team, 9804);
  const act = (await admin.query(
    `select mapping_id, mapping_version_id from training_load.source_metric_mapping_activations where source_team_binding_id = $1 and ended_at is null and applies_to_session order by activated_at limit 1`,
    [team.bindingId],
  )).rows[0];
  assert.ok(act, "an open session activation on the team's binding");
  const preview = () => fetch(`${apiBase}/api/training-load/sources/metrics/mappings/${act.mapping_id}/versions/${act.mapping_version_id}/preview?candidateId=${cand.id}`, { headers: { Cookie: team.padmin.cookie } })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  let r = await preview();
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.current?.reason, "mixed_timezones");
  assert.equal((await setZone(team, "Europe/London")).status, 200);
  r = await preview();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.preview?.levels, "the preview's levels");
});

test("13. a single-zone session's preview is byte for byte the same with and without the team's zone (the same previewHash)", async () => {
  const team = await setupTeam();
  const { buildCandidatePreview } = await import("../src/gpexeImportPreview.js");
  const bundle = bundleOf({ sessionId: 9805, zones: ["Europe/London", "Europe/London"] });
  const importPath = { path: "source_connection", bindingId: String(team.bindingId) };
  const c = await newClient();
  try {
    const before = await buildCandidatePreview(c, { bundle, ownerTeamId: team.teamId, performedByUserId: team.padmin.id, importPath });
    assert.equal((await setZone(team, "Europe/Sarajevo")).status, 200);
    const after = await buildCandidatePreview(c, { bundle, ownerTeamId: team.teamId, performedByUserId: team.padmin.id, importPath });
    assert.equal(after.previewHash, before.previewHash);
    assert.deepEqual(after.preview.session, before.preview.session);
    assert.equal(after.preview.session.timezoneSource, undefined);
    // And a mixed bundle's preview does change with the zone (the guard above is not vacuous).
    const mixed = bundleOf({ sessionId: 9806, zones: ["Europe/London", "Europe/Stockholm"] });
    const m = await buildCandidatePreview(c, { bundle: mixed, ownerTeamId: team.teamId, performedByUserId: team.padmin.id, importPath });
    assert.equal(m.preview.session.timezoneSource, "team");
  } finally {
    await c.end();
  }
});

test("14. a read-back that fails after the zone was saved still answers 200 with the saved zone and readError; the row is there", async () => {
  const team = await setupTeam();
  const tzService = await import("../src/gpexeTeamTimezone.js");
  tzService.setTimezoneReadBackForTests(async () => { throw Object.assign(new Error("read after commit failed"), { code: "pool_checkout_timeout" }); });
  try {
    const r = await setZone(team, "Europe/Sarajevo");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.sessionTimezone.readError, true);
    assert.equal(r.body.sessionTimezone.current.timezone, "Europe/Sarajevo");
  } finally {
    tzService.setTimezoneReadBackForTests(null);
  }
  assert.equal(await historyCount(team.teamId), 1, "the write was saved");
});

test("15. a team of an archived club gets the identical 404 on both routes, and nothing is written", async () => {
  const team = await setupTeam();
  const missing = await api(`/teams/00000000-0000-4000-8000-000000000000/session-timezone`, { cookie: team.padmin.cookie });
  await admin.query(`update public.clubs set is_active = false where id = $1`, [team.clubId]);
  try {
    const read = await api(tzPath(team), { cookie: team.padmin.cookie });
    const write = await setZone(team, "Europe/Sarajevo");
    assert.equal(read.status, 404);
    assert.equal(write.status, 404);
    assert.equal(read.text, missing.text);
    assert.equal(write.text, missing.text);
  } finally {
    await admin.query(`update public.clubs set is_active = true where id = $1`, [team.clubId]);
  }
  assert.equal(await historyCount(team.teamId), 0);
});

test("16. the writer's own bundle import (the CLI path) reads the team's zone too: a mixed bundle is imported with the event in the team's zone", async () => {
  const team = await setupTeam();
  const { importGpexeBundle } = await import("../src/gpexeImportWriter.js");
  const mixed = bundleOf({ sessionId: 9807, zones: ["Europe/Sarajevo", "Europe/Stockholm"], gpexeTeamId: Number(team.sourceTeamId) });
  const ctx = { ownerTeamId: team.teamId, performedByUserId: team.padmin.id, athleteIdByGpexeId: { 101: team.athleteIds[0], 102: team.athleteIds[1] }, batchFilename: "tz62" };
  const c = await newClient();
  try {
    await assert.rejects(importGpexeBundle(c, mixed, ctx), (e) => e.code === "mixed_timezones", "without the zone: refused");
    assert.equal((await setZone(team, "Europe/London")).status, 200);
    await importGpexeBundle(c, mixed, ctx);
  } finally {
    await c.end();
  }
  const ev = (await admin.query(`select event_timezone_snapshot from training_load.metric_events where owner_team_id = $1 and source_external_id = 'team_session:9807'`, [team.teamId])).rows[0];
  assert.equal(ev?.event_timezone_snapshot, "Europe/London");
});

async function newClient() {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  return c;
}

test("11. migration v62: the preflight passes on v61, the post-check on v62, the rollback restores v61 exactly, refuses once a zone was set, and the migration applies again", async () => {
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "tz62rb", migrations: sliceTo("v61_import_states") });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    const pre = await booleansOf(client, fs.readFileSync(RUNBOOK("team-session-timezone-v62-preflight.sql"), "utf8"));
    assert.ok(pre.length >= 12, `the preflight returned its booleans (${pre.length})`);
    assert.deepEqual(pre.filter(([, v]) => v !== true), [], "every preflight block is ok on a v61 database");
    const v61Catalog = await catalogOf(client);
    await applyGpexeTestMigrations(rb.url, sliceTo("v62_team_session_timezone"));
    const post = await booleansOf(client, fs.readFileSync(RUNBOOK("team-session-timezone-v62-postcheck.sql"), "utf8"));
    assert.ok(post.length >= 12, `the post-check returned its booleans (${post.length})`);
    assert.deepEqual(post.filter(([, v]) => v !== true), [], "every post-check block is ok on a v62 database");
    const v62Catalog = await catalogOf(client);
    assert.notDeepEqual(v62Catalog, v61Catalog);
    await client.query(fs.readFileSync(RUNBOOK("team-session-timezone-v62-rollback.sql"), "utf8"));
    assert.deepEqual(await catalogOf(client), v61Catalog, "the rollback restores the v61 catalog exactly");
    assert.equal((await client.query(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [V62])).rows[0].n, 0);
    await applyGpexeTestMigrations(rb.url, sliceTo("v62_team_session_timezone"));
    assert.deepEqual(await catalogOf(client), v62Catalog, "re-applied: the same catalog");
  } finally {
    await client.end();
    await rb.drop();
  }
  const team = await setupTeam();
  assert.equal((await setZone(team, "Europe/Sarajevo")).status, 200);
  const before = await catalogOf(admin);
  const c = await newClient();
  try {
    await assert.rejects(c.query(fs.readFileSync(RUNBOOK("team-session-timezone-v62-rollback.sql"), "utf8")), /v62 rollback refused: a team session time zone has been set/);
    await c.query("rollback").catch(() => {});
  } finally {
    await c.end();
  }
  assert.deepEqual(await catalogOf(admin), before, "the refused rollback changed nothing");
});
