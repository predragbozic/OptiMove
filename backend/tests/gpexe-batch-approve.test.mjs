// Imports phase 4a: POST /api/training-load/gpexe/teams/:teamId/imports
// approves several clean "Ready" candidates of a team, one after another,
// each through the single approval (approveCandidate). Through the real
// server on a disposable database; GPEXE is a fake client; the import switch
// is turned on inside this process only, for the tests that import.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "batch" });
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

async function api(path, { method = "GET", body, cookie, raw } = {}) {
  const res = await fetch(`${apiBase}/api/training-load/gpexe${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
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

// A session whose athletes are all linked, in the team and need no manual
// step (a clean "Ready" candidate), unless `ids` names 104 (never linked).
// Each session gets its own start time and track ids.
function cleanBundle({ sessionId, hour = 8, ids = [101, 102], distance101 = 3000, updatedOn = "2026-09-14T20:18:09.337" }) {
  const byId = Object.fromEntries(standardAthletes().map((a) => [a.id, a]));
  byId[104] = { ...structuredClone(byId[102]), id: 104 };
  const athletes = ids.map((id, i) => {
    const a = structuredClone(byId[id]);
    a.tracks = [sessionId * 10 + i];
    for (const part of a.parts) delete part.track;
    return a;
  });
  athletes.find((a) => a.id === 101)?.parts.forEach((p) => { if (p.drill === null) p.distance = distance101; });
  return makeBundle({ sessionId, gpexeTeamId: 77, start: `2026-09-14T${String(hour).padStart(2, "0")}:08:12`, updatedOn, athletes });
}

function fakeGpexe(bundles, { onUse } = {}) {
  return () => {
    onUse?.();
    return {
      async listTeamSessions() { return bundles.map((b) => ({ id: String(b.teamSession.id) })); },
      async fetchSessionBundle({ sessionId }) { return structuredClone(bundles.find((b) => String(b.teamSession.id) === sessionId)); },
    };
  };
}

let nextGpexeTeamId = 5000;
async function setupTeam() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A101", "B102", "C103", "D", "E", "F105"] });
  const [a, b, c, , , f] = org.athleteIds;
  const coach = await coachOf(org.teamId);
  const padmin = await platformAdmin();
  assert.equal((await api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: String(nextGpexeTeamId++) } })).status, 200);
  for (const [gpexeAthleteId, athleteId] of [["101", a], ["102", b], ["103", c], ["105", f]]) {
    assert.equal((await api(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId, athleteId } })).status, 201);
  }
  return { ...org, coach, padmin };
}

async function checkNow(team, bundles) {
  service.setGpexeClientFactory(fakeGpexe(bundles));
  const started = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body: {} });
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

// The current candidate id of each GPEXE session id.
async function candidateIds(team) {
  const list = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  // Newest first: the first row of a session is its current candidate.
  const ids = {};
  for (const c of list) ids[c.gpexeTeamSessionId] ??= c.id;
  return ids;
}

// The list as the coach sees it: id -> previewHash.
async function listedHashes(team) {
  const list = (await api(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  return Object.fromEntries(list.map((c) => [c.id, c.previewHash]));
}

// A batch as the screen would send it: each id with the preview hash the
// list shows right now (or `hashes`, a list read earlier). An id the list
// does not show gets a well-formed hash of zeros.
async function batch(team, ids, cookie = team.padmin.cookie, hashes = null) {
  const seen = hashes ?? await listedHashes(team);
  const previewHashes = Object.fromEntries(ids.map((id) => [id, seen[id] ?? "0".repeat(64)]));
  return api(`/teams/${team.teamId}/imports`, { method: "POST", cookie, body: { candidateIds: ids, previewHashes } });
}

async function withSwitchOn(fn) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await fn();
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
    service.setApprovalObserver(null);
    service.setApprovalCommitForTests(null);
    service.setUncertainCommitCheckForTests({});
  }
}

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

async function candidateStatus(id) {
  return (await admin.query(`select status from training_load.gpexe_import_candidates where id = $1`, [id])).rows[0].status;
}

async function eventsOf(teamId) {
  return (await admin.query(`select count(*)::int as n from training_load.metric_events where owner_team_id = $1`, [teamId])).rows[0].n;
}

const outcomes = (r) => r.body.results.map((x) => [x.candidateId, x.outcome, x.code]);

test("batch: two clean Ready sessions are both imported, in the order asked, each through the single approval with its own approval row", async (t) => {
  const team = await setupTeam();
  await checkNow(team, [cleanBundle({ sessionId: 8101, hour: 8 }), cleanBundle({ sessionId: 8102, hour: 10 })]);
  const ids = await candidateIds(team);
  // The list's newest-first order is 8102, 8101; the request asks 8101 first.
  const asked = [ids["8101"], ids["8102"]];
  const stored = Object.fromEntries((await admin.query(`select id, preview_hash from training_load.gpexe_import_candidates where id = any($1::uuid[])`, [asked])).rows.map((r) => [r.id, r.preview_hash]));

  await withSwitchOn(async () => {
    // The single approval's own hook, inside its transaction after the import
    // ran: the batch has no writer of its own.
    const seen = [];
    service.setApprovalObserver(({ candidateId }) => { seen.push(candidateId); });
    const started = performance.now();
    const r = await batch(team, asked);
    t.diagnostic(`two clean approvals in one batch took ${Math.round(performance.now() - started)} ms`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(outcomes(r), [[asked[0], "imported", null], [asked[1], "imported", null]]);
    assert.deepEqual(seen, asked, "each candidate went through approveCandidate, in the order asked");
    assert.deepEqual(r.body.summary, { requested: 2, imported: 2, alreadyImported: 0, refused: 0, unknown: 0, notAttempted: 0 });
    for (const res of r.body.results) {
      assert.equal(res.commitConfirmation, "confirmed");
      const [approval] = await approvalsOf(res.candidateId);
      assert.equal(approval.id, res.approvalId);
      assert.equal(approval.preview_hash, stored[res.candidateId], "the approval is bound to the preview hash the list showed");
      assert.deepEqual([approval.approved_by_user_id, approval.approval_basis, approval.changes_to_imported, approval.changes_accepted], [team.padmin.id, "platform_admin", 0, false]);
      assert.equal(await candidateStatus(res.candidateId), "imported");
    }
    assert.equal(await eventsOf(team.teamId), 2);
  });
});

test("batch: a refused candidate does not stop the next one - replaced by newer data, not ready (an unlinked athlete), changes that need acceptance, and a preview that changed under the lock (with reviewAgain); none of them is imported, an imported one is already_imported", async () => {
  const team = await setupTeam();
  // 8201: 101 only, imported first so that a resend changes it; 8205 stays
  // pending and is replaced by newer data.
  await checkNow(team, [cleanBundle({ sessionId: 8201, hour: 7, ids: [101] }), cleanBundle({ sessionId: 8205, hour: 15, ids: [101] })]);
  const first = (await candidateIds(team))["8201"];
  const replaced = (await candidateIds(team))["8205"];
  await withSwitchOn(async () => assert.equal((await batch(team, [first])).body.results[0].outcome, "imported"));

  // 8201 resent with another distance for 101 (changes an imported result),
  // 8202 with the unlinked 104 (not ready), 8203 with 101 and 102 (clean now,
  // but 102 is unlinked after the check), 8204 with 101 only (clean).
  await checkNow(team, [
    cleanBundle({ sessionId: 8201, hour: 7, ids: [101], distance101: 3300, updatedOn: "2026-09-15T09:00:00.000" }),
    cleanBundle({ sessionId: 8202, hour: 9, ids: [101, 104] }),
    cleanBundle({ sessionId: 8203, hour: 11, ids: [101, 102] }),
    cleanBundle({ sessionId: 8204, hour: 13, ids: [101] }),
    cleanBundle({ sessionId: 8205, hour: 15, ids: [101], distance101: 3100, updatedOn: "2026-09-15T09:00:00.000" }),
  ]);
  const ids = await candidateIds(team);
  const link102 = (await api(`/teams/${team.teamId}/athlete-links`, { cookie: team.coach.cookie })).body.links.find((l) => l.gpexeAthleteId === "102");
  assert.equal((await api(`/teams/${team.teamId}/athlete-links/${link102.id}/unlink`, { method: "POST", cookie: team.coach.cookie })).status, 200);

  await withSwitchOn(async () => {
    assert.equal(await candidateStatus(replaced), "superseded");
    const asked = [first, replaced, ids["8201"], ids["8202"], ids["8203"], ids["8204"]];
    const r = await batch(team, asked);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(outcomes(r), [
      [first, "already_imported", "already_imported"],
      [replaced, "refused", "superseded_by_newer_data"],
      [ids["8201"], "refused", "changes_need_acceptance"],
      [ids["8202"], "refused", "not_ready"],
      [ids["8203"], "refused", "preview_changed"],
      [ids["8204"], "imported", null],
    ]);
    const [already, superseded, changes, notReady, changed] = r.body.results;
    assert.equal(already.approvalId, (await approvalsOf(first))[0].id);
    assert.deepEqual(superseded.reviewAgain, { candidateId: ids["8205"], href: `/api/training-load/gpexe/teams/${team.teamId}/candidates/${ids["8205"]}` });
    assert.ok(changes.changesToImported > 0);
    assert.deepEqual(notReady.reasons, [{ code: "athletes_not_linked", count: 1 }]);
    assert.deepEqual(changed.reviewAgain, { candidateId: ids["8203"], href: `/api/training-load/gpexe/teams/${team.teamId}/candidates/${ids["8203"]}` });
    for (const res of r.body.results) assert.ok(!("message" in res), "codes only, never a message");
    for (const id of [ids["8201"], ids["8202"], ids["8203"]]) {
      assert.equal((await approvalsOf(id)).length, 0);
      assert.equal(await candidateStatus(id), "pending");
    }
    assert.equal(await eventsOf(team.teamId), 2, "the first import and 8204, nothing else");
    assert.deepEqual(r.body.summary, { requested: 6, imported: 1, alreadyImported: 1, refused: 4, unknown: 0, notAttempted: 0 });
  });
});

test("batch: an unconfirmed COMMIT that is not in the database stops the batch - import_outcome_unknown with the approval id and how to check, the rest not_attempted; repeating the request is safe", async () => {
  const team = await setupTeam();
  await checkNow(team, [8301, 8302, 8303].map((sessionId, i) => cleanBundle({ sessionId, hour: 8 + i * 2, ids: [101] })));
  const ids = await candidateIds(team);
  const asked = [ids["8301"], ids["8302"], ids["8303"]];
  let approvalId;
  await withSwitchOn(async () => {
    let commits = 0;
    service.setApprovalCommitForTests(async (client) => {
      commits += 1;
      if (commits === 2) {
        // The connection is lost before the server commits.
        await client.query("rollback");
        throw new Error("Connection terminated unexpectedly");
      }
      return client.query("commit");
    });
    const r = await batch(team, asked);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(outcomes(r), [[asked[0], "imported", null], [asked[1], "import_outcome_unknown", "import_outcome_unknown"], [asked[2], "not_attempted", null]]);
    assert.equal(commits, 2, "nothing was attempted after the unknown outcome");
    const unknown = r.body.results[1];
    approvalId = unknown.approvalId;
    assert.match(approvalId, /^[0-9a-f-]{36}$/);
    assert.equal(unknown.verify.approvalId, approvalId);
    assert.equal(unknown.verify.approvalHref, `/api/training-load/gpexe/teams/${team.teamId}/approvals/${approvalId}`);
    assert.ok(unknown.verify.imported && unknown.verify.notImported && unknown.verify.retry);
    assert.ok(!/nothing was imported/i.test(r.text), "an unconfirmed COMMIT is never reported as nothing imported");
    assert.deepEqual(r.body.summary, { requested: 3, imported: 1, alreadyImported: 0, refused: 0, unknown: 1, notAttempted: 1 });
  });
  // Following the steps: this one was not imported; the third was never tried.
  assert.equal((await api(`/teams/${team.teamId}/approvals/${approvalId}`, { cookie: team.coach.cookie })).status, 404);
  assert.deepEqual([await candidateStatus(asked[1]), await candidateStatus(asked[2])], ["pending", "pending"]);
  assert.equal(await eventsOf(team.teamId), 1);

  await withSwitchOn(async () => {
    const again = await batch(team, asked);
    assert.deepEqual(outcomes(again), [[asked[0], "already_imported", "already_imported"], [asked[1], "imported", null], [asked[2], "imported", null]]);
    assert.equal(again.body.results[0].approvalId, (await approvalsOf(asked[0]))[0].id);
  });
  for (const id of asked) assert.equal((await approvalsOf(id)).length, 1);
  assert.equal(await eventsOf(team.teamId), 3);
});

test("batch: retried after a partial success whose last COMMIT did go through - already_imported for what is in, the rest imported, never a duplicate", async () => {
  const team = await setupTeam();
  await checkNow(team, [8401, 8402, 8403].map((sessionId, i) => cleanBundle({ sessionId, hour: 8 + i * 2, ids: [101] })));
  const ids = await candidateIds(team);
  const asked = [ids["8401"], ids["8402"], ids["8403"]];
  await withSwitchOn(async () => {
    let commits = 0;
    service.setApprovalCommitForTests(async (client) => {
      commits += 1;
      await client.query("commit");
      if (commits === 2) throw new Error("Connection terminated unexpectedly");
    });
    // The check after the lost answer cannot reach the database either.
    service.setUncertainCommitCheckForTests({ fault: () => { throw new Error("database unreachable"); }, timeoutMs: 2_000 });
    const r = await batch(team, asked);
    assert.deepEqual(outcomes(r).map(([, o]) => o), ["imported", "import_outcome_unknown", "not_attempted"]);
    service.setApprovalCommitForTests(null);
    service.setUncertainCommitCheckForTests({});

    const again = await batch(team, asked);
    assert.equal(again.status, 200);
    assert.deepEqual(outcomes(again), [[asked[0], "already_imported", "already_imported"], [asked[1], "already_imported", "already_imported"], [asked[2], "imported", null]]);
    assert.equal(again.body.results[1].approvalId, r.body.results[1].approvalId, "the unknown one was in: the same approval");
    assert.deepEqual(again.body.summary, { requested: 3, imported: 1, alreadyImported: 2, refused: 0, unknown: 0, notAttempted: 0 });
  });
  for (const id of asked) assert.equal((await approvalsOf(id)).length, 1);
  assert.equal(await eventsOf(team.teamId), 3);
});

test("batch: a batch and a single approval of the same candidate at the same time give exactly one approval; two batches at the same time too", async () => {
  const team = await setupTeam();
  await checkNow(team, [8501, 8502, 8503].map((sessionId, i) => cleanBundle({ sessionId, hour: 8 + i * 2, ids: [101] })));
  const ids = await candidateIds(team);
  const detail = (await api(`/teams/${team.teamId}/candidates/${ids["8501"]}`, { cookie: team.coach.cookie })).body.candidate;
  await withSwitchOn(async () => {
    // The batch stops inside the first approval's transaction, holding the
    // candidate; the single approval is sent and must wait for that lock.
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
    const inBatch = batch(team, [ids["8501"]]);
    await Promise.race([inside, inBatch.then((r) => { throw new Error(`the batch ended before its import ran: ${r.status} ${r.text}`); })]);
    const single = api(`/teams/${team.teamId}/candidates/${ids["8501"]}/approve`, { method: "POST", cookie: team.padmin.cookie, body: { previewHash: detail.previewHash } });
    let waited = false;
    let results;
    try {
      for (let i = 0; i < 200 && !waited; i += 1) {
        waited = (await admin.query(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%gpexe_import_candidates%for update%'`,
        )).rows[0].n > 0;
        if (!waited) await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      release();
      results = await Promise.all([inBatch, single]);
    }
    assert.ok(waited, "the single approval waited for the batch's candidate lock");
    assert.deepEqual(outcomes(results[0]), [[ids["8501"], "imported", null]]);
    assert.deepEqual([results[1].status, results[1].body.error], [409, "already_imported"]);
    assert.equal(calls, 1, "the single approval never ran the import");
    service.setApprovalObserver(null);

    // Two batches over the same two candidates, at once: the first stops
    // inside its first approval; the second must wait for that candidate.
    const pair = [ids["8502"], ids["8503"]];
    const hashes = await listedHashes(team);
    let release2;
    let entered2;
    const gate2 = new Promise((resolve) => { release2 = resolve; });
    const inside2 = new Promise((resolve) => { entered2 = resolve; });
    let imports = 0;
    service.setApprovalObserver(async () => {
      imports += 1;
      if (imports === 1) {
        entered2();
        await gate2;
      }
    });
    const b1Promise = batch(team, pair, team.padmin.cookie, hashes);
    await Promise.race([inside2, b1Promise.then((r) => { throw new Error(`the first batch ended before its import ran: ${r.status} ${r.text}`); })]);
    const b2Promise = batch(team, pair, team.padmin.cookie, hashes);
    let waited2 = false;
    let b1;
    let b2;
    try {
      for (let i = 0; i < 200 && !waited2; i += 1) {
        waited2 = (await admin.query(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%gpexe_import_candidates%for update%'`,
        )).rows[0].n > 0;
        if (!waited2) await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      release2();
      [b1, b2] = await Promise.all([b1Promise, b2Promise]);
    }
    assert.ok(waited2, "the second batch waited for the first one's candidate lock");
    assert.equal(outcomes(b2)[0][1], "already_imported", "the waiting batch found it imported under the lock");
    for (const [i, id] of pair.entries()) {
      const both = [b1.body.results[i], b2.body.results[i]].map((x) => x.outcome).sort();
      assert.deepEqual(both, ["already_imported", "imported"], `${id}: imported once, the other batch saw it imported`);
    }
    assert.equal(imports, 2, "one import per candidate");
  });
  for (const id of Object.values(ids)) assert.equal((await approvalsOf(id)).length, 1);
  assert.equal(await eventsOf(team.teamId), 3);
});

