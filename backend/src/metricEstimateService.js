// Estimated values for an athlete without GPS data (phase 5b, 6b-B): the proposal read and the save.
//
// Contract: docs/ai/phase5b-estimates-contract.md (rules 1-8 and section 4, 6b-B), with the Rukovodilac's GO of
// 2026-11-12 (Q1 (a): the request key on the provenance rows, migration v64; Q2 (a): the estimate participant in the
// event's zone, re-snapshot by a later import; Q3, Q4). The database (v63, v64) holds the rules whoever writes; this module
// is the only writer of an estimate.
//
// Both routes are behind the server flag ESTIMATES_ENABLED (default off): off, both answer the router's identical 404.
// Audience (rule 5): the activity's roster decider - resolveRosterTarget's basis in the active workspace (the read), and
// training.lock_activity_decider's right under lock (the save). Everyone else gets the identical 404.
//
// The save is ONE transaction, in this lock order (contract rule 6, the import's order):
//   1. training.lock_activity_decider(user, team, basis)      (42501 -> 403 not_a_team_coach)
//   2. the team's import lock, try-lock                        (taken by an import or check -> 409 try_again)
//   3. the alias set's activity rows FOR KEY SHARE (lockAliasSet)
//   3b. the (author, request key) advisory lock (v64's guard takes the same one)
//   4. the request key's rows (the replay), then the checks under the locks
//   5. the event participant and its confirmed activity link (training.materialize_activity_group_from_metric_event)
//   6. per variable: the estimate occasion, its one value, its provenance row (v63's guards; M3 supersedes an older
//      estimate of the same variable)
//   7. a bounded COMMIT; an unknown outcome is looked up by the request key on a new connection.
// Nothing is written to a request table: the provenance rows carry the key and the hash (v64), and the answer is read
// back from them, so a replay answers exactly what the save answered.
import { pool } from "./db.js";
import { tryLockTeamForImport } from "./gpexeImportWriter.js";
import { RosterError, noRoster, resolveRosterTarget } from "./activityRoster.js";
import {
  COMMIT_ANSWER_TIMEOUT_MS, NOTHING_SAVED, OUTCOME_UNKNOWN, UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS,
  commitCertainlyRefused, lockAliasSet, requestHash, withinBound,
} from "./activityRosterCommands.js";
import { boundedText } from "./metricTextRules.js";
import { comparableSessionTypes, effectiveTypeOf, readSessionTypeState, sessionTypeLabels } from "./activitySessionTypes.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ESTIMATE_METHODS = Object.freeze(["proportional", "copy_athlete", "team_average", "scale_recording", "position_average"]);
// v87: the position average - the mean of the measured values of the athletes of the same position in this session (the
// team average's rule: at least 3 athletes, no minutes).
export const POSITION_AVERAGE_MIN_ATHLETES = 3;
// The proportional method's history (owner's answer 3): the last 5 measured sessions of the same category, within 90 days,
// at least 3.
export const PROPORTIONAL_SESSIONS = 5;
export const PROPORTIONAL_MIN_SESSIONS = 3;
export const PROPORTIONAL_WINDOW_DAYS = 90;
export const TEAM_AVERAGE_MIN_ATHLETES = 3;
// A sane cap on the minutes a coach enters (v63's basis allows up to 1440).
export const MAX_MINUTES = 600;
export const MAX_NOTE_LENGTH = 500;
// The system variable whose measured values give a session's minutes.
export const DURATION_KEY = "duration";
const LOCK_TIMEOUT = "5s";
const STATEMENT_TIMEOUT = "10s";
const READ_STATEMENT_TIMEOUT = "5s";

const notFound = () => new RosterError(404, "notFound", "Not found.");
const bad = (code, message) => new RosterError(400, code, message);
const conflict = (code, message, details) => new RosterError(409, code, message, details);

export function estimatesEnabled() {
  return process.env.ESTIMATES_ENABLED === "true";
}

const isUuid = (value) => typeof value === "string" && UUID_PATTERN.test(value);
const round = (value, digits) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
function minutesOf(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  // The bounds hold for the value that is used and stored (rounded to 2 decimals): 0.004 is 0, refused.
  const used = typeof n === "number" && Number.isFinite(n) ? round(n, 2) : NaN;
  if (!(used > 0) || used > MAX_MINUTES) {
    throw bad("invalid_minutes", `minutes must be a number above 0 and at most ${MAX_MINUTES}.`);
  }
  return used;
}

export function validateProposalQuery(query) {
  const athleteId = String(query?.athleteId ?? "").toLowerCase();
  if (!isUuid(athleteId)) throw bad("invalid_athlete", "athleteId must be a UUID.");
  const source = query?.sourceAthleteId === undefined || query?.sourceAthleteId === "" ? null : String(query.sourceAthleteId).toLowerCase();
  if (source !== null && !isUuid(source)) throw bad("invalid_source_athlete", "sourceAthleteId must be a UUID.");
  if (source === athleteId) throw bad("invalid_source_athlete", "An athlete's values are not copied from the athlete.");
  return { athleteId, minutes: minutesOf(query?.minutes), sourceAthleteId: source };
}

