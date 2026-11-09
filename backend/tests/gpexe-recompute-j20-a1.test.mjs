// J20-A1 (contract docs/ai/j20-session-review-contract.md section 5.0): the
// whole candidate's preview recomputed on demand.
//   1  a link does not change the stored preview; the recompute stores the new
//      one (same transaction, compare-and-set) and the returned hash is
//      approvable: link -> recompute -> approve imports the newly linked athlete
//   2  nothing but the candidate's derived columns is written; no value, no
//      approval; an imported candidate answers already_imported
//   3  the identical 404 (unknown candidate, another team's candidate, a user
//      of no team), and a team coach (not a platform admin) may call it
//   4  the SQL order of the route: candidate FOR UPDATE, then the team lock,
//      then the compare-and-set on the route's own connection, then COMMIT
//   5  a recompute against an approval of the same candidate: no deadlock, no
//      500; the approval waits and then answers preview_changed
//   6  a candidate row held by someone else: a bounded 409 try_again, the
//      stored columns unchanged
//   7  a COMMIT whose answer is lost: committed -> 200; not committed -> 503
//      outcome_unknown (never "nothing was written")
//   8  a repeat on an unchanged candidate within the interval is try_again
// On disposable optimove_tests_gpexe_* databases only; no GPEXE request, no
// credential (marker values of the fake source only).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "recompute_j20a1" });
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

test("1. a link leaves the stored preview as it was; the recompute stores the new one and its hash is approvable (link -> recompute -> approve imports the newly linked athlete)", async () => {
  const t = await team();
  await check(t);
  const c = await candidateRow(t);
  assert.equal(c.status, "pending");
  assert.ok(!importedAthletes(c).includes(athleteId(3)), "athlete 3 is left out: not linked");
  assert.equal((await linkThird(t)).status, 201);
  const stale = await q(`select preview_hash from training_load.gpexe_import_candidates where id = $1`, [c.id]);
  assert.equal(stale[0].preview_hash, c.preview_hash, "a link does not change the stored preview");
  // Without the recompute, the old hash cannot be approved any more (the approval recomputes).
  const r = await recompute(t, c.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.notEqual(r.body.candidate.previewHash, c.preview_hash, "the hash differs");
  const stored = await candidateRow(t);
  assert.equal(stored.id, c.id);
  assert.equal(stored.preview_hash, r.body.candidate.previewHash, "the returned hash IS the stored one");
  assert.ok(importedAthletes(stored).includes(athleteId(3)), "athlete 3 is importable now");
  assert.equal(stored.status, "pending");
  const approved = await approve(t, c.id, r.body.candidate.previewHash);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.outcome, "imported");
  assert.ok((await valueCount(t.teamId)) > 0);
  const athletesWithValues = await q(
    `select distinct p.athlete_id from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id
      where e.owner_team_id = $1`, [t.teamId]);
  assert.ok(athletesWithValues.some((x) => x.athlete_id === t.athleteIds[2]), "the newly linked athlete has values");
});

test("2. nothing but the candidate's derived columns is written; an imported candidate answers already_imported", async () => {
  const t = await team();
  await check(t);
  const c = await candidateRow(t);
  await linkThird(t);
  const before = (await q(`select * from training_load.gpexe_import_candidates where id = $1`, [c.id]))[0];
  const writeTables = async () => ({
    instances: await q(`select id, source_host_key, source_instance_key, state from training_load.metric_source_connections where owner_team_id = $1 order by id`, [t.teamId]),
    counts: (await q(
      `select (select count(*) from training_load.metric_events where owner_team_id = $1) as events,
              (select count(*) from training_load.metric_source_identities si join training_load.metric_source_connections c on c.id = si.source_connection_id where c.owner_team_id = $1) as identities,
              (select count(*) from training_load.metric_source_connections where owner_team_id = $1) as connections,
              (select count(*) from training.activities where owner_team_id = $1) as activities`, [t.teamId]))[0],
  });
  const tablesBefore = await writeTables();
  const r = await recompute(t, c.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = (await q(`select * from training_load.gpexe_import_candidates where id = $1`, [c.id]))[0];
  const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k])).sort();
  assert.deepEqual(changed, ["preview", "preview_computed_at", "preview_hash"].filter((k) => changed.includes(k)).sort(), `only derived columns changed: ${changed}`);
  assert.ok(changed.includes("preview") && changed.includes("preview_hash"));
  assert.equal(await valueCount(t.teamId), 0, "no value is written by the rolled-back import");
  assert.deepEqual(await writeTables(), tablesBefore, "no source instance, key, event, identity or activity survives the rolled-back import");
  assert.equal((await q(`select count(*)::int as n from training_load.gpexe_import_approvals where owner_team_id = $1`, [t.teamId]))[0].n, 0, "no approval");
  const approved = await approve(t, c.id, after.preview_hash);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const again = await recompute(t, c.id);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "already_imported");
});