test("batch: another team's candidate is never imported and never revealed - the same 404 as a missing one, with nothing attempted", async () => {
  const team = await setupTeam();
  const other = await setupTeam();
  await checkNow(team, [cleanBundle({ sessionId: 8601, ids: [101] })]);
  await checkNow(other, [cleanBundle({ sessionId: 8602, ids: [101] })]);
  const own = (await candidateIds(team))["8601"];
  const foreign = (await candidateIds(other))["8602"];
  const before = await allRowCounts();
  await withSwitchOn(async () => {
    let ran = false;
    service.setApprovalObserver(() => { ran = true; });
    const missing = await batch(team, [own, "00000000-0000-4000-8000-000000000000"]);
    const mixed = await batch(team, [own, foreign]);
    const through = await batch(other, [own], other.padmin.cookie);
    for (const r of [missing, mixed, through]) assert.deepEqual([r.status, r.body], [404, { error: "notFound" }]);
    assert.equal(mixed.text, missing.text, "a foreign candidate looks exactly like a missing one");
    assert.equal(ran, false);
  });
  assert.deepEqual(await allRowCounts(), before);
});

test("batch: only a platform admin or a coach with an active grant; the team's coach without one gets 403, another team's coach 404, no login 401 - nothing attempted", async () => {
  const team = await setupTeam();
  const other = await setupTeam();
  await checkNow(team, [cleanBundle({ sessionId: 8701, ids: [101] })]);
  const id = (await candidateIds(team))["8701"];
  const before = await allRowCounts();
  await withSwitchOn(async () => {
    const r1 = await batch(team, [id], team.coach.cookie);
    assert.deepEqual([r1.status, r1.body.error], [403, "not_an_approver"]);
    assert.deepEqual([(await batch(team, [id], other.coach.cookie)).status, (await batch(team, [id], other.coach.cookie)).body], [404, { error: "notFound" }]);
    assert.equal((await api(`/teams/${team.teamId}/imports`, { method: "POST", body: { candidateIds: [id] } })).status, 401);
    assert.deepEqual(await allRowCounts(), before);

    const grant = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: team.coach.id, reason: "approves GPEXE imports" } });
    assert.equal(grant.status, 201);
    const ok = await batch(team, [id], team.coach.cookie);
    assert.deepEqual(outcomes(ok), [[id, "imported", null]]);
    const [approval] = await approvalsOf(id);
    assert.deepEqual([approval.approved_by_user_id, approval.approval_basis, approval.approver_grant_id], [team.coach.id, "team_grant", grant.body.grant.id]);
  });
});

