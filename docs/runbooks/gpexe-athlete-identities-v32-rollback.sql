-- Rollback of migration v32 (the GPEXE athlete identity snapshot):
-- migrations_v2/202610061000_training_load_v32_gpexe_athlete_identities.sql
--
-- Not a migration and never run automatically. Rehearsed on a disposable
-- database (backend/tests/gpexe-athlete-identity.test.mjs, the migration
-- test: apply on v31, check the invariants, roll back to the identical v31
-- catalog, apply again, and a failing last statement leaves nothing behind).
-- Before it is run anywhere real:
--   * the application is back on a commit WITHOUT the identity load (its
--     routes read and write the two tables);
--   * a fresh, restore-verified backup exists;
--   * the owner approved this database specifically.
-- It drops exactly what v32 created: three tables (with their indexes,
-- constraints and foreign keys), the five triggers and their functions, and
-- the purge function. It is forward-safe: it refuses, changing nothing, when
--   * any migrations_v2 migration newer than v32 is recorded;
--   * a load request row exists that is not 'failed' — a completed or running
--     load is history a forward migration has to decide about.
-- The identity rows themselves are a 14-day cache of personal data that may
-- never outlive the feature: they are deleted, never copied or exported.
--
-- One transaction: everything or nothing. Run it as
--   psql -v ON_ERROR_STOP=1 -f docs/runbooks/gpexe-athlete-identities-v32-rollback.sql
begin;
set local lock_timeout = '5s';
-- NOWAIT on every table whose triggers or foreign keys are dropped: a load,
-- an Unbind or an archive in flight makes this fail at once with 55P03 and
-- change nothing; run it again when quiet.
lock table training_load.gpexe_athlete_identity_requests in access exclusive mode nowait;
lock table training_load.gpexe_athlete_identities in access exclusive mode nowait;
lock table training_load.gpexe_athlete_identity_suppressions in access exclusive mode nowait;
lock table training_load.source_team_bindings in access exclusive mode nowait;
lock table training_load.source_credential_connections in access exclusive mode nowait;
lock table public.teams in access exclusive mode nowait;
lock table public.clubs in access exclusive mode nowait;

do $$
declare
  newer text;
  history integer;
begin
  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name > 'migrations_v2/202610061000_training_load_v32_gpexe_athlete_identities.sql'
     and migration_name like 'migrations_v2/%';
  if newer is not null then
    raise exception 'v32 rollback refused: later migrations are applied: %; only a forward migration is allowed', newer;
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name like '%202610061000_training_load_v32_gpexe_athlete_identities.sql') then
    raise exception 'v32 rollback refused: v32 is not recorded as applied on this database';
  end if;
  select count(*) into history from training_load.gpexe_athlete_identity_requests where status <> 'failed';
  if history > 0 then
    raise exception 'v32 rollback refused: % identity load request(s) are running or completed; only a forward migration may decide their fate', history;
  end if;
end $$;

drop trigger if exists clubs_drop_gpexe_athlete_identities on public.clubs;
drop function if exists training_load.gpexe_athlete_identities_drop_for_club();
drop trigger if exists teams_drop_gpexe_athlete_identities on public.teams;
drop function if exists training_load.gpexe_athlete_identities_drop_for_team();
drop trigger if exists source_team_bindings_drop_identities on training_load.source_team_bindings;
drop function if exists training_load.gpexe_athlete_identities_drop_for_binding();
drop function if exists training_load.purge_expired_gpexe_athlete_identities(integer);
drop function if exists training_load.purge_expired_gpexe_athlete_identity_suppressions(integer);
drop table if exists training_load.gpexe_athlete_identity_suppressions;
drop function if exists training_load.gpexe_athlete_identity_suppression_guard();
drop table if exists training_load.gpexe_athlete_identity_requests;
drop function if exists training_load.gpexe_athlete_identity_request_guard();
drop table if exists training_load.gpexe_athlete_identities;
drop function if exists training_load.gpexe_athlete_identity_no_update();
drop function if exists training_load.gpexe_athlete_identity_check();
delete from public.schema_migrations where migration_name like '%202610061000_training_load_v32_gpexe_athlete_identities.sql';
commit;
