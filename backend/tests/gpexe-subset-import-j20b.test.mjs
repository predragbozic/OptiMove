// J20-B (contract docs/ai/j20-session-review-contract.md section 5.1): an approval that leaves
// athletes out (excludedAthleteIds, migration v59). On disposable optimove_tests_gpexe_*
// databases only; no GPEXE request, no credential (marker values of the fake source only).
//   1  the subset preview stores nothing: the candidate row is byte for byte what it was
//   2  a subset approval imports exactly the chosen set; the approval records who was left
//      out; no observation for the left-out athlete; the roster reads the athlete as "needs a state"
//   3  validation (format, not in session, already left out, everyone, hash pairing)
//   4  a changed world under the lock: 409 preview_changed with the subset preview in the body, nothing stored
//   5  already_imported on a repeat; the recorded set through getApproval
//   6  determinism: the same set gives the same subset hash, two sets two hashes
//   7  the batch refuses excludedAthleteIds
//   8  the database: raw inserts (migration v59 triggers and CHECKs)
//   9  a lost COMMIT of a subset approval is verified and returns the recorded set; not committed is 503
//  10  the SQL order of the subset preview and that it never commits
//  11  a subset preview against an approval of the same candidate: no deadlock, no 500
//  12  a coach without the approver right cannot ask for a subset preview
//  16  a coach with an approver grant: the subset preview and the refusal body are projected for the coach (no activation, mapping
//      version or fingerprint), and the subset approval passes the v59 trigger on the team_grant basis
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import fs from "node:fs";
import { applyGpexeTestMigrations, createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { PLANTED, previewBundle } from "./support/preview-bundles.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding } from "./support/mapped-world.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const DAY = "2026-09-14";

let db;
let admin;
let server;
let apiBase;
let service;
let connections;
let resolver;
let preview;
let createSession;
let appPool;
let src;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "subset_j20b" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  process.env.SOURCE_CREDENTIAL_KEYS = (await import("../src/sourceCredentialCrypto.js")).generateKeyEntry(1);
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
  preview = await import("../src/gpexeImportPreview.js");
  connections = await import("../src/sourceConnectionService.js");
  resolver = await import("../src/sourceImportCredentialResolver.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  src = createFakeSource();
  connections.setSourceFetchForTests(src.fetchImpl);
  resolver.setImportSourceFetchForTests(src.fetchImpl);
  service.setGpexeClientFactory(() => { throw new Error("TRAP: the legacy client factory was called for a bound team"); });
  service.setRecomputeIntervalForTests(0);
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  service?.setGpexeClientFactory(null);
  service?.setRecomputeIntervalForTests(null);
  service?.setRecomputeCommitForTests(null);
  service?.setRecomputeObserverForTests(null);
  preview?.setImportTransactionBoundsForTests(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_SWITCH === undefined) delete process.env.GPEXE_IMPORT_APPLY_ENABLED; else process.env.GPEXE_IMPORT_APPLY_ENABLED = ORIGINAL_SWITCH;
  if (ORIGINAL_KEYS === undefined) delete process.env.SOURCE_CREDENTIAL_KEYS; else process.env.SOURCE_CREDENTIAL_KEYS = ORIGINAL_KEYS;
});

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text, headers: res.headers };
}
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;

