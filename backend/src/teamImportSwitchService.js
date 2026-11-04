// U2 (v56): the import switch per team, its conditions and the records of the
// two dated prerequisites (backup, restore probe) and two recorded facts
// (wrong-link procedure, archived-team check stop).
//
// Every write goes through a sanctioned database function that derives the
// acting user's right and basis itself (training_load.set_team_import_switch,
// record_import_prerequisite); this module only calls them in a bounded
// transaction and turns the database's refusals into stable codes. The body
// never names an actor or a basis.
import { pool, query } from "./db.js";
import { GpexeImportServiceError } from "./gpexeImportService.js";

const KINDS = ["backup", "restore_probe", "wrong_link_procedure", "archived_team_check_stop"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function isRealDay(text) {
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}
const BACKUP_MAX_AGE_DAYS = 2;
const PROBE_MAX_AGE_DAYS = 35;

function refusal(status, code, message, details) {
  const error = new GpexeImportServiceError(status, code, message);
  if (details) error.details = details;
  return error;
}

const CONDITION_TEXT = {
  backup: "A database backup dated within the last 2 days must be recorded.",
  restore_probe: "A restore probe dated within the last 35 days must be recorded.",
  wrong_link_procedure: "The procedure for a wrongly linked athlete must be recorded as available (needed for team mode).",
  archived_team_check_stop: "The stop of a running check when its team is archived must be recorded as verified (needed for team mode).",
};

// What the screens show. `met` for the two dated items is judged by the
// database when the switch is turned on; here the same arithmetic is shown.
export async function readTeamImportSwitch(teamId, { detail }) {
  const sw = (await query(
    `select s.enabled, s.mode, s.changed_at, s.changed_by_user_id, s.change_reason
       from training_load.gpexe_team_import_switch s where s.owner_team_id = $1`,
    [teamId],
  )).rows[0];
  const base = { enabled: sw ? sw.enabled === true : false, mode: sw ? sw.mode : "pilot", configured: Boolean(sw) };
  if (!detail) return base;
  const records = (await query(
    `select distinct on (kind) kind, recorded_on::text as recorded_on, recorded_at, recorded_by_user_id
       from training_load.gpexe_import_prerequisite_records order by kind, recorded_on desc, recorded_at desc`,
  )).rows;
  const byKind = Object.fromEntries(records.map((r) => [r.kind, r]));
  const today = (await query(`select current_date::text as d`)).rows[0].d;
  const ageDays = (kind) => (byKind[kind] ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${byKind[kind].recorded_on}T00:00:00Z`)) / 86400000) : null);
  const conditions = [
    { kind: "backup", required: "pilot_and_team", met: ageDays("backup") !== null && ageDays("backup") >= 0 && ageDays("backup") <= BACKUP_MAX_AGE_DAYS, recordedOn: byKind.backup?.recorded_on ?? null, maxAgeDays: BACKUP_MAX_AGE_DAYS, text: CONDITION_TEXT.backup },
    { kind: "restore_probe", required: "pilot_and_team", met: ageDays("restore_probe") !== null && ageDays("restore_probe") >= 0 && ageDays("restore_probe") <= PROBE_MAX_AGE_DAYS, recordedOn: byKind.restore_probe?.recorded_on ?? null, maxAgeDays: PROBE_MAX_AGE_DAYS, text: CONDITION_TEXT.restore_probe },
    { kind: "wrong_link_procedure", required: "team", met: Boolean(byKind.wrong_link_procedure), recordedOn: byKind.wrong_link_procedure?.recorded_on ?? null, maxAgeDays: null, text: CONDITION_TEXT.wrong_link_procedure },
    { kind: "archived_team_check_stop", required: "team", met: Boolean(byKind.archived_team_check_stop), recordedOn: byKind.archived_team_check_stop?.recorded_on ?? null, maxAgeDays: null, text: CONDITION_TEXT.archived_team_check_stop },
  ];
  const history = (await query(
    `select h.enabled, h.mode, h.basis, h.changed_at, h.change_reason
       from training_load.gpexe_team_import_switch_history h where h.owner_team_id = $1 order by h.changed_at desc, h.id limit 20`,
    [teamId],
  )).rows.map((h) => ({ enabled: h.enabled, mode: h.mode, basis: h.basis, changedAt: h.changed_at, reason: h.change_reason }));
  return { ...base, changedAt: sw?.changed_at ?? null, reason: sw?.change_reason ?? null, conditions, history };
}

async function inBoundedTransaction(fn) {
  const client = await pool.connect();
  let released = false;
  client.on("error", () => {});
  try {
    await client.query("begin isolation level read committed");
    await client.query("set local lock_timeout = '3s'");
    await client.query("set local statement_timeout = '10s'");
    await client.query("set local idle_in_transaction_session_timeout = '15s'");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try { await client.query("rollback"); } catch { client.release(true); released = true; }
    throw error;
  } finally {
    if (!released) client.release();
  }
}

function mapDatabaseRefusal(error) {
  if (error instanceof GpexeImportServiceError) return error;
  const message = String(error?.message || "");
  if (error?.code === "55000" && message.startsWith("team_import_condition:")) {
    const kind = message.slice("team_import_condition:".length);
    if (KINDS.includes(kind)) return refusal(409, "team_import_condition_unmet", CONDITION_TEXT[kind], { condition: kind });
  }
  if (error?.code === "42501") {
    if (/team_import_mode_platform_admin_only|team_import_pilot_platform_admin_only/.test(message)) {
      return refusal(403, "forbidden", "Only a platform administrator can move a team between pilot and team mode, or turn a pilot team on.");
    }
    return refusal(404, "notFound", "Not found.");
  }
  if (error?.code === "22023") return refusal(400, "invalid_request", "Check the values sent: a reason of 1 to 500 characters is required.");
  if (error?.code === "55P03" || error?.code === "40P01") return refusal(409, "try_again", "Another change was running; nothing was changed. Try again in a moment.");
  return null;
}

// enabled: boolean; mode: "pilot" | "team" | undefined (keeps the current one).
export async function setTeamImportSwitch(teamId, userId, { enabled, mode, reason }) {
  if (typeof enabled !== "boolean") throw refusal(400, "invalid_request", "enabled must be true or false.");
  if (mode !== undefined && mode !== "pilot" && mode !== "team") throw refusal(400, "invalid_request", "mode must be pilot or team.");
  if (typeof reason !== "string") throw refusal(400, "invalid_request", "A reason is required.");
  try {
    return await inBoundedTransaction(async (client) => {
      const row = (await client.query(
        `select enabled, mode, changed_at from training_load.set_team_import_switch($1, $2, $3, $4, $5)`,
        [userId, teamId, enabled, mode ?? null, reason],
      )).rows[0];
      return { enabled: row.enabled, mode: row.mode, changedAt: row.changed_at };
    });
  } catch (error) {
    const mapped = mapDatabaseRefusal(error);
    if (mapped) throw mapped;
    throw error;
  }
}

export async function recordImportPrerequisite(userId, { kind, recordedOn, note }) {
  if (!KINDS.includes(kind)) throw refusal(400, "invalid_request", "Unknown kind.");
  if (typeof recordedOn !== "string" || !DATE.test(recordedOn) || !isRealDay(recordedOn)) {
    throw refusal(400, "invalid_request", "recordedOn must be a real date, YYYY-MM-DD.");
  }
  if (note !== undefined && note !== null && typeof note !== "string") throw refusal(400, "invalid_request", "note must be text.");
  try {
    return await inBoundedTransaction(async (client) => {
      const id = (await client.query(
        `select training_load.record_import_prerequisite($1, $2, $3::date, $4) as id`,
        [userId, kind, recordedOn, note ?? null],
      )).rows[0].id;
      return { id, kind, recordedOn };
    });
  } catch (error) {
    const mapped = mapDatabaseRefusal(error);
    if (mapped) {
      // A non-platform admin never learns that the route exists.
      if (mapped.code === "notFound") throw refusal(404, "notFound", "Not found.");
      throw mapped;
    }
    throw error;
  }
}
