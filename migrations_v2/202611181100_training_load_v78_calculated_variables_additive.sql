-- v78: calculated variables add up only amounts (the owner's rule of 2026-11-18; the Rukovodilac's decision A of the same
-- day: v78 inside calculated variables PR 2a, one ★★ round).
--
-- What it changes:
--   * training_load.metric_calculation_version_guard (v77), CREATE OR REPLACE, three additions and nothing else:
--       - a calculated version's day rule (daily_aggregation_method) is 'sum';
--       - every input's current version is combined by 'sum' (Average, Highest, Latest and Keep each value are not amounts);
--       - an input of a calculated variable's current version keeps 'sum' in a new version, as it keeps its unit (v77).
--   * a new BEFORE UPDATE OF state guard on training_load.metric_definitions (training_load.metric_calculation_state_guard):
--       - an input of an ACTIVE calculated variable's current version is not archived;
--       - a calculated variable is restored only while every input of its current version is active.
--     An archive (the row's FOR NO KEY UPDATE) waits for a calculation being created over the same variable (the version
--     guard's FOR SHARE of its inputs) and for a restore of a calculated variable over it (this guard's FOR SHARE of the
--     inputs, in id order), and the reverse; the second is refused, since a PL/pgSQL statement reads what the other committed
--     (READ COMMITTED, a fresh snapshot per statement).
--   No table, column, index or row. The API refuses the same four cases first, with sentences naming the variable
--   (backend/src/canonicalVariableAdminService.js); these are the backstop for any other writer.
--
-- Before anything changes it checks that the body in force is v77's (md5 of pg_proc.prosrc) and that no stored row already
-- breaks a rule (the preflight counts them; expected 0); after, that the bodies are the new ones.
-- Runbook: docs/runbooks/calculated-variables-v78.md; rollback: docs/runbooks/calculated-variables-v78-rollback.sql.

set local lock_timeout = '5s';

do $$
begin
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'metric_calculation_version_guard') is distinct from 'a4d8225e2c3b70e618c58c18eb712dcc' then
    raise exception 'v78 refused: the body in force of training_load.metric_calculation_version_guard is not v77''s' using errcode = '23514';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'training_load' and p.proname = 'metric_calculation_state_guard') then
    raise exception 'v78 refused: training_load.metric_calculation_state_guard exists already' using errcode = '23514';
  end if;
  -- No stored row breaks the new rules (a calculated version not summed by day, an input of a calculated variable's current
  -- version not summed by day, an active calculated variable over an input that is not active).
  if exists (select 1 from training_load.metric_definition_versions where calculation is not null and daily_aggregation_method <> 'sum') then
    raise exception 'v78 refused: a calculated version is not summed by day' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.metric_definitions cd
               join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
               join training_load.metric_definitions i on i.id = any (training_load.metric_calculation_inputs(cv.calculation))
               join training_load.metric_definition_versions iv on iv.id = i.current_version_id and iv.metric_definition_id = i.id
              where cv.calculation is not null and iv.daily_aggregation_method <> 'sum') then
    raise exception 'v78 refused: an input of a calculated variable is not summed by day' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.metric_definitions cd
               join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
               join training_load.metric_definitions i on i.id = any (training_load.metric_calculation_inputs(cv.calculation))
              where cd.state = 'active' and cv.calculation is not null and i.state <> 'active') then
    raise exception 'v78 refused: an active calculated variable adds up an input that is not active' using errcode = '23514';
  end if;
end;
$$;

-- 1. The version guard (v77's body with the three day-rule additions).
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

-- 2. The state guard.
create function training_load.metric_calculation_state_guard() returns trigger as $$
declare
  v_used text;
begin
  -- An active calculated variable keeps its inputs active: an input it adds up is not archived ...
  if old.state = 'active' and new.state is distinct from 'active' then
    select cd.id::text into v_used
      from training_load.metric_definitions cd
      join training_load.metric_definition_versions cv on cv.id = cd.current_version_id and cv.metric_definition_id = cd.id
     where cd.state = 'active' and cv.calculation is not null
       and old.id = any (training_load.metric_calculation_inputs(cv.calculation))
     limit 1;
    if v_used is not null then
      raise exception 'metric_definitions: an active calculated variable adds up this variable; it stays active' using errcode = '23514';
    end if;
  end if;
  -- ... and a calculated variable becomes active again only while every input is active.
  if old.state is distinct from 'active' and new.state = 'active' then
    -- The inputs FOR SHARE in id order first (the version guard's order): an archive of one of them and this restore wait
    -- for each other, and the second is refused (the reviews of 2026-11-18: without the lock both could pass).
    perform 1 from training_load.metric_definitions i
     where i.id = any (training_load.metric_calculation_inputs((select cv.calculation from training_load.metric_definition_versions cv
                                                                 where cv.id = new.current_version_id)))
     order by i.id for share;
    if exists (select 1 from training_load.metric_definition_versions cv
                 join training_load.metric_definitions i on i.id = any (training_load.metric_calculation_inputs(cv.calculation))
                where cv.id = new.current_version_id and cv.calculation is not null and i.state is distinct from 'active') then
      raise exception 'metric_definitions: a calculated variable is active only while every input is active' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
comment on function training_load.metric_calculation_state_guard() is
  'v78: an input of an active calculated variable is not archived; a calculated variable is active only while its inputs are.';

create trigger metric_definitions_calculation_state_guard
  before update of state on training_load.metric_definitions
  for each row execute function training_load.metric_calculation_state_guard();

do $$
begin
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'metric_calculation_version_guard') is distinct from 'eae4cc9d519a498ca7f4acf0bedbdcbd'
     or (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'training_load' and p.proname = 'metric_calculation_state_guard') is distinct from '51fc201fb536a64e5803f413b9fbffdf' then
    raise exception 'v78 failed: a body is not the one v78 writes' using errcode = '23514';
  end if;
end;
$$;
