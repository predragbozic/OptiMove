// Training Activity — single-participant ("fuzzy path") materialization,
// candidate matching/scoring, and match-suggestion resolution. Pure
// service functions taking an already-resolved workspace `scope` (see
// trainingActivityAccess.js) — routes and tests both call these directly,
// mirroring trainingLoadMetricsMeasurements.js's own convention.
//
// This is deliberately plain Node orchestration, not a DB function: unlike
// the 4 functions in migrations_v2's training_activity_v4 migration
// (which need an atomic, DB-enforced "exactly one outcome under
// concurrency" guarantee for a SHARED identity), a single participant's
// own candidate search/scoring/materialization has no such cross-caller
// race to resolve — the participant-write-request idempotency claim below
// already serializes retries of the SAME logical operation, and a
// same-athlete/same-date advisory lock (taken from Node, exactly like a
// DB function would) serializes genuinely concurrent DIFFERENT calls for
// the same athlete/date.
import crypto from "crypto";
import { pool, query } from "./db.js";
import { isAthleteInWorkspaceScope } from "./trainingActivityAccess.js";

function uuid() {
  return crypto.randomUUID();
}
function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}
function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
  return out;
}
function canonicalHash(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(obj))).digest("hex");
}

function buildContentHash({ operationKind, ownerScope, ownerIds, athleteId, localDate, timezone, startInstant, endInstant, durationMinutes, planLogicalSessionId, externalAssignmentId, name, activityTypeKey }) {
  return canonicalHash({
    operationKind, ownerScope,
    ownerUserId: ownerIds?.userId || null, ownerClubId: ownerIds?.clubId || null, ownerTeamId: ownerIds?.teamId || null,
    athleteId, localDate, timezone: timezone || null,
    startInstant: startInstant || null, endInstant: endInstant || null, durationMinutes: durationMinutes ?? null,
    planLogicalSessionId: planLogicalSessionId || null, externalAssignmentId: externalAssignmentId || null,
    name: name || null, activityTypeKey: activityTypeKey || null,
  });
}

function requesterKeyFor({ requestedBy, requestedBySourceConnectionId }) {
  if (requestedBy) return `user:${requestedBy}`;
  if (requestedBySourceConnectionId) return `source:${requestedBySourceConnectionId}`;
  throw new Error("requesterKeyFor: exactly one of requestedBy/requestedBySourceConnectionId is required");
}

async function claimActivityWriteRequest(client, { requestKey, requestedBy, requestedBySourceConnectionId, operationKind, ownerScope, ownerIds, contentHash }) {
  const insert = await client.query(
    `insert into training.activity_write_requests (request_key, requested_by_user_id, requested_by_source_connection_id, operation_kind, request_content_hash, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (requester_key, request_key) do nothing
     returning *`,
    [requestKey, requestedBy || null, requestedBySourceConnectionId || null, operationKind, contentHash, ownerScope, ownerIds?.userId || null, ownerIds?.clubId || null, ownerIds?.teamId || null],
  );
  if (insert.rowCount === 1) return { isNew: true, row: insert.rows[0] };

  const requesterKey = requesterKeyFor({ requestedBy, requestedBySourceConnectionId });
  const existing = await client.query(`select * from training.activity_write_requests where requester_key=$1 and request_key=$2`, [requesterKey, requestKey]);
  const row = existing.rows[0];
  if (row.operation_kind !== operationKind) throw httpError(409, "request key already used for a different operation kind");
  // The current caller's own claimed workspace/owner scope is re-checked
  // on every replay, BEFORE the generic content-hash check, so a
  // workspace switch under the same request key gets its own specific
  // refusal rather than a generic "different content" one.
  const sameScope = row.owner_scope === ownerScope
    && (row.owner_user_id || null) === (ownerIds?.userId || null)
    && (row.owner_club_id || null) === (ownerIds?.clubId || null)
    && (row.owner_team_id || null) === (ownerIds?.teamId || null);
  if (!sameScope) {
    throw httpError(403, "request key replay under a DIFFERENT current workspace/owner scope — refusing to return another workspace's result");
  }
  if (row.request_content_hash !== contentHash) throw httpError(409, "request key already used with different content");
  return { isNew: false, row };
}

// Versioned multi-signal scoring: a candidate is "strong" (auto-confirm
// eligible) only when the TIME signal is itself excellent (<=30min) AND AT
// LEAST ONE other independent signal (duration similarity, matching name,
// or matching activity_type_key) also agrees — a real multi-signal
// AND-gate, not a lone higher threshold. Every candidate keeps its own
// breakdown and the policy version that produced it, for audit
// (activity_match_suggestions.score_breakdown/policy_version).
const MATCH_POLICY_VERSION = 2;

function scoreCandidate({ startInstant, durationMinutes, name, activityTypeKey }, candidateRow) {
  const breakdown = {};

  let timeScore = 0;
  if (startInstant && candidateRow.started_at) {
    const diffMinutes = Math.abs(new Date(startInstant) - new Date(candidateRow.started_at)) / 60000;
    if (diffMinutes <= 30) timeScore = 100;
    else if (diffMinutes <= 120) timeScore = 60;
    else if (diffMinutes <= 240) timeScore = 20;
  } else {
    timeScore = 10; // same day, no time info at all — weak signal only
  }
  breakdown.time = timeScore;

  let durationScore = 0;
  if (durationMinutes != null && candidateRow.started_at && candidateRow.ended_at) {
    const candidateDurationMinutes = (new Date(candidateRow.ended_at) - new Date(candidateRow.started_at)) / 60000;
    const diff = Math.abs(candidateDurationMinutes - durationMinutes);
    if (diff <= 15) durationScore = 100;
    else if (diff <= 45) durationScore = 40;
  }
  breakdown.duration = durationScore;

  let nameScore = 0;
  if (name && candidateRow.name && name.trim().toLowerCase() === candidateRow.name.trim().toLowerCase()) {
    nameScore = 100;
  }
  breakdown.name = nameScore;

  let typeScore = 0;
  if (activityTypeKey && candidateRow.activity_type_key && activityTypeKey === candidateRow.activity_type_key) {
    typeScore = 100;
  }
  breakdown.type = typeScore;

  // Known team/group context is not modeled in this candidate query (no
  // shared "roster" signal to compare against here) — kept as an
  // explicit, always-zero, documented breakdown entry rather than
  // silently omitted, so a future extension has an obvious place to slot
  // a real signal in without changing the shape of score_breakdown.
  breakdown.teamContext = 0;

  const agreeingSecondarySignals = [durationScore, nameScore, typeScore].filter((s) => s >= 80).length;
  const strong = timeScore >= 100 && agreeingSecondarySignals >= 1;
  return { score: timeScore, strong, breakdown, policyVersion: MATCH_POLICY_VERSION };
}

