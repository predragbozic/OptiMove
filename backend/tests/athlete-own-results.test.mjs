import { VARIABLE_MANAGE, editVariablesManageTestRole, stageVariablesManageForTest } from "./support/variables-manage-grants.mjs";
import { applyActivityIdentityBridgeForCuratedFixture } from "./support/external-schedule-m2-fixture.mjs";
// An athlete reads her own recorded results (owner's decision 2026-11-16: all of them, read-only, nobody else's),
// through the three real routes on a disposable database: GET /api/training-activity/:id, GET /api/training-activity
// and GET /api/training-load/calendar in an athlete workspace. Her answer is a fixed list of fields; names and units
// only for the variables in her own facts; what is not hers is the identical 404. Invented data only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb } from "./_gpexe-disposable-db.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const DAY = "2026-09-08";

let db;
let k;
let server;
let apiBase;
let createSession;
let appPool;
const W = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "athleteown", roleRead: true });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  await applyActivityIdentityBridgeForCuratedFixture(db.url);
  await stageVariablesManageForTest(k);
  await editVariablesManageTestRole(k, VARIABLE_MANAGE, true);
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  await world();
});

after(async () => {
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
async function variable(cookie, over = {}) {
  const res = await call("/api/training-load/sources/metrics/variables", {
    method: "POST", cookie,
    body: { requestKey: crypto.randomUUID(), label: `Sprint ${uid()}`, unit: "m", levels: ["session"], dailyAggregationMethod: "sum", ...over },
  });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.variable.id, versionId: res.body.variable.currentVersion.id, label: res.body.variable.label, shortLabel: over.shortLabel ?? null, unit: over.unit ?? "m" };
}
// One session recorded through the real route for several athletes, each with her own values.
async function recorded(writer, people, segments) {
  const ev = await call("/api/training-load/metrics/events", {
    method: "POST", cookie: writer.cookie,
    body: { requestKey: `k-${uid()}`, occurredDate: DAY, scopeLevel: "session", ...(segments ? { segments } : {}),
      participants: people.map(([athlete, values]) => ({ athleteId: athlete.id, timezone: "UTC",
        values: values.map(([v, value, segmentIndex]) => ({ metricDefinitionId: v.id, metricDefinitionVersionId: v.versionId, value, ...(segmentIndex === undefined ? {} : { segmentIndex }) })) })) },
  });
  assert.equal(ev.status, 201, ev.text);
  assert.ok(ev.body.activityId, ev.text.slice(0, 300));
  return ev.body.activityId;
}
const detail = (who, id) => call(`/api/training-activity/${id}`, { cookie: who.cookie });
const list = (who) => call(`/api/training-activity?dateFrom=${DAY}&dateTo=${DAY}`, { cookie: who.cookie });
const calendar = (who) => call(`/api/training-load/calendar?dateFrom=${DAY}&dateTo=${DAY}`, { cookie: who.cookie });
const keys = (o) => Object.keys(o).sort();
// Ana's and Bea's values are numbers nobody else has, so a leak of the other's shows in the text.
const ANA = { sys: 111.25, club: 222.5, team: 333.75, drill1: 444.25, drill2: 555.25, loose: 666.25, foreign: 677.25, suggested: 688.25 };
const BEA = { sys: 7771.5, club: 7772.5, team: 7773.5, extra: 7774.5 };

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.teamA1 = await team(W.clubA);
  W.teamA3 = await team(W.clubA); // archived later
  W.teamB1 = await team(W.clubB);
  W.pa = await person("platform-admin", { platform: true, ws: ["platform", null] });
  W.caA = await person("club-admin-a", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  W.coachA1 = await person("coach-a1", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  // A platform admin who coaches A1, in A1's workspace: the writer whose catalog admits the club's variable.
  W.writerA1 = await person("platform-admin-coach-a1", { platform: true, coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  W.coachA3 = await person("coach-a3", { coachOf: [W.teamA3], ws: ["team", W.teamA3] });
  W.coachB1 = await person("coach-b1", { coachOf: [W.teamB1], ws: ["team", W.teamB1] });
  W.ana = await athleteIn(W.clubA, W.teamA1, { withUser: true });
  W.bea = await athleteIn(W.clubA, W.teamA1, { withUser: true });
  W.cy = await athleteIn(W.clubB, W.teamB1, { withUser: true });
  // Two more of A1 with no values in the group session: one the coach marks as having taken part, one as absent.
  W.dana = await athleteIn(W.clubA, W.teamA1, { withUser: true });
  W.ema = await athleteIn(W.clubA, W.teamA1, { withUser: true });
  // Ana is also a member of the team that gets archived.
  await k.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [W.ana.id, W.clubA, W.teamA3]);
  // The roster lists by name: Dana first and Bea last, so "the first athlete's state" is never Bea's by accident.
  await k.query(`update public.athletes set display_name = 'Aaa Example', full_name = 'Aaa Example' where id = $1`, [W.dana.id]);
  await k.query(`update public.athletes set display_name = 'Zzz Example', full_name = 'Zzz Example' where id = $1`, [W.bea.id]);
  for (const a of [W.ana, W.bea, W.cy]) a.name = (await one(`select display_name as n from public.athletes where id = $1`, [a.id])).n;

  W.sysVar = await variable(W.pa.cookie, { label: `System Load ${uid()}`, unit: "AU" });
  W.drillVar = await variable(W.pa.cookie, { label: `System Drill Distance ${uid()}`, unit: "m", levels: ["session", "drill"] });
  W.sysUnused = await variable(W.pa.cookie, { label: `System Unused ${uid()}`, unit: "AU" });
  W.clubVar = await variable(W.caA.cookie, { label: `Club A Sprint ${uid()}`, shortLabel: "A Spr", unit: "m" });
  W.clubOnlyBea = await variable(W.caA.cookie, { label: `Club A Only Bea ${uid()}`, unit: "m" });
  const teamDef = await call("/api/training-load/metrics/definitions", { method: "POST", cookie: W.coachA1.cookie,
    body: { key: `team_a1_${uid()}`, label: `Team A1 Jumps ${uid()}`, ownerScope: "team", ownerTeamId: W.teamA1, unit: "count", valueType: "numeric", scopeCapabilities: ["session"] } });
  assert.equal(teamDef.status, 201, teamDef.text);
  W.teamVar = { id: teamDef.body.row.id, versionId: teamDef.body.row.current_version_id, label: teamDef.body.row.label, shortLabel: null, unit: "count" };

  // G: a group session of A1 with Ana and Bea; Bea has one variable Ana does not.
  // Ana also has a value in each of three drills; the third drill is then left without a component.
  W.actG = await recorded(W.writerA1, [
    [W.ana, [[W.sysVar, ANA.sys], [W.clubVar, ANA.club], [W.teamVar, ANA.team], [W.drillVar, ANA.drill1, 0], [W.drillVar, ANA.drill2, 1], [W.drillVar, ANA.loose, 2], [W.drillVar, ANA.foreign, 3], [W.drillVar, ANA.suggested, 4]]],
    [W.bea, [[W.sysVar, BEA.sys], [W.clubVar, BEA.club], [W.teamVar, BEA.team], [W.clubOnlyBea, BEA.extra]]],
  ], [{ label: "Source Drill One", order: 1 }, { label: "Source Drill Two", order: 2 }, { label: "Source Drill Three", order: 3 }, { label: "Source Drill Four", order: 4 }, { label: "Source Drill Five", order: 5 }]);
  W.drillComponents = (await k.query(`select l.activity_component_id as id, s.segment_order as n, s.id as segment_id from training.activity_component_metric_segment_links l
     join training_load.metric_event_segments s on s.id = l.metric_event_segment_id join training.activity_components c on c.id = l.activity_component_id where c.activity_id = $1 order by s.segment_order`, [W.actG])).rows;
  assert.equal(W.drillComponents.length, 5);
  await k.query(`delete from training.activity_component_metric_segment_links where metric_event_segment_id = $1`, [W.drillComponents[2].segment_id]);
  // The fifth drill's link is only a suggestion, not confirmed.
  await k.query("begin");
  await k.query("set local session_replication_role = replica");
  await k.query(`update training.activity_component_metric_segment_links set link_status = 'suggested' where metric_event_segment_id = $1`, [W.drillComponents[4].segment_id]);
  await k.query("commit");
  // The team's variable is archived after the session: her value still has its name.
  await k.query(`update training_load.metric_definitions set state = 'archived' where id = $1`, [W.teamVar.id]);
  // A drill of that session, performed by both, each with a note and a prescription.
  W.drill = (await one(`insert into training.activity_components (activity_id, component_type_key, name_snapshot, sort_order, planned_duration_seconds, origin)
     select $1, (select key from training.component_types order by key limit 1), 'Passing drill', 1, 600, 'manual' returning id`, [W.actG])).id;
  // A drill only Bea performed (a coach's own words in its name).
  W.beaOnlyDrill = (await one(`insert into training.activity_components (activity_id, component_type_key, name_snapshot, sort_order, origin)
     select $1, (select key from training.component_types order by key limit 1), 'Rehab only Bea did', 2, 'manual' returning id`, [W.actG])).id;
  await k.query(`insert into training.activity_participant_components (activity_id, activity_participant_id, activity_component_id, status)
     select $1, ap.id, $2, 'performed' from training.activity_participants ap where ap.activity_id = $1 and ap.athlete_id = $3`, [W.actG, W.beaOnlyDrill, W.bea.id]);
  for (const [a, note] of [[W.ana, "ana-coach-note-zeta"], [W.bea, "bea-coach-note-omega"]]) {
    await k.query(`insert into training.activity_participant_components (activity_id, activity_participant_id, activity_component_id, status, actual_duration_seconds, actual_prescription_snapshot, note)
       select $1, ap.id, $2, 'performed', 540, '{"sets":3}'::jsonb, $4 from training.activity_participants ap where ap.activity_id = $1 and ap.athlete_id = $3`, [W.actG, W.drill, a.id, note]);
  }
  // Only Bea; only Cy (another club); Ana on the team that is then archived.
  W.actBea = await recorded(W.coachA1, [[W.bea, [[W.sysVar, 7780.5]]]]);
  // The fourth drill's link is pointed at a component of ANOTHER session (as a broken or hostile row would be).
  W.foreignComponent = (await one(`insert into training.activity_components (activity_id, component_type_key, name_snapshot, sort_order, origin)
     select $1, (select key from training.component_types order by key limit 1), 'Foreign drill of another session', 1, 'manual' returning id`, [W.actBea])).id;
  await k.query("begin");
  await k.query("set local session_replication_role = replica");
  await k.query(`update training.activity_component_metric_segment_links set activity_component_id = $1 where metric_event_segment_id = $2`, [W.foreignComponent, W.drillComponents[3].segment_id]);
  await k.query("commit");
  W.actCy = await recorded(W.coachB1, [[W.cy, [[W.sysVar, 8880.5]]]]);
  W.actArchived = await recorded(W.coachA3, [[W.ana, [[W.sysVar, 999.5]]]]);
  await k.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [W.bea.id, W.clubA, W.teamA3]);
  W.actArchivedBea = await recorded(W.coachA3, [[W.bea, [[W.sysVar, 7795.5]]]]);
  await k.query(`update public.teams set is_active = false where id = $1`, [W.teamA3]);
  // One login that is a coach of A1 AND an athlete of A1 (a multi-role login).
  W.dual = await athleteIn(W.clubA, W.teamA1, { withUser: true });
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [W.dual.userId, W.teamA1]);
  W.actDual = await recorded(W.coachA1, [[W.dual, [[W.sysVar, 55.5]]], [W.bea, [[W.sysVar, 7790.5]]]]);
}

test("1. the detail: only her own facts, each a fixed list of fields; names and units for exactly her variables; nothing of the other athlete", async () => {
  const coach = await detail(W.coachA1, W.actG);
  assert.equal(coach.status, 200, coach.text);
  // What a coach reads (and so what exists to be hidden): both athletes, the link-only fact, the bookkeeping ids, the notes.
  assert.deepEqual(keys(coach.body), ["athleteNamesById", "canonicalActivityId", "components", "facts", "variableNamesById"]);
  assert.ok(coach.body.facts.some((f) => f.factKind === "metric_event_link" && f.athleteId === null), "the activity has a link-only fact");
  assert.equal(coach.body.facts.filter((f) => f.factKind === "metric_value").length, 12);
  assert.ok(coach.text.includes("ana-coach-note-zeta") && coach.text.includes("bea-coach-note-omega") && coach.text.includes("occasionId") && coach.text.includes("entryMethod"));

  const res = await detail(W.ana, W.actG);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(keys(res.body), ["canonicalActivityId", "components", "facts", "myAttendance", "recordedBy", "variableNamesById"]);
  assert.equal(res.body.canonicalActivityId, W.actG);
  assert.equal(res.body.recordedBy, "coach", "her values were entered by hand");
  assert.equal(res.body.myAttendance, "participated");
  const values = res.body.facts.filter((f) => f.factKind === "metric_value");
  for (const f of values) {
    assert.deepEqual(keys(f), ["detail", "factKind"]);
    assert.deepEqual(keys(f.detail), ["componentId", "drillKey", "drillOrdinal", "level", "metricDefinitionId", "unitAtCapture", "valueBoolean", "valueKey", "valueNumeric", "valueText"]);
    assert.ok(f.detail.level === "session" ? f.detail.drillKey === null : /^[0-9a-f]{16}$/.test(f.detail.drillKey));
    assert.match(f.detail.valueKey, /^[0-9a-f]{16}$/);
  }
  // The whole session first, then each drill: its place in the session's own structure and its order; a drill
  // nobody linked to a component is still a drill, with no component. Never the source's segment or event id.
  const placed = values.map((f) => [f.detail.metricDefinitionId, Number(f.detail.valueNumeric), f.detail.level, f.detail.componentId, f.detail.drillOrdinal]).sort((a, b) => a[1] - b[1]);
  assert.deepEqual(placed, [
    [W.sysVar.id, ANA.sys, "session", null, null], [W.clubVar.id, ANA.club, "session", null, null], [W.teamVar.id, ANA.team, "session", null, null],
    [W.drillVar.id, ANA.drill1, "drill", W.drillComponents[0].id, 1], [W.drillVar.id, ANA.drill2, "drill", W.drillComponents[1].id, 2], [W.drillVar.id, ANA.loose, "drill", null, 3],
    // A link to a component that is not of this session, and a link that is not confirmed, place nothing.
    [W.drillVar.id, ANA.foreign, "drill", null, 4], [W.drillVar.id, ANA.suggested, "drill", null, 5],
  ]);
  assert.ok(!res.text.includes(W.foreignComponent) && !res.text.includes("Foreign drill"), "nothing of the other session");
  assert.equal(new Set(values.map((f) => f.detail.valueKey)).size, 8, "one key per value");
  assert.equal(new Set(values.filter((f) => f.detail.level === "drill").map((f) => f.detail.drillKey)).size, 5, "one key per drill, with or without a component");
  const again = await detail(W.ana, W.actG);
  assert.equal(again.text, res.text, "the same answer, keys included, on every read");
  for (const segment of W.drillComponents) assert.ok(!res.text.includes(segment.segment_id), "no segment id");
  const performed = res.body.facts.filter((f) => f.factKind === "component_performance");
  assert.equal(performed.length, 1);
  assert.deepEqual(keys(performed[0]), ["detail", "factKind"]);
  assert.deepEqual(performed[0].detail, { componentId: W.drill, name: "Passing drill", componentTypeKey: performed[0].detail.componentTypeKey, status: "performed", actualDurationSeconds: 540 });
  assert.deepEqual([...new Set(res.body.facts.map((f) => f.factKind))].sort(), ["component_performance", "metric_value"], "no link-only fact, no other kind");
  assert.equal(res.body.facts.length, 9);
  // Names: exactly her three variables, whoever owns them (system, club, team) - three closed fields each.
  // The team's variable was archived after the session: results are history, it keeps its name.
  assert.deepEqual(res.body.variableNamesById, {
    [W.sysVar.id]: { label: W.sysVar.label, shortLabel: null, unit: "AU" },
    [W.drillVar.id]: { label: W.drillVar.label, shortLabel: null, unit: "m" },
    [W.clubVar.id]: { label: W.clubVar.label, shortLabel: "A Spr", unit: "m" },
    [W.teamVar.id]: { label: W.teamVar.label, shortLabel: null, unit: "count" },
  });
  // The session's own structure.
  // The structure as far as it is hers: the two drills her values are placed on and the one she performed - not the
  // drills whose link is missing, foreign or unconfirmed, and (below) not a drill only another athlete did.
  assert.deepEqual(res.body.components.map((c) => c.id).sort(), [W.drill, W.drillComponents[0].id, W.drillComponents[1].id].sort());
  assert.equal(coach.body.components.length, 7, "the coach reads the whole structure");
  assert.ok(!res.text.includes(W.beaOnlyDrill) && !res.text.includes("Rehab only Bea"), "a drill only Bea did is not listed to Ana");
  for (const c of res.body.components) assert.deepEqual(keys(c), ["actualDurationSeconds", "componentTypeKey", "id", "name", "parentComponentId", "plannedDurationSeconds", "sortOrder"]);
  assert.deepEqual(res.body.components.find((c) => c.id === W.drill), { id: W.drill, parentComponentId: null, componentTypeKey: performed[0].detail.componentTypeKey, name: "Passing drill", sortOrder: 1, plannedDurationSeconds: 600, actualDurationSeconds: null });
  for (const d of W.drillComponents.slice(0, 2)) assert.ok(res.body.components.some((c) => c.id === d.id), "a placed value points into the structure");
  // Nothing of Bea, of the staff's bookkeeping, or of the catalog.
  for (const hidden of [W.bea.id, W.bea.name, W.clubOnlyBea.id, W.clubOnlyBea.label, W.sysUnused.id, ...Object.values(BEA).map(String), "bea-coach-note", "ana-coach-note", "sets",
    "occasionId", "sourceIdentityId", "entryMethod", "metricDefinitionVersionId", "aliasParticipantId", "canonicalParticipantId", "athleteId", "athleteNamesById", "computedByRef", "aggregationRole",
    "coverage", "isDerived", "segmentId", "metricEventSegmentId", "metricEventId", "linkStatus", "fromActivityId", "exerciseId", "\"key\"", "icon", "owner", "description", "note"]) {
    assert.ok(!res.text.includes(hidden), `her answer does not contain ${hidden}`);
  }
  // Bea reads the same session: her own four, and her own names - the mirror image.
  const bea = await detail(W.bea, W.actG);
  assert.deepEqual(keys(bea.body.variableNamesById).sort(), [W.sysVar.id, W.clubVar.id, W.teamVar.id, W.clubOnlyBea.id].sort());
  assert.ok(bea.body.facts.every((f) => f.factKind !== "metric_value" || f.detail.level === "session"));
  assert.deepEqual(bea.body.components.map((c) => c.id).sort(), [W.drill, W.beaOnlyDrill].sort(), "Bea's own two");
  for (const hidden of [W.ana.id, ...Object.values(ANA).map(String)]) assert.ok(!bea.text.includes(hidden));
});

test("2. the projection itself: an imported value and an RPE keep only what is hers to read; an estimate is refused", async () => {
  const { athleteSelfFact } = await import("../src/trainingActivityResults.js");
  const imported = { canonicalActivityId: "a", canonicalParticipantId: "p", athleteId: "me", factKind: "metric_value",
    detail: { occasionId: "o", sourceIdentityId: "src-1", entryMethod: "import", metricDefinitionId: "d", metricDefinitionVersionId: "v", valueNumeric: 5, valueBoolean: null, valueText: null, unitAtCapture: "m",
      aggregationRole: "sum", coverage: 1, isDerived: false, computedByRef: null, segmentId: "s", aliasParticipantId: "ap" } };
  const key = athleteSelfFact(imported).detail.valueKey;
  const BASE = { metricDefinitionId: "d", valueNumeric: 5, valueBoolean: null, valueText: null, unitAtCapture: "m", level: "drill", componentId: null, drillOrdinal: null, drillKey: athleteSelfFact(imported).detail.drillKey, valueKey: key };
  assert.deepEqual(athleteSelfFact(imported), { factKind: "metric_value", detail: BASE });
  assert.deepEqual(athleteSelfFact(imported, (segmentId) => (segmentId === "s" ? { componentId: "c-1", drillOrdinal: 2 } : null)).detail, { ...BASE, componentId: "c-1", drillOrdinal: 2 });
  assert.deepEqual(athleteSelfFact({ ...imported, detail: { ...imported.detail, segmentId: null } }, () => ({ componentId: "never", drillOrdinal: 9 })).detail, { ...BASE, level: "session", drillKey: null }, "a session value is never placed");
  assert.ok(/^[0-9a-f]{16}$/.test(BASE.drillKey) && !BASE.drillKey.includes("s") === !BASE.drillKey.includes("s"));
  assert.notEqual(athleteSelfFact({ ...imported, detail: { ...imported.detail, segmentId: "s2" } }).detail.drillKey, BASE.drillKey);
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.notEqual(athleteSelfFact({ ...imported, detail: { ...imported.detail, occasionId: "o2" } }).detail.valueKey, key, "another recording of the same variable has another key");
  for (const method of ["manual", "import", "device", undefined, null, "Estimate", "estimate "]) {
    assert.equal("entryMethod" in athleteSelfFact({ ...imported, detail: { ...imported.detail, entryMethod: method } }).detail, false, String(method));
  }
  // An estimate is not hers at all (owner, 2026-11-16): the projection refuses one even if it were handed one - with
  // or without a label on it.
  const estimateFact = { ...imported, detail: { ...imported.detail, entryMethod: "estimate" } };
  assert.equal(athleteSelfFact(estimateFact), null);
  assert.equal(athleteSelfFact({ ...estimateFact, estimate: { method: "copy_athlete", estimatedBy: "Coach Example", estimatedAt: "2026-09-08T10:00:00Z", sourceAthleteName: "Bea Example" } }), null);
  const { isEstimateFact } = await import("../src/trainingActivityResults.js");
  assert.deepEqual([estimateFact, imported, { factKind: "rpe", detail: { entryMethod: "estimate" } }, { factKind: "metric_value", detail: { entryMethod: "manual" } }, null].map(isEstimateFact), [true, false, false, false, false]);
  assert.deepEqual(athleteSelfFact({ athleteId: "me", factKind: "rpe", detail: { sessionFeedbackId: "f", rpe: 7, durationMinutes: 60, srpe: 420, source: "athlete_app", aliasParticipantId: "ap" } }),
    { factKind: "rpe", detail: { rpe: 7, durationMinutes: 60, srpe: 420 } });
  assert.deepEqual(athleteSelfFact({ athleteId: "me", factKind: "component_performance", detail: { componentId: "c", name: "Drill", componentTypeKey: "drill", status: "performed", actualDurationSeconds: 5, note: "n", actualPrescriptionSnapshot: { a: 1 }, activityParticipantComponentId: "x", aliasParticipantId: "ap" } }),
    { factKind: "component_performance", detail: { componentId: "c", name: "Drill", componentTypeKey: "drill", status: "performed", actualDurationSeconds: 5 } });
  // A kind this list does not know - the link-only ones, or one added later - is not hers until it is added here.
  for (const kind of ["metric_event_link", "component_metric_segment_link", "coach_note", "roster_decision"]) assert.equal(athleteSelfFact({ athleteId: null, factKind: kind, detail: { anything: 1 } }), null, kind);
  const { recordedByOf } = await import("../src/trainingActivityResults.js");
  assert.deepEqual([{ device: true, any: true }, { device: false, any: true }, { device: false, any: false }, { device: null, any: null }].map(recordedByOf), ["device", "coach", null, null]);
});

test("3. what is not hers answers the identical 404, byte for byte: a missing id, another athlete's session in her team, another club's, another's on an archived team; her own on an archived team stays hers", async () => {
  const missing = await detail(W.ana, crypto.randomUUID());
  assert.equal(missing.status, 404);
  assert.equal(missing.text, JSON.stringify({ error: "Activity not found." }));
  for (const [what, id] of [["another athlete's, same team", W.actBea], ["another club's", W.actCy], ["another athlete's on the archived team", W.actArchivedBea], ["a session she is not in (the dual login's)", W.actDual]]) {
    const res = await detail(W.ana, id);
    assert.equal(res.status, 404, what);
    assert.equal(res.text, missing.text, what);
  }
  // The same for an athlete of another club against the group session.
  const cy = await detail(W.cy, W.actG);
  assert.deepEqual([cy.status, cy.text], [404, missing.text]);
  // The archived team's session is hidden from the club's admin too, with the same answer; the group session is not.
  const admin = await detail(W.caA, W.actArchived);
  assert.deepEqual([admin.status, admin.text], [404, missing.text]);
  assert.equal((await detail(W.caA, W.actG)).status, 200);
  assert.equal((await detail(W.ana, "not-a-uuid")).status, 400);
  // Her own past result on the team that was archived later: still hers, read-only (the Rukovodilac's decision on the
  // owner's "all of her own results"); the team's other session there is the 404 above.
  const own = await detail(W.ana, W.actArchived);
  assert.equal(own.status, 200, own.text);
  assert.deepEqual(own.body.facts.map((f) => Number(f.detail.valueNumeric)), [999.5]);
  assert.ok(!own.text.includes(W.bea.id));
});

test("4. the list: her own rows only, without the staff's bookkeeping; another athlete's id is refused; her own on the archived team is there, another's is not", async () => {
  const res = await list(W.ana);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.rows.map((r) => r.activityId).sort(), [W.actG, W.actArchived].sort(), "the group session and her own on the archived team");
  for (const row of res.body.rows) {
    assert.deepEqual(keys(row), ["activityId", "activityTypeKey", "athleteId", "endedAt", "localDate", "name", "participantId", "participationStatus", "recordedBy", "startedAt", "timezoneSnapshot"]);
    assert.equal(row.athleteId, W.ana.id);
    assert.equal(row.recordedBy, "coach", "entered by hand");
  }
  for (const hidden of [W.bea.id, W.actBea, W.actCy, W.actArchivedBea, W.actDual, "origin", "lifecycleState", "ownerScope"]) assert.ok(!res.text.includes(hidden), hidden);
  assert.equal((await call(`/api/training-activity?dateFrom=${DAY}&dateTo=${DAY}&athleteId=${W.bea.id}`, { cookie: W.ana.cookie })).status, 403);
  // A coach's rows are as they were.
  const coach = await list(W.coachA1);
  assert.deepEqual(keys(coach.body.rows[0]), ["activityId", "activityTypeKey", "athleteId", "endedAt", "lifecycleState", "localDate", "name", "origin", "ownerScope", "participantId", "participationStatus", "startedAt", "timezoneSnapshot"]);
  assert.ok(coach.body.rows.some((r) => r.athleteId === W.bea.id) && coach.body.rows.some((r) => r.athleteId === W.ana.id));
});

