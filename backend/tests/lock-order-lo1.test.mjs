// LO-1, the lock-order pull request (J14 section 7 and R13; J15 section 5 and
// R13; the Rukovodilac's L0 (a), 2026-11-03): every rights check of the
// services locks the users row before the role row - `u, g` for the platform
// role, `u, r` for a club or team role, `u, r, c` with the club - the order of
// the real revocations (routes/organization.js: `for update of u, g` and
// `for update of u, r`); and A1 takes its listed bindings and teams before its
// rights and every lock before its first end (D's order).
//
// Every race here runs the REAL revocation route against the REAL write route
// on a disposable database, in the order that deadlocks when a writer takes
// the role row first: the revocation queued on the user's row behind a peer,
// the writer then started, the peer released. Users first, the writer waits
// behind the revocation and never holds the role row it needs; role first, the
// two wait on each other (40P01). The second order of each pair (the writer
// holding its right first, the revocation waiting) proves the database's own
// role-first re-locks inside the write's triggers (v34/v35/v38) wait for
// nothing once the service holds the rows. No GPEXE request, no persistent
// database.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS_BEFORE_CONFIRMATION_GATE } from "./_gpexe-disposable-db.mjs";
import { writeRevision } from "./support/source-revisions.mjs";
import { allowSyntheticTestFields } from "./support/test-extractors.mjs";

allowSyntheticTestFields();

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const METRICS = "/api/training-load/sources/metrics";
const SOURCES = "/api/training-load/sources";
const GPEXE = "/api/training-load/gpexe";
const ORG = "/api/organization";
const COMPAT = "docs/ai/gpexe-rest-v1-compatibility.md#2-the-table";
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const T4 = "training_load.source_metric_mapping_versions";
const T5 = "training_load.source_metric_mapping_activations";

let db, k, server, apiBase, service, variables, gpexeIdentity, dbModule, appPool, createSession;
const W = {};
const logLines = [];
const originalConsole = {};

before(async () => {
  // v66 (J18, M-B) gates a club admin's activation of a version of a field without parameters; this suite's fields have
  // none, so its database is built through v65 (see GPEXE_TEST_MIGRATIONS_BEFORE_CONFIRMATION_GATE).
  // Not yet in this file: a test on the full schema. Tests 7 and 8 fail on main too and leave connections holding
  // a users row, so a test added after them waits on it; a recorded follow-up of J18's 18-3.
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "lo1", migrations: GPEXE_TEST_MIGRATIONS_BEFORE_CONFIRMATION_GATE });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  // The columns the real revocation routes write and read (as in the 7h suite).
  await k.query(`alter table public.user_club_roles add column if not exists granted_by_user_id uuid,
                   add column if not exists revoked_at timestamptz, add column if not exists revoked_by_user_id uuid,
                   add column if not exists created_at timestamptz not null default now()`);
  await k.query(`alter table public.user_global_roles add column if not exists granted_by_user_id uuid,
                   add column if not exists revoked_at timestamptz, add column if not exists revoked_by_user_id uuid,
                   add column if not exists created_at timestamptz not null default now(),
                   add column if not exists updated_at timestamptz not null default now()`);
  await k.query(`alter table public.user_team_roles add column if not exists granted_by_user_id uuid,
                   add column if not exists revoked_at timestamptz, add column if not exists revoked_by_user_id uuid,
                   add column if not exists created_at timestamptz not null default now(),
                   add column if not exists updated_at timestamptz not null default now()`);
  // The column the identity read compares (public.athletes in the deployed
  // schema has it; the identity suite adds it the same way).
  await k.query(`alter table public.athletes add column if not exists birth_date date`);
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : (a instanceof Error ? `${a.code ?? ""} ${a.message}` : JSON.stringify(a)))).join(" "));
      if (process.env.LO1_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  variables = await import("../src/canonicalVariableAdminService.js");
  gpexeIdentity = await import("../src/gpexeAthleteIdentityService.js");
  dbModule = await import("../src/db.js");
  ({ createSession } = await import("../src/auth.js"));
  appPool = dbModule.pool;
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  W.pa = await platformAdmin();
  W.pa2 = await platformAdmin();
});

