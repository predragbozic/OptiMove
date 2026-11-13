// MT-D (plan sections 10 and 13, migrations v68 and v69): scaling a short recording - the scale choice (one track or a picked track),
// the mapper's scaleRecording, the scale_recording save after the import, the flag, the undo and the migration's round trip.
// Disposable databases only; GPEXE is the fake server3 source.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding } from "./support/mapped-world.mjs";
import crypto from "node:crypto";
import { buildGpexeImportPlan, setScaleDurationKeyForTests, trackSetFingerprint } from "../src/gpexeImportMapper.js";
import { LEGACY_SPECS } from "./support/gpexe-legacy-specs.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const ORIGINAL_ESTIMATES = process.env.ESTIMATES_ENABLED;
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
let choices;
let preview;
let estimates;
let timeKey;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "mtd", migrations: GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events")) });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  process.env.ESTIMATES_ENABLED = "true";
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
  choices = await import("../src/gpexeTrackChoiceService.js");
  preview = await import("../src/gpexeImportPreview.js");
  estimates = await import("../src/metricEstimateService.js");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  choices?.setTrackChoiceTestHooks(null);
  estimates?.setEstimateTestHooks(null);
  setScaleDurationKeyForTests(null);
  preview?.setImportTransactionBoundsForTests(null);
  service?.setGpexeClientFactory(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  if (ORIGINAL_ESTIMATES === undefined) delete process.env.ESTIMATES_ENABLED; else process.env.ESTIMATES_ENABLED = ORIGINAL_ESTIMATES;
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
  return { status: res.status, body: parsed, text };
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


// A session of three athletes: 101 and 102 on one track each, 103 on two tracks that differ (a real restart), and optionally
// 106 on two identical tracks (one recording, MT-0).
function bundleOf({ sessionId, with106 = false, without103 = false, tweak103 = null, updatedOn = "2026-09-14T20:18:09.337" }) {
  const std = standardAthletes();
  const athletes = std.map((a) => structuredClone(a));
  if (without103) athletes.splice(2, 1);
  athletes[0].tracks = [sessionId * 10 + 1];
  athletes[1].tracks = [sessionId * 10 + 2];
  for (const a of athletes.slice(0, 2)) for (const part of a.parts) delete part.track;
  if (tweak103 && !without103) tweak103(athletes[2]);
  if (with106) {
    const dup = { id: 106, tracks: [9207, 9206], parts: [] };
    for (const track of dup.tracks) for (const part of std[1].parts) dup.parts.push({ ...structuredClone(part), track });
    athletes.push(dup);
  }
  return makeBundle({ detailsDrills: [0, 1], sessionId, gpexeTeamId: 77, start: "2026-09-14T10:08:12", updatedOn, athletes });
}

let nextGpexeTeamId = 8700;
async function setupTeam({ link = ["101", "102", "103"] } = {}) {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["Ana", "Bea", "Cid"] });
  await admin.query(`delete from public.athlete_memberships where team_id = $1`, [org.teamId]);
  for (const athleteId of org.athleteIds) {
    await admin.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athleteId, org.clubId, org.teamId]);
  }
  const coachId = await makeUser("coach");
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coachId, org.teamId]);
  await setWorkspace(coachId, "team", org.teamId);
  const coach = { id: coachId, cookie: `optimove_session=${await createSession(coachId)}` };
  const padminId = await makeUser("platform admin");
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [padminId]);
  await setWorkspace(padminId, "platform", null);
  const padmin = { id: padminId, cookie: `optimove_session=${await createSession(padminId)}` };
  const sourceTeamId = String(nextGpexeTeamId++);
  assert.equal((await api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: sourceTeamId } })).status, 200);
  src.show(sourceTeamId);
  const { bindingId } = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId });
  await enableTeamImportSwitch(admin, org.teamId);
  await activateBinding(admin, bindingId);
  const ids = { "101": org.athleteIds[0], "102": org.athleteIds[1], "103": org.athleteIds[2] };
  for (const gpexeAthleteId of link) {
    assert.equal((await api(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId, athleteId: ids[gpexeAthleteId] } })).status, 201);
  }
  return { ...org, coach, padmin, sourceTeamId };
}

