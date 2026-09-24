// In-app GPEXE import, phases F1 and F2, through the real server on a disposable
// database: "Check now", candidates, previews, athlete links, approver
// grants, retention, approval and import. GPEXE itself is a fake client;
// nothing touches a persistent database. Results and activities are written
// only by the F2 approval tests, only on the disposable database, with the
// import switch turned on inside this process for those tests alone.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { importGpexePlan } from "../src/gpexeImportWriter.js";
import { GpexeClientError } from "../src/gpexeClient.js";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;

let db;
let admin;
let server;
let apiBase;
let service;
let createSession;
let appPool;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "inapp" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  service?.setGpexeClientFactory(null);
  // A request left hanging by a failed test must not keep the suite open.
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
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function cookieFor(userId) {
  return `optimove_session=${await createSession(userId)}`;
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
  return { id, cookie: await cookieFor(id) };
}

async function platformAdmin() {
  const id = await makeUser("platform admin");
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return { id, cookie: await cookieFor(id) };
}

// Athletes: 101 and 102 measured; 103 on two tracks (manual review); 104
// measured but not linked; 105 with statistics GPEXE marks invalid.
function sessionAthletes({ distance101 = 3000 } = {}) {
  const [a101, a102, a103] = standardAthletes();
  a101.parts[0].distance = distance101;
  const a104 = { ...structuredClone(a102), id: 104, tracks: [9005] };
  const a105 = { ...structuredClone(a102), id: 105, tracks: [9006] };
  return [a101, a102, a103, a104, a105];
}

function sessionBundle({ sessionId = 7001, gpexeTeamId = 77, category, updatedOn, distance101, detailsDrills } = {}) {
  const bundle = makeBundle({ sessionId, gpexeTeamId, category, updatedOn, ...(detailsDrills ? { detailsDrills } : {}), athletes: sessionAthletes({ distance101 }) });
  for (const row of bundle.athleteSessions) if (row.athlete === 105) row.is_stats_valid = false;
  return bundle;
}

// A fake GPEXE: sessions and bundles by id, or a thrown client error.
function fakeGpexe({ bundles = [], error = null, gate = null, fetchGate = null, onFetch = null } = {}) {
  return () => ({
    async listTeamSessions() {
      if (gate) await gate;
      if (error) throw error;
      return bundles.map((b) => ({ id: String(b.teamSession.id) }));
    },
    async fetchSessionBundle({ sessionId }) {
      if (onFetch) onFetch();
      if (fetchGate) await fetchGate;
      return structuredClone(bundles.find((b) => String(b.teamSession.id) === sessionId));
    },
  });
}

// Team with six athletes; links for 101, 102, 103, 105 (104 stays unlinked).
// Each team reads its own GPEXE team (one GPEXE team feeds one OptiMove team);
// the fake GPEXE ignores the number.
let nextGpexeTeamId = 1000;
async function setupTeam({ gpexeTeamId = String(nextGpexeTeamId++) } = {}) {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A101", "B102", "C103", "D", "E", "F105"] });
  const [a, b, c, d, e, f] = org.athleteIds;
  const coach = await coachOf(org.teamId);
  const padmin = await platformAdmin();
  assert.equal((await api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId } })).status, 200);
  for (const [gpexeAthleteId, athleteId] of [["101", a], ["102", b], ["103", c], ["105", f]]) {
    assert.equal((await api(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId, athleteId } })).status, 201);
  }
  return { ...org, ids: { a, b, c, d, e, f }, coach, padmin };
}

async function waitForCheck(teamId, checkId, cookie) {
  for (let i = 0; i < 200; i += 1) {
    const r = await api(`/teams/${teamId}/checks/${checkId}`, { cookie });
    if (r.body.check?.status !== "running") return r.body.check;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("check did not finish");
}

async function checkNow(team, cookie = team.coach.cookie, body = {}) {
  const started = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie, body });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return waitForCheck(team.teamId, started.body.check.id, cookie);
}

async function writtenRows(teamId) {
  return (await admin.query(
    `select (select count(*)::int from training_load.metric_events where owner_team_id = $1) as events,
            (select count(*)::int from training.activities where owner_team_id = $1) as activities,
            (select count(*)::int from training_load.metric_source_connections where owner_team_id = $1) as connections,
            (select count(*)::int from training_load.metric_definitions where owner_team_id = $1) as definitions,
            (select count(*)::int from training_load.metric_import_batches where owner_team_id = $1) as batches,
            (select count(*)::int from training_load.metric_values) as all_values`,
    [teamId],
  )).rows[0];
}

const NOTHING_WRITTEN = { events: 0, activities: 0, connections: 0, definitions: 0, batches: 0 };

test("check: candidates and a preview are saved while the import switch is off, and no result or activity is written", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle()] }));
  const valuesBefore = (await writtenRows(team.teamId)).all_values;

  const check = await checkNow(team);
  assert.equal(check.status, "succeeded", JSON.stringify(check.error));
  assert.deepEqual([check.sessionsSeen, check.candidatesNew, check.candidatesChanged, check.candidatesUnchanged], [1, 1, 0, 0]);

  const list = await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie });
  assert.equal(list.body.importSwitch.enabled, false);
  assert.match(list.body.importSwitch.message, /checks and previews are saved, but no result or activity can be written/);
  assert.equal(list.body.candidates.length, 1);
  const summary = list.body.candidates[0];
  assert.equal(summary.status, "pending");
  assert.equal(summary.previewStatus, "ready");
  assert.ok(!summary.approvalBlockers.includes("approval_not_available_yet"), "F2: approval exists");
  assert.ok(summary.approvalBlockers.includes("import_switch_off"));
  // Phase 2b: what keeps it out of "Ready" comes with the list (104 unlinked,
  // 103 on two tracks, 105 marked invalid), nothing blocks the session.
  assert.deepEqual([summary.blockedCode, summary.blockedSourceCode, summary.sessionType], [null, null, "FULL TRAINING"]);
  assert.deepEqual(summary.reasons, [
    { code: "athletes_not_linked", count: 1 }, { code: "athletes_need_manual_review", count: 1 }, { code: "athletes_marked_invalid_by_source", count: 1 },
  ]);

  const { rows: [counts] } = { rows: [await writtenRows(team.teamId)] };
  const { all_values: valuesAfter, ...teamRows } = counts;
  assert.deepEqual(teamRows, NOTHING_WRITTEN, "the preview's dry run left nothing behind");
  assert.equal(valuesAfter, valuesBefore);
});

test("preview: per athlete and per value, participation and GPS apart, every left-out value with its reason", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7002 })] }));
  await checkNow(team);
  const [summary] = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  const detail = (await api(`/teams/${team.teamId}/candidates/${summary.id}`, { cookie: team.coach.cookie })).body.candidate;
  const preview = detail.preview;
  const by = Object.fromEntries(preview.athletes.map((x) => [x.gpexeAthleteId, x]));

  // Measured and linked: every result would be created.
  assert.equal(by["101"].athleteId, team.ids.a);
  assert.deepEqual(by["101"].participation, { status: "recorded_by_gpexe" });
  assert.deepEqual(by["101"].gps, { status: "measured", reason: null });
  assert.equal(by["101"].notImported, null);
  assert.deepEqual(by["101"].results.map((r) => [r.level, r.drillIndex, r.outcome]), [["full", null, "created"], ["drill", 0, "created"], ["drill", 1, "created"]]);
  // Drill 1 burst/brake were not fetched: left out with the reason, not a zero.
  const drill1 = by["101"].results.find((r) => r.drillIndex === 1);
  assert.ok(!drill1.values.some((v) => v.metricKey.includes("burst")), "a left-out value is absent, never 0");
  assert.ok(by["101"].skippedValues.some((s) => s.drillIndex === 1 && s.reason === "details_not_fetched"));

  // Two tracks: manual review, stated from the GPEXE data, not imported; the others go on.
  assert.equal(by["103"].gps.status, "needs_manual_review");
  assert.equal(by["103"].gps.reason.source, "gpexe_data");
  assert.equal(by["103"].notImported.code, "multiple_tracks");
  assert.equal(preview.counts.athletesManualReview, 1);

  // Measured but not linked to an OptiMove athlete.
  assert.equal(by["104"].athleteId, null);
  assert.equal(by["104"].gps.status, "measured");
  assert.equal(by["104"].notImported.code, "athlete_not_linked");

  // GPEXE marks the statistics invalid: that reason comes from the data.
  assert.equal(by["105"].gps.status, "not_valid");
  assert.deepEqual([by["105"].gps.reason.code, by["105"].gps.reason.source], ["stats_invalid", "gpexe_data"]);

  // Team athletes with no GPEXE row: participation unknown, no GPS record, no reason invented.
  const without = new Map(preview.teamAthletesWithoutGpexeRecord.map((x) => [x.athleteId, x]));
  assert.deepEqual([...without.keys()].sort(), [team.ids.d, team.ids.e].sort());
  assert.deepEqual(without.get(team.ids.e), { athleteId: team.ids.e, participation: { status: "unknown" }, gps: { status: "no_record", reason: null } });
  assert.equal(detail.athletes[team.ids.e].name, "E");

  assert.equal(preview.status, "ready");
  assert.equal(preview.counts.created, 5);
  assert.match(detail.previewHash, /^[0-9a-f]{64}$/);
});

test("check: repeating it on unchanged data adds no candidate; changed data supersedes the old one", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7003 })] }));
  await checkNow(team);
  const second = await checkNow(team);
  assert.deepEqual([second.candidatesNew, second.candidatesChanged, second.candidatesUnchanged], [0, 0, 1]);
  const count = async () => (await admin.query(`select count(*)::int as n from training_load.gpexe_import_candidates where owner_team_id = $1`, [team.teamId])).rows[0].n;
  assert.equal(await count(), 1);

  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7003, distance101: 3333 })] }));
  const third = await checkNow(team);
  assert.deepEqual([third.candidatesNew, third.candidatesChanged, third.candidatesUnchanged], [0, 1, 0]);
  assert.equal(await count(), 2);
  const visible = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  assert.equal(visible.length, 1, "the superseded candidate is hidden by default");
  const all = (await api(`/teams/${team.teamId}/candidates?includeSuperseded=true`, { cookie: team.coach.cookie })).body.candidates;
  const old = all.find((c) => c.status === "superseded");
  assert.equal(old.supersededByCandidateId, visible[0].id);
  assert.ok(old.approvalBlockers.includes("superseded_by_newer_data"));
});

test("preview: against data already imported, only the difference is shown, old next to new", async () => {
  const team = await setupTeam();
  // An earlier import of 101 and 102, committed the pilot way.
  const first = sessionBundle({ sessionId: 7004, updatedOn: "2026-09-14T20:18:09.337" });
  const plan = buildGpexeImportPlan(first);
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    await importGpexePlan(client, { ...plan, participants: plan.participants.filter((p) => ["101", "102"].includes(p.gpexeAthleteId)) }, {
      ownerTeamId: team.teamId, performedByUserId: team.userId, athleteIdByGpexeId: { 101: team.ids.a, 102: team.ids.b }, batchFilename: "earlier import",
    });
  } finally {
    await client.end();
  }
  const before = await writtenRows(team.teamId);

  // GPEXE later reports a different total distance for 101's whole session.
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7004, updatedOn: "2026-09-15T08:00:00.000", distance101: 3100 })] }));
  await checkNow(team);
  const [summary] = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  const preview = (await api(`/teams/${team.teamId}/candidates/${summary.id}`, { cookie: team.coach.cookie })).body.candidate.preview;
  const a101 = preview.athletes.find((x) => x.gpexeAthleteId === "101");
  const full = a101.results.find((r) => r.level === "full");
  assert.equal(full.outcome, "corrected");
  const distance = full.values.find((v) => v.metricKey === "gpexe_total_distance");
  assert.deepEqual([distance.previous, distance.value, distance.change], [3000, 3100, "changed"]);
  assert.ok(full.values.filter((v) => v.metricKey !== "gpexe_total_distance").every((v) => v.change === "same"));
  assert.ok(a101.results.filter((r) => r.level === "drill").every((r) => r.outcome === "unchanged"));
  assert.ok(preview.athletes.find((x) => x.gpexeAthleteId === "102").results.every((r) => r.outcome === "unchanged"));

  assert.deepEqual(await writtenRows(team.teamId), before, "the preview changed nothing that was already imported");
});

test("check: a session the importer cannot take is saved as blocked, with the reason", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7005, category: "OFFICIAL MATCH" })] }));
  await checkNow(team);
  const [summary] = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  assert.equal(summary.status, "blocked");
  // The list row already says why, in neutral terms; the adapter's code and
  // the session type come with it, the server's sentence does not.
  assert.deepEqual([summary.blockedCode, summary.blockedSourceCode, summary.sessionType, summary.reasons], ["unsupported_session_type", "unsupported_category", "OFFICIAL MATCH", []]);
  assert.equal(summary.preview, undefined, "the list carries no preview");
  const candidate = (await api(`/teams/${team.teamId}/candidates/${summary.id}`, { cookie: team.coach.cookie })).body.candidate;
  assert.equal(candidate.preview.blocked.code, "unsupported_category");
  assert.deepEqual([candidate.blockedCode, candidate.sessionType], ["unsupported_session_type", "OFFICIAL MATCH"], "the detail carries the same fields");
});

test("check: GPEXE refusing the token fails the check with a stable code, and the token appears nowhere", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ error: new GpexeClientError("unauthorized", "GPEXE refused the server's token (check GPEXE_API_TOKEN).", { status: 401 }) }));
  const check = await checkNow(team);
  assert.equal(check.status, "failed");
  assert.equal(check.error.code, "unauthorized");

  service.setGpexeClientFactory(() => {
    throw new GpexeClientError("token_missing", "GPEXE_API_TOKEN is not set on the server.");
  });
  const missing = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body: {} });
  assert.equal(missing.status, 503);
  assert.equal(missing.body.error, "gpexe_token_missing");
});

