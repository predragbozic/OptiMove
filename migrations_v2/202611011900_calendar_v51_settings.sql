-- Central calendar v51 (K2b-1a): Settings -> Calendar — the club's event
-- types become editable, a library of details (coach-filled event context),
-- the club's places, team colours and default places, and the catalog's
-- request record and change log. Plan: docs/ai/central-calendar-k2b-plan.md
-- (sections 2, 3, 6, 13 and 16, the owner decisions D28-D39); runbook
-- docs/runbooks/calendar-settings-v51.md; rollback
-- docs/runbooks/calendar-settings-v51-rollback.sql.
--
-- v49's file is never edited; v51 ALTERS its objects:
--   calendar.event_types       drops K2a's read-only guard; adds color_key
--                              and revision; the system set stays final (D35)
--   calendar.events            adds location_id (a library place OR the
--                              one-off `location` text, never both)
--   event_requests / changes   their operation / kind CHECKs gain
--                              set_fields and align_sessions (T1)
--   seed_club_event_types()    also copies the details, their options and the
--                              types' detail lists (POST /clubs unchanged)
-- New:
--   calendar.event_fields          the details library (system + per club)
--   calendar.event_field_options   the choices of a `choice` detail
--   calendar.event_type_fields     a type's default details, ordered
--   calendar.event_selected_fields one event's details, ordered
--   calendar.event_field_values    the coach's values (never deleted)
--   calendar.locations             a club's places (D27)
--   calendar.team_settings         a team's colour and default place
--   calendar.settings_requests     the catalog's requestKey record
--   calendar.settings_changes      the catalog's append-only change log
--
-- Rules the database keeps whoever writes (plan 2.3-2.6): once a detail has
-- a value its label, unit, bounds and option labels never change; a catalog
-- row is never deleted except together with its club (maintenance, as v49);
-- every update of a type, detail, place or team setting bumps `revision` by
-- one and needs its change row at COMMIT (a seed-shaped insert needs none);
-- a child row (an option, a list entry, a selection, a value) needs its
-- parent written in the same transaction; a club's lists and selections hold
-- only the owner's details; an event's place is its owner's club's; the
-- system set is final; a club keeps at least one live type; every table
-- refuses TRUNCATE. No row of any other schema is written.

set local lock_timeout = '5s';