after(async () => {
  for (const g of openGates.splice(0)) g.open();
  resetSeams();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) {
    let timer;
    await Promise.race([appPool.end(), new Promise((res) => { timer = setTimeout(res, 5_000); })]);
    clearTimeout(timer);
  }
  await k?.end().catch(() => {});
  await db?.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

function resetSeams() {
  service?.setMappingRightsHoldForTests(null);
  service?.setMappingWriteHoldForTests(null);
  variables?.setVariableWriteHoldForTests(null);
  gpexeIdentity?.setIdentityListHoldForTests?.(null);
}
afterEach(() => {
  for (const g of openGates.splice(0)) g.open();
  resetSeams();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const uid = () => crypto.randomBytes(4).toString("hex");
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
const key = () => crypto.randomUUID();

async function api(prefix, p, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${prefix}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const post = (prefix, p, cookie, body) => api(prefix, p, { method: "POST", cookie, body });
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };

async function user(label) {
  return (await one(k, `insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,true) returning id`, [`${label}-${uid()}@test.local`, label])).id;
}
async function workspace(userId, type, scopeId) {
  await k.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
async function platformAdmin(ws = ["platform", null]) {
  const id = await user("platform-admin");
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  if (ws[0] === "club") await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, ws[1]]);
  await workspace(id, ws[0], ws[1]);
  return { id, cookie: await cookieFor(id) };
}
async function clubAdmin(clubId) {
  const id = await user("club-admin");
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await workspace(id, "club", clubId);
  return { id, cookie: await cookieFor(id) };
}
const club = async () => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`Club ${uid()}`])).id;
const newTeam = async (clubId) => (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;
async function teamCoach(clubId) {
  const teamId = await newTeam(clubId);
  const id = await user("coach");
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await workspace(id, "team", teamId);
  return { id, teamId, cookie: await cookieFor(id) };
}
// A club with `admins` club admins (ascending user id) and one gpexe binding.
async function freshClub(admins = 3) {
  const clubId = await club();
  const list = [];
  for (let i = 0; i < admins; i += 1) list.push(await clubAdmin(clubId));
  list.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { clubId, admins: list };
}

// A club-owned server3 connection per club (verified; the credential parts are
// random bytes, never decrypted) and one team binding per call.
const connectionOf = new Map();
let gpexeTeamCounter = 0;
async function connection(clubId) {
  if (!connectionOf.has(clubId)) {
    connectionOf.set(clubId, (await one(k,
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                                credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
       values ('gpexe','club',$1,'server3','LO-1 test','exchanged_token',$2,'verified',$3,$4,$5,1, now()) returning id`,
      [clubId, W.pa.id, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)])).id);
  }
  return connectionOf.get(clubId);
}
async function binding(clubId) {
  const teamId = await newTeam(clubId);
  gpexeTeamCounter += 1;
  const sourceTeamId = String(970000 + gpexeTeamCounter);
  await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)`, [teamId, sourceTeamId, W.pa.id]);
  const connectionId = await connection(clubId);
  const bindingId = (await one(k,
    `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
     values ($1,$2,'gpexe',$3,$4,$1) returning id`, [teamId, connectionId, sourceTeamId, W.pa.id])).id;
  return { bindingId, teamId, clubId, connectionId, sourceTeamId };
}

// A canonical variable, a test field and a submitted mapping version through the real routes.
async function variable(owner) {
  const res = await post(METRICS, "/variables", owner.cookie, { requestKey: key(), label: `LO-1 variable ${uid()}`, unit: "s", levels: ["session", "drill"], dailyAggregationMethod: "sum" });
  assert.equal(res.status, 201, res.text);
  return { id: res.body.variable.id };
}
async function field() {
  const fieldId = (await one(k, `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'LO-1 test field',$2) returning id`,
    [`lo1.test.f${uid()}`, W.pa.id])).id;
  const revId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape: "number", parameterKind: "none", evidenceRef: COMPAT, unit: "s", unitRef: UNIT_REF, meaning: true, meaningRef: MEANING_REF, state: "active" });
  return { fieldId, revId };
}
async function waitingVersion(owner) {
  const f = await field();
  const target = await variable(owner);
  const m = await post(METRICS, "/mappings", owner.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: target.id });
  assert.equal(m.status, 201, m.text);
  const mappingId = m.body.mapping.id;
  const v = await post(METRICS, `/mappings/${mappingId}/versions`, owner.cookie, { requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: true });
  assert.equal(v.status, 201, v.text);
  ok(await post(METRICS, `/mappings/${mappingId}/versions/${v.body.version.id}/submit`, owner.cookie, { requestKey: key() }));
  return { mappingId, versionId: v.body.version.id };
}
const activate = (v, who, { starts = null } = {}) => post(METRICS, `/mappings/${v.mappingId}/versions/${v.versionId}/activate`, who.cookie, {
  requestKey: key(), expectedActiveVersionId: null,
  ...(starts ? { activations: starts.map((b) => ({ bindingId: b.bindingId, requirement: "required" })), activationReason: `Starts ${uid()}` } : {}),
});
const statusOf = async (v) => (await one(k, `select status, activated_basis from ${T4} where id = $1`, [v.versionId]));

// The real revocations.
const revokeClub = (target, clubId) => api(ORG, `/users/${target.id}/club-roles/${clubId}/club_admin`, { method: "DELETE", cookie: W.pa.cookie });
const revokeCoach = (target, teamId) => api(ORG, `/users/${target.id}/team-roles/${teamId}/team_coach`, { method: "DELETE", cookie: W.pa.cookie });
const revokePlatform = (target) => api(ORG, `/users/${target.id}/global-roles/platform_admin`, { method: "DELETE", cookie: W.pa.cookie });
const grantPlatform = (userId) => k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [userId]);
const grantClub = (userId, clubId) => k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [userId, clubId]);
const unbindRoute = (who, b) => post(SOURCES, `/gpexe/connections/${b.connectionId}/bindings/${b.bindingId}/unbind`, who.cookie, {
  requestKey: key(), reason: `LO-1 unbind ${uid()}`, expected: { teamId: b.teamId, sourceTeamId: b.sourceTeamId },
});
const identities = (who, b) => api(GPEXE, `/teams/${b.teamId}/athlete-identities`, { cookie: who.cookie });
const bindingState = async (b) => (await one(k, `select state from training_load.source_team_bindings where id = $1`, [b.bindingId])).state;
const clubRoleActive = async (userId, clubId) => (await one(k, `select is_active from public.user_club_roles where user_id = $1 and club_id = $2 and role = 'club_admin'`, [userId, clubId])).is_active;
const globalRoleActive = async (userId) => (await one(k, `select is_active from public.user_global_roles where user_id = $1 and role = 'platform_admin'`, [userId])).is_active;

