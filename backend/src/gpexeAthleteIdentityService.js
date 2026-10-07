// GPEXE athlete identity: an administrator's explicit, read-only load of the
// name and date of birth of a team's GPEXE athletes (owner order 2026-10-06).
// Discovery: docs/ai/gpexe-athlete-identity-discovery.md. Source and field
// rules: docs/ai/gpexe-rest-v1-compatibility.md section 4b. Schema: v32.
//
// Boundaries, each one tested (backend/tests/gpexe-athlete-identity.test.mjs):
//   * only a platform admin (platform workspace or the team's club workspace)
//     or the active admin of the team's club (that club's workspace); the
//     right is read live on every request and FOR SHARE before the write;
//     everyone and everything else — a coach, another club, a team workspace,
//     an archived team or club, a team without an active binding — gets the
//     router's identical 404;
//   * never during a check: only POST …/athlete-identities/loads reads GPEXE;
//   * the client sends a requestKey and nothing else. The athlete ids come
//     from the stored candidates of the team that a SUCCEEDED check read
//     through the team's CURRENT active binding — never from the client;
//   * at most 50 athletes per load, at most 3 requests at once, one GET per
//     athlete (rest/v1/athlete/<id>/), no retry, no redirect, no other host,
//     family or token than the binding's (the F3c2g resolver), a per-request
//     timeout and a total network budget that keeps the HTTP answer under
//     the client's bound;
//   * every answer must name the id asked for; the facts of the binding (the
//     binding, the connection's state and club, the host, the credential's
//     fingerprint, the team's club) are re-validated before every read, after
//     the last one, and under FOR SHARE locks before the write; a 401 moves
//     the connection to needs_reconnect through the existing auto-invalidate
//     path, a 403 changes nothing of the credential;
//   * one load at a time per team (a partial unique index), idempotent by
//     requestKey (a replay answers the saved counts; a running or lost load is
//     never re-run under the same key); the bounded COMMIT with the
//     verified-after-commit / outcome_unknown answers of F2;
//   * the snapshot holds the sanitized display name, the normalized date of
//     birth, the provenance and observed_at / expires_at = observed_at + 14
//     days; a valid row is reused and never extended; an expired row is never
//     shown or used and is deleted by the purge;
//   * no name, date or athlete id in a log line, an audit row, an error, a
//     URL or the load's answer (counts only).
import { isPoolCheckoutTimeout, pool } from "./db.js";
import { holdsClubAdminRole } from "./authz.js";
import {
  IMPORT_SOURCE_SYSTEM, PATH_SOURCE_CONNECTION, SourceAdapterError, SourceImportResolveError,
  assertImportSourceStillUsable, autoInvalidateImportSource, boundImportSideEffect as withinBound,
  identityReaderFor, openImportSource, preflightImportSource, resolveImportSourceFacts,
} from "./sourceImportCredentialResolver.js";

export const IDENTITY_TTL_DAYS = 14;
// A GPEXE 404 leaves the athlete out of the next loads' choice for exactly
// this long (owner decision 2026-10-07): never an identity, never extended.
export const IDENTITY_NOT_FOUND_RETRY_HOURS = 24;
export const IDENTITY_MAX_PER_LOAD = 50;
export const IDENTITY_CONCURRENCY = 3;
export const IDENTITY_REQUEST_TIMEOUT_MS = 15_000;
// The whole network part of one load. With the database steps (statement
// timeouts of 10 s, the bounded COMMIT of 15 s and its 5 s check) the answer
// stays below the client's 90 s bound (frontend/gpexe-import-data.js).
export const IDENTITY_NETWORK_BUDGET_MS = 45_000;
export const IDENTITY_STATEMENT_TIMEOUT_MS = 10_000;
export const IDENTITY_ROW_LOCK_TIMEOUT_MS = 2_000;
export const IDENTITY_COMMIT_BOUND_MS = 15_000;
export const IDENTITY_VERIFY_BOUND_MS = 5_000;
// A running load older than this cannot still be working (every step above is
// bounded); the next load or a replay of its key closes it as abandoned.
export const IDENTITY_STALE_AFTER_SECONDS = 180;
const ATHLETE_ID_PATTERN = "^(0|[1-9][0-9]{0,11})$";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GpexeIdentityError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "GpexeIdentityError";
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

