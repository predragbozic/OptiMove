-- v70 - App health, AH-1 (docs/ai/app-health-device-person-plan.md, sections 2, 4.4 and 10.1; the owner's order of
-- 2026-11-13: App health shows the device and, for a platform admin, who hit an error).
--
-- 1. public.app_error_events gains seven columns, all final from the insert:
--    * six device facts, each nullable and each a word of a closed list (or a small number / a boolean), derived and
--      reduced in the browser: device_class, os_family, browser_family, browser_major, viewport_bucket, touch.
--      The User-Agent string is never stored. A row written before v70, a server error and a report from a page that
--      predates the change keep nulls;
--    * user_hash_version: 1 is the existing unkeyed hash (every existing row), 2 and later are keyed (HMAC with a
--      server secret; the hash is computed by the server, never in SQL, so no key reaches this database).
-- 2. The update guard of v58 lists the columns that may never change; its body is replaced so the seven new columns
--    are final too. The migration refuses unless the body it replaces is v58's (by md5).
-- 3. public.app_error_person_lookups: an append-only record of every use of "Show person" (AH-3): who looked, when,
--    at which kind of error, how many people the answer named. Never a name and never a hash. A row is never changed
--    and is deleted only once it is older than one year (the retention purge).
--
-- No existing row is rewritten: the new columns are nullable, or carry a constant default (PostgreSQL stores it in
-- the catalog). Locks: ACCESS EXCLUSIVE on public.app_error_events for the column additions, held to the migration's
-- COMMIT; the table holds at most 30 days of rows, so validating the new CHECKs is short.
-- Rollback: docs/runbooks/app-error-events-v70-rollback.sql (it refuses once a keyed row exists).
-- Runbook: docs/runbooks/app-error-events-v70.md.

do $$
begin
  if to_regclass('public.app_error_events') is null then
    raise exception 'v70: public.app_error_events (v58) is missing' using errcode = '23514';
  end if;
  if (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'app_error_events_guard_update')
       is distinct from '1737e2dd01bcdb74f02a006a65cb5389' then
    raise exception 'v70: the update guard of app_error_events is not the one this migration replaces (v58)' using errcode = '23514';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'app_error_events'
              and column_name in ('device_class', 'os_family', 'browser_family', 'browser_major', 'viewport_bucket', 'touch', 'user_hash_version'))
     or to_regclass('public.app_error_person_lookups') is not null then
    raise exception 'v70: a column or table of this migration already exists' using errcode = '23514';
  end if;
end $$;

alter table public.app_error_events
  add column device_class text,
  add column os_family text,
  add column browser_family text,
  add column browser_major smallint,
  add column viewport_bucket text,
  add column touch boolean,
  add column user_hash_version smallint not null default 1;

alter table public.app_error_events
  add constraint app_error_events_device_class_known check (device_class is null or device_class in ('phone', 'tablet', 'desktop', 'unknown')),
  add constraint app_error_events_os_family_known check (os_family is null or os_family in ('ios', 'android', 'windows', 'macos', 'linux', 'chromeos', 'other')),
  add constraint app_error_events_browser_family_known check (browser_family is null or browser_family in ('safari', 'chrome', 'firefox', 'edge', 'samsung', 'webview', 'other')),
  add constraint app_error_events_browser_major_range check (browser_major is null or browser_major between 1 and 999),
  add constraint app_error_events_viewport_bucket_known check (viewport_bucket is null or viewport_bucket in ('lt_360', '360_479', '480_767', '768_1023', '1024_1439', 'ge_1440')),
  -- A server error has no browser behind it: it carries no device fact.
  add constraint app_error_events_device_client_only check (
    source = 'client' or (device_class is null and os_family is null and browser_family is null and browser_major is null and viewport_bucket is null and touch is null)),
  -- A browser's version is told only with its family.
  add constraint app_error_events_browser_major_with_family check (browser_major is null or browser_family is not null),
  add constraint app_error_events_user_hash_version_known check (user_hash_version between 1 and 999);

-- The seven new columns are final from the insert, as every other column but the count and the last-seen time.
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

