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
// activity in the active workspace; everyone else gets the 404. Neither has
// a self-report activity (v44, owner decision 2026-10-29): a team-owned
// activity of origin planned_session / external_assignment with at most one
// canonical participant across its alias set and no measured value — one
// athlete's own RPE or external result (an external occurrence with two or
// more assignees is one activity for the team's event and keeps its roster).
// The rule is training.activity_has_roster(), the one function every roster
// function reads through; here it answers the same 409 to a caller who may
// decide on the team's sessions and the same 404 to everyone else; a command
// answers its requestKey replay first (activityRosterCommands.js).
//
// States are derived, never stored (contract section 2). Measured comes from
// effective api_import / csv_import values in canonical_activity_results()
// (ADR-001), never from activity_participants.participation_status (the
// GPEXE path writes 'planned' for a measured athlete).
import { estimateLabelFor, readEstimateLabels } from "./estimateLabels.js";
import { athleteSessionTypeView, effectiveTypeAt, effectiveTypeOf, readSessionTypeState, sessionTypeLabels } from "./activitySessionTypes.js";
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
// A self-report activity (v44): the same code as a non-team session.
export const noRoster = () => new RosterError(409, "roster_not_applicable", "This session holds one athlete's own result and has no roster.");

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
  // ST-4 (v88): a device record corrected on the roster is still the athlete's record (measured, marked corrected); a
  // value entered on the roster gives the athlete the state Manual values. A manual value of another path is as before.
  const measured = facts.filter((f) => MEASURED_METHODS.has(f.entryMethod) || (f.manualKind && f.sourceIdentityId));
  const rosterEntry = facts.filter((f) => f.entryMethod === "manual" && f.manualKind && !f.sourceIdentityId);
  const manual = facts.filter((f) => f.entryMethod === "manual" && !f.manualKind);
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
  } else if (rosterEntry.length) {
    state = "manual_values";
    group = "done";
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
  if (manual.length && !measured.length && !effective.length && !rosterEntry.length) flags.push("manual_values_recorded");
  if (facts.some((f) => f.manualKind === "correction")) flags.push("corrected");
  return { state, group, flags, sourceReason };
}

function valuesView(facts, estimateLabels = new Map(), nameInAnswer = () => null, typeChangeOf = () => null) {
  return facts
    .filter((f) => f.segmentId === null)
    .map((f) => {
      const view = {
        metricKey: f.metricKey, label: f.metricLabel, shortLabel: f.metricShortLabel,
        value: f.valueNumeric, valueText: f.valueText, unit: f.unit, entryMethod: f.entryMethod,
      };
      // ST-4: a corrected value carries the measured value it replaced (null when the record held none).
      if (f.manualKind === "correction") view.measuredValue = f.measuredValue;
      // 6b-C1: only an estimated value carries its label (rule 10); every other value is as before.
      if (f.entryMethod === "estimate") {
        const estimate = estimateLabelFor(estimateLabels.get(String(f.occasionId)), nameInAnswer);
        if (estimate) {
          // ST-3: an estimate saved while the athlete's effective type was another one keeps its value and says so.
          const typeChanged = typeChangeOf(f.athleteId, estimate.estimatedAt);
          if (typeChanged) estimate.calculatedWhenType = typeChanged;
          view.estimate = estimate;
        }
      }
      return view;
    })
    .sort((a, b) => String(a.metricKey).localeCompare(String(b.metricKey)));
}

