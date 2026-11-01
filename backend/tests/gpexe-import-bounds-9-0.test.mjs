// Phase 9, 9-0 (J17 section 9): switch conditions 2 and 3, on a disposable
// database through the real server.
//   Condition 2 - every wait of an approval before its COMMIT, and of the
//   check-time preview, is bounded by the server (lock_timeout,
//   statement_timeout, idle_in_transaction_session_timeout, SET LOCAL right
//   after BEGIN); a bounded wait before the COMMIT is 409 try_again with
//   nothing written (a failed check with a stable code for the preview); an
//   error the COMMIT itself raises goes through resolveUncertainCommit, never
//   try_again; a session the server ends never ends the process.
//   Condition 3 - the undo takes the team's import lock first, so an undo
//   waits for a running import of the same team and the reverse.
// GPEXE is a fake client; the import switch is turned on inside this process
// only, for the approval tests.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { importGpexePlan, importGpexePlanLocked, lockTeamForImport } from "../src/gpexeImportWriter.js";
import {
  IMPORT_IDLE_IN_TRANSACTION_MS, IMPORT_LOCK_TIMEOUT_MS, IMPORT_STATEMENT_TIMEOUT_MS,
  setCheckPreviewHoldForTests, setImportTransactionBounds, setImportTransactionBoundsForTests,
} from "../src/gpexeImportPreview.js";
import { undoImportedSession } from "../scripts/gpexe-undo-imported-session.mjs";
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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "bounds" });
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
  service?.setApprovalObserver(null);
  setImportTransactionBoundsForTests(null);
  setCheckPreviewHoldForTests(null);
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

// ---------------------------------------------------------------------------
// Helpers (the in-app import suite's, narrowed to what these tests need)
// ---------------------------------------------------------------------------

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load/gpexe${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
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

async function platformAdmin() {
  const id = await makeUser("platform admin");
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}

// A fake GPEXE: the sessions of the given bundles; fetchGate holds every
// bundle read until it resolves.
function fakeGpexe({ bundles = [], fetchGate = null, onFetch = null } = {}) {
  return () => ({
    async listTeamSessions() {
      return bundles.map((b) => ({ id: String(b.teamSession.id) }));
    },
    async fetchSessionBundle({ sessionId }) {
      if (onFetch) onFetch();
      if (fetchGate) await fetchGate;
      return structuredClone(bundles.find((b) => String(b.teamSession.id) === sessionId));
    },
  });
}

// v33: a session with two drills is actionable only when both drill answers
// are non-empty and distinct, so the route's sessions carry both drills.
function routeBundle(sessionId, { gpexeTeamId, athletes = standardAthletes() } = {}) {
  return makeBundle({ sessionId, gpexeTeamId, athletes, detailsDrills: [0, 1] });
}

// A team with athletes 101, 102, 103 linked (103 is on two tracks and stays
// out, as in J17's Arm A1).
let nextGpexeTeamId = 3000;
async function setupTeam() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A101", "B102", "C103"] });
  const padmin = await platformAdmin();
  const gpexeTeamId = String(nextGpexeTeamId++);
  assert.equal((await api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId } })).status, 200);
  for (const [gpexeAthleteId, athleteId] of [["101", org.athleteIds[0]], ["102", org.athleteIds[1]], ["103", org.athleteIds[2]]]) {
    assert.equal((await api(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: padmin.cookie, body: { gpexeAthleteId, athleteId } })).status, 201);
  }
  return { ...org, padmin, gpexeTeamId };
}

async function waitForCheck(teamId, checkId, cookie) {
  for (let i = 0; i < 400; i += 1) {
    const r = await api(`/teams/${teamId}/checks/${checkId}`, { cookie });
    if (r.body.check?.status !== "running") return r.body.check;
    await sleep(25);
  }
  throw new Error("check did not finish");
}

async function startCheck(team) {
  const started = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.padmin.cookie, body: {} });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return started.body.check.id;
}

async function checkNow(team) {
  return waitForCheck(team.teamId, await startCheck(team), team.padmin.cookie);
}

async function candidates(team) {
  return (await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates;
}

async function candidateDetail(team, id) {
  return (await api(`/teams/${team.teamId}/candidates/${id}`, { cookie: team.padmin.cookie })).body.candidate;
}

// A team with one checked, actionable candidate per session id.
async function teamWithCandidates(sessionIds, { athletes } = {}) {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: sessionIds.map((id) => routeBundle(id, { athletes })) }));
  const check = await checkNow(team);
  assert.equal(check.status, "succeeded", JSON.stringify(check.error));
  const list = await candidates(team);
  assert.equal(list.length, sessionIds.length);
  for (const c of list) assert.deepEqual(c.approvalBlockers.filter((b) => b !== "import_switch_off"), [], `candidate ${c.id} is actionable`);
  return { team, list };
}