export function validateSave(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("invalid_body", "A JSON object is required.");
  const requestKey = typeof body.requestKey === "string" ? body.requestKey.toLowerCase() : "";
  if (!isUuid(requestKey)) throw bad("invalid_request_key", "requestKey must be a UUID.");
  const athleteId = typeof body.athleteId === "string" ? body.athleteId.toLowerCase() : "";
  if (!isUuid(athleteId)) throw bad("invalid_athlete", "athleteId must be a UUID.");
  if (!ESTIMATE_METHODS.includes(body.method)) throw bad("invalid_method", `method must be one of ${ESTIMATE_METHODS.join(", ")}.`);
  const method = body.method;
  const minutes = method === "proportional" ? minutesOf(body.minutes) : null;
  if (method !== "proportional" && body.minutes !== undefined && body.minutes !== null) throw bad("invalid_minutes", "minutes belongs to the proportional method only.");
  let sourceAthleteId = null;
  if (method === "copy_athlete") {
    sourceAthleteId = typeof body.sourceAthleteId === "string" ? body.sourceAthleteId.toLowerCase() : "";
    if (!isUuid(sourceAthleteId)) throw bad("invalid_source_athlete", "sourceAthleteId must be a UUID.");
    if (sourceAthleteId === athleteId) throw bad("invalid_source_athlete", "An athlete's values are not copied from the athlete.");
  } else if (body.sourceAthleteId !== undefined && body.sourceAthleteId !== null) {
    throw bad("invalid_source_athlete", "sourceAthleteId belongs to the copy_athlete method only.");
  }
  let note = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string") throw bad("invalid_note", "note must be text.");
    const trimmed = body.note.trim();
    if (trimmed !== "") {
      if (!boundedText(trimmed, MAX_NOTE_LENGTH)) throw bad("invalid_note", `note must be one line of at most ${MAX_NOTE_LENGTH} visible characters.`);
      note = trimmed;
    }
  }
  return { requestKey, athleteId, method, minutes, sourceAthleteId, note };
}

// ---------------------------------------------------------------------------
// What the estimate rests on (read inside the caller's transaction)
// ---------------------------------------------------------------------------
// An effective occasion (o): whole session, not superseded, no conflict status, and its identity's current occasion.
const EFFECTIVE = `o.segment_id is null and o.superseded_by_occasion_id is null and o.import_conflict_status is null
  and (o.source_identity_id is null or exists (select 1 from training_load.metric_source_identities si
                                               where si.id = o.source_identity_id and si.current_occasion_id = o.id))`;

// The one imported metric event of the activity's alias set (rule 4: only a session that came from an import).
async function importedEventOf(client, canonicalId) {
  const rows = (await client.query(
    `select distinct e.id, e.occurred_date::text as occurred_date, e.occurred_instant, e.event_timezone_snapshot, e.owner_team_id,
            e.source_external_id
       from training.activity_metric_event_links l
       join training_load.metric_events e on e.id = l.metric_event_id
      where l.activity_id in (select activity_id from training.activity_alias_ids($1)) and l.link_status = 'confirmed'
        and e.source_connection_id is not null and e.scope_level = 'session'`,
    [canonicalId],
  )).rows;
  if (rows.length !== 1) throw conflict("estimate_not_available", "Only a session that came from an import can hold estimated values.");
  return rows[0];
}

// The event must be the authorised team's own (defence in depth: the event comes from the activity's links).
function assertEventOfTeam(event, team) {
  if (String(event.owner_team_id) !== String(team.id)) throw conflict("estimate_not_available", "Only a session that came from an import can hold estimated values.");
}

async function rosterAthletes(client, canonicalId) {
  return (await client.query(
    `select r.athlete_id, coalesce(nullif(a.display_name, ''), a.full_name) as name
       from training.activity_roster($1) r join public.athletes a on a.id = r.athlete_id`,
    [canonicalId],
  )).rows.map((r) => ({ athleteId: String(r.athlete_id), name: r.name ?? null }));
}

// Everything one proposal or save needs, read in one place so the save computes exactly what the proposal shows.
export async function loadEstimateContext(client, { canonicalId, activity, team, event, athleteId }) {
  const roster = await rosterAthletes(client, canonicalId);
  // Measured values of the event (a basis, rule 2): api_import / csv_import, effective, numeric.
  const measured = (await client.query(
    `select p.athlete_id, v.metric_definition_id, v.value_numeric::float8 as value, v.unit_at_capture
       from training_load.metric_event_participants p
       join training_load.metric_measurement_occasions o on o.event_participant_id = p.id
       join training_load.metric_values v on v.occasion_id = o.id
      where p.event_id = $1 and o.entry_method in ('api_import', 'csv_import') and ${EFFECTIVE} and v.value_numeric is not null
        -- J21: a calculated variable is OptiMove's sum of others, never estimated (and never a basis); it is left out.
        and not v.is_derived`,
    [event.id],
  )).rows.map((r) => ({ athleteId: String(r.athlete_id), def: String(r.metric_definition_id), value: Number(r.value), unit: r.unit_at_capture ?? null }));
  // The athlete's own real values (M2): manual counts too.
  const real = new Set((await client.query(
    `select distinct v.metric_definition_id
       from training_load.metric_event_participants p
       join training_load.metric_measurement_occasions o on o.event_participant_id = p.id
       join training_load.metric_values v on v.occasion_id = o.id
      where p.event_id = $1 and p.athlete_id = $2 and o.entry_method in ('manual', 'api_import', 'csv_import') and ${EFFECTIVE}`,
    [event.id, athleteId],
  )).rows.map((r) => String(r.metric_definition_id)));
  const defIds = [...new Set(measured.map((m) => m.def))];
  const variables = (await client.query(
    `select d.id, d.key, d.label, d.short_label, d.current_version_id, dv.unit, dv.value_type, dv.daily_aggregation_method,
            (d.owner_scope <> 'club' or d.owner_club_id = $2) as named
       from training_load.metric_definitions d
       join training_load.metric_definition_versions dv on dv.id = d.current_version_id
      where d.id = any($1::uuid[])
      order by d.key, d.id`,
    [defIds, team.club_id],
  )).rows
    // A variable of another club (a team that moved) is never named here, and never estimated.
    .filter((d) => d.named)
    .map((d) => {
      const def = String(d.id);
      let reason = null;
      if (d.value_type !== "numeric" || !["sum", "avg"].includes(d.daily_aggregation_method)) reason = "not_estimable";
      else if (real.has(def)) reason = "measured_exists";
      return {
        metricDefinitionId: def, versionId: String(d.current_version_id), key: d.key ?? null, label: d.label ?? null,
        shortLabel: d.short_label ?? null, unit: d.unit ?? null, aggregation: d.daily_aggregation_method, estimable: reason === null, reason,
      };
    });
  const durationDef = (await client.query(
    `select d.id, dv.unit from training_load.metric_definitions d join training_load.metric_definition_versions dv on dv.id = d.current_version_id
      where d.owner_scope = 'system' and d.key = $1`,
    [testHooks.durationKey ?? DURATION_KEY],
  )).rows[0] ?? null;
  // ST-3 (plan section 6): every method works by the athlete's EFFECTIVE session type - the athlete's own exception in
  // this session, otherwise the session's type, both read here (inside the save's locks), never from the unlocked
  // resolve. Team average and Copy take only athletes of the target's type.
  const types = await readSessionTypeState(client, canonicalId);
  const typeOf = (id) => effectiveTypeOf(types, id);
  const targetType = typeOf(athleteId);
  return {
    roster, measured, variables, durationDef, athleteId, event, activity, team, real,
    typesInstalled: types.installed, typeOf, targetType, sameType: (id) => typeOf(id) === targetType,
  };
}

