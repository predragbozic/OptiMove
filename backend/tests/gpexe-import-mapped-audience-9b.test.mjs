// Phase 9, 9-B (contract J17 section 6 / 6.1 and 8.2): who reads what of a
// GPEXE import candidate. One audience level per request (platform,
// club_admin, other), computed by the route from its own access snapshot and
// applied on six surfaces: the list, the detail, the approval's refusals, the
// batch results, the candidate embedded in a successful approval's answer and
// the check answer (which carries no candidate). The owner's coordinator
// decision of 2026-11-02: the neutral blockedCode is data_setup_incomplete for
// every viewer; the platform admin reads all eight precise codes through
// blockedSourceCode and preview.blocked; the club's admin (in the club's
// workspace only, D8) the precise codes with mapping_not_usable in place of the
// three source-instance codes; everyone else data_setup_incomplete and the
// coach sentence. Also D10 (a blocked candidate's preview hash for the
// platform admin only), D29 (a kept athlete whose every mapped value was left
// out), C110 (the Left-out reason code for the two administrators only) and R17
// (a club variable's name only where C99 admits the viewer).
//
// Through the real server on a disposable database; GPEXE is the fake server3
// source of support/gpexe-fake-source.mjs (or, for the one legacy-path case, a
// fake legacy client); the import switch is turned on inside this process only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { asSourceTeam, bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding, ensureMappedSystem } from "./support/mapped-world.mjs";
import { BLOCK_MESSAGES } from "../src/gpexeImportPreview.js";
import {
  BLOCKING_CODES, CLUB_VARIABLE_LABEL, COACH_SENTENCE, PLATFORM_ONLY_CODES, STABLE_CODE,
  normalizeImportAudience, projectBlockedCodes, projectPreview,
} from "../src/gpexeImportAudience.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const D1 = "2026-09-14";
const ZERO_HASH = "0".repeat(64);
const LEFT_OUT_RANGE = "Outside the variable's limits.";
const ADMIN_VALUE_FIELDS = ["activationId", "mappingVersionId", "sourceParameterFingerprint"];
const ALL_CODES = [...BLOCKING_CODES];
const INSTANCE_CODES = [...PLATFORM_ONLY_CODES];
// The five viewers and the level each reads at (J17 section 6.1).
const LEVEL = Object.freeze({ coach: "other", granted: "other", dual: "other", cadmin: "club_admin", padmin: "platform" });
const APPROVERS = new Set(["granted", "padmin"]);
const LEGACY_TRAP = () => { throw new Error("TRAP: the legacy client factory was called for a bound team"); };

let db;
let admin;
let server;
let apiBase;
let service;
let connections;
let resolver;
let access;
let createSession;
let appPool;
let src;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "audience" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  process.env.SOURCE_CREDENTIAL_KEYS = (await import("../src/sourceCredentialCrypto.js")).generateKeyEntry(1);
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
  connections = await import("../src/sourceConnectionService.js");
  resolver = await import("../src/sourceImportCredentialResolver.js");
  access = await import("../src/gpexeImportAccess.js");
  src = createFakeSource();
  connections.setSourceFetchForTests(src.fetchImpl);
  resolver.setImportSourceFetchForTests(src.fetchImpl);
  service.setGpexeClientFactory(LEGACY_TRAP);
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  service?.setGpexeClientFactory(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
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

// ---------------------------------------------------------------------------
// HTTP, users and viewers
// ---------------------------------------------------------------------------
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeUser(label) {
  return (await admin.query(
    `insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`,
    [`${label.replace(/\s+/g, "-")}-${crypto.randomBytes(4).toString("hex")}@test.local`, label],
  )).rows[0].id;
}

async function setWorkspace(userId, type, scopeId) {
  await admin.query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [userId, type, scopeId],
  );
}

const sessionOf = async (id) => ({ id: String(id), cookie: `optimove_session=${await createSession(id)}` });

async function coachOf(teamId, label = "coach") {
  const id = await makeUser(label);
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return sessionOf(id);
}

async function platformAdmin() {
  const id = await makeUser("platform admin");
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return sessionOf(id);
}

async function clubAdminOf(clubId) {
  const id = await makeUser("club admin");
  await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await setWorkspace(id, "club", clubId);
  return sessionOf(id);
}

// The club's admin who also coaches the team, acting in the team workspace
// (D8: there the level is other).
async function dualOf(team) {
  const id = await makeUser("club admin and coach");
  await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, team.clubId]);
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, team.teamId]);
  await setWorkspace(id, "team", team.teamId);
  return sessionOf(id);
}

// Every team its own GPEXE team id (gpexe_team_settings is unique on it).
let nextSourceTeamId = 6100;
async function setupTeam({ bind = true, activate = true } = {}) {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A101", "B102"] });
  const [a101, a102] = org.athleteIds;
  const padmin = await platformAdmin();
  const coach = await coachOf(org.teamId);
  const sourceTeamId = String(nextSourceTeamId++);
  const settings = await api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: sourceTeamId } });
  assert.equal(settings.status, 200, settings.text);
  let bindingId = null;
  await enableTeamImportSwitch(admin, org.teamId);
  if (bind) {
    src.show(sourceTeamId);
    ({ bindingId } = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId }));
    if (activate) await activateBinding(admin, bindingId);
  }
  for (const [gpexeAthleteId, athleteId] of [["101", a101], ["102", a102]]) {
    const linked = await api(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId, athleteId } });
    assert.equal(linked.status, 201, linked.text);
  }
  return { ...org, a101, a102, padmin, coach, sourceTeamId, bindingId };
}