// Candidate search: owner scope + athlete + local date are the mandatory
// filter (never date alone); scoreCandidate() above refines confidence.
async function findActivityCandidates(client, { ownerScope, ownerIds, athleteId, localDate, startInstant, endInstant, durationMinutes, name, activityTypeKey, planLogicalSessionId, externalAssignmentId }) {
  if (planLogicalSessionId || externalAssignmentId) {
    // The physical row a CONFIRMED link points at may itself be a
    // merge-superseded ALIAS by now (a merge never touches the session
    // link, only the participant's own merge_status/
    // superseded_by_participant_id), and that alias's own activity may
    // likewise have been superseded (if it lost its last canonical
    // participant). Every exact-key return is resolved through BOTH
    // canonical chains before it is ever handed back to a caller — a
    // repeat import against an old identity must land on the CURRENT
    // canonical participant/activity, never re-attach data to a dead row.
    const keyMatch = await client.query(
      `select ap.id as participant_id, ap.activity_id
       from training.activity_participant_session_links l
       join training.activity_participants ap on ap.id = l.activity_participant_id
       where l.link_status = 'confirmed' and ap.athlete_id = $1
         and (($2::uuid is not null and l.logical_session_id = $2) or ($3::uuid is not null and l.external_assignment_id = $3))
       limit 1`,
      [athleteId, planLogicalSessionId || null, externalAssignmentId || null],
    );
    if (keyMatch.rowCount) {
      const canonicalParticipant = await client.query(`select training.resolve_canonical_participant_id($1) as id`, [keyMatch.rows[0].participant_id]);
      const canonicalParticipantId = canonicalParticipant.rows[0].id;
      const canonicalParticipantRow = await client.query(`select activity_id from training.activity_participants where id=$1`, [canonicalParticipantId]);
      const canonicalActivity = await client.query(`select training.resolve_canonical_activity_id($1) as id`, [canonicalParticipantRow.rows[0].activity_id]);
      return { exactKeyMatch: { participant_id: canonicalParticipantId, activity_id: canonicalActivity.rows[0].id }, candidates: [] };
    }
  }

  const ownerCond = ownerScope === "system"
    ? "a.owner_scope = 'system'"
    : `a.owner_scope = $3 and a.owner_user_id is not distinct from $4::uuid and a.owner_club_id is not distinct from $5::uuid and a.owner_team_id is not distinct from $6::uuid`;
  const result = await client.query(
    `select ap.id as participant_id, ap.activity_id, a.started_at, a.ended_at, a.name, a.activity_type_key, a.lifecycle_state
     from training.activity_participants ap
     join training.activities a on a.id = ap.activity_id
     where ap.athlete_id = $1 and ap.local_date = $2 and a.lifecycle_state <> 'superseded' and ap.merge_status = 'canonical'
       and (${ownerCond})`,
    [athleteId, localDate, ownerScope, ownerIds?.userId || null, ownerIds?.clubId || null, ownerIds?.teamId || null],
  );
  const candidates = result.rows
    .map((row) => ({ ...row, ...scoreCandidate({ startInstant, durationMinutes, name, activityTypeKey }, row) }))
    .filter((c) => c.score > 0);
  return { exactKeyMatch: null, candidates };
}

