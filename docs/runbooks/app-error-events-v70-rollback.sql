-- Rollback of migration v70 (migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql).
--
-- Not a migration and never run automatically. Rehearsed on a disposable database
-- (backend/tests/app-error-events-v70.test.mjs: apply -> rollback -> the v58 schema and guard body by md5 -> re-apply).
-- Before it is run anywhere real: the deployed commit no longer contains the v70 migration file (otherwise the migrator
-- applies it again at the next start) and no longer writes the v70 columns (the server's inserts would fail; they fail
-- quietly, but the code must go first); and the owner approved this database specifically (.claude/rules/database-safety.md).
--
-- It drops the seven v70 columns of public.app_error_events (the device facts are telemetry), puts v58's update guard
-- back, drops public.app_error_person_lookups with its four functions and removes the v70 record. It refuses, changing
-- nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v70 is not recorded, or a migrations_v2 migration with a later file name is;
--   * a row carries a keyed hash (user_hash_version >= 2 with a user_hash): without the version column it would read
--     as an unkeyed hash, so from the first keyed row on v70 is forward-only (the rows age out in 30 days);
--   * a lookup is recorded: "who looked" is kept for a year and is never dropped by a rollback.
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f app-error-events-v70-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v70 rollback refused: the migrator is running';
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql') then
    raise exception 'v70 rollback refused: v70 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql') then
    raise exception 'v70 rollback refused: later migrations are applied';
  end if;
end $$;

-- Before the checks of the rows: no writer can add a keyed row or a lookup between a check and the change it guards.
lock table public.app_error_events, public.app_error_person_lookups in access exclusive mode;

do $$
begin
  if exists (select 1 from public.app_error_events where user_hash_version >= 2 and user_hash is not null) then
    raise exception 'v70 rollback refused: a keyed user hash is stored';
  end if;
  if exists (select 1 from public.app_error_person_lookups) then
    raise exception 'v70 rollback refused: a lookup is recorded';
  end if;
end $$;

alter table public.app_error_events
  drop column device_class, drop column os_family, drop column browser_family, drop column browser_major,
  drop column viewport_bucket, drop column touch, drop column user_hash_version;

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
     or new.stack_signature is distinct from old.stack_signature
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

drop table public.app_error_person_lookups;
drop function public.app_error_person_lookups_guard_insert();
drop function public.app_error_person_lookups_refuse_update();
drop function public.app_error_person_lookups_guard_delete();
drop function public.app_error_person_lookups_refuse_truncate();
delete from public.schema_migrations where migration_name = 'migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql';
commit;
