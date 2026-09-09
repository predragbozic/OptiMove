// Training Activity 2B — links every new SESSION-level Metrics Core event
// to exactly one canonical training.activity, inside the SAME transaction
// createGroupEvent (trainingLoadMetricsMeasurements.js) already holds open.
// A day-level event (scope_level='day') never reaches this module at all —
// see createGroupEvent's own branch.
//
// Maximally reuses the existing Training Activity model rather than adding
// new schema: materializeNaturalKeyActivity (this branch's own
// generalization of the already-deployed planned-RPE natural-key path,
// trainingActivityMaterialize.js) for a per-participant logicalSessionId/
// externalAssignmentId claim; findActivityCandidates/scoreCandidate (the
// already-deployed fuzzy-match scoring used by the solo materialize route)
// for both a solo event AND a standalone group event with no authoritative
// identity (materializeGroupFuzzyActivity below aggregates the SAME
// per-athlete scoring across every participant — see its own header);
// training.reparent_activity_participant() for the deterministic "prove
// two separately-identified participants belong to the same group session
// -> merge into one activity" case (section 4), with a proactive check
// (assertNoConflictingThirdActivityLink) turning its own raw conflict
// exception into a controlled, info-hiding 409 (section 2). The real,
// already-deployed training.materialize_activity_group_from_metric_event()
// DB function is NOT used by this automatic flow — it has no candidate-
// search concept (see materializeGroupFuzzyActivity's own header) — but
// stays in place, unmodified, for the separate manual
// POST /materialize/metric-event/:eventId route
// (trainingActivityMaterialize.js's materializeGroupFromMetricEvent). No
// new migration.
import {
  findActivityCandidates, materializeNaturalKeyActivity,
} from "./trainingActivityMaterialize.js";
import { canManageActivityInScope } from "./trainingActivityAccess.js";

// Local httpError (rather than trainingActivityMaterialize.js's own, which
// has no `code` parameter) — createGroupEvent's own catch block forwards
// `error.code` straight through to the HTTP response body (see
// respondToWriteError/sendServiceResult in routes/trainingLoadMetrics.js),
// exactly like trainingLoadMetricsMeasurements.js's own httpError already
// does for e.g. scopeCapabilitiesRequired.
function httpError(status, message, code) {
  const e = new Error(message);
  e.httpStatus = status;
  if (code) e.code = code;
  return e;
}

// Resolves a client-supplied activityId through the canonical alias chain
// FIRST (a superseded id is a legitimate, transparently-resolved reference,
// exactly like every other reader in this app), then authorizes the
// CANONICAL row against the CURRENT workspace scope — same info-hiding 404
// convention as the rest of the Training Activity module (never 403, never
// distinguishes "doesn't exist" from "not yours").
async function resolveExplicitActivity(client, scope, activityId) {
  const canonicalRes = await client.query(`select training.resolve_canonical_activity_id($1) as id`, [activityId]);
  const canonicalId = canonicalRes.rows[0]?.id;
  const row = canonicalId
    ? await client.query(`select id, owner_scope, owner_user_id, owner_club_id, owner_team_id, occurred_local_date from training.activities where id=$1`, [canonicalId])
    : { rowCount: 0 };
  if (!row.rowCount) throw httpError(404, "Activity not found.");
  const activity = row.rows[0];
  if (!canManageActivityInScope(scope, activity)) throw httpError(404, "Activity not found.");
  return activity;
}

// Idempotent event-level link: at most one CONFIRMED
// activity_metric_event_links row per metric_event_id (real partial unique
// index, training_activity_v2). A retry (same event, same resolved
// activity) is a safe no-op; an attempt to point the SAME event at a
// DIFFERENT activity than it is already confirmedly linked to is refused —
// never silently repointed.
async function ensureConfirmedEventLink(client, { activityId, eventId, performedBy, linkMethod }) {
  const existing = await client.query(
    `select activity_id from training.activity_metric_event_links where metric_event_id=$1 and link_status='confirmed'`,
    [eventId],
  );
  if (existing.rowCount) {
    const canonical = await client.query(`select training.resolve_canonical_activity_id($1) as id`, [existing.rows[0].activity_id]);
    if (String(canonical.rows[0].id) !== String(activityId)) {
      throw httpError(409, "This metric event is already linked to a different activity.");
    }
    return;
  }
  await client.query(
    `insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
     values ($1,$2,$3,'confirmed',$4,now(),$4)`,
    [activityId, eventId, linkMethod, performedBy],
  );
}

