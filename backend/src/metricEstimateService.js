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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ESTIMATE_METHODS = Object.freeze(["proportional", "copy_athlete", "team_average"]);
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
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > MAX_MINUTES) {
    throw bad("invalid_minutes", `minutes must be a number above 0 and at most ${MAX_MINUTES}.`);
  }
  return round(n, 2);
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
    `select distinct e.id, e.occurred_date::text as occurred_date, e.occurred_instant, e.event_timezone_snapshot, e.owner_team_id
       from training.activity_metric_event_links l
       join training_load.metric_events e on e.id = l.metric_event_id
      where l.activity_id in (select activity_id from training.activity_alias_ids($1)) and l.link_status = 'confirmed'
        and e.source_connection_id is not null and e.scope_level = 'session'`,
    [canonicalId],
  )).rows;
  if (rows.length !== 1) throw conflict("estimate_not_available", "Only a session that came from an import can hold estimated values.");
  return rows[0];
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
      where p.event_id = $1 and o.entry_method in ('api_import', 'csv_import') and ${EFFECTIVE} and v.value_numeric is not null`,
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
  return { roster, measured, variables, durationDef, athleteId, event, activity, team };
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
    const values = ctx.measured.filter((m) => m.def === v.metricDefinitionId && m.athleteId !== ctx.athleteId && sameUnit(m.unit, v.unit));
    const athletes = new Set(values.map((m) => m.athleteId)).size;
    if (athletes < TEAM_AVERAGE_MIN_ATHLETES) return { variable: v, value: null, reason: "too_few_athletes", basis: null };
    const mean = values.reduce((s, m) => s + m.value, 0) / values.length;
    return { variable: v, value: round(mean, 3), reason: null, basis: { athletes } };
  });
}

function copySources(ctx) {
  const estimable = new Set(ctx.variables.filter((v) => v.estimable).map((v) => v.metricDefinitionId));
  const withValue = new Set(ctx.measured.filter((m) => estimable.has(m.def)).map((m) => m.athleteId));
  return ctx.roster.filter((a) => a.athleteId !== ctx.athleteId && withValue.has(a.athleteId));
}

function copyAthlete(ctx, sourceAthleteId) {
  return ctx.variables.filter((v) => v.estimable).map((v) => {
    const source = ctx.measured.find((m) => m.def === v.metricDefinitionId && m.athleteId === sourceAthleteId && sameUnit(m.unit, v.unit));
    if (!source) return { variable: v, value: null, reason: "source_has_no_value", basis: null };
    return { variable: v, value: round(source.value, 3), reason: null, basis: { sourceAthleteId } };
  });
}

// The athlete's own per-minute rate over the last measured sessions of the same category (the activity's type) of the
// same team, within the window, before this session.
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
        and exists (select 1 from training.activity_metric_event_links l join training.activities a on a.id = l.activity_id
                     where l.metric_event_id = e.id and l.link_status = 'confirmed' and a.activity_type_key = $8)`,
    [ctx.athleteId, ctx.team.id, ctx.event.id, ctx.event.occurred_date, PROPORTIONAL_WINDOW_DAYS, ctx.event.occurred_instant,
      [durationId, ...sums.map((v) => v.metricDefinitionId)], ctx.activity.activity_type_key],
  )).rows;
  const byEvent = new Map();
  for (const r of rows) {
    const id = String(r.event_id);
    if (!byEvent.has(id)) byEvent.set(id, { at: r.occurred_instant ? new Date(r.occurred_instant).getTime() : Date.parse(`${r.occurred_date}T00:00:00Z`), id, values: new Map() });
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
      used.push({ dur: dur.value, val: val.value });
      if (used.length === PROPORTIONAL_SESSIONS) break;
    }
    if (used.length < PROPORTIONAL_MIN_SESSIONS) return { variable: v, value: null, reason: "too_few_sessions", basis: null };
    const rate = used.reduce((s, u) => s + u.val, 0) / used.reduce((s, u) => s + u.dur, 0);
    const ratePerMinute = round(rate, 6);
    return { variable: v, value: round(ratePerMinute * minutes, 3), reason: null, basis: { minutes, ratePerMinute, sessions: used.length } };
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
    const ectx = await loadEstimateContext(client, { canonicalId: target.canonicalId, activity: target.activity, team: target.team, event, athleteId: input.athleteId });
    const athlete = ectx.roster.find((a) => a.athleteId === input.athleteId);
    if (!athlete) throw conflict("athlete_not_on_roster", "This athlete is not on this session's roster.");
    const fallback = defaultMinutes(ectx);
    const minutes = input.minutes ?? fallback;
    const sources = copySources(ectx);
    let copy;
    if (input.sourceAthleteId === null) {
      copy = { available: sources.length > 0, reason: sources.length ? "choose_source" : "no_source", values: [] };
    } else if (!sources.some((s) => s.athleteId === input.sourceAthleteId)) {
      copy = { available: false, reason: "copy_source_not_usable", values: [] };
    } else {
      copy = methodView(copyAthlete(ectx, input.sourceAthleteId), "nothing_to_estimate");
    }
    const answer = {
      activityId: target.canonicalId,
      athleteId: input.athleteId,
      athleteName: athlete.name,
      minutes: { default: fallback, used: minutes },
      variables: ectx.variables.map(({ versionId, ...v }) => v),
      methods: {
        proportional: methodView(await proportional(client, ectx, minutes), "nothing_to_estimate"),
        copy_athlete: { ...copy, sourceAthleteId: input.sourceAthleteId, sources },
        team_average: methodView(teamAverage(ectx), "nothing_to_estimate"),
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
    const ectx = await loadEstimateContext(client, { canonicalId, activity: target.activity, team: target.team, event, athleteId: input.athleteId });
    if (!ectx.roster.some((a) => a.athleteId === input.athleteId)) throw conflict("athlete_not_on_roster", "This athlete is not on this session's roster.");

    let entries;
    let minutes = null;
    if (input.method === "team_average") {
      entries = teamAverage(ectx);
    } else if (input.method === "copy_athlete") {
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
    await client.query(`select set_config('optimove.estimate_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [ctx.userId]);
    await client.query(
      `insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1, $2, $3)
       on conflict (event_id, athlete_id) do nothing`,
      [event.id, input.athleteId, event.event_timezone_snapshot],
    );
    const participantId = (await client.query(
      `select id from training_load.metric_event_participants where event_id = $1 and athlete_id = $2`, [event.id, input.athleteId],
    )).rows[0].id;
    const linked = (await client.query(
      `select training.materialize_activity_group_from_metric_event($1, $2, $3, $4) as id`,
      [event.id, target.activity.activity_type_key, target.activity.name, ctx.userId],
    )).rows[0].id;
    const linkedCanonical = (await client.query(`select training.resolve_canonical_activity_id($1) as id`, [linked])).rows[0].id;
    if (String(linkedCanonical) !== canonicalId) throw new Error("the event's activity is not this session");
    for (const entry of toWrite) {
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

