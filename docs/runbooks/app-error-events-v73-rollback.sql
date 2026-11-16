-- Rollback of migration v73 (migrations_v2/202611151500_app_error_events_v73_request_and_restart.sql).
--
-- Not a migration and never run automatically. Rehearsed on a disposable database
-- (backend/tests/app-error-events-v73.test.mjs: apply -> rollback -> the v70 schema and guard body by md5 -> re-apply).
-- Before it is run anywhere real: the deployed commit no longer contains the v73 migration file (otherwise the migrator
-- applies it again at the next start) and no longer writes the v73 columns (the server's inserts would fail; they fail
-- quietly, but the code must go first); and the owner approved this database specifically (.claude/rules/database-safety.md).
--
-- It drops the five v73 columns of public.app_error_events (which request failed and the restart facts are
-- telemetry; the rows stay, and a row that had a request keeps the kind it was grouped under) and puts v70's update
-- guard back. It refuses, changing nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v73 is not recorded, or a migrations_v2 migration with a later file name is;
--   * the update guard's body is not the one v73 installed (by md5).
-- What is in the five columns is dropped for good: applying v73 again brings the columns back empty.
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f app-error-events-v73-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v73 rollback refused: the migrator is running';
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611151500_app_error_events_v73_request_and_restart.sql') then
    raise exception 'v73 rollback refused: v73 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611151500_app_error_events_v73_request_and_restart.sql') then
    raise exception 'v73 rollback refused: later migrations are applied';
  end if;
  -- The guard this rollback replaces must be v73's own: a body someone changed since (a hot fix) is never overwritten
  -- silently with v70's.
  if (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'app_error_events_guard_update')
       is distinct from '05cd59a40237bf6b443d268961409d93' then
    raise exception 'v73 rollback refused: the update guard is not the one v73 installed';
  end if;
end $$;

lock table public.app_error_events in access exclusive mode;

alter table public.app_error_events
  drop column request_method, drop column request_route, drop column server_uptime, drop column page_behind_server, drop column delivered_late;

create or replace function public.app_error_events_guard_update() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id
     or new.fingerprint is distinct from old.fingerprint
     or new.source is distinct from old.source
     or new.screen is distinct from old.screen
     or new.route_template is distinct from old.route_template
     or new.action is distinct from old.action
     or new.error_code is distinct from old.error_code
     or new.http_status is distinct from old.http_status
     or new.role is distinct from old.role
     or new.release_commit is distinct from old.release_commit
     or new.user_hash is distinct from old.user_hash
     or new.user_hash_version is distinct from old.user_hash_version
     or new.stack_signature is distinct from old.stack_signature
     or new.device_class is distinct from old.device_class
     or new.os_family is distinct from old.os_family
     or new.browser_family is distinct from old.browser_family
     or new.browser_major is distinct from old.browser_major
     or new.viewport_bucket is distinct from old.viewport_bucket
     or new.touch is distinct from old.touch
     or new.first_seen_at is distinct from old.first_seen_at then
    raise exception 'app_error_events: only repeat_count and last_seen_at may change' using errcode = '23514';
  end if;
  if new.repeat_count < old.repeat_count then
    raise exception 'app_error_events: repeat_count never decreases' using errcode = '23514';
  end if;
  if new.last_seen_at < old.last_seen_at or new.last_seen_at > clock_timestamp() + interval '1 minute' then
    raise exception 'app_error_events: last_seen_at never moves back and never into the future' using errcode = '23514';
  end if;
  return new;
end
$$;
revoke execute on function public.app_error_events_guard_update() from public;

delete from public.schema_migrations where migration_name = 'migrations_v2/202611151500_app_error_events_v73_request_and_restart.sql';
commit;