async function viewersOf(team) {
  const granted = await coachOf(team.teamId, "granted coach");
  const grant = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: granted.id, reason: "9-B audience test grant." } });
  assert.equal(grant.status, 201, grant.text);
  return { coach: team.coach, granted, cadmin: await clubAdminOf(team.clubId), dual: await dualOf(team), padmin: team.padmin };
}

// ---------------------------------------------------------------------------
// Sessions, checks and candidates
// ---------------------------------------------------------------------------
// A session of athletes 101 and 102 (both linked), its own track ids, both
// drills' details (v33: the drill-parameter effect is confirmed). maxV: a
// max_v (m/s) per GPEXE athlete id for every row of that athlete.
function sessionBundle({ sessionId, hour = 8, maxV = {}, powerBounds, burstUnit }) {
  const athletes = standardAthletes().filter((a) => a.id === 101 || a.id === 102).map((a, i) => {
    const copy = structuredClone(a);
    copy.tracks = [sessionId * 10 + i];
    for (const part of copy.parts) {
      delete part.track;
      if (maxV[a.id] !== undefined) part.maxV = maxV[a.id];
    }
    return copy;
  });
  const bundle = makeBundle({
    sessionId, start: `2026-09-14T${String(hour).padStart(2, "0")}:08:12`, athletes, detailsDrills: [0, 1],
    ...(powerBounds ? { powerBounds } : {}),
  });
  if (burstUnit) for (const player of Object.values(bundle.details.full.players)) player.tot_burst_events.unit = burstUnit;
  return bundle;
}

function legacyClient(bundles) {
  return {
    async listTeamSessions() { return bundles.map((b) => ({ id: String(b.teamSession.id) })); },
    async fetchSessionBundle({ sessionId }) { return structuredClone(bundles.find((b) => String(b.teamSession.id) === String(sessionId))); },
  };
}

// One check of D1 as the coach, until it succeeded; returns its id. A bound
// team reads through the fake server3 source; a never-bound team through the
// fake legacy client (the trap is put back afterwards).
async function checkNow(team, bundles) {
  if (team.bindingId) src.serve(team.sourceTeamId, bundles);
  else service.setGpexeClientFactory(() => legacyClient(bundles.map((b) => asSourceTeam(b, team.sourceTeamId))));
  try {
    const started = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body: { from: D1, to: D1 } });
    assert.equal(started.status, 202, started.text);
    const checkId = started.body.check.id;
    for (let i = 0; i < 600; i += 1) {
      const r = await api(`/teams/${team.teamId}/checks/${checkId}`, { cookie: team.padmin.cookie });
      if (r.body.check?.status !== "running") {
        assert.equal(r.body.check.status, "succeeded", JSON.stringify(r.body.check));
        return checkId;
      }
      await sleep(50);
    }
    throw new Error("check did not finish");
  } finally {
    if (!team.bindingId) service.setGpexeClientFactory(LEGACY_TRAP);
  }
}

async function onlyCandidate(team) {
  const rows = (await admin.query(
    `select id, status, preview, preview_hash from training_load.gpexe_import_candidates where owner_team_id = $1 and status <> 'superseded'`,
    [team.teamId],
  )).rows;
  assert.equal(rows.length, 1, "one current candidate");
  return rows[0];
}

// Plant one blocking code on a candidate (the v22 guard lets a pending or
// blocked row's status and preview change; the preview hash is kept).
async function plant(candidateId, code) {
  const { preview } = (await admin.query(`select preview from training_load.gpexe_import_candidates where id = $1`, [candidateId])).rows[0];
  const planted = { ...preview, status: "blocked", blocked: { code, message: BLOCK_MESSAGES[code] } };
  await admin.query(`update training_load.gpexe_import_candidates set status = 'blocked', preview = $2::jsonb where id = $1`, [candidateId, JSON.stringify(planted)]);
}

async function eventsOf(teamId) {
  return (await admin.query(`select count(*)::int as n from training_load.metric_events where owner_team_id = $1`, [teamId])).rows[0].n;
}

async function approvalsOf(candidateId) {
  return (await admin.query(`select * from training_load.gpexe_import_approvals where candidate_id = $1`, [candidateId])).rows;
}

async function withSwitchOn(fn) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await fn();
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
}

// The three read surfaces of one viewer: the list (with this candidate's
// summary), the detail and, when given, the check answer.
async function reads(team, viewer, candidateId, checkId = null) {
  const list = await api(`/teams/${team.teamId}/candidates`, { cookie: viewer.cookie });
  const detail = await api(`/teams/${team.teamId}/candidates/${candidateId}`, { cookie: viewer.cookie });
  const check = checkId ? await api(`/teams/${team.teamId}/checks/${checkId}`, { cookie: viewer.cookie }) : null;
  assert.equal(list.status, 200, list.text);
  assert.equal(detail.status, 200, detail.text);
  if (check) assert.equal(check.status, 200, check.text);
  return { list, detail, check, summary: list.body.candidates.find((c) => c.id === candidateId), candidate: detail.body.candidate };
}

