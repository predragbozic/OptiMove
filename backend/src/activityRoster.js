// Session roster read model (Phase 5a1): GET /api/training-activity/:activityId/roster.
//
// Contract: docs/ai/phase5a-discovery-and-contract.md, sections 2 and 4.
// This is a READ: it runs in one read-only REPEATABLE READ transaction (one
// consistent snapshot), creates no completion row, writes no decision,
// membership period or observation, and never calls a source such as GPEXE.
//
// Who may read: the roster of a TEAM-owned activity is shown to someone who
// may decide on it, through the path of their ACTIVE workspace (owner
// decision O2, 2026-09-25):
//   team workspace of the activity's team, as its team coach   -> team_coach
//   club workspace of the team's club, as that club's admin     -> club_admin
//   platform workspace, as a platform admin                     -> platform_admin
// Holding a stronger role elsewhere is never a substitute for the active
// path. A missing activity, an archived team and every other caller get the
// same 404 (ADR-006). An activity that is not team-owned has no roster: 409
// roster_not_applicable, but only for a caller who may otherwise manage the
// activity in the active workspace; everyone else gets the 404.
//
// States are derived, never stored (contract section 2). Measured comes from
// effective api_import / csv_import values in canonical_activity_results()
// (ADR-001), never from activity_participants.participation_status (the
// GPEXE path writes 'planned' for a measured athlete).
import crypto from "node:crypto";
import { pool } from "./db.js";
import { holdsClubAdminRole, holdsTeamCoachRole, isPlatformAdministrator } from "./authz.js";
import { activityScopeForWorkspace, canManageActivityInScope } from "./trainingActivityAccess.js";

export class RosterError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

const notFound = () => new RosterError(404, "notFound", "Not found.");

// The user-facing words of every state. participated_no_values is O1 (a):
// "Participated · no device data", valid for a match and for sources that
// are not GPS as well.
export const ROSTER_STATE_LABELS = Object.freeze({
  did_not_participate: "Did not participate",
  participated_no_values: "Participated · no device data",
  manual_values: "Manual values",
  estimated: "Estimated",
  measured_change_waiting: "Measured · change waiting",
  measured: "Measured",
  no_usable_device_record: "No usable device record",
  unknown: "Unknown",
});

// Neutral reason codes an adapter writes for an unusable record, in the
// coach's words (the source is named separately).
export const SOURCE_REASON_LABELS = Object.freeze({
  needs_manual_review: "flagged this record for a manual check",
  marked_invalid_by_source: "marks this record as not valid",
});

const MEASURED_METHODS = new Set(["api_import", "csv_import"]);

