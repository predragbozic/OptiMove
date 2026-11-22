// Manual values on the roster (ST-4, docs/ai/session-type-plan.md section 7; the owner's decisions of 2026-11-20): an
// entry for an athlete without a device record, a correction of a measured value, and the restore of the measured values.
//
// A manual value is a 'manual' occasion, never a value the source delivered:
//   - an entry is an occasion of its own (no source identity) on the athlete's event participant of the imported session;
//     it replaces an estimate of the same variable through v63's M3, and a later entry supersedes the earlier one;
//   - a correction is a 'manual' occasion of the athlete's whole-session source identity: it supersedes the current
//     occasion and becomes the identity's current one. The measured occasion is never deleted;
//   - a restore is a correction whose values are exactly the measured occasion's (v86 checks it).
// Every one has its provenance row in training_load.metric_manual_values (who, when, on which right, which request; v86),
// written in the same transaction. This module is the only writer of that table.
//
// Behind the server flag MANUAL_VALUES_ENABLED (on unless it is "false"; the Rukovodilac, 2026-11-22): off, every route
// answers the router's identical 404.
// Audience: the activity's roster decider (team coach in the team's workspace, the club's admin, a platform admin) -
// resolveRosterTarget's basis in the active workspace, and training.lock_activity_decider's right under lock (the save).
// Everyone else gets the identical 404.
//
// The save is ONE transaction, in this lock order (the estimate save's order, section 7 of the plan):
//   1. training.lock_activity_decider(user, team, basis)          (42501 -> 403 not_a_team_coach)
//   2. the team's import lock, try-lock                            (an import or a check holds it -> 409 try_again)
//   3. the alias set's activity rows FOR KEY SHARE (lockAliasSet)
//   4. the (author, request key) advisory lock, then the replay
//   5. a correction / restore: the source identity FOR UPDATE; an entry: the previous entry occasion FOR UPDATE
//   6. the writes (the occasion insert takes v13's participant and event locks; M3 the estimate occasion's row)
//   7. a bounded COMMIT; an unknown outcome is looked up by the request key on a new connection.
import { pool } from "./db.js";
import { tryLockTeamForImport } from "./gpexeImportWriter.js";
import { RosterError, noRoster, resolveRosterTarget } from "./activityRoster.js";
import {
  COMMIT_ANSWER_TIMEOUT_MS, NOTHING_SAVED, OUTCOME_UNKNOWN, UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS,
  commitCertainlyRefused, lockAliasSet, requestHash, withinBound,
} from "./activityRosterCommands.js";
import { writeCalculatedValues } from "./calculatedValues.js";
import { boundedText } from "./metricTextRules.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_NOTE_LENGTH = 500;
export const MAX_VALUES = 64;
// A sane bound for a typed number (the column is numeric; nothing a coach types is near it).
export const MAX_ABS_VALUE = 1e9;
const LOCK_TIMEOUT = "5s";
const STATEMENT_TIMEOUT = "10s";
const READ_STATEMENT_TIMEOUT = "5s";
const MEASURED = ["api_import", "csv_import"];

const notFound = () => new RosterError(404, "notFound", "Not found.");
const bad = (code, message) => new RosterError(400, code, message);
const conflict = (code, message, details) => new RosterError(409, code, message, details);

export function manualValuesEnabled() {
  return process.env.MANUAL_VALUES_ENABLED !== "false";
}

const isUuid = (value) => typeof value === "string" && UUID_PATTERN.test(value);
const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
function noteOf(body) {
  if (body.note === undefined || body.note === null) return null;
  if (typeof body.note !== "string") throw bad("invalid_note", "note must be text.");
  const trimmed = body.note.trim();
  if (trimmed === "") return null;
  if (!boundedText(trimmed, MAX_NOTE_LENGTH)) throw bad("invalid_note", `note must be one line of at most ${MAX_NOTE_LENGTH} visible characters.`);
  return trimmed;
}

