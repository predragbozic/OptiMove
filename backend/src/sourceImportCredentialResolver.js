// F3c2g — the importer's source-neutral credential resolver: from exactly one
// OptiMove team to a closed read context (an adapter bound to the team's
// approved source team, on the connection's approved host), or to the
// explicitly labelled legacy path for a team that has no new binding yet.
//
// Discovery and the transition rule: docs/ai/source-connections-f3c2g-discovery.md.
// Contract: docs/ai/source-connections-f3c2-contract.md section 2.8.
//
// Rules this module enforces, whoever calls it:
//   * it takes a team id and a source system — never a URL, a host, a source
//     team id or a credential from the caller; the facts and the opened
//     source it hands out are branded, and it refuses any other object;
//   * one active binding at most; the approved pair of gpexe_team_settings
//     (compared canonically, the one rule v30 / the bind / the Settings route
//     share); the connection of the same club, `verified`; the host approved
//     in the catalog AND resolvable in code; otherwise a stable code, never a
//     fallback (a team WITH a binding never reads through the environment
//     token, usable or not);
//   * the facts are read inside the caller's short transaction under the team
//     import lock (phase 1, no decrypt); the key ring is proven without a
//     decrypt before any row exists; the credential is decrypted only after
//     that transaction committed, right before the first request, and the
//     plaintext reference is dropped in `finally` (phase 2) — the adapter
//     closure is then its only holder, as the legacy client closure is today;
//   * nothing of a credential, a username, a password or a URL ever enters a
//     result, a log line, an error or audit metadata;
//   * while a run reads the source without a lock, the same facts — the
//     binding, the connection, its state, its club, its host, the approved
//     pair AND a fingerprint of the stored credential — are re-validated
//     before every operation (phase 3): a binding that ended, a connection
//     that is no longer usable, a credential replaced by a Reconnect, a
//     retired host, a moved team or a changed approved pair stop the run with
//     the precise code; the legacy path is re-validated the same way (a
//     binding that appears mid-run stops it: binding_started); both paths
//     pin the team's club (a team moved or archived, or its club archived,
//     stops the run) and re-validate AFTER every operation too — a list,
//     empty or not, and a bundle are returned only when the facts still hold;
//   * the legacy path is open only to a team that NEVER had a binding for the
//     source: after an Unbind the team is binding_ended until it is bound
//     again, never back on the environment token (owner, 2026-10-04).
import crypto from "node:crypto";
import { pool } from "./db.js";
import { decryptCredential, keyringFromEnv } from "./sourceCredentialCrypto.js";
import { resolveApprovedSourceHost } from "./sourceHosts.js";
import { createSourceAdapter, SourceAdapterError, DIAGNOSTIC_MARK } from "./sourceAdapters.js";

// The importer sees the adapter's error class only through this module: the
// resolver is the importer's one door to the source-connection infrastructure.
export { SourceAdapterError, DIAGNOSTIC_MARK };

export const IMPORT_SOURCE_SYSTEM = "gpexe";
// Only a connection a successful Test or Connect left `verified` is read by an
// import (owner-reviewable decision Q2 of the discovery): an import never
// performs a Test, so it never promotes a state itself.
export const USABLE_CONNECTION_STATES = Object.freeze(["verified"]);
export const PATH_SOURCE_CONNECTION = "source_connection";
export const PATH_LEGACY_ENV = "legacy_env";
// The best-effort state change after a refused credential is bounded on the
// client side too (the F2 COMMIT discipline): past this it is abandoned, the
// client destroyed, and the check's own outcome — already written — stands.
export const AUTO_INVALIDATE_BOUND_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_SYSTEM = /^[a-z][a-z0-9_]{1,30}$/;
const ROW_LOCK_TIMEOUT_MS = 2_000;
const STATEMENT_TIMEOUT_MS = 10_000;

export class SourceImportResolveError extends Error {
  constructor(code, message, { status = 409, facts = {} } = {}) {
    super(message);
    this.name = "SourceImportResolveError";
    this.code = code;
    this.status = status;
    this.facts = facts;
  }
}