test("check: one at a time per team; a check that stopped reporting is closed as abandoned", async () => {
  const team = await setupTeam();
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7006 })], gate }));
  const first = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body: {} });
  assert.equal(first.status, 202);
  const second = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body: {} });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "check_already_running");
  open();
  assert.equal((await waitForCheck(team.teamId, first.body.check.id, team.coach.cookie)).status, "succeeded");

  // A running check whose server went away: no heartbeat for too long.
  const stale = (await admin.query(
    // v24: a check row records the GPEXE team it reads, so this stand-in for
    // an abandoned run carries the team's own connection.
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, window_from, window_to, heartbeat_at, started_at, gpexe_team_id)
     values ($1,$2,'2026-09-01','2026-09-14', now() - interval '1 hour', now() - interval '1 hour',
             (select gpexe_team_id from training_load.gpexe_team_settings where owner_team_id = $1)) returning id`,
    [team.teamId, team.coach.id],
  )).rows[0].id;
  service.setGpexeClientFactory(fakeGpexe({ bundles: [] }));
  assert.equal((await checkNow(team)).status, "succeeded");
  const closed = (await admin.query(`select status, error_code from training_load.gpexe_import_checks where id = $1`, [stale])).rows[0];
  assert.deepEqual(closed, { status: "failed", error_code: "abandoned" });
});

test("check window: at most 31 days, not in the future, a real date", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [] }));
  for (const body of [{ from: "2026-08-01", to: "2026-09-14" }, { from: "2026-09-10", to: "2026-09-01" }, { to: "2999-01-01" }, { from: "2026-02-30" }]) {
    const r = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, "invalid_window");
  }
});

test("retention: an expired snapshot is gone for the app before the purge, the purge removes it, and only a new check brings it back", async () => {
  const team = await setupTeam();
  const bundle = sessionBundle({ sessionId: 7007 });
  service.setGpexeClientFactory(fakeGpexe({ bundles: [bundle] }));
  await checkNow(team);
  const [summary] = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  assert.equal(summary.snapshot.available, true);
  const days = Math.round((new Date(summary.snapshot.expiresAt) - Date.now()) / 86_400_000);
  assert.equal(days, 30, "an unapproved candidate keeps its snapshot 30 days");

  await admin.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() - interval '1 minute' where id = $1`, [summary.id]);
  // Not purged yet, but already unusable.
  const expired = (await api(`/teams/${team.teamId}/candidates/${summary.id}`, { cookie: team.coach.cookie })).body.candidate;
  assert.deepEqual([expired.snapshot.available, expired.snapshot.reason, expired.preview], [false, "expired", null]);
  assert.ok(expired.approvalBlockers.includes("snapshot_expired_check_again"));
  assert.deepEqual([expired.blockedCode, expired.blockedSourceCode, expired.sessionType, expired.reasons], [null, null, null, []], "an expired snapshot claims no reason");
  const padmin = await platformAdmin();
  const watching = (await api(`/retention`, { cookie: padmin.cookie })).body.retention;
  assert.ok(watching.expiredNotPurged >= 1);
  assert.equal(watching.healthy, false, "the monitor shows the overdue purge");

  const { runGpexeRetentionOnce } = await import("../src/gpexeRetentionCli.js");
  const { purged, status } = await runGpexeRetentionOnce();
  assert.ok(purged >= 1);
  assert.equal(status.expiredNotPurged, 0);
  assert.equal(status.healthy, true);
  assert.equal(status.lastSuccessfulRun.trigger, "cli");
  const row = (await admin.query(`select raw_bundle, preview, raw_purged_at, bundle_hash, preview_hash from training_load.gpexe_import_candidates where id = $1`, [summary.id])).rows[0];
  assert.equal(row.raw_bundle, null);
  assert.equal(row.preview, null);
  assert.ok(row.raw_purged_at);
  assert.match(row.bundle_hash, /^[0-9a-f]{64}$/, "the hash stays as the trace");
  const purgedView = (await api(`/teams/${team.teamId}/candidates/${summary.id}`, { cookie: team.coach.cookie })).body.candidate;
  assert.equal(purgedView.snapshot.reason, "purged");

  // Checking again restores the same candidate with a fresh 30 days.
  await checkNow(team);
  const back = (await api(`/teams/${team.teamId}/candidates/${summary.id}`, { cookie: team.coach.cookie })).body.candidate;
  assert.equal(back.snapshot.available, true);
  assert.equal(back.preview.status, "ready");
});

test("retention: every check purges expired snapshots first, even of other sessions, with no scheduler running", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7010 })] }));
  await checkNow(team);
  const id = (await admin.query(`select id from training_load.gpexe_import_candidates where owner_team_id = $1`, [team.teamId])).rows[0].id;
  await admin.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() - interval '1 minute' where id = $1`, [id]);
  // GPEXE no longer lists that session; the check still clears its snapshot.
  service.setGpexeClientFactory(fakeGpexe({ bundles: [] }));
  const check = await checkNow(team);
  const row = (await admin.query(`select raw_bundle, raw_purged_at is not null as purged from training_load.gpexe_import_candidates where id = $1`, [id])).rows[0];
  assert.deepEqual(row, { raw_bundle: null, purged: true });
  const run = (await admin.query(
    `select trigger_source, purged_count from training_load.gpexe_retention_runs where started_at >= $1 order by started_at limit 1`,
    [check.startedAt],
  )).rows[0];
  assert.equal(run.trigger_source, "check");
  assert.ok(run.purged_count >= 1);
});

test("retention: an imported snapshot is purged after its 90 days and a later check does not store it again", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7008 })] }));
  await checkNow(team);
  const id = await importThroughApproval(team);
  // Its 90 days are over.
  await admin.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() - interval '1 day' where id = $1`, [id]);
  await service.runRetention("interval");
  const recheck = await checkNow(team);
  assert.equal(recheck.status, "succeeded", JSON.stringify(recheck.error));
  assert.equal(recheck.candidatesUnchanged, 1);
  const row = (await admin.query(`select raw_bundle, raw_purged_at is not null as purged, status, last_seen_check_id from training_load.gpexe_import_candidates where id = $1`, [id])).rows[0];
  assert.deepEqual(row, { raw_bundle: null, purged: true, status: "imported", last_seen_check_id: recheck.id });
  assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_import_candidates where owner_team_id = $1`, [team.teamId])).rows[0].n, 1);
});

test("access: another team's coach, the wrong workspace and a malformed id all get the same 404", async () => {
  const team = await setupTeam();
  const other = await createGpexePilotOrg(admin, { athleteNames: ["X"] });
  const outsider = await coachOf(other.teamId, "other coach");
  for (const path of [`/teams/${team.teamId}/status`, `/teams/${team.teamId}/candidates`, `/teams/not-a-uuid/status`, `/teams/00000000-0000-4000-8000-000000000000/status`]) {
    const r = await api(path, { cookie: outsider.cookie });
    assert.deepEqual([r.status, r.body.error], [404, "notFound"], path);
  }
  // The team's own coach, but acting in another team's workspace.
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [team.coach.id, other.teamId]);
  await setWorkspace(team.coach.id, "team", other.teamId);
  assert.equal((await api(`/teams/${team.teamId}/status`, { cookie: team.coach.cookie })).status, 404);
  await setWorkspace(team.coach.id, "team", team.teamId);
  assert.equal((await api(`/teams/${team.teamId}/status`, { cookie: team.coach.cookie })).status, 200);
  assert.equal((await fetch(`${apiBase}/api/training-load/gpexe/teams/${team.teamId}/status`)).status, 401);
  // Retention status does not exist for a coach.
  assert.equal((await api(`/retention`, { cookie: team.coach.cookie })).status, 404);
});

test("settings: only a platform admin connects a GPEXE team, and one GPEXE team feeds one OptiMove team", async () => {
  const team = await setupTeam({ gpexeTeamId: "501" });
  const coachTry = await api(`/teams/${team.teamId}/settings`, { method: "PUT", cookie: team.coach.cookie, body: { gpexeTeamId: "502" } });
  assert.equal(coachTry.status, 403);
  const other = await createGpexePilotOrg(admin, { athleteNames: ["Y"] });
  const taken = await api(`/teams/${other.teamId}/settings`, { method: "PUT", cookie: team.padmin.cookie, body: { gpexeTeamId: "501" } });
  assert.deepEqual([taken.status, taken.body.error], [409, "gpexe_team_taken"]);
  const bad = await api(`/teams/${other.teamId}/settings`, { method: "PUT", cookie: team.padmin.cookie, body: { gpexeTeamId: "5; drop" } });
  assert.equal(bad.status, 400);
  const status = await api(`/teams/${team.teamId}/status`, { cookie: team.coach.cookie });
  assert.equal(status.body.settings.gpexeTeamId, "501");
  assert.equal(status.body.approvalAvailable, true);
});

test("settings history: a platform admin reads every earlier value with its reason; the team's coach does not, and another team's coach gets the same 404 as a team that does not exist", async () => {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["H1"] });
  const coach = await coachOf(org.teamId);
  const padmin = await platformAdmin();
  const first = String(nextGpexeTeamId++);
  const second = String(nextGpexeTeamId++);
  const put = (body, cookie = padmin.cookie) => api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie, body });
  assert.equal((await put({ gpexeTeamId: first, reason: "pilot team, owner approved" })).status, 200);
  // The same value again is idempotent: it appends nothing and leaves the
  // reason of the value in force alone.
  assert.equal((await put({ gpexeTeamId: first, reason: "typed again by mistake" })).status, 200);
  assert.equal((await put({ gpexeTeamId: second, reason: "the first number was a typo" })).status, 200);

  const history = await api(`/teams/${org.teamId}/settings/history`, { cookie: padmin.cookie });
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.deepEqual(history.body.history.map((row) => row.gpexeTeamId), [second, first], "newest first, and the repeat wrote no row");
  assert.deepEqual(history.body.history.map((row) => row.changeReason), ["the first number was a typo", "pilot team, owner approved"]);
  assert.ok(history.body.history.every((row) => row.configuredByName && row.configuredAt), JSON.stringify(history.body.history));

  // A coach of the team may review imports, but an admin's note may name
  // another club or team, so it is not theirs to read.
  const asCoach = await api(`/teams/${org.teamId}/settings/history`, { cookie: coach.cookie });
  assert.deepEqual([asCoach.status, asCoach.body.error], [403, "forbidden"]);

  const otherOrg = await createGpexePilotOrg(admin, { athleteNames: ["H2"] });
  const otherCoach = await coachOf(otherOrg.teamId);
  assert.equal((await api(`/teams/${org.teamId}/settings/history`, { cookie: otherCoach.cookie })).status, 404);

  // The current value: the admin screen also names who set it and why; the
  // coach's own screen still gets only the number and when.
  const adminStatus = await api(`/teams/${org.teamId}/status`, { cookie: padmin.cookie });
  assert.equal(adminStatus.body.settings.gpexeTeamId, second);
  assert.equal(adminStatus.body.settings.changeReason, "the first number was a typo");
  assert.ok(adminStatus.body.settings.configuredByName);
  const coachStatus = await api(`/teams/${org.teamId}/status`, { cookie: coach.cookie });
  assert.deepEqual(Object.keys(coachStatus.body.settings).sort(), ["configuredAt", "gpexeTeamId"]);
});

test("approver grants: only a platform admin grants and revokes, only to an active coach of the team, and the right follows the role", async () => {
  const team = await setupTeam();
  const status = async (who) => (await api(`/teams/${team.teamId}/status`, { cookie: who.cookie })).body.viewer;
  assert.deepEqual(await status(team.coach), { canApprove: false, approvalBasis: null, isPlatformAdmin: false }, "the coach role alone gives no right");

  const selfGrant = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.coach.cookie, body: { userId: team.coach.id, reason: "me" } });
  // Refused by the route itself (the database would refuse it too, see below).
  assert.deepEqual([selfGrant.status, selfGrant.body.message], [403, "Only a platform admin may do this."]);
  const noReason = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: team.coach.id, reason: " " } });
  assert.deepEqual([noReason.status, noReason.body.error], [400, "reason_required"]);
  const notCoach = await makeUser("not a coach");
  const refused = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: notCoach, reason: "fitness coach" } });
  assert.deepEqual([refused.status, refused.body.error], [409, "grantee_not_team_coach"]);

  const grant = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: team.coach.id, reason: "approves GPEXE imports for this team" } });
  assert.equal(grant.status, 201);
  assert.equal((await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: team.coach.id, reason: "again" } })).status, 409);
  assert.deepEqual(await status(team.coach), { canApprove: true, approvalBasis: "team_grant", isPlatformAdmin: false });

  // Losing the coach role ends the right without touching the grant.
  const { canApproveGpexeImport } = await import("../src/gpexeImportAccess.js");
  const { query } = await import("../src/db.js");
  assert.equal((await canApproveGpexeImport({ query }, team.coach.id, team.teamId)).canApprove, true);
  await admin.query(`update public.user_team_roles set is_active = false where user_id = $1 and team_id = $2`, [team.coach.id, team.teamId]);
  assert.deepEqual(await canApproveGpexeImport({ query }, team.coach.id, team.teamId), { canApprove: false, basis: null });
  const r = await admin.query(`select 1 from training_load.gpexe_import_approvers where id = $1 and revoked_at is null`, [grant.body.grant.id]);
  assert.equal(r.rowCount, 1, "the grant row itself is untouched");
  await admin.query(`update public.user_team_roles set is_active = true where user_id = $1 and team_id = $2`, [team.coach.id, team.teamId]);
  // A grant for one team gives nothing on another.
  const otherTeam = await createGpexePilotOrg(admin, { athleteNames: ["Z"] });
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [team.coach.id, otherTeam.teamId]);
  assert.equal((await canApproveGpexeImport({ query }, team.coach.id, otherTeam.teamId)).canApprove, false);

  const revoke = await api(`/teams/${team.teamId}/approvers/${grant.body.grant.id}/revoke`, { method: "POST", cookie: team.padmin.cookie, body: { reason: "left the staff" } });
  assert.equal(revoke.status, 200);
  assert.equal((await status(team.coach)).canApprove, false);
  const history = (await api(`/teams/${team.teamId}/approvers`, { cookie: team.coach.cookie })).body.approvers;
  assert.deepEqual(history.map((h) => [h.active, h.grantReason, h.revokeReason]), [[false, "approves GPEXE imports for this team", "left the staff"]]);
  assert.deepEqual(await status(team.padmin), { canApprove: true, approvalBasis: "platform_admin", isPlatformAdmin: true });
});

test("database: approver grants and athlete links keep their history and refuse what the routes refuse", async () => {
  const team = await setupTeam();
  const grant = await admin.query(
    `insert into training_load.gpexe_import_approvers (owner_team_id, user_id, granted_by_user_id, grant_reason) values ($1,$2,$3,'reason') returning id`,
    [team.teamId, team.coach.id, team.padmin.id],
  );
  const id = grant.rows[0].id;
  // A coach cannot be the one who granted.
  await assert.rejects(
    admin.query(`insert into training_load.gpexe_import_approvers (owner_team_id, user_id, granted_by_user_id, grant_reason) values ($1,$2,$2,'self')`, [team.teamId, team.coach.id]),
    (e) => e.code === "42501",
  );
  await assert.rejects(admin.query(`delete from training_load.gpexe_import_approvers where id = $1`, [id]), /never deleted/);
  await assert.rejects(admin.query(`update training_load.gpexe_import_approvers set grant_reason = 'rewritten' where id = $1`, [id]), /only revoking/);
  await assert.rejects(admin.query(`update training_load.gpexe_import_approvers set revoked_at = now(), revoked_by_user_id = $2, revoke_reason = 'x' where id = $1`, [id, team.coach.id]), (e) => e.code === "42501");
  await admin.query(`update training_load.gpexe_import_approvers set revoked_at = now(), revoked_by_user_id = $2, revoke_reason = 'done' where id = $1`, [id, team.padmin.id]);
  await assert.rejects(admin.query(`update training_load.gpexe_import_approvers set revoke_reason = 'again' where id = $1`, [id]), /already revoked/);

  const link = (await admin.query(`select id from training_load.gpexe_athlete_links where owner_team_id = $1 and gpexe_athlete_id = '101'`, [team.teamId])).rows[0].id;
  await assert.rejects(admin.query(`delete from training_load.gpexe_athlete_links where id = $1`, [link]), /never deleted/);
  await assert.rejects(admin.query(`update training_load.gpexe_athlete_links set athlete_id = $2 where id = $1`, [link, team.ids.e]), /only unlinking/);
});

test("athlete links: only a team member, one active link per side, unlink keeps the history", async () => {
  const team = await setupTeam();
  const stranger = (await admin.query(`insert into public.athletes (full_name, display_name) values ('Stranger','Stranger') returning id`)).rows[0].id;
  const notMember = await api(`/teams/${team.teamId}/athlete-links`, { method: "POST", cookie: team.coach.cookie, body: { gpexeAthleteId: "200", athleteId: stranger } });
  assert.deepEqual([notMember.status, notMember.body.error], [409, "athlete_not_in_team"]);
  const taken = await api(`/teams/${team.teamId}/athlete-links`, { method: "POST", cookie: team.coach.cookie, body: { gpexeAthleteId: "101", athleteId: team.ids.e } });
  assert.deepEqual([taken.status, taken.body.error], [409, "already_linked"]);
  const links = (await api(`/teams/${team.teamId}/athlete-links`, { cookie: team.coach.cookie })).body.links;
  const l101 = links.find((l) => l.gpexeAthleteId === "101");
  assert.equal(l101.athleteName, "A101");
  assert.equal((await api(`/teams/${team.teamId}/athlete-links/${l101.id}/unlink`, { method: "POST", cookie: team.coach.cookie })).status, 200);
  assert.equal((await api(`/teams/${team.teamId}/athlete-links/${l101.id}/unlink`, { method: "POST", cookie: team.coach.cookie })).status, 404);
  assert.equal((await api(`/teams/${team.teamId}/athlete-links`, { method: "POST", cookie: team.coach.cookie, body: { gpexeAthleteId: "101", athleteId: team.ids.e } })).status, 201);
  const history = (await admin.query(`select count(*)::int as n from training_load.gpexe_athlete_links where owner_team_id = $1 and gpexe_athlete_id = '101'`, [team.teamId])).rows[0].n;
  assert.equal(history, 2);
});

test("switch: turning GPEXE_IMPORT_APPLY_ENABLED on changes what the screens say, and a check alone still writes no result", async () => {
  const team = await setupTeam();
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7009 })] }));
    await checkNow(team);
    const list = await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie });
    assert.equal(list.body.importSwitch.enabled, true);
    assert.ok(!list.body.candidates[0].approvalBlockers.includes("import_switch_off"));
    assert.deepEqual(list.body.candidates[0].approvalBlockers, [], "switch on, pending, ready: nothing blocks the approval");
    const { all_values: _values, ...teamRows } = await writtenRows(team.teamId);
    assert.deepEqual(teamRows, NOTHING_WRITTEN);
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
});

test("check: a run closed as abandoned stops, and never ends up succeeded or writes a candidate", async () => {
  const team = await setupTeam();
  let open;
  let entered;
  const fetchGate = new Promise((resolve) => { open = resolve; });
  const fetching = new Promise((resolve) => { entered = resolve; });
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7011 })], fetchGate, onFetch: () => entered() }));
  const first = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body: {} });
  assert.equal(first.status, 202);
  await fetching; // the run is now waiting inside a GPEXE request
  // It looks dead: no heartbeat for an hour. A new check closes it.
  await admin.query(`update training_load.gpexe_import_checks set heartbeat_at = now() - interval '1 hour' where id = $1`, [first.body.check.id]);
  service.setGpexeClientFactory(fakeGpexe({ bundles: [] }));
  assert.equal((await checkNow(team)).status, "succeeded");
  // The old run wakes up; wait until it has really ended.
  const ended = new Promise((resolve) => service.setCheckRunObserver((id) => { if (id === first.body.check.id) resolve(); }));
  open();
  await ended;
  service.setCheckRunObserver(null);
  const row = (await admin.query(`select status, error_code from training_load.gpexe_import_checks where id = $1`, [first.body.check.id])).rows[0];
  assert.deepEqual(row, { status: "failed", error_code: "abandoned" });
  const candidates = (await admin.query(`select count(*)::int as n from training_load.gpexe_import_candidates where owner_team_id = $1`, [team.teamId])).rows[0].n;
  assert.equal(candidates, 0, "the closed run recorded nothing");
});

test("preview: an athlete imported before and now left out blocks the session, and is named as the cause", async () => {
  const team = await setupTeam();
  const bundle = sessionBundle({ sessionId: 7012 });
  const plan = buildGpexeImportPlan(bundle);
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    await importGpexePlan(client, { ...plan, participants: plan.participants.filter((p) => ["101", "102"].includes(p.gpexeAthleteId)) }, {
      ownerTeamId: team.teamId, performedByUserId: team.userId, athleteIdByGpexeId: { 101: team.ids.a, 102: team.ids.b }, batchFilename: "earlier import",
    });
  } finally {
    await client.end();
  }
  const link101 = (await api(`/teams/${team.teamId}/athlete-links`, { cookie: team.coach.cookie })).body.links.find((l) => l.gpexeAthleteId === "101");
  await api(`/teams/${team.teamId}/athlete-links/${link101.id}/unlink`, { method: "POST", cookie: team.coach.cookie });

  service.setGpexeClientFactory(fakeGpexe({ bundles: [bundle] }));
  await checkNow(team);
  const [summary] = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  assert.equal(summary.status, "blocked");
  assert.deepEqual([summary.blockedCode, summary.blockedSourceCode], ["earlier_import_left_behind", "identities_missing_from_source"]);
  const preview = (await api(`/teams/${team.teamId}/candidates/${summary.id}`, { cookie: team.coach.cookie })).body.candidate.preview;
  assert.equal(preview.blocked.code, "identities_missing_from_source");
  assert.deepEqual(preview.blocked.gpexeAthleteIds, ["101"]);
  const by = Object.fromEntries(preview.athletes.map((x) => [x.gpexeAthleteId, x]));
  assert.equal(by["101"].blocksSession, true);
  assert.equal(by["101"].notImported.code, "athlete_not_linked");
  assert.equal(by["102"].blocksSession, false);
  assert.equal(by["102"].notImported.code, "session_blocked");
  // One concrete step that lifts the block, naming the athlete the earlier
  // results belong to.
  assert.equal(preview.blocked.resolution.length, 1);
  const [step] = preview.blocked.resolution;
  assert.deepEqual([step.gpexeAthleteId, step.previousAthleteId, step.cause, step.action], ["101", team.ids.a, "athlete_not_linked", "relink_athlete"]);
  assert.match(step.step, /Link GPEXE athlete 101 again/);

  // Doing that step lifts the block.
  await api(`/teams/${team.teamId}/athlete-links`, { method: "POST", cookie: team.coach.cookie, body: { gpexeAthleteId: "101", athleteId: team.ids.a } });
  await checkNow(team);
  const after = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates[0];
  // No longer blocked; 101 and 102 were imported already and are unchanged.
  assert.equal(after.status, "pending");
  assert.equal(after.previewStatus, "no_changes");
  // 101 and 102 are linked and imported; 104 stays unlinked, 103 and 105
  // keep their data reasons: "nothing new" is not "nobody linked".
  assert.equal(after.blockedCode, null);
  assert.deepEqual(after.reasons.map((r) => r.code), ["athletes_not_linked", "athletes_need_manual_review", "athletes_marked_invalid_by_source"]);
});

test("access: the club admin sees the team in the club's workspace, not in another club's", async () => {
  const team = await setupTeam();
  const clubAdmin = await makeUser("club admin");
  await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [clubAdmin, team.clubId]);
  const otherClub = (await admin.query(`insert into public.clubs (name) values ('Other club') returning id`)).rows[0].id;
  await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [clubAdmin, otherClub]);
  const cookie = await cookieFor(clubAdmin);
  await setWorkspace(clubAdmin, "club", team.clubId);
  assert.equal((await api(`/teams/${team.teamId}/status`, { cookie })).status, 200);
  await setWorkspace(clubAdmin, "club", otherClub);
  const r = await api(`/teams/${team.teamId}/status`, { cookie });
  assert.deepEqual([r.status, r.body.error], [404, "notFound"]);
});

test("database: history tables refuse TRUNCATE, an imported candidate is never deleted, every GPEXE team setting is kept", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7013 })] }));
  await checkNow(team);
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    for (const table of ["gpexe_athlete_links", "gpexe_import_approvers", "gpexe_import_candidates", "gpexe_team_settings_history"]) {
      await c.query("begin");
      await assert.rejects(c.query(`truncate training_load.${table} cascade`), /TRUNCATE refused/, table);
      await c.query("rollback");
    }
    // Reaching the candidates through the checks they reference is refused too.
    await c.query("begin");
    await assert.rejects(c.query(`truncate training_load.gpexe_import_checks cascade`), /TRUNCATE refused/);
    await c.query("rollback");
  } finally {
    await c.end();
  }
  const id = await importThroughApproval(team);
  await assert.rejects(admin.query(`delete from training_load.gpexe_import_candidates where id = $1`, [id]), /never deleted/);
  // Nor by first turning it back into a pending one.
  await assert.rejects(admin.query(`update training_load.gpexe_import_candidates set status = 'pending', imported_at = null where id = $1`, [id]), /status and import time are final/);
  await assert.rejects(admin.query(`update training_load.gpexe_import_candidates set bundle_hash = repeat('0', 64) where id = $1`, [id]), /never change/);
  // The purge may still clear an imported snapshot.
  await admin.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() - interval '1 minute' where id = $1`, [id]);
  await service.runRetention("cli");
  assert.equal((await admin.query(`select raw_bundle, status from training_load.gpexe_import_candidates where id = $1`, [id])).rows[0].status, "imported");

  const other = await createGpexePilotOrg(admin, { athleteNames: ["Q"] });
  // Nothing depends on this team's connection yet, so it may still be
  // changed - with a reason, which v24 requires for a change (see
  // gpexe-settings-change-guard.test.mjs).
  for (const [gpexeTeamId, reason] of [["88001", null], ["88002", "connected to the wrong GPEXE team"]]) {
    const body = reason ? { gpexeTeamId, reason } : { gpexeTeamId };
    assert.equal((await api(`/teams/${other.teamId}/settings`, { method: "PUT", cookie: team.padmin.cookie, body })).status, 200);
  }
  const history = (await admin.query(`select gpexe_team_id from training_load.gpexe_team_settings_history where owner_team_id = $1 order by configured_at, gpexe_team_id`, [other.teamId])).rows.map((r) => r.gpexe_team_id);
  assert.deepEqual(history, ["88001", "88002"]);
  await assert.rejects(admin.query(`delete from training_load.gpexe_team_settings_history where owner_team_id = $1`, [other.teamId]), /append-only/);
});

