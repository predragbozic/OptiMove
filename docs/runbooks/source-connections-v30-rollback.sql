-- Rollback of migration v30 (F3c2e: the approved GPEXE team of a bound team
-- is final while its source binding is active):
-- migrations_v2/202610041000_training_load_v30_gpexe_team_settings_bound_final.sql
--
-- Not a migration and never run automatically. Rehearsed on a disposable
-- database (backend/tests/source-connections-f3c2e.test.mjs, the migration
-- test: apply on v29, roll back, apply again, refuse under a later migration,
-- refuse while the protection is needed). Before it is run anywhere real:
--   * the application is back on a commit WITHOUT the F3c2e bind route (the
--     route relies on the trigger as the backstop of the approved pair);
--   * a fresh, restore-verified backup exists;
--   * the owner approved this database specifically.
-- It drops only what v30 created (the pair trigger and its function on
-- source_team_bindings, the canonical unique index, the settings trigger and
-- its function, the canonical function). It refuses, changing nothing, when
--   * any migrations_v2 migration newer than v30 is recorded;
--   * the protection is already needed: an ACTIVE gpexe source_team_binding
--     exists for a team that has a gpexe_team_settings row (without the
--     trigger that pair could silently diverge) — end the bindings first,
--     through a path that exists by then, never by a raw UPDATE here.
-- Rows are not read for their content, copied or exported; dropping two
-- triggers, three functions and an index touches no data. Nothing of v29 or
-- earlier is touched (v24's own guards on gpexe_team_settings stay).
--
-- One transaction: everything or nothing.
begin;
-- DDL needs ACCESS EXCLUSIVE on gpexe_team_settings; a bind or a settings
-- change holds a row lock for seconds. Never queue every other access
-- behind it.
set local lock_timeout = '5s';
-- The refusal below is checked under the locks the DROPs need anyway, so a
-- bind in flight (its binding row not yet committed, the settings row held
-- FOR SHARE) makes this rollback fail at once (55P03) instead of slipping
-- past the check. Bindings first, then settings: the bind path's own order.
lock table training_load.source_team_bindings in access exclusive mode;
lock table training_load.gpexe_team_settings in access exclusive mode;

do $$
declare
  newer text;
  needed integer;
begin
  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name > 'migrations_v2/202610041000_training_load_v30_gpexe_team_settings_bound_final.sql'
     and migration_name like 'migrations_v2/%';
  if newer is not null then
    raise exception 'v30 rollback refused: later migrations are applied: %; only a forward migration is allowed', newer;
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name like '%202610041000_training_load_v30_gpexe_team_settings_bound_final.sql') then
    raise exception 'v30 rollback refused: v30 is not recorded as applied on this database';
  end if;
  select count(*) into needed
    from training_load.source_team_bindings b
    join training_load.gpexe_team_settings s on s.owner_team_id = b.team_id
   where b.source_system = 'gpexe' and b.state = 'active';
  if needed > 0 then
    raise exception 'v30 rollback refused: % active gpexe binding(s) rely on the approved-pair protection; end them first', needed;
  end if;
end $$;

drop index if exists training_load.gpexe_team_settings_canonical_team_id_key;
drop trigger if exists source_team_bindings_check_pair on training_load.source_team_bindings;
drop function if exists training_load.refuse_unapproved_gpexe_binding();
drop trigger if exists gpexe_team_settings_bound_team_final on training_load.gpexe_team_settings;
drop function if exists training_load.refuse_gpexe_team_change_while_bound();
drop function if exists training_load.gpexe_team_id_canonical(text);

delete from public.schema_migrations
 where migration_name like '%202610041000_training_load_v30_gpexe_team_settings_bound_final.sql';

do $$
begin
  if exists (select 1 from pg_trigger where tgname in ('gpexe_team_settings_bound_team_final', 'source_team_bindings_check_pair')) then
    raise exception 'v30 rollback refused: a v30 trigger is still there';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname in ('refuse_gpexe_team_change_while_bound', 'refuse_unapproved_gpexe_binding', 'gpexe_team_id_canonical')) then
    raise exception 'v30 rollback refused: a v30 function is still there';
  end if;
  if exists (select 1 from pg_indexes where schemaname = 'training_load' and indexname = 'gpexe_team_settings_canonical_team_id_key') then
    raise exception 'v30 rollback refused: the v30 index is still there';
  end if;
end $$;

commit;
