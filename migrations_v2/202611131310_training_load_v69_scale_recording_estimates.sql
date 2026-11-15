-- Training Load v69 - the scaled estimate (MT-D, scaling a short recording; part 2 of 2: method scale_recording).
--
-- Plan: docs/ai/mt-multiple-tracks-plan.md sections 10 and 13, decided by the Rukovodilac on 2026-11-13. Runbook:
-- docs/runbooks/scale-recording-v68-v69.md. Part 1, v68, holds the scale on the track choice.
--
-- What this migration changes (no existing row changes; nothing is written to a table):
--   1. training_load.metric_value_estimates.method also takes 'scale_recording'. The provenance guard
--      (validate_metric_value_estimate, v63, replaced by v64) already allows a method outside copy_athlete / team_average for
--      a 'sum' variable only, so a scaled estimate of an avg, max, last or none variable is refused without a body change.
--   2. training_load.estimate_basis_ok gains the 'scale_recording' branch: exactly measured, recordedMinutes and
--      targetMinutes, numbers, 0 < recordedMinutes < targetMinutes <= 600, measured >= 0. Every existing branch is
--      unchanged, so every existing row stays valid.
--
-- Order: after v68. Refuses to run without v63's table and method CHECK, or with another body of estimate_basis_ok in force.
-- Rollback: docs/runbooks/scale-recording-v69-rollback.sql (refuses once a scaled estimate exists, or a later migration is
-- recorded).

do $$
begin
  if to_regclass('training_load.metric_value_estimates') is null then
    raise exception 'v69 refused: v63 (the estimates) is not applied' using errcode = '23514';
  end if;
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'estimate_basis_ok') is distinct from '3e33a4053bbfa06cf21a15ce23903029' then
    raise exception 'v69 refused: the body in force of training_load.estimate_basis_ok is not v63''s' using errcode = '23514';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'training_load.metric_value_estimates'::regclass
                  and conname = 'metric_value_estimates_method_check') then
    raise exception 'v69 refused: the method CHECK of metric_value_estimates is not v63''s' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The method
-- ---------------------------------------------------------------------------
alter table training_load.metric_value_estimates drop constraint metric_value_estimates_method_check;
alter table training_load.metric_value_estimates add constraint metric_value_estimates_method_check
  check (method in ('proportional', 'copy_athlete', 'team_average', 'scale_recording'));

-- ---------------------------------------------------------------------------
-- 2. Its basis (v63's branches verbatim, one branch added)
-- ---------------------------------------------------------------------------
create or replace function training_load.estimate_basis_ok(p_method text, p_basis jsonb) returns boolean as $$
  select case p_method
    when 'proportional' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['minutes', 'ratePerMinute', 'sessions']
      and jsonb_typeof(p_basis -> 'minutes') = 'number' and (p_basis ->> 'minutes')::numeric > 0 and (p_basis ->> 'minutes')::numeric <= 1440
      and jsonb_typeof(p_basis -> 'ratePerMinute') = 'number' and (p_basis ->> 'ratePerMinute')::numeric >= 0
      and jsonb_typeof(p_basis -> 'sessions') = 'number' and (p_basis ->> 'sessions') ~ '^[0-9]{1,3}$' and (p_basis ->> 'sessions')::int between 3 and 5
    when 'copy_athlete' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['sourceAthleteId']
      and jsonb_typeof(p_basis -> 'sourceAthleteId') = 'string'
      and (p_basis ->> 'sourceAthleteId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    when 'team_average' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['athletes']
      and jsonb_typeof(p_basis -> 'athletes') = 'number' and (p_basis ->> 'athletes') ~ '^[0-9]{1,4}$' and (p_basis ->> 'athletes')::int >= 3
    when 'scale_recording' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['measured', 'recordedMinutes', 'targetMinutes']
      and jsonb_typeof(p_basis -> 'measured') = 'number' and (p_basis ->> 'measured')::numeric >= 0
      and jsonb_typeof(p_basis -> 'recordedMinutes') = 'number' and jsonb_typeof(p_basis -> 'targetMinutes') = 'number'
      and (p_basis ->> 'recordedMinutes')::numeric > 0
      and (p_basis ->> 'recordedMinutes')::numeric < (p_basis ->> 'targetMinutes')::numeric
      and (p_basis ->> 'targetMinutes')::numeric <= 600
    else false
  end;
$$ language sql immutable;