async function checkNow(team, bundles) {
  src.serve(team.sourceTeamId, bundles);
  const started = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.padmin.cookie, body: { from: D1, to: D1 } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 200; i += 1) {
    const r = await api(`/teams/${team.teamId}/checks/${started.body.check.id}`, { cookie: team.padmin.cookie });
    if (r.body.check?.status !== "running") {
      assert.equal(r.body.check.status, "succeeded", JSON.stringify(r.body.check));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("check did not finish");
}
const candidates = async (team) => (await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates;
async function candidateOf(team, sessionId, bundleOpts = {}) {
  await checkNow(team, [bundleOf({ sessionId, ...bundleOpts })]);
  const c = (await candidates(team)).find((x) => x.gpexeTeamSessionId === String(sessionId) && ["pending", "blocked"].includes(x.status));
  assert.ok(c, "an open candidate");
  return c;
}
const key = () => crypto.randomUUID();
const choicesUrl = (team, cid) => `/teams/${team.teamId}/candidates/${cid}/track-choices`;
const getChoices = (team, cid, cookie = team.padmin.cookie) => api(choicesUrl(team, cid), { cookie });
const put = (team, cid, athlete, body, cookie = team.padmin.cookie) => api(`${choicesUrl(team, cid)}/${athlete}`, { method: "PUT", cookie, body });
const rowsOf = async (teamId) => (await admin.query(`select * from training_load.gpexe_track_choices where owner_team_id = $1 order by chosen_at, id`, [teamId])).rows;
async function grantCoach(team) {
  const r = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: team.coach.id, reason: "approves this team's imports" } });
  assert.ok([200, 201].includes(r.status), r.text);
  return (await admin.query(`select id from training_load.gpexe_import_approvers where user_id = $1 and owner_team_id = $2 and revoked_at is null`, [team.coach.id, team.teamId])).rows[0].id;
}
async function approve(team, cand) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } } });
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
}
// Records every SQL text sent on clients the application pool hands out while fn runs.
async function recordingSql(fn) {
  const seen = [];
  const wrapped = [];
  const original = appPool.connect;
  appPool.connect = function (callback) {
    if (callback) return original.call(this, callback);
    return original.call(this).then((c) => {
      if (!wrapped.some((w) => w.c === c)) {
        const send = c.query;
        wrapped.push({ c, send });
        c.query = function (...args) {
          const t = typeof args[0] === "string" ? args[0] : args[0]?.text;
          if (t) seen.push(t.replace(/\s+/g, " "));
          return send.apply(this, args);
        };
      }
      return c;
    });
  };
  try {
    const result = await fn();
    return { result, seen };
  } finally {
    appPool.connect = original;
    for (const w of wrapped) w.c.query = w.send;
  }
}
const indexOf = (seen, re) => seen.findIndex((t) => re.test(t));


const oracle = LEGACY_SPECS.map((spec) => ({ raw: true, key: spec.key, levels: { full: true, drill: true }, extract: spec.extract }));
const detailOf = async (team, id, cookie = team.padmin.cookie) => (await api(`/teams/${team.teamId}/candidates/${id}`, { cookie })).body.candidate;
const recompute = (team, id) => api(`/teams/${team.teamId}/candidates/${id}/preview`, { method: "POST", cookie: team.padmin.cookie });
const entryOf = (preview, athlete) => preview.athletes.find((a) => a.gpexeAthleteId === athlete);
const choose = async (team, cid, body) => {
  const r = await put(team, cid, "103", { requestKey: key(), expectedChoiceId: null, ...body });
  assert.equal(r.status, 201, r.text);
  return r.body.choice;
};
const identitiesOf = async (teamId, athleteId) => (await admin.query(
  `select si.source_external_id
     from training_load.metric_source_identities si
     join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id
     join training_load.metric_event_participants p on p.id = o.event_participant_id
     join training_load.metric_events e on e.id = p.event_id
    where e.owner_team_id = $1 and p.athlete_id = $2 order by 1`,
  [teamId, athleteId],
)).rows.map((r) => r.source_external_id);
const nativeOf = (bundle, track) => bundle.athleteSessions.filter((r) => String(r.athlete) === "103" && String(r.track) === String(track))
  .map((r) => (r.drill === null ? `athlete_session:${r.id}:full` : `athlete_session:${r.id}:drill:${r.drill}`)).sort();


