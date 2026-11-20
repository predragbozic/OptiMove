-- Rollback of migration v83 (an athlete changes their own RPE answer while the question is open, K4b;
-- migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql).
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/rpe-answer-change-k4b.test.mjs
-- and backend/scripts/rpe-answer-change-v83-rehearsal.mjs: apply -> rollback -> the catalog identical to before -> apply again),
-- on PostgreSQL 16; on 17 by the owner's run of that script (docs/runbooks/rpe-answer-change-v83.md). Before it is run anywhere
-- real: the deployed commit no longer contains the v83 file (otherwise the migrator applies v83 again at the next start), and the
-- database is named in its own approval (.claude/rules/database-safety.md).
--
-- It re-points the trigger protect_session_feedback_snapshot back to the v5 function, drops every v83 object and the v83
-- record. It changes no other row. It refuses (23514, fixed message), changing nothing, once any of these holds - from then on
-- v83 is forward-only:
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v83 is not recorded, or a later migrations_v2 migration is;
--   * a row of training_load.session_feedback_changes exists (an answer was changed);
--   * a foreign key from outside v83 points into training_load.session_feedback_changes;
--   * the v5 function's body is not the one v83 was applied over (md5).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f rpe-answer-change-v83-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v83 rollback refused: the migrator is running' using errcode = '23514';
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql') then
    raise exception 'v83 rollback refused: v83 is not recorded on this database' using errcode = '23514';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql') then
    raise exception 'v83 rollback refused: later migrations are applied' using errcode = '23514';
  end if;
  -- Locks the history against a change landing during the rollback, then counts it.
  lock table training_load.session_feedback_changes in share mode;
  if exists (select 1 from training_load.session_feedback_changes) then
    raise exception 'v83 rollback refused: an answer was changed (the history has rows)' using errcode = '23514';
  end if;
  if exists (select 1 from pg_constraint k where k.contype = 'f' and k.confrelid = 'training_load.session_feedback_changes'::regclass
               and k.conrelid <> 'training_load.session_feedback_changes'::regclass) then
    raise exception 'v83 rollback refused: another table refers to the history' using errcode = '23514';
  end if;
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'protect_session_feedback_snapshot') is distinct from '1d60bc187fa149ca524ffcb0e61d8a63' then
    raise exception 'v83 rollback refused: the v5 snapshot function is not the one v83 was applied over' using errcode = '23514';
  end if;
end;
$$;

drop trigger session_feedback_change_link on training_load.session_feedback;
drop trigger protect_session_feedback_snapshot on training_load.session_feedback;
create trigger protect_session_feedback_snapshot
  before update on training_load.session_feedback
  for each row execute function training_load.protect_session_feedback_snapshot();
drop function training_load.change_external_rpe(uuid, uuid, uuid, integer, integer, text, integer);
drop function training_load.rpe_change_state(uuid);
drop function training_load.session_feedback_change_link_check();
drop function training_load.protect_session_feedback_snapshot_v83();
drop table training_load.session_feedback_changes;
drop function training_load.session_feedback_changes_guard();
drop function training_load.session_feedback_changes_append_only();
drop function training_load.rpe_change_current_xmin();
drop function training_load.rpe_change_marker_ok();
delete from public.schema_migrations where migration_name = 'migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql';

commit;
