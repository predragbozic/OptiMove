export function allowedDashboardAggregations(type, kind) {
  return ['text', 'boolean'].includes(type) ? ['last', 'none'] : kind === 'ratio' ? ['ratio', 'max', 'last', 'none'] : ['sum', 'avg', 'max', 'last', 'none'];
}

export const RATIO_AGGREGATION_MESSAGE = 'This metric cannot be totalled or averaged. Choose Ratio, Highest or Latest.';
export const NON_RATIO_MESSAGE = 'Ratio is only for a calculated ratio. Choose another way to combine values.';
export function assertDashboardAggregation(calculation, aggregation, rolePolicy) {
  const ratio = calculation?.kind === 'ratio';
  if (ratio ? !allowedDashboardAggregations('numeric', 'ratio').includes(aggregation) || rolePolicy !== 'all_including_derived' : aggregation === 'ratio') {
    throw Object.assign(new Error(ratio ? RATIO_AGGREGATION_MESSAGE : NON_RATIO_MESSAGE), { code: 'aggregation_not_allowed', httpStatus: 409 });
  }
}

// Seeds are server-resolved canonical occasions, already scoped by workspace, activity,
// component, athlete, source and coverage. No caller-supplied occasion ids reach this query.
export async function queryRatioBuckets(queryRunner, seeds, definitionId, aggregation, expectedVersionId) {
  const { rows } = await queryRunner(`select (
    with seeds as (select * from jsonb_to_recordset($1::jsonb)
      as s("occasionId" uuid, "athleteId" uuid, "bucketKey" text, instant timestamptz)),
    current_formula as (
      select v.id, to_jsonb(v.*)->'calculation' as calculation from training_load.metric_definitions d
      join training_load.metric_definition_versions v on v.id=d.current_version_id where d.id=$2),
    occasions as (
      select s.*, r.id as ratio_id, r.value_numeric as stored_value, r.unit_at_capture as unit,
        to_jsonb(f.*)->'calculation' as calculation, n.value_numeric as numerator, d.value_numeric as denominator,
        r.computed_by_ref, r.metric_definition_version_id,
        exists (select 1 from training_load.metric_values iv
          join training_load.metric_definitions idf on idf.id=iv.metric_definition_id
          join training_load.metric_definition_versions idv on idv.id=idf.current_version_id
          join training_load.metric_definition_versions sv on sv.id=iv.metric_definition_version_id
          where iv.occasion_id=s."occasionId" and iv.metric_definition_id in
            (select value::uuid from jsonb_array_elements_text((select calculation->'inputs' from current_formula)))
            and iv.value_numeric is not null and iv.unit_at_capture is not distinct from idv.unit
            and (not iv.is_derived or to_jsonb(sv.*)->'calculation'->>'kind'='sum')) as has_input
      from seeds s
      left join training_load.metric_values r on r.occasion_id=s."occasionId" and r.metric_definition_id=$2
        and r.is_derived and r.aggregation_role='derived_rollup'
      left join training_load.metric_definition_versions f on f.id=(r.computed_by_ref->>'formulaVersionId')::uuid
      left join training_load.metric_values n on n.id=(r.computed_by_ref->'inputValueIds'->>0)::uuid and n.occasion_id=s."occasionId"
      left join training_load.metric_values d on d.id=(r.computed_by_ref->'inputValueIds'->>1)::uuid and d.occasion_id=s."occasionId"
    ), included as (select * from occasions where ratio_id is not null),
    grouped as (
      select "bucketKey", "athleteId", unit,
        case when $3='none' then "occasionId" else null end as occasion,
        case $3 when 'ratio' then round(sum(numerator)*(min(calculation->>'scale'))::numeric/nullif(sum(denominator),0),6)
          when 'max' then max(stored_value)
          when 'last' then (array_agg(stored_value order by instant desc nulls last,"occasionId" desc))[1]
          when 'none' then max(stored_value) end as value,
        case when $3 in ('ratio','none') then sum(numerator) end as numerator,
        case when $3 in ('ratio','none') then sum(denominator) end as denominator,
        count(*)::int as "includedOccasions"
      from included group by "bucketKey","athleteId",unit,case when $3='none' then "occasionId" else null end
    ), counts as (
      select "bucketKey", "athleteId", count(*) filter(where ratio_id is null and has_input)::int as left_out
      from occasions group by "bucketKey","athleteId"
    )
    select jsonb_build_object(
      'catalogChanged', (select id from current_formula) is distinct from $4::uuid,
      'invalid', exists(select 1 from included where stored_value is null or numerator is null or denominator is null or denominator<=0
        or numerator<0 or calculation->>'kind' is distinct from 'ratio'
        or (computed_by_ref->>'formulaVersionId')::uuid is distinct from metric_definition_version_id),
      'changed', (select count(distinct jsonb_build_array(calculation->'inputs',calculation->'scale'))>1 from included),
      'calculationKey', (select jsonb_build_array(calculation->'inputs',calculation->'scale') from included limit 1),
      'calculation', (select jsonb_build_object('kind','ratio','scale',(calculation->>'scale')::int,'unit',unit) from included limit 1),
      'coverage', jsonb_build_object('includedOccasions',(select count(*)::int from included),
        'leftOutOccasions',(select count(*)::int from occasions where ratio_id is null and has_input)),
      'rows', coalesce((select jsonb_agg(jsonb_build_object('bucketKey',g."bucketKey",'athleteId',g."athleteId",
        'unit',g.unit,'value',g.value,'numerator',g.numerator,'denominator',g.denominator,
        'includedOccasions',g."includedOccasions",'leftOutOccasions',case when $3='none' then 0 else c.left_out end)
        order by g."bucketKey",g."athleteId",g.occasion)
        from grouped g join counts c on c."bucketKey"=g."bucketKey" and c."athleteId" is not distinct from g."athleteId"),'[]'::jsonb))
  ) as result`, [JSON.stringify(seeds), definitionId, aggregation, expectedVersionId]);
  const result = rows[0].result;
  if (result.catalogChanged) throw new Error('Ratio definition changed during query');
  if (result.invalid) throw new Error('Invalid stored ratio provenance');
  if (result.changed) throw Object.assign(new Error('The calculation changed during this period. Choose a shorter period.'), { code: 'calculation_changed_in_period' });
  return result;
}