test("batch: a malformed, empty, duplicate, over-limit or wrongly typed candidateIds, acceptChanges or an unknown field is a stable 400, and nothing is written", async () => {
  const team = await setupTeam();
  await checkNow(team, [cleanBundle({ sessionId: 8801, ids: [101] })]);
  const id = (await candidateIds(team))["8801"];
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const before = await allRowCounts();
  await withSwitchOn(async () => {
    let ran = false;
    service.setApprovalObserver(() => { ran = true; });
    const hash = (await listedHashes(team))[id];
    const good = (extra) => ({ candidateIds: [id], previewHashes: { [id]: hash }, ...extra });
    const cases = [
      [{}, "candidate_ids_required"],
      [{ candidateIds: [] }, "candidate_ids_required"],
      [{ candidateIds: id }, "candidate_ids_required"],
      [{ candidateIds: null }, "candidate_ids_required"],
      [{ candidateIds: [id, id] }, "duplicate_candidate_id"],
      [{ candidateIds: [id, id.toUpperCase()] }, "duplicate_candidate_id"],
      [{ candidateIds: [id, "nope"] }, "invalid_candidate_id"],
      [{ candidateIds: [id, 42] }, "invalid_candidate_id"],
      [{ candidateIds: [id, null] }, "invalid_candidate_id"],
      [{ candidateIds: Array.from({ length: service.BATCH_APPROVE_MAX + 1 }, (_, i) => uuid(i + 1)) }, "too_many_candidates"],
      [good({ acceptChanges: true }), "accept_changes_not_allowed"],
      [good({ acceptChanges: false }), "accept_changes_not_allowed"],
      [good({ previewHash: hash }), "unknown_field"],
      [[id], "invalid_body"],
      [{ candidateIds: [id] }, "preview_hashes_required"],
      [good({ previewHashes: [hash] }), "preview_hashes_required"],
      [good({ previewHashes: {} }), "preview_hashes_mismatch"],
      [good({ previewHashes: { [id]: hash, [uuid(7)]: hash } }), "preview_hashes_mismatch"],
      [good({ previewHashes: { [uuid(7)]: hash } }), "preview_hashes_mismatch"],
      [good({ previewHashes: { [id]: hash, [id.toUpperCase()]: hash } }), "preview_hashes_mismatch"],
      [good({ previewHashes: { [id]: "not a hash" } }), "invalid_preview_hash"],
      [good({ previewHashes: { [id]: 42 } }), "invalid_preview_hash"],
    ];
    for (const [body, code] of cases) {
      const r = await api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: team.padmin.cookie, body });
      assert.deepEqual([r.status, r.body.error], [400, code], JSON.stringify(body).slice(0, 80));
      if (code === "invalid_body") assert.match(r.body.message, /previewHashes/, "the message names the whole body");
    }
    assert.equal(service.BATCH_APPROVE_MAX, 10);
    assert.equal(ran, false);
    assert.deepEqual(await allRowCounts(), before, "nothing written by any refused body");
    assert.equal(await candidateStatus(id), "pending");
    // The same id in another letter case is the same candidate.
    const upper = await api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [id.toUpperCase()], previewHashes: { [id]: hash } } });
    assert.equal(upper.status, 200, upper.text);
    assert.deepEqual(outcomes(upper), [[id, "imported", null]]);
  });
});

