-- Athletes v88 - an athlete's position and the estimate method position_average.
--
-- The owner's decision (2026-11-22, relayed by the OptiMove manager): „Jedna pozicija po sportisti". The list of positions
-- is edited in Settings -> Tags & Presets; the position is chosen on the athlete. Plan: docs/ai/athlete-positions-plan.md.
-- Runbook: docs/runbooks/athlete-positions-v88.md.
--
-- What this migration does:
--   * public.sport_positions (v42 of the Tests module, empty) stays the one registry of positions (no parallel table). It
--     gains an owner ('system' or 'club' with its club), who created it, who archived it and when, a sort order and
--     updated_at. The id is the identity; a rename changes only the name; an archive takes it out of the pickers and
--     leaves it on the athletes who hold it. A position is never deleted. Clubs carry no sport today, so every position
--     belongs to the sport 'Football', seeded here with six system positions.
--   * public.sport_position_changes: the append-only log of every add, rename, archive and restore (who, the basis, the
--     old and new name, the request key and its hash - the request record of the routes). The v85 pattern.
--   * public.athlete_positions: the append-only history of an athlete's position in a club. One row per change (a set
--     or a clear, position_id null); the athlete's position in the club is the row with the highest seq. An athlete in
--     two clubs holds one position per club (two lists). The row is also the request record of the route.
--   * Guards (the v35 / v85 pattern): every write needs the transaction's acting user
--     (optimove.position_actor = '<user uuid>:<xact id>') with the right: for the list, an active platform admin for a
--     system position and the active club admin of an active club for a club position; for an athlete's position, an
--     active platform admin, the club's active admin, or the active coach of an active team of that club in which the
--     athlete holds an active membership. The rights lock the user first (PR #346). A change of a position without its
--     log row in the same transaction is refused at COMMIT (deferred).
--   * training_load.metric_value_estimates.method also takes 'position_average'; estimate_basis_ok gains its branch
--     (exactly athletes >= 3 and positionId, a uuid); validate_metric_value_estimate lets it estimate an avg variable,
--     as team_average. Every existing branch is unchanged, so every existing row stays valid.
--
-- Lock orders: a list write - the acting user, its role row (FOR SHARE), the club (FOR SHARE), the position row; an
-- athlete's position - the acting user, the role row, the club or the team, the athlete's membership (FOR SHARE), the
-- athlete row (FOR UPDATE: two changes of one athlete are decided one after the other, so seq follows their order).
-- The guards prove that the row, the actor and the right agree; they do not stop whoever holds the database
-- credentials (stated as v35 states it).
-- Rollback: docs/runbooks/athlete-positions-v88-rollback.sql.

-- ---------------------------------------------------------------------------
-- 0. Preconditions
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.sport_positions') is null or to_regclass('public.sports') is null then
    raise exception 'v88 refused: public.sports / public.sport_positions (Tests v42) do not exist' using errcode = '23514';
  end if;
  if (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
       where table_schema = 'public' and table_name = 'sport_positions') is distinct from 'id,sport_id,name,created_at' then
    raise exception 'v88 refused: public.sport_positions is not the v42 shape (id, sport_id, name, created_at)' using errcode = '23514';
  end if;
  if exists (select 1 from public.sport_positions) then
    raise exception 'v88 refused: public.sport_positions already holds a row' using errcode = '23514';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.sport_positions'::regclass
                  and conname = 'sport_positions_sport_id_name_key') then
    raise exception 'v88 refused: the unique (sport_id, name) of v42 is missing' using errcode = '23514';
  end if;
  if to_regclass('public.athlete_positions') is not null or to_regclass('public.sport_position_changes') is not null then
    raise exception 'v88 refused: a v88 table already exists' using errcode = '23514';
  end if;
  if to_regclass('training_load.metric_value_estimates') is null then
    raise exception 'v88 refused: v63 (the estimates) is not applied' using errcode = '23514';
  end if;
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'estimate_basis_ok') is distinct from '1ee471360a969f6895e1e697fa1facc6' then
    raise exception 'v88 refused: the body in force of training_load.estimate_basis_ok is not v69''s' using errcode = '23514';
  end if;
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'validate_metric_value_estimate') is distinct from 'd4fdb1a813a4560651493af644632ea3' then
    raise exception 'v88 refused: the body in force of training_load.validate_metric_value_estimate is not v64''s' using errcode = '23514';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'training_load.metric_value_estimates'::regclass
       and conname = 'metric_value_estimates_method_check')
     is distinct from 'CHECK (((method)::text = ANY ((ARRAY[''proportional''::character varying, ''copy_athlete''::character varying, ''team_average''::character varying, ''scale_recording''::character varying])::text[])))' then
    raise exception 'v88 refused: the method CHECK of metric_value_estimates is not v69''s' using errcode = '23514';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The registry: owner, archive, creator, order; the seed
