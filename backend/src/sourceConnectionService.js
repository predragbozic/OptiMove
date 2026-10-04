// Source credential connections: Connect, Reconnect, Test (F3c2d), the
// verified team binding (F3c2e) and the safe Unbind (F3c2f).
// Contract: docs/ai/source-connections-f3c2-contract.md section 2 (routes,
// the eight mandatory conditions, the state transitions) and the owner's
// order of 2026-10-03. GPEXE / server3 / rest_v1 is the first real profile;
// nothing here names a host, a path or a URL — every network call goes
// through backend/src/sourceHosts.js (the exchange) or the read adapter of
// backend/src/sourceAdapters.js (the test reads), each behind
// resolveApprovedSourceHost() with the catalog row read in the same
// transaction.
//
// What never leaves this module: the username, the password and the issued
// token. They live in the request handler's scope, are used once, and are
// not logged, not audited as values, not returned and not part of any error
// message. The row stores only the AES-256-GCM parts of
// backend/src/sourceCredentialCrypto.js.
//
// Lock order of one attempt (conditions 2–4), held through the source call
// so that two exchanges never run at once for one connection or one user:
//   1. the per-user advisory lock (throttle window across connections);
//   2. the connection row FOR NO KEY UPDATE (lock_timeout bounded: busy → try_again);
//   3. the catalog row FOR SHARE and the host gate;
//   4. every bound team, ascending, try-lock style (hold_gpexe_team_lock);
//   5. the throttle count from the append-only audit;
//   6. the key ring; only then the network.
// Nothing waits on a team lock while holding the connection row (the lock
// is a try-lock), so the binding trigger's reverse order cannot deadlock.
// A bind (F3c2e) is a branch of the same attempt: after the connection row it
// takes its one team's row FOR SHARE, that team's try-lock and the team's
// takes every bound team and the target team try-lock style, ascending,
// reads the team's approved pair (gpexe_team_settings) FOR SHARE, reads the
// chosen team alone, takes the team row FOR SHARE only after the source
// answered, and inserts the binding with its audit in the same transaction;
// a bind that reached the source without succeeding counts in the 5 / 15 min
// window like a credential attempt.
import crypto from "node:crypto";
import { pool } from "./db.js";
import { isPlatformAdministrator, holdsClubAdminRole } from "./authz.js";
import { resolveActiveWorkspace } from "./workspace.js";
import { resolveApprovedSourceHost, sourceExchange, sourceHost, isAllowedHostKey } from "./sourceHosts.js";
import { adapterFamilies, createSourceAdapter } from "./sourceAdapters.js";
import { encryptCredential, decryptCredential, keyringFromEnv } from "./sourceCredentialCrypto.js";

export class SourceConnectionError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "SourceConnectionError";
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}
const refusal = (status, code, message, details) => new SourceConnectionError(status, code, message, details);

export const THROTTLE_WINDOW_MINUTES = 15;
export const THROTTLE_MAX_ATTEMPTS = 5;
export const ROW_LOCK_TIMEOUT_MS = 2_000;
// How long one user's attempt waits for that user's previous attempt (the
// per-user lock) before it answers try_again; then the row lock's own bound.
export const USER_LOCK_WAIT_MS = 20_000;
// Statements inside the attempt's transaction, and the whole transaction's
// idle time while the source is called, are bounded too, so a stalled source
// or database can never hold the pool and the locks for good.
export const STATEMENT_TIMEOUT_MS = 10_000;
export const ATTEMPT_NETWORK_BUDGET_MS = 90_000;
export const EXCHANGE_TIMEOUT_MS = 30_000;
export const TEST_TIMEOUT_MS = 30_000;
export const MAX_EXCHANGE_ANSWER_BYTES = 64 * 1024;
export const MAX_USERNAME_LENGTH = 254;
export const MAX_PASSWORD_LENGTH = 512;
export const MAX_TOKEN_LENGTH = 4096;
export const COMMIT_ANSWER_TIMEOUT_MS = 15_000;
export const UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_SYSTEM = /^[a-z][a-z0-9_]{1,30}$/;
const HOST_KEY = /^[a-z0-9][a-z0-9_-]{0,30}$/;
const ONE_LINE = /^[^\r\n\t\0]+$/;
// The credential kind this step supports end to end: the owner's Connect
// form takes a username and a password, exchanges them once and keeps the
// token. An official API token entered directly (api_token) is a later step.
export const SUPPORTED_CREDENTIAL_KIND = "exchanged_token";
// When a connection has no bound team yet, the credential is checked with
// the one read that needs no team: the team list count. The adapter is
// built for that read with a placeholder it never sends as a team; no team
// is checked, chosen or derived from that list.
const UNBOUND_LIST_PLACEHOLDER_TEAM = "0";
// The only metadata keys an audit row may carry (condition 5). The v27
// trigger refuses a secret-named key whatever the value; these are facts.
// source_team_id is the source's own team number, stored in clear in
// source_team_bindings (v27); it is a fact, not a secret.
// request_id / request_hash (F3c2f): the idempotency identity of an Unbind,
// stored on its audit row (the audit is the request record: append-only, per
// connection, team and user); source_contacted: the plain fact that an
// Unbind never reaches the source. None of these names a secret.
const AUDIT_METADATA_KEYS = new Set(["host_key", "credential_kind", "status_class", "attempt_no", "bound_team_count", "source_team_count", "counted", "attempt_id", "source_team_id", "request_id", "request_hash", "source_contacted", "binding_id"]);
export const UNBIND_REASON_MAX_LENGTH = 500;
// The canonical source team id per source (gpexe: the guard PR's numeric
// form, the v27 CHECK); any other source: the v27 generic form.
const SOURCE_TEAM_ID = { gpexe: /^(0|[1-9][0-9]{0,11})$/, default: /^[A-Za-z0-9._:-]{1,64}$/ };
// A gpexe_team_settings value (v22 allows leading zeros) compared in its
// canonical form — the same rule as training_load.gpexe_team_id_canonical (v30).
const canonicalGpexeTeamId = (raw) => (typeof raw === "string" && /^[0-9]{1,12}$/.test(raw) ? raw.replace(/^0+(?=[0-9])/, "") : raw);

// ---------------------------------------------------------------------------
// Test seams (never set by the application).
// ---------------------------------------------------------------------------
let fetchForSource = null;
let commitTimeoutMs = COMMIT_ANSWER_TIMEOUT_MS;
let uncertainCheckTimeoutMs = UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS;
let commitFault = null;
let uncertainCheckFault = null;
let nowForTests = null;
let exchangeTimeoutMs = EXCHANGE_TIMEOUT_MS;
let testTimeoutMs = TEST_TIMEOUT_MS;
let userLockWaitMs = USER_LOCK_WAIT_MS;
let networkBudgetMs = ATTEMPT_NETWORK_BUDGET_MS;
let statementTimeoutMs = STATEMENT_TIMEOUT_MS;
let writeFault = null;
export function setSourceFetchForTests(fetchImpl) { fetchForSource = fetchImpl ?? null; }
export function setSourceConnectionTimingForTests({ exchangeTimeout = EXCHANGE_TIMEOUT_MS, testTimeout = TEST_TIMEOUT_MS, userLockWait = USER_LOCK_WAIT_MS, networkBudget = ATTEMPT_NETWORK_BUDGET_MS, statementTimeout = STATEMENT_TIMEOUT_MS } = {}) {
  exchangeTimeoutMs = exchangeTimeout; testTimeoutMs = testTimeout; userLockWaitMs = userLockWait; networkBudgetMs = networkBudget; statementTimeoutMs = statementTimeout;
}

// A checked-out pool client has no 'error' listener of its own (pg-pool
// removes its idle listener at checkout), and pg emits 'error' when the
// server ends the session or the socket drops while no query runs — exactly
// what idle_in_transaction_session_timeout or a pooler reset does during
// the network call. Without a listener that event would crash the process.
// The listener is removed again before the client goes back to the pool.
function guardClient(client) {
  const onClientError = () => {};
  client.on("error", onClientError);
  return (destroy = false) => {
    client.removeListener("error", onClientError);
    client.release(destroy ? true : undefined);
  };
}
// A fault injected right before the row is written (after the source was
// reached): tests prove that such an attempt is still recorded and counted.
export function setSourceConnectionWriteFaultForTests(fn) { writeFault = fn ?? null; }
let bindInsertFault = null;
// Runs right before the binding INSERT, after every in-code check: a test
// inserts a clashing row from another session there, so the v27 unique
// indexes (the database's backstop) are really what refuses.
export function setSourceBindingInsertFaultForTests(fn) { bindInsertFault = fn ?? null; }
let unbindHold = null;
// Runs inside an Unbind after every lock and check, right before its UPDATE:
// a test holds the transaction there to race it against a bind, a Settings
// change or an import of the same team.
export function setSourceUnbindHoldForTests(fn) { unbindHold = fn ?? null; }
let unbindReplayHold = null;
// Runs inside an Unbind once its own earlier request record was found, right
// before the replay's right re-check: a test revokes the right there.
export function setSourceUnbindReplayHoldForTests(fn) { unbindReplayHold = fn ?? null; }
let auditDedupeHold = null;
// Runs inside the refusal-audit transaction while its dedupe advisory lock is
// held, after the check-and-insert and before COMMIT: a test races a second
// identical refusal against it and proves that exactly one audit row is
// written (the second waits on the lock and then sees the committed row).
export function setSourceAuditDedupeHoldForTests(fn) { auditDedupeHold = fn ?? null; }
// A delay injected before the compensating audit row of an attempt that
// reached the source and did not commit: tests prove that the row is still
// visible to the throttle before the next attempt of the same user runs.
let compensationDelayMs = 0;
export function setSourceConnectionCompensationDelayForTests(ms) { compensationDelayMs = ms ?? 0; }
// A fault injected into the read a route makes AFTER a confirmed COMMIT:
// tests prove that such a read never turns a committed attempt into a 500.
let postCommitReadFault = null;
export function setPostCommitReadFaultForTests(fn) { postCommitReadFault = fn ?? null; }
export function setSourceConnectionCommitForTests({ fault = null, timeoutMs = COMMIT_ANSWER_TIMEOUT_MS, checkFault = null, checkTimeoutMs = UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS } = {}) {
  commitFault = fault; commitTimeoutMs = timeoutMs; uncertainCheckFault = checkFault; uncertainCheckTimeoutMs = checkTimeoutMs;
}
export function setSourceConnectionClockForTests(fn) { nowForTests = fn ?? null; }
const sourceFetch = () => fetchForSource ?? globalThis.fetch;

