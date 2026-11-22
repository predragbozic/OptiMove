// A session's type changed after the import, and an athlete's own type in a session (ST-3 of
// docs/ai/session-type-plan.md, sections 3, 5 and 10; migration v88 holds the rules whoever writes).
//
//   POST /api/training-activity/:activityId/type                    { activityTypeKey, reason?, requestKey }
//   PUT  /api/training-activity/:activityId/roster/:athleteId/type  { activityTypeKey | null, reason?, requestKey }
//
// Who: the roster decider of the session's team through the ACTIVE workspace (resolveRosterTarget's basis: the team's
// coach, the club's admin, a platform admin). Everyone else, a missing session and a session of an archived team get
// the identical 404 (ADR-006).
//
// Each command is ONE transaction, in this lock order:
//   1. training.lock_activity_decider(user, team, basis)  - the team, its club, the acting user, the role row
//                                                           (users before the role row, v54); 42501 -> 403
//   2. the (user, requestKey) advisory lock, then the replay read (a saved answer wins over the present state)
//   3. the addressed activity row FOR UPDATE              - a merge or a reparent locks it the same way, so a session
//                                                           that is canonical under this lock stays canonical
//   4. the participant row(s) FOR UPDATE, ascending
//   5. the exception row(s)
//   6. the type row FOR SHARE (training.session_type_offered; inside v85's and v88's guards too)
//   7. the request row, the deferred checks, a bounded COMMIT.
// No team import lock is taken: a type change never waits for an import, and an import never touches a type or an
// exception of an imported session.
//
// A command that changes nothing (the same type again, clearing an exception that is not there) answers 200 with
// `changed: false` and writes nothing, so its key stays free. Stable codes only; a database message never reaches the
// client.
import crypto from "node:crypto";
import { pool } from "./db.js";
import { RosterError, noRoster, resolveRosterTarget } from "./activityRoster.js";
import {
  COMMIT_ANSWER_TIMEOUT_MS, NOTHING_SAVED, OUTCOME_UNKNOWN, UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS,
  commitCertainlyRefused, requestHash, withinBound,
} from "./activityRosterCommands.js";
import { boundedText } from "./metricTextRules.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A system type's key or a club type's generated key (v85's key shapes).
const TYPE_KEY_PATTERN = /^(?:[a-z][a-z0-9_]{1,40}|c_[0-9a-f]{8}_[a-z0-9_]{1,40})$/;
export const MAX_TYPE_REASON_LENGTH = 300;
const LOCK_TIMEOUT = "5s";
const STATEMENT_TIMEOUT = "10s";
const IDLE_TIMEOUT = "10s";

const notFound = () => new RosterError(404, "notFound", "Not found.");
const bad = (code, message) => new RosterError(400, code, message);
const conflict = (code, message, details) => new RosterError(409, code, message, details);
const notOffered = () => conflict("session_type_not_offered", "This session type is not offered to this team.");
const sameAsSession = () => conflict("same_as_session", "This is the session's own type.");

const isUuid = (value) => typeof value === "string" && UUID_PATTERN.test(value);

// Test seams only (backend/tests/session-types-st3.test.mjs). Never set in the app.
let testHooks = {};
export function setTypeChangeTestHooks(hooks) {
  testHooks = hooks ?? {};
}

// ---------------------------------------------------------------------------
// Input (400s, before any database work)
// ---------------------------------------------------------------------------
function requestKeyOf(body) {
  if (!isUuid(body?.requestKey)) throw bad("invalid_request_key", "requestKey must be a UUID.");
  return body.requestKey.toLowerCase();
}
function reasonOf(body) {
  const raw = body?.reason;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw bad("invalid_reason", "reason must be text.");
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!boundedText(trimmed, MAX_TYPE_REASON_LENGTH)) throw bad("invalid_reason", `reason is one line of at most ${MAX_TYPE_REASON_LENGTH} visible characters.`);
  return trimmed;
}
function typeKeyOf(value) {
  if (typeof value !== "string" || !TYPE_KEY_PATTERN.test(value)) throw bad("invalid_session_type", "activityTypeKey must be a session type's key.");
  return value;
}
function objectBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("invalid_body", "A JSON object is required.");
}

export function validateSessionType(body, activityId) {
  objectBody(body);
  const requestKey = requestKeyOf(body);
  return { requestKey, canonical: { operation: "session_type", activityId, activityTypeKey: typeKeyOf(body.activityTypeKey), reason: reasonOf(body) } };
}