// A peer transaction that holds a user's row FOR UPDATE, so a revocation
// queues on it first.
async function peerHoldsUser(userId) {
  const peer = new pg.Client({ connectionString: db.url });
  await peer.connect();
  await peer.query("begin");
  await peer.query(`select 1 from public.users where id = $1 for update`, [userId]);
  return peer;
}
async function release(peer) {
  await peer.query("commit").catch(() => {});
  await peer.end().catch(() => {});
}
// The number of backends of this database waiting on a lock whose query
// matches `pattern`, at least `n` of them within the time limit.
async function waiters(pattern, n = 1, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await one(k, `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
                                and query ~* $1 and pid <> pg_backend_pid()`, [pattern]);
    if (row.n >= n) return row.n;
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.fail(`fewer than ${n} backend(s) wait on a lock for /${pattern}/`);
}
async function until(condition, label, timeoutMs = 10000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting: ${label}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}
const openGates = [];
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  const g = { promise, open };
  openGates.push(g);
  return g;
}
function holdRights() {
  const g = gate();
  const state = { entered: false };
  service.setMappingRightsHoldForTests(async () => {
    if (state.entered) return;
    state.entered = true;
    await g.promise;
  });
  return { g, state };
}
function holdWrite(where) {
  const g = gate();
  const state = { entered: false };
  service.setMappingWriteHoldForTests(async (_client, at) => {
    if (at !== where || state.entered) return;
    state.entered = true;
    await g.promise;
  });
  return { g, state };
}
const deadlocks = () => logLines.filter((l) => /40P01|deadlock detected/i.test(l));
function noDeadlock(from) {
  assert.deepEqual(deadlocks().slice(from), [], "no 40P01 in the log lines");
}
// The writer queued behind a revocation that is itself queued behind a peer:
// release the peer, then both settle.
async function revocationFirst({ target, revoke, writerPattern, write }) {
  const peer = await peerHoldsUser(target.id);
  const revoking = revoke();
  let writing;
  try {
    await waiters("for update of u, ");
    writing = write();
    await waiters(writerPattern);
  } finally {
    await release(peer);
  }
  return { revoked: await revoking, written: await writing };
}

