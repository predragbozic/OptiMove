-- v87: manual values on the roster - an entry for an athlete without a device record, a correction of a measured value,
-- the restore of the measured values - and the undo of a session that holds them (ST-4, docs/ai/session-type-plan.md
-- sections 7, 8 and 13 Q3; the owner's decisions of 2026-11-20).
--
-- A manual value is a 'manual' occasion (v13), never a value the source delivered: an entry is an occasion of its own, a
-- correction is a 'manual' occasion of the same source identity that supersedes the measured one (kept, never deleted). Its
-- provenance - who, when, on which right, which request - is one row of training_load.metric_manual_values, written by
-- backend/src/manualValueService.js in the same transaction (the only writer).
--
-- What this migration changes (no existing row changes):
--   1. training_load.metric_manual_values: one provenance row per manual occasion written from the roster. Kind 'entry'
--      (no source identity), 'correction' or 'restore' (the source identity's current occasion, superseding the previous
--      one; the measured occasion it rests on is named). Append-only; a DELETE only inside the session undo's own
--      transaction (v57's marker).
--   2. Guards (fixed messages, 23514 / 42501): the row's author is the transaction's acting user
--      (optimove.manual_value_actor = '<user uuid>:<xact id>', set by the service) and the occasion's author; the occasion
--      is a whole-session 'manual' occasion with no import batch and no conflict status; an entry has no source identity;
--      a correction or a restore is its identity's current occasion, supersedes the previous one, and rests on an
--      api_import / csv_import occasion of the same identity; a restore holds exactly the measured occasion's values.
--      A 'manual' occasion inserted while the acting user is set has its provenance row by COMMIT (deferred).
--   3. training.activity_roster_needs_state: an athlete whose values were entered or corrected on the roster has a state
--      (like a measured athlete). A manual value from another path (the Metrics screen) is unchanged: still no state.
--   4. The session undo: session_undo_scope lists the session's manual values (count, the current ones, a fingerprint);
--      undo_imported_session refuses them unless the call confirms exactly that list (p_manual_values_fingerprint, the
--      v60 pattern), removes their provenance rows with them, and records them in import_deletion_log.manual_values_removed
--      (new nullable column, closed shape, confirmed by the deleting user). The function gains one trailing parameter with a
--      default and one result column, so it is dropped and created again; a call with the old seven arguments is unchanged.
--   5. training_load.gpexe_import_approvals gains replaced_manual_athlete_ids and chosen_activity_type_key (the coach's
--      choices of the later re-import question and of ST-2), and v59's subset-hash pair rule covers them. Empty until
--      those pull requests write them.
--
-- Bodies are replaced after an md5 check of the bodies in force (v76's undo, v63's scope, v26's needs-state). New lines sit
-- between "-- v87 begin" and "-- v87 end".
-- Locks: the deletion log and the approvals ACCESS EXCLUSIVE (their new columns and CHECKs), lock_timeout 5 s, before the
-- first change.
-- Rollback: docs/runbooks/manual-values-v87.md (refuses once a provenance row or a logged manual removal exists).

set local lock_timeout = '5s';
lock table training_load.import_deletion_log in access exclusive mode;
lock table training_load.gpexe_import_approvals in access exclusive mode;

-- ---------------------------------------------------------------------------
-- 0. Preconditions: written on the bodies in force; refuse any other.
-- ---------------------------------------------------------------------------
do $$
declare
  expected constant text[][] := array[
    ['training_load', 'undo_imported_session', '67559dabda476298a10f100d13dc74e1', 'v76'],
    ['training_load', 'session_undo_scope', '4d33a3379faaf918243b8db11de12c81', 'v63'],
    ['training', 'activity_roster_needs_state', '8016e580c27a56ed97c6711cdf401cd6', 'v26']];
  i integer;
begin
  if to_regclass('training.activity_type_changes') is null then
    raise exception 'v87 refused: v85 (session types) is not applied' using errcode = '23514';
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2]) <> 1 then
      raise exception 'v87 refused: %.% must exist exactly once', expected[i][1], expected[i][2] using errcode = '23514';
    end if;
    if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2]) is distinct from expected[i][3] then
      raise exception 'v87 refused: the body in force of %.% is not %''s', expected[i][1], expected[i][2], expected[i][4] using errcode = '23514';
    end if;
  end loop;
  if exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'import_deletion_log'
              and column_name = 'manual_values_removed') then
    raise exception 'v87 refused: import_deletion_log.manual_values_removed already exists' using errcode = '23514';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'training_load.gpexe_import_approvals'::regclass
       and conname = 'gpexe_import_approvals_subset_hash_pair') is distinct from 'CHECK (((cardinality(excluded_athlete_ids) = 0) = (subset_hash IS NULL)))' then
    raise exception 'v87 refused: the subset-hash pair rule in force is not v59''s' using errcode = '23514';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The acting user of a manual value write
-- ---------------------------------------------------------------------------
create function training_load.manual_value_context_actor() returns uuid as $$
declare
  raw text := current_setting('optimove.manual_value_actor', true);
begin
  if raw is null
     or raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,20}$'
     or split_part(raw, ':', 2) is distinct from pg_current_xact_id()::text then
    raise exception 'manual value: no acting user is set for this transaction' using errcode = '42501';
  end if;
  return split_part(raw, ':', 1)::uuid;
end;
$$ language plpgsql;