// Idempotent participant-level link. Advisory-locked on (activityId,
// athleteId) so two concurrent operations that both need a
// training.activity_participants row for the SAME athlete under the SAME
// activity (e.g. two sources reporting the same group session in parallel)
// serialize on the check-then-insert instead of racing the real
// unique(activity_id, athlete_id) constraint into a raw 23505.
async function ensureParticipantMetricLink(client, { activityId, athleteId, localDate, timezone, metricEventParticipantId, performedBy }) {
  const already = await client.query(
    `select 1 from training.activity_participant_metric_participant_links where metric_event_participant_id=$1 and link_status='confirmed'`,
    [metricEventParticipantId],
  );
  if (already.rowCount) return;

  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 6))`, [`activity-participant-upsert:${activityId}:${athleteId}`]);
  let participantRow = await client.query(`select id from training.activity_participants where activity_id=$1 and athlete_id=$2`, [activityId, athleteId]);
  let activityParticipantId = participantRow.rows[0]?.id;
  if (!activityParticipantId) {
    const inserted = await client.query(
      `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status)
       values ($1,$2,$3,$4,'participated') returning id`,
      [activityId, athleteId, localDate, timezone],
    );
    activityParticipantId = inserted.rows[0].id;
  }
  await client.query(
    `insert into training.activity_participant_metric_participant_links (activity_participant_id, metric_event_participant_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
     values ($1,$2,'automatic','confirmed',$3,now(),$3)`,
    [activityParticipantId, metricEventParticipantId, performedBy],
  );
}

// Section 5 — component-segment linking. Idempotent per segment; advisory
// locked so two concurrent writers touching the SAME never-before-seen
// segment can never both create a duplicate source-component snapshot.
// Multiple metrics of the same segment share this one link automatically —
// this is called ONCE per segment (never per value).
const DEFAULT_SOURCE_COMPONENT_TYPE = "interval";
async function resolveOrCreateComponentLink(client, { activityId, segment, performedBy }) {
  const existing = await client.query(
    `select activity_component_id from training.activity_component_metric_segment_links where metric_event_segment_id=$1 and link_status='confirmed'`,
    [segment.segmentId],
  );
  if (existing.rowCount) return existing.rows[0].activity_component_id;

  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 7))`, [`activity-component-segment:${segment.segmentId}`]);
  const recheck = await client.query(
    `select activity_component_id from training.activity_component_metric_segment_links where metric_event_segment_id=$1 and link_status='confirmed'`,
    [segment.segmentId],
  );
  if (recheck.rowCount) return recheck.rows[0].activity_component_id;

  let targetComponentId = segment.activityComponentId || null;
  let linkMethod = "manual";
  if (targetComponentId) {
    const comp = await client.query(`select activity_id from training.activity_components where id=$1`, [targetComponentId]);
    if (!comp.rowCount) throw httpError(404, "Activity component not found.");
    if (String(comp.rows[0].activity_id) !== String(activityId)) {
      throw httpError(409, "That activity component does not belong to this event's own activity.");
    }
  } else {
    linkMethod = "automatic";
    const inserted = await client.query(
      `insert into training.activity_components (activity_id, component_type_key, name_snapshot, origin, sort_order)
       values ($1,$2,$3,'api_source',1) returning id`,
      [activityId, DEFAULT_SOURCE_COMPONENT_TYPE, segment.label || "Segment"],
    );
    targetComponentId = inserted.rows[0].id;
  }
  await client.query(
    `insert into training.activity_component_metric_segment_links (activity_component_id, metric_event_segment_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
     values ($1,$2,$3,'confirmed',$4,now(),$4)`,
    [targetComponentId, segment.segmentId, linkMethod, performedBy],
  );
  return targetComponentId;
}