test("retention: the purge works in short batches and a backlog is cleared completely", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7014 }), sessionBundle({ sessionId: 7015 }), sessionBundle({ sessionId: 7016 })] }));
  await checkNow(team);
  await admin.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() - interval '1 minute' where owner_team_id = $1`, [team.teamId]);
  // One batch at a time.
  assert.equal((await admin.query(`select training_load.purge_expired_gpexe_raw(2) as n`)).rows[0].n, 2);
  const left = (await admin.query(`select count(*)::int as n from training_load.gpexe_import_candidates where owner_team_id = $1 and raw_bundle is not null`, [team.teamId])).rows[0].n;
  assert.ok(left >= 1);
  const run = await service.runRetention("cli");
  assert.ok(run.purged >= left);
  assert.equal((await service.retentionStatus()).expiredNotPurged, 0);
});

// ---------------------------------------------------------------------------
// Phase F2: approving a candidate imports it. The switch is turned on only
// inside this test process, on the disposable database.
// ---------------------------------------------------------------------------

async function withSwitchOn(fn) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await fn();
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
    service.setApprovalObserver(null);
  }
}

// The candidate of the team's only session, imported the one way there is:
// approved by the platform admin with the switch on.
async function importThroughApproval(team) {
  return withSwitchOn(async () => {
    const candidate = await pendingCandidate(team);
    const r = await approve(team, candidate, team.padmin.cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return candidate.id;
  });
}

async function pendingCandidate(team, cookie = team.coach.cookie) {
  const list = (await api(`/teams/${team.teamId}/candidates`, { cookie })).body.candidates;
  const summary = list.find((c) => c.status === "pending") ?? list[0];
  return (await api(`/teams/${team.teamId}/candidates/${summary.id}`, { cookie })).body.candidate;
}

function approve(team, candidate, cookie, body = {}) {
  return api(`/teams/${team.teamId}/candidates/${candidate.id}/approve`, {
    method: "POST", cookie, body: { previewHash: candidate.previewHash, ...body },
  });
}

// Row counts of every table in the schemas an import can touch: "nothing
// written" means every one of them is exactly as before.
async function allRowCounts() {
  const tables = (await admin.query(
    `select table_schema || '.' || table_name as name from information_schema.tables
      where table_schema in ('training_load', 'training', 'public') and table_type = 'BASE TABLE' order by 1`,
  )).rows.map((r) => r.name);
  const counts = {};
  for (const name of tables) counts[name] = (await admin.query(`select count(*)::int as n from ${name}`)).rows[0].n;
  return counts;
}

async function approvalsOf(candidateId) {
  return (await admin.query(`select * from training_load.gpexe_import_approvals where candidate_id = $1`, [candidateId])).rows;
}

async function candidateRow(id) {
  return (await admin.query(`select status, imported_at, raw_expires_at, preview_hash, preview from training_load.gpexe_import_candidates where id = $1`, [id])).rows[0];
}

async function currentDistance(teamId, externalId) {
  return (await admin.query(
    `select v.value_numeric::float8 as v
       from training_load.metric_source_connections c
       join training_load.metric_source_identities si on si.source_connection_id = c.id
       join training_load.metric_values v on v.occasion_id = si.current_occasion_id
       join training_load.metric_definitions d on d.id = v.metric_definition_id
      where c.owner_team_id = $1 and si.source_external_id = $2 and d.key = 'gpexe_total_distance'`,
    [teamId, externalId],
  )).rows[0]?.v ?? null;
}

test("approve: with the import switch off nothing is written, whoever asks", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7101 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  const before = await allRowCounts();
  const r = await approve(team, candidate, team.padmin.cookie);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "import_switch_off");
  assert.match(r.body.message, /no result or activity can be written/);
  assert.deepEqual(await allRowCounts(), before);
  assert.equal((await candidateRow(candidate.id)).status, "pending");
});

test("approve: the whole candidate is imported exactly as previewed, recorded with its approver, and only once", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7102 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  assert.equal(candidate.preview.status, "ready");
  assert.deepEqual(candidate.preview.changesToImported, [], "a first import changes nothing already imported");

  await withSwitchOn(async () => {
    const r = await approve(team, candidate, team.padmin.cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.approval.basis, "platform_admin");
    assert.equal(r.body.candidate.status, "imported");
    assert.ok(r.body.candidate.approvalBlockers.includes("already_imported"));

    // What was written is what the preview said: 101 and 102 created, the
    // others left out with their reasons.
    const created = candidate.preview.athletes.flatMap((a) => a.results.filter((x) => x.outcome === "created").map((x) => x.externalId)).sort();
    assert.ok(created.length > 0);
    assert.deepEqual(r.body.import.counts, { created: created.length });
    const identities = (await admin.query(
      `select si.source_external_id from training_load.metric_source_connections c
         join training_load.metric_source_identities si on si.source_connection_id = c.id
        where c.owner_team_id = $1 and si.current_occasion_id is not null order by 1`,
      [team.teamId],
    )).rows.map((x) => x.source_external_id);
    assert.deepEqual(identities, created);
    const rows = await writtenRows(team.teamId);
    assert.equal(rows.events, 1);
    assert.equal(rows.activities, 1);
    assert.equal(rows.batches, 1);

    const [approval] = await approvalsOf(candidate.id);
    assert.equal(approval.approved_by_user_id, team.padmin.id);
    assert.equal(approval.approval_basis, "platform_admin");
    assert.equal(approval.approver_grant_id, null);
    assert.equal(approval.preview_hash, candidate.previewHash);
    assert.equal(approval.changes_to_imported, 0);
    assert.equal(approval.metric_event_id, r.body.import.eventId);
    const row = await candidateRow(candidate.id);
    assert.equal(row.status, "imported");
    // 90 calendar days (one more hour when they cross the end of summer time).
    const days = (new Date(row.raw_expires_at) - Date.now()) / 86_400_000;
    assert.ok(days > 89.9 && days < 90.05, `the snapshot is kept 90 days after import (${days})`);

    // Approving again changes nothing.
    const again = await approve(team, candidate, team.padmin.cookie);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "already_imported");
    assert.deepEqual(await writtenRows(team.teamId), rows);
    assert.equal((await approvalsOf(candidate.id)).length, 1);

    // GPEXE unchanged: the next check has nothing new to review.
    const check = await checkNow(team);
    assert.deepEqual([check.candidatesNew, check.candidatesChanged, check.candidatesUnchanged], [0, 0, 1]);
  });
});

test("approve: when the preview changed under the approval's lock, everything the import already wrote is rolled back and the candidate is sent back for review", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7103 })] }));
  await checkNow(team);
  const reviewed = await pendingCandidate(team);
  assert.ok(reviewed.preview.athletes.find((a) => a.gpexeAthleteId === "102").results.some((x) => x.outcome === "created"));

  // After the review, 102 is unlinked: the import would now leave 102 out.
  const link102 = (await api(`/teams/${team.teamId}/athlete-links`, { cookie: team.coach.cookie })).body.links.find((l) => l.gpexeAthleteId === "102");
  assert.equal((await api(`/teams/${team.teamId}/athlete-links/${link102.id}/unlink`, { method: "POST", cookie: team.coach.cookie })).status, 200);
  const before = await allRowCounts();

  await withSwitchOn(async () => {
    // Inside the approval's transaction, after the import ran and before the
    // hashes were compared: the import HAD written its rows.
    let seenInside = null;
    service.setApprovalObserver(async ({ client, freshPreviewHash }) => {
      seenInside = {
        events: (await client.query(`select count(*)::int as n from training_load.metric_events where owner_team_id = $1`, [team.teamId])).rows[0].n,
        occasions: (await client.query(
          `select count(*)::int as n from training_load.metric_measurement_occasions o
             join training_load.metric_event_participants p on p.id = o.event_participant_id
             join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`, [team.teamId])).rows[0].n,
        activities: (await client.query(`select count(*)::int as n from training.activities where owner_team_id = $1`, [team.teamId])).rows[0].n,
        freshPreviewHash,
      };
    });
    const r = await approve(team, reviewed, team.padmin.cookie);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "preview_changed");
    assert.match(r.body.message, /nothing was imported/);
    assert.deepEqual(r.body.reviewAgain, { candidateId: reviewed.id, href: `/api/training-load/gpexe/teams/${team.teamId}/candidates/${reviewed.id}` });

    assert.ok(seenInside, "the import ran before the comparison");
    assert.ok(seenInside.events === 1 && seenInside.occasions > 0 && seenInside.activities === 1, JSON.stringify(seenInside));
    assert.notEqual(seenInside.freshPreviewHash, reviewed.previewHash);

    // All of it is gone: every table of every schema the import touches has
    // exactly the rows it had before, and no approval was recorded.
    assert.deepEqual(await allRowCounts(), before);
    assert.equal((await approvalsOf(reviewed.id)).length, 0);

    // The way back: the candidate now carries the preview of what an import
    // would do today, 102 left out as unlinked.
    const again = (await api(r.body.reviewAgain.href.replace("/api/training-load/gpexe", ""), { cookie: team.coach.cookie })).body.candidate;
    assert.equal(again.status, "pending");
    assert.equal(again.previewHash, seenInside.freshPreviewHash);
    assert.equal(again.preview.athletes.find((a) => a.gpexeAthleteId === "102").notImported.code, "athlete_not_linked");

    // An approval of the new preview goes through.
    service.setApprovalObserver(null);
    const ok = await approve(team, again, team.padmin.cookie);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await approvalsOf(reviewed.id))[0].preview_hash, again.previewHash);
  });
});

test("approve: a preview hash other than the stored one is refused before anything is written", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7104 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  const before = await allRowCounts();
  await withSwitchOn(async () => {
    let importRan = false;
    service.setApprovalObserver(() => { importRan = true; });
    const r = await approve(team, candidate, team.padmin.cookie, { previewHash: "0".repeat(64) });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "preview_changed");
    assert.equal(r.body.reviewAgain.candidateId, candidate.id);
    assert.equal(importRan, false, "refused before the import ran");
    assert.equal((await approve(team, candidate, team.padmin.cookie, { previewHash: "not a hash" })).status, 400);
    assert.equal((await approve(team, candidate, team.padmin.cookie, { acceptChanges: "yes" })).status, 400);
  });
  assert.deepEqual(await allRowCounts(), before);
  assert.equal((await candidateRow(candidate.id)).preview_hash, candidate.previewHash, "a refused stale hash does not touch the candidate");
});

test("approve: every change to an already imported result is listed and must be accepted explicitly", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7105, updatedOn: "2026-09-14T20:18:09.337" })] }));
  await checkNow(team);
  await withSwitchOn(async () => {
    assert.equal((await approve(team, await pendingCandidate(team), team.padmin.cookie)).status, 200);
  });
  const fullId = (await admin.query(
    `select si.source_external_id as id from training_load.metric_source_identities si join training_load.metric_source_connections c on c.id = si.source_connection_id
      where c.owner_team_id = $1 and si.source_external_id like '%:full' and si.current_occasion_id is not null
        and exists (select 1 from training_load.metric_values v join training_load.metric_definitions d on d.id = v.metric_definition_id
                     where v.occasion_id = si.current_occasion_id and d.key = 'gpexe_total_distance' and v.value_numeric = 3000)
      order by 1 limit 1`, [team.teamId])).rows[0].id;

  // GPEXE later reports a different distance for 101 (newer report time):
  // the imported value would be replaced.
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7105, updatedOn: "2026-09-15T08:00:00.000", distance101: 3100 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  assert.equal(candidate.changesToImported, 1);
  assert.equal(candidate.preview.counts.changesToImported, 1);
  assert.deepEqual(candidate.reasons.at(-1), { code: "changes_to_imported_results", count: 1 }, "the list's last reason is the change to accept");
  const [change] = candidate.preview.changesToImported;
  assert.equal(change.gpexeAthleteId, "101");
  assert.equal(change.externalId, fullId);
  assert.equal(change.outcome, "corrected");
  assert.equal(change.effect, "replaces_current_values");
  assert.equal(change.newVersionBecomesCurrent, true);
  assert.deepEqual(change.values.map((v) => [v.metricKey, v.previous, v.value, v.change]), [["gpexe_total_distance", 3000, 3100, "changed"]]);

  const before = await allRowCounts();
  await withSwitchOn(async () => {
    for (const body of [{}, { acceptChanges: false }]) {
      const r = await approve(team, candidate, team.padmin.cookie, body);
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "changes_need_acceptance");
      assert.equal(r.body.changesToImported, 1);
    }
    assert.deepEqual(await allRowCounts(), before, "refused without acceptance: nothing written");
    assert.equal(await currentDistance(team.teamId, fullId), 3000);

    const ok = await approve(team, candidate, team.padmin.cookie, { acceptChanges: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.approval.changesAccepted, 1);
    assert.deepEqual(ok.body.import.counts, { corrected: 1, unchanged: candidate.preview.counts.unchanged });
    const [approval] = await approvalsOf(candidate.id);
    assert.deepEqual([approval.changes_to_imported, approval.changes_accepted], [1, true]);
    assert.equal(await currentDistance(team.teamId, fullId), 3100);
  });

  // Different values with the same report time are not a correction: they
  // are stored as a conflicting version for review, the current value
  // stays; that is a change to an imported result too, and it is listed.
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7105, updatedOn: "2026-09-15T08:00:00.000", distance101: 3200 })] }));
  await checkNow(team);
  const conflicting = await pendingCandidate(team);
  assert.equal(conflicting.changesToImported, 1);
  assert.deepEqual(
    [conflicting.preview.changesToImported[0].outcome, conflicting.preview.changesToImported[0].effect, conflicting.preview.changesToImported[0].newVersionBecomesCurrent],
    ["needs_review", "conflicting_version_flagged", false],
  );
});

test("approve: only an active platform admin or a coach with an active grant for the team; others are refused before anything is written", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7106 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  const other = await setupTeam();
  const before = await allRowCounts();

  await withSwitchOn(async () => {
    // The team's coach without a grant.
    const r1 = await approve(team, candidate, team.coach.cookie);
    assert.equal(r1.status, 403);
    assert.equal(r1.body.error, "not_an_approver");
    // Another team's coach, a malformed id, and this candidate through the
    // other team: the same 404 as a candidate that does not exist.
    assert.deepEqual(await approve(team, candidate, other.coach.cookie), { status: 404, body: { error: "notFound" } });
    assert.deepEqual(await api(`/teams/${team.teamId}/candidates/nope/approve`, { method: "POST", cookie: team.padmin.cookie, body: { previewHash: candidate.previewHash } }), { status: 404, body: { error: "notFound" } });
    assert.deepEqual(await approve(other, candidate, other.padmin.cookie), { status: 404, body: { error: "notFound" } });
    assert.deepEqual(await allRowCounts(), before);

    // A grant makes the coach an approver; revoked, it stops at once.
    const grant = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: team.coach.id, reason: "approves GPEXE imports" } });
    assert.equal(grant.status, 201);
    await api(`/teams/${team.teamId}/approvers/${grant.body.grant.id}/revoke`, { method: "POST", cookie: team.padmin.cookie, body: { reason: "test" } });
    assert.equal((await approve(team, candidate, team.coach.cookie)).status, 403);
    const regrant = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: team.coach.id, reason: "again" } });

    // A coach who no longer coaches the team keeps no right through the grant.
    await admin.query(`update public.user_team_roles set is_active = false where user_id = $1 and team_id = $2`, [team.coach.id, team.teamId]);
    const r3 = await approve(team, candidate, team.coach.cookie);
    assert.ok([403, 404].includes(r3.status), `refused (${r3.status})`);
    await admin.query(`update public.user_team_roles set is_active = true where user_id = $1 and team_id = $2`, [team.coach.id, team.teamId]);
    assert.deepEqual(await allRowCounts(), { ...before, "training_load.gpexe_import_approvers": before["training_load.gpexe_import_approvers"] + 2 });

    const ok = await approve(team, candidate, team.coach.cookie);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.approval.basis, "team_grant");
    const [approval] = await approvalsOf(candidate.id);
    assert.deepEqual([approval.approved_by_user_id, approval.approval_basis, approval.approver_grant_id], [team.coach.id, "team_grant", regrant.body.grant.id]);
  });
});

test("approve: two approvals of the same candidate at the same time import it once", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7107 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: team.coach.id, reason: "second approver" } });

  await withSwitchOn(async () => {
    // The first approval stops inside its transaction, holding the candidate;
    // the second one is sent and must wait for that lock.
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const inside = new Promise((resolve) => { entered = resolve; });
    let calls = 0;
    service.setApprovalObserver(async () => {
      calls += 1;
      if (calls === 1) {
        entered();
        await gate;
      }
    });
    const first = approve(team, candidate, team.padmin.cookie);
    await Promise.race([inside, first.then((r) => { throw new Error(`the first approval ended before its import ran: ${r.status} ${JSON.stringify(r.body)}`); })]);
    const second = approve(team, candidate, team.coach.cookie);
    // The first approval is always let go, even when an assertion fails,
    // so a failure can never leave the suite hanging.
    let waitedForCandidate = false;
    let results;
    try {
      for (let i = 0; i < 200 && !waitedForCandidate; i += 1) {
        waitedForCandidate = (await admin.query(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%gpexe_import_candidates%for update%'`,
        )).rows[0].n > 0;
        if (!waitedForCandidate) await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      release();
      results = await Promise.all([first, second]);
    }
    assert.ok(waitedForCandidate, "the second approval waited for the candidate row lock");
    assert.deepEqual(results.map((r) => r.status), [200, 409], JSON.stringify(results.map((r) => r.body)));
    assert.equal(results[1].body.error, "already_imported");
    assert.equal(calls, 1, "the second approval never ran the import");
    assert.equal((await approvalsOf(candidate.id)).length, 1);
    const rows = await writtenRows(team.teamId);
    assert.deepEqual([rows.events, rows.activities, rows.batches], [1, 1, 1]);
  });
});

