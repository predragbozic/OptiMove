-- v79: calculated variables, step 4 - a ratio and a difference (the owner's order "hajde onda radi na tome" of 2026-11-19;
-- the Rukovodilac's acceptance of the plan, PR #627, docs/ai/calculated-variables-v79-plan.md, with O1-O6 decided).
--
-- What it changes (no table, no row; four function bodies replaced, two CHECKs widened):
--   * training_load.metric_calculation_shape_ok: also
--       {"kind":"ratio","inputs":[<numerator>,<denominator>],"scale":1|100} and {"kind":"difference","inputs":[<a>,<b>]};
--     the role of an input is its place (the plan's section 1.1). A sum is unchanged.
--   * training_load.metric_calculation_version_guard (v78's body, md5-checked first):
--       - a calculated variable keeps its kind (a sum stays a sum, a ratio a ratio) from version to version;
--       - a ratio's day rule is 'ratio' (it is never summed or averaged), a sum's and a difference's 'sum'; an ordinary
--         variable never takes 'ratio';
--       - one level of nesting (O1): an input of a ratio or a difference is an ordinary variable or a sum, never a ratio or
--         a difference; an input of a sum stays an ordinary one (v77);
--       - units: a sum's and a difference's inputs have its unit; a ratio's unit is '<numerator unit>/<denominator unit>',
--         a percentage (scale 100) is '%' over two inputs of one unit; no conversion inside a formula (O3);
--       - a sum used by a ratio or a difference keeps its unit in a new version, as an ordinary input does (v77).
--     The locks are v77's: the variable's own row FOR NO KEY UPDATE, the inputs FOR SHARE in id order.
--   * training_load.metric_calculation_value_guard (v77's body, md5-checked): each input value is the value of the input
--     in that place (positional for a ratio and a difference); an input value of a ratio or a difference may be a sum's
--     own value (derived) - the writer writes sums first in the same transaction; the value is exactly:
--       sum         the sum of the inputs;
--       difference  a - b, and a - b >= 0 (a negative difference is no value, O5);
--       ratio       round(numerator * scale / denominator, 6), with denominator > 0 and numerator >= 0 (O4).
--   * training_load.dashboard_widget_series_validate_aggregation_type_compat (v16's body, md5-checked): a series of a
--     ratio is combined only as 'ratio', 'max', 'last' or 'none' (a ratio is never totalled or averaged); 'ratio' is only for
--     a ratio. The application refuses every ratio series until the dashboard stream builds its query (the plan's section
--     6); this is the database's backstop.
--   * CHECK metric_definition_versions.daily_aggregation_method and dashboard_widget_series.analytical_aggregation also
--     take 'ratio' (both refuse nothing stored: the old lists are subsets).
-- Deployed alone, nothing changes for a reader or a writer: no ratio or difference exists until the API creates one.
-- Locks: lock_timeout 5 s. Replacing a function takes no table lock; the two ALTER TABLE ... CHECK take ACCESS EXCLUSIVE on
-- metric_definition_versions and dashboard_widget_series for the validation scan (small tables). A busy table fails the
-- migration with nothing applied.
-- Runbook: docs/runbooks/calculated-variables-v79.md; rollback: docs/runbooks/calculated-variables-v79-rollback.sql (refuses
-- once a ratio or difference version, a 'ratio' day rule or a 'ratio' series exists).

set local lock_timeout = '5s';

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
      raise exception 'v79 refused: a body in force is not the one v79 replaces (%)', v_md5 using errcode = '23514';
    end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load'
         and p.proname in ('metric_calculation_shape_ok', 'metric_calculation_version_guard', 'metric_calculation_value_guard',
                           'dashboard_widget_series_validate_aggregation_type_compat')) <> 4 then
    raise exception 'v79 refused: a function v79 replaces is missing' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.metric_definition_versions where calculation is not null and calculation ->> 'kind' <> 'sum') then
    raise exception 'v79 refused: a calculation of another kind than sum exists already' using errcode = '23514';
  end if;
end;
$$;

-- 1. The shape of a calculation.
create or replace function training_load.metric_calculation_shape_ok(c jsonb) returns boolean
language sql immutable as $$
  -- Every branch is decided (coalesce): a CHECK passes on NULL, so an object without the keys ({}) must read false.
  select coalesce(case
    when c is null then true
    when jsonb_typeof(c) <> 'object' then false
    when not (c ? 'kind' and c ? 'inputs') then false
    when jsonb_typeof(c -> 'kind') <> 'string' then false
    when c ->> 'kind' = 'sum'
      and (select array_agg(k order by k collate "C") from jsonb_object_keys(c) k) <> array['inputs', 'kind']::text[] then false
    when c ->> 'kind' = 'difference'
      and (select array_agg(k order by k collate "C") from jsonb_object_keys(c) k) <> array['inputs', 'kind']::text[] then false
    when c ->> 'kind' = 'ratio'
      and ((select array_agg(k order by k collate "C") from jsonb_object_keys(c) k) <> array['inputs', 'kind', 'scale']::text[]
           or jsonb_typeof(c -> 'scale') <> 'number' or (c ->> 'scale') not in ('1', '100')) then false
    when c ->> 'kind' not in ('sum', 'ratio', 'difference') then false
    when jsonb_typeof(c -> 'inputs') <> 'array' then false
    when c ->> 'kind' = 'sum' and jsonb_array_length(c -> 'inputs') not between 2 and 10 then false
    when c ->> 'kind' in ('ratio', 'difference') and jsonb_array_length(c -> 'inputs') <> 2 then false
    else (select bool_and(jsonb_typeof(e) = 'string'
                          and (e #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                 and count(distinct e #>> '{}') = count(*)
            from jsonb_array_elements(c -> 'inputs') e)
  end, false)
$$;
comment on function training_load.metric_calculation_shape_ok(jsonb) is
  'v79: a calculation is {"kind":"sum","inputs":[2-10 distinct lower-case uuids]}, {"kind":"ratio","inputs":[numerator, denominator],"scale":1|100} or {"kind":"difference","inputs":[a, b]}, and nothing else.';

-- 2. The day rule 'ratio' (a ratio's own: never summed or averaged) and a ratio series' 'ratio' aggregation.
alter table training_load.metric_definition_versions
  drop constraint metric_definition_versions_daily_aggregation_method_check,
  add constraint metric_definition_versions_daily_aggregation_method_check
    check (daily_aggregation_method in ('sum', 'avg', 'max', 'last', 'none', 'ratio'));
alter table training_load.dashboard_widget_series
  drop constraint dashboard_widget_series_analytical_aggregation_check,
  add constraint dashboard_widget_series_analytical_aggregation_check
    check (analytical_aggregation in ('sum', 'avg', 'max', 'last', 'none', 'ratio'));

-- 3. The version guard (v78's body with the kinds).
create or replace function training_load.metric_calculation_version_guard() returns trigger as $$
declare
  v_owner_scope text;
  v_owner_club uuid;
  v_prev jsonb;
  v_prev_found boolean;
  v_kind text;
  v_inputs uuid[];
  v_levels text[];
  v_input record;
  v_count integer;
  v_units text[];
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
  -- v79: ... and keeps its kind.
  if v_prev is not null and new.calculation is not null and (v_prev ->> 'kind') is distinct from (new.calculation ->> 'kind') then
    raise exception 'metric_definition_versions: a calculated variable keeps its kind' using errcode = '23514';
  end if;

  -- An input of a calculated variable (of any kind) keeps its unit, its numeric type and its day rule Sum while used.
  if exists (select 1 from training_load.metric_definitions cd
               join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
              where cv.calculation is not null
                and new.metric_definition_id = any (training_load.metric_calculation_inputs(cv.calculation))
                and (cv.unit is distinct from new.unit and cv.calculation ->> 'kind' <> 'ratio'
                     or new.value_type is distinct from 'numeric')) then
    raise exception 'metric_definition_versions: a calculated variable uses this variable; its unit and type stay as they are' using errcode = '23514';
  end if;
  -- v79: a ratio's input keeps its own unit (the ratio's unit is made of its inputs' units).
  if exists (select 1 from training_load.metric_definitions cd
               join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
               join training_load.metric_definitions od on od.id = new.metric_definition_id
               join training_load.metric_definition_versions ov on ov.id = od.current_version_id and ov.metric_definition_id = od.id
              where cv.calculation ->> 'kind' = 'ratio'
                and new.metric_definition_id = any (training_load.metric_calculation_inputs(cv.calculation))
                and ov.unit is distinct from new.unit) then
    raise exception 'metric_definition_versions: a calculated variable uses this variable; its unit and type stay as they are' using errcode = '23514';
  end if;
  if new.daily_aggregation_method is distinct from 'sum'
     and exists (select 1 from training_load.metric_definitions cd
                   join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
                  where cv.calculation is not null
                    and new.metric_definition_id = any (training_load.metric_calculation_inputs(cv.calculation))) then
    raise exception 'metric_definition_versions: a calculated variable adds up this variable; its day rule stays Sum' using errcode = '23514';
  end if;

  if new.calculation is null then
    -- v79: 'ratio' is a ratio's own day rule.
    if new.daily_aggregation_method = 'ratio' then
      raise exception 'metric_definition_versions: only a calculated ratio has the day rule Ratio' using errcode = '23514';
    end if;
    return new;
  end if;

  v_kind := new.calculation ->> 'kind';
  if new.value_type is distinct from 'numeric' or new.min_value is not null or new.max_value is not null then
    raise exception 'metric_definition_versions: a calculated version is numeric, with no bounds' using errcode = '23514';
  end if;
  -- A sum and a difference are amounts (day rule Sum); a ratio is never summed or averaged (day rule Ratio).
  if v_kind = 'ratio' and new.daily_aggregation_method is distinct from 'ratio' then
    raise exception 'metric_definition_versions: a calculated ratio''s day rule is Ratio' using errcode = '23514';
  end if;
  if v_kind <> 'ratio' and new.daily_aggregation_method is distinct from 'sum' then
    raise exception 'metric_definition_versions: a calculated version''s day rule is Sum' using errcode = '23514';
  end if;
  if v_owner_scope not in ('system', 'club') then
    raise exception 'metric_definition_versions: only a system or a club variable is calculated' using errcode = '23514';
  end if;
  v_inputs := training_load.metric_calculation_inputs(new.calculation);
  if v_kind = 'sum' and cardinality(v_inputs) not between 2 and 10 then
    raise exception 'metric_definition_versions: a calculation sums 2 to 10 inputs' using errcode = '23514';
  end if;
  if v_kind <> 'sum' and cardinality(v_inputs) <> 2 then
    raise exception 'metric_definition_versions: a ratio or a difference has exactly two inputs' using errcode = '23514';
  end if;
  if new.metric_definition_id = any (v_inputs) then
    raise exception 'metric_definition_versions: a calculated variable is not its own input' using errcode = '23514';
  end if;

  select array_agg(c.scope_level::text order by c.scope_level) into v_levels
    from training_load.metric_definition_scope_capabilities c where c.metric_definition_id = new.metric_definition_id;
  if v_levels is null or 'day' = any (v_levels) then
    raise exception 'metric_definition_versions: a calculated variable has its session or drill levels before its version' using errcode = '23514';
  end if;

  -- The inputs, FOR SHARE in id order, then each checked on its current version, in the calculation's order.
  perform 1 from training_load.metric_definitions d where d.id = any (v_inputs) order by d.id for share;
  v_count := 0;
  v_units := '{}'::text[];
  for v_input in
    select d.id, d.state, d.owner_scope, d.owner_club_id, v.value_type, v.unit, v.calculation, v.daily_aggregation_method,
           (select array_agg(c.scope_level::text) from training_load.metric_definition_scope_capabilities c where c.metric_definition_id = d.id) as levels
      from unnest(v_inputs) with ordinality as x(id, ord)
      join training_load.metric_definitions d on d.id = x.id
      join training_load.metric_definition_versions v on v.id = d.current_version_id and v.metric_definition_id = d.id
     order by x.ord
  loop
    v_count := v_count + 1;
    v_units := v_units || v_input.unit;
    if v_input.state is distinct from 'active'
       or not (v_input.owner_scope = 'system'
               or (v_owner_scope = 'club' and v_input.owner_scope = 'club' and v_input.owner_club_id = v_owner_club)) then
      raise exception 'metric_definition_versions: every input is an active variable of the same owner or a system one' using errcode = '23514';
    end if;
    -- One level (O1): a sum adds up ordinary variables; a ratio or a difference uses ordinary variables or sums.
    if v_input.calculation is not null and (v_kind = 'sum' or v_input.calculation ->> 'kind' <> 'sum') then
      raise exception 'metric_definition_versions: an input is not calculated itself, or is a sum used by a ratio or a difference' using errcode = '23514';
    end if;
    if v_input.value_type is distinct from 'numeric' or (v_kind <> 'ratio' and v_input.unit is distinct from new.unit) then
      raise exception 'metric_definition_versions: every input is numeric with the calculated variable''s unit' using errcode = '23514';
    end if;
    -- v78: every input is an amount, combined by Sum (a ratio divides two amounts).
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
  -- v79: a ratio's unit is its inputs' (no conversion inside a formula, O3).
  if v_kind = 'ratio' then
    if (new.calculation ->> 'scale') = '100' then
      if v_units[1] is distinct from v_units[2] or new.unit is distinct from '%' then
        raise exception 'metric_definition_versions: a percentage divides two variables of one unit, and its unit is %%' using errcode = '23514';
      end if;
    elsif new.unit is distinct from (v_units[1] || '/' || v_units[2]) then
      raise exception 'metric_definition_versions: a ratio''s unit is its numerator''s unit / its denominator''s unit' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
comment on function training_load.metric_calculation_version_guard() is
  'v79: a calculated version (sum: 2-10 inputs; ratio, difference: 2) uses active numeric inputs of the same owner (or system), each summed by day, with its levels; a sum''s inputs are ordinary and have its unit; a ratio''s or a difference''s are ordinary or sums; a difference has its inputs'' unit, a ratio <numerator>/<denominator> or % over one unit; a ratio''s day rule is Ratio, the others'' Sum; a variable never changes kind; an input keeps its unit and its day rule Sum while used.';

-- 4. The value guard (v77's body with the kinds).
create or replace function training_load.metric_calculation_value_guard() returns trigger as $$
declare
  v_calc jsonb;
  v_kind text;
  v_inputs uuid[];
  v_ids uuid[];
  v_found integer;
  v_defs integer;
  v_in_place boolean;
  v_sum numeric;
  v_first numeric;
  v_second numeric;
  v_expected numeric;
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
  v_kind := v_calc ->> 'kind';
  v_inputs := training_load.metric_calculation_inputs(v_calc);
  if jsonb_array_length(new.computed_by_ref -> 'inputValueIds') <> cardinality(v_inputs)
     or exists (select 1 from jsonb_array_elements(new.computed_by_ref -> 'inputValueIds') e
                 where jsonb_typeof(e) <> 'string'
                    or (e #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'metric_values: a calculated value names one input value per input' using errcode = '23514';
  end if;
  select array_agg((e #>> '{}')::uuid order by ord) into v_ids
    from jsonb_array_elements(new.computed_by_ref -> 'inputValueIds') with ordinality as t(e, ord);
  -- An input value is on this occasion, of an input, not derived - or, for a ratio or a difference, a sum's own value.
  select count(*), count(distinct iv.metric_definition_id), coalesce(bool_and(iv.metric_definition_id = v_inputs[x.ord]), false),
         sum(iv.value_numeric), max(iv.value_numeric) filter (where x.ord = 1), max(iv.value_numeric) filter (where x.ord = 2)
    into v_found, v_defs, v_in_place, v_sum, v_first, v_second
    from unnest(v_ids) with ordinality as x(id, ord)
    join training_load.metric_values iv on iv.id = x.id
   where iv.occasion_id = new.occasion_id and iv.value_numeric is not null and iv.metric_definition_id = any (v_inputs)
     and (not iv.is_derived
          or (v_kind <> 'sum'
              and exists (select 1 from training_load.metric_definition_versions sv
                           where sv.id = iv.metric_definition_version_id and sv.calculation ->> 'kind' = 'sum')));
  if v_found <> cardinality(v_inputs) or v_defs <> cardinality(v_inputs) or (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_inputs) then
    raise exception 'metric_values: a calculated value names one input value per input, on its own occasion' using errcode = '23514';
  end if;
  if v_kind <> 'sum' and not v_in_place then
    raise exception 'metric_values: a ratio''s or a difference''s input values are named in the calculation''s order' using errcode = '23514';
  end if;
  if v_kind = 'sum' then
    v_expected := v_sum;
  elsif v_kind = 'difference' then
    if v_first - v_second < 0 then
      raise exception 'metric_values: a difference below zero is no value' using errcode = '23514';
    end if;
    v_expected := v_first - v_second;
  elsif v_kind = 'ratio' then
    if v_second <= 0 or v_first < 0 then
      raise exception 'metric_values: a ratio needs a denominator above zero and a numerator not below zero' using errcode = '23514';
    end if;
    v_expected := round(v_first * (v_calc ->> 'scale')::numeric / v_second, 6);
  else
    raise exception 'metric_values: an unknown kind of calculation' using errcode = '23514';
  end if;
  if v_expected is distinct from new.value_numeric then
    raise exception 'metric_values: a calculated value is exactly its calculation of its input values' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
comment on function training_load.metric_calculation_value_guard() is
  'v79: a calculated value is derived, derived_rollup, complete, names its own version and one value per input on its own occasion (in place for a ratio or a difference, which may use a sum''s value), and is exactly: the sum; a - b >= 0; round(numerator * scale / denominator, 6) with denominator > 0 and numerator >= 0.';

-- 5. A series of a ratio is never totalled or averaged (v16's body with the kind).
create or replace function training_load.dashboard_widget_series_validate_aggregation_type_compat() returns trigger as $$
declare
  v_value_type varchar;
  v_kind text;
begin
  if new.metric_definition_id is not null then
    perform 1 from training_load.metric_definitions where id = new.metric_definition_id for share;
    select mdv.value_type, mdv.calculation ->> 'kind' into v_value_type, v_kind
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
  -- v79: a ratio is combined as a ratio (sum of numerators / sum of denominators), its highest or its latest value - never
  -- totalled or averaged; 'ratio' is only for a ratio.
  if v_kind = 'ratio' and new.analytical_aggregation not in ('ratio', 'max', 'last', 'none') then
    raise exception 'dashboard_widget_series: a ratio is not totalled or averaged (got %, widget %)', new.analytical_aggregation, new.widget_id using errcode = '23514';
  end if;
  if v_kind is distinct from 'ratio' and new.analytical_aggregation = 'ratio' then
    raise exception 'dashboard_widget_series: the aggregation ratio is only for a calculated ratio (widget %)', new.widget_id using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

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
    if v_md5 not in ('metric_calculation_shape_ok=a48b6fa7166f0c46e10cc8a98f3c3ae2', 'metric_calculation_version_guard=97949aad715f1532054edbf3f81ab4ca',
                     'metric_calculation_value_guard=c4ff25e511abccebc4a07f6ccd7478d8', 'dashboard_widget_series_validate_aggregation_type_compat=259f15ee79a08434b0439ebd0a3daff4') then
      raise exception 'v79 failed: a body is not the one v79 writes (%)', v_md5 using errcode = '23514';
    end if;
  end loop;
end;
$$;
