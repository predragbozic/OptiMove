-- Rollback of migration v28 (one approved host key, gpexe / server3):
-- migrations_v2/202609291000_training_load_v28_source_host_server3.sql
--
-- Not a migration and never run automatically. Rehearsed on a disposable
-- database (backend/tests/source-hosts-server3.test.mjs). Before it is run
-- anywhere real: the application is back on a commit whose
-- backend/src/sourceHosts.js does not know server3, a fresh restore-verified
-- backup exists, and the owner approved this database specifically.
--
-- It removes ONE row and the v28 record, and only while the key is unused.
-- It refuses, changing nothing, when
--   * any connection names gpexe / server3 (a connection is history: its
--     bindings and audit rows point at it, and its host is part of the
--     credential's authenticated context);
--   * the catalog row is not exactly what v28 inserted (label, state, note):
--     someone retired or relabelled it, which is a use of its own;
--   * any migrations_v2 migration newer than v28 is recorded.
-- After any of these the only way forward is a new migration (retire the
-- key: update ... set state = 'retired').
--
-- A catalog row cannot be deleted while its guard trigger is on (v27), so
-- the trigger is switched off for this one statement inside the
-- transaction and the commit is refused unless it is on again.
--
-- Waits are bounded: a stalled transaction that holds the catalog row makes
-- this script fail after 5 s instead of waiting while it holds locks itself.
-- The table lock only keeps other catalog WRITERS out (a retirement, a
-- relabel) while the checks run; it does not wait for a connection insert,
-- which holds the catalog row FOR SHARE. The guards against a connection
-- insert in flight are the row lock the DELETE has to wait for (bounded by
-- the lock timeout) and the foreign key (ON DELETE RESTRICT).
--
-- One transaction: everything or nothing.
begin;
set local lock_timeout = '5s';
lock table training_load.source_host_catalog in share row exclusive mode;

do $$
declare
  n_conn bigint;
  row_is_v28 boolean;
  newer text;
  reasons text[] := '{}';
begin
  select count(*) into n_conn from training_load.source_credential_connections
   where source_system = 'gpexe' and host_key = 'server3';
  if n_conn > 0 then
    reasons := reasons || format('%s connection(s) use host key server3', n_conn);
  end if;

  select exists (
           select 1 from training_load.source_host_catalog
            where source_system = 'gpexe' and host_key = 'server3'
              and label = 'GPEXE server3' and state = 'approved'
              and note = 'API family rest/v1. Confirmed by the owner-run read-only verification of 2026-09-29. Approved for F3c2.')
    into row_is_v28;
  if not row_is_v28 then
    reasons := reasons || 'the server3 catalog row is missing or is not what v28 inserted'::text;
  end if;

  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name like 'migrations_v2/%'
     and migration_name > 'migrations_v2/202609291000_training_load_v28_source_host_server3.sql';
  if newer is not null then
    reasons := reasons || format('later migrations are applied: %s', newer);
  end if;

  if cardinality(reasons) > 0 then
    raise exception 'v28 rollback refused: %; only a forward migration is allowed', array_to_string(reasons, '; ');
  end if;
end $$;

alter table training_load.source_host_catalog disable trigger source_host_catalog_immutable;

delete from training_load.source_host_catalog
 where source_system = 'gpexe' and host_key = 'server3';

alter table training_load.source_host_catalog enable trigger source_host_catalog_immutable;

do $$
begin
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'training_load' and c.relname = 'source_host_catalog'
       and t.tgname = 'source_host_catalog_immutable' and t.tgenabled = 'O') then
    raise exception 'v28 rollback refused: the catalog guard trigger is not enabled again';
  end if;
  if exists (select 1 from training_load.source_host_catalog where source_system = 'gpexe' and host_key = 'server3') then
    raise exception 'v28 rollback refused: the server3 row is still there';
  end if;
end $$;

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202609291000_training_load_v28_source_host_server3.sql';

commit;
