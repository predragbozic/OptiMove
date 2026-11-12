-- Training Load v62 — a team's session time zone (mixed_timezones (b); the owner's decisions of 2026-11-11, relayed by the
-- Rukovodilac: option A2, a sibling table; First team's zone is Europe/Sarajevo).
--
-- A GPEXE session whose GPS units report more than one time zone is refused today (mapper mixed_timezones): the event's
-- date, time and name need one zone. With this table a platform admin sets the team's zone, and the importer uses it ONLY
-- for such a mixed session. A session whose tracks agree keeps its own zone (an away match keeps its real local time), so
-- nothing already imported changes and its preview hash stays the same. Each athlete's own track zone stays on its
-- participant row, as before.
--
-- No existing table, function or trigger changes (no md5 gate): v24's guards on gpexe_team_settings stay as they are.
--
--   * gpexe_team_session_timezones: one row per team, the zone in force (NULL = cleared), who, when and why.
--   * gpexe_team_session_timezone_history: every value the row ever had, append-only, no TRUNCATE.
--   * The zone is an IANA name PostgreSQL knows (pg_timezone_names), checked on every write; the application checks
--     it against Node's Intl as well.
--   * A write takes the team's import lock (training_load.hold_gpexe_team_lock, v24), so a zone never changes under a
--     running check, preview or approval of that team.
--
-- Rollback: docs/runbooks/team-session-timezone-v62-rollback.sql (refuses once any row exists or a later migration is
-- recorded).

create table training_load.gpexe_team_session_timezones (
  owner_team_id uuid primary key references public.teams(id) on delete restrict,
  timezone text check (timezone is null or (length(timezone) between 1 and 64 and timezone ~ '^[A-Za-z][A-Za-z0-9_+/-]*$')),
  set_by_user_id uuid not null references public.users(id) on delete restrict,
  set_at timestamptz not null default now(),
  reason text not null check (reason ~ '[^[:space:]]' and length(reason) <= 500)
);
create index gpexe_team_session_timezones_set_by_idx on training_load.gpexe_team_session_timezones (set_by_user_id);
comment on table training_load.gpexe_team_session_timezones is
  'v62: the team''s session time zone, used by the GPEXE importer only for a session whose tracks report more than one zone. NULL = cleared.';

create table training_load.gpexe_team_session_timezone_history (
  id uuid primary key default gen_random_uuid(),
  owner_team_id uuid not null references public.teams(id) on delete restrict,
  timezone text,
  set_by_user_id uuid not null references public.users(id) on delete restrict,
  set_at timestamptz not null,
  reason text not null
);
create index gpexe_team_session_timezone_history_team_idx on training_load.gpexe_team_session_timezone_history (owner_team_id, set_at desc);
create index gpexe_team_session_timezone_history_by_idx on training_load.gpexe_team_session_timezone_history (set_by_user_id);

-- The zone must be one PostgreSQL knows; the team cannot move; a write holds the team's import lock.
create function training_load.guard_gpexe_team_session_timezone() returns trigger as $$
begin
  if tg_op = 'UPDATE' and new.owner_team_id is distinct from old.owner_team_id then
    raise exception 'gpexe_team_session_timezones: the team of a session time zone is final'
      using errcode = 'check_violation', constraint = 'gpexe_team_session_timezones_team_final';
  end if;
  if new.timezone is not null and not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'gpexe_team_session_timezones: "%" is not a known time zone', new.timezone
      using errcode = 'check_violation', constraint = 'gpexe_team_session_timezones_known_zone';
  end if;
  perform training_load.hold_gpexe_team_lock(new.owner_team_id, 'session time zone change');
  return new;
end;
$$ language plpgsql;

create trigger gpexe_team_session_timezones_guard
  before insert or update on training_load.gpexe_team_session_timezones
  for each row execute function training_load.guard_gpexe_team_session_timezone();

create function training_load.record_gpexe_team_session_timezone() returns trigger as $$
begin
  insert into training_load.gpexe_team_session_timezone_history (owner_team_id, timezone, set_by_user_id, set_at, reason)
  values (new.owner_team_id, new.timezone, new.set_by_user_id, new.set_at, new.reason);
  return new;
end;
$$ language plpgsql;

create trigger gpexe_team_session_timezones_record
  after insert or update on training_load.gpexe_team_session_timezones
  for each row execute function training_load.record_gpexe_team_session_timezone();

-- The row is never deleted (clearing writes NULL, so the history keeps every step); TRUNCATE fires no row trigger.
create function training_load.refuse_gpexe_team_session_timezone_delete() returns trigger as $$
begin
  raise exception 'gpexe_team_session_timezones: a session time zone is never deleted (team %); clear it instead', old.owner_team_id;
end;
$$ language plpgsql;

create trigger gpexe_team_session_timezones_refuse_delete
  before delete on training_load.gpexe_team_session_timezones
  for each row execute function training_load.refuse_gpexe_team_session_timezone_delete();

create trigger gpexe_team_session_timezones_no_truncate
  before truncate on training_load.gpexe_team_session_timezones
  for each statement execute function training_load.gpexe_history_no_truncate();

create function training_load.gpexe_team_session_timezone_history_append_only() returns trigger as $$
begin
  raise exception 'gpexe_team_session_timezone_history is append-only';
end;
$$ language plpgsql;

create trigger gpexe_team_session_timezone_history_append_only
  before update or delete on training_load.gpexe_team_session_timezone_history
  for each row execute function training_load.gpexe_team_session_timezone_history_append_only();

create trigger gpexe_team_session_timezone_history_no_truncate
  before truncate on training_load.gpexe_team_session_timezone_history
  for each statement execute function training_load.gpexe_history_no_truncate();