test("5. the calendar: her sessions without the team's numbers; a coach's calendar is as it was", async () => {
  const res = await calendar(W.ana);
  assert.equal(res.status, 200, res.text);
  const items = res.body.days.flatMap((d) => d.items).filter((i) => i.kind === "activity");
  assert.deepEqual(items.map((i) => i.activityId).sort(), [W.actG, W.actArchived].sort());
  for (const item of items) {
    assert.deepEqual(keys(item), ["activityId", "activityTypeKey", "kind", "name", "occurredLocalDate", "recordedBy", "rpe", "startedAt", "timezoneSnapshot"]);
    assert.equal(item.rpe, null, "nobody asked her for an RPE on this session");
    assert.equal(item.recordedBy, "coach");
  }
  for (const hidden of ["participantCount", "metrics", "withData", "conflictCount", "openSuggestionCount", "origin", "lifecycleState", W.bea.id, W.bea.name, W.actBea, W.actArchivedBea, W.actDual]) assert.ok(!res.text.includes(hidden), hidden);
  const coach = await calendar(W.coachA1);
  const group = coach.body.days.flatMap((d) => d.items).find((i) => i.activityId === W.actG);
  assert.deepEqual(keys(group), ["activityId", "activityTypeKey", "conflictCount", "kind", "lifecycleState", "metrics", "name", "occurredLocalDate", "openSuggestionCount", "origin", "participantCount", "rpe", "startedAt", "timezoneSnapshot"]);
  assert.equal(group.participantCount, 2);
  assert.ok(!("recordedBy" in group));
  assert.deepEqual(group.metrics, { total: 2, withData: 2 });
});

