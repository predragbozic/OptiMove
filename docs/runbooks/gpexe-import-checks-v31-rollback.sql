-- Rollback of migration v31 (F3c2g: a check records which credential path it
-- read through):
-- migrations_v2/202610041200_training_load_v31_gpexe_import_checks_source_path.sql
--
-- Not a migration and never run automatically. Rehearsed on a disposable
-- database (backend/tests/gpexe-import-credential-resolver.test.mjs, the
-- migration test: apply on v30, roll back, apply again, refuse under a later
-- migration, refuse while evidence exists). Before it is run anywhere real:
--   * the application is back on a commit WITHOUT the F3c2g resolver (the
--     check INSERT names the five columns);
--   * a fresh, restore-verified backup exists;
--   * the owner approved this database specifically.
-- It drops only what v31 created (two triggers and their functions, one
-- CHECK constraint, five columns with their own constraints and foreign
-- keys). It is forward-safe: it refuses, changing nothing, when
--   * any migrations_v2 migration newer than v31 is recorded;
--   * any check row says source_connection — that row is evidence (which
--     connection, binding, source team and host a check read through) that
--     v30 cannot represent; such rows are never deleted or rewritten here.
--     Only a forward migration may decide their fate.
-- Rows on the legacy path lose nothing: before v31 every row meant exactly
-- that. Rows are not read for their content, copied or exported.
--
-- One transaction: everything or nothing. Run it as
--   psql -v ON_ERROR_STOP=1 -f docs/runbooks/gpexe-import-checks-v31-rollback.sql
-- so a refusal (55P03 while a check is being started, or one of the checks)
-- stops the script at once; nothing is dropped either way — run it again
-- when quiet.
begin;
-- DDL needs ACCESS EXCLUSIVE on the checks table. NOWAIT: a check being
-- started (its INSERT) or a running check's heartbeat UPDATE in flight makes
-- this rollback fail at once with 55P03 and change nothing. The two tables
-- the foreign keys reference are locked NOWAIT as well (below), so the later
-- DROP COLUMN meets no wait either: a bind, Unbind, Connect or Test in
-- flight makes the whole transaction fail at once, and nothing is dropped.
-- The header requires the application to be rolled back first, so nothing
-- of that runs here anyway.
set local lock_timeout = '5s';
lock table training_load.gpexe_import_checks in access exclusive mode nowait;
-- Dropping the two foreign-key columns also locks the referenced tables; they
-- are taken NOWAIT here too, so this rollback never waits on any table the
-- application uses (schema_migrations and the catalog stay under the 5 s
-- lock_timeout; only another migration runner could contend there).
lock table training_load.source_team_bindings in access exclusive mode nowait;
lock table training_load.source_credential_connections in access exclusive mode nowait;

do $$
declare
  newer text;
  evidence integer;
begin
  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name > 'migrations_v2/202610041200_training_load_v31_gpexe_import_checks_source_path.sql'
     and migration_name like 'migrations_v2/%';
  if newer is not null then
    raise exception 'v31 rollback refused: later migrations are applied: %; only a forward migration is allowed', newer;
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name like '%202610041200_training_load_v31_gpexe_import_checks_source_path.sql') then
    raise exception 'v31 rollback refused: v31 is not recorded as applied on this database';
  end if;
  select count(*) into evidence from training_load.gpexe_import_checks where source_path = 'source_connection';
  if evidence > 0 then
    raise exception 'v31 rollback refused: % check row(s) record a source-connection read, which v30 cannot represent; only a forward migration may decide their fate', evidence;
  end if;
end $$;

drop trigger if exists gpexe_import_checks_freeze_source on training_load.gpexe_import_checks;
drop function if exists training_load.freeze_gpexe_check_source();
drop trigger if exists gpexe_import_checks_source_facts on training_load.gpexe_import_checks;
drop function if exists training_load.require_gpexe_check_source();
alter table training_load.gpexe_import_checks
  drop constraint if exists gpexe_import_checks_source_path_facts;
alter table training_load.gpexe_import_checks
  drop column if exists source_host_key,
  drop column if exists source_team_id,
  drop column if exists source_binding_id,
  drop column if exists source_connection_id,
  drop column if exists source_path;

delete from public.schema_migrations
 where migration_name like '%202610041200_training_load_v31_gpexe_import_checks_source_path.sql';

do $$
begin
  if exists (select 1 from pg_trigger where tgname in ('gpexe_import_checks_freeze_source', 'gpexe_import_checks_source_facts')) then
    raise exception 'v31 rollback refused: a v31 trigger is still there';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname in ('freeze_gpexe_check_source', 'require_gpexe_check_source')) then
    raise exception 'v31 rollback refused: a v31 function is still there';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_import_checks' and column_name in ('source_path', 'source_connection_id', 'source_binding_id', 'source_team_id', 'source_host_key')) then
    raise exception 'v31 rollback refused: a v31 column is still there';
  end if;
end $$;

commit;
