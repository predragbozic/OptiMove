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
const MATCH_POLICY_VERSION = 1;

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
  if (!(await isAthleteInWorkspaceScope(scope, athleteId))) throw httpError(403, "That athlete is outside your access.");
  const ownerScope = scope.ownerContext.ownerScope;
  const ownerIds = { userId: scope.ownerContext.ownerUserId, clubId: scope.ownerContext.ownerClubId, teamId: scope.ownerContext.ownerTeamId };

  const client = await pool.connect();
  try {
    await client.query("begin");
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
export async function materializeGroupFromExternalOccurrence(scope, { occurrenceId, activityTypeKey, name, performedBy }) {
  if (scope.type === null) throw httpError(403, "Forbidden");
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
export async function acceptMatchSuggestion(scope, { suggestionId, performedBy, reason }) {
  if (scope.type === null) throw httpError(403, "Forbidden");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sugRes = await client.query(
      `select ms.*, a.owner_scope, a.owner_user_id, a.owner_club_id, a.owner_team_id
       from training.activity_match_suggestions ms join training.activities a on a.id = ms.activity_id
       where ms.id=$1 for update`,
      [suggestionId],
    );
    const sug = sugRes.rows[0];
    if (!sug) throw httpError(404, "Suggestion not found.");
    if (!canManageOwnerRow(scope, sug)) throw httpError(404, "Suggestion not found.");
    if (sug.status !== "open") throw httpError(409, "Suggestion already resolved.");
    const sourceParticipantId = sug.source_participant_id;
    const mergeRes = await client.query(`select training.merge_activity_participants($1,$2,$3,$4) as id`, [sourceParticipantId, sug.candidate_participant_id, performedBy, reason || "accepted ambiguous match suggestion"]);
    await client.query(`update training.activity_match_suggestions set status='accepted', resolved_by_user_id=$1, resolved_at=now() where id=$2`, [performedBy, suggestionId]);
    await client.query(`update training.activity_match_suggestions set status='dismissed', resolved_by_user_id=$1, resolved_at=now() where activity_id=$2 and id<>$3 and status='open'`, [performedBy, sug.activity_id, suggestionId]);
    await client.query("commit");
    return { canonicalParticipantId: mergeRes.rows[0].id, sourceParticipantId };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function dismissMatchSuggestion(scope, { suggestionId, performedBy }) {
  if (scope.type === null) throw httpError(403, "Forbidden");
  const sugRes = await query(
    `select ms.*, a.owner_scope, a.owner_user_id, a.owner_club_id, a.owner_team_id
     from training.activity_match_suggestions ms join training.activities a on a.id = ms.activity_id
     where ms.id=$1`,
    [suggestionId],
  );
  const sug = sugRes.rows[0];
  if (!sug) throw httpError(404, "Suggestion not found.");
  if (!canManageOwnerRow(scope, sug)) throw httpError(404, "Suggestion not found.");
  if (sug.status !== "open") throw httpError(409, "Suggestion already resolved.");
  await query(`update training.activity_match_suggestions set status='dismissed', resolved_by_user_id=$1, resolved_at=now() where id=$2`, [performedBy, suggestionId]);
  return { ok: true };
}

// Authorized reparent/merge — both check the SOURCE participant's own
// activity is within the caller's scope before doing anything (the
// sanctioned SQL functions themselves additionally refuse a cross-owner-
// scope move at the DB level, but a 404 here — never a 403 leaking that a
// participant id exists — matches this app's existing not-yours-vs-
// missing convention).
export async function reparentActivityParticipant(scope, { participantId, toActivityId, performedBy, reason, componentStrategy, componentMapping }) {
  if (scope.type === null) throw httpError(403, "Forbidden");
  const p = await query(`select ap.id, a.owner_scope, a.owner_user_id, a.owner_club_id, a.owner_team_id from training.activity_participants ap join training.activities a on a.id = ap.activity_id where ap.id=$1`, [participantId]);
  if (!p.rowCount) throw httpError(404, "Participant not found.");
  if (!canManageOwnerRow(scope, p.rows[0])) throw httpError(404, "Participant not found.");
  await query(`select training.reparent_activity_participant($1,$2,$3,$4,$5,$6)`, [participantId, toActivityId, performedBy, reason || null, componentStrategy || "none", componentMapping ? JSON.stringify(componentMapping) : null]);
  return { ok: true };
}

export async function mergeActivityParticipants(scope, { sourceParticipantId, targetParticipantId, performedBy, reason }) {
  if (scope.type === null) throw httpError(403, "Forbidden");
  const p = await query(`select ap.id, a.owner_scope, a.owner_user_id, a.owner_club_id, a.owner_team_id from training.activity_participants ap join training.activities a on a.id = ap.activity_id where ap.id=$1`, [sourceParticipantId]);
  if (!p.rowCount) throw httpError(404, "Participant not found.");
  if (!canManageOwnerRow(scope, p.rows[0])) throw httpError(404, "Participant not found.");
  const r = await query(`select training.merge_activity_participants($1,$2,$3,$4) as id`, [sourceParticipantId, targetParticipantId, performedBy, reason || null]);
  return { canonicalParticipantId: r.rows[0].id };
}

export { uuid, httpError };