// ---------------------------------------------------------------------------
// 1-2. Metrics Core (sourceMetricAccess.js rightsStillHold)
// ---------------------------------------------------------------------------
test("1. a platform admin's A1 against the real platform-admin revocation, both orders: queued behind it, A1 is the identical 404 with nothing written and the revocation succeeds; holding its right first, A1 commits (the v35/v52 trigger re-locks of the role and user rows wait for nothing) and the revocation succeeds after it - no 40P01", async () => {
  const from = logLines.length;
  // Order 1: the revocation first.
  const pa = await platformAdmin();
  const v1 = await waitingVersion(pa);
  const { revoked, written } = await revocationFirst({
    target: pa, revoke: () => revokePlatform(pa), writerPattern: "for share of", write: () => activate(v1, pa),
  });
  assert.equal(revoked.status, 200, revoked.text);
  assert.deepEqual([written.status, written.body], [404, { error: "notFound" }], written.text);
  assert.equal((await statusOf(v1)).status, "needs_review", "nothing written");
  assert.equal(await globalRoleActive(pa.id), false);
  // Order 2: A1 holds its right first; the revocation waits for it.
  const pb = await platformAdmin();
  const v2 = await waitingVersion(pb);
  const wh = holdWrite("mapping_version_activate");
  const a1 = activate(v2, pb);
  await until(() => wh.state.entered, "A1 holds after its right");
  const revoking = revokePlatform(pb);
  await waiters("for update of u, g");
  wh.g.open();
  // The answer after the COMMIT checks the right again (C69): the revocation
  // that commits right after A1 can make it the identical 404, while A1's rows
  // are committed either way (as 7h test 17).
  const res = await a1;
  assert.ok([200, 404].includes(res.status), res.text);
  assert.deepEqual(await statusOf(v2), { status: "active", activated_basis: "platform_admin" });
  assert.equal((await revoking).status, 200);
  assert.equal(await globalRoleActive(pb.id), false);
  noDeadlock(from);
});

test("2. a club admin promoted to platform admin during its A1, and the promotion revoked by the real route at the same time: A1's promotion probe (`u, g`) waits behind the revocation, finds no platform role and A1 commits on the club_admin basis - no 40P01", async () => {
  const from = logLines.length;
  const x = await freshClub(2);
  const [adm] = x.admins;
  const v = await waitingVersion(adm);
  const rh = holdRights();
  const a1 = activate(v, adm);
  await until(() => rh.state.entered, "A1 holds before its right (its context is club_admin)");
  await grantPlatform(adm.id);
  const peer = await peerHoldsUser(adm.id);
  const revoking = revokePlatform(adm);
  await waiters("for update of u, g");
  rh.g.open();
  await waiters("for share of");
  await release(peer);
  assert.equal((await revoking).status, 200);
  const res = await a1;
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(await statusOf(v), { status: "active", activated_basis: "club_admin" });
  noDeadlock(from);
});

// ---------------------------------------------------------------------------
// 3-4. The team-coach basis (sourceMetricAccess.js coachRightsStillHold)
// ---------------------------------------------------------------------------
async function coachWithVariable() {
  const x = await freshClub(2);
  const coach = await teamCoach(x.clubId);
  const v = await variable(x.admins[0]);
  const read = await api(METRICS, `/variables/${v.id}`, { cookie: coach.cookie });
  assert.equal(read.status, 200, read.text);
  return { x, coach, variableId: v.id, labelsToken: read.body.variable.labelsToken };
}
const rename = (who, s) => post(METRICS, `/variables/${s.variableId}/rename`, who.cookie, { requestKey: key(), labelsToken: s.labelsToken, label: `Renamed ${uid()}` });