const MESSAGES = Object.freeze({
  binding_ambiguous: "The team has more than one active source binding; nothing was read.",
  team_not_available: "The team is not available for a source import.",
  team_setting_missing: "The team has an active source binding but no approved source team; nothing was read.",
  team_setting_mismatch: "The team's active source binding does not name its approved source team; nothing was read.",
  connection_foreign_club: "The team's source connection does not belong to the team's club; nothing was read.",
  connection_not_usable: "The team's source connection is not in a usable state; test or reconnect it first. Nothing was read.",
  connection_credential_changed: "The team's source connection was reconnected while the check was running; the check stopped. Check again.",
  host_not_allowed: "The host of the team's source connection is not approved; nothing was read.",
  adapter_not_available: "There is no read adapter for the host of the team's source connection; nothing was read.",
  key_missing: "The server has no key for this connection's credential; nothing was read.",
  credential_unreadable: "The stored credential could not be read; reconnect to store a new one. Nothing was read.",
  binding_ended: "The team's source binding has ended; bind the team again before the next check. The legacy token is never used for a team that had a binding.",
  team_club_changed: "The team moved to another club while the check was running; the check stopped.",
  binding_started: "A source binding was created for the team while the check was running through the legacy token; the check stopped. Check again.",
  drill_set_incomplete: "The source did not answer every drill of a session; that session was not recorded and the check stopped.",
  source_team_mismatch: "The check asked for a source team other than the bound one; nothing was read.",
  context_not_issued: "The source context was not issued by the resolver; nothing was read.",
});

function fail(code, extra = {}) {
  return new SourceImportResolveError(code, MESSAGES[code] ?? "The source connection cannot be used; nothing was read.", extra);
}
// The codes of a failed check that describe the team's source connection —
// the binding, the connection's state, club, host, key, adapter or credential
// (a refused credential and a resource it may not read included). On the API
// an administrator of the platform or of the team's club sees them; a coach
// sees the stable code `source_connection_unavailable` and the sentence to
// contact an administrator, the same rule as the 409 of a check start. A
// general source answer (a 5xx, an unexpected answer, an incomplete drill
// set) and a team fact (a move, an archive) are not in this set.
const CONNECTION_CONFIGURATION_CODES = new Set([
  "binding_ambiguous", "binding_ended", "binding_started", "team_setting_missing", "team_setting_mismatch",
  "connection_foreign_club", "connection_not_usable", "connection_credential_changed", "host_not_allowed",
  "adapter_not_available", "key_missing", "credential_unreadable", "context_not_issued", "source_team_mismatch",
  "source_auth_rejected", "source_access_refused",
]);
export const isConnectionConfigurationCode = (code) => CONNECTION_CONFIGURATION_CODES.has(code);
// For the tests only (the Set itself stays private, so no importer can change
// the masking at runtime): the masked codes, and every code this module can
// put on a check row — a new code must be classified (test 4).
export const CONNECTION_CONFIGURATION_CODE_LIST = Object.freeze([...CONNECTION_CONFIGURATION_CODES]);
export const IMPORT_RESOLVE_CODES = Object.freeze(Object.keys(MESSAGES));

// Only objects this module built are accepted back by it: a caller cannot
// hand in a host, a catalog row, a source team or encrypted parts of its own.
const ISSUED = new WeakSet();
const issue = (object) => { ISSUED.add(object); return object; };
const requireIssued = (object) => { if (!object || typeof object !== "object" || !ISSUED.has(object)) throw fail("context_not_issued"); return object; };

// Test seams: the fetch the adapter uses (never a real network in tests), a
// hold right before the re-validation of a running check, and a fault in
// place of the auto-invalidation's COMMIT.
let fetchForImport = null;
export function setImportSourceFetchForTests(fetchImpl) { fetchForImport = fetchImpl ?? null; }
let revalidateHold = null;
export function setImportSourceRevalidateHoldForTests(fn) { revalidateHold = fn ?? null; }
let autoInvalidateCommitFault = null;
export function setImportSourceAutoInvalidateCommitFaultForTests(fn) { autoInvalidateCommitFault = fn ?? null; }
let autoInvalidateBoundMs = AUTO_INVALIDATE_BOUND_MS;
export function setImportSourceAutoInvalidateBoundForTests(ms) { autoInvalidateBoundMs = Number.isInteger(ms) && ms > 0 ? ms : AUTO_INVALIDATE_BOUND_MS; }