test("batch: an unexpected database error is a stable code without the database's text - on a candidate it stops the batch (rest not_attempted), before the first one it is a 500 with nothing attempted", async () => {
  const team = await setupTeam();
  await checkNow(team, [8901, 8902, 8903].map((sessionId, i) => cleanBundle({ sessionId, hour: 8 + i * 2, ids: [101] })));
  const ids = await candidateIds(team);
  const asked = [ids["8901"], ids["8902"], ids["8903"]];
  const SECRET = 'relation "internal_secret_table" does not exist';
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await withSwitchOn(async () => {
      let calls = 0;
      service.setApprovalObserver(() => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error(SECRET), { code: "42P01" });
      });
      const r = await batch(team, asked);
      assert.equal(r.status, 200);
      assert.deepEqual(outcomes(r), [[asked[0], "imported", null], [asked[1], "refused", "internal_error"], [asked[2], "not_attempted", null]]);
      assert.ok(!r.text.includes("internal_secret_table"), "the database's text never reaches the client");
      assert.equal(await candidateStatus(asked[1]), "pending", "rolled back");
      assert.equal(await candidateStatus(asked[2]), "pending");
      service.setApprovalObserver(null);

      // Before the first candidate: the approver check fails.
      const original = appPool.query.bind(appPool);
      appPool.query = (text, ...rest) => {
        if (typeof text === "string" && text.includes("gpexe_import_approvers a")) return Promise.reject(Object.assign(new Error(SECRET), { code: "42P01" }));
        return original(text, ...rest);
      };
      try {
        const start = await batch(team, [asked[2]]);
        assert.deepEqual([start.status, start.body.error], [500, "internal_error"]);
        assert.ok(!start.text.includes("internal_secret_table"));
      } finally {
        appPool.query = original;
      }
      assert.equal(await candidateStatus(asked[2]), "pending");
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((e) => e.includes("internal_secret_table")), "the text is logged on the server");
  assert.equal(await eventsOf(team.teamId), 1);
});