export function validateAthleteType(body, activityId, athleteId) {
  if (!isUuid(athleteId)) throw notFound();
  objectBody(body);
  const requestKey = requestKeyOf(body);
  if (!Object.prototype.hasOwnProperty.call(body, "activityTypeKey")) throw bad("invalid_session_type", "activityTypeKey is a session type's key, or null to clear the athlete's own type.");
  const activityTypeKey = body.activityTypeKey === null ? null : typeKeyOf(body.activityTypeKey);
  return { requestKey, canonical: { operation: "athlete_type", activityId, athleteId: athleteId.toLowerCase(), activityTypeKey, reason: reasonOf(body) } };
}

// ---------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------
// A type the team may newly take: a system type or its own club's, and active. Another club's type is refused by a
// plain read, so its row is never locked or waited on; an offered one is then locked FOR SHARE (an archive waits).
async function assertOffered(client, typeKey, clubId) {
  const visible = (await client.query(
    `select 1 from training.activity_types where key = $1 and (owner_scope = 'system' or owner_club_id = $2)`, [typeKey, clubId],
  )).rowCount === 1;
  if (!visible) throw notOffered();
  const offered = (await client.query(`select training.session_type_offered($1, $2, true) as ok`, [typeKey, clubId])).rows[0].ok;
  if (!offered) throw notOffered();
}

async function findStoredResult(userId, requestKey, hash, ms) {
  const deadline = Date.now() + ms;
  const left = () => Math.max(1, deadline - Date.now());
  const connecting = pool.connect();
  let checker;
  try {
    checker = await withinBound(connecting, left());
  } catch (error) {
    connecting.then((late) => late.release(true), () => {});
    throw error;
  }
  let broken = false;
  const onError = () => { broken = true; };
  checker.on("error", onError);
  try {
    if (testHooks.checkFault) {
      const fault = Promise.resolve().then(() => testHooks.checkFault(checker));
      fault.catch(() => {});
      await withinBound(fault, left());
    }
    const answer = checker.query({
      text: `select request_hash, result from training.activity_type_requests where performed_by_user_id = $1 and request_key = $2`,
      values: [userId, requestKey],
      query_timeout: left(),
    });
    answer.catch(() => {});
    const row = (await withinBound(answer, left())).rows[0];
    return row && row.request_hash === hash ? row.result : null;
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    checker.removeListener("error", onError);
    if (broken) checker.on("error", () => {});
    checker.release(broken ? true : undefined);
  }
}