-- The acting user is set for THIS transaction (without raising): the deferred check of section 2 asks it.
create function training_load.manual_value_actor_is_set() returns boolean as $$
  select coalesce(current_setting('optimove.manual_value_actor', true), '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,20}$'
     and split_part(current_setting('optimove.manual_value_actor', true), ':', 2) = pg_current_xact_id()::text;
$$ language sql volatile;

-- ---------------------------------------------------------------------------
-- 2. The provenance table and its guards
-- ---------------------------------------------------------------------------
create table training_load.metric_manual_values (
  id uuid primary key default gen_random_uuid(),
  occasion_id uuid not null unique references training_load.metric_measurement_occasions(id) on delete restrict,
  kind varchar(12) not null check (kind in ('entry', 'correction', 'restore')),
  -- The occasion this one superseded (a correction's or a restore's previous current occasion; an entry's previous entry).
  replaced_occasion_id uuid references training_load.metric_measurement_occasions(id) on delete restrict,
  -- A correction's or a restore's measured occasion (api_import / csv_import, same identity); null for an entry.
  measured_occasion_id uuid references training_load.metric_measurement_occasions(id) on delete restrict,
  entered_by_user_id uuid not null references public.users(id) on delete restrict,
  entered_by_basis varchar(20) not null check (entered_by_basis in ('team_coach', 'club_admin', 'platform_admin')),
  entered_at timestamptz not null default clock_timestamp(),
  note text check (note is null or (char_length(note) between 1 and 500 and note = btrim(note))),
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint metric_manual_values_request_unique unique (entered_by_user_id, request_key),
  constraint metric_manual_values_kind_shape check (
    (kind = 'entry' and measured_occasion_id is null)
    or (kind in ('correction', 'restore') and measured_occasion_id is not null and replaced_occasion_id is not null))
);
create index metric_manual_values_replaced_idx on training_load.metric_manual_values (replaced_occasion_id) where replaced_occasion_id is not null;
create index metric_manual_values_measured_idx on training_load.metric_manual_values (measured_occasion_id) where measured_occasion_id is not null;
comment on table training_load.metric_manual_values is
  'v87: the provenance of a manual value written on the roster (entry, correction, restore): who, when, on which right, which request. Append-only; removed only by the session undo.';

create function training_load.validate_metric_manual_value() returns trigger as $$
declare
  v_occ record;
  v_measured record;
  v_prev record;
begin
  if new.entered_by_user_id is distinct from training_load.manual_value_context_actor() then
    raise exception 'manual value: the author must be the acting user' using errcode = '42501';
  end if;
  select o.id, o.entry_method, o.segment_id, o.source_identity_id, o.import_batch_id, o.import_conflict_status,
         o.recorded_by_user_id, o.supersedes_occasion_id, o.superseded_by_occasion_id
    into v_occ from training_load.metric_measurement_occasions o where o.id = new.occasion_id;
  if not found or v_occ.entry_method is distinct from 'manual' or v_occ.segment_id is not null
     or v_occ.import_batch_id is not null or v_occ.import_conflict_status is not null or v_occ.superseded_by_occasion_id is not null then
    raise exception 'manual value: the provenance row belongs to a current whole-session manual occasion' using errcode = '23514';
  end if;
  if v_occ.recorded_by_user_id is distinct from new.entered_by_user_id then
    raise exception 'manual value: the author must be the acting user' using errcode = '42501';
  end if;
  if new.replaced_occasion_id is distinct from v_occ.supersedes_occasion_id then
    raise exception 'manual value: the replaced occasion is the one this occasion supersedes' using errcode = '23514';
  end if;
  if new.kind = 'entry' then
    if v_occ.source_identity_id is not null then
      raise exception 'manual value: an entry has no source record' using errcode = '23514';
    end if;
    if new.replaced_occasion_id is not null then
      select o.entry_method, o.source_identity_id into v_prev from training_load.metric_measurement_occasions o where o.id = new.replaced_occasion_id;
      if v_prev.entry_method is distinct from 'manual' or v_prev.source_identity_id is not null
         or not exists (select 1 from training_load.metric_manual_values m where m.occasion_id = new.replaced_occasion_id and m.kind = 'entry') then
        raise exception 'manual value: an entry replaces only an earlier entry' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  -- A correction or a restore: the identity's current occasion, resting on a measured occasion of the same identity.
  if v_occ.source_identity_id is null
     or not exists (select 1 from training_load.metric_source_identities si
                     where si.id = v_occ.source_identity_id and si.current_occasion_id = new.occasion_id) then
    raise exception 'manual value: a correction is its source record''s current occasion' using errcode = '23514';
  end if;
  select o.entry_method, o.source_identity_id, o.segment_id into v_measured
    from training_load.metric_measurement_occasions o where o.id = new.measured_occasion_id;
  if v_measured.entry_method not in ('api_import', 'csv_import') or v_measured.source_identity_id is distinct from v_occ.source_identity_id
     or v_measured.segment_id is not null then
    raise exception 'manual value: a correction rests on a measured occasion of the same record' using errcode = '23514';
  end if;
  if new.kind = 'restore' and (
       exists (select v.metric_definition_id, v.value_numeric, v.value_boolean, v.value_text from training_load.metric_values v
                where v.occasion_id = new.occasion_id and not v.is_derived
               except
               select v.metric_definition_id, v.value_numeric, v.value_boolean, v.value_text from training_load.metric_values v
                where v.occasion_id = new.measured_occasion_id and not v.is_derived)
       or exists (select v.metric_definition_id, v.value_numeric, v.value_boolean, v.value_text from training_load.metric_values v
                   where v.occasion_id = new.measured_occasion_id and not v.is_derived
                  except
                  select v.metric_definition_id, v.value_numeric, v.value_boolean, v.value_text from training_load.metric_values v
                   where v.occasion_id = new.occasion_id and not v.is_derived)) then
    raise exception 'manual value: a restore holds exactly the measured values' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger metric_manual_values_validate
  before insert on training_load.metric_manual_values
  for each row execute function training_load.validate_metric_manual_value();

-- Append-only; a DELETE only inside the session undo's own transaction.
create function training_load.protect_metric_manual_values() returns trigger as $$
begin
  if tg_op = 'DELETE' and training_load.session_undo_marker_ok() then
    return old;
  end if;
  raise exception 'metric_manual_values is append-only' using errcode = '23514';
end;
$$ language plpgsql;
create trigger metric_manual_values_protect
  before update or delete on training_load.metric_manual_values
  for each row execute function training_load.protect_metric_manual_values();
create trigger metric_manual_values_no_truncate
  before truncate on training_load.metric_manual_values
  for each statement execute function training_load.forbid_update_delete();

-- A manual occasion written while the acting user is set has its provenance row by COMMIT (the service never leaves one
-- without it). Other paths (the Metrics screen) never set the acting user and are unchanged.
create function training_load.check_manual_value_has_provenance() returns trigger as $$
begin
  if training_load.manual_value_actor_is_set()
     and not exists (select 1 from training_load.metric_manual_values m where m.occasion_id = new.id) then
    raise exception 'manual value: a manual occasion written on the roster needs its provenance row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;
create constraint trigger metric_measurement_occasions_manual_provenance
  after insert on training_load.metric_measurement_occasions
  deferrable initially deferred
  for each row when (new.entry_method = 'manual') execute function training_load.check_manual_value_has_provenance();

-- ---------------------------------------------------------------------------
-- 3. The roster: an athlete with roster-written manual values has a state
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION training.activity_roster_needs_state(p_canonical_activity_id uuid)
 RETURNS TABLE(athlete_id uuid)
 LANGUAGE sql
 STABLE
AS $function$
  with r as (
    select athlete_id from training.activity_roster(p_canonical_activity_id)
  ),
  d as (
    select d.athlete_id, d.decision_kind, coalesce(d.reason_key, '') as reason_key
      from training.activity_athlete_decisions d
     where d.activity_id in (select activity_id from training.activity_alias_ids(p_canonical_activity_id))
       and d.superseded_by_decision_id is null
  ),
  m as (
    select distinct x.athlete_id
      from training.canonical_activity_results(p_canonical_activity_id) x
     where x.fact_kind = 'metric_value'
       and (x.detail ->> 'entryMethod' in ('api_import', 'csv_import')
            -- v87 begin: a value entered or corrected on the roster (its provenance row) gives the athlete a state too.
            or (x.detail ->> 'entryMethod' = 'manual'
                and exists (select 1 from training_load.metric_manual_values mv where mv.occasion_id = (x.detail ->> 'occasionId')::uuid)))
            -- v87 end
  )
  select r.athlete_id
    from r
   where ((select count(*) from d where d.athlete_id = r.athlete_id) > 1
          and (select count(distinct (d.decision_kind, d.reason_key)) from d where d.athlete_id = r.athlete_id) > 1)
      or (not exists (select 1 from d where d.athlete_id = r.athlete_id and d.decision_kind <> 'cleared')
          and not exists (select 1 from m where m.athlete_id = r.athlete_id));
$function$;

-- ---------------------------------------------------------------------------
-- 4. The deletion log records the manual values an undo removed
-- ---------------------------------------------------------------------------
-- The closed shape: {count, list, fingerprint, confirmed_by}; the list holds at most 60 current manual values.
create function training_load.session_undo_manual_log_ok(p jsonb, p_deleted_by uuid) returns boolean as $$
declare
  v_item jsonb;
begin
  if p is null then
    return true;
  end if;
  if jsonb_typeof(p) <> 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(p) k) is distinct from array['confirmed_by', 'count', 'fingerprint', 'list']
     or jsonb_typeof(p -> 'count') <> 'number' or p ->> 'count' !~ '^[1-9][0-9]{0,8}$'
     or jsonb_typeof(p -> 'fingerprint') <> 'string' or p ->> 'fingerprint' !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p -> 'confirmed_by') <> 'string' or p ->> 'confirmed_by' is distinct from p_deleted_by::text
     or jsonb_typeof(p -> 'list') <> 'array' or jsonb_array_length(p -> 'list') > 60 then
    return false;
  end if;
  for v_item in select value from jsonb_array_elements(p -> 'list') loop
    if jsonb_typeof(v_item) <> 'object'
       or (select array_agg(k order by k) from jsonb_object_keys(v_item) k) is distinct from array['at', 'athlete', 'by', 'kind', 'values']
       or jsonb_typeof(v_item -> 'athlete') <> 'string'
       or v_item ->> 'athlete' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_item -> 'kind') <> 'string' or (v_item ->> 'kind') not in ('entry', 'correction', 'restore', 'other')
       or not (jsonb_typeof(v_item -> 'by') = 'null'
               or (jsonb_typeof(v_item -> 'by') = 'string' and v_item ->> 'by' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
       or jsonb_typeof(v_item -> 'at') <> 'string'
       or v_item ->> 'at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?([+-][0-9]{2}(:[0-9]{2})?|Z)$'
       or jsonb_typeof(v_item -> 'values') <> 'number' or v_item ->> 'values' !~ '^(0|[1-9][0-9]{0,4})$' then
      return false;
    end if;
  end loop;
  return true;
end;
$$ language plpgsql immutable;

alter table training_load.import_deletion_log add column manual_values_removed jsonb;
alter table training_load.import_deletion_log
  add constraint import_deletion_log_manual_values_removed_shape
  check (training_load.session_undo_manual_log_ok(manual_values_removed, deleted_by_user_id));
comment on column training_load.import_deletion_log.manual_values_removed is
  'v87: the manual values the undo removed after the user confirmed them: {count, list (at most 60 current ones), fingerprint, confirmed_by}; null when there were none.';

-- ---------------------------------------------------------------------------
-- 5. The session undo: the scope lists the manual values
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION training_load.session_undo_scope(p_event uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  v_est_occ integer;
  v_est_val integer;
  v_event record;
  v_part uuid[];
  v_occ uuid[];
  v_seg uuid[];
  v_ident uuid[];
  v_batch uuid[];
  v_act uuid[];
  v_obs uuid[];
  v_reached uuid[];
  v_alias uuid[];
  v_binding record;
  v_values integer := 0;
  v_manual integer := 0;
  v_shared integer := 0;
  v_other_links integer := 0;
  v_entangled integer := 0;
  v_calendar integer := 0;
  v_write_requests integer := 0;
  v_work jsonb;
  v_manual_list jsonb; -- v87
  v_manual_fp text; -- v87
begin
  select e.id, e.source_connection_id, e.source_external_id, e.owner_team_id, e.occurred_date, c.source_system
    into v_event
    from training_load.metric_events e
    left join training_load.metric_source_connections c on c.id = e.source_connection_id
   where e.id = p_event;
  if not found then
    perform training_load.session_undo_refuse('event_missing');
  end if;
  v_part := coalesce(array(select id from training_load.metric_event_participants where event_id = p_event order by id), '{}');
  v_occ := coalesce(array(select id from training_load.metric_measurement_occasions where event_participant_id = any(v_part) order by id), '{}');
  select count(*)::int into v_manual from training_load.metric_measurement_occasions where id = any(v_occ) and entry_method = 'manual';
  -- v87 begin: every manual occasion (history included) is in the fingerprint; the current ones are listed (at most 60).
  if v_manual > 0 then
    select encode(sha256(convert_to(string_agg(o.id::text, ',' order by o.id), 'UTF8')), 'hex') into v_manual_fp
      from training_load.metric_measurement_occasions o where o.id = any(v_occ) and o.entry_method = 'manual';
    select coalesce(jsonb_agg(item order by at, k), '[]'::jsonb) into v_manual_list from (
      select jsonb_build_object('athlete', p.athlete_id, 'kind', coalesce(m.kind, 'other'), 'by', o.recorded_by_user_id,
                                'at', o.created_at,
                                'values', (select count(*) from training_load.metric_values v where v.occasion_id = o.id and not v.is_derived)) as item,
             o.created_at as at, o.id::text as k
        from training_load.metric_measurement_occasions o
        join training_load.metric_event_participants p on p.id = o.event_participant_id
        left join training_load.metric_manual_values m on m.occasion_id = o.id
       where o.id = any(v_occ) and o.entry_method = 'manual' and o.superseded_by_occasion_id is null and o.import_conflict_status is null
         and (o.source_identity_id is null or exists (select 1 from training_load.metric_source_identities si
                                                       where si.id = o.source_identity_id and si.current_occasion_id = o.id))
       order by o.created_at, o.id limit 60) items;
  end if;
  -- v87 end
  -- v63: estimates are listed and removed with the session; they never block (contract rule 8).
  select count(*)::int into v_est_occ from training_load.metric_measurement_occasions where id = any(v_occ) and entry_method = 'estimate';
  select count(*)::int into v_est_val from training_load.metric_value_estimates where occasion_id = any(v_occ);
  select count(*)::int into v_values from training_load.metric_values where occasion_id = any(v_occ);
  v_seg := coalesce(array(select id from training_load.metric_event_segments where event_id = p_event order by id), '{}');
  select b.event_id, b.reference_set_external_id into v_binding from training_load.metric_event_source_bindings b where b.event_id = p_event;
  v_batch := coalesce(array(select distinct import_batch_id from training_load.metric_measurement_occasions where id = any(v_occ) and import_batch_id is not null order by 1), '{}');
  -- The occasions' identities and the session's own reservation identity (found through the EVENT's connection and
  -- external id, not the binding's: a binding may be absent).
  v_ident := coalesce(array(
    select id from (
      select source_identity_id as id from training_load.metric_measurement_occasions where id = any(v_occ) and source_identity_id is not null
      union
      select si.id from training_load.metric_source_identities si
       where v_event.source_connection_id is not null and v_event.source_external_id is not null
         and si.source_connection_id = v_event.source_connection_id and si.source_external_id = v_event.source_external_id
    ) x order by id), '{}');
  -- The activities this session reaches: through its participants OR a direct event link.
  v_reached := coalesce(array(
    select activity_id from (
      select ap.activity_id
        from training.activity_participants ap
        join training.activity_participant_metric_participant_links pl on pl.activity_participant_id = ap.id
       where pl.metric_event_participant_id = any(v_part)
      union
      select activity_id from training.activity_metric_event_links where metric_event_id = p_event
    ) r order by activity_id), '{}');
  v_act := coalesce(array(
    select distinct ap.activity_id
      from training.activity_participants ap
      join training.activity_participant_metric_participant_links l on l.activity_participant_id = ap.id
     where l.metric_event_participant_id = any(v_part)
     order by 1), '{}');
  select count(*)::int into v_shared
    from training.activity_participants ap2
    join training.activity_participant_metric_participant_links l2 on l2.activity_participant_id = ap2.id
    join training_load.metric_event_participants p2 on p2.id = l2.metric_event_participant_id
   where ap2.activity_id = any(v_act) and p2.event_id <> p_event;
  select count(*)::int into v_other_links
    from training.activity_metric_event_links l
   where l.activity_id = any(v_reached) and l.metric_event_id <> p_event;
  select count(*)::int into v_entangled
    from training.activities a
   where a.id = any(v_reached)
     and (a.lifecycle_state = 'superseded' or a.superseded_by_activity_id is not null
          or exists (select 1 from training.activity_participant_merge_log m where m.source_activity_id = a.id or m.target_activity_id = a.id)
          or exists (select 1 from training.activity_participant_reparent_log r where r.from_activity_id = a.id or r.to_activity_id = a.id));
  -- The whole alias set of every reached activity (v25 rosters).
  v_alias := coalesce(array(
    select aa.activity_id
      from (select distinct training.resolve_canonical_activity_id(r) as canonical_id from unnest(v_reached) r) c
      cross join lateral training.activity_alias_ids(c.canonical_id) aa
     order by 1), '{}');
  -- v60: the roster work, split into what the import wrote and what came later.
  v_work := training_load.session_undo_roster_work(v_alias);
  v_obs := coalesce(array(select id from training.activity_source_observations where activity_id = any(v_alias) order by id), '{}');
  select count(*)::int into v_calendar from calendar.event_activity_links where activity_id = any(v_reached) or activity_id = any(v_alias);
  select count(*)::int into v_write_requests from training_load.metric_write_requests
   where result_event_id = p_event or result_occasion_id = any(v_occ);
  return jsonb_build_object(
    'eventId', p_event,
    'connectionId', v_event.source_connection_id,
    'ownerTeamId', v_event.owner_team_id,
    'occurredDate', v_event.occurred_date,
    'sourceSystem', v_event.source_system,
    'externalId', v_event.source_external_id,
    'participantIds', to_jsonb(v_part),
    'occasionIds', to_jsonb(v_occ),
    'valueCount', v_values,
    'segmentIds', to_jsonb(v_seg),
    'identityIds', to_jsonb(v_ident),
    'hasBinding', v_binding.event_id is not null,
    'referenceSetExternalId', v_binding.reference_set_external_id,
    'activityIds', to_jsonb(v_act),
    'batchIds', to_jsonb(v_batch),
    'observationIds', to_jsonb(v_obs),
    'manualOccasionCount', v_manual,
    -- v87: the manual values, for the confirmation (null when there are none).
    'manualValues', case when v_manual > 0 then jsonb_build_object('count', v_manual, 'list', v_manual_list, 'fingerprint', v_manual_fp) end,
    'estimateOccasionCount', v_est_occ,
    'estimateValueCount', v_est_val,
    'sharedActivityCount', v_shared,
    'otherEventLinkCount', v_other_links,
    'entangledActivityCount', v_entangled,
    'calendarLinkCount', v_calendar,
    'manualWriteRequestCount', v_write_requests,
    'aliasActivityIds', to_jsonb(v_alias),
    'rosterWork', v_work);
end;
-- Volatile on purpose: every statement of the body takes its own snapshot, so the second look (after the activities are
-- locked) sees a link committed while the lock was waited for.
$function$;

-- ---------------------------------------------------------------------------
-- 6. The session undo: manual values removed only with a confirmation of exactly the listed ones
-- ---------------------------------------------------------------------------
drop function training_load.undo_imported_session(uuid, uuid, uuid, uuid, text, uuid, text);
CREATE FUNCTION training_load.undo_imported_session(p_actor uuid, p_team uuid, p_candidate uuid, p_request_key uuid, p_reason text, p_expected_event uuid DEFAULT NULL::uuid, p_later_roster_fingerprint text DEFAULT NULL::text, p_manual_values_fingerprint text DEFAULT NULL::text)
 RETURNS TABLE(replayed boolean, event_id uuid, deletion_log_id uuid, removed_counts jsonb, removed_total integer, new_candidate_id uuid, undone_candidate_ids uuid[], roster_work_removed jsonb, manual_values_removed jsonb)
 LANGUAGE plpgsql
AS $function$
declare
  v_basis text; -- v76: the right this undo is made on
  v_reason text := btrim(coalesce(p_reason, ''));
  v_hash text;
  v_req record;
  v_cand record;
  v_offer record;
  v_ids uuid[];
  v_event_id uuid;
  v_event record;
  v_scope jsonb;
  v_act uuid[];
  v_part uuid[];
  v_occ uuid[];
  v_seg uuid[];
  v_ident uuid[];
  v_batch uuid[];
  v_obs uuid[];
  v_work jsonb;
  v_removed jsonb := '{}'::jsonb;
  v_total integer;
  v_n integer;
  v_log uuid;
  v_req_id uuid := gen_random_uuid();
  v_new uuid;
  v_last_status text;
  v_constraint text;
  v_status text;
  v_pass integer := 0;
  v_act_before uuid[];
  v_confirm boolean := p_later_roster_fingerprint is not null;
  v_alias uuid[];
  v_later_total integer;
  v_roster_removed jsonb;
  v_roster_n integer;
  v_manual jsonb; -- v87
  v_manual_removed jsonb; -- v87
begin
  if p_actor is null or p_team is null or p_candidate is null or p_request_key is null then
    raise exception 'undo_imported_session: actor, team, candidate and request key are required' using errcode = '22023';
  end if;
  if length(v_reason) not between 1 and 500 or v_reason ~ '[[:cntrl:]]' then
    perform training_load.session_undo_refuse('invalid_reason');
  end if;
  if v_confirm and p_later_roster_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'undo_imported_session: the later roster work fingerprint is 64 lowercase hex characters' using errcode = '22023';
  end if;
  -- v87 begin
  if p_manual_values_fingerprint is not null and p_manual_values_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'undo_imported_session: the manual values fingerprint is 64 lowercase hex characters' using errcode = '22023';
  end if;
  -- v87 end
  -- v57's hash when nothing is confirmed (a v57 request replays unchanged); a confirmation is part of the request.
  v_hash := encode(sha256(convert_to(p_candidate::text || '|' || v_reason || '|' || coalesce(p_expected_event::text, '')
                                     || case when v_confirm then '|confirm|' || p_later_roster_fingerprint else '' end
                                     -- v87: a confirmation of manual values is part of the request too.
                                     || case when p_manual_values_fingerprint is not null then '|manual|' || p_manual_values_fingerprint else '' end, 'UTF8')), 'hex');

  -- 1. The right: -- v76 begin whoever may approve an import of this team (the owner's decision of 2026-11-17), derived by
  --    lock_gpexe_session_undo_right: the acting user, then the role rows, then the team's switch row, each FOR SHARE (the
  --    revocations' order, and the order of the approval's own lock_gpexe_import_approver). The switch being off is no
  --    refusal here: a wrong import stays deletable. -- v76 end
  v_basis := training_load.lock_gpexe_session_undo_right(p_actor, p_team);

  -- 1b. An unlocked look at the candidate BEFORE the team lock. The approval locks a candidate row and only then waits for
  --     the team lock, the undo the other way round; an undo aimed at a candidate that is not imported (an approval may hold
  --     it) is therefore refused here, before it can wait for that row while holding the team lock. An imported row can be
  --     locked by an approval that refuses it before waiting for the team lock, and by a check's finalization, which then
  --     only TRY-locks the team (never waits), so the later FOR UPDATE cannot close a cycle. An undone row passes on
  --     purpose: its replay is answered below.
  select c.status into v_status from training_load.gpexe_import_candidates c where c.id = p_candidate and c.owner_team_id = p_team;
  if not found then
    perform training_load.session_undo_refuse('candidate_not_found');
  end if;
  if v_status <> 'imported' then
    perform training_load.session_undo_refuse('candidate_not_imported');
  end if;

  -- 2. The team's import lock: the importer's own key, so an import and an undo of the same team wait for each other.
  perform pg_advisory_xact_lock(hashtextextended('gpexe-import-team:' || lower(p_team::text), 21));

  -- 3. A replay answers the saved outcome before any further lock.
  select * into v_req from training_load.gpexe_session_undo_requests q
   where q.requested_by_user_id = p_actor and q.request_key = p_request_key and q.owner_team_id = p_team;
  if found then
    if v_req.request_hash <> v_hash then
      perform training_load.session_undo_refuse('request_key_reused');
    end if;
    return query select true, v_req.event_id, v_req.deletion_log_id, v_req.removed_counts, v_req.removed_total, v_req.new_candidate_id, v_req.undone_candidate_ids,
                        (select l.roster_work_removed from training_load.import_deletion_log l where l.id = v_req.deletion_log_id),
                        (select l.manual_values_removed from training_load.import_deletion_log l where l.id = v_req.deletion_log_id);
    return;
  end if;

  -- 4. The event the requested candidate's approval wrote, and every approved version of the session that wrote into it. A
  --    session changed in GPEXE and approved again (acceptChanges) goes into the SAME event (one event per session, v20), so
  --    removing the event undoes all of them: they are locked by id, and the undo marks every one of them.
  select a.metric_event_id into v_event_id from training_load.gpexe_import_approvals a where a.candidate_id = p_candidate;
  if not found then
    perform training_load.session_undo_refuse('approval_missing');
  end if;
  perform 1 from training_load.gpexe_import_candidates c
   where c.owner_team_id = p_team
     and c.id in (select a.candidate_id from training_load.gpexe_import_approvals a where a.metric_event_id = v_event_id)
   order by c.id for update;
  select * into v_cand from training_load.gpexe_import_candidates c where c.id = p_candidate and c.owner_team_id = p_team;
  if not found then
    perform training_load.session_undo_refuse('candidate_not_found');
  end if;
  if v_cand.status <> 'imported' then
    perform training_load.session_undo_refuse('candidate_not_imported');
  end if;
  if v_cand.import_undone_at is not null then
    perform training_load.session_undo_refuse('already_undone');
  end if;
  v_ids := coalesce(array(
    select c.id from training_load.gpexe_import_candidates c
      join training_load.gpexe_import_approvals a on a.candidate_id = c.id
     where a.metric_event_id = v_event_id and c.owner_team_id = p_team and c.status = 'imported' and c.import_undone_at is null
     order by c.id), '{}');

  -- 5. The event, locked, and the identity of what is about to be removed.
  if p_expected_event is not null and p_expected_event <> v_event_id then
    perform training_load.session_undo_refuse('event_mismatch');
  end if;
  select e.id, e.owner_team_id, e.source_external_id into v_event
    from training_load.metric_events e where e.id = v_event_id for update;
  if not found then
    perform training_load.session_undo_refuse('event_missing');
  end if;
  if v_event.owner_team_id is distinct from p_team then
    perform training_load.session_undo_refuse('event_team_mismatch');
  end if;
  if v_event.source_external_id is distinct from 'team_session:' || v_cand.gpexe_team_session_id then
    perform training_load.session_undo_refuse('event_session_mismatch');
  end if;
  if (select count(*) from training_load.metric_events e2
       join training_load.metric_source_connections c2 on c2.id = e2.source_connection_id
      where c2.source_system = 'gpexe' and e2.owner_team_id = p_team and e2.source_external_id = v_event.source_external_id) > 1 then
    perform training_load.session_undo_refuse('two_events_for_session');
  end if;

  -- 6. The scope, collected again after the activities are locked (a link added meanwhile is seen here or waits).
  v_scope := training_load.session_undo_scope(v_event_id);
  v_act := coalesce(array(select jsonb_array_elements_text(v_scope -> 'activityIds')::uuid), '{}');
  -- Lock the activities, look again, and repeat until the set no longer grows (a link added while a lock was waited for is
  -- seen by the next look; three rounds are far more than the importer's own creation under the team lock can need).
  loop
    exit when cardinality(v_act) = 0;
    perform 1 from training.activities a where a.id = any(v_act) order by a.id for update;
    v_act_before := v_act;
    v_scope := training_load.session_undo_scope(v_event_id);
    v_act := coalesce(array(select jsonb_array_elements_text(v_scope -> 'activityIds')::uuid), '{}');
    exit when v_act <@ v_act_before;
    v_pass := v_pass + 1;
    if v_pass >= 3 then
      raise exception 'undo_imported_session: the activities of the event keep changing' using errcode = '55P03';
    end if;
  end loop;
  -- v87 begin: manual values never block for good (the owner's answer Q3 of 2026-11-20): they are removed only with a
  -- confirmation of exactly the list computed here, under the team's import lock (every manual write takes it too). A
  -- manual entry of another path that left a write request still refuses below (manual_write_request_exists).
  v_manual := v_scope -> 'manualValues';
  if (v_scope ->> 'manualOccasionCount')::int > 0 then
    if p_manual_values_fingerprint is null then
      perform training_load.session_undo_refuse('manual_values_need_confirmation', v_manual::text);
    end if;
    if p_manual_values_fingerprint is distinct from v_manual ->> 'fingerprint' then
      perform training_load.session_undo_refuse('manual_values_changed', v_manual::text);
    end if;
  elsif p_manual_values_fingerprint is not null then
    -- A fingerprint confirms a list; with no manual value at all that list is gone.
    perform training_load.session_undo_refuse('manual_values_changed', '{"count":0,"list":[],"fingerprint":null}');
  end if;
  -- v87 end
  if (v_scope ->> 'sharedActivityCount')::int > 0 then
    perform training_load.session_undo_refuse('shared_activity');
  end if;
  if (v_scope ->> 'otherEventLinkCount')::int > 0 then
    perform training_load.session_undo_refuse('other_event_link');
  end if;
  if (v_scope ->> 'entangledActivityCount')::int > 0 then
    perform training_load.session_undo_refuse('entangled_activity');
  end if;
  if (v_scope ->> 'calendarLinkCount')::int > 0 then
    perform training_load.session_undo_refuse('calendar_link_exists', v_scope ->> 'calendarLinkCount');
  end if;
  if (v_scope ->> 'manualWriteRequestCount')::int > 0 then
    perform training_load.session_undo_refuse('manual_write_request_exists');
  end if;
  -- v60 (O1): the roster work never blocks what the import wrote; LATER work is removed only with a confirmation of
  -- exactly the list computed here, under the team's import lock (every roster command takes it too).
  v_work := v_scope -> 'rosterWork';
  v_later_total := (v_work -> 'laterWork' ->> 'decisions')::int + (v_work -> 'laterWork' ->> 'requests')::int
                 + (v_work -> 'laterWork' ->> 'completions')::int + (v_work -> 'laterWork' ->> 'completionLog')::int;
  if v_later_total > 0 then
    if not v_confirm then
      perform training_load.session_undo_refuse('roster_work_needs_confirmation', v_work::text);
    end if;
    if p_later_roster_fingerprint is distinct from v_work -> 'laterWork' ->> 'fingerprint' then
      perform training_load.session_undo_refuse('roster_work_changed', v_work::text);
    end if;
  elsif v_confirm then
    -- A fingerprint confirms a list; with no later work at all that list is gone.
    perform training_load.session_undo_refuse('roster_work_changed', v_work::text);
  end if;
  v_alias := coalesce(array(select jsonb_array_elements_text(v_scope -> 'aliasActivityIds')::uuid), '{}');
  v_part := coalesce(array(select jsonb_array_elements_text(v_scope -> 'participantIds')::uuid), '{}');
  v_occ := coalesce(array(select jsonb_array_elements_text(v_scope -> 'occasionIds')::uuid), '{}');
  v_seg := coalesce(array(select jsonb_array_elements_text(v_scope -> 'segmentIds')::uuid), '{}');
  v_ident := coalesce(array(select jsonb_array_elements_text(v_scope -> 'identityIds')::uuid), '{}');
  v_batch := coalesce(array(select jsonb_array_elements_text(v_scope -> 'batchIds')::uuid), '{}');
  v_obs := coalesce(array(select jsonb_array_elements_text(v_scope -> 'observationIds')::uuid), '{}');

  -- 7. The removal, in the CLI's order, under the marker.
  perform set_config('optimove.session_undo_tx', txid_current()::text, true);
  begin
    -- v60: the roster work of the alias set first (decisions -> completion log -> completions -> requests); each count must
    -- be the one the scope counted, or the work changed under the call.
    delete from training.activity_athlete_decisions where activity_id = any(v_alias);
    get diagnostics v_n = row_count;
    v_roster_n := v_n;
    if v_n <> (v_work ->> 'decisions')::int then
      perform training_load.session_undo_refuse('roster_work_changed', v_work::text);
    end if;
    v_removed := training_load.session_undo_add(v_removed, 'activity_athlete_decisions', v_n);
    delete from training.activity_completion_log where activity_id = any(v_alias);
    get diagnostics v_n = row_count;
    v_roster_n := v_roster_n + v_n;
    if v_n <> (v_work ->> 'completionLog')::int then
      perform training_load.session_undo_refuse('roster_work_changed', v_work::text);
    end if;
    v_removed := training_load.session_undo_add(v_removed, 'activity_completion_log', v_n);
    delete from training.activity_completions where activity_id = any(v_alias);
    get diagnostics v_n = row_count;
    v_roster_n := v_roster_n + v_n;
    if v_n <> (v_work ->> 'completions')::int then
      perform training_load.session_undo_refuse('roster_work_changed', v_work::text);
    end if;
    v_removed := training_load.session_undo_add(v_removed, 'activity_completions', v_n);
    delete from training.activity_roster_requests where activity_id = any(v_alias);
    get diagnostics v_n = row_count;
    v_roster_n := v_roster_n + v_n;
    if v_n <> (v_work ->> 'requests')::int then
      perform training_load.session_undo_refuse('roster_work_changed', v_work::text);
    end if;
    v_removed := training_load.session_undo_add(v_removed, 'activity_roster_requests', v_n);
    if cardinality(v_obs) > 0 then
      delete from training.activity_source_observations where id = any(v_obs);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activity_source_observations', v_n);
    end if;
    if cardinality(v_act) > 0 then
      delete from training.activity_component_metric_segment_links l using training.activity_components c
       where c.id = l.activity_component_id and c.activity_id = any(v_act);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activity_component_metric_segment_links', v_n);
      delete from training.activity_components where activity_id = any(v_act);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activity_components', v_n);
      -- Only this event's links: a foreign one left behind makes the activity delete fail and the whole call roll back.
      delete from training.activity_participant_metric_participant_links l using training_load.metric_event_participants p
       where p.id = l.metric_event_participant_id and p.event_id = v_event_id;
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activity_participant_metric_participant_links', v_n);
      delete from training.activity_participants where activity_id = any(v_act);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activity_participants', v_n);
      delete from training.activity_metric_event_links where metric_event_id = v_event_id;
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activity_metric_event_links', v_n);
      delete from training.activities where id = any(v_act);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'activities', v_n);
    end if;
    if cardinality(v_occ) > 0 then
      delete from training_load.metric_value_source_provenance p using training_load.metric_values v
       where v.id = p.metric_value_id and v.occasion_id = any(v_occ);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_value_source_provenance', v_n);
      -- v63: an estimate's provenance row goes before its value (it references it).
      delete from training_load.metric_value_estimates where occasion_id = any(v_occ);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'estimates_removed', v_n);
      -- v87 begin: a manual value's provenance row goes before its occasion (it references it).
      delete from training_load.metric_manual_values where occasion_id = any(v_occ);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_manual_values', v_n);
      -- v87 end
      delete from training_load.metric_values where occasion_id = any(v_occ);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_values', v_n);
      update training_load.metric_source_identities set current_occasion_id = null where current_occasion_id = any(v_occ);
      -- One statement for the whole chain: occasions point at each other and the checks run at the end of the statement.
      delete from training_load.metric_measurement_occasions where id = any(v_occ);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_measurement_occasions', v_n);
    end if;
    if cardinality(v_ident) > 0 then
      delete from training_load.metric_source_identities where id = any(v_ident);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_source_identities', v_n);
    end if;
    if cardinality(v_part) > 0 then
      delete from training_load.metric_event_participants where id = any(v_part);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_event_participants', v_n);
    end if;
    if cardinality(v_seg) > 0 then
      delete from training_load.metric_event_segments where id = any(v_seg);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_event_segments', v_n);
    end if;
    if (v_scope ->> 'hasBinding')::boolean then
      delete from training_load.metric_event_source_bindings b where b.event_id = v_event_id;
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_event_source_bindings', v_n);
    end if;
    delete from training_load.metric_events where id = v_event_id;
    get diagnostics v_n = row_count;
    v_removed := training_load.session_undo_add(v_removed, 'metric_events', v_n);
    if cardinality(v_batch) > 0 then
      delete from training_load.metric_import_batches b
       where b.id = any(v_batch)
         and not exists (select 1 from training_load.metric_measurement_occasions o where o.import_batch_id = b.id);
      get diagnostics v_n = row_count;
      v_removed := training_load.session_undo_add(v_removed, 'metric_import_batches', v_n);
    end if;
  exception when foreign_key_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform training_load.session_undo_refuse('referenced_elsewhere', v_constraint);
  end;
  select coalesce(sum(value::int), 0)::int into v_total from jsonb_each_text(v_removed);
  if v_roster_n > 0 then
    v_roster_removed := jsonb_build_object(
      'import_written', jsonb_build_object('decisions', (v_work -> 'importWritten' ->> 'decisions')::int,
                                           'requests', (v_work -> 'importWritten' ->> 'requests')::int,
                                           'completions', (v_work -> 'importWritten' ->> 'completions')::int,
                                           'completion_log', (v_work -> 'importWritten' ->> 'completionLog')::int),
      'later', jsonb_build_object('decisions', (v_work -> 'laterWork' ->> 'decisions')::int,
                                  'requests', (v_work -> 'laterWork' ->> 'requests')::int,
                                  'completions', (v_work -> 'laterWork' ->> 'completions')::int,
                                  'completion_log', (v_work -> 'laterWork' ->> 'completionLog')::int),
      'later_list', v_work -> 'laterWork' -> 'list',
      'later_fingerprint', v_work -> 'laterWork' -> 'fingerprint',
      'confirmed_by', case when v_later_total > 0 then to_jsonb(p_actor) else 'null'::jsonb end);
  end if;
  -- v87 begin: what was confirmed and removed.
  if (v_scope ->> 'manualOccasionCount')::int > 0 then
    v_manual_removed := jsonb_build_object('count', (v_manual ->> 'count')::int, 'list', v_manual -> 'list',
                                           'fingerprint', v_manual -> 'fingerprint', 'confirmed_by', to_jsonb(p_actor));
  end if;
  -- v87 end

  -- 8. The deletion log (v21): one row, in this transaction, after the event is gone.
  insert into training_load.import_deletion_log
    (deleted_by_user_id, authorized_via, reason, event_id, source_system, source_connection_id, source_external_id,
     owner_team_id, occurred_date, reference_set_external_id, removed_counts, removed_total, roster_work_removed,
     manual_values_removed /* v87 */)
  values (p_actor, v_basis /* v76: derived above */, v_reason, v_event_id, v_scope ->> 'sourceSystem', (v_scope ->> 'connectionId')::uuid,
          v_scope ->> 'externalId', (v_scope ->> 'ownerTeamId')::uuid, (v_scope ->> 'occurredDate')::date,
          v_scope ->> 'referenceSetExternalId', v_removed, v_total, v_roster_removed, v_manual_removed)
  returning id into v_log;

  -- 9. Every candidate of the event is marked undone (their request is checked at the end of this call). Then, for the NEWEST
  --    approved content among them, when its raw snapshot is still available, the check that last saw it succeeded and the
  --    team has no live candidate of the session with other content, a fresh pending candidate of that content is written.
  update training_load.gpexe_import_candidates
     set import_undone_at = clock_timestamp(), import_undone_request_id = v_req_id
   where id = any(v_ids);
  select c.* into v_offer
    from training_load.gpexe_import_candidates c
    join training_load.gpexe_import_approvals a on a.candidate_id = c.id
   where c.id = any(v_ids)
   order by a.approved_at desc, c.id desc limit 1;
  select k.status into v_last_status from training_load.gpexe_import_checks k
   where k.id = v_offer.last_seen_check_id and k.owner_team_id = p_team;
  if v_offer.raw_bundle is not null and v_offer.raw_purged_at is null and v_offer.raw_expires_at > now()
     and v_last_status = 'succeeded'
     -- Never offer content older than what the team already has: a live candidate of the same session with other content
     -- (newer data a search published) means the old snapshot would be approvable over it.
     and not exists (select 1 from training_load.gpexe_import_candidates o
                      where o.owner_team_id = p_team and o.gpexe_team_session_id = v_offer.gpexe_team_session_id
                        and o.import_undone_at is null and o.bundle_hash <> v_offer.bundle_hash
                        and o.status in ('pending', 'blocked', 'imported')) then
    v_new := gen_random_uuid();
    insert into training_load.gpexe_import_candidates
      (id, owner_team_id, gpexe_team_session_id, session_started_at, session_label, bundle_hash, raw_bundle, raw_expires_at,
       status, first_seen_check_id, last_seen_check_id, first_seen_at, last_seen_at, drill_parameter_effect)
    values (v_new, p_team, v_offer.gpexe_team_session_id, v_offer.session_started_at, v_offer.session_label, v_offer.bundle_hash,
            v_offer.raw_bundle, least(v_offer.raw_expires_at, now() + interval '30 days'), 'pending',
            v_offer.first_seen_check_id, v_offer.last_seen_check_id, v_offer.first_seen_at, now(), v_offer.drill_parameter_effect);
  end if;

  -- 10. The request record, then the deferred link is checked here, not at the COMMIT.
  insert into training_load.gpexe_session_undo_requests
    (id, requested_by_user_id, request_key, request_hash, owner_team_id, candidate_id, undone_candidate_ids, event_id,
     deletion_log_id, reason, removed_counts, removed_total, new_candidate_id)
  values (v_req_id, p_actor, p_request_key, v_hash, p_team, p_candidate, v_ids, v_event_id, v_log, v_reason, v_removed, v_total, v_new);
  set constraints training_load.gpexe_import_candidates_import_undone_request_fkey immediate;
  -- The marker covers this call only.
  perform set_config('optimove.session_undo_tx', '', true);
  return query select false, v_event_id, v_log, v_removed, v_total, v_new, v_ids, v_roster_removed, v_manual_removed;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. The approval records the coach's choice (written by the later pull requests: ST-4's re-import question and ST-2's
--    chosen session type; agreed with the ST-2 executor on 2026-11-22). No row changes: both columns start empty.
-- ---------------------------------------------------------------------------
--   replaced_manual_athlete_ids: the athletes whose manual values the approval replaced with GPEXE's ("Use GPEXE's values").
--   chosen_activity_type_key: the session type the coach chose when it differs from the team's suggestion; null for the
--     suggestion, for an approval of an already imported session, and for every approval before v87.
-- A subset hash binds a choice: present exactly when the approval has one (an excluded athlete, a replaced manual value or a
-- chosen type) - v59's pair rule, widened.
alter table training_load.gpexe_import_approvals
  add column replaced_manual_athlete_ids uuid[] not null default '{}',
  add column chosen_activity_type_key text references training.activity_types(key) on delete restrict;
alter table training_load.gpexe_import_approvals
  add constraint gpexe_import_approvals_replaced_manual_size check (cardinality(replaced_manual_athlete_ids) <= 60),
  drop constraint gpexe_import_approvals_subset_hash_pair,
  add constraint gpexe_import_approvals_subset_hash_pair check (
    (subset_hash is null) = (cardinality(excluded_athlete_ids) = 0 and cardinality(replaced_manual_athlete_ids) = 0
                             and chosen_activity_type_key is null));

comment on function training_load.undo_imported_session(uuid, uuid, uuid, uuid, text, uuid, text, text) is
  'v87: the sanctioned undo of one imported GPEXE session, its roster work, estimates and (confirmed) manual values included, by whoever may import it (lock_gpexe_session_undo_right). See migrations_v2/202611221000_training_load_v87_manual_values.sql.';