// What a level reads of one planted code.
function expectedFor(level, code) {
  if (level === "platform") return { source: code, blocked: { code, message: BLOCK_MESSAGES[code] } };
  if (level === "club_admin") {
    const shown = PLATFORM_ONLY_CODES.has(code) ? "mapping_not_usable" : code;
    return { source: shown, blocked: { code: shown, message: BLOCK_MESSAGES[shown] } };
  }
  return { source: STABLE_CODE, blocked: { code: STABLE_CODE, message: COACH_SENTENCE } };
}

function bannedFor(level) {
  if (level === "other") return ALL_CODES;
  if (level === "club_admin") return INSTANCE_CODES;
  return [];
}

// A whole-body scan: no code a level may not read, and no sentence of it.
function assertNoLeak(level, text, where) {
  for (const code of bannedFor(level)) {
    assert.ok(!text.includes(code), `${where}: the answer names ${code}`);
    assert.ok(!text.includes(BLOCK_MESSAGES[code]), `${where}: the answer carries the sentence of ${code}`);
  }
}

const athleteOf = (preview, gpexeAthleteId) => preview.athletes.find((a) => a.gpexeAthleteId === gpexeAthleteId);

// ---------------------------------------------------------------------------
test("1. the matrix: for each of the eight blocking codes, every viewer reads exactly its level on every surface - the platform admin the precise code and sentence and the stored hash; the club's admin the precise code, with mapping_not_usable for the three instance codes; everyone else data_setup_incomplete and the coach sentence, no hash, and no code or sentence anywhere; the approval and the batch name no code; a missing or unknown level reads as other", async () => {
  // The closed set: the eight codes are exactly the codes with a sentence.
  assert.equal(ALL_CODES.length, 8);
  assert.deepEqual(Object.keys(BLOCK_MESSAGES).sort(), [...ALL_CODES].sort());
  assert.deepEqual(INSTANCE_CODES.sort(), ["session_imported_under_another_instance", "source_instance_changed", "source_instance_held"]);
  // Unit level: a missing or unknown level is other.
  const synthetic = {
    version: 3, status: "blocked", blocked: { code: "source_instance_held", message: BLOCK_MESSAGES.source_instance_held },
    athletes: [], changesToImported: [], unmappedSourceFields: 0, unactivatedSourceMetrics: ["a source field"],
  };
  assert.equal(normalizeImportAudience(undefined), "other");
  assert.equal(normalizeImportAudience("x"), "other");
  assert.deepEqual(projectPreview(synthetic, undefined), projectPreview(synthetic, "other"));
  assert.deepEqual(projectPreview(synthetic, "x").blocked, { code: STABLE_CODE, message: COACH_SENTENCE });
  assert.ok(!("unactivatedSourceMetrics" in projectPreview(synthetic, undefined)));
  const summary = { blockedCode: STABLE_CODE, blockedSourceCode: "source_instance_held" };
  assert.equal(projectBlockedCodes(summary, "x").blockedSourceCode, STABLE_CODE);
  assert.equal(projectBlockedCodes(summary, undefined).blockedSourceCode, STABLE_CODE);
  assert.equal(projectBlockedCodes(summary, "club_admin").blockedSourceCode, "mapping_not_usable");
  assert.equal(projectBlockedCodes(summary, "platform").blockedSourceCode, "source_instance_held");

  const team = await setupTeam();
  const viewers = await viewersOf(team);
  const checkId = await checkNow(team, [sessionBundle({ sessionId: 9101 })]);
  const cand = await onlyCandidate(team);
  assert.equal(cand.status, "pending", "a real check gave a pending candidate");
  assert.equal(cand.preview.status, "ready");

  for (const code of ALL_CODES) {
    await plant(cand.id, code);
    for (const [name, viewer] of Object.entries(viewers)) {
      const level = LEVEL[name];
      const want = expectedFor(level, code);
      const where = `${code} as ${name}`;
      const { list, detail, check, summary: s, candidate: c } = await reads(team, viewer, cand.id, checkId);
      // (1) the list.
      assert.equal(s.status, "blocked", where);
      assert.equal(s.previewStatus, "blocked", where);
      assert.equal(s.blockedCode, STABLE_CODE, `${where}: the neutral code is the same for everyone`);
      assert.equal(s.blockedSourceCode, want.source, `${where}: list blockedSourceCode`);
      assert.equal(s.previewHash, level === "platform" ? cand.preview_hash : null, `${where}: D10 on the list`);
      assert.ok(s.approvalBlockers.includes("blocked"), where);
      assertNoLeak(level, list.text, `${where} (list)`);
      // (2) the detail.
      assert.equal(c.blockedCode, STABLE_CODE, where);
      assert.equal(c.blockedSourceCode, want.source, `${where}: detail blockedSourceCode`);
      assert.deepEqual(c.preview.blocked, want.blocked, `${where}: preview.blocked`);
      assert.equal(c.previewHash, level === "platform" ? cand.preview_hash : null, `${where}: D10 on the detail`);
      assertNoLeak(level, detail.text, `${where} (detail)`);
      // (6) the check answer carries no candidate: nothing for anyone.
      assertNoLeak("other", check.text, `${where} (check)`);

      await withSwitchOn(async () => {
        const hash = s.previewHash ?? ZERO_HASH;
        // (3) the approval: 403 before anything without the right; with it, 409 blocked naming no code.
        const ap = await api(`/teams/${team.teamId}/candidates/${cand.id}/approve`, { method: "POST", cookie: viewer.cookie, body: { previewHash: hash } });
        if (APPROVERS.has(name)) {
          assert.equal(ap.status, 409, `${where}: ${ap.text}`);
          assert.equal(ap.body.error, "blocked", where);
        } else {
          assert.equal(ap.status, 403, `${where}: ${ap.text}`);
          assert.equal(ap.body.error, "not_an_approver", where);
        }
        assertNoLeak("other", ap.text, `${where} (approve)`);
        // (4) the batch: refused blocked with the neutral code, or 403.
        const bt = await api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: viewer.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: hash } } });
        if (APPROVERS.has(name)) {
          assert.equal(bt.status, 200, `${where}: ${bt.text}`);
          assert.deepEqual(bt.body.results, [{ candidateId: cand.id, outcome: "refused", code: "blocked", approvalId: null, blockedCode: STABLE_CODE }], where);
        } else {
          assert.equal(bt.status, 403, `${where}: ${bt.text}`);
          assert.equal(bt.body.error, "not_an_approver", where);
        }
        assertNoLeak("other", bt.text, `${where} (batch)`);
      });
    }
  }
  assert.equal((await approvalsOf(cand.id)).length, 0, "nothing was approved");
  assert.equal(await eventsOf(team.teamId), 0, "nothing was imported");
});

