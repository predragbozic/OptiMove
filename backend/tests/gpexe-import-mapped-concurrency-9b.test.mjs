// Phase 9, 9-B (contract J17 sections 3, 5, 7 and 8.2): the importer's lock
// order against the operations that change what it writes through, with real
// connections and real locks - no sleep is evidence (a sleep only shows "still
// waiting" after the wait was seen in the lock manager through
// pg_blocking_pids), every wait is bounded, and every gate opens in a finally.
// "No 40P01" is asserted by the outcomes: every request ends with its
// documented answer (and no error line names a deadlock).
//   1 - the writer against a 7d end (S2) of its only activation: the end waits
//       on the import's T5 FOR SHARE (held after step 5); an end that lands
//       between step 4 and step 5 is mapping_changed; an end that holds its
//       T5 lock first makes the import wait and then mapping_changed;
//   2 - an approval against an Unbind of the team's binding, both orders;
//   3 - an approval against a 7g end of the team's source instance, both orders;
//   4 - two approvals of the same team at once serialize on the team lock;
//   5 - a coach's approval with a 7d end by another platform admin and a revoke
//       of the coach's grant during it: the end waits, the approval answers 403
//       not_an_approver at step 6b, nothing written;
//   6 - R16: the team (single approval) or its club (batch) archived while the
//       approval waits on the team lock: the identical 404, the batch stops;
//   7 - T7 23505: another team's active instance of the same (server3, GPEXE
//       team) lands while the import is held before its T7 lock: the insert's
//       savepoint takes the 23505, the import is source_instance_held and the
//       transaction stays usable.
// A team move is not built for R16: v27 refuses moving a team bound through
// its club's connection (and the move takes the team lock as a try-lock).
// GPEXE is the fake server3 source (support/gpexe-fake-source.mjs); the
// legacy client factory is a trap. Disposable optimove_tests_gpexe_* databases
// only; no GPEXE request, no credential, no trigger disabled.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { GpexeImportError, importGpexeBundle, importGpexeBundleLocked, lockTeamForImport } from "../src/gpexeImportWriter.js";
import { ImportMappingChangedError, setImportMappingHoldForTests, setSourceInstanceHoldForTests } from "../src/gpexeImportMapping.js";
import { setImportTransactionBoundsForTests } from "../src/gpexeImportPreview.js";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { LEGACY_SPECS } from "./support/gpexe-legacy-specs.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { activateBinding, mappedBinding, platformAdmin as worldPlatformAdmin, t7Keys } from "./support/mapped-world.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
// The fixtures' day: a binding-path check reads the sessions of its window.
const D1 = "2026-09-14";

let db;
let admin;
let server;
let apiBase;
let service;
let connections;
let resolver;
let activations;
let instances;
let createSession;
let appPool;
let src;
const errorLines = [];
const originalConsoleError = console.error;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "mapped_conc_9b" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  process.env.SOURCE_CREDENTIAL_KEYS = (await import("../src/sourceCredentialCrypto.js")).generateKeyEntry(1);
  console.error = (...args) => {
    errorLines.push(args.map((a) => (typeof a === "string" ? a : String(a?.message ?? a))).join(" "));
    originalConsoleError(...args);
  };
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
  connections = await import("../src/sourceConnectionService.js");
  resolver = await import("../src/sourceImportCredentialResolver.js");
  activations = await import("../src/sourceMetricActivationService.js");
  instances = await import("../src/sourceInstanceEndService.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app talks to the disposable database");
  src = createFakeSource();
  connections.setSourceFetchForTests(src.fetchImpl);
  resolver.setImportSourceFetchForTests(src.fetchImpl);
  service.setGpexeClientFactory(() => { throw new Error("TRAP: the legacy client factory was called for a bound team"); });
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  for (const g of openGates.splice(0)) g.open();
  resetSeams();
  service?.setGpexeClientFactory(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) {
    let timer;
    await Promise.race([appPool.end(), new Promise((resolve) => { timer = setTimeout(resolve, 5_000); })]);
    clearTimeout(timer);
  }
  if (admin) await admin.end();
  if (db) await db.drop();
  console.error = originalConsoleError;
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_SWITCH === undefined) delete process.env.GPEXE_IMPORT_APPLY_ENABLED; else process.env.GPEXE_IMPORT_APPLY_ENABLED = ORIGINAL_SWITCH;
  if (ORIGINAL_KEYS === undefined) delete process.env.SOURCE_CREDENTIAL_KEYS; else process.env.SOURCE_CREDENTIAL_KEYS = ORIGINAL_KEYS;
});

