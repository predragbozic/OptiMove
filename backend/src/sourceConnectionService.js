// Source credential connections: Connect, Reconnect, Test (F3c2d).
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
import { pool } from "./db.js";
import { isPlatformAdministrator } from "./authz.js";
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
const AUDIT_METADATA_KEYS = new Set(["host_key", "credential_kind", "status_class", "attempt_no", "bound_team_count", "source_team_count", "counted"]);

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
// Access: a platform admin only (D2/D3), in the platform workspace or in the
// owning club's workspace. Everything else — another role, another
// workspace, an archived or missing club — is the same 404 as a missing
// connection (ADR-006). Resolved once per request.
// ---------------------------------------------------------------------------
export async function resolveConnectionAdmin(req) {
  if (!req?.user?.id || !req.authz || !isPlatformAdministrator(req.authz)) return null;
  const { workspace } = await resolveActiveWorkspace(req.user.id, req.authz);
  if (!workspace || (workspace.type !== "platform" && workspace.type !== "club")) return null;
  return { userId: String(req.user.id), basis: "platform_admin", workspace: { type: workspace.type, scopeId: workspace.scopeId ? String(workspace.scopeId) : null } };
}
function clubVisible(ctx, clubId) {
  return ctx.workspace.type === "platform" || (ctx.workspace.type === "club" && ctx.workspace.scopeId === String(clubId));
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
    boundTeams: bindings.map((b) => ({ teamId: b.team_id, sourceTeamId: b.source_team_id, teamName: b.team_name ?? null, teamActive: b.team_active !== false })),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function bindingsOf(executor, connectionId) {
  return (await executor.query(
    `select b.team_id, b.source_team_id, t.name as team_name, coalesce(t.is_active, true) as team_active
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
  if (action === "test") {
    plainBody(body ?? {}, []);
  } else {
    pair = readCredentialPair(plainBody(body, action === "reconnect" ? ["username", "password", "confirmation"] : ["username", "password"]));
    if (action === "reconnect") confirmation = readConfirmation(body);
  }

  const client = await pool.connect();
  const release = guardClient(client);
  let released = false;
  // Everything the audit of a refusal needs, once the row is known.
  let known = null;
  // Set right before the first request to the source: an attempt that
  // reached the source is recorded and counted whatever happens afterwards.
  let reachedSource = false;
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
    known = { connectionId: pre.id, hostKey: pre.host_key, credentialKind: pre.credential_kind };
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
    // The state precondition.
    if (action === "connect" && row.state !== "not_connected") throw refusal(409, "already_connected", "This connection already holds a credential; use Reconnect to replace it.");
    if (action !== "connect" && row.state === "not_connected") throw refusal(409, "not_connected", "This connection holds no credential yet; use Connect first.");
    if (row.credential_kind !== SUPPORTED_CREDENTIAL_KIND) throw refusal(409, "credential_kind_unsupported", "This connection's credential kind is not supported by this step.");
    // 3. The bound teams, read only after the row lock (condition 2), and
    //    the reconnect confirmation (D11) against those facts.
    const bindings = await bindingsOf(client, row.id);
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
    // 5. Every bound team, ascending, try-lock style (condition 3).
    for (const b of bindings) {
      try {
        await client.query(`select training_load.hold_gpexe_team_lock($1, $2)`, [b.team_id, action]);
      } catch (error) {
        if (error.code === "P0001") throw refusal(409, "try_again", "A GPEXE check, import or connection change is running for a bound team. Try again when it has finished.", { teamId: b.team_id });
        throw error;
      }
    }
    // 6. The throttle (condition 4): attempts that reached the source in the
    //    window, per connection and per user; a refusal below never counts.
    //    The window is measured by the database's own clock (a test may move
    //    it); one query per key so each uses its own index.
    const COUNTED = `action in ('connect', 'reconnect', 'test')
        and performed_at > coalesce($2::timestamptz, now()) - make_interval(mins => $3)
        and (outcome in ('ok', 'failed', 'unknown') or (outcome = 'refused' and error_code = 'source_auth_rejected'))`;
    const counts = {
      per_connection: (await client.query(`select count(*)::int as n from training_load.source_connection_audit where connection_id = $1 and ${COUNTED}`, [row.id, testClock(), THROTTLE_WINDOW_MINUTES])).rows[0].n,
      per_user: (await client.query(`select count(*)::int as n from training_load.source_connection_audit where performed_by_user_id = $1 and ${COUNTED}`, [ctx.userId, testClock(), THROTTLE_WINDOW_MINUTES])).rows[0].n,
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
    const baseMetadata = { host_key: row.host_key, credential_kind: row.credential_kind, attempt_no: attemptNo, bound_team_count: bindings.length };
    if (action === "test") {
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
      reachedSource = true;
      const result = await exchangeCredential({ exchangeSpec, username: pair.username, password: pair.password });
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
        await commitAttempt(client, release, auditId, row.id);
        throw refusal(result.code === "source_auth_rejected" ? 409 : 502, result.code, EXCHANGE_MESSAGES[result.code]);
      }
      token = result.token;
    }

    // The test reads (one adapter per bound team; the list count when none),
    // within what is left of the attempt's network budget.
    const read = await testReads({ row, catalog, token, bindings, deadline: networkDeadline, onFirstRequest: () => { reachedSource = true; } });
    const metadata = { ...baseMetadata, status_class: read.ok ? "2xx" : read.statusClass, counted: true, ...(read.sourceTeamCount === null ? {} : { source_team_count: read.sourceTeamCount }) };

    // 9. Before anything is stored: the caller's right and the owner must
    //    still hold now, after the time the source took (a revoked admin or
    //    an archived club stores nothing; the token is discarded).
    const adminRows = await client.query(
      `select g.id from public.user_global_roles g join public.users u on u.id = g.user_id
        where g.user_id = $1 and g.role = 'platform_admin' and g.is_active = true and u.is_active = true for share of g, u`,
      [ctx.userId],
    );
    const clubRows = await client.query(`select id from public.clubs where id = $1 and coalesce(is_active, true) for share`, [row.owner_club_id]);
    if (adminRows.rowCount === 0 || clubRows.rowCount === 0) throw refusal(409, "rights_changed", "The right to manage this connection changed while the source was being called; nothing was stored.");
    if (writeFault) await writeFault(client);
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
    const confirmation2 = await commitAttempt(client, release, auditId, row.id);
    return {
      connectionId: row.id, action, outcome, state, code: errorCode, lastVerifiedAt: state === "verified" ? written.last_verified_at : null,
      boundTeamsChecked: read.boundTeamsChecked, sourceTeamCount: read.sourceTeamCount, exchangeStatusClass,
      ...(confirmation2 ? { commitConfirmation: confirmation2 } : {}),
    };
  } catch (error) {
    if (!released) {
      // The rollback may itself fail on a dead session; the client is then
      // destroyed instead of returned.
      let dead = false;
      await withinBound(client.query("rollback"), 5_000).catch(() => { dead = true; });
      released = true;
      release(dead);
    }
    // A lock wait that ran out on any statement of the attempt (the catalog
    // row, a club row) is the same stable answer as a busy connection row.
    if (error?.code === "55P03") error = refusal(409, "try_again", "Another change of this connection, its host or its club is running. Try again when it has finished.", { connectionId: id });
    // Recorded already: the attempt's own row was inserted in the transaction
    // (then committed, or its commit is outcome_unknown and handled there).
    const alreadyRecorded = recorded || (error instanceof SourceConnectionError && error.code === "outcome_unknown");
    if (reachedSource && !alreadyRecorded && known) {
      // The source was reached, and the attempt did not commit (a database
      // error, a refused right, a write fault): it is still recorded and
      // counted, on a fresh connection, as a failed attempt (the throttle
      // counts `failed`), and the answer never says that nothing happened at
      // the source. (The rollback above already released this user's lock,
      // so one more attempt may start before this row lands — at most one.)
      const code = error instanceof SourceConnectionError ? error.code : "attempt_not_recorded";
      await auditRefusal({ connectionId: known.connectionId, action, errorCode: code, ctx, outcome: error instanceof SourceConnectionError ? "failed" : "unknown", metadata: { host_key: known.hostKey, credential_kind: known.credentialKind, counted: true } });
      if (error instanceof SourceConnectionError) throw error;
      console.error(`[source-connections] ${action} reached the source but its result could not be recorded: ${error?.code ?? ""}`.slice(0, 300));
      throw refusal(500, "attempt_not_recorded", "The source was reached, but the result could not be stored. Nothing of this connection changed; read its state before trying again.", { connectionId: known.connectionId });
    }
    if (error instanceof SourceConnectionError) {
      // A refusal that never reached the source is audited on its own, in
      // its own short transaction, and is never counted by the throttle.
      if (known && !alreadyRecorded && error.code !== "attempt_not_recorded") {
        await auditRefusal({ connectionId: known.connectionId, action, errorCode: error.code, ctx, metadata: { host_key: known.hostKey, credential_kind: known.credentialKind, counted: false } });
      }
      throw error;
    }
    throw internal(action, error);
  } finally {
    if (!released) release();
  }
}

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
async function exchangeCredential({ exchangeSpec, username, password }) {
  const body = exchangeSpec.encoding === "json"
    ? JSON.stringify({ username, password })
    : new URLSearchParams({ username, password }).toString();
  let res;
  try {
    res = await sourceFetch()(exchangeSpec.url, {
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
async function testReads({ row, catalog, token, bindings, deadline, onFirstRequest = () => {} }) {
  const active = bindings.filter((b) => b.team_active !== false);
  // Each read gets at most the test timeout, and never more than what is
  // left of the attempt's whole network budget; past the budget the rest
  // is not read and the test fails as source_unavailable.
  const options = () => {
    const left = deadline - Date.now();
    if (left < 1) throw new SourceAdapterErrorLike("source_unavailable", "network budget exhausted");
    return { sourceSystem: row.source_system, hostKey: row.host_key, catalogRow: catalog, credential: token, fetchImpl: sourceFetch(), timeoutMs: Math.max(1, Math.min(testTimeoutMs, left)), attempts: 1 };
  };
  try {
    if (active.length === 0) {
      const adapter = createSourceAdapter({ ...options(), boundSourceTeamId: UNBOUND_LIST_PLACEHOLDER_TEAM });
      onFirstRequest();
      const list = await adapter.countVisibleTeams();
      return { ok: true, code: null, statusClass: "2xx", sourceTeamCount: list.teamCount, boundTeamsChecked: 0 };
    }
    let checked = 0;
    for (const b of active) {
      const adapter = createSourceAdapter({ ...options(), boundSourceTeamId: b.source_team_id });
      onFirstRequest();
      await adapter.verifyBoundTeam();
      checked += 1;
    }
    return { ok: true, code: null, statusClass: "2xx", sourceTeamCount: null, boundTeamsChecked: checked };
  } catch (error) {
    const code = error?.code;
    const status = error?.status;
    const statusClass = Number.isInteger(status) ? `${Math.floor(status / 100)}xx` : "network";
    if (code === "source_auth_rejected" || code === "source_access_refused") return { ok: false, code: "source_auth_rejected", statusClass, sourceTeamCount: null, boundTeamsChecked: 0 };
    if (code === "source_team_not_visible") return { ok: false, code, statusClass, sourceTeamCount: null, boundTeamsChecked: 0 };
    if (code === "source_unavailable") return { ok: false, code, statusClass, sourceTeamCount: null, boundTeamsChecked: 0 };
    if (code === "host_not_allowed" || code === "path_not_allowed" || code === "adapter_not_available") throw refusal(409, "host_not_allowed", "The host of this connection is not approved; nothing was sent to it.");
    // source_answer_unexpected, source_team_mismatch, an unknown adapter code
    return { ok: false, code: "source_answer_unexpected", statusClass, sourceTeamCount: null, boundTeamsChecked: 0 };
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

async function insertAudit(executor, { connectionId, action, outcome, errorCode = null, userId, basis, metadata = {}, teamId = null }) {
  return (await executor.query(
    `insert into training_load.source_connection_audit (connection_id, team_id, action, outcome, error_code, performed_by_user_id, basis, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) returning id`,
    [connectionId, teamId, action, outcome, errorCode, userId, basis, JSON.stringify(auditMetadata(metadata))],
  )).rows[0].id;
}

async function auditRefusal({ connectionId, action, errorCode, ctx, metadata, outcome = "refused" }) {
  try {
    await pool.query(
      `insert into training_load.source_connection_audit (connection_id, action, outcome, error_code, performed_by_user_id, basis, metadata)
       values ($1, $2, $7, $3, $4, $5, $6::jsonb)`,
      [connectionId, action, errorCode, ctx.userId, ctx.basis, JSON.stringify(auditMetadata(metadata)), outcome],
    );
  } catch (error) {
    console.error(`[source-connections] the refusal ${errorCode} of ${action} could not be audited: ${error?.code ?? ""}`);
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
async function commitAttempt(client, release, auditId, connectionId) {
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
  throw refusal(503, "outcome_unknown", "The database did not confirm this attempt, and it could not be verified yet. Read the connection's state before doing anything else; do not resend the credentials blindly.", { connectionId, auditId });
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
export async function recordUnknownOutcome({ connectionId, action, ctx }) {
  try {
    await pool.query(
      `insert into training_load.source_connection_audit (connection_id, action, outcome, error_code, performed_by_user_id, basis, metadata)
       values ($1, $2, 'unknown', 'outcome_unknown', $3, $4, '{}'::jsonb)`,
      [connectionId, action, ctx.userId, ctx.basis],
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