-- ---------------------------------------------------------------------------
insert into public.sports (name) values ('Football') on conflict (name) do nothing;

alter table public.sport_positions
  add column owner_scope text not null default 'system',
  add column owner_club_id uuid references public.clubs(id) on delete restrict,
  add column created_by_user_id uuid references public.users(id) on delete restrict,
  add column archived_at timestamptz,
  add column archived_by_user_id uuid references public.users(id) on delete restrict,
  add column sort_order integer not null default 100,
  add column updated_at timestamptz not null default now();

-- The seed (before any guard exists; the migration runs without an acting user).
insert into public.sport_positions (sport_id, name, sort_order)
select s.id, v.name, v.sort_order
  from public.sports s
  cross join (values ('Goalkeeper', 10), ('Centre back', 20), ('Full back', 30), ('Midfielder', 40), ('Winger', 50), ('Forward', 60))
       as v(name, sort_order)
 where s.name = 'Football';

-- One live name per owner and sport (an archived position frees its name); v42's unique (sport_id, name) would make
-- two clubs' names collide, so it is replaced by this index.
alter table public.sport_positions drop constraint sport_positions_sport_id_name_key;
alter table public.sport_positions
  add constraint sport_positions_owner_scope_check check (owner_scope in ('system', 'club')),
  add constraint sport_positions_owner_shape check (
    (owner_scope = 'system' and owner_club_id is null) or (owner_scope = 'club' and owner_club_id is not null)),
  add constraint sport_positions_name_check check (training_load.source_metric_text_ok(name, 60)),
  add constraint sport_positions_archived_by_shape check (archived_by_user_id is null or archived_at is not null),
  add constraint sport_positions_sort_order_check check (sort_order between 0 and 10000);
create unique index sport_positions_owner_name_live_key
  on public.sport_positions (sport_id, owner_scope, owner_club_id, lower(name)) nulls not distinct where archived_at is null;
create index sport_positions_owner_club_idx on public.sport_positions (owner_club_id) where owner_club_id is not null;

-- ---------------------------------------------------------------------------
-- 2. The change log of the list (and the request record of its routes)
-- ---------------------------------------------------------------------------
create table public.sport_position_changes (
  id                   uuid primary key default gen_random_uuid(),
  position_id          uuid not null references public.sport_positions(id) on delete restrict,
  action               text not null
                       constraint sport_position_changes_action_check check (action in ('create', 'rename', 'archive', 'restore')),
  old_name             text,
  new_name             text not null
                       constraint sport_position_changes_new_name_check check (training_load.source_metric_text_ok(new_name, 60)),
  performed_by_user_id uuid not null references public.users(id) on delete restrict,
  basis                text not null
                       constraint sport_position_changes_basis_check check (basis in ('platform_admin', 'club_admin')),
  request_key          uuid not null,
  request_hash         text not null constraint sport_position_changes_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  created_xact         text not null default pg_current_xact_id()::text,
  created_at           timestamptz not null default now(),
  constraint sport_position_changes_name_shape check (
    (action = 'create' and old_name is null) or (action <> 'create' and old_name is not null))
);
create unique index sport_position_changes_request_key on public.sport_position_changes (performed_by_user_id, request_key);
create index sport_position_changes_position_idx on public.sport_position_changes (position_id, created_at);