// Which authorization path the caller uses for this team in the active
// workspace, or null.
export function rosterBasisForWorkspace(workspace, authz, team) {
  if (!workspace || !team) return null;
  if (workspace.type === "team" && String(workspace.scopeId) === String(team.id) && holdsTeamCoachRole(authz, team.id)) return "team_coach";
  if (workspace.type === "club" && String(workspace.scopeId) === String(team.club_id) && holdsClubAdminRole(authz, team.club_id)) return "club_admin";
  if (workspace.type === "platform" && isPlatformAdministrator(authz)) return "platform_admin";
  return null;
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// sha256 over what the roster's states rest on: per athlete (sorted), the
// state, the current decision ids and the effective occasion ids. 5a2 stores
// it at completion; a read compares it with the stored one.
export function rosterFingerprint(athletes) {
  const rows = athletes
    .map((a) => [a.athleteId, a.state, [...a.decisionIds].sort(), [...a.occasionIds].sort()])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function decisionView(row) {
  return {
    id: String(row.id),
    activityId: String(row.activity_id),
    kind: row.decision_kind,
    label: ROSTER_STATE_LABELS[row.decision_kind] ?? null,
    reasonKey: row.reason_key ?? null,
    note: row.note ?? null,
    decidedBy: { userId: String(row.decided_by_user_id), name: row.decided_by_name ?? null, basis: row.decided_by_basis },
    decidedAt: iso(row.decided_at),
  };
}

// The derived state of one roster athlete (contract section 2, first match
// wins), with its group, flags and what it rests on.
export function deriveAthleteState({ decisions, facts, needsReview, observations }) {
  const flags = [];
  const measured = facts.filter((f) => MEASURED_METHODS.has(f.entryMethod));
  const manual = facts.filter((f) => f.entryMethod === "manual");
  const effective = decisions.filter((d) => d.decision_kind !== "cleared");
  const unusable = observations.find((o) => o.kind === "record_unusable") ?? null;
  const changePending = observations.some((o) => o.kind === "change_pending");

  let state;
  let group;
  let sourceReason = null;
  const distinct = new Set(decisions.map((d) => `${d.decision_kind}|${d.reason_key ?? ""}`));
  if (decisions.length > 1 && distinct.size > 1) {
    // Two alias activities hold different current decisions (a merge). The
    // coach decides once; until then the athlete needs a state.
    state = "unknown";
    group = "needs_state";
    flags.push("decisions_disagree");
  } else if (effective.length) {
    state = effective[0].decision_kind;
    group = "done";
    if (measured.length) {
      flags.push("measured_after_decision");
      group = "needs_review";
    }
  } else if (measured.length) {
    if (needsReview || changePending) {
      state = "measured_change_waiting";
      group = "needs_review";
    } else {
      state = "measured";
      group = "done";
    }
  } else if (unusable) {
    state = "no_usable_device_record";
    group = "needs_state";
  } else {
    state = "unknown";
    group = "needs_state";
  }
  if (unusable && (state === "no_usable_device_record" || state === "unknown")) {
    sourceReason = {
      code: unusable.reason_code,
      sourceSystem: unusable.source_system,
      label: SOURCE_REASON_LABELS[unusable.reason_code] ?? null,
    };
  }
  if (manual.length && !measured.length && !effective.length) flags.push("manual_values_recorded");
  return { state, group, flags, sourceReason };
}

function valuesView(facts) {
  return facts
    .filter((f) => f.segmentId === null)
    .map((f) => ({
      metricKey: f.metricKey, label: f.metricLabel, shortLabel: f.metricShortLabel,
      value: f.valueNumeric, valueText: f.valueText, unit: f.unit, entryMethod: f.entryMethod,
    }))
    .sort((a, b) => String(a.metricKey).localeCompare(String(b.metricKey)));
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = String(row[key]);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

async function readInSnapshot(fn) {
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Resolves the addressed activity to its canonical team activity and the
// caller's basis in the active workspace, with the same answers for reads
// and writes: a missing activity, an archived team and every caller outside
// the active-workspace path -> 404 notFound; a session that is not
// team-owned -> 409 roster_not_applicable, but only for a caller who may
// manage it in the active workspace.
export async function resolveRosterTarget(client, ctx, activityId) {
  const one = async (sql, params) => (await client.query(sql, params)).rows;
  const found = (await one(
    `select training.resolve_canonical_activity_id(id) as canonical_id from training.activities where id = $1`,
    [activityId],
  ))[0];
  if (!found) throw notFound();
  const canonicalId = String(found.canonical_id);
  const activity = (await one(
    `select id, name, activity_type_key, occurred_local_date::text as occurred_local_date, started_at, timezone_snapshot,
            owner_scope, owner_user_id, owner_club_id, owner_team_id
       from training.activities where id = $1`,
    [canonicalId],
  ))[0];
  if (!activity) throw notFound();

  if (activity.owner_scope !== "team") {
    const scope = activityScopeForWorkspace(ctx.workspace, { user: { id: ctx.userId } });
    if (scope.type !== null && canManageActivityInScope(scope, activity)) {
      throw new RosterError(409, "roster_not_applicable", "Only a team session has a roster.");
    }
    throw notFound();
  }
  const team = (await one(
    `select id, club_id from public.teams where id = $1 and coalesce(is_active, true)`,
    [activity.owner_team_id],
  ))[0];
  const basis = rosterBasisForWorkspace(ctx.workspace, ctx.authz, team);
  if (!basis) throw notFound();
  return { canonicalId, activity, team, basis };
}

// Everything the roster rests on, read with the given client: inside the
// read's REPEATABLE READ snapshot, or inside a command's transaction after
// its locks (and after its own writes, which it then sees).
export async function loadRosterSnapshot(client, canonicalId) {
  const one = async (sql, params) => (await client.query(sql, params)).rows;
  const roster = await one(
    `select r.athlete_id, r.member_from, r.member_to, r.left_at,
            coalesce(nullif(a.display_name, ''), a.full_name) as name
       from training.activity_roster($1) r
       join public.athletes a on a.id = r.athlete_id`,
    [canonicalId],
  );
  const facts = (await one(
    `select r.athlete_id, r.detail ->> 'entryMethod' as entry_method, r.detail ->> 'occasionId' as occasion_id,
            r.detail ->> 'segmentId' as segment_id, r.detail ->> 'valueNumeric' as value_numeric,
            r.detail ->> 'valueText' as value_text, r.detail ->> 'unitAtCapture' as unit,
            d.key as metric_key, d.label as metric_label, d.short_label as metric_short_label
       from training.canonical_activity_results($1) r
       left join training_load.metric_definitions d on d.id = (r.detail ->> 'metricDefinitionId')::uuid
      where r.fact_kind = 'metric_value'`,
    [canonicalId],
  )).map((r) => ({
    athleteId: String(r.athlete_id), entryMethod: r.entry_method, occasionId: r.occasion_id,
    segmentId: r.segment_id ?? null, valueNumeric: numberOrNull(r.value_numeric), valueText: r.value_text ?? null,
    unit: r.unit ?? null, metricKey: r.metric_key ?? null, metricLabel: r.metric_label ?? null, metricShortLabel: r.metric_short_label ?? null,
  }));
  const needsReview = new Set((await one(
    `select distinct ap.athlete_id
       from training.activity_alias_ids($1) aa
       join training.activity_participants ap on ap.activity_id = aa.activity_id
       join training.activity_participant_metric_participant_links l
            on l.activity_participant_id = ap.id and l.link_status = 'confirmed'
       join training_load.metric_measurement_occasions o on o.event_participant_id = l.metric_event_participant_id
      where o.import_conflict_status = 'needs_review' and o.superseded_by_occasion_id is null`,
    [canonicalId],
  )).map((r) => String(r.athlete_id)));
  const observations = await one(
    `select o.athlete_id, o.kind, o.reason_code, c.source_system
       from training.activity_source_observations o
       join training_load.metric_source_connections c on c.id = o.source_connection_id
      where o.activity_id in (select activity_id from training.activity_alias_ids($1)) and o.resolved_at is null`,
    [canonicalId],
  );
  const decisions = await one(
    `select d.id, d.activity_id, d.athlete_id, d.decision_kind, d.reason_key, d.note, d.decided_by_user_id,
            d.decided_by_basis, d.decided_at, coalesce(nullif(u.display_name, ''), u.full_name) as decided_by_name
       from training.activity_athlete_decisions d
       left join public.users u on u.id = d.decided_by_user_id
      where d.activity_id in (select activity_id from training.activity_alias_ids($1))
        and d.superseded_by_decision_id is null
      order by d.decided_at, d.id`,
    [canonicalId],
  );
  const completionRow = (await one(
    `select c.status, c.revision, c.completed_by_user_id, c.completed_by_basis, c.completed_at, c.input_fingerprint,
            c.needs_review_causes, coalesce(nullif(u.display_name, ''), u.full_name) as completed_by_name
       from training.activity_completions c
       left join public.users u on u.id = c.completed_by_user_id
      where c.activity_id = $1`,
    [canonicalId],
  ))[0] ?? null;
  const reasons = await one(
    `select key, label from training.participation_reasons where is_active order by sort_order, key`,
    [],
  );

  const factsByAthlete = groupBy(facts, "athleteId");
  const observationsByAthlete = groupBy(observations, "athlete_id");
  const decisionsByAthlete = groupBy(decisions, "athlete_id");
  const rosterIds = new Set(roster.map((r) => String(r.athlete_id)));

  const athletes = roster.map((r) => {
    const athleteId = String(r.athlete_id);
    const athleteFacts = factsByAthlete.get(athleteId) ?? [];
    const athleteDecisions = decisionsByAthlete.get(athleteId) ?? [];
    const derived = deriveAthleteState({
      decisions: athleteDecisions,
      facts: athleteFacts,
      needsReview: needsReview.has(athleteId),
      observations: observationsByAthlete.get(athleteId) ?? [],
    });
    const flags = [...derived.flags];
    if (r.left_at) flags.push("left_team");
    const effectiveDecisions = athleteDecisions.filter((d) => d.decision_kind !== "cleared");
    return {
      athleteId,
      name: r.name ?? null,
      membership: { from: iso(r.member_from), to: iso(r.member_to), leftAfterSession: Boolean(r.left_at), leftAt: iso(r.left_at) },
      state: derived.state,
      stateLabel: ROSTER_STATE_LABELS[derived.state],
      group: derived.group,
      // Several current decisions that agree (the same decision on two
      // aliases before a merge) still show one: the latest.
      decision: effectiveDecisions.length && !flags.includes("decisions_disagree") ? decisionView(effectiveDecisions[effectiveDecisions.length - 1]) : null,
      ...(flags.includes("decisions_disagree") ? { conflictingDecisions: athleteDecisions.map(decisionView) } : {}),
      flags,
      sourceReason: derived.sourceReason,
      values: valuesView(athleteFacts),
      // Internal (removed by publicAthlete): what the fingerprint and the
      // 5a2 commands rest on.
      decisionIds: athleteDecisions.map((d) => String(d.id)),
      currentDecisions: athleteDecisions,
      occasionIds: [...new Set(athleteFacts.map((f) => f.occasionId).filter(Boolean))],
      measured: athleteFacts.some((f) => MEASURED_METHODS.has(f.entryMethod)),
    };
  }).sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")) || a.athleteId.localeCompare(b.athleteId));

  // Recorded by a source, but not on this session's roster (no membership
  // period of the team covers the session): listed apart, never blocking.
  // Deliberately no finer reason (joined later, left earlier, never a
  // member): nothing here proves which one it is.
  const outsideIds = [...new Set(facts.filter((f) => MEASURED_METHODS.has(f.entryMethod)).map((f) => f.athleteId))]
    .filter((id) => !rosterIds.has(id));
  const outsideNames = outsideIds.length
    ? new Map((await one(
      `select id, coalesce(nullif(display_name, ''), full_name) as name from public.athletes where id = any($1::uuid[])`,
      [outsideIds],
    )).map((r) => [String(r.id), r.name]))
    : new Map();
  const recordedOutsideRoster = outsideIds
    .map((athleteId) => ({ athleteId, name: outsideNames.get(athleteId) ?? null, state: "measured", stateLabel: ROSTER_STATE_LABELS.measured, values: valuesView(factsByAthlete.get(athleteId) ?? []) }))
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")) || a.athleteId.localeCompare(b.athleteId));

  const fingerprint = rosterFingerprint(athletes);
  // The second layer of "complete never stays true" (contract 3.4): what
  // the completion rested on is compared on every read. A read reports it;
  // the next 5a2 command persists it (cause input_changed).
  const inputChanged = Boolean(completionRow && completionRow.status === "complete" && completionRow.input_fingerprint !== fingerprint);
  let completion = { status: "not_complete", revision: 0, completedBy: null, completedAt: null, needsReviewCauses: [] };
  if (completionRow) {
    completion = {
      status: completionRow.status,
      revision: completionRow.revision,
      completedBy: completionRow.completed_by_user_id
        ? { userId: String(completionRow.completed_by_user_id), name: completionRow.completed_by_name ?? null, basis: completionRow.completed_by_basis }
        : null,
      completedAt: iso(completionRow.completed_at),
      needsReviewCauses: [...(completionRow.needs_review_causes ?? [])],
    };
    if (inputChanged) {
      completion = { ...completion, status: "needs_review", needsReviewCauses: ["input_changed"] };
    }
  }
  const counts = {
    total: athletes.length,
    needsState: athletes.filter((a) => a.group === "needs_state").length,
    needsReview: athletes.filter((a) => a.group === "needs_review").length,
    recordedOutsideRoster: recordedOutsideRoster.length,
  };
  return { athletes, recordedOutsideRoster, completionRow, completion, inputChanged, fingerprint, counts, reasons };
}

// The public shape of one roster athlete (internal fields removed).
export function publicAthlete({ decisionIds, currentDecisions, occasionIds, measured, ...rest }) {
  return rest;
}

// ctx = { userId, authz, workspace } — the workspace resolved once for the request.
export async function getActivityRoster(ctx, activityId) {
  return readInSnapshot(async (client) => {
    const { canonicalId, activity, basis } = await resolveRosterTarget(client, ctx, activityId);
    const snap = await loadRosterSnapshot(client, canonicalId);
    return {
      activity: {
        id: String(activityId),
        name: activity.name ?? null,
        activityTypeKey: activity.activity_type_key ?? null,
        occurredLocalDate: activity.occurred_local_date,
        startedAt: iso(activity.started_at),
        timezone: activity.timezone_snapshot,
        ownerTeamId: String(activity.owner_team_id),
      },
      canonicalActivityId: canonicalId,
      viewer: { basis },
      completion: snap.completion,
      // Phase 5a2: the token a Complete sends back as expectedFingerprint —
      // the roster the coach looked at.
      rosterFingerprint: snap.fingerprint,
      athletes: snap.athletes.map(publicAthlete),
      recordedOutsideRoster: snap.recordedOutsideRoster,
      reasons: snap.reasons.map((r) => ({ key: r.key, label: r.label })),
      counts: snap.counts,
      canComplete: snap.counts.total > 0 && snap.counts.needsState === 0 && snap.completion.status !== "complete",
    };
  });
}
