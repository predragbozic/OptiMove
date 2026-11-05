-- Rollback of migration v57 (the in-app undo of an imported GPEXE session, U5):
-- migrations_v2/202611051000_training_load_v57_session_undo.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/session-undo-u5.test.mjs:
-- apply -> rollback -> the v56 catalog exactly (trigger definitions, constraints, columns) -> re-apply, every refusal below).
-- Before it is run anywhere real: a fresh restore-verified backup exists; the deployed commit no longer contains the v57
-- migration file (otherwise the migrator applies v57 again at the next start); and the owner approved this database
-- specifically (.claude/rules/database-safety.md).
--
-- It re-points the six triggers at the original functions (which v57 left in place), restores the full unique key on
-- gpexe_import_candidates, drops the two columns, the request table and every v57 function, and removes the v57 record.
-- It changes no other row. It refuses, changing nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v57 is not recorded, or any later migrations_v2 migration is;
--   * the body in force of any v57 function is not v57's (by md5);
--   * a request row exists or any candidate is marked undone (an undo happened: the way back is forward-only, because
--     the restored unique key would refuse the fresh candidate beside its undone one and the log rows would lose their request).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f session-undo-v57-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v57 rollback refused: the migrator is running';
  end if;
end $$;

-- Nothing may be written between the checks below and the drops.
lock table training_load.gpexe_import_candidates, training_load.gpexe_session_undo_requests,
  training_load.metric_values, training_load.metric_event_source_bindings, training_load.metric_value_source_provenance,
  training.activity_source_observations in access exclusive mode;

do $$
declare
  v57 constant text := 'migrations_v2/202611051000_training_load_v57_session_undo.sql';
  expected constant text[][] := array[
    ['training_load', 'forbid_update_delete_unless_session_undo', '2ffa110ec96ea1966291c876be457460'],
    ['training_load', 'forbid_event_source_binding_delete_unless_session_undo', '7d181f998af3d88f7edfed027f421fe6'],
    ['training_load', 'source_metric_append_only_unless_session_undo', 'f607bfcf8f618b5d394513f066d79d0b'],
    ['training', 'protect_activity_source_observation_v57', 'ea21a2a49f320dc7d6be45becc7743f5'],
    ['training_load', 'protect_gpexe_import_candidate_v57', '311d7f35e2e2ad4d56afa1f7760f78e0'],
    ['training_load', 'undo_imported_session', 'd16fda9662e38c8374c1e818506a4e3d'],
    ['training_load', 'session_undo_scope', 'f605cb502a36a4d8e372373fe1e2207a']];
  i int;
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v57) then
    raise exception 'v57 rollback refused: v57 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v57) then
    raise exception 'v57 rollback refused: later migrations are applied';
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = expected[i][1] and p.proname = expected[i][2]) is distinct from expected[i][3] then
      raise exception 'v57 rollback refused: the body in force of %.% is not v57''s', expected[i][1], expected[i][2];
    end if;
  end loop;
  if exists (select 1 from training_load.gpexe_session_undo_requests) or exists (select 1 from training_load.gpexe_import_candidates where import_undone_at is not null) then
    raise exception 'v57 rollback refused: an undo was made (a request row or an undone candidate exists)';
  end if;
end $$;

-- The six triggers back on the originals.
drop trigger metric_values_immutable on training_load.metric_values;
create trigger metric_values_immutable
  before update or delete on training_load.metric_values
  for each row execute function training_load.forbid_update_delete();
drop trigger metric_event_source_bindings_no_delete on training_load.metric_event_source_bindings;
create trigger metric_event_source_bindings_no_delete
  before delete on training_load.metric_event_source_bindings
  for each row execute function training_load.forbid_event_source_binding_delete();
drop trigger metric_value_source_provenance_append_only on training_load.metric_value_source_provenance;
create trigger metric_value_source_provenance_append_only
  before update or delete on training_load.metric_value_source_provenance
  for each row execute function training_load.source_metric_append_only();
drop trigger activity_source_observations_append_only on training.activity_source_observations;
create trigger activity_source_observations_append_only
  before update or delete on training.activity_source_observations
  for each row execute function training.protect_activity_source_observation();
drop trigger gpexe_import_candidates_protect on training_load.gpexe_import_candidates;
create trigger gpexe_import_candidates_protect
  before update or delete on training_load.gpexe_import_candidates
  for each row execute function training_load.protect_gpexe_import_candidate();
drop trigger gpexe_import_candidates_protect_insert on training_load.gpexe_import_candidates;
create trigger gpexe_import_candidates_protect_insert
  before insert on training_load.gpexe_import_candidates
  for each row execute function training_load.protect_gpexe_import_candidate();

-- The candidate key and columns back.
drop index training_load.gpexe_import_candidates_live_content_key;
alter table training_load.gpexe_import_candidates
  add constraint gpexe_import_candidates_owner_team_id_gpexe_team_session_id_key unique (owner_team_id, gpexe_team_session_id, bundle_hash);
drop index training_load.gpexe_import_candidates_import_undone_request_idx;
alter table training_load.gpexe_import_candidates
  drop constraint gpexe_import_candidates_import_undone_request_fkey,
  drop constraint gpexe_import_candidates_import_undone_together,
  drop constraint gpexe_import_candidates_import_undone_imported,
  drop column import_undone_at,
  drop column import_undone_request_id;

drop table training_load.gpexe_session_undo_requests;
drop function training_load.undo_imported_session(uuid, uuid, uuid, uuid, text, uuid);
drop function training_load.session_undo_add(jsonb, text, integer);
drop function training_load.session_undo_scope(uuid);
drop function training_load.protect_gpexe_import_candidate_v57();
drop function training_load.forbid_update_delete_unless_session_undo();
drop function training_load.forbid_event_source_binding_delete_unless_session_undo();
drop function training_load.source_metric_append_only_unless_session_undo();
drop function training.protect_activity_source_observation_v57();
drop function training_load.session_undo_request_guard();
drop function training_load.session_undo_refuse(text, text);
drop function training_load.session_undo_marker_ok();

delete from public.schema_migrations where migration_name = 'migrations_v2/202611051000_training_load_v57_session_undo.sql';

-- Post-gate: the originals are in force and every v57 object is gone.
do $$
begin
  if (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where not t.tgisinternal and t.tgenabled = 'O'
         and (t.tgname, p.proname) in (('metric_values_immutable', 'forbid_update_delete'),
                                       ('metric_event_source_bindings_no_delete', 'forbid_event_source_binding_delete'),
                                       ('metric_value_source_provenance_append_only', 'source_metric_append_only'),
                                       ('activity_source_observations_append_only', 'protect_activity_source_observation'),
                                       ('gpexe_import_candidates_protect', 'protect_gpexe_import_candidate'),
                                       ('gpexe_import_candidates_protect_insert', 'protect_gpexe_import_candidate'))) <> 6 then
    raise exception 'v57 rollback failed: a trigger does not point at its original function';
  end if;
  if to_regclass('training_load.gpexe_session_undo_requests') is not null
     or to_regprocedure('training_load.undo_imported_session(uuid,uuid,uuid,uuid,text,uuid)') is not null then
    raise exception 'v57 rollback failed: a v57 object is still there';
  end if;
end $$;
commit;