test("approve: a blocked, superseded, expired or empty candidate is refused with the step to take, and nothing is written", async () => {
  await withSwitchOn(async () => {
    // Superseded: points at the newer candidate.
    const team = await setupTeam();
    service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7108 })] }));
    await checkNow(team);
    const old = await pendingCandidate(team);
    service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7108, distance101: 3333 })] }));
    await checkNow(team);
    const newer = await pendingCandidate(team);
    assert.notEqual(newer.id, old.id);
    const before = await allRowCounts();
    const s = await approve(team, old, team.padmin.cookie);
    assert.deepEqual([s.status, s.body.error, s.body.reviewAgain.candidateId], [409, "superseded_by_newer_data", newer.id]);

    // Expired snapshot: check again.
    await admin.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() - interval '1 minute' where id = $1`, [newer.id]);
    const e = await approve(team, newer, team.padmin.cookie);
    assert.deepEqual([e.status, e.body.error], [409, "snapshot_expired_check_again"]);
    assert.deepEqual(await allRowCounts(), before);

    // Blocked: an official match the importer does not take.
    const blockedTeam = await setupTeam();
    service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7109, category: "OFFICIAL MATCH" })] }));
    await checkNow(blockedTeam);
    const blockedSummary = (await api(`/teams/${blockedTeam.teamId}/candidates`, { cookie: blockedTeam.coach.cookie })).body.candidates[0];
    const blocked = (await api(`/teams/${blockedTeam.teamId}/candidates/${blockedSummary.id}`, { cookie: blockedTeam.coach.cookie })).body.candidate;
    const b = await approve(blockedTeam, blocked, blockedTeam.padmin.cookie);
    assert.deepEqual([b.status, b.body.error], [409, "blocked"]);

    // Nothing to import: everything was imported earlier the pilot way.
    const emptyTeam = await setupTeam();
    const bundle = sessionBundle({ sessionId: 7110 });
    const plan = buildGpexeImportPlan(bundle);
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      const linked = plan.participants.filter((p) => ["101", "102"].includes(p.gpexeAthleteId));
      await importGpexePlan(client, { ...plan, participants: linked }, {
        ownerTeamId: emptyTeam.teamId, performedByUserId: emptyTeam.userId, athleteIdByGpexeId: { 101: emptyTeam.ids.a, 102: emptyTeam.ids.b }, batchFilename: "earlier import",
      });
    } finally {
      await client.end();
    }
    service.setGpexeClientFactory(fakeGpexe({ bundles: [bundle] }));
    await checkNow(emptyTeam);
    const empty = await pendingCandidate(emptyTeam);
    assert.equal(empty.preview.status, "no_changes");
    const n = await approve(emptyTeam, empty, emptyTeam.padmin.cookie);
    assert.deepEqual([n.status, n.body.error], [409, "nothing_to_import"]);
  });
});

test("database: approvals are append-only, re-check the approver, and a candidate becomes imported only with its approval", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7111 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  const row = (await admin.query(`select gpexe_team_session_id, bundle_hash, preview_hash from training_load.gpexe_import_candidates where id = $1`, [candidate.id])).rows[0];
  const insert = (userId, basis, grantId, overrides = {}) => admin.query(
    `insert into training_load.gpexe_import_approvals
       (candidate_id, owner_team_id, gpexe_team_session_id, bundle_hash, preview_hash, approved_by_user_id, approval_basis,
        approver_grant_id, changes_to_imported, changes_accepted, metric_event_id, import_counts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,0,false,gen_random_uuid(),'{}')`,
    [candidate.id, team.teamId, row.gpexe_team_session_id, row.bundle_hash, overrides.previewHash ?? row.preview_hash, userId, basis, grantId],
  );
  const refused = async (promise, pattern, code) => {
    await assert.rejects(promise, (error) => {
      assert.match(error.message, pattern);
      if (code) assert.equal(error.code, code);
      return true;
    });
  };

  // No right, or a basis the user does not hold.
  await refused(insert(team.coach.id, "team_grant", null), /check constraint|may not approve/);
  await refused(insert(team.coach.id, "platform_admin", null), /may not approve GPEXE imports/, "42501");
  // Not the reviewed preview.
  await refused(insert(team.padmin.id, "platform_admin", null, { previewHash: "1".repeat(64) }), /does not match the candidate/);
  // A candidate never becomes imported without its approval.
  await refused(admin.query(`update training_load.gpexe_import_candidates set status = 'imported', imported_at = now() where id = $1`, [candidate.id]), /has no recorded approval/);

  await insert(team.padmin.id, "platform_admin", null);
  await refused(insert(team.padmin.id, "platform_admin", null), /duplicate key/);
  await refused(admin.query(`update training_load.gpexe_import_approvals set changes_accepted = true where candidate_id = $1`, [candidate.id]), /append-only/);
  await refused(admin.query(`delete from training_load.gpexe_import_approvals where candidate_id = $1`, [candidate.id]), /append-only/);
  await refused(admin.query(`truncate training_load.gpexe_import_approvals`), /TRUNCATE refused/);
  await refused(admin.query(`delete from training_load.gpexe_import_candidates where id = $1`, [candidate.id]), /violates foreign key|restrict/i);

  // Only a pending candidate: a blocked one is refused even with an approval.
  await admin.query(`update training_load.gpexe_import_candidates set status = 'blocked' where id = $1`, [candidate.id]);
  await refused(admin.query(`update training_load.gpexe_import_candidates set status = 'imported', imported_at = now() where id = $1`, [candidate.id]), /only a pending candidate/);
});

test("approve: a revoke sent while an approval is running waits for it; the approval stands on the right it held", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7112 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  const grant = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: team.coach.id, reason: "approver" } });
  assert.equal(grant.status, 201);

  await withSwitchOn(async () => {
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const inside = new Promise((resolve) => { entered = resolve; });
    service.setApprovalObserver(async () => {
      entered();
      await gate;
    });
    const approval = approve(team, candidate, team.coach.cookie);
    await Promise.race([inside, approval.then((r) => { throw new Error(`the approval ended before its import ran: ${r.status} ${JSON.stringify(r.body)}`); })]);
    const revoke = api(`/teams/${team.teamId}/approvers/${grant.body.grant.id}/revoke`, { method: "POST", cookie: team.padmin.cookie, body: { reason: "revoked mid-approval" } });
    let revokeWaited = false;
    let results;
    try {
      for (let i = 0; i < 200 && !revokeWaited; i += 1) {
        revokeWaited = (await admin.query(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%update training_load.gpexe_import_approvers%'`,
        )).rows[0].n > 0;
        if (!revokeWaited) await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      release();
      results = await Promise.all([approval, revoke]);
    }
    assert.ok(revokeWaited, "the revoke waited for the approval holding the grant");
    assert.deepEqual(results.map((r) => r.status), [200, 200], JSON.stringify(results.map((r) => r.body)));
    const row = (await admin.query(
      `select a.approved_at, g.revoked_at from training_load.gpexe_import_approvals a
         join training_load.gpexe_import_approvers g on g.id = a.approver_grant_id where a.candidate_id = $1`, [candidate.id])).rows[0];
    assert.ok(row.approved_at < row.revoked_at, "the approval came first, on the right it held");
  });
});