// The canonical form of a source team id, the one rule every layer shares
// (training_load.gpexe_team_id_canonical, the F3c2e bind, the Settings route):
// for gpexe a numeric id without leading zeros; another source as given.
export function canonicalSourceTeamId(sourceSystem, value) {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  if (sourceSystem === IMPORT_SOURCE_SYSTEM) return /^[0-9]{1,12}$/.test(raw) ? raw.replace(/^0+(?=[0-9])/, "") : null;
  return /^[A-Za-z0-9._:-]{1,64}$/.test(raw) ? raw : null;
}

// One SELECT, two shapes: phase 1 reads the encrypted parts (it is the only
// reader of them); phase 3 reads a fingerprint of the stored credential only
// (sha256 of its random nonce: it changes on every Connect / Reconnect and
// names nothing of the credential).
const factsSql = (withParts) => `
  select t.id as team_id, t.club_id as team_club_id, coalesce(t.is_active, true) as team_active,
         b.id as binding_id, b.connection_id, b.source_team_id, b.state as binding_state, b.source_system,
         s.gpexe_team_id as approved_source_team_id,
         c.id as connection_row_id, c.owner_scope, c.owner_club_id, c.state as connection_state, c.host_key, c.credential_kind,
         case when c.credential_nonce is null then null else encode(sha256(c.credential_nonce), 'hex') end as credential_fingerprint,
         ${withParts ? "c.credential_ciphertext, c.credential_nonce, c.credential_auth_tag, c.credential_key_version," : ""}
         coalesce(cl.is_active, true) as club_active,
         coalesce(tc.is_active, true) as team_club_active,
         exists (select 1 from training_load.source_team_bindings e where e.team_id = t.id and e.source_system = $2 and e.state <> 'active') as has_ended_binding,
         h.source_system as catalog_source_system, h.host_key as catalog_host_key, h.state as catalog_state
    from public.teams t
    left join public.clubs tc on tc.id = t.club_id
    left join training_load.source_team_bindings b on b.team_id = t.id and b.source_system = $2 and b.state = 'active'
    left join training_load.gpexe_team_settings s on s.owner_team_id = t.id
    left join training_load.source_credential_connections c on c.id = b.connection_id
    left join public.clubs cl on cl.id = c.owner_club_id
    left join training_load.source_host_catalog h on h.source_system = c.source_system and h.host_key = c.host_key
   where t.id = $1
   order by b.bound_at, b.id`;
const FACTS_SQL = factsSql(true);
const FACTS_LITE_SQL = factsSql(false);

