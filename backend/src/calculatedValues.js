// Calculated variables, step 2 (J21, C141-C148): OptiMove's own values of a calculated variable, written once, in the
// transaction that writes their inputs, beside them on the same occasion (never computed again at read time).
//
// One statement per occasion writes every calculated variable that applies to it (C141, the Rukovodilac's rule of
// 2026-11-18): the variable is active; its owner is OptiMove or the team's own club; the team's club has not hidden it (7i);
// it has the occasion's level; and every input has a non-derived value on this occasion, in the calculated variable's unit
// (the Independent's LOW-1 on PR #612: a re-pointed input of another unit is left out, never added). Anything else writes
// nothing for that variable: a missing input is no value, never a partial sum (C142, C145).
//
// The arithmetic is the database's (exact numeric), so v77's value guard, which recomputes it, always agrees. Each kind of
// calculation is one entry of KINDS: sum, and since v79 ratio and difference (each a new entry, not a rewrite;
// the Rukovodilac's (a)-(e) of 2026-11-18). computed_by_ref names the formula version and the input values in the
// calculation's own input order (the order carries the roles of a later kind).
// The plan's levels: "full" (the whole session) and "drill".
const LEVEL = { full: "session", drill: "component" };

// The value of one calculated variable on one occasion, from its inputs' values `iv` (one row per input, `ord` its place),
// and whether those values give one (v79): a ratio needs a denominator above 0 and a numerator not below 0 (no value
// otherwise, O4); a difference below 0 is no value (O5). The SQL is v79's value guard's, so the guard always agrees.
const FIRST = "(select value_numeric from inputs where ord = 1)";
const SECOND = "(select value_numeric from inputs where ord = 2)";
const KINDS = Object.freeze({
  sum: { value: "(select sum(value_numeric) from inputs)", valid: "true" },
  difference: { value: `${FIRST} - ${SECOND}`, valid: `${FIRST} - ${SECOND} >= 0` },
  ratio: { value: `round(${FIRST} * (c.calculation ->> 'scale')::numeric / nullif(${SECOND}, 0), 6)`, valid: `${SECOND} > 0 and ${FIRST} >= 0` },
});
// One level of nesting (v79, O1): a sum adds up ordinary values; a ratio or a difference may use a sum's own value, so the
// sums of an occasion are written first, in the same transaction.
const PASSES = Object.freeze([["sum"], ["ratio", "difference"]]);
export const CALCULATION_KINDS = Object.freeze(Object.keys(KINDS));

function kindCases(part) {
  return Object.entries(KINDS).map(([kind, sql]) => `when '${kind}' then ${sql[part]}`).join(" ");
}

// An input value the calculation may use: the input's own, non-derived, numeric, in the input's own unit (its current
// version's - a calculated variable's input keeps its unit while used, v77/v79; the Independent's LOW-1 on PR #612: a value
// in another unit is left out, never used) - or, for a ratio or a difference, a sum's own value.
const INPUT_VALUE = `
  join training_load.metric_definitions idf on idf.id = i.id::uuid
  join training_load.metric_definition_versions idv on idv.id = idf.current_version_id and idv.metric_definition_id = idf.id
  join training_load.metric_values iv
    on iv.occasion_id = $1 and iv.metric_definition_id = idf.id and iv.value_numeric is not null
   and iv.unit_at_capture is not distinct from idv.unit
   and (not iv.is_derived
        or (c.calculation ->> 'kind' <> 'sum'
            and exists (select 1 from training_load.metric_definition_versions sv
                         where sv.id = iv.metric_definition_version_id and to_jsonb(sv.*) -> 'calculation' ->> 'kind' = 'sum')))`;