test("approve: values added to an imported result and a GPEXE resend next to a manual correction are listed and need acceptance too", async () => {
  const team = await setupTeam();
  // First import: burst/brake details only for drill 0.
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7113, detailsDrills: [0] })] }));
  await checkNow(team);
  await withSwitchOn(async () => {
    assert.equal((await approve(team, await pendingCandidate(team), team.padmin.cookie)).status, 200);
  });

  // GPEXE now also has drill 1's details: values are ADDED to results that
  // were imported before, the existing values stay the same.
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7113, detailsDrills: [0, 1] })] }));
  await checkNow(team);
  const supplemented = await pendingCandidate(team);
  assert.ok(supplemented.changesToImported > 0);
  for (const change of supplemented.preview.changesToImported) {
    assert.deepEqual([change.outcome, change.effect, change.newVersionBecomesCurrent, change.level, change.drillIndex], ["supplemented", "adds_values_to_imported_result", true, "drill", 1]);
    assert.deepEqual(change.values.map((v) => [v.metricKey, v.previous, v.change]).sort(), [["gpexe_brake_events", null, "added"], ["gpexe_burst_events", null, "added"]]);
  }
  await withSwitchOn(async () => {
    const refused = await approve(team, supplemented, team.padmin.cookie);
    assert.deepEqual([refused.status, refused.body.error, refused.body.changesToImported], [409, "changes_need_acceptance", supplemented.changesToImported]);
    const ok = await approve(team, supplemented, team.padmin.cookie, { acceptChanges: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.import.counts.supplemented, supplemented.changesToImported);
  });

  // A coach corrects 101's whole-session values by hand. A later, different
  // GPEXE version never replaces a manual correction: it is stored flagged,
  // and that too is listed as a change to accept.
  const identity = (await admin.query(
    `select si.id, si.current_occasion_id, si.source_external_id from training_load.metric_source_identities si
       join training_load.metric_source_connections c on c.id = si.source_connection_id
      where c.owner_team_id = $1 and si.source_external_id like 'athlete_session:%:full'
        and exists (select 1 from training_load.metric_values v join training_load.metric_definitions d on d.id = v.metric_definition_id
                     where v.occasion_id = si.current_occasion_id and d.key = 'gpexe_total_distance' and v.value_numeric = 3000)
      order by si.source_external_id limit 1`, [team.teamId])).rows[0];
  const values = (await admin.query(
    `select metric_definition_id, metric_definition_version_id, value_numeric::float8 as value from training_load.metric_values where occasion_id = $1`,
    [identity.current_occasion_id],
  )).rows.map((v) => ({ metricDefinitionId: v.metric_definition_id, metricDefinitionVersionId: v.metric_definition_version_id, value: v.value }));
  const { correctImportedOccasionManually } = await import("../src/trainingLoadMetricsMeasurements.js");
  const req = { user: { id: team.coach.id }, authz: { platformRoles: [], clubRoles: [], teamRoles: [{ role: "team_coach", teamId: team.teamId }], managedTeamIds: [] } };
  const scope = { type: "team", teamId: team.teamId, ownerContext: { ownerScope: "team", ownerTeamId: team.teamId, ownerClubId: null, ownerUserId: null } };
  const manual = await correctImportedOccasionManually(req, scope, { requestKey: `manual-${team.teamId}`, sourceIdentityId: identity.id, expectedCurrentOccasionId: identity.current_occasion_id, values });
  assert.equal(manual.error, undefined, JSON.stringify(manual));

  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7113, detailsDrills: [0, 1], updatedOn: "2026-09-15T08:00:00.000", distance101: 3100 })] }));
  await checkNow(team);
  const resend = await pendingCandidate(team);
  const [change] = resend.preview.changesToImported;
  assert.equal(resend.changesToImported, 1);
  assert.deepEqual(
    [change.externalId, change.outcome, change.effect, change.newVersionBecomesCurrent, change.manualCorrectionKept],
    [identity.source_external_id, "stale_resend_ignored", "older_or_manual_version_flagged", false, true],
  );
  await withSwitchOn(async () => {
    assert.equal((await approve(team, resend, team.padmin.cookie)).body.error, "changes_need_acceptance");
    assert.equal((await approve(team, resend, team.padmin.cookie, { acceptChanges: true })).status, 200);
  });
  assert.equal(await currentDistance(team.teamId, identity.source_external_id), 3000, "the manual correction stays current");
});

test("preview: every importer outcome on an imported result has an acceptance rule, and an unknown one stops the preview", async () => {
  const { changeToImportedRule } = await import("../src/gpexeImportPreview.js");
  assert.equal(changeToImportedRule("unchanged"), null);
  assert.equal(changeToImportedRule("needs_review_already_recorded"), null);
  assert.equal(changeToImportedRule("stale_resend_ignored_already_recorded"), null);
  for (const outcome of ["corrected", "supplemented", "needs_review", "stale_resend_ignored"]) assert.ok(changeToImportedRule(outcome).effect, outcome);
  assert.throws(() => changeToImportedRule("rewritten"), /no acceptance rule/);
});

test("approve: stored GPEXE data the importer can no longer take blocks the candidate with the reason, and nothing is written", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7114 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  // As if the mapper's rules changed between the check and the approval.
  await admin.query(`update training_load.gpexe_import_candidates set raw_bundle = jsonb_set(raw_bundle, '{teamSession,category_name}', '"OFFICIAL MATCH"') where id = $1`, [candidate.id]);
  const before = await allRowCounts();
  await withSwitchOn(async () => {
    const r = await approve(team, candidate, team.padmin.cookie);
    assert.deepEqual([r.status, r.body.error, r.body.reviewAgain.candidateId], [409, "preview_changed", candidate.id]);
  });
  assert.deepEqual(await allRowCounts(), before);
  const again = (await api(`/teams/${team.teamId}/candidates/${candidate.id}`, { cookie: team.coach.cookie })).body.candidate;
  assert.equal(again.status, "blocked", "the next review shows why, instead of leading back to the same refusal");
  assert.notEqual(again.previewHash, candidate.previewHash);
  assert.ok(again.preview.blocked.code);
});

test("approve: deactivating the approver while an approval is running waits for it", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7115 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  await withSwitchOn(async () => {
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const inside = new Promise((resolve) => { entered = resolve; });
    service.setApprovalObserver(async () => {
      entered();
      await gate;
    });
    const approval = approve(team, candidate, team.padmin.cookie);
    await Promise.race([inside, approval.then((r) => { throw new Error(`the approval ended before its import ran: ${r.status} ${JSON.stringify(r.body)}`); })]);
    const other = new pg.Client({ connectionString: db.url });
    await other.connect();
    let waited = false;
    let results;
    try {
      const deactivate = other.query(`update public.users set is_active = false where id = $1`, [team.padmin.id]);
      try {
        for (let i = 0; i < 200 && !waited; i += 1) {
          waited = (await admin.query(
            `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike 'update public.users set is_active = false%'`,
          )).rows[0].n > 0;
          if (!waited) await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        release();
        results = await Promise.all([approval, deactivate]);
      }
    } finally {
      await other.end();
    }
    assert.ok(waited, "the deactivation waited for the approval holding the user row");
    assert.equal(results[0].status, 200, JSON.stringify(results[0].body));
  });
  await admin.query(`update public.users set is_active = true where id = $1`, [team.padmin.id]);
});

test("database: a candidate is never inserted as imported, and an approval must carry the preview's own number of changes", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7116 })] }));
  const check = await checkNow(team);
  await assert.rejects(admin.query(
    `insert into training_load.gpexe_import_candidates
       (owner_team_id, gpexe_team_session_id, bundle_hash, raw_bundle, raw_expires_at, status, imported_at, preview, preview_hash, preview_computed_at, first_seen_check_id, last_seen_check_id)
     values ($1, '99', repeat('a', 64), '{}', now() + interval '1 day', 'imported', now(), '{}', repeat('b', 64), now(), $2, $2)`,
    [team.teamId, check.id]), /never inserted as imported/);

  const candidate = await pendingCandidate(team);
  const row = (await admin.query(`select gpexe_team_session_id, bundle_hash, preview_hash from training_load.gpexe_import_candidates where id = $1`, [candidate.id])).rows[0];
  await assert.rejects(admin.query(
    `insert into training_load.gpexe_import_approvals
       (candidate_id, owner_team_id, gpexe_team_session_id, bundle_hash, preview_hash, approved_by_user_id, approval_basis,
        approver_grant_id, changes_to_imported, changes_accepted, metric_event_id, import_counts)
     values ($1,$2,$3,$4,$5,$6,'platform_admin',null,1,true,gen_random_uuid(),'{}')`,
    [candidate.id, team.teamId, row.gpexe_team_session_id, row.bundle_hash, row.preview_hash, team.padmin.id]), /changes_to_imported does not match/);
});

// ---------------------------------------------------------------------------
// External review of f8ecab2: an unconfirmed COMMIT, and a failed read of the
// candidate after a committed import, must never hide or deny an import.
// ---------------------------------------------------------------------------

async function withCommitReplaced(commit, fn, options) {
  service.setApprovalCommitForTests(commit, options);
  try {
    return await fn();
  } finally {
    service.setApprovalCommitForTests(null);
  }
}