-- ---------------------------------------------------------------------------
-- 3. The athlete's position in a club (append-only history; the latest row is in force)
-- ---------------------------------------------------------------------------
create table public.athlete_positions (
  seq            bigint generated always as identity primary key,
  athlete_id     uuid not null references public.athletes(id) on delete restrict,
  club_id        uuid not null references public.clubs(id) on delete restrict,
  position_id    uuid references public.sport_positions(id) on delete restrict,
  set_by_user_id uuid not null references public.users(id) on delete restrict,
  basis          text not null
                 constraint athlete_positions_basis_check check (basis in ('platform_admin', 'club_admin', 'team_coach')),
  via_team_id    uuid references public.teams(id) on delete restrict,
  request_key    uuid not null,
  request_hash   text not null constraint athlete_positions_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  created_xact   text not null default pg_current_xact_id()::text,
  set_at         timestamptz not null default clock_timestamp(),
  constraint athlete_positions_team_shape check ((basis = 'team_coach') = (via_team_id is not null))
);
create unique index athlete_positions_request_key on public.athlete_positions (set_by_user_id, request_key);
create index athlete_positions_athlete_club_idx on public.athlete_positions (athlete_id, club_id, seq desc);
create index athlete_positions_position_idx on public.athlete_positions (position_id) where position_id is not null;

-- The position in force of an athlete in a club, or null (none set, or cleared).
create function public.athlete_position_in_force(p_athlete uuid, p_club uuid) returns uuid as $$
  select position_id from public.athlete_positions
   where athlete_id = p_athlete and club_id = p_club
   order by seq desc limit 1;
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- 4. The acting user and the rights
-- ---------------------------------------------------------------------------
create function public.position_actor() returns uuid as $$
declare
  raw text := current_setting('optimove.position_actor', true);
begin
  if raw is null
     or raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,20}$'
     or split_part(raw, ':', 2) is distinct from pg_current_xact_id()::text then
    raise exception 'position: no acting user is set for this transaction' using errcode = '42501';
  end if;
  return split_part(raw, ':', 1)::uuid;
end;
$$ language plpgsql;