const sameUnit = (a, b) => (a ?? null) === (b ?? null);

// The default minutes: the median of the other athletes' measured durations in this session.
function defaultMinutes(ctx) {
  const d = ctx.durationDef;
  if (!d || d.unit !== "min") return null;
  const values = ctx.measured
    .filter((m) => m.def === String(d.id) && m.athleteId !== ctx.athleteId && sameUnit(m.unit, d.unit) && m.value > 0)
    .map((m) => m.value)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  return Math.min(round(median, 1), MAX_MINUTES) || null;
}

function teamAverage(ctx) {
  return ctx.variables.filter((v) => v.estimable).map((v) => {
    const everyone = ctx.measured.filter((m) => m.def === v.metricDefinitionId && m.athleteId !== ctx.athleteId && sameUnit(m.unit, v.unit));
    // Only athletes who did the target's type; enough athletes of other types is its own reason.
    const values = everyone.filter((m) => ctx.sameType(m.athleteId));
    const athletes = new Set(values.map((m) => m.athleteId)).size;
    if (athletes < TEAM_AVERAGE_MIN_ATHLETES) {
      const reason = new Set(everyone.map((m) => m.athleteId)).size >= TEAM_AVERAGE_MIN_ATHLETES ? "too_few_same_type" : "too_few_athletes";
      return { variable: v, value: null, reason, basis: null };
    }
    const mean = values.reduce((s, m) => s + m.value, 0) / values.length;
    return { variable: v, value: round(mean, 3), reason: null, basis: { athletes } };
  });
}

// v87: the positions in force, in the team's club, of the target athlete and of the session's roster. Read in the
// caller's transaction (the proposal's snapshot, or the save's). Without v87 (a database built before it) the method is
// not available, never replaced by another.
export async function loadPositions(client, ctx) {
  const installed = (await client.query(`select to_regclass('public.athlete_positions') is not null as ok`)).rows[0].ok;
  if (!installed) return { installed: false, target: null, byAthlete: new Map() };
  const ids = ctx.roster.map((a) => a.athleteId);
  if (!ids.includes(ctx.athleteId)) ids.push(ctx.athleteId);
  const rows = (await client.query(
    `select a.id as athlete_id, p.id as position_id, coalesce(o.name, p.name) as name
       from unnest($1::uuid[]) as a(id)
       join public.sport_positions p on p.id = public.athlete_position_in_force(a.id, $2)
       -- The club's own name for a default position.
       left join public.club_position_overrides o on o.position_id = p.id and o.club_id = $2`,
    [ids, ctx.team.club_id],
  )).rows;
  const byAthlete = new Map(rows.map((r) => [String(r.athlete_id), String(r.position_id)]));
  const mine = rows.find((r) => String(r.athlete_id) === ctx.athleteId) ?? null;
  return { installed: true, target: mine ? { id: String(mine.position_id), name: mine.name } : null, byAthlete };
}

function positionAverage(ctx, positions) {
  const estimable = ctx.variables.filter((v) => v.estimable);
  const unavailable = (reason) => estimable.map((v) => ({ variable: v, value: null, reason, basis: null }));
  if (!positions.installed) return unavailable("positions_not_available");
  if (!positions.target) return unavailable("no_position");
  const positionId = positions.target.id;
  const peers = new Set(ctx.roster.filter((a) => a.athleteId !== ctx.athleteId && positions.byAthlete.get(a.athleteId) === positionId).map((a) => a.athleteId));
  return estimable.map((v) => {
    const ofPosition = ctx.measured.filter((m) => m.def === v.metricDefinitionId && peers.has(m.athleteId) && sameUnit(m.unit, v.unit));
    // As the team average and Copy (plan section 6): only athletes who did the target's type in this session; enough
    // athletes of the position who did another type is its own reason.
    const values = ofPosition.filter((m) => ctx.sameType(m.athleteId));
    const athletes = new Set(values.map((m) => m.athleteId)).size;
    if (athletes < POSITION_AVERAGE_MIN_ATHLETES) {
      const reason = new Set(ofPosition.map((m) => m.athleteId)).size >= POSITION_AVERAGE_MIN_ATHLETES ? "too_few_same_type" : "too_few_athletes_in_position";
      return { variable: v, value: null, reason, basis: null };
    }
    const mean = values.reduce((s, m) => s + m.value, 0) / values.length;
    return { variable: v, value: round(mean, 3), reason: null, basis: { athletes, positionId } };
  });
}

