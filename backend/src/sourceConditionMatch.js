// v80 (docs/ai/v80-condition-match-plan.md, step B): the match of a column without parameters to a variable with a
// condition for one team, with the database facts it needs - the active unit conversion of the bound unit, the newest
// stored session's team threshold set, the owner's confirmation of a details event setting. Every function takes the
// caller's client inside its transaction; nothing here opens a connection (the board, the activation steps and the
// mapping service use it under their own locks).
import { conditionMatches, needsEventConfirmation, rangeWords, sourceRangeOf } from "./sourceConditionRules.js";

// Whether v80 is installed on this database (its confirmations table; every v80 object comes and goes together). Without
// it the services behave as before v80: no rule, no match, no column of v80 read or written - the precedent of v72's field
// inventory (gpexeImportService.js) and the calendar's questions. Asked once per transaction that may need it.
export async function conditionMatchInstalled(queryable) {
  return (await queryable.query(`select to_regclass('training_load.source_metric_event_setting_confirmations') is not null as ok`)).rows[0].ok === true;
}
// A stored condition as a select expression with every number as its exact numeric text (the code review of v80: a
// condition read as a JS double could match a GPEXE limit that the stored decimal does not).
export const exactConditionSql = (expr) =>
  `(case when jsonb_typeof(${expr}) = 'object' then (select jsonb_object_agg(e.key, case when jsonb_typeof(e.value) = 'number' then to_jsonb(e.value #>> '{}') else e.value end) from jsonb_each(${expr}) e) end)`;

// The version's rule as a select column: the column itself, or null before v80.
export const conditionRuleColumn = (installed, alias = "v") => (installed ? `${alias}.condition_rule` : "null::jsonb as condition_rule");

// A rule fits a condition's shape (the database's condition_rule_fits): a zone rule a zone condition (between, or >= for
// a top zone), an acceleration rule a '>=' event condition, a deceleration rule a '<=' one.
export function ruleFits(rule, cd) {
  if (!rule || !cd || typeof cd !== "object") return false;
  if (rule.kind === "zone") return ["between", ">="].includes(cd.operator) && !("duration_seconds" in cd);
  if (rule.kind === "event") return "duration_seconds" in cd && cd.operator === (rule.event === "acceleration" ? ">=" : "<=");
  return false;
}

// The one active conversion from a unit to another (D5 normal form as stored), or null.
export async function boundConversion(client, fromUnit, toUnit) {
  const rows = (await client.query(
    `select trim_scale(scale)::text as scale, trim_scale(scale_divisor)::text as divisor, trim_scale("offset")::text as "offset"
       from training_load.unit_conversions where from_unit = $1 and to_unit = $2 and state = 'active' order by id`,
    [fromUnit, toUnit],
  )).rows;
  return rows.length === 1 ? { scale: rows[0].scale, divisor: rows[0].divisor, offset: rows[0].offset } : null;
}

// The team threshold set of the team's newest stored session the import could still read (not purged, not expired, with
// a start), or null.
export async function newestTeamThresholds(client, teamId) {
  const row = (await client.query(
    `select c.raw_bundle -> 'teamThresholds' as thresholds
       from training_load.gpexe_import_candidates c
      where c.owner_team_id = $1 and c.raw_purged_at is null and c.raw_expires_at > now() and c.session_started_at is not null
      order by c.session_started_at desc, c.id limit 1`,
    [teamId],
  )).rows[0];
  return row?.thresholds ?? null;
}

// Whether the owner confirmed this event setting for the column's revision (v80's confirmations).
export async function eventSettingConfirmed(client, { revisionId, event, range }) {
  return (await client.query(
    `select 1 from training_load.source_metric_event_setting_confirmations
      where source_metric_version_id = $1 and event_kind = $2 and threshold_value = $3::numeric and duration_seconds = $4::numeric limit 1`,
    [revisionId, event, range.value, range.duration_seconds],
  )).rowCount > 0;
}

export const MATCH_TEXT = Object.freeze({
  team_setting_missing: "OptiMove has no saved session of this team with GPEXE's team settings, so it cannot check that this column counts what the variable counts. Find new sessions first.",
  event_setting_not_confirmed: "Confirm first, in Source fields, the team's event setting GPEXE shows for this column.",
  conversion_unavailable: "OptiMove cannot compare this column's unit with the variable's.",
});
// The refusal of a column whose team setting is not the variable's condition, naming both.
export const settingMismatchText = (variableLabel, range, cd, teamName) =>
  `This column counts ${rangeWords(range)} (${teamName ? `${teamName}'s` : "the team's"} setting in GPEXE); ${variableLabel} counts ${rangeWords(cd)}. Choose a variable with the same setting, or change the team's setting in GPEXE.`;

// The match of a rule's column to a variable's condition against a team threshold set: { ok: true, match } with what the
// activation records, or { ok: false, code, range }.
export async function matchCondition(client, { rule, cd, thresholds, revisionId }) {
  const read = sourceRangeOf(rule, thresholds);
  if (!read || !read.range || read.setId === null || Object.values(read.range).some((v) => v === null)) return { ok: false, code: "team_setting_missing", range: null };
  const { range, setId } = read;
  let conversion = null;
  if (cd.unit !== range.unit) {
    conversion = await boundConversion(client, range.unit, cd.unit);
    if (!conversion) return { ok: false, code: "conversion_unavailable", range };
  }
  if (!conditionMatches(cd, range, conversion)) return { ok: false, code: "team_setting_mismatch", range };
  if (needsEventConfirmation(rule) && !(await eventSettingConfirmed(client, { revisionId, event: rule.event, range }))) {
    return { ok: false, code: "event_setting_not_confirmed", range };
  }
  return { ok: true, match: { condition: cd, sourceRange: range, setId }, range };
}