function commonOf(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("invalid_body", "A JSON object is required.");
  const requestKey = lower(body.requestKey);
  if (!isUuid(requestKey)) throw bad("invalid_request_key", "requestKey must be a UUID.");
  const athleteId = lower(body.athleteId);
  if (!isUuid(athleteId)) throw bad("invalid_athlete", "athleteId must be a UUID.");
  let expectedOccasionId = null;
  if (body.expectedOccasionId !== undefined && body.expectedOccasionId !== null) {
    expectedOccasionId = lower(body.expectedOccasionId);
    if (!isUuid(expectedOccasionId)) throw bad("invalid_expected_occasion", "expectedOccasionId must be a UUID or null.");
  }
  return { requestKey, athleteId, expectedOccasionId, note: noteOf(body) };
}

export function validateSave(body) {
  const common = commonOf(body);
  if (!Array.isArray(body.values) || body.values.length === 0 || body.values.length > MAX_VALUES) {
    throw bad("invalid_values", `values must be a list of 1 to ${MAX_VALUES} entries.`);
  }
  const seen = new Set();
  const values = body.values.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw bad("invalid_values", "Each value is an object.");
    const metricDefinitionId = lower(entry.metricDefinitionId);
    if (!isUuid(metricDefinitionId)) throw bad("invalid_values", "metricDefinitionId must be a UUID.");
    if (seen.has(metricDefinitionId)) throw bad("invalid_values", "A variable is given once.");
    seen.add(metricDefinitionId);
    const raw = entry.value;
    const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > MAX_ABS_VALUE) {
      throw bad("invalid_value", "Each value must be a number.");
    }
    return { metricDefinitionId, value: n };
  }).sort((a, b) => a.metricDefinitionId.localeCompare(b.metricDefinitionId));
  return { ...common, values };
}

export function validateRestore(body) {
  const common = commonOf(body);
  if (body.values !== undefined) throw bad("invalid_values", "A restore takes no values.");
  if (common.expectedOccasionId === null) throw bad("invalid_expected_occasion", "expectedOccasionId is required.");
  return common;
}

// ---------------------------------------------------------------------------
// What the session and the athlete hold (read inside the caller's transaction)
// ---------------------------------------------------------------------------
// The one imported metric event of the activity's alias set (only a session that came from an import has a roster with
// device records).
async function importedEventOf(client, canonicalId) {
  const rows = (await client.query(
    `select distinct e.id, e.owner_team_id, e.event_timezone_snapshot
       from training.activity_metric_event_links l
       join training_load.metric_events e on e.id = l.metric_event_id
      where l.activity_id in (select activity_id from training.activity_alias_ids($1)) and l.link_status = 'confirmed'
        and e.source_connection_id is not null and e.scope_level = 'session'`,
    [canonicalId],
  )).rows;
  if (rows.length !== 1) throw conflict("manual_not_available", "Only a session that came from an import holds manual values here.");
  return rows[0];
}

function assertEventOfTeam(event, team) {
  if (String(event.owner_team_id) !== String(team.id)) throw conflict("manual_not_available", "Only a session that came from an import holds manual values here.");
}

// The current whole-session occasions of the athlete in the event: measured (by identity), manual and estimates.
async function athleteOccasions(client, eventId, athleteId) {
  return (await client.query(
    `select o.id, o.entry_method, o.source_identity_id, o.recorded_by_user_id, o.created_at, o.supersedes_occasion_id,
            m.kind as manual_kind, m.measured_occasion_id, m.entered_by_user_id, m.entered_by_basis, m.entered_at, m.note
       from training_load.metric_event_participants p
       join training_load.metric_measurement_occasions o on o.event_participant_id = p.id
       left join training_load.metric_manual_values m on m.occasion_id = o.id
      where p.event_id = $1 and p.athlete_id = $2 and o.segment_id is null
        and o.superseded_by_occasion_id is null and o.import_conflict_status is null
        and (o.source_identity_id is null or exists (select 1 from training_load.metric_source_identities si
                                                     where si.id = o.source_identity_id and si.current_occasion_id = o.id))
      order by o.created_at, o.id`,
    [eventId, athleteId],
  )).rows;
}

