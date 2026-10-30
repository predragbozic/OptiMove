-- Central calendar v48 (K2a-1a): events, their types, targets, links, the
-- request record, the change log and the writer lock, in a new `calendar`
-- schema. Plan: docs/ai/central-calendar-k2a-plan.md (sections 1.2, 4, 6 and
-- 10, the owner decisions D18-D23); runbook docs/runbooks/calendar-events-v48.md;
-- rollback docs/runbooks/calendar-events-v48-rollback.sql. Lines that follow an
-- owner decision: D18 = the club_admin branch of lock_event_writer over a
-- team-owned event; D19 = the seed's default_expects; D22 = end_day.
--
-- What it builds (plan section 1.2):
--   calendar.event_types          the catalog (D4, D9): a system set and a copy
--                                 per club, seeded here and by POST /clubs;
--                                 read-only until Settings -> Calendar (K2b)
--   calendar.events               one event: owner (club / team / user, the
--                                 v4 shape), type, title, day + optional end
--                                 day, times, IANA zone, location, status
--                                 planned / cancelled, `expects` (D15), notes,
--                                 an optional reference to ONE external
--                                 schedule and ONE test schedule
--   calendar.event_targets        athlete / team / club, inside the owner
--                                 (the invariant of plan 1.2, enforced here
--                                 whoever writes)
--   calendar.event_session_links  the Builder link by SLOT KEY (plan 2.2):
--                                 plan + day + AM/PM + B/T/A + order
--   calendar.event_activity_links an activity attached by hand (K2a-1b)
--   calendar.event_requests       the requestKey record (one per command)
--   calendar.event_changes        the append-only change log, one row per
--                                 request, required at COMMIT
--   calendar.lock_event_writer()  the v25 pattern: the role rows FOR SHARE,
--                                 42501 otherwise
--
-- Rules the database keeps whoever writes: an event is never deleted (it is
-- cancelled, and a cancelled event is final); a link is never deleted (it is
-- ended); requests and changes are append-only; every table refuses
-- TRUNCATE; every write of an event bumps `revision` by exactly one; an
-- event needs at least one target at COMMIT; a request needs its change row
-- at COMMIT. Text columns use the v40 twins of backend/src/metricTextRules.js.
-- No row of any other schema is written. Rollback:
-- docs/runbooks/calendar-events-v48-rollback.sql (with the slice).