// The disposable world names its minutes variable "GPEXE time min <suffix>", not `duration`: the mapper and the save are told.
async function useWorldMinutes() {
  timeKey = (await admin.query(`select key from training_load.metric_definitions where owner_scope = 'system' and label like 'GPEXE time min %'`)).rows[0].key;
  setScaleDurationKeyForTests(timeKey);
  estimates.setEstimateTestHooks({ durationKey: timeKey });
}
async function tapi(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-activity${path}`, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const scale = (team, cid, athlete, minutes, extra = {}) => put(team, cid, athlete, { requestKey: key(), choice: "track", trackId: extra.trackId, expectedChoiceId: null, scaleTargetMinutes: minutes, ...extra });
const wholeValues = async (teamId, athleteId) => (await admin.query(
  `select d.label, v.value_numeric::float8 as value, o.entry_method
     from training_load.metric_values v
     join training_load.metric_measurement_occasions o on o.id = v.occasion_id
     join training_load.metric_event_participants p on p.id = o.event_participant_id
     join training_load.metric_events e on e.id = p.event_id
     join training_load.metric_definitions d on d.id = v.metric_definition_id
    where e.owner_team_id = $1 and p.athlete_id = $2 and o.segment_id is null and o.superseded_by_occasion_id is null
    order by d.label`,
  [teamId, athleteId],
)).rows;

// ---------------------------------------------------------------------------
// 1. The mapper (pure)
// ---------------------------------------------------------------------------
// Mapped specs as mappedMetricSpecs builds them, with the variable's daily aggregation (MT-D).
function specsWith({ withDuration = true } = {}) {
  const spec = (id, key, unit, aggregation, extract, divisor = "1") => Object.freeze({
    activationId: `a-${id}`, mappingVersionId: `mv-${id}`, mappingId: `m-${id}`, sourceMetricVersionId: `sv-${id}`,
    metricDefinitionId: `00000000-0000-4000-8000-00000000000${id}`, metricDefinitionVersionId: `00000000-0000-4000-8000-00000000010${id}`,
    variableKey: key, variableScope: "system", label: key, unit, sourceUnit: "x", sourceMetricKey: `k${id}`, sourceLabel: key,
    sourceParameterFingerprint: `f${id}`, requirement: "optional", aggregation,
    levels: Object.freeze({ full: true, drill: true }),
    factors: Object.freeze({ scale: "1", divisor, offset: "0" }), range: Object.freeze({ min: null, max: null }),
    extract: ({ row }) => ({ value: extract(row) }),
  });
  return [
    ...(withDuration ? [spec(1, "dur", "min", "sum", (r) => r.total_time, "60")] : []),
    spec(2, "dist", "m", "sum", (r) => r.total_distance),
    spec(3, "vmax", "m/s", "max", (r) => r.max_v),
    spec(4, "avgdist", "m", "avg", (r) => r.total_distance),
  ];
}

test("1. the mapper: a one-track athlete's scale moves the whole-session sums into scaleRecording, leaves an average out, keeps the max and the drills; no choice is the plan of before; a stale, too-long or duration-less scale imports the athlete as without one", () => {
  setScaleDurationKeyForTests("dur");
  try {
    const bundle = bundleOf({ sessionId: 6101 });
    const rows102 = bundle.athleteSessions.filter((r) => String(r.athlete) === "102");
    const fingerprint = trackSetFingerprint(rows102);
    assert.match(fingerprint, /^61012:[0-9]+,[0-9]+$/, "a one-track fingerprint");
    const metricSpecs = specsWith();
    const plan = (choices, specs = metricSpecs) => buildGpexeImportPlan(bundle, { metricSpecs: specs, trackChoices: choices });
    const before = JSON.stringify(plan(null));
    assert.equal(JSON.stringify(plan(new Map())), before, "no choice: unchanged");
    const as = (c) => new Map([["102", { choiceId: "c2", kind: "track", trackId: "61012", fingerprint, scaleTargetMinutes: 40, ...c }]]);

    const scaled = plan(as({}));
    const p = scaled.participants.find((x) => x.gpexeAthleteId === "102");
    assert.deepEqual(p.trackChoice, { choiceId: "c2", kind: "track", trackId: "61012", trackCount: 1, stale: false, scaleTargetMinutes: 40 });
    assert.equal(p.scaleRecording.targetMinutes, 40);
    assert.equal(p.scaleRecording.recordedMinutes, 20);
    assert.deepEqual(p.scaleRecording.values.map((v) => [v.variableKey, v.value]), [["dur", "20"], ["dist", "1500"]]);
    const whole = p.results.find((r) => r.level === "full");
    assert.deepEqual(whole.values.map((v) => v.variableKey), ["vmax"], "only the max stays measured");
    const drill = p.results.find((r) => r.level === "drill");
    assert.deepEqual(drill.values.map((v) => v.variableKey), ["dur", "dist", "vmax", "avgdist"], "drill values untouched (D2)");
    assert.deepEqual(scaled.leftOut.filter((r) => r.gpexeAthleteId === "102").map((r) => [r.activationId, r.code]),
      [["a-1", "scaled_by_choice"], ["a-2", "scaled_by_choice"], ["a-4", "not_scaled"]]);
    // Every other athlete as before.
    const others = (pl) => JSON.stringify(pl.participants.filter((x) => x.gpexeAthleteId !== "102"));
    assert.equal(others(scaled), others(plan(null)));

    // Stale (another row set), not shorter, no duration: imported as without a choice.
    const stale = plan(as({ fingerprint: "61012:1" })).participants.find((x) => x.gpexeAthleteId === "102");
    assert.equal(stale.trackChoice.stale, true);
    assert.equal(stale.scaleRecording, undefined);
    assert.deepEqual(stale.results.find((r) => r.level === "full").values.map((v) => v.variableKey), ["dur", "dist", "vmax", "avgdist"]);
    const notShorter = plan(as({ scaleTargetMinutes: 20 })).participants.find((x) => x.gpexeAthleteId === "102");
    assert.deepEqual(notShorter.scaleRecording, { notPossible: "not_shorter", targetMinutes: 20, recordedMinutes: 20 });
    assert.equal(notShorter.results.find((r) => r.level === "full").values.length, 4);
    const noDuration = plan(as({}), specsWith({ withDuration: false })).participants.find((x) => x.gpexeAthleteId === "102");
    assert.deepEqual(noDuration.scaleRecording, { notPossible: "no_duration", targetMinutes: 40 });
    assert.equal(noDuration.results.find((r) => r.level === "full").values.length, 3);
    // A one-track choice without a scale, or of another kind, is ignored.
    assert.equal(JSON.stringify(plan(as({ scaleTargetMinutes: null }))), before);
    assert.equal(JSON.stringify(plan(as({ kind: "none", trackId: null }))), before);

    // A picked track of a multi-track athlete carries the scale too.
    const rows103 = bundle.athleteSessions.filter((r) => String(r.athlete) === "103");
    const fp103 = trackSetFingerprint(rows103);
    const picked = plan(new Map([["103", { choiceId: "c3", kind: "track", trackId: "9003", fingerprint: fp103, scaleTargetMinutes: 40 }]]))
      .participants.find((x) => x.gpexeAthleteId === "103");
    assert.equal(picked.trackChoice.scaleTargetMinutes, 40);
    assert.equal(picked.scaleRecording.recordedMinutes, 10, "track 9003's 600 s");
  } finally {
    setScaleDurationKeyForTests(null);
  }
});

// ---------------------------------------------------------------------------
// 2. The PUT
// ---------------------------------------------------------------------------
test("2. the PUT: a scale on a one-track athlete is stored and listed; without a scale the one-track athlete is not_multiple_tracks; a scale only with 'track', within (0, 600] and two decimals; cleared removes it; with estimates off a scale is scale_not_available and nothing is written", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 6201);
  const noScale = await put(team, cand.id, "102", { requestKey: key(), choice: "track", trackId: "62012", expectedChoiceId: null });
  assert.deepEqual([noScale.status, noScale.body.error], [409, "not_multiple_tracks"]);
  for (const bad of [0, -1, 600.01, 12.345, "40", true]) {
    const r = await put(team, cand.id, "102", { requestKey: key(), choice: "track", trackId: "62012", expectedChoiceId: null, scaleTargetMinutes: bad });
    assert.deepEqual([r.status, r.body.error], [400, "invalid_scale"], `bad scale ${bad}`);
  }
  const onNone = await put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: null, scaleTargetMinutes: 40 });
  assert.deepEqual([onNone.status, onNone.body.error], [400, "invalid_scale"]);

  process.env.ESTIMATES_ENABLED = "false";
  try {
    const off = await scale(team, cand.id, "102", 40, { trackId: "62012" });
    assert.deepEqual([off.status, off.body.error], [409, "scale_not_available"]);
    assert.equal((await rowsOf(team.teamId)).length, 0, "nothing written");
    // A choice without a scale is unchanged with estimates off.
    assert.equal((await put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: null })).status, 201);
    assert.equal((await getChoices(team, cand.id)).body.scaleAvailable, false);
  } finally {
    process.env.ESTIMATES_ENABLED = "true";
  }

  const made = await scale(team, cand.id, "102", 40, { trackId: "62012" });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.choice.scaleTargetMinutes, 40);
  const listed = (await getChoices(team, cand.id)).body;
  assert.equal(listed.scaleAvailable, true);
  const a102 = listed.athletes.find((a) => a.gpexeAthleteId === "102");
  assert.deepEqual(a102.tracks, [{ trackId: "62012" }]);
  assert.equal(a102.currentChoice.scaleTargetMinutes, 40);
  assert.equal(a102.currentChoice.stale, false);
  const row = (await rowsOf(team.teamId)).find((r) => r.gpexe_athlete_id === "102");
  assert.match(row.track_set_fingerprint, /^62012:[0-9,]+$/);
  // Cleared removes the scale; a second clear has nothing to clear.
  const cleared = await put(team, cand.id, "102", { requestKey: key(), choice: "cleared", expectedChoiceId: made.body.choice.id });
  assert.equal(cleared.status, 201, cleared.text);
  assert.equal(cleared.body.choice.scaleTargetMinutes, null);
  const again = await put(team, cand.id, "102", { requestKey: key(), choice: "cleared", expectedChoiceId: cleared.body.choice.id });
  assert.deepEqual([again.status, again.body.error], [409, "nothing_to_clear"]);
  // The database refuses what the service refuses: a one-track row without a scale, a scale on 'none'.
  // (the guard trigger asks for an acting user first; with triggers off the table's own CHECKs answer)
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    await c.query("set session_replication_role = replica");
    for (const [sql, constraint] of [
      [`insert into training_load.gpexe_track_choices (owner_team_id, gpexe_team_session_id, gpexe_athlete_id, track_set_fingerprint, choice, chosen_track_id, chosen_by_user_id, chosen_basis, request_key, request_hash)
        values ('${team.teamId}', '6201', '101', '62011:1', 'track', '62011', '${team.padmin.id}', 'platform_admin', gen_random_uuid(), repeat('a', 64))`, "gpexe_track_choices_one_track_scale"],
      [`insert into training_load.gpexe_track_choices (owner_team_id, gpexe_team_session_id, gpexe_athlete_id, track_set_fingerprint, choice, chosen_by_user_id, chosen_basis, request_key, request_hash, scale_target_minutes)
        values ('${team.teamId}', '6201', '101', '62011:1;62019:2', 'none', '${team.padmin.id}', 'platform_admin', gen_random_uuid(), repeat('a', 64), 40)`, "gpexe_track_choices_scale_on_track"],
    ]) {
      await assert.rejects(c.query(sql), (e) => e.code === "23514" && e.constraint === constraint, constraint);
    }
  } finally {
    await c.end();
  }
});

// ---------------------------------------------------------------------------
// 3. Import, then the save
// ---------------------------------------------------------------------------
test("3. a scaled athlete is imported with its max only; the preview lists the sums as scaled; scale_recording saves duration = target and each sum x target / recorded, with its basis; the proposal shows it; another athlete has no scale", async () => {
  const team = await setupTeam();
  await useWorldMinutes();
  const cand = await candidateOf(team, 6301, { without103: true });
  assert.equal((await scale(team, cand.id, "102", 40, { trackId: "63012" })).status, 201);
  const fresh = (await recompute(team, cand.id)).body.candidate;
  assert.notEqual(fresh.previewHash, cand.previewHash);
  const e = entryOf(fresh.preview, "102");
  assert.equal(e.scaleRecording.targetMinutes, 40);
  assert.equal(e.scaleRecording.recordedMinutes, 20);
  assert.deepEqual([...new Set(e.skippedValues.filter((v) => v.level === "full").map((v) => v.reason))], ["scaled_by_choice"]);
  assert.equal(e.scaleRecording.values.length, e.skippedValues.filter((v) => v.reason === "scaled_by_choice").length);
  const listed = (await candidates(team)).find((c) => c.id === cand.id);
  const ap = await approve(team, listed);
  assert.equal(ap.body.results?.[0]?.outcome, "imported", JSON.stringify(ap.body) + JSON.stringify({ status: listed.status, previewStatus: listed.previewStatus, reasons: listed.reasons, blockers: listed.approvalBlockers }));

  const measured = await wholeValues(team.teamId, team.athleteIds[1]);
  assert.deepEqual(measured.map((r) => [r.label.replace(/ [^ ]+$/, ""), r.entry_method]), [["GPEXE max speed", "api_import"]], "only the max measured");

  const activityId = (await admin.query(`select activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id])).rows[0].activity_id;
  const proposal = await tapi(`/${activityId}/estimates/proposal?athleteId=${team.athleteIds[1]}`, { cookie: team.coach.cookie });
  assert.equal(proposal.status, 200, proposal.text);
  assert.equal(proposal.body.methods.scale_recording.available, true);
  const other = await tapi(`/${activityId}/estimates/proposal?athleteId=${team.athleteIds[0]}`, { cookie: team.coach.cookie });
  assert.deepEqual([other.body.methods.scale_recording.available, other.body.methods.scale_recording.reason], [false, "scale_not_chosen"]);

  const save = await tapi(`/${activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), athleteId: team.athleteIds[1], method: "scale_recording" } });
  assert.equal(save.status, 201, save.text);
  const after = await wholeValues(team.teamId, team.athleteIds[1]);
  const byLabel = Object.fromEntries(after.map((r) => [r.label.replace(/ [^ ]+$/, ""), r]));
  assert.equal(byLabel["GPEXE time min"].value, 40, "the duration becomes the target");
  assert.equal(byLabel["GPEXE time min"].entry_method, "estimate");
  assert.equal(byLabel["GPEXE total distance"].value, 3000, "1500 m x 40 / 20");
  assert.equal(byLabel["GPEXE max speed"].entry_method, "api_import");
  const prov = (await admin.query(
    `select me.method, me.basis from training_load.metric_value_estimates me
       join training_load.metric_values v on v.id = me.metric_value_id
       join training_load.metric_definitions d on d.id = v.metric_definition_id
      where d.label like 'GPEXE total distance %' and me.method = 'scale_recording'`,
  )).rows;
  assert.equal(prov.length, 1);
  assert.deepEqual(prov[0].basis, { measured: 1500, recordedMinutes: 20, targetMinutes: 40 });

  const none = await tapi(`/${activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), athleteId: team.athleteIds[0], method: "scale_recording" } });
  assert.deepEqual([none.status, none.body.error], [409, "scale_not_chosen"]);
  for (const extra of [{ minutes: 30 }, { sourceAthleteId: team.athleteIds[0] }]) {
    const bad = await tapi(`/${activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), athleteId: team.athleteIds[1], method: "scale_recording", ...extra } });
    assert.equal(bad.status, 400, JSON.stringify(extra));
  }
  // After the retention purge the recorded part can no longer be scaled.
  await admin.query(`update training_load.gpexe_import_candidates set raw_bundle = null, preview = null, raw_purged_at = now() where id = $1`, [cand.id]);
  const expired = await tapi(`/${activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), athleteId: team.athleteIds[1], method: "scale_recording" } });
  assert.deepEqual([expired.status, expired.body.error], [409, "scale_basis_expired"]);
});