// The athlete's state for a manual write: a correction (a current occasion with a source identity), an entry, or refused.
function classify(occasions) {
  const withRecord = occasions.filter((o) => o.source_identity_id !== null && (MEASURED.includes(o.entry_method) || o.entry_method === "manual"));
  if (withRecord.length > 1) throw conflict("record_ambiguous", "This athlete has more than one device record in this session. Fix it in the source first.");
  if (withRecord.length === 1) {
    const current = withRecord[0];
    if (current.entry_method === "manual" && !current.manual_kind) {
      throw conflict("changed_elsewhere", "This athlete's values were changed outside the roster. Change them there.");
    }
    return { mode: "correction", current };
  }
  const entries = occasions.filter((o) => o.entry_method === "manual");
  // A removal (v86's 'removal' kind: an empty occasion that ended an entry) is the current occasion a new entry follows.
  if (entries.some((o) => o.manual_kind !== "entry" && o.manual_kind !== "removal")) {
    throw conflict("changed_elsewhere", "This athlete's values were entered outside the roster. Change them there.");
  }
  if (entries.length > 1) throw conflict("changed_elsewhere", "This athlete has more than one manual entry. Reload and try again.");
  return { mode: "entry", current: entries[0] ?? null, estimates: occasions.filter((o) => o.entry_method === "estimate") };
}

async function valuesOf(client, occasionIds) {
  if (!occasionIds.length) return [];
  return (await client.query(
    `select v.occasion_id, v.metric_definition_id, v.metric_definition_version_id, v.value_numeric::text as value_numeric,
            v.value_boolean, v.value_text, v.unit_at_capture, v.aggregation_role, v.coverage
       from training_load.metric_values v
      where v.occasion_id = any($1::uuid[]) and not v.is_derived
      order by v.metric_definition_id`,
    [occasionIds],
  )).rows;
}

// A typed value inside its variable version's limits (min_value / max_value, as C110 applies them on import), or 409
// value_out_of_range naming the variable and its limits; checked before anything is written.
export async function assertWithinLimits(client, typed) {
  if (!typed.length) return;
  const limits = new Map((await client.query(
    `select dv.id, dv.min_value::text as min_value, dv.max_value::text as max_value, coalesce(d.label, d.key) as label
       from training_load.metric_definition_versions dv join training_load.metric_definitions d on d.id = dv.metric_definition_id
      where dv.id = any($1::uuid[])`,
    [[...new Set(typed.map((t) => String(t.versionId)))]],
  )).rows.map((r) => [String(r.id), r]));
  for (const t of typed) {
    const l = limits.get(String(t.versionId));
    if (!l) continue;
    const below = l.min_value !== null && t.value < Number(l.min_value);
    const above = l.max_value !== null && t.value > Number(l.max_value);
    if (below || above) {
      const range = l.min_value !== null && l.max_value !== null ? `between ${l.min_value} and ${l.max_value}` : l.min_value !== null ? `at least ${l.min_value}` : `at most ${l.max_value}`;
      throw conflict("value_out_of_range", `${l.label} must be ${range}. Nothing was saved.`);
    }
  }
}

// The variables an entry may hold: the numeric variables measured in this session (named for the team's club), each at its
// current version.
async function sessionVariables(client, eventId, clubId) {
  return (await client.query(
    `select d.id, d.key, d.label, d.short_label, d.current_version_id, dv.unit, dv.value_type
       from training_load.metric_definitions d
       join training_load.metric_definition_versions dv on dv.id = d.current_version_id
      where d.id in (select distinct v.metric_definition_id
                       from training_load.metric_event_participants p
                       join training_load.metric_measurement_occasions o on o.event_participant_id = p.id
                       join training_load.metric_values v on v.occasion_id = o.id
                      where p.event_id = $1 and o.entry_method in ('api_import', 'csv_import') and o.segment_id is null
                        and not v.is_derived)
        and (d.owner_scope <> 'club' or d.owner_club_id = $2)
        and dv.value_type = 'numeric'
      order by d.key, d.id`,
    [eventId, clubId],
  )).rows;
}

