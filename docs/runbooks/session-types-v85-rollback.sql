-- Rollback of migration v85 (session types, ST-1; migrations_v2/202611201500_training_load_v85_session_types.sql).
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/session-types-v85-migration.test.mjs
-- and backend/scripts/session-types-v85-rehearsal.mjs: apply -> rollback -> the catalog identical to before -> apply again), on
-- PostgreSQL 16 and, by the command in docs/runbooks/session-types-v85.md, on 17. Before it is run anywhere real: the deployed
-- commit no longer contains the v85 file (otherwise the migrator applies v85 again at the next start), and the database is named
-- in its own approval (.claude/rules/database-safety.md).
--
-- It drops the change log, the source map, every v85 trigger and function, the v85 constraints, index and columns of
-- training.activity_types, deletes the four types v85 added, puts back the v1 labels ("Training session", "Match") and makes
-- testing_session and recovery_session active again, and deletes the v85 record. It changes no other row. It refuses (23514,
-- fixed message), changing nothing, once any of these holds - from then on v85 is forward-only:
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v85 is not recorded, or any migration was applied after it (by applied_at, not by prefix);
--   * a change row exists (a type was added, renamed, archived or restored through the app), or a club type exists;
--   * an activity holds one of the four types v85 added;
--   * the source map holds a row that is not the seed;
--   * a v1 type differs from the v85 seed (label, active).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f session-types-v85-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v85 rollback refused: the migrator is running' using errcode = '23514';
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611201500_training_load_v85_session_types.sql') then
    raise exception 'v85 rollback refused: v85 is not recorded on this database' using errcode = '23514';
  end if;
  if exists (select 1 from public.schema_migrations m where m.migration_name <> 'migrations_v2/202611201500_training_load_v85_session_types.sql'
              and m.applied_at >= (select applied_at from public.schema_migrations where migration_name = 'migrations_v2/202611201500_training_load_v85_session_types.sql')) then
    raise exception 'v85 rollback refused: later migrations are applied' using errcode = '23514';
  end if;
  if exists (select 1 from training.activity_type_changes) or exists (select 1 from training.activity_types where owner_scope = 'club') then
    raise exception 'v85 rollback refused: session types were changed in the app' using errcode = '23514';
  end if;
  if exists (select 1 from training.activities where activity_type_key in ('friendly_match', 'exercise_session', 'compensation_session', 'rtp_session')) then
    raise exception 'v85 rollback refused: an activity holds a session type v85 added' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.source_session_types where not seeded) then
    raise exception 'v85 rollback refused: a team suggestion was set' using errcode = '23514';
  end if;
  if (select string_agg(key || '=' || label || ':' || is_active::text, ',' order by key) from training.activity_types
       where key in ('training_session', 'match', 'testing_session', 'recovery_session'))
     is distinct from 'match=Game:true,recovery_session=Recovery session:false,testing_session=Testing session:false,training_session=Full training:true' then
    raise exception 'v85 rollback refused: a v1 type differs from the v85 seed' using errcode = '23514';
  end if;
end $$;

drop trigger source_session_types_no_truncate on training_load.source_session_types;
drop trigger source_session_types_before_write on training_load.source_session_types;
drop table training_load.source_session_types;
drop function training_load.source_session_types_before_write();

drop trigger activities_session_type_guard on training.activities;
drop function training.activities_session_type_guard();

drop trigger activity_type_changes_no_truncate on training.activity_type_changes;
drop trigger activity_type_changes_no_update on training.activity_type_changes;
drop trigger activity_type_changes_before_insert on training.activity_type_changes;
drop table training.activity_type_changes;
drop function training.activity_type_changes_append_only();
drop function training.activity_type_changes_before_insert();

drop trigger activity_types_change_logged on training.activity_types;
drop trigger activity_types_no_truncate on training.activity_types;
drop trigger activity_types_before_write on training.activity_types;
drop function training.activity_types_change_logged();
drop function training.activity_types_no_truncate();
drop function training.activity_types_before_write();
drop function training.session_type_offered(text, uuid, boolean);
drop function training.session_type_basis(uuid, text, uuid);
drop function training.session_type_actor();

drop index training.activity_types_owner_club_idx;
drop index training.activity_types_owner_label_live_key;
alter table training.activity_types
  drop constraint activity_types_sort_order_check,
  drop constraint activity_types_archived_by_shape,
  drop constraint activity_types_archive_shape,
  drop constraint activity_types_label_check,
  drop constraint activity_types_key_shape,
  drop constraint activity_types_owner_shape,
  drop constraint activity_types_owner_scope_check;

delete from training.activity_types where key in ('friendly_match', 'exercise_session', 'compensation_session', 'rtp_session');
update training.activity_types set label = 'Training session' where key = 'training_session';
update training.activity_types set label = 'Match' where key = 'match';
update training.activity_types set is_active = true where key in ('testing_session', 'recovery_session');

alter table training.activity_types
  drop column updated_at,
  drop column sort_order,
  drop column archived_by_user_id,
  drop column archived_at,
  drop column created_by_user_id,
  drop column owner_club_id,
  drop column owner_scope;

delete from public.schema_migrations where migration_name = 'migrations_v2/202611201500_training_load_v85_session_types.sql';
commit;