test("3. a coach made the club's admin during a rename, and that role revoked by the real route at the same time: the coach's club-admin probe (`u, r, c`) waits behind the revocation, finds no role and the rename commits on the team_coach basis - no 40P01", async () => {
  const from = logLines.length;
  const s = await coachWithVariable();
  const rh = holdRights();
  const renaming = rename(s.coach, s);
  await until(() => rh.state.entered, "the rename holds before its right (team_coach)");
  await grantClub(s.coach.id, s.x.clubId);
  const peer = await peerHoldsUser(s.coach.id);
  const revoking = revokeClub(s.coach, s.x.clubId);
  await waiters("for update of u, r");
  rh.g.open();
  await waiters("for share of");
  await release(peer);
  assert.equal((await revoking).status, 200);
  const res = await renaming;
  assert.equal(res.status, 200, res.text);
  const request = await one(k, `select basis from training_load.metric_variable_requests where metric_definition_id = $1 and operation = 'variable_rename' order by created_at desc limit 1`, [s.variableId]);
  assert.equal(request.basis, "team_coach");
  noDeadlock(from);
});

test("4. a coach made a platform admin during a rename, and that role revoked by the real route at the same time: the coach's platform probe (`u, g`) waits behind the revocation, finds no role and the rename commits on the team_coach basis - no 40P01", async () => {
  const from = logLines.length;
  const s = await coachWithVariable();
  const rh = holdRights();
  const renaming = rename(s.coach, s);
  await until(() => rh.state.entered, "the rename holds before its right (team_coach)");
  await grantPlatform(s.coach.id);
  const peer = await peerHoldsUser(s.coach.id);
  const revoking = revokePlatform(s.coach);
  await waiters("for update of u, g");
  rh.g.open();
  await waiters("for share of");
  await release(peer);
  assert.equal((await revoking).status, 200);
  const res = await renaming;
  assert.equal(res.status, 200, res.text);
  const request = await one(k, `select basis from training_load.metric_variable_requests where metric_definition_id = $1 and operation = 'variable_rename' order by created_at desc limit 1`, [s.variableId]);
  assert.equal(request.basis, "team_coach");
  noDeadlock(from);
});

// ---------------------------------------------------------------------------
// 5-6. Source connections (sourceConnectionService.js rightsStillHold)
// ---------------------------------------------------------------------------
test("5. a club admin's Unbind against the real club-admin revocation, queued behind it: the Unbind is refused (rights_changed, nothing ended) and the revocation succeeds - no 40P01", async () => {
  const from = logLines.length;
  const x = await freshClub(2);
  const [adm] = x.admins;
  const b = await binding(x.clubId);
  const { revoked, written } = await revocationFirst({
    target: adm, revoke: () => revokeClub(adm, x.clubId), writerPattern: "for share of", write: () => unbindRoute(adm, b),
  });
  assert.equal(revoked.status, 200, revoked.text);
  assert.deepEqual([written.status, written.body.error], [409, "rights_changed"], written.text);
  assert.equal(await bindingState(b), "active", "nothing ended");
  assert.equal(await clubRoleActive(adm.id, x.clubId), false);
  noDeadlock(from);
});

test("6. a platform admin's Unbind against the real platform-admin revocation, queued behind it: the Unbind is refused (rights_changed, nothing ended) and the revocation succeeds - no 40P01", async () => {
  const from = logLines.length;
  const x = await freshClub(1);
  const pa = await platformAdmin();
  const b = await binding(x.clubId);
  const { revoked, written } = await revocationFirst({
    target: pa, revoke: () => revokePlatform(pa), writerPattern: "for share of", write: () => unbindRoute(pa, b),
  });
  assert.equal(revoked.status, 200, revoked.text);
  assert.deepEqual([written.status, written.body.error], [409, "rights_changed"], written.text);
  assert.equal(await bindingState(b), "active", "nothing ended");
  noDeadlock(from);
});