async function definitionsOf(client, ids, clubId) {
  if (!ids.length) return new Map();
  const rows = (await client.query(
    `select d.id, d.key, d.label, d.short_label, (d.owner_scope <> 'club' or d.owner_club_id = $2) as named
       from training_load.metric_definitions d where d.id = any($1::uuid[])`,
    [ids, clubId],
  )).rows;
  return new Map(rows.map((r) => [String(r.id), r]));
}

const num = (text) => (text === null || text === undefined ? null : Number(text));

// ---------------------------------------------------------------------------
// The form (GET): what the panel shows and what a save must send back
// ---------------------------------------------------------------------------
export async function getManualValueForm(ctx, activityId, query) {
  if (!manualValuesEnabled()) throw notFound();
  const athleteId = lower(String(query?.athleteId ?? ""));
  if (!isUuid(athleteId)) throw bad("invalid_athlete", "athleteId must be a UUID.");
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await client.query(`set local statement_timeout = '${READ_STATEMENT_TIMEOUT}'`);
    const target = await resolveRosterTarget(client, ctx, activityId);
    const event = await importedEventOf(client, target.canonicalId);
    assertEventOfTeam(event, target.team);
    const roster = (await client.query(
      `select r.athlete_id, coalesce(nullif(a.display_name, ''), a.full_name) as name
         from training.activity_roster($1) r join public.athletes a on a.id = r.athlete_id where r.athlete_id = $2`,
      [target.canonicalId, athleteId],
    )).rows[0];
    if (!roster) throw conflict("athlete_not_on_roster", "This athlete is not on this session's roster.");
    const state = classify(await athleteOccasions(client, event.id, athleteId));
    const clubId = target.team.club_id;
    let variables;
    let measuredOccasionId = null;
    if (state.mode === "correction") {
      measuredOccasionId = MEASURED.includes(state.current.entry_method) ? String(state.current.id) : String(state.current.measured_occasion_id);
      const rows = await valuesOf(client, [String(state.current.id), measuredOccasionId]);
      const current = rows.filter((r) => String(r.occasion_id) === String(state.current.id));
      const measured = new Map(rows.filter((r) => String(r.occasion_id) === measuredOccasionId).map((r) => [String(r.metric_definition_id), r]));
      const defs = await definitionsOf(client, current.map((r) => String(r.metric_definition_id)), clubId);
      variables = current
        .filter((r) => defs.get(String(r.metric_definition_id))?.named)
        .map((r) => {
          const d = defs.get(String(r.metric_definition_id));
          return {
            metricDefinitionId: String(r.metric_definition_id), key: d.key ?? null, label: d.label ?? null, shortLabel: d.short_label ?? null,
            unit: r.unit_at_capture ?? null, editable: r.value_numeric !== null,
            value: num(r.value_numeric), measuredValue: num(measured.get(String(r.metric_definition_id))?.value_numeric),
          };
        });
    } else {
      const own = state.current ? await valuesOf(client, [String(state.current.id)]) : [];
      const estimated = await valuesOf(client, (state.estimates ?? []).map((o) => String(o.id)));
      const ownBy = new Map(own.map((r) => [String(r.metric_definition_id), r]));
      const estBy = new Map(estimated.map((r) => [String(r.metric_definition_id), r]));
      variables = (await sessionVariables(client, event.id, clubId)).map((d) => ({
        metricDefinitionId: String(d.id), key: d.key ?? null, label: d.label ?? null, shortLabel: d.short_label ?? null,
        unit: d.unit ?? null, editable: true,
        value: num(ownBy.get(String(d.id))?.value_numeric), estimatedValue: num(estBy.get(String(d.id))?.value_numeric),
      }));
    }
    const current = state.current && state.current.entry_method === "manual" ? await provenanceView(client, state.current) : null;
    await client.query("commit");
    return {
      status: 200,
      body: {
        activityId: target.canonicalId,
        athleteId,
        athleteName: roster.name ?? null,
        mode: state.mode,
        expectedOccasionId: state.current ? String(state.current.id) : null,
        manual: current,
        canRestore: state.mode === "correction" && state.current.entry_method === "manual" && state.current.manual_kind === "correction",
        variables,
      },
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error?.code === "57014") throw new RosterError(503, "try_again", "The values took too long to read. Try again.");
    throw error;
  } finally {
    client.release();
  }
}