// ---------------------------------------------------------------------------
// 2. How each code really arises: the platform admin reads the precise code,
// the coach data_setup_incomplete; nothing is approvable.
async function assertBlockedAs(team, code, checkId) {
  const cand = await onlyCandidate(team);
  assert.equal(cand.status, "blocked", `${code}: stored blocked`);
  assert.equal(cand.preview.blocked?.code, code, `${code}: the stored preview names it`);
  const pa = await reads(team, team.padmin, cand.id, checkId);
  assert.equal(pa.summary.blockedCode, STABLE_CODE);
  assert.equal(pa.summary.blockedSourceCode, code);
  assert.equal(pa.summary.previewHash, cand.preview_hash);
  assert.ok(pa.summary.approvalBlockers.includes("blocked"));
  assert.deepEqual(pa.candidate.preview.blocked, { code, message: BLOCK_MESSAGES[code] });
  assertNoLeak("other", pa.check.text, `${code} (check, platform)`);
  const co = await reads(team, team.coach, cand.id, checkId);
  assert.equal(co.summary.blockedCode, STABLE_CODE);
  assert.equal(co.summary.blockedSourceCode, STABLE_CODE);
  assert.equal(co.summary.previewHash, null);
  assert.deepEqual(co.candidate.preview.blocked, { code: STABLE_CODE, message: COACH_SENTENCE });
  for (const [where, r] of [["list", co.list], ["detail", co.detail], ["check", co.check]]) assertNoLeak("other", r.text, `${code} (${where}, coach)`);
  await withSwitchOn(async () => {
    const ap = await api(`/teams/${team.teamId}/candidates/${cand.id}/approve`, { method: "POST", cookie: team.padmin.cookie, body: { previewHash: cand.preview_hash } });
    assert.equal(ap.status, 409, ap.text);
    assert.equal(ap.body.error, "blocked");
  });
  assert.equal((await approvalsOf(cand.id)).length, 0);
  assert.equal(await eventsOf(team.teamId), 0);
}

test("2a. no_mapped_values arises for a bound team with no activation", async () => {
  const team = await setupTeam({ activate: false });
  const checkId = await checkNow(team, [sessionBundle({ sessionId: 9201 })]);
  await assertBlockedAs(team, "no_mapped_values", checkId);
});

test("2b. mapping_not_usable arises for a never-bound team checked through the legacy path", async () => {
  const team = await setupTeam({ bind: false });
  const checkId = await checkNow(team, [sessionBundle({ sessionId: 9202 })]);
  assert.equal((await admin.query(`select source_path from training_load.gpexe_import_checks where id = $1`, [checkId])).rows[0].source_path, "legacy_env");
  await assertBlockedAs(team, "mapping_not_usable", checkId);
});

test("2c. source_threshold_contract_mismatch arises when the session's power zones are 22-55 instead of 25-60", async () => {
  const team = await setupTeam();
  const checkId = await checkNow(team, [sessionBundle({ sessionId: 9203, powerBounds: [[null, 20], [20, 22], [22, 55], [55, 75], [75, null]] })]);
  await assertBlockedAs(team, "source_threshold_contract_mismatch", checkId);
});

test("2d. source_shape_mismatch arises when the whole-session details give tot_burst_events with unit count", async () => {
  const team = await setupTeam();
  const checkId = await checkNow(team, [sessionBundle({ sessionId: 9204, burstUnit: "count" })]);
  await assertBlockedAs(team, "source_shape_mismatch", checkId);
});