// Roster athletes with a measured value of an estimable variable, apart from the target.
function measuredAthletes(ctx) {
  const estimable = new Set(ctx.variables.filter((v) => v.estimable).map((v) => v.metricDefinitionId));
  const withValue = new Set(ctx.measured.filter((m) => estimable.has(m.def)).map((m) => m.athleteId));
  return ctx.roster.filter((a) => a.athleteId !== ctx.athleteId && withValue.has(a.athleteId));
}
// Copy takes only an athlete of the target's effective type; the others are listed apart (the picker greys them out).
function copySources(ctx) {
  return measuredAthletes(ctx).filter((a) => ctx.sameType(a.athleteId));
}
function otherTypeSources(ctx) {
  return measuredAthletes(ctx).filter((a) => !ctx.sameType(a.athleteId)).map((a) => ({ ...a, activityTypeKey: ctx.typeOf(a.athleteId) }));
}

function copyAthlete(ctx, sourceAthleteId) {
  return ctx.variables.filter((v) => v.estimable).map((v) => {
    const source = ctx.measured.find((m) => m.def === v.metricDefinitionId && m.athleteId === sourceAthleteId && sameUnit(m.unit, v.unit));
    if (!source) return { variable: v, value: null, reason: "source_has_no_value", basis: null };
    return { variable: v, value: round(source.value, 3), reason: null, basis: { sourceAthleteId } };
  });
}

// The type of a past session as the athlete did it (ST-3, plan section 6): the athlete's effective type there as it
// stands now - an exception in that session, otherwise that session's type (a correction fixes the record, so a past
// session corrected to another type leaves this average). A past participant without an activity participant row falls
// back to the session's type. PAST_SESSION_TYPE alone is the rule of a world without v89.
const PAST_SESSION_TYPE = `(select a.activity_type_key from training.activity_metric_event_links l join training.activities a on a.id = l.activity_id
                             where l.metric_event_id = e.id and l.link_status = 'confirmed' order by l.activity_id limit 1)`;
const PAST_EFFECTIVE_TYPE = `coalesce(
          (select training.effective_activity_type(mpl.activity_participant_id)
             from training.activity_participant_metric_participant_links mpl
            where mpl.metric_event_participant_id = p.id and mpl.link_status = 'confirmed' order by mpl.activity_participant_id limit 1),
          ${PAST_SESSION_TYPE})`;