-- The foreign keys below take SHARE ROW EXCLUSIVE locks on users, clubs,
-- teams, athletes, plans.plans, training.activities and
-- training_load.external_schedules: a long transaction on one of them makes
-- this migration wait, and this bound makes it fail instead of queueing
-- behind every other writer (the runner's own transaction rolls back).
set local lock_timeout = '5s';

create schema calendar;

-- ---------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------
-- A set of expectations (D15): every element one of the three channels, no
-- duplicates; '{}' means "nothing is expected" (a meeting).
create function calendar.expects_ok(p text[]) returns boolean
  language sql immutable as $$
    select p is not null
       and not exists (select 1 from unnest(p) e where e is null or e not in ('rpe', 'device_data', 'test_result'))
       and (select count(*) from unnest(p) e) = (select count(distinct e) from unnest(p) e)
  $$;

-- Multi-line text (notes, reasons): the v40 text rule applied with line
-- breaks allowed (a line break is the one control character a note may hold).
create function calendar.multiline_text_ok(v text, max_len integer) returns boolean
  language sql immutable as $$
    select v is not null and training_load.source_metric_text_ok(replace(v, E'\n', ' '), max_len)
  $$;

-- A change's details: a JSON object whose values are scalars or arrays of
-- scalars (ids, the before / after of a column) — never a nested object.
create function calendar.details_ok(d jsonb) returns boolean
  language sql immutable as $$
    select d is not null and jsonb_typeof(d) = 'object'
       and not exists (
         select 1 from jsonb_each(d) kv
          where jsonb_typeof(kv.value) = 'object'
             or (jsonb_typeof(kv.value) = 'array'
                 and exists (select 1 from jsonb_array_elements(kv.value) el where jsonb_typeof(el) in ('object', 'array'))))
  $$;

create function calendar.refuse_change() returns trigger language plpgsql as $$
begin
  raise exception 'calendar.%: % is refused, the table is append-only', tg_table_name, tg_op using errcode = '23514';
end $$;

create function calendar.refuse_delete() returns trigger language plpgsql as $$
begin
  raise exception 'calendar.%: rows are never deleted (an event is cancelled, a link is ended)', tg_table_name using errcode = '23514';
end $$;

create function calendar.refuse_truncate() returns trigger language plpgsql as $$
begin
  raise exception 'calendar.%: TRUNCATE is refused', tg_table_name using errcode = '23514';
end $$;

-- ---------------------------------------------------------------------------
-- 1. Event types (D2, D4, D9)
-- ---------------------------------------------------------------------------
create table calendar.event_types (
  id                  uuid primary key default gen_random_uuid(),
  owner_scope         varchar(20) not null
                      constraint event_types_owner_scope_check check (owner_scope in ('system', 'club')),
  -- A club's copy goes with the club: the application only archives clubs,
  -- but a hard delete of a club (maintenance, the shared test suites'
  -- cleanup) must not be stopped by its unused type copies; a copy in use is
  -- kept by events.event_type_id's own RESTRICT, which then stops the club's
  -- delete too — the same way its events do.
  owner_club_id       uuid references public.clubs(id) on delete cascade,
  -- The base kind decides the default expectations (D9); write-once.
  kind                varchar(20) not null
                      constraint event_types_kind_check check (kind in ('training', 'match', 'travel', 'meeting', 'day_off', 'camp', 'test')),
  key                 text not null
                      constraint event_types_key_check check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label               text not null
                      constraint event_types_label_check check (training_load.source_metric_text_ok(label, 60)),
  default_expects     text[] not null default '{}'
                      constraint event_types_default_expects_check check (calendar.expects_ok(default_expects)),
  -- The icon library's key (frontend/icon-library.js); set by K2b.
  icon_key            text
                      constraint event_types_icon_key_check check (icon_key is null or icon_key ~ '^[a-z0-9][a-z0-9-]{0,60}$'),
  sort_order          integer not null default 0,
  -- A seeded row carries its seed key (K0 LOW-5): seeded once, never on
  -- read; a club's archived default never comes back (K2b archives a seeded
  -- row, it never deletes one).
  seed_key            text
                      constraint event_types_seed_key_check check (seed_key is null or seed_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  archived_at         timestamptz,
  archived_by_user_id uuid references public.users(id) on delete restrict,
  created_by_user_id  uuid references public.users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint event_types_owner_shape check (
    (owner_scope = 'system' and owner_club_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null)),
  constraint event_types_archive_shape check ((archived_at is null) = (archived_by_user_id is null))
);
create unique index event_types_owner_key_key
  on calendar.event_types (owner_scope, owner_club_id, key) nulls not distinct;
create unique index event_types_owner_seed_key_key
  on calendar.event_types (owner_scope, owner_club_id, seed_key) nulls not distinct where seed_key is not null;
create unique index event_types_owner_label_live_key
  on calendar.event_types (owner_scope, owner_club_id, lower(label)) nulls not distinct where archived_at is null;
create index event_types_owner_idx on calendar.event_types (owner_scope, owner_club_id);

create function calendar.event_types_before_write() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.kind is distinct from old.kind then
      raise exception 'calendar.event_types: kind is write-once' using errcode = '23514';
    end if;
    if new.owner_scope is distinct from old.owner_scope or new.owner_club_id is distinct from old.owner_club_id then
      raise exception 'calendar.event_types: the owner is write-once' using errcode = '23514';
    end if;
    if new.seed_key is distinct from old.seed_key then
      raise exception 'calendar.event_types: seed_key is write-once' using errcode = '23514';
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger event_types_before_write
  before insert or update on calendar.event_types
  for each row execute function calendar.event_types_before_write();

-- K2a has no route that edits a type: until Settings -> Calendar (K2b) the
-- catalog is read-only whoever writes. K2b's migration drops this trigger. A
-- DELETE is not guarded here: a type in use is kept by the events' RESTRICT
-- foreign key, and an unused copy goes with its club (above); K2b's rule that
-- a seeded default is archived, never deleted, is K2b's service.
create function calendar.event_types_k2a_read_only() returns trigger language plpgsql as $$
begin
  raise exception 'calendar.event_types: % is refused until Settings -> Calendar exists (K2b)', tg_op using errcode = '23514';
end $$;
create trigger event_types_k2a_read_only
  before update on calendar.event_types
  for each row execute function calendar.event_types_k2a_read_only();
-- The system set is the parent of every club's copy (seed_club_event_types)
-- and the only set a private coach uses: its rows are never deleted,
-- whoever writes. A club's copies still go with their club (the cascade
-- above only ever deletes rows of owner_scope 'club').
create function calendar.event_types_system_final() returns trigger language plpgsql as $$
begin
  if old.owner_scope = 'system' then
    raise exception 'calendar.event_types: a system type is never deleted' using errcode = '23514';
  end if;
  return old;
end $$;
create trigger event_types_system_final
  before delete on calendar.event_types
  for each row execute function calendar.event_types_system_final();
create trigger event_types_no_truncate
  before truncate on calendar.event_types
  for each statement execute function calendar.refuse_truncate();

