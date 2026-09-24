// In-app GPEXE import: "Check now", candidates, previews, athlete links,
// approver grants and retention of the raw snapshots (phase F1), and
// approving a candidate, which imports it (phase F2, approveCandidate).
// Only approveCandidate writes measurements, events or activities; the
// preview is a rolled-back dry run.
//
// GPEXE_IMPORT_APPLY_ENABLED (owner decision 2026-09-18) blocks writing
// results and activities, i.e. approving. It does not block checks: a check
// still records itself and its candidates, which is what makes them
// reviewable. The switch stays off in an environment until a fresh,
// restore-verified backup of it exists (operational gate, recorded in
// docs/runbooks/gpexe-in-app-import.md); nothing here checks or claims a
// backup.
import { pool, query } from "./db.js";
import { createGpexeClient, GpexeClientError } from "./gpexeClient.js";
import { buildGpexeImportPlan, GpexeMappingError } from "./gpexeImportMapper.js";
import { candidateReasons } from "./gpexeImportReasons.js";
import { blockedByMapping, buildCandidatePreview, canonicalJson, previewLocked, sha256Hex } from "./gpexeImportPreview.js";
import { lockTeamForImport } from "./gpexeImportWriter.js";

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
  const row = (await query(
    `select s.gpexe_team_id, s.configured_at, s.change_reason,
            coalesce(nullif(u.display_name, ''), u.full_name, u.email) as configured_by_name
       from training_load.gpexe_team_settings s join public.users u on u.id = s.configured_by_user_id
      where s.owner_team_id = $1`,
    [teamId],
  )).rows[0];
  return row
    ? { gpexeTeamId: row.gpexe_team_id, configuredAt: row.configured_at, changeReason: row.change_reason, configuredByName: row.configured_by_name }
    : null;
}

// Every value the connection ever had, newest first. Read-only, and read by
// the route only for a platform admin: a row carries the admin's own note,
// which may name another club or team (same reason the current reason is
// admin-only in /status). The history itself is append-only in the database
// (v22 gpexe_team_settings_history_no_update_delete), so nothing here can
// rewrite it.
export const SETTINGS_HISTORY_LIMIT = 50;

export async function listSettingsHistory(teamId) {
  return (await query(
    `select h.gpexe_team_id, h.configured_at, h.change_reason,
            coalesce(nullif(u.display_name, ''), u.full_name, u.email) as configured_by_name
       from training_load.gpexe_team_settings_history h join public.users u on u.id = h.configured_by_user_id
      where h.owner_team_id = $1
      order by h.configured_at desc, h.id desc
      limit $2`,
    [teamId, SETTINGS_HISTORY_LIMIT],
  )).rows.map((r) => ({
    gpexeTeamId: r.gpexe_team_id, configuredAt: r.configured_at, changeReason: r.change_reason, configuredByName: r.configured_by_name,
  }));
}

export const SETTINGS_LOCK_TIMEOUT_MS = 3_000;
const CHANGE_REASON_MAX = 500;

// What makes a team's GPEXE connection unchangeable. A GPEXE athlete id and a
// GPEXE session id mean something only inside one GPEXE team, while the rows
// below are keyed by the OptiMove team alone - so the same link or candidate
// would silently describe a different person or session under another GPEXE
// team. Each entry is read inside the change's own transaction.
const CHANGE_BLOCKERS = [
  ["a session found by a check", `select 1 from training_load.gpexe_import_candidates where owner_team_id = $1 limit 1`],
  ["a check", `select 1 from training_load.gpexe_import_checks where owner_team_id = $1 limit 1`],
  ["a GPEXE athlete linked to an OptiMove athlete", `select 1 from training_load.gpexe_athlete_links where owner_team_id = $1 limit 1`],
  // Defence in depth: an approval references its candidate
  // (v23 candidate_id ... references gpexe_import_candidates on delete
  // restrict) and a candidate that was imported is never deleted (v22
  // protect_gpexe_import_candidate), so the first entry always answers first
  // and no test can make this one answer alone. It stays for the day a
  // candidate may be purged.
  ["an approved import", `select 1 from training_load.gpexe_import_approvals where owner_team_id = $1 limit 1`],
  ["imported GPEXE data", `select 1 from training_load.metric_source_connections c
     where c.source_system = 'gpexe' and c.owner_scope = 'team' and c.owner_team_id = $1
       and (c.state = 'active' or exists (select 1 from training_load.metric_events e where e.source_connection_id = c.id)) limit 1`],
];

function changeReason(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new GpexeImportServiceError(400, "change_reason_required", "Changing the GPEXE team of a team that is already connected needs a reason.");
  }
  const reason = raw.trim();
  if (reason.length > CHANGE_REASON_MAX) {
    throw new GpexeImportServiceError(400, "change_reason_too_long", `A reason is at most ${CHANGE_REASON_MAX} characters.`);
  }
  return reason;
}