// The athlete's own per-minute rate over the last measured sessions the athlete did as a comparable type (the athlete's
// effective type in this session, with D7: comparableSessionTypes) of the same team, within the window, before this
// session.
async function proportional(client, ctx, minutes) {
  const estimable = ctx.variables.filter((v) => v.estimable);
  const d = ctx.durationDef;
  const unavailable = (reason) => estimable.map((v) => ({ variable: v, value: null, reason: v.aggregation === "sum" ? reason : "method_not_for_variable", basis: null }));
  if (!d || d.unit !== "min") return unavailable("duration_not_available");
  if (minutes === null) return unavailable("minutes_required");
  const sums = estimable.filter((v) => v.aggregation === "sum");
  if (!sums.length) return unavailable("method_not_for_variable");
  const durationId = String(d.id);
  const rows = (await client.query(
    `select e.id as event_id, e.occurred_date, e.occurred_instant, v.metric_definition_id, v.value_numeric::float8 as value, v.unit_at_capture
       from training_load.metric_events e
       join training_load.metric_event_participants p on p.event_id = e.id and p.athlete_id = $1
       join training_load.metric_measurement_occasions o on o.event_participant_id = p.id
       join training_load.metric_values v on v.occasion_id = o.id
      where e.owner_scope = 'team' and e.owner_team_id = $2 and e.id <> $3 and e.scope_level = 'session'
        and e.occurred_date >= $4::date - $5::int and e.occurred_date <= $4::date
        and (case when e.occurred_instant is not null and $6::timestamptz is not null then e.occurred_instant < $6::timestamptz
                  else e.occurred_date < $4::date end)
        and o.entry_method in ('api_import', 'csv_import') and ${EFFECTIVE} and v.value_numeric is not null
        and v.metric_definition_id = any($7::uuid[])
        and ${ctx.typesInstalled ? PAST_EFFECTIVE_TYPE : PAST_SESSION_TYPE} = any($8::text[])`,
    [ctx.athleteId, ctx.team.id, ctx.event.id, ctx.event.occurred_date, PROPORTIONAL_WINDOW_DAYS, ctx.event.occurred_instant,
      [durationId, ...sums.map((v) => v.metricDefinitionId)], comparableSessionTypes(ctx.targetType)],
  )).rows;
  const byEvent = new Map();
  for (const r of rows) {
    const id = String(r.event_id);
    if (!byEvent.has(id)) byEvent.set(id, { at: r.occurred_instant ? new Date(r.occurred_instant).getTime() : Date.parse(`${r.occurred_date}T00:00:00Z`), id, day: dayText(r.occurred_date), values: new Map() });
    byEvent.get(id).values.set(String(r.metric_definition_id), { value: Number(r.value), unit: r.unit_at_capture ?? null });
  }
  const events = [...byEvent.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  return estimable.map((v) => {
    if (v.aggregation !== "sum") return { variable: v, value: null, reason: "method_not_for_variable", basis: null };
    const used = [];
    for (const e of events) {
      const dur = e.values.get(durationId);
      const val = e.values.get(v.metricDefinitionId);
      if (!dur || !val || !(dur.value > 0) || !sameUnit(dur.unit, d.unit) || !sameUnit(val.unit, v.unit)) continue;
      used.push({ dur: dur.value, val: val.value, day: e.day, eventId: e.id });
      if (used.length === PROPORTIONAL_SESSIONS) break;
    }
    if (used.length < PROPORTIONAL_MIN_SESSIONS) return { variable: v, value: null, reason: "too_few_sessions", basis: null };
    const rate = used.reduce((s, u) => s + u.val, 0) / used.reduce((s, u) => s + u.dur, 0);
    const ratePerMinute = round(rate, 6);
    // A negative history (a source's negative values) gives no rate (v63's basis holds ratePerMinute >= 0).
    if (!(ratePerMinute >= 0)) return { variable: v, value: null, reason: "invalid_history", basis: null };
    // The days of the sessions used ride beside the basis (the saved basis keeps v63's shape): the proposal shows them.
    return { variable: v, value: round(ratePerMinute * minutes, 3), reason: null, basis: { minutes, ratePerMinute, sessions: used.length }, usedSessions: used.map((u) => ({ id: u.eventId, day: u.day })) };
  });
}
// A session's day as YYYY-MM-DD (a date column reads as a Date or a text).
const dayText = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").slice(0, 10));
// The day of each session Own average used, over all its variables: one entry per session (two on one day are two
// entries), newest first. Only the days leave the server, never a session's id.
export function proportionalDays(entries) {
  const byId = new Map();
  for (const e of entries) for (const u of e.usedSessions ?? []) if (u.day) byId.set(String(u.id), u.day);
  return [...byId.values()].sort().reverse();
}

// MT-D (plan sections 10 and 13): the recorded part of a short recording scaled to the target the coach chose before the
// import. The values come from the imported candidate's stored preview (scaleRecording, bound by the approval's preview hash),
// never from a second mapper run; after the retention purge they are gone (scale_basis_expired). Each sum value becomes
// measured x target / recorded; the duration becomes the target. Only a `sum` variable is scaled (v63/v64 refuse the rest).
async function scaleRecording(client, ctx) {
  const session = /^team_session:([0-9]{1,12})$/.exec(String(ctx.event.source_external_id ?? ""));
  if (!session) throw conflict("scale_not_chosen", "No scale was chosen for this athlete before the import.");
  // With the approval that imported it: a subset import (J20-B) stores no preview of its own, so the athletes it left out are
  // read from the approval, never inferred from the full preview.
  const candidate = (await client.query(
    `select c.preview, a.excluded_athlete_ids
       from training_load.gpexe_import_candidates c
       join training_load.gpexe_import_approvals a on a.candidate_id = c.id
      where c.owner_team_id = $1 and c.gpexe_team_session_id = $2 and c.status = 'imported' and c.import_undone_at is null
      order by c.imported_at desc limit 1`,
    [ctx.event.owner_team_id, session[1]],
  )).rows[0];
  if (!candidate) throw conflict("scale_not_chosen", "No scale was chosen for this athlete before the import.");
  if (!candidate.preview) throw conflict("scale_basis_expired", "The data of this import has expired; its recorded part can no longer be scaled.");
  const entry = (candidate.preview.athletes ?? []).find((a) => String(a.athleteId) === ctx.athleteId) ?? null;
  const leftOut = new Set((candidate.excluded_athlete_ids ?? []).map(String));
  // Only an athlete that import really took: not left out by the coach (J20-B) and not refused (notImported).
  const scaled = entry && !entry.notImported && !leftOut.has(String(entry.gpexeAthleteId)) ? entry.scaleRecording ?? null : null;
  if (!scaled) throw conflict("scale_not_chosen", "No scale was chosen for this athlete before the import.");
  if (scaled.notPossible) throw conflict("scale_not_possible", "This recording could not be scaled.", { reason: scaled.notPossible });
  const recordedMinutes = Number(scaled.recordedMinutes);
  const targetMinutes = Number(scaled.targetMinutes);
  const defIds = [...new Set((scaled.values ?? []).map((v) => String(v.metricDefinitionId)))];
  const defs = new Map((await client.query(
    `select d.id, d.key, d.label, d.short_label, d.current_version_id, dv.unit, dv.value_type, dv.daily_aggregation_method,
            (d.owner_scope <> 'club' or d.owner_club_id = $2) as named
       from training_load.metric_definitions d
       join training_load.metric_definition_versions dv on dv.id = d.current_version_id
      where d.id = any($1::uuid[])`,
    [defIds, ctx.team.club_id],
  )).rows.map((d) => [String(d.id), d]));
  // A variable of another club (a team that moved) is never named here, and never estimated - as loadEstimateContext.
  return (scaled.values ?? []).filter((v) => defs.get(String(v.metricDefinitionId))?.named === true).map((v) => {
    const d = defs.get(String(v.metricDefinitionId));
    const def = String(v.metricDefinitionId);
    const variable = {
      metricDefinitionId: def, versionId: d ? String(d.current_version_id) : null, key: d?.key ?? null, label: d?.label ?? null,
      shortLabel: d?.short_label ?? null, unit: d?.unit ?? null, aggregation: d?.daily_aggregation_method ?? null,
    };
    let reason = null;
    if (d.value_type !== "numeric" || d.daily_aggregation_method !== "sum") reason = "not_estimable";
    else if (String(d.current_version_id) !== String(v.metricDefinitionVersionId) || !sameUnit(d.unit, v.unit)) reason = "definition_changed";
    else if (ctx.real.has(def)) reason = "measured_exists";
    const measured = Number(v.value);
    if (reason || !Number.isFinite(measured)) return { variable, value: null, reason: reason ?? "not_estimable", basis: null };
    // Only the system minutes variable becomes the target (as the mapper picked the recorded minutes); every other sum, a
    // club's own `duration` included, is scaled.
    const isDuration = ctx.durationDef && String(ctx.durationDef.id) === def && ctx.durationDef.unit === "min";
    const value = isDuration ? targetMinutes : round(measured * targetMinutes / recordedMinutes, 3);
    return { variable, value, reason: null, basis: { measured, recordedMinutes, targetMinutes } };
  });
}

function methodView(entries, reasonWhenEmpty) {
  const values = entries.map((e) => ({
    metricDefinitionId: e.variable.metricDefinitionId, value: e.value, reason: e.reason, basis: e.basis,
  }));
  const available = entries.some((e) => e.value !== null);
  const reasons = [...new Set(entries.map((e) => e.reason).filter(Boolean))];
  return { available, reason: available ? null : (reasons.length === 1 ? reasons[0] : reasonWhenEmpty), values };
}

// ---------------------------------------------------------------------------
// The proposal (GET): no lock, nothing written, bounded.
// ---------------------------------------------------------------------------
export async function getEstimateProposal(ctx, activityId, query) {
  if (!estimatesEnabled()) throw notFound();
  const input = validateProposalQuery(query);
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await client.query(`set local statement_timeout = '${READ_STATEMENT_TIMEOUT}'`);
    const target = await resolveRosterTarget(client, ctx, activityId);
    const event = await importedEventOf(client, target.canonicalId);
    assertEventOfTeam(event, target.team);
    const ectx = await loadEstimateContext(client, { canonicalId: target.canonicalId, activity: target.activity, team: target.team, event, athleteId: input.athleteId });
    const athlete = ectx.roster.find((a) => a.athleteId === input.athleteId);
    if (!athlete) throw conflict("athlete_not_on_roster", "This athlete is not on this session's roster.");
    const fallback = defaultMinutes(ectx);
    const minutes = input.minutes ?? fallback;
    const sources = copySources(ectx);
    const others = otherTypeSources(ectx);
    let copy;
    if (input.sourceAthleteId === null) {
      copy = { available: sources.length > 0, reason: sources.length ? "choose_source" : "no_source", values: [] };
    } else if (others.some((s) => s.athleteId === input.sourceAthleteId)) {
      copy = { available: false, reason: "source_type_differs", values: [] };
    } else if (!sources.some((s) => s.athleteId === input.sourceAthleteId)) {
      copy = { available: false, reason: "copy_source_not_usable", values: [] };
    } else {
      copy = methodView(copyAthlete(ectx, input.sourceAthleteId), "nothing_to_estimate");
    }
    const own = await proportional(client, ectx, minutes);
    const positions = await loadPositions(client, ectx);
    // The kind of session Own average compares with: the athlete's effective type here (its key and label) and the set
    // of types that count toward it (D7), or null without a type.
    const typeKey = ectx.targetType ?? null;
    const compared = comparableSessionTypes(typeKey);
    const typeLabels = await sessionTypeLabels(client, [...compared, ...others.map((o) => o.activityTypeKey)]);
    const typeLabel = typeKey ? typeLabels.get(typeKey) ?? null : null;
    const answer = {
      activityId: target.canonicalId,
      athleteId: input.athleteId,
      athleteName: athlete.name,
      minutes: { default: fallback, used: minutes },
      variables: ectx.variables.map(({ versionId, ...v }) => v),
      methods: {
        // The days of the sessions it used, and the session type it compares with (read only; the saved basis is unchanged).
        proportional: { ...methodView(own, "nothing_to_estimate"), sessionDays: proportionalDays(own), comparesWith: typeKey ? { key: typeKey, label: typeLabel, types: compared.map((key) => ({ key, label: typeLabels.get(key) ?? null })) } : null },
        // otherTypeSources: athletes with values who did another type here - shown, never copied from.
        copy_athlete: {
          ...copy, sourceAthleteId: input.sourceAthleteId, sources,
          otherTypeSources: others.map((o) => ({ ...o, activityTypeLabel: typeLabels.get(o.activityTypeKey) ?? null })),
        },
        team_average: methodView(teamAverage(ectx), "nothing_to_estimate"),
        // v87: the athletes of the same position; not available with the reason (no position, too few athletes of it).
        position_average: { ...methodView(positionAverage(ectx, positions), "nothing_to_estimate"), position: positions.target },
        // MT-D: only where a scale was chosen before the import; otherwise not available with the reason.
        scale_recording: await scaleRecording(client, ectx).then(
          (entries) => methodView(entries, "nothing_to_estimate"),
          (error) => {
            if (error instanceof RosterError && error.status === 409) return { available: false, reason: error.code, values: [] };
            throw error;
          },
        ),
      },
    };
    await client.query("commit");
    return { status: 200, body: answer };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error?.code === "57014") throw new RosterError(503, "try_again", "The proposal took too long. Try again.");
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// The save (POST)
// ---------------------------------------------------------------------------
// Test seams only (backend/tests/metric-estimates-6b-b.test.mjs). Never set in the app.
let testHooks = {};
export function setEstimateTestHooks(hooks) {
  testHooks = hooks ?? {};
}

// The answer of a save, read back from its provenance rows (the save and every replay answer the same).
async function readSaved(client, userId, requestKey) {
  const rows = (await client.query(
    `select e.method, e.basis, e.note, e.request_hash, e.estimated_at, o.id as occasion_id, p.athlete_id, p.event_id,
            v.metric_definition_id, v.value_numeric::float8 as value, v.unit_at_capture,
            (d.owner_scope <> 'club' or d.owner_club_id = t.club_id) as named, d.key, d.label, d.short_label,
            (select training.resolve_canonical_activity_id(l.activity_id) from training.activity_metric_event_links l
              where l.metric_event_id = p.event_id and l.link_status = 'confirmed' order by l.activity_id limit 1) as activity_id
       from training_load.metric_value_estimates e
       join training_load.metric_values v on v.id = e.metric_value_id
       join training_load.metric_measurement_occasions o on o.id = e.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events ev on ev.id = p.event_id
       left join public.teams t on t.id = ev.owner_team_id
       join training_load.metric_definitions d on d.id = v.metric_definition_id
      where e.estimated_by_user_id = $1 and e.request_key = $2
      order by v.metric_definition_id`,
    [userId, requestKey],
  )).rows;
  if (!rows.length) return null;
  const first = rows[0];
  return {
    hash: first.request_hash,
    answer: {
      activityId: first.activity_id ? String(first.activity_id) : null,
      athleteId: String(first.athlete_id),
      method: first.method,
      note: first.note ?? null,
      estimatedAt: new Date(first.estimated_at).toISOString(),
      estimates: rows.map((r) => ({
        metricDefinitionId: String(r.metric_definition_id),
        key: r.named ? (r.key ?? null) : null,
        label: r.named ? (r.label ?? null) : null,
        shortLabel: r.named ? (r.short_label ?? null) : null,
        value: Number(r.value),
        unit: r.unit_at_capture ?? null,
        occasionId: String(r.occasion_id),
        basis: r.basis,
      })),
    },
  };
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
    const reading = (async () => {
      await checker.query("begin read only");
      await checker.query(`set local statement_timeout = ${Math.max(1, Math.floor(left()))}`);
      const found = await readSaved(checker, userId, requestKey);
      await checker.query("commit");
      return found;
    })();
    reading.catch(() => {});
    const saved = await withinBound(reading, left());
    return saved && saved.hash === hash ? saved.answer : null;
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    checker.removeListener("error", onError);
    if (broken) checker.on("error", () => {});
    checker.release(broken ? true : undefined);
  }
}

