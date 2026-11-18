-- Rollback of migration v78 (calculated variables add up only amounts): migrations_v2/202611181100_training_load_v78_calculated_variables_additive.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/calculated-variables-v78.test.mjs:
-- apply -> rollback -> the catalog of v77 exactly -> re-apply). Before it is run anywhere real: a fresh restore-verified
-- backup exists; the deployed commit no longer contains the v78 migration file (otherwise the migrator applies v78 again at
-- the next start); and the owner approved this database specifically (.claude/rules/database-safety.md).
--
-- It restores v77's body of training_load.metric_calculation_version_guard exactly (and its comment), drops v78's state guard
-- (its trigger and function) and removes the v78 record. It changes no row of any table. It refuses, changing nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v78 is not recorded, or any later migrations_v2 migration is;
--   * a body in force is not the one v78 wrote.
-- After it the four day-rule and archive rules are the API's alone again (backend/src/canonicalVariableAdminService.js).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f calculated-variables-v78-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v78 rollback refused: the migrator is running';
  end if;
end $$;

do $$
declare
  v78 constant text := 'migrations_v2/202611181100_training_load_v78_calculated_variables_additive.sql';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v78) then
    raise exception 'v78 rollback refused: v78 is not recorded';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v78) then
    raise exception 'v78 rollback refused: a later migration is recorded';
  end if;
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'metric_calculation_version_guard') is distinct from 'eae4cc9d519a498ca7f4acf0bedbdcbd'
     or (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'training_load' and p.proname = 'metric_calculation_state_guard') is distinct from '1954b245cfd2c147540c3daf3bb95a92' then
    raise exception 'v78 rollback refused: a body in force is not the one v78 wrote';
  end if;
end $$;

drop trigger metric_definitions_calculation_state_guard on training_load.metric_definitions;
drop function training_load.metric_calculation_state_guard();

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

do $$
begin
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'metric_calculation_version_guard') is distinct from 'a4d8225e2c3b70e618c58c18eb712dcc' then
    raise exception 'v78 rollback failed: the restored body is not v77''s';
  end if;
end $$;

delete from public.schema_migrations where migration_name = 'migrations_v2/202611181100_training_load_v78_calculated_variables_additive.sql';

commit;