// ---------------------------------------------------------------------------
// Access (D2 settled by the owner on 2026-10-03): an active platform admin in
// the platform workspace or in the owning club's workspace, or the owning
// club's own active admin in that club's workspace. Everything else — another
// role, another club's admin, another workspace, an archived or missing club
// — is the same 404 as a missing connection (ADR-006). Resolved once per
// request.
// ---------------------------------------------------------------------------
export async function resolveConnectionAdmin(req) {
  if (!req?.user?.id || !req.authz) return null;
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  if (!workspace) return null;
  const scopeId = workspace.scopeId ? String(workspace.scopeId) : null;
  // One path, two bases (owner decision 2026-10-03): an active platform
  // admin in the platform workspace or in a club's workspace; otherwise an
  // active club admin, only in the club workspace of their own club (the
  // workspace list admits an active club only, and the club is checked again
  // on every read and after every source call).
  if (isPlatformAdministrator(req.authz)) {
    if (workspace.type !== "platform" && workspace.type !== "club") return null;
    return { userId: String(req.user.id), basis: "platform_admin", workspace: { type: workspace.type, scopeId } };
  }
  if (workspace.type === "club" && scopeId && holdsClubAdminRole(req.authz, scopeId)) {
    return { userId: String(req.user.id), basis: "club_admin", workspace: { type: "club", scopeId } };
  }
  return null;
}
// After the time a source call took, the caller's right and the owning club
// must still hold before anything is stored — by the context's basis, the
// rows FOR SHARE so a revocation or an archive running meanwhile is ordered
// against this transaction.
async function rightsStillHold(client, ctx, clubId) {
  const right = ctx.basis === "platform_admin"
    ? await client.query(
      `select 1 from public.user_global_roles g join public.users u on u.id = g.user_id
        where g.user_id = $1 and g.role = 'platform_admin' and g.is_active = true and u.is_active = true for share of g, u`,
      [ctx.userId],
    )
    : await client.query(
      `select 1 from public.user_club_roles r join public.users u on u.id = r.user_id
        where r.user_id = $1 and r.club_id = $2 and r.role = 'club_admin' and r.is_active = true and u.is_active = true for share of r, u`,
      [ctx.userId, clubId],
    );
  const club = await client.query(`select 1 from public.clubs where id = $1 and coalesce(is_active, true) for share`, [clubId]);
  return right.rowCount > 0 && club.rowCount > 0;
}
function clubVisible(ctx, clubId) {
  if (ctx.workspace.type === "platform") return ctx.basis === "platform_admin";
  return ctx.workspace.type === "club" && ctx.workspace.scopeId === String(clubId);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const CONNECTION_COLUMNS = `c.id, c.source_system, c.owner_scope, c.owner_club_id, c.owner_team_id, c.host_key, c.account_label, c.credential_kind,
  c.state, c.last_verified_at, c.last_error_code, c.last_error_at, c.created_at, c.updated_at,
  (c.credential_ciphertext is not null) as has_credential, cl.is_active as club_active`;

function publicConnection(row, bindings = []) {
  // Never a credential part, never a username: state, facts and labels only.
  return {
    id: row.id, sourceSystem: row.source_system, hostKey: row.host_key,
    hostLabel: isAllowedHostKey(row.source_system, row.host_key) ? sourceHost(row.source_system, row.host_key).label : null,
    ownerScope: row.owner_scope, ownerClubId: row.owner_club_id, accountLabel: row.account_label, credentialKind: row.credential_kind,
    state: row.state, hasCredential: row.has_credential === true,
    lastVerifiedAt: row.last_verified_at, lastErrorCode: row.last_error_code, lastErrorAt: row.last_error_at,
    boundTeams: bindings.map((b) => ({ ...publicBinding(b), teamActive: b.team_active !== false })),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// A binding as it is shown: the OptiMove team (id and name from the OptiMove
// database), the source team id, its state and when it was bound. Never the
// source's own name of the team, never an account fact.
function publicBinding(b) {
  return { bindingId: b.id, teamId: b.team_id, teamName: b.team_name ?? null, sourceTeamId: b.source_team_id, state: "active", boundAt: b.bound_at };
}

async function bindingsOf(executor, connectionId) {
  return (await executor.query(
    `select b.id, b.team_id, b.source_team_id, b.bound_at, t.name as team_name, coalesce(t.is_active, true) as team_active
       from training_load.source_team_bindings b join public.teams t on t.id = b.team_id
      where b.connection_id = $1 and b.state = 'active' order by b.team_id`,
    [connectionId],
  )).rows;
}

export async function listConnections({ ctx, sourceSystem, clubId }) {
  if (!SOURCE_SYSTEM.test(sourceSystem ?? "")) return null;
  if (typeof clubId !== "string" || !UUID.test(clubId) || !clubVisible(ctx, clubId)) return null;
  const club = (await pool.query(`select id from public.clubs where id = $1 and coalesce(is_active, true)`, [clubId])).rows[0];
  if (!club) return null;
  const rows = (await pool.query(
    `select ${CONNECTION_COLUMNS} from training_load.source_credential_connections c join public.clubs cl on cl.id = c.owner_club_id
      where c.source_system = $1 and c.owner_scope = 'club' and c.owner_club_id = $2 order by c.created_at, c.id`,
    [sourceSystem, clubId],
  )).rows;
  const out = [];
  for (const row of rows) out.push(publicConnection(row, await bindingsOf(pool, row.id)));
  return out;
}

export async function getConnection({ ctx, sourceSystem, id }) {
  if (!SOURCE_SYSTEM.test(sourceSystem ?? "") || typeof id !== "string" || !UUID.test(id)) return null;
  if (postCommitReadFault) await postCommitReadFault();
  const row = (await pool.query(
    `select ${CONNECTION_COLUMNS} from training_load.source_credential_connections c join public.clubs cl on cl.id = c.owner_club_id
      where c.id = $1 and c.source_system = $2 and c.owner_scope = 'club'`,
    [id, sourceSystem],
  )).rows[0];
  if (!row || row.club_active === false || !clubVisible(ctx, row.owner_club_id)) return null;
  return publicConnection(row, await bindingsOf(pool, row.id));
}

// ---------------------------------------------------------------------------
// Create: one not_connected row and its audit row. Club-owned only (D4); the
// host must be approved in the catalog AND resolvable AND speak a family
// this backend has a read adapter for AND have a confirmed exchange — the
// first real profile is server3 / rest_v1, and nothing falls back to e03.
// ---------------------------------------------------------------------------
export async function createConnection({ ctx, sourceSystem, body }) {
  // A source this backend knows nothing about is the same 404 as elsewhere.
  if (!SOURCE_SYSTEM.test(sourceSystem ?? "") || adapterFamilies(sourceSystem).length === 0) return null;
  const b = plainBody(body, ["ownerScope", "ownerClubId", "hostKey", "accountLabel", "credentialKind"]);
  if (b.ownerScope !== "club") throw refusal(400, "owner_scope_unsupported", "A source connection belongs to a club in this step; teams are bound to it separately.");
  if (typeof b.ownerClubId !== "string" || !UUID.test(b.ownerClubId)) throw refusal(400, "invalid_body", "ownerClubId must be a club id.");
  if (typeof b.hostKey !== "string" || !HOST_KEY.test(b.hostKey)) throw refusal(400, "invalid_body", "hostKey must be a catalog key.");
  if (typeof b.accountLabel !== "string" || !ONE_LINE.test(b.accountLabel) || b.accountLabel.trim().length < 1 || b.accountLabel.length > 120) {
    throw refusal(400, "invalid_body", "accountLabel is one line of 1 to 120 characters.");
  }
  if (b.credentialKind !== SUPPORTED_CREDENTIAL_KIND) throw refusal(400, "credential_kind_unsupported", "Only a token obtained by a one-time username/password exchange is supported in this step.");
  if (!clubVisible(ctx, b.ownerClubId)) return null;
  const client = await pool.connect();
  const release = guardClient(client);
  let released = false;
  let created = null;
  try {
    await client.query("begin");
    await client.query(`set local lock_timeout = '${ROW_LOCK_TIMEOUT_MS}ms'`);
    await client.query(`set local statement_timeout = '${statementTimeoutMs}ms'`);
    const club = (await client.query(`select id from public.clubs where id = $1 and coalesce(is_active, true) for share`, [b.ownerClubId])).rows[0];
    if (!club) { await client.query("rollback"); released = true; release(); return null; }
    const catalog = (await client.query(`select source_system, host_key, state from training_load.source_host_catalog where source_system = $1 and host_key = $2 for share`, [sourceSystem, b.hostKey])).rows[0];
    let host;
    try {
      host = resolveApprovedSourceHost(sourceSystem, b.hostKey, catalog);
    } catch {
      throw refusal(400, "host_not_allowed", "That source host is not approved for new connections.");
    }
    if (!host.exchange) throw refusal(400, "exchange_not_supported", "No credential exchange is confirmed on that host.");
    if (!adapterFamilies(sourceSystem).includes(host.apiFamily)) throw refusal(400, "adapter_not_available", "This backend has no read adapter for the API family that host speaks.");
    const row = (await client.query(
      `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, updated_by_user_id)
       values ($1, 'club', $2, $3, $4, $5, $6, $6) returning id`,
      [sourceSystem, b.ownerClubId, b.hostKey, b.accountLabel.trim(), b.credentialKind, ctx.userId],
    )).rows[0];
    const auditId = await insertAudit(client, { connectionId: row.id, action: "create", outcome: "ok", userId: ctx.userId, basis: ctx.basis, metadata: { host_key: b.hostKey, credential_kind: b.credentialKind } });
    // The same bounded COMMIT and verify as an attempt: once the COMMIT is
    // sent, the answer never says "nothing was created".
    released = true;
    const confirmation = await commitAttempt(client, release, auditId, row.id);
    created = { id: row.id, confirmation };
  } catch (error) {
    if (!released) {
      await client.query("rollback").catch(() => {});
      released = true;
      release();
    }
    if (error?.code === "55P03") throw refusal(409, "try_again", "Another change of this club or host is running. Try again when it has finished.");
    if (error instanceof SourceConnectionError) throw error;
    throw internal("create", error);
  } finally {
    if (!released) release();
  }
  // The read after the COMMIT: if it fails, the creation still stands and a
  // minimal answer says so instead of a failure that would hide the write.
  try {
    const connection = await getConnection({ ctx, sourceSystem, id: created.id });
    return connection ? { ...connection, ...(created.confirmation ? { commitConfirmation: created.confirmation } : {}) } : { id: created.id, state: "not_connected", readError: "connection_read_failed" };
  } catch {
    return { id: created.id, state: "not_connected", readError: "connection_read_failed" };
  }
}

// ---------------------------------------------------------------------------
// The three attempts
// ---------------------------------------------------------------------------
export function connect(args) { return attempt({ ...args, action: "connect" }); }
export function reconnect(args) { return attempt({ ...args, action: "reconnect" }); }
export function testConnection(args) { return attempt({ ...args, action: "test" }); }
// F3c2e: bind one OptiMove team of the owning club to one chosen source team,
// after that team's own read with the stored credential succeeded.
export function bindTeam(args) { return attempt({ ...args, action: "bind" }); }

// ---------------------------------------------------------------------------
// F3c2f: Unbind — end an active binding. A LOCAL operation only: no request to
// the source, no exchange, no credential change, nothing deleted (the binding
// row becomes `ended` with when / who / why; the settings row and the
// provenance pointer stay). Idempotent by requestKey: the audit row of the
// successful Unbind is its request record (append-only, per connection, team
// and performing user), so the same key answers the same saved facts without
// a second UPDATE or audit, and the same key with another body is refused.
// Lock order: the per-user lock → the connection row FOR NO KEY UPDATE → the
// request record (a replay is answered here, behind the two locks that
// serialize one user's and one connection's changes, before any team lock, so
// a retry of a lost answer never meets a busy team) → the TARGET team's
// import try-lock (an Unbind changes neither the credential nor the
// connection's state, so the credential-attempt rule "every bound team" does
// not apply: a Check now or import of a sibling team must not block the
// remedy; the v27 trigger takes the same try-lock inside the UPDATE) → the
// binding row FOR UPDATE → the checks → the right and the club re-checked →
// UPDATE + audit `unbind` in one transaction → the bounded COMMIT. 55P03 and
// 40P01 are `try_again`; nothing waits without a bound. The connection does
// not have to be `verified`: a binding can always be ended safely.
// ---------------------------------------------------------------------------
export async function unbindTeam({ ctx, sourceSystem, id, bindingId, body }) {
  if (!SOURCE_SYSTEM.test(sourceSystem ?? "") || typeof id !== "string" || !UUID.test(id) || typeof bindingId !== "string" || !UUID.test(bindingId)) return null;
  const request = readUnbindBody(plainBody(body, ["requestKey", "reason", "expected"]), sourceSystem);
  const requestHash = crypto.createHash("sha256").update(JSON.stringify({ sourceSystem, id: id.toLowerCase(), bindingId: bindingId.toLowerCase(), reason: request.reason, expected: request.expected })).digest("hex");
  const attemptId = crypto.randomUUID();
  const action = "unbind";
  const client = await pool.connect();
  const release = guardClient(client);
  let released = false;
  let known = null;
  let recorded = false;
  try {
    await client.query("begin");
    await client.query(`set local statement_timeout = '${statementTimeoutMs}ms'`);
    await client.query(`set local idle_in_transaction_session_timeout = '${statementTimeoutMs * 3}ms'`);
    // 1. Identity, unlocked: the connection must be visible to the caller and
    //    the binding must be that connection's; anything else is the same 404.
    const pre = (await client.query(
      `select c.id, c.host_key, c.credential_kind, c.owner_club_id, cl.is_active as club_active, b.team_id
         from training_load.source_credential_connections c
         join public.clubs cl on cl.id = c.owner_club_id
         join training_load.source_team_bindings b on b.connection_id = c.id
        where c.id = $1 and c.source_system = $2 and c.owner_scope = 'club' and b.id = $3`,
      [id, sourceSystem, bindingId],
    )).rows[0];
    if (!pre || pre.club_active === false || !clubVisible(ctx, pre.owner_club_id)) { await client.query("rollback"); released = true; release(); return null; }
    known = { connectionId: pre.id, hostKey: pre.host_key, credentialKind: pre.credential_kind, teamId: pre.team_id, sourceTeamId: null };
    // 2. The per-user lock (one change of this user at a time, bounded).
    await client.query(`set local lock_timeout = '${userLockWaitMs}ms'`);
    await client.query(`set local statement_timeout = '${userLockWaitMs + 2_000}ms'`);
    try {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`source-auth-throttle:${ctx.userId}`]);
    } catch (error) {
      if (error.code === "55P03" || error.code === "57014") throw refusal(409, "try_again", "Another connect, reconnect, test, bind or unbind of yours is still running. Try again when it has finished.", { connectionId: id });
      throw error;
    }
    await client.query(`set local statement_timeout = '${statementTimeoutMs}ms'`);
    await client.query(`set local lock_timeout = '${ROW_LOCK_TIMEOUT_MS}ms'`);
    // 3. The connection row.
    let row;
    try {
      row = (await client.query(
        `select c.id, c.source_system, c.host_key, c.credential_kind, c.owner_club_id, cl.is_active as club_active
           from training_load.source_credential_connections c join public.clubs cl on cl.id = c.owner_club_id
          where c.id = $1 and c.source_system = $2 and c.owner_scope = 'club' for no key update of c`,
        [id, sourceSystem],
      )).rows[0];
    } catch (error) {
      if (error.code === "55P03") throw refusal(409, "try_again", "Another change of this connection is running. Try again when it has finished.", { connectionId: id });
      throw error;
    }
    if (!row || row.club_active === false || !clubVisible(ctx, row.owner_club_id)) { await client.query("rollback"); released = true; release(); return null; }
    // 4. The request record, behind the per-user lock and the connection row
    //    only: the same key of this user on this connection is the same saved
    //    answer (a retry after a lost answer never meets a busy team); the
    //    same key with another body — another binding, reason or pair — is
    //    refused. The record is the append-only audit row of the successful
    //    Unbind, which names the binding it ended. A refusal is NOT a request
    //    record: the same key may repeat a transient or correctable refusal
    //    (try_again, binding_mismatch, …) and a fresh key is always a new
    //    attempt; the key binds to its body only once an Unbind was saved.
    //    The refusal audit's dedupe (the catch block below) only keeps the
    //    same user / key / refusal from adding a second audit row.
    const earlier = (await client.query(
      `select a.id, a.metadata, b.id as binding_id, b.team_id, b.source_team_id, b.state, b.bound_at, b.ended_at, b.ended_by_user_id, b.end_reason, t.name as team_name
         from training_load.source_connection_audit a
         join training_load.source_team_bindings b on b.id = (a.metadata->>'binding_id')::uuid
         join public.teams t on t.id = b.team_id
        where a.connection_id = $1 and a.action = 'unbind' and a.outcome = 'ok' and a.performed_by_user_id = $2 and a.metadata->>'request_id' = $3
        order by a.performed_at, a.id limit 1`,
      [row.id, ctx.userId, request.requestKey],
    )).rows[0];
    if (earlier) {
      if (earlier.metadata.request_hash !== requestHash || String(earlier.binding_id) !== bindingId.toLowerCase()) {
        throw refusal(409, "request_key_reused", "This requestKey was already used for a different Unbind request; use a new key.", { current: { bindingId: earlier.binding_id, teamId: earlier.team_id, sourceTeamId: earlier.source_team_id, state: earlier.state, endedAt: earlier.ended_at } });
      }
      // A replay is a read of the caller's own earlier result; the right is
      // still re-checked, so the retry rule has no exception.
      if (unbindReplayHold) await unbindReplayHold(client);
      if (!(await rightsStillHold(client, ctx, row.owner_club_id))) throw refusal(409, "rights_changed", "The right to manage this connection changed; nothing was changed.");
      await client.query("rollback"); released = true; release();
      return unbindResult(row.id, { id: earlier.binding_id, team_id: earlier.team_id, team_name: earlier.team_name, source_team_id: earlier.source_team_id, state: earlier.state, bound_at: earlier.bound_at, ended_at: earlier.ended_at, ended_by_user_id: earlier.ended_by_user_id, end_reason: earlier.end_reason }, earlier.id, true, null);
    }
    // 5. The target team's import try-lock (a Check now, an import, a Settings
    //    change, a bind, a team move and the binding trigger itself take the
    //    same lock); the other bound teams are not touched by an Unbind.
    const bindings = await bindingsOf(client, row.id);
    try {
      await client.query(`select training_load.hold_gpexe_team_lock($1, 'unbind')`, [pre.team_id]);
    } catch (error) {
      if (error.code === "P0001") throw refusal(409, "try_again", "A GPEXE check, import, settings change or binding change is running for this team. Try again when it has finished.", { teamId: pre.team_id });
      throw error;
    }
    // 6. The binding row itself.
    let binding;
    try {
      binding = (await client.query(
        `select b.id, b.team_id, b.source_team_id, b.state, b.bound_at, b.ended_at, b.ended_by_user_id, b.end_reason, t.name as team_name
           from training_load.source_team_bindings b join public.teams t on t.id = b.team_id
          where b.id = $1 and b.connection_id = $2 for update of b`,
        [bindingId, row.id],
      )).rows[0];
    } catch (error) {
      if (error.code === "55P03") throw refusal(409, "try_again", "Another change of this binding is running. Try again when it has finished.", { connectionId: id });
      throw error;
    }
    if (!binding) { await client.query("rollback"); released = true; release(); return null; }
    known.sourceTeamId = binding.source_team_id;
    const current = { bindingId: binding.id, teamId: binding.team_id, sourceTeamId: binding.source_team_id, state: binding.state, endedAt: binding.ended_at };
    // 7. The checks against the row as it is under the lock.
    if (binding.state !== "active") throw refusal(409, "binding_already_ended", "This binding was already ended; nothing was changed.", { current });
    if (String(request.expected.teamId) !== String(binding.team_id) || request.expected.sourceTeamId !== binding.source_team_id) {
      throw refusal(409, "binding_mismatch", "The binding is not the one named in the request; nothing was changed. Read the current binding and try again.", { current });
    }
    // (test seam: hold the transaction here, with every lock taken and before
    // the final checks, to race it against other operations)
    if (unbindHold) await unbindHold(client);
    // 8. The right and the club, again, right before the write.
    if (!(await rightsStillHold(client, ctx, row.owner_club_id))) throw refusal(409, "rights_changed", "The right to manage this connection changed; nothing was changed.");
    // 9. The end of the binding (the v27 immutability trigger allows exactly
    //    this change and re-takes the team's try-lock this transaction holds).
    const ended = (await client.query(
      `update training_load.source_team_bindings
          set state = 'ended', ended_at = coalesce($2::timestamptz, clock_timestamp()), ended_by_user_id = $3::uuid, end_reason = $4::text
        where id = $1::uuid and state = 'active'
        returning ended_at`,
      [binding.id, testClock(), ctx.userId, request.reason],
    )).rows[0];
    if (!ended) throw refusal(409, "binding_already_ended", "This binding was already ended; nothing was changed.", { current });
    // 10. The audit row, in the same transaction: the request record and the
    //     plain facts (the source was not contacted; nothing counts in the
    //     authentication window).
    const auditId = await insertAudit(client, {
      connectionId: row.id, teamId: binding.team_id, action, outcome: "ok", userId: ctx.userId, basis: ctx.basis, reason: request.reason,
      metadata: { host_key: row.host_key, credential_kind: row.credential_kind, source_team_id: binding.source_team_id, binding_id: binding.id, bound_team_count: Math.max(0, bindings.length - 1), counted: false, source_contacted: false, attempt_id: attemptId, request_id: request.requestKey, request_hash: requestHash },
    });
    recorded = true;
    released = true;
    const confirmation = await commitAttempt(client, release, auditId, row.id, attemptId, binding.team_id);
    return unbindResult(row.id, { ...binding, state: "ended", ended_at: ended.ended_at, ended_by_user_id: ctx.userId, end_reason: request.reason }, auditId, false, confirmation);
  } catch (error) {
    if (error?.code === "55P03" || error?.code === "40P01") error = refusal(409, "try_again", "Another change of this connection, its club or a team is running. Try again when it has finished.", { connectionId: id });
    if (!released) {
      let dead = false;
      await withinBound(client.query("rollback"), 5_000).catch(() => { dead = true; });
      released = true;
      release(dead);
    }
    if (error instanceof SourceConnectionError) {
      const alreadyRecorded = recorded || error.code === "outcome_unknown";
      if (known && !alreadyRecorded && error.status !== 404) {
        // A refusal is audited once per request: the same user repeating the
        // same requestKey into the same refusal adds no row (the audit is
        // append-only and must not grow without bound from retries). The
        // check and the insert are one bounded statement.
        await auditRefusal({ connectionId: known.connectionId, teamId: known.teamId, action, errorCode: error.code, ctx, onceForRequestId: request.requestKey, metadata: { host_key: known.hostKey, credential_kind: known.credentialKind, counted: false, source_contacted: false, attempt_id: attemptId, request_id: request.requestKey, binding_id: bindingId.toLowerCase(), ...(known.sourceTeamId ? { source_team_id: known.sourceTeamId } : {}) } });
      }
      throw error;
    }
    throw internal(action, error);
  } finally {
    if (!released) release();
  }
}

function unbindResult(connectionId, binding, auditId, replayed, commitConfirmation) {
  return {
    connectionId, action: "unbind", outcome: "ok", replayed,
    binding: { bindingId: binding.id, teamId: binding.team_id, teamName: binding.team_name ?? null, sourceTeamId: binding.source_team_id, state: binding.state, boundAt: binding.bound_at, endedAt: binding.ended_at, endedByUserId: binding.ended_by_user_id, endReason: binding.end_reason },
    auditId, sourceContacted: false,
    ...(commitConfirmation ? { commitConfirmation } : {}),
  };
}

// A reason is visible text: no control or format character (that includes
// bidi controls, zero-width characters and the Unicode line separators), at
// least one letter, digit or punctuation mark, at most 500 characters.
// (the Hangul fillers U+115F, U+1160, U+3164, U+FFA0 are letters by category
// but render blank, so they count as invisible here too)
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029\u115F\u1160\u3164\uFFA0]/u;
const VISIBLE_MARK = /[\p{L}\p{N}\p{P}]/u;
function isVisibleReason(text) {
  return text.length >= 1 && text.length <= UNBIND_REASON_MAX_LENGTH && !INVISIBLE.test(text) && VISIBLE_MARK.test(text);
}