// Every seam this file sets, back to none (gates are opened first, so no
// held transaction is left waiting on a promise nobody resolves).
function resetSeams() {
  setSourceInstanceHoldForTests(null);
  setImportMappingHoldForTests(null);
  setImportTransactionBoundsForTests(null);
  activations?.setActivationWriteHoldForTests(null);
  instances?.setInstanceSeamsForTests();
  connections?.setSourceUnbindHoldForTests(null);
  service?.setApprovalObserver(null);
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
}
afterEach(() => {
  for (const g of openGates.splice(0)) g.open();
  resetSeams();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A promise bounded in time: nothing in this file may wait forever.
function within(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Whether a promise has settled yet; attaching the handlers here also keeps a
// rejection that is awaited later from counting as unhandled.
function settled(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
}

// A gate for a test seam: the first caller records its backend pid, signals
// `reached` and waits until the gate opens; later callers pass through.
const openGates = [];
function gate() {
  let open;
  let markReached;
  const opened = new Promise((resolve) => { open = resolve; });
  const reached = new Promise((resolve) => { markReached = resolve; });
  const g = {
    entered: false, pid: null, reached, open: () => open(),
    hold: async (client) => {
      if (g.entered) return;
      g.entered = true;
      g.pid = client?.processID ?? null;
      markReached();
      await opened;
    },
  };
  openGates.push(g);
  return g;
}

// A backend of this database that the lock manager says is waiting on a lock
// held by holderPid (row, tuple, transaction id or advisory), or null.
async function waiterBlockedBy(holderPid, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = (await admin.query(
      `select pid from pg_stat_activity where datname = current_database() and $1 = any(pg_blocking_pids(pid)) order by pid limit 1`,
      [holderPid],
    )).rows[0];
    if (row) return row.pid;
    await sleep(10);
  }
  return null;
}

const deadlockLines = (from) => errorLines.slice(from).filter((line) => /40P01|deadlock/i.test(line));

async function newClient() {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  return client;
}

// Another session holding the team's import lock (the key of every import,
// check-time preview, link, settings change, bind and Unbind).
async function holdTeamLock(teamId) {
  const holder = await newClient();
  await holder.query("begin");
  await lockTeamForImport(holder, teamId);
  let released = false;
  return {
    pid: holder.processID,
    release: async () => {
      if (released) return;
      released = true;
      await holder.query("rollback").catch(() => {});
      await holder.end().catch(() => {});
    },
  };
}

// Another team's active, keyed Metrics Core source instance (T7), committed
// on its own connection; its lock_timeout makes a wait it should not have fail
// instead of hang.
async function rawInstance(teamId, sourceTeamId) {
  const c = await newClient();
  try {
    await c.query("begin");
    await c.query(`select set_config('lock_timeout', '2000ms', true)`);
    const id = (await c.query(
      `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id, source_host_key, source_instance_key)
       values ('gpexe','team',$1,'server3',$2) returning id`,
      [teamId, String(sourceTeamId)],
    )).rows[0].id;
    await c.query("commit");
    return String(id);
  } finally {
    await c.end();
  }
}

// What an import of one team writes, counted: "nothing written" is every
// one of them as before.
const TEAM_IMPORT_COUNTS = {
  events: `select count(*)::int as c from training_load.metric_events where owner_team_id = $1`,
  metric_values: `select count(*)::int as c from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`,
  provenance: `select count(*)::int as c from training_load.metric_value_source_provenance pr join training_load.metric_values v on v.id = pr.metric_value_id join training_load.metric_measurement_occasions o on o.id = v.occasion_id join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`,
  import_batches: `select count(*)::int as c from training_load.metric_import_batches where owner_team_id = $1`,
  activities: `select count(*)::int as c from training.activities where owner_team_id = $1`,
  approvals: `select count(*)::int as c from training_load.gpexe_import_approvals where owner_team_id = $1`,
  source_instances: `select count(*)::int as c from training_load.metric_source_connections where owner_team_id = $1`,
};
const ZERO = Object.fromEntries(Object.keys(TEAM_IMPORT_COUNTS).map((k) => [k, 0]));
async function teamCounts(teamId) {
  const out = {};
  for (const [name, sql] of Object.entries(TEAM_IMPORT_COUNTS)) out[name] = (await admin.query(sql, [teamId])).rows[0].c;
  return out;
}

// Row counts of every table an approval can touch.
async function allRowCounts() {
  const tables = (await admin.query(
    `select table_schema || '.' || table_name as name from information_schema.tables
      where table_schema in ('training_load', 'training', 'public') and table_type = 'BASE TABLE' order by 1`,
  )).rows.map((r) => r.name);
  const counts = {};
  for (const name of tables) counts[name] = (await admin.query(`select count(*)::int as n from ${name}`)).rows[0].n;
  return counts;
}

const activationEndedAt = async (id) => (await admin.query(`select ended_at from training_load.source_metric_mapping_activations where id = $1`, [id])).rows[0].ended_at;
const candidateRow = async (id) => (await admin.query(`select status, preview, preview_hash from training_load.gpexe_import_candidates where id = $1`, [id])).rows[0];
const bindingState = async (id) => (await admin.query(`select state from training_load.source_team_bindings where id = $1`, [id])).rows[0].state;

async function teamValueRows(teamId) {
  return (await admin.query(
    `select v.metric_definition_id, v.value_numeric::text as value_text, pr.activation_id
       from training_load.metric_values v
       left join training_load.metric_value_source_provenance pr on pr.metric_value_id = v.id
       join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events e on e.id = p.event_id
      where e.owner_team_id = $1`,
    [teamId],
  )).rows;
}

// The pre-9-B values of one bundle (the frozen specs), keyed
// athlete|level|drill|legacy key.
function oracleOf(bundle) {
  const plan = buildGpexeImportPlan(bundle, {
    metricSpecs: LEGACY_SPECS.map((s) => ({ raw: true, key: s.key, levels: { full: true, drill: true }, extract: s.extract })),
  });
  const out = new Map();
  for (const p of plan.participants) for (const r of p.results) for (const v of r.values) out.set(`${p.gpexeAthleteId}|${r.level}|${r.drillIndex ?? ""}|${v.key}`, v.value);
  return out;
}

// A 7d end (S2) through the service, as a platform admin in the platform
// workspace (system mappings on any club's binding).
const systemCtx = (userId) => ({ userId: String(userId), basis: "platform_admin", owner: { scope: "system", clubId: null } });
function endActivation(userId, activationId) {
  return activations.endActivation({
    ctx: systemCtx(userId), activationId,
    body: { requestKey: crypto.randomUUID(), expectedState: "open", reason: "9-B concurrency test end." },
  });
}

// Each team its own GPEXE team id (gpexe_team_settings is unique on it) and
// each session its own id (the fake source serves a session for one team).
let sourceTeamCounter = 73000;
const nextSourceTeamId = () => String(++sourceTeamCounter);
let sessionCounter = 73100;
const nextSession = () => ++sessionCounter;

// ---------------------------------------------------------------------------
// Writer-level teams: a raw-SQL binding with the mapped world's activations
// ---------------------------------------------------------------------------
async function mappedTeam({ only = null } = {}) {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["W101", "W102", "W103"] });
  const sourceTeamId = nextSourceTeamId();
  const bound = await mappedBinding(admin, { teamId: org.teamId, clubId: org.clubId, sourceTeamId, only });
  return { ...org, ...bound, sourceTeamId, athleteMap: { 101: org.athleteIds[0], 102: org.athleteIds[1], 103: org.athleteIds[2] } };
}
const writerBundle = (org) => makeBundle({ sessionId: nextSession(), athletes: standardAthletes(), gpexeTeamId: Number(org.sourceTeamId) });
const writerCtx = (org) => ({ ownerTeamId: org.teamId, performedByUserId: org.userId, athleteIdByGpexeId: org.athleteMap, batchFilename: "9-B concurrency" });