-- The basis on which p_user may write a position of this owner, or null. Users first, then the role row, then the club
-- (PR #346); every row FOR SHARE.
create function public.sport_position_basis(p_user uuid, p_owner_scope text, p_club uuid) returns text as $$
begin
  perform 1 from public.users u where u.id = p_user and u.is_active = true for share;
  if not found then
    return null;
  end if;
  if p_owner_scope = 'system' then
    perform 1 from public.user_global_roles r
     where r.user_id = p_user and r.role = 'platform_admin' and r.is_active = true for share of r;
    return case when found then 'platform_admin' end;
  end if;
  if p_owner_scope = 'club' and p_club is not null then
    perform 1 from public.user_club_roles r
     where r.user_id = p_user and r.club_id = p_club and r.role = 'club_admin' and r.is_active = true for share of r;
    if not found then
      return null;
    end if;
    perform 1 from public.clubs c where c.id = p_club and c.is_active = true for share;
    return case when found then 'club_admin' end;
  end if;
  return null;
end;
$$ language plpgsql;

-- Whether p_user may set the position of p_athlete in p_club on the named basis (and, for team_coach, through p_team).
-- Users first, then the role row, then the club or the team, then the athlete's membership; every row FOR SHARE.
create function public.athlete_position_right(p_user uuid, p_athlete uuid, p_club uuid, p_basis text, p_team uuid)
returns boolean as $$
begin
  perform 1 from public.users u where u.id = p_user and u.is_active = true for share;
  if not found then
    return false;
  end if;
  if p_basis = 'platform_admin' and p_team is null then
    perform 1 from public.user_global_roles r
     where r.user_id = p_user and r.role = 'platform_admin' and r.is_active = true for share of r;
    if not found then
      return false;
    end if;
    perform 1 from public.clubs c where c.id = p_club and c.is_active = true for share;
    if not found then
      return false;
    end if;
  elsif p_basis = 'club_admin' and p_team is null then
    perform 1 from public.user_club_roles r
     where r.user_id = p_user and r.club_id = p_club and r.role = 'club_admin' and r.is_active = true for share of r;
    if not found then
      return false;
    end if;
    perform 1 from public.clubs c where c.id = p_club and c.is_active = true for share;
    if not found then
      return false;
    end if;
  elsif p_basis = 'team_coach' and p_team is not null then
    perform 1 from public.user_team_roles r
     where r.user_id = p_user and r.team_id = p_team and r.role = 'team_coach' and r.is_active = true for share of r;
    if not found then
      return false;
    end if;
    perform 1 from public.teams t where t.id = p_team and t.club_id = p_club and t.is_active = true for share;
    if not found then
      return false;
    end if;
    perform 1 from public.clubs c where c.id = p_club and c.is_active = true for share;
    if not found then
      return false;
    end if;
    perform 1 from public.athlete_memberships m
     where m.athlete_id = p_athlete and m.club_id = p_club and m.team_id = p_team and m.membership_type = 'team'
       and m.status = 'active' for share;
    return found;
  else
    return false;
  end if;
  -- An admin sets the position of an athlete who holds an active membership in the club (club or team).
  perform 1 from public.athlete_memberships m
   where m.athlete_id = p_athlete and m.club_id = p_club and m.status = 'active' for share;
  return found;
end;
$$ language plpgsql;

-- Whether a position is offered to a club (a system position, or the club's own), and, with p_require_active, still
-- active. The position row is locked FOR SHARE.
create function public.sport_position_offered(p_position uuid, p_club uuid, p_require_active boolean) returns boolean as $$
declare
  v record;
begin
  select owner_scope, owner_club_id, archived_at into v from public.sport_positions where id = p_position for share;
  if not found then
    return false;
  end if;
  if v.owner_scope = 'club' and v.owner_club_id is distinct from p_club then
    return false;
  end if;
  return not p_require_active or v.archived_at is null;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 5. Guards on public.sport_positions
-- ---------------------------------------------------------------------------
create function public.sport_positions_before_write() returns trigger as $$
declare
  v_actor uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'public.sport_positions: a position is never deleted; archive it' using errcode = '23514';
  end if;
  v_actor := public.position_actor();
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.sport_id is distinct from old.sport_id
       or new.owner_scope is distinct from old.owner_scope or new.owner_club_id is distinct from old.owner_club_id
       or new.created_by_user_id is distinct from old.created_by_user_id or new.created_at is distinct from old.created_at then
      raise exception 'public.sport_positions: id, sport, owner and creator are write-once' using errcode = '23514';
    end if;
    if (new.archived_at is null) is distinct from (old.archived_at is null) then
      if new.archived_at is null then
        if new.archived_by_user_id is not null then
          raise exception 'public.sport_positions: a restore clears the archive' using errcode = '23514';
        end if;
      elsif new.archived_by_user_id is distinct from v_actor then
        raise exception 'public.sport_positions: an archive names the acting user' using errcode = '23514';
      end if;
    elsif new.archived_at is distinct from old.archived_at or new.archived_by_user_id is distinct from old.archived_by_user_id then
      raise exception 'public.sport_positions: the archive changes only with the archive state' using errcode = '23514';
    end if;
    new.updated_at := now();
  else
    if new.created_by_user_id is distinct from v_actor then
      raise exception 'public.sport_positions: a new position names the acting user as its creator' using errcode = '23514';
    end if;
    if new.archived_at is not null or new.archived_by_user_id is not null then
      raise exception 'public.sport_positions: a new position is active' using errcode = '23514';
    end if;
  end if;
  if public.sport_position_basis(v_actor, new.owner_scope, new.owner_club_id) is null then
    raise exception 'public.sport_positions: the acting user may not write this position' using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger sport_positions_before_write
  before insert or update or delete on public.sport_positions
  for each row execute function public.sport_positions_before_write();

create function public.sport_positions_no_truncate() returns trigger as $$
begin
  raise exception 'public.sport_positions: a position is never deleted; archive it' using errcode = '23514';
end;
$$ language plpgsql;
create trigger sport_positions_no_truncate before truncate on public.sport_positions
  for each statement execute function public.sport_positions_no_truncate();

create function public.sport_positions_change_logged() returns trigger as $$
begin
  if not exists (select 1 from public.sport_position_changes c
                  where c.position_id = new.id and c.created_xact = pg_current_xact_id()::text) then
    raise exception 'public.sport_positions: a change of a position needs its log row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;
create constraint trigger sport_positions_change_logged
  after insert or update on public.sport_positions deferrable initially deferred
  for each row execute function public.sport_positions_change_logged();

-- ---------------------------------------------------------------------------
-- 6. Guards on the list's log
-- ---------------------------------------------------------------------------
create function public.sport_position_changes_before_insert() returns trigger as $$
declare
  v_actor uuid := public.position_actor();
  v record;
begin
  if new.performed_by_user_id is distinct from v_actor then
    raise exception 'public.sport_position_changes: the row names the acting user' using errcode = '42501';
  end if;
  if new.created_xact is distinct from pg_current_xact_id()::text then
    raise exception 'public.sport_position_changes: created_xact is the writing transaction' using errcode = '23514';
  end if;
  select owner_scope, owner_club_id, name, archived_at into v from public.sport_positions where id = new.position_id;
  if not found then
    raise exception 'public.sport_position_changes: no such position' using errcode = '23514';
  end if;
  if new.basis is distinct from public.sport_position_basis(v_actor, v.owner_scope, v.owner_club_id) then
    raise exception 'public.sport_position_changes: the basis is not the acting user''s right' using errcode = '42501';
  end if;
  if new.new_name is distinct from v.name
     or (new.action = 'rename' and new.old_name is not distinct from new.new_name)
     or (new.action = 'archive' and v.archived_at is null)
     or (new.action in ('create', 'restore', 'rename') and v.archived_at is not null) then
    raise exception 'public.sport_position_changes: the row does not match the position' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger sport_position_changes_before_insert
  before insert on public.sport_position_changes
  for each row execute function public.sport_position_changes_before_insert();

create function public.position_history_append_only() returns trigger as $$
begin
  raise exception '%: append-only', tg_table_name using errcode = '23514';
end;
$$ language plpgsql;
create trigger sport_position_changes_no_update before update or delete on public.sport_position_changes
  for each row execute function public.position_history_append_only();
create trigger sport_position_changes_no_truncate before truncate on public.sport_position_changes
  for each statement execute function public.position_history_append_only();

-- ---------------------------------------------------------------------------
-- 7. Guards on an athlete's position
-- ---------------------------------------------------------------------------
create function public.athlete_positions_before_insert() returns trigger as $$
declare
  v_actor uuid := public.position_actor();
begin
  if new.set_by_user_id is distinct from v_actor then
    raise exception 'public.athlete_positions: the row names the acting user' using errcode = '42501';
  end if;
  if new.created_xact is distinct from pg_current_xact_id()::text then
    raise exception 'public.athlete_positions: created_xact is the writing transaction' using errcode = '23514';
  end if;
  if not public.athlete_position_right(v_actor, new.athlete_id, new.club_id, new.basis, new.via_team_id) then
    raise exception 'public.athlete_positions: the acting user may not set this athlete''s position' using errcode = '42501';
  end if;
  -- The athlete row last: two changes of one athlete are decided one after the other.
  perform 1 from public.athletes a where a.id = new.athlete_id for update;
  if new.position_id is not null and not public.sport_position_offered(new.position_id, new.club_id, true) then
    raise exception 'public.athlete_positions: the position is not offered to this club' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger athlete_positions_before_insert
  before insert on public.athlete_positions
  for each row execute function public.athlete_positions_before_insert();
create trigger athlete_positions_no_update before update or delete on public.athlete_positions
  for each row execute function public.position_history_append_only();
create trigger athlete_positions_no_truncate before truncate on public.athlete_positions
  for each statement execute function public.position_history_append_only();

-- ---------------------------------------------------------------------------
-- 8. The estimate method position_average (v69's method CHECK and basis, v64's provenance guard; one branch each)
-- ---------------------------------------------------------------------------
alter table training_load.metric_value_estimates drop constraint metric_value_estimates_method_check;
alter table training_load.metric_value_estimates add constraint metric_value_estimates_method_check
  check (method in ('proportional', 'copy_athlete', 'team_average', 'scale_recording', 'position_average'));

create or replace function training_load.estimate_basis_ok(p_method text, p_basis jsonb) returns boolean as $$
  select case p_method
    when 'proportional' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['minutes', 'ratePerMinute', 'sessions']
      and jsonb_typeof(p_basis -> 'minutes') = 'number' and (p_basis ->> 'minutes')::numeric > 0 and (p_basis ->> 'minutes')::numeric <= 1440
      and jsonb_typeof(p_basis -> 'ratePerMinute') = 'number' and (p_basis ->> 'ratePerMinute')::numeric >= 0
      and jsonb_typeof(p_basis -> 'sessions') = 'number' and (p_basis ->> 'sessions') ~ '^[0-9]{1,3}$' and (p_basis ->> 'sessions')::int between 3 and 5
    when 'copy_athlete' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['sourceAthleteId']
      and jsonb_typeof(p_basis -> 'sourceAthleteId') = 'string'
      and (p_basis ->> 'sourceAthleteId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    when 'team_average' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['athletes']
      and jsonb_typeof(p_basis -> 'athletes') = 'number' and (p_basis ->> 'athletes') ~ '^[0-9]{1,4}$' and (p_basis ->> 'athletes')::int >= 3
    when 'scale_recording' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['measured', 'recordedMinutes', 'targetMinutes']
      and jsonb_typeof(p_basis -> 'measured') = 'number' and (p_basis ->> 'measured')::numeric >= 0
      and jsonb_typeof(p_basis -> 'recordedMinutes') = 'number' and jsonb_typeof(p_basis -> 'targetMinutes') = 'number'
      and (p_basis ->> 'recordedMinutes')::numeric > 0
      and (p_basis ->> 'recordedMinutes')::numeric < (p_basis ->> 'targetMinutes')::numeric
      and (p_basis ->> 'targetMinutes')::numeric <= 600
    when 'position_average' then
      jsonb_typeof(p_basis) = 'object'
      and (select array_agg(k order by k) from jsonb_object_keys(p_basis) k) = array['athletes', 'positionId']
      and jsonb_typeof(p_basis -> 'athletes') = 'number' and (p_basis ->> 'athletes') ~ '^[0-9]{1,4}$' and (p_basis ->> 'athletes')::int >= 3
      and jsonb_typeof(p_basis -> 'positionId') = 'string'
      and (p_basis ->> 'positionId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    else false
  end;
$$ language sql immutable;

create or replace function training_load.validate_metric_value_estimate() returns trigger as $$
declare
  v_val record;
begin
  select v.occasion_id, o.entry_method, o.recorded_by_user_id, dv.daily_aggregation_method
    into v_val
    from training_load.metric_values v
    join training_load.metric_measurement_occasions o on o.id = v.occasion_id
    join training_load.metric_definition_versions dv on dv.id = v.metric_definition_version_id
   where v.id = new.metric_value_id;
  if not found or v_val.entry_method is distinct from 'estimate' or v_val.occasion_id is distinct from new.occasion_id then
    raise exception 'estimate: the provenance row belongs to an estimated value of its occasion' using errcode = '23514';
  end if;
  if new.estimated_by_user_id is distinct from v_val.recorded_by_user_id
     or new.estimated_by_user_id is distinct from training_load.estimate_context_actor() then
    raise exception 'estimate: the author must be the acting user' using errcode = '42501';
  end if;
  if not (v_val.daily_aggregation_method = 'sum'
          or (v_val.daily_aggregation_method = 'avg' and new.method in ('copy_athlete', 'team_average', 'position_average'))) then
    raise exception 'estimate: this method is not allowed for this variable' using errcode = '23514';
  end if;
  -- v64: one request key names one request. The (author, key) lock serialises two saves of one key (two teams' sessions
  -- at once, where the team lock does not serialise them); the check below then reads in a new snapshot.
  perform pg_advisory_xact_lock(hashtextextended('estimate-request:' || new.estimated_by_user_id::text || ':' || new.request_key::text, 64));
  if exists (select 1 from training_load.metric_value_estimates e
              where e.estimated_by_user_id = new.estimated_by_user_id and e.request_key = new.request_key
                and e.request_hash is distinct from new.request_hash) then
    raise exception 'estimate: a request key names one request' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