// The Unbind body: the idempotency key, the mandatory reason and the pair the
// administrator saw (the concurrency check the schema can answer: a binding
// never changes except to end, so "the same pair, still active" is the whole
// precondition). Nothing else.
function readUnbindBody(body, sourceSystem) {
  const { requestKey, reason, expected } = body;
  if (typeof requestKey !== "string" || !UUID.test(requestKey)) throw refusal(400, "invalid_body", "requestKey must be a UUID chosen by the client for this one Unbind.");
  if (typeof reason !== "string" || !isVisibleReason(reason.trim())) throw refusal(400, "invalid_body", `reason is one line of visible text, at most ${UNBIND_REASON_MAX_LENGTH} characters, and is required.`);
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) throw refusal(400, "invalid_body", "expected must name the binding's teamId and sourceTeamId.");
  for (const key of Object.keys(expected)) if (!["teamId", "sourceTeamId"].includes(key)) throw refusal(400, "invalid_body", "expected carries a field it does not take.");
  const pattern = Object.hasOwn(SOURCE_TEAM_ID, sourceSystem) ? SOURCE_TEAM_ID[sourceSystem] : SOURCE_TEAM_ID.default;
  if (typeof expected.teamId !== "string" || !UUID.test(expected.teamId) || typeof expected.sourceTeamId !== "string" || !pattern.test(expected.sourceTeamId)) {
    throw refusal(400, "invalid_body", "expected must name the binding's teamId and sourceTeamId.");
  }
  return { requestKey: requestKey.toLowerCase(), reason: reason.trim(), expected: { teamId: expected.teamId.toLowerCase(), sourceTeamId: expected.sourceTeamId } };
}