test("approve: the COMMIT went through but its answer was lost — the answer says imported, verified, never 'nothing was imported'", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7201 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  await withSwitchOn(() => withCommitReplaced(async (client) => {
    await client.query("commit");
    throw new Error("Connection terminated unexpectedly");
  }, async () => {
    const r = await approve(team, candidate, team.padmin.cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outcome, "imported");
    assert.equal(r.body.commitConfirmation, "verified_after_commit_error");
    assert.ok(!/nothing was imported/i.test(JSON.stringify(r.body)));
    assert.equal(r.body.candidate.status, "imported");
    assert.equal(r.body.candidate.approval.id, r.body.approval.id, "the candidate names the approval that imported it");

    const [approval] = await approvalsOf(candidate.id);
    assert.equal(approval.id, r.body.approval.id);
    const rows = await writtenRows(team.teamId);
    assert.deepEqual([rows.events, rows.activities], [1, 1]);
    const byId = await api(`/teams/${team.teamId}/approvals/${approval.id}`, { cookie: team.coach.cookie });
    assert.equal(byId.status, 200);
    assert.deepEqual([byId.body.approval.candidateId, byId.body.approval.import.eventId], [candidate.id, r.body.import.eventId]);
  }));
});

test("approve: the COMMIT was never confirmed and the import is not there — 503 import_outcome_unknown with how to check, and approving again is safe", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7202 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  const before = await allRowCounts();
  let approvalId;
  await withSwitchOn(() => withCommitReplaced(async (client) => {
    // The connection is lost before the server commits: the transaction ends
    // without its rows.
    await client.query("rollback");
    throw new Error("Connection terminated unexpectedly");
  }, async () => {
    const r = await approve(team, candidate, team.padmin.cookie);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "import_outcome_unknown");
    assert.ok(!/nothing was imported/i.test(JSON.stringify(r.body)), "an unconfirmed COMMIT is never reported as nothing imported");
    assert.match(r.body.message, /may or may not have been imported/);
    const { verify } = r.body;
    approvalId = verify.approvalId;
    assert.equal(verify.candidateId, candidate.id);
    assert.equal(verify.candidateHref, `/api/training-load/gpexe/teams/${team.teamId}/candidates/${candidate.id}`);
    assert.equal(verify.approvalHref, `/api/training-load/gpexe/teams/${team.teamId}/approvals/${verify.approvalId}`);
    assert.ok(verify.imported && verify.notImported && verify.retry);
  }));

  // Following the steps: no approval, candidate still pending — not imported.
  assert.deepEqual(await api(`/teams/${team.teamId}/approvals/${approvalId}`, { cookie: team.coach.cookie }), { status: 404, body: { error: "notFound" } });
  const after = (await api(`/teams/${team.teamId}/candidates/${candidate.id}`, { cookie: team.coach.cookie })).body.candidate;
  assert.deepEqual([after.status, after.approval], ["pending", null]);
  assert.deepEqual(await allRowCounts(), before);

  // Approving again is safe and imports it once.
  await withSwitchOn(async () => {
    const again = await approve(team, candidate, team.padmin.cookie);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.commitConfirmation, "confirmed");
    assert.equal((await approve(team, candidate, team.padmin.cookie)).body.error, "already_imported");
  });
  assert.equal((await approvalsOf(candidate.id)).length, 1);
});

test("approve: reading the candidate after a committed import fails — the answer still says imported, with the approval and the write report", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7203 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  await withSwitchOn(async () => {
    service.setCandidateReadFaultForTests((id) => {
      if (id === candidate.id) throw new Error("read failed");
    });
    let r;
    try {
      r = await approve(team, candidate, team.padmin.cookie);
    } finally {
      service.setCandidateReadFaultForTests(null);
    }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outcome, "imported");
    assert.equal(r.body.commitConfirmation, "confirmed");
    assert.ok(r.body.approval.id && r.body.import.eventId);
    assert.equal(r.body.candidate, null);
    assert.deepEqual(Object.keys(r.body.candidateReadError).sort(), ["candidateHref", "error", "message"]);
    assert.equal(r.body.candidateReadError.error, "candidate_read_failed");
    assert.match(r.body.candidateReadError.message, /import was committed/);
    assert.ok(!/read failed/.test(JSON.stringify(r.body)), "the underlying error text is not sent");
  });
  const [approval] = await approvalsOf(candidate.id);
  assert.equal(approval.metric_event_id, (await admin.query(`select id from training_load.metric_events where owner_team_id = $1`, [team.teamId])).rows[0].id);
  assert.equal((await candidateRow(candidate.id)).status, "imported");
});

test("approvals by id: another team's approval and a malformed id are the same 404 as a missing one", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7204 })] }));
  await checkNow(team);
  const approvalId = await withSwitchOn(async () => (await approve(team, await pendingCandidate(team), team.padmin.cookie)).body.approval.id);
  const other = await setupTeam();
  const notFound = { status: 404, body: { error: "notFound" } };
  assert.deepEqual(await api(`/teams/${other.teamId}/approvals/${approvalId}`, { cookie: other.coach.cookie }), notFound);
  assert.deepEqual(await api(`/teams/${team.teamId}/approvals/${approvalId}`, { cookie: other.coach.cookie }), notFound);
  assert.deepEqual(await api(`/teams/${team.teamId}/approvals/nope`, { cookie: team.coach.cookie }), notFound);
  assert.equal((await api(`/teams/${team.teamId}/approvals/${approvalId}`, { cookie: team.coach.cookie })).status, 200);
});

// Which pooled connection the approval used, and whether the pool dropped it.
async function approvalConnectionFate(fn) {
  let used = null;
  service.setApprovalObserver(({ client }) => { used = client; });
  const removed = new Set();
  const onRemove = (client) => removed.add(client);
  appPool.on("remove", onRemove);
  try {
    const result = await fn();
    assert.ok(used, "the approval reached its import");
    // The pool emits "remove" only once the dropped connection has closed,
    // which can be after the HTTP answer: wait for it (a kept connection
    // waits the whole time and stays kept).
    for (let i = 0; i < 75 && !removed.has(used); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    return { result, dropped: removed.has(used) };
  } finally {
    appPool.off("remove", onRemove);
    service.setApprovalObserver(null);
  }
}

test("approve: after a confirmed COMMIT the connection goes back to the pool; only an unconfirmed one is dropped", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7205 }), sessionBundle({ sessionId: 7206 })] }));
  await checkNow(team);
  const [first, second] = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  const detail = async (id) => (await api(`/teams/${team.teamId}/candidates/${id}`, { cookie: team.coach.cookie })).body.candidate;
  await withSwitchOn(async () => {
    const ok = await approvalConnectionFate(async () => approve(team, await detail(first.id), team.padmin.cookie));
    assert.equal(ok.result.status, 200);
    assert.equal(ok.result.body.commitConfirmation, "confirmed");
    assert.equal(ok.dropped, false, "a confirmed COMMIT keeps the connection in the pool");

    const lost = await withCommitReplaced(async (client) => {
      await client.query("commit");
      throw new Error("Connection terminated unexpectedly");
    }, () => approvalConnectionFate(async () => approve(team, await detail(second.id), team.padmin.cookie)));
    assert.equal(lost.result.body.commitConfirmation, "verified_after_commit_error");
    assert.equal(lost.dropped, true, "a connection whose COMMIT went unanswered is not reused");
  });
});

test("approve: the COMMIT went unconfirmed and the check fails or hangs — 503 import_outcome_unknown in bounded time, never 'nothing was imported'", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7207 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  const lostAnswer = async (client) => {
    await client.query("commit");
    throw new Error("Connection terminated unexpectedly");
  };
  await withSwitchOn(() => withCommitReplaced(lostAnswer, async () => {
    try {
      // The check itself fails (the database is unreachable).
      service.setUncertainCommitCheckForTests({ fault: () => { throw new Error("db down"); } });
      const failed = await approve(team, candidate, team.padmin.cookie);
      assert.deepEqual([failed.status, failed.body.error], [503, "import_outcome_unknown"], JSON.stringify(failed.body));
      assert.ok(failed.body.verify.approvalHref);
      assert.ok(!/nothing was imported|db down/i.test(JSON.stringify(failed.body)));
      // Here the COMMIT did go through: the steps in verify find it.
      assert.equal((await api(failed.body.verify.approvalHref.replace("/api/training-load/gpexe", ""), { cookie: team.coach.cookie })).status, 200);
      assert.equal((await api(failed.body.verify.candidateHref.replace("/api/training-load/gpexe", ""), { cookie: team.coach.cookie })).body.candidate.status, "imported");
    } finally {
      service.setUncertainCommitCheckForTests();
    }
  }));

  const team2 = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7208 })] }));
  await checkNow(team2);
  const candidate2 = await pendingCandidate(team2);
  await withSwitchOn(() => withCommitReplaced(lostAnswer, async () => {
    try {
      // The check's own query never answers (a real stuck query on its
      // connection): the bound ends it, and that connection is not left
      // occupying the pool.
      service.setUncertainCommitCheckForTests({ fault: (client) => client.query("select pg_sleep(30)"), timeoutMs: 500 });
      const started = Date.now();
      const hung = await approve(team2, candidate2, team2.padmin.cookie);
      assert.deepEqual([hung.status, hung.body.error], [503, "import_outcome_unknown"], JSON.stringify(hung.body));
      assert.ok(Date.now() - started < 5_000, `answered within the bound (${Date.now() - started} ms)`);
      assert.ok(!/nothing was imported/i.test(JSON.stringify(hung.body)));
      let inUse = Infinity;
      for (let i = 0; i < 100 && inUse > 0; i += 1) {
        inUse = appPool.totalCount - appPool.idleCount;
        if (inUse > 0) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(inUse, 0, "no pool connection is left held by the stuck check");
      assert.equal(appPool.waitingCount, 0);
    } finally {
      service.setUncertainCommitCheckForTests();
    }
  }));
});