// `apply(cmd)` returns { result } for a command that changes nothing, or { result, record: { athleteId, oldTypeKey,
// newTypeKey } } for one that wrote.
async function runTypeCommand(ctx, activityId, { requestKey, canonical }, apply) {
  const hash = requestHash(canonical);
  const client = await pool.connect();
  let commitSent = false;
  let broken = false;
  let released = false;
  const onClientError = () => { broken = true; };
  client.on("error", onClientError);
  try {
    await client.query("begin");
    await client.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
    await client.query(`set local idle_in_transaction_session_timeout = '${IDLE_TIMEOUT}'`);
    const target = await resolveRosterTarget(client, ctx, activityId, { deferGate: true });
    const teamId = String(target.team.id);
    if (testHooks.beforeLocks) await testHooks.beforeLocks({ client, operation: canonical.operation });
    // 1. The rights, under lock (users before the role row).
    try {
      await client.query(`select training.lock_activity_decider($1, $2, $3)`, [ctx.userId, teamId, target.basis]);
    } catch (error) {
      if (error?.code === "42501") throw new RosterError(403, "not_a_team_coach", "You may not decide on this team's sessions.");
      throw error;
    }
    // 2. The same (user, key) is decided one after the other; the replay only for a caller who holds the right now.
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('activity-type-request:' || $1::uuid::text || ':' || $2::uuid::text, 88))`,
      [ctx.userId, requestKey],
    );
    const prior = (await client.query(
      `select request_hash, result from training.activity_type_requests where performed_by_user_id = $1 and request_key = $2`,
      [ctx.userId, requestKey],
    )).rows[0];
    if (prior) {
      if (prior.request_hash !== hash) throw conflict("request_key_reused", "This requestKey was already used for a different request.");
      await client.query("rollback");
      return { status: 200, body: prior.result, replayed: true };
    }
    // 3. The addressed activity row. Superseding it needs this lock, so what is read now holds until the COMMIT.
    const activity = (await client.query(
      `select id, activity_type_key from training.activities where id = $1 for update`, [activityId],
    )).rows[0];
    if (!activity) throw notFound();
    const canonicalId = String((await client.query(`select training.resolve_canonical_activity_id($1) as id`, [activityId])).rows[0].id);
    if (canonicalId !== String(activityId)) {
      // Merged into another session: its id is named only to a caller who may decide on that one too.
      if (canonicalId !== target.canonicalId) {
        const again = await resolveRosterTarget(client, ctx, canonicalId, { deferGate: true });
        if (String(again.team.id) !== teamId || again.basis !== target.basis) throw notFound();
      }
      throw conflict("activity_superseded", "This session was merged into another.", { canonicalActivityId: canonicalId });
    }
    // The acting user of v85's and v88's guards.
    await client.query(`select set_config('optimove.session_type_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [ctx.userId]);
    const outcome = await apply({
      client, ctx, canonical, activityId: canonicalId, teamId, clubId: String(target.team.club_id), basis: target.basis,
      sessionTypeKey: activity.activity_type_key ?? null,
    });
    if (!outcome.record) {
      await client.query("rollback");
      return { status: 200, body: outcome.result };
    }
    await client.query(
      `insert into training.activity_type_requests
         (activity_id, athlete_id, operation, old_type_key, new_type_key, reason, performed_by_user_id, basis, request_key, request_hash, result)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [canonicalId, outcome.record.athleteId ?? null, canonical.operation, outcome.record.oldTypeKey, outcome.record.newTypeKey,
        canonical.reason, ctx.userId, target.basis, requestKey, hash, JSON.stringify(outcome.result)],
    );
    // Every deferred check answers here, before the COMMIT is sent.
    await client.query("set constraints all immediate");
    if (testHooks.beforeCommit) await testHooks.beforeCommit({ client, operation: canonical.operation });
    commitSent = true;
    const committing = Promise.resolve().then(() => (testHooks.commit ? testHooks.commit(client) : client.query("commit")));
    committing.catch(() => {});
    await withinBound(committing, testHooks.commitTimeoutMs ?? COMMIT_ANSWER_TIMEOUT_MS);
    return { status: 200, body: outcome.result };
  } catch (error) {
    if (!commitSent) {
      await client.query("rollback").catch(() => { broken = true; });
      if (error?.code === "55P03" || error?.code === "40P01" || error?.code === "57014") {
        throw conflict("try_again", "The session is being changed. Try again.");
      }
      if (error?.code === "42501") throw new RosterError(403, "not_a_team_coach", "You may not decide on this team's sessions.");
      // The database's own refusals (v85's activity guard, v88's exception guard), for a write that raced a change.
      if (error?.code === "23514" && error?.message === "participant_type_same_as_session") throw sameAsSession();
      if (error?.code === "23514" && (error?.message === "participant_type_not_offered" || /session type is not offered/.test(String(error?.message)))) throw notOffered();
      throw error;
    }
    console.error(`[session-type] commit of ${canonical.operation} on activity ${activityId} failed: ${error?.code ?? ""} ${error?.message}`);
    if (commitCertainlyRefused(error)) {
      await client.query("rollback").catch(() => { broken = true; });
      throw new RosterError(500, "internal_error", NOTHING_SAVED);
    }
    // Unknown outcome: the connection is destroyed first, then the request row is looked for on a new one.
    released = true;
    client.removeListener("error", onClientError);
    client.on("error", () => {});
    client.release(true);
    let found = null;
    try {
      found = await findStoredResult(ctx.userId, requestKey, hash, testHooks.checkTimeoutMs ?? UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS);
    } catch (checkError) {
      console.error(`[session-type] checking ${canonical.operation} on activity ${activityId} after an unconfirmed COMMIT failed: ${checkError?.message}`);
    }
    if (found) return { status: 200, body: found, verifiedAfterCommitError: true };
    throw new RosterError(503, "outcome_unknown", OUTCOME_UNKNOWN);
  } finally {
    if (!released) {
      client.removeListener("error", onClientError);
      client.release(broken ? true : undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// The session's type
// ---------------------------------------------------------------------------
export function changeSessionType(ctx, activityId, body) {
  const validated = validateSessionType(body, activityId);
  return runTypeCommand(ctx, activityId, validated, async (cmd) => {
    const { client, canonical } = cmd;
    const next = canonical.activityTypeKey;
    if (next === cmd.sessionTypeKey) {
      return { result: { activityId: cmd.activityId, activityTypeKey: next, previousActivityTypeKey: next, changed: false, endedExceptionAthleteIds: [] } };
    }
    await assertOffered(client, next, cmd.clubId);
    // Every other field as it is: the row stays locked and the correction log writes who, why and when (v1).
    await client.query(
      `select training.correct_confirmed_activity_fields(a.id, a.occurred_local_date, a.started_at, a.ended_at, a.timezone_snapshot, $2, $3, $4)
         from training.activities a where a.id = $1`,
      [cmd.activityId, next, cmd.ctx.userId, canonical.reason],
    );
    // An exception equal to the session's new type would mean nothing: it ends (the participants, then their rows).
    const same = (await client.query(
      `select ap.id, ap.athlete_id
         from training.activity_participants ap
         join training.participant_activity_types x on x.participant_id = ap.id and x.ended_at is null
        where ap.activity_id = $1 and x.activity_type_key = $2
        order by ap.id
          for update of ap`,
      [cmd.activityId, next],
    )).rows;
    if (same.length) {
      await client.query(
        `update training.participant_activity_types
            set ended_at = clock_timestamp(), ended_by_user_id = $2, end_cause = 'same_as_session'
          where participant_id = any($1::uuid[]) and ended_at is null`,
        [same.map((r) => r.id), cmd.ctx.userId],
      );
    }
    return {
      result: {
        activityId: cmd.activityId, activityTypeKey: next, previousActivityTypeKey: cmd.sessionTypeKey, changed: true,
        endedExceptionAthleteIds: same.map((r) => String(r.athlete_id)).sort(),
      },
      record: { athleteId: null, oldTypeKey: cmd.sessionTypeKey, newTypeKey: next },
    };
  });
}

// ---------------------------------------------------------------------------
// An athlete's own type (the exception)
// ---------------------------------------------------------------------------
export function setAthleteSessionType(ctx, activityId, athleteId, body) {
  const validated = validateAthleteType(body, activityId, athleteId);
  return runTypeCommand(ctx, activityId, validated, async (cmd) => {
    const { client, canonical } = cmd;
    const next = canonical.activityTypeKey;
    // A self-report session holds one athlete's own result and has no roster (v44): the roster's own answer.
    const gate = await client.query(`select coalesce(training.activity_has_roster($1), false) as has_roster`, [cmd.activityId]);
    if (!gate.rows[0].has_roster) throw noRoster();
    // An exception belongs to the athlete's participant row: an athlete with no record in this session has none.
    const participant = (await client.query(
      `select id from training.activity_participants where activity_id = $1 and athlete_id = $2 and merge_status = 'canonical' for update`,
      [cmd.activityId, canonical.athleteId],
    )).rows[0];
    if (!participant) throw conflict("athlete_has_no_record", "This athlete has no record in this session yet.");
    const live = (await client.query(
      `select id, activity_type_key from training.participant_activity_types where participant_id = $1 and ended_at is null for update`,
      [participant.id],
    )).rows[0] ?? null;
    const view = (exceptionKey, changed) => ({
      activityId: cmd.activityId, athleteId: canonical.athleteId, sessionTypeKey: cmd.sessionTypeKey,
      exceptionTypeKey: exceptionKey, effectiveTypeKey: exceptionKey ?? cmd.sessionTypeKey,
      previousExceptionTypeKey: live?.activity_type_key ?? null, changed,
    });
    if (next === null) {
      if (!live) return { result: view(null, false) };
    } else {
      if (next === cmd.sessionTypeKey) throw sameAsSession();
      if (live && live.activity_type_key === next) return { result: view(next, false) };
      await assertOffered(client, next, cmd.clubId);
    }
    if (live) {
      await client.query(
        `update training.participant_activity_types set ended_at = clock_timestamp(), ended_by_user_id = $2, end_cause = $3 where id = $1`,
        [live.id, cmd.ctx.userId, next === null ? "cleared" : "replaced"],
      );
    }
    if (next !== null) {
      await client.query(
        `insert into training.participant_activity_types (id, participant_id, activity_type_key, reason, set_by_user_id, set_by_basis)
         values ($1, $2, $3, $4, $5, $6)`,
        [crypto.randomUUID(), participant.id, next, canonical.reason, cmd.ctx.userId, cmd.basis],
      );
    }
    return {
      result: view(next, true),
      record: { athleteId: canonical.athleteId, oldTypeKey: live?.activity_type_key ?? null, newTypeKey: next },
    };
  });
}