async function user(label, { platform = false, team = null } = {}) {
  const id = (await admin.query(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${crypto.randomBytes(4).toString("hex")}@test.local`, label])).rows[0].id;
  if (platform) await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  if (team) await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, team]);
  await admin.query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [id, platform ? "platform" : "team", platform ? null : team]);
  return { id: String(id), cookie: `optimove_session=${await createSession(id)}` };
}

const athleteId = (n) => `${PLANTED.athletePrefix}${String(n).padStart(2, "0")}`;
let nextSession = 48224900;
const bundleFor = (t) => previewBundle({ gpexeTeamId: Number(t.sourceTeamId), sessionId: (t.sessionId ??= nextSession++) });
let nextSourceTeam = 9701;

// A team bound through the real routes, athletes 1 and 2 linked (3 is NOT:
// its GPEXE row is left out as athlete_not_linked until the coach links it).
async function team() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A01", "A02", "A03", "A04"] });
  const sourceTeamId = String(nextSourceTeam++);
  const padmin = await user("platform admin", { platform: true });
  const coach = await user("coach", { team: org.teamId });
  assert.equal((await api(`/gpexe/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: sourceTeamId } })).status, 200);
  src.show(sourceTeamId);
  const bound = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId });
  await enableTeamImportSwitch(admin, org.teamId);
  await activateBinding(admin, bound.bindingId, { only: null });
  for (const n of [1, 2]) {
    const r = await api(`/gpexe/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId: athleteId(n), athleteId: org.athleteIds[n - 1] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  return { ...org, sourceTeamId, padmin, coach, ...bound };
}
const linkThird = (t) => api(`/gpexe/teams/${t.teamId}/athlete-links`, { method: "POST", cookie: t.coach.cookie, body: { gpexeAthleteId: athleteId(3), athleteId: t.athleteIds[2] } });

async function check(t) {
  src.serve(t.sourceTeamId, [bundleFor(t)]);
  const started = await api(`/gpexe/teams/${t.teamId}/checks`, { method: "POST", cookie: t.coach.cookie, body: { from: DAY, to: DAY } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 400; i += 1) {
    const r = await api(`/gpexe/teams/${t.teamId}/checks/${started.body.check.id}`, { cookie: t.padmin.cookie });
    if (r.body.check?.status !== "running") {
      assert.equal(r.body.check.status, "succeeded", JSON.stringify(r.body.check));
      return r.body.check;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the check did not finish");
}
const candidateRow = async (t) => (await q(`select * from training_load.gpexe_import_candidates where owner_team_id = $1 and status <> 'superseded' order by first_seen_at desc limit 1`, [t.teamId]))[0];
const recompute = (t, candidateId, cookie = t.coach.cookie) => api(`/gpexe/teams/${t.teamId}/candidates/${candidateId}/preview`, { method: "POST", cookie, body: {} });
async function approve(t, candidateId, previewHash, cookie = t.padmin.cookie) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await api(`/gpexe/teams/${t.teamId}/candidates/${candidateId}/approve`, { method: "POST", cookie, body: { previewHash } });
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
}
const importedAthletes = (c) => (c.preview.athletes || []).filter((a) => !a.notImported).map((a) => a.gpexeAthleteId).sort();
const valueCount = async (teamId) => Number((await q(
  `select count(*) from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id
     join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id
    where e.owner_team_id = $1`, [teamId]))[0].count);


const linkAll = async (t) => { assert.equal((await linkThird(t)).status, 201); };
const subsetPreview = (t, candidateId, excludedAthleteIds, cookie = t.padmin.cookie) =>
  api(`/gpexe/teams/${t.teamId}/candidates/${candidateId}/preview`, { method: "POST", cookie, body: { excludedAthleteIds } });
async function approveSubset(t, candidateId, { previewHash, subsetHash, excludedAthleteIds, cookie = t.padmin.cookie, extra = {} }) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await api(`/gpexe/teams/${t.teamId}/candidates/${candidateId}/approve`, { method: "POST", cookie, body: { previewHash, subsetHash, excludedAthleteIds, ...extra } });
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
}
const athletesWithValues = async (teamId) => (await q(
  `select distinct p.athlete_id from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id
     join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id
    where e.owner_team_id = $1`, [teamId])).map((r) => r.athlete_id).sort();
// A team with athletes 1-3 linked and a pending candidate (athlete 4 is left out by the importer: two tracks).
async function readyWorld() {
  const t = await team();
  await check(t);
  await linkAll(t);
  const c = await candidateRow(t);
  const r = await recompute(t, c.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const full = await candidateRow(t);
  assert.deepEqual(importedAthletes(full), [athleteId(1), athleteId(2), athleteId(3)]);
  return { t, c: full };
}

test("1. the subset preview stores nothing: the candidate row is byte for byte what it was; the athlete is left out by the coach, the others stay importable", async () => {
  const { t, c } = await readyWorld();
  const before = (await q(`select * from training_load.gpexe_import_candidates where id = $1`, [c.id]))[0];
  const tables = async () => JSON.stringify((await q(
    `select (select count(*) from training_load.metric_events where owner_team_id = $1) as events,
            (select count(*) from training_load.metric_source_identities si join training_load.metric_source_connections k on k.id = si.source_connection_id where k.owner_team_id = $1) as identities,
            (select count(*) from training.activities where owner_team_id = $1) as activities,
            (select count(*) from training_load.gpexe_import_approvals where owner_team_id = $1) as approvals`, [t.teamId]))[0]);
  const tablesBefore = await tables();
  const r = await subsetPreview(t, c.id, [athleteId(3)]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(r.body.subset.excludedAthleteIds, [athleteId(3)]);
  assert.equal(r.body.subset.previewHash, c.preview_hash, "the candidate's stored full hash is what the approval sends as previewHash");
  assert.match(r.body.subset.subsetHash, /^[0-9a-f]{64}$/);
  assert.notEqual(r.body.subset.subsetHash, c.preview_hash);
  const byId = Object.fromEntries(r.body.subset.preview.athletes.map((a) => [a.gpexeAthleteId, a]));
  assert.equal(byId[athleteId(3)].notImported.code, "left_out_by_coach");
  assert.equal(byId[athleteId(1)].notImported, null);
  assert.equal(byId[athleteId(2)].notImported, null);
  assert.ok(byId[athleteId(3)].results.every((x) => x.outcome === "not_imported"), "nothing of the left-out athlete would be written");
  const after = (await q(`select * from training_load.gpexe_import_candidates where id = $1`, [c.id]))[0];
  assert.deepEqual(after, before, "the candidate row is byte for byte as it was (preview, hash, status, computed-at)");
  assert.equal(await tables(), tablesBefore, "no event, identity, activity or approval survives");
  assert.equal(await valueCount(t.teamId), 0);
});

test("2. a subset approval imports exactly the chosen set; the approval records who was left out; no observation for the left-out athlete; the roster reads them as needing a state", async () => {
  const { t, c } = await readyWorld();
  const s = (await subsetPreview(t, c.id, [athleteId(3)])).body.subset;
  const done = await approveSubset(t, c.id, { previewHash: s.previewHash, subsetHash: s.subsetHash, excludedAthleteIds: [athleteId(3)] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.outcome, "imported");
  assert.deepEqual(done.body.approval.excludedAthleteIds, [athleteId(3)]);
  assert.equal(done.body.approval.subsetHash, s.subsetHash);
  assert.deepEqual(await athletesWithValues(t.teamId), [t.athleteIds[0], t.athleteIds[1]].sort(), "values exist for athletes 1 and 2 only");
  const row = (await q(`select excluded_athlete_ids, subset_hash, preview_hash from training_load.gpexe_import_approvals where candidate_id = $1`, [c.id]))[0];
  assert.deepEqual(row.excluded_athlete_ids, [athleteId(3)]);
  assert.equal(row.subset_hash, s.subsetHash);
  assert.equal(row.preview_hash, c.preview_hash, "the approval keeps the candidate's hash");
  assert.equal((await candidateRow(t)).status, "imported");
  const obs = await q(`select count(*)::int as n from training.activity_source_observations o join training.activities a on a.id = o.activity_id where a.owner_team_id = $1 and o.athlete_id = $2`, [t.teamId, t.athleteIds[2]]);
  assert.equal(obs[0].n, 0, "a left-out athlete gets no 'No usable device record' observation");
  // The roster: members of the team from before the session day.
  await admin.query("set session_replication_role = replica");
  await admin.query(`update public.athlete_membership_periods set valid_from = '2026-01-01' where athlete_id = any($1::uuid[])`, [t.athleteIds]);
  await admin.query("set session_replication_role = origin");
  const activityId = done.body.import.activityId;
  const roster = await api(`/../training-activity/${activityId}/roster`, { cookie: t.padmin.cookie });
  assert.equal(roster.status, 200, JSON.stringify(roster.body).slice(0, 300));
  const state = Object.fromEntries(roster.body.athletes.map((a) => [a.athleteId, a.state]));
  assert.equal(state[t.athleteIds[0]], "measured");
  assert.equal(state[t.athleteIds[1]], "measured");
  assert.equal(state[t.athleteIds[2]], "unknown", "the left-out athlete is 'needs a state', like an athlete without a record");
});

test("3. validation: format, not in the session, already left out, everybody, the hash pairing", async () => {
  const { t, c } = await readyWorld();
  const bad = async (excludedAthleteIds, extra = {}, expect = [400, "invalid_excluded_athlete"]) => {
    const r = await approveSubset(t, c.id, { previewHash: c.preview_hash, subsetHash: "a".repeat(64), excludedAthleteIds, extra });
    assert.deepEqual([r.status, r.body.error], expect, JSON.stringify([excludedAthleteIds, r.body]));
  };
  await bad("7");
  await bad([7]);
  await bad(["007"]);
  await bad(["12345678901234"]);
  await bad(Array.from({ length: 61 }, (_, i) => String(1000 + i)));
  await bad(["999"], {}, [400, "invalid_excluded_athlete"]);
  await bad([athleteId(4)], {}, [400, "invalid_exclusion"]);
  await bad([athleteId(1), athleteId(2), athleteId(3)], {}, [409, "no_importable_athlete"]);
  const noHash = await approveSubset(t, c.id, { previewHash: c.preview_hash, excludedAthleteIds: [athleteId(3)] });
  assert.deepEqual([noHash.status, noHash.body.error], [400, "invalid_subset_hash"]);
  const hashAlone = await approveSubset(t, c.id, { previewHash: c.preview_hash, subsetHash: "a".repeat(64) });
  assert.deepEqual([hashAlone.status, hashAlone.body.error], [400, "subset_hash_without_exclusion"]);
  // The same on the subset preview route.
  assert.equal((await subsetPreview(t, c.id, ["999"])).body.error, "invalid_excluded_athlete");
  assert.equal((await subsetPreview(t, c.id, [athleteId(4)])).body.error, "invalid_exclusion");
  assert.equal((await subsetPreview(t, c.id, [athleteId(1), athleteId(2), athleteId(3)])).body.error, "no_importable_athlete");
  assert.equal((await subsetPreview(t, c.id, [])).body.error, "invalid_excluded_athlete");
  assert.equal(await valueCount(t.teamId), 0, "nothing was written by any refusal");
  assert.equal((await candidateRow(t)).status, "pending");
});

test("4. a world that changed under the lock: 409 preview_changed with the recomputed subset preview in the body; the stored candidate is untouched", async () => {
  const { t, c } = await readyWorld();
  const s = (await subsetPreview(t, c.id, [athleteId(3)])).body.subset;
  // Athlete 2 is unlinked after the review: the subset preview differs, the stored (full) one is not recomputed by a link.
  const link = (await q(`select id from training_load.gpexe_athlete_links where owner_team_id = $1 and gpexe_athlete_id = $2 and unlinked_at is null`, [t.teamId, athleteId(2)]))[0];
  const un = await api(`/gpexe/teams/${t.teamId}/athlete-links/${link.id}/unlink`, { method: "POST", cookie: t.coach.cookie, body: {} });
  assert.ok([200, 204].includes(un.status), JSON.stringify(un.body));
  const stored = (await q(`select * from training_load.gpexe_import_candidates where id = $1`, [c.id]))[0];
  const r = await approveSubset(t, c.id, { previewHash: c.preview_hash, subsetHash: s.subsetHash, excludedAthleteIds: [athleteId(3)] });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, "preview_changed");
  assert.ok(r.body.subset?.preview, "the recomputed subset preview is in the body");
  assert.notEqual(r.body.subset.subsetHash, s.subsetHash);
  assert.deepEqual(r.body.subset.excludedAthleteIds, [athleteId(3)]);
  assert.deepEqual((await q(`select * from training_load.gpexe_import_candidates where id = $1`, [c.id]))[0], stored,
    "a refused subset approval leaves the stored preview and hash byte for byte as they were (storeRefreshedPreview is not called)");
  assert.equal(await valueCount(t.teamId), 0);
  // An id that cannot be left out any more (athlete 2 is now not linked -> already left out) is a changed preview, not a 400.
  const gone = await approveSubset(t, c.id, { previewHash: c.preview_hash, subsetHash: s.subsetHash, excludedAthleteIds: [athleteId(2)] });
  assert.deepEqual([gone.status, gone.body.error], [409, "preview_changed"], "re-validated against the athletes recomputed under the lock");
  assert.deepEqual(gone.body.subset.excludedAthleteIds, [athleteId(2)]);
});

test("5. a repeat of a subset approval is already_imported; the recorded set is read through getApproval", async () => {
  const { t, c } = await readyWorld();
  const s = (await subsetPreview(t, c.id, [athleteId(2), athleteId(3)])).body.subset;
  const first = await approveSubset(t, c.id, { previewHash: s.previewHash, subsetHash: s.subsetHash, excludedAthleteIds: [athleteId(2), athleteId(3)] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await approveSubset(t, c.id, { previewHash: s.previewHash, subsetHash: s.subsetHash, excludedAthleteIds: [athleteId(2), athleteId(3)] });
  assert.deepEqual([again.status, again.body.error], [409, "already_imported"]);
  const other = await approveSubset(t, c.id, { previewHash: s.previewHash, subsetHash: "b".repeat(64), excludedAthleteIds: [athleteId(3)] });
  assert.deepEqual([other.status, other.body.error], [409, "already_imported"], "a retry with another set is indistinguishable from a replay");
  const got = await api(`/gpexe/teams/${t.teamId}/approvals/${first.body.approval.id}`, { cookie: t.padmin.cookie });
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.deepEqual(got.body.approval.excludedAthleteIds, [athleteId(2), athleteId(3)]);
  assert.equal(got.body.approval.subsetHash, s.subsetHash);
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_approvals where candidate_id = $1`, [c.id]))[0].n, 1);
  assert.deepEqual(await athletesWithValues(t.teamId), [t.athleteIds[0]]);
});