// The one check both phases and the re-validation share. `rows` are the facts
// rows of one team (one per active binding, or one with nulls). `expected` is
// the identity a run started with; `expectLegacy` says the run is a legacy
// one and a binding may not have appeared.
function judge(rows, { teamId, sourceSystem, expected = null, expectLegacy = null }) {
  if (rows.length === 0 || rows[0].team_active !== true || rows[0].team_club_active !== true) throw fail("team_not_available", { status: 404 });
  const teamClubId = rows[0].team_club_id === null || rows[0].team_club_id === undefined ? null : String(rows[0].team_club_id);
  // Both paths pin the club the run started in: a team moved to another club
  // (possible only without a binding — v27 refuses the move of a bound team)
  // reads nothing more for either club.
  // (`undefined` means "no run yet"; a run that started with no club is
  // pinned to null, so a move INTO a club is a change too)
  const pinned = expected ? expected.teamClubId : expectLegacy ? expectLegacy.teamClubId : undefined;
  if (pinned !== undefined && pinned !== teamClubId) throw fail("team_club_changed");
  const bindings = rows.filter((r) => r.binding_id !== null);
  if (bindings.length === 0) {
    if (expected) throw fail("binding_ended", { facts: { bindingId: expected.bindingId } });
    // The legacy path is open only to a team that never had a binding for
    // this source: after an Unbind the team needs a new binding, and the
    // environment token is never read for it again.
    if (rows[0].has_ended_binding === true) throw fail("binding_ended");
    return issue({ path: PATH_LEGACY_ENV, teamId, sourceSystem, teamClubId });
  }
  if (expectLegacy) throw fail("binding_started");
  if (bindings.length > 1) throw fail("binding_ambiguous");
  const r = bindings[0];
  if (expected && (String(r.binding_id) !== String(expected.bindingId) || String(r.connection_id) !== String(expected.connectionId) || r.source_team_id !== expected.sourceTeamId)) {
    throw fail("binding_ended", { facts: { bindingId: expected.bindingId } });
  }
  if (r.source_system !== sourceSystem) throw fail("binding_ambiguous");
  const approved = canonicalSourceTeamId(sourceSystem, r.approved_source_team_id);
  const bound = canonicalSourceTeamId(sourceSystem, r.source_team_id);
  if (approved === null) throw fail("team_setting_missing");
  if (bound === null || approved !== bound) throw fail("team_setting_mismatch");
  if (r.connection_row_id === null || r.owner_scope !== "club" || String(r.owner_club_id) !== String(r.team_club_id) || r.club_active !== true) throw fail("connection_foreign_club");
  if (!USABLE_CONNECTION_STATES.includes(r.connection_state)) throw fail("connection_not_usable", { facts: { state: r.connection_state } });
  if (typeof r.credential_fingerprint !== "string" || r.credential_fingerprint.length !== 64) throw fail("credential_unreadable", { status: 503 });
  if (expected && r.credential_fingerprint !== expected.credentialFingerprint) throw fail("connection_credential_changed");
  const catalogRow = r.catalog_host_key === null ? null : { source_system: r.catalog_source_system, host_key: r.catalog_host_key, state: r.catalog_state };
  let host;
  try {
    host = resolveApprovedSourceHost(sourceSystem, r.host_key, catalogRow);
  } catch {
    throw fail("host_not_allowed");
  }
  return issue({
    path: PATH_SOURCE_CONNECTION,
    teamId,
    teamClubId,
    sourceSystem,
    bindingId: r.binding_id,
    connectionId: r.connection_id,
    sourceTeamId: bound,
    hostKey: r.host_key,
    apiFamily: host.apiFamily,
    catalogRow,
    credentialFingerprint: r.credential_fingerprint,
    // The AAD context of the stored credential (F3c1): the parts decrypt only
    // with exactly this connection's identity. Present in phase 1 only.
    credential: r.credential_ciphertext === undefined ? null : {
      context: { connectionId: r.connection_id, ownerScope: r.owner_scope, ownerClubId: r.owner_club_id, ownerTeamId: null, sourceSystem, hostKey: r.host_key, credentialKind: r.credential_kind },
      parts: { ciphertext: r.credential_ciphertext, nonce: r.credential_nonce, authTag: r.credential_auth_tag, keyVersion: r.credential_key_version },
      kind: r.credential_kind,
    },
  });
}

function checkArguments(teamId, sourceSystem) {
  if (typeof teamId !== "string" || !UUID.test(teamId)) throw fail("team_not_available", { status: 404 });
  if (typeof sourceSystem !== "string" || !SOURCE_SYSTEM.test(sourceSystem)) throw fail("binding_ambiguous");
}

// Phase 1 — inside the caller's transaction (the team import lock held):
// the facts, no decrypt, no network. Returns { path: "legacy_env" } or the
// closed facts of the binding path.
export async function resolveImportSourceFacts(executor, { teamId, sourceSystem = IMPORT_SOURCE_SYSTEM } = {}) {
  checkArguments(teamId, sourceSystem);
  const rows = (await executor.query(FACTS_SQL, [teamId, sourceSystem])).rows;
  return judge(rows, { teamId, sourceSystem });
}

