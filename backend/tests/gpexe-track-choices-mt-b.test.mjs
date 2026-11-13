// MT-B: applying a track choice (plan section 12) - the mapper, the preview and its hash, the coach projection, the batch, the
// roster, preview_changed, a stale choice after an import, the CLI path, and L1-L4 of MT-A's GO; disposable databases.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding } from "./support/mapped-world.mjs";
import crypto from "node:crypto";
import { buildGpexeImportPlan, trackSetFingerprint } from "../src/gpexeImportMapper.js";
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

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "mtb", migrations: GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events")) });
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
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  choices?.setTrackChoiceTestHooks(null);
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

test("1. the mapper: a 'track' choice of exactly this track set imports that track's rows with their native identities, 'none' leaves the athlete out by choice, a cleared or stale choice is today's multiple_tracks, and no choice gives the plan of before MT-B byte for byte", () => {
  const bundle = bundleOf({ sessionId: 6101 });
  const rows = bundle.athleteSessions.filter((r) => String(r.athlete) === "103");
  const fingerprint = trackSetFingerprint(rows);
  assert.match(fingerprint, /^9003:[0-9]+;9004:[0-9]+$/);
  const plan = (choices) => buildGpexeImportPlan(bundle, { metricSpecs: oracle, trackChoices: choices });
  const before = JSON.stringify(buildGpexeImportPlan(bundle, { metricSpecs: oracle }));
  assert.equal(JSON.stringify(plan(new Map())), before, "an empty choice map changes nothing");
  assert.equal(JSON.stringify(plan(null)), before);
  const as = (c) => new Map([["103", { choiceId: "c1", fingerprint, trackId: null, ...c }]]);

  const used = plan(as({ kind: "track", trackId: "9004" }));
  const p = used.participants.find((x) => x.gpexeAthleteId === "103");
  assert.deepEqual(p.trackChoice, { choiceId: "c1", kind: "track", trackId: "9004", trackCount: 2, stale: false });
  assert.deepEqual(p.results.map((r) => r.externalId).sort(), nativeOf(bundle, 9004));
  assert.equal(used.anomalies.some((a) => a.gpexeAthleteId === "103"), false);
  // The same values as a bundle in which 103 was only ever recorded on track 9004.
  const single = structuredClone(bundle);
  single.athleteSessions = single.athleteSessions.filter((r) => !(String(r.athlete) === "103" && String(r.track) === "9003"));
  const valuesOf = (pl) => pl.participants.find((x) => x.gpexeAthleteId === "103").results.map((r) => [r.externalId, r.values.map((v) => [v.key, v.value])]);
  assert.deepEqual(valuesOf(used), valuesOf(buildGpexeImportPlan(single, { metricSpecs: oracle })));

  const none = plan(as({ kind: "none" }));
  assert.equal(none.participants.some((x) => x.gpexeAthleteId === "103"), false);
  assert.deepEqual(none.anomalies.filter((a) => a.gpexeAthleteId === "103").map((a) => [a.kind, a.trackChoice?.kind, a.trackChoice?.stale]), [["no_track_by_choice", "none", false]]);

  const cleared = plan(as({ kind: "cleared" }));
  assert.equal(JSON.stringify(cleared), before, "a cleared choice is no choice");
  for (const stale of [as({ kind: "track", trackId: "9004", fingerprint: "9003:1;9004:2" }), as({ kind: "none", fingerprint: "9003:1;9004:2" }), as({ kind: "track", trackId: "9009" })]) {
    const pl = plan(stale);
    const a = pl.anomalies.filter((x) => x.gpexeAthleteId === "103");
    assert.deepEqual(a.map((x) => [x.kind, x.trackChoice?.stale]), [["multiple_tracks", true]]);
    assert.equal(pl.participants.some((x) => x.gpexeAthleteId === "103"), false);
  }
  const odd = rows.map((r) => (String(r.track) === "9004" ? { ...r, track: null } : r));
  assert.equal(trackSetFingerprint(odd), null);
});

test("2. the preview: no choice leaves the stored preview and hash unchanged; 'track' shows the athlete measured from that track (hash changes, J20-A1 stores it); a coach reads the choice without its id", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 6201);
  const first = await detailOf(team, cand.id);
  const r0 = await recompute(team, cand.id);
  assert.equal(r0.status, 200, r0.text);
  assert.equal(r0.body.candidate.previewHash, cand.previewHash, "no choice: the recomputed preview is the stored one");
  assert.equal(JSON.stringify(entryOf(r0.body.candidate.preview, "103")), JSON.stringify(entryOf(first.preview, "103")));
  assert.equal("trackChoice" in entryOf(first.preview, "103"), false);

  const c = await choose(team, cand.id, { choice: "track", trackId: "9004" });
  const r1 = await recompute(team, cand.id);
  assert.equal(r1.status, 200, r1.text);
  assert.notEqual(r1.body.candidate.previewHash, cand.previewHash);
  const e = entryOf(r1.body.candidate.preview, "103");
  assert.deepEqual(e.trackChoice, { choiceId: c.id, kind: "track", trackId: "9004", trackCount: 2, stale: false });
  assert.equal(e.gps.status, "measured");
  assert.equal(e.notImported, null);
  const bundle = bundleOf({ sessionId: 6201 });
  assert.deepEqual(e.results.map((x) => x.externalId).sort(), nativeOf(bundle, 9004));
  const asCoach = entryOf((await detailOf(team, cand.id, team.coach.cookie)).preview, "103");
  assert.deepEqual(asCoach.trackChoice, { kind: "track", trackId: "9004", trackCount: 2, stale: false }, "no choice id for a coach");
});