test("3. the identical 404 for an unknown candidate, another team's candidate and a user of no team; a team coach may recompute", async () => {
  const t = await team();
  const other = await team();
  await check(t);
  const c = await candidateRow(t);
  const outsider = await user("outsider");
  const unknown = await recompute(t, crypto.randomUUID());
  const foreign = await recompute(other, c.id);
  const stranger = await recompute(t, c.id, outsider.cookie);
  const malformed = await api(`/gpexe/teams/${t.teamId}/candidates/not-a-uuid/preview`, { method: "POST", cookie: t.coach.cookie, body: {} });
  for (const x of [unknown, foreign, stranger, malformed]) {
    assert.equal(x.status, 404);
    assert.equal(x.headers.get("cache-control"), "no-store", "every answer, the 404s included, is no-store");
  }
  assert.equal(unknown.text, foreign.text);
  assert.equal(unknown.text, stranger.text);
  assert.equal(unknown.text, malformed.text);
  assert.equal((await recompute(t, c.id, t.coach.cookie)).status, 200, "a team coach");
  assert.equal((await recompute(t, c.id, t.padmin.cookie)).status, 200, "a platform admin");
});

test("4. the SQL order of the route: candidate FOR UPDATE, then the team lock, then the compare-and-set on the route's own connection, then COMMIT", async () => {
  const t = await team();
  await check(t);
  const c = await candidateRow(t);
  await linkThird(t);
  const seen = [];
  const realConnect = appPool.connect.bind(appPool);
  appPool.connect = (...args) => {
    // pool.query() checks a client out in the callback style: leave that alone.
    if (typeof args[args.length - 1] === "function") return realConnect(...args);
    return realConnect(...args).then(wrap);
  };
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
  let r;
  try {
    r = await recompute(t, c.id);
  } finally {
    appPool.connect = realConnect;
  }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const log = seen.find((l) => l.some((s) => s.includes("for update") && s.includes("gpexe_import_candidates")) && l.some((s) => s.includes("pg_advisory_xact_lock")));
  assert.ok(log, "the recompute's connection was found");
  const at = (pred) => log.findIndex(pred);
  const begin = at((s) => s.startsWith("begin"));
  const forUpdate = at((s) => s.includes("for update") && s.includes("gpexe_import_candidates"));
  const teamLock = at((s) => s.includes("pg_advisory_xact_lock"));
  const store = at((s) => s.startsWith("update training_load.gpexe_import_candidates") && s.includes("preview_hash"));
  const commit = at((s) => s === "commit");
  assert.ok(begin >= 0 && forUpdate > begin, "the candidate is locked inside the transaction");
  assert.ok(teamLock > forUpdate, "the team lock comes AFTER the candidate row (the approval's order)");
  assert.ok(store > teamLock, "the compare-and-set comes after both locks, on this connection");
  assert.ok(commit > store, "COMMIT last");
  assert.ok(!log.some((s) => s.includes("lock_gpexe_import_approver")), "the approver-rights lock (6b) is not taken");
  const savepoint = at((s) => s.startsWith("savepoint j20_recompute_preview"));
  const firstMappingLock = log.findIndex((s) => /order by id for share/.test(s));
  assert.ok(firstMappingLock > teamLock, "the mapping registry locks were taken (the world has activations)");
  assert.ok(savepoint > teamLock && savepoint < firstMappingLock, "the savepoint is opened BEFORE the mapping preparation, so its T7 key write is rolled back with the import");
  assert.ok(at((s) => s.startsWith("rollback to savepoint j20_recompute_preview")) < store, "the import is rolled back before the compare-and-set");
});