test("4. the undo removes the scaled estimates with the session; the choice and its scale stay", async () => {
  const team = await setupTeam();
  await useWorldMinutes();
  const cand = await candidateOf(team, 6401, { without103: true });
  assert.equal((await scale(team, cand.id, "102", 40, { trackId: "64012" })).status, 201);
  await recompute(team, cand.id);
  assert.equal((await approve(team, (await candidates(team)).find((c) => c.id === cand.id))).body.results?.[0]?.outcome, "imported");
  const activityId = (await admin.query(`select activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id])).rows[0].activity_id;
  assert.equal((await tapi(`/${activityId}/estimates`, { method: "POST", cookie: team.coach.cookie, body: { requestKey: key(), athleteId: team.athleteIds[1], method: "scale_recording" } })).status, 201);
  assert.ok((await admin.query(`select count(*)::int n from training_load.metric_value_estimates where method = 'scale_recording'`)).rows[0].n > 0);
  const eventId = (await admin.query(`select metric_event_id from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id])).rows[0].metric_event_id;
  const undone = await api(`/teams/${team.teamId}/candidates/${cand.id}/undo-import`, { method: "POST", cookie: team.padmin.cookie, body: { requestKey: key(), reason: "scaled by mistake", expected: { eventId } } });
  assert.equal(undone.status, 200, undone.text);
  const scaledOfTeam = async () => (await admin.query(
    `select count(*)::int n from training_load.metric_value_estimates me
       join training_load.metric_measurement_occasions o on o.id = me.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events e on e.id = p.event_id
      where me.method = 'scale_recording' and e.owner_team_id = $1`, [team.teamId])).rows[0].n;
  assert.equal(await scaledOfTeam(), 0, "the team's scaled estimates are gone");
  const kept = (await rowsOf(team.teamId)).find((r) => r.gpexe_athlete_id === "102");
  assert.equal(Number(kept.scale_target_minutes), 40);
});

