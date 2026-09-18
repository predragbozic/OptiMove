// In-app GPEXE import, phase F1: "Check now", candidates, previews,
// athlete links, approver grants and retention of the raw snapshots.
// Nothing here writes a measurement, an event or an activity: the preview is
// a rolled-back dry run, and approving/importing a candidate is phase F2.
//
// GPEXE_IMPORT_APPLY_ENABLED (owner decision 2026-09-18) blocks writing
// results and activities. It does not block this module: a check still
// records itself and its candidates, which is what makes them reviewable.
import { pool, query } from "./db.js";
import { createGpexeClient, GpexeClientError } from "./gpexeClient.js";
import { buildCandidatePreview, canonicalJson, sha256Hex } from "./gpexeImportPreview.js";

export const RAW_RETENTION_UNAPPROVED_DAYS = 30;
export const RAW_RETENTION_IMPORTED_DAYS = 90;
export const CHECK_WINDOW_DEFAULT_DAYS = 14;
export const CHECK_WINDOW_MAX_DAYS = 31;
// A running check that has not reported progress for this long is treated as
// abandoned (e.g. the server restarted in the middle of it).
export const CHECK_STALE_AFTER_MINUTES = 15;

export function applyEnabled() {
  return process.env.GPEXE_IMPORT_APPLY_ENABLED === "true";
}

export function applySwitchInfo() {
  const enabled = applyEnabled();
  return {
    enabled,
    message: enabled
      ? "Approved imports can write results and activities in this environment."
      : "Import writing is switched off in this environment: checks and previews are saved, but no result or activity can be written.",
  };
}

// Tests observe when a background check run has fully ended (whatever the
// outcome), instead of waiting an arbitrary time.
let checkRunObserver = null;
export function setCheckRunObserver(observer) {
  checkRunObserver = observer ?? null;
}

// Tests replace the GPEXE client; production always builds the real one.
let clientFactory = () => createGpexeClient();
export function setGpexeClientFactory(factory) {
  clientFactory = factory ?? (() => createGpexeClient());
}

export class GpexeImportServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function parseDay(value, what) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new GpexeImportServiceError(400, "invalid_window", `${what} must be YYYY-MM-DD.`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || isoDay(d) !== value) throw new GpexeImportServiceError(400, "invalid_window", `${what} is not a real date.`);
  return d;
}