test("6. one login that is a coach and an athlete: in the team's workspace the coach's answer, in the athlete's workspace her own", async () => {
  await workspace(W.dual.userId, "team", W.teamA1);
  const asCoach = await detail(W.dual, W.actDual);
  assert.equal(asCoach.status, 200, asCoach.text);
  assert.deepEqual(keys(asCoach.body), ["athleteNamesById", "canonicalActivityId", "components", "facts", "variableNamesById"]);
  assert.ok(asCoach.body.facts.some((f) => f.athleteId === W.bea.id) && asCoach.text.includes("occasionId"), "the coach's read, with the other athlete");
  assert.equal((await detail(W.dual, W.actBea)).status, 200, "a coach reads a session she is not in");
  assert.ok((await calendar(W.dual)).text.includes("participantCount"));
  await workspace(W.dual.userId, "athlete", null);
  const asAthlete = await detail(W.dual, W.actDual);
  assert.deepEqual(keys(asAthlete.body), ["canonicalActivityId", "components", "facts", "myAttendance", "recordedBy", "variableNamesById"]);
  assert.deepEqual(asAthlete.body.facts.map((f) => Number(f.detail.valueNumeric)), [55.5]);
  assert.ok(!asAthlete.text.includes(W.bea.id) && !asAthlete.text.includes("7790.5"));
  assert.equal((await detail(W.dual, W.actBea)).status, 404, "as an athlete, not hers");
  assert.ok(!(await calendar(W.dual)).text.includes("participantCount"));
});