-- ---------------------------------------------------------------------------
-- 2. Events
-- ---------------------------------------------------------------------------
create table calendar.events (
  id                    uuid primary key default gen_random_uuid(),
  -- The owner (ADR-002): the active workspace at create (D4 club, D6 team,
  -- D7 private coach); never 'system' (plan choice 9.11).
  owner_scope           varchar(20) not null
                        constraint events_owner_scope_check check (owner_scope in ('club', 'team', 'user')),
  owner_user_id         uuid references public.users(id) on delete restrict,
  owner_club_id         uuid references public.clubs(id) on delete restrict,
  owner_team_id         uuid references public.teams(id) on delete restrict,
  event_type_id         uuid not null references calendar.event_types(id) on delete restrict,
  title                 text not null
                        constraint events_title_check check (training_load.source_metric_text_ok(title, 120)),
  -- Local days, as plans.plan_days.date and activities.occurred_local_date;
  -- end_day for a camp, a trip, a day off that spans days (plan choice 9.7).
  day                   date not null,
  end_day               date
                        constraint events_end_day_check check (end_day is null or end_day >= day),
  start_time            time,
  end_time              time,
  -- IANA, validated by trigger (the v4 rule); stored for later use, the
  -- read keeps local days.
  timezone              varchar(64) not null,
  location              text
                        constraint events_location_check check (location is null or training_load.source_metric_text_ok(location, 120)),
  status                varchar(10) not null default 'planned'
                        constraint events_status_check check (status in ('planned', 'cancelled')),
  cancelled_at          timestamptz,
  cancelled_by_user_id  uuid references public.users(id) on delete restrict,
  cancel_reason         text
                        constraint events_cancel_reason_check check (cancel_reason is null or calendar.multiline_text_ok(cancel_reason, 500)),
  -- D15: what the event expects, copied from the type at create, editable.
  expects               text[] not null default '{}'
                        constraint events_expects_check check (calendar.expects_ok(expects)),
  -- Coach-internal; never in the athlete's answer.
  notes                 text
                        constraint events_notes_check check (notes is null or calendar.multiline_text_ok(notes, 2000)),
  -- Plan 1.1 option (a): the RPE collection and the test the event refers to.
  external_schedule_id  uuid references training_load.external_schedules(id) on delete restrict,
  -- A trigger-checked reference to tests.test_schedules (plan choice 9.13):
  -- the shared disposable fixture carries no Tests schema, so an FK would
  -- stop every suite that applies the whole migration list.
  test_schedule_id      uuid,
  -- +1 on every write of this row (expectedRevision of the edit routes).
  revision              integer not null default 1
                        constraint events_revision_check check (revision >= 1),
  created_by_user_id    uuid not null references public.users(id) on delete restrict,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint events_owner_shape check (
    (owner_scope = 'user' and owner_user_id is not null and owner_club_id is null     and owner_team_id is null) or
    (owner_scope = 'club' and owner_club_id is not null and owner_user_id is null     and owner_team_id is null) or
    (owner_scope = 'team' and owner_team_id is not null and owner_user_id is null     and owner_club_id is null)),
  -- A span of at most a year (a camp, a trip; never a stray date).
  constraint events_span_check check (end_day is null or end_day <= day + 366),
  -- An end needs a start; on a one-day event (no end_day, or end_day = day)
  -- the end is after the start.
  constraint events_time_shape check (
    end_time is null or (start_time is not null and ((end_day is not null and end_day > day) or end_time > start_time))),
  constraint events_cancel_shape check (
    (status = 'planned'   and cancelled_at is null     and cancelled_by_user_id is null     and cancel_reason is null) or
    (status = 'cancelled' and cancelled_at is not null and cancelled_by_user_id is not null))
);
create index events_owner_idx on calendar.events (owner_scope, owner_club_id, owner_team_id, owner_user_id);
-- Plain indexes for the foreign keys' own lookups (a parent's delete or
-- update checks them; the composite above is led by owner_scope).
create index events_owner_club_idx on calendar.events (owner_club_id) where owner_club_id is not null;
create index events_owner_team_idx on calendar.events (owner_team_id) where owner_team_id is not null;
create index events_owner_user_idx on calendar.events (owner_user_id) where owner_user_id is not null;
create index events_external_schedule_idx on calendar.events (external_schedule_id) where external_schedule_id is not null;
create index events_day_idx on calendar.events (day);
create index events_end_day_idx on calendar.events (end_day) where end_day is not null;
create index events_type_idx on calendar.events (event_type_id);
create unique index events_one_planned_per_external_schedule
  on calendar.events (external_schedule_id) where external_schedule_id is not null and status = 'planned';
create unique index events_one_planned_per_test_schedule
  on calendar.events (test_schedule_id) where test_schedule_id is not null and status = 'planned';

create function calendar.events_before_write() returns trigger language plpgsql as $$
declare
  v_type record;
  v_owner_club uuid;
begin
  if tg_op = 'UPDATE' then
    if old.status = 'cancelled' then
      raise exception 'calendar.events: a cancelled event is final' using errcode = '23514';
    end if;
    if new.owner_scope is distinct from old.owner_scope or new.owner_user_id is distinct from old.owner_user_id
       or new.owner_club_id is distinct from old.owner_club_id or new.owner_team_id is distinct from old.owner_team_id then
      raise exception 'calendar.events: the owner is write-once' using errcode = '23514';
    end if;
    if new.created_by_user_id is distinct from old.created_by_user_id or new.created_at is distinct from old.created_at then
      raise exception 'calendar.events: the creation facts are write-once' using errcode = '23514';
    end if;
    if new.revision <> old.revision + 1 then
      raise exception 'calendar.events: revision must increase by exactly one on every write' using errcode = '23514';
    end if;
    new.updated_at := now();
  elsif new.revision <> 1 then
    raise exception 'calendar.events: a new event has revision 1' using errcode = '23514';
  end if;

  -- The references are validated when they are SET or CHANGED, never again
  -- on every later write: a test schedule the Tests module deleted, or a
  -- team moved to another club, must never make the event uncancellable.
  if tg_op = 'INSERT' or new.timezone is distinct from old.timezone then
    if not exists (select 1 from pg_timezone_names where name = new.timezone) then
      raise exception 'calendar.events: timezone is not a recognized IANA name' using errcode = '23514';
    end if;
  end if;

  select t.owner_scope, t.owner_club_id, t.kind, t.archived_at
    into v_type
    from calendar.event_types t where t.id = new.event_type_id;
  if not found then
    raise exception 'calendar.events: event_type_id names no event type' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' or new.event_type_id is distinct from old.event_type_id then
    if v_type.archived_at is not null then
      raise exception 'calendar.events: an archived event type takes no new event' using errcode = '23514';
    end if;
    v_owner_club := case new.owner_scope
                      when 'club' then new.owner_club_id
                      when 'team' then (select t.club_id from public.teams t where t.id = new.owner_team_id)
                      else null end;
    if not (v_type.owner_scope = 'system'
            or (v_type.owner_scope = 'club' and v_owner_club is not null and v_type.owner_club_id = v_owner_club)) then
      raise exception 'calendar.events: the event type belongs to another owner' using errcode = '23514';
    end if;
  end if;

  if new.test_schedule_id is not null
     and (tg_op = 'INSERT' or new.test_schedule_id is distinct from old.test_schedule_id or new.event_type_id is distinct from old.event_type_id) then
    if v_type.kind <> 'test' then
      raise exception 'calendar.events: a test schedule can be referenced only by an event of kind test' using errcode = '23514';
    end if;
    if (tg_op = 'INSERT' or new.test_schedule_id is distinct from old.test_schedule_id)
       and not exists (select 1 from tests.test_schedules s where s.id = new.test_schedule_id) then
      raise exception 'calendar.events: test_schedule_id names no test schedule' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger events_before_write
  before insert or update on calendar.events
  for each row execute function calendar.events_before_write();
