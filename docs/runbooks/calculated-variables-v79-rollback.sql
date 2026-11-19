-- Rollback of migration v79 (calculated variables: a ratio and a difference): migrations_v2/202611191200_training_load_v79_calculated_ratio_difference.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/calculated-variables-v79.test.mjs:
-- apply -> rollback -> the catalog of v78 exactly -> re-apply). Before it is run anywhere real: a fresh restore-verified
-- backup exists; the deployed commit no longer contains the v79 migration file (otherwise the migrator applies v79 again at
-- the next start); and the owner approved this database specifically (.claude/rules/database-safety.md).
--
-- It restores the four bodies v79 replaced exactly (v77's shape and value guard, v78's version guard, v16's series guard; with
-- their comments), narrows the two CHECKs back and removes the v79 record. It changes no row of any table. It refuses,
-- changing nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v79 is not recorded;
--   * a body in force is not the one v79 wrote (a later migration that replaced one must be rolled back first);
--   * a ratio or a difference exists (a version of one, so possibly its values), a version carries the day rule 'ratio', or a
--     dashboard series the aggregation 'ratio' - v78's guards and the narrowed CHECKs could not hold them.
-- It does not look at later migrations by name: one that touches other objects (the calendar's) does not block it.
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f calculated-variables-v79-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v79 rollback refused: the migrator is running';
  end if;
end $$;

do $$
declare
  v_md5 text;
begin
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611191200_training_load_v79_calculated_ratio_difference.sql') then
    raise exception 'v79 rollback refused: v79 is not recorded';
  end if;
  for v_md5 in
    select format('%s=%s', p.proname, md5(p.prosrc)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'training_load'
       and p.proname in ('metric_calculation_shape_ok', 'metric_calculation_version_guard', 'metric_calculation_value_guard',
                         'dashboard_widget_series_validate_aggregation_type_compat')
  loop
    if v_md5 not in ('metric_calculation_shape_ok=a48b6fa7166f0c46e10cc8a98f3c3ae2', 'metric_calculation_version_guard=97949aad715f1532054edbf3f81ab4ca',
                     'metric_calculation_value_guard=c4ff25e511abccebc4a07f6ccd7478d8', 'dashboard_widget_series_validate_aggregation_type_compat=259f15ee79a08434b0439ebd0a3daff4') then
      raise exception 'v79 rollback refused: a body in force is not the one v79 wrote (%)', v_md5;
    end if;
  end loop;
  if exists (select 1 from training_load.metric_definition_versions where calculation ->> 'kind' in ('ratio', 'difference')) then
    raise exception 'v79 rollback refused: a ratio or a difference exists';
  end if;
  if exists (select 1 from training_load.metric_definition_versions where daily_aggregation_method = 'ratio') then
    raise exception 'v79 rollback refused: a version has the day rule ratio';
  end if;
  if exists (select 1 from training_load.dashboard_widget_series where analytical_aggregation = 'ratio') then
    raise exception 'v79 rollback refused: a dashboard series combines as ratio';
  end if;
end $$;

-- The bodies before v79, exactly.
create or replace function training_load.metric_calculation_shape_ok(c jsonb) returns boolean
language sql immutable as $$
  -- Every branch is decided (coalesce): a CHECK passes on NULL, so an object without the keys ({}) must read false.
  select coalesce(case
    when c is null then true
    when jsonb_typeof(c) <> 'object' then false
    when not (c ? 'kind' and c ? 'inputs') then false
    when (select array_agg(k order by k collate "C") from jsonb_object_keys(c) k) <> array['inputs', 'kind']::text[] then false
    when jsonb_typeof(c -> 'kind') <> 'string' or c ->> 'kind' <> 'sum' then false
    when jsonb_typeof(c -> 'inputs') <> 'array' then false
    when jsonb_array_length(c -> 'inputs') not between 2 and 10 then false
    else (select bool_and(jsonb_typeof(e) = 'string'
                          and (e #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                 and count(distinct e #>> '{}') = count(*)
            from jsonb_array_elements(c -> 'inputs') e)
  end, false)
$$;
comment on function training_load.metric_calculation_shape_ok(jsonb) is
  'v77: a calculation is {"kind":"sum","inputs":[2-10 distinct lower-case uuids]} and nothing else.';

create or replace function training_load.metric_calculation_version_guard() returns trigger as $$
declare
  v_owner_scope text;
  v_owner_club uuid;
  v_prev jsonb;
  v_prev_found boolean;
  v_inputs uuid[];
  v_levels text[];
  v_input record;
  v_count integer;
begin
  -- The variable's own row: a change of its unit waits for a calculation over it being created, and the reverse.
  select d.owner_scope, d.owner_club_id into v_owner_scope, v_owner_club
    from training_load.metric_definitions d where d.id = new.metric_definition_id for no key update;
  if not found then
    return new; -- the foreign key refuses it
  end if;

  select v.calculation, true into v_prev, v_prev_found
    from training_load.metric_definition_versions v
   where v.metric_definition_id = new.metric_definition_id
   order by v.version_number desc limit 1;
  if coalesce(v_prev_found, false) and ((v_prev is null) <> (new.calculation is null)) then
    raise exception 'metric_definition_versions: a variable is calculated from its first version or never' using errcode = '23514';
  end if;

  if new.calculation is null then
    -- An input of a calculated variable keeps its unit and its numeric type.
    if exists (select 1 from training_load.metric_definitions cd
                 join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
                where cv.calculation is not null
                  and new.metric_definition_id = any (training_load.metric_calculation_inputs(cv.calculation))
                  and (cv.unit is distinct from new.unit or new.value_type is distinct from 'numeric')) then
      raise exception 'metric_definition_versions: a calculated variable uses this variable; its unit and type stay as they are' using errcode = '23514';
    end if;
    -- v78: ... and its day rule stays Sum (a sum adds only amounts).
    if new.daily_aggregation_method is distinct from 'sum'
       and exists (select 1 from training_load.metric_definitions cd
                     join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
                    where cv.calculation is not null
                      and new.metric_definition_id = any (training_load.metric_calculation_inputs(cv.calculation))) then
      raise exception 'metric_definition_versions: a calculated variable adds up this variable; its day rule stays Sum' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.value_type is distinct from 'numeric' or new.min_value is not null or new.max_value is not null then
    raise exception 'metric_definition_versions: a calculated version is numeric, with no bounds' using errcode = '23514';
  end if;
  -- v78: a calculated variable's day values are added up too.
  if new.daily_aggregation_method is distinct from 'sum' then
    raise exception 'metric_definition_versions: a calculated version''s day rule is Sum' using errcode = '23514';
  end if;
  if v_owner_scope not in ('system', 'club') then
    raise exception 'metric_definition_versions: only a system or a club variable is calculated' using errcode = '23514';
  end if;
  v_inputs := training_load.metric_calculation_inputs(new.calculation);
  if cardinality(v_inputs) not between 2 and 10 then
    raise exception 'metric_definition_versions: a calculation sums 2 to 10 inputs' using errcode = '23514';
  end if;
  if new.metric_definition_id = any (v_inputs) then
    raise exception 'metric_definition_versions: a calculated variable is not its own input' using errcode = '23514';
  end if;

  select array_agg(c.scope_level::text order by c.scope_level) into v_levels
    from training_load.metric_definition_scope_capabilities c where c.metric_definition_id = new.metric_definition_id;
  if v_levels is null or 'day' = any (v_levels) then
    raise exception 'metric_definition_versions: a calculated variable has its session or drill levels before its version' using errcode = '23514';
  end if;

  -- The inputs, FOR SHARE in id order, then each checked on its current version.
  perform 1 from training_load.metric_definitions d where d.id = any (v_inputs) order by d.id for share;
  v_count := 0;
  for v_input in
    select d.id, d.state, d.owner_scope, d.owner_club_id, v.value_type, v.unit, v.calculation, v.daily_aggregation_method,
           (select array_agg(c.scope_level::text) from training_load.metric_definition_scope_capabilities c where c.metric_definition_id = d.id) as levels
      from training_load.metric_definitions d
      join training_load.metric_definition_versions v on v.id = d.current_version_id and v.metric_definition_id = d.id
     where d.id = any (v_inputs)
  loop
    v_count := v_count + 1;
    if v_input.state is distinct from 'active'
       or not (v_input.owner_scope = 'system'
               or (v_owner_scope = 'club' and v_input.owner_scope = 'club' and v_input.owner_club_id = v_owner_club)) then
      raise exception 'metric_definition_versions: every input is an active variable of the same owner or a system one' using errcode = '23514';
    end if;
    if v_input.calculation is not null then
      raise exception 'metric_definition_versions: an input is not calculated itself' using errcode = '23514';
    end if;
    if v_input.value_type is distinct from 'numeric' or v_input.unit is distinct from new.unit then
      raise exception 'metric_definition_versions: every input is numeric with the calculated variable''s unit' using errcode = '23514';
    end if;
    -- v78: a sum adds only amounts: every input is combined by Sum.
    if v_input.daily_aggregation_method is distinct from 'sum' then
      raise exception 'metric_definition_versions: every input is added up by Sum' using errcode = '23514';
    end if;
    if not (v_levels <@ coalesce(v_input.levels, '{}'::text[])) then
      raise exception 'metric_definition_versions: every input has every level of the calculated variable' using errcode = '23514';
    end if;
  end loop;
  if v_count <> cardinality(v_inputs) then
    raise exception 'metric_definition_versions: every input is an active variable of the same owner or a system one' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
comment on function training_load.metric_calculation_version_guard() is
  'v78: a calculated version sums 2-10 active, non-calculated, numeric inputs of the same owner (or system), each summed by day, with its unit and levels, and is summed by day itself; a variable never changes kind; an input keeps its unit and its day rule Sum while used.';

create or replace function training_load.metric_calculation_value_guard() returns trigger as $$
declare
  v_calc jsonb;
  v_inputs uuid[];
  v_ids uuid[];
  v_found integer;
  v_defs integer;
  v_sum numeric;
begin
  select v.calculation into v_calc from training_load.metric_definition_versions v where v.id = new.metric_definition_version_id;
  if v_calc is null then
    if new.computed_by_ref is not null and jsonb_typeof(new.computed_by_ref) = 'object' and new.computed_by_ref ? 'formulaVersionId' then
      raise exception 'metric_values: a formula reference names a calculated version' using errcode = '23514';
    end if;
    return new;
  end if;

  if not new.is_derived or new.aggregation_role is distinct from 'derived_rollup' or new.coverage is distinct from 'complete'
     or new.value_numeric is null or new.computed_by_ref is null or jsonb_typeof(new.computed_by_ref) <> 'object'
     or (select array_agg(k order by k collate "C") from jsonb_object_keys(new.computed_by_ref) k) <> array['formulaVersionId', 'inputValueIds']::text[]
     or new.computed_by_ref ->> 'formulaVersionId' is distinct from new.metric_definition_version_id::text
     or jsonb_typeof(new.computed_by_ref -> 'inputValueIds') <> 'array' then
    raise exception 'metric_values: a calculated variable''s value is written only as its calculation' using errcode = '23514';
  end if;
  v_inputs := training_load.metric_calculation_inputs(v_calc);
  if jsonb_array_length(new.computed_by_ref -> 'inputValueIds') <> cardinality(v_inputs)
     or exists (select 1 from jsonb_array_elements(new.computed_by_ref -> 'inputValueIds') e
                 where jsonb_typeof(e) <> 'string'
                    or (e #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'metric_values: a calculated value names one input value per input' using errcode = '23514';
  end if;
  select array_agg((e #>> '{}')::uuid) into v_ids from jsonb_array_elements(new.computed_by_ref -> 'inputValueIds') e;
  select count(*), count(distinct iv.metric_definition_id), sum(iv.value_numeric)
    into v_found, v_defs, v_sum
    from training_load.metric_values iv
   where iv.id = any (v_ids) and iv.occasion_id = new.occasion_id and not iv.is_derived
     and iv.value_numeric is not null and iv.metric_definition_id = any (v_inputs);
  if v_found <> cardinality(v_inputs) or v_defs <> cardinality(v_inputs) or (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_inputs) then
    raise exception 'metric_values: a calculated value names one input value per input, on its own occasion' using errcode = '23514';
  end if;
  if v_sum is distinct from new.value_numeric then
    raise exception 'metric_values: a calculated value is exactly the sum of its input values' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
comment on function training_load.metric_calculation_value_guard() is
  'v77: a value of a calculated version is derived_rollup, complete, names its formula version and one non-derived value per input on its own occasion, and equals their sum.';

create or replace function training_load.dashboard_widget_series_validate_aggregation_type_compat() returns trigger as $$
declare
  v_value_type varchar;
begin
  if new.metric_definition_id is not null then
    perform 1 from training_load.metric_definitions where id = new.metric_definition_id for share;
    select mdv.value_type into v_value_type
      from training_load.metric_definitions md
      join training_load.metric_definition_versions mdv on mdv.id = md.current_version_id
      where md.id = new.metric_definition_id;
  elsif new.built_in_series_key is not null then
    perform 1 from training_load.dashboard_builtin_series where key = new.built_in_series_key for share;
    select value_type into v_value_type from training_load.dashboard_builtin_series where key = new.built_in_series_key;
  else
    return new;
  end if;
  if v_value_type in ('text', 'boolean') and new.analytical_aggregation not in ('last', 'none') then
    raise exception 'dashboard_widget_series: value_type % only supports analytical_aggregation last/none this phase (got %, widget %)', v_value_type, new.analytical_aggregation, new.widget_id;
  end if;
  return new;
end;
$$ language plpgsql;

alter table training_load.metric_definition_versions
  drop constraint metric_definition_versions_daily_aggregation_method_check,
  add constraint metric_definition_versions_daily_aggregation_method_check
    check (daily_aggregation_method in ('sum', 'avg', 'max', 'last', 'none'));
alter table training_load.dashboard_widget_series
  drop constraint dashboard_widget_series_analytical_aggregation_check,
  add constraint dashboard_widget_series_analytical_aggregation_check
    check (analytical_aggregation in ('sum', 'avg', 'max', 'last', 'none'));

do $$
declare
  v_md5 text;
begin
  for v_md5 in
    select format('%s=%s', p.proname, md5(p.prosrc)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'training_load'
       and p.proname in ('metric_calculation_shape_ok', 'metric_calculation_version_guard', 'metric_calculation_value_guard',
                         'dashboard_widget_series_validate_aggregation_type_compat')
  loop
    if v_md5 not in ('metric_calculation_shape_ok=2d2a17ae713005d116fc1ab96b783b9d', 'metric_calculation_version_guard=eae4cc9d519a498ca7f4acf0bedbdcbd',
                     'metric_calculation_value_guard=22e88230de37aba4646d49cc49986f6f', 'dashboard_widget_series_validate_aggregation_type_compat=dbd91e8d23f6bd729fc89e705c7424c8') then
      raise exception 'v79 rollback failed: a restored body is not the one before v79 (%)', v_md5;
    end if;
  end loop;
end $$;

delete from public.schema_migrations where migration_name = 'migrations_v2/202611191200_training_load_v79_calculated_ratio_difference.sql';

commit;