-- No club is created while v51 runs, and the lock comes FIRST, before any DDL
-- on calendar.*: POST /clubs takes the clubs table, then inserts its type
-- copies, so taking the two in the same order means no deadlock, and no club
-- of the old server can land between the icon update and the seed below
-- without its details (db review of K2b-1a, F1). Event writes take ROW SHARE
-- on clubs (lock_event_writer's FOR SHARE), which this mode does not block.
lock table public.clubs in share row exclusive mode;

-- ---------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------
-- The closed palette (plan 2.5, D38): the first eight are today's automatic
-- colours (frontend/styles.css --cc-team-0..7). A new colour is a later
-- migration's `create or replace`; backend/src/calendarColors.js and the
-- frontend's palette are proven equal to this list by a test.
create function calendar.color_key_ok(p text) returns boolean
  language sql immutable as $$
    select p in ('teal', 'rust', 'indigo', 'plum', 'green', 'amber', 'rose', 'sky', 'slate', 'olive', 'coral', 'violet')
  $$;

-- A detail's number (its bounds and its values): at most three decimals and
-- below a billion in size.
create function calendar.detail_number_ok(p numeric) returns boolean
  language sql immutable as $$
    select p is null or (p = round(p, 3) and abs(p) < 1000000000)
  $$;

-- Is the row (by its xmin) written by THIS transaction? A child row's parent
-- must be: the parent's own revision rule then requires its change row. A
-- write inside a savepoint carries a subtransaction's xid and is refused
-- (fail-closed; no application path uses one).
create function calendar.written_in_this_transaction(p_xmin xid) returns boolean
  language sql volatile as $$
    select p_xmin = pg_current_xact_id()::xid
  $$;

-- ---------------------------------------------------------------------------
-- 1. Event types: editable (K2a's read-only guard goes), colour, revision
-- ---------------------------------------------------------------------------
drop trigger event_types_k2a_read_only on calendar.event_types;
drop function calendar.event_types_k2a_read_only();

alter table calendar.event_types
  add column color_key text
      constraint event_types_color_key_check check (color_key is null or calendar.color_key_ok(color_key)),
  add column revision integer not null default 1
      constraint event_types_revision_check check (revision >= 1);

-- ---------------------------------------------------------------------------
-- 2. The details library (D24, D25, D29)
-- ---------------------------------------------------------------------------
create table calendar.event_fields (
  id                  uuid primary key default gen_random_uuid(),
  owner_scope         varchar(20) not null
                      constraint event_fields_owner_scope_check check (owner_scope in ('system', 'club')),
  -- A club's copy goes with its club's hard delete (as its types, v49); a
  -- detail in use is kept by the values' and selections' RESTRICT, and an
  -- edited one by the change log's.
  owner_club_id       uuid references public.clubs(id) on delete cascade,
  key                 text not null
                      constraint event_fields_key_check check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label               text not null
                      constraint event_fields_label_check check (training_load.source_metric_text_ok(label, 60)),
  description         text
                      constraint event_fields_description_check check (description is null or training_load.source_metric_text_ok(description, 200)),
  -- D29: only the coach fills a detail in K2b-1; K2b-2 decides the athlete's
  -- side (Metrics Core) and widens this CHECK in its own migration.
  filled_by           varchar(10) not null default 'coach'
                      constraint event_fields_filled_by_check check (filled_by in ('coach')),
  value_kind          varchar(12) not null
                      constraint event_fields_value_kind_check check (value_kind in ('choice', 'number', 'scale_1_5', 'yes_no', 'short_text')),
  unit                text
                      constraint event_fields_unit_check check (unit is null or training_load.source_metric_unit_token_ok(unit)),
  min_value           numeric
                      constraint event_fields_min_check check (calendar.detail_number_ok(min_value)),
  max_value           numeric
                      constraint event_fields_max_check check (calendar.detail_number_ok(max_value)),
  -- D25: optional unless the club's admin says so.
  required            boolean not null default false,
  sort_order          integer not null default 0,
  seed_key            text
                      constraint event_fields_seed_key_check check (seed_key is null or seed_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  archived_at         timestamptz,
  archived_by_user_id uuid references public.users(id) on delete restrict,
  created_by_user_id  uuid references public.users(id) on delete restrict,
  revision            integer not null default 1
                      constraint event_fields_revision_check check (revision >= 1),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint event_fields_owner_shape check (
    (owner_scope = 'system' and owner_club_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null)),
  constraint event_fields_archive_shape check ((archived_at is null) = (archived_by_user_id is null)),
  constraint event_fields_number_shape check (value_kind = 'number' or (unit is null and min_value is null and max_value is null)),
  constraint event_fields_bounds_check check (min_value is null or max_value is null or min_value <= max_value)
);
create unique index event_fields_owner_key_key
  on calendar.event_fields (owner_scope, owner_club_id, key) nulls not distinct;
create unique index event_fields_owner_seed_key_key
  on calendar.event_fields (owner_scope, owner_club_id, seed_key) nulls not distinct where seed_key is not null;
create unique index event_fields_owner_label_live_key
  on calendar.event_fields (owner_scope, owner_club_id, lower(label)) nulls not distinct where archived_at is null;
create index event_fields_owner_club_idx on calendar.event_fields (owner_club_id) where owner_club_id is not null;

create table calendar.event_field_options (
  id          uuid primary key default gen_random_uuid(),
  field_id    uuid not null references calendar.event_fields(id) on delete cascade,
  label       text not null
              constraint event_field_options_label_check check (training_load.source_metric_text_ok(label, 40)),
  sort_order  integer not null default 0,
  seed_key    text
              constraint event_field_options_seed_key_check check (seed_key is null or seed_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- D30: a hidden option keeps its old answers and leaves the pickers.
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index event_field_options_label_live_key
  on calendar.event_field_options (field_id, lower(label)) where archived_at is null;
create unique index event_field_options_seed_key_key
  on calendar.event_field_options (field_id, seed_key) where seed_key is not null;
create index event_field_options_field_idx on calendar.event_field_options (field_id);

-- A type's default details (D19's sibling: copied to a new event, editable
-- per event). Rewritten inside the type's command: entries removed, moved,
-- added (an archived detail already listed stays; a new entry is live).
create table calendar.event_type_fields (
  event_type_id uuid not null references calendar.event_types(id) on delete cascade,
  field_id      uuid not null references calendar.event_fields(id) on delete cascade,
  position      integer not null
                constraint event_type_fields_position_check check (position >= 0),
  primary key (event_type_id, field_id)
);
create index event_type_fields_field_idx on calendar.event_type_fields (field_id);

-- One event's details, ordered (as `expects`: copied from the type at
-- create, editable per event; K2b-1b writes it the same way as a type's list).
create table calendar.event_selected_fields (
  event_id uuid not null references calendar.events(id) on delete restrict,
  field_id uuid not null references calendar.event_fields(id) on delete restrict,
  position integer not null
           constraint event_selected_fields_position_check check (position >= 0),
  primary key (event_id, field_id)
);
create index event_selected_fields_field_idx on calendar.event_selected_fields (field_id);

-- The coach's values (D39: the event's managers; K2b-1b writes them). One
-- per event and detail; never deleted — a clear sets every value column to
-- null, so "the detail has values" never turns back (plan 2.3).
create table calendar.event_field_values (
  id                 uuid primary key default gen_random_uuid(),
  event_id           uuid not null references calendar.events(id) on delete restrict,
  field_id           uuid not null references calendar.event_fields(id) on delete restrict,
  option_id          uuid references calendar.event_field_options(id) on delete restrict,
  number_value       numeric
                     constraint event_field_values_number_check check (calendar.detail_number_ok(number_value)),
  scale_value        smallint
                     constraint event_field_values_scale_check check (scale_value is null or scale_value between 1 and 5),
  bool_value         boolean,
  text_value         text
                     constraint event_field_values_text_check check (text_value is null or training_load.source_metric_text_ok(text_value, 200)),
  updated_by_user_id uuid not null references public.users(id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint event_field_values_one_per_detail unique (event_id, field_id),
  constraint event_field_values_one_value check (num_nonnulls(option_id, number_value, scale_value, bool_value, text_value) <= 1)
);
create index event_field_values_field_idx on calendar.event_field_values (field_id);
create index event_field_values_option_idx on calendar.event_field_values (option_id) where option_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Places (D27, D34) and team settings (D11, D38)
-- ---------------------------------------------------------------------------
create table calendar.locations (
  id                  uuid primary key default gen_random_uuid(),
  -- Never deleted: a place exists only through an audited command, and the
  -- change log's RESTRICT keeps its club too.
  owner_club_id       uuid not null references public.clubs(id) on delete restrict,
  name                text not null
                      constraint locations_name_check check (training_load.source_metric_text_ok(name, 80)),
  address             text
                      constraint locations_address_check check (address is null or training_load.source_metric_text_ok(address, 200)),
  note                text
                      constraint locations_note_check check (note is null or calendar.multiline_text_ok(note, 500)),
  archived_at         timestamptz,
  archived_by_user_id uuid references public.users(id) on delete restrict,
  created_by_user_id  uuid not null references public.users(id) on delete restrict,
  revision            integer not null default 1
                      constraint locations_revision_check check (revision >= 1),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint locations_archive_shape check ((archived_at is null) = (archived_by_user_id is null))
);
create unique index locations_club_name_live_key
  on calendar.locations (owner_club_id, lower(name)) where archived_at is null;
create index locations_club_idx on calendar.locations (owner_club_id);

create table calendar.team_settings (
  team_id             uuid primary key references public.teams(id) on delete restrict,
  -- null = the automatic colour (plan 2.5)
  color_key           text
                      constraint team_settings_color_key_check check (color_key is null or calendar.color_key_ok(color_key)),
  default_location_id uuid references calendar.locations(id) on delete restrict,
  revision            integer not null default 1
                      constraint team_settings_revision_check check (revision >= 1),
  updated_by_user_id  uuid not null references public.users(id) on delete restrict,
  updated_at          timestamptz not null default now()
);
create index team_settings_location_idx on calendar.team_settings (default_location_id) where default_location_id is not null;

-- An event's place: a library place OR the one-off text, never both (D27).
alter table calendar.events
  add column location_id uuid references calendar.locations(id) on delete restrict;
alter table calendar.events
  add constraint events_location_one check (location_id is null or location is null);
create index events_location_idx on calendar.events (location_id) where location_id is not null;

-- ---------------------------------------------------------------------------
-- 4. The catalog's request record and change log (the v49 pair)
-- ---------------------------------------------------------------------------
create table calendar.settings_requests (
  id                    uuid primary key default gen_random_uuid(),
  request_key           uuid not null,
  request_hash          text not null
                        constraint settings_requests_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  operation             varchar(24) not null
                        constraint settings_requests_operation_check check (operation in (
                          'type_create', 'type_update', 'type_archive', 'type_restore', 'type_order',
                          'field_create', 'field_update', 'field_archive', 'field_restore',
                          'location_create', 'location_update', 'location_archive', 'location_restore',
                          'team_update')),
  performed_by_user_id  uuid not null references public.users(id) on delete restrict,
  club_id               uuid not null references public.clubs(id) on delete restrict,
  result                jsonb not null
                        constraint settings_requests_result_check check (jsonb_typeof(result) = 'object'),
  created_at            timestamptz not null default now(),
  constraint settings_requests_one_per_key unique (performed_by_user_id, request_key)
);
create index settings_requests_club_idx on calendar.settings_requests (club_id);

create table calendar.settings_changes (
  id                    uuid primary key default gen_random_uuid(),
  request_id            uuid not null references calendar.settings_requests(id) on delete restrict,
  subject_kind          varchar(10) not null
                        constraint settings_changes_subject_kind_check check (subject_kind in ('type', 'field', 'location', 'team')),
  event_type_id         uuid references calendar.event_types(id) on delete restrict,
  field_id              uuid references calendar.event_fields(id) on delete restrict,
  location_id           uuid references calendar.locations(id) on delete restrict,
  team_id               uuid references public.teams(id) on delete restrict,
  -- The subject's revision after this change.
  revision              integer not null
                        constraint settings_changes_revision_check check (revision >= 1),
  kind                  varchar(24) not null
                        constraint settings_changes_kind_check check (kind in (
                          'type_create', 'type_update', 'type_archive', 'type_restore', 'type_order',
                          'field_create', 'field_update', 'field_archive', 'field_restore',
                          'location_create', 'location_update', 'location_archive', 'location_restore',
                          'team_update')),
  basis                 varchar(20) not null
                        constraint settings_changes_basis_check check (basis in ('platform_admin', 'club_admin')),
  performed_by_user_id  uuid not null references public.users(id) on delete restrict,
  performed_at          timestamptz not null default now(),
  -- Flat facts: ids, flags and the before / after of scalars — never a
  -- label, an address, a note or a value's text.
  details               jsonb not null default '{}'::jsonb
                        constraint settings_changes_details_check check (calendar.details_ok(details)),
  constraint settings_changes_subject_shape check (
    (subject_kind = 'type'     and event_type_id is not null and field_id is null and location_id is null and team_id is null) or
    (subject_kind = 'field'    and field_id is not null and event_type_id is null and location_id is null and team_id is null) or
    (subject_kind = 'location' and location_id is not null and event_type_id is null and field_id is null and team_id is null) or
    (subject_kind = 'team'     and team_id is not null and event_type_id is null and field_id is null and location_id is null))
);
create index settings_changes_request_idx on calendar.settings_changes (request_id);
create unique index settings_changes_type_revision_key on calendar.settings_changes (event_type_id, revision) where event_type_id is not null;
create unique index settings_changes_field_revision_key on calendar.settings_changes (field_id, revision) where field_id is not null;
create unique index settings_changes_location_revision_key on calendar.settings_changes (location_id, revision) where location_id is not null;
create unique index settings_changes_team_revision_key on calendar.settings_changes (team_id, revision) where team_id is not null;

-- v49's two CHECKs gain the values command (K2b-1b) and the standalone
-- alignment (T1; K2a-1b's open point 1).
alter table calendar.event_requests drop constraint event_requests_operation_check;
alter table calendar.event_requests add constraint event_requests_operation_check check (operation in (
  'create', 'update', 'cancel', 'attach_sessions', 'detach_sessions',
  'attach_activity', 'detach_activity', 'set_schedule', 'clear_schedule', 'set_fields', 'align_sessions'));
alter table calendar.event_changes drop constraint event_changes_kind_check;
alter table calendar.event_changes add constraint event_changes_kind_check check (kind in (
  'create', 'update', 'cancel', 'attach_sessions', 'detach_sessions',
  'attach_activity', 'detach_activity', 'set_schedule', 'clear_schedule', 'set_fields', 'align_sessions'));

-- ---------------------------------------------------------------------------
-- 5. The seed (plan section 3, D32): the system details and lists, the
--    seeded types' icons, and the club copies (before the guards below)
-- ---------------------------------------------------------------------------
insert into calendar.event_fields (owner_scope, key, label, value_kind, unit, min_value, max_value, sort_order, seed_key) values
  ('system', 'weather',           'Weather',           'choice',     null, null,  null, 10,  'weather'),
  ('system', 'temperature',       'Temperature',       'number',     '°C', -40,   50,   20,  'temperature'),
  ('system', 'surface',           'Surface',           'choice',     null, null,  null, 30,  'surface'),
  ('system', 'opponent',          'Opponent',          'short_text', null, null,  null, 40,  'opponent'),
  ('system', 'home_away',         'Home or away',      'choice',     null, null,  null, 50,  'home_away'),
  ('system', 'our_score',         'Our score',         'number',     null, 0,     999,  60,  'our_score'),
  ('system', 'their_score',       'Their score',       'number',     null, 0,     999,  70,  'their_score'),
  ('system', 'travel_time',       'Travel time',       'number',     'min', 0,    2880, 80,  'travel_time'),
  ('system', 'transport',         'Transport',         'choice',     null, null,  null, 90,  'transport'),
  ('system', 'travel_difficulty', 'Travel difficulty', 'scale_1_5',  null, null,  null, 100, 'travel_difficulty');

insert into calendar.event_field_options (field_id, label, sort_order, seed_key)
select f.id, o.label, o.sort_order, o.seed_key
  from (values
    ('weather', 'Sunny', 10, 'sunny'), ('weather', 'Cloudy', 20, 'cloudy'), ('weather', 'Rain', 30, 'rain'),
    ('weather', 'Snow', 40, 'snow'), ('weather', 'Windy', 50, 'windy'),
    ('surface', 'Natural grass', 10, 'natural_grass'), ('surface', 'Artificial grass', 20, 'artificial_grass'),
    ('surface', 'Indoor court', 30, 'indoor_court'), ('surface', 'Track', 40, 'track'), ('surface', 'Gym', 50, 'gym'),
    ('home_away', 'Home', 10, 'home'), ('home_away', 'Away', 20, 'away'), ('home_away', 'Neutral', 30, 'neutral'),
    ('transport', 'Bus', 10, 'bus'), ('transport', 'Car', 20, 'car'), ('transport', 'Plane', 30, 'plane'), ('transport', 'Train', 40, 'train')
  ) as o(field_key, label, sort_order, seed_key)
  join calendar.event_fields f on f.owner_scope = 'system' and f.seed_key = o.field_key;

insert into calendar.event_type_fields (event_type_id, field_id, position)
select t.id, f.id, l.position
  from (values
    ('training', 'weather', 0), ('training', 'temperature', 1), ('training', 'surface', 2),
    ('match', 'weather', 0), ('match', 'temperature', 1), ('match', 'surface', 2), ('match', 'opponent', 3),
    ('match', 'home_away', 4), ('match', 'our_score', 5), ('match', 'their_score', 6),
    ('travel', 'travel_time', 0), ('travel', 'transport', 1), ('travel', 'travel_difficulty', 2)
  ) as l(type_key, field_key, position)
  join calendar.event_types t on t.owner_scope = 'system' and t.seed_key = l.type_key
  join calendar.event_fields f on f.owner_scope = 'system' and f.seed_key = l.field_key;

-- The seeded types' icons: today's kind icons (frontend/central-calendar-view.js
-- CENTRAL_CALENDAR_EVENT_KIND_ICONS), so nothing visible moves. Only rows
-- still exactly as v49 seeded them (none can differ: the catalog was
-- read-only until now).
update calendar.event_types t
   set icon_key = s.icon_key
  from (values ('training', 'run'), ('match', 'trophy'), ('test', 'clipboard'), ('travel', 'route'),
               ('meeting', 'team'), ('day_off', 'bed'), ('camp', 'mountain')) as s(seed_key, icon_key)
 where t.seed_key = s.seed_key and t.icon_key is null and t.created_by_user_id is null;

-- One definition of "a club's copy of the system set" (v49's function,
-- widened): the types (with their icon and colour), the details, their
-- options and the types' detail lists. Idempotent by seed_key: a club that
-- already has (or archived, or changed) a default keeps it as it is. A copy
-- the club never changed (revision 1) and that has no option / no list entry
-- yet gets the system ones; one the club changed keeps its own (an emptied
-- list stays empty). Returns the number of TYPE rows inserted (v49's
-- contract).
create or replace function calendar.seed_club_event_types(p_club_id uuid) returns integer language plpgsql as $$
declare
  v_count integer;
begin
  insert into calendar.event_types (owner_scope, owner_club_id, kind, key, label, default_expects, icon_key, color_key, sort_order, seed_key)
  select 'club', p_club_id, s.kind, s.key, s.label, s.default_expects, s.icon_key, s.color_key, s.sort_order, s.seed_key
    from calendar.event_types s
   where s.owner_scope = 'system' and s.seed_key is not null and s.archived_at is null
     and not exists (select 1 from calendar.event_types x
                      where x.owner_scope = 'club' and x.owner_club_id = p_club_id and x.seed_key = s.seed_key)
   order by s.sort_order;
  get diagnostics v_count = row_count;

  insert into calendar.event_fields (owner_scope, owner_club_id, key, label, description, value_kind, unit, min_value, max_value, required, sort_order, seed_key)
  select 'club', p_club_id, s.key, s.label, s.description, s.value_kind, s.unit, s.min_value, s.max_value, s.required, s.sort_order, s.seed_key
    from calendar.event_fields s
   where s.owner_scope = 'system' and s.seed_key is not null and s.archived_at is null
     and not exists (select 1 from calendar.event_fields x
                      where x.owner_scope = 'club' and x.owner_club_id = p_club_id and x.seed_key = s.seed_key)
   order by s.sort_order;

  insert into calendar.event_field_options (field_id, label, sort_order, seed_key)
  select c.id, o.label, o.sort_order, o.seed_key
    from calendar.event_fields s
    join calendar.event_field_options o on o.field_id = s.id and o.seed_key is not null and o.archived_at is null
    join calendar.event_fields c on c.owner_scope = 'club' and c.owner_club_id = p_club_id and c.seed_key = s.seed_key
   where s.owner_scope = 'system' and c.revision = 1
     and not exists (select 1 from calendar.event_field_options x where x.field_id = c.id)
   order by c.id, o.sort_order;

  insert into calendar.event_type_fields (event_type_id, field_id, position)
  select ct.id, cf.id, l.position
    from calendar.event_type_fields l
    join calendar.event_types st on st.id = l.event_type_id and st.owner_scope = 'system'
    join calendar.event_fields sf on sf.id = l.field_id and sf.owner_scope = 'system'
    join calendar.event_types ct on ct.owner_scope = 'club' and ct.owner_club_id = p_club_id and ct.seed_key = st.seed_key
    join calendar.event_fields cf on cf.owner_scope = 'club' and cf.owner_club_id = p_club_id and cf.seed_key = sf.seed_key
   where ct.revision = 1 and cf.archived_at is null
     and not exists (select 1 from calendar.event_type_fields x where x.event_type_id = ct.id)
   order by ct.id, l.position;
  return v_count;
end $$;

-- The clubs v49 seeded keep their type copies (their icons are set above,
-- their revision stays 1); their details, options and the lists of their
-- seeded types are copied here, by the same function (public.clubs is locked
-- since the top of the file).
select calendar.seed_club_event_types(c.id) from public.clubs c where coalesce(c.is_active, true) order by c.id;

-- ---------------------------------------------------------------------------
-- 6. The guards (created after the seed)
-- ---------------------------------------------------------------------------
-- 6.1 Event types. v49's event_types_before_write keeps kind, owner and
-- seed_key write-once and sets updated_at; this one adds the rest.
create function calendar.event_types_k2b_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1 or new.archived_at is not null then
      raise exception 'calendar.event_types: a new type has revision 1 and is live' using errcode = '23514';
    end if;
    -- D35: the system set changes by migration only, in the seed's shape.
    if new.owner_scope = 'system' and not (new.seed_key is not null and new.created_by_user_id is null) then
      raise exception 'calendar.event_types: the system set is final' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.owner_scope = 'system' then
    raise exception 'calendar.event_types: the system set is final' using errcode = '23514';
  end if;
  if new.key is distinct from old.key or new.created_by_user_id is distinct from old.created_by_user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'calendar.event_types: key and the creation facts are write-once' using errcode = '23514';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'calendar.event_types: revision must increase by exactly one on every write' using errcode = '23514';
  end if;
  -- A club keeps at least one live type (plan 2.6). Archives of one owner are
  -- serialized on a transaction-scoped advisory lock, so two concurrent
  -- archives of the last two types cannot both pass.
  if old.archived_at is null and new.archived_at is not null then
    perform pg_advisory_xact_lock(hashtextextended('calendar.event_types.live:' || coalesce(new.owner_club_id::text, 'system'), 0));
    if not exists (select 1 from calendar.event_types x
                    where x.owner_scope = new.owner_scope and x.owner_club_id is not distinct from new.owner_club_id
                      and x.archived_at is null and x.id <> new.id) then
      raise exception 'calendar.event_types: an owner keeps at least one live type' using errcode = '23514', constraint = 'event_types_last_live';
    end if;
  end if;
  return new;
end $$;
create trigger event_types_k2b_guard
  before insert or update on calendar.event_types
  for each row execute function calendar.event_types_k2b_guard();

-- D37: a club's type is never deleted on its own; it goes only with its
-- club's hard delete (the cascade of v49; then the club row is gone). The
-- system set keeps v49's event_types_system_final.
create function calendar.event_types_club_no_delete() returns trigger language plpgsql as $$
begin
  if old.owner_scope = 'club' and exists (select 1 from public.clubs c where c.id = old.owner_club_id) then
    raise exception 'calendar.event_types: a type is archived, never deleted' using errcode = '23514';
  end if;
  return old;
end $$;
create trigger event_types_club_no_delete
  before delete on calendar.event_types
  for each row execute function calendar.event_types_club_no_delete();

-- 6.2 Details.
-- "The detail has values": a value row names it (a cleared one included).
create function calendar.field_has_values(p_field_id uuid) returns boolean language sql stable as $$
  select exists (select 1 from calendar.event_field_values v where v.field_id = p_field_id)
$$;

create function calendar.event_fields_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1 or new.archived_at is not null then
      raise exception 'calendar.event_fields: a new detail has revision 1 and is live' using errcode = '23514';
    end if;
    if new.owner_scope = 'system' and not (new.seed_key is not null and new.created_by_user_id is null) then
      raise exception 'calendar.event_fields: the system set is final' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.owner_scope = 'system' then
    raise exception 'calendar.event_fields: the system set is final' using errcode = '23514';
  end if;
  if new.owner_scope is distinct from old.owner_scope or new.owner_club_id is distinct from old.owner_club_id
     or new.key is distinct from old.key or new.value_kind is distinct from old.value_kind
     or new.filled_by is distinct from old.filled_by or new.seed_key is distinct from old.seed_key
     or new.created_by_user_id is distinct from old.created_by_user_id or new.created_at is distinct from old.created_at then
    raise exception 'calendar.event_fields: owner, key, kind, filled_by, seed_key and the creation facts are write-once' using errcode = '23514';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'calendar.event_fields: revision must increase by exactly one on every write' using errcode = '23514';
  end if;
  -- The owner's rule: once a detail has a value, its meaning never changes.
  -- A value writer holds this row FOR SHARE (6.4), so a value committed while
  -- this update waited is seen here (a fresh snapshot per statement).
  if (new.label is distinct from old.label or new.unit is distinct from old.unit
      or new.min_value is distinct from old.min_value or new.max_value is distinct from old.max_value)
     and calendar.field_has_values(old.id) then
    raise exception 'calendar.event_fields: a detail with values keeps its meaning (label, unit, bounds)' using errcode = '23514', constraint = 'event_fields_answered_frozen';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger event_fields_guard
  before insert or update on calendar.event_fields
  for each row execute function calendar.event_fields_guard();

create function calendar.event_fields_no_delete() returns trigger language plpgsql as $$
begin
  if old.owner_scope = 'system' or exists (select 1 from public.clubs c where c.id = old.owner_club_id) then
    raise exception 'calendar.event_fields: a detail is archived, never deleted' using errcode = '23514';
  end if;
  return old;
end $$;
create trigger event_fields_no_delete
  before delete on calendar.event_fields
  for each row execute function calendar.event_fields_no_delete();

-- 6.3 Options.
create function calendar.event_field_options_guard() returns trigger language plpgsql as $$
declare
  v_field record;
begin
  -- The detail's row FOR UPDATE: options and the values of one detail
  -- serialize on it (the freeze, the count).
  select f.owner_scope, f.value_kind, f.archived_at into v_field
    from calendar.event_fields f where f.id = new.field_id for update;
  if not found then
    raise exception 'calendar.event_field_options: field_id names no detail' using errcode = '23514';
  end if;
  if v_field.value_kind <> 'choice' then
    raise exception 'calendar.event_field_options: only a choice detail has options' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if v_field.owner_scope = 'system' and new.seed_key is null then
      raise exception 'calendar.event_field_options: the system set is final' using errcode = '23514';
    end if;
    if new.archived_at is not null then
      raise exception 'calendar.event_field_options: a new option is live' using errcode = '23514';
    end if;
    if (select count(*) from calendar.event_field_options o where o.field_id = new.field_id and o.archived_at is null) >= 20 then
      raise exception 'calendar.event_field_options: at most 20 live options' using errcode = '23514', constraint = 'event_field_options_max';
    end if;
    return new;
  end if;
  if v_field.owner_scope = 'system' then
    raise exception 'calendar.event_field_options: the system set is final' using errcode = '23514';
  end if;
  if new.field_id is distinct from old.field_id or new.seed_key is distinct from old.seed_key or new.created_at is distinct from old.created_at then
    raise exception 'calendar.event_field_options: field_id, seed_key and created_at are write-once' using errcode = '23514';
  end if;
  if new.label is distinct from old.label and calendar.field_has_values(old.field_id) then
    raise exception 'calendar.event_field_options: an option of a detail with values keeps its label' using errcode = '23514', constraint = 'event_fields_answered_frozen';
  end if;
  if old.archived_at is not null and new.archived_at is null
     and (select count(*) from calendar.event_field_options o where o.field_id = new.field_id and o.archived_at is null) >= 20 then
    raise exception 'calendar.event_field_options: at most 20 live options' using errcode = '23514', constraint = 'event_field_options_max';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger event_field_options_guard
  before insert or update on calendar.event_field_options
  for each row execute function calendar.event_field_options_guard();

create function calendar.event_field_options_no_delete() returns trigger language plpgsql as $$
begin
  if exists (select 1 from calendar.event_fields f where f.id = old.field_id) then
    raise exception 'calendar.event_field_options: an option is hidden, never deleted' using errcode = '23514';
  end if;
  return old;
end $$;
create trigger event_field_options_no_delete
  before delete on calendar.event_field_options
  for each row execute function calendar.event_field_options_no_delete();

-- 6.4 A type's default list.
create function calendar.event_type_fields_guard() returns trigger language plpgsql as $$
declare
  v_type record;
  v_field record;
begin
  if tg_op = 'DELETE' then
    select t.owner_scope into v_type from calendar.event_types t where t.id = old.event_type_id;
    if found and v_type.owner_scope = 'system' then
      raise exception 'calendar.event_type_fields: the system set is final' using errcode = '23514';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    -- Only an entry's place in the list moves (an edit keeps the entries it
    -- keeps, so an archived detail already listed stays, plan 2.6).
    if new.event_type_id is distinct from old.event_type_id or new.field_id is distinct from old.field_id then
      raise exception 'calendar.event_type_fields: an entry only moves' using errcode = '23514';
    end if;
    select t.owner_scope into v_type from calendar.event_types t where t.id = new.event_type_id;
    if v_type.owner_scope = 'system' then
      raise exception 'calendar.event_type_fields: the system set is final' using errcode = '23514';
    end if;
    return new;
  end if;
  select t.owner_scope, t.owner_club_id into v_type from calendar.event_types t where t.id = new.event_type_id for update;
  if not found or v_type.owner_scope = 'system' then
    raise exception 'calendar.event_type_fields: the system set is final' using errcode = '23514';
  end if;
  select f.owner_scope, f.owner_club_id, f.archived_at into v_field from calendar.event_fields f where f.id = new.field_id for share;
  if not found or v_field.owner_scope <> v_type.owner_scope or v_field.owner_club_id is distinct from v_type.owner_club_id then
    raise exception 'calendar.event_type_fields: a type lists its own owner''s details only' using errcode = '23514';
  end if;
  if v_field.archived_at is not null then
    raise exception 'calendar.event_type_fields: an archived detail is not added' using errcode = '23514';
  end if;
  if (select count(*) from calendar.event_type_fields l where l.event_type_id = new.event_type_id) >= 20 then
    raise exception 'calendar.event_type_fields: at most 20 details per type' using errcode = '23514', constraint = 'event_type_fields_max';
  end if;
  return new;
end $$;
create trigger event_type_fields_guard
  before insert or update or delete on calendar.event_type_fields
  for each row execute function calendar.event_type_fields_guard();

-- 6.5 One event's details.
create function calendar.event_selected_fields_guard() returns trigger language plpgsql as $$
declare
  v_event record;
  v_field record;
  v_club uuid;
begin
  if tg_op = 'UPDATE' then
    if new.event_id is distinct from old.event_id or new.field_id is distinct from old.field_id then
      raise exception 'calendar.event_selected_fields: an entry only moves' using errcode = '23514';
    end if;
    select e.status into v_event from calendar.events e where e.id = new.event_id for update;
    if not found or v_event.status <> 'planned' then
      raise exception 'calendar.event_selected_fields: a cancelled event is final' using errcode = '23514';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    select e.status into v_event from calendar.events e where e.id = old.event_id for update;
    if not found or v_event.status <> 'planned' then
      raise exception 'calendar.event_selected_fields: a cancelled event is final' using errcode = '23514';
    end if;
    return old;
  end if;
  select e.status, e.owner_scope, e.owner_club_id, e.owner_team_id into v_event
    from calendar.events e where e.id = new.event_id for update;
  if not found or v_event.status <> 'planned' then
    raise exception 'calendar.event_selected_fields: a cancelled event is final' using errcode = '23514';
  end if;
  select f.owner_scope, f.owner_club_id, f.archived_at into v_field from calendar.event_fields f where f.id = new.field_id for share;
  v_club := case v_event.owner_scope
              when 'club' then v_event.owner_club_id
              when 'team' then (select t.club_id from public.teams t where t.id = v_event.owner_team_id)
              else null end;
  if not found
     or not ((v_club is null and v_field.owner_scope = 'system')
             or (v_club is not null and v_field.owner_scope = 'club' and v_field.owner_club_id = v_club)) then
    raise exception 'calendar.event_selected_fields: an event takes its owner''s details only' using errcode = '23514';
  end if;
  if v_field.archived_at is not null then
    raise exception 'calendar.event_selected_fields: an archived detail is not newly chosen' using errcode = '23514';
  end if;
  if (select count(*) from calendar.event_selected_fields s where s.event_id = new.event_id) >= 30 then
    raise exception 'calendar.event_selected_fields: at most 30 details per event' using errcode = '23514', constraint = 'event_selected_fields_max';
  end if;
  return new;
end $$;
create trigger event_selected_fields_guard
  before insert or update or delete on calendar.event_selected_fields
  for each row execute function calendar.event_selected_fields_guard();

-- 6.6 Values.
create function calendar.event_field_values_guard() returns trigger language plpgsql as $$
declare
  v_status varchar;
  v_field record;
  v_option record;
  v_option_changed boolean := tg_op = 'INSERT';
begin
  if tg_op = 'UPDATE' then
    if new.event_id is distinct from old.event_id or new.field_id is distinct from old.field_id
       or new.created_at is distinct from old.created_at then
      raise exception 'calendar.event_field_values: event, detail and created_at are write-once' using errcode = '23514';
    end if;
    v_option_changed := new.option_id is distinct from old.option_id;
  end if;
  select e.status into v_status from calendar.events e where e.id = new.event_id;
  if v_status is distinct from 'planned' then
    raise exception 'calendar.event_field_values: only a planned event takes a value' using errcode = '23514';
  end if;
  -- FOR SHARE: a detail's edit (FOR UPDATE) and a value serialize (6.2).
  select f.value_kind, f.min_value, f.max_value into v_field from calendar.event_fields f where f.id = new.field_id for share;
  if not found then
    raise exception 'calendar.event_field_values: field_id names no detail' using errcode = '23514';
  end if;
  if not exists (select 1 from calendar.event_selected_fields s where s.event_id = new.event_id and s.field_id = new.field_id) then
    raise exception 'calendar.event_field_values: the detail is not chosen on this event' using errcode = '23514';
  end if;
  if (new.option_id is not null and v_field.value_kind <> 'choice')
     or (new.number_value is not null and v_field.value_kind <> 'number')
     or (new.scale_value is not null and v_field.value_kind <> 'scale_1_5')
     or (new.bool_value is not null and v_field.value_kind <> 'yes_no')
     or (new.text_value is not null and v_field.value_kind <> 'short_text') then
    raise exception 'calendar.event_field_values: the value does not match the detail''s kind' using errcode = '23514', constraint = 'event_field_values_kind';
  end if;
  if new.number_value is not null
     and ((v_field.min_value is not null and new.number_value < v_field.min_value)
          or (v_field.max_value is not null and new.number_value > v_field.max_value)) then
    raise exception 'calendar.event_field_values: the number is outside the detail''s bounds' using errcode = '23514', constraint = 'event_field_values_bounds';
  end if;
  if new.option_id is not null and v_option_changed then
    select o.field_id, o.archived_at into v_option from calendar.event_field_options o where o.id = new.option_id;
    if not found or v_option.field_id <> new.field_id or v_option.archived_at is not null then
      raise exception 'calendar.event_field_values: the option is not a live option of this detail' using errcode = '23514', constraint = 'event_field_values_option';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger event_field_values_guard
  before insert or update on calendar.event_field_values
  for each row execute function calendar.event_field_values_guard();
create trigger event_field_values_no_delete
  before delete on calendar.event_field_values
  for each row execute function calendar.refuse_delete();

-- 6.7 Places and team settings.
create function calendar.locations_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1 or new.archived_at is not null then
      raise exception 'calendar.locations: a new place has revision 1 and is live' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.owner_club_id is distinct from old.owner_club_id or new.created_by_user_id is distinct from old.created_by_user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'calendar.locations: the owner and the creation facts are write-once' using errcode = '23514';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'calendar.locations: revision must increase by exactly one on every write' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger locations_guard
  before insert or update on calendar.locations
  for each row execute function calendar.locations_guard();
create trigger locations_no_delete
  before delete on calendar.locations
  for each row execute function calendar.refuse_delete();

-- A place a team or an event names is of the right club and live when it is
-- SET or CHANGED (never re-judged on a later write: archiving a place never
-- blocks a write of an event that already has it), and held FOR SHARE so an
-- archive waits behind the write.
create function calendar.location_usable(p_location_id uuid, p_club_id uuid) returns boolean language plpgsql as $$
declare
  v record;
begin
  select l.owner_club_id, l.archived_at into v from calendar.locations l where l.id = p_location_id for share;
  return found and p_club_id is not null and v.owner_club_id = p_club_id and v.archived_at is null;
end $$;

create function calendar.team_settings_guard() returns trigger language plpgsql as $$
declare
  v_club uuid;
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1 then
      raise exception 'calendar.team_settings: a new row has revision 1' using errcode = '23514';
    end if;
  else
    if new.team_id is distinct from old.team_id then
      raise exception 'calendar.team_settings: team_id is write-once' using errcode = '23514';
    end if;
    if new.revision <> old.revision + 1 then
      raise exception 'calendar.team_settings: revision must increase by exactly one on every write' using errcode = '23514';
    end if;
    new.updated_at := now();
  end if;
  if new.default_location_id is not null
     and (tg_op = 'INSERT' or new.default_location_id is distinct from old.default_location_id) then
    select t.club_id into v_club from public.teams t where t.id = new.team_id;
    if not calendar.location_usable(new.default_location_id, v_club) then
      raise exception 'calendar.team_settings: the default place is a live place of the team''s club' using errcode = '23514', constraint = 'team_settings_location';
    end if;
  end if;
  return new;
end $$;
create trigger team_settings_guard
  before insert or update on calendar.team_settings
  for each row execute function calendar.team_settings_guard();
create trigger team_settings_no_delete
  before delete on calendar.team_settings
  for each row execute function calendar.refuse_delete();

create function calendar.events_location_guard() returns trigger language plpgsql as $$
declare
  v_club uuid;
begin
  if new.location_id is not null and (tg_op = 'INSERT' or new.location_id is distinct from old.location_id) then
    v_club := case new.owner_scope
                when 'club' then new.owner_club_id
                when 'team' then (select t.club_id from public.teams t where t.id = new.owner_team_id)
                else null end;
    if not calendar.location_usable(new.location_id, v_club) then
      raise exception 'calendar.events: the place is a live place of the event owner''s club' using errcode = '23514', constraint = 'events_location_usable';
    end if;
  end if;
  return new;
end $$;
create trigger events_location_guard
  before insert or update on calendar.events
  for each row execute function calendar.events_location_guard();

-- 6.8 The change log and the request record.
create function calendar.settings_changes_before_insert() returns trigger language plpgsql as $$
declare
  v_request record;
  v_club uuid;
  v_revision integer;
begin
  select r.operation, r.performed_by_user_id, r.club_id into v_request from calendar.settings_requests r where r.id = new.request_id;
  if not found then
    raise exception 'calendar.settings_changes: request_id names no request' using errcode = '23514';
  end if;
  if v_request.operation <> new.kind or v_request.performed_by_user_id <> new.performed_by_user_id then
    raise exception 'calendar.settings_changes: the change does not match its request' using errcode = '23514';
  end if;
  if new.subject_kind = 'type' then
    select t.owner_club_id, t.revision into v_club, v_revision from calendar.event_types t where t.id = new.event_type_id and t.owner_scope = 'club';
  elsif new.subject_kind = 'field' then
    select f.owner_club_id, f.revision into v_club, v_revision from calendar.event_fields f where f.id = new.field_id and f.owner_scope = 'club';
  elsif new.subject_kind = 'location' then
    select l.owner_club_id, l.revision into v_club, v_revision from calendar.locations l where l.id = new.location_id;
  else
    select t.club_id, s.revision into v_club, v_revision
      from public.teams t join calendar.team_settings s on s.team_id = t.id where t.id = new.team_id;
  end if;
  if v_club is null or v_club <> v_request.club_id then
    raise exception 'calendar.settings_changes: the subject belongs to the request''s club only' using errcode = '23514';
  end if;
  if v_revision is distinct from new.revision then
    raise exception 'calendar.settings_changes: revision must be the subject''s current revision' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger settings_changes_before_insert
  before insert on calendar.settings_changes
  for each row execute function calendar.settings_changes_before_insert();
create trigger settings_changes_append_only
  before update or delete on calendar.settings_changes
  for each row execute function calendar.refuse_change();
create trigger settings_requests_append_only
  before update or delete on calendar.settings_requests
  for each row execute function calendar.refuse_change();

create function calendar.settings_requests_need_change() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from calendar.settings_changes c where c.request_id = new.id) then
    raise exception 'calendar.settings_requests: a request must have its change row in the same transaction' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger settings_requests_need_change
  after insert on calendar.settings_requests
  deferrable initially deferred
  for each row execute function calendar.settings_requests_need_change();

-- 6.9 The audit pairing at COMMIT (plan 2.4). A subject's write needs its
-- change row at the revision it left; a seed-shaped insert (the migration,
-- seed_club_event_types) needs none.
create function calendar.event_types_need_change() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.seed_key is not null and new.created_by_user_id is null then
    return null;
  end if;
  if not exists (select 1 from calendar.settings_changes c where c.event_type_id = new.id and c.revision = new.revision) then
    raise exception 'calendar.event_types: a write needs its change row (type, revision) in the same transaction' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger event_types_need_change
  after insert or update on calendar.event_types
  deferrable initially deferred
  for each row execute function calendar.event_types_need_change();

create function calendar.event_fields_need_change() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.seed_key is not null and new.created_by_user_id is null then
    return null;
  end if;
  if not exists (select 1 from calendar.settings_changes c where c.field_id = new.id and c.revision = new.revision) then
    raise exception 'calendar.event_fields: a write needs its change row (detail, revision) in the same transaction' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger event_fields_need_change
  after insert or update on calendar.event_fields
  deferrable initially deferred
  for each row execute function calendar.event_fields_need_change();

create function calendar.locations_need_change() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from calendar.settings_changes c where c.location_id = new.id and c.revision = new.revision) then
    raise exception 'calendar.locations: a write needs its change row (place, revision) in the same transaction' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger locations_need_change
  after insert or update on calendar.locations
  deferrable initially deferred
  for each row execute function calendar.locations_need_change();

create function calendar.team_settings_need_change() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from calendar.settings_changes c where c.team_id = new.team_id and c.revision = new.revision) then
    raise exception 'calendar.team_settings: a write needs its change row (team, revision) in the same transaction' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger team_settings_need_change
  after insert or update on calendar.team_settings
  deferrable initially deferred
  for each row execute function calendar.team_settings_need_change();

-- A child row needs its parent written in the same transaction: the parent's
-- revision rule above (or v49's events_need_change for an event) then
-- requires the audit. A parent that is gone is a cascade (its own guard
-- allowed it). The one exception is the seed: an option or a list entry of a
-- copy still exactly as seeded (revision 1, seed shape) — what
-- seed_club_event_types writes for a club whose copies already exist (a
-- known limit, recorded in the runbook: a raw write in that shape passes).
create function calendar.event_field_options_need_parent() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from calendar.event_fields f
                  where f.id = new.field_id
                    and (calendar.written_in_this_transaction(f.xmin)
                         or (f.revision = 1 and f.seed_key is not null and f.created_by_user_id is null))) then
    raise exception 'calendar.event_field_options: an option is written with its detail' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger event_field_options_need_parent
  after insert or update on calendar.event_field_options
  deferrable initially deferred
  for each row execute function calendar.event_field_options_need_parent();

create function calendar.event_type_fields_need_parent() returns trigger language plpgsql as $$
declare
  v_type_id uuid;
begin
  if tg_op = 'DELETE' then
    v_type_id := old.event_type_id;
  else
    v_type_id := new.event_type_id;
  end if;
  if exists (select 1 from calendar.event_types t where t.id = v_type_id)
     and not exists (select 1 from calendar.event_types t
                      where t.id = v_type_id
                        and (calendar.written_in_this_transaction(t.xmin)
                             or (t.revision = 1 and t.seed_key is not null and t.created_by_user_id is null))) then
    raise exception 'calendar.event_type_fields: a list is written with its type' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger event_type_fields_need_parent
  after insert or update or delete on calendar.event_type_fields
  deferrable initially deferred
  for each row execute function calendar.event_type_fields_need_parent();

create function calendar.event_selected_fields_need_parent() returns trigger language plpgsql as $$
declare
  v_event_id uuid;
begin
  if tg_op = 'DELETE' then
    v_event_id := old.event_id;
  else
    v_event_id := new.event_id;
  end if;
  if not exists (select 1 from calendar.events e where e.id = v_event_id and calendar.written_in_this_transaction(e.xmin)) then
    raise exception 'calendar.event_selected_fields: a selection is written with its event' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger event_selected_fields_need_parent
  after insert or update or delete on calendar.event_selected_fields
  deferrable initially deferred
  for each row execute function calendar.event_selected_fields_need_parent();

create function calendar.event_field_values_need_parent() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from calendar.events e where e.id = new.event_id and calendar.written_in_this_transaction(e.xmin)) then
    raise exception 'calendar.event_field_values: a value is written with its event' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger event_field_values_need_parent
  after insert or update on calendar.event_field_values
  deferrable initially deferred
  for each row execute function calendar.event_field_values_need_parent();

