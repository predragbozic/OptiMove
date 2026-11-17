// v62 (mixed_timezones (b)): a team's session time zone. The GPEXE importer uses it ONLY for a session whose tracks report
// more than one zone (buildGpexeImportPlan's teamTimezone); a session whose tracks agree keeps its own zone. A platform
// admin, or (the owner's decision of 2026-11-16) the active admin of the team's own club in that club's workspace, sets or
// clears it, with a reason, under the team's import lock, so it never changes under a running check, preview or approval
// of that team. The right is checked again inside the write, after the lock (users row first, then the role, the team and
// the club, the revocations' order): a right, team or club lost meanwhile writes nothing and answers the identical 404. The database (v62) checks the zone again against pg_timezone_names and keeps every value in an
// append-only history.
import { pool, query } from "./db.js";
import { lockTeamForImport } from "./gpexeImportWriter.js";
import { validIanaZone } from "./gpexeTeamTimezoneRead.js";

export { teamSessionTimezone, validIanaZone } from "./gpexeTeamTimezoneRead.js";

export class TeamTimezoneError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const TIMEZONE_LOCK_TIMEOUT_MS = 3_000;
// The two bases that may set the zone (the route decides which one a request has).
export const TIMEZONE_BASES = Object.freeze(["platform_admin", "club_admin"]);

// Test seam (never set by the application): runs after the team's import lock, before the right is checked again.
let writeHoldForTests = null;
export function setTimezoneWriteHoldForTests(fn) {
  writeHoldForTests = fn ?? null;
}

// The right, read FOR SHARE inside the write: the active user first, in its own statement, then the role of the basis,
// then the active team of the club, then the active club (`.claude/rules/migrations.md`: users before the role row, as the
// revocations lock them).
async function rightStillHolds(client, { userId, basis, clubId }, teamId) {
  const user = await client.query(`select 1 from public.users where id = $1 and is_active = true for share`, [userId]);
  if (user.rowCount === 0) return false;
  const role = basis === "platform_admin"
    ? await client.query(`select 1 from public.user_global_roles where user_id = $1 and role = 'platform_admin' and is_active = true for share`, [userId])
    : basis === "club_admin"
      ? await client.query(`select 1 from public.user_club_roles where user_id = $1 and club_id = $2 and role = 'club_admin' and is_active = true for share`, [userId, clubId])
      : { rowCount: 0 };
  if (role.rowCount === 0) return false;
  const team = await client.query(`select 1 from public.teams where id = $1 and club_id = $2 and coalesce(is_active, true) for share`, [teamId, clubId]);
  if (team.rowCount === 0) return false;
  const club = await client.query(`select 1 from public.clubs where id = $1 and coalesce(is_active, true) for share`, [clubId]);
  return club.rowCount > 0;
}
const REASON_MAX = 500;
export const TIMEZONE_HISTORY_LIMIT = 50;

// What the settings screen shows: the zone in force, who set it, when and why. A platform admin's read.
export async function readTeamSessionTimezone(teamId) {
  const row = (await query(
    `select z.timezone, z.set_at, z.reason, coalesce(nullif(u.display_name, ''), u.full_name, u.email) as set_by_name
       from training_load.gpexe_team_session_timezones z join public.users u on u.id = z.set_by_user_id
      where z.owner_team_id = $1`,
    [teamId],
  )).rows[0];
  const history = (await query(
    `select h.timezone, h.set_at, h.reason, coalesce(nullif(u.display_name, ''), u.full_name, u.email) as set_by_name
       from training_load.gpexe_team_session_timezone_history h join public.users u on u.id = h.set_by_user_id
      where h.owner_team_id = $1
      order by h.set_at desc, h.id desc
      limit $2`,
    [teamId, TIMEZONE_HISTORY_LIMIT],
  )).rows;
  const shape = (r) => ({ timezone: r.timezone, setAt: r.set_at, reason: r.reason, setByName: r.set_by_name });
  return { current: row ? shape(row) : null, history: history.map(shape) };
}

// Sets (or, with timezone null, clears) the team's zone. The same value again writes nothing. A reason is required.
// `basis` and `clubId` are the request's (the route's access); the right is checked again under the lock.
export async function setTeamSessionTimezone(teamId, { timezone, reason, userId, basis, clubId }) {
  if (!TIMEZONE_BASES.includes(basis) || !clubId) throw new TeamTimezoneError(404, "notFound", "");
  if (timezone !== null && !validIanaZone(timezone)) {
    throw new TeamTimezoneError(400, "invalid_timezone", "Choose a time zone from the list (for example Europe/Sarajevo).");
  }
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > REASON_MAX) {
    throw new TeamTimezoneError(400, "reason_required", `Say why the time zone is set or changed (at most ${REASON_MAX} characters).`);
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local lock_timeout = '${TIMEZONE_LOCK_TIMEOUT_MS}ms'`);
    await lockTeamForImport(client, teamId);
    if (writeHoldForTests) await writeHoldForTests(client);
    if (!(await rightStillHolds(client, { userId, basis, clubId }, teamId))) {
      throw new TeamTimezoneError(404, "notFound", "");
    }
    const current = (await client.query(
      `select timezone from training_load.gpexe_team_session_timezones where owner_team_id = $1 for update`,
      [teamId],
    )).rows[0];
    if ((current ? current.timezone : null) === timezone) {
      // Idempotent: nothing is written, so nothing is appended to the history.
      await client.query("commit");
      return readBackAfterCommit(teamId, timezone);
    }
    await client.query(
      `insert into training_load.gpexe_team_session_timezones (owner_team_id, timezone, set_by_user_id, set_at, reason)
       values ($1, $2, $3, now(), $4)
       on conflict (owner_team_id) do update set timezone = excluded.timezone, set_by_user_id = excluded.set_by_user_id,
         set_at = excluded.set_at, reason = excluded.reason`,
      [teamId, timezone, userId, reason.trim()],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error instanceof TeamTimezoneError) throw error;
    if (error.code === "23514" && error.constraint === "gpexe_team_session_timezones_known_zone") {
      throw new TeamTimezoneError(400, "invalid_timezone", "Choose a time zone from the list (for example Europe/Sarajevo).");
    }
    if (error.code === "55P03" || error.code === "40P01" || /GPEXE check, import or connection change is running/.test(error.message || "")) {
      throw new TeamTimezoneError(409, "gpexe_change_busy", "A GPEXE check, import or connection change is running for this team. Try again when it has finished.");
    }
    throw error;
  } finally {
    client.release();
  }
  return readBackAfterCommit(teamId, timezone);
}

// After a confirmed COMMIT the zone is saved: a failed read-back never turns that into a failure. It answers the saved zone
// with readError, and the screen says the list is out of date (the code review of v62, the post-COMMIT rule).
let readBackForTests = null;
export function setTimezoneReadBackForTests(fn) {
  readBackForTests = fn ?? null;
}
async function readBackAfterCommit(teamId, timezone) {
  try {
    if (readBackForTests) await readBackForTests();
    return await readTeamSessionTimezone(teamId);
  } catch (error) {
    console.error(`[gpexe] reading the session time zone of team ${teamId} after it was saved failed: ${error?.code || error?.message || error}`);
    return { current: { timezone, setAt: null, reason: null, setByName: null }, history: null, readError: true };
  }
}