// Solo (single-participant), no-authoritative-identity path — mirrors
// materializeActivityParticipant's own decision table exactly: 0
// candidates -> new confirmed; 1 strong candidate -> auto-matched; anything
// else -> a NEW provisional activity plus one suggestion per candidate,
// never an automatic merge of an uncertain match. The multi-participant
// generalization of this same policy is materializeGroupFuzzyActivity,
// below.
async function materializeSoloFuzzyActivity(client, { ownerScope, ownerIds, athleteId, localDate, timezone, startInstant, eventName, activityTypeKey, performedBy }) {
  const { candidates } = await findActivityCandidates(client, {
    ownerScope, ownerIds, athleteId, localDate, startInstant, endInstant: null, durationMinutes: null,
    name: eventName, activityTypeKey, planLogicalSessionId: null, externalAssignmentId: null,
  });
  const strong = candidates.filter((c) => c.strong);

  if (candidates.length === 0) {
    const activityInsert = await client.query(
      `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_user_id, owner_club_id, owner_team_id, origin, lifecycle_state, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'source_import','confirmed',$10) returning id`,
      [activityTypeKey || null, eventName || null, localDate, startInstant || null, timezone, ownerScope, ownerIds?.userId || null, ownerIds?.clubId || null, ownerIds?.teamId || null, performedBy || null],
    );
    return { activityId: activityInsert.rows[0].id, suggestions: [] };
  }

  if (strong.length === 1 && candidates.length === 1) {
    await client.query(`select 1 from training.activities where id=$1 for update`, [strong[0].activity_id]);
    return { activityId: strong[0].activity_id, suggestions: [] };
  }

  const activityInsert = await client.query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_user_id, owner_club_id, owner_team_id, origin, lifecycle_state, created_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'source_import','provisional',$10) returning id`,
    [activityTypeKey || null, eventName || null, localDate, startInstant || null, timezone, ownerScope, ownerIds?.userId || null, ownerIds?.clubId || null, ownerIds?.teamId || null, performedBy || null],
  );
  const activityId = activityInsert.rows[0].id;
  const participantInsert = await client.query(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status)
     values ($1,$2,$3,$4,'participated') returning id`,
    [activityId, athleteId, localDate, timezone],
  );
  const sourceParticipantId = participantInsert.rows[0].id;
  const suggestions = [];
  for (const c of candidates) {
    const sugInsert = await client.query(
      `insert into training.activity_match_suggestions (activity_id, source_participant_id, candidate_activity_id, candidate_participant_id, confidence, score_breakdown, policy_version, reason)
       values ($1,$2,$3,$4,$5,$6,$7,'candidate recorded for human review — see score_breakdown for why it did not auto-confirm') returning id`,
      [activityId, sourceParticipantId, c.activity_id, c.participant_id, c.score, JSON.stringify(c.breakdown), c.policyVersion],
    );
    suggestions.push({ suggestionId: sugInsert.rows[0].id, candidateActivityId: c.activity_id, confidence: c.score });
  }
  return { activityId, suggestions };
}