// Resolves the AUTHORITATIVE identity for a natural-key materialize call —
// never the client's own claimed athleteId/localDate/timezone/instant.
// Returns null for a pure manual call (neither key given); throws 400 if
// BOTH keys are given (checked before this is ever called, but re-checked
// here too since this function is the one place that would otherwise
// silently prefer one over the other).
//
//   planned  — resolved through the SAME "real, live, PUBLISHED Weekly
//              plan" definition check_session_link_integrity() itself
//              enforces at commit time (v2 migration) — a stale/draft/
//              non-weekly/unpublished session resolves to nothing here
//              either, failing fast with a clear 404 instead of a later,
//              harder-to-diagnose DB-trigger rejection. The athlete comes
//              from the plan's OWN athlete_id — never trusted from the
//              caller. Timezone comes from that athlete's own
//              device_timezone (there is no session-level timezone
//              column); if it is null, this refuses rather than
//              defaulting to UTC or guessing. started_at is derived from
//              plan_days.date + plan_sessions.session_time, converted
//              through that SAME timezone, when session_time is set —
//              null otherwise (never fabricated).
//   external — resolved through the real external_assignments row itself
//              (which always carries its own timezone/local_scheduled_date
//              — no fallback needed), joined up to its occurrence and
//              schedule for ownership.
async function resolveAuthoritativeSource(client, { planLogicalSessionId, externalAssignmentId }) {
  if (planLogicalSessionId && externalAssignmentId) {
    throw httpError(400, "planLogicalSessionId and externalAssignmentId cannot both be provided.");
  }
  if (planLogicalSessionId) {
    const r = await client.query(
      `select p.athlete_id, pd.date as local_date, a.device_timezone as timezone,
              case when ps.session_time is not null and a.device_timezone is not null
                then (pd.date + ps.session_time) at time zone a.device_timezone
                else null end as start_instant,
              pwo.owner_scope, pwo.owner_user_id, pwo.owner_club_id, pwo.owner_team_id
       from plans.plan_sessions ps
       join plans.plan_days pd on pd.id = ps.plan_day_id
       join plans.plans p on p.id = pd.plan_id
       join public.athletes a on a.id = p.athlete_id
       left join training_load.plan_workspace_ownership pwo on pwo.plan_id = p.id
       where ps.logical_session_id = $1
         and p.is_active = true and p.is_edit_draft = false
         and p.plan_type = 'weekly' and p.status = 'active'`,
      [planLogicalSessionId],
    );
    if (!r.rowCount) throw httpError(404, "No real, live, published Weekly plan session was found for that logical session.");
    const row = r.rows[0];
    if (!row.timezone || !String(row.timezone).trim()) throw httpError(409, "The athlete's timezone is not resolvable — refusing to guess.");
    if (!row.owner_scope) throw httpError(409, "That plan has no resolved workspace ownership.");
    return {
      athleteId: row.athlete_id, localDate: row.local_date, timezone: row.timezone, startInstant: row.start_instant,
      ownerScope: row.owner_scope, ownerIds: { userId: row.owner_user_id, clubId: row.owner_club_id, teamId: row.owner_team_id },
    };
  }
  if (externalAssignmentId) {
    const r = await client.query(
      `select ea.athlete_id, ea.local_scheduled_date as local_date, ea.timezone,
              es.owner_scope, es.owner_user_id, es.owner_club_id, es.owner_team_id
       from training_load.external_assignments ea
       join training_load.external_schedule_occurrences eo on eo.id = ea.occurrence_id
       join training_load.external_schedules es on es.id = eo.schedule_id
       where ea.id = $1`,
      [externalAssignmentId],
    );
    if (!r.rowCount) throw httpError(404, "External assignment not found.");
    const row = r.rows[0];
    if (!row.timezone || !String(row.timezone).trim()) throw httpError(409, "The assignment's timezone is not resolvable — refusing to guess.");
    if (!row.owner_scope) throw httpError(409, "That external schedule has no resolved workspace ownership.");
    return {
      athleteId: row.athlete_id, localDate: row.local_date, timezone: row.timezone, startInstant: null,
      ownerScope: row.owner_scope, ownerIds: { userId: row.owner_user_id, clubId: row.owner_club_id, teamId: row.owner_team_id },
    };
  }
  return null;
}