// Connecting a team to its GPEXE team, and changing that connection.
//
// One transaction, under the same team import lock an approval takes, so no
// import can commit between the check below and the write. The same value
// again writes nothing at all: no new history row, and the reason of the
// current value is left alone (a reason can never be rewritten without a real
// change). A different value is refused - with nothing written - as soon as
// anything depends on the current one.
export async function setTeamSettings(teamId, { gpexeTeamId, reason, userId }) {
  if (typeof gpexeTeamId !== "string" || !/^[0-9]{1,12}$/.test(gpexeTeamId)) {
    throw new GpexeImportServiceError(400, "invalid_gpexe_team_id", "gpexeTeamId must be a numeric GPEXE team id.");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    // A team whose import or check is running must not make this wait forever.
    await client.query(`set local lock_timeout = '${SETTINGS_LOCK_TIMEOUT_MS}ms'`);
    await lockTeamForImport(client, teamId);
    const current = (await client.query(
      `select gpexe_team_id from training_load.gpexe_team_settings where owner_team_id = $1 for update`,
      [teamId],
    )).rows[0];

    if (current && current.gpexe_team_id === gpexeTeamId) {
      // Idempotent: nothing is written, so nothing is appended to the history.
      await client.query("commit");
      return getTeamSettings(teamId);
    }

    // A change needs a reason; a first connection may carry one and it is
    // kept (an empty or whitespace-only one is refused either way).
    let why = current ? changeReason(reason) : (typeof reason === "string" && reason.trim() ? changeReason(reason) : null);
    for (const [what, sql] of CHANGE_BLOCKERS) {
      if ((await client.query(sql, [teamId])).rowCount) {
        if (current) {
          throw new GpexeImportServiceError(
            409, "gpexe_team_change_blocked",
            `This team already has ${what} from GPEXE team ${current.gpexe_team_id}. A GPEXE athlete or session id means something only inside its own GPEXE team, so the connection is final.`,
          );
        }
        // No connection recorded, yet something of this team already
        // describes one: a first connection would silently adopt it.
        throw new GpexeImportServiceError(
          409, "gpexe_orphan_data",
          `This team already has ${what} from a GPEXE team that is not recorded. Connecting it now would read that as the new team's own data, so it is refused. There is no procedure for clearing it yet: a platform admin has to decide what happens to that data first (docs/runbooks/gpexe-in-app-import.md, "Refusals when connecting or linking").`,
        );
      }
    }

    await client.query(
      `insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id, change_reason) values ($1,$2,$3,$4)
       on conflict (owner_team_id) do update set gpexe_team_id = excluded.gpexe_team_id, configured_by_user_id = excluded.configured_by_user_id,
         configured_at = now(), change_reason = excluded.change_reason`,
      [teamId, gpexeTeamId, userId, why],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error.code === "23505") throw new GpexeImportServiceError(409, "gpexe_team_taken", "This GPEXE team is already connected to another OptiMove team.");
    if (error.code === "55P03" || error.code === "40P01") {
      throw new GpexeImportServiceError(409, "gpexe_change_busy", "A GPEXE check, import or connection change is running for this team. Try again when it has finished.");
    }
    if (error instanceof GpexeImportServiceError) throw error;
    // Anything else (a database guard firing, a bug): a stable code, and the
    // database's own text never reaches the caller.
    console.error(`[gpexe] the GPEXE team of ${teamId} could not be set: ${error?.code ?? ""} ${error?.message}`);
    throw new GpexeImportServiceError(500, "internal_error", "The GPEXE team could not be set; nothing was changed.");
  } finally {
    client.release();
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
  // A first, unlocked read only to fail early (no GPEXE team, no token); the
  // value the check really uses is read again under the lock below.
  const settings = await getTeamSettings(teamId);
  if (!settings) throw new GpexeImportServiceError(409, "gpexe_team_not_configured", "No GPEXE team is configured for this team yet.");
  let gpexeTeamId = settings.gpexeTeamId;
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
  // The check's own GPEXE team is decided here, in a short transaction under
  // the same team import lock a settings change takes, and written on the
  // check row. So a check and a change of the connection can never overlap:
  // whichever takes the lock first wins, and a check that exists then blocks
  // the change. No GPEXE request is made while this transaction is open.
  let row;
  const lockClient = await pool.connect();
  try {
    await lockClient.query("begin");
    await lockClient.query(`set local lock_timeout = '${SETTINGS_LOCK_TIMEOUT_MS}ms'`);
    await lockTeamForImport(lockClient, teamId);
    const locked = (await lockClient.query(
      `select gpexe_team_id from training_load.gpexe_team_settings where owner_team_id = $1`,
      [teamId],
    )).rows[0];
    if (!locked) throw new GpexeImportServiceError(409, "gpexe_team_not_configured", "No GPEXE team is configured for this team yet.");
    gpexeTeamId = locked.gpexe_team_id;
    row = (await lockClient.query(
      `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, window_from, window_to, gpexe_team_id) values ($1,$2,$3,$4,$5) returning *`,
      [teamId, userId, window.from, window.to, gpexeTeamId],
    )).rows[0];
    await lockClient.query("commit");
  } catch (error) {
    await lockClient.query("rollback").catch(() => {});
    if (error.code === "23505") throw new GpexeImportServiceError(409, "check_already_running", "A check is already running for this team.");
    if (error.code === "55P03" || error.code === "40P01") {
      throw new GpexeImportServiceError(409, "gpexe_change_busy", "A GPEXE check, import or connection change is running for this team. Try again when it has finished.");
    }
    if (error instanceof GpexeImportServiceError) throw error;
    console.error(`[gpexe] the check of ${teamId} could not be started: ${error?.code ?? ""} ${error?.message}`);
    throw new GpexeImportServiceError(500, "internal_error", "The check could not be started; nothing was written.");
  } finally {
    lockClient.release();
  }

  const job = runCheck(row.id, { teamId, userId, gpexeTeamId, window, gpexe: client });
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

// Why this candidate cannot be approved right now (the approval checks the
// same things again, under its locks). Whether the viewer may approve is the
// status route's viewer.canApprove.
function approvalBlockers(row, snapshot, preview) {
  const blockers = [];
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
    // The approval must carry acceptChanges = true when this is > 0.
    changesToImported: preview ? (preview.changesToImported?.length ?? 0) : null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    importedAt: row.imported_at,
    supersededByCandidateId: row.superseded_by_candidate_id,
    snapshot,
    approvalBlockers: approvalBlockers(row, snapshot, preview),
    // Phase 2b, additive: why the session is blocked and what keeps it out of
    // "Ready to import", from the stored preview - the list needs no
    // per-candidate read for them. Null / empty when the snapshot is gone.
    ...candidateReasons(row.status, preview),
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

// Tests make reading a candidate fail, to prove the approval route never
// hides a committed import behind that failure.
let candidateReadFault = null;
export function setCandidateReadFaultForTests(fault) {
  candidateReadFault = fault ?? null;
}

function approvalView(row) {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    approvedAt: row.approved_at,
    approvedByUserId: row.approved_by_user_id,
    basis: row.approval_basis,
    changesToImported: row.changes_to_imported,
    changesAccepted: row.changes_accepted,
    import: { eventId: row.metric_event_id, activityId: row.activity_id, importBatchId: row.import_batch_id, counts: row.import_counts },
  };
}

const APPROVAL_COLUMNS = `id, candidate_id, approved_at, approved_by_user_id, approval_basis, changes_to_imported, changes_accepted,
  metric_event_id, activity_id, import_batch_id, import_counts`;

// One approval of the team, by id: what "was it imported?" is checked
// against when an approval's outcome is uncertain.
export async function getApproval(teamId, approvalId) {
  const row = (await query(`select ${APPROVAL_COLUMNS} from training_load.gpexe_import_approvals where id = $1 and owner_team_id = $2`, [approvalId, teamId])).rows[0];
  return row ? approvalView(row) : null;
}

export async function getCandidate(teamId, candidateId) {
  if (candidateReadFault) await candidateReadFault(candidateId);
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
  // An imported candidate names its approval (who, when, what was written).
  const approvalRow = row.status === "imported"
    ? (await query(`select ${APPROVAL_COLUMNS} from training_load.gpexe_import_approvals where candidate_id = $1 and owner_team_id = $2`, [candidateId, teamId])).rows[0]
    : null;
  return { ...summary, preview, previewHash: preview ? row.preview_hash : null, athletes, approval: approvalRow ? approvalView(approvalRow) : null };
}

// ---------------------------------------------------------------------------
// Athlete links
// ---------------------------------------------------------------------------

function mapTriggerError(error, fallbackCode) {
  if (error instanceof GpexeImportServiceError) return error;
  if (error.code === "23505") return new GpexeImportServiceError(409, "already_linked", "This GPEXE athlete or this OptiMove athlete is already linked in this team.");
  if (error.code === "42501") return new GpexeImportServiceError(403, "forbidden", "Not allowed.");
  if (error.code === "P0001") return new GpexeImportServiceError(409, fallbackCode, "The change was refused by the database rules.");
  // Any other database code (a constraint nobody mapped, a bug): a stable
  // answer, and the database's own text stays in the log.
  console.error(`[gpexe] ${fallbackCode}: unmapped database error ${error?.code ?? ""} ${error?.message}`);
  return new GpexeImportServiceError(500, "internal_error", "The change failed on the server; nothing was written.");
}

// The team's source athletes (Imports phase 3a): every GPEXE athlete the
// team's available snapshots (not purged, not expired) have seen, plus every GPEXE athlete the team has an
// active link for, once each - what a whole-team linking screen needs.
// Read-only, from stored data only (no GPEXE call), one SQL statement
// whatever the number of candidates or athletes.
//
// "Last seen" is deterministic: the newest session by session date among
// the team's candidates whose snapshot is still available - not purged and
// not expired, the same rule snapshotState() applies everywhere else (v22:
// an expired snapshot is gone for the app before the purge removes it); the
// tie-break among rows of the same date is a current version before a
// superseded one, then the later last_seen_at, then the larger candidate id.
//
// A session the mapper refused (unsupported category, invalid statistics,
// inconsistent data) is stored blocked with a preview that names no athlete.
// Its raw snapshot's athleteSessions[].athlete is used only as a fallback
// (owner decision (b), 2026-09-24): it adds a GPEXE athlete who appears in no
// available preview at all, with lastSeen from the newest available refused
// session (candidateStatus "blocked", evidence "raw_snapshot") and no helper
// values. It never replaces a preview sighting or its values, and it obeys
// the same availability, team and tie-break rules. Only a valid GPEXE
// athlete id is accepted from the raw row.
//
// Helper values for telling athletes apart are the athlete's own
// whole-session result of that sighting (from the stored preview); the number
// of drills is a property of the session (lastSeen.sessionDrillsCount, from
// the raw snapshot's own field). A value the source did not give is null,
// never a zero. GPEXE names are never stored, so none is returned; the
// OptiMove name comes only from the confirmed link.
export const SOURCE_ATHLETE_UNITS = Object.freeze({ duration: "min", distance: "m", maxSpeed: "km/h" });
const SOURCE_ATHLETE_VALUE_KEYS = { duration: "gpexe_time_min", distance: "gpexe_total_distance", maxSpeed: "gpexe_max_speed" };

const NO_VALUES = Object.freeze({ duration: null, distance: null, maxSpeed: null });

// The athlete's whole-session values of one preview entry; null entry (a
// raw-only sighting, or no sighting) gives nulls.
function sourceAthleteValues(entry) {
  const full = Array.isArray(entry?.results) ? entry.results.find((r) => r.level === "full") : null;
  const byKey = new Map((full?.values || []).map((v) => [v.metricKey, v.value]));
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    duration: num(byKey.get(SOURCE_ATHLETE_VALUE_KEYS.duration)),
    distance: num(byKey.get(SOURCE_ATHLETE_VALUE_KEYS.distance)),
    maxSpeed: num(byKey.get(SOURCE_ATHLETE_VALUE_KEYS.maxSpeed)),
  };
}

// The session's drill count from the raw snapshot's own field, which
// arrives as text: only a plain non-negative integer counts (Number("")
// would be 0, an invented number).
function sessionDrillsCount(raw) {
  return typeof raw === "string" && /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

export async function listSourceAthletes(teamId) {
  const rows = (await query(
    `with available as (
       select c.id as candidate_id, c.gpexe_team_session_id, c.session_started_at, c.session_label, c.status, c.last_seen_at,
              c.preview, c.raw_bundle
         from training_load.gpexe_import_candidates c
        where c.owner_team_id = $1 and c.raw_purged_at is null and c.raw_expires_at > now() and c.preview is not null
     ),
     sighting as (
       select c.candidate_id, c.gpexe_team_session_id, c.session_started_at, c.session_label, c.status, c.last_seen_at,
              c.preview->'session'->>'categoryName' as session_type, a.entry->>'gpexeAthleteId' as gpexe_athlete_id, a.entry,
              'preview' as evidence
         from available c
         cross join lateral jsonb_array_elements(c.preview->'athletes') as a(entry)
     ),
     latest as (
       select distinct on (gpexe_athlete_id) *
         from sighting
        order by gpexe_athlete_id, session_started_at desc nulls last, (status <> 'superseded') desc, last_seen_at desc, candidate_id desc
     ),
     -- Fallback: athletes named only by the raw rows of a refused (blocked)
     -- session, never seen in any available preview.
     raw_sighting as (
       select c.candidate_id, c.gpexe_team_session_id, c.session_started_at, c.session_label, c.status, c.last_seen_at,
              c.raw_bundle->'teamSession'->>'category_name' as session_type, r.row->>'athlete' as gpexe_athlete_id, null::jsonb as entry,
              'raw_snapshot' as evidence
         from available c
         cross join lateral jsonb_array_elements(c.raw_bundle->'athleteSessions') as r(row)
        where c.status = 'blocked'
          and jsonb_typeof(c.raw_bundle->'athleteSessions') = 'array'
          and r.row->>'teamsession' = c.gpexe_team_session_id
          and r.row->>'athlete' ~ '^[0-9]{1,12}$'
          and not exists (select 1 from sighting p where p.gpexe_athlete_id = r.row->>'athlete')
     ),
     latest_raw as (
       select distinct on (gpexe_athlete_id) *
         from raw_sighting
        order by gpexe_athlete_id, session_started_at desc nulls last, last_seen_at desc, candidate_id desc
     ),
     seen as (
       select * from latest
       union all
       select * from latest_raw
     ),
     link as (
       select l.id as link_id, l.gpexe_athlete_id, l.athlete_id, l.linked_at,
              coalesce(nullif(a.display_name, ''), a.full_name) as athlete_name,
              exists (select 1 from public.athlete_memberships m
                       where m.athlete_id = l.athlete_id and m.team_id = $1 and m.membership_type = 'team' and m.status = 'active') as athlete_active
         from training_load.gpexe_athlete_links l
         join public.athletes a on a.id = l.athlete_id
        where l.owner_team_id = $1 and l.unlinked_at is null
     )
     select coalesce(s.gpexe_athlete_id, k.gpexe_athlete_id) as gpexe_athlete_id,
            s.candidate_id, s.gpexe_team_session_id, s.session_started_at, s.session_label, s.session_type,
            s.status as candidate_status, s.last_seen_at, s.entry, s.evidence,
            (select c2.raw_bundle->'teamSession'->>'drills_count' from training_load.gpexe_import_candidates c2
              where c2.id = s.candidate_id and c2.owner_team_id = $1) as raw_drills_count,
            k.link_id, k.athlete_id, k.linked_at, k.athlete_name, k.athlete_active
       from seen s
       full outer join link k on k.gpexe_athlete_id = s.gpexe_athlete_id
      order by length(coalesce(s.gpexe_athlete_id, k.gpexe_athlete_id)), coalesce(s.gpexe_athlete_id, k.gpexe_athlete_id)`,
    [teamId],
  )).rows;
  return rows.map((r) => ({
    gpexeAthleteId: r.gpexe_athlete_id,
    status: !r.link_id ? "unlinked" : r.athlete_active ? "linked" : "linked_inactive",
    link: r.link_id ? { id: r.link_id, athleteId: r.athlete_id, athleteName: r.athlete_name, linkedAt: r.linked_at } : null,
    lastSeen: r.candidate_id ? {
      candidateId: r.candidate_id, gpexeTeamSessionId: r.gpexe_team_session_id, sessionStartedAt: r.session_started_at,
      sessionLabel: r.session_label, sessionType: r.session_type, candidateStatus: r.candidate_status, lastSeenAt: r.last_seen_at,
      evidence: r.evidence, sessionDrillsCount: sessionDrillsCount(r.raw_drills_count),
    } : null,
    values: r.candidate_id && r.entry ? sourceAthleteValues(r.entry) : { ...NO_VALUES },
  }));
}

export async function listAthleteLinks(teamId) {
  return (await query(
    `select l.id, l.gpexe_athlete_id, l.athlete_id, l.linked_at, coalesce(nullif(a.display_name, ''), a.full_name) as athlete_name
     from training_load.gpexe_athlete_links l join public.athletes a on a.id = l.athlete_id
     where l.owner_team_id = $1 and l.unlinked_at is null order by l.gpexe_athlete_id`,
    [teamId],
  )).rows.map((r) => ({ id: r.id, gpexeAthleteId: r.gpexe_athlete_id, athleteId: r.athlete_id, athleteName: r.athlete_name, linkedAt: r.linked_at }));
}

// A link says which OptiMove athlete a GPEXE athlete number belongs to, and
// that number means something only inside the team's own GPEXE team. So both
// writes take the same team import lock a connection change takes: a link
// made while a change is being decided would otherwise be invisible to its
// guard and end up describing a different GPEXE team's athlete
// (db-reviewer, 2026-09-20).
async function writeUnderTeamLock(teamId, write) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local lock_timeout = '${SETTINGS_LOCK_TIMEOUT_MS}ms'`);
    await lockTeamForImport(client, teamId);
    const result = await write(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error.code === "55P03" || error.code === "40P01") {
      throw new GpexeImportServiceError(409, "gpexe_change_busy", "A GPEXE check, import or connection change is running for this team. Try again when it has finished.");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function linkAthlete(teamId, { gpexeAthleteId, athleteId, userId }) {
  if (typeof gpexeAthleteId !== "string" || !/^[0-9]{1,12}$/.test(gpexeAthleteId)) throw new GpexeImportServiceError(400, "invalid_gpexe_athlete_id", "gpexeAthleteId must be a numeric GPEXE athlete id.");
  try {
    return await writeUnderTeamLock(teamId, async (client) => {
      // A GPEXE athlete number belongs to a GPEXE team: without the team's
      // connection there is nothing it could mean.
      const connected = (await client.query(`select 1 from training_load.gpexe_team_settings where owner_team_id = $1`, [teamId])).rowCount;
      if (!connected) throw new GpexeImportServiceError(409, "gpexe_team_not_configured", "No GPEXE team is configured for this team yet, so a GPEXE athlete cannot be linked.");
      const row = (await client.query(
        `insert into training_load.gpexe_athlete_links (owner_team_id, gpexe_athlete_id, athlete_id, linked_by_user_id) values ($1,$2,$3,$4) returning id`,
        [teamId, gpexeAthleteId, athleteId, userId],
      )).rows[0];
      return { id: row.id };
    });
  } catch (error) {
    if (error instanceof GpexeImportServiceError) throw error;
    throw mapTriggerError(error, "athlete_not_in_team");
  }
}

export async function unlinkAthlete(teamId, { linkId, userId }) {
  try {
    return await writeUnderTeamLock(teamId, async (client) => {
      const r = await client.query(
        `update training_load.gpexe_athlete_links set unlinked_at = now(), unlinked_by_user_id = $3
          where id = $1 and owner_team_id = $2 and unlinked_at is null returning id`,
        [linkId, teamId, userId],
      );
      return r.rowCount === 1;
    });
  } catch (error) {
    // Same as linkAthlete: a database rule that refuses this is answered with
    // a stable code, never with the database's own text.
    if (error instanceof GpexeImportServiceError) throw error;
    throw mapTriggerError(error, "link_not_removed");
  }
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

// ---------------------------------------------------------------------------
// Approval and import (phase F2)
// ---------------------------------------------------------------------------

// Tests look inside the approval transaction right after the import ran and
// before the preview hash is compared (the rows are there, uncommitted).
let approvalObserver = null;
export function setApprovalObserver(observer) {
  approvalObserver = observer ?? null;
}

// Tests replace the approval's COMMIT (e.g. commit and then lose the
// answer, or lose the connection before it), to prove what the caller is
// told when the outcome of the commit is not known.
let approvalCommit = null;
// How long the approval waits for the answer to its COMMIT. Past this the
// outcome is unknown: the connection is closed and the approval is looked
// for on another one (resolveUncertainCommit). A COMMIT itself is short;
// this only has to cover a slow disk or network, not the import.
export const COMMIT_ANSWER_TIMEOUT_MS = 15_000;
let commitAnswerTimeoutMs = COMMIT_ANSWER_TIMEOUT_MS;
export function setApprovalCommitForTests(commit, { timeoutMs = COMMIT_ANSWER_TIMEOUT_MS } = {}) {
  approvalCommit = commit ?? null;
  commitAnswerTimeoutMs = timeoutMs;
}

// The check after an unconfirmed COMMIT runs exactly when the database may
// be unreachable, so it is bounded: past this, the answer is 503
// import_outcome_unknown instead of a request that hangs.
export const UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS = 5_000;
let uncertainCommitCheckTimeoutMs = UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS;
// Tests make that check fail or hang (the fault gets the check's own
// connection, e.g. to run a query that never answers), and shorten its bound.
let uncertainCommitCheckFault = null;
export function setUncertainCommitCheckForTests({ fault = null, timeoutMs = UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS } = {}) {
  uncertainCommitCheckFault = fault;
  uncertainCommitCheckTimeoutMs = timeoutMs;
}

// Is the approval committed? Bounded as a whole, and it never leaves a pool
// connection behind: getting a connection and the query share one deadline;
// a connection that arrives after the deadline is closed at once, and one
// whose query did not answer in time is closed instead of returned.
async function approvalIsCommitted(approvalId, teamId, ms) {
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
  let broken = false;
  try {
    if (uncertainCommitCheckFault) {
      const fault = Promise.resolve().then(() => uncertainCommitCheckFault(client));
      fault.catch(() => {});
      await withinBound(fault, left());
    }
    const answer = client.query({
      text: `select 1 from training_load.gpexe_import_approvals a
               join training_load.gpexe_import_candidates c on c.id = a.candidate_id
              where a.id = $1 and a.owner_team_id = $2 and c.status = 'imported'`,
      values: [approvalId, teamId],
      query_timeout: left(),
    });
    answer.catch(() => {});
    return (await withinBound(answer, left())).rowCount === 1;
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    client.release(broken ? true : undefined);
  }
}

function withinBound(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The COMMIT was sent but its answer did not arrive: the import may or may
// not be in the database. Never "nothing was imported". The approval row is
// looked for on another connection: found, the import IS committed and the
// caller is told so; not found (it may not be visible yet, or never will
// be) or not readable, the caller gets 503 import_outcome_unknown with how
// to check. Approving again is safe either way (an imported candidate
// answers 409 already_imported).
async function resolveUncertainCommit(teamId, candidateId, { approvalId, result, commitError }) {
  console.error(`[gpexe] approval ${approvalId} of candidate ${candidateId}: the COMMIT was not confirmed (${commitError?.code ?? ""} ${commitError?.message}); checking whether it is in the database`);
  let found = false;
  try {
    found = await approvalIsCommitted(approvalId, teamId, uncertainCommitCheckTimeoutMs);
  } catch (error) {
    console.error(`[gpexe] checking approval ${approvalId} after an unconfirmed COMMIT failed: ${error?.message}`);
  }
  if (found) return { ...result, commitConfirmation: "verified_after_commit_error" };
  throw refusal(503, "import_outcome_unknown",
    "The database did not confirm the import, and it could not be verified yet. It may or may not have been imported; do not assume either. Check the candidate or the approval before doing anything else.",
    {
      verify: {
        candidateId,
        candidateHref: reviewAgain(teamId, candidateId).href,
        approvalId,
        approvalHref: `/api/training-load/gpexe/teams/${teamId}/approvals/${approvalId}`,
        imported: "The approval exists and the candidate's status is 'imported' (with this approval).",
        notImported: "The approval does not exist (404) and the candidate is still 'pending'.",
        retry: "Approving again is safe: an imported candidate answers 409 already_imported, a pending one is approved normally.",
      },
    });
}

// Where a caller whose preview is out of date reviews the candidate again.
function reviewAgain(teamId, candidateId) {
  return { candidateId, href: `/api/training-load/gpexe/teams/${teamId}/candidates/${candidateId}` };
}

function refusal(status, code, message, details) {
  const error = new GpexeImportServiceError(status, code, message);
  if (details) error.details = details;
  return error;
}

function previewChanged(teamId, candidateId, message) {
  return refusal(409, "preview_changed", message, { reviewAgain: reviewAgain(teamId, candidateId) });
}

// The preview recomputed under the approval's locks differs from the one
// that was approved, and the approval was rolled back. The candidate gets
// the recomputed preview, so the next review shows what an import would do
// now, unless somebody refreshed it in the meantime.
async function storeRefreshedPreview(candidateId, { expectedPreviewHash, preview, previewHash }) {
  await query(
    `update training_load.gpexe_import_candidates
        set preview = $3, preview_hash = $4, preview_computed_at = now(), status = $5
      where id = $1 and preview_hash = $2 and status in ('pending', 'blocked') and raw_bundle is not null`,
    [candidateId, expectedPreviewHash, preview, previewHash, preview.status === "blocked" ? "blocked" : "pending"],
  );
}

const HASH = /^[0-9a-f]{64}$/;

// Approves one candidate as a whole and imports it, in ONE transaction:
//   1. the approver's right, held FOR SHARE (lock_gpexe_import_approver);
//   2. the candidate, FOR UPDATE: pending, snapshot not expired, the stored
//      preview is the one the caller reviewed, and every change to an
//      already imported result is accepted (acceptChanges);
//   3. the team's import lock, the import itself, and the preview recomputed
//      from what the import did (previewLocked);
//   4. the recomputed preview hash must equal the approved one; otherwise
//      EVERYTHING is rolled back, including what the import had written, and
//      the caller is sent back to review the candidate;
//   5. the approval row and the candidate becoming 'imported' (its snapshot
//      kept 90 more days); commit.
// Nothing is written before step 3, and nothing survives a refusal.
export async function approveCandidate(teamId, candidateId, { userId, previewHash, acceptChanges }) {
  if (typeof previewHash !== "string" || !HASH.test(previewHash)) {
    throw refusal(400, "invalid_preview_hash", "previewHash must be the hash of the preview you reviewed.");
  }
  if (acceptChanges !== undefined && typeof acceptChanges !== "boolean") {
    throw refusal(400, "invalid_accept_changes", "acceptChanges must be true or false.");
  }
  if (!applyEnabled()) throw refusal(409, "import_switch_off", applySwitchInfo().message);

  const client = await pool.connect();
  let refreshed = null;
  // commitSent: no ROLLBACK after the COMMIT was sent. commitUncertain: the
  // COMMIT got no answer, so this connection is not returned to the pool.
  let commitSent = false;
  let commitUncertain = false;
  let released = false;
  try {
    await client.query("begin");
    // Step 1.
    const right = (await client.query(
      `select basis, grant_id from training_load.lock_gpexe_import_approver($1, $2) limit 1`,
      [userId, teamId],
    )).rows[0];

    // Step 2.
    const row = (await client.query(
      `select id, gpexe_team_session_id, bundle_hash, raw_bundle, raw_expires_at, raw_purged_at, status,
              superseded_by_candidate_id, preview, preview_hash
         from training_load.gpexe_import_candidates where id = $1 and owner_team_id = $2 for update`,
      [candidateId, teamId],
    )).rows[0];
    if (!row) throw refusal(404, "notFound", "Not found.");
    if (row.status === "imported") throw refusal(409, "already_imported", "This candidate has already been imported.");
    if (row.status === "superseded") {
      throw refusal(409, "superseded_by_newer_data", "GPEXE has newer data for this session; review the newer candidate.",
        { reviewAgain: reviewAgain(teamId, row.superseded_by_candidate_id) });
    }
    if (row.status === "blocked") throw refusal(409, "blocked", "This session is blocked; the preview names the reason and the step that lifts it.");
    if (!snapshotState(row).available) throw refusal(409, "snapshot_expired_check_again", "The GPEXE data of this candidate has expired; press \"Check now\" again.");
    if (row.preview_hash !== previewHash) {
      throw previewChanged(teamId, candidateId, "The preview was recomputed after you reviewed it; review the candidate again.");
    }
    if (row.preview?.status === "no_changes") throw refusal(409, "nothing_to_import", "This candidate would write nothing.");
    const changesToImported = row.preview?.changesToImported?.length ?? 0;
    if (changesToImported > 0 && acceptChanges !== true) {
      throw refusal(409, "changes_need_acceptance",
        `This import changes ${changesToImported} already imported result(s); accept them explicitly (acceptChanges).`,
        { changesToImported });
    }

    // Step 3: from here on the import writes, uncommitted.
    let plan;
    try {
      plan = buildGpexeImportPlan(row.raw_bundle);
    } catch (error) {
      if (!(error instanceof GpexeMappingError)) throw error;
      // The candidate becomes blocked with the mapping reason, so the next
      // review shows why and does not lead back here.
      const blocked = blockedByMapping(row.raw_bundle, error);
      refreshed = { expectedPreviewHash: row.preview_hash, preview: blocked.preview, previewHash: blocked.previewHash };
      throw previewChanged(teamId, candidateId, "The stored GPEXE data can no longer be imported; nothing was imported. Review the candidate again.");
    }
    await lockTeamForImport(client, teamId);
    const fresh = await previewLocked(client, { bundle: row.raw_bundle, plan, ownerTeamId: teamId, performedByUserId: userId });
    if (approvalObserver) await approvalObserver({ client, candidateId, freshPreviewHash: fresh.previewHash });

    // Step 4.
    if (fresh.previewHash !== previewHash || fresh.preview.status !== "ready" || !fresh.summary) {
      refreshed = { expectedPreviewHash: row.preview_hash, preview: fresh.preview, previewHash: fresh.previewHash };
      throw previewChanged(teamId, candidateId, "What this import would do has changed since the preview was made; nothing was imported. Review the candidate again.");
    }

    // Step 5.
    const summary = fresh.summary;
    const approval = (await client.query(
      `insert into training_load.gpexe_import_approvals
         (candidate_id, owner_team_id, gpexe_team_session_id, bundle_hash, preview_hash, approved_by_user_id, approval_basis,
          approver_grant_id, changes_to_imported, changes_accepted, metric_event_id, activity_id, import_batch_id, import_counts)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id, approved_at`,
      [candidateId, teamId, row.gpexe_team_session_id, row.bundle_hash, previewHash, userId, right.basis, right.grant_id,
        changesToImported, changesToImported > 0, summary.eventId, summary.activityId, summary.importBatchId, summary.counts],
    )).rows[0];
    await client.query(
      `update training_load.gpexe_import_candidates
          set status = 'imported', imported_at = now(), raw_expires_at = now() + make_interval(days => $2)
        where id = $1`,
      [candidateId, RAW_RETENTION_IMPORTED_DAYS],
    );
    const result = {
      outcome: "imported",
      commitConfirmation: "confirmed",
      approval: { id: approval.id, approvedAt: approval.approved_at, basis: right.basis, changesAccepted: changesToImported },
      import: { eventId: summary.eventId, activityId: summary.activityId, importBatchId: summary.importBatchId, counts: summary.counts },
    };
    // From here on "nothing was imported" can no longer be said: once the
    // COMMIT is sent, a missing answer is an unknown outcome.
    commitSent = true;
    const committing = Promise.resolve().then(() => (approvalCommit ? approvalCommit(client) : client.query("commit")));
    committing.catch(() => {}); // a COMMIT that loses the race may still fail later
    try {
      // An answer that never comes is bounded like a lost one.
      await withinBound(committing, commitAnswerTimeoutMs);
    } catch (commitError) {
      commitUncertain = true;
      // The connection is not trusted any more: close it first (this also
      // ends a COMMIT still waiting on it), then look on another one.
      released = true;
      client.release(true);
      return await resolveUncertainCommit(teamId, candidateId, { approvalId: approval.id, result, commitError });
    }
    return result;
  } catch (error) {
    if (!commitSent) await client.query("rollback").catch(() => {});
    if (refreshed) {
      await storeRefreshedPreview(candidateId, refreshed)
        .catch((e) => console.error(`[gpexe] storing the refreshed preview of ${candidateId} failed: ${e?.message}`));
    }
    if (error instanceof GpexeImportServiceError) throw error;
    if (error?.code === "42501") throw refusal(403, "not_an_approver", "You may not approve GPEXE imports for this team.");
    // Anything else (a database guard firing, a bug) is logged here and
    // answered with a stable code; its text never reaches the caller.
    console.error(`[gpexe] approval of candidate ${candidateId} failed: ${error?.code ?? ""} ${error?.message}`);
    throw refusal(500, "internal_error", "The approval failed on the server; nothing was imported.");
  } finally {
    // A connection whose COMMIT went unanswered is not trusted again.
    if (!released) client.release(commitUncertain ? true : undefined);
  }
}