function approve(team, candidate) {
  return api(`/teams/${team.teamId}/candidates/${candidate.id}/approve`, {
    method: "POST", cookie: team.padmin.cookie, body: { previewHash: candidate.previewHash },
  });
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

// Row counts of every table an import can touch: "nothing written" means
// every one of them is exactly as before.
async function allRowCounts() {
  const tables = (await admin.query(
    `select table_schema || '.' || table_name as name from information_schema.tables
      where table_schema in ('training_load', 'training', 'public') and table_type = 'BASE TABLE' order by 1`,
  )).rows.map((r) => r.name);
  const counts = {};
  for (const name of tables) counts[name] = (await admin.query(`select count(*)::int as n from ${name}`)).rows[0].n;
  return counts;
}

async function newClient() {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  return client;
}

// Another session holding the team's import lock (the key of every import,
// check-time preview, check start, link, settings change, bind and Unbind).
async function holdTeamLock(teamId) {
  const holder = await newClient();
  await holder.query("begin");
  await lockTeamForImport(holder, teamId);
  return { release: async () => { await holder.query("rollback").catch(() => {}); await holder.end(); } };
}

// Another session holding one row FOR UPDATE.
async function holdRow(sql, params) {
  const holder = await newClient();
  await holder.query("begin");
  assert.equal((await holder.query(sql, params)).rowCount, 1);
  return { release: async () => { await holder.query("rollback").catch(() => {}); await holder.end(); } };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Uncaught exceptions while fn runs (an 'error' event on a checked-out
// client with no listener would be one, and would end a real server).
async function countUncaught(fn) {
  const seen = [];
  const onUncaught = (error) => { seen.push(error); };
  process.on("uncaughtException", onUncaught);
  try {
    const result = await fn();
    // A late socket error arrives on the next turns of the event loop.
    await sleep(300);
    return { result, uncaught: seen };
  } finally {
    process.off("uncaughtException", onUncaught);
  }
}

// The client the approval used (from its observer, after the import ran) and
// whether the pool dropped it.
async function approvalConnectionFate(fn) {
  let used = null;
  const removed = new Set();
  const onRemove = (client) => removed.add(client);
  appPool.on("remove", onRemove);
  try {
    const result = await fn((client) => { used = client; });
    for (let i = 0; i < 100 && used && !removed.has(used); i += 1) await sleep(20);
    return { result, used, dropped: Boolean(used && removed.has(used)) };
  } finally {
    appPool.off("remove", onRemove);
  }
}

// ---------------------------------------------------------------------------
// Condition 2: the approval
// ---------------------------------------------------------------------------

test("1. approval: the three bounds are SET LOCAL in the approval's own transaction (5 s lock, 10 s statement, 10 s idle) and none stays on the pooled connection", async () => {
  assert.deepEqual([IMPORT_LOCK_TIMEOUT_MS, IMPORT_STATEMENT_TIMEOUT_MS, IMPORT_IDLE_IN_TRANSACTION_MS], [5_000, 10_000, 10_000]);
  const { team, list } = await teamWithCandidates([9101]);
  const candidate = await candidateDetail(team, list[0].id);
  let inside = null;
  let pid = null;
  await withSwitchOn(async () => {
    service.setApprovalObserver(async ({ client }) => {
      pid = client.processID;
      inside = (await client.query(
        `select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement,
                current_setting('idle_in_transaction_session_timeout') as idle`,
      )).rows[0];
    });
    const r = await approve(team, candidate);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.commitConfirmation, "confirmed");
  });
  assert.deepEqual(inside, { lock: "5s", statement: "10s", idle: "10s" });
  // SET LOCAL ended with the transaction: the same pooled connection is back at the server's defaults.
  const held = [];
  try {
    for (let i = 0; i < 10; i += 1) {
      const c = await appPool.connect();
      held.push(c);
      if (c.processID === pid) {
        const after = (await c.query(
          `select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement,
                  current_setting('idle_in_transaction_session_timeout') as idle`,
        )).rows[0];
        assert.deepEqual(after, { lock: "0", statement: "0", idle: "0" });
        return;
      }
    }
    assert.fail("the approval's pooled connection was not found again");
  } finally {
    for (const c of held) c.release();
  }
});

test("2. approval: the team's advisory import lock held elsewhere is bounded - 409 try_again within the bound, nothing written, and the next approval imports", async () => {
  const { team, list } = await teamWithCandidates([9201]);
  const candidate = await candidateDetail(team, list[0].id);
  const before = await allRowCounts();
  const lock = await holdTeamLock(team.teamId);
  try {
    await withSwitchOn(() => withBounds({ lockTimeoutMs: 300 }, async () => {
      const started = performance.now();
      const r = await approve(team, candidate);
      const took = performance.now() - started;
      assert.deepEqual([r.status, r.body.error], [409, "try_again"], JSON.stringify(r.body));
      assert.match(r.body.message, /Nothing was imported/);
      assert.ok(took < 3_000, `answered within the bound (${Math.round(took)} ms)`);
    }));
  } finally {
    await lock.release();
  }
  assert.deepEqual(await allRowCounts(), before, "nothing written");
  assert.equal((await candidateDetail(team, candidate.id)).status, "pending");
  await withSwitchOn(async () => {
    const r = await approve(team, candidate);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

test("3. approval: a row lock held elsewhere is bounded - the candidate row, and the approver's role row (the first lock) - 409 try_again, nothing written", async () => {
  const { team, list } = await teamWithCandidates([9301]);
  const candidate = await candidateDetail(team, list[0].id);
  const before = await allRowCounts();
  const holds = [
    () => holdRow(`select id from training_load.gpexe_import_candidates where id = $1 for update`, [candidate.id]),
    () => holdRow(`select user_id from public.user_global_roles where user_id = $1 and role = 'platform_admin' for update`, [team.padmin.id]),
  ];
  for (const hold of holds) {
    const lock = await hold();
    try {
      await withSwitchOn(() => withBounds({ lockTimeoutMs: 300 }, async () => {
        const r = await approve(team, candidate);
        assert.deepEqual([r.status, r.body.error], [409, "try_again"], JSON.stringify(r.body));
      }));
    } finally {
      await lock.release();
    }
    assert.deepEqual(await allRowCounts(), before, "nothing written");
  }
});

test("4. approval: a statement ended by its bound before the COMMIT is 409 try_again, and what the import had already written in the transaction is rolled back", async () => {
  const { team, list } = await teamWithCandidates([9401]);
  const candidate = await candidateDetail(team, list[0].id);
  const before = await allRowCounts();
  let importWrote = 0;
  await withSwitchOn(() => withBounds({ statementTimeoutMs: 300 }, async () => {
    service.setApprovalObserver(async ({ client }) => {
      importWrote = (await client.query(`select count(*)::int as n from training_load.metric_events where owner_team_id = $1`, [team.teamId])).rows[0].n;
      await client.query("select pg_sleep(2)");
    });
    const r = await approve(team, candidate);
    assert.deepEqual([r.status, r.body.error], [409, "try_again"], JSON.stringify(r.body));
  }));
  assert.equal(importWrote, 1, "the import had written its event inside the transaction");
  assert.deepEqual(await allRowCounts(), before, "rolled back: nothing written");
});

test("5. approval: a session the server ends while idle in the transaction answers 409 try_again, the process lives on (no uncaught error), and the connection is not reused", async () => {
  const { team, list } = await teamWithCandidates([9501]);
  const candidate = await candidateDetail(team, list[0].id);
  const before = await allRowCounts();
  const run = await countUncaught(() => withSwitchOn(() => withBounds({ idleInTransactionMs: 300 }, () => approvalConnectionFate(async (seen) => {
    service.setApprovalObserver(async ({ client }) => {
      seen(client);
      // Idle in the transaction past its bound: the server ends the session.
      await sleep(1_200);
    });
    return approve(team, candidate);
  }))));
  const { result: fate, uncaught } = run;
  assert.deepEqual([fate.result.status, fate.result.body.error], [409, "try_again"], JSON.stringify(fate.result.body));
  assert.deepEqual(uncaught.map((e) => e?.message), [], "no uncaught error: the listener caught the server's end of the session");
  assert.equal(fate.dropped, true, "a session the server ended is not returned to the pool");
  assert.deepEqual(await allRowCounts(), before, "nothing written");
  // The server keeps answering.
  assert.equal((await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).status, 200);
});

// A deferred trigger on the approvals table that sleeps for the candidates
// listed in a marker table (created and dropped by the test).
async function withSlowDeferredTrigger(candidateIds, seconds, fn) {
  await admin.query(`create table public.bounds_9_0_slow_commit (candidate_id uuid primary key)`);
  await admin.query(`
    create function public.bounds_9_0_slow_commit_fn() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from public.bounds_9_0_slow_commit where candidate_id = new.candidate_id) then
        perform pg_sleep(${Number(seconds)});
      end if;
      return null;
    end $$`);
  await admin.query(`
    create constraint trigger bounds_9_0_slow_commit_trg after insert on training_load.gpexe_import_approvals
      deferrable initially deferred for each row execute function public.bounds_9_0_slow_commit_fn()`);
  for (const id of candidateIds) await admin.query(`insert into public.bounds_9_0_slow_commit values ($1)`, [id]);
  try {
    return await fn();
  } finally {
    await admin.query(`drop trigger bounds_9_0_slow_commit_trg on training_load.gpexe_import_approvals`);
    await admin.query(`drop function public.bounds_9_0_slow_commit_fn()`);
    await admin.query(`drop table public.bounds_9_0_slow_commit`);
  }
}

test("6a. PostgreSQL does not bound a COMMIT's deferred trigger work with statement_timeout, but does bound SET CONSTRAINTS ALL IMMEDIATE (the premise of firing it before the COMMIT)", async () => {
  const client = await newClient();
  try {
    await client.query(`create temp table bounds_probe (id int)`);
    await client.query(`create function pg_temp.bounds_probe_fn() returns trigger language plpgsql as $$ begin perform pg_sleep(1.5); return null; end $$`);
    await client.query(`create constraint trigger bounds_probe_trg after insert on bounds_probe deferrable initially deferred for each row execute function pg_temp.bounds_probe_fn()`);
    await client.query("begin");
    await client.query(`select set_config('statement_timeout', '300ms', true)`);
    await client.query(`insert into bounds_probe values (1)`);
    const started = performance.now();
    await client.query("commit");
    const commitMs = performance.now() - started;
    assert.ok(commitMs >= 1_400, `the COMMIT ran its 1.5 s deferred trigger to the end under a 300 ms statement_timeout (${Math.round(commitMs)} ms)`);
    assert.equal((await client.query(`select count(*)::int as n from bounds_probe`)).rows[0].n, 1, "and committed");

    await client.query("begin");
    await client.query(`select set_config('statement_timeout', '300ms', true)`);
    await client.query(`insert into bounds_probe values (2)`);
    await assert.rejects(client.query("set constraints all immediate"), (error) => error.code === "57014");
    await client.query("rollback");
    assert.equal((await client.query(`select count(*)::int as n from bounds_probe`)).rows[0].n, 1, "the bounded one wrote nothing");
  } finally {
    await client.end();
  }
});

test("6b. approval: the deferred trigger work runs before the COMMIT under the statement bound - a slow deferred trigger answers 409 try_again, nothing written, never an unknown outcome; approving again imports", async () => {
  const { team, list } = await teamWithCandidates([9601]);
  const candidate = await candidateDetail(team, list[0].id);
  const before = await allRowCounts();
  await withSlowDeferredTrigger([candidate.id], 3, async () => {
    const markerRow = { "public.bounds_9_0_slow_commit": 1 };
    await withSwitchOn(() => withBounds({ statementTimeoutMs: 500 }, async () => {
      const started = performance.now();
      const r = await approve(team, candidate);
      const took = performance.now() - started;
      assert.deepEqual([r.status, r.body.error], [409, "try_again"], JSON.stringify(r.body));
      assert.ok(took < 2_500, `bounded by the server before the COMMIT (${Math.round(took)} ms)`);
    }));
    assert.deepEqual(await allRowCounts(), { ...before, ...markerRow }, "nothing written");
  });
  await withSwitchOn(async () => {
    const r = await approve(team, await candidateDetail(team, candidate.id));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

test("6c. approval: an error the COMMIT itself raises goes through resolveUncertainCommit, never try_again - a 57014 at the COMMIT that did not land is 503 import_outcome_unknown, one that landed is imported (verified)", async () => {
  const { team, list } = await teamWithCandidates([9611, 9612]);
  const [first, second] = await Promise.all(list.map((c) => candidateDetail(team, c.id)));
  const cancelled = () => Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  const before = await allRowCounts();
  await withSwitchOn(async () => {
    service.setApprovalCommitForTests(async (client) => { await client.query("rollback"); throw cancelled(); });
    try {
      const r = await approve(team, first);
      assert.deepEqual([r.status, r.body.error], [503, "import_outcome_unknown"], JSON.stringify(r.body));
      assert.ok(!/nothing was imported/i.test(JSON.stringify(r.body)));
    } finally {
      service.setApprovalCommitForTests(null);
    }
  });
  assert.deepEqual(await allRowCounts(), before, "it did not land");
  await withSwitchOn(async () => {
    service.setApprovalCommitForTests(async (client) => { await client.query("commit"); throw cancelled(); });
    try {
      const r = await approve(team, second);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.commitConfirmation, "verified_after_commit_error");
    } finally {
      service.setApprovalCommitForTests(null);
    }
  });
});

test("6d. approval: nothing is written between SET CONSTRAINTS ALL IMMEDIATE and the COMMIT - the approval's last two statements are exactly those two", async () => {
  const { team, list } = await teamWithCandidates([9621]);
  const candidate = await candidateDetail(team, list[0].id);
  const wrapped = new Map();
  const onAcquire = (c) => { if (!wrapped.has(c)) wrapped.set(c, timeStatements(c)); };
  let approvalClient = null;
  appPool.on("acquire", onAcquire);
  try {
    await withSwitchOn(async () => {
      service.setApprovalObserver(({ client: c }) => { approvalClient = c; });
      const r = await approve(team, candidate);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    });
  } finally {
    appPool.off("acquire", onAcquire);
    for (const w of wrapped.values()) w.restore();
  }
  // The statements the approval sent on its own client, in order of completion
  // (sent one after another, so the same as the order sent).
  const texts = wrapped.get(approvalClient).times.map((t) => t.text.replace(/\s+/g, " ").trim().toLowerCase());
  const commit = texts.lastIndexOf("commit");
  assert.ok(commit > 0, "the approval committed on its client");
  assert.deepEqual(texts.slice(commit - 1, commit + 1), ["set constraints all immediate", "commit"]);
  assert.equal(texts.indexOf("set constraints all immediate"), commit - 1, "sent once, right before the COMMIT");
});

test("6e. approval: a deferred check that refuses (23514) at SET CONSTRAINTS ALL IMMEDIATE is the existing refusal before the COMMIT - 500 internal_error, nothing written, never try_again or an unknown outcome", async () => {
  const { team, list } = await teamWithCandidates([9631]);
  const candidate = await candidateDetail(team, list[0].id);
  const before = await allRowCounts();
  await admin.query(`create table public.bounds_9_0_refuse (candidate_id uuid primary key)`);
  await admin.query(`
    create function public.bounds_9_0_refuse_fn() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from public.bounds_9_0_refuse where candidate_id = new.candidate_id) then
        raise exception 'bounds 9-0 deferred refusal' using errcode = 'check_violation';
      end if;
      return null;
    end $$`);
  await admin.query(`
    create constraint trigger bounds_9_0_refuse_trg after insert on training_load.gpexe_import_approvals
      deferrable initially deferred for each row execute function public.bounds_9_0_refuse_fn()`);
  await admin.query(`insert into public.bounds_9_0_refuse values ($1)`, [candidate.id]);
  try {
    await withSwitchOn(async () => {
      const r = await approve(team, candidate);
      assert.deepEqual([r.status, r.body.error], [500, "internal_error"], JSON.stringify(r.body));
      assert.match(r.body.message, /nothing was imported/);
      assert.ok(!/bounds 9-0/.test(JSON.stringify(r.body)), "the database's text never reaches the caller");
    });
    assert.deepEqual(await allRowCounts(), { ...before, "public.bounds_9_0_refuse": 1 }, "nothing written");
  } finally {
    await admin.query(`drop trigger bounds_9_0_refuse_trg on training_load.gpexe_import_approvals`);
    await admin.query(`drop function public.bounds_9_0_refuse_fn()`);
    await admin.query(`drop table public.bounds_9_0_refuse`);
  }
});

test("7. batch: a bounded wait stops the batch - the first candidate is refused try_again, the rest not_attempted, nothing written", async () => {
  // A batch takes clean Ready candidates only: no athlete on two tracks.
  const { team, list } = await teamWithCandidates([9701, 9702], { athletes: standardAthletes().slice(0, 2) });
  const before = await allRowCounts();
  const lock = await holdTeamLock(team.teamId);
  try {
    await withSwitchOn(() => withBounds({ lockTimeoutMs: 300 }, async () => {
      const r = await api(`/teams/${team.teamId}/imports`, {
        method: "POST", cookie: team.padmin.cookie,
        body: { candidateIds: list.map((c) => c.id), previewHashes: Object.fromEntries(list.map((c) => [c.id, c.previewHash])) },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.results.map((x) => [x.outcome, x.code]), [["refused", "try_again"], ["not_attempted", null]]);
    }));
  } finally {
    await lock.release();
  }
  assert.deepEqual(await allRowCounts(), before, "nothing written");
});

// Every statement of one client, timed.
function timeStatements(client) {
  const original = client.query;
  const times = [];
  client.query = function timed(...args) {
    const text = typeof args[0] === "string" ? args[0] : String(args[0]?.text ?? "");
    const started = performance.now();
    const answer = original.apply(this, args);
    if (answer && typeof answer.then === "function") {
      answer.then(() => times.push({ text, ms: performance.now() - started }), () => times.push({ text, ms: performance.now() - started, failed: true }));
    }
    return answer;
  };
  return { times, restore: () => { client.query = original; } };
}

function summarize(times) {
  const commit = times.filter((t) => /^\s*commit\s*$/i.test(t.text));
  const others = times.filter((t) => !/^\s*commit\s*$/i.test(t.text));
  const longest = others.reduce((a, b) => (b.ms > a.ms ? b : a), { ms: 0, text: "" });
  return {
    statements: others.length,
    longestMs: Math.round(longest.ms * 10) / 10,
    longest: longest.text.replace(/\s+/g, " ").slice(0, 80),
    commitMs: commit.length ? Math.round(commit[commit.length - 1].ms * 10) / 10 : null,
    totalMs: Math.round(times.reduce((sum, t) => sum + t.ms, 0)),
  };
}

test("8. Arm A1 commits under the production bounds: the writer on J17's Arm A1 (53 values) and an approval through the route, every statement and the COMMIT measured far below the 10 s statement bound", async () => {
  // (a) The writer's own entry on Arm A1 exactly (makeBundle with the standard
  // athletes, detailsDrills [0]: 53 values), in the approval's transaction
  // shape: BEGIN, the bounds, the team lock, the import, COMMIT.
  const org = await setupTeam();
  const client = await newClient();
  const writer = timeStatements(client);
  let armA1;
  try {
    await client.query("begin");
    await setImportTransactionBounds(client);
    await lockTeamForImport(client, org.teamId);
    const plan = buildGpexeImportPlan(makeBundle({ athletes: standardAthletes() }));
    await importGpexePlanLocked(client, plan, {
      ownerTeamId: org.teamId, performedByUserId: org.padmin.id,
      athleteIdByGpexeId: { 101: org.athleteIds[0], 102: org.athleteIds[1], 103: org.athleteIds[2] }, batchFilename: "bounds 9-0 arm A1",
    });
    await client.query("commit");
  } finally {
    writer.restore();
    await client.end();
  }
  armA1 = summarize(writer.times);
  const values = (await admin.query(
    `select count(*)::int as n from training_load.metric_values v
       join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`,
    [org.teamId],
  )).rows[0].n;
  assert.equal(values, 53, "J17's Arm A1: 53 values");

  // (b) An approval through the real route (both drills, as v33 requires),
  // every statement of the approval's pooled client timed.
  const { team, list } = await teamWithCandidates([9801]);
  const candidate = await candidateDetail(team, list[0].id);
  const wrapped = new Map();
  const onAcquire = (c) => { if (!wrapped.has(c)) wrapped.set(c, timeStatements(c)); };
  let approvalClient = null;
  appPool.on("acquire", onAcquire);
  let route;
  try {
    await withSwitchOn(async () => {
      service.setApprovalObserver(({ client: c }) => { approvalClient = c; });
      const r = await approve(team, candidate);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.commitConfirmation, "confirmed", "committed under the production bounds");
    });
  } finally {
    appPool.off("acquire", onAcquire);
    for (const w of wrapped.values()) w.restore();
  }
  route = summarize(wrapped.get(approvalClient).times);
  console.log(`[9-0 measurement] Arm A1 writer: ${JSON.stringify(armA1)}`);
  console.log(`[9-0 measurement] route approval: ${JSON.stringify(route)}`);
  for (const m of [armA1, route]) {
    assert.ok(m.longestMs < IMPORT_STATEMENT_TIMEOUT_MS / 4, `the longest statement (${m.longestMs} ms) is far below the bound`);
    assert.ok(m.commitMs < IMPORT_STATEMENT_TIMEOUT_MS / 4, `the COMMIT (${m.commitMs} ms) is far below the bound`);
  }
});

// ---------------------------------------------------------------------------
// Condition 2: the check-time preview
// ---------------------------------------------------------------------------

async function checkRow(checkId) {
  return (await admin.query(`select status, error_code from training_load.gpexe_import_checks where id = $1`, [checkId])).rows[0];
}

async function stagedAndPublished(teamId, checkId) {
  return {
    observations: (await admin.query(`select count(*)::int as n from training_load.gpexe_import_check_observations where check_id = $1`, [checkId])).rows[0].n,
    candidates: (await admin.query(`select count(*)::int as n from training_load.gpexe_import_candidates where owner_team_id = $1`, [teamId])).rows[0].n,
  };
}

test("9. check: a preview that waits for the team lock past its bound fails the check with check_preview_busy - never a blocked candidate, nothing published", async () => {
  const team = await setupTeam();
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  let fetched = false;
  service.setGpexeClientFactory(fakeGpexe({ bundles: [routeBundle(9901)], fetchGate, onFetch: () => { fetched = true; } }));
  let checkId;
  let lock;
  await withBounds({ lockTimeoutMs: 300 }, async () => {
    checkId = await startCheck(team);
    // The check has started (its own short start transaction took and left the
    // team lock); now another session takes the lock before the preview runs.
    for (let i = 0; i < 200 && !fetched; i += 1) await sleep(10);
    assert.ok(fetched, "the check reached its bundle read");
    lock = await holdTeamLock(team.teamId);
    releaseFetch();
    try {
      const check = await waitForCheck(team.teamId, checkId, team.padmin.cookie);
      assert.equal(check.status, "failed");
      assert.equal(check.error.code, "check_preview_busy");
      assert.match(check.error.message, /nothing of the check was published/);
    } finally {
      await lock.release();
    }
  });
  assert.deepEqual(await checkRow(checkId), { status: "failed", error_code: "check_preview_busy" });
  assert.deepEqual(await stagedAndPublished(team.teamId, checkId), { observations: 0, candidates: 0 });
});

test("10. check: a preview statement ended by its bound fails the check with check_preview_busy, nothing published", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [routeBundle(10001)] }));
  setCheckPreviewHoldForTests((client) => client.query("select pg_sleep(2)"));
  let check;
  try {
    check = await withBounds({ statementTimeoutMs: 300 }, () => checkNow(team));
  } finally {
    setCheckPreviewHoldForTests(null);
  }
  assert.deepEqual([check.status, check.error.code], ["failed", "check_preview_busy"]);
  assert.deepEqual(await stagedAndPublished(team.teamId, check.id), { observations: 0, candidates: 0 });
});

test("11. check: the database ends the preview's session (the idle bound) - the check fails with check_preview_interrupted, the process lives on, the connection is not reused", async () => {
  const team = await setupTeam();
  service.setGpexeClientFactory(fakeGpexe({ bundles: [routeBundle(11001)] }));
  let used = null;
  const removed = new Set();
  const onRemove = (client) => removed.add(client);
  appPool.on("remove", onRemove);
  setCheckPreviewHoldForTests(async (client) => { used = client; await sleep(1_200); });
  let run;
  try {
    run = await countUncaught(() => withBounds({ idleInTransactionMs: 300 }, () => checkNow(team)));
    for (let i = 0; i < 100 && used && !removed.has(used); i += 1) await sleep(20);
  } finally {
    setCheckPreviewHoldForTests(null);
    appPool.off("remove", onRemove);
  }
  const check = run.result;
  assert.deepEqual([check.status, check.error.code], ["failed", "check_preview_interrupted"], JSON.stringify(check.error));
  assert.deepEqual(run.uncaught.map((e) => e?.message), [], "no uncaught error");
  assert.ok(used && removed.has(used), "the ended session's connection is not returned to the pool");
  assert.deepEqual(await stagedAndPublished(team.teamId, check.id), { observations: 0, candidates: 0 });
  // The next check of the team runs normally.
  const again = await checkNow(team);
  assert.equal(again.status, "succeeded", JSON.stringify(again.error));
});

// ---------------------------------------------------------------------------
// Condition 3: the undo takes the team's import lock
// ---------------------------------------------------------------------------

async function undoTeam() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["U101", "U102", "U103"] });
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1, 'platform_admin', true)`, [org.userId]);
  return { ...org, athleteMap: { 101: org.athleteIds[0], 102: org.athleteIds[1], 103: org.athleteIds[2] } };
}

function importSession(org, sessionId, { onLocked } = {}) {
  return (async () => {
    const client = await newClient();
    try {
      return await importGpexePlan(client, buildGpexeImportPlan(makeBundle({ sessionId, athletes: standardAthletes() })), {
        ownerTeamId: org.teamId, performedByUserId: org.userId, athleteIdByGpexeId: org.athleteMap, batchFilename: "bounds 9-0 undo",
      }, { onLocked });
    } finally {
      await client.end();
    }
  })();
}

function undoDryRun(org, eventId, { onTeamLocked, onPid } = {}) {
  return (async () => {
    const client = await newClient();
    if (onPid) onPid(client.processID);
    try {
      return await undoImportedSession(client, { eventId }, { performedByUserId: org.userId, reason: "9-0 lock order test", apply: false, onTeamLocked });
    } finally {
      await client.end();
    }
  })();
}

async function waitsOnAdvisoryLock(pid) {
  for (let i = 0; i < 200; i += 1) {
    const n = (await admin.query(`select count(*)::int as n from pg_locks where pid = $1 and locktype = 'advisory' and not granted`, [pid])).rows[0].n;
    if (n > 0) return true;
    await sleep(10);
  }
  return false;
}

async function eventOf(org, sessionId) {
  return (await admin.query(
    `select e.id from training_load.metric_events e join training_load.metric_source_connections c on c.id = e.source_connection_id
      where c.owner_team_id = $1 and e.source_external_id = $2`,
    [org.teamId, `team_session:${sessionId}`],
  )).rows[0].id;
}

function settled(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
}

test("12. undo: an undo waits for a running import of the same team, and an import waits for a running undo (the team import lock, taken before the event)", async () => {
  const org = await undoTeam();
  await importSession(org, 12001);
  const eventId = await eventOf(org, 12001);

  // (a) An import of the same team holds the team lock: the undo waits on it.
  let releaseImport;
  const importGate = new Promise((resolve) => { releaseImport = resolve; });
  let importLocked;
  const importHasLock = new Promise((resolve) => { importLocked = resolve; });
  const running = importSession(org, 12002, { onLocked: async () => { importLocked(); await importGate; } });
  await importHasLock;
  let undoPid = null;
  const undo = undoDryRun(org, eventId, { onPid: (pid) => { undoPid = pid; } });
  const undoDone = settled(undo);
  for (let i = 0; i < 100 && undoPid === null; i += 1) await sleep(10);
  assert.ok(await waitsOnAdvisoryLock(undoPid), "the undo waits on the team's advisory import lock");
  assert.equal((await admin.query(`select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation where l.pid = $1 and c.relname = 'metric_events' and l.mode = 'RowShareLock'`, [undoPid])).rows[0].n, 0, "the undo has not locked the event yet");
  await sleep(200);
  assert.equal(undoDone(), false, "the undo is still waiting");
  releaseImport();
  await running;
  const log = await undo;
  assert.equal(log.outcome, "rolled_back", "the dry run went through after the import committed");

  // (b) An undo holds the team lock: an import of the same team waits on it.
  let releaseUndo;
  const undoGate = new Promise((resolve) => { releaseUndo = resolve; });
  let undoLocked;
  const undoHasLock = new Promise((resolve) => { undoLocked = resolve; });
  const holding = undoDryRun(org, eventId, { onTeamLocked: async () => { undoLocked(); await undoGate; } });
  await undoHasLock;
  const importClient = await newClient();
  const importPid = importClient.processID;
  const blocked = (async () => {
    try {
      return await importGpexePlan(importClient, buildGpexeImportPlan(makeBundle({ sessionId: 12003, athletes: standardAthletes() })), {
        ownerTeamId: org.teamId, performedByUserId: org.userId, athleteIdByGpexeId: org.athleteMap, batchFilename: "bounds 9-0 undo",
      });
    } finally {
      await importClient.end();
    }
  })();
  const importDone = settled(blocked);
  assert.ok(await waitsOnAdvisoryLock(importPid), "the import waits on the team's advisory import lock");
  await sleep(200);
  assert.equal(importDone(), false, "the import is still waiting");
  releaseUndo();
  assert.equal((await holding).outcome, "rolled_back");
  const imported = await blocked;
  assert.ok(imported.eventId, "the import went through after the undo ended");
});

test("13. undo: the platform admin is checked after the team lock - a revocation made while the undo waits for the lock lands at once (the undo holds no role row yet) and the undo then refuses; nothing holds the team lock afterwards", async () => {
  const org = await undoTeam();
  await importSession(org, 13001);
  const eventId = await eventOf(org, 13001);
  const lock = await holdTeamLock(org.teamId);
  let undoPid = null;
  const undo = undoDryRun(org, eventId, { onPid: (pid) => { undoPid = pid; } });
  undo.catch(() => {});
  try {
    for (let i = 0; i < 100 && undoPid === null; i += 1) await sleep(10);
    assert.ok(await waitsOnAdvisoryLock(undoPid), "the undo waits on the team lock");
    // The revocation must not wait behind the undo: bounded at 2 s.
    const revoker = await newClient();
    try {
      await revoker.query("begin");
      await revoker.query(`select set_config('lock_timeout', '2000ms', true)`);
      await revoker.query(`update public.user_global_roles set is_active = false where user_id = $1 and role = 'platform_admin'`, [org.userId]);
      await revoker.query("commit");
    } finally {
      await revoker.end();
    }
  } finally {
    await lock.release();
  }
  await assert.rejects(undo, /not an active platform admin/);
  // Nothing holds the team lock: an import of the team runs at once.
  const imported = await importSession(org, 13002);
  assert.ok(imported.eventId);
});