create trigger events_no_delete
  before delete on calendar.events
  for each row execute function calendar.refuse_delete();
create trigger events_no_truncate
  before truncate on calendar.events
  for each statement execute function calendar.refuse_truncate();

-- The audit is complete or the write is not, in BOTH directions: every
-- insert or update of an event needs, at COMMIT, a change row that names the
-- event at the revision the write left (section 7 adds the other direction,
-- a request needs its change). A raw write without its audit cannot be
-- committed. The link tables of K2a-1b get their own pairing with their
-- commands (recorded in the plan).
create function calendar.events_need_change() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from calendar.event_changes c where c.event_id = new.id and c.revision = new.revision) then
    raise exception 'calendar.events: a write needs its change row (event, revision) in the same transaction' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger events_need_change
  after insert or update on calendar.events
  deferrable initially deferred
  for each row execute function calendar.events_need_change();

-- ---------------------------------------------------------------------------
-- 3. Targets (plan 1.2: the invariant, whoever writes)
-- ---------------------------------------------------------------------------
create table calendar.event_targets (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references calendar.events(id) on delete restrict,
  target_kind       varchar(10) not null
                    constraint event_targets_kind_check check (target_kind in ('athlete', 'team', 'club')),
  target_athlete_id uuid references public.athletes(id) on delete restrict,
  target_team_id    uuid references public.teams(id) on delete restrict,
  target_club_id    uuid references public.clubs(id) on delete restrict,
  created_at        timestamptz not null default now(),
  constraint event_targets_shape check (
    (target_kind = 'athlete' and target_athlete_id is not null and target_team_id is null     and target_club_id is null) or
    (target_kind = 'team'    and target_team_id is not null    and target_athlete_id is null  and target_club_id is null) or
    (target_kind = 'club'    and target_club_id is not null    and target_athlete_id is null  and target_team_id is null)),
  constraint event_targets_one_per_target unique nulls not distinct (event_id, target_kind, target_athlete_id, target_team_id, target_club_id)
);
create index event_targets_event_idx on calendar.event_targets (event_id);
create index event_targets_athlete_idx on calendar.event_targets (target_athlete_id) where target_athlete_id is not null;
create index event_targets_team_idx on calendar.event_targets (target_team_id) where target_team_id is not null;
create index event_targets_club_idx on calendar.event_targets (target_club_id) where target_club_id is not null;

create function calendar.event_targets_before_insert() returns trigger language plpgsql as $$
declare
  v_event record;
  v_team record;
begin
  select e.owner_scope, e.owner_user_id, e.owner_club_id, e.owner_team_id, e.status
    into v_event from calendar.events e where e.id = new.event_id;
  if not found then
    raise exception 'calendar.event_targets: event_id names no event' using errcode = '23514';
  end if;
  if v_event.status <> 'planned' then
    raise exception 'calendar.event_targets: a cancelled event is final' using errcode = '23514';
  end if;
  if v_event.owner_scope = 'club' then
    if new.target_kind = 'club' and new.target_club_id <> v_event.owner_club_id then
      raise exception 'calendar.event_targets: a club-owned event targets its own club only' using errcode = '23514';
    end if;
    if new.target_kind = 'team' then
      select t.club_id, coalesce(t.is_active, true) as active into v_team from public.teams t where t.id = new.target_team_id;
      if not found or v_team.club_id is distinct from v_event.owner_club_id or not v_team.active then
        raise exception 'calendar.event_targets: a club-owned event targets an active team of its own club only' using errcode = '23514';
      end if;
    end if;
    -- The periods of v25 carry club_id for club and team memberships alike,
    -- so one condition covers a club member and a member of one of its teams.
    if new.target_kind = 'athlete' and not exists (
         select 1 from public.athlete_membership_periods mp
          where mp.athlete_id = new.target_athlete_id and mp.club_id = v_event.owner_club_id) then
      raise exception 'calendar.event_targets: a club-owned event targets a member of the club only' using errcode = '23514';
    end if;
  elsif v_event.owner_scope = 'team' then
    if new.target_kind = 'club' or (new.target_kind = 'team' and new.target_team_id <> v_event.owner_team_id) then
      raise exception 'calendar.event_targets: a team-owned event targets its own team or its members only' using errcode = '23514';
    end if;
    if new.target_kind = 'athlete' and not exists (
         select 1 from public.athlete_membership_periods mp
          where mp.athlete_id = new.target_athlete_id and mp.membership_type = 'team' and mp.team_id = v_event.owner_team_id) then
      raise exception 'calendar.event_targets: a team-owned event targets its own team or its members only' using errcode = '23514';
    end if;
  else
    -- The coach relationship, as every private-coach access check of the
    -- application reads it.
    if new.target_kind <> 'athlete' or not exists (
         select 1 from public.user_athletes ua
          where ua.user_id = v_event.owner_user_id and ua.athlete_id = new.target_athlete_id
            and ua.relationship_type = 'coach' and ua.is_active = true) then
      raise exception 'calendar.event_targets: a private coach''s event targets their own athletes only' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger event_targets_before_insert
  before insert on calendar.event_targets
  for each row execute function calendar.event_targets_before_insert();