test("3. 'none': the athlete is left out by choice (no review, no roster observation); the session imports in the batch; a 'none' lifts no other blocker - with an unlinked athlete it stays not ready", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 6301);
  await choose(team, cand.id, { choice: "none" });
  const fresh = (await recompute(team, cand.id)).body.candidate;
  const e = entryOf(fresh.preview, "103");
  assert.equal(e.gps.status, "not_used_by_choice");
  assert.equal(e.notImported.code, "no_track_by_choice");
  assert.equal(e.trackChoice.kind, "none");
  const listed = (await candidates(team)).find((c) => c.id === cand.id);
  assert.equal(listed.previewHash, fresh.previewHash);
  const r = await approve(team, listed);
  assert.equal(r.body.results?.[0]?.outcome, "imported", r.text);
  assert.deepEqual(await identitiesOf(team.teamId, team.athleteIds[2]), [], "nothing of 103 imported");
  const observations = (await admin.query(`select count(*)::int n from training.activity_source_observations where athlete_id = $1`, [team.athleteIds[2]])).rows[0].n;
  assert.equal(observations, 0, "no record_unusable observation for a 'none' athlete");

  // Another blocker stays: 102 not linked.
  const other = await setupTeam({ link: ["101", "103"] });
  const c2 = await candidateOf(other, 6302);
  await choose(other, c2.id, { choice: "none" });
  await recompute(other, c2.id);
  const listed2 = (await candidates(other)).find((c) => c.id === c2.id);
  const r2 = await approve(other, listed2);
  assert.equal(r2.body.results?.[0]?.outcome, "refused", r2.text);
  assert.equal(r2.body.results[0].code, "not_ready");
});