// The core idempotent join for a SINGLE participant. Group identities
// (shared external occurrence / shared metric event) go through the
// dedicated SQL functions in migrations_v2's training_activity_v4 instead
// (see materializeGroupFromExternalOccurrence/materializeGroupFromMetricEvent
// below) — a per-participant loop over this function is NOT sufficient to
// guarantee "exactly one activity" for a group under concurrency (each
// call here only ever sees ITS OWN athlete as a candidate for itself).
//
// Decision table (versioned, see scoreCandidate above):
//   0 candidates                          -> new, confirmed (no signal to compare against)
//   1 candidate, STRONG (multi-signal)    -> auto_matched
//   1 candidate, WEAK (time-only or below)-> provisional + ONE suggestion
//   2+ candidates (any strength)          -> provisional + suggestions for ALL
export async function materializeActivityParticipant(scope, {
  requestKey, requestedBy, requestedBySourceConnectionId, operationKind, athleteId, localDate, timezone,
  startInstant, endInstant, durationMinutes, name, activityTypeKey, origin,
  planLogicalSessionId, externalAssignmentId,
}) {
  if (scope.type === null) throw httpError(403, "Forbidden");
  if (planLogicalSessionId && externalAssignmentId) {
    throw httpError(400, "planLogicalSessionId and externalAssignmentId cannot both be provided.");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    // AUTHORITATIVE identity resolution — for a natural-key call, the
    // client's own athleteId/localDate/timezone/startInstant/endInstant/
    // durationMinutes are NEVER trusted as the source of truth. If the
    // client supplies athleteId/localDate/timezone anyway and it
    // disagrees with the authoritative source, that is treated as a
    // confused or hostile caller and rejected outright — never silently
    // corrected — so a coach can never materialize athlete B's real
    // session as if it belonged to athlete A merely by naming A in the
    // request body. startInstant/endInstant/durationMinutes are always
    // FORCED to the authoritative-derived shape for a natural-key call
    // (there is no legitimate reason for a caller to supply timing data
    // for an identity it does not control); name/activityTypeKey remain
    // pure presentation — they affect matching/display only, never which
    // athlete/date/timezone/owner this resolves to.
    const authoritative = await resolveAuthoritativeSource(client, { planLogicalSessionId, externalAssignmentId });
    let effectiveAthleteId = athleteId, effectiveLocalDate = localDate, effectiveTimezone = timezone;
    let effectiveStartInstant = startInstant, effectiveEndInstant = endInstant, effectiveDurationMinutes = durationMinutes;
    let ownerScope, ownerIds;
    if (authoritative) {
      if (athleteId !== undefined && athleteId !== null && String(athleteId) !== String(authoritative.athleteId)) {
        throw httpError(400, "athleteId does not match the authoritative source (planned session / external assignment).");
      }
      if (localDate !== undefined && localDate !== null && String(localDate) !== String(authoritative.localDate)) {
        throw httpError(400, "localDate does not match the authoritative source.");
      }
      if (timezone !== undefined && timezone !== null && timezone !== authoritative.timezone) {
        throw httpError(400, "timezone does not match the authoritative source.");
      }
      // startInstant is compared against the authoritative source ONLY
      // where that source genuinely has one (a planned session with a
      // real session_time) — the client may never supply a value the
      // source has no way to corroborate. endInstant/durationMinutes are
      // rejected outright whenever supplied here: neither a plan session
      // nor an external assignment carries an authoritative end
      // instant/duration at all (no such column exists yet), so there is
      // nothing to verify a client-supplied value against — silently
      // discarding it (as this function used to do) would let a caller
      // believe its value was recorded when it never was.
      if (startInstant !== undefined && startInstant !== null) {
        if (authoritative.startInstant === null) {
          throw httpError(400, "startInstant cannot be supplied — the authoritative source has no known start time for this session/assignment.");
        }
        if (new Date(startInstant).getTime() !== new Date(authoritative.startInstant).getTime()) {
          throw httpError(400, "startInstant does not match the authoritative source.");
        }
      }
      if (endInstant !== undefined && endInstant !== null) {
        throw httpError(400, "endInstant cannot be supplied for a planned-session/external-assignment materialize call — no authoritative end time exists yet to verify it against.");
      }
      if (durationMinutes !== undefined && durationMinutes !== null) {
        throw httpError(400, "durationMinutes cannot be supplied for a planned-session/external-assignment materialize call — no authoritative duration exists yet to verify it against.");
      }
      effectiveAthleteId = authoritative.athleteId;
      effectiveLocalDate = authoritative.localDate;
      effectiveTimezone = authoritative.timezone;
      effectiveStartInstant = authoritative.startInstant;
      effectiveEndInstant = null;
      effectiveDurationMinutes = null;
      ownerScope = authoritative.ownerScope;
      ownerIds = authoritative.ownerIds;
      if (!canManageOwnerRow(scope, { owner_scope: ownerScope, owner_user_id: ownerIds.userId, owner_club_id: ownerIds.clubId, owner_team_id: ownerIds.teamId })) {
        throw httpError(403, "That plan/assignment is outside your access.");
      }
    } else {
      ownerScope = scope.ownerContext.ownerScope;
      ownerIds = { userId: scope.ownerContext.ownerUserId, clubId: scope.ownerContext.ownerClubId, teamId: scope.ownerContext.ownerTeamId };
    }
    if (!(await isAthleteInWorkspaceScope(scope, effectiveAthleteId))) throw httpError(403, "That athlete is outside your access.");
    athleteId = effectiveAthleteId; localDate = effectiveLocalDate; timezone = effectiveTimezone;
    startInstant = effectiveStartInstant; endInstant = effectiveEndInstant; durationMinutes = effectiveDurationMinutes;

    assertPresentationNameValid(name);
    await assertActivityTypeKeyValid(client.query.bind(client), activityTypeKey);

    const contentHash = buildContentHash({ operationKind, ownerScope, ownerIds, athleteId, localDate, timezone, startInstant, endInstant, durationMinutes, planLogicalSessionId, externalAssignmentId, name, activityTypeKey });
    const claim = await claimActivityWriteRequest(client, { requestKey, requestedBy, requestedBySourceConnectionId, operationKind, ownerScope, ownerIds, contentHash });
    const requesterKey = requesterKeyFor({ requestedBy, requestedBySourceConnectionId });

    if (!claim.isNew) {
      let participantId = claim.row.result_participant_id;
      if (!participantId) {
        const participantRow = await client.query(`select id from training.activity_participants where activity_id=$1 and athlete_id=$2`, [claim.row.result_activity_id, athleteId]);
        participantId = participantRow.rows[0]?.id;
      }
      await client.query("commit");
      return { activityId: claim.row.result_activity_id, participantId, reused: true, matchStatus: "replay" };
    }

    const naturalKey = planLogicalSessionId || externalAssignmentId;
    if (naturalKey) {
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`activity-link:${athleteId}:${naturalKey}`]);
    } else {
      // The fuzzy path's advisory lock, taken BEFORE candidates are ever
      // read, keyed on the minimum natural grouping required: owner
      // scope+id, athlete, local date.
      const fuzzyKey = `activity-fuzzy:${ownerScope}:${ownerIds?.userId || ""}:${ownerIds?.clubId || ""}:${ownerIds?.teamId || ""}:${athleteId}:${localDate}`;
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 1))`, [fuzzyKey]);
    }

    const { exactKeyMatch, candidates } = await findActivityCandidates(client, { ownerScope, ownerIds, athleteId, localDate, startInstant, endInstant, durationMinutes, name, activityTypeKey, planLogicalSessionId, externalAssignmentId });

    if (exactKeyMatch) {
      await client.query(`update training.activity_write_requests set result_activity_id=$1, result_participant_id=$2 where requester_key=$3 and request_key=$4`, [exactKeyMatch.activity_id, exactKeyMatch.participant_id, requesterKey, requestKey]);
      await client.query("commit");
      return { activityId: exactKeyMatch.activity_id, participantId: exactKeyMatch.participant_id, reused: false, matchStatus: "reused_by_key" };
    }

    const strong = candidates.filter((c) => c.strong);
    let activityId, participantId, matchStatus;

    if (candidates.length === 0) {
      const activityInsert = await client.query(
        `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, ended_at, timezone_snapshot, owner_scope, owner_user_id, owner_club_id, owner_team_id, origin, lifecycle_state, created_by_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'confirmed',$12) returning id`,
        [activityTypeKey || null, name || null, localDate, startInstant || null, endInstant || null, timezone, ownerScope, ownerIds?.userId || null, ownerIds?.clubId || null, ownerIds?.teamId || null, origin, requestedBy || null],
      );
      activityId = activityInsert.rows[0].id;
      const participantInsert = await client.query(
        `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status)
         values ($1,$2,$3,$4,'participated') returning id`,
        [activityId, athleteId, localDate, timezone],
      );
      participantId = participantInsert.rows[0].id;
      matchStatus = "new";
    } else if (strong.length === 1 && candidates.length === 1) {
      await client.query(`select 1 from training.activities where id=$1 for update`, [strong[0].activity_id]);
      activityId = strong[0].activity_id;
      participantId = strong[0].participant_id;
      matchStatus = "auto_matched";
    } else {
      // 1+ candidate(s), none resolving to a single strong match — always
      // provisional, always suggestion(s) recorded, whether it's exactly
      // one weak candidate or several tied ones.
      const activityInsert = await client.query(
        `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, ended_at, timezone_snapshot, owner_scope, owner_user_id, owner_club_id, owner_team_id, origin, lifecycle_state, created_by_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'provisional',$12) returning id`,
        [activityTypeKey || null, name || null, localDate, startInstant || null, endInstant || null, timezone, ownerScope, ownerIds?.userId || null, ownerIds?.clubId || null, ownerIds?.teamId || null, origin, requestedBy || null],
      );
      activityId = activityInsert.rows[0].id;
      const participantInsert = await client.query(
        `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status)
         values ($1,$2,$3,$4,'participated') returning id`,
        [activityId, athleteId, localDate, timezone],
      );
      participantId = participantInsert.rows[0].id;
      matchStatus = "ambiguous_new";

      for (const c of candidates) {
        await client.query(
          `insert into training.activity_match_suggestions (activity_id, source_participant_id, candidate_activity_id, candidate_participant_id, confidence, score_breakdown, policy_version, reason)
           values ($1,$2,$3,$4,$5,$6,$7,'candidate recorded for human review — see score_breakdown for why it did not auto-confirm')`,
          [activityId, participantId, c.activity_id, c.participant_id, c.score, JSON.stringify(c.breakdown), c.policyVersion],
        );
      }
    }

    if (planLogicalSessionId || externalAssignmentId) {
      await client.query(
        `insert into training.activity_participant_session_links (activity_participant_id, athlete_id, logical_session_id, external_assignment_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
         values ($1,$2,$3,$4,'automatic','confirmed',$5,now(),$5)`,
        [participantId, athleteId, planLogicalSessionId || null, externalAssignmentId || null, requestedBy || null],
      );
    }

    await client.query(`update training.activity_write_requests set result_activity_id=$1, result_participant_id=$2 where requester_key=$3 and request_key=$4`, [activityId, participantId, requesterKey, requestKey]);
    await client.query("commit");
    return { activityId, participantId, reused: false, matchStatus };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Thin wrappers around the plpgsql functions in migrations_v2's
// training_activity_v4 migration — never exposed to any HTTP route
// directly; every caller here (and every route below in
// routes/trainingActivity.js) resolves and checks workspace authorization
// FIRST, exactly like the rest of this module.
// Shared by all 3 materialization service functions (single-participant,
// external-occurrence group, metric-event group) so a future 4th path can
// never quietly diverge from this check — `queryFn` is either a
// transactional client's own `.query` (bound) or the module-level `query`
// helper, both `(text, params) => Promise<Result>`.
const MAX_NAME_LENGTH = 200;
async function assertActivityTypeKeyValid(queryFn, activityTypeKey) {
  if (!activityTypeKey) return;
  if (typeof activityTypeKey !== "string" || activityTypeKey.length > MAX_NAME_LENGTH) {
    throw httpError(400, `Invalid activityTypeKey.`);
  }
  const r = await queryFn(`select 1 from training.activity_types where key = $1 and is_active = true`, [activityTypeKey]);
  if (!r.rowCount) throw httpError(400, `Unknown or inactive activityTypeKey "${activityTypeKey}".`);
}
function assertPresentationNameValid(name) {
  if (name === undefined || name === null) return;
  if (typeof name !== "string" || name.length > MAX_NAME_LENGTH) {
    throw httpError(400, `name must be a string of at most ${MAX_NAME_LENGTH} characters.`);
  }
}

export async function materializeGroupFromExternalOccurrence(scope, { occurrenceId, activityTypeKey, name, performedBy }) {
  if (scope.type === null) throw httpError(403, "Forbidden");
  assertPresentationNameValid(name);
  await assertActivityTypeKeyValid(query, activityTypeKey);
  const occ = await query(
    `select es.owner_scope, es.owner_user_id, es.owner_club_id, es.owner_team_id
     from training_load.external_schedule_occurrences eo join training_load.external_schedules es on es.id = eo.schedule_id
     where eo.id = $1`,
    [occurrenceId],
  );
  if (!occ.rowCount) throw httpError(404, "External occurrence not found.");
  if (!canManageOwnerRow(scope, occ.rows[0])) throw httpError(404, "External occurrence not found.");
  const r = await query(`select training.materialize_activity_group_from_external_occurrence($1,$2,$3,$4) as id`, [occurrenceId, activityTypeKey || null, name || null, performedBy]);
  return r.rows[0].id;
}
export async function materializeGroupFromMetricEvent(scope, { eventId, activityTypeKey, name, performedBy }) {
  if (scope.type === null) throw httpError(403, "Forbidden");
  assertPresentationNameValid(name);
  await assertActivityTypeKeyValid(query, activityTypeKey);
  const ev = await query(`select owner_scope, owner_user_id, owner_club_id, owner_team_id from training_load.metric_events where id = $1`, [eventId]);
  if (!ev.rowCount) throw httpError(404, "Metric event not found.");
  if (!canManageOwnerRow(scope, ev.rows[0])) throw httpError(404, "Metric event not found.");
  const r = await query(`select training.materialize_activity_group_from_metric_event($1,$2,$3,$4) as id`, [eventId, activityTypeKey || null, name || null, performedBy]);
  return r.rows[0].id;
}
function canManageOwnerRow(scope, row) {
  if (scope.type === "platform") return true;
  if (scope.type === "club") return row.owner_scope === "club" && String(row.owner_club_id) === String(scope.clubId);
  if (scope.type === "team") return row.owner_scope === "team" && String(row.owner_team_id) === String(scope.teamId);
  if (scope.type === "private_coach") return row.owner_scope === "user" && String(row.owner_user_id) === String(scope.userId);
  return false;
}

// Wires an ambiguous activity_match_suggestions row to the sanctioned
// participant-merge flow. Uses the suggestion's own EXPLICITLY-STORED
// source_participant_id, never a re-derived
// `select id from activity_participants where activity_id=...` (which is
// only safe while that activity has exactly one participant). Sibling
// open suggestions on the same source activity are dismissed
// automatically since the ambiguity that produced them is now resolved.
// `onLocked` (default no-op) is a test-only hook, same convention as
// trainingLoadMetricsMeasurements.js's correctManualOccasion/
// correctSourceIdentityOccasion — called right after the row lock below
// is acquired, letting a deterministic concurrency test pause here (via
// its own promise/barrier) so a SECOND, racing acceptMatchSuggestion/
// dismissMatchSuggestion call can be directly observed Lock-waiting on
// the SAME suggestion row before this one proceeds. Never awaited for
// anything but a controlled test.
// Round 4 fix: two SIBLING suggestions on the SAME source activity/source
// participant (an ambiguous_new materialization records one per
// candidate) used to be serialized only at the level of their OWN
// suggestion row — this alone is not enough. Concurrently: A locks S1's
// row and enters merge_activity_participants, which takes an advisory
// lock on the SOURCE participant (shared by S1 and S2) before its target;
// B locks S2's row and, entering ITS OWN merge, blocks on that SAME
// source-participant advisory lock A already holds. A, having merged,
// then tries to cascade-dismiss the sibling (S2) via the bare UPDATE
// below — which now blocks on B's own row lock on S2. That is a genuine
// wait-for cycle (A waits on B's row lock, B waits on A's advisory lock).
// Fixed by taking ONE shared advisory lock, keyed on the source identity
// (source activity + source participant) common to every sibling, BEFORE
// ever locking an individual suggestion row — every accept/dismiss call
// for ANY suggestion sharing that identity now serializes at this single
// point, so two callers can never simultaneously be mid-way through
// locking two different sibling rows in the first place.
async function lockMatchSuggestionSourceIdentity(client, suggestionId) {
  const idLookup = await client.query(`select activity_id, source_participant_id from training.activity_match_suggestions where id=$1`, [suggestionId]);
  if (!idLookup.rowCount) throw httpError(404, "Suggestion not found.");
  const { activity_id: sourceActivityId, source_participant_id: sourceParticipantId } = idLookup.rows[0];
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 5))`, [`activity-suggestion-source:${sourceActivityId}:${sourceParticipantId}`]);
}