export async function saveEstimate(ctx, activityId, body) {
  if (!estimatesEnabled()) throw notFound();
  const input = validateSave(body);
  const canonical = {
    operation: "estimate", activityId, athleteId: input.athleteId, method: input.method,
    minutes: input.minutes, sourceAthleteId: input.sourceAthleteId, note: input.note,
  };
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
    const target = await resolveRosterTarget(client, ctx, activityId, { deferGate: true });
    const teamId = String(target.team.id);
    try {
      await client.query(`select training.lock_activity_decider($1, $2, $3)`, [ctx.userId, teamId, target.basis]);
    } catch (error) {
      if (error?.code === "42501") throw new RosterError(403, "not_a_team_coach", "You may not decide on this team's roster.");
      throw error;
    }
    if (testHooks.beforeTeamLock) await testHooks.beforeTeamLock({ client, teamId });
    if (!(await tryLockTeamForImport(client, teamId))) {
      throw conflict("try_again", "An import or a search of this team is running. Try again in a moment.");
    }
    const aliasSet = await lockAliasSet(client, activityId);
    const canonicalId = aliasSet.canonicalId;
    if (canonicalId !== target.canonicalId) {
      const again = await resolveRosterTarget(client, ctx, canonicalId, { deferGate: true });
      if (String(again.team.id) !== teamId || again.basis !== target.basis) throw notFound();
    }
    // The (author, key) lock v64's guard takes: two saves of one key on two teams' sessions (the team lock does not
    // serialise them) are decided one after the other, so the replay below sees the other's committed rows.
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('estimate-request:' || $1::uuid::text || ':' || $2::uuid::text, 64))`,
      [ctx.userId, input.requestKey],
    );

    // The replay: a saved answer wins over the present state.
    const prior = await readSaved(client, ctx.userId, input.requestKey);
    if (prior) {
      if (prior.hash !== hash) throw conflict("request_key_reused", "This requestKey was already used for a different request.");
      await client.query("rollback");
      return { status: 200, body: prior.answer, replayed: true };
    }
    if (String(activityId) !== canonicalId) {
      throw conflict("activity_superseded", "This session was merged into another.", { canonicalActivityId: canonicalId });
    }
    const gate = await client.query(`select coalesce(training.activity_has_roster($1), false) as has_roster`, [canonicalId]);
    if (!gate.rows[0].has_roster) throw noRoster();
    const event = await importedEventOf(client, canonicalId);
    assertEventOfTeam(event, target.team);
    const ectx = await loadEstimateContext(client, { canonicalId, activity: target.activity, team: target.team, event, athleteId: input.athleteId });
    if (!ectx.roster.some((a) => a.athleteId === input.athleteId)) throw conflict("athlete_not_on_roster", "This athlete is not on this session's roster.");

    let entries;
    let minutes = null;
    if (input.method === "scale_recording") {
      entries = await scaleRecording(client, ectx);
    } else if (input.method === "team_average") {
      entries = teamAverage(ectx);
    } else if (input.method === "position_average") {
      const positions = await loadPositions(client, ectx);
      if (!positions.installed) throw conflict("positions_not_available", "Positions are not available.");
      if (!positions.target) throw conflict("no_position", "This athlete has no position. Set one in Settings → Athletes.");
      entries = positionAverage(ectx, positions);
    } else if (input.method === "copy_athlete") {
      // A stale screen naming an athlete who did another type: refused, nothing written (plan section 6).
      if (otherTypeSources(ectx).some((s) => s.athleteId === input.sourceAthleteId)) {
        throw conflict("source_type_differs", "That athlete did another session type here. Choose an athlete of the same type.");
      }
      if (!copySources(ectx).some((s) => s.athleteId === input.sourceAthleteId)) {
        throw conflict("copy_source_not_usable", "Choose an athlete of this session's roster with measured values.");
      }
      entries = copyAthlete(ectx, input.sourceAthleteId);
    } else {
      minutes = input.minutes ?? defaultMinutes(ectx);
      if (minutes === null) throw conflict("minutes_required", "Enter the minutes the athlete trained.");
      entries = await proportional(client, ectx, minutes);
    }
    const toWrite = entries.filter((e) => e.value !== null);
    if (!toWrite.length) {
      const reasons = [...new Set(entries.map((e) => e.reason).filter(Boolean))].sort();
      throw conflict("nothing_to_estimate", "No variable of this session can be estimated this way.", { reasons });
    }

    // The writes: the acting user for v63's guards, the participant in the event's zone, its activity link, the values.
    // ONE TRANSACTION, AND IT MUST STAY ONE: an athlete's own reads hide a participation that an estimate made
    // (trainingActivityAccess.js athleteOwnParticipationSql) by comparing created_at of the activity participant row
    // written here (step 2, inside materialize_activity_group_from_metric_event) with created_at of the estimate's
    // occasions (step 3). Both default to now() - the transaction's start - so they are equal only while the three
    // writes below share a transaction. Writing the participant earlier (another transaction, a background job, a
    // retry that reuses a row) would show the athlete a session that exists for her only because she was estimated.
    // metric-estimates-6b-b.test.mjs (17y) pins this. The robust form is a provenance mark on
    // training.activity_participants (a migration), to be made before ESTIMATES_ENABLED is switched on.
    await client.query(`select set_config('optimove.estimate_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [ctx.userId]);
    // Step 1 of 3 (see above).
    await client.query(
      `insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1, $2, $3)
       on conflict (event_id, athlete_id) do nothing`,
      [event.id, input.athleteId, event.event_timezone_snapshot],
    );
    const participantId = (await client.query(
      `select id from training_load.metric_event_participants where event_id = $1 and athlete_id = $2`, [event.id, input.athleteId],
    )).rows[0].id;
    // Step 2 of 3 (see above): this creates the athlete's activity participant row when she has none.
    const linked = (await client.query(
      `select training.materialize_activity_group_from_metric_event($1, $2, $3, $4) as id`,
      [event.id, target.activity.activity_type_key, target.activity.name, ctx.userId],
    )).rows[0].id;
    const linkedCanonical = (await client.query(`select training.resolve_canonical_activity_id($1) as id`, [linked])).rows[0].id;
    if (String(linkedCanonical) !== canonicalId) throw new Error("the event's activity is not this session");
    for (const entry of toWrite) {
      // Step 3 of 3 (see above): the estimate's occasion, in the same transaction as the participant row.
      const occasionId = (await client.query(
        `insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id)
         values ($1, 'estimate', $2) returning id`,
        [participantId, ctx.userId],
      )).rows[0].id;
      const valueId = (await client.query(
        `insert into training_load.metric_values
           (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, is_derived, aggregation_role, coverage)
         values ($1, $2, $3, $4, $5, false, 'standalone', 'not_applicable') returning id`,
        [occasionId, entry.variable.metricDefinitionId, entry.variable.versionId, entry.value, entry.variable.unit],
      )).rows[0].id;
      await client.query(
        `insert into training_load.metric_value_estimates
           (metric_value_id, occasion_id, method, basis, estimated_by_user_id, note, request_key, request_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [valueId, occasionId, input.method, JSON.stringify(entry.basis), ctx.userId, input.note, input.requestKey, hash],
      );
    }
    // The deferred checks (provenance, one value per occasion) answer here, before the COMMIT is sent.
    await client.query("set constraints all immediate");
    const saved = await readSaved(client, ctx.userId, input.requestKey);
    if (testHooks.beforeCommit) await testHooks.beforeCommit({ client, canonicalId });
    commitSent = true;
    const committing = Promise.resolve().then(() => (testHooks.commit ? testHooks.commit(client) : client.query("commit")));
    committing.catch(() => {});
    await withinBound(committing, testHooks.commitTimeoutMs ?? COMMIT_ANSWER_TIMEOUT_MS);
    return { status: 201, body: saved.answer };
  } catch (error) {
    if (!commitSent) {
      await client.query("rollback").catch(() => { broken = true; });
      if (error?.code === "55P03" || error?.code === "40P01" || error?.code === "57014") {
        throw conflict("try_again", "The session is being changed. Try again.");
      }
      // A real value written meanwhile by a path that does not take the team's lock (v63's M2 refusal).
      if (error?.code === "23514" && error?.message === "estimate_measured_exists") {
        throw conflict("measured_exists", "A measured value of this variable arrived meanwhile. Nothing was saved.");
      }
      throw error;
    }
    console.error(`[estimate] commit on activity ${activityId} failed: ${error?.code ?? ""} ${error?.message}`);
    if (commitCertainlyRefused(error)) {
      await client.query("rollback").catch(() => { broken = true; });
      throw new RosterError(500, "internal_error", NOTHING_SAVED);
    }
    released = true;
    client.removeListener("error", onClientError);
    client.on("error", () => {});
    client.release(true);
    let found = null;
    try {
      found = await findStoredResult(ctx.userId, input.requestKey, hash, testHooks.checkTimeoutMs ?? UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS);
    } catch (checkError) {
      console.error(`[estimate] checking a save on activity ${activityId} after an unconfirmed COMMIT failed: ${checkError?.message}`);
    }
    if (found) return { status: 201, body: found, verifiedAfterCommitError: true };
    throw new RosterError(503, "outcome_unknown", OUTCOME_UNKNOWN);
  } finally {
    if (!released) {
      client.removeListener("error", onClientError);
      client.release(broken ? true : undefined);
    }
  }
}