// -----------------------------------------------------------------------
// Group (multi-participant), no-authoritative-identity path — the SAME
// candidate scoring findActivityCandidates/scoreCandidate already use for
// the solo path (MATCH_POLICY_VERSION, the same time/duration/name/type
// signal breakdown), run ONCE per participant against that participant's
// own athlete/date, then AGGREGATED across the whole group. This is
// deliberately not a new/parallel policy — no new scoring dimension is
// invented — but "participant overlap" (rule 1's own explicit signal) IS
// real here: when the group's candidate search converges on exactly ONE
// activity id and every participant who found any candidate found ONLY
// that same strong one, that convergence across independent per-athlete
// searches (never a single-participant coincidence) IS the overlap
// signal — captured structurally by the consistency check below, not by
// inventing a new weighted score.
//
// Decision table (mirrors materializeSoloFuzzyActivity's own table,
// generalized to N participants):
//   0 distinct candidate activities across the WHOLE group -> new, confirmed
//   1 distinct candidate activity, AND every participant's own candidate
//     set is either empty or EXACTLY that one activity scored strong
//     -> auto-matched (reuse the existing activity)
//   otherwise (2+ distinct candidate activities, or any participant has an
//     ambiguous/weak candidate set) -> ONE new provisional activity, every
//     participant added to it, and — for each participant that actually
//     has candidates — one activity_match_suggestions row per candidate,
//     using that participant's own activity_participants row as
//     source_participant_id. This is the SAME per-participant suggestion
//     shape the solo path and materializeActivityParticipant's own
//     ambiguous_new branch already use; a "group suggestion" is simply
//     every member of the group who has one recorded independently, all
//     sharing the SAME provisional activity_id — resolved one at a time
//     through the EXISTING accept/dismiss flow (already proven, by tests
//     55/56/57 in training-activity.test.mjs, to handle a shared activity
//     with several independent participants' suggestion groups without
//     cross-resolving each other).
//
// Concurrency: advisory-locked on the group's own identity (owner scope +
// date + the FULL sorted set of athlete ids) BEFORE any candidate search —
// same convention as the solo path's own per-athlete lock, generalized so
// two concurrent imports describing the SAME real group session (same
// participants, same date, same owner) can never independently decide
// "no candidates -> new activity" and each create their own duplicate.
async function materializeGroupFuzzyActivity(client, { ownerScope, ownerIds, localDate, startInstant, eventName, activityTypeKey, participants, performedBy }, { onLocked } = {}) {
  const sortedAthleteIds = [...new Set(participants.map((p) => p.athleteId))].sort();
  const groupKey = `activity-group-fuzzy:${ownerScope}:${ownerIds?.userId || ""}:${ownerIds?.clubId || ""}:${ownerIds?.teamId || ""}:${localDate}:${sortedAthleteIds.join(",")}`;
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 8))`, [groupKey]);
  // Test-only hook (default no-op), same convention as every other
  // deterministic-lock-proof point in this codebase — called the instant
  // this advisory lock is genuinely held, so a test can pause here and
  // prove a second, concurrent import describing the SAME real group
  // (same athletes/date/owner) is really lock-waiting before releasing
  // the first.
  if (onLocked) await onLocked(client);

  const perParticipant = [];
  for (const p of participants) {
    const { candidates } = await findActivityCandidates(client, {
      ownerScope, ownerIds, athleteId: p.athleteId, localDate, startInstant, endInstant: null, durationMinutes: null,
      name: eventName, activityTypeKey, planLogicalSessionId: null, externalAssignmentId: null,
    });
    perParticipant.push({ athleteId: p.athleteId, candidates });
  }

  const allCandidateActivityIds = new Set();
  for (const pp of perParticipant) for (const c of pp.candidates) allCandidateActivityIds.add(c.activity_id);

  if (allCandidateActivityIds.size === 0) {
    const activityInsert = await client.query(
      `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_user_id, owner_club_id, owner_team_id, origin, lifecycle_state, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'source_import','confirmed',$10) returning id`,
      [activityTypeKey || null, eventName || null, localDate, startInstant || null, participants[0].timezone, ownerScope, ownerIds?.userId || null, ownerIds?.clubId || null, ownerIds?.teamId || null, performedBy || null],
    );
    return { activityId: activityInsert.rows[0].id, suggestions: [] };
  }

  if (allCandidateActivityIds.size === 1) {
    const [onlyId] = allCandidateActivityIds;
    const allConsistentAndStrong = perParticipant.every(
      (pp) => pp.candidates.length === 0 || (pp.candidates.length === 1 && pp.candidates[0].activity_id === onlyId && pp.candidates[0].strong),
    );
    if (allConsistentAndStrong) {
      await client.query(`select 1 from training.activities where id=$1 for update`, [onlyId]);
      return { activityId: onlyId, suggestions: [] };
    }
  }

  // Ambiguous — never an automatic merge of an uncertain match.
  const activityInsert = await client.query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_user_id, owner_club_id, owner_team_id, origin, lifecycle_state, created_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'source_import','provisional',$10) returning id`,
    [activityTypeKey || null, eventName || null, localDate, startInstant || null, participants[0].timezone, ownerScope, ownerIds?.userId || null, ownerIds?.clubId || null, ownerIds?.teamId || null, performedBy || null],
  );
  const activityId = activityInsert.rows[0].id;
  const suggestions = [];
  for (const p of participants) {
    const participantInsert = await client.query(
      `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status)
       values ($1,$2,$3,$4,'participated') returning id`,
      [activityId, p.athleteId, localDate, p.timezone],
    );
    const sourceParticipantId = participantInsert.rows[0].id;
    const pp = perParticipant.find((x) => x.athleteId === p.athleteId);
    for (const c of pp.candidates) {
      const sugInsert = await client.query(
        `insert into training.activity_match_suggestions (activity_id, source_participant_id, candidate_activity_id, candidate_participant_id, confidence, score_breakdown, policy_version, reason)
         values ($1,$2,$3,$4,$5,$6,$7,'candidate recorded for human review — see score_breakdown for why it did not auto-confirm (group event)') returning id`,
        [activityId, sourceParticipantId, c.activity_id, c.participant_id, c.score, JSON.stringify(c.breakdown), c.policyVersion],
      );
      suggestions.push({ suggestionId: sugInsert.rows[0].id, candidateActivityId: c.activity_id, athleteId: p.athleteId, confidence: c.score });
    }
  }
  return { activityId, suggestions };
}