test("batch: with the import switch off the answer is the single approval's 409 import_switch_off, and nothing is written", async () => {
  const team = await setupTeam();
  await checkNow(team, [cleanBundle({ sessionId: 9001, ids: [101] })]);
  const id = (await candidateIds(team))["9001"];
  const before = await allRowCounts();
  const r = await batch(team, [id]);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "import_switch_off");
  assert.match(r.body.message, /no result or activity can be written/);
  assert.deepEqual(await allRowCounts(), before);
});

test("batch: approving makes no GPEXE call, whatever the number of candidates - it imports the stored snapshots", async () => {
  const team = await setupTeam();
  const bundles = [9101, 9102, 9103, 9104].map((sessionId, i) => cleanBundle({ sessionId, hour: 7 + i * 2, ids: [101] }));
  await checkNow(team, bundles);
  const ids = Object.values(await candidateIds(team));
  let clients = 0;
  service.setGpexeClientFactory(() => {
    clients += 1;
    throw new Error("GPEXE must not be called while approving");
  });
  try {
    await withSwitchOn(async () => {
      const r = await batch(team, ids);
      assert.deepEqual(r.body.summary, { requested: 4, imported: 4, alreadyImported: 0, refused: 0, unknown: 0, notAttempted: 0 });
    });
  } finally {
    service.setGpexeClientFactory(null);
  }
  assert.equal(clients, 0);
});

