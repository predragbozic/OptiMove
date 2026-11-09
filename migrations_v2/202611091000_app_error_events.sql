-- v58 - app error tracking, backend (Option A, A1; the Rukovodilac's order of 2026-11-08/09).
--
-- One table, public.app_error_events: a SANITIZED record of an error the app hit, from the browser or from the server.
-- It holds no free text on purpose. Every text column is a closed shape enforced by a CHECK, so even a buggy writer cannot
-- store a name, an e-mail, a request body, a query string, a token, a content string or a message a source returned:
--   * screen / action / error_code - lower-case words (a-z 0-9 _ . -), at most 60 characters;
--   * route_template - a route pattern with ids already replaced by :id, no query string;
--   * stack_signature - the grammar fn@file( > fn@file){0,3} (function and file names only, no line, no message), at most 200 characters.
--     The grammar removes the accidental path (an error message put in the field is refused); it cannot stop a writer that
--     deliberately encodes words as fn@file, so the column is a bounded shape, not a proof of "no text";
--   * user_hash - 12 hex characters of a one-way hash of the user id, never the id;
--   * release_commit - 7 to 40 hex characters.
-- One row is one (user, fingerprint) pair inside a one-hour window: the same user repeating the same error raises
-- repeat_count and last_seen_at on that row (the throttle and the count in one). Only those two columns may ever change.
-- Rows are deleted by the retention purge (30 days after last_seen_at); the purge is a plain DELETE of old rows.
--
-- No row of any other table changes. The table is not in training_load: it is app-wide.
-- Rollback: docs/runbooks/app-error-events-v58-rollback.sql. Runbook: docs/runbooks/app-error-events-v58.md.

create table public.app_error_events (
  id bigint generated always as identity primary key,
  fingerprint text not null,
  source text not null,
  screen text,
  route_template text,
  action text,
  error_code text not null,
  http_status smallint,
  role text not null,
  release_commit text,
  user_hash text,
  stack_signature text,
  repeat_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint app_error_events_fingerprint_shape check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint app_error_events_source_known check (source in ('client', 'server')),
  constraint app_error_events_screen_shape check (screen is null or screen ~ '^[a-z0-9_-]{1,60}$'),
  constraint app_error_events_route_shape check (route_template is null or (length(route_template) <= 120 and route_template ~ '^/[A-Za-z0-9_/:.-]*$')),
  constraint app_error_events_action_shape check (action is null or action ~ '^[a-z0-9_.-]{1,60}$'),
  constraint app_error_events_code_shape check (error_code ~ '^[a-z0-9_.-]{1,60}$'),
  constraint app_error_events_status_range check (http_status is null or http_status between 100 and 599),
  constraint app_error_events_role_known check (role in ('platform_admin', 'coach', 'athlete', 'user', 'none')),
  constraint app_error_events_release_shape check (release_commit is null or release_commit ~ '^[0-9a-f]{7,40}$'),
  constraint app_error_events_user_hash_shape check (user_hash is null or user_hash ~ '^[0-9a-f]{12}$'),
  constraint app_error_events_stack_shape check (stack_signature is null or (length(stack_signature) <= 200 and stack_signature ~ '^[A-Za-z0-9_$.]{1,40}@[A-Za-z0-9_.-]{1,40}( > [A-Za-z0-9_$.]{1,40}@[A-Za-z0-9_.-]{1,40}){0,3}$')),
  constraint app_error_events_repeat_positive check (repeat_count >= 1),
  constraint app_error_events_times_ordered check (last_seen_at >= first_seen_at),
  constraint app_error_events_where_known check (
    (source = 'client' and screen is not null and route_template is null)
    or (source = 'server' and route_template is not null and screen is null)
  )
);

create index app_error_events_last_seen_idx on public.app_error_events (last_seen_at);
create index app_error_events_fingerprint_idx on public.app_error_events (fingerprint, last_seen_at desc);
create index app_error_events_user_window_idx on public.app_error_events (user_hash, fingerprint, last_seen_at desc) where user_hash is not null;

-- Only the count and the last-seen time may change; every other column is final from the insert.
create function public.app_error_events_guard_update() returns trigger
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

-- A raw INSERT or UPDATE cannot put a time in the future (it would defeat the 30-day purge) and last_seen_at never moves back.
create function public.app_error_events_guard_insert() returns trigger
language plpgsql as $$
begin
  if new.first_seen_at > clock_timestamp() + interval '1 minute' or new.last_seen_at > clock_timestamp() + interval '1 minute' then
    raise exception 'app_error_events: a time in the future is refused' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger app_error_events_guard_insert before insert on public.app_error_events
  for each row execute function public.app_error_events_guard_insert();

create trigger app_error_events_guard_update before update on public.app_error_events
  for each row execute function public.app_error_events_guard_update();

-- TRUNCATE is refused: the table is emptied only by the retention purge, which deletes old rows.
create function public.app_error_events_refuse_truncate() returns trigger
language plpgsql as $$
begin
  raise exception 'app_error_events: TRUNCATE is refused; the retention purge deletes old rows' using errcode = '23514';
end
$$;

create trigger app_error_events_refuse_truncate before truncate on public.app_error_events
  for each statement execute function public.app_error_events_refuse_truncate();

-- The table belongs to the application's own role only. Row-level security is on with no policy (the owner, the role the application and
-- the migrator share, is not subject to it; any other role sees nothing), nothing is granted to PUBLIC, and the trigger functions are
-- not executable by PUBLIC (a trigger needs EXECUTE only when it is created). anon / authenticated, where those roles exist
-- (Supabase), lose every privilege on the table, whatever default privileges gave them.
alter table public.app_error_events enable row level security;
revoke all on public.app_error_events from public;
revoke execute on function public.app_error_events_guard_update() from public;
revoke execute on function public.app_error_events_guard_insert() from public;
revoke execute on function public.app_error_events_refuse_truncate() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.app_error_events from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.app_error_events from authenticated';
  end if;
end $$;
