-- v80: a column without parameters fills a variable with a condition only when the team's GPEXE setting matches
-- (docs/ai/v80-condition-match-plan.md, step B; the Rukovodilac's GO of 2026-11-19).
--
-- Today a mapping version of a field without parameters (parameter_kind 'none') never fills a variable whose version has
-- a condition: the service refuses it (condition_mismatch, PR #37), the database does not (v34's
-- source_metric_check_parameters returns early for 'none'). v80:
--   * a mapping version may name a CONDITION RULE (condition_rule): which team setting of GPEXE gives the column its
--     range (a numbered power or speed zone; the acceleration or deceleration event setting). A version without
--     parameters on a conditioned variable must carry one, and only such a version may (the database's own refusal);
--     it is written once;
--   * an activation (T5) of such a version records what it was matched against, once: the variable's own condition
--     (matched_condition, the target version's condition_description as stored), the column's range in GPEXE's units
--     (matched_source_range), the team threshold set's id and the time; an activation of any other version records none;
--   * a GPEXE details event column (details.players.acceleration_events / deceleration_events) is matched only after the
--     owner confirmed the team's setting GPEXE shows for it: source_metric_event_setting_confirmations, append-only,
--     written by its acting platform administrator (the v35 actor).
-- The arithmetic of a match (zone limits, unit conversion, exact decimals) is the service's; the database checks the
-- shapes, the pairing and that matched_condition is the variable's condition. The importer blocks a session whose team
-- setting differs from matched_source_range (team_setting_changed).
--
-- Columns and triggers only: no function body of an earlier migration is replaced, no existing row is changed. Every new
-- column is null on every existing row, which is today's behaviour. v80 refuses to apply if a version without parameters
-- already targets a conditioned variable version (the service never wrote one; expected 0).
--
-- Locks: ALTER TABLE ... ADD COLUMN (nullable, no default) takes ACCESS EXCLUSIVE on source_metric_mapping_versions and
-- source_metric_mapping_activations for a catalog-only change (no table rewrite, no scan), each under lock_timeout 5 s,
-- in that order (the writers' own order, version before activation). The new triggers read the variable version
-- (metric_definition_versions) and the mapping version FOR SHARE-free (plain reads of immutable rows).

set local lock_timeout = '5s';

-- Both tables first, in the writers' order (versions before activations), so nothing is written between the check below and
-- the columns.
lock table training_load.source_metric_mapping_versions, training_load.source_metric_mapping_activations in access exclusive mode;

do $$
begin
  if exists (
    select 1
      from training_load.source_metric_mapping_versions mv
      join training_load.metric_definition_versions dv on dv.id = mv.metric_definition_version_id
     where mv.parameter_kind = 'none' and dv.condition_description is not null) then
    raise exception 'v80 refused: a mapping version without parameters already targets a variable version with a condition' using errcode = '23514';
  end if;
end $$;

alter table training_load.source_metric_mapping_versions
  add column condition_rule jsonb;
alter table training_load.source_metric_mapping_activations
  add column matched_condition jsonb,
  add column matched_source_range jsonb,
  add column matched_threshold_set_id text,
  add column matched_at timestamptz;

comment on column training_load.source_metric_mapping_versions.condition_rule is
  'v80: which team setting of GPEXE gives a column without parameters its range, on a variable with a condition: {"kind":"zone","family":"power"|"speed","zone":N} or {"kind":"event","event":"acceleration"|"deceleration"}. Written once.';
comment on column training_load.source_metric_mapping_activations.matched_condition is
  'v80: the variable''s condition this activation was matched against (the target version''s condition_description). Written once.';
comment on column training_load.source_metric_mapping_activations.matched_source_range is
  'v80: the column''s range in GPEXE''s own units at the match; every session imported through this activation must carry the same. Written once.';

-- The shape of a rule (closed).
create function training_load.condition_rule_shape_ok(p jsonb) returns boolean
  language sql immutable as $$
    select case
      when p is null or jsonb_typeof(p) <> 'object' then false
      when p ->> 'kind' = 'zone' then
        (select array_agg(k order by k collate "C") from jsonb_object_keys(p) k) = array['family', 'kind', 'zone']
        and p ->> 'family' in ('power', 'speed')
        and jsonb_typeof(p -> 'zone') = 'number' and (p ->> 'zone') ~ '^[1-9][0-9]?$'
      when p ->> 'kind' = 'event' then
        (select array_agg(k order by k collate "C") from jsonb_object_keys(p) k) = array['event', 'kind']
        and p ->> 'event' in ('acceleration', 'deceleration')
      else false
    end
  $$;

-- A rule fits a condition's shape: a zone rule a zone condition (between, or >= for a top zone), an acceleration rule a
-- '>=' event condition, a deceleration rule a '<=' one.
create function training_load.condition_rule_fits(p_rule jsonb, p_cd jsonb) returns boolean
  language sql immutable as $$
    select case
      when p_cd is null or jsonb_typeof(p_cd) <> 'object' then false
      when p_rule ->> 'kind' = 'zone' then (p_cd ->> 'operator') in ('between', '>=') and not (p_cd ? 'duration_seconds')
      when p_rule ->> 'kind' = 'event' then p_cd ? 'duration_seconds'
        and (p_cd ->> 'operator') = case p_rule ->> 'event' when 'acceleration' then '>=' else '<=' end
      else false
    end
  $$;

-- A mapping version: without parameters on a conditioned variable only with a fitting rule; a rule only there; final.
create function training_load.source_metric_mapping_versions_condition_guard() returns trigger as $$
declare
  v_cd jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.condition_rule is distinct from old.condition_rule then
      raise exception 'source_metric_mapping_versions: a version''s condition rule is written once' using errcode = '23514';
    end if;
    return new;
  end if;
  select condition_description into v_cd from training_load.metric_definition_versions where id = new.metric_definition_version_id;
  if new.parameter_kind = 'none' and v_cd is not null then
    if not training_load.condition_rule_shape_ok(new.condition_rule) or not training_load.condition_rule_fits(new.condition_rule, v_cd) then
      raise exception 'source_metric_mapping_versions: a field without parameters fills a variable with a condition only through a fitting condition rule' using errcode = '23514';
    end if;
  elsif new.condition_rule is not null then
    raise exception 'source_metric_mapping_versions: a condition rule is only for a field without parameters on a variable with a condition' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_mapping_versions_condition_guard
  before insert or update on training_load.source_metric_mapping_versions
  for each row execute function training_load.source_metric_mapping_versions_condition_guard();

-- An activation: of a version with a rule, the match recorded in full (the variable's own condition); of any other, none;
-- final.
create function training_load.source_metric_mapping_activations_match_guard() returns trigger as $$
declare
  v_rule jsonb;
  v_cd jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.matched_condition is distinct from old.matched_condition or new.matched_source_range is distinct from old.matched_source_range
       or new.matched_threshold_set_id is distinct from old.matched_threshold_set_id or new.matched_at is distinct from old.matched_at then
      raise exception 'source_metric_mapping_activations: a match is written once' using errcode = '23514';
    end if;
    return new;
  end if;
  select mv.condition_rule, dv.condition_description into v_rule, v_cd
    from training_load.source_metric_mapping_versions mv
    join training_load.metric_definition_versions dv on dv.id = mv.metric_definition_version_id
   where mv.id = new.mapping_version_id;
  if v_rule is not null then
    if new.matched_condition is null or new.matched_condition is distinct from v_cd
       or new.matched_source_range is null or jsonb_typeof(new.matched_source_range) <> 'object'
       or new.matched_threshold_set_id is null or btrim(new.matched_threshold_set_id) = '' or char_length(new.matched_threshold_set_id) > 64
       or new.matched_at is null then
      raise exception 'source_metric_mapping_activations: an activation of a version with a condition rule records its match' using errcode = '23514';
    end if;
  elsif new.matched_condition is not null or new.matched_source_range is not null or new.matched_threshold_set_id is not null or new.matched_at is not null then
    raise exception 'source_metric_mapping_activations: only an activation of a version with a condition rule records a match' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_mapping_activations_match_guard
  before insert or update on training_load.source_metric_mapping_activations
  for each row execute function training_load.source_metric_mapping_activations_match_guard();

-- The owner's confirmation of the team's event setting GPEXE shows for a details event column.
create table training_load.source_metric_event_setting_confirmations (
  id uuid primary key default gen_random_uuid(),
  source_metric_definition_id uuid not null references training_load.source_metric_definitions(id) on delete restrict,
  source_metric_version_id uuid not null references training_load.source_metric_definition_versions(id) on delete restrict,
  event_kind text not null check (event_kind in ('acceleration', 'deceleration')),
  threshold_value numeric not null,
  duration_seconds numeric not null check (duration_seconds >= 0),
  observation_confirmation_id uuid not null references training_load.source_metric_confirmations(id) on delete restrict,
  threshold_set_id text not null check (btrim(threshold_set_id) <> '' and char_length(threshold_set_id) <= 64),
  confirmed_by_user_id uuid not null references public.users(id) on delete restrict,
  confirmed_at timestamptz not null default now(),
  request_key uuid not null unique,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$')
);
create index source_metric_event_setting_confirmations_version_idx
  on training_load.source_metric_event_setting_confirmations (source_metric_version_id, event_kind);

-- Written only by its acting user (the v35 setting of this transaction), an active platform administrator; the revision
-- is the field's own.
create function training_load.source_metric_event_setting_confirmations_guard() returns trigger as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'source_metric_event_setting_confirmations: a confirmation is never changed or removed' using errcode = '23514';
  end if;
  if training_load.source_metric_context_actor() is distinct from new.confirmed_by_user_id then
    raise exception 'source_metric_event_setting_confirmations: written by its acting user only' using errcode = '42501';
  end if;
  if training_load.source_metric_actor_basis(new.confirmed_by_user_id, null) is distinct from 'platform_admin' then
    raise exception 'source_metric_event_setting_confirmations: only an active platform administrator confirms' using errcode = '42501';
  end if;
  if not exists (select 1 from training_load.source_metric_definition_versions r
                  where r.id = new.source_metric_version_id and r.source_metric_definition_id = new.source_metric_definition_id) then
    raise exception 'source_metric_event_setting_confirmations: the revision is not the field''s' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_event_setting_confirmations_guard
  before insert or update or delete on training_load.source_metric_event_setting_confirmations
  for each row execute function training_load.source_metric_event_setting_confirmations_guard();
create trigger source_metric_event_setting_confirmations_no_truncate
  before truncate on training_load.source_metric_event_setting_confirmations
  for each statement execute function training_load.source_metric_event_setting_confirmations_guard();