-- 6.10 TRUNCATE, refused on every new table.
create trigger event_fields_no_truncate before truncate on calendar.event_fields for each statement execute function calendar.refuse_truncate();
create trigger event_field_options_no_truncate before truncate on calendar.event_field_options for each statement execute function calendar.refuse_truncate();
create trigger event_type_fields_no_truncate before truncate on calendar.event_type_fields for each statement execute function calendar.refuse_truncate();
create trigger event_selected_fields_no_truncate before truncate on calendar.event_selected_fields for each statement execute function calendar.refuse_truncate();
create trigger event_field_values_no_truncate before truncate on calendar.event_field_values for each statement execute function calendar.refuse_truncate();
create trigger locations_no_truncate before truncate on calendar.locations for each statement execute function calendar.refuse_truncate();
create trigger team_settings_no_truncate before truncate on calendar.team_settings for each statement execute function calendar.refuse_truncate();
create trigger settings_requests_no_truncate before truncate on calendar.settings_requests for each statement execute function calendar.refuse_truncate();
create trigger settings_changes_no_truncate before truncate on calendar.settings_changes for each statement execute function calendar.refuse_truncate();

-- ---------------------------------------------------------------------------
-- 7. Fail-closed self-check: the seed is exactly what this file says.
-- ---------------------------------------------------------------------------
do $$
declare
  v_clubs integer;
  v_system_fields integer;
  v_system_options integer;
  v_system_lists integer;
  v_club_fields integer;
  v_club_options integer;
  v_club_lists integer;
  v_icons integer;