// ---------------------------------------------------------------------------
// 5. The migration
// ---------------------------------------------------------------------------
test("5. v68 and v69: each rollback refuses while what it removes is in use (a scaled choice, a scaled estimate, a later migration); on a clean database v69 then v68 roll back to v67's catalog exactly and both apply again; the md5 gate refuses another basis body", async () => {
  const fresh = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "mtd68", migrations: GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events")) });
  const c = new pg.Client({ connectionString: fresh.url });
  await c.connect();
  const fs = await import("node:fs/promises");
  const read = (rel) => fs.readFile(new URL(`../../${rel}`, import.meta.url), "utf8");
  const rb68 = await read("docs/runbooks/scale-recording-v68-rollback.sql");
  const rb69 = await read("docs/runbooks/scale-recording-v69-rollback.sql");
  const v69 = await read("migrations_v2/202611131310_training_load_v69_scale_recording_estimates.sql");
  const catalog = async () => (await c.query(
    `select conname, pg_get_constraintdef(oid) d from pg_constraint
      where conrelid in ('training_load.metric_value_estimates'::regclass, 'training_load.gpexe_track_choices'::regclass) and contype = 'c'
     union all select 'col:' || column_name, data_type from information_schema.columns
      where table_schema = 'training_load' and table_name = 'gpexe_track_choices'
     union all select 'fn:' || p.proname, md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'training_load' and p.proname in ('estimate_basis_ok', 'validate_metric_value_estimate', 'validate_gpexe_track_choice')
     order by 1, 2`,
  )).rows;
  const refuses = async (sql, pattern) => {
    await assert.rejects(c.query(sql), pattern);
    await c.query("rollback").catch(() => {});
  };
  try {
    const withBoth = await catalog();
    await refuses(rb68, /v68 rollback refused: later migrations are applied/);
    assert.deepEqual(await catalog(), withBoth, "a refused rollback changes nothing");
    await c.query(rb69);
    await c.query(rb68);
    const v67Catalog = await catalog();
    assert.ok(!v67Catalog.some((r) => r.conname === "col:scale_target_minutes"));
    assert.ok(v67Catalog.some((r) => r.conname === "fn:estimate_basis_ok" && r.d === "3e33a4053bbfa06cf21a15ce23903029"), "v63's basis body back");
    await refuses(rb68, /v68 is not recorded/);
    await refuses(rb69, /v69 is not recorded/);
    // The md5 gate: another body of estimate_basis_ok refuses v69 and changes nothing.
    await c.query("begin");
    await c.query(`create or replace function training_load.estimate_basis_ok(p_method text, p_basis jsonb) returns boolean as $$ select false $$ language sql immutable`);
    await assert.rejects(c.query(v69), /estimate_basis_ok is not v63's/);
    await c.query("rollback");
    assert.deepEqual(await catalog(), v67Catalog);
    // Re-applied by the real runner (their records and checksums as at start-up).
    await applyGpexeTestMigrations(fresh.url, GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events")));
    assert.deepEqual(await catalog(), withBoth, "v68 and v69 again: the same catalog");
  } finally {
    await c.end();
    await fresh.drop();
  }
  // On the suite's database (scaled choices and estimates made above): both rollbacks refuse.
  const r = new pg.Client({ connectionString: db.url });
  await r.connect();
  try {
    assert.ok((await admin.query(`select count(*)::int n from training_load.metric_value_estimates where method = 'scale_recording'`)).rows[0].n > 0);
    await assert.rejects(r.query(rb69), /a scaled estimate exists/);
    await r.query("rollback").catch(() => {});
    await r.query(`create temp table later as select * from public.schema_migrations where migration_name like '%v69_scale_recording_estimates.sql'`);
    await r.query(`delete from public.schema_migrations where migration_name in (select migration_name from later)`);
    try {
      await assert.rejects(r.query(rb68), /a scaled or one-track choice exists/);
      await r.query("rollback").catch(() => {});
    } finally {
      await r.query(`insert into public.schema_migrations select * from later`);
    }
  } finally {
    await r.end();
  }
});

test("6. the runbook's preflight is all true on a database at v67, and the post-check all true right after v68 and v69", async () => {
  const fs = await import("node:fs/promises");
  const blocks = async (rel) => (await fs.readFile(new URL(`../../${rel}`, import.meta.url), "utf8"))
    .split(/\n(?=-- [0-9]+\. )/).map((b) => b.replace(/^--.*$/gm, "").trim()).filter((b) => b.length > 0);
  const allTrue = async (url, rel) => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const all = await blocks(rel);
      assert.equal(all.length, 4, `${rel}: four blocks`);
      for (const sql of all) {
        await c.query("begin read only");
        const row = (await c.query(sql)).rows[0];
        await c.query("rollback");
        for (const [k, v] of Object.entries(row)) if (typeof v === "boolean") assert.equal(v, true, `${rel}: ${k}`);
      }
    } finally {
      await c.end();
    }
  };
  const base = GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events"));
  const atV67 = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "mtdpre", migrations: base.filter((m) => !/_v6[89]_/.test(m)) });
  try {
    await allTrue(atV67.url, "docs/runbooks/scale-recording-v68-v69-preflight.sql");
    await applyGpexeTestMigrations(atV67.url, base);
    await allTrue(atV67.url, "docs/runbooks/scale-recording-v68-v69-postcheck.sql");
  } finally {
    await atV67.drop();
  }
});