-- A target is replaced (deleted and inserted again inside the edit's
-- transaction), never updated; a cancelled event's targets are final too.
create trigger event_targets_no_update
  before update on calendar.event_targets
  for each row execute function calendar.refuse_change();
create function calendar.event_targets_before_delete() returns trigger language plpgsql as $$
begin
  if exists (select 1 from calendar.events e where e.id = old.event_id and e.status <> 'planned') then
    raise exception 'calendar.event_targets: a cancelled event is final' using errcode = '23514';
  end if;
  return old;
end $$;
create trigger event_targets_before_delete
  before delete on calendar.event_targets
  for each row execute function calendar.event_targets_before_delete();
create trigger event_targets_no_truncate
  before truncate on calendar.event_targets
  for each statement execute function calendar.refuse_truncate();

-- At COMMIT an event has at least one target (a new event, and an edit that
-- replaced the targets).
-- Two functions, one per table: a trigger function resolves NEW / OLD at
-- run time against the row type of its own table.
create function calendar.event_has_target(p_event_id uuid) returns boolean language sql stable as $$
  select exists (select 1 from calendar.event_targets tg where tg.event_id = p_event_id)
$$;
create function calendar.events_need_target_after_insert() returns trigger language plpgsql as $$
begin
  if not calendar.event_has_target(new.id) then
    raise exception 'calendar.events: an event needs at least one target' using errcode = '23514';
  end if;
  return null;
end $$;
create function calendar.event_targets_need_target_after_delete() returns trigger language plpgsql as $$
begin
  if not calendar.event_has_target(old.event_id) then
    raise exception 'calendar.events: an event needs at least one target' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger events_need_target_insert
  after insert on calendar.events
  deferrable initially deferred
  for each row execute function calendar.events_need_target_after_insert();
create constraint trigger event_targets_need_target_delete
  after delete on calendar.event_targets
  deferrable initially deferred
  for each row execute function calendar.event_targets_need_target_after_delete();

-- ---------------------------------------------------------------------------
-- 4. The Builder link, by slot key (plan 2.2, choice 9.9)
-- ---------------------------------------------------------------------------
create table calendar.event_session_links (
  id                          uuid primary key default gen_random_uuid(),
  event_id                    uuid not null references calendar.events(id) on delete restrict,
  -- The live plan; a deleted plan leaves the link orphaned (plan_id null,
  -- counted by the read), never silently gone.
  plan_id                     uuid references plans.plans(id) on delete set null,
  day                         date not null,
  am_pm                       text,
  bta                         text,
  session_order               integer not null default 0
                              constraint event_session_links_order_check check (session_order >= 0),
  -- Information only: the session as it was when linked.
  logical_session_id_at_link  uuid,
  session_name_at_link        text
                              constraint event_session_links_name_check check (session_name_at_link is null or training_load.source_metric_text_ok(session_name_at_link, 120)),
  linked_by_user_id           uuid not null references public.users(id) on delete restrict,
  linked_at                   timestamptz not null default now(),
  ended_at                    timestamptz,
  ended_by_user_id            uuid references public.users(id) on delete restrict,
  constraint event_session_links_end_shape check ((ended_at is null) = (ended_by_user_id is null))
);
create unique index event_session_links_one_live_per_slot
  on calendar.event_session_links (plan_id, day, am_pm, bta, session_order) nulls not distinct
  where ended_at is null and plan_id is not null;
create index event_session_links_event_idx on calendar.event_session_links (event_id) where ended_at is null;
-- The plan's ON DELETE SET NULL looks the links up by plan_id alone.
create index event_session_links_plan_idx on calendar.event_session_links (plan_id) where plan_id is not null;

create function calendar.event_session_links_before_write() returns trigger language plpgsql as $$
declare
  v_event record;