// ---------------------------------------------------------------------------
// Route-level teams: bound through the real Connect / Bind routes, checked
// through the binding, candidates approved through the real route
// ---------------------------------------------------------------------------
async function call(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const gpexe = (path, opts) => call(`/gpexe${path}`, opts);

async function makeUser(label) {
  return String((await admin.query(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${crypto.randomBytes(4).toString("hex")}@test.local`, label])).rows[0].id);
}
async function setWorkspace(userId, type, scopeId) {
  await admin.query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [userId, type, scopeId],
  );
}
async function routePlatformAdmin() {
  const id = await makeUser("platform admin");
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}
async function teamCoach(teamId) {
  const id = await makeUser("coach");
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}

// v33: a session with two drills is actionable only with two distinct
// non-empty drill answers, so every route session carries both drills.
const routeBundle = (sessionId, gpexeTeamId, athletes = standardAthletes()) => makeBundle({ sessionId, gpexeTeamId: Number(gpexeTeamId), athletes, detailsDrills: [0, 1] });

// A team with athletes 101, 102, 103 linked (103 has two tracks and stays
// out), bound to its own GPEXE team with the eleven activations; with
// `coach`, a coach of the team holding an approver grant.
async function setupTeam({ coach = false } = {}) {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A101", "B102", "C103"] });
  const padmin = await routePlatformAdmin();
  const gpexeTeamId = nextSourceTeamId();
  const settings = await gpexe(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId } });
  assert.equal(settings.status, 200, settings.text);
  src.show(gpexeTeamId);
  const { bindingId, connectionId } = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId: gpexeTeamId });
  const { started } = await activateBinding(admin, bindingId);
  for (const [gpexeAthleteId, athleteId] of [["101", org.athleteIds[0]], ["102", org.athleteIds[1]], ["103", org.athleteIds[2]]]) {
    const r = await gpexe(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: padmin.cookie, body: { gpexeAthleteId, athleteId } });
    assert.equal(r.status, 201, r.text);
  }
  let approver = null;
  if (coach) {
    approver = await teamCoach(org.teamId);
    const granted = await gpexe(`/teams/${org.teamId}/approvers`, { method: "POST", cookie: padmin.cookie, body: { userId: approver.id, reason: "9-B concurrency test grant." } });
    assert.equal(granted.status, 201, granted.text);
    approver.grantId = String(granted.body.grant.id);
  }
  return { ...org, padmin, gpexeTeamId, bindingId, connectionId, started, coach: approver };
}

async function checkNow(team) {
  const started = await gpexe(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.padmin.cookie, body: { from: D1, to: D1 } });
  assert.equal(started.status, 202, started.text);
  for (let i = 0; i < 400; i += 1) {
    const r = await gpexe(`/teams/${team.teamId}/checks/${started.body.check.id}`, { cookie: team.padmin.cookie });
    if (r.body.check?.status !== "running") return r.body.check;
    await sleep(25);
  }
  throw new Error("the check did not finish");
}

// A team with `n` checked, actionable candidates (one per session).
async function teamWithCandidates(n, opts = {}) {
  const team = await setupTeam(opts);
  src.serve(team.gpexeTeamId, Array.from({ length: n }, () => routeBundle(nextSession(), team.gpexeTeamId, opts.athletes)));
  const check = await checkNow(team);
  assert.equal(check.status, "succeeded", JSON.stringify(check.error));
  const list = (await gpexe(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates;
  assert.equal(list.length, n);
  for (const c of list) assert.deepEqual(c.approvalBlockers.filter((b) => b !== "import_switch_off"), [], `candidate ${c.id} is actionable`);
  const details = [];
  for (const c of list) details.push((await gpexe(`/teams/${team.teamId}/candidates/${c.id}`, { cookie: team.padmin.cookie })).body.candidate);
  for (const d of details) assert.match(String(d.previewHash), /^[0-9a-f]{64}$/);
  return { team, details };
}

function approve(team, candidate, { cookie = team.padmin.cookie } = {}) {
  return gpexe(`/teams/${team.teamId}/candidates/${candidate.id}/approve`, { method: "POST", cookie, body: { previewHash: candidate.previewHash } });
}

async function withSwitchOn(fn) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await fn();
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
    service.setApprovalObserver(null);
  }
}

async function withBounds(bounds, fn) {
  setImportTransactionBoundsForTests(bounds);
  try {
    return await fn();
  } finally {
    setImportTransactionBoundsForTests(null);
  }
}

function unbind(team) {
  return call(`/sources/gpexe/connections/${team.connectionId}/bindings/${team.bindingId}/unbind`, {
    method: "POST", cookie: team.padmin.cookie,
    body: { requestKey: crypto.randomUUID(), reason: "9-B concurrency test unbind.", expected: { teamId: team.teamId, sourceTeamId: team.gpexeTeamId } },
  });
}

function endInstance(team, instance) {
  return call(`/sources/metrics/source-instances/${instance.id}/end`, {
    method: "POST", cookie: team.padmin.cookie,
    body: {
      requestKey: crypto.randomUUID(), reason: "9-B concurrency test end of the instance.",
      expected: { sourceSystem: "gpexe", sourceHostKey: instance.source_host_key, sourceInstanceKey: instance.source_instance_key },
    },
  });
}

// ---------------------------------------------------------------------------
// 1. The writer against a 7d end of its only activation
// ---------------------------------------------------------------------------

test("1a. the writer against a 7d end of its only activation, the import first: held after step 5 (its T5 row FOR SHARE, before the T7 lock), the end waits on the import's lock, the import finishes with exactly its values through that activation, and only then the end commits - no 40P01", async () => {
  const logFrom = errorLines.length;
  const org = await mappedTeam({ only: ["gpexe_total_distance"] });
  const [activationId] = org.started.gpexe_total_distance;
  assert.ok(activationId, "the one activation");
  const bundle = writerBundle(org);
  const g = gate();
  setSourceInstanceHoldForTests(g.hold);
  const client = await newClient();
  const importPid = client.processID;
  const importing = importGpexeBundle(client, bundle, writerCtx(org)).finally(() => client.end().catch(() => {}));
  const importDone = settled(importing);
  let ending = null;
  try {
    await within(g.reached, 15_000, "the import reached its hold after step 5");
    assert.equal(g.pid, importPid, "the hold is the import's own transaction");
    ending = endActivation(org.platformAdminId, activationId);
    const endDone = settled(ending);
    assert.ok(await waiterBlockedBy(importPid), "the end waits on a lock the import holds (the T5 row FOR SHARE)");
    await sleep(150);
    assert.deepEqual([importDone(), endDone()], [false, false], "both still waiting: the import at its hold, the end on the import's lock");
    assert.equal(await activationEndedAt(activationId), null, "the activation is still open while the import holds it");
  } finally {
    g.open();
  }
  const summary = await within(importing, 20_000, "the import");
  const ended = await within(ending, 20_000, "the end");
  assert.equal(ended.replayed, false);
  assert.notEqual(await activationEndedAt(activationId), null, "the end committed after the import");
  assert.ok(summary.counts.created > 0, JSON.stringify(summary.counts));
  const expected = [...oracleOf(bundle).keys()].filter((k) => k.endsWith("|gpexe_total_distance"));
  assert.ok(expected.length > 0, "the oracle has total distance values");
  const rows = await teamValueRows(org.teamId);
  assert.equal(rows.length, expected.length, "exactly the values of the one activation, none missing, none added");
  for (const r of rows) {
    assert.equal(String(r.metric_definition_id), String(org.world.gpexe_total_distance.variableId));
    assert.equal(String(r.activation_id), String(activationId), "every value's T6 row names the activation it was written through");
  }
  assert.deepEqual(deadlockLines(logFrom), []);
});

test("1b. the writer against a 7d end that lands between step 4 (the activations read unlocked) and step 5 (their locks): the end does not wait (the import holds no registry row yet), and the import's re-check under the locks answers mapping_changed - nothing written, no source instance", async () => {
  const logFrom = errorLines.length;
  const org = await mappedTeam({ only: ["gpexe_total_distance"] });
  const [activationId] = org.started.gpexe_total_distance;
  const g = gate();
  setImportMappingHoldForTests(g.hold);
  const client = await newClient();
  const importing = importGpexeBundle(client, writerBundle(org), writerCtx(org)).finally(() => client.end().catch(() => {}));
  const importDone = settled(importing);
  try {
    await within(g.reached, 15_000, "the import read its activations and holds before step 5");
    // The end's own row lock bound is 2 s: an answer here means it did not wait on the import.
    const ended = await within(endActivation(org.platformAdminId, activationId), 10_000, "the end");
    assert.equal(ended.replayed, false);
    assert.notEqual(await activationEndedAt(activationId), null);
    assert.equal(importDone(), false, "the import is still at its hold");
  } finally {
    g.open();
  }
  await assert.rejects(within(importing, 20_000, "the import"), (error) => error instanceof ImportMappingChangedError && error.code === "mapping_changed");
  assert.deepEqual(await teamCounts(org.teamId), ZERO, "nothing written");
  assert.equal((await t7Keys(admin, org.teamId)).length, 0, "no source instance either");
  assert.deepEqual(deadlockLines(logFrom), []);
});

test("1c. the writer against a 7d end that holds its T5 row lock first (held after every lock and check, before its UPDATE): the import waits on the end's lock at step 5, the end commits, and the import's re-check answers mapping_changed - nothing written", async () => {
  const logFrom = errorLines.length;
  const org = await mappedTeam({ only: ["gpexe_total_distance"] });
  const [activationId] = org.started.gpexe_total_distance;
  const g = gate();
  activations.setActivationWriteHoldForTests(g.hold);
  const ending = endActivation(org.platformAdminId, activationId);
  const endDone = settled(ending);
  let importing = null;
  try {
    await within(g.reached, 15_000, "the end holds its locks before its UPDATE");
    const client = await newClient();
    const importPid = client.processID;
    importing = importGpexeBundle(client, writerBundle(org), writerCtx(org)).finally(() => client.end().catch(() => {}));
    const importDone = settled(importing);
    assert.equal(await waiterBlockedBy(g.pid), importPid, "the import waits on a lock the end holds (the T5 row)");
    await sleep(150);
    assert.deepEqual([importDone(), endDone()], [false, false]);
  } finally {
    g.open();
  }
  const ended = await within(ending, 20_000, "the end");
  assert.equal(ended.replayed, false);
  assert.notEqual(await activationEndedAt(activationId), null);
  await assert.rejects(within(importing, 20_000, "the import"), (error) => error instanceof ImportMappingChangedError && error.code === "mapping_changed");
  assert.deepEqual(await teamCounts(org.teamId), ZERO, "nothing written");
  assert.equal((await t7Keys(admin, org.teamId)).length, 0);
  assert.deepEqual(deadlockLines(logFrom), []);
});

// ---------------------------------------------------------------------------
// 2. An approval against an Unbind of the team's binding
// ---------------------------------------------------------------------------

test("2. an approval against an Unbind of the same team's binding, both orders: the Unbind holding the team lock makes a bounded approval 409 try_again (nothing written), and an approval that waited until the Unbind committed answers 409 preview_changed with the stored preview blocked mapping_not_usable (the binding ended before step 3), nothing imported; an approval holding the team lock makes the Unbind 409 try_again and then imports, the binding still active - no 40P01", async () => {
  const logFrom = errorLines.length;

  // (a) The Unbind first: held after its team try-lock and its binding FOR UPDATE.
  const a = await teamWithCandidates(1);
  const [ca] = a.details;
  const before = await allRowCounts();
  const gu = gate();
  connections.setSourceUnbindHoldForTests(gu.hold);
  const unbinding = unbind(a.team);
  const unbindDone = settled(unbinding);
  try {
    await within(gu.reached, 15_000, "the Unbind holds the team lock and the binding row");
    await withSwitchOn(async () => {
      const r = await withBounds({ lockTimeoutMs: 300 }, () => approve(a.team, ca));
      assert.deepEqual([r.status, r.body.error], [409, "try_again"], r.text);
    });
    assert.deepEqual(await allRowCounts(), before, "nothing written by the approval (and nothing yet by the held Unbind)");
    assert.equal((await candidateRow(ca.id)).status, "pending");
    await withSwitchOn(async () => {
      const waiting = approve(a.team, ca);
      const waitingDone = settled(waiting);
      assert.ok(await waiterBlockedBy(gu.pid), "the approval waits on the team lock the Unbind holds");
      await sleep(150);
      assert.deepEqual([waitingDone(), unbindDone()], [false, false]);
      gu.open();
      const u = await within(unbinding, 20_000, "the Unbind");
      assert.equal(u.status, 200, u.text);
      const r = await within(waiting, 20_000, "the waiting approval");
      assert.deepEqual([r.status, r.body.error], [409, "preview_changed"], r.text);
    });
  } finally {
    gu.open();
    connections.setSourceUnbindHoldForTests(null);
  }
  assert.equal(await bindingState(a.team.bindingId), "ended");
  const stored = await candidateRow(ca.id);
  assert.equal(stored.status, "blocked");
  assert.equal(stored.preview.blocked.code, "mapping_not_usable", "the refreshed preview: no binding to write through");
  assert.deepEqual(await teamCounts(a.team.teamId), ZERO, "nothing imported");

  // (b) The approval first: held inside its transaction after the import ran.
  const b = await teamWithCandidates(1);
  const [cb] = b.details;
  await withSwitchOn(async () => {
    const g = gate();
    service.setApprovalObserver(({ client }) => g.hold(client));
    const approving = approve(b.team, cb);
    const approvingDone = settled(approving);
    try {
      await within(g.reached, 20_000, "the approval holds the team lock and the binding FOR SHARE");
      const u = await within(unbind(b.team), 10_000, "the Unbind");
      assert.deepEqual([u.status, u.body.error], [409, "try_again"], u.text);
      assert.equal(approvingDone(), false);
    } finally {
      g.open();
    }
    const r = await within(approving, 20_000, "the approval");
    assert.equal(r.status, 200, r.text);
  });
  assert.equal(await bindingState(b.team.bindingId), "active", "the refused Unbind changed nothing");
  const counts = await teamCounts(b.team.teamId);
  assert.equal(counts.approvals, 1);
  assert.ok(counts.metric_values > 0);
  assert.equal(counts.metric_values, counts.provenance);
  assert.deepEqual(deadlockLines(logFrom), []);
});

// ---------------------------------------------------------------------------
// 3. An approval against a 7g end of the team's source instance
// ---------------------------------------------------------------------------

test("3. an approval against a 7g end of the team's source instance, both orders: the end holding the team lock (after its team try-lock and its bindings FOR SHARE) makes a bounded approval 409 try_again with nothing written, the end then refuses instance_binding_active; an approval holding the team lock makes the end 409 try_again and then imports, the instance still active - no 40P01", async () => {
  const logFrom = errorLines.length;
  const { team, details: [c1, c2] } = await teamWithCandidates(2);
  await withSwitchOn(async () => {
    const r = await approve(team, c1);
    assert.equal(r.status, 200, r.text);
  });
  const [instance] = (await t7Keys(admin, team.teamId)).filter((row) => row.state === "active");
  assert.ok(instance, "the first import keyed the team's source instance (T7)");
  assert.deepEqual([instance.source_host_key, instance.source_instance_key], ["server3", team.gpexeTeamId]);

  // (a) The end first.
  const before = await allRowCounts();
  const ge = gate();
  instances.setInstanceSeamsForTests({ afterBindings: ge.hold });
  const ending = endInstance(team, instance);
  const endingDone = settled(ending);
  try {
    await within(ge.reached, 15_000, "the 7g end holds the team lock");
    await withSwitchOn(async () => {
      const r = await withBounds({ lockTimeoutMs: 300 }, () => approve(team, c2));
      assert.deepEqual([r.status, r.body.error], [409, "try_again"], r.text);
    });
    assert.deepEqual(await allRowCounts(), before, "nothing written");
    assert.equal(endingDone(), false);
  } finally {
    ge.open();
  }
  const e = await within(ending, 20_000, "the 7g end");
  assert.deepEqual([e.status, e.body.error], [409, "instance_binding_active"], e.text);
  instances.setInstanceSeamsForTests();
  assert.deepEqual(await allRowCounts(), before, "the refused end wrote nothing either");
  assert.equal((await candidateRow(c2.id)).status, "pending");

  // (b) The approval first.
  await withSwitchOn(async () => {
    const g = gate();
    service.setApprovalObserver(({ client }) => g.hold(client));
    const approving = approve(team, c2);
    const approvingDone = settled(approving);
    try {
      await within(g.reached, 20_000, "the approval holds the team lock");
      const refused = await within(endInstance(team, instance), 10_000, "the 7g end");
      assert.deepEqual([refused.status, refused.body.error], [409, "try_again"], refused.text);
      assert.equal(approvingDone(), false);
    } finally {
      g.open();
    }
    const r = await within(approving, 20_000, "the approval");
    assert.equal(r.status, 200, r.text);
  });
  const after = (await t7Keys(admin, team.teamId)).find((row) => row.id === instance.id);
  assert.equal(after.state, "active", "the instance was not ended");
  assert.equal((await teamCounts(team.teamId)).approvals, 2);
  assert.deepEqual(deadlockLines(logFrom), []);
});

// ---------------------------------------------------------------------------
// 4. Two approvals of the same team at once
// ---------------------------------------------------------------------------

test("4. two approvals of two candidates of the same team at the same time: the second waits on the team import lock the first holds, then both import - one after the other, no 40P01", async () => {
  const logFrom = errorLines.length;
  const { team, details: [c1, c2] } = await teamWithCandidates(2);
  await withSwitchOn(async () => {
    const g = gate();
    service.setApprovalObserver(({ client }) => g.hold(client));
    const first = approve(team, c1);
    const firstDone = settled(first);
    let second = null;
    try {
      await within(g.reached, 20_000, "the first approval imported inside its transaction and holds the team lock");
      second = approve(team, c2);
      const secondDone = settled(second);
      assert.ok(await waiterBlockedBy(g.pid), "the second approval waits on a lock the first holds");
      await sleep(150);
      assert.deepEqual([firstDone(), secondDone()], [false, false]);
    } finally {
      g.open();
    }
    const r1 = await within(first, 20_000, "the first approval");
    const r2 = await within(second, 20_000, "the second approval");
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r2.status, 200, r2.text);
    assert.equal(r1.body.commitConfirmation, "confirmed");
    assert.equal(r2.body.commitConfirmation, "confirmed");
  });
  const counts = await teamCounts(team.teamId);
  assert.equal(counts.approvals, 2);
  assert.equal(counts.events, 2, "one event per session");
  assert.ok(counts.metric_values > 0);
  assert.equal(counts.metric_values, counts.provenance);
  assert.equal(counts.source_instances, 1, "one source instance, keyed once");
  for (const c of [c1, c2]) assert.equal((await candidateRow(c.id)).status, "imported");
  assert.deepEqual(deadlockLines(logFrom), []);
});

// ---------------------------------------------------------------------------
// 5. A 7d end by another platform admin and a revoke of the approver's grant
// ---------------------------------------------------------------------------

test("5. a coach's approval held after step 5 (its T5 rows FOR SHARE), a revoke of the coach's grant and a 7d end by another platform admin during it: the revoke lands at once, the end waits on the approval's lock, the approval answers 403 not_an_approver at step 6b with nothing written, and only then the end commits - no 40P01", async () => {
  const logFrom = errorLines.length;
  const { team, details: [c] } = await teamWithCandidates(1, { coach: true });
  const otherAdmin = await worldPlatformAdmin(admin, "9b-conc-other");
  const [activationId] = team.started.gpexe_time_min;
  assert.ok(activationId);
  await withSwitchOn(async () => {
    const g = gate();
    setSourceInstanceHoldForTests(g.hold);
    const approving = approve(team, c, { cookie: team.coach.cookie });
    const approvingDone = settled(approving);
    let ending = null;
    try {
      await within(g.reached, 20_000, "the coach's approval passed step 1 and holds after step 5");
      const revoked = await within(
        gpexe(`/teams/${team.teamId}/approvers/${team.coach.grantId}/revoke`, { method: "POST", cookie: team.padmin.cookie, body: { reason: "9-B concurrency test revoke." } }),
        10_000, "the revoke");
      assert.equal(revoked.status, 200, revoked.text);
      ending = endActivation(otherAdmin, activationId);
      const endDone = settled(ending);
      assert.ok(await waiterBlockedBy(g.pid), "the 7d end waits on a lock the approval holds (the T5 row FOR SHARE)");
      await sleep(100);
      assert.deepEqual([approvingDone(), endDone()], [false, false]);
    } finally {
      g.open();
    }
    const r = await within(approving, 20_000, "the approval");
    assert.deepEqual([r.status, r.body.error], [403, "not_an_approver"], r.text);
    const ended = await within(ending, 20_000, "the 7d end");
    assert.equal(ended.replayed, false);
  });
  assert.notEqual(await activationEndedAt(activationId), null, "the end committed after the approval rolled back");
  assert.deepEqual(await teamCounts(team.teamId), ZERO, "nothing written: no value, approval or source instance");
  assert.equal((await candidateRow(c.id)).status, "pending");
  assert.deepEqual(deadlockLines(logFrom), []);
});

// ---------------------------------------------------------------------------
// 6. R16: the team or its club archived while the approval waits
// ---------------------------------------------------------------------------

test("6. R16: the team archived while a single approval waits on the team import lock (after its candidate lock) is the identical 404 notFound, nothing written; the club archived while a batch's first approval waits stops the batch - that one refused notFound, the rest not_attempted, nothing written", async () => {
  const logFrom = errorLines.length;

  // The single route.
  const s = await teamWithCandidates(1);
  const before = await allRowCounts();
  const holder = await holdTeamLock(s.team.teamId);
  let single;
  try {
    await withSwitchOn(async () => {
      const approving = approve(s.team, s.details[0]);
      settled(approving);
      assert.ok(await waiterBlockedBy(holder.pid), "the approval waits on the team import lock");
      await admin.query(`update public.teams set is_active = false where id = $1`, [s.team.teamId]);
      await holder.release();
      single = await within(approving, 20_000, "the approval");
    });
  } finally {
    await holder.release();
  }
  assert.equal(single.status, 404, single.text);
  const missing = await gpexe(`/teams/${crypto.randomUUID()}/candidates/${s.details[0].id}/approve`, { method: "POST", cookie: s.team.padmin.cookie, body: { previewHash: s.details[0].previewHash } });
  assert.equal(missing.status, 404);
  assert.deepEqual(single.body, missing.body, "the identical 404 of a team that does not exist");
  assert.deepEqual(single.body, { error: "notFound" });
  assert.deepEqual(await allRowCounts(), before, "nothing written");

  // The batch takes clean Ready candidates only (no athlete needing a manual
  // review), so its sessions carry athletes 101 and 102 alone.
  const b = await teamWithCandidates(2, { athletes: standardAthletes().slice(0, 2) });
  const [b1, b2] = b.details;
  const beforeBatch = await teamCounts(b.team.teamId);
  const holder2 = await holdTeamLock(b.team.teamId);
  let batch;
  try {
    await withSwitchOn(async () => {
      const batching = gpexe(`/teams/${b.team.teamId}/imports`, {
        method: "POST", cookie: b.team.padmin.cookie,
        body: { candidateIds: [b1.id, b2.id], previewHashes: { [b1.id]: b1.previewHash, [b2.id]: b2.previewHash } },
      });
      settled(batching);
      assert.ok(await waiterBlockedBy(holder2.pid), "the batch's first approval waits on the team import lock");
      await admin.query(`update public.clubs set is_active = false where id = $1`, [b.team.clubId]);
      await holder2.release();
      batch = await within(batching, 20_000, "the batch");
    });
  } finally {
    await holder2.release();
  }
  assert.equal(batch.status, 200, batch.text);
  assert.deepEqual(batch.body.results.map((r) => [r.candidateId, r.outcome, r.code]), [[b1.id, "refused", "notFound"], [b2.id, "not_attempted", null]]);
  assert.equal(batch.body.summary.imported, 0);
  assert.equal(batch.body.summary.notAttempted, 1);
  assert.deepEqual(await teamCounts(b.team.teamId), beforeBatch, "nothing written");
  for (const c of [b1, b2]) assert.equal((await candidateRow(c.id)).status, "pending");
  assert.deepEqual(deadlockLines(logFrom), []);
});

// ---------------------------------------------------------------------------
// 7. T7 23505: another team's active instance of the same GPEXE team
// ---------------------------------------------------------------------------

test("7a. the writer held before its T7 lock while another team's active instance of the same (server3, GPEXE team) is committed: the import's insert takes the 23505 in its savepoint, the import is refused source_instance_held, and its transaction stays usable - nothing written for the team", async () => {
  const a = await mappedTeam({ only: ["gpexe_total_distance"] });
  const other = await createGpexePilotOrg(admin, { athleteNames: ["X1"] });
  const g = gate();
  setSourceInstanceHoldForTests(g.hold);
  const client = await newClient();
  let otherInstance = null;
  try {
    await client.query("begin");
    await lockTeamForImport(client, a.teamId);
    const importing = importGpexeBundleLocked(client, writerBundle(a), writerCtx(a));
    const importDone = settled(importing);
    try {
      await within(g.reached, 15_000, "the import holds before its T7 lock");
      otherInstance = await within(rawInstance(other.teamId, a.sourceTeamId), 10_000, "the other team's instance (it waits on nothing the import holds)");
      assert.equal(importDone(), false);
    } finally {
      g.open();
    }
    await assert.rejects(within(importing, 20_000, "the import"), (error) => error instanceof GpexeImportError && error.code === "source_instance_held");
    // The savepoint took the 23505: the same transaction still answers, and holds no row of the refused insert.
    assert.equal((await client.query(`select 1 as one`)).rows[0].one, 1, "the transaction is not aborted");
    assert.equal((await client.query(`select count(*)::int as n from training_load.metric_source_connections where owner_team_id = $1`, [a.teamId])).rows[0].n, 0);
  } finally {
    g.open();
    await client.query("rollback").catch(() => {});
    await client.end();
  }
  assert.deepEqual(await teamCounts(a.teamId), ZERO, "nothing written");
  const held = (await admin.query(`select owner_team_id, state, source_host_key, source_instance_key from training_load.metric_source_connections where id = $1`, [otherInstance])).rows[0];
  assert.deepEqual([String(held.owner_team_id), held.state, held.source_host_key, held.source_instance_key], [String(other.teamId), "active", "server3", a.sourceTeamId]);
});

test("7b. the same race inside an approval: the approval's insert takes the 23505 in its savepoint, the approval answers 409 preview_changed (not a 500: the transaction stayed usable for the refreshed preview), the stored preview is blocked source_instance_held, and nothing is written", async () => {
  const logFrom = errorLines.length;
  const { team, details: [c] } = await teamWithCandidates(1);
  const other = await createGpexePilotOrg(admin, { athleteNames: ["X1"] });
  assert.equal((await t7Keys(admin, team.teamId)).length, 0, "the team holds no source instance yet");
  let r;
  await withSwitchOn(async () => {
    const g = gate();
    setSourceInstanceHoldForTests(g.hold);
    const approving = approve(team, c);
    const approvingDone = settled(approving);
    try {
      await within(g.reached, 20_000, "the approval holds before its T7 lock");
      await within(rawInstance(other.teamId, team.gpexeTeamId), 10_000, "the other team's instance");
      assert.equal(approvingDone(), false);
    } finally {
      g.open();
    }
    r = await within(approving, 20_000, "the approval");
  });
  assert.deepEqual([r.status, r.body.error], [409, "preview_changed"], r.text);
  const stored = await candidateRow(c.id);
  assert.equal(stored.status, "blocked");
  assert.equal(stored.preview.blocked.code, "source_instance_held");
  assert.notEqual(stored.preview_hash, c.previewHash);
  assert.deepEqual(await teamCounts(team.teamId), ZERO, "nothing written");
  assert.deepEqual(deadlockLines(logFrom), []);
});