begin
  select count(*) into v_clubs from public.clubs where coalesce(is_active, true);
  select count(*) into v_system_fields from calendar.event_fields where owner_scope = 'system';
  select count(*) into v_system_options from calendar.event_field_options o join calendar.event_fields f on f.id = o.field_id where f.owner_scope = 'system';
  select count(*) into v_system_lists from calendar.event_type_fields l join calendar.event_types t on t.id = l.event_type_id where t.owner_scope = 'system';
  select count(*) into v_club_fields from calendar.event_fields where owner_scope = 'club';
  select count(*) into v_club_options from calendar.event_field_options o join calendar.event_fields f on f.id = o.field_id where f.owner_scope = 'club';
  select count(*) into v_club_lists from calendar.event_type_fields l join calendar.event_types t on t.id = l.event_type_id where t.owner_scope = 'club';
  select count(*) into v_icons from calendar.event_types where icon_key is null;
  if v_system_fields <> 10 or v_system_options <> 17 or v_system_lists <> 13
     or v_club_fields <> 10 * v_clubs or v_club_options <> 17 * v_clubs or v_club_lists <> 13 * v_clubs or v_icons <> 0 then
    raise exception 'calendar v51: the seed is not what was expected (fields %/%, options %/%, lists %/%, clubs %, types without icon %)',
      v_system_fields, v_club_fields, v_system_options, v_club_options, v_system_lists, v_club_lists, v_clubs, v_icons;
  end if;
end $$;