test("batch: a preview recomputed after the coach read the list (a link changed, then a check) is not imported - preview_changed, until the new list is sent", async () => {
  const team = await setupTeam();
  await checkNow(team, [cleanBundle({ sessionId: 9201, ids: [101] })]);
  const id = (await candidateIds(team))["9201"];
  const seen = await listedHashes(team);
  assert.match(seen[id], /^[0-9a-f]{64}$/, "the list carries the preview hash");

  // Another coach links GPEXE 101 to another athlete and finds the sessions
  // again: the same candidate's preview is rewritten, still clean Ready.
  const link101 = (await api(`/teams/${team.teamId}/athlete-links`, { cookie: team.coach.cookie })).body.links.find((l) => l.gpexeAthleteId === "101");
  assert.equal((await api(`/teams/${team.teamId}/athlete-links/${link101.id}/unlink`, { method: "POST", cookie: team.coach.cookie })).status, 200);
  assert.equal((await api(`/teams/${team.teamId}/athlete-links`, { method: "POST", cookie: team.coach.cookie, body: { gpexeAthleteId: "101", athleteId: team.athleteIds[3] } })).status, 201);
  await checkNow(team, [cleanBundle({ sessionId: 9201, ids: [101] })]);
  const now = await listedHashes(team);
  assert.equal((await candidateIds(team))["9201"], id, "the same candidate");
  assert.notEqual(now[id], seen[id], "its preview was rewritten");

  await withSwitchOn(async () => {
    let ran = false;
    service.setApprovalObserver(() => { ran = true; });
    const stale = await batch(team, [id], team.padmin.cookie, seen);
    assert.deepEqual(outcomes(stale), [[id, "refused", "preview_changed"]]);
    assert.deepEqual(stale.body.results[0].reviewAgain, { candidateId: id, href: `/api/training-load/gpexe/teams/${team.teamId}/candidates/${id}` });
    assert.equal(ran, false, "refused before the import ran");
    assert.equal((await approvalsOf(id)).length, 0);
    service.setApprovalObserver(null);

    const fresh = await batch(team, [id], team.padmin.cookie, now);
    assert.deepEqual(outcomes(fresh), [[id, "imported", null]]);
    assert.equal((await approvalsOf(id))[0].preview_hash, now[id]);
  });
});