function plainBody(body, allowed) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw refusal(400, "invalid_body", "A JSON object body is required.");
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw refusal(400, "invalid_body", "The body carries a field this request does not take.");
  return body;
}

// The username and the password are read here and nowhere else; the
// handler passes them on by value and keeps no copy.
function readCredentialPair(body) {
  const { username, password } = body;
  if (typeof username !== "string" || username.length < 1 || username.length > MAX_USERNAME_LENGTH || !ONE_LINE.test(username)) throw refusal(400, "invalid_body", "username is one line of at most 254 characters.");
  if (typeof password !== "string" || password.length < 1 || password.length > MAX_PASSWORD_LENGTH || !ONE_LINE.test(password)) throw refusal(400, "invalid_body", "password is one line of at most 512 characters.");
  return { username, password };
}

// The bind body: the OptiMove team and the chosen source team id, nothing
// else — no URL, host, name, credential or list.
function readBindBody(body, sourceSystem) {
  const { teamId, sourceTeamId } = body;
  if (typeof teamId !== "string" || !UUID.test(teamId)) throw refusal(400, "invalid_body", "teamId must be an OptiMove team id.");
  const pattern = Object.hasOwn(SOURCE_TEAM_ID, sourceSystem) ? SOURCE_TEAM_ID[sourceSystem] : SOURCE_TEAM_ID.default;
  if (typeof sourceTeamId !== "string" || !pattern.test(sourceTeamId)) throw refusal(400, "invalid_body", "sourceTeamId must be a canonical source team id.");
  return { teamId: teamId.toLowerCase(), sourceTeamId };
}

function readConfirmation(body) {
  const c = body.confirmation;
  if (c === null || typeof c !== "object" || Array.isArray(c)) throw refusal(400, "invalid_body", "confirmation must name the source, the owning club and the number of affected teams.");
  for (const key of Object.keys(c)) if (!["sourceSystem", "ownerClubId", "affectedTeamCount"].includes(key)) throw refusal(400, "invalid_body", "confirmation carries a field it does not take.");
  if (typeof c.sourceSystem !== "string" || typeof c.ownerClubId !== "string" || !UUID.test(c.ownerClubId) || !Number.isInteger(c.affectedTeamCount) || c.affectedTeamCount < 0) {
    throw refusal(400, "invalid_body", "confirmation must name the source, the owning club and the number of affected teams.");
  }
  return { sourceSystem: c.sourceSystem, ownerClubId: c.ownerClubId, affectedTeamCount: c.affectedTeamCount };
}