begin
  if tg_op = 'UPDATE' then
    -- Only two changes are allowed: ending the link once, and the plan's
    -- deletion setting plan_id to null (the FK's own UPDATE).
    if new.event_id is distinct from old.event_id or new.day is distinct from old.day
       or new.am_pm is distinct from old.am_pm or new.bta is distinct from old.bta or new.session_order is distinct from old.session_order
       or new.logical_session_id_at_link is distinct from old.logical_session_id_at_link
       or new.session_name_at_link is distinct from old.session_name_at_link
       or new.linked_by_user_id is distinct from old.linked_by_user_id or new.linked_at is distinct from old.linked_at then
      raise exception 'calendar.event_session_links: a link is ended, never changed' using errcode = '23514';
    end if;
    if new.plan_id is distinct from old.plan_id and new.plan_id is not null then
      raise exception 'calendar.event_session_links: plan_id may only be cleared by the plan''s deletion' using errcode = '23514';
    end if;
    if old.ended_at is not null and (new.ended_at is distinct from old.ended_at or new.ended_by_user_id is distinct from old.ended_by_user_id) then
      raise exception 'calendar.event_session_links: an ended link is final' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.plan_id is null or new.ended_at is not null then
    raise exception 'calendar.event_session_links: a new link names a plan and is live' using errcode = '23514';
  end if;
  select e.status, e.day, e.end_day into v_event from calendar.events e where e.id = new.event_id;
  if not found or v_event.status <> 'planned' then
    raise exception 'calendar.event_session_links: only a planned event takes a link' using errcode = '23514';
  end if;
  if new.day < v_event.day or new.day > coalesce(v_event.end_day, v_event.day) then
    raise exception 'calendar.event_session_links: the session''s day is outside the event''s days' using errcode = '23514';
  end if;
  -- The slot names a session of a live, published weekly plan on that day
  -- (the WEEKLY_PLAN_SESSION_FILTER_SQL rule of backend/src/trainingLoadAccess.js).
  if not exists (
       select 1
         from plans.plans p
         join plans.plan_days pd on pd.plan_id = p.id
         join plans.plan_sessions ps on ps.plan_day_id = pd.id
        where p.id = new.plan_id and p.plan_type = 'weekly' and p.status = 'active'
          and coalesce(p.is_active, true) and not coalesce(p.is_edit_draft, false)
          and pd.date = new.day
          and ps.am_pm is not distinct from new.am_pm and ps.bta is not distinct from new.bta
          and ps.session_order = new.session_order) then
    raise exception 'calendar.event_session_links: the slot names no published session' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger event_session_links_before_write
  before insert or update on calendar.event_session_links
  for each row execute function calendar.event_session_links_before_write();
create trigger event_session_links_no_delete
  before delete on calendar.event_session_links
  for each row execute function calendar.refuse_delete();
create trigger event_session_links_no_truncate
  before truncate on calendar.event_session_links
  for each statement execute function calendar.refuse_truncate();

-- ---------------------------------------------------------------------------
-- 5. The activity link (plan 1.2, choice 9.8; attached by hand in K2a-1b)
-- ---------------------------------------------------------------------------
create table calendar.event_activity_links (
  id                 uuid primary key default gen_random_uuid(),
  event_id           uuid not null references calendar.events(id) on delete restrict,
  activity_id        uuid not null references training.activities(id) on delete restrict,
  link_method        varchar(10) not null default 'manual'
                     constraint event_activity_links_method_check check (link_method in ('manual', 'automatic')),
  linked_by_user_id  uuid not null references public.users(id) on delete restrict,
  linked_at          timestamptz not null default now(),
  ended_at           timestamptz,
  ended_by_user_id   uuid references public.users(id) on delete restrict,
  constraint event_activity_links_end_shape check ((ended_at is null) = (ended_by_user_id is null))
);
create unique index event_activity_links_one_live_per_activity
  on calendar.event_activity_links (activity_id) where ended_at is null;
create index event_activity_links_event_idx on calendar.event_activity_links (event_id) where ended_at is null;
create index event_activity_links_activity_idx on calendar.event_activity_links (activity_id);

create function calendar.event_activity_links_before_write() returns trigger language plpgsql as $$
declare
  v_event record;
  v_activity record;
begin
  if tg_op = 'UPDATE' then
    if new.event_id is distinct from old.event_id or new.activity_id is distinct from old.activity_id
       or new.link_method is distinct from old.link_method
       or new.linked_by_user_id is distinct from old.linked_by_user_id or new.linked_at is distinct from old.linked_at then
      raise exception 'calendar.event_activity_links: a link is ended, never changed' using errcode = '23514';
    end if;
    if old.ended_at is not null then
      raise exception 'calendar.event_activity_links: an ended link is final' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.ended_at is not null then
    raise exception 'calendar.event_activity_links: a new link is live' using errcode = '23514';
  end if;
  select e.status, e.day, e.end_day into v_event from calendar.events e where e.id = new.event_id;
  if not found or v_event.status <> 'planned' then
    raise exception 'calendar.event_activity_links: only a planned event takes a link' using errcode = '23514';
  end if;
  select a.lifecycle_state, a.occurred_local_date into v_activity from training.activities a where a.id = new.activity_id;
  if not found or v_activity.lifecycle_state = 'superseded' then
    raise exception 'calendar.event_activity_links: only a canonical activity can be linked' using errcode = '23514';
  end if;
  if v_activity.occurred_local_date < v_event.day or v_activity.occurred_local_date > coalesce(v_event.end_day, v_event.day) then
    raise exception 'calendar.event_activity_links: the activity''s day is outside the event''s days' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger event_activity_links_before_write
  before insert or update on calendar.event_activity_links
  for each row execute function calendar.event_activity_links_before_write();
create trigger event_activity_links_no_delete
  before delete on calendar.event_activity_links
  for each row execute function calendar.refuse_delete();
create trigger event_activity_links_no_truncate
  before truncate on calendar.event_activity_links
  for each statement execute function calendar.refuse_truncate();

-- ---------------------------------------------------------------------------
-- 6. The request record (requestKey; the v25 / v36 pattern)
-- ---------------------------------------------------------------------------
create table calendar.event_requests (
  id                    uuid primary key default gen_random_uuid(),
  request_key           uuid not null,
  request_hash          text not null
                        constraint event_requests_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  operation             varchar(20) not null
                        constraint event_requests_operation_check check (operation in (
                          'create', 'update', 'cancel', 'attach_sessions', 'detach_sessions',
                          'attach_activity', 'detach_activity', 'set_schedule', 'clear_schedule')),
  performed_by_user_id  uuid not null references public.users(id) on delete restrict,
  event_id              uuid not null references calendar.events(id) on delete restrict,
  result                jsonb not null
                        constraint event_requests_result_check check (jsonb_typeof(result) = 'object'),
  created_at            timestamptz not null default now(),
  constraint event_requests_one_per_key unique (performed_by_user_id, request_key)
);
create index event_requests_event_idx on calendar.event_requests (event_id);
create trigger event_requests_append_only
  before update or delete on calendar.event_requests
  for each row execute function calendar.refuse_change();
create trigger event_requests_no_truncate
  before truncate on calendar.event_requests
  for each statement execute function calendar.refuse_truncate();

-- ---------------------------------------------------------------------------
-- 7. The change log (append-only; one row per request, required at COMMIT)
-- ---------------------------------------------------------------------------
create table calendar.event_changes (
  id                    uuid primary key default gen_random_uuid(),
  event_id              uuid not null references calendar.events(id) on delete restrict,
  kind                  varchar(20) not null
                        constraint event_changes_kind_check check (kind in (
                          'create', 'update', 'cancel', 'attach_sessions', 'detach_sessions',
                          'attach_activity', 'detach_activity', 'set_schedule', 'clear_schedule')),
  basis                 varchar(20) not null
                        constraint event_changes_basis_check check (basis in ('platform_admin', 'club_admin', 'team_coach', 'private_coach')),
  performed_by_user_id  uuid not null references public.users(id) on delete restrict,
  performed_at          timestamptz not null default now(),
  reason                text
                        constraint event_changes_reason_check check (reason is null or calendar.multiline_text_ok(reason, 500)),
  -- Flat facts: ids and the before / after of changed columns, never a name.
  details               jsonb not null default '{}'::jsonb
                        constraint event_changes_details_check check (calendar.details_ok(details)),
  request_id            uuid not null references calendar.event_requests(id) on delete restrict,
  -- The event's revision after this change.
  revision              integer not null
                        constraint event_changes_revision_check check (revision >= 1),
  constraint event_changes_one_per_request unique (request_id)
);
create index event_changes_event_idx on calendar.event_changes (event_id, performed_at);

create function calendar.event_changes_before_insert() returns trigger language plpgsql as $$
declare
  v_request record;
  v_revision integer;
begin
  select r.event_id, r.operation, r.performed_by_user_id into v_request from calendar.event_requests r where r.id = new.request_id;
  if not found then
    raise exception 'calendar.event_changes: request_id names no request' using errcode = '23514';
  end if;
  if v_request.event_id <> new.event_id or v_request.operation <> new.kind or v_request.performed_by_user_id <> new.performed_by_user_id then
    raise exception 'calendar.event_changes: the change does not match its request' using errcode = '23514';
  end if;
  select e.revision into v_revision from calendar.events e where e.id = new.event_id;
  if v_revision is distinct from new.revision then
    raise exception 'calendar.event_changes: revision must be the event''s current revision' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger event_changes_before_insert
  before insert on calendar.event_changes
  for each row execute function calendar.event_changes_before_insert();
create trigger event_changes_append_only
  before update or delete on calendar.event_changes
  for each row execute function calendar.refuse_change();
create trigger event_changes_no_truncate
  before truncate on calendar.event_changes
  for each statement execute function calendar.refuse_truncate();

-- A request without its change row cannot be committed (the v35 idea, the
-- v25 shape): the audit is complete or the write is not.
create function calendar.event_requests_need_change() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from calendar.event_changes c where c.request_id = new.id) then
    raise exception 'calendar.event_requests: a request must have its change row in the same transaction' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger event_requests_need_change
  after insert on calendar.event_requests
  deferrable initially deferred
  for each row execute function calendar.event_requests_need_change();