test("6. determinism: the same set gives the same subset hash on every call (in any order and with duplicates); different sets give different hashes and each approval imports exactly its set", async () => {
  const w1 = await readyWorld();
  const a = (await subsetPreview(w1.t, w1.c.id, [athleteId(3)])).body.subset;
  const b = (await subsetPreview(w1.t, w1.c.id, [athleteId(3), athleteId(3)])).body.subset;
  assert.equal(a.subsetHash, b.subsetHash);
  const c2 = (await subsetPreview(w1.t, w1.c.id, [athleteId(3), athleteId(2)])).body.subset;
  const d2 = (await subsetPreview(w1.t, w1.c.id, [athleteId(2), athleteId(3)])).body.subset;
  assert.equal(c2.subsetHash, d2.subsetHash);
  assert.deepEqual(c2.excludedAthleteIds, [athleteId(2), athleteId(3)], "sorted numerically");
  const e = (await subsetPreview(w1.t, w1.c.id, [athleteId(2)])).body.subset;
  assert.equal(new Set([a.subsetHash, c2.subsetHash, e.subsetHash, w1.c.preview_hash]).size, 4, "four different sets, four different hashes");
  const done = await approveSubset(w1.t, w1.c.id, { previewHash: e.previewHash, subsetHash: e.subsetHash, excludedAthleteIds: [athleteId(2)] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(await athletesWithValues(w1.t.teamId), [w1.t.athleteIds[0], w1.t.athleteIds[2]].sort());
  const w2 = await readyWorld();
  const f = (await subsetPreview(w2.t, w2.c.id, [athleteId(3)])).body.subset;
  const done2 = await approveSubset(w2.t, w2.c.id, { previewHash: f.previewHash, subsetHash: f.subsetHash, excludedAthleteIds: [athleteId(3)] });
  assert.equal(done2.status, 200, JSON.stringify(done2.body));
  assert.deepEqual(await athletesWithValues(w2.t.teamId), [w2.t.athleteIds[0], w2.t.athleteIds[1]].sort());
});

test("7. the batch refuses excludedAthleteIds: it can never import a subset behind a hash that does not cover it", async () => {
  const { t, c } = await readyWorld();
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    const r = await api(`/gpexe/teams/${t.teamId}/imports`, { method: "POST", cookie: t.padmin.cookie,
      body: { candidateIds: [c.id], previewHashes: { [c.id]: c.preview_hash }, excludedAthleteIds: [athleteId(3)] } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
  assert.equal(await valueCount(t.teamId), 0);
});

test("8. the database (v59): well-formed sets pass, malformed ones and a hash without a set (or a set without a hash) are refused; the documented limit of a wrong but well-formed hash", async () => {
  const { t, c } = await readyWorld();
  const tryInsert = async (excluded, subsetHash) => {
    const c2 = new pg.Client({ connectionString: db.url });
    await c2.connect();
    try {
      await c2.query("begin");
      const cand = (await c2.query(`select * from training_load.gpexe_import_candidates where id = $1`, [c.id])).rows[0];
      await c2.query(
        `insert into training_load.gpexe_import_approvals (candidate_id, owner_team_id, gpexe_team_session_id, bundle_hash, preview_hash, approved_by_user_id, approval_basis,
            changes_to_imported, changes_accepted, metric_event_id, import_counts, excluded_athlete_ids, subset_hash)
         values ($1,$2,$3,$4,$5,$6,'platform_admin',$7,$8,gen_random_uuid(),'{}'::jsonb,$9,$10)`,
        [c.id, t.teamId, cand.gpexe_team_session_id, cand.bundle_hash, cand.preview_hash, t.padmin.id,
          cand.preview?.changesToImported?.length ?? 0, (cand.preview?.changesToImported?.length ?? 0) > 0, excluded, subsetHash]);
      return "ok";
    } catch (error) {
      return error.code;
    } finally {
      await c2.query("rollback").catch(() => {});
      await c2.end();
    }
  };
  const H = "c".repeat(64);
  assert.equal(await tryInsert([], null), "ok", "no exclusion, no hash: the old shape");
  assert.equal(await tryInsert([athleteId(3)], H), "ok", "a well-formed set with a well-formed hash (the documented limit: the trigger cannot recompute the hash)");
  assert.equal(await tryInsert([athleteId(2), athleteId(3)], H), "ok");
  assert.equal(await tryInsert([athleteId(3)], null), "23514", "a set without a subset hash");
  assert.equal(await tryInsert([], H), "23514", "a subset hash without a set");
  assert.equal(await tryInsert([athleteId(3)], "xyz"), "23514", "a malformed hash");
  assert.equal(await tryInsert([athleteId(3), athleteId(2)], H), "23514", "unsorted");
  assert.equal(await tryInsert([athleteId(3), athleteId(3)], H), "23514", "duplicates");
  assert.equal(await tryInsert(["007"], H), "23514", "not canonical");
  assert.equal(await tryInsert(["12", null], H), "23514", "a NULL element");
  assert.equal(await tryInsert(Array.from({ length: 61 }, (_, i) => String(1000 + i)), H), "23514", "more than 60");
  assert.equal(await tryInsert(["9", "10"], H), "ok", "numeric sort: 9 before 10");
  assert.equal(await tryInsert(["10", "9"], H), "23514");
  // Append-only: the new columns are write-once like the rest.
  const done = await approveSubset(t, c.id, { previewHash: c.preview_hash, subsetHash: (await subsetPreview(t, c.id, [athleteId(3)])).body.subset.subsetHash, excludedAthleteIds: [athleteId(3)] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  await assert.rejects(admin.query(`update training_load.gpexe_import_approvals set excluded_athlete_ids = '{}', subset_hash = null where candidate_id = $1`, [c.id]), /append-only/);
  // Rows from before v59 read as "nobody left out".
  const old = await q(`select column_default, is_nullable from information_schema.columns where table_schema='training_load' and table_name='gpexe_import_approvals' and column_name='excluded_athlete_ids'`);
  assert.equal(old[0].is_nullable, "NO");
  assert.match(old[0].column_default, /\{\}/);
});

test("9. a lost COMMIT of a subset approval is never 'nothing was imported': committed -> 200 verified_after_commit_error with the recorded set; not committed -> 503", async () => {
  const { t, c } = await readyWorld();
  const s = (await subsetPreview(t, c.id, [athleteId(3)])).body.subset;
  service.setApprovalCommitForTests(async (client) => { await client.query("commit"); throw new Error("answer lost"); }, { timeoutMs: 2000 });
  let landed;
  try {
    landed = await approveSubset(t, c.id, { previewHash: s.previewHash, subsetHash: s.subsetHash, excludedAthleteIds: [athleteId(3)] });
  } finally {
    service.setApprovalCommitForTests(null);
  }
  assert.equal(landed.status, 200, JSON.stringify(landed.body));
  assert.equal(landed.body.commitConfirmation, "verified_after_commit_error");
  assert.deepEqual(landed.body.approval.excludedAthleteIds, [athleteId(3)], "the recorded set comes back with the proof");
  assert.equal(landed.body.approval.subsetHash, s.subsetHash);
  const w = await readyWorld();
  const s2 = (await subsetPreview(w.t, w.c.id, [athleteId(3)])).body.subset;
  service.setApprovalCommitForTests(async () => { throw new Error("connection lost before the COMMIT"); }, { timeoutMs: 2000 });
  let lost;
  try {
    lost = await approveSubset(w.t, w.c.id, { previewHash: s2.previewHash, subsetHash: s2.subsetHash, excludedAthleteIds: [athleteId(3)] });
  } finally {
    service.setApprovalCommitForTests(null);
  }
  assert.equal(lost.status, 503, JSON.stringify(lost.body));
  assert.equal(lost.body.error, "import_outcome_unknown");
  assert.equal((await candidateRow(w.t)).status, "pending");
  assert.equal(await valueCount(w.t.teamId), 0);
});

test("10. the SQL order of the subset preview: candidate FOR UPDATE, then the team lock, then the import; it never commits and never updates the candidate", async () => {
  const { t, c } = await readyWorld();
  const seen = [];
  const realConnect = appPool.connect.bind(appPool);
  const wrap = (client) => {
    const realQuery = client.query.bind(client);
    const log = [];
    client.query = (text, ...rest) => {
      const sql = typeof text === "string" ? text : text?.text ?? "";
      log.push(sql.replace(/\s+/g, " ").trim().toLowerCase());
      return realQuery(text, ...rest);
    };
    seen.push(log);
    return client;
  };
  appPool.connect = (...args) => (typeof args[args.length - 1] === "function" ? realConnect(...args) : realConnect(...args).then(wrap));
  let r;
  try {
    r = await subsetPreview(t, c.id, [athleteId(3)]);
  } finally {
    appPool.connect = realConnect;
  }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const log = seen.find((l) => l.some((s) => s.includes("for update") && s.includes("gpexe_import_candidates")) && l.some((s) => s.includes("pg_advisory_xact_lock")));
  assert.ok(log, "the connection was found");
  const at = (pred) => log.findIndex(pred);
  const begin = at((s) => s.startsWith("begin"));
  const forUpdate = at((s) => s.includes("for update") && s.includes("gpexe_import_candidates"));
  const teamLock = at((s) => s.includes("pg_advisory_xact_lock"));
  assert.ok(begin >= 0 && forUpdate > begin && teamLock > forUpdate, "candidate row before the team lock (the approval's order)");
  assert.ok(!log.some((s) => s === "commit"), "never commits");
  assert.ok(!log.some((s) => s.startsWith("update training_load.gpexe_import_candidates")), "never updates the candidate");
  assert.ok(!log.some((s) => s.includes("lock_gpexe_import_approver")), "the approver-rights lock (6b) is not taken: it is a read");
  // (The same pooled connection then serves the projection read, so the log goes on after the transaction ended.)
  assert.ok(at((s) => s === "rollback") > teamLock, "the transaction ends with a rollback after the import");
});

test("11. a subset preview and an approval of the same candidate: no deadlock, no 500", async () => {
  const { t, c } = await readyWorld();
  const s = (await subsetPreview(t, c.id, [athleteId(3)])).body.subset;
  const [p, a] = await Promise.all([
    subsetPreview(t, c.id, [athleteId(2)]),
    approveSubset(t, c.id, { previewHash: s.previewHash, subsetHash: s.subsetHash, excludedAthleteIds: [athleteId(3)] }),
  ]);
  for (const r of [p, a]) assert.ok(r.status < 500, `no 500: ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok([200, 409].includes(p.status));
  assert.equal(a.status, 200, JSON.stringify(a.body));
});

test("12. a coach without the approver right cannot ask for a subset preview; the identical 404 for another team's candidate and a user of no team", async () => {
  const { t, c } = await readyWorld();
  const r = await subsetPreview(t, c.id, [athleteId(3)], t.coach.cookie);
  assert.deepEqual([r.status, r.body.error], [403, "not_an_approver"]);
  const stranger = await user("stranger");
  assert.equal((await subsetPreview(t, c.id, [athleteId(3)], stranger.cookie)).status, 404);
  assert.equal((await subsetPreview(t, "00000000-0000-0000-0000-000000000000", [athleteId(3)])).status, 404);
  assert.equal((await q(`select preview_hash from training_load.gpexe_import_candidates where id = $1`, [c.id]))[0].preview_hash, c.preview_hash);
});

test("16. a coach with an approver grant: the subset preview and a refused subset approval are projected for the coach; the subset approval passes the trigger on the team_grant basis", async () => {
  const { t, c } = await readyWorld();
  const grant = await api(`/gpexe/teams/${t.teamId}/approvers`, { method: "POST", cookie: t.padmin.cookie, body: { userId: t.coach.id, reason: "j20b test" } });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  const ADMIN_FIELDS = /mappingVersionId|activationId|sourceParameterFingerprint/;
  const asAdmin = await subsetPreview(t, c.id, [athleteId(3)]);
  assert.match(JSON.stringify(asAdmin.body.subset.preview), ADMIN_FIELDS, "the platform admin's projection keeps the administrator fields (so the test below proves a projection)");
  const asCoach = await subsetPreview(t, c.id, [athleteId(3)], t.coach.cookie);
  assert.equal(asCoach.status, 200, JSON.stringify(asCoach.body));
  assert.doesNotMatch(JSON.stringify(asCoach.body), ADMIN_FIELDS, "no activation, mapping version or fingerprint reaches the coach");
  assert.equal(asCoach.body.subset.subsetHash, asAdmin.body.subset.subsetHash, "the hash is the same for every audience (it covers the unprojected preview)");
  assert.equal(asCoach.body.subset.preview.athletes.find((a) => a.gpexeAthleteId === athleteId(3)).notImported.code, "left_out_by_coach");
  // A refused subset approval: the recomputed subset preview is in the body, projected for the coach.
  const link = (await q(`select id from training_load.gpexe_athlete_links where owner_team_id = $1 and gpexe_athlete_id = $2 and unlinked_at is null`, [t.teamId, athleteId(2)]))[0];
  assert.equal((await api(`/gpexe/teams/${t.teamId}/athlete-links/${link.id}/unlink`, { method: "POST", cookie: t.coach.cookie, body: {} })).status, 200);
  const refused = await approveSubset(t, c.id, { previewHash: c.preview_hash, subsetHash: asCoach.body.subset.subsetHash, excludedAthleteIds: [athleteId(3)], cookie: t.coach.cookie });
  assert.deepEqual([refused.status, refused.body.error], [409, "preview_changed"], JSON.stringify(refused.body).slice(0, 300));
  assert.ok(refused.body.subset?.preview);
  assert.doesNotMatch(JSON.stringify(refused.body), ADMIN_FIELDS);
  // Relink and import as the coach (team_grant basis).
  assert.equal((await linkThird(t).catch(() => ({ status: 0 }))).status === 201 || true, true);
  await api(`/gpexe/teams/${t.teamId}/athlete-links`, { method: "POST", cookie: t.coach.cookie, body: { gpexeAthleteId: athleteId(2), athleteId: t.athleteIds[1] } });
  const again = await subsetPreview(t, c.id, [athleteId(3)], t.coach.cookie);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const done = await approveSubset(t, c.id, { previewHash: c.preview_hash, subsetHash: again.body.subset.subsetHash, excludedAthleteIds: [athleteId(3)], cookie: t.coach.cookie });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.approval.basis, "team_grant");
  assert.deepEqual(done.body.approval.excludedAthleteIds, [athleteId(3)]);
  assert.doesNotMatch(JSON.stringify(done.body.candidate?.preview ?? {}), ADMIN_FIELDS);
});


test("17. an athlete whose results were imported before cannot be left out (a clear 400, never a loop of preview_changed); a subset that would write nothing is nothing_to_import", async () => {
  const { t, c } = await readyWorld();
  // The stored preview says athlete 3's result was imported before (unchanged): leaving it out would leave it behind.
  const preview = JSON.parse(JSON.stringify(c.preview));
  preview.athletes.find((a) => a.gpexeAthleteId === athleteId(3)).results.forEach((r) => { r.outcome = "unchanged"; });
  await q(`update training_load.gpexe_import_candidates set preview = $2 where id = $1`, [c.id, preview]);
  const r = await subsetPreview(t, c.id, [athleteId(3)]);
  assert.deepEqual([r.status, r.body.error], [400, "invalid_exclusion"], JSON.stringify(r.body));
  const a = await approveSubset(t, c.id, { previewHash: c.preview_hash, subsetHash: "a".repeat(64), excludedAthleteIds: [athleteId(3)] });
  assert.deepEqual([a.status, a.body.error], [400, "invalid_exclusion"]);
  // Restore; leaving out the others is still allowed.
  await q(`update training_load.gpexe_import_candidates set preview = $2 where id = $1`, [c.id, c.preview]);
  assert.equal((await subsetPreview(t, c.id, [athleteId(3)])).status, 200);
});

test("18. a subset approval whose binding ended never stores a refreshed preview (the stored candidate stays byte for byte); the whole-session approval does store it", async () => {
  const { t, c } = await readyWorld();
  const s = (await subsetPreview(t, c.id, [athleteId(3)])).body.subset;
  const un = await api(`/sources/gpexe/connections/${t.connectionId}/bindings/${t.bindingId}/unbind`, { method: "POST", cookie: t.padmin.cookie,
    body: { requestKey: crypto.randomUUID(), reason: "j20b test: binding ended", expected: { teamId: t.teamId, sourceTeamId: t.sourceTeamId } } });
  assert.equal(un.status, 200, JSON.stringify(un.body));
  const before = (await q(`select * from training_load.gpexe_import_candidates where id = $1`, [c.id]))[0];
  const blockedReview = await subsetPreview(t, c.id, [athleteId(3)]);
  assert.deepEqual([blockedReview.status, blockedReview.body.error], [409, "subset_blocked"], `a review that would be blocked gets its own code: ${JSON.stringify(blockedReview.body).slice(0, 200)}`);
  const r = await approveSubset(t, c.id, { previewHash: s.previewHash, subsetHash: s.subsetHash, excludedAthleteIds: [athleteId(3)] });
  assert.deepEqual([r.status, r.body.error], [409, "preview_changed"], JSON.stringify(r.body).slice(0, 300));
  assert.deepEqual((await q(`select * from training_load.gpexe_import_candidates where id = $1`, [c.id]))[0], before, "nothing of the candidate changed");
  const full = await approve(t, c.id, c.preview_hash);
  assert.deepEqual([full.status, full.body.error], [409, "preview_changed"]);
  assert.notEqual((await candidateRow(t)).preview_hash, before.preview_hash, "the whole-session refusal stores the recomputed (blocked) preview, as before");
});

test("19. static: the router sends no unprojected subset preview to the client (previewOverride only inside getCandidate calls; subset.preview / subsetPreview never inside a res.json)", () => {
  const route = fs.readFileSync(new URL("../src/routes/gpexeImport.js", import.meta.url), "utf8");
  const overrides = [...route.matchAll(/previewOverride\s*:/g)];
  assert.ok(overrides.length >= 2);
  for (const m of overrides) {
    const head = route.slice(Math.max(0, m.index - 400), m.index);
    assert.match(head, /service\.getCandidate\(/, "previewOverride is only an argument of service.getCandidate");
  }
  const jsonCalls = [...route.matchAll(/\.json\(\{[^]*?\}\);/g)].map((m) => m[0]);
  for (const call of jsonCalls) {
    assert.doesNotMatch(call, /\bsubset\.preview\b|\bsubsetPreview\b(?!\s*&&)/, `an unprojected subset preview in a response: ${call.slice(0, 120)}`);
  }
});

// ---------------------------------------------------------------------------
// Migration v59: preflight, post-check, rollback rehearsal, the md5 gate
// ---------------------------------------------------------------------------
const RUNBOOK = (name) => new URL(`../../docs/runbooks/${name}`, import.meta.url);
const V59 = "migrations_v2/202611091100_training_load_v59_import_approval_subset.sql";
const WITHOUT_V59 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes("v59")));
async function booleansOf(client, sql) {
  const out = [];
  for (const res of [].concat(await client.query(sql))) for (const row of res.rows) for (const [k, v] of Object.entries(row)) if (typeof v === "boolean") out.push([k, v]);
  return out;
}
async function catalogOf(client) {
  const q1 = async (text) => (await client.query(text)).rows.map((r) => r.d);
  return {
    columns: await q1(`select column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') as d from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_import_approvals' order by ordinal_position`),
    constraints: await q1(`select conname || ' :: ' || pg_get_constraintdef(oid) as d from pg_constraint where conrelid = 'training_load.gpexe_import_approvals'::regclass order by 1`),
    triggers: await q1(`select t.tgname || ' :: ' || pg_get_triggerdef(t.oid) as d from pg_trigger t where t.tgrelid = 'training_load.gpexe_import_approvals'::regclass and not t.tgisinternal order by 1`),
    functions: await q1(`select n.nspname || '.' || p.proname || ' ' || md5(p.prosrc) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('training_load', 'training') order by 1`),
  };
}

test("13. migration v59: the preflight passes on v57+, the post-check on v59, the rollback restores the earlier catalog exactly and the migration applies again to the same result", async () => {
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "subsetrb", migrations: WITHOUT_V59 });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    const pre = await booleansOf(client, fs.readFileSync(RUNBOOK("import-approval-subset-v59-preflight.sql"), "utf8"));
    assert.ok(pre.length >= 12, `the preflight returned its booleans (${pre.length})`);
    assert.deepEqual(pre.filter(([, v]) => v !== true), [], "every preflight block is ok before v59");
    const before = await catalogOf(client);
    await applyGpexeTestMigrations(rb.url, GPEXE_TEST_MIGRATIONS);
    const post = await booleansOf(client, fs.readFileSync(RUNBOOK("import-approval-subset-v59-postcheck.sql"), "utf8"));
    assert.ok(post.length >= 8, `the post-check returned its booleans (${post.length})`);
    assert.deepEqual(post.filter(([, v]) => v !== true), [], "every post-check block is ok on a v59 database");
    const md5 = (await client.query(`select md5(prosrc) m from pg_proc where proname = 'validate_gpexe_import_approval'`)).rows[0].m;
    assert.match(fs.readFileSync(RUNBOOK("import-approval-subset-v59-postcheck.sql"), "utf8"), new RegExp(md5), "the post-check names the body in force");
    assert.match(fs.readFileSync(RUNBOOK("import-approval-subset-v59-rollback.sql"), "utf8"), new RegExp(md5), "the rollback names the body in force");
    const after = await catalogOf(client);
    assert.notDeepEqual(after, before);
    await client.query(fs.readFileSync(RUNBOOK("import-approval-subset-v59-rollback.sql"), "utf8"));
    assert.deepEqual(await catalogOf(client), before, "the rollback restores the earlier catalog exactly");
    assert.equal((await client.query(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [V59])).rows[0].n, 0);
    await applyGpexeTestMigrations(rb.url, GPEXE_TEST_MIGRATIONS);
    assert.deepEqual(await catalogOf(client), after, "re-applied: the same catalog");
  } finally {
    await client.end();
    await rb.drop();
  }
});

test("14. the rollback refuses, changing nothing, once a subset approval exists, under a later migration, or when the body was replaced", async () => {
  const { t, c } = await readyWorld();
  const s = (await subsetPreview(t, c.id, [athleteId(3)])).body.subset;
  const done = await approveSubset(t, c.id, { previewHash: s.previewHash, subsetHash: s.subsetHash, excludedAthleteIds: [athleteId(3)] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const rollback = fs.readFileSync(RUNBOOK("import-approval-subset-v59-rollback.sql"), "utf8");
  const before = await catalogOf(admin);
  const c2 = new pg.Client({ connectionString: db.url });
  await c2.connect();
  try {
    await assert.rejects(c2.query(rollback), /v59 rollback refused: a subset approval exists/);
    await c2.query("rollback").catch(() => {});
    await c2.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) select 'migrations_v2/202611091200_later.sql', checksum, runner_version from public.schema_migrations limit 1`);
    await assert.rejects(c2.query(rollback), /later migrations are applied/);
    await c2.query("rollback").catch(() => {});
    await c2.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/202611091200_later.sql'`);
    await c2.query("begin");
    await c2.query(`create or replace function training_load.validate_gpexe_import_approval() returns trigger as 'begin return new; end' language plpgsql`);
    await assert.rejects(c2.query(rollback), /is not v59's/);
    await c2.query("rollback");
  } finally {
    await c2.end();
  }
  assert.deepEqual(await catalogOf(admin), before, "nothing changed");
  assert.equal((await q(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [V59]))[0].n, 1);
});

test("15. the md5 gate: the migration refuses to run when the trigger function in force is not v33's", async () => {
  const rb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "subsetgate", migrations: WITHOUT_V59 });
  const client = new pg.Client({ connectionString: rb.url });
  await client.connect();
  try {
    await client.query(`create or replace function training_load.validate_gpexe_import_approval() returns trigger as 'begin return new; end' language plpgsql`);
    await assert.rejects(applyGpexeTestMigrations(rb.url, GPEXE_TEST_MIGRATIONS), /ABORT while applying .*v59_import_approval_subset.*SQLSTATE 23514/);
    assert.equal((await client.query(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [V59])).rows[0].n, 0);
    assert.equal((await client.query(`select count(*)::int n from information_schema.columns where table_name = 'gpexe_import_approvals' and column_name = 'excluded_athlete_ids'`)).rows[0].n, 0, "nothing of v59 was applied");
  } finally {
    await client.end();
    await rb.drop();
  }
});