async function attempt({ ctx, sourceSystem, id, body, action }) {
  if (!SOURCE_SYSTEM.test(sourceSystem ?? "") || typeof id !== "string" || !UUID.test(id)) return null;
  // Body validation before anything is locked or read: a malformed request is
  // not an attempt and is not audited.
  let pair = null;
  let confirmation = null;
  let bindBody = null;
  if (action === "test") {
    plainBody(body ?? {}, []);
  } else if (action === "bind") {
    bindBody = readBindBody(plainBody(body, ["teamId", "sourceTeamId"]), sourceSystem);
  } else {
    // The pair is copied out and the original body object loses its
    // credential fields at once; only `pair` carries them, until the
    // exchange, and it is dropped in every outcome (finally below).
    pair = readCredentialPair(plainBody(body, action === "reconnect" ? ["username", "password", "confirmation"] : ["username", "password"]));
    if (action === "reconnect") confirmation = readConfirmation(body);
    scrubCredentialFields(body);
  }
  // One logical attempt: every audit row it writes carries this id, and the
  // throttle counts distinct ids, so a committed row plus a later "unknown"
  // row of the same attempt count once.
  const attemptId = crypto.randomUUID();
  // Requests really sent to the source by this attempt, counted at the fetch
  // invocation itself (the exchange and every adapter read go through
  // trackedFetch); "reached the source" is true only once one was invoked.
  let sent = 0;

  const client = await pool.connect();
  const release = guardClient(client);
  let released = false;
  // Everything the audit of a refusal needs, once the row is known.
  let known = null;
  // True once a request to the source was really invoked: such an attempt
  // is recorded and counted whatever happens afterwards.
  let reachedSource = false;
  const trackedFetch = (...args) => {
    sent += 1;
    reachedSource = true;
    return sourceFetch()(...args);
  };
  // Set when this attempt's own audit row was inserted in the transaction.
  let recorded = false;
  try {
    await client.query("begin");
    // Every statement of the attempt and the transaction's idle time while
    // the source answers are bounded (a stalled source or database never
    // holds the pool and the locks for good). The one statement allowed to
    // wait longer is the per-user lock below.
    await client.query(`set local statement_timeout = '${statementTimeoutMs}ms'`);
    await client.query(`set local idle_in_transaction_session_timeout = '${networkBudgetMs + statementTimeoutMs}ms'`);
    // 1. The connection's identity, read without a lock, so that a refusal
    //    below (a busy user lock or row) can still be audited by host key.
    const pre = (await client.query(
      `select c.id, c.host_key, c.credential_kind, c.owner_club_id, cl.is_active as club_active
         from training_load.source_credential_connections c join public.clubs cl on cl.id = c.owner_club_id
        where c.id = $1 and c.source_system = $2 and c.owner_scope = 'club'`,
      [id, sourceSystem],
    )).rows[0];
    if (!pre || pre.club_active === false || !clubVisible(ctx, pre.owner_club_id)) { await client.query("rollback"); released = true; release(); return null; }
    known = { connectionId: pre.id, hostKey: pre.host_key, credentialKind: pre.credential_kind, teamId: null };
    // A bind names a team: it must exist, be active and belong to the owning
    // club, or the answer is the same 404 as a missing connection (a team of
    // another club is never confirmed to exist).
    let teamPre = null;
    if (bindBody) {
      teamPre = (await client.query(`select id, club_id, name, coalesce(is_active, true) as active from public.teams where id = $1`, [bindBody.teamId])).rows[0];
      if (!teamPre || teamPre.active === false || String(teamPre.club_id) !== String(pre.owner_club_id)) { await client.query("rollback"); released = true; release(); return null; }
      known.teamId = bindBody.teamId;
      known.sourceTeamId = bindBody.sourceTeamId;
    }
    // 2. The per-user window (condition 4): two attempts of one user on two
    //    connections never count each other out. One user's attempts are
    //    serialized here; the wait is bounded by lock_timeout (and the
    //    statement timeout is lifted above it for this one statement), then
    //    try_again.
    await client.query(`set local lock_timeout = '${userLockWaitMs}ms'`);
    await client.query(`set local statement_timeout = '${userLockWaitMs + 2_000}ms'`);
    try {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`source-auth-throttle:${ctx.userId}`]);
    } catch (error) {
      if (error.code === "55P03" || error.code === "57014") throw refusal(409, "try_again", "Another connect, reconnect or test of yours is still running. Try again when it has finished.", { connectionId: id });
      throw error;
    }
    await client.query(`set local statement_timeout = '${statementTimeoutMs}ms'`);
    await client.query(`set local lock_timeout = '${ROW_LOCK_TIMEOUT_MS}ms'`);
    // 3. The connection row, FOR NO KEY UPDATE: attempts on one connection
    //    are serialized (a second one answers try_again after lock_timeout),
    //    while the audit row of a refused attempt, whose foreign key only
    //    needs KEY SHARE, can still be written meanwhile.
    let row;
    try {
      row = (await client.query(
        `select c.*, cl.is_active as club_active from training_load.source_credential_connections c join public.clubs cl on cl.id = c.owner_club_id
          where c.id = $1 and c.source_system = $2 and c.owner_scope = 'club' for no key update of c`,
        [id, sourceSystem],
      )).rows[0];
    } catch (error) {
      if (error.code === "55P03") throw refusal(409, "try_again", "Another connect, reconnect or test is running for this connection. Try again when it has finished.", { connectionId: id });
      throw error;
    }
    if (!row || row.club_active === false || !clubVisible(ctx, row.owner_club_id)) { await client.query("rollback"); released = true; release(); return null; }
    // 3. The bound teams, read only after the row lock (condition 2).
    const bindings = await bindingsOf(client, row.id);
    // A bind that exists already, exactly so, is the same final answer BEFORE
    // any state gate: a retry after an unknown outcome gets its binding even
    // when a Test moved the connection out of verified meanwhile (no row, no
    // request, no audit).
    if (bindBody) {
      const same = bindings.find((b) => String(b.team_id) === bindBody.teamId);
      if (same && same.source_team_id === bindBody.sourceTeamId) {
        await client.query("rollback"); released = true; release();
        return { connectionId: row.id, action, outcome: "ok", idempotent: true, binding: publicBinding(same) };
      }
    }
    // The state precondition.
    if (action === "connect" && row.state !== "not_connected") throw refusal(409, "already_connected", "This connection already holds a credential; use Reconnect to replace it.");
    if (action === "bind" && row.state !== "verified") throw refusal(409, "connection_not_verified", "This connection is not verified; run Test connection (or Connect) successfully before binding a team.");
    if (action !== "connect" && row.state === "not_connected") throw refusal(409, "not_connected", "This connection holds no credential yet; use Connect first.");
    if (row.credential_kind !== SUPPORTED_CREDENTIAL_KIND) throw refusal(409, "credential_kind_unsupported", "This connection's credential kind is not supported by this step.");
    // The caller's own team already bound for this source (to another source
    // team, or through another connection) is a conflict before anything is
    // sent. Whether the SOURCE team is bound elsewhere is answered only after
    // the chosen team's own read succeeded (below), so an id the caller's
    // credential cannot see is never confirmed to exist in another club; the
    // two partial unique indexes of v27 are the backstop.
    let legacyPointer = null;
    if (bindBody) {
      const own = await client.query(`select 1 from training_load.source_team_bindings where state = 'active' and source_system = $1 and team_id = $2`, [row.source_system, bindBody.teamId]);
      if (own.rowCount > 0) throw refusal(409, "team_already_bound", "This team is already bound for this source; nothing was changed.", { teamId: bindBody.teamId });
    }
    // The reconnect confirmation (D11) against the bound teams.
    if (confirmation && (confirmation.sourceSystem !== row.source_system || confirmation.ownerClubId !== String(row.owner_club_id) || confirmation.affectedTeamCount !== bindings.length)) {
      throw refusal(409, "confirmation_mismatch", "The confirmation does not name this connection's source, owning club and number of bound teams.", {
        expected: { sourceSystem: row.source_system, ownerClubId: row.owner_club_id, affectedTeamCount: bindings.length },
      });
    }
    // 4. The host gate, catalog row read in this transaction (conditions 1, 7).
    const catalog = (await client.query(`select source_system, host_key, state from training_load.source_host_catalog where source_system = $1 and host_key = $2 for share`, [row.source_system, row.host_key])).rows[0];
    let host;
    try {
      host = resolveApprovedSourceHost(row.source_system, row.host_key, catalog);
    } catch {
      throw refusal(409, "host_not_allowed", "The host of this connection is not approved; nothing was sent to it.");
    }
    if (bindBody) {
      // 5b. A bind may change the connection's state (a refused credential →
      //     needs_reconnect), so, as for every credential attempt (condition
      //     3), every active bound team AND the target team are try-locked in
      //     ascending order, once each — the same lock the insert trigger, a
      //     check, an import, a settings change and a team move take. Any of
      //     them busy: try_again, no state change, no binding. The team ROW is
      //     not taken here: it is read FOR SHARE only after the source
      //     answered (step 9b), so a rename or an archive never waits behind
      //     a slow source.
      const toLock = [...new Set([...bindings.map((b) => String(b.team_id)), bindBody.teamId])].sort();
      for (const teamId of toLock) {
        try {
          await client.query(`select training_load.hold_gpexe_team_lock($1, 'bind')`, [teamId]);
        } catch (error) {
          if (error.code === "P0001") throw refusal(409, "try_again", "A GPEXE check, import, settings change or binding is running for a team of this connection. Try again when it has finished.", { teamId });
          throw error;
        }
      }
      // The approved pair (owner decision 2026-10-04): the team's existing
      // gpexe_team_settings row IS the platform-admin allowlist. It must exist
      // and name, in canonical form, exactly the chosen source team; nothing
      // else may be bound, by anyone. The row is read FOR SHARE (a settings
      // change in flight holds the team lock above, so it is never half-seen)
      // and never written here (D12); the binding carries the provenance
      // pointer to it. The v30 trigger keeps that pair final while the
      // binding is active.
      const setting = row.source_system === "gpexe"
        ? (await client.query(`select gpexe_team_id from training_load.gpexe_team_settings where owner_team_id = $1 for share`, [bindBody.teamId])).rows[0]
        : undefined;
      if (!setting) throw refusal(409, "team_setting_missing", "This team has no approved source team yet; a platform administrator sets it in Settings → Data sources first. Nothing was changed.", { teamId: bindBody.teamId });
      if (canonicalGpexeTeamId(setting.gpexe_team_id) !== bindBody.sourceTeamId) throw refusal(409, "team_setting_mismatch", "This team's approved source team is another one; a platform administrator changes it in Settings → Data sources, with a reason, before it can be bound. Nothing was changed.", { teamId: bindBody.teamId });
      legacyPointer = bindBody.teamId;
    } else {
      // 5. Every bound team, ascending, try-lock style (condition 3).
      for (const b of bindings) {
        try {
          await client.query(`select training_load.hold_gpexe_team_lock($1, $2)`, [b.team_id, action]);
        } catch (error) {
          if (error.code === "P0001") throw refusal(409, "try_again", "A GPEXE check, import or connection change is running for a bound team. Try again when it has finished.", { teamId: b.team_id });
          throw error;
        }
      }
    }
    // 6. The throttle (condition 4): attempts that reached the source in the
    //    window, per connection and per user; a refusal below never counts.
    //    The window is measured by the database's own clock (a test may move
    //    it); one query per key so each uses its own index.
    //    A bind that reached the source and did not succeed (failed, unknown,
    //    or the credential refused) counts in the same window as a credential
    //    attempt: the stored token is sent either way. A successful bind is
    //    exempt (its repeat is a local no-op).
    const COUNTED = `performed_at > coalesce($2::timestamptz, now()) - make_interval(mins => $3)
        and ((action in ('connect', 'reconnect', 'test') and (outcome in ('ok', 'failed', 'unknown') or (outcome = 'refused' and error_code = 'source_auth_rejected')))
          or (action = 'bind' and (outcome in ('failed', 'unknown') or (outcome = 'refused' and error_code = 'source_auth_rejected'))))`;
    const counts = {
      // One logical attempt counts once, however many rows it left (its
      // committed row and a later "unknown" row share the attempt id).
      per_connection: (await client.query(`select count(distinct coalesce(metadata->>'attempt_id', id::text))::int as n from training_load.source_connection_audit where connection_id = $1 and ${COUNTED}`, [row.id, testClock(), THROTTLE_WINDOW_MINUTES])).rows[0].n,
      per_user: (await client.query(`select count(distinct coalesce(metadata->>'attempt_id', id::text))::int as n from training_load.source_connection_audit where performed_by_user_id = $1 and ${COUNTED}`, [ctx.userId, testClock(), THROTTLE_WINDOW_MINUTES])).rows[0].n,
    };
    const attemptNo = Math.max(counts.per_connection, counts.per_user) + 1;
    if (counts.per_connection >= THROTTLE_MAX_ATTEMPTS || counts.per_user >= THROTTLE_MAX_ATTEMPTS) {
      throw refusal(429, "source_auth_throttled", `At most ${THROTTLE_MAX_ATTEMPTS} connection attempts reach the source in ${THROTTLE_WINDOW_MINUTES} minutes. Wait before trying again.`, { retryAfterMinutes: THROTTLE_WINDOW_MINUTES });
    }
    // 7. The key ring, before the network: without it nothing could be stored.
    let keyring;
    try {
      keyring = keyringFromEnv();
    } catch {
      throw refusal(503, "key_missing", "The server has no credential key configured; nothing was sent to the source.");
    }
    const context = { connectionId: row.id, ownerScope: row.owner_scope, ownerClubId: row.owner_club_id, ownerTeamId: row.owner_team_id, sourceSystem: row.source_system, hostKey: row.host_key, credentialKind: row.credential_kind };

    // 8. The network. For a test, the stored token; for connect / reconnect,
    //    the exchange first. The plaintext stays in this scope.
    let token = null;
    let exchangeStatusClass = "none";
    const networkDeadline = Date.now() + networkBudgetMs;
    // Everything up to here is locks, counts and checks; the savepoint lets a
    // failure after the source call be recorded in THIS transaction, with
    // every lock still held, instead of on a second connection.
    await client.query("savepoint attempt_locked");

    const baseMetadata = { host_key: row.host_key, credential_kind: row.credential_kind, attempt_no: attemptNo, bound_team_count: bindings.length, attempt_id: attemptId, ...(bindBody ? { source_team_id: bindBody.sourceTeamId } : {}) };
    if (action === "test" || action === "bind") {
      try {
        token = decryptCredential({ ciphertext: row.credential_ciphertext, nonce: row.credential_nonce, authTag: row.credential_auth_tag, keyVersion: row.credential_key_version }, context, keyring);
      } catch (error) {
        const code = error?.code === "key_version_unknown" ? "key_missing" : "credential_unreadable";
        throw refusal(503, code, code === "key_missing" ? "The server has no key for this connection's credential; nothing was sent to the source." : "The stored credential could not be read; reconnect to store a new one.");
      }
    } else {
      let exchangeSpec;
      try {
        exchangeSpec = sourceExchange(row.source_system, row.host_key, catalog);
      } catch {
        throw refusal(409, "exchange_not_supported", "No credential exchange is confirmed on this host; nothing was sent to it.");
      }
      const result = await exchangeCredential({ exchangeSpec, username: pair.username, password: pair.password, fetchImpl: trackedFetch });
      pair = null;
      exchangeStatusClass = result.statusClass;
      if (!result.ok) {
        // The exchange reached the source and was refused or failed: counted,
        // audited, nothing stored, the state unchanged (a reconnect keeps the
        // old credential; nothing says whether it still works).
        const outcome = result.code === "source_auth_rejected" ? "refused" : "failed";
        const auditId = await insertAudit(client, { connectionId: row.id, action, outcome, errorCode: result.code, userId: ctx.userId, basis: ctx.basis, metadata: { ...baseMetadata, status_class: result.statusClass, counted: true } });
        recorded = true;
        released = true;
        await commitAttempt(client, release, auditId, row.id, attemptId);
        throw refusal(result.code === "source_auth_rejected" ? 409 : 502, result.code, EXCHANGE_MESSAGES[result.code]);
      }
      token = result.token;
    }

    // The test reads (one adapter per bound team; the list count when none),
    // within what is left of the attempt's network budget.
    const read = await testReads({ row, catalog, token, bindings, deadline: networkDeadline, fetchImpl: trackedFetch, chosenSourceTeamId: bindBody?.sourceTeamId ?? null });
    // Nothing was sent at all (the network budget was already spent): not an
    // attempt the source saw — a local refusal, the state unchanged.
    if (!read.ok && sent === 0) {
      // Whatever stopped the reads, no request was invoked: not an attempt the
      // source saw, nothing counted, nothing changed.
      throw refusal(503, read.code === "network_budget_exhausted" ? "network_budget_exhausted" : "attempt_not_sent", "The attempt could not send anything to the source; nothing was changed.");
    }
    const metadata = { ...baseMetadata, status_class: read.ok ? "2xx" : read.statusClass, counted: true, ...(read.sourceTeamCount === null ? {} : { source_team_count: read.sourceTeamCount }) };
    // What the administrator may see of the teams the credential sees (owner
    // decision 2026-10-04): every visible team is matched against the
    // approved pairs of the owning club (the gpexe_team_settings rows of its
    // active teams). A platform admin gets the bounded list with the match
    // per row (support, setting the allowlist); a club admin gets ONLY the
    // intersection — no name, id, count or other fact of a team outside it.
    // The truncation of the source list is reported to both.
    let presented = null;
    if (read.ok && !bindBody && Array.isArray(read.sourceTeams)) {
      // Two settings rows anywhere in the database that are one GPEXE team in
      // canonical form ("981" in club A, "0981" in club B) make the allowlist
      // ambiguous: the v30 unique index refuses that state, and should it exist
      // anyway (the index missing), the list is withheld fail-closed — for
      // every basis — when any such duplicate names a team the source offers or
      // a team of the owning club's own pairs. The check is GLOBAL (every club),
      // not scoped to the owning club, and no row ever wins over another.
      const duplicated = new Set((await client.query(
        `select training_load.gpexe_team_id_canonical(gpexe_team_id) as canonical
           from training_load.gpexe_team_settings
          group by 1 having count(*) > 1`,
      )).rows.map((r) => r.canonical));
      const own = (await client.query(
        `select s.owner_team_id as team_id, s.gpexe_team_id, t.name as team_name
           from training_load.gpexe_team_settings s join public.teams t on t.id = s.owner_team_id
          where t.club_id = $1 and coalesce(t.is_active, true)`,
        [row.owner_club_id],
      )).rows;
      const ownKeys = own.map((r) => canonicalGpexeTeamId(r.gpexe_team_id));
      const ambiguous = (duplicated.size > 0 && (
        read.sourceTeams.some((t) => duplicated.has(t.sourceTeamId))
        || ownKeys.some((key) => duplicated.has(key))))
        // The two reads above are two statements: a duplicate committed between
        // them would be in `own` but not in `duplicated`, so the club's own rows
        // are checked in memory as well — never one row over another.
        || new Set(ownKeys).size !== ownKeys.length;
      const approved = new Map(own.map((r) => [canonicalGpexeTeamId(r.gpexe_team_id), r]));
      if (ambiguous) {
        presented = { unavailable: "approved_pairs_ambiguous" };
      } else {
        const annotated = read.sourceTeams.map((t) => {
          const pair = row.source_system === "gpexe" ? approved.get(t.sourceTeamId) : undefined;
          return { sourceTeamId: t.sourceTeamId, name: t.name, approvedTeamId: pair?.team_id ?? null, approvedTeamName: pair?.team_name ?? null };
        });
        // Fail closed: only the platform basis sees the whole list; any other
        // basis (today club_admin only) sees the intersection.
        const whole = ctx.basis === "platform_admin";
        const teams = whole ? annotated : annotated.filter((t) => t.approvedTeamId !== null);
        presented = { teams, count: whole ? read.sourceTeamCount : teams.length, truncated: read.sourceTeamsTruncated === true };
      }
    }

    // 9. Before anything is stored: the caller's right and the owner must
    //    still hold now, after the time the source took (a revoked admin or
    //    an archived club stores nothing; the token is discarded).
    if (!(await rightsStillHold(client, ctx, row.owner_club_id))) throw refusal(409, "rights_changed", "The right to manage this connection changed while the source was being called; nothing was stored.");
    if (writeFault) await writeFault(client);

    if (bindBody) {
      // 9b. The team row, FOR SHARE for the short rest of the transaction, and
      //     the same qualification as at the pre-read: a team archived or moved
      //     under the administrator while the source answered is the same 404
      //     as a missing one, with nothing bound — but the source WAS reached
      //     with the stored token, so the attempt is audited and counted like
      //     every other source-reaching outcome (condition 5), and a refused
      //     credential still becomes a fact of the connection before the 404.
      const team = (await client.query(`select id, club_id, coalesce(is_active, true) as active from public.teams where id = $1 for share`, [bindBody.teamId])).rows[0];
      if (!team || team.active === false || String(team.club_id) !== String(row.owner_club_id)) {
        if (!read.ok && read.code === "source_auth_rejected") await markNeedsReconnect(client, row.id, ctx.userId);
        const auditId = await insertAudit(client, { connectionId: row.id, teamId: bindBody.teamId, action, outcome: "failed", errorCode: "team_not_available", userId: ctx.userId, basis: ctx.basis, metadata });
        recorded = true;
        released = true;
        await commitAttempt(client, release, auditId, row.id, attemptId, bindBody.teamId);
        return null;
      }
      if (!read.ok) {
        // The source answered and the team cannot be bound: a refused
        // credential is a fact of the connection (needs_reconnect); a team
        // not visible or a source not available changes nothing of it. Each
        // is audited with the team and committed; no row is bound.
        if (read.code === "source_auth_rejected") await markNeedsReconnect(client, row.id, ctx.userId);
        const auditId = await insertAudit(client, { connectionId: row.id, teamId: bindBody.teamId, action, outcome: read.code === "source_auth_rejected" ? "refused" : "failed", errorCode: read.code, userId: ctx.userId, basis: ctx.basis, metadata });
        recorded = true;
        released = true;
        await commitAttempt(client, release, auditId, row.id, attemptId, bindBody.teamId);
        throw refusal(read.code === "source_unavailable" || read.code === "source_answer_unexpected" ? 502 : 409, read.code, BIND_MESSAGES[read.code] ?? BIND_MESSAGES.source_answer_unexpected, { teamId: bindBody.teamId });
      }
      // The chosen team is visible to this credential: only now is "bound to
      // another team already" answered (the unique index is the backstop).
      const taken = await client.query(`select 1 from training_load.source_team_bindings where state = 'active' and source_system = $1 and source_team_id = $2`, [row.source_system, bindBody.sourceTeamId]);
      if (taken.rowCount > 0) throw refusal(409, "source_team_already_bound", "That source team is already bound to another team; nothing was changed.", { teamId: bindBody.teamId });
      // The binding row (the v27 insert trigger re-checks the owner, the host
      // and the pointer, and re-takes the team lock this transaction holds),
      // then its audit, in this transaction.
      let inserted;
      try {
        if (bindInsertFault) await bindInsertFault(client);
        inserted = (await client.query(
          `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
           values ($1, $2, $3, $4, $5, $6) returning id, team_id, source_team_id, bound_at`,
          [bindBody.teamId, row.id, row.source_system, bindBody.sourceTeamId, ctx.userId, legacyPointer],
        )).rows[0];
      } catch (error) {
        if (error.code === "23505" && error.constraint === "source_team_bindings_one_active_per_team_source") throw refusal(409, "team_already_bound", "This team is already bound for this source; nothing was changed.", { teamId: bindBody.teamId });
        if (error.code === "23505" && error.constraint === "source_team_bindings_one_active_per_source_team") throw refusal(409, "source_team_already_bound", "That source team is already bound to another team; nothing was changed.", { teamId: bindBody.teamId });
        if (error.code === "23505") throw refusal(409, "binding_refused", "The database refused this binding; nothing was changed.", { teamId: bindBody.teamId });
        if (error.code === "P0001") throw refusal(409, "try_again", "A GPEXE check, import, settings change or binding is running for this team. Try again when it has finished.", { teamId: bindBody.teamId });
        // The v30 pair trigger (the database's own guarantee of the approved
        // pair; the service checked it under the same locks, so this is a
        // raw-writer or race path) answers the same readable codes.
        if (error.code === "23514" && error.constraint === "source_team_bindings_approved_pair_missing") throw refusal(409, "team_setting_missing", "This team has no approved source team yet; a platform administrator sets it in Settings → Data sources first. Nothing was changed.", { teamId: bindBody.teamId });
        if (error.code === "23514" && error.constraint === "source_team_bindings_approved_pair") throw refusal(409, "team_setting_mismatch", "This team's approved source team is another one; a platform administrator changes it in Settings → Data sources, with a reason, before it can be bound. Nothing was changed.", { teamId: bindBody.teamId });
        if (error.code === "23514" || error.code === "23503") throw refusal(409, "binding_refused", "The database refused this binding (the host, the club, the team or the approved source team changed meanwhile); nothing was changed.", { teamId: bindBody.teamId });
        throw error;
      }
      // A successful bind is NOT counted by the 5 / 15 min window (its repeat
      // is a local no-op), and its audit row says so. `counted` documents
      // what the COUNTED predicate decides from action / outcome / error_code
      // (test 27 keeps the two in step); the one deliberate divergence is an
      // attempt whose COMMIT outcome stayed unknown — its `ok` row says false
      // and its later `unknown` row true, and the window counts the attempt
      // once by attempt_id.
      const auditId = await insertAudit(client, { connectionId: row.id, teamId: bindBody.teamId, action, outcome: "ok", userId: ctx.userId, basis: ctx.basis, metadata: { ...metadata, bound_team_count: bindings.length + 1, counted: false } });
      recorded = true;
      released = true;
      const confirmation3 = await commitAttempt(client, release, auditId, row.id, attemptId, bindBody.teamId);
      return {
        connectionId: row.id, action, outcome: "ok", idempotent: false,
        binding: { bindingId: inserted.id, teamId: inserted.team_id, teamName: teamPre?.name ?? null, sourceTeamId: inserted.source_team_id, state: "active", boundAt: inserted.bound_at },
        ...(confirmation3 ? { commitConfirmation: confirmation3 } : {}),
      };
    }
    // 10. The row: new ciphertext for connect / reconnect; the state per 2.4,
    //     every time from the database's clock.
    let state;
    let errorCode = null;
    if (read.ok) state = "verified";
    else if (read.code === "source_auth_rejected") { state = "needs_reconnect"; errorCode = read.code; }
    else if (action === "test") { state = "source_unavailable"; errorCode = read.code; }
    else { state = "linked_untested"; errorCode = read.code; }
    let parts = null;
    if (action !== "test") {
      parts = encryptCredential(token, context, keyring);
      token = null;
    }
    const written = (await client.query(
      `update training_load.source_credential_connections
          set credential_ciphertext = coalesce($2::bytea, credential_ciphertext), credential_nonce = coalesce($3::bytea, credential_nonce),
              credential_auth_tag = coalesce($4::bytea, credential_auth_tag), credential_key_version = coalesce($5::integer, credential_key_version),
              state = $6::text, last_verified_at = case when $6::text = 'verified' then coalesce($7::timestamptz, now()) else last_verified_at end,
              last_error_code = $8::text, last_error_at = case when $8::text is null then null else coalesce($7::timestamptz, now()) end,
              updated_by_user_id = $9::uuid, updated_at = coalesce($7::timestamptz, now())
        where id = $1::uuid
        returning last_verified_at`,
      [row.id, parts?.ciphertext ?? null, parts?.nonce ?? null, parts?.authTag ?? null, parts?.keyVersion ?? null, state, testClock(), errorCode, ctx.userId],
    )).rows[0];
    const outcome = read.ok ? "ok" : (read.code === "source_auth_rejected" ? "refused" : "failed");
    const auditId = await insertAudit(client, { connectionId: row.id, action, outcome, errorCode, userId: ctx.userId, basis: ctx.basis, metadata });
    recorded = true;
    released = true;
    const confirmation2 = await commitAttempt(client, release, auditId, row.id, attemptId);
    return {
      connectionId: row.id, action, outcome, state, code: errorCode, lastVerifiedAt: state === "verified" ? written.last_verified_at : null,
      boundTeamsChecked: read.boundTeamsChecked, sourceTeamCount: presented?.count ?? null, exchangeStatusClass,
      // The teams this administrator may choose from (id, name and the
      // approved OptiMove team of the pair); nothing is preselected or bound.
      // sourceTeamsTruncated is false only when the source list was complete.
      sourceTeams: presented?.teams ?? null,
      sourceTeamsTruncated: presented?.truncated ?? null,
      ...(presented?.unavailable ? { sourceTeamsUnavailable: presented.unavailable } : {}),
      ...(confirmation2 ? { commitConfirmation: confirmation2 } : {}),
    };
  } catch (error) {
    // A lock wait that ran out on any statement of the attempt (the catalog
    // row, a club row) is the same stable answer as a busy connection row.
    if (error?.code === "55P03" || error?.code === "40P01") error = refusal(409, "try_again", "Another change of this connection, its host, its club or a team is running. Try again when it has finished.", { connectionId: id });
    // Recorded already: the attempt's own row was inserted in the transaction
    // (then committed, or its commit is outcome_unknown and handled there).
    const alreadyRecorded = recorded || (error instanceof SourceConnectionError && error.code === "outcome_unknown");
    const compensate = reachedSource && !alreadyRecorded && known;
    if (compensate) {
      // The source was reached, and the attempt did not commit (a database
      // error, a refused right, a write fault): it is recorded and counted as
      // a failed attempt in THIS transaction — back to the savepoint taken
      // after the locks, the row inserted, the bounded COMMIT — so every
      // lock, the per-user lock included, is held until the row is visible
      // to the next attempt of this user. A fresh, bounded connection is only
      // the fallback when this session is unusable (ended by the server);
      // only then is the user lock already gone (documented residual).
      if (compensationDelayMs > 0) await new Promise((r) => setTimeout(r, compensationDelayMs));
      const code = error instanceof SourceConnectionError ? error.code : "attempt_not_recorded";
      const outcome = error instanceof SourceConnectionError ? "failed" : "unknown";
      const metadata = { host_key: known.hostKey, credential_kind: known.credentialKind, counted: true, attempt_id: attemptId, ...(known.sourceTeamId ? { source_team_id: known.sourceTeamId } : {}) };
      // First choice: this very transaction. Back to the savepoint taken
      // after the locks (an aborted statement is undone, the locks stay),
      // insert the row, commit with the bounded COMMIT discipline. No second
      // pool connection is needed while this one is held.
      let compensated = false;
      if (!released) {
        try {
          await withinBound(client.query("rollback to savepoint attempt_locked"), 5_000);
          const auditId = await withinBound(insertAudit(client, { connectionId: known.connectionId, teamId: known.teamId, action, outcome, errorCode: code, userId: ctx.userId, basis: ctx.basis, metadata }), 5_000);
          released = true;
          try {
            await commitAttempt(client, release, auditId, known.connectionId, attemptId, known.teamId);
            compensated = true;
          } catch {
            // outcome_unknown of the compensation itself: the row may exist;
            // the fallback below may add a second row of the same attempt,
            // which the throttle counts once.
          }
        } catch {
          // This session is unusable (ended by the server, or the savepoint
          // itself failed): fall back below.
        }
      }
      if (!compensated) {
        // Fallback: a fresh connection, bounded. (Only when the session died
        // is the user lock already gone; that residual is documented.)
        await withinBound(auditRefusal({ connectionId: known.connectionId, teamId: known.teamId, action, errorCode: code, ctx, outcome, metadata }), 5_000).catch(() => {});
      }
    }
    if (!released) {
      // The rollback may itself fail on a dead session; the client is then
      // destroyed instead of returned.
      let dead = false;
      await withinBound(client.query("rollback"), 5_000).catch(() => { dead = true; });
      released = true;
      release(dead);
    }
    if (compensate) {
      if (error instanceof SourceConnectionError) throw error;
      console.error(`[source-connections] ${action} reached the source but its result could not be recorded: ${error?.code ?? ""}`.slice(0, 300));
      throw refusal(500, "attempt_not_recorded", "The source was reached, but the result could not be stored. Nothing of this connection changed; read its state before trying again.", { connectionId: known.connectionId });
    }
    if (error instanceof SourceConnectionError) {
      // A refusal that never reached the source is audited on its own, in
      // its own short transaction, and is never counted by the throttle.
      if (known && !alreadyRecorded && error.code !== "attempt_not_recorded" && error.status !== 404) {
        await auditRefusal({ connectionId: known.connectionId, teamId: known.teamId, action, errorCode: error.code, ctx, metadata: { host_key: known.hostKey, credential_kind: known.credentialKind, counted: false, attempt_id: attemptId } });
      }
      throw error;
    }
    throw internal(action, error);
  } finally {
    pair = null;
    if (!released) release();
  }
}