// One stable sentence per code; never a value, a name, a date or an id.
const MESSAGES = Object.freeze({
  invalid_body: "The body is { requestKey } with a UUID chosen by the client for this one load.",
  request_key_reused: "This requestKey was already used for another team; use a new key.",
  identity_load_running: "A load of GPEXE names is running for this team, possibly started by another administrator, or the result of this request is not settled yet. Nothing was started twice.",
  identity_load_abandoned: "That load did not finish and saved nothing. Start a new load.",
  try_again: "OptiMove is busy with this team's source connection (a search, an import or a connection change). Try again in a moment; nothing was saved.",
  outcome_unknown: "The database did not confirm the load, and it could not be verified yet. Check the result with the same request; do not start a new load.",
  source_auth_rejected: "GPEXE refused the connection's credential; nothing was saved. The connection now needs a reconnect in Settings > Source connections.",
  source_access_refused: "GPEXE does not allow this connection to read athletes; nothing was saved.",
  source_identity_mismatch: "GPEXE answered for another athlete than the one asked; nothing was saved.",
  source_unavailable: "GPEXE did not answer; nothing was saved.",
  source_answer_unexpected: "GPEXE answered in an unexpected way; nothing was saved.",
  network_budget_exhausted: "GPEXE did not answer in time; nothing was saved.",
  internal_error: "The load could not be completed; nothing was saved.",
});
const STATUS = Object.freeze({
  invalid_body: 400, request_key_reused: 409, identity_load_running: 409, identity_load_abandoned: 409, try_again: 409,
  outcome_unknown: 503, source_auth_rejected: 409, source_access_refused: 409, source_identity_mismatch: 502,
  source_unavailable: 502, source_answer_unexpected: 502, network_budget_exhausted: 502, internal_error: 500,
  key_missing: 503, credential_unreadable: 503,
});
const refusal = (code, details) => new GpexeIdentityError(STATUS[code] ?? 409, code, MESSAGES[code] ?? "The team's source connection cannot be used right now; nothing was read.", details);
const notAvailable = () => new GpexeIdentityError(404, "notFound", "notFound");

// ---------------------------------------------------------------------------
// Test seams (never set by the application).
// ---------------------------------------------------------------------------
let fetchForIdentity = null;
let timing = null;
let finalizeHold = null;
let commitFault = null;
let verifyFault = null;
let insertFault = null;
let listHold = null;
export function setIdentityFetchForTests(fn) { fetchForIdentity = fn ?? null; }
export function setIdentityTimingForTests(t) { timing = t ?? null; }
// Runs inside the write transaction after every lock and check, right before
// the snapshot rows are written: a test races an Unbind or an archive there.
export function setIdentityFinalizeHoldForTests(fn) { finalizeHold = fn ?? null; }
export function setIdentityCommitFaultForTests(fn) { commitFault = fn ?? null; }
export function setIdentityVerifyFaultForTests(fn) { verifyFault = fn ?? null; }
export function setIdentityInsertFaultForTests(fn) { insertFault = fn ?? null; }
// The identity read: called with "before" after the route's own check and
// before the read transaction, and with "locked" once every lock is held and
// before the first identity row is read. Tests race a revocation there.
export function setIdentityListHoldForTests(fn) { listHold = fn ?? null; }
const t = (key, value) => (timing && Number.isInteger(timing[key]) ? timing[key] : value);