test("batch: a COMMIT whose answer was lost but which is found afterwards counts as imported (verified), and the batch goes on", async () => {
  const team = await setupTeam();
  await checkNow(team, [9301, 9302].map((sessionId, i) => cleanBundle({ sessionId, hour: 8 + i * 2, ids: [101] })));
  const ids = await candidateIds(team);
  const asked = [ids["9301"], ids["9302"]];
  await withSwitchOn(async () => {
    let commits = 0;
    service.setApprovalCommitForTests(async (client) => {
      commits += 1;
      await client.query("commit");
      if (commits === 1) throw new Error("Connection terminated unexpectedly");
    });
    const r = await batch(team, asked);
    assert.deepEqual(outcomes(r), [[asked[0], "imported", null], [asked[1], "imported", null]]);
    assert.equal(r.body.results[0].commitConfirmation, "verified_after_commit_error");
    assert.equal(r.body.results[0].approvalId, (await approvalsOf(asked[0]))[0].id);
    assert.equal(r.body.results[1].commitConfirmation, "confirmed");
    assert.deepEqual(r.body.summary, { requested: 2, imported: 2, alreadyImported: 0, refused: 0, unknown: 0, notAttempted: 0 });
  });
  assert.equal(await eventsOf(team.teamId), 2);
});