// ---------------------------------------------------------------------------
// 7-8. GPEXE identities (gpexeAthleteIdentityService.js rightHolds, lock: true)
// ---------------------------------------------------------------------------
test("7. a club admin's locked identity read against the real club-admin revocation, both orders: queued behind it, the read is the identical 404; holding its right first, the read answers and the revocation succeeds after it - no 40P01", async () => {
  const from = logLines.length;
  const x = await freshClub(3);
  const [adm1, adm2] = x.admins;
  const b = await binding(x.clubId);
  ok(await identities(adm1, b));
  // Order 1.
  const { revoked, written } = await revocationFirst({
    target: adm1, revoke: () => revokeClub(adm1, x.clubId), writerPattern: "from public[.]users where .* for share", write: () => identities(adm1, b),
  });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(written.status, 404, written.text);
  // Order 2: the read holds its locks (the list hold seam, after the right).
  const g = gate();
  const state = { entered: false };
  gpexeIdentity.setIdentityListHoldForTests(async (at) => {
    if (at !== "locked" || state.entered) return;
    state.entered = true;
    await g.promise;
  });
  const reading = identities(adm2, b);
  await until(() => state.entered, "the read holds after its right");
  const revoking = revokeClub(adm2, x.clubId);
  await waiters("for update of u, r");
  g.open();
  assert.equal((await reading).status, 200);
  assert.equal((await revoking).status, 200);
  noDeadlock(from);
});

test("8. a platform admin's locked identity read against the real platform-admin revocation, queued behind it: the read is the identical 404 and the revocation succeeds - no 40P01", async () => {
  const from = logLines.length;
  const x = await freshClub(1);
  const pa = await platformAdmin();
  const b = await binding(x.clubId);
  ok(await identities(pa, b));
  const { revoked, written } = await revocationFirst({
    target: pa, revoke: () => revokePlatform(pa), writerPattern: "from public[.]users where .* for share", write: () => identities(pa, b),
  });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(written.status, 404, written.text);
  noDeadlock(from);
});

// ---------------------------------------------------------------------------
// 9. A1 in D's order (J15 section 5 and R13)
// ---------------------------------------------------------------------------
test("9. the three-way race of J15 section 5: a club admin's A1 with a listed start held after its right, the real club-admin revocation of that admin (which locks the other admins first, in user id order) and another admin's real Unbind of the listed binding - A1 commits its start, the revocation and the Unbind succeed after it, no 40P01", async () => {
  const from = logLines.length;
  const x = await freshClub(3);
  // The revocation locks the qualifying admins in ascending user id: the
  // Unbind's admin (the smallest id) before A1's admin (the largest).
  const unbinder = x.admins[0];
  const activator = x.admins[2];
  const v = await waitingVersion(activator);
  const b = await binding(x.clubId);
  const wh = holdWrite("mapping_version_activate");
  const a1 = activate(v, activator, { starts: [b] });
  await until(() => wh.state.entered, "A1 holds after its right");
  const revoking = revokeClub(activator, x.clubId);
  await waiters("for update of u, r");
  const unbinding = unbindRoute(unbinder, b);
  // Two backends now wait: the revocation (on A1's admin) and the Unbind -
  // on the binding A1 holds (D's order), or, role first, on its own admin's
  // row that the revocation holds.
  const start = Date.now();
  while ((await one(k, `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`)).n < 2) {
    if (Date.now() - start > 10000) assert.fail("the Unbind never waits");
    await new Promise((res) => setTimeout(res, 20));
  }
  wh.g.open();
  const [activated, revoked, unbound] = await Promise.all([a1, revoking, unbinding]);
  // 200, or the identical 404 when the revocation commits before the answer's
  // own check of the right after A1's COMMIT (C69); A1's rows are committed.
  assert.ok([200, 404].includes(activated.status), activated.text);
  assert.deepEqual(await statusOf(v), { status: "active", activated_basis: "club_admin" });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(await clubRoleActive(activator.id, x.clubId), false);
  assert.equal(unbound.status, 200, unbound.text);
  assert.equal(await bindingState(b), "ended");
  // An Unbind never touches an activation (v48): A1's start stays as it was written.
  const open = await one(k, `select count(*)::int as n from ${T5} where source_team_binding_id = $1 and mapping_version_id = $2 and ended_at is null`, [b.bindingId, v.versionId]);
  assert.equal(open.n, 1, "A1's start");
  noDeadlock(from);
});