// Section 2 (correction round): reparent_activity_participant() itself
// raises a raw P0001 (with the conflicting event's own UUID embedded in
// the message) when the participant being moved has a CONFIRMED metric-
// participant link whose event is not (yet) linked to the target activity
// — i.e. that participant is ALSO tied to a genuinely THIRD, unrelated
// activity this merge never asked to touch. That is a real, expected
// business conflict, not a bug — but it must reach the API as a
// controlled, info-hiding 409, never the DB's own raw message (which both
// leaks a UUID and isn't a stable contract). Checked PROACTIVELY, before
// ever calling reparent, so the failure path never depends on parsing a
// P0001 message string; reparent's own raise stays as an unconditional
// last-resort backstop for any path that reaches it some other way.
async function assertNoConflictingThirdActivityLink(client, { activityParticipantId, targetActivityId }) {
  const rows = await client.query(
    `select mep.event_id from training.activity_participant_metric_participant_links mpl
     join training_load.metric_event_participants mep on mep.id = mpl.metric_event_participant_id
     where mpl.activity_participant_id = $1 and mpl.link_status = 'confirmed'`,
    [activityParticipantId],
  );
  for (const row of rows.rows) {
    const linked = await client.query(
      `select 1 from training.activity_metric_event_links where activity_id=$1 and metric_event_id=$2 and link_status='confirmed'`,
      [targetActivityId, row.event_id],
    );
    if (!linked.rowCount) {
      throw httpError(409, "This participant is already linked to a different, unrelated activity through an existing metric event — refusing to merge automatically.", "activityLinkConflict");
    }
  }
}

