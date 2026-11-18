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
// calculation is one entry of KINDS: today only "sum"; a later kind (ratio, difference: v79) is a new entry, not a rewrite
// (the Rukovodilac's (a)-(e) of 2026-11-18). computed_by_ref names the formula version and the input values in the
// calculation's own input order (the order carries the roles of a later kind).
// The plan's levels: "full" (the whole session) and "drill".
const LEVEL = { full: "session", drill: "component" };

// The value of one calculated variable on one occasion, from its inputs' values `iv` (one row per input, `ord` its place).
const KINDS = Object.freeze({
  sum: "sum(iv.value_numeric)",
});

function kindCases() {
  return Object.entries(KINDS).map(([kind, expression]) => `when '${kind}' then (select ${expression} from inputs iv)`).join(" ");
}

// Writes the calculated values of one occasion; returns them as { metricDefinitionId, valueId }. `level` is the occasion's
// ("session" or "drill"); `ownerTeamId` the importing team (its club decides which club variables and hides apply).
export async function writeCalculatedValues(client, { occasionId, level, ownerTeamId }) {
  const scopeLevel = LEVEL[level];
  if (!scopeLevel) throw new Error(`writeCalculatedValues: unknown level ${level}`);
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
                 select iv.id, iv.value_numeric, iv.unit_at_capture, i.ord
                   from jsonb_array_elements_text(c.calculation -> 'inputs') with ordinality as i(id, ord)
                   join training_load.metric_values iv
                     on iv.occasion_id = $1 and iv.metric_definition_id = i.id::uuid
                    and not iv.is_derived and iv.value_numeric is not null)
               select jsonb_build_object(
                        'complete', count(*) = jsonb_array_length(c.calculation -> 'inputs')
                                    and bool_and(iv.unit_at_capture is not distinct from c.unit),
                        'ids', jsonb_agg(iv.id::text order by iv.ord),
                        'value', (case c.calculation ->> 'kind' ${kindCases()} end))
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
    [occasionId, scopeLevel, ownerTeamId, Object.keys(KINDS)],
  )).rows;
  return rows.map((r) => ({ metricDefinitionId: String(r.metric_definition_id), valueId: String(r.id) }));
}

// Which calculated variables apply to an occasion's level for the team, and which of their inputs the occasion lacks (the
// preview names the missing input per athlete, C142). Read-only; the same filters as the writer.
export async function calculatedVariablesMissing(client, { occasionId, level, ownerTeamId }) {
  const scopeLevel = LEVEL[level];
  return (await client.query(
    `with team as (select club_id from public.teams where id = $3)
     select cd.id::text as definition_id, cd.label,
            (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'label', idf.label) order by i.ord), '[]'::jsonb)
               from jsonb_array_elements_text(to_jsonb(cv.*) -> 'calculation' -> 'inputs') with ordinality as i(id, ord)
               join training_load.metric_definitions idf on idf.id = i.id::uuid
              where not exists (select 1 from training_load.metric_values iv
                                 where iv.occasion_id = $1 and iv.metric_definition_id = i.id::uuid and not iv.is_derived
                                   and iv.value_numeric is not null and iv.unit_at_capture is not distinct from cv.unit)) as missing
       from training_load.metric_definitions cd
       join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
       join training_load.metric_definition_scope_capabilities sc on sc.metric_definition_id = cd.id and sc.scope_level = $2
      where cd.state = 'active'
        and to_jsonb(cv.*) -> 'calculation' ->> 'kind' = any ($4::text[])
        and (cd.owner_scope = 'system' or (cd.owner_scope = 'club' and cd.owner_club_id = (select club_id from team)))
        and not exists (select 1 from training_load.metric_definition_club_hides h
                         where h.metric_definition_id = cd.id and h.club_id = (select club_id from team) and h.shown_at is null)
      order by cd.label, cd.id`,
    [occasionId, scopeLevel, ownerTeamId, Object.keys(KINDS)],
  )).rows.map((r) => ({ metricDefinitionId: r.definition_id, label: r.label, missing: r.missing }));
}

// The preview's entry for one occasion (C142): every calculated variable that applies, with the value written or, when an
// input has no value there, the inputs missing by name. Empty when none applies (the preview then carries no entry).
export async function calculatedForOccasion(client, { occasionId, level, ownerTeamId }) {
  const applicable = await calculatedVariablesMissing(client, { occasionId, level, ownerTeamId });
  if (applicable.length === 0) return [];
  const written = new Map((await client.query(
    `select metric_definition_id::text as id, value_numeric::text as value, unit_at_capture as unit
       from training_load.metric_values where occasion_id = $1 and is_derived and metric_definition_id = any ($2::uuid[])`,
    [occasionId, applicable.map((a) => a.metricDefinitionId)],
  )).rows.map((r) => [r.id, r]));
  return applicable.map((a) => {
    const value = written.get(a.metricDefinitionId) ?? null;
    return {
      metricDefinitionId: a.metricDefinitionId, label: a.label,
      value: value ? value.value : null, unit: value ? value.unit : null,
      missingInputs: value ? [] : a.missing.map((m) => ({ metricDefinitionId: m.id, label: m.label })),
    };
  });
}