export function resolveCheckWindow({ from, to } = {}, now = new Date()) {
  const toDay = to ? parseDay(to, "to") : new Date(`${isoDay(now)}T00:00:00Z`);
  const fromDay = from ? parseDay(from, "from") : new Date(toDay.getTime() - (CHECK_WINDOW_DEFAULT_DAYS - 1) * 86_400_000);
  const days = Math.round((toDay - fromDay) / 86_400_000) + 1;
  if (days < 1) throw new GpexeImportServiceError(400, "invalid_window", "from must not be after to.");
  if (days > CHECK_WINDOW_MAX_DAYS) throw new GpexeImportServiceError(400, "invalid_window", `a check covers at most ${CHECK_WINDOW_MAX_DAYS} days.`);
  if (toDay.getTime() > new Date(`${isoDay(now)}T00:00:00Z`).getTime() + 86_400_000) {
    throw new GpexeImportServiceError(400, "invalid_window", "to is in the future.");
  }
  return { from: isoDay(fromDay), to: isoDay(toDay) };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getTeamSettings(teamId) {
  const row = (await query(`select gpexe_team_id, configured_at from training_load.gpexe_team_settings where owner_team_id = $1`, [teamId])).rows[0];
  return row ? { gpexeTeamId: row.gpexe_team_id, configuredAt: row.configured_at } : null;
}

export async function setTeamSettings(teamId, { gpexeTeamId, userId }) {
  if (typeof gpexeTeamId !== "string" || !/^[0-9]{1,12}$/.test(gpexeTeamId)) {
    throw new GpexeImportServiceError(400, "invalid_gpexe_team_id", "gpexeTeamId must be a numeric GPEXE team id.");
  }
  try {
    await query(
      `insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)
       on conflict (owner_team_id) do update set gpexe_team_id = excluded.gpexe_team_id, configured_by_user_id = excluded.configured_by_user_id, configured_at = now()`,
      [teamId, gpexeTeamId, userId],
    );
  } catch (error) {
    if (error.code === "23505") throw new GpexeImportServiceError(409, "gpexe_team_taken", "This GPEXE team is already connected to another OptiMove team.");
    throw error;
  }
  return getTeamSettings(teamId);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export const RETENTION_BATCH_SIZE = 200;
const RETENTION_MAX_BATCHES = 500;

export async function runRetention(triggerSource) {
  const run = (await query(`insert into training_load.gpexe_retention_runs (trigger_source) values ($1) returning id`, [triggerSource])).rows[0];
  try {
    // Short batches until one comes back smaller than the batch size.
    let purged = 0;
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
      const n = (await query(`select training_load.purge_expired_gpexe_raw($1) as n`, [RETENTION_BATCH_SIZE])).rows[0].n;
      purged += n;
      if (n < RETENTION_BATCH_SIZE) break;
    }
    await query(`update training_load.gpexe_retention_runs set finished_at = now(), purged_count = $2 where id = $1`, [run.id, purged]);
    return { runId: run.id, purged };
  } catch (error) {
    await query(`update training_load.gpexe_retention_runs set finished_at = now(), error_message = $2 where id = $1`, [run.id, String(error.message).slice(0, 300)]).catch(() => {});
    throw error;
  }
}

export const RETENTION_INTERVAL_HOURS = 6;

// In the web server process only (see server.js). Timers are unref'd, and a
// failure is logged and recorded in gpexe_retention_runs, never thrown.
export function startGpexeRetentionSchedule({ intervalHours = RETENTION_INTERVAL_HOURS, startupDelayMs = 30_000 } = {}) {
  const tick = (trigger) => runRetention(trigger).catch((error) => console.error(`[gpexe] retention (${trigger}) failed: ${error?.message}`));
  const first = setTimeout(() => tick("startup"), startupDelayMs);
  first.unref();
  const every = setInterval(() => tick("interval"), intervalHours * 3_600_000);
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

// What a platform admin (and the runbook) watches: expired snapshots that are
// still stored must be 0; the last successful purge must be recent.
export async function retentionStatus() {
  const counts = (await query(
    `select count(*) filter (where raw_bundle is not null)::int as stored,
            count(*) filter (where raw_bundle is not null and raw_expires_at <= now())::int as expired_not_purged,
            min(raw_expires_at) filter (where raw_bundle is not null) as next_expiry
     from training_load.gpexe_import_candidates`,
  )).rows[0];
  const lastOk = (await query(
    `select finished_at, trigger_source, purged_count from training_load.gpexe_retention_runs
     where finished_at is not null and error_message is null order by finished_at desc limit 1`,
  )).rows[0] ?? null;
  const lastFailed = (await query(
    `select finished_at, trigger_source, error_message from training_load.gpexe_retention_runs
     where error_message is not null order by finished_at desc limit 1`,
  )).rows[0] ?? null;
  return {
    storedSnapshots: counts.stored,
    expiredNotPurged: counts.expired_not_purged,
    nextExpiry: counts.next_expiry,
    lastSuccessfulRun: lastOk ? { at: lastOk.finished_at, trigger: lastOk.trigger_source, purged: lastOk.purged_count } : null,
    lastFailedRun: lastFailed ? { at: lastFailed.finished_at, trigger: lastFailed.trigger_source, error: lastFailed.error_message } : null,
    healthy: counts.expired_not_purged === 0,
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkView(row) {
  return {
    id: row.id,
    status: row.status,
    window: { from: row.window_from, to: row.window_to },
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    sessionsSeen: row.sessions_seen,
    candidatesNew: row.candidates_new,
    candidatesChanged: row.candidates_changed,
    candidatesUnchanged: row.candidates_unchanged,
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
  };
}

export async function getCheck(teamId, checkId) {
  const row = (await query(`select * from training_load.gpexe_import_checks where id = $1 and owner_team_id = $2`, [checkId, teamId])).rows[0];
  return row ? checkView(row) : null;
}

export async function latestCheck(teamId) {
  const row = (await query(`select * from training_load.gpexe_import_checks where owner_team_id = $1 order by started_at desc limit 1`, [teamId])).rows[0];
  return row ? checkView(row) : null;
}

// Starts a check and returns it right away; the fetch runs in the
// background (GPEXE can take minutes). `wait` is for tests and the CLI.
export async function startCheck(teamId, { userId, window, wait = false }) {
  const settings = await getTeamSettings(teamId);
  if (!settings) throw new GpexeImportServiceError(409, "gpexe_team_not_configured", "No GPEXE team is configured for this team yet.");
  let client;
  try {
    client = clientFactory();
  } catch (error) {
    if (error instanceof GpexeClientError && error.code === "token_missing") {
      throw new GpexeImportServiceError(503, "gpexe_token_missing", "The server has no GPEXE token configured.");
    }
    throw error;
  }

  await query(
    `update training_load.gpexe_import_checks
        set status = 'failed', finished_at = now(), error_code = 'abandoned',
            error_message = 'The check stopped reporting progress (for example the server restarted).'
      where owner_team_id = $1 and status = 'running' and heartbeat_at < now() - make_interval(mins => $2)`,
    [teamId, CHECK_STALE_AFTER_MINUTES],
  );
  let row;
  try {
    row = (await query(
      `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, window_from, window_to) values ($1,$2,$3,$4) returning *`,
      [teamId, userId, window.from, window.to],
    )).rows[0];
  } catch (error) {
    if (error.code === "23505") throw new GpexeImportServiceError(409, "check_already_running", "A check is already running for this team.");
    throw error;
  }

  const job = runCheck(row.id, { teamId, userId, gpexeTeamId: settings.gpexeTeamId, window, gpexe: client });
  if (wait) await job;
  else job.catch((error) => console.error(`[gpexe] check ${row.id} failed outside its own handler: ${error?.name}`));
  return checkView(wait ? (await query(`select * from training_load.gpexe_import_checks where id = $1`, [row.id])).rows[0] : row);
}

// Thrown when the check's own row is no longer 'running' (a later check
// closed it as abandoned): this run stops and writes nothing more.
class CheckClosedElsewhere extends Error {}

// Every write to the check row is conditional on it still running, so a run
// that was closed from outside can neither keep going nor end up
// 'succeeded' over an 'abandoned'.
async function heartbeat(checkId, counts) {
  const r = await query(
    `update training_load.gpexe_import_checks
        set heartbeat_at = now(), sessions_seen = $2, candidates_new = $3, candidates_changed = $4, candidates_unchanged = $5
      where id = $1 and status = 'running'`,
    [checkId, counts.sessions, counts.new, counts.changed, counts.unchanged],
  );
  if (r.rowCount === 0) throw new CheckClosedElsewhere();
}

async function runCheck(checkId, options) {
  try {
    return await runCheckBody(checkId, options);
  } finally {
    if (checkRunObserver) checkRunObserver(checkId);
  }
}

async function runCheckBody(checkId, { teamId, userId, gpexeTeamId, window, gpexe }) {
  const counts = { sessions: 0, new: 0, changed: 0, unchanged: 0 };
  const alive = () => heartbeat(checkId, counts);
  try {
    // Every check is also a retention run, so expired snapshots go even when
    // no scheduler ran; a failure here must not stop the check.
    await runRetention("check").catch((error) => console.error(`[gpexe] retention during check failed: ${error?.message}`));
    const sessions = await gpexe.listTeamSessions({ gpexeTeamId, fromDay: window.from, toDay: window.to, onProgress: alive });
    await alive();
    for (const session of sessions) {
      // A heartbeat after every GPEXE request: one slow session must not look
      // like a dead check.
      const bundle = await gpexe.fetchSessionBundle({ gpexeTeamId, sessionId: session.id, onProgress: alive });
      await alive();
      const kind = await recordCandidate(checkId, { teamId, userId, bundle });
      counts.sessions += 1;
      counts[kind] += 1;
      await alive();
    }
    await query(`update training_load.gpexe_import_checks set status = 'succeeded', finished_at = now() where id = $1 and status = 'running'`, [checkId]);
  } catch (error) {
    if (error instanceof CheckClosedElsewhere) return;
    const known = error instanceof GpexeClientError;
    if (!known) console.error(`[gpexe] check ${checkId} failed: ${error?.stack || error}`);
    await query(
      `update training_load.gpexe_import_checks set status = 'failed', finished_at = now(), error_code = $2, error_message = $3,
              sessions_seen = $4, candidates_new = $5, candidates_changed = $6, candidates_unchanged = $7
        where id = $1 and status = 'running'`,
      [checkId, known ? error.code : "internal_error", known ? error.message : "The check failed on the server.", counts.sessions, counts.new, counts.changed, counts.unchanged],
    );
  }
}

function sessionStartInstant(bundle) {
  const raw = bundle?.teamSession?.start_timestamp;
  if (typeof raw !== "string") return null;
  const d = new Date(`${raw.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// One session of a check: store (or refresh) its candidate. Returns "new",
// "changed" or "unchanged". Repeated checks of unchanged data only refresh
// the same row — the unique (team, session, content hash) key makes a second
// row impossible.
async function recordCandidate(checkId, { teamId, userId, bundle }) {
  const sessionId = String(bundle.teamSession.id);
  const bundleHash = sha256Hex(canonicalJson(bundle));

  // The dry run needs its own connection outside any transaction.
  const previewClient = await pool.connect();
  let preview;
  let previewHash;
  try {
    ({ preview, previewHash } = await buildCandidatePreview(previewClient, { bundle, ownerTeamId: teamId, performedByUserId: userId }));
  } finally {
    previewClient.release();
  }
  const status = preview.status === "blocked" ? "blocked" : "pending";
  const label = preview.session?.name ?? `GPEXE ${preview.session?.categoryName ?? "session"} ${preview.session?.startTimestamp ?? ""}`.trim();

  const client = await pool.connect();
  try {
    await client.query("begin");
    // Serializes two checks of the same session (the one-running-check index
    // already prevents two checks per team; this also covers the CLI).
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`gpexe-candidate:${teamId}:${sessionId}`]);
    const existing = (await client.query(
      `select id, bundle_hash, status, imported_at from training_load.gpexe_import_candidates
       where owner_team_id = $1 and gpexe_team_session_id = $2 order by first_seen_at for update`,
      [teamId, sessionId],
    )).rows;
    const same = existing.find((c) => c.bundle_hash === bundleHash);
    let currentId;
    let kind;
    if (same && same.status === "imported") {
      // Already imported with exactly this content: nothing to review. Only
      // the sighting is recorded; the snapshot keeps its own 90-day clock and
      // is never re-stored after it.
      kind = "unchanged";
      await client.query(
        `update training_load.gpexe_import_candidates set last_seen_check_id = $2, last_seen_at = now() where id = $1`,
        [same.id, checkId],
      );
      currentId = same.id;
    } else if (same) {
      kind = "unchanged";
      // Refreshing re-stores the snapshot and restarts its 30 days, and the
      // preview is recomputed against today's state. A candidate whose
      // snapshot had expired becomes reviewable again only this way.
      await client.query(
        `update training_load.gpexe_import_candidates
            set raw_bundle = $2, raw_purged_at = null, raw_expires_at = now() + make_interval(days => $3),
                status = $4, superseded_by_candidate_id = null,
                preview = $5, preview_hash = $6, preview_computed_at = now(),
                last_seen_check_id = $7, last_seen_at = now(), session_started_at = $8, session_label = $9
          where id = $1`,
        [same.id, bundle, RAW_RETENTION_UNAPPROVED_DAYS, status, preview, previewHash, checkId, sessionStartInstant(bundle), label],
      );
      currentId = same.id;
    } else {
      kind = existing.length ? "changed" : "new";
      currentId = (await client.query(
        `insert into training_load.gpexe_import_candidates
           (owner_team_id, gpexe_team_session_id, session_started_at, session_label, bundle_hash, raw_bundle, raw_expires_at,
            status, preview, preview_hash, preview_computed_at, first_seen_check_id, last_seen_check_id)
         values ($1,$2,$3,$4,$5,$6, now() + make_interval(days => $7), $8,$9,$10, now(), $11, $11) returning id`,
        [teamId, sessionId, sessionStartInstant(bundle), label, bundleHash, bundle, RAW_RETENTION_UNAPPROVED_DAYS, status, preview, previewHash, checkId],
      )).rows[0].id;
    }
    // Older content of the same session that was never imported is replaced
    // by what GPEXE shows now; an imported one stays as the record.
    await client.query(
      `update training_load.gpexe_import_candidates set status = 'superseded', superseded_by_candidate_id = $3
        where owner_team_id = $1 and gpexe_team_session_id = $2 and id <> $3 and status in ('pending', 'blocked')`,
      [teamId, sessionId, currentId],
    );
    await client.query("commit");
    return kind;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function snapshotState(row) {
  if (row.raw_purged_at) return { available: false, reason: "purged", expiresAt: row.raw_expires_at };
  if (new Date(row.raw_expires_at).getTime() <= Date.now()) return { available: false, reason: "expired", expiresAt: row.raw_expires_at };
  return { available: true, reason: null, expiresAt: row.raw_expires_at };
}

// Why this candidate cannot be approved right now. F1 has no approval at
// all, so "approval_not_available_yet" is always there; the other reasons are
// the ones F2 keeps.
function approvalBlockers(row, snapshot, preview) {
  const blockers = ["approval_not_available_yet"];
  if (!applyEnabled()) blockers.push("import_switch_off");
  if (row.status === "superseded") blockers.push("superseded_by_newer_data");
  if (row.status === "imported") blockers.push("already_imported");
  if (row.status === "blocked") blockers.push("blocked");
  if (!snapshot.available) blockers.push("snapshot_expired_check_again");
  if (preview && preview.status === "no_changes") blockers.push("nothing_to_import");
  return blockers;
}

function candidateSummary(row) {
  const snapshot = snapshotState(row);
  const preview = snapshot.available ? row.preview : null;
  return {
    id: row.id,
    gpexeTeamSessionId: row.gpexe_team_session_id,
    label: row.session_label,
    sessionStartedAt: row.session_started_at,
    status: row.status,
    previewStatus: preview?.status ?? null,
    counts: preview?.counts ?? null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    importedAt: row.imported_at,
    supersededByCandidateId: row.superseded_by_candidate_id,
    snapshot,
    approvalBlockers: approvalBlockers(row, snapshot, preview),
  };
}

const CANDIDATE_COLUMNS = `id, gpexe_team_session_id, session_label, session_started_at, status, preview, preview_hash,
  first_seen_at, last_seen_at, imported_at, superseded_by_candidate_id, raw_expires_at, raw_purged_at`;

export async function listCandidates(teamId, { includeSuperseded = false } = {}) {
  const rows = (await query(
    `select ${CANDIDATE_COLUMNS} from training_load.gpexe_import_candidates
     where owner_team_id = $1 and ($2 or status <> 'superseded')
     order by session_started_at desc nulls last, first_seen_at desc limit 200`,
    [teamId, includeSuperseded],
  )).rows;
  return rows.map(candidateSummary);
}

export async function getCandidate(teamId, candidateId) {
  const row = (await query(`select ${CANDIDATE_COLUMNS} from training_load.gpexe_import_candidates where id = $1 and owner_team_id = $2`, [candidateId, teamId])).rows[0];
  if (!row) return null;
  const summary = candidateSummary(row);
  const preview = summary.snapshot.available ? row.preview : null;
  // Names are read now, for the team's own athletes only; the stored preview
  // carries ids, not names.
  let athletes = {};
  if (preview) {
    const ids = [...new Set([
      ...preview.athletes.map((a) => a.athleteId).filter(Boolean),
      ...preview.teamAthletesWithoutGpexeRecord.map((a) => a.athleteId),
    ])];
    if (ids.length) {
      const named = (await query(
        `select a.id, coalesce(nullif(a.display_name, ''), a.full_name) as name from public.athletes a
         where a.id = any($1::uuid[])
           and exists (select 1 from public.athlete_memberships m where m.athlete_id = a.id and m.team_id = $2 and m.membership_type = 'team')`,
        [ids, teamId],
      )).rows;
      athletes = Object.fromEntries(named.map((r) => [r.id, { name: r.name }]));
    }
  }
  return { ...summary, preview, previewHash: preview ? row.preview_hash : null, athletes };
}

// ---------------------------------------------------------------------------
// Athlete links
// ---------------------------------------------------------------------------

function mapTriggerError(error, fallbackCode) {
  if (error.code === "23505") return new GpexeImportServiceError(409, "already_linked", "This GPEXE athlete or this OptiMove athlete is already linked in this team.");
  if (error.code === "42501") return new GpexeImportServiceError(403, "forbidden", "Not allowed.");
  if (error.code === "P0001") return new GpexeImportServiceError(409, fallbackCode, "The change was refused by the database rules.");
  return error;
}

export async function listAthleteLinks(teamId) {
  return (await query(
    `select l.id, l.gpexe_athlete_id, l.athlete_id, l.linked_at, coalesce(nullif(a.display_name, ''), a.full_name) as athlete_name
     from training_load.gpexe_athlete_links l join public.athletes a on a.id = l.athlete_id
     where l.owner_team_id = $1 and l.unlinked_at is null order by l.gpexe_athlete_id`,
    [teamId],
  )).rows.map((r) => ({ id: r.id, gpexeAthleteId: r.gpexe_athlete_id, athleteId: r.athlete_id, athleteName: r.athlete_name, linkedAt: r.linked_at }));
}

export async function linkAthlete(teamId, { gpexeAthleteId, athleteId, userId }) {
  if (typeof gpexeAthleteId !== "string" || !/^[0-9]{1,12}$/.test(gpexeAthleteId)) throw new GpexeImportServiceError(400, "invalid_gpexe_athlete_id", "gpexeAthleteId must be a numeric GPEXE athlete id.");
  try {
    const row = (await query(
      `insert into training_load.gpexe_athlete_links (owner_team_id, gpexe_athlete_id, athlete_id, linked_by_user_id) values ($1,$2,$3,$4) returning id`,
      [teamId, gpexeAthleteId, athleteId, userId],
    )).rows[0];
    return { id: row.id };
  } catch (error) {
    throw mapTriggerError(error, "athlete_not_in_team");
  }
}

export async function unlinkAthlete(teamId, { linkId, userId }) {
  const r = await query(
    `update training_load.gpexe_athlete_links set unlinked_at = now(), unlinked_by_user_id = $3
      where id = $1 and owner_team_id = $2 and unlinked_at is null returning id`,
    [linkId, teamId, userId],
  );
  return r.rowCount === 1;
}

// ---------------------------------------------------------------------------
// Approver grants (platform admin only; checked by the route AND the trigger)
// ---------------------------------------------------------------------------

export async function listApprovers(teamId) {
  return (await query(
    `select g.id, g.user_id, coalesce(nullif(u.display_name, ''), u.full_name, u.email) as user_name, g.granted_at, g.grant_reason,
            g.revoked_at, g.revoke_reason
     from training_load.gpexe_import_approvers g join public.users u on u.id = g.user_id
     where g.owner_team_id = $1 order by g.granted_at desc`,
    [teamId],
  )).rows.map((r) => ({
    id: r.id, userId: r.user_id, userName: r.user_name, grantedAt: r.granted_at, grantReason: r.grant_reason,
    revokedAt: r.revoked_at, revokeReason: r.revoke_reason, active: r.revoked_at === null,
  }));
}

function requireReason(reason) {
  if (typeof reason !== "string" || !reason.trim()) throw new GpexeImportServiceError(400, "reason_required", "A reason is required.");
  return reason.trim();
}

export async function grantApprover(teamId, { userId, grantedByUserId, reason }) {
  const why = requireReason(reason);
  try {
    const row = (await query(
      `insert into training_load.gpexe_import_approvers (owner_team_id, user_id, granted_by_user_id, grant_reason) values ($1,$2,$3,$4) returning id`,
      [teamId, userId, grantedByUserId, why],
    )).rows[0];
    return { id: row.id };
  } catch (error) {
    if (error.code === "23505") throw new GpexeImportServiceError(409, "already_granted", "This coach already holds an active grant for this team.");
    throw mapTriggerError(error, "grantee_not_team_coach");
  }
}

export async function revokeApprover(teamId, { grantId, revokedByUserId, reason }) {
  const why = requireReason(reason);
  try {
    const r = await query(
      `update training_load.gpexe_import_approvers set revoked_at = now(), revoked_by_user_id = $3, revoke_reason = $4
        where id = $1 and owner_team_id = $2 and revoked_at is null returning id`,
      [grantId, teamId, revokedByUserId, why],
    );
    return r.rowCount === 1;
  } catch (error) {
    throw mapTriggerError(error, "revoke_refused");
  }
}