test("9b. D's order itself (the code review's LO1-T1): a club admin's A1 with a listed start held at its right (before rightsStillHold's own queries) already holds the listed binding FOR SHARE, so another admin's real Unbind of that binding waits on it; A1 commits its start, the Unbind ends the binding after it, no 40P01", async () => {
  const from = logLines.length;
  const x = await freshClub(2);
  const [unbinder, activator] = x.admins;
  const v = await waitingVersion(activator);
  const b = await binding(x.clubId);
  const rh = holdRights();
  const a1 = activate(v, activator, { starts: [b] });
  await until(() => rh.state.entered, "A1 holds at its right");
  const unbinding = unbindRoute(unbinder, b);
  // Rights before bindings, A1 would hold no binding row here and the Unbind
  // would end the binding at once, never waiting.
  await waiters("for update of b");
  rh.g.open();
  const [activated, unbound] = await Promise.all([a1, unbinding]);
  ok(activated);
  assert.deepEqual(await statusOf(v), { status: "active", activated_basis: "club_admin" });
  // The Unbind's wait is bounded (its 2 s row-lock timeout): on a slow runner
  // A1's tail can outlast it, and the Unbind is then a clean try_again with
  // the binding left active. Either way it waited on the binding (above).
  if (unbound.status === 200) assert.equal(await bindingState(b), "ended");
  else {
    assert.deepEqual([unbound.status, unbound.body.error], [409, "try_again"], unbound.text);
    assert.equal(await bindingState(b), "active");
  }
  const open = await one(k, `select count(*)::int as n from ${T5} where source_team_binding_id = $1 and mapping_version_id = $2 and ended_at is null`, [b.bindingId, v.versionId]);
  assert.equal(open.n, 1, "A1's start, committed before the Unbind");
  noDeadlock(from);
});

test("9c. D's order, step by step (the code review's LO1-SRC-1 and the db review's DB-3): A1 replacing a version with an open activation and listing a start takes no users or role row before the listed bindings, then the bindings and teams, then the rights, then the listed bindings' clubs, all before its first end, and sends no locking clause between the first end and the COMMIT", async () => {
  const x = await freshClub(1);
  const [admin] = x.admins;
  const f = await field();
  const target = await variable(admin);
  const mappingId = ok(await post(METRICS, "/mappings", admin.cookie, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: target.id }), 201).mapping.id;
  const version = async () => {
    const id = ok(await post(METRICS, `/mappings/${mappingId}/versions`, admin.cookie, { requestKey: key(), sourceRevisionId: f.revId, appliesToSession: true, appliesToDrill: true }), 201).version.id;
    ok(await post(METRICS, `/mappings/${mappingId}/versions/${id}/submit`, admin.cookie, { requestKey: key() }));
    return { mappingId, versionId: id };
  };
  const b1 = await binding(x.clubId);
  const b2 = await binding(x.clubId);
  const v1 = await version();
  ok(await activate(v1, admin, { starts: [b1] }));
  const v2 = await version();
  // Record every SQL text the replacement's transaction sends, on the pool
  // the service uses; every wrapped client is restored afterwards.
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
  let res;
  try {
    res = await post(METRICS, `/mappings/${mappingId}/versions/${v2.versionId}/activate`, admin.cookie, {
      requestKey: key(), expectedActiveVersionId: v1.versionId, reason: `Replace ${uid()}`,
      activations: [{ bindingId: b2.bindingId, requirement: "required" }], activationReason: `Starts ${uid()}`,
    });
  } finally {
    appPool.connect = original;
    for (const { c, send } of wrapped) c.query = send;
  }
  ok(res);
  // The patterns are anchored on the services' exact SQL text
  // (sourceMetricActivationSteps.js, sourceMetricAccess.js): a reworded
  // statement makes this test fail rather than pass vacuously.
  const at = (re, from = 0) => seen.findIndex((s, i) => i >= from && re.test(s));
  const iBindings = at(/from training_load\.source_team_bindings where id = any\(\$1::uuid\[\]\) order by id for share$/);
  const iTeams = at(/from public\.teams where id = any\(\$1::uuid\[\]\) order by id for share$/, iBindings);
  const iRights = at(/for share of u, (g|r)$/, iTeams);
  const iClubs = at(/from public\.clubs where id = any\(\$1::uuid\[\]\) order by id for share$/, iRights);
  const iEnd = at(/^update training_load\.source_metric_mapping_activations set ended_at/);
  assert.ok(iBindings >= 0 && iTeams > iBindings && iRights > iTeams && iClubs > iRights && iEnd > iClubs,
    JSON.stringify({ iBindings, iTeams, iRights, iClubs, iEnd, seen: seen.map((s) => s.slice(0, 90)) }, null, 1));
  // No users or role row is locked in the transaction before the listed
  // bindings (the re-review's LO1-RR-2): an early rights check kept beside
  // the late one would hold the user's row while waiting for a binding.
  const iBegin = seen.findLastIndex((s, i) => i < iBindings && /^begin/i.test(s));
  assert.ok(iBegin >= 0, "the replacement's own transaction");
  assert.deepEqual(seen.slice(iBegin, iBindings).filter((s) => /\bfor (share|update|no key update) of u\b/i.test(s)), [], "no user row before the bindings");
  // Between the first end and the COMMIT, A1 sends no locking clause. (The
  // writes' own, foreign-key and trigger locks fall on rows A1 already holds:
  // tests 1, 9 and 10 for the trigger re-locks. The answer's own check of the
  // right after the COMMIT, C69, is a new transaction.)
  const iCommit = at(/^commit$/i, iEnd);
  assert.ok(iCommit > iEnd, "the replacement commits after its ends");
  const lateLocks = seen.slice(iEnd, iCommit).filter((s) => /\bfor (share|update|no key update)\b/i.test(s));
  assert.deepEqual(lateLocks, [], "no locking clause after the first end");
  assert.equal((await one(k, `select count(*)::int as n from ${T5} where mapping_version_id = $1 and ended_at is null`, [v1.versionId])).n, 0, "N's activation ended");
  assert.equal((await one(k, `select count(*)::int as n from ${T5} where mapping_version_id = $1 and source_team_binding_id = $2 and ended_at is null`, [v2.versionId, b2.bindingId])).n, 1, "N+1 started on the listed binding");
});