test("7. her attendance and how her values were recorded; a club archived later; an athlete with a decision and no value", async () => {
  await workspace(W.dual.userId, "athlete", null); // on its own, whatever ran before
  const key = () => crypto.randomUUID();
  const put = (activityId, athlete, body) => call(`/api/training-activity/${activityId}/roster/${athlete.id}/decision`, { method: "PUT", cookie: W.coachA1.cookie, body: { expectedDecisionId: null, requestKey: key(), ...body } });
  // No decision about her and a value of hers: she took part. Her values were entered by hand: "coach".
  const before = await detail(W.bea, W.actBea);
  assert.deepEqual([before.body.myAttendance, before.body.recordedBy], ["participated", "coach"]);
  // The coach's decision about her says it, in one word: no reason, no note, no author.
  const said = await put(W.actBea, W.bea, { kind: "participated_no_values", note: "vest-forgotten-note" });
  assert.equal(said.status, 200, said.text);
  // A value of hers says she took part, whatever a decision beside it says (the coach is shown that disagreement).
  let own = await detail(W.bea, W.actBea);
  assert.equal(own.body.myAttendance, "participated");
  const absent = await put(W.actBea, W.bea, { kind: "did_not_participate", reasonKey: "illness", note: "absent-note-kappa", expectedDecisionId: said.body.decision.id });
  assert.equal(absent.status, 200, absent.text);
  // Another athlete of the roster (the first by name) has another state in the same session: hers is her own.
  assert.equal((await put(W.actBea, W.dana, { kind: "participated_no_values" })).status, 200);
  own = await detail(W.bea, W.actBea);
  assert.equal(own.body.myAttendance, "participated");
  for (const hidden of ["vest-forgotten-note", "absent-note-kappa", "illness", "reasonKey", "decidedBy", W.coachA1.id, "decision"]) assert.ok(!own.text.includes(hidden), hidden);
  // A value written by a device (as an import writes it): "device", in the detail, the list and the calendar.
  await k.query("begin");
  await k.query("set local session_replication_role = replica");
  const changed = await k.query(`update training_load.metric_measurement_occasions o set entry_method = 'api_import'
     from training.activity_participant_metric_participant_links mpl join training.activity_participants ap on ap.id = mpl.activity_participant_id
     where o.event_participant_id = mpl.metric_event_participant_id and ap.activity_id = $1 and ap.athlete_id = $2`, [W.actBea, W.bea.id]);
  await k.query("commit");
  assert.equal(changed.rowCount, 1);
  own = await detail(W.bea, W.actBea);
  assert.equal(own.body.recordedBy, "device");
  assert.ok(!own.text.includes("api_import") && !own.text.includes("entryMethod"), "never how, only by whom");
  const rows = (await list(W.bea)).body.rows;
  assert.equal(rows.find((r) => r.activityId === W.actBea).recordedBy, "device");
  assert.equal(rows.find((r) => r.activityId === W.actG).recordedBy, "coach");
  const items = (await calendar(W.bea)).body.days.flatMap((d) => d.items);
  assert.equal(items.find((i) => i.activityId === W.actBea).recordedBy, "device");
  assert.equal(items.find((i) => i.activityId === W.actG).recordedBy, "coach");
  // In a session of two, the OTHER athlete's value is a device's and only the other was asked for and gave an RPE:
  // her list and calendar still say "coach", and her RPE is her own (asked: no).
  await k.query("begin");
  await k.query("set local session_replication_role = replica");
  await k.query(`update training_load.metric_measurement_occasions o set entry_method = 'api_import'
     from training.activity_participant_metric_participant_links mpl join training.activity_participants ap on ap.id = mpl.activity_participant_id
     where o.event_participant_id = mpl.metric_event_participant_id and ap.activity_id = $1 and ap.athlete_id = $2`, [W.actDual, W.bea.id]);
  await k.query("commit");
  const schedule = (await one(`insert into training_load.external_schedules (schedule_kind, timezone, start_date, opens_time, closes_time, status, event_name, created_by_user_id, owner_scope, owner_team_id)
     values ('one_time','UTC',$1,'00:00','23:59','active','Fixture event',$2,'team',$3) returning id`, [DAY, W.coachA1.id, W.teamA1])).id;
  const occurrence = (await one(`insert into training_load.external_schedule_occurrences (schedule_id, scheduled_date, opens_at, closes_at) values ($1,$2,$3,$4) returning id`, [schedule, DAY, `${DAY}T00:00:00Z`, `${DAY}T23:59:00Z`])).id;
  const asked = async (athlete, rpe) => {
    const assignment = (await one(`insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at) values ($1,$2,'UTC',$3,$4,$5) returning id`,
      [occurrence, athlete.id, DAY, `${DAY}T00:00:00Z`, `${DAY}T23:59:00Z`])).id;
    await k.query(`insert into training.activity_participant_session_links (activity_participant_id, athlete_id, external_assignment_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
       select ap.id, ap.athlete_id, $3, 'manual', 'confirmed', $4, now(), $4 from training.activity_participants ap where ap.activity_id = $1 and ap.athlete_id = $2`, [W.actDual, athlete.id, assignment, W.coachA1.id]);
    if (rpe) await k.query(`insert into training_load.session_feedback (athlete_id, session_date, external_assignment_id, source, rpe, duration_minutes, event_name) values ($1,$2,$3,'scheduled_external',$4,60,'Fixture event')`, [athlete.id, DAY, assignment, rpe]);
  };
  await asked(W.bea, 7);
  const dualItem = async () => (await calendar(W.dual)).body.days.flatMap((d) => d.items).find((i) => i.activityId === W.actDual);
  assert.deepEqual([(await dualItem()).recordedBy, (await dualItem()).rpe], ["coach", null], "the other's device and the other's RPE are not hers");
  assert.equal((await list(W.dual)).body.rows.find((r) => r.activityId === W.actDual).recordedBy, "coach");
  assert.equal((await detail(W.dual, W.actDual)).body.recordedBy, "coach");
  await asked(W.dual, null);
  assert.deepEqual((await dualItem()).rpe, { requested: 1, rated: 0 }, "she was asked and has not answered; the other's answer is not counted");
  // Bea's own RPE in that session, through the route: three fields.
  const beaDual = await detail(W.bea, W.actDual);
  assert.deepEqual(beaDual.body.facts.find((f) => f.factKind === "rpe"), { factKind: "rpe", detail: { rpe: 7, durationMinutes: 60, srpe: 420 } });
  assert.deepEqual((await calendar(W.bea)).body.days.flatMap((d) => d.items).find((i) => i.activityId === W.actDual).rpe, { requested: 1, rated: 1 });

  // An athlete of the team with a decision about her and NO value in the session is not a participant of it: the
  // session is not hers to open (the same 404) and is not in her list. (Recorded as it is today; whether a session
  // she is only marked in should be hers to see is the owner's decision, not this change's.)
  assert.equal((await put(W.actG, W.dana, { kind: "participated_no_values" })).status, 200);
  assert.equal((await put(W.actG, W.ema, { kind: "did_not_participate", reasonKey: "illness" })).status, 200);
  for (const who of [W.dana, W.ema]) {
    const res = await detail(who, W.actG);
    assert.deepEqual([res.status, res.text], [404, JSON.stringify({ error: "Activity not found." })]);
    assert.deepEqual((await list(who)).body.rows, []);
  }
  // Ana's answer did not change with the decisions about the others.
  assert.equal((await detail(W.ana, W.actG)).body.myAttendance, "participated");
  // An athlete who is a participant WITHOUT a value (she only gave an RPE): the coach's decision about her, in one
  // word - and never the decision about the athlete listed first.
  W.noValue = await athleteIn(W.clubA, W.teamA1, { withUser: true });
  await k.query(`insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status, merge_status)
     select a.id, $2, a.occurred_local_date, 'UTC', 'participated', 'canonical' from training.activities a where a.id = $1`, [W.actBea, W.noValue.id]);
  let quiet = await detail(W.noValue, W.actBea);
  assert.equal(quiet.status, 200, quiet.text);
  assert.deepEqual([quiet.body.myAttendance, quiet.body.recordedBy, quiet.body.facts, quiet.body.components], [null, null, [], []], "no value, no decision: nothing is said");
  const first = await put(W.actBea, W.noValue, { kind: "participated_no_values", note: "note-about-her" });
  assert.equal(first.status, 200, first.text);
  quiet = await detail(W.noValue, W.actBea);
  assert.equal(quiet.body.myAttendance, "participated_no_device_data");
  assert.equal((await put(W.actBea, W.noValue, { kind: "did_not_participate", reasonKey: "illness", expectedDecisionId: first.body.decision.id })).status, 200);
  quiet = await detail(W.noValue, W.actBea);
  assert.equal(quiet.body.myAttendance, "did_not_participate");
  for (const hidden of ["note-about-her", "illness", "reasonKey", "decidedBy", W.coachA1.id, W.bea.id, "7780.5"]) assert.ok(!quiet.text.includes(hidden), hidden);

  // Her club is archived later: her own results stay readable in all three routes; another's stay the 404.
  await k.query(`update public.clubs set is_active = false where id = $1`, [W.clubB]);
  const cy = await detail(W.cy, W.actCy);
  assert.equal(cy.status, 200, cy.text);
  assert.deepEqual(cy.body.facts.map((f) => Number(f.detail.valueNumeric)), [8880.5]);
  assert.deepEqual((await list(W.cy)).body.rows.map((r) => r.activityId), [W.actCy]);
  assert.deepEqual((await calendar(W.cy)).body.days.flatMap((d) => d.items).filter((i) => i.kind === "activity").map((i) => i.activityId), [W.actCy]);
  assert.equal((await detail(W.cy, W.actG)).status, 404);
});

