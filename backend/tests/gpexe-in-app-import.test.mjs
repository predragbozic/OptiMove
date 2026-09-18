// In-app GPEXE import, phase F1, through the real server on a disposable
// database: "Check now", candidates, previews, athlete links, approver
// grants, retention. GPEXE itself is a fake client; nothing touches a
// persistent database, and nothing here may write a result or an activity.
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
  if (server) await new Promise((resolve) => server.close(resolve));
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

function sessionBundle({ sessionId = 7001, gpexeTeamId = 77, category, updatedOn, distance101 } = {}) {
  const bundle = makeBundle({ sessionId, gpexeTeamId, category, updatedOn, athletes: sessionAthletes({ distance101 }) });
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
  assert.ok(summary.approvalBlockers.includes("approval_not_available_yet"));
  assert.ok(summary.approvalBlockers.includes("import_switch_off"));

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
  const preview = (await api(`/teams/${team.teamId}/candidates/${summary.id}`, { cookie: team.coach.cookie })).body.candidate.preview;
  assert.equal(preview.blocked.code, "unsupported_category");
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
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, window_from, window_to, heartbeat_at, started_at)
     values ($1,$2,'2026-09-01','2026-09-14', now() - interval '1 hour', now() - interval '1 hour') returning id`,
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
  const id = (await admin.query(`select id from training_load.gpexe_import_candidates where owner_team_id = $1`, [team.teamId])).rows[0].id;
  // F2 is what marks a candidate imported; here the row is set directly.
  await admin.query(`update training_load.gpexe_import_candidates set status = 'imported', imported_at = now() - interval '91 days', raw_expires_at = now() - interval '1 day' where id = $1`, [id]);
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
  assert.equal(status.body.approvalAvailable, false);
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

test("switch: turning GPEXE_IMPORT_APPLY_ENABLED on changes what the screens say, and F1 still writes no result", async () => {
  const team = await setupTeam();
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    service.setGpexeClientFactory(fakeGpexe({ bundles: [sessionBundle({ sessionId: 7009 })] }));
    await checkNow(team);
    const list = await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie });
    assert.equal(list.body.importSwitch.enabled, true);
    assert.ok(!list.body.candidates[0].approvalBlockers.includes("import_switch_off"));
    assert.ok(list.body.candidates[0].approvalBlockers.includes("approval_not_available_yet"));
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
  const id = (await admin.query(`select id from training_load.gpexe_import_candidates where owner_team_id = $1`, [team.teamId])).rows[0].id;
  await admin.query(`update training_load.gpexe_import_candidates set status = 'imported', imported_at = now() where id = $1`, [id]);
  await assert.rejects(admin.query(`delete from training_load.gpexe_import_candidates where id = $1`, [id]), /never deleted/);
  // Nor by first turning it back into a pending one.
  await assert.rejects(admin.query(`update training_load.gpexe_import_candidates set status = 'pending', imported_at = null where id = $1`, [id]), /status and import time are final/);
  await assert.rejects(admin.query(`update training_load.gpexe_import_candidates set bundle_hash = repeat('0', 64) where id = $1`, [id]), /never change/);
  // The purge may still clear an imported snapshot.
  await admin.query(`update training_load.gpexe_import_candidates set raw_expires_at = now() - interval '1 minute' where id = $1`, [id]);
  await service.runRetention("cli");
  assert.equal((await admin.query(`select raw_bundle, status from training_load.gpexe_import_candidates where id = $1`, [id])).rows[0].status, "imported");

  const other = await createGpexePilotOrg(admin, { athleteNames: ["Q"] });
  for (const gpexeTeamId of ["88001", "88002"]) {
    assert.equal((await api(`/teams/${other.teamId}/settings`, { method: "PUT", cookie: team.padmin.cookie, body: { gpexeTeamId } })).status, 200);
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