// Writes the calculated values of one occasion; returns them as { metricDefinitionId, valueId }. `level` is the occasion's
// ("session" or "drill"); `ownerTeamId` the importing team (its club decides which club variables and hides apply).
// `kinds` (from calculatedLevels) names the kinds that apply at this level; a pass with none of them sends no statement (the
// reviews of PR 2b: a team with only sums sends one statement per occasion, as before v79). Left out, every pass runs.
export async function writeCalculatedValues(client, { occasionId, level, ownerTeamId, kinds: applying = CALCULATION_KINDS }) {
  const scopeLevel = LEVEL[level];
  if (!scopeLevel) throw new Error(`writeCalculatedValues: unknown level ${level}`);
  const written = [];
  for (const kinds of PASSES) {
    if (!kinds.some((kind) => applying.includes(kind))) continue;
    const rows = (await client.query(
      `with team as (select club_id from public.teams where id = $3),
       candidates as (
         -- v77's column is read through the whole row, so a database before v77 (some suites pin one) reads no calculation.
         select cd.id as definition_id, cv.id as version_id, cv.unit, to_jsonb(cv.*) -> 'calculation' as calculation
           from training_load.metric_definitions cd
           join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
           join training_load.metric_definition_scope_capabilities sc on sc.metric_definition_id = cd.id and sc.scope_level = $2
          where cd.state = 'active'
            and to_jsonb(cv.*) -> 'calculation' ->> 'kind' = any ($4::text[])
            and (cd.owner_scope = 'system' or (cd.owner_scope = 'club' and cd.owner_club_id = (select club_id from team)))
            and not exists (select 1 from training_load.metric_definition_club_hides h
                             where h.metric_definition_id = cd.id and h.club_id = (select club_id from team) and h.shown_at is null)
       ),
       computed as (
         select c.*,
                (with inputs as (
                   select iv.id, iv.value_numeric, i.ord
                     from jsonb_array_elements_text(c.calculation -> 'inputs') with ordinality as i(id, ord)
                     ${INPUT_VALUE})
                 select jsonb_build_object(
                          'complete', count(*) = jsonb_array_length(c.calculation -> 'inputs')
                                      and coalesce((case c.calculation ->> 'kind' ${kindCases("valid")} end), false),
                          'ids', jsonb_agg(iv.id::text order by iv.ord),
                          'value', (case c.calculation ->> 'kind' ${kindCases("value")} end))
                   from inputs iv) as result
           from candidates c
       )
       insert into training_load.metric_values
         (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, unit_at_capture, is_derived, aggregation_role, coverage, computed_by_ref)
       select $1, definition_id, version_id, (result ->> 'value')::numeric, unit, true, 'derived_rollup', 'complete',
              jsonb_build_object('formulaVersionId', version_id::text, 'inputValueIds', result -> 'ids')
         from computed
        where (result ->> 'complete')::boolean
        order by definition_id
       returning id, metric_definition_id`,
      [occasionId, scopeLevel, ownerTeamId, kinds],
    )).rows;
    for (const r of rows) written.push({ metricDefinitionId: String(r.metric_definition_id), valueId: String(r.id) });
  }
  return written;
}

// The plan levels ("full", "drill") at which at least one calculated variable applies to the team, read once per import
// (the reviews of PR 2b): an occasion at another level costs no statement, so a team without a calculated variable - today's
// production - sends nothing more than before. The same filters as the writer.
export async function calculatedLevels(client, { ownerTeamId }) {
  const rows = (await client.query(
    `with team as (select club_id from public.teams where id = $1)
     select distinct sc.scope_level, to_jsonb(cv.*) -> 'calculation' ->> 'kind' as kind
       from training_load.metric_definitions cd
       join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
       join training_load.metric_definition_scope_capabilities sc on sc.metric_definition_id = cd.id
      where cd.state = 'active'
        and to_jsonb(cv.*) -> 'calculation' ->> 'kind' = any ($2::text[])
        and (cd.owner_scope = 'system' or (cd.owner_scope = 'club' and cd.owner_club_id = (select club_id from team)))
        and not exists (select 1 from training_load.metric_definition_club_hides h
                         where h.metric_definition_id = cd.id and h.club_id = (select club_id from team) and h.shown_at is null)`,
    [ownerTeamId, Object.keys(KINDS)],
  )).rows;
  // A Map level -> the kinds that apply there (v79); `has(level)` reads as the Set of levels did.
  const out = new Map();
  for (const [level, scope] of Object.entries(LEVEL)) {
    const kinds = rows.filter((r) => r.scope_level === scope).map((r) => r.kind);
    if (kinds.length) out.set(level, kinds);
  }
  return out;
}