// A bind's read refused the stored credential: a fact of the whole connection
// (2.4), recorded in the attempt's own transaction.
async function markNeedsReconnect(client, connectionId, userId) {
  await client.query(
    `update training_load.source_credential_connections
        set state = 'needs_reconnect', last_error_code = 'source_auth_rejected', last_error_at = coalesce($2::timestamptz, now()),
            updated_by_user_id = $3::uuid, updated_at = coalesce($2::timestamptz, now())
      where id = $1::uuid`,
    [connectionId, testClock(), userId],
  );
}

// The original body object loses its credential fields as soon as they were
// copied out (JavaScript strings cannot be overwritten; what is guaranteed is
// that no reference to them survives in the body the route handed over).
function scrubCredentialFields(body) {
  if (body && typeof body === "object") {
    for (const key of ["username", "password"]) {
      try { body[key] = undefined; delete body[key]; } catch { /* nothing kept */ }
    }
  }
}

const BIND_MESSAGES = {
  source_auth_rejected: "The source refused the stored credential; reconnect before binding a team. Nothing was bound.",
  source_team_not_visible: "The source does not show that team to this credential. Nothing was bound.",
  source_unavailable: "The source did not answer the team's read. Nothing was bound; try again later.",
  source_answer_unexpected: "The source answered the team's read in a way this server does not understand. Nothing was bound.",
};