test("batch: a right lost or the switch turned off in the middle stops the batch - that candidate refused with the code, the rest not_attempted", async () => {
  const team = await setupTeam();
  await checkNow(team, [9401, 9402, 9403, 9404, 9405, 9406].map((sessionId, i) => cleanBundle({ sessionId, hour: 6 + i * 2, ids: [101] })));
  const ids = await candidateIds(team);
  const grant = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: team.coach.id, reason: "approves GPEXE imports" } });
  assert.equal(grant.status, 201);

  await withSwitchOn(async () => {
    // The coach's right is revoked right after the first import committed.
    let commits = 0;
    service.setApprovalCommitForTests(async (client) => {
      await client.query("commit");
      commits += 1;
      if (commits === 1) {
        const revoked = await api(`/teams/${team.teamId}/approvers/${grant.body.grant.id}/revoke`, { method: "POST", cookie: team.padmin.cookie, body: { reason: "test" } });
        assert.equal(revoked.status, 200, revoked.text);
      }
    });
    const lost = [ids["9401"], ids["9402"], ids["9403"]];
    const r1 = await batch(team, lost, team.coach.cookie);
    assert.deepEqual(outcomes(r1), [[lost[0], "imported", null], [lost[1], "refused", "not_an_approver"], [lost[2], "not_attempted", null]]);

    // The switch is turned off right after the first import committed.
    commits = 0;
    service.setApprovalCommitForTests(async (client) => {
      await client.query("commit");
      commits += 1;
      if (commits === 1) delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
    });
    const off = [ids["9404"], ids["9405"], ids["9406"]];
    const r2 = await batch(team, off);
    assert.deepEqual(outcomes(r2), [[off[0], "imported", null], [off[1], "refused", "import_switch_off"], [off[2], "not_attempted", null]]);
  });
  for (const id of [ids["9402"], ids["9403"], ids["9405"], ids["9406"]]) {
    assert.equal(await candidateStatus(id), "pending");
    assert.equal((await approvalsOf(id)).length, 0);
  }
  assert.equal(await eventsOf(team.teamId), 2);
});

test("batch: a stale hash whose recomputed preview now has a reason is preview_changed (review again), not a reason from a preview nobody saw", async () => {
  const team = await setupTeam();
  await checkNow(team, [cleanBundle({ sessionId: 9501, ids: [101, 102] })]);
  const id = (await candidateIds(team))["9501"];
  const seen = await listedHashes(team);
  // 102 is unlinked and the sessions are found again: the same candidate's
  // preview is rewritten, now with athletes_not_linked.
  const link102 = (await api(`/teams/${team.teamId}/athlete-links`, { cookie: team.coach.cookie })).body.links.find((l) => l.gpexeAthleteId === "102");
  assert.equal((await api(`/teams/${team.teamId}/athlete-links/${link102.id}/unlink`, { method: "POST", cookie: team.coach.cookie })).status, 200);
  await checkNow(team, [cleanBundle({ sessionId: 9501, ids: [101, 102] })]);
  assert.equal((await candidateIds(team))["9501"], id, "the same candidate");
  await withSwitchOn(async () => {
    const r = await batch(team, [id], team.padmin.cookie, seen);
    assert.deepEqual(outcomes(r), [[id, "refused", "preview_changed"]]);
    assert.ok(!("reasons" in r.body.results[0]), "no reason from the unseen preview");
    assert.equal((await approvalsOf(id)).length, 0);
  });
});
