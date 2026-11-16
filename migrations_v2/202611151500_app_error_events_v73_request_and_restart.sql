-- v73 - App health, AH-2b (the owner's request of 2026-11-15, decided by the Rukovodilac the same day): which request
-- failed, and whether an error fell around a server restart.
--
-- public.app_error_events gains five columns, all nullable and all final from the insert:
--   * request_method, request_route - for a failed request the browser reports (no answer, an answer it could not
--     read, an HTTP error status): the method as one of five words and the path as a route pattern, every id already
--     replaced by :id, no query string (the shape route_template has for the server's own rows). Browser rows only,
--     both or neither;
--   * server_uptime - how long the server process that received the report (or hit the error) had been running:
--     'lt_2m', 'lt_10m' or 'ge_10m'. "The server had just restarted" is the first;
--   * page_behind_server - for a browser row: whether the page's own build differed from the server's when the
--     report arrived (the page was loaded before a deploy). Null when either build is unknown;
--   * delivered_late - for a browser row the browser could not deliver at once (the request for it failed too) and
--     sent with a later successful call: how long it was held, 'lt_1m', 'lt_10m', 'lt_1h' or 'ge_1h'.
-- No user data: a method, a route pattern, three closed words and a boolean.
--
-- The update guard (v70's body) lists the columns that may never change; its body is replaced so the five new
-- columns are final too. The migration refuses unless the body it replaces is v70's (by md5).
--
-- No existing row is rewritten: every new column is nullable with no default. Locks: ACCESS EXCLUSIVE on
-- public.app_error_events for the column additions, held to the migration's COMMIT; the table holds at most 30 days
-- of rows, and the new CHECKs are validated in the same ALTER TABLE.
-- Rollback: docs/runbooks/app-error-events-v73-rollback.sql. Runbook: docs/runbooks/app-error-events-v73.md.

do $$
begin
  if to_regclass('public.app_error_events') is null then
    raise exception 'v73: public.app_error_events (v58) is missing' using errcode = '23514';
  end if;
  if (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'app_error_events_guard_update')
       is distinct from '13009f97dbedc04be84380baa037ce88' then
    raise exception 'v73: the update guard of app_error_events is not the one this migration replaces (v70)' using errcode = '23514';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'app_error_events'
              and column_name in ('request_method', 'request_route', 'server_uptime', 'page_behind_server', 'delivered_late')) then
    raise exception 'v73: a column of this migration already exists' using errcode = '23514';
  end if;
end $$;

alter table public.app_error_events
  add column request_method text,
  add column request_route text,
  add column server_uptime text,
  add column page_behind_server boolean,
  add column delivered_late text;

alter table public.app_error_events
  add constraint app_error_events_request_method_known check (request_method is null or request_method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  -- The shape of route_template (v58): a pattern, never a query string.
  add constraint app_error_events_request_route_shape check (request_route is null or (length(request_route) <= 120 and request_route ~ '^/[A-Za-z0-9_/:.-]*$')),
  add constraint app_error_events_request_whole check ((request_method is null) = (request_route is null)),
  add constraint app_error_events_server_uptime_known check (server_uptime is null or server_uptime in ('lt_2m', 'lt_10m', 'ge_10m')),
  add constraint app_error_events_delivered_late_known check (delivered_late is null or delivered_late in ('lt_1m', 'lt_10m', 'lt_1h', 'ge_1h')),
  -- A request, a page's build and a late delivery are facts of a browser report only.
  add constraint app_error_events_request_client_only check (
    source = 'client' or (request_method is null and request_route is null and page_behind_server is null and delivered_late is null));

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
     or new.request_method is distinct from old.request_method
     or new.request_route is distinct from old.request_route
     or new.server_uptime is distinct from old.server_uptime
     or new.page_behind_server is distinct from old.page_behind_server
     or new.delivered_late is distinct from old.delivered_late
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

comment on column public.app_error_events.request_route is
  'For a failed request the browser reports: the path as a route pattern (ids replaced by :id, no query string). Never a URL.';
comment on column public.app_error_events.server_uptime is
  'How long the server process had been running when it recorded the row: lt_2m, lt_10m or ge_10m.';
