-- v77: calculated variables, step 1 - a Metrics Core variable whose value is the sum of 2-10 other variables (the owner's
-- order of 2026-11-18, option B; the Rukovodilac's decisions 1-10). Plan: docs/ai/gpexe-metric-variable-mapping-discovery.md,
-- section J21 (decisions C141-C150).
--
-- What it adds (no row is written; no body in force is replaced):
--   * metric_definition_versions.calculation jsonb: null for an ordinary variable; for a calculated one exactly
--     {"kind": "sum", "inputs": [<2-10 distinct lower-case definition ids>]} (CHECK, metric_calculation_shape_ok).
--   * A version guard (BEFORE INSERT on metric_definition_versions):
--       - a variable is calculated from its version 1 or never: a later version keeps the kind of the version before it;
--       - a calculated version is numeric with no bounds (a sum outside a bound would refuse an import); a condition is
--         allowed as stated data (the Rukovodilac, 2026-11-18): it is not checked against the inputs in step 1;
--       - every input is another active variable of the same owner (a system variable takes system inputs; a club variable
--         its own club's or system ones), numeric, not calculated itself (no nesting, so no cycle), with the calculated
--         version's unit exactly (no conversion in step 1), and every level the calculated variable has (session /
--         component; never day);
--       - a new version of an input keeps its unit and numeric type while a calculated variable's current version uses it.
--     The inputs are locked FOR SHARE and the variable's own row FOR NO KEY UPDATE, so a concurrent change of an input's
--     unit and a calculation over it wait for each other (an import's FOR KEY SHARE on a definition never waits).
--   * A level guard (metric_definition_scope_capabilities): a calculated variable gets only a level all its inputs have and
--     keeps at least one; an input keeps a level a calculated variable using it has. It locks as the version guard does.
--   * A mapping guard (source_metric_mapping_versions): a calculated variable is never the target of a mapping.
--   * A value guard (BEFORE INSERT on metric_values): a value of a calculated version is written only as its calculation -
--     is_derived, aggregation_role 'derived_rollup', coverage 'complete', computed_by_ref exactly
--     {"formulaVersionId": <its own version id>, "inputValueIds": [...]} naming one value per input, on the same occasion
--     (so the same athlete, event and level), none derived, and value_numeric exactly their sum. A missing input is no value
--     (decision 2); zero is a value (decision 5). An imported, manual or estimated value of a calculated variable is
--     refused, and a formula reference on any other value too. Step 1 writes no such value: the writer is the next PR.
-- Nothing computes a value yet and no variable is calculated until the API creates one, so deployed alone v77 changes nothing
-- for a reader or a writer (decision 9).
-- Locks: metric_definition_versions ACCESS EXCLUSIVE for the new column and CHECK (every existing row is null: no rewrite), then
-- the trigger creations, lock_timeout 5 s; a busy table fails the migration with nothing applied.
-- Rollback: docs/runbooks/calculated-variables-v77-rollback.sql (refuses once a calculated version or a formula value exists).

set local lock_timeout = '5s';

-- 1. The shape of a calculation.
create function training_load.metric_calculation_shape_ok(c jsonb) returns boolean
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

alter table training_load.metric_definition_versions
  add column calculation jsonb,
  add constraint metric_definition_versions_calculation_shape check (training_load.metric_calculation_shape_ok(calculation));
comment on column training_load.metric_definition_versions.calculation is
  'v77: null for an ordinary variable; {"kind":"sum","inputs":[definition ids]} for a calculated one (its values are the sum of its inputs'' values on the same occasion).';

-- The ids of the inputs of a calculation, as uuids (empty for none).
create function training_load.metric_calculation_inputs(c jsonb) returns uuid[]
language sql immutable as $$
  select coalesce(array_agg((e #>> '{}')::uuid order by ord), '{}'::uuid[])
    from jsonb_array_elements(c -> 'inputs') with ordinality as t(e, ord)
$$;

-- 2. The version guard.
create function training_load.metric_calculation_version_guard() returns trigger as $$
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
    return new;
  end if;

  if new.value_type is distinct from 'numeric' or new.min_value is not null or new.max_value is not null then
    raise exception 'metric_definition_versions: a calculated version is numeric, with no bounds' using errcode = '23514';
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
    select d.id, d.state, d.owner_scope, d.owner_club_id, v.value_type, v.unit, v.calculation,
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
  'v77: a calculated version sums 2-10 active, non-calculated, numeric inputs of the same owner (or system) with its unit and levels; a variable never changes kind; an input keeps its unit while used.';

create trigger metric_definition_versions_calculation_guard
  before insert on training_load.metric_definition_versions
  for each row execute function training_load.metric_calculation_version_guard();

-- 3. The level guard. Locks like the version guard (the definition's own row FOR NO KEY UPDATE; a calculation's inputs FOR
-- SHARE in id order), so a level change and a calculation over the same variable wait for each other.
create function training_load.metric_calculation_level_guard() returns trigger as $$
declare
  v_def uuid;
  v_level text;
  v_calc jsonb;
  v_inputs uuid[];
  v_rows uuid[] := '{}';
begin
  -- The definition rows this change touches, FOR NO KEY UPDATE once, in id order (an UPDATE may name two).
  if tg_op in ('UPDATE', 'DELETE') then
    v_rows := v_rows || old.metric_definition_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_rows := v_rows || new.metric_definition_id;
  end if;
  perform 1 from training_load.metric_definitions d where d.id = any (v_rows) order by d.id for no key update;
  if tg_op in ('UPDATE', 'DELETE') then
    v_def := old.metric_definition_id;
    v_level := old.scope_level;
    if tg_op = 'DELETE' or new.metric_definition_id is distinct from v_def or new.scope_level is distinct from v_level then
      if exists (select 1 from training_load.metric_definitions cd
                   join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
                   join training_load.metric_definition_scope_capabilities cc on cc.metric_definition_id = cd.id and cc.scope_level = v_level
                  where cv.calculation is not null and v_def = any (training_load.metric_calculation_inputs(cv.calculation))) then
        raise exception 'metric_definition_scope_capabilities: a calculated variable uses this level of this variable' using errcode = '23514';
      end if;
      -- A calculated variable keeps at least one level (a level renamed in place stays one).
      if (tg_op = 'DELETE' or new.metric_definition_id is distinct from v_def)
         and exists (select 1 from training_load.metric_definitions d
                   join training_load.metric_definition_versions v on v.id = d.current_version_id and v.metric_definition_id = d.id
                  where d.id = v_def and v.calculation is not null)
         and not exists (select 1 from training_load.metric_definition_scope_capabilities c
                          where c.metric_definition_id = v_def and c.scope_level <> v_level) then
        raise exception 'metric_definition_scope_capabilities: a calculated variable keeps at least one level' using errcode = '23514';
      end if;
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select v.calculation into v_calc
      from training_load.metric_definitions d
      join training_load.metric_definition_versions v on v.id = d.current_version_id and v.metric_definition_id = d.id
     where d.id = new.metric_definition_id;
    if v_calc is not null then
      v_inputs := training_load.metric_calculation_inputs(v_calc);
      perform 1 from training_load.metric_definitions d where d.id = any (v_inputs) order by d.id for share;
      if new.scope_level = 'day'
         or exists (select 1 from unnest(v_inputs) i(id)
                     where not exists (select 1 from training_load.metric_definition_scope_capabilities c
                                        where c.metric_definition_id = i.id and c.scope_level = new.scope_level)) then
        raise exception 'metric_definition_scope_capabilities: a calculated variable gets only a level all its inputs have' using errcode = '23514';
      end if;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$ language plpgsql;

create trigger metric_definition_scope_capabilities_calculation_guard
  before insert or update or delete on training_load.metric_definition_scope_capabilities
  for each row execute function training_load.metric_calculation_level_guard();

-- 4. The mapping guard.
create function training_load.metric_calculation_mapping_guard() returns trigger as $$
begin
  if exists (select 1 from training_load.metric_definition_versions v
              where v.id = new.metric_definition_version_id and v.calculation is not null) then
    raise exception 'source_metric_mapping_versions: a calculated variable is never the target of a mapping' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_mapping_versions_calculation_guard
  before insert on training_load.source_metric_mapping_versions
  for each row execute function training_load.metric_calculation_mapping_guard();

-- 5. The value guard. A calculated value comes after its inputs (a later statement, or a later row of the same one).
create function training_load.metric_calculation_value_guard() returns trigger as $$
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

create trigger metric_values_calculation_guard
  before insert on training_load.metric_values
  for each row execute function training_load.metric_calculation_value_guard();