-- Who looked at the people behind a kind of error ("Show person", AH-3). No name, no hash, no device: the kind of
-- error and a count only. looked_by_user_id is not a foreign key on purpose: the record outlives the account.
create table public.app_error_person_lookups (
  id bigint generated always as identity primary key,
  request_key uuid not null,
  looked_by_user_id uuid not null,
  fingerprint text not null,
  people_named integer not null,
  outcome text not null,
  -- clock_timestamp(), not now(): the insert guard compares with the clock, and a transaction may be older than a minute.
  looked_at timestamptz not null default clock_timestamp(),
  constraint app_error_person_lookups_request_key_once unique (request_key),
  constraint app_error_person_lookups_fingerprint_shape check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint app_error_person_lookups_people_range check (people_named between 0 and 20),
  constraint app_error_person_lookups_outcome_known check (outcome in ('answered', 'key_missing')),
  constraint app_error_person_lookups_named_only_when_answered check (outcome = 'answered' or people_named = 0)
);

create index app_error_person_lookups_looked_at_idx on public.app_error_person_lookups (looked_at);
create index app_error_person_lookups_user_window_idx on public.app_error_person_lookups (looked_by_user_id, looked_at desc);

create function public.app_error_person_lookups_guard_insert() returns trigger
language plpgsql as $$
begin
  if new.looked_at > clock_timestamp() + interval '1 minute' or new.looked_at < clock_timestamp() - interval '1 minute' then
    raise exception 'app_error_person_lookups: a lookup is recorded at the time it is made' using errcode = '23514';
  end if;
  return new;
end
$$;

create function public.app_error_person_lookups_refuse_update() returns trigger
language plpgsql as $$
begin
  raise exception 'app_error_person_lookups: a recorded lookup never changes' using errcode = '23514';
end
$$;

-- Deleted only by the retention purge: a row younger than one year stays.
create function public.app_error_person_lookups_guard_delete() returns trigger
language plpgsql as $$
begin
  if old.looked_at > clock_timestamp() - interval '365 days' then
    raise exception 'app_error_person_lookups: a lookup is kept for one year' using errcode = '23514';
  end if;
  return old;
end
$$;

create function public.app_error_person_lookups_refuse_truncate() returns trigger
language plpgsql as $$
begin
  raise exception 'app_error_person_lookups: TRUNCATE is refused; the retention purge deletes old rows' using errcode = '23514';
end
$$;

create trigger app_error_person_lookups_guard_insert before insert on public.app_error_person_lookups
  for each row execute function public.app_error_person_lookups_guard_insert();
create trigger app_error_person_lookups_refuse_update before update on public.app_error_person_lookups
  for each row execute function public.app_error_person_lookups_refuse_update();
create trigger app_error_person_lookups_guard_delete before delete on public.app_error_person_lookups
  for each row execute function public.app_error_person_lookups_guard_delete();
create trigger app_error_person_lookups_refuse_truncate before truncate on public.app_error_person_lookups
  for each statement execute function public.app_error_person_lookups_refuse_truncate();

-- As v58's table: the application's own role only, row-level security on with no policy, nothing for PUBLIC.
alter table public.app_error_person_lookups enable row level security;
revoke all on public.app_error_person_lookups from public;
revoke execute on function public.app_error_person_lookups_guard_insert() from public;
revoke execute on function public.app_error_person_lookups_refuse_update() from public;
revoke execute on function public.app_error_person_lookups_guard_delete() from public;
revoke execute on function public.app_error_person_lookups_refuse_truncate() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.app_error_person_lookups from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.app_error_person_lookups from authenticated';
  end if;
end $$;

comment on column public.app_error_events.user_hash_version is
  'How user_hash was made: 1 = the unkeyed sha256 of v58; 2 and later = HMAC-SHA256 with a server secret (the hash is computed by the server, never in SQL).';
comment on table public.app_error_person_lookups is
  'App health, Show person: who looked at the people behind a kind of error, when, and how many were named. Append-only; a row is kept one year. No name and no hash.';