const EXCHANGE_MESSAGES = {
  source_auth_rejected: "The source refused the username and password. Nothing was stored.",
  source_unavailable: "The source did not answer the exchange. Nothing was stored; try again later.",
  source_answer_unexpected: "The source answered the exchange in a way this server does not understand. Nothing was stored.",
};

// The database's own clock is the clock of the window and of the facts; a
// test may substitute one, the application never does.
function testClock() {
  return nowForTests ? nowForTests().toISOString() : null;
}

function internal(action, error) {
  // The database's own text, a bug or a driver error: a stable code, and
  // never anything of the request in the log line.
  console.error(`[source-connections] ${action} failed: ${error?.code ?? ""} ${error?.message ?? ""}`.slice(0, 500));
  return refusal(500, "internal_error", "The request could not be completed; nothing was changed.");
}

// ---------------------------------------------------------------------------
// The exchange: one POST to the host's confirmed exchange endpoint, in the
// host's confirmed encoding; redirects refused; the answer bounded; only the
// token field read. Statuses become stable codes; the body never leaves.
// ---------------------------------------------------------------------------
async function exchangeCredential({ exchangeSpec, username, password, fetchImpl = sourceFetch() }) {
  const body = exchangeSpec.encoding === "json"
    ? JSON.stringify({ username, password })
    : new URLSearchParams({ username, password }).toString();
  let res;
  try {
    res = await fetchImpl(exchangeSpec.url, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": exchangeSpec.encoding === "json" ? "application/json" : "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(exchangeTimeoutMs),
    });
  } catch {
    return { ok: false, code: "source_unavailable", statusClass: "network" };
  }
  const status = res.status;
  const statusClass = `${Math.floor(status / 100)}xx`;
  if (status >= 300 && status < 400) return { ok: false, code: "source_answer_unexpected", statusClass };
  if (status === 400 || status === 401 || status === 403) return { ok: false, code: "source_auth_rejected", statusClass };
  if (status === 429 || status >= 500) return { ok: false, code: "source_unavailable", statusClass };
  if (status !== 200) return { ok: false, code: "source_answer_unexpected", statusClass };
  let text;
  try {
    text = await readBounded(res, MAX_EXCHANGE_ANSWER_BYTES);
  } catch {
    return { ok: false, code: "source_answer_unexpected", statusClass };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "source_answer_unexpected", statusClass };
  }
  const token = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, exchangeSpec.tokenField) ? parsed[exchangeSpec.tokenField] : undefined;
  if (typeof token !== "string" || token.length < 1 || token.length > MAX_TOKEN_LENGTH || !/^[^\s]+$/.test(token)) {
    return { ok: false, code: "source_answer_unexpected", statusClass };
  }
  return { ok: true, token, statusClass };
}