test("4. a choice changed between the review and the approval is preview_changed (nothing imported); the reviewed choice then imports 103 from its track, with that track's identities, and the choice is final", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 6401);
  const c1 = await choose(team, cand.id, { choice: "track", trackId: "9003" });
  await recompute(team, cand.id);
  const reviewed = (await candidates(team)).find((c) => c.id === cand.id);
  const c2 = await choose(team, cand.id, { choice: "track", trackId: "9004", expectedChoiceId: c1.id });
  const refused = await approve(team, reviewed);
  assert.equal(refused.body.results?.[0]?.code, "preview_changed", refused.text);
  assert.equal((await admin.query(`select count(*)::int n from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id])).rows[0].n, 0);
  await recompute(team, cand.id);
  const now = (await candidates(team)).find((c) => c.id === cand.id);
  assert.equal((await approve(team, now)).body.results?.[0]?.outcome, "imported");
  assert.deepEqual(await identitiesOf(team.teamId, team.athleteIds[2]), nativeOf(bundleOf({ sessionId: 6401 }), 9004));
  const final = await put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: c2.id });
  assert.equal(final.status, 409);
});

test("5. GPEXE changes the tracks after the import: the choice is stale, the session is blocked identities_missing_from_source, and the resolution says track_choice_stale / undo_and_choose_again", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 6501);
  await choose(team, cand.id, { choice: "track", trackId: "9004" });
  await recompute(team, cand.id);
  assert.equal((await approve(team, (await candidates(team)).find((c) => c.id === cand.id))).body.results?.[0]?.outcome, "imported");
  const third = (a) => { a.tracks = [9003, 9004, 9005]; a.parts.push({ drill: null, track: 9005, time: 300, distance: 200, maxV: 4, power: [300, 0, 0, 0, 0], acc: 1, dec: 1 }); };
  await checkNow(team, [bundleOf({ sessionId: 6501, updatedOn: "2026-09-15T09:00:00.000", tweak103: third })]);
  const blocked = (await candidates(team)).find((c) => c.gpexeTeamSessionId === "6501" && c.status === "blocked");
  assert.ok(blocked, "the changed session is blocked");
  const d = await detailOf(team, blocked.id);
  assert.equal(d.preview.blocked.code, "identities_missing_from_source");
  const step = d.preview.blocked.resolution.find((s) => s.gpexeAthleteId === "103");
  assert.deepEqual([step.cause, step.action], ["track_choice_stale", "undo_and_choose_again"]);
  assert.equal(entryOf(d.preview, "103").trackChoice.stale, true);
});

test("6. the CLI / test writer path refuses a session with a current choice (track_choice_not_supported)", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 6601);
  const c = await choose(team, cand.id, { choice: "track", trackId: "9004" });
  const writer = await import("../src/gpexeImportWriter.js");
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    const bundle = bundleOf({ sessionId: 6601 });
    await assert.rejects(writer.importGpexeBundle(client, bundle, { ownerTeamId: team.teamId, performedByUserId: team.padmin.id, athleteIdByGpexeId: {} }), { code: "track_choice_not_supported" });
  } finally {
    await client.end();
  }
  assert.ok(c.id);
});

test("7. L1: two first choices of one athlete from two connections, the guard satisfied, end in one row and a 23505 (the one-root index)", async () => {
  const team = await setupTeam();
  const a = new pg.Client({ connectionString: db.url });
  const b = new pg.Client({ connectionString: db.url });
  await a.connect();
  await b.connect();
  const insert = (c) => c.query(
    `insert into training_load.gpexe_track_choices (owner_team_id, gpexe_team_session_id, gpexe_athlete_id, track_set_fingerprint, choice,
       chosen_by_user_id, chosen_basis, request_key, request_hash) values ($1,'6701','103','9003:1;9004:2','none',$2,'platform_admin',gen_random_uuid(),$3)`,
    [team.teamId, team.padmin.id, "b".repeat(64)]);
  try {
    for (const c of [a, b]) {
      await c.query("begin");
      await c.query(`select set_config('optimove.track_choice_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [team.padmin.id]);
    }
    await insert(a);
    const second = insert(b);
    second.catch(() => {});
    // b's guard has passed and its insert waits on the index entry a holds; only then does a commit.
    for (let i = 0; i < 200; i += 1) {
      const waiting = (await admin.query(`select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)).rows[0].n;
      if (waiting > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await a.query("commit");
    await assert.rejects(second, { code: "23505" });
    await b.query("rollback");
  } finally {
    await a.end();
    await b.end();
  }
  assert.equal((await rowsOf(team.teamId)).length, 1);
});

test("8. L2: a team switched to pilot mode while a team coach's PUT waits for the team lock is the identical 404 (55000 team_import_pilot_mode); nothing written", async () => {
  const team = await setupTeam();
  await enableTeamImportSwitch(admin, team.teamId, null, { mode: "team" });
  const cand = await candidateOf(team, 6801);
  choices.setTrackChoiceTestHooks({ beforeTeamLock: async () => { await enableTeamImportSwitch(admin, team.teamId, null, { mode: "pilot" }); } });
  try {
    const r = await put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: null }, team.coach.cookie);
    assert.equal(r.status, 404, r.text);
  } finally {
    choices.setTrackChoiceTestHooks(null);
  }
  assert.equal((await rowsOf(team.teamId)).length, 0);
});

test("9. L3 and L4: a malformed body outside the audience is the identical 404 (inside it, a 400); the GET names who chose, never the user id", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 6901);
  const outside = await put(team, cand.id, "103", { nonsense: true }, team.coach.cookie);
  const unknown = await getChoices(team, crypto.randomUUID());
  assert.equal(outside.status, 404);
  assert.deepEqual(outside.body, unknown.body);
  assert.equal((await put(team, cand.id, "103", { nonsense: true })).status, 400);
  const c = await choose(team, cand.id, { choice: "none" });
  assert.deepEqual(c.chosenBy, { name: "platform admin" });
  const listed = (await getChoices(team, cand.id)).body.athletes[0].currentChoice;
  assert.deepEqual(listed.chosenBy, { name: "platform admin" });
  assert.equal(JSON.stringify((await getChoices(team, cand.id)).body).includes(team.padmin.id), false, "no user id anywhere");
});

test("10. 6b: a 'none' athlete imported as left out takes an estimate; the next search of the unchanged session changes neither the estimate nor its being the athlete's only value", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 7001);
  await choose(team, cand.id, { choice: "none" });
  await recompute(team, cand.id);
  assert.equal((await approve(team, (await candidates(team)).find((c) => c.id === cand.id))).body.results?.[0]?.outcome, "imported");
  const activityId = (await admin.query(`select activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [cand.id])).rows[0].activity_id;
  const res = await fetch(`${apiBase}/api/training-activity/${activityId}/estimates`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: team.coach.cookie },
    body: JSON.stringify({ requestKey: key(), athleteId: team.athleteIds[2], method: "copy_athlete", sourceAthleteId: team.athleteIds[0] }),
  });
  assert.equal(res.status, 201, await res.text());
  const values = async () => (await admin.query(
    `select o.entry_method, v.value_numeric::text v from training_load.metric_values v
       join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
      where p.athlete_id = $1 and o.superseded_by_occasion_id is null order by 1, 2`, [team.athleteIds[2]])).rows;
  const before = await values();
  assert.ok(before.length > 0 && before.every((r) => r.entry_method === "estimate"), JSON.stringify(before));
  await checkNow(team, [bundleOf({ sessionId: 7001 })]);
  assert.deepEqual(await values(), before);
});