// The preview's entries (C142), for the occasions THIS import wrote, in one statement: per occasion, every calculated
// variable that applies, with the value written or, when an input has no value there, the inputs missing by name. Returns a
// Map occasionId -> entries; an occasion with none is absent (the preview then carries no entry for it).
// Why a calculation with every input still wrote no value (v79), from the same input values and the same conditions as
// KINDS' `valid` (the code review of v79 PR 1): a ratio's denominator is 0 or below 0, or its numerator below 0; a
// difference below 0.
function noValueReason(kind, values) {
  const [first, second] = (values ?? []).map(Number);
  if (kind === "ratio") {
    if (second === 0) return "denominator_zero";
    if (second < 0) return "denominator_negative";
    if (first < 0) return "numerator_negative";
  }
  if (kind === "difference" && first - second < 0) return "below_zero";
  return null;
}
export async function calculatedForOccasions(client, { occasions, ownerTeamId }) {
  const out = new Map();
  const wanted = occasions.filter((o) => LEVEL[o.level]);
  if (wanted.length === 0) return out;
  const rows = (await client.query(
    `with occ as (select * from unnest($1::uuid[], $2::text[]) as x(occasion_id, scope_level)),
     team as (select club_id from public.teams where id = $3),
     cands as (
       select cd.id, cd.label, cv.unit, sc.scope_level, to_jsonb(cv.*) -> 'calculation' as calculation
         from training_load.metric_definitions cd
         join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
         join training_load.metric_definition_scope_capabilities sc on sc.metric_definition_id = cd.id
        where cd.state = 'active'
          and to_jsonb(cv.*) -> 'calculation' ->> 'kind' = any ($4::text[])
          and (cd.owner_scope = 'system' or (cd.owner_scope = 'club' and cd.owner_club_id = (select club_id from team)))
          and not exists (select 1 from training_load.metric_definition_club_hides h
                           where h.metric_definition_id = cd.id and h.club_id = (select club_id from team) and h.shown_at is null)
     )
     select occ.occasion_id::text as occasion_id, c.id::text as definition_id, c.label, c.calculation ->> 'kind' as kind,
            w.value_numeric::text as value, w.unit_at_capture as unit,
            (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'label', idf.label) order by i.ord), '[]'::jsonb)
               from jsonb_array_elements_text(c.calculation -> 'inputs') with ordinality as i(id, ord)
               join training_load.metric_definitions idf on idf.id = i.id::uuid
               join training_load.metric_definition_versions idv on idv.id = idf.current_version_id and idv.metric_definition_id = idf.id
              -- The writer's rule for a usable input value (INPUT_VALUE): its own unit; a sum's value for a ratio or difference.
              where not exists (select 1 from training_load.metric_values iv
                                 where iv.occasion_id = occ.occasion_id and iv.metric_definition_id = idf.id
                                   and iv.value_numeric is not null and iv.unit_at_capture is not distinct from idv.unit
                                   and (not iv.is_derived
                                        or (c.calculation ->> 'kind' <> 'sum'
                                            and exists (select 1 from training_load.metric_definition_versions sv
                                                         where sv.id = iv.metric_definition_version_id
                                                           and to_jsonb(sv.*) -> 'calculation' ->> 'kind' = 'sum'))))) as missing,
            -- The input values the writer used (INPUT_VALUE), in the calculation's order: the reason a value is missing.
            (select jsonb_agg(iv.value_numeric order by i.ord)
               from jsonb_array_elements_text(c.calculation -> 'inputs') with ordinality as i(id, ord)
               ${INPUT_VALUE.replace("iv.occasion_id = $1", "iv.occasion_id = occ.occasion_id")}) as input_values
       from occ
       join cands c on c.scope_level = occ.scope_level
       left join training_load.metric_values w on w.occasion_id = occ.occasion_id and w.metric_definition_id = c.id and w.is_derived
      order by occ.occasion_id, c.label, c.id`,
    [wanted.map((o) => o.occasionId), wanted.map((o) => LEVEL[o.level]), ownerTeamId, Object.keys(KINDS)],
  )).rows;
  for (const r of rows) {
    if (!out.has(r.occasion_id)) out.set(r.occasion_id, []);
    const written = r.value !== null;
    out.get(r.occasion_id).push({
      metricDefinitionId: r.definition_id, label: r.label,
      value: written ? r.value : null, unit: written ? r.unit : null,
      missingInputs: written ? [] : r.missing.map((m) => ({ metricDefinitionId: m.id, label: m.label })),
      // v79: every input has a value and still none is written - noValueReason says why.
      reason: written || r.missing.length ? null : noValueReason(r.kind, r.input_values),
    });
  }
  return out;
}

// ---- The athlete never sees a calculated value (the Rukovodilac's step-1 decision; the owner's rule that an athlete sees
// only what was really measured). Decided on the server, by the database's own facts: a value is a calculated one when it
// is derived and its version carries a calculation (v77; read through the whole row, so a database before v77 has none).

// A SQL condition that is true for a calculated value `v` (alias of training_load.metric_values).
export function calculatedValueSql(alias = "v") {
  return `(${alias}.is_derived and exists (select 1 from training_load.metric_definition_versions calc_v
            where calc_v.id = ${alias}.metric_definition_version_id
              and coalesce(to_jsonb(calc_v.*) -> 'calculation', 'null'::jsonb) <> 'null'::jsonb))`;
}

// The version ids, among `versionIds`, that carry a calculation. `run(sql, params)` answers { rows }.
export async function calculationVersionIds(run, versionIds) {
  const ids = [...new Set(versionIds.filter(Boolean).map(String))];
  if (ids.length === 0) return new Set();
  const rows = (await run(
    `select id::text as id from training_load.metric_definition_versions v
      where v.id = any($1::uuid[]) and coalesce(to_jsonb(v.*) -> 'calculation', 'null'::jsonb) <> 'null'::jsonb`,
    [ids],
  )).rows;
  return new Set(rows.map((r) => r.id));
}

// A SQL condition that is true for a calculated variable `d` (alias of training_load.metric_definitions): its current version
// carries a calculation. The athlete's catalog never lists one (the Rukovodilac, 2026-11-19: no label, no picker entry).
export function calculatedDefinitionSql(alias = "d") {
  return `exists (select 1 from training_load.metric_definition_versions calc_d
                   where calc_d.id = ${alias}.current_version_id
                     and coalesce(to_jsonb(calc_d.*) -> 'calculation', 'null'::jsonb) <> 'null'::jsonb)`;
}