// ---------------------------------------------------------------------------
// 10. The database's own role-first re-locks (v38) after the service's
// users-first rights (the Rukovodilac's L0 (a): shown by a test)
// ---------------------------------------------------------------------------
test("10. a rename holding its right (users first) while the real revocation of that right waits: the v38 trigger function's role-first re-locks (metric_variable_change_basis) wait for nothing - the club admin's rename and the coach's rename commit, each revocation succeeds after them, no 40P01", async () => {
  const from = logLines.length;
  const holdRename = () => {
    const g = gate();
    const state = { entered: false };
    variables.setVariableWriteHoldForTests(async (_client, at) => {
      if (at !== "variable_rename" || state.entered) return;
      state.entered = true;
      await g.promise;
    });
    return { g, state };
  };
  const lastRename = async (variableId) => one(k, `select basis, requested_by_user_id from training_load.metric_variable_requests
    where metric_definition_id = $1 and operation = 'variable_rename' order by created_at desc limit 1`, [variableId]);
  // (a) club_admin: the club-admin revocation waits on the admin's users row.
  const s1 = await coachWithVariable();
  const admin = s1.x.admins[0];
  const read = await api(METRICS, `/variables/${s1.variableId}`, { cookie: admin.cookie });
  assert.equal(read.status, 200, read.text);
  const h1 = holdRename();
  const renaming1 = rename(admin, { variableId: s1.variableId, labelsToken: read.body.variable.labelsToken });
  await until(() => h1.state.entered, "the club admin's rename holds after its right");
  const revoking1 = revokeClub(admin, s1.x.clubId);
  await waiters("for update of u, r");
  h1.g.open();
  const res1 = await renaming1;
  assert.ok([200, 404].includes(res1.status), res1.text);
  assert.deepEqual({ ...(await lastRename(s1.variableId)) }, { basis: "club_admin", requested_by_user_id: admin.id }, "the rename committed");
  assert.equal((await revoking1).status, 200);
  // (b) team_coach: the team-coach revocation waits on the coach's role row.
  const s2 = await coachWithVariable();
  const h2 = holdRename();
  const renaming2 = rename(s2.coach, s2);
  await until(() => h2.state.entered, "the coach's rename holds after its right");
  const revoking2 = revokeCoach(s2.coach, s2.coach.teamId);
  await waiters("update public.user_team_roles");
  h2.g.open();
  const res2 = await renaming2;
  assert.ok([200, 404].includes(res2.status), res2.text);
  assert.deepEqual({ ...(await lastRename(s2.variableId)) }, { basis: "team_coach", requested_by_user_id: s2.coach.id }, "the rename committed");
  assert.equal((await revoking2).status, 200);
  noDeadlock(from);
});