// What a caller may compare two resolutions by (an unlocked pre-read against
// the locked read): the path and the binding identity, the credential's
// fingerprint included — nothing secret.
export function importSourceIdentity(facts) {
  if (!facts || facts.path !== PATH_SOURCE_CONNECTION) return { path: PATH_LEGACY_ENV };
  return { path: PATH_SOURCE_CONNECTION, bindingId: String(facts.bindingId), connectionId: String(facts.connectionId), sourceTeamId: facts.sourceTeamId, credentialFingerprint: facts.credentialFingerprint };
}

export function sameImportSource(a, b) {
  const x = importSourceIdentity(a);
  const y = importSourceIdentity(b);
  return x.path === y.path && x.bindingId === y.bindingId && x.connectionId === y.connectionId && x.sourceTeamId === y.sourceTeamId && x.credentialFingerprint === y.credentialFingerprint;
}

// Before any check row exists: the key ring is readable and holds the
// credential's key version. No decrypt — the plaintext is materialised once,
// in openImportSource, right before the first request.
export function preflightImportSource(facts) {
  requireIssued(facts);
  if (facts.path !== PATH_SOURCE_CONNECTION) return;
  let keyring;
  try {
    keyring = keyringFromEnv();
  } catch {
    throw fail("key_missing", { status: 503 });
  }
  const version = facts.credential?.parts?.keyVersion;
  if (!Number.isInteger(version) || !keyring.keys.has(version)) throw fail("key_missing", { status: 503 });
}

// Phase 2 — after COMMIT, right before the first request: the key ring, the
// decrypt, the adapter bound to the binding's source team on the approved
// host. The plaintext lives in this function's scope and in the adapter's
// closure only; the reference here is dropped in `finally`. The facts object
// loses its encrypted parts too: a run keeps only the ids it needs. Every
// response the adapter receives can report progress to the run (a heartbeat
// per request, as the legacy client gives), through setRequestProgress.
export function openImportSource(facts, { fetchImpl = fetchForImport ?? globalThis.fetch, timeoutMs = 90_000 } = {}) {
  requireIssued(facts);
  if (facts.path !== PATH_SOURCE_CONNECTION || !facts.credential) throw fail("binding_ambiguous");
  let keyring;
  try {
    keyring = keyringFromEnv();
  } catch {
    throw fail("key_missing", { status: 503 });
  }
  if (typeof fetchImpl !== "function") throw fail("adapter_not_available");
  const progress = { fn: null };
  const trackedFetch = async (url, init) => {
    const res = await fetchImpl(url, init);
    if (progress.fn) { try { await progress.fn(); } catch { /* the run's own throwing heartbeat decides */ } }
    return res;
  };
  let token = null;
  try {
    try {
      token = decryptCredential(facts.credential.parts, facts.credential.context, keyring);
    } catch (error) {
      throw fail(error?.code === "key_version_unknown" ? "key_missing" : "credential_unreadable", { status: 503 });
    }
    let adapter;
    try {
      adapter = createSourceAdapter({ sourceSystem: facts.sourceSystem, hostKey: facts.hostKey, catalogRow: facts.catalogRow, credential: token, boundSourceTeamId: facts.sourceTeamId, fetchImpl: trackedFetch, timeoutMs, attempts: 1 });
    } catch (error) {
      if (error?.code === "adapter_not_available") throw fail("adapter_not_available");
      if (error?.code === "host_not_allowed" || error?.code === "path_not_allowed") throw fail("host_not_allowed");
      if (error?.code === "credential_missing" || error?.code === "invalid_bound_team" || error?.code === "invalid_options") throw fail("credential_unreadable", { status: 503 });
      throw error;
    }
    return issue({
      path: PATH_SOURCE_CONNECTION,
      teamId: facts.teamId,
      teamClubId: facts.teamClubId,
      sourceSystem: facts.sourceSystem,
      connectionId: facts.connectionId,
      bindingId: facts.bindingId,
      sourceTeamId: facts.sourceTeamId,
      hostKey: facts.hostKey,
      apiFamily: facts.apiFamily,
      credentialFingerprint: facts.credentialFingerprint,
      adapter,
      setRequestProgress(fn) { progress.fn = typeof fn === "function" ? fn : null; },
    });
  } finally {
    token = null;
    keyring = null;
    if (facts.credential) { facts.credential.parts = null; facts.credential = null; }
  }
}