test("8. whether she has a recorded session: one boolean, hers alone; drills of two recordings in one session; after a merge", async () => {
  const self = (who) => call("/api/training-activity/self", { cookie: who.cookie });
  const has = async (who) => { const res = await self(who); assert.equal(res.status, 200, res.text); assert.deepEqual(keys(res.body), ["hasRecordedSessions"]); return res.body.hasRecordedSessions; };
  // None: a new athlete; an athlete the coach only marked (not a participant); the same answer for both.
  const fresh = await athleteIn(W.clubA, W.teamA1, { withUser: true });
  assert.equal(await has(fresh), false);
  assert.equal(await has(W.dana), false);
  assert.equal((await self(fresh)).text, (await self(W.dana)).text);
  // A session she only rated - a participant of a session with no recorded value for anyone - does not count.
  const columns = (await k.query(`select string_agg(quote_ident(column_name), ',') as c from information_schema.columns where table_schema = 'training' and table_name = 'activities' and column_name <> 'id' and is_generated = 'NEVER'`)).rows[0].c;
  const empty = (await one(`insert into training.activities (${columns}) select ${columns} from training.activities where id = $1 returning id`, [W.actBea])).id;
  await k.query(`insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status, merge_status) values ($1,$2,$3,'UTC','participated','canonical')`, [empty, fresh.id, DAY]);
  assert.equal(await has(fresh), false);
  assert.deepEqual((await list(fresh)).body.rows.map((r) => [r.activityId, r.recordedBy]), [[empty, null]], "it is in her list, as a session with nothing recorded");
  // With values of her own; as a participant of a session where only another athlete has values; on an archived
  // club (her history stays hers).
  assert.equal(await has(W.ana), true);
  assert.equal(await has(W.noValue), true, "you took part; no data of yours was recorded");
  assert.equal(await has(W.cy), true, "her club was archived in test 7");
  assert.ok(!(await self(W.ana)).text.match(/\d{4}-\d{2}-\d{2}|count|[0-9a-f]{8}-/), "no date, no count, no id");
  // A session whose ONLY values are estimates - here another participant's - holds nothing measured: it does not
  // count for an athlete who took part in it without a value. (The fixture turns a hand-entered value into an
  // estimate in place; the estimate suite covers estimates written by the real route.)
  const p = await athleteIn(W.clubA, W.teamA1, { withUser: true });
  const q = await athleteIn(W.clubA, W.teamA1, { withUser: true });
  const onlyEstimates = await recorded(W.coachA1, [[p, [[W.sysVar, 61.5]]]]);
  await k.query(`insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status, merge_status) values ($1,$2,$3,'UTC','participated','canonical')`, [onlyEstimates, q.id, DAY]);
  assert.equal(await has(q), true, "while the other's value is a measured one");
  await k.query("begin");
  await k.query("set local session_replication_role = replica");
  await k.query(`update training_load.metric_measurement_occasions o set entry_method = 'estimate'
     from training.activity_participant_metric_participant_links mpl join training.activity_participants ap on ap.id = mpl.activity_participant_id
     where o.event_participant_id = mpl.metric_event_participant_id and ap.activity_id = $1`, [onlyEstimates]);
  await k.query("commit");
  assert.equal(await has(q), false, "once it is an estimate, nothing measured is left in that session");
  assert.equal(await has(p), false, "nor for the athlete whose only value it is");
  // The athlete whose only tie to the session is that estimate: the session is not hers to see at all - the 404 of
  // a missing one, and not in her list or calendar. The other, who took part without any value, still has it, empty.
  const hidden = await detail(p, onlyEstimates);
  assert.deepEqual([hidden.status, hidden.text], [404, JSON.stringify({ error: "Activity not found." })]);
  assert.deepEqual((await list(p)).body.rows, []);
  assert.deepEqual((await calendar(p)).body.days.flatMap((d) => d.items).filter((i) => i.kind === "activity"), []);
  const still = await detail(q, onlyEstimates);
  assert.deepEqual([still.status, still.body.facts, still.body.recordedBy, still.body.variableNamesById], [200, [], null, {}]);
  assert.ok(!still.text.includes("61.5") && !still.text.includes("estimate"));
  assert.deepEqual((await list(q)).body.rows.map((r) => [r.activityId, r.recordedBy]), [[onlyEstimates, null]]);
  // The estimated athlete was also asked to rate that session (a confirmed link ties her to it apart from the
  // estimate): the session is hers again - and still says nothing of the estimate: no value, recorded by nobody, no
  // attendance drawn from it; once a third athlete has a measured value in it, it counts for her as for anyone who
  // took part without a value - exactly as if her estimate were not there.
  const schedule = (await one(`insert into training_load.external_schedules (schedule_kind, timezone, start_date, opens_time, closes_time, status, event_name, created_by_user_id, owner_scope, owner_team_id)
     values ('one_time','UTC',$1,'00:00','23:59','active','Fixture rating',$2,'team',$3) returning id`, [DAY, W.coachA1.id, W.teamA1])).id;
  const occurrence = (await one(`insert into training_load.external_schedule_occurrences (schedule_id, scheduled_date, opens_at, closes_at) values ($1,$2,$3,$4) returning id`, [schedule, DAY, `${DAY}T00:00:00Z`, `${DAY}T23:59:00Z`])).id;
  const assignment = (await one(`insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at) values ($1,$2,'UTC',$3,$4,$5) returning id`,
    [occurrence, p.id, DAY, `${DAY}T00:00:00Z`, `${DAY}T23:59:00Z`])).id;
  await k.query(`insert into training.activity_participant_session_links (activity_participant_id, athlete_id, external_assignment_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
     select ap.id, ap.athlete_id, $3, 'manual', 'confirmed', $4, now(), $4 from training.activity_participants ap where ap.activity_id = $1 and ap.athlete_id = $2`, [onlyEstimates, p.id, assignment, W.coachA1.id]);
  const tied = await detail(p, onlyEstimates);
  assert.equal(tied.status, 200, tied.text);
  assert.deepEqual([tied.body.facts, tied.body.recordedBy, tied.body.myAttendance, tied.body.variableNamesById, tied.body.components], [[], null, null, {}, []]);
  assert.ok(!tied.text.includes("61.5") && !tied.text.includes("estimate"));
  assert.deepEqual((await list(p)).body.rows.map((r) => [r.activityId, r.recordedBy]), [[onlyEstimates, null]]);
  assert.deepEqual((await calendar(p)).body.days.flatMap((d) => d.items).filter((i) => i.kind === "activity").map((i) => [i.activityId, i.recordedBy]), [[onlyEstimates, null]]);
  const third = await athleteIn(W.clubA, W.teamA1, { withUser: true });
  const add = await call("/api/training-load/metrics/events", { method: "POST", cookie: W.coachA1.cookie, body: { requestKey: `k-${uid()}`, occurredDate: DAY, scopeLevel: "session", activityId: onlyEstimates,
    participants: [{ athleteId: third.id, timezone: "UTC", values: [{ metricDefinitionId: W.sysVar.id, metricDefinitionVersionId: W.sysVar.versionId, value: 62.5 }] }] } });
  assert.equal(add.status, 201, add.text);
  assert.deepEqual([await has(third), await has(q), await has(p)], [true, true, true], "measured for one; the other two took part without a measured value - an estimate of her own changes nothing");
  // Outside an athlete workspace the route does not exist: the unknown route's own answer.
  const coach = await self(W.coachA1);
  const unknown = await call("/api/training-activity-nope/self", { cookie: W.coachA1.cookie });
  assert.equal(coach.status, 404);
  assert.equal(coach.text.replace("/api/training-activity/self", "X"), unknown.text.replace("/api/training-activity-nope/self", "X"));
  assert.equal((await call("/api/training-activity/self")).status, 401);

  // One session holding two recordings, each numbering its drills from 1: two drills, two orders, two keys.
  const mia = await athleteIn(W.clubA, W.teamA1, { withUser: true });
  const record = (body) => call("/api/training-load/metrics/events", { method: "POST", cookie: W.writerA1.cookie, body: { requestKey: `k-${uid()}`, occurredDate: DAY, scopeLevel: "session", ...body } });
  const value = (v, n, segmentIndex) => ({ metricDefinitionId: W.drillVar.id, metricDefinitionVersionId: W.drillVar.versionId, value: n, ...(segmentIndex === undefined ? {} : { segmentIndex }) });
  const firstRecording = await record({ segments: [{ label: "First recording drill", order: 1 }], participants: [{ athleteId: mia.id, timezone: "UTC", values: [value(0, 901.5, 0)] }] });
  assert.equal(firstRecording.status, 201, firstRecording.text);
  const session = firstRecording.body.activityId;
  const secondRecording = await record({ activityId: session, segments: [{ label: "Second recording drill", order: 1 }], participants: [{ athleteId: mia.id, timezone: "UTC", values: [value(0, 902.5, 0)] }] });
  assert.equal(secondRecording.status, 201, secondRecording.text);
  const two = await detail(mia, session);
  const drills = two.body.facts.filter((f) => f.factKind === "metric_value").map((f) => [Number(f.detail.valueNumeric), f.detail.level, f.detail.drillOrdinal]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(drills.map((d) => d.slice(0, 2)), [[901.5, "drill"], [902.5, "drill"]]);
  assert.deepEqual(drills.map((d) => d[2]).sort(), [1, 2], "numbered across the session's recordings, never 1 and 1");
  assert.equal(new Set(two.body.facts.map((f) => f.detail.drillKey)).size, 2);
  assert.equal(two.body.components.length, 2);

  // After a merge: one participant of hers had a hand-entered value, the other a device's. One row in her list,
  // recorded by a device in the list, the calendar and the detail alike; the merged-away id still opens hers.
  const zed = await athleteIn(W.clubA, W.teamA1, { withUser: true });
  const sessionA = (await record({ participants: [{ athleteId: zed.id, timezone: "UTC", values: [{ metricDefinitionId: W.sysVar.id, metricDefinitionVersionId: W.sysVar.versionId, value: 31.5 }] }] })).body.activityId;
  const sessionB = (await record({ participants: [{ athleteId: zed.id, timezone: "UTC", values: [{ metricDefinitionId: W.clubVar.id, metricDefinitionVersionId: W.clubVar.versionId, value: 32.5 }] }] })).body.activityId;
  await k.query("begin");
  await k.query("set local session_replication_role = replica");
  await k.query(`update training_load.metric_measurement_occasions o set entry_method = 'api_import'
     from training.activity_participant_metric_participant_links mpl join training.activity_participants ap on ap.id = mpl.activity_participant_id
     where o.event_participant_id = mpl.metric_event_participant_id and ap.activity_id = $1`, [sessionA]);
  await k.query("commit");
  const participant = async (activityId) => (await one(`select id from training.activity_participants where activity_id = $1 and athlete_id = $2`, [activityId, zed.id])).id;
  const merged = await call(`/api/training-activity/participants/${await participant(sessionA)}/merge`, { method: "POST", cookie: W.coachA1.cookie, body: { targetParticipantId: await participant(sessionB), reason: "duplicate" } });
  assert.ok(merged.status < 300, merged.text);
  const rows = (await list(zed)).body.rows;
  assert.equal(rows.length, 1, "one session, not two");
  assert.equal(rows[0].recordedBy, "device", "the device's value came with the merged participant");
  const item = (await calendar(zed)).body.days.flatMap((d) => d.items).filter((i) => i.kind === "activity");
  assert.deepEqual(item.map((i) => i.recordedBy), ["device"]);
  const after = await detail(zed, rows[0].activityId);
  assert.equal(after.body.recordedBy, "device");
  assert.deepEqual(after.body.facts.map((f) => Number(f.detail.valueNumeric)).sort(), [31.5, 32.5]);
  for (const id of [sessionA, sessionB]) assert.equal((await detail(zed, id)).status, 200, "either id opens her own merged session");
  assert.equal(await has(zed), true);
  assert.equal((await detail(W.ana, sessionA)).status, 404);
});