-- ---------------------------------------------------------------------------
-- 8. The writer lock (plan 4.1 / 4.3; the v25 training.lock_activity_decider pattern)
-- ---------------------------------------------------------------------------
-- Locks the owner's rows and the role rows the basis rests on FOR SHARE for
-- the rest of the transaction, so a role revoked or an owner archived
-- meanwhile waits behind the write and a write never lands on a revoked
-- role. The order is v25 / v26's (training.lock_activity_decider and the
-- roster's team → club → role → user): the owner team, then its club (both
-- active), then the role row, then the acting user's row. Bases:
--   platform_admin  an active platform admin; any owner, a private coach's
--                   events included (support, plan 4.1)
--   club_admin      the active admin of the owner club, or of the owner
--                   TEAM's club (owner decision D18)
--   team_coach      an active coach of the owner team
--   private_coach   the owner user themself, an active independent coach
--                   (public.user_global_roles, the fact authz.isIndependentCoach reads)
-- 42501 for everything else; the service answers the identical 404 (ADR-006).
create function calendar.lock_event_writer(p_user_id uuid, p_owner_scope varchar, p_owner_id uuid, p_basis varchar)
returns varchar language plpgsql as $$
declare
  v_club_id uuid;
begin
  if p_basis is null or p_basis not in ('platform_admin', 'club_admin', 'team_coach', 'private_coach') then
    raise exception 'lock_event_writer: unknown basis %', p_basis using errcode = 'invalid_parameter_value';
  end if;
  if p_owner_scope is null or p_owner_scope not in ('club', 'team', 'user') or p_owner_id is null then
    raise exception 'lock_event_writer: unknown owner' using errcode = 'invalid_parameter_value';
  end if;

  -- 1. The owner: the team (active), then its club (active); a club; a user.
  if p_owner_scope = 'team' then
    select t.club_id into v_club_id from public.teams t where t.id = p_owner_id and coalesce(t.is_active, true) for share;
    if not found then
      raise exception 'user % may not write the events of a team that is not active', p_user_id using errcode = 'insufficient_privilege';
    end if;
  elsif p_owner_scope = 'club' then
    v_club_id := p_owner_id;
  end if;
  if v_club_id is not null then
    perform 1 from public.clubs c where c.id = v_club_id and coalesce(c.is_active, true) for share;
    if not found then
      raise exception 'user % may not write the events of a club that is not active', p_user_id using errcode = 'insufficient_privilege';
    end if;
  end if;
  if p_owner_scope = 'user' and p_basis <> 'platform_admin' and p_owner_id <> p_user_id then
    raise exception 'user % may not write another coach''s events', p_user_id using errcode = 'insufficient_privilege';
  end if;

  -- 2. The role row of the basis.
  if p_basis = 'platform_admin' then
    perform 1 from public.user_global_roles r
     where r.user_id = p_user_id and r.role = 'platform_admin' and r.is_active = true
       for share;
  elsif p_basis = 'club_admin' then
    if v_club_id is null then
      raise exception 'user % may not write these events as club_admin', p_user_id using errcode = 'insufficient_privilege';
    end if;
    perform 1 from public.user_club_roles r
     where r.user_id = p_user_id and r.club_id = v_club_id and r.role = 'club_admin' and r.is_active = true
       for share;
  elsif p_basis = 'team_coach' then
    if p_owner_scope <> 'team' then
      raise exception 'user % may not write these events as team_coach', p_user_id using errcode = 'insufficient_privilege';
    end if;
    perform 1 from public.user_team_roles r
     where r.user_id = p_user_id and r.team_id = p_owner_id and r.role = 'team_coach' and r.is_active = true
       for share;
  else
    if p_owner_scope <> 'user' then
      raise exception 'user % may not write these events as private_coach', p_user_id using errcode = 'insufficient_privilege';
    end if;
    perform 1 from public.user_global_roles r
     where r.user_id = p_user_id and r.role = 'independent_coach' and r.is_active = true
       for share;
  end if;
  if not found then
    raise exception 'user % may not write the events of this % as %', p_user_id, p_owner_scope, p_basis using errcode = 'insufficient_privilege';
  end if;

  -- 3. The acting user, last.
  perform 1 from public.users u where u.id = p_user_id and u.is_active = true for share;
  if not found then
    raise exception 'user % may not write calendar events', p_user_id using errcode = 'insufficient_privilege';
  end if;
  return p_basis;