export async function acceptMatchSuggestion(scope, { suggestionId, performedBy, reason }, { onLocked } = {}) {
  if (scope.type === null) throw httpError(403, "Forbidden");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockMatchSuggestionSourceIdentity(client, suggestionId);
    const sugRes = await client.query(
      `select ms.*, a.owner_scope, a.owner_user_id, a.owner_club_id, a.owner_team_id
       from training.activity_match_suggestions ms join training.activities a on a.id = ms.activity_id
       where ms.id=$1 for update`,
      [suggestionId],
    );
    if (onLocked) await onLocked(client);
    const sug = sugRes.rows[0];
    if (!sug) throw httpError(404, "Suggestion not found.");
    if (!canManageOwnerRow(scope, sug)) throw httpError(404, "Suggestion not found.");
    if (sug.status !== "open") throw httpError(409, "Suggestion already resolved.");
    const sourceParticipantId = sug.source_participant_id;
    const mergeRes = await client.query(`select training.merge_activity_participants($1,$2,$3,$4) as id`, [sourceParticipantId, sug.candidate_participant_id, performedBy, reason || "accepted ambiguous match suggestion"]);
    await client.query(`update training.activity_match_suggestions set status='accepted', resolved_by_user_id=$1, resolved_at=now() where id=$2`, [performedBy, suggestionId]);
    // Round 5 fix: the shared serialization key introduced in Round 4 is
    // (activity_id, source_participant_id) — a SINGLE provisional
    // activity can carry sibling suggestions for MORE THAN ONE
    // participant (a group materialization where several participants
    // each independently ended up ambiguous). This cascade used to filter
    // only by activity_id, so accepting one participant's suggestion
    // would also silently dismiss a COMPLETELY UNRELATED participant's
    // still-open suggestions on the same activity — resolved participant
    // A's ambiguity must never resolve participant B's. Filtering by
    // source_participant_id too keeps the cascade scoped to exactly the
    // SAME identity this call's own advisory lock (lockMatchSuggestion
    // SourceIdentity) already serializes on.
    await client.query(`update training.activity_match_suggestions set status='dismissed', resolved_by_user_id=$1, resolved_at=now() where activity_id=$2 and source_participant_id=$3 and id<>$4 and status='open'`, [performedBy, sug.activity_id, sourceParticipantId, suggestionId]);
    await client.query("commit");
    return { canonicalParticipantId: mergeRes.rows[0].id, sourceParticipantId };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Race fix: this used to be a plain unlocked read-then-write (`query`,
// no transaction) whose final UPDATE had no `where status='open'` guard —
// two concurrent calls (dismiss racing accept, or dismiss racing
// dismiss) could both read status='open' before either wrote, and a
// dismiss that lost the race could then blindly overwrite a status
// accept had ALREADY moved to 'accepted' (after a real merge had already
// happened), corrupting the suggestion's own audit trail. Now uses the
// exact SAME `SELECT ... FOR UPDATE` shape as acceptMatchSuggestion,
// locking the identical single row — Postgres's own row lock is what
// gives accept and dismiss a single, real serialization point on the
// SAME suggestion: whichever call's FOR UPDATE has to wait re-reads the
// ALREADY-updated status once it acquires the lock and correctly refuses
// with 409, rather than the second writer blindly overwriting the first.
export async function dismissMatchSuggestion(scope, { suggestionId, performedBy }, { onLocked } = {}) {
  if (scope.type === null) throw httpError(403, "Forbidden");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockMatchSuggestionSourceIdentity(client, suggestionId);
    const sugRes = await client.query(
      `select ms.*, a.owner_scope, a.owner_user_id, a.owner_club_id, a.owner_team_id
       from training.activity_match_suggestions ms join training.activities a on a.id = ms.activity_id
       where ms.id=$1 for update`,
      [suggestionId],
    );
    if (onLocked) await onLocked(client);
    const sug = sugRes.rows[0];
    if (!sug) throw httpError(404, "Suggestion not found.");
    if (!canManageOwnerRow(scope, sug)) throw httpError(404, "Suggestion not found.");
    if (sug.status !== "open") throw httpError(409, "Suggestion already resolved.");
    const updated = await client.query(
      `update training.activity_match_suggestions set status='dismissed', resolved_by_user_id=$1, resolved_at=now() where id=$2 and status='open' returning id`,
      [performedBy, suggestionId],
    );
    if (!updated.rowCount) throw httpError(409, "Suggestion already resolved.");
    await client.query("commit");
    return { ok: true };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Round 4 fix: componentMapping used to be forwarded straight to the DB
// function untouched — a malformed shape (not an object, non-UUID keys/
// values) would only ever have been caught deep inside
// reparent_activity_participant's own 'map' branch as a raw Postgres
// 22P02 (invalid_text_representation). Validated HERE, before any
// transaction/advisory lock is ever taken, so a bad request is refused
// with zero partial writes and a controlled 400 — the DB function's own
// cast is now only a defensive last resort (see the v4 migration's own
// comment on that same cast). One documented rule for every OTHER
// strategy: componentMapping must simply be absent (undefined/null) —
// never silently ignored if the caller mistakenly sent one for
// 'none'/'clone', which would otherwise hide a confused client's own
// wrong request.
function assertValidComponentMapping(componentStrategy, componentMapping) {
  if (componentMapping === undefined || componentMapping === null) return;
  if (componentStrategy !== "map") {
    throw httpError(400, "componentMapping may only be provided when componentStrategy is 'map'.");
  }
  if (typeof componentMapping !== "object" || Array.isArray(componentMapping)) {
    throw httpError(400, "componentMapping must be a plain object of { sourceComponentId: targetComponentId }.");
  }
  for (const [k, v] of Object.entries(componentMapping)) {
    if (!UUID_PATTERN.test(k) || typeof v !== "string" || !UUID_PATTERN.test(v)) {
      throw httpError(400, "componentMapping keys and values must all be valid UUIDs.");
    }
  }
}

// Authorized reparent/merge — both check the SOURCE participant's own
// activity is within the caller's scope before doing anything (the
// sanctioned SQL functions themselves additionally refuse a cross-owner-
// scope move at the DB level, but a 404 here — never a 403 leaking that a
// participant id exists — matches this app's existing not-yours-vs-
// missing convention).
//
// Round 4 fix: reparent used to authorize ONLY the source — an
// unauthorized or nonexistent TARGET activity was invisible to this
// function entirely, so the DB function's own cross-owner-scope refusal
// (which names both sides' owner UUIDs in its RAISE EXCEPTION message)
// could be reached by an authorized caller pointing at someone else's
// activity, and that raw message would then reach the client verbatim
// via routes/trainingActivity.js's own P0001 -> 400 passthrough. The
// target is now loaded and authorized here, with the SAME info-hiding 404
// the source already gets, and the two sides' owner scopes are compared
// HERE too — so an authorized-but-cross-scope target now gets a clean,
// sanitized 400 from Node, and the DB's own cross-scope branch becomes an
// unreachable-via-this-app defensive backstop only (never a real path a
// client can trigger, so its own UUID-bearing message can never leak).
export async function reparentActivityParticipant(scope, { participantId, toActivityId, performedBy, reason, componentStrategy, componentMapping }) {
  if (scope.type === null) throw httpError(403, "Forbidden");
  const strategy = componentStrategy || "none";
  assertValidComponentMapping(strategy, componentMapping);

  const p = await query(`select ap.id, a.owner_scope, a.owner_user_id, a.owner_club_id, a.owner_team_id from training.activity_participants ap join training.activities a on a.id = ap.activity_id where ap.id=$1`, [participantId]);
  if (!p.rowCount) throw httpError(404, "Participant not found.");
  if (!canManageOwnerRow(scope, p.rows[0])) throw httpError(404, "Participant not found.");

  const target = await query(`select id, owner_scope, owner_user_id, owner_club_id, owner_team_id from training.activities where id=$1`, [toActivityId]);
  if (!target.rowCount) throw httpError(404, "Target activity not found.");
  if (!canManageOwnerRow(scope, target.rows[0])) throw httpError(404, "Target activity not found.");

  const source = p.rows[0];
  const to = target.rows[0];
  const sameOwnerScope = source.owner_scope === to.owner_scope
    && (source.owner_user_id || null) === (to.owner_user_id || null)
    && (source.owner_club_id || null) === (to.owner_club_id || null)
    && (source.owner_team_id || null) === (to.owner_team_id || null);
  if (!sameOwnerScope) throw httpError(400, "Cannot reparent a participant across different owner scopes.");

  await query(`select training.reparent_activity_participant($1,$2,$3,$4,$5,$6)`, [participantId, toActivityId, performedBy, reason || null, strategy, componentMapping ? JSON.stringify(componentMapping) : null]);
  return { ok: true };
}

// Round 5 fix: this used to authorize only the SOURCE participant —
// targetParticipantId was forwarded straight to
// training.merge_activity_participants() untouched, so an unauthorized or
// nonexistent target was invisible to this service layer entirely. Same
// gap and same fix as reparentActivityParticipant's own Round 4
// correction: the target participant (with its own activity's owner
// fields) is now loaded and authorized with the SAME info-hiding 404 the
// source already gets, and the two sides' owner scopes are compared here
// and rejected with a clean, sanitized 400 BEFORE the DB is ever called —
// so merge_activity_participants()'s own cross-owner-scope RAISE
// EXCEPTION (which names both sides' owner UUIDs) becomes an
// unreachable-via-this-app defensive backstop only, never a real leak
// path an authorized caller could trigger by pointing at someone else's
// participant. The DB function's own "same athlete" and "target must be
// canonical" checks are left exactly as they are — those remain the
// authoritative, last-resort protection regardless of caller.
export async function mergeActivityParticipants(scope, { sourceParticipantId, targetParticipantId, performedBy, reason }) {
  if (scope.type === null) throw httpError(403, "Forbidden");
  const p = await query(`select ap.id, a.owner_scope, a.owner_user_id, a.owner_club_id, a.owner_team_id from training.activity_participants ap join training.activities a on a.id = ap.activity_id where ap.id=$1`, [sourceParticipantId]);
  if (!p.rowCount) throw httpError(404, "Participant not found.");
  if (!canManageOwnerRow(scope, p.rows[0])) throw httpError(404, "Participant not found.");

  const t = await query(`select ap.id, a.owner_scope, a.owner_user_id, a.owner_club_id, a.owner_team_id from training.activity_participants ap join training.activities a on a.id = ap.activity_id where ap.id=$1`, [targetParticipantId]);
  if (!t.rowCount) throw httpError(404, "Target participant not found.");
  if (!canManageOwnerRow(scope, t.rows[0])) throw httpError(404, "Target participant not found.");

  const source = p.rows[0];
  const target = t.rows[0];
  const sameOwnerScope = source.owner_scope === target.owner_scope
    && (source.owner_user_id || null) === (target.owner_user_id || null)
    && (source.owner_club_id || null) === (target.owner_club_id || null)
    && (source.owner_team_id || null) === (target.owner_team_id || null);
  if (!sameOwnerScope) throw httpError(400, "Cannot merge participants across different owner scopes.");

  const r = await query(`select training.merge_activity_participants($1,$2,$3,$4) as id`, [sourceParticipantId, targetParticipantId, performedBy, reason || null]);
  return { canonicalParticipantId: r.rows[0].id };
}

// ---------------------------------------------------------------------
// Planned RPE -> Training Activity materialization (Training Activity
// Integration 2A). ALWAYS transaction-aware: `client` is the CALLER's own
// already-open, already-locked transaction (routes/trainingLoad.js's own
// POST /sessions/:sessionId/rpe, right after its session_feedback INSERT
// actually happened) — this function never opens, commits, or rolls back
// a transaction of its own. A materialization failure here aborts the
// SAME transaction as the RPE insert, so the RPE result and its
// Training Activity link can never end up in a half-written state: both
// commit together, or neither does. Never call this from a route that
// manages a SEPARATE transaction, and never call it over a fresh
// `pool.connect()` of its own.
//
// Deterministic natural-key identity only — no fuzzy candidate search is
// possible or needed here, unlike materializeActivityParticipant's own
// natural-key branch (which this mirrors): a planned session's own
// logical_session_id either already has a CONFIRMED
// activity_participant_session_links row (a prior submit — or a
// concurrent one that wins the race below — already materialized this
// exact identity; resolved through the canonical alias chain in case a
// later merge/reparent moved it), or it doesn't (create a brand-new
// confirmed activity + participant + link, exactly once). Serialized by
// the SAME advisory-lock convention materializeActivityParticipant's own
// natural-key path uses (`activity-link:<athleteId>:<naturalKey>`, salt
// 0) — a concurrent HTTP /materialize call or a retried submit against
// the SAME logical session can never race this into two activities.
export async function materializePlannedRpeActivityForSubmit(client, {
  logicalSessionId, athleteId, localDate, timezone, startInstant,
  sessionName, ownerScope, ownerIds, performedBy,
}) {
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`activity-link:${athleteId}:${logicalSessionId}`]);

  const keyMatch = await client.query(
    `select ap.id as participant_id, ap.activity_id
     from training.activity_participant_session_links l
     join training.activity_participants ap on ap.id = l.activity_participant_id
     where l.link_status = 'confirmed' and ap.athlete_id = $1 and l.logical_session_id = $2
     limit 1`,
    [athleteId, logicalSessionId],
  );
  if (keyMatch.rowCount) {
    const canonicalParticipant = await client.query(`select training.resolve_canonical_participant_id($1) as id`, [keyMatch.rows[0].participant_id]);
    const canonicalParticipantId = canonicalParticipant.rows[0].id;
    const canonicalParticipantRow = await client.query(`select activity_id from training.activity_participants where id=$1`, [canonicalParticipantId]);
    const canonicalActivity = await client.query(`select training.resolve_canonical_activity_id($1) as id`, [canonicalParticipantRow.rows[0].activity_id]);
    return { activityId: canonicalActivity.rows[0].id, participantId: canonicalParticipantId, reused: true };
  }

  const activityInsert = await client.query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_user_id, owner_club_id, owner_team_id, origin, lifecycle_state, created_by_user_id)
     values ('training_session',$1,$2,$3,$4,$5,$6,$7,$8,'planned_session','confirmed',$9) returning id`,
    [sessionName || null, localDate, startInstant || null, timezone, ownerScope, ownerIds?.userId || null, ownerIds?.clubId || null, ownerIds?.teamId || null, performedBy || null],
  );
  const activityId = activityInsert.rows[0].id;
  const participantInsert = await client.query(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status)
     values ($1,$2,$3,$4,'participated') returning id`,
    [activityId, athleteId, localDate, timezone],
  );
  const participantId = participantInsert.rows[0].id;
  await client.query(
    `insert into training.activity_participant_session_links (activity_participant_id, athlete_id, logical_session_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
     values ($1,$2,$3,'automatic','confirmed',$4,now(),$4)`,
    [participantId, athleteId, logicalSessionId, performedBy || null],
  );
  return { activityId, participantId, reused: false };
}

export { uuid, httpError };