test("2e. source_instance_held arises when another team already owns the active Metrics Core instance of this GPEXE team", async () => {
  const team = await setupTeam();
  const other = await createGpexePilotOrg(admin, { athleteNames: ["X"] });
  await admin.query(
    `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id, source_host_key, source_instance_key)
     values ('gpexe', 'team', $1, 'server3', $2)`,
    [other.teamId, team.sourceTeamId],
  );
  const checkId = await checkNow(team, [sessionBundle({ sessionId: 9205 })]);
  await assertBlockedAs(team, "source_instance_held", checkId);
});

test("2f. source_instance_changed arises when the team's own active instance names another GPEXE team", async () => {
  const team = await setupTeam();
  await admin.query(
    `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id, source_host_key, source_instance_key)
     values ('gpexe', 'team', $1, 'server3', '99999')`,
    [team.teamId],
  );
  const checkId = await checkNow(team, [sessionBundle({ sessionId: 9206 })]);
  await assertBlockedAs(team, "source_instance_changed", checkId);
});

// ---------------------------------------------------------------------------
test("3. D10: a candidate that is not blocked carries its preview hash for every viewer; the granted coach approves it with the list's hash, and the candidate embedded in that answer is read at the coach's level", async () => {
  const team = await setupTeam();
  const viewers = await viewersOf(team);
  await checkNow(team, [sessionBundle({ sessionId: 9301 })]);
  const cand = await onlyCandidate(team);
  assert.equal(cand.status, "pending");
  for (const [name, viewer] of Object.entries(viewers)) {
    const { summary: s, candidate: c } = await reads(team, viewer, cand.id);
    assert.equal(s.previewHash, cand.preview_hash, `${name}: the list's hash`);
    assert.equal(c.previewHash, cand.preview_hash, `${name}: the detail's hash`);
    assert.equal(s.blockedCode, null, name);
    assert.equal(s.blockedSourceCode, null, name);
    assert.deepEqual(s.approvalBlockers, ["import_switch_off"], `${name}: Ready but for the switch`);
  }
  const seen = (await reads(team, viewers.granted, cand.id)).summary.previewHash;
  await withSwitchOn(async () => {
    const r = await api(`/teams/${team.teamId}/candidates/${cand.id}/approve`, { method: "POST", cookie: viewers.granted.cookie, body: { previewHash: seen } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.outcome, "imported");
    assert.equal(r.body.approval.basis, "team_grant");
    // (5) the embedded candidate, at the granted coach's level (other).
    const embedded = r.body.candidate;
    assert.equal(embedded.status, "imported");
    assert.equal(embedded.previewHash, cand.preview_hash);
    const values = embedded.preview.athletes.flatMap((a) => a.results.flatMap((res) => res.values));
    assert.ok(values.length > 0, "the embedded preview names the imported values");
    for (const v of values) for (const field of ADMIN_VALUE_FIELDS) assert.ok(!(field in v), `the embedded value carries no ${field}`);
    for (const field of ADMIN_VALUE_FIELDS) assert.ok(!r.text.includes(`"${field}"`), `no ${field} anywhere in the answer`);
    assert.ok(!("unactivatedSourceMetrics" in embedded.preview));
  });
  const [approval] = await approvalsOf(cand.id);
  assert.equal(String(approval.approved_by_user_id), viewers.granted.id);
  assert.equal(approval.approval_basis, "team_grant");
  // The platform admin still reads the admin fields of the same candidate.
  const pa = (await reads(team, viewers.padmin, cand.id)).candidate;
  const paValues = pa.preview.athletes.flatMap((a) => a.results.flatMap((res) => res.values));
  assert.ok(paValues.every((v) => typeof v.activationId === "string" && typeof v.mappingVersionId === "string"));
});

// ---------------------------------------------------------------------------
test("4. D29, C110 and R17: a club variable with a maximum, activated alone - an athlete whose every value is out of range is kept with allValuesLeftOut, no result value and its Left-out entries in plain words for everyone, the reason code and the admin fields only for the two administrators; a coach of the club's team reads the club variable's name, a viewer C99 does not admit reads 'Club variable'; the approval writes only the other athlete's value", async () => {
  const team = await setupTeam({ activate: false });
  const viewers = await viewersOf(team);
  // The seeded max_v revision is confirmed by the system world (built once per database).
  const world = await ensureMappedSystem(admin, { platformAdminId: team.padmin.id });
  const [variables, mappings, activations] = await Promise.all([
    import("../src/canonicalVariableAdminService.js"),
    import("../src/sourceMetricMappingService.js"),
    import("../src/sourceMetricActivationService.js"),
  ]);
  // The platform admin acting for the club (the club's workspace basis of sourceMetricAccess.js).
  const ctx = { userId: String(team.padmin.id), basis: "platform_admin", owner: { scope: "club", clubId: String(team.clubId) } };
  const rk = () => crypto.randomUUID();
  const variable = (await variables.createVariable({
    ctx, body: { requestKey: rk(), label: "Club max speed", unit: "km/h", levels: ["session", "drill"], dailyAggregationMethod: "max", maxValue: "40" },
  })).variable;
  const variableId = String(variable.id);
  const definition = (await admin.query(`select key, owner_scope, owner_club_id from training_load.metric_definitions where id = $1`, [variableId])).rows[0];
  assert.deepEqual([definition.owner_scope, String(definition.owner_club_id)], ["club", String(team.clubId)]);
  const variableKey = definition.key;
  const mapping = (await mappings.createMapping({ ctx, body: { requestKey: rk(), sourceMetricId: world.gpexe_max_speed.fieldId, metricDefinitionId: variableId } })).mapping;
  const version = (await mappings.createVersion({
    ctx, mappingId: mapping.id,
    body: { requestKey: rk(), sourceRevisionId: world.gpexe_max_speed.revId, appliesToSession: true, appliesToDrill: true, conversionNote: "Metres per second to kilometres per hour." },
  })).version;
  await mappings.submitVersion({ ctx, mappingId: mapping.id, versionId: version.id, body: { requestKey: rk() } });
  await mappings.activateVersion({ ctx, mappingId: mapping.id, versionId: version.id, body: { requestKey: rk(), expectedActiveVersionId: null } });
  const started = await activations.startActivations({
    ctx, body: { requestKey: rk(), mappingId: mapping.id, versionId: version.id, bindings: [{ bindingId: team.bindingId, requirement: "optional" }], reason: "9-B audience test activation." },
  });
  assert.equal(started.activations.length, 1);
  const activationId = String(started.activations[0].id ?? started.activations[0].activationId);
  assert.equal((await admin.query(`select count(*)::int as n from training_load.source_metric_mapping_activations where source_team_binding_id = $1 and ended_at is null`, [team.bindingId])).rows[0].n, 1, "the club variable alone");

  // 101: 11.5 m/s = 41.4 km/h everywhere (above 40); 102: 6.2 m/s = 22.32 km/h.
  await checkNow(team, [sessionBundle({ sessionId: 9401, maxV: { 101: 11.5 } })]);
  const cand = await onlyCandidate(team);
  assert.equal(cand.status, "pending");
  assert.equal(cand.preview.status, "ready");

  for (const [name, viewer] of Object.entries(viewers)) {
    const level = LEVEL[name];
    const { summary: s, detail, candidate: c } = await reads(team, viewer, cand.id);
    assert.equal(s.blockedCode, null, `${name}: Ready`);
    assert.equal(s.previewStatus, "ready", name);
    assert.deepEqual(s.reasons, [], name);
    const a101 = athleteOf(c.preview, "101");
    assert.equal(a101.allValuesLeftOut, true, `${name}: D29`);
    assert.equal(a101.notImported, null, `${name}: the athlete is kept`);
    assert.equal(a101.results.length, 3, `${name}: whole session and both drills`);
    assert.ok(a101.results.every((r) => r.values.length === 0), `${name}: no result value`);
    assert.equal(a101.skippedValues.length, 3, name);
    for (const sv of a101.skippedValues) {
      assert.equal(sv.message, LEFT_OUT_RANGE, `${name}: the plain reason for everyone`);
      assert.ok(!("value" in sv), `${name}: a Left-out entry never carries the value`);
      assert.equal(sv.variableScope, "club");
      assert.equal(sv.label, "Club max speed", `${name}: a coach of the club's team reads the name (C99)`);
      assert.equal(sv.variableKey, variableKey, name);
      if (level === "other") {
        for (const field of ["reason", "sourceReason", ...ADMIN_VALUE_FIELDS]) assert.ok(!(field in sv), `${name}: no ${field}`);
      } else {
        assert.equal(sv.reason, "canonical_value_out_of_range", name);
        assert.equal(sv.sourceReason, "canonical_value_out_of_range", name);
        assert.equal(sv.activationId, activationId, name);
        assert.equal(sv.mappingVersionId, String(version.id), name);
        assert.ok("sourceParameterFingerprint" in sv, name);
      }
    }
    const a102 = athleteOf(c.preview, "102");
    assert.ok(!a102.allValuesLeftOut, name);
    assert.equal(a102.results.length, 2, `${name}: whole session and drill 0`);
    for (const r of a102.results) {
      assert.equal(r.values.length, 1, name);
      const [v] = r.values;
      assert.equal(v.metricDefinitionId, variableId);
      assert.ok(Math.abs(Number(v.value) - 22.32) < 1e-9, `${name}: 6.2 m/s is ${v.value} km/h`);
      assert.equal(v.label, "Club max speed", name);
      for (const field of ADMIN_VALUE_FIELDS) assert.equal(field in v, level !== "other", `${name}: ${field}`);
    }
    if (level === "other") {
      // Security review LOW (9-B): the coach's projection removes named fields
      // (a deny-list), so the exact key sets a coach reads are pinned here - a
      // field added to the preview, a value or a Left-out entry must be decided
      // for this level before it ships.
      const keys = (o) => Object.keys(o).sort();
      assert.deepEqual(keys(c.preview), ["anomalies", "athletes", "blocked", "changesToImported", "counts", "session", "status", "teamAthletesWithoutGpexeRecord", "thresholdsUsed", "unactivatedSourceMetricCount", "version"], `${name}: the preview's keys`);
      assert.deepEqual(keys(a101), ["allValuesLeftOut", "athleteId", "blocksSession", "gpexeAthleteId", "gps", "notImported", "notes", "participation", "results", "skippedValues"], `${name}: an athlete's keys`);
      assert.deepEqual(keys(a102.results[0]), ["drillIndex", "externalId", "level", "outcome", "values"], `${name}: a result's keys`);
      assert.deepEqual(keys(a102.results[0].values[0]), ["change", "label", "metricDefinitionId", "previous", "sourceMetricKey", "sourceUnit", "sourceValue", "unit", "value", "variableKey", "variableScope"], `${name}: a value's keys`);
      for (const sv of a101.skippedValues) assert.deepEqual(keys(sv), ["drillIndex", "label", "level", "message", "sourceMetricKey", "unit", "variableKey", "variableScope"], `${name}: a Left-out entry's keys`);
      // The nested containers a coach reads, pinned the same way (code re-review of the 9-B fixes). A change to an
      // already imported result carries values projected by the same projectValue as a result's (asserted above).
      assert.deepEqual(keys(c.preview.session), ["categoryName", "drillsCount", "gpexeTeamSessionId", "name", "occurredLocalDate", "startTimestamp"], `${name}: the session's keys`);
      assert.deepEqual(keys(c.preview.thresholdsUsed), ["id"], `${name}: thresholdsUsed's keys`);
      assert.deepEqual(keys(c.preview.counts), ["already_recorded", "athletesManualReview", "athletesNotImported", "changesToImported", "corrected", "created", "needs_review", "skippedValues", "stale_resend_ignored", "supplemented", "unchanged"], `${name}: the counts' keys`);
      assert.deepEqual(keys(a101.gps), ["reason", "status"], `${name}: gps's keys`);
      assert.deepEqual(keys(a101.participation), ["status"], `${name}: participation's keys`);
      assert.deepEqual(c.preview.changesToImported, [], `${name}: no earlier import here`);
      assert.ok(!detail.text.includes("canonical_value_out_of_range"), `${name}: the Left-out code is for the administrators`);
      for (const field of [...ADMIN_VALUE_FIELDS, "sourceReason"]) assert.ok(!detail.text.includes(`"${field}"`), `${name}: no ${field} anywhere`);
      assert.ok(!("unactivatedSourceMetrics" in c.preview), name);
    } else {
      assert.ok(Array.isArray(c.preview.unactivatedSourceMetrics), name);
    }
  }

  // The platform admin approves: (5) the embedded candidate keeps the admin fields for the platform admin.
  const seen = (await reads(team, viewers.padmin, cand.id)).summary.previewHash;
  await withSwitchOn(async () => {
    const r = await api(`/teams/${team.teamId}/candidates/${cand.id}/approve`, { method: "POST", cookie: viewers.padmin.cookie, body: { previewHash: seen } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.outcome, "imported");
    const a101 = athleteOf(r.body.candidate.preview, "101");
    assert.equal(a101.allValuesLeftOut, true);
    assert.ok(a101.skippedValues.every((sv) => sv.activationId === activationId && sv.reason === "canonical_value_out_of_range"));
  });
  // The same candidate read by the coach afterwards: none of them.
  const after = await reads(team, viewers.coach, cand.id);
  assert.equal(after.candidate.status, "imported");
  for (const sv of athleteOf(after.candidate.preview, "101").skippedValues) {
    for (const field of ["reason", "sourceReason", ...ADMIN_VALUE_FIELDS]) assert.ok(!(field in sv), `coach after the import: no ${field}`);
    assert.equal(sv.message, LEFT_OUT_RANGE);
  }
  for (const field of ADMIN_VALUE_FIELDS) assert.ok(!after.detail.text.includes(`"${field}"`), `coach after the import: no ${field} anywhere`);

  // Nothing of athlete 101 is written as a value; athlete 102's max speed is.
  const valuesOf = async (athleteId) => (await admin.query(
    `select v.metric_definition_id, v.value_numeric::text as t from training_load.metric_values v
       join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
      where p.athlete_id = $1`,
    [athleteId],
  )).rows;
  assert.deepEqual(await valuesOf(team.a101), [], "no value for the athlete whose every value was left out");
  const of102 = await valuesOf(team.a102);
  assert.equal(of102.length, 2, "athlete 102: whole session and drill 0");
  for (const row of of102) {
    assert.equal(String(row.metric_definition_id), variableId);
    assert.ok(Math.abs(Number(row.t) - 22.32) < 1e-9, row.t);
  }

  // R17 at unit level on the stored preview: a viewer C99 does not admit
  // reads "Club variable" and no key; one it admits reads the name.
  const stored = (await admin.query(`select preview from training_load.gpexe_import_candidates where id = $1`, [cand.id])).rows[0].preview;
  const hidden = projectPreview(stored, "other", { namesClubVariables: false });
  const entries = (p) => p.athletes.flatMap((a) => [...a.skippedValues, ...a.results.flatMap((r) => r.values)]);
  assert.ok(entries(hidden).length > 0);
  for (const e of entries(hidden)) {
    assert.equal(e.label, CLUB_VARIABLE_LABEL);
    assert.ok(!("variableKey" in e));
  }
  for (const e of entries(projectPreview(stored, "other", { namesClubVariables: true }))) assert.equal(e.label, "Club max speed");

  // R17 (the lock-order pull request): the route asks C99 (resolveVariableEditor)
  // with the workspace this request already resolved, never through a second
  // read of the stored workspace that a switch in between could make disagree
  // with the route's own team check. Counted on the app's pool: the coach's
  // detail read reads the stored workspace exactly once (the request's own
  // resolution), and still names the club variable.
  const workspaceReads = [];
  const realQuery = appPool.query;
  appPool.query = function countingQuery(text, ...rest) {
    const sql = typeof text === "string" ? text : text?.text;
    if (typeof sql === "string" && /user_workspace_preferences/.test(sql)) workspaceReads.push(sql);
    return realQuery.call(this, text, ...rest);
  };
  let named;
  try {
    named = await api(`/teams/${team.teamId}/candidates/${cand.id}`, { cookie: viewers.coach.cookie });
  } finally {
    appPool.query = realQuery;
  }
  assert.equal(named.status, 200, named.text);
  assert.ok(named.text.includes("Club max speed"), "the coach C99 admits reads the club variable's name");
  assert.equal(workspaceReads.length, 1, `one read of the stored workspace: ${workspaceReads.length}`);

  // R17 through the route: the route still admits the team's coach when the
  // team's club is archived (resolveGpexeTeamAccess reads the team only), but
  // C99 (resolveVariableEditor) admits only a coach of an active club - so the
  // same coach now reads "Club variable" and no key.
  await admin.query(`update public.clubs set is_active = false where id = $1`, [team.clubId]);
  const excluded = await reads(team, viewers.coach, cand.id);
  for (const e of entries(excluded.candidate.preview)) {
    assert.equal(e.label, CLUB_VARIABLE_LABEL, "a viewer C99 does not admit reads the neutral label");
    assert.ok(!("variableKey" in e));
  }
  assert.ok(!excluded.detail.text.includes("Club max speed"));
  assert.ok(!excluded.detail.text.includes(variableKey));
});

// ---------------------------------------------------------------------------
test("5. D8: the club's admin who also coaches the team reads at level other in the team workspace and at level club_admin in the club's workspace; one planted instance code shows the difference", async () => {
  const team = await setupTeam();
  const dual = await dualOf(team);
  await checkNow(team, [sessionBundle({ sessionId: 9501 })]);
  const cand = await onlyCandidate(team);
  for (const code of ["source_instance_changed", "source_threshold_contract_mismatch"]) {
    await plant(cand.id, code);
    await setWorkspace(dual.id, "team", team.teamId);
    const inTeam = await reads(team, dual, cand.id);
    assert.equal(inTeam.summary.blockedSourceCode, STABLE_CODE, `${code}: team workspace`);
    assert.deepEqual(inTeam.candidate.preview.blocked, { code: STABLE_CODE, message: COACH_SENTENCE });
    assert.equal(inTeam.summary.previewHash, null);
    assertNoLeak("other", inTeam.list.text, `${code} (list, team workspace)`);
    assertNoLeak("other", inTeam.detail.text, `${code} (detail, team workspace)`);

    await setWorkspace(dual.id, "club", team.clubId);
    const inClub = await reads(team, dual, cand.id);
    const want = expectedFor("club_admin", code);
    assert.equal(inClub.summary.blockedSourceCode, want.source, `${code}: club workspace`);
    assert.deepEqual(inClub.candidate.preview.blocked, want.blocked);
    assert.equal(inClub.summary.previewHash, null, "D10: only the platform admin");
    assertNoLeak("club_admin", inClub.list.text, `${code} (list, club workspace)`);
    assertNoLeak("club_admin", inClub.detail.text, `${code} (detail, club workspace)`);
  }
  assert.equal(expectedFor("club_admin", "source_instance_changed").source, "mapping_not_usable");

  // Unit level: the level comes from the access snapshot's workspace.
  const C = String(team.clubId);
  const T = String(team.teamId);
  const authz = { platformRoles: [], clubRoles: [{ clubId: C, role: "club_admin" }], teamRoles: [{ teamId: T, role: "team_coach" }], managedTeamIds: [T] };
  assert.equal(access.importAudienceOf(authz, { platformAdmin: false, clubId: C, workspace: { type: "team", scopeId: T } }), "other");
  assert.equal(access.importAudienceOf(authz, { platformAdmin: false, clubId: C, workspace: { type: "club", scopeId: C } }), "club_admin");
  assert.equal(access.importAudienceOf(authz, { platformAdmin: false, clubId: C, workspace: { type: "club", scopeId: crypto.randomUUID() } }), "other");
  assert.equal(access.importAudienceOf({ ...authz, clubRoles: [] }, { platformAdmin: false, clubId: C, workspace: { type: "club", scopeId: C } }), "other");
  assert.equal(access.importAudienceOf(authz, { platformAdmin: true, clubId: C, workspace: { type: "platform", scopeId: null } }), "platform");
  assert.equal(access.importAudienceOf(authz, null), "other");
});