async function provenanceView(client, occasion) {
  const name = (await client.query(
    `select coalesce(nullif(display_name, ''), full_name) as name from public.users where id = $1`, [occasion.entered_by_user_id],
  )).rows[0]?.name ?? null;
  return {
    kind: occasion.manual_kind,
    enteredBy: { userId: String(occasion.entered_by_user_id), name, basis: occasion.entered_by_basis },
    enteredAt: new Date(occasion.entered_at).toISOString(),
    note: occasion.note ?? null,
  };
}

// ---------------------------------------------------------------------------
// The save (POST) and the restore
// ---------------------------------------------------------------------------
// Test seams only (backend/tests/manual-values-st4.test.mjs). Never set in the app.
let testHooks = {};
export function setManualValueTestHooks(hooks) {
  testHooks = hooks ?? {};
}

// The answer of a save, read back from its provenance row (the save and every replay answer the same).
async function readSaved(client, userId, requestKey) {
  const row = (await client.query(
    `select m.occasion_id, m.kind, m.replaced_occasion_id, m.measured_occasion_id, m.entered_by_basis, m.entered_at, m.note,
            m.request_hash, p.athlete_id, p.event_id, t.club_id,
            (select training.resolve_canonical_activity_id(l.activity_id) from training.activity_metric_event_links l
              where l.metric_event_id = p.event_id and l.link_status = 'confirmed' order by l.activity_id limit 1) as activity_id
       from training_load.metric_manual_values m
       join training_load.metric_measurement_occasions o on o.id = m.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events ev on ev.id = p.event_id
       left join public.teams t on t.id = ev.owner_team_id
      where m.entered_by_user_id = $1 and m.request_key = $2`,
    [userId, requestKey],
  )).rows[0];
  if (!row) return null;
  const ids = [String(row.occasion_id), ...(row.measured_occasion_id ? [String(row.measured_occasion_id)] : [])];
  const values = await valuesOf(client, ids);
  const measured = new Map(values.filter((v) => String(v.occasion_id) === String(row.measured_occasion_id)).map((v) => [String(v.metric_definition_id), v]));
  const own = values.filter((v) => String(v.occasion_id) === String(row.occasion_id));
  const defs = await definitionsOf(client, own.map((v) => String(v.metric_definition_id)), row.club_id);
  return {
    hash: row.request_hash,
    answer: {
      activityId: row.activity_id ? String(row.activity_id) : null,
      athleteId: String(row.athlete_id),
      kind: row.kind,
      occasionId: String(row.occasion_id),
      replacedOccasionId: row.replaced_occasion_id ? String(row.replaced_occasion_id) : null,
      enteredBy: { userId: String(userId), basis: row.entered_by_basis },
      enteredAt: new Date(row.entered_at).toISOString(),
      note: row.note ?? null,
      // Only the variables named for the team's club (the form's own rule); another club's variable is never listed.
      values: own.filter((v) => defs.get(String(v.metric_definition_id))?.named).map((v) => {
        const d = defs.get(String(v.metric_definition_id));
        return {
          metricDefinitionId: String(v.metric_definition_id),
          key: d.key ?? null,
          label: d.label ?? null,
          value: num(v.value_numeric),
          unit: v.unit_at_capture ?? null,
          ...(row.measured_occasion_id ? { measuredValue: num(measured.get(String(v.metric_definition_id))?.value_numeric) } : {}),
        };
      }),
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

async function insertOccasion(client, { participantId, sourceIdentityId, userId, supersedes }) {
  return String((await client.query(
    `insert into training_load.metric_measurement_occasions
       (event_participant_id, entry_method, source_identity_id, recorded_by_user_id, supersedes_occasion_id)
     values ($1, 'manual', $2, $3, $4) returning id`,
    [participantId, sourceIdentityId, userId, supersedes],
  )).rows[0].id);
}

// A copied value (a correction, a restore, an entry's earlier values) keeps every semantic column of the value it copies -
// its aggregation role and coverage too (a whole-session GPEXE value is source_rollup / complete); a typed new value of an
// entry is a standalone value (the estimate save's choice).
async function insertValue(client, occasionId, v) {
  await client.query(
    `insert into training_load.metric_values
       (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, value_boolean, value_text, unit_at_capture,
        is_derived, aggregation_role, coverage)
     values ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)`,
    [occasionId, v.metric_definition_id, v.metric_definition_version_id, v.value_numeric, v.value_boolean ?? null, v.value_text ?? null,
      v.unit_at_capture ?? null, v.aggregation_role ?? "standalone", v.coverage ?? "not_applicable"],
  );
}

// The common frame of a write: rights, the team lock, the alias set, the request key, the replay, the gate. `write`
// receives the locked context and returns nothing; the answer is read back from the provenance row.
async function runManualWrite(ctx, activityId, input, canonical, write) {
  if (!manualValuesEnabled()) throw notFound();
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
    // The (author, key) lock: two saves of one key on two teams' sessions are decided one after the other.
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('manual-value-request:' || $1::uuid::text || ':' || $2::uuid::text, 64))`,
      [ctx.userId, input.requestKey],
    );
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
    const onRoster = await client.query(`select 1 from training.activity_roster($1) where athlete_id = $2`, [canonicalId, input.athleteId]);
    if (!onRoster.rowCount) throw conflict("athlete_not_on_roster", "This athlete is not on this session's roster.");

    await client.query(`select set_config('optimove.manual_value_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [ctx.userId]);
    await write({ client, target, event, canonicalId, basis: target.basis, hash });
    // The deferred checks (provenance by COMMIT, v63's) answer here, before the COMMIT is sent.
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
      throw error;
    }
    console.error(`[manual-values] commit on activity ${activityId} failed: ${error?.code ?? ""} ${error?.message}`);
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
      console.error(`[manual-values] checking a save on activity ${activityId} after an unconfirmed COMMIT failed: ${checkError?.message}`);
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

const stale = () => conflict("values_changed", "This athlete's values changed since you opened them. Nothing was saved. Open them again.");

// Locks the current occasion the caller expects and checks it is still the current one (a correction: through its
// identity; an entry: the previous entry itself). Returns the classified state under the locks.
async function lockCurrent(client, eventId, input) {
  const before = classify(await athleteOccasions(client, eventId, input.athleteId));
  if (before.mode === "correction") {
    await client.query(`select 1 from training_load.metric_source_identities where id = $1 for update`, [before.current.source_identity_id]);
  } else if (before.current) {
    await client.query(`select 1 from training_load.metric_measurement_occasions where id = $1 for update`, [before.current.id]);
  }
  const after = classify(await athleteOccasions(client, eventId, input.athleteId));
  const currentId = after.current ? String(after.current.id) : null;
  if (after.mode !== before.mode || currentId !== (before.current ? String(before.current.id) : null) || currentId !== input.expectedOccasionId) {
    throw stale();
  }
  return after;
}

async function recalculate(client, occasionId, teamId) {
  await writeCalculatedValues(client, { occasionId, level: "full", ownerTeamId: teamId });
}

async function writeProvenance(client, { occasionId, kind, replaced, measured, userId, basis, note, requestKey, hash }) {
  await client.query(
    `insert into training_load.metric_manual_values
       (occasion_id, kind, replaced_occasion_id, measured_occasion_id, entered_by_user_id, entered_by_basis, note, request_key, request_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [occasionId, kind, replaced, measured, userId, basis, note, requestKey, hash],
  );
}

export async function saveManualValues(ctx, activityId, body) {
  // The flag first: off, every body (a malformed one too) gets the identical 404.
  if (!manualValuesEnabled()) throw notFound();
  const input = validateSave(body);
  const canonical = {
    operation: "manual_values", activityId, athleteId: input.athleteId, expectedOccasionId: input.expectedOccasionId,
    values: input.values, note: input.note,
  };
  return runManualWrite(ctx, activityId, input, canonical, async ({ client, target, event, basis, hash }) => {
    const state = await lockCurrent(client, event.id, input);
    const teamId = String(target.team.id);
    if (state.mode === "correction") {
      const current = state.current;
      const measuredId = MEASURED.includes(current.entry_method) ? String(current.id) : String(current.measured_occasion_id);
      const old = await valuesOf(client, [String(current.id)]);
      const byDef = new Map(old.map((r) => [String(r.metric_definition_id), r]));
      // Only the variables the form offers: numeric and named for the team's club (another club's variable held in the
      // record is copied as it is, never changed here).
      const named = await definitionsOf(client, old.map((r) => String(r.metric_definition_id)), target.team.club_id);
      let changed = 0;
      for (const v of input.values) {
        const row = byDef.get(v.metricDefinitionId);
        if (!row || row.value_numeric === null || !named.get(v.metricDefinitionId)?.named) {
          throw conflict("variable_not_in_record", "A value names a variable this record does not hold.");
        }
        if (Number(row.value_numeric) !== v.value) changed += 1;
      }
      if (changed === 0) throw conflict("nothing_changed", "These are the values already shown. Nothing was saved.");
      await assertWithinLimits(client, input.values
        .filter((v) => Number(byDef.get(v.metricDefinitionId).value_numeric) !== v.value)
        .map((v) => ({ versionId: byDef.get(v.metricDefinitionId).metric_definition_version_id, value: v.value })));
      const given = new Map(input.values.map((v) => [v.metricDefinitionId, v.value]));
      const occasionId = await insertOccasion(client, { participantId: (await participantOf(client, current.id)), sourceIdentityId: current.source_identity_id, userId: ctx.userId, supersedes: current.id });
      for (const r of old) {
        const typed = given.get(String(r.metric_definition_id));
        // A value sent back unchanged keeps its stored text exactly (no round trip through a JS number).
        const changedValue = typed !== undefined && Number(r.value_numeric) !== typed;
        await insertValue(client, occasionId, { ...r, value_numeric: changedValue ? String(typed) : r.value_numeric });
      }
      await supersede(client, { current: String(current.id), occasionId, identityId: current.source_identity_id });
      await recalculate(client, occasionId, teamId);
      await writeProvenance(client, { occasionId, kind: "correction", replaced: String(current.id), measured: measuredId, userId: ctx.userId, basis, note: input.note, requestKey: input.requestKey, hash });
      return;
    }
    // An entry: only the session's numeric variables, at their current versions.
    const variables = new Map((await sessionVariables(client, event.id, target.team.club_id)).map((d) => [String(d.id), d]));
    for (const v of input.values) {
      if (!variables.has(v.metricDefinitionId)) throw conflict("variable_not_in_session", "A value names a variable this session does not measure.");
    }
    await assertWithinLimits(client, input.values.map((v) => ({ versionId: variables.get(v.metricDefinitionId).current_version_id, value: v.value })));
    await client.query(
      `insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1, $2, $3)
       on conflict (event_id, athlete_id) do nothing`,
      [event.id, input.athleteId, event.event_timezone_snapshot],
    );
    const participantId = String((await client.query(
      `select id from training_load.metric_event_participants where event_id = $1 and athlete_id = $2`, [event.id, input.athleteId],
    )).rows[0].id);
    // The athlete's activity participant row and its link, as the estimate save makes them (none is made twice).
    const linked = (await client.query(
      `select training.materialize_activity_group_from_metric_event($1, $2, $3, $4) as id`,
      [event.id, target.activity.activity_type_key, target.activity.name, ctx.userId],
    )).rows[0].id;
    const linkedCanonical = (await client.query(`select training.resolve_canonical_activity_id($1) as id`, [linked])).rows[0].id;
    if (String(linkedCanonical) !== String(target.canonicalId)) throw new Error("the event's activity is not this session");
    const previous = state.current ? String(state.current.id) : null;
    // A later entry changes the values it names; the earlier entry's other values are carried over unchanged (never lost
    // through the supersede), as a correction does.
    const earlier = previous ? await valuesOf(client, [previous]) : [];
    const occasionId = await insertOccasion(client, { participantId, sourceIdentityId: null, userId: ctx.userId, supersedes: previous });
    if (previous) await supersede(client, { current: previous, occasionId, identityId: null });
    const given = new Set(input.values.map((v) => v.metricDefinitionId));
    for (const r of earlier) {
      if (!given.has(String(r.metric_definition_id))) await insertValue(client, occasionId, r);
    }
    for (const v of input.values) {
      const d = variables.get(v.metricDefinitionId);
      await insertValue(client, occasionId, {
        metric_definition_id: d.id, metric_definition_version_id: d.current_version_id, value_numeric: String(v.value), unit_at_capture: d.unit ?? null,
      });
    }
    await recalculate(client, occasionId, teamId);
    await writeProvenance(client, { occasionId, kind: "entry", replaced: previous, measured: null, userId: ctx.userId, basis, note: input.note, requestKey: input.requestKey, hash });
  });
}

export async function restoreMeasuredValues(ctx, activityId, body) {
  if (!manualValuesEnabled()) throw notFound();
  const input = validateRestore(body);
  const canonical = { operation: "manual_restore", activityId, athleteId: input.athleteId, expectedOccasionId: input.expectedOccasionId, note: input.note };
  return runManualWrite(ctx, activityId, input, canonical, async ({ client, target, event, basis, hash }) => {
    const state = await lockCurrent(client, event.id, input);
    const current = state.current;
    if (state.mode !== "correction" || current.entry_method !== "manual" || current.manual_kind !== "correction") {
      throw conflict("nothing_to_restore", "This athlete's values are the measured ones. Nothing was saved.");
    }
    const measuredId = String(current.measured_occasion_id);
    const measured = await valuesOf(client, [measuredId]);
    const occasionId = await insertOccasion(client, { participantId: (await participantOf(client, current.id)), sourceIdentityId: current.source_identity_id, userId: ctx.userId, supersedes: current.id });
    for (const r of measured) await insertValue(client, occasionId, r);
    await supersede(client, { current: String(current.id), occasionId, identityId: current.source_identity_id });
    await recalculate(client, occasionId, String(target.team.id));
    await writeProvenance(client, { occasionId, kind: "restore", replaced: String(current.id), measured: measuredId, userId: ctx.userId, basis, note: input.note, requestKey: input.requestKey, hash });
  });
}

async function participantOf(client, occasionId) {
  return String((await client.query(`select event_participant_id from training_load.metric_measurement_occasions where id = $1`, [occasionId])).rows[0].event_participant_id);
}

async function supersede(client, { current, occasionId, identityId }) {
  const updated = await client.query(
    `update training_load.metric_measurement_occasions set superseded_by_occasion_id = $1 where id = $2 and superseded_by_occasion_id is null`,
    [occasionId, current],
  );
  if (updated.rowCount !== 1) throw stale();
  if (identityId) {
    const moved = await client.query(
      `update training_load.metric_source_identities set current_occasion_id = $1 where id = $2 and current_occasion_id = $3`,
      [occasionId, identityId, current],
    );
    if (moved.rowCount !== 1) throw stale();
  }
}