// Reads a response body up to a limit, counting the bytes as they arrive;
// past the limit the stream is cancelled and the answer refused.
async function readBounded(res, limit) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("too large");
  if (!res.body || typeof res.body.getReader !== "function") {
    const text = typeof res.text === "function" ? await res.text() : "";
    if (Buffer.byteLength(text, "utf8") > limit) throw new Error("too large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error("too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// The test reads: the bound team's own read for every active binding (one
// adapter per bound source team, each limited to that team); with no binding
// yet, the team list count — nothing is chosen or bound from that list.
// ---------------------------------------------------------------------------
async function testReads({ row, catalog, token, bindings, deadline, fetchImpl, chosenSourceTeamId = null }) {
  const active = bindings.filter((b) => b.team_active !== false);
  // Each read gets at most the test timeout, and never more than what is
  // left of the attempt's whole network budget; past the budget the rest
  // is not read (network_budget_exhausted: the caller tells a spent budget
  // before any request from one after some).
  const options = () => {
    const left = deadline - Date.now();
    if (left < 1) throw new SourceAdapterErrorLike("network_budget_exhausted", "network budget exhausted");
    return { sourceSystem: row.source_system, hostKey: row.host_key, catalogRow: catalog, credential: token, fetchImpl, timeoutMs: Math.max(1, Math.min(testTimeoutMs, left)), attempts: 1 };
  };
  try {
    if (chosenSourceTeamId !== null) {
      // A bind: the chosen team's own read, alone, with the adapter bound to
      // exactly that id; never the list.
      await createSourceAdapter({ ...options(), boundSourceTeamId: chosenSourceTeamId }).verifyBoundTeam();
      return { ok: true, code: null, statusClass: "2xx", sourceTeamCount: null, sourceTeams: null, boundTeamsChecked: 1 };
    }
    // Connect / Test: the teams this credential sees (id and name only), for
    // the administrator to choose one from — nothing is chosen, stored or
    // bound here —, then every active bound team's own read.
    const list = await createSourceAdapter({ ...options(), boundSourceTeamId: UNBOUND_LIST_PLACEHOLDER_TEAM }).listVisibleTeams();
    let checked = 0;
    for (const b of active) {
      const adapter = createSourceAdapter({ ...options(), boundSourceTeamId: b.source_team_id });
      await adapter.verifyBoundTeam();
      checked += 1;
    }
    return { ok: true, code: null, statusClass: "2xx", sourceTeamCount: list.teamCount, sourceTeams: list.teams, sourceTeamsTruncated: list.firstPageOnly === true, boundTeamsChecked: checked };
  } catch (error) {
    const code = error?.code;
    const status = error?.status;
    const statusClass = Number.isInteger(status) ? `${Math.floor(status / 100)}xx` : "network";
    if (code === "source_auth_rejected" || code === "source_access_refused") return { ok: false, code: "source_auth_rejected", statusClass, sourceTeamCount: null, sourceTeams: null, boundTeamsChecked: 0 };
    if (code === "source_team_not_visible") return { ok: false, code, statusClass, sourceTeamCount: null, sourceTeams: null, boundTeamsChecked: 0 };
    if (code === "source_unavailable") return { ok: false, code, statusClass, sourceTeamCount: null, sourceTeams: null, boundTeamsChecked: 0 };
    if (code === "network_budget_exhausted") return { ok: false, code, statusClass: "none", sourceTeamCount: null, sourceTeams: null, boundTeamsChecked: 0 };
    if (code === "host_not_allowed" || code === "path_not_allowed" || code === "adapter_not_available") throw refusal(409, "host_not_allowed", "The host of this connection is not approved; nothing was sent to it.");
    // source_answer_unexpected, source_team_mismatch, an unknown adapter code
    return { ok: false, code: "source_answer_unexpected", statusClass, sourceTeamCount: null, sourceTeams: null, boundTeamsChecked: 0 };
  }
}

class SourceAdapterErrorLike extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------------------------------------------------------------------------
// Audit (condition 5): a fixed allowlist of metadata keys; the v27 trigger is
// the backstop. Values are codes, counts and booleans — never a credential,
// a username or a source sentence.
// ---------------------------------------------------------------------------
export function auditMetadata(metadata) {
  const out = {};
  for (const [k, v] of Object.entries(metadata ?? {})) {
    if (!AUDIT_METADATA_KEYS.has(k)) throw new Error(`audit metadata key not allowed: ${k}`);
    if (v === undefined) continue;
    if (!(v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 64 && ONE_LINE.test(v)))) throw new Error(`audit metadata value not allowed: ${k}`);
    out[k] = v;
  }
  return out;
}

async function insertAudit(executor, { connectionId, action, outcome, errorCode = null, userId, basis, metadata = {}, teamId = null, reason = null }) {
  return (await executor.query(
    `insert into training_load.source_connection_audit (connection_id, team_id, action, outcome, error_code, performed_by_user_id, basis, metadata, reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) returning id`,
    [connectionId, teamId, action, outcome, errorCode, userId, basis, JSON.stringify(auditMetadata(metadata)), reason],
  )).rows[0].id;
}

async function auditRefusal({ connectionId, action, errorCode, ctx, metadata, outcome = "refused", teamId = null, onceForRequestId = null }) {
  try {
    // With onceForRequestId the row is written only when this user has no
    // row of the same action, outcome, code and request id on this
    // connection and team yet. The check-and-insert alone is not atomic
    // (no unique index on an append-only table, and the attempt's own locks
    // are already released here), so boundedAuditInsert first takes a
    // transaction-scoped advisory lock on exactly that identity, bounded by
    // lock_timeout, and runs the check-and-insert as the NEXT statement, so
    // its snapshot is taken after the wait. Two identical refusals in flight
    // therefore write one row; the second sees it.
    const dedupeKey = onceForRequestId === null ? null
      : [connectionId, ctx.userId, action, outcome, errorCode ?? "", teamId ?? "null", onceForRequestId].join("|");
    await boundedAuditInsert(
      onceForRequestId === null
        ? `insert into training_load.source_connection_audit (connection_id, team_id, action, outcome, error_code, performed_by_user_id, basis, metadata)
           values ($1, $8, $2, $7, $3, $4, $5, $6::jsonb)`
        : `insert into training_load.source_connection_audit (connection_id, team_id, action, outcome, error_code, performed_by_user_id, basis, metadata)
           select $1::uuid, $8::uuid, $2::text, $7::text, $3::text, $4::uuid, $5::text, $6::jsonb
            where not exists (
              select 1 from training_load.source_connection_audit
               where connection_id = $1::uuid and team_id is not distinct from $8::uuid and action = $2::text and outcome = $7::text
                 and error_code is not distinct from $3::text and performed_by_user_id = $4::uuid and metadata->>'request_id' = $9::text)`,
      onceForRequestId === null
        ? [connectionId, action, errorCode, ctx.userId, ctx.basis, JSON.stringify(auditMetadata(metadata)), outcome, teamId]
        : [connectionId, action, errorCode, ctx.userId, ctx.basis, JSON.stringify(auditMetadata(metadata)), outcome, teamId, onceForRequestId],
      dedupeKey,
    );
  } catch (error) {
    console.error(`[source-connections] the refusal ${errorCode} of ${action} could not be audited: ${error?.code ?? ""}`);
  }
}

// An audit row written outside the attempt's own transaction (a refusal, the
// second row of an unknown outcome): its foreign keys take KEY SHARE locks
// on the connection and the team, and a team row held by a running move or
// archive must not hold this request for the length of that transaction —
// the wait is bounded like every other row wait here, then the row is
// dropped and logged by code only.
//
// With a dedupeKey the insert is a deduplicated one (an Unbind refusal): the
// transaction first takes pg_advisory_xact_lock on that identity — a
// transaction-scoped lock, never a session lock that could stay on a pooled
// connection — under the same lock_timeout (lock_timeout bounds advisory
// waits too: 55P03 after ROW_LOCK_TIMEOUT_MS), then runs the caller's
// check-and-insert as a separate statement so its snapshot is taken after the
// wait, then commits within the COMMIT bound. Identical refusals are thereby
// serialized: the second one's NOT EXISTS sees the first one's row.
async function boundedAuditInsert(sql, params, dedupeKey = null) {
  const client = await pool.connect();
  const release = guardClient(client);
  let dead = false;
  let commitSent = false;
  try {
    // READ COMMITTED is pinned: the dedupe relies on the next statement
    // taking its snapshot after the lock wait, which a stricter default
    // isolation level would silently break.
    await client.query("begin isolation level read committed");
    await client.query(`set local lock_timeout = '${ROW_LOCK_TIMEOUT_MS}ms'`);
    await client.query(`set local statement_timeout = '${statementTimeoutMs}ms'`);
    await client.query(`set local idle_in_transaction_session_timeout = '${statementTimeoutMs}ms'`);
    if (dedupeKey !== null) {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`source-audit-dedupe:${dedupeKey}`]);
    }
    await client.query(sql, params);
    // The test hold sits in the window the lock protects: this transaction's
    // row is written but not committed, so without the lock an identical
    // refusal's NOT EXISTS could not see it and would write a second row.
    if (dedupeKey !== null && auditDedupeHold) await auditDedupeHold(client);
    commitSent = true;
    const commit = client.query("commit");
    commit.catch(() => {});
    await withinBound(commit, commitTimeoutMs);
  } catch (error) {
    // Once COMMIT was sent, nothing more is awaited on this client: a
    // ROLLBACK would queue behind the unanswered COMMIT without a bound, so
    // the client is destroyed instead (the server ends the transaction with
    // the connection). Before that, the ROLLBACK itself is bounded.
    dead = true;
    if (!commitSent) {
      const rollback = client.query("rollback");
      rollback.catch(() => {});
      await withinBound(rollback, 5_000).then(() => { dead = false; }, () => {});
    }
    throw error;
  } finally {
    release(dead);
  }
}

// ---------------------------------------------------------------------------
// COMMIT outcome (the F2 approval discipline): the answer to COMMIT is
// awaited at most commitTimeoutMs; after an error or that time the
// connection is closed and the audit row of this attempt is looked for on a
// fresh connection (at most uncertainCheckTimeoutMs). Found → committed,
// answered as such. Not found or not readable → outcome_unknown, with one
// more audit row "unknown" by the same user and basis when that can be
// written; the client re-reads state instead of resending.
// ---------------------------------------------------------------------------
async function commitAttempt(client, release, auditId, connectionId, attemptId = null, teamId = null) {
  let commitError = null;
  try {
    const commit = commitFault ? commitFault(client) : client.query("commit");
    commit.catch(() => {});
    await withinBound(commit, commitTimeoutMs);
    release();
    return null;
  } catch (error) {
    commitError = error;
    release(true);
  }
  console.error(`[source-connections] the COMMIT of an attempt on ${connectionId} was not confirmed (${commitError?.code ?? ""}); checking whether it is in the database`);
  let found = false;
  try {
    found = await auditRowIsCommitted(auditId, uncertainCheckTimeoutMs);
  } catch (error) {
    console.error(`[source-connections] checking the attempt after an unconfirmed COMMIT failed: ${error?.message ?? ""}`.slice(0, 300));
  }
  if (found) return "verified_after_commit_error";
  throw refusal(503, "outcome_unknown", "The database did not confirm this attempt, and it could not be verified yet. Read the connection's state before doing anything else; do not resend the credentials blindly.", { connectionId, auditId, attemptId, ...(teamId ? { teamId } : {}) });
}

async function auditRowIsCommitted(auditId, ms) {
  const deadline = Date.now() + ms;
  const left = () => Math.max(1, deadline - Date.now());
  const connecting = pool.connect();
  let client;
  try {
    client = await withinBound(connecting, left());
  } catch (error) {
    connecting.then((late) => late.release(true), () => {});
    throw error;
  }
  const release = guardClient(client);
  let broken = false;
  try {
    if (uncertainCheckFault) {
      const fault = Promise.resolve().then(() => uncertainCheckFault(client));
      fault.catch(() => {});
      await withinBound(fault, left());
    }
    const answer = client.query({ text: `select 1 from training_load.source_connection_audit where id = $1`, values: [auditId], query_timeout: left() });
    answer.catch(() => {});
    return (await withinBound(answer, left())).rowCount === 1;
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    release(broken);
  }
}

// The second audit row of an unresolved outcome, written by the handler
// after outcome_unknown (best effort, a fresh connection, never a system
// basis — the v27 actor CHECK).
export async function recordUnknownOutcome({ connectionId, action, ctx, attemptId = null, teamId = null }) {
  try {
    await boundedAuditInsert(
      `insert into training_load.source_connection_audit (connection_id, team_id, action, outcome, error_code, performed_by_user_id, basis, metadata)
       values ($1, $6, $2, 'unknown', 'outcome_unknown', $3, $4, $5::jsonb)`,
      [connectionId, action, ctx.userId, ctx.basis, JSON.stringify(auditMetadata(attemptId ? { attempt_id: attemptId } : {})), teamId],
    );
    return true;
  } catch {
    return false;
  }
}

function withinBound(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