// ST-4 (v88): Map(occasionId -> { kind, by, basis, at, note, measured: Map(definitionId -> number|null) }) for the manual
// occasions a roster answer shows. The author is named (the roster's audience decides on this team; the name is a
// display fact like a decision's decidedBy).
async function readManualProvenance(client, occasionIds) {
  const ids = [...new Set(occasionIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  // A database before v88 (some suites pin one) has no provenance table: no manual value was written on its roster.
  if (!(await client.query(`select to_regclass('training_load.metric_manual_values') is not null as present`)).rows[0].present) return new Map();
  const rows = (await client.query(
    `select m.occasion_id, m.kind, m.entered_by_user_id, m.entered_by_basis, m.entered_at, m.note, m.measured_occasion_id,
            coalesce(nullif(u.display_name, ''), u.full_name) as author
       from training_load.metric_manual_values m
       left join public.users u on u.id = m.entered_by_user_id
      where m.occasion_id = any($1::uuid[])`,
    [ids],
  )).rows;
  const measuredIds = rows.map((r) => r.measured_occasion_id).filter(Boolean);
  const measuredValues = measuredIds.length ? (await client.query(
    `select occasion_id, metric_definition_id, value_numeric::text as value from training_load.metric_values
      where occasion_id = any($1::uuid[]) and not is_derived`,
    [measuredIds],
  )).rows : [];
  const out = new Map();
  for (const r of rows) {
    const measured = new Map(measuredValues.filter((v) => String(v.occasion_id) === String(r.measured_occasion_id))
      .map((v) => [String(v.metric_definition_id), numberOrNull(v.value)]));
    out.set(String(r.occasion_id), {
      kind: r.kind, by: { userId: String(r.entered_by_user_id), name: r.author ?? null, basis: r.entered_by_basis },
      at: iso(r.entered_at), note: r.note ?? null, measured,
    });
  }
  return out;
}

function manualViewOf(athleteFacts, manualRows) {
  const fact = athleteFacts.find((f) => f.manualKind && f.segmentId === null);
  if (!fact) return null;
  const row = manualRows.get(String(fact.occasionId));
  return { kind: row.kind, enteredBy: row.by, enteredAt: row.at, note: row.note };
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
// `deferGate`: a command asks for the v44 gate's answer instead of the 409,
// because its requestKey replay must come first (a saved answer wins over the
// present state); the read lets the 409 be thrown here.
export async function resolveRosterTarget(client, ctx, activityId, { deferGate = false } = {}) {
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
  // An archived team, or a team of an archived club, has no roster to show
  // or change: the identical 404.
  const team = (await one(
    `select t.id, t.club_id from public.teams t join public.clubs c on c.id = t.club_id
      where t.id = $1 and coalesce(t.is_active, true) and coalesce(c.is_active, true)`,
    [activity.owner_team_id],
  ))[0];
  const basis = rosterBasisForWorkspace(ctx.workspace, ctx.authz, team);
  if (!basis) throw notFound();
  // A self-report activity (v44): the caller may decide on this team's
  // sessions, but this one holds one athlete's own result and has no roster.
  // Read only now, after the basis: a caller without one never pays for it.
  const hasRoster = (await one(`select coalesce(training.activity_has_roster($1), false) as has_roster`, [canonicalId]))[0].has_roster;
  if (!hasRoster && !deferGate) throw noRoster();
  return { canonicalId, activity, team, basis, hasRoster };
}

// 7h-V: the placeholder keys of the unnamed variables of one answer, by the
// sorted definition ids (exported for its test).
export function unnamedMetricKeys(definitionIds) {
  return new Map([...new Set(definitionIds.map((id) => String(id ?? "")))]
    .sort()
    .map((id, i) => [id, `#unnamed-${i + 1}`]));
}

// Everything the roster rests on, read with the given client: inside the
// read's REPEATABLE READ snapshot, or inside a command's transaction after
// its locks (and after its own writes, which it then sees).
//
// 7h-V (C127, the Rukovodilac's V1 (a)): a team's results name only the
// variables of the team's own club - a club-owned definition of another club
// (one written into this team's results by a user who also administers that
// club, or left by a team moved between clubs) reads with no key, label or
// short label, for every basis, the platform admin's included. System and
// the other scopes are unchanged here (the other owners' user and team
// variables are a separate info-hiding task). Display only: no roster state
// reads a name.
export async function loadRosterSnapshot(client, canonicalId) {
  const one = async (sql, params) => (await client.query(sql, params)).rows;
  const roster = await one(
    `select r.athlete_id, r.member_from, r.member_to, r.left_at,
            coalesce(nullif(a.display_name, ''), a.full_name) as name
       from training.activity_roster($1) r
       join public.athletes a on a.id = r.athlete_id`,
    [canonicalId],
  );
  const factRows = await one(
    `select r.athlete_id, r.detail ->> 'entryMethod' as entry_method, r.detail ->> 'occasionId' as occasion_id,
            r.detail ->> 'segmentId' as segment_id, r.detail ->> 'valueNumeric' as value_numeric,
            r.detail ->> 'valueText' as value_text, r.detail ->> 'unitAtCapture' as unit,
            r.detail ->> 'metricDefinitionId' as metric_definition_id, d.id is not null as metric_named,
            r.detail ->> 'sourceIdentityId' as source_identity_id,
            d.key as metric_key, d.label as metric_label, d.short_label as metric_short_label
       from training.canonical_activity_results($1) r
       left join training_load.metric_definitions d on d.id = (r.detail ->> 'metricDefinitionId')::uuid
            and (d.owner_scope <> 'club'
                 or d.owner_club_id = (select t.club_id from training.activities a join public.teams t on t.id = a.owner_team_id
                                        where a.id = $1))
      where r.fact_kind = 'metric_value'`,
    [canonicalId],
  );
  // An unnamed variable keeps a column of its own (the screen groups values
  // by key): a placeholder key per definition, in a shape no definition key
  // has ("#"), numbered in this answer by the sorted definition ids - the same
  // for every viewer and read of the same facts, whatever the row order (a new
  // unnamed variable may renumber; the screen groups by key within one answer
  // only and keeps nothing) - so two unnamed
  // variables never share a column and the definition's own key and id never
  // leave here.
  const unnamedKeys = unnamedMetricKeys(factRows.filter((r) => !r.metric_named).map((r) => r.metric_definition_id));
  const unnamedKeyOf = (definitionId) => unnamedKeys.get(String(definitionId ?? ""));
  // ST-4 (v88): the provenance of every manual value written on the roster, and the measured values a correction rests on.
  const manualRows = await readManualProvenance(client, factRows.filter((r) => r.entry_method === "manual" && r.segment_id === null).map((r) => r.occasion_id));
  const facts = factRows.map((r) => ({
    athleteId: String(r.athlete_id), entryMethod: r.entry_method, occasionId: r.occasion_id,
    sourceIdentityId: r.source_identity_id ?? null, manualKind: manualRows.get(String(r.occasion_id))?.kind ?? null,
    measuredValue: manualRows.get(String(r.occasion_id))?.measured.get(String(r.metric_definition_id)) ?? null,
    segmentId: r.segment_id ?? null, valueNumeric: numberOrNull(r.value_numeric), valueText: r.value_text ?? null,
    unit: r.unit ?? null, metricKey: r.metric_named ? (r.metric_key ?? null) : unnamedKeyOf(r.metric_definition_id),
    metricLabel: r.metric_label ?? null, metricShortLabel: r.metric_short_label ?? null,
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
  // 6b-C1: the label of each estimated value; a copy source is named only if this answer already names that athlete.
  const estimateLabels = await readEstimateLabels(client, facts.filter((f) => f.entryMethod === "estimate").map((f) => f.occasionId));
  const answerNames = new Map([...roster.map((r) => [String(r.athlete_id).toLowerCase(), r.name]), ...[...outsideNames].map(([id, name]) => [id.toLowerCase(), name])]);
  const nameInAnswer = (athleteId) => answerNames.get(String(athleteId).toLowerCase()) ?? null;
  // ST-3 (v89): each athlete's effective session type and own exception. The mark of a saved estimate is derived, never
  // stored: the type the athlete had when it was saved, when that differs from the type now (plan section 5).
  const types = await readSessionTypeState(client, canonicalId, { withHistory: estimateLabels.size > 0 });
  const typeMarks = [];
  const typeChangeOf = (athleteId, estimatedAt) => {
    if (!types.installed || !estimatedAt) return null;
    const then = effectiveTypeAt(types, athleteId, new Date(estimatedAt).getTime());
    if (then === effectiveTypeOf(types, athleteId)) return null;
    const mark = { key: then, label: null };
    typeMarks.push(mark);
    return mark;
  };
  const values = (athleteFacts) => valuesView(athleteFacts, estimateLabels, nameInAnswer, typeChangeOf);

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
      values: values(athleteFacts),
      // ST-4: who entered or corrected this athlete's values on the roster, and when (null when nobody did).
      manual: manualViewOf(athleteFacts, manualRows),
      ...(types.installed ? { sessionType: athleteSessionTypeView(types, athleteId) } : {}),
      // Internal (removed by publicAthlete): what the fingerprint and the
      // 5a2 commands rest on.
      decisionIds: athleteDecisions.map((d) => String(d.id)),
      currentDecisions: athleteDecisions,
      occasionIds: [...new Set(athleteFacts.map((f) => f.occasionId).filter(Boolean))],
      measured: athleteFacts.some((f) => MEASURED_METHODS.has(f.entryMethod) || (f.manualKind && f.sourceIdentityId)),
      // ST-4: values entered on the roster (an entry, no source record) - a state is set only after they are removed.
      rosterEntry: athleteFacts.some((f) => f.entryMethod === "manual" && f.manualKind && !f.sourceIdentityId),
    };
  }).sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")) || a.athleteId.localeCompare(b.athleteId));

  const recordedOutsideRoster = outsideIds
    .map((athleteId) => ({ athleteId, name: outsideNames.get(athleteId) ?? null, state: "measured", stateLabel: ROSTER_STATE_LABELS.measured, values: values(factsByAthlete.get(athleteId) ?? []) }))
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")) || a.athleteId.localeCompare(b.athleteId));

  if (typeMarks.length) {
    const labels = await sessionTypeLabels(client, typeMarks.map((m) => m.key));
    for (const mark of typeMarks) mark.label = labels.get(mark.key) ?? null;
  }

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
export function publicAthlete({ decisionIds, currentDecisions, occasionIds, measured, rosterEntry, ...rest }) {
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
      // 6b-C1: the estimate action is offered only while the save is on (ESTIMATES_ENABLED, metricEstimateService's own
      // check, read here without importing it: that module imports this one). Off, the answer is as before.
      // ST-4: manual values are offered while their routes are on (MANUAL_VALUES_ENABLED, on unless "false").
      viewer: {
        basis,
        ...(process.env.ESTIMATES_ENABLED === "true" ? { estimates: true } : {}),
        ...(process.env.MANUAL_VALUES_ENABLED !== "false" ? { manualValues: true } : {}),
      },
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
