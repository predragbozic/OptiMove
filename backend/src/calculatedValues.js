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

// The plan levels ("full", "drill") at which at least one calculated variable applies to the team, read once per import
// (the reviews of PR 2b): an occasion at another level costs no statement, so a team without a calculated variable - today's
// production - sends nothing more than before. The same filters as the writer.
export async function calculatedLevels(client, { ownerTeamId }) {
  const rows = (await client.query(
    `with team as (select club_id from public.teams where id = $1)
     select distinct sc.scope_level
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
  const scopeLevels = new Set(rows.map((r) => r.scope_level));
  return new Set(Object.entries(LEVEL).filter(([, scope]) => scopeLevels.has(scope)).map(([level]) => level));
}

// The preview's entries (C142), for the occasions THIS import wrote, in one statement: per occasion, every calculated
// variable that applies, with the value written or, when an input has no value there, the inputs missing by name. Returns a
// Map occasionId -> entries; an occasion with none is absent (the preview then carries no entry for it).
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
     select occ.occasion_id::text as occasion_id, c.id::text as definition_id, c.label,
            w.value_numeric::text as value, w.unit_at_capture as unit,
            (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'label', idf.label) order by i.ord), '[]'::jsonb)
               from jsonb_array_elements_text(c.calculation -> 'inputs') with ordinality as i(id, ord)
               join training_load.metric_definitions idf on idf.id = i.id::uuid
              where not exists (select 1 from training_load.metric_values iv
                                 where iv.occasion_id = occ.occasion_id and iv.metric_definition_id = i.id::uuid and not iv.is_derived
                                   and iv.value_numeric is not null and iv.unit_at_capture is not distinct from c.unit)) as missing
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
    });
  }
  return out;
}