// Narrow external review of a89e244: a COMMIT whose answer never comes.
async function poolSettled() {
  let inUse = Infinity;
  let openTx = Infinity;
  for (let i = 0; i < 150 && (inUse > 0 || openTx > 0); i += 1) {
    inUse = appPool.totalCount - appPool.idleCount;
    openTx = (await admin.query(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`,
    )).rows[0].n;
    if (inUse > 0 || openTx > 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { inUse, openTx, waiting: appPool.waitingCount };
}

test("approve: a COMMIT that never answers is bounded — the request ends, the connection is closed, and without a commit the answer is import_outcome_unknown", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7209 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  const before = await allRowCounts();
  await withSwitchOn(async () => {
    // The COMMIT is "sent" but its promise never settles, and it never
    // reached the server.
    const fate = await withCommitReplaced(() => new Promise(() => {}), () => approvalConnectionFate(async () => {
      const started = Date.now();
      const r = await approve(team, candidate, team.padmin.cookie);
      return { r, ms: Date.now() - started };
    }), { timeoutMs: 400 });
    const { r, ms } = fate.result;
    assert.ok(ms < 8_000, `the request ended (${ms} ms)`);
    assert.deepEqual([r.status, r.body.error], [503, "import_outcome_unknown"], JSON.stringify(r.body));
    assert.ok(!/nothing was imported/i.test(JSON.stringify(r.body)));
    assert.equal(r.body.verify.candidateId, candidate.id);
    assert.equal(fate.dropped, true, "the connection whose COMMIT never answered is closed, not returned to the pool");
  });
  assert.deepEqual(await poolSettled(), { inUse: 0, openTx: 0, waiting: 0 }, "no pool connection held and no transaction left open");
  // Following verify: not imported. Nothing of it remains, and approving
  // again (the candidate row is no longer locked) imports it once.
  assert.equal((await api(`/teams/${team.teamId}/candidates/${candidate.id}`, { cookie: team.coach.cookie })).body.candidate.status, "pending");
  assert.deepEqual(await allRowCounts(), before);
  await withSwitchOn(async () => {
    const again = await approve(team, candidate, team.padmin.cookie);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.commitConfirmation, "confirmed");
  });
  assert.equal((await approvalsOf(candidate.id)).length, 1);
});

test("approve: the COMMIT went through but its answer never comes — bounded, the connection is closed, and the answer is the verified import", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7210 })] }));
  await checkNow(team);
  const candidate = await pendingCandidate(team);
  await withSwitchOn(async () => {
    let commitClient = null;
    // The unreliable connection is closed BEFORE the check runs: by the time
    // the check starts, it can no longer be used. Otherwise the check throws
    // and the answer would be 503.
    service.setUncertainCommitCheckForTests({
      fault: async () => { await assert.rejects(commitClient.query("select 1")); },
    });
    let fate;
    try {
      fate = await withCommitReplaced(async (client) => {
        commitClient = client;
        await client.query("commit");
        return new Promise(() => {}); // the answer never arrives
      }, () => approvalConnectionFate(async () => {
        const started = Date.now();
        const r = await approve(team, candidate, team.padmin.cookie);
        return { r, ms: Date.now() - started };
      }), { timeoutMs: 400 });
    } finally {
      service.setUncertainCommitCheckForTests();
    }
    const { r, ms } = fate.result;
    assert.ok(ms < 8_000, `the request ended (${ms} ms)`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.outcome, r.body.commitConfirmation], ["imported", "verified_after_commit_error"]);
    assert.equal(r.body.candidate.approval.id, r.body.approval.id);
    assert.equal(fate.dropped, true);
  });
  assert.deepEqual(await poolSettled(), { inUse: 0, openTx: 0, waiting: 0 });
  assert.equal((await approvalsOf(candidate.id)).length, 1);
  assert.equal((await writtenRows(team.teamId)).events, 1);
});

// ---------------------------------------------------------------------------
// Imports phase 2b: the list carries the reasons the inbox needs for its
// four buckets, from the same query it already runs.
// ---------------------------------------------------------------------------

// Every SQL statement the server runs while `fn` runs: through pool.query
// and through a checked-out client (pool.connect) alike.
async function countQueries(fn) {
  const originalQuery = appPool.query;
  const originalConnect = appPool.connect;
  let n = 0;
  appPool.query = function counted(...args) {
    n += 1;
    return originalQuery.apply(this, args);
  };
  appPool.connect = function countedConnect(cb) {
    // pool.query itself connects with a callback; that path is already
    // counted at pool.query. Only a client handed out as a promise is spied.
    if (typeof cb === "function") return originalConnect.call(this, cb);
    return originalConnect.call(this).then((client) => {
      const clientQuery = client.query;
      client.query = function countedClientQuery(...qargs) {
        n += 1;
        return clientQuery.apply(this, qargs);
      };
      const release = client.release;
      client.release = function restoringRelease(...rargs) {
        client.query = clientQuery;
        client.release = release;
        return release.apply(this, rargs);
      };
      return client;
    });
  };
  try {
    await fn();
  } finally {
    appPool.query = originalQuery;
    appPool.connect = originalConnect;
  }
  return n;
}

test("countQueries (test helper): a query through a checked-out client is counted too", async () => {
  const n = await countQueries(async () => {
    const client = await appPool.connect();
    try {
      await client.query("select 1");
    } finally {
      client.release();
    }
  });
  assert.equal(n, 1);
});

test("candidates list: blocked code and reasons come with the list, and the list runs the same number of queries for one candidate as for several", async () => {
  const team = await setupTeam();
  // One session first: 101 and 102 linked and measured, 104 unlinked, 103 on
  // two tracks, 105 marked invalid.
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7201 })] }));
  await checkNow(team);
  const one = await countQueries(async () => {
    const r = await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.candidates.length, 1);
  });

  // Then a match (blocked, stays out), a session in which nobody is linked
  // (only athlete 104 recorded) and a session GPEXE marks invalid.
  const [, a102] = standardAthletes();
  const only104 = makeBundle({ sessionId: 7202, gpexeTeamId: 77, athletes: [{ ...structuredClone(a102), id: 104, tracks: [9105] }] });
  const invalid = sessionBundle({ sessionId: 7204 });
  invalid.teamSession.is_stats_valid = false;
  service.setGpexeClientFactory(fakeGpexe({ bundles: [
    sessionBundle({ sessionId: 7201 }), sessionBundle({ sessionId: 7203, category: "OFFICIAL MATCH" }), only104, invalid,
  ] }));
  await checkNow(team);

  let list;
  const several = await countQueries(async () => {
    const r = await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie });
    assert.equal(r.status, 200);
    list = r.body.candidates;
  });
  assert.equal(list.length, 4);
  assert.equal(several, one, `the list must not read per candidate (one candidate: ${one} queries, four: ${several})`);

  const by = Object.fromEntries(list.map((c) => [c.gpexeTeamSessionId, c]));
  assert.deepEqual([by["7201"].status, by["7201"].blockedCode, by["7201"].reasons.map((r) => r.code)],
    ["pending", null, ["athletes_not_linked", "athletes_need_manual_review", "athletes_marked_invalid_by_source"]]);
  assert.deepEqual([by["7203"].status, by["7203"].blockedCode, by["7203"].blockedSourceCode, by["7203"].sessionType, by["7203"].reasons],
    ["blocked", "unsupported_session_type", "unsupported_category", "OFFICIAL MATCH", []]);
  assert.deepEqual([by["7202"].status, by["7202"].previewStatus, by["7202"].blockedCode, by["7202"].reasons],
    ["pending", "no_changes", null, [{ code: "no_linked_athlete", count: 1 }]]);
  assert.deepEqual([by["7204"].status, by["7204"].blockedCode, by["7204"].blockedSourceCode],
    ["blocked", "source_marks_session_invalid", "session_stats_invalid"]);
  // No server sentence rides on the list: the coach's words are the app's.
  for (const c of list) {
    assert.equal(c.preview, undefined);
    assert.ok(!("blockedMessage" in c) && !("message" in c), c.gpexeTeamSessionId);
    assert.ok(Array.isArray(c.reasons));
  }
});

// ---------------------------------------------------------------------------
// Imports phase 3a: the team's source athletes, read-only, from stored data.
// ---------------------------------------------------------------------------

async function sourceAthletes(team, cookie = team.coach.cookie) {
  const r = await api(`/teams/${team.teamId}/source-athletes`, { cookie });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test("source athletes: once each, with status, the link's name only, a deterministic last sighting and helper values; a value the source did not give is null", async () => {
  const team = await setupTeam();
  // A GPEXE athlete linked before any check ever saw them.
  assert.equal((await api(`/teams/${team.teamId}/athlete-links`, { method: "POST", cookie: team.coach.cookie, body: { gpexeAthleteId: "199", athleteId: team.ids.d } })).status, 201);
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7301 })] }));
  await checkNow(team);
  const body = await sourceAthletes(team);
  assert.deepEqual(body.units, { duration: "min", distance: "m", maxSpeed: "km/h" });
  assert.match(body.lastSeenRule, /newest session date/);
  assert.deepEqual(body.athletes.map((a) => a.gpexeAthleteId), ["101", "102", "103", "104", "105", "199"], "once each, in id order");

  const by = Object.fromEntries(body.athletes.map((a) => [a.gpexeAthleteId, a]));
  const [candidate] = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  const detail = (await api(`/teams/${team.teamId}/candidates/${candidate.id}`, { cookie: team.coach.cookie })).body.candidate;
  const stored = Object.fromEntries(detail.preview.athletes.map((a) => [a.gpexeAthleteId, a]));
  const storedValue = (gpexeId, key) => stored[gpexeId].results.find((r) => r.level === "full").values.find((v) => v.metricKey === key).value;

  // Linked and measured: the link, the OptiMove name from it, the session, the values.
  assert.equal(by["101"].status, "linked");
  assert.deepEqual([by["101"].link.athleteId, by["101"].link.athleteName], [team.ids.a, "A101"]);
  assert.deepEqual([by["101"].lastSeen.candidateId, by["101"].lastSeen.gpexeTeamSessionId, by["101"].lastSeen.candidateStatus], [candidate.id, "7301", "pending"]);
  assert.equal(by["101"].lastSeen.sessionStartedAt, candidate.sessionStartedAt);
  assert.deepEqual(by["101"].values, {
    duration: storedValue("101", "gpexe_time_min"), distance: storedValue("101", "gpexe_total_distance"), maxSpeed: storedValue("101", "gpexe_max_speed"),
  });
  assert.deepEqual([by["101"].lastSeen.evidence, by["101"].lastSeen.sessionDrillsCount], ["preview", 2], "the drill count is the session's, next to the sighting");
  assert.equal(by["101"].values.distance, 3000);
  assert.equal(by["101"].values.duration, 40);

  // Recorded but not linked: no link, no name anywhere, values still there.
  assert.equal(by["104"].status, "unlinked");
  assert.equal(by["104"].link, null);
  assert.equal(by["104"].values.distance, storedValue("104", "gpexe_total_distance"));
  assert.equal(by["104"].lastSeen.candidateId, candidate.id);

  // Two tracks / invalid statistics: linked, seen, but the source gave no
  // whole-session value the preview could keep - null, never 0. The drill
  // count is the session's own field.
  for (const id of ["103", "105"]) {
    assert.equal(by[id].status, "linked", id);
    assert.equal(by[id].lastSeen.candidateId, candidate.id, id);
    assert.deepEqual(by[id].values, { duration: null, distance: null, maxSpeed: null }, id);
    assert.equal(by[id].lastSeen.sessionDrillsCount, 2, id);
  }

  // Linked, never seen: the link, nothing else.
  assert.equal(by["199"].status, "linked");
  assert.equal(by["199"].link.athleteId, team.ids.d);
  assert.equal(by["199"].lastSeen, null);
  assert.deepEqual(by["199"].values, { duration: null, distance: null, maxSpeed: null });

  // No GPEXE name field exists, and no OptiMove name outside a link.
  const text = JSON.stringify(body.athletes);
  assert.ok(!/"name"|gpexeName|athlete_name|"E"|"D"/.test(text.replace(/"athleteName":"[^"]*"/g, "")), "names only inside link.athleteName");
  for (const a of body.athletes) assert.deepEqual(Object.keys(a).sort(), ["gpexeAthleteId", "lastSeen", "link", "status", "values"]);
});

test("source athletes: the last sighting is the newest session date; on the same date a current version beats a replaced one", async () => {
  const team = await setupTeam();
  const older = makeBundle({ sessionId: 7302, gpexeTeamId: 77, start: "2026-09-10T18:00:00", athletes: sessionAthletes() });
  const newer = makeBundle({ sessionId: 7303, gpexeTeamId: 77, start: "2026-09-12T18:00:00", athletes: sessionAthletes() });
  // The fake lists the newer session first: the order GPEXE answers in must not matter.
  service.setGpexeClientFactory(fakeGpexe({ bundles: [newer, older] }));
  await checkNow(team);
  let by = Object.fromEntries((await sourceAthletes(team)).athletes.map((a) => [a.gpexeAthleteId, a]));
  assert.equal(by["101"].lastSeen.gpexeTeamSessionId, "7303");
  assert.equal(by["104"].lastSeen.gpexeTeamSessionId, "7303");

  // A later check sees only the older session again: the newer date still wins.
  service.setGpexeClientFactory(fakeGpexe({ bundles: [older] }));
  await checkNow(team);
  by = Object.fromEntries((await sourceAthletes(team)).athletes.map((a) => [a.gpexeAthleteId, a]));
  assert.equal(by["101"].lastSeen.gpexeTeamSessionId, "7303");

  // The newer session changes content: its old candidate is replaced, and
  // the sighting is the current version (same date, same session).
  const changed = makeBundle({ sessionId: 7303, gpexeTeamId: 77, start: "2026-09-12T18:00:00", athletes: sessionAthletes({ distance101: 3333 }) });
  service.setGpexeClientFactory(fakeGpexe({ bundles: [changed] }));
  await checkNow(team);
  const all = (await api(`/teams/${team.teamId}/candidates?includeSuperseded=true`, { cookie: team.coach.cookie })).body.candidates;
  const current = all.find((c) => c.gpexeTeamSessionId === "7303" && c.status !== "superseded");
  const replaced = all.find((c) => c.gpexeTeamSessionId === "7303" && c.status === "superseded");
  assert.ok(current && replaced);
  by = Object.fromEntries((await sourceAthletes(team)).athletes.map((a) => [a.gpexeAthleteId, a]));
  assert.deepEqual([by["101"].lastSeen.candidateId, by["101"].lastSeen.candidateStatus, by["101"].values.distance], [current.id, "pending", 3333]);
  assert.equal((await sourceAthletes(team)).athletes.filter((a) => a.gpexeAthleteId === "101").length, 1, "still once");

  // A purged snapshot is no sighting any more: the next available one is.
  await admin.query(`update training_load.gpexe_import_candidates set raw_bundle = null, preview = null, raw_purged_at = now() where id = $1`, [current.id]);
  await admin.query(`update training_load.gpexe_import_candidates set raw_bundle = null, preview = null, raw_purged_at = now() where id = $1`, [replaced.id]);
  by = Object.fromEntries((await sourceAthletes(team)).athletes.map((a) => [a.gpexeAthleteId, a]));
  assert.equal(by["101"].lastSeen.gpexeTeamSessionId, "7302");
});

test("source athletes: an expired but not yet purged snapshot is no sighting (the app's retention rule), and a raw drill count that is not a plain integer is null", async () => {
  const team = await setupTeam();
  const older = makeBundle({ sessionId: 7313, gpexeTeamId: 77, start: "2026-09-10T18:00:00", athletes: sessionAthletes() });
  const newer = makeBundle({ sessionId: 7314, gpexeTeamId: 77, start: "2026-09-12T18:00:00", athletes: sessionAthletes() });
  service.setGpexeClientFactory(fakeGpexe({ bundles: [older, newer] }));
  await checkNow(team);
  let by = Object.fromEntries((await sourceAthletes(team)).athletes.map((a) => [a.gpexeAthleteId, a]));
  assert.equal(by["101"].lastSeen.gpexeTeamSessionId, "7314");

  // The newer snapshot's 30 days are over, the purge has not run: for the
  // app it is gone (GET candidates/:id shows no preview), so it is no
  // sighting here either.
  await admin.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() - interval '1 minute' where owner_team_id = $1 and gpexe_team_session_id = '7314'`, [team.teamId]);
  const expired = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates.find((c) => c.gpexeTeamSessionId === "7314");
  assert.equal(expired.snapshot.available, false);
  by = Object.fromEntries((await sourceAthletes(team)).athletes.map((a) => [a.gpexeAthleteId, a]));
  assert.equal(by["101"].lastSeen.gpexeTeamSessionId, "7313");

  // A degenerate raw drills_count (empty text) is null, not 0.
  await admin.query(`update training_load.gpexe_import_candidates set raw_bundle = jsonb_set(raw_bundle, '{teamSession,drills_count}', '""') where owner_team_id = $1 and gpexe_team_session_id = '7313'`, [team.teamId]);
  by = Object.fromEntries((await sourceAthletes(team)).athletes.map((a) => [a.gpexeAthleteId, a]));
  assert.equal(by["101"].lastSeen.sessionDrillsCount, null);
  assert.equal(by["101"].values.distance, 3000, "the athlete's values are untouched");

  // Both expired: seen nowhere, still linked.
  await admin.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() - interval '1 minute' where owner_team_id = $1`, [team.teamId]);
  by = Object.fromEntries((await sourceAthletes(team)).athletes.map((a) => [a.gpexeAthleteId, a]));
  assert.deepEqual([by["101"].status, by["101"].lastSeen, by["101"].values], ["linked", null, { duration: null, distance: null, maxSpeed: null }]);
  assert.equal(by["104"], undefined, "an unlinked athlete with no available sighting is not listed");
});

test("source athletes: a link whose OptiMove athlete is no longer an active member of the team is linked_inactive, and the link is still shown", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7304 })] }));
  await checkNow(team);
  await admin.query(`update public.athlete_memberships set status = 'inactive' where athlete_id = $1 and team_id = $2`, [team.ids.a, team.teamId]);
  const by = Object.fromEntries((await sourceAthletes(team)).athletes.map((a) => [a.gpexeAthleteId, a]));
  assert.equal(by["101"].status, "linked_inactive");
  assert.deepEqual([by["101"].link.athleteId, by["101"].link.athleteName], [team.ids.a, "A101"]);
  assert.equal(by["102"].status, "linked");
  // Unlinking ends it: the athlete is simply unlinked.
  const link = (await api(`/teams/${team.teamId}/athlete-links`, { cookie: team.coach.cookie })).body.links.find((l) => l.gpexeAthleteId === "101");
  await api(`/teams/${team.teamId}/athlete-links/${link.id}/unlink`, { method: "POST", cookie: team.coach.cookie });
  const after = Object.fromEntries((await sourceAthletes(team)).athletes.map((a) => [a.gpexeAthleteId, a]));
  assert.deepEqual([after["101"].status, after["101"].link], ["unlinked", null]);
});

test("source athletes: the team's coach reads them; another team's coach, a user with no role, an admin in the wrong club workspace and a malformed id get the same 404; no login gets 401; nothing of another team leaks", async () => {
  const team = await setupTeam();
  const other = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7305 })] }));
  await checkNow(team);
  // The other team's GPEXE athlete 201 exists only there.
  const [, a102] = standardAthletes();
  const otherBundle = makeBundle({ sessionId: 7306, gpexeTeamId: 78, athletes: [{ ...structuredClone(a102), id: 201, tracks: [9201] }] });
  // ... and a refused session (a match) whose only athlete, 205, is raw-only.
  const otherMatch = makeBundle({ sessionId: 7316, gpexeTeamId: 78, category: "OFFICIAL MATCH", athletes: [{ ...structuredClone(a102), id: 205, tracks: [9205] }] });
  service.setGpexeClientFactory(fakeGpexe({ bundles: [otherBundle, otherMatch] }));
  await checkNow(other);

  const mine = await sourceAthletes(team);
  const theirs = await sourceAthletes(other);
  assert.deepEqual(mine.athletes.map((a) => a.gpexeAthleteId), ["101", "102", "103", "104", "105"]);
  assert.deepEqual(theirs.athletes.map((a) => a.gpexeAthleteId), ["101", "102", "103", "105", "201", "205"], "the other team's links, its own sighting and its own raw-only athlete");
  assert.equal(theirs.athletes.find((a) => a.gpexeAthleteId === "205").lastSeen.evidence, "raw_snapshot");
  assert.equal(theirs.athletes.find((a) => a.gpexeAthleteId === "101").lastSeen, null, "team A's sighting of 101 is not team B's");
  // The identifiers the answer really carries are disjoint between the two
  // teams, and each answer lists every athlete once (a lost team filter on
  // the links would double the rows both teams linked).
  const ids = (body, pick) => new Set(body.athletes.map(pick).filter(Boolean));
  for (const pick of [(a) => a.link?.id, (a) => a.link?.athleteId, (a) => a.lastSeen?.candidateId]) {
    const a = ids(mine, pick);
    const b = ids(theirs, pick);
    assert.ok(a.size > 0 && b.size > 0);
    assert.ok([...a].every((id) => !b.has(id)), "disjoint");
  }
  assert.equal(mine.athletes.length, new Set(mine.athletes.map((a) => a.gpexeAthleteId)).size);
  assert.equal(theirs.athletes.length, new Set(theirs.athletes.map((a) => a.gpexeAthleteId)).size);
  for (const a of theirs.athletes) if (a.link) assert.ok(other.athleteIds.includes(a.link.athleteId), "only the other team's own athletes");
  for (const a of mine.athletes) if (a.link) assert.ok(team.athleteIds.includes(a.link.athleteId));

  // Another team's coach: the same body as a team that does not exist.
  const outsider = await coachOf(other.teamId, "other coach");
  const foreign = await api(`/teams/${team.teamId}/source-athletes`, { cookie: outsider.cookie });
  assert.deepEqual([foreign.status, foreign.body], [404, { error: "notFound" }]);
  // A signed-in user with no role at all.
  const nobody = await makeUser("nobody");
  await setWorkspace(nobody, "private_coach", null);
  assert.deepEqual((await api(`/teams/${team.teamId}/source-athletes`, { cookie: await cookieFor(nobody) })).status, 404);
  // The other club's admin, in that club's workspace: not a workspace that contains the team.
  const otherAdmin = await makeUser("other club admin");
  await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [otherAdmin, other.clubId]);
  await setWorkspace(otherAdmin, "club", other.clubId);
  const otherAdminCookie = await cookieFor(otherAdmin);
  assert.equal((await api(`/teams/${team.teamId}/source-athletes`, { cookie: otherAdminCookie })).status, 404);
  assert.equal((await api(`/teams/${other.teamId}/source-athletes`, { cookie: otherAdminCookie })).status, 200, "the same admin reads their own club's team");
  // An admin of BOTH clubs, active in the other club's workspace: may manage
  // the team, but is not in a workspace that contains it - 404, as for the
  // candidates; in the team's own club workspace the same admin reads it.
  await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [otherAdmin, team.clubId]);
  assert.equal((await api(`/teams/${team.teamId}/source-athletes`, { cookie: otherAdminCookie })).status, 404, "not in a workspace that contains the team");
  await setWorkspace(otherAdmin, "club", team.clubId);
  assert.equal((await api(`/teams/${team.teamId}/source-athletes`, { cookie: otherAdminCookie })).status, 200);
  assert.equal((await api(`/teams/${team.teamId}/source-athletes`, { cookie: team.padmin.cookie })).status, 200, "a platform admin in the platform workspace reads it");
  for (const path of [`/teams/not-a-uuid/source-athletes`, `/teams/00000000-0000-4000-8000-000000000000/source-athletes`]) {
    const r = await api(path, { cookie: team.coach.cookie });
    assert.deepEqual([r.status, r.body.error], [404, "notFound"], path);
  }
  assert.equal((await api(`/teams/${team.teamId}/source-athletes`)).status, 401);
});

test("source athletes: the number of SQL statements does not grow with the number of candidates or source athletes", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7307 })] }));
  await checkNow(team);
  let sql = [];
  const originalQuery = appPool.query;
  appPool.query = function captured(text, ...rest) {
    if (typeof text === "string" && /source_athletes|jsonb_array_elements\(c\.preview/.test(text)) sql.push(text);
    return originalQuery.call(this, text, ...rest);
  };
  let few;
  try {
    few = await countQueries(async () => {
      const body = await sourceAthletes(team);
      assert.equal(body.athletes.length, 5);
    });
  } finally {
    appPool.query = originalQuery;
  }

  // Five more sessions, three new GPEXE athletes, two more links.
  const [, a102] = standardAthletes();
  const extra = (sessionId, ids) => makeBundle({ sessionId, gpexeTeamId: 77, start: `2026-09-0${(sessionId % 5) + 1}T18:00:00`, athletes: [...sessionAthletes(), ...ids.map((id) => ({ ...structuredClone(a102), id, tracks: [9300 + id] }))] });
  const refused = makeBundle({ sessionId: 7317, gpexeTeamId: 77, category: "OFFICIAL MATCH", start: "2026-09-07T18:00:00", athletes: [...sessionAthletes(), { ...structuredClone(a102), id: 304, tracks: [9604] }] });
  service.setGpexeClientFactory(fakeGpexe({ bundles: [extra(7308, [301]), extra(7309, [301, 302]), extra(7310, [303]), extra(7311, []), extra(7312, [301, 302, 303]), refused] }));
  await checkNow(team);
  for (const [gpexeAthleteId, athleteId] of [["301", team.ids.d], ["302", team.ids.e]]) {
    assert.equal((await api(`/teams/${team.teamId}/athlete-links`, { method: "POST", cookie: team.coach.cookie, body: { gpexeAthleteId, athleteId } })).status, 201);
  }
  assert.equal((await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates.length, 7);
  const many = await countQueries(async () => {
    const body = await sourceAthletes(team);
    assert.equal(body.athletes.length, 9);
    assert.equal(body.athletes.find((a) => a.gpexeAthleteId === "304").lastSeen.evidence, "raw_snapshot");
  });
  assert.equal(many, few, `the same number of statements for 1 candidate / 5 athletes and 7 candidates / 9 athletes (few=${few} many=${many})`);

  // The plan of the one statement, for the review packet (no assertion on
  // its shape - only that it is one statement and parametrized).
  assert.equal(sql.length, 1, "exactly one source-athletes statement per request");
  assert.ok(sql[0].includes("$1") && !sql[0].includes(team.teamId), "parametrized");
  if (process.env.GPEXE_PLAN_OUT) {
    const plan = (await admin.query(`explain (analyze, buffers, format text) ${sql[0]}`, [team.teamId])).rows.map((r) => r["QUERY PLAN"]).join("\n");
    (await import("node:fs")).writeFileSync(process.env.GPEXE_PLAN_OUT, plan);
  }
});

test("source athletes: an athlete named only by a refused session's raw snapshot is listed as unlinked with evidence raw_snapshot and no values; an invalid raw id is ignored; expired or purged, it is gone", async () => {
  const team = await setupTeam();
  const [, a102] = standardAthletes();
  // A match: the mapper refuses it, the stored preview names no athlete; only
  // athlete 204 is recorded in it. A second raw row carries an invalid id.
  const match = makeBundle({ sessionId: 7320, gpexeTeamId: 77, category: "OFFICIAL MATCH", start: "2026-09-13T18:00:00", athletes: [{ ...structuredClone(a102), id: 204, tracks: [9204] }] });
  match.athleteSessions.push({ ...structuredClone(match.athleteSessions[0]), id: 999001, athlete: "not-an-id" });
  service.setGpexeClientFactory(fakeGpexe({ bundles: [match] }));
  await checkNow(team);
  const [candidate] = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  assert.deepEqual([candidate.status, candidate.blockedCode], ["blocked", "unsupported_session_type"]);

  let body = await sourceAthletes(team);
  assert.deepEqual(body.athletes.map((a) => a.gpexeAthleteId), ["101", "102", "103", "105", "204"], "the links, plus the raw-only athlete; no invalid id");
  const a204 = body.athletes.find((a) => a.gpexeAthleteId === "204");
  assert.equal(a204.status, "unlinked");
  assert.equal(a204.link, null);
  assert.deepEqual(a204.values, { duration: null, distance: null, maxSpeed: null });
  assert.deepEqual([a204.lastSeen.candidateId, a204.lastSeen.gpexeTeamSessionId, a204.lastSeen.candidateStatus, a204.lastSeen.evidence, a204.lastSeen.sessionType, a204.lastSeen.sessionDrillsCount],
    [candidate.id, "7320", "blocked", "raw_snapshot", "OFFICIAL MATCH", 2]);
  assert.match(body.lastSeenRule, /raw_snapshot/);
  // No name of any kind rides on a raw-only row (the client drops
  // athlete_name before storage; the SQL reads only the id and the session).
  assert.deepEqual(Object.keys(a204).sort(), ["gpexeAthleteId", "lastSeen", "link", "status", "values"]);
  assert.ok(!/name/i.test(JSON.stringify(a204)), JSON.stringify(a204));
  // A linked athlete with no sighting at all stays without one.
  assert.equal(body.athletes.find((a) => a.gpexeAthleteId === "101").lastSeen, null);

  // Expired, not purged: gone. Purged: gone.
  await admin.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() - interval '1 minute' where id = $1`, [candidate.id]);
  body = await sourceAthletes(team);
  assert.equal(body.athletes.find((a) => a.gpexeAthleteId === "204"), undefined, "expired");
  await admin.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() + interval '1 day' where id = $1`, [candidate.id]);
  assert.ok((await sourceAthletes(team)).athletes.some((a) => a.gpexeAthleteId === "204"), "back while available");
  await admin.query(`update training_load.gpexe_import_candidates set raw_bundle = null, preview = null, raw_purged_at = now() where id = $1`, [candidate.id]);
  body = await sourceAthletes(team);
  assert.equal(body.athletes.find((a) => a.gpexeAthleteId === "204"), undefined, "purged");
});

test("source athletes: the raw fallback never replaces a preview sighting or its values, even when the refused session is newer", async () => {
  const team = await setupTeam();
  const [, a102] = standardAthletes();
  const training = makeBundle({ sessionId: 7321, gpexeTeamId: 77, start: "2026-09-10T18:00:00", athletes: sessionAthletes() });
  // A newer match recorded 101 (seen in the training's preview) and 206 (seen nowhere else).
  const match = makeBundle({ sessionId: 7322, gpexeTeamId: 77, category: "OFFICIAL MATCH", start: "2026-09-12T18:00:00", athletes: [...sessionAthletes({ distance101: 5000 }), { ...structuredClone(a102), id: 206, tracks: [9206] }] });
  service.setGpexeClientFactory(fakeGpexe({ bundles: [match, training] }));
  await checkNow(team);
  const list = (await sourceAthletes(team)).athletes;
  // The list itself, once each: a fallback without its "not exists" would
  // list 101-105 twice (a keyed object would hide that).
  assert.deepEqual(list.map((a) => a.gpexeAthleteId), ["101", "102", "103", "104", "105", "206"]);
  const by = Object.fromEntries(list.map((a) => [a.gpexeAthleteId, a]));
  // 101: the preview sighting of 10 Sep with its values, not the raw row of 12 Sep.
  assert.deepEqual([by["101"].lastSeen.gpexeTeamSessionId, by["101"].lastSeen.evidence, by["101"].lastSeen.candidateStatus, by["101"].values.distance], ["7321", "preview", "pending", 3000]);
  // 104 (unlinked, in the training's preview): the same rule.
  assert.deepEqual([by["104"].status, by["104"].lastSeen.gpexeTeamSessionId, by["104"].lastSeen.evidence], ["unlinked", "7321", "preview"]);
  // 206: only the match's raw row names it.
  assert.deepEqual([by["206"].status, by["206"].lastSeen.gpexeTeamSessionId, by["206"].lastSeen.evidence, by["206"].lastSeen.candidateStatus, by["206"].values], ["unlinked", "7322", "raw_snapshot", "blocked", { duration: null, distance: null, maxSpeed: null }]);
  assert.ok(!/name/i.test(JSON.stringify(by["206"])), "no name on the raw-only row");
});

test("source athletes: a refused candidate whose raw athleteSessions is not an array (object, string, number, null, missing) yields no raw-only athlete and never an error; links and preview sightings stay", async () => {
  const team = await setupTeam();
  const [, a102] = standardAthletes();
  const training = makeBundle({ sessionId: 7323, gpexeTeamId: 77, start: "2026-09-10T18:00:00", athletes: sessionAthletes() });
  const match = makeBundle({ sessionId: 7324, gpexeTeamId: 77, category: "OFFICIAL MATCH", start: "2026-09-12T18:00:00", athletes: [{ ...structuredClone(a102), id: 207, tracks: [9207] }] });
  service.setGpexeClientFactory(fakeGpexe({ bundles: [training, match] }));
  await checkNow(team);
  const refused = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates.find((c) => c.gpexeTeamSessionId === "7324");
  assert.equal(refused.status, "blocked");
  const original = (await admin.query(`select raw_bundle->'athleteSessions' as rows from training_load.gpexe_import_candidates where id = $1`, [refused.id])).rows[0].rows;
  // One raw row per part (whole session and each drill), all of athlete 207.
  assert.ok(Array.isArray(original) && original.length >= 1 && original.every((row) => String(row.athlete) === "207"));

  const withLinksAndPreview = ["101", "102", "103", "104", "105"];
  const expect = async (label) => {
    const r = await api(`/teams/${team.teamId}/source-athletes`, { cookie: team.coach.cookie });
    assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body.athletes.map((a) => a.gpexeAthleteId), withLinksAndPreview, label);
    const by = Object.fromEntries(r.body.athletes.map((a) => [a.gpexeAthleteId, a]));
    assert.deepEqual([by["101"].status, by["101"].lastSeen.gpexeTeamSessionId, by["101"].lastSeen.evidence, by["101"].values.distance], ["linked", "7323", "preview", 3000], label);
    assert.deepEqual([by["104"].status, by["104"].lastSeen.evidence], ["unlinked", "preview"], label);
  };

  // The valid array: the raw-only athlete is listed.
  let r = await api(`/teams/${team.teamId}/source-athletes`, { cookie: team.coach.cookie });
  assert.deepEqual(r.body.athletes.map((a) => a.gpexeAthleteId), [...withLinksAndPreview, "207"]);

  const shapes = [
    ["object", `jsonb_set(raw_bundle, '{athleteSessions}', '{"athlete": 207, "teamsession": 7324}')`],
    ["string", `jsonb_set(raw_bundle, '{athleteSessions}', '"207"')`],
    ["number", `jsonb_set(raw_bundle, '{athleteSessions}', '207')`],
    ["null", `jsonb_set(raw_bundle, '{athleteSessions}', 'null')`],
    ["missing", `raw_bundle - 'athleteSessions'`],
  ];
  for (const [label, expr] of shapes) {
    await admin.query(`update training_load.gpexe_import_candidates set raw_bundle = ${expr} where id = $1`, [refused.id]);
    const stored = (await admin.query(`select jsonb_typeof(raw_bundle->'athleteSessions') as t from training_load.gpexe_import_candidates where id = $1`, [refused.id])).rows[0].t;
    assert.equal(stored, label === "missing" ? null : label === "null" ? "null" : label, label);
    await expect(label);
  }

  // The array again: the raw-only athlete is back.
  await admin.query(`update training_load.gpexe_import_candidates set raw_bundle = jsonb_set(raw_bundle, '{athleteSessions}', $2::jsonb) where id = $1`, [refused.id, JSON.stringify(original)]);
  r = await api(`/teams/${team.teamId}/source-athletes`, { cookie: team.coach.cookie });
  assert.deepEqual(r.body.athletes.map((a) => a.gpexeAthleteId), [...withLinksAndPreview, "207"]);
});