end $$;

-- ---------------------------------------------------------------------------
-- 9. The seed (D4; plan section 6 — the default_expects follow the owner's
--    answers to 9.2 and 9.14)
-- ---------------------------------------------------------------------------
-- One definition of "a club's copy of the system set", used here for every
-- active club and by POST /clubs for a new one. Idempotent by seed_key: a
-- club that already has (or archived) a default keeps it as it is.
create function calendar.seed_club_event_types(p_club_id uuid) returns integer language plpgsql as $$
declare
  v_count integer;
begin
  insert into calendar.event_types (owner_scope, owner_club_id, kind, key, label, default_expects, sort_order, seed_key)
  select 'club', p_club_id, s.kind, s.key, s.label, s.default_expects, s.sort_order, s.seed_key
    from calendar.event_types s
   where s.owner_scope = 'system' and s.seed_key is not null and s.archived_at is null
     and not exists (select 1 from calendar.event_types x
                      where x.owner_scope = 'club' and x.owner_club_id = p_club_id and x.seed_key = s.seed_key)
   order by s.sort_order;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

insert into calendar.event_types (owner_scope, kind, key, label, default_expects, sort_order, seed_key) values
  ('system', 'training', 'training', 'Training', '{rpe}',         10, 'training'),
  ('system', 'match',    'match',    'Match',    '{rpe}',         20, 'match'),
  ('system', 'travel',   'travel',   'Travel',   '{}',            30, 'travel'),
  ('system', 'meeting',  'meeting',  'Meeting',  '{}',            40, 'meeting'),
  ('system', 'day_off',  'day_off',  'Day off',  '{}',            50, 'day_off'),
  ('system', 'camp',     'camp',     'Camp',     '{}',            60, 'camp'),
  ('system', 'test',     'test',     'Test',     '{test_result}', 70, 'test');

-- No club is created between the seed and the self-check below (the
-- application's POST /clubs waits here, then seeds its own copy).
lock table public.clubs in share row exclusive mode;
select calendar.seed_club_event_types(c.id) from public.clubs c where coalesce(c.is_active, true) order by c.id;

-- Fail-closed self-check: the seed is exactly what this file says.
do $$
declare
  v_system integer;
  v_clubs integer;
  v_copies integer;
begin
  select count(*) into v_system from calendar.event_types where owner_scope = 'system';
  select count(*) into v_clubs from public.clubs where coalesce(is_active, true);
  select count(*) into v_copies from calendar.event_types where owner_scope = 'club';
  if v_system <> 7 or v_copies <> 7 * v_clubs then
    raise exception 'calendar v48: the seed is not what was expected (system %, clubs %, copies %)', v_system, v_clubs, v_copies;
  end if;
end $$;
