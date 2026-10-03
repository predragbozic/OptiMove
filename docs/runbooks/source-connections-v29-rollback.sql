-- Rollback of migration v29 (F3c2d: the linked_untested fact CHECK, the
-- credential-states CHECK and the per-user throttle index):
-- migrations_v2/202610031000_training_load_v29_source_connection_state_facts.sql
--
-- Not a migration and never run automatically. Rehearsed on a disposable
-- database (backend/tests/source-connections-f3c2d.test.mjs, test 1: apply
-- on v28, roll back, apply again, refuse under a later migration). Before
-- it is run anywhere real:
--   * the application is back on a commit WITHOUT the F3c2d routes (the
--     routes rely on these CHECKs; without them a route bug could store a
--     contradictory row);
--   * a fresh, restore-verified backup exists;
--   * the owner approved this database specifically.
-- It drops only what v29 created. It refuses, changing nothing, when any
-- migrations_v2 migration newer than v29 is recorded in schema_migrations.
-- Rows are not read, copied, exported or decrypted: dropping a CHECK and
-- an index touches no data. Nothing of v28 or earlier is touched.
--
-- One transaction: everything or nothing.
begin;
-- The DDL below needs ACCESS EXCLUSIVE; a running attempt holds ROW SHARE for
-- up to about a minute. Never queue every other access behind it.
set local lock_timeout = '5s';

do $$
declare
  newer text;
begin
  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name > 'migrations_v2/202610031000_training_load_v29_source_connection_state_facts.sql'
     and migration_name like 'migrations_v2/%';
  if newer is not null then
    raise exception 'v29 rollback refused: later migrations are applied: %; only a forward migration is allowed', newer;
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name like '%202610031000_training_load_v29_source_connection_state_facts.sql') then
    raise exception 'v29 rollback refused: v29 is not recorded as applied on this database';
  end if;
end $$;

alter table training_load.source_credential_connections
  drop constraint if exists source_credential_connections_state_linked_untested_facts;
alter table training_load.source_credential_connections
  drop constraint if exists source_credential_connections_state_has_credential;
drop index if exists training_load.source_connection_audit_user_attempts_idx;

delete from public.schema_migrations
 where migration_name like '%202610031000_training_load_v29_source_connection_state_facts.sql';

do $$
begin
  if exists (select 1 from pg_constraint where conname in ('source_credential_connections_state_linked_untested_facts', 'source_credential_connections_state_has_credential')) then
    raise exception 'v29 rollback refused: a v29 constraint is still there';
  end if;
  if exists (select 1 from pg_indexes where schemaname = 'training_load' and indexname = 'source_connection_audit_user_attempts_idx') then
    raise exception 'v29 rollback refused: the v29 index is still there';
  end if;
end $$;

commit;