// -----------------------------------------------------------------------
// Main entry point — called by createGroupEvent (trainingLoadMetricsMeasurements.js)
// once, right after the event/segments/participants rows are inserted and
// BEFORE any occasion/value row is written (a component-scope value insert
// needs the confirmed segment->component link this function creates to
// already exist — see the real DB trigger
// training_load.check_metric_value_scope_capability, training_activity_v3).
//
// `participants`: [{ metricEventParticipantId, athleteId, timezone,
//   logicalSessionId, externalAssignmentId, trainingLoadEnabled }] —
//   trainingLoadEnabled is the SAME plans.plan_sessions.training_load_enabled
//   value resolveParticipantLink already read for a logicalSessionId
//   participant (null when the participant carries no logicalSessionId at
//   all — irrelevant then).
// `segments`: [{ segmentId, label, activityComponentId }] — only segments
//   that actually received at least one value in this request; each is
//   linked to exactly one activity component.
// Returns { activityId, linkStatus, suggestions, componentLinksBySegmentId }.
// -----------------------------------------------------------------------
export async function linkMetricEventToActivity(client, {
  scope, eventId, occurredDate, occurredInstant, eventName, activityTypeKey,
  explicitActivityId, segments, participants, performedBy,
}, { onNaturalKeyLocked, onGroupFuzzyLocked } = {}) {
  const ownerScope = scope.ownerContext.ownerScope;
  const ownerIds = { userId: scope.ownerContext.ownerUserId, clubId: scope.ownerContext.ownerClubId, teamId: scope.ownerContext.ownerTeamId };

  // Rule: an explicit attempt to link via a logicalSessionId whose planned
  // session is training_load_enabled=false is controlled-rejected with
  // zero partial writes — checked FIRST, before any Activity row is
  // touched, so the whole transaction rolls back cleanly on throw.
  for (const p of participants) {
    if (p.logicalSessionId && p.trainingLoadEnabled === false) {
      throw httpError(409, "That planned session is not enabled for Training Load — refusing to link a metric event to it.", "trainingLoadNotEnabled");
    }
  }

  let activityId;
  let linkStatus;
  let linkMethod;
  let suggestions = [];

  if (explicitActivityId) {
    const activity = await resolveExplicitActivity(client, scope, explicitActivityId);
    if (String(activity.occurred_local_date) !== String(occurredDate)) {
      throw httpError(409, "activityId occurred on a different date than this event.");
    }
    activityId = activity.id;
    linkStatus = "confirmed";
    linkMethod = "manual";
  } else {
    const naturalResults = [];
    const resolvedActivityIds = new Set();
    let firstNaturalKeyCall = true;
    for (const p of participants) {
      if (p.logicalSessionId || p.externalAssignmentId) {
        const r = await materializeNaturalKeyActivity(client, {
          logicalSessionId: p.logicalSessionId || null, externalAssignmentId: p.externalAssignmentId || null,
          athleteId: p.athleteId, localDate: occurredDate, timezone: p.timezone, startInstant: occurredInstant,
          sessionName: eventName, ownerScope, ownerIds, performedBy,
        }, { onLocked: firstNaturalKeyCall ? onNaturalKeyLocked : undefined });
        firstNaturalKeyCall = false;
        naturalResults.push({ p, activityId: r.activityId, participantId: r.participantId });
        resolvedActivityIds.add(r.activityId);
      } else {
        naturalResults.push({ p, activityId: null, participantId: null });
      }
    }

    if (resolvedActivityIds.size > 0) {
      const distinctIds = [...resolvedActivityIds];
      activityId = distinctIds[0];
      // Section 4: two participants whose own natural keys resolved to
      // DIFFERENT existing activities, but who are provably part of the
      // SAME group metric event, get merged into ONE canonical activity —
      // via the sanctioned reparent function (each is a DIFFERENT athlete,
      // so this is a reparent, never merge_activity_participants, which is
      // reserved for the SAME-athlete alias case). Deterministic lock
      // order: reparent_activity_participant itself advisory-locks the
      // participant identity first, then both activities ascending by id.
      for (const otherId of distinctIds.slice(1)) {
        for (const nr of naturalResults) {
          if (nr.activityId === otherId) {
            await assertNoConflictingThirdActivityLink(client, { activityParticipantId: nr.participantId, targetActivityId: activityId });
            await client.query(`select training.reparent_activity_participant($1,$2,$3,$4,'none',null)`, [nr.participantId, activityId, performedBy, "merged via Training Activity 2B group metric event linking — proven same session"]);
          }
        }
      }
      linkStatus = "confirmed";
      linkMethod = "automatic";
    } else if (participants.length === 1) {
      const solo = participants[0];
      const result = await materializeSoloFuzzyActivity(client, {
        ownerScope, ownerIds, athleteId: solo.athleteId, localDate: occurredDate, timezone: solo.timezone,
        startInstant: occurredInstant, eventName, activityTypeKey, performedBy,
      });
      activityId = result.activityId;
      suggestions = result.suggestions;
      linkStatus = suggestions.length ? "suggested" : "confirmed";
      linkMethod = "automatic";
    } else {
      // Correction round: a standalone GROUP event (no explicit activityId,
      // no participant has an authoritative logicalSessionId/
      // externalAssignmentId) used to call training.materialize_activity_
      // group_from_metric_event() unconditionally — that DB function has no
      // candidate-search concept at all (it only resolves via an EXISTING
      // confirmed link on this exact event id, or else always creates a
      // brand-new activity), so it could silently duplicate an
      // already-existing, genuinely-the-same real-world session recorded
      // through a DIFFERENT metric event (e.g. a future GPEXE group
      // import). Replaced with materializeGroupFuzzyActivity, which reuses
      // the SAME per-athlete candidate scoring the solo path already uses,
      // aggregated across the whole group — see that function's own header
      // for the full decision table.
      const result = await materializeGroupFuzzyActivity(client, {
        ownerScope, ownerIds, localDate: occurredDate, startInstant: occurredInstant,
        eventName, activityTypeKey, participants, performedBy,
      }, { onLocked: onGroupFuzzyLocked });
      activityId = result.activityId;
      suggestions = result.suggestions;
      linkStatus = suggestions.length ? "suggested" : "confirmed";
      linkMethod = "automatic";
    }
  }

  await ensureConfirmedEventLink(client, { activityId, eventId, performedBy, linkMethod });
  for (const p of participants) {
    await ensureParticipantMetricLink(client, {
      activityId, athleteId: p.athleteId, localDate: occurredDate, timezone: p.timezone,
      metricEventParticipantId: p.metricEventParticipantId, performedBy,
    });
  }

  const componentLinksBySegmentId = new Map();
  for (const seg of segments) {
    const componentId = await resolveOrCreateComponentLink(client, { activityId, segment: seg, performedBy });
    componentLinksBySegmentId.set(seg.segmentId, componentId);
  }

  return { activityId, linkStatus, suggestions, componentLinksBySegmentId };
}