test("5. a recompute and an approval of the same candidate: no deadlock, no 500; the approval waits for the recompute and then answers preview_changed", async () => {
  const t = await team();
  await check(t);
  const c = await candidateRow(t);
  await linkThird(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let atGate;
  const reached = new Promise((resolve) => { atGate = resolve; });
  service.setRecomputeObserverForTests(async () => { atGate(); await gate; });
  const recomputing = recompute(t, c.id);
  await reached;
  // The recompute holds the candidate row and the team lock; the approval of the OLD hash starts now.
  const approving = approve(t, c.id, c.preview_hash);
  // Wait until the approval is really blocked on a lock in the database (no sleep as proof).
  let blocked = 0;
  for (let i = 0; i < 200 && !blocked; i += 1) {
    blocked = Number((await q(`select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`))[0].count);
    if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(blocked >= 1, "the approval is waiting for the candidate row held by the recompute");
  service.setRecomputeObserverForTests(null);
  release();
  const [r, a] = await Promise.all([recomputing, approving]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(a.status, 409, JSON.stringify(a.body));
  assert.equal(a.body.error, "preview_changed");
  assert.notEqual(a.status, 500);
  assert.equal(await valueCount(t.teamId), 0, "nothing imported by the refused approval");
  const now = await candidateRow(t);
  assert.equal(now.preview_hash, r.body.candidate.previewHash, "the stored hash is the recomputed one");
});

test("6. a candidate row held by someone else: a bounded 409 try_again, the stored columns unchanged", async () => {
  const t = await team();
  await check(t);
  const c = await candidateRow(t);
  await linkThird(t);
  preview.setImportTransactionBoundsForTests({ lockTimeoutMs: 300 });
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select id from training_load.gpexe_import_candidates where id = $1 for update`, [c.id]);
    const r = await recompute(t, c.id);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "try_again");
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
    preview.setImportTransactionBoundsForTests(null);
  }
  const after = await candidateRow(t);
  assert.equal(after.preview_hash, c.preview_hash);
  assert.equal(after.preview_computed_at.getTime(), c.preview_computed_at.getTime());
  // The team lock held by another transaction: the same bounded answer.
  preview.setImportTransactionBoundsForTests({ lockTimeoutMs: 300 });
  const holder2 = new pg.Client({ connectionString: db.url });
  await holder2.connect();
  try {
    await holder2.query("begin");
    await holder2.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`gpexe-import-team:${t.teamId}`]);
    const r = await recompute(t, c.id);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "try_again");
  } finally {
    await holder2.query("rollback").catch(() => {});
    await holder2.end();
    preview.setImportTransactionBoundsForTests(null);
  }
  assert.equal((await candidateRow(t)).preview_hash, c.preview_hash);
  assert.equal((await recompute(t, c.id)).status, 200, "free again");
});

test("7. a COMMIT whose answer is lost: committed -> 200; not committed -> 503 outcome_unknown (never 'nothing was written')", async () => {
  const t = await team();
  await check(t);
  const c = await candidateRow(t);
  await linkThird(t);
  // (a) the COMMIT lands, the answer is lost.
  service.setRecomputeCommitForTests(async (client) => { await client.query("commit"); throw new Error("answer lost"); }, { timeoutMs: 2000 });
  const landed = await recompute(t, c.id);
  assert.equal(landed.status, 200, JSON.stringify(landed.body));
  const stored = await candidateRow(t);
  assert.notEqual(stored.preview_hash, c.preview_hash);
  assert.equal(landed.body.candidate.previewHash, stored.preview_hash);
  // (b) the COMMIT never reaches the server: the connection is closed, nothing is stored.
  await linkThird(t).catch(() => {});
  await q(`update training_load.gpexe_import_candidates set preview_hash = $2 where id = $1`, [c.id, "0".repeat(64)]);
  service.setRecomputeCommitForTests(async () => { throw new Error("connection lost before the COMMIT"); }, { timeoutMs: 2000 });
  const lost = await recompute(t, c.id);
  service.setRecomputeCommitForTests(null);
  assert.equal(lost.status, 503, JSON.stringify(lost.body));
  assert.equal(lost.body.error, "outcome_unknown");
  assert.equal((await candidateRow(t)).preview_hash, "0".repeat(64), "nothing was stored");
  assert.equal((await recompute(t, c.id)).status, 200, "a repeat after the unknown outcome works");
});

test("8. a repeat on an unchanged candidate within the interval is try_again; a changed link set is not throttled", async () => {
  const t = await team();
  await check(t);
  const c = await candidateRow(t);
  service.setRecomputeIntervalForTests(60_000);
  try {
    const first = await recompute(t, c.id);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.candidate.previewHash, c.preview_hash, "nothing changed");
    const second = await recompute(t, c.id);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "try_again");
    await linkThird(t);
    const afterLink = await recompute(t, c.id);
    assert.equal(afterLink.status, 200, "the link changed the preview: a deliberate step, not throttled" + JSON.stringify(afterLink.body));
    assert.notEqual(afterLink.body.candidate.previewHash, c.preview_hash);
  } finally {
    service.setRecomputeIntervalForTests(0);
  }
});

test("9. a compare-and-set that matches no row (the stored hash moved under the route) answers 409 preview_changed and stores nothing", async () => {
  const t = await team();
  await check(t);
  const c = await candidateRow(t);
  await linkThird(t);
  // The route's own connection moves the stored hash after the preview and before the compare-and-set.
  service.setRecomputeObserverForTests(async ({ client }) => {
    await client.query(`update training_load.gpexe_import_candidates set preview_hash = $2 where id = $1`, [c.id, "f".repeat(64)]);
  });
  let r;
  try {
    r = await recompute(t, c.id);
  } finally {
    service.setRecomputeObserverForTests(null);
  }
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, "preview_changed");
  const after = await candidateRow(t);
  assert.equal(after.preview_hash, c.preview_hash, "the whole transaction was rolled back, including the observer's change");
  assert.equal(after.preview_computed_at.getTime(), c.preview_computed_at.getTime());
});

test("10. a candidate whose stored hash is NULL can be recomputed (the compare-and-set is null-safe)", async () => {
  const t = await team();
  await check(t);
  const c = await candidateRow(t);
  await linkThird(t);
  await q(`update training_load.gpexe_import_candidates set preview_hash = null where id = $1`, [c.id]);
  const r = await recompute(t, c.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match((await candidateRow(t)).preview_hash, /^[0-9a-f]{64}$/);
});

test("11. one recompute per team in flight: a second call answers try_again at once, before taking a connection; another team is not blocked", async () => {
  const t = await team();
  const other = await team();
  await check(t);
  await check(other);
  const c = await candidateRow(t);
  const oc = await candidateRow(other);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let atGate;
  const reached = new Promise((resolve) => { atGate = resolve; });
  let first = true;
  service.setRecomputeObserverForTests(async () => { if (first) { first = false; atGate(); await gate; } });
  const running = recompute(t, c.id);
  await reached;
  const startedAt = Date.now();
  const second = await recompute(t, c.id);
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.error, "try_again");
  assert.ok(Date.now() - startedAt < 2000, "answered at once, not after waiting for a lock");
  const otherTeam = await recompute(other, oc.id);
  assert.equal(otherTeam.status, 200, "another team is not blocked: " + JSON.stringify(otherTeam.body));
  release();
  assert.equal((await running).status, 200);
  service.setRecomputeObserverForTests(null);
  assert.equal((await recompute(t, c.id)).status, 200, "free again");
});

test("12. a failed read of the candidate AFTER the commit still answers 200 with candidateReadError (never 'not carried out'); the update is stored", async () => {
  const t = await team();
  await check(t);
  const c = await candidateRow(t);
  await linkThird(t);
  service.setCandidateReadFaultForTests(async () => { throw new Error("read failed"); });
  let r;
  try {
    r = await recompute(t, c.id);
  } finally {
    service.setCandidateReadFaultForTests(null);
  }
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.candidate, null);
  assert.equal(r.body.candidateReadError.error, "candidate_read_failed");
  assert.notEqual((await candidateRow(t)).preview_hash, c.preview_hash, "stored");
});