// Phase 3 — during a run, before every source operation, without a lock: the
// same facts again, against the identity the run started with. Anything that
// moved stops the run with its precise code (binding_ended,
// connection_not_usable, connection_credential_changed, host_not_allowed,
// team_setting_*, connection_foreign_club, team_not_available).
export async function assertImportSourceStillUsable(source, executor = pool) {
  requireIssued(source);
  if (source.path !== PATH_SOURCE_CONNECTION) return;
  if (revalidateHold) await revalidateHold();
  const rows = (await executor.query(FACTS_LITE_SQL, [source.teamId, source.sourceSystem])).rows;
  judge(rows, { teamId: source.teamId, sourceSystem: source.sourceSystem, expected: { bindingId: source.bindingId, connectionId: source.connectionId, sourceTeamId: source.sourceTeamId, credentialFingerprint: source.credentialFingerprint, teamClubId: source.teamClubId } });
}

// The legacy path's re-validation: a team that reads through the environment
// token must still have no binding before every operation (binding_started
// otherwise), and must still be available.
export async function assertLegacyPathStillOpen(legacy, executor = pool) {
  requireIssued(legacy);
  if (legacy.path !== PATH_LEGACY_ENV) throw fail("binding_ambiguous");
  if (revalidateHold) await revalidateHold();
  const rows = (await executor.query(FACTS_LITE_SQL, [legacy.teamId, legacy.sourceSystem])).rows;
  judge(rows, { teamId: legacy.teamId, sourceSystem: legacy.sourceSystem, expectLegacy: { teamClubId: legacy.teamClubId } });
}