function guardClient(client) {
  const onClientError = () => {};
  client.on("error", onClientError);
  return (destroy = false) => {
    client.removeListener("error", onClientError);
    client.release(destroy ? true : undefined);
  };
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------
// From the router's resolved team access (the team is active and in the
// caller's workspace): the basis of the identity right, or null. A platform
// admin in the platform workspace or the team's club workspace; otherwise the
// team's club admin in that club's workspace. A team workspace never.
export function identityAdminBasis(req, access) {
  if (!access || !access.clubId) return null;
  const ws = access.workspace || {};
  const inClub = ws.type === "club" && String(ws.scopeId) === String(access.clubId);
  if (access.platformAdmin && (ws.type === "platform" || inClub)) return "platform_admin";
  if (inClub && holdsClubAdminRole(req.authz, access.clubId)) return "club_admin";
  return null;
}

// The right, read live (and FOR SHARE inside a write transaction): an active
// user with an active platform_admin role, or an active club_admin role of the
// team's club; and the club itself active.
async function rightHolds(executor, ctx, clubId, { lock = false } = {}) {
  const share = lock ? " for share of r, u" : "";
  const right = ctx.basis === "platform_admin"
    ? await executor.query(`select 1 from public.user_global_roles r join public.users u on u.id = r.user_id where r.user_id = $1 and r.role = 'platform_admin' and r.is_active = true and u.is_active = true${share}`, [ctx.userId])
    : await executor.query(`select 1 from public.user_club_roles r join public.users u on u.id = r.user_id where r.user_id = $1 and r.club_id = $2 and r.role = 'club_admin' and r.is_active = true and u.is_active = true${share}`, [ctx.userId, clubId]);
  const club = await executor.query(`select 1 from public.clubs where id = $1 and coalesce(is_active, true)${lock ? " for share" : ""}`, [clubId]);
  return right.rowCount > 0 && club.rowCount > 0;
}

// The team's active gpexe binding with an active team and club, or null.
async function activeBinding(executor, teamId) {
  return (await executor.query(
    `select b.id, b.connection_id, b.source_team_id, t.club_id
       from training_load.source_team_bindings b
       join public.teams t on t.id = b.team_id and coalesce(t.is_active, true)
       join public.clubs c on c.id = t.club_id and coalesce(c.is_active, true)
      where b.team_id = $1 and b.source_system = $2 and b.state = 'active'`,
    [teamId, IMPORT_SOURCE_SYSTEM],
  )).rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// The athletes a load may read: derived on the server only.
// ---------------------------------------------------------------------------
// The canonical GPEXE athlete ids of the team's available candidates (not
// purged, not expired, with a preview) that a SUCCEEDED check read through
// THIS binding (first or last seen), newest session first.
const ELIGIBLE_SQL = `
  select a.entry->>'gpexeAthleteId' as gpexe_athlete_id, max(c.session_started_at) as last_seen
    from training_load.gpexe_import_candidates c
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(c.preview->'athletes') = 'array' then c.preview->'athletes' else '[]'::jsonb end
    ) as a(entry)
   where c.owner_team_id = $1
     and c.raw_purged_at is null and c.raw_expires_at > now() and c.preview is not null
     and exists (
       select 1 from training_load.gpexe_import_checks k
        where k.id in (c.first_seen_check_id, c.last_seen_check_id)
          and k.owner_team_id = $1 and k.status = 'succeeded'
          and k.source_path = 'source_connection' and k.source_binding_id = $2
     )
     and a.entry->>'gpexeAthleteId' ~ $3
   group by 1`;

// Pending: eligible, without a valid identity, and not inside an active
// 24-hour retry suppression of a GPEXE 404 (those are counted apart, so a
// run of 404s at the front of the order cannot starve the athletes behind it).
async function eligibleAthletes(executor, teamId, bindingId) {
  const rows = (await executor.query(
    `with eligible as (${ELIGIBLE_SQL})
     select e.gpexe_athlete_id,
            exists (select 1 from training_load.gpexe_athlete_identities i
                     where i.binding_id = $2 and i.gpexe_athlete_id = e.gpexe_athlete_id and i.expires_at > now()) as has_identity,
            exists (select 1 from training_load.gpexe_athlete_identity_suppressions s
                     where s.binding_id = $2 and s.gpexe_athlete_id = e.gpexe_athlete_id and s.retry_after > now()) as suppressed
       from eligible e
      order by e.last_seen desc nulls last, length(e.gpexe_athlete_id), e.gpexe_athlete_id`,
    [teamId, bindingId, ATHLETE_ID_PATTERN],
  )).rows;
  const pending = rows.filter((r) => !r.has_identity && !r.suppressed).map((r) => r.gpexe_athlete_id);
  const retryLater = rows.filter((r) => !r.has_identity && r.suppressed).length;
  return { eligible: rows.length, pending, retryLater };
}

// Best effort, any caller: one bounded batch of expired rows. The readers
// never depend on it (they filter on expires_at).
export async function purgeExpiredIdentities(limit = 200) {
  const r = await pool.query(`select training_load.purge_expired_gpexe_athlete_identities($1) as n`, [limit])
    .catch((error) => ({ error }));
  // Its own call: a failure of the identity purge never keeps expired
  // suppressions, and the other way round.
  await pool.query(`select training_load.purge_expired_gpexe_athlete_identity_suppressions($1) as n`, [limit])
    .catch((error) => console.error(`[gpexe-identity] suppression purge failed: ${error?.code ?? ""}`));
  if (r.error) throw r.error;
  return r.rows[0].n;
}

// ---------------------------------------------------------------------------
// Read: what an administrator sees on Link athletes.
// ---------------------------------------------------------------------------
// The right and the data are read in ONE bounded transaction (external review
// of PR #144, HIGH): the binding, the connection, the team, the caller's role
// and user rows and the club are locked FOR SHARE in the write path's order
// (connection -> binding -> team -> right and club) before a single identity
// row is read, and stay locked until the answer is assembled. A revocation,
// an archive or an Unbind that commits before these locks is seen here and
// answers the same 404 as no right at all; one that comes later waits for
// this read to finish. Fail-closed: anything unexpected is no answer.
// Lock order (fixed, shared with finalize and the v32 insert trigger): the
// connection, the binding, the team, then the caller's role and user rows,
// then the club. A future club-archive cascade must lock the teams before the
// club, or it would invert this order (bounded by lock_timeout, never a leak).
export async function listIdentities(teamId, ctx, { expectedClubId = null } = {}) {
  if (listHold) await listHold("before");
  // Readers never show an expired row; deleting it first keeps the physical
  // deletion close to the expiry on a quiet server (DB review M3).
  await purgeExpiredIdentities().catch((error) => console.error(`[gpexe-identity] purge before a read failed: ${error?.code ?? ""}`));
  const client = await pool.connect();
  const release = guardClient(client);
  let released = false;
  try {
    await client.query("begin isolation level read committed");
    await client.query(`set local statement_timeout = '${t("statementTimeout", IDENTITY_STATEMENT_TIMEOUT_MS)}ms'`);
    await client.query(`set local lock_timeout = '${IDENTITY_ROW_LOCK_TIMEOUT_MS}ms'`);
    await client.query(`set local idle_in_transaction_session_timeout = '${IDENTITY_STATEMENT_TIMEOUT_MS * 3}ms'`);
    // Which connection to lock first: the team's active binding, unlocked.
    const pre = (await client.query(
      `select id, connection_id from training_load.source_team_bindings where team_id = $1 and source_system = $2 and state = 'active'`,
      [teamId, IMPORT_SOURCE_SYSTEM],
    )).rows[0];
    if (!pre) return closeNull();
    const conn = (await client.query(`select id, owner_club_id from training_load.source_credential_connections where id = $1 for share`, [pre.connection_id])).rows[0];
    const binding = (await client.query(`select id, team_id, state, source_system from training_load.source_team_bindings where id = $1 for share`, [pre.id])).rows[0];
    const team = (await client.query(`select id, club_id, coalesce(is_active, true) as active from public.teams where id = $1 for share`, [teamId])).rows[0];
    if (!conn || !binding || binding.state !== "active" || binding.source_system !== IMPORT_SOURCE_SYSTEM || String(binding.team_id) !== String(teamId)
      || !team || team.active !== true || !team.club_id || String(conn.owner_club_id) !== String(team.club_id)
      // The club the route resolved the caller's workspace for must still be
      // the team's club under the lock (a team moved meanwhile reads nothing).
      || (expectedClubId && String(team.club_id) !== String(expectedClubId))) return closeNull();
    if (!(await rightHolds(client, ctx, team.club_id, { lock: true }))) return closeNull();
    if (listHold) await listHold("locked", client);
    const identities = (await client.query(
      `select gpexe_athlete_id, display_name, to_char(birth_date, 'YYYY-MM-DD') as birth_date
         from training_load.gpexe_athlete_identities
        where binding_id = $1 and owner_team_id = $2 and expires_at > now()
        order by length(gpexe_athlete_id), gpexe_athlete_id`,
      [binding.id, teamId],
    )).rows;
    const { pending, retryLater } = await eligibleAthletes(client, teamId, binding.id);
    // A known GPEXE date of birth that differs from the date of birth OptiMove
    // holds: only the pair is returned (for a warning when that pair is
    // chosen), never OptiMove's date itself, and only for the pairs the screen
    // can stage - a GPEXE athlete without an active link and an active athlete
    // of the team without one (owner decision: the mismatch boolean is
    // allowed for these two administrators).
    const conflicts = (await client.query(
      `select i.gpexe_athlete_id, a.id as athlete_id
         from training_load.gpexe_athlete_identities i
         join public.athlete_memberships m on m.team_id = i.owner_team_id and m.membership_type = 'team' and m.status = 'active'
         join public.athletes a on a.id = m.athlete_id
        where i.binding_id = $1 and i.expires_at > now()
          and i.birth_date is not null and a.birth_date is not null and a.birth_date <> i.birth_date
          and not exists (select 1 from training_load.gpexe_athlete_links l
                           where l.owner_team_id = i.owner_team_id and l.unlinked_at is null
                             and (l.gpexe_athlete_id = i.gpexe_athlete_id or l.athlete_id = a.id))`,
      [binding.id],
    )).rows;
    const answer = {
      identities: identities.map((r) => ({ gpexeAthleteId: r.gpexe_athlete_id, name: r.display_name, birthDate: r.birth_date })),
      pendingCount: pending.length,
      // Athletes GPEXE had no record for within the last 24 hours: a count
      // only, never an identity, a name, a date or an id.
      retryLaterCount: retryLater,
      maxPerLoad: IDENTITY_MAX_PER_LOAD,
      retentionDays: IDENTITY_TTL_DAYS,
      birthDateConflicts: conflicts.map((r) => ({ gpexeAthleteId: r.gpexe_athlete_id, athleteId: r.athlete_id })),
    };
    // The answer is complete while every lock is still held; only then is
    // the read transaction ended.
    await client.query("commit");
    released = true;
    release();
    return answer;
  } catch (error) {
    if (!released) {
      let dead = false;
      await withinBound(client.query("rollback"), 5_000).catch(() => { dead = true; });
      released = true;
      release(dead);
    }
    if (error?.code === "55P03" || error?.code === "40P01" || error?.code === "57014") throw refusal("try_again");
    console.error(`[gpexe-identity] a read failed: ${error?.code ?? error?.name ?? ""}`);
    throw refusal("internal_error");
  }

  async function closeNull() {
    released = true;
    let dead = false;
    await withinBound(client.query("rollback"), 5_000).catch(() => { dead = true; });
    release(dead);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
function readBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw refusal("invalid_body");
  for (const key of Object.keys(body)) if (key !== "requestKey") throw refusal("invalid_body");
  if (typeof body.requestKey !== "string" || !UUID.test(body.requestKey)) throw refusal("invalid_body");
  return body.requestKey.toLowerCase();
}

function resultOf(row, { replayed, unrecognised = null }) {
  return {
    requestKey: row.request_key,
    outcome: row.error_code ? "partial" : "completed",
    loaded: row.loaded ?? 0,
    notFound: row.not_found ?? 0,
    notRead: row.not_read ?? 0,
    stopCode: row.error_code ?? null,
    // Counted in this answer only; never stored, so a replay cannot give it.
    unrecognisedBirthDates: unrecognised,
    retentionDays: IDENTITY_TTL_DAYS,
    replayed,
  };
}

const REQUEST_COLUMNS = "id, owner_team_id, binding_id, request_key, status, loaded, not_found, not_read, error_code, (started_at < now() - make_interval(secs => $3)) as stale";

async function closeIfStale(executor, requestId) {
  await executor.query(
    `update training_load.gpexe_athlete_identity_requests set status = 'failed', finished_at = now(), error_code = 'abandoned'
      where id = $1 and status = 'running' and started_at < now() - make_interval(secs => $2)`,
    [requestId, t("staleSeconds", IDENTITY_STALE_AFTER_SECONDS)],
  );
}

// A replay of the caller's own earlier load: its saved answer, after the
// right was checked again by the route and here.
async function replay(row, teamId, ctx, clubId, bindingId) {
  // The same key belongs to one team and one binding: after an Unbind and a
  // new binding an old key answers nothing of the old one.
  if (String(row.owner_team_id) !== String(teamId) || (bindingId && String(row.binding_id) !== String(bindingId))) throw refusal("request_key_reused");
  if (!(await rightHolds(pool, ctx, clubId))) throw notAvailable();
  if (row.status === "running" && row.stale) {
    await closeIfStale(pool, row.id);
    throw refusal("identity_load_abandoned", { replayed: true });
  }
  if (row.status === "running") throw refusal("identity_load_running", { replayed: true });
  if (row.status === "failed") {
    if (row.error_code === "abandoned") throw refusal("identity_load_abandoned", { replayed: true });
    throw refusal(STATUS[row.error_code] ? row.error_code : "internal_error", { replayed: true });
  }
  return resultOf(row, { replayed: true });
}

async function findRequest(executor, ctx, requestKey) {
  return (await executor.query(
    `select ${REQUEST_COLUMNS}, binding_id from training_load.gpexe_athlete_identity_requests where requested_by_user_id = $1 and request_key = $2`,
    [ctx.userId, requestKey, t("staleSeconds", IDENTITY_STALE_AFTER_SECONDS)],
  )).rows[0] ?? null;
}

function mapResolveError(error) {
  if (!(error instanceof SourceImportResolveError)) return null;
  if (error.code === "team_not_available" || error.code === "binding_ended") return notAvailable();
  return new GpexeIdentityError(error.status === 503 ? 503 : 409, "source_connection_unavailable", "The team's source connection cannot be used right now; nothing was read.", { reason: error.code });
}

// Marks a load failed in its own short, bounded transaction (never with a
// value; the code is a stable word). Best effort: a failure is logged by code.
async function markFailed(requestId, code) {
  try {
    // A checkout that arrives after the bound is released at once.
    const connecting = pool.connect();
    let abandoned = false;
    connecting.then((late) => { if (abandoned) late.release(); }, () => {});
    let client;
    try {
      client = await withinBound(connecting, 5_000);
    } catch (error) {
      abandoned = true;
      throw error;
    }
    const release = guardClient(client);
    try {
      await client.query(`set statement_timeout = '${IDENTITY_STATEMENT_TIMEOUT_MS}ms'`);
      await client.query(
        `update training_load.gpexe_athlete_identity_requests set status = 'failed', finished_at = now(), error_code = $2, loaded = 0
          where id = $1 and status = 'running'`,
        [requestId, /^[a-z_]{1,64}$/.test(code) ? code : "internal_error"],
      );
      await client.query(`set statement_timeout = 0`);
      release();
    } catch (error) {
      release(true);
      throw error;
    }
  } catch (error) {
    console.error(`[gpexe-identity] a load could not be marked failed: ${error?.code ?? error?.name ?? ""}`);
  }
}

export async function loadIdentities(teamId, { ctx, body }) {
  const requestKey = readBody(body);
  await purgeExpiredIdentities().catch((error) => console.error(`[gpexe-identity] purge before a load failed: ${error?.code ?? ""}`));

  // 1. A replay is answered before anything else is claimed.
  const binding0 = await activeBinding(pool, teamId);
  if (!binding0) throw notAvailable();
  const earlier = await findRequest(pool, ctx, requestKey);
  if (earlier) return replay(earlier, teamId, ctx, binding0.club_id, binding0.id);

  // 2. The claim: facts (no decrypt), the key ring, the right, the targets,
  //    and the request row, in one short transaction.
  let facts;
  let request;
  let targets;
  const client = await pool.connect();
  const release = guardClient(client);
  let released = false;
  try {
    await client.query("begin isolation level read committed");
    await client.query(`set local statement_timeout = '${t("statementTimeout", IDENTITY_STATEMENT_TIMEOUT_MS)}ms'`);
    await client.query(`set local lock_timeout = '${IDENTITY_ROW_LOCK_TIMEOUT_MS}ms'`);
    await client.query(`set local idle_in_transaction_session_timeout = '${IDENTITY_STATEMENT_TIMEOUT_MS * 3}ms'`);
    try {
      facts = await resolveImportSourceFacts(client, { teamId });
    } catch (error) {
      throw mapResolveError(error) ?? error;
    }
    if (facts.path !== PATH_SOURCE_CONNECTION) throw notAvailable();
    try {
      preflightImportSource(facts);
    } catch (error) {
      throw mapResolveError(error) ?? error;
    }
    if (!(await rightHolds(client, ctx, facts.teamClubId))) throw notAvailable();
    await client.query(
      `update training_load.gpexe_athlete_identity_requests set status = 'failed', finished_at = now(), error_code = 'abandoned'
        where owner_team_id = $1 and status = 'running' and started_at < now() - make_interval(secs => $2)`,
      [teamId, t("staleSeconds", IDENTITY_STALE_AFTER_SECONDS)],
    );
    const { pending } = await eligibleAthletes(client, teamId, facts.bindingId);
    targets = pending.slice(0, IDENTITY_MAX_PER_LOAD);
    const notReadLater = pending.length - targets.length;
    try {
      request = (await client.query(
        `insert into training_load.gpexe_athlete_identity_requests
           (owner_team_id, binding_id, requested_by_user_id, request_key, status, targets, finished_at, loaded, not_found, not_read)
         values ($1, $2, $3, $4, $5::varchar, $6::int, case when $5::varchar = 'completed' then now() end, $7::int, $7::int, $8::int)
         returning ${REQUEST_COLUMNS.replace("$3", "$9")}`,
        [teamId, facts.bindingId, ctx.userId, requestKey, targets.length ? "running" : "completed", targets.length, targets.length ? null : 0, targets.length ? null : notReadLater, t("staleSeconds", IDENTITY_STALE_AFTER_SECONDS)],
      )).rows[0];
    } catch (error) {
      if (error.code === "23505" && error.constraint === "gpexe_athlete_identity_requests_one_running") throw refusal("identity_load_running");
      if (error.code === "23505" && error.constraint === "gpexe_athlete_identity_requests_key") {
        // The same key, sent twice at once: the other one claimed it.
        await client.query("rollback");
        released = true;
        release();
        const row = await findRequest(pool, ctx, requestKey);
        if (row) return replay(row, teamId, ctx, facts.teamClubId, facts.bindingId);
        throw refusal("identity_load_running");
      }
      throw error;
    }
    request.notReadLater = notReadLater;
    await client.query("commit");
    released = true;
    release();
  } catch (error) {
    if (!released) {
      let dead = false;
      await withinBound(client.query("rollback"), 5_000).catch(() => { dead = true; });
      released = true;
      release(dead);
    }
    if (error instanceof GpexeIdentityError) throw error;
    if (error?.code === "55P03" || error?.code === "40P01" || error?.code === "57014") throw refusal("try_again");
    // The v32 guard of the request row: the binding ended (an Unbind that
    // committed while this claim waited on its row) — the same 404 as a team
    // without an active binding.
    if (error?.code === "23514" && error?.constraint === "gpexe_athlete_identity_requests_active_binding") throw notAvailable();
    console.error(`[gpexe-identity] a load could not start: ${error?.code ?? error?.name ?? ""}`);
    throw refusal("internal_error");
  }
  if (request.status === "completed") return resultOf(request, { replayed: false, unrecognised: 0 });

  // 3. The network part: no database connection is held.
  const outcome = await readIdentities(facts, targets);
  if (outcome.authRejected) {
    // The load's own outcome first, then the connection's state (the F3c2g
    // order): nothing here can change the first.
    await markFailed(request.id, "source_auth_rejected");
    if (outcome.source) await autoInvalidateImportSource(outcome.source, { trigger: "identity_read" });
    throw refusal("source_auth_rejected");
  }
  if (outcome.discard) {
    await markFailed(request.id, outcome.stop ?? "internal_error");
    if (outcome.resolveError) throw mapResolveError(outcome.resolveError);
    throw refusal(STATUS[outcome.stop] ? outcome.stop : "internal_error");
  }

  // 4. The write, under the locks that order it against an Unbind, a
  //    Reconnect, an archive and a change of the right. Its checkout is its
  //    first step: when the pool has no free connection within the bound
  //    (db.js) nothing of the load was written, the request row is closed as
  //    failed (best effort, bounded) and the answer is try_again.
  try {
    return await finalize({ teamId, ctx, facts, request, targets, outcome });
  } catch (error) {
    if (!isPoolCheckoutTimeout(error)) throw error;
    await markFailed(request.id, "try_again");
    throw refusal("try_again");
  }
}

// Up to three workers over the targets, inside the network budget. Returns
// the identities read and how the load ended; never throws for a source answer.
async function readIdentities(facts, targets) {
  const budgetMs = t("networkBudget", IDENTITY_NETWORK_BUDGET_MS);
  const deadline = Date.now() + budgetMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const base = fetchForIdentity ?? globalThis.fetch;
  const budgetFetch = (url, init = {}) => base(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
  const out = { identities: new Map(), notFound: 0, notFoundIds: [], unrecognised: 0, failed: 0, stop: null, discard: false, authRejected: false, resolveError: null, source: null };
  const halt = (code, { discard = false } = {}) => {
    if (!out.stop) out.stop = code;
    if (discard) out.discard = true;
  };
  try {
    let source;
    try {
      source = openImportSource(facts, { fetchImpl: budgetFetch, timeoutMs: t("requestTimeout", IDENTITY_REQUEST_TIMEOUT_MS) });
    } catch (error) {
      out.resolveError = error instanceof SourceImportResolveError ? error : null;
      halt(error?.code && /^[a-z_]{1,64}$/.test(error.code) ? error.code : "internal_error", { discard: true });
      return out;
    }
    out.source = source;
    const reader = identityReaderFor(source, targets);
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (out.stop) return;
        if (Date.now() >= deadline) { halt("network_budget_exhausted"); return; }
        const index = next;
        next += 1;
        if (index >= targets.length) return;
        const athleteId = targets[index];
        try {
          const { identity, birthDateUnrecognised } = await reader.readAthleteIdentity(athleteId);
          if (identity.gpexeAthleteId !== athleteId) { halt("source_identity_mismatch", { discard: true }); return; }
          out.identities.set(athleteId, { ...identity, observedAt: new Date() });
          if (birthDateUnrecognised) out.unrecognised += 1;
        } catch (error) {
          if (error instanceof SourceImportResolveError) { out.resolveError = error; halt(error.code, { discard: true }); return; }
          const code = error instanceof SourceAdapterError ? error.code : null;
          // GPEXE has no such athlete: counted in this answer (no id) and, in
          // finalize, suppressed for 24 hours - never an identity (owner
          // decision 2026-10-07, after the external review of 94ec914).
          if (code === "source_not_found") { out.notFound += 1; out.notFoundIds.push({ gpexeAthleteId: athleteId, observedAt: new Date() }); continue; }
          out.failed += 1;
          if (code === "source_auth_rejected") { out.authRejected = true; halt(code, { discard: true }); return; }
          if (["source_access_refused", "source_identity_mismatch", "source_team_mismatch", "host_not_allowed", "path_not_allowed"].includes(code)) { halt(code, { discard: true }); return; }
          if (code === "source_unavailable") { halt(Date.now() >= deadline ? "network_budget_exhausted" : "source_unavailable"); return; }
          if (code === "source_answer_unexpected") { halt(code); return; }
          console.error(`[gpexe-identity] an athlete read failed: ${code ?? error?.name ?? ""}`);
          halt("internal_error", { discard: true });
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(t("concurrency", IDENTITY_CONCURRENCY), IDENTITY_CONCURRENCY, targets.length) }, worker));
    if (!out.discard) {
      try {
        await reader.assertStillUsable();
      } catch (error) {
        if (error instanceof SourceImportResolveError) { out.resolveError = error; halt(error.code, { discard: true }); } else halt("internal_error", { discard: true });
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function finalize({ teamId, ctx, facts, request, targets, outcome }) {
  const client = await pool.connect();
  const release = guardClient(client);
  let released = false;
  let commitSent = false;
  try {
    await client.query("begin isolation level read committed");
    await client.query(`set local statement_timeout = '${t("statementTimeout", IDENTITY_STATEMENT_TIMEOUT_MS)}ms'`);
    await client.query(`set local lock_timeout = '${IDENTITY_ROW_LOCK_TIMEOUT_MS}ms'`);
    await client.query(`set local idle_in_transaction_session_timeout = '${IDENTITY_STATEMENT_TIMEOUT_MS * 3}ms'`);
    // Lock order: connection → binding → team → right and club → request.
    // The same order as a bind / Unbind (connection first), so none of them
    // can deadlock with this; an archive or an Unbind that commits first is
    // seen here, one that comes later deletes what this writes.
    const conn = (await client.query(`select id from training_load.source_credential_connections where id = $1 for share`, [facts.connectionId])).rows[0];
    const binding = (await client.query(`select id, state, team_id from training_load.source_team_bindings where id = $1 for share`, [facts.bindingId])).rows[0];
    const team = (await client.query(`select id, club_id, coalesce(is_active, true) as active from public.teams where id = $1 for share`, [teamId])).rows[0];
    if (!conn || !binding || binding.state !== "active" || String(binding.team_id) !== String(teamId) || !team || team.active !== true || String(team.club_id) !== String(facts.teamClubId)) {
      throw Object.assign(notAvailable(), { failCode: "binding_ended" });
    }
    if (!(await rightHolds(client, ctx, facts.teamClubId, { lock: true }))) throw Object.assign(notAvailable(), { failCode: "rights_changed" });
    try {
      await assertImportSourceStillUsable(outcome.source, client);
    } catch (error) {
      const mapped = mapResolveError(error);
      if (mapped) throw Object.assign(mapped, { failCode: error.code });
      throw error;
    }
    const own = (await client.query(`select id from training_load.gpexe_athlete_identity_requests where id = $1 and status = 'running' for update`, [request.id])).rows[0];
    if (!own) throw Object.assign(refusal("identity_load_abandoned"), { failCode: null });
    if (finalizeHold) await finalizeHold(client);
    const read = [...outcome.identities.values()];
    await client.query(
      `delete from training_load.gpexe_athlete_identities where binding_id = $1 and gpexe_athlete_id = any($2::text[]) and expires_at <= now()`,
      [facts.bindingId, read.map((i) => i.gpexeAthleteId)],
    );
    let loaded = 0;
    for (const identity of read) {
      if (insertFault) await insertFault(client);
      const r = await client.query(
        `insert into training_load.gpexe_athlete_identities
           (owner_team_id, binding_id, connection_id, source_team_id, gpexe_athlete_id, display_name, birth_date, observed_at, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7::date, $8::timestamptz, $8::timestamptz + make_interval(hours => $9))
         on conflict (binding_id, gpexe_athlete_id) do nothing`,
        [teamId, facts.bindingId, facts.connectionId, facts.sourceTeamId, identity.gpexeAthleteId, identity.displayName, identity.birthDate, identity.observedAt.toISOString(), IDENTITY_TTL_DAYS * 24],
      );
      loaded += r.rowCount;
    }
    // GPEXE's "no such athlete": no identity, only the 24-hour retry
    // suppression (binding, team, id, observed_at, retry_after); an expired
    // one of the same athlete is replaced, an active one never extended.
    if (outcome.notFoundIds.length) {
      await client.query(
        `delete from training_load.gpexe_athlete_identity_suppressions where binding_id = $1 and gpexe_athlete_id = any($2::text[]) and retry_after <= now()`,
        [facts.bindingId, outcome.notFoundIds.map((x) => x.gpexeAthleteId)],
      );
      for (const miss of outcome.notFoundIds) {
        await client.query(
          `insert into training_load.gpexe_athlete_identity_suppressions (owner_team_id, binding_id, gpexe_athlete_id, observed_at, retry_after)
           values ($1, $2, $3, $4::timestamptz, $4::timestamptz + make_interval(hours => $5))
           on conflict (binding_id, gpexe_athlete_id) do nothing`,
          [teamId, facts.bindingId, miss.gpexeAthleteId, miss.observedAt.toISOString(), IDENTITY_NOT_FOUND_RETRY_HOURS],
        );
      }
    }
    // Not read: chosen but never answered (the load stopped, or the one read
    // that failed), plus the athletes beyond this load's 50. A "no such
    // athlete" answer is counted in notFound (and suppressed for 24 hours).
    const notRead = targets.length - outcome.identities.size - outcome.notFound + (request.notReadLater ?? 0);
    const saved = (await client.query(
      `update training_load.gpexe_athlete_identity_requests
          set status = 'completed', finished_at = now(), loaded = $2, not_found = $3, not_read = $4, error_code = $5
        where id = $1 and status = 'running'
        returning request_key, loaded, not_found, not_read, error_code`,
      [request.id, loaded, outcome.notFound, Math.max(0, notRead), outcome.stop],
    )).rows[0];
    commitSent = true;
    released = true;
    let commitError = null;
    try {
      const commit = commitFault ? commitFault(client) : client.query("commit");
      commit.catch(() => {});
      await withinBound(commit, t("commitBound", IDENTITY_COMMIT_BOUND_MS));
      release();
    } catch (error) {
      commitError = error;
      release(true);
    }
    if (!commitError) return resultOf(saved, { replayed: false, unrecognised: outcome.unrecognised });
    console.error(`[gpexe-identity] the COMMIT of a load was not confirmed (${commitError?.code ?? ""}); checking whether it is in the database`);
    if (await requestCommitted(request.id)) return { ...resultOf(saved, { replayed: false, unrecognised: outcome.unrecognised }), commitConfirmation: "verified_after_commit_error" };
    throw refusal("outcome_unknown", { requestKey: saved.request_key });
  } catch (error) {
    if (!released) {
      let dead = false;
      await withinBound(client.query("rollback"), 5_000).catch(() => { dead = true; });
      released = true;
      release(dead);
    }
    if (commitSent) throw error;
    let failCode = error?.failCode;
    let answer = error;
    if (!(error instanceof GpexeIdentityError)) {
      if (error?.code === "55P03" || error?.code === "40P01" || error?.code === "57014") { failCode = "try_again"; answer = refusal("try_again"); } else if (error?.code === "23514" && (error?.constraint === "gpexe_athlete_identities_active_binding" || error?.constraint === "gpexe_athlete_identities_active_team")) {
        // A v32 guard refused the row because the binding, the team or its
        // club ended in the instant after the locks: nothing is shown or kept.
        failCode = "binding_ended"; answer = notAvailable();
      } else {
        console.error(`[gpexe-identity] a load could not be saved: ${error?.code ?? error?.name ?? ""}`);
        failCode = "internal_error"; answer = refusal("internal_error");
      }
    }
    if (failCode !== null) await markFailed(request.id, failCode ?? answer.code ?? "internal_error");
    throw answer;
  }
}

async function requestCommitted(requestId) {
  const ms = t("verifyBound", IDENTITY_VERIFY_BOUND_MS);
  const deadline = Date.now() + ms;
  const left = () => Math.max(1, deadline - Date.now());
  const connecting = pool.connect();
  let client;
  try {
    client = await withinBound(connecting, left());
  } catch {
    connecting.then((late) => late.release(true), () => {});
    return false;
  }
  const release = guardClient(client);
  let broken = false;
  try {
    if (verifyFault) {
      const fault = Promise.resolve().then(() => verifyFault(client));
      fault.catch(() => {});
      await withinBound(fault, left());
    }
    const answer = client.query({ text: `select 1 from training_load.gpexe_athlete_identity_requests where id = $1 and status = 'completed'`, values: [requestId], query_timeout: left() });
    answer.catch(() => {});
    return (await withinBound(answer, left())).rowCount === 1;
  } catch {
    broken = true;
    return false;
  } finally {
    release(broken);
  }
}