function withinBound(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A refused credential (401) during an import read: the connection becomes
// needs_reconnect with one `auto_invalidate` audit row — basis `system`, no
// user, the one actor the v27 CHECK allows for that action. Its own short,
// bounded transaction, also bounded on the client side; the caller writes
// the check's own outcome BEFORE calling this, so nothing here can change
// it: a failure is logged by code only. Idempotent, and conditional on the
// credential the run held (its fingerprint): a connection already out of
// `verified`, or reconnected meanwhile, is left as it is (no second row).
// Which read refused the credential, as the audit row's `trigger` fact: an
// import's check run or an administrator's identity load.
const AUTO_INVALIDATE_TRIGGERS = new Set(["import_read", "identity_read"]);
export async function autoInvalidateImportSource(source, { errorCode = "source_auth_rejected", trigger = "import_read" } = {}) {
  if (!source || !ISSUED.has(source) || source.path !== PATH_SOURCE_CONNECTION) return false;
  if (!AUTO_INVALIDATE_TRIGGERS.has(trigger)) return false;
  let client = null;
  let dead = false;
  let commitSent = false;
  // A checked-out client may be ended by the server (idle_in_transaction
  // timeout, a pooler reset) while nothing is awaited on it; without a
  // listener that event would crash the process.
  const onClientError = () => {};
  try {
    // A checkout that arrives after the bound is released at once: a bound
    // around pool.connect() must never leave a client nobody holds (the
    // late-release pattern of auditRowIsCommitted / the approval check).
    const connecting = pool.connect();
    let abandoned = false;
    connecting.then((late) => { if (abandoned) late.release(); }, () => {});
    try {
      client = await withinBound(connecting, autoInvalidateBoundMs);
    } catch (error) {
      abandoned = true;
      throw error;
    }
    client.on("error", onClientError);
    await client.query("begin isolation level read committed");
    await client.query(`set local lock_timeout = '${ROW_LOCK_TIMEOUT_MS}ms'`);
    await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await client.query(`set local idle_in_transaction_session_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    const moved = await client.query(
      `update training_load.source_credential_connections
          set state = 'needs_reconnect', last_error_code = $2, last_error_at = now(), updated_at = now(), updated_by_user_id = null
        where id = $1 and state = 'verified' and encode(sha256(credential_nonce), 'hex') = $3
        returning host_key, credential_kind`,
      [source.connectionId, errorCode, source.credentialFingerprint],
    );
    if (moved.rowCount === 1) {
      await client.query(
        `insert into training_load.source_connection_audit (connection_id, team_id, action, outcome, error_code, performed_by_user_id, basis, metadata)
         values ($1, $2, 'auto_invalidate', 'ok', $3, null, 'system', $4::jsonb)`,
        [source.connectionId, source.teamId, errorCode, JSON.stringify({ host_key: moved.rows[0].host_key, credential_kind: moved.rows[0].credential_kind, binding_id: String(source.bindingId), source_team_id: source.sourceTeamId, trigger })],
      );
    }
    commitSent = true;
    const commit = autoInvalidateCommitFault ? autoInvalidateCommitFault(client) : client.query("commit");
    commit.catch(() => {});
    await withinBound(commit, autoInvalidateBoundMs);
    return moved.rowCount === 1;
  } catch (error) {
    dead = true;
    if (client && !commitSent) {
      const rollback = client.query("rollback");
      rollback.catch(() => {});
      await withinBound(rollback, 5_000).then(() => { dead = false; }, () => {});
    }
    console.error(`[gpexe] the source connection of a refused import read ${commitSent ? "may or may not have been invalidated (the COMMIT was not confirmed)" : "could not be invalidated"}: ${error?.code ?? error?.name ?? ""}`);
    return false;
  } finally {
    if (client) { client.removeListener("error", onClientError); client.release(dead ? true : undefined); }
  }
}

// The importer reads through the same two operations whatever the path. For
// the binding path they are the adapter's reads, with the re-validation
// before each, the bound team enforced, and the drill rules of the owner
// (2026-10-03): an incomplete drill set stops the run before the session is
// recorded; an empty, successfully read `players` is a valid empty drill. The
// adapter's extra fields (`drillsStatus`, `drillLabels`) are stripped so the
// stored snapshot keeps the F1 bundle contract.
export function importClientFor(source) {
  requireIssued(source);
  if (source.path !== PATH_SOURCE_CONNECTION) throw fail("binding_ambiguous");
  const { adapter } = source;
  const sameTeam = (gpexeTeamId) => {
    if (canonicalSourceTeamId(source.sourceSystem, gpexeTeamId) !== source.sourceTeamId) throw fail("source_team_mismatch");
  };
  return Object.freeze({
    path: PATH_SOURCE_CONNECTION,
    async listTeamSessions({ gpexeTeamId, fromDay, toDay, onProgress = null } = {}) {
      sameTeam(gpexeTeamId);
      await assertImportSourceStillUsable(source);
      // The facts are re-checked between the adapter's two complete reads of
      // the list too, so the second read is never sent after an Unbind, a
      // Reconnect or a state change during the first.
      const result = await adapter.listSessionsByDay({ fromDay, toDay, beforeSecondRead: () => assertImportSourceStillUsable(source) });
      if (onProgress) await onProgress();
      // A list — empty or not — is returned only when the facts still hold
      // after the read: a binding that ended or a credential replaced while
      // the list was in flight ends the run here, before any session.
      await assertImportSourceStillUsable(source);
      return result.sessions.map((s) => ({ ...s }));
    },
    async fetchSessionBundle({ gpexeTeamId, sessionId, onProgress = null } = {}) {
      sameTeam(gpexeTeamId);
      await assertImportSourceStillUsable(source);
      const bundle = await adapter.fetchSessionBundle({ sessionId });
      if (onProgress) await onProgress();
      // The re-validation window is one bundle (the adapter's dependent reads
      // of one session); a bundle read across the end of its binding, a
      // Reconnect or a state change is dropped here, before it is recorded.
      await assertImportSourceStillUsable(source);
      const { drillsStatus, drillLabels, ...stored } = bundle;
      void drillLabels;
      if (!drillsStatus || drillsStatus.complete !== true) {
        // A drill refused for a metric's shape carries the adapter's sanitized
        // description (fixed words and buckets only, at most 900 characters);
        // the check row shows it to an administrator after DIAGNOSTIC_MARK.
        const failed = drillsStatus?.failed ?? null;
        const failedIndex = Number.isInteger(failed?.drillIndex) ? failed.drillIndex : null;
        const facts = { sessionId: String(sessionId), failedIndex };
        if (failed && typeof failed.diagnosticText === "string" && failed.diagnosticText && failedIndex !== null) {
          const failedCode = /^[a-z_]{1,64}$/.test(String(failed.code ?? "")) ? failed.code : "source_answer_unexpected";
          throw new SourceImportResolveError("drill_set_incomplete", `${MESSAGES.drill_set_incomplete}${DIAGNOSTIC_MARK}drill_index=${failedIndex}; drill_code=${failedCode}; ${failed.diagnosticText.slice(0, 900)}`, { facts });
        }
        throw fail("drill_set_incomplete", { facts });
      }
      return stored;
    },
  });
}

// An administrator's identity load (owner order 2026-10-06) reads through the
// same opened source: one athlete record at a time, only for an id of the set
// the caller derived server-side from the stored, successful checks of this
// binding (frozen here; any other id is refused before a request), with the
// facts re-validated before every read. The caller re-validates once more
// after the last read and again, under locks, before it writes.
export const IDENTITY_IDS_MAX = 50;
export function identityReaderFor(source, athleteIds) {
  requireIssued(source);
  if (source.path !== PATH_SOURCE_CONNECTION) throw fail("binding_ambiguous");
  if (!Array.isArray(athleteIds) || athleteIds.length > IDENTITY_IDS_MAX || athleteIds.some((id) => typeof id !== "string" || !/^(0|[1-9][0-9]{0,11})$/.test(id))) throw fail("context_not_issued");
  const allowed = new Set(athleteIds);
  const { adapter } = source;
  return Object.freeze({
    async readAthleteIdentity(athleteId) {
      if (!allowed.has(athleteId)) throw fail("context_not_issued");
      await assertImportSourceStillUsable(source);
      return adapter.readAthleteIdentity({ athleteId });
    },
    async assertStillUsable() {
      await assertImportSourceStillUsable(source);
    },
  });
}

// The legacy path, wrapped the same way: the existing environment-token client
// runs only while the team still has no binding, checked before every
// operation; the client's own behaviour (its heartbeat per request, its
// errors) is unchanged.
export function legacyImportClientFor(legacy, client) {
  requireIssued(legacy);
  if (legacy.path !== PATH_LEGACY_ENV) throw fail("binding_ambiguous");
  if (!client || typeof client.listTeamSessions !== "function" || typeof client.fetchSessionBundle !== "function") throw fail("adapter_not_available");
  return Object.freeze({
    path: PATH_LEGACY_ENV,
    async listTeamSessions(options) {
      await assertLegacyPathStillOpen(legacy);
      const sessions = await client.listTeamSessions(options);
      // Empty or not, the list is returned only when the team still has no
      // binding and is still the same active team of the same club.
      await assertLegacyPathStillOpen(legacy);
      return sessions;
    },
    async fetchSessionBundle(options) {
      await assertLegacyPathStillOpen(legacy);
      const bundle = await client.fetchSessionBundle(options);
      // The same one-bundle window as the binding path: a bundle read across
      // the appearance of a binding is dropped before it is recorded.
      await assertLegacyPathStillOpen(legacy);
      return bundle;
    },
  });
}

// Named here so the importer's catch block and the tests share one bound.
export { withinBound as boundImportSideEffect };
export const credentialFingerprintOf = (nonce) => (Buffer.isBuffer(nonce) ? crypto.createHash("sha256").update(nonce).digest("hex") : null);
