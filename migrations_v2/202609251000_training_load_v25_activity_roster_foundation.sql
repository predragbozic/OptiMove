-- Training Load v25 — session roster foundation (Phase 5a1).
--
-- Contract: docs/ai/phase5a-discovery-and-contract.md (v2.1, approved by the
-- owner 2026-09-25 with decisions O1 = (a), O2 = team coach + club admin +
-- platform admin, and the completion downgrade triggers moved to 5a2).
--
-- What this migration adds, and nothing more:
--   1. public.athlete_membership_periods — the history of a team/club
--      membership, written by a trigger on public.athlete_memberships and
--      backfilled here. The membership row itself is unchanged (Settings keeps
--      reviving the same row on restore, organization.js ensureActiveMembership);
--      a second trigger refuses a change of a membership's identity columns.
--   2. training.activity_roster(activity) — the team's roster on the session
--      date, one row per athlete.
--   3. training.participation_reasons — the reason catalog, seeded.
--   4. training.activity_roster_requests, training.activity_athlete_decisions,
--      training.activity_completions, training.activity_completion_log — the
--      tables the 5a2 commands write. Nothing in the application writes them
--      in 5a1; their integrity and append-only rules are enforced here.
--   5. training.activity_source_observations — a source-neutral "this
--      athlete's device record is not usable" fact, written by an import
--      approval in the same transaction (gpexeImportService.approveCandidate).
--   6. training.lock_activity_decider(user, team, basis) — the right to decide
--      on a team's roster through ONE named authorization path.
--
-- Deliberately NOT here (5a2, together with the complete/reopen commands):
-- the triggers that turn a complete session into needs_review when an
-- occasion, link, membership, merge or observation changes. Until 5a2 no
-- code can set a completion to complete, so there is nothing to downgrade.
--
-- Guards that a sanctioned writer switches off for one statement use a
-- transaction-local setting (same pattern as training.allow_supersede_write,
-- v1): optimove.membership_period_write. It keeps an accidental raw write
-- out; it is not a defence against a database owner who sets it on purpose.
--
-- Lock order for the 5a2 writes (documented here so the triggers below are
-- read with it in mind): training.lock_activity_decider (team row, role row
-- and user row FOR SHARE) -> the team import advisory lock
-- (gpexeImportWriter.lockTeamForImport) -> completion rows FOR UPDATE in
-- ascending activity id -> request lookup and inserts. The GPEXE approval
-- keeps its v23 order and writes observations after the team import lock.
--
-- Known limitation (recorded in the contract, section 3.1): a membership that
-- was archived and restored BEFORE this migration lost its gap, because the
-- restore revives the same row; its backfilled period starts at starts_at and
-- is still open, so the athlete appears on rosters inside that gap
-- (over-inclusion, never omission).

-- ---------------------------------------------------------------------------
-- 0. Shared refusal for TRUNCATE of a history table.
-- ---------------------------------------------------------------------------
create function training.roster_history_no_truncate() returns trigger as $$
begin
  raise exception '%.% keeps history; TRUNCATE refused', tg_table_schema, tg_table_name;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 1. Membership periods.
-- ---------------------------------------------------------------------------
create table public.athlete_membership_periods (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.athlete_memberships(id) on delete cascade,
  athlete_id uuid not null,
  club_id uuid not null,
  team_id uuid,
  membership_type varchar(20) not null check (membership_type in ('club', 'team')),
  valid_from timestamptz not null,
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from),
  check ((membership_type = 'club' and team_id is null) or (membership_type = 'team' and team_id is not null))
);
create unique index athlete_membership_periods_one_open_idx
  on public.athlete_membership_periods (membership_id) where valid_to is null;
create index athlete_membership_periods_team_idx
  on public.athlete_membership_periods (team_id, valid_from) where membership_type = 'team';
create index athlete_membership_periods_athlete_idx
  on public.athlete_membership_periods (athlete_id);
-- Every period of one membership, open or closed (the restore's previous
-- end, and the cascade from a deleted membership).
create index athlete_membership_periods_membership_idx
  on public.athlete_membership_periods (membership_id);

-- A period is written only by the membership trigger (and the backfill
-- below), copies its membership exactly, and is closed at most once. It is
-- removed only together with its membership (ON DELETE CASCADE).
create function public.protect_athlete_membership_period() returns trigger as $$
declare
  m record;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.athlete_memberships where id = old.membership_id) then
      raise exception 'athlete_membership_periods: a period is removed only with its membership (period %)', old.id;
    end if;
    return old;
  end if;
  if current_setting('optimove.membership_period_write', true) is distinct from 'on' then
    raise exception 'athlete_membership_periods: written only by the membership trigger (% refused)', tg_op;
  end if;
  if tg_op = 'INSERT' then
    select athlete_id, club_id, team_id, membership_type into m from public.athlete_memberships where id = new.membership_id;
    if not found
       or m.athlete_id is distinct from new.athlete_id or m.club_id is distinct from new.club_id
       or m.team_id is distinct from new.team_id or m.membership_type is distinct from new.membership_type then
      raise exception 'athlete_membership_periods: the period does not copy membership %', new.membership_id;
    end if;
    return new;
  end if;
  -- UPDATE: only closing an open period, once.
  if old.valid_to is not null or new.valid_to is null
     or new.id is distinct from old.id or new.membership_id is distinct from old.membership_id
     or new.athlete_id is distinct from old.athlete_id or new.club_id is distinct from old.club_id
     or new.team_id is distinct from old.team_id or new.membership_type is distinct from old.membership_type
     or new.valid_from is distinct from old.valid_from or new.created_at is distinct from old.created_at then
    raise exception 'athlete_membership_periods: a period only gets its end once (period %)', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger athlete_membership_periods_protect
  before insert or update or delete on public.athlete_membership_periods
  for each row execute function public.protect_athlete_membership_period();
create trigger athlete_membership_periods_no_truncate
  before truncate on public.athlete_membership_periods
  for each statement execute function training.roster_history_no_truncate();

-- The identity of a membership never changes: its periods copy it, and the
-- application never changes it (it archives and restores the same row).
create function public.protect_athlete_membership_identity() returns trigger as $$
begin
  if new.athlete_id is distinct from old.athlete_id or new.club_id is distinct from old.club_id
     or new.team_id is distinct from old.team_id or new.membership_type is distinct from old.membership_type then
    raise exception 'athlete_memberships (id=%): athlete, club, team and membership type never change — archive it and add a new membership', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger athlete_memberships_protect_identity
  before update on public.athlete_memberships
  for each row execute function public.protect_athlete_membership_identity();

-- Every legal status change and what it does to the periods:
--   insert active | paused          -> open a period at starts_at
--   insert archived                 -> a closed period [starts_at, archived_at or now()]
--   active <-> paused               -> nothing (still a member)
--   active | paused -> archived     -> close the open period at archived_at or now()
--   archived -> active | paused     -> open a new period at now()
-- Opening when a period is already open, or closing when none is open, does
-- nothing, so a Settings write is never refused because of the history.
create function public.record_athlete_membership_period() returns trigger as $$
declare
  previous text := current_setting('optimove.membership_period_write', true);
  member_before boolean;
  member_after boolean := new.status in ('active', 'paused');
begin
  perform set_config('optimove.membership_period_write', 'on', true);
  if tg_op = 'INSERT' then
    if member_after then
      insert into public.athlete_membership_periods (membership_id, athlete_id, club_id, team_id, membership_type, valid_from)
      values (new.id, new.athlete_id, new.club_id, new.team_id, new.membership_type, new.starts_at);
    else
      insert into public.athlete_membership_periods (membership_id, athlete_id, club_id, team_id, membership_type, valid_from, valid_to)
      values (new.id, new.athlete_id, new.club_id, new.team_id, new.membership_type, new.starts_at,
              greatest(new.starts_at, coalesce(new.archived_at, now())));
    end if;
  elsif new.status is distinct from old.status then
    member_before := old.status in ('active', 'paused');
    if member_before and not member_after then
      update public.athlete_membership_periods
         set valid_to = greatest(valid_from, coalesce(new.archived_at, now()))
       where membership_id = new.id and valid_to is null;
    elsif member_after and not member_before then
      -- now() is the transaction's START: a restore that waited on the row
      -- lock behind an archive may have started before that archive's end.
      -- The new period never starts before the previous one ended, so the
      -- periods of one membership never overlap.
      insert into public.athlete_membership_periods (membership_id, athlete_id, club_id, team_id, membership_type, valid_from)
      select new.id, new.athlete_id, new.club_id, new.team_id, new.membership_type,
             greatest(now(), coalesce((select max(p.valid_to) from public.athlete_membership_periods p where p.membership_id = new.id), now()))
       where not exists (select 1 from public.athlete_membership_periods where membership_id = new.id and valid_to is null);
    end if;
  end if;
  perform set_config('optimove.membership_period_write', coalesce(previous, ''), true);
  return null;
end;
$$ language plpgsql;

-- Backfill, before the trigger exists: one period per existing membership.
-- An archived row without archived_at (possible only from raw writes) is
-- closed at updated_at. The counts are reported and must match.
do $$
declare
  memberships integer;
  periods integer;
  open_periods integer;
  archived_without_time integer;
begin
  perform set_config('optimove.membership_period_write', 'on', true);
  select count(*) into memberships from public.athlete_memberships;
  select count(*) into archived_without_time from public.athlete_memberships where status = 'archived' and archived_at is null;
  insert into public.athlete_membership_periods (membership_id, athlete_id, club_id, team_id, membership_type, valid_from, valid_to)
  select id, athlete_id, club_id, team_id, membership_type, starts_at,
         case when status = 'archived' then greatest(starts_at, coalesce(archived_at, updated_at)) end
    from public.athlete_memberships;
  select count(*), count(*) filter (where valid_to is null) into periods, open_periods from public.athlete_membership_periods;
  perform set_config('optimove.membership_period_write', '', true);
  if periods <> memberships then
    raise exception 'v25 backfill: % memberships but % periods', memberships, periods;
  end if;
  raise notice 'v25 backfill: % memberships -> % periods (% open, % closed; % archived without archived_at closed at updated_at)',
    memberships, periods, open_periods, periods - open_periods, archived_without_time;
end;
$$;

create trigger athlete_memberships_record_period
  after insert or update of status on public.athlete_memberships
  for each row execute function public.record_athlete_membership_period();

-- ---------------------------------------------------------------------------
-- 2. The roster of a team-owned activity on its session date.
-- ---------------------------------------------------------------------------
-- Members of the activity's owner team whose period covers the session start
-- (valid_from <= started_at < valid_to); without a start time, whose period
-- overlaps the activity's local day in its own time zone. One row per athlete
-- however many memberships cover the session. left_at: the end of the
-- athlete's last period in this team when none is open now (left the team
-- later), otherwise null. Empty for an activity that is not team-owned.
create function training.activity_roster(p_activity_id uuid)
returns table (athlete_id uuid, member_from timestamptz, member_to timestamptz, left_at timestamptz) as $$
  with a as (
    select owner_team_id, started_at,
           (occurred_local_date::timestamp at time zone timezone_snapshot) as day_start,
           ((occurred_local_date + 1)::timestamp at time zone timezone_snapshot) as day_end
      from training.activities
     where id = p_activity_id and owner_scope = 'team'
  ),
  team_periods as (
    select p.athlete_id, p.valid_from, p.valid_to
      from a join public.athlete_membership_periods p
        on p.team_id = a.owner_team_id and p.membership_type = 'team'
  ),
  covering as (
    select tp.athlete_id, tp.valid_from, tp.valid_to
      from team_periods tp cross join a
     where case when a.started_at is not null
                then tp.valid_from <= a.started_at and a.started_at < coalesce(tp.valid_to, 'infinity')
                else tp.valid_from < a.day_end and coalesce(tp.valid_to, 'infinity') > a.day_start
           end
  )
  select c.athlete_id,
         min(c.valid_from),
         case when bool_or(c.valid_to is null) then null else max(c.valid_to) end,
         (select case when bool_or(tp.valid_to is null) then null else max(tp.valid_to) end
            from team_periods tp where tp.athlete_id = c.athlete_id)
    from covering c
   group by c.athlete_id;
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- 3. Right to decide on a team's roster, through one named path.
-- ---------------------------------------------------------------------------
-- p_basis is the path the caller actually used in its active workspace
-- (team workspace -> team_coach, club workspace -> club_admin, platform
-- workspace -> platform_admin); holding a stronger role elsewhere is not a
-- substitute. The team (active), the role row, the user row (active) and,
-- for club_admin, the club row (active) are held FOR SHARE until the
-- transaction ends, so an archive, a role removal or a deactivation waits
-- for, or is seen by, the write. Raises 42501 otherwise.
create function training.lock_activity_decider(p_user_id uuid, p_team_id uuid, p_basis varchar)
returns varchar as $$
declare
  v_club_id uuid;
begin
  if p_basis is null or p_basis not in ('team_coach', 'club_admin', 'platform_admin') then
    raise exception 'lock_activity_decider: unknown basis %', p_basis using errcode = 'invalid_parameter_value';
  end if;
  select club_id into v_club_id from public.teams where id = p_team_id and coalesce(is_active, true) for share;
  if not found then
    raise exception 'user % may not decide on the roster of team %', p_user_id, p_team_id using errcode = 'insufficient_privilege';
  end if;
  if p_basis = 'team_coach' then
    perform 1 from public.user_team_roles r join public.users u on u.id = r.user_id
     where r.user_id = p_user_id and r.team_id = p_team_id and r.role = 'team_coach' and r.is_active = true and u.is_active = true
       for share of r, u;
  elsif p_basis = 'club_admin' then
    perform 1 from public.user_club_roles r join public.users u on u.id = r.user_id
      join public.clubs c on c.id = r.club_id
     where r.user_id = p_user_id and r.club_id = v_club_id and r.role = 'club_admin' and r.is_active = true
       and u.is_active = true and coalesce(c.is_active, true)
       for share of r, u, c;
  else
    perform 1 from public.user_global_roles r join public.users u on u.id = r.user_id
     where r.user_id = p_user_id and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
       for share of r, u;
  end if;
  if not found then
    raise exception 'user % may not decide on the roster of team % as %', p_user_id, p_team_id, p_basis using errcode = 'insufficient_privilege';
  end if;
  return p_basis;
end;
$$ language plpgsql;

-- Shared by every new table that points at an activity: the activity exists,
-- is the canonical one (not superseded), is team-owned, and (when given)
-- belongs to that team.
create function training.assert_canonical_team_activity(p_activity_id uuid, p_owner_team_id uuid, p_what text)
returns uuid as $$
declare
  act record;
begin
  select owner_scope, owner_team_id, superseded_by_activity_id into act from training.activities where id = p_activity_id;
  if not found then
    raise exception '%: activity % does not exist', p_what, p_activity_id;
  end if;
  if act.superseded_by_activity_id is not null then
    raise exception '%: activity % was superseded by %; write to the canonical activity', p_what, p_activity_id, act.superseded_by_activity_id;
  end if;
  if act.owner_scope <> 'team' then
    raise exception '%: activity % is not team-owned; only a team session has a roster', p_what, p_activity_id;
  end if;
  if p_owner_team_id is not null and act.owner_team_id is distinct from p_owner_team_id then
    raise exception '%: owner_team_id % is not the team of activity %', p_what, p_owner_team_id, p_activity_id;
  end if;
  return act.owner_team_id;
end;
$$ language plpgsql stable;

-- ---------------------------------------------------------------------------
-- 4. Reason catalog.
-- ---------------------------------------------------------------------------
create table training.participation_reasons (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text not null check (length(btrim(label)) between 1 and 80),
  sort_order smallint not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into training.participation_reasons (key, label, sort_order) values
  ('non_contact_injury', 'Injury (non-contact)', 10),
  ('contact_injury', 'Injury (contact)', 20),
  ('illness', 'Illness', 30),
  ('load_management', 'Load management', 40),
  ('other_team', 'With another team', 50),
  ('other', 'Other', 90);

-- A key is referenced by decisions for ever: it is deactivated, never
-- renamed or removed.
create function training.protect_participation_reason() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'participation_reasons: reason % is deactivated, never deleted', old.key;
  end if;
  if new.key is distinct from old.key then
    raise exception 'participation_reasons: the key % never changes', old.key;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger participation_reasons_protect
  before update or delete on training.participation_reasons
  for each row execute function training.protect_participation_reason();
create trigger participation_reasons_no_truncate
  before truncate on training.participation_reasons
  for each statement execute function training.roster_history_no_truncate();

-- ---------------------------------------------------------------------------
-- 5. Requests (idempotency per request) — append-only.
-- ---------------------------------------------------------------------------
create table training.activity_roster_requests (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references training.activities(id),
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  operation varchar(20) not null check (operation in ('decide', 'decide_bulk', 'clear', 'complete', 'reopen')),
  performed_by_user_id uuid not null references public.users(id),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  unique (activity_id, request_key)
);

create function training.protect_activity_roster_request() returns trigger as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'activity_roster_requests is append-only (% refused)', tg_op;
  end if;
  perform training.assert_canonical_team_activity(new.activity_id, null, 'activity_roster_requests');
  return new;
end;
$$ language plpgsql;

create trigger activity_roster_requests_protect
  before insert or update or delete on training.activity_roster_requests
  for each row execute function training.protect_activity_roster_request();
create trigger activity_roster_requests_no_truncate
  before truncate on training.activity_roster_requests
  for each statement execute function training.roster_history_no_truncate();

-- ---------------------------------------------------------------------------
-- 6. Decisions — append-only with a current pointer.
-- ---------------------------------------------------------------------------
-- request_id and superseded_by_decision_id are checked at commit (deferred):
-- a write inserts its decisions and then the one request row that carries
-- the answer, and points the previous decision at the new one before the new
-- one exists (the one-current index allows only one current row at a time).
create table training.activity_athlete_decisions (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references training.activities(id),
  athlete_id uuid not null references public.athletes(id),
  owner_team_id uuid not null references public.teams(id),
  request_id uuid not null references training.activity_roster_requests(id) deferrable initially deferred,
  decision_kind varchar(30) not null check (decision_kind in
    ('did_not_participate', 'participated_no_values', 'manual_values', 'estimated', 'cleared')),
  reason_key text references training.participation_reasons(key),
  note text check (note is null or length(note) <= 500),
  occasion_id uuid references training_load.metric_measurement_occasions(id),
  decided_by_user_id uuid not null references public.users(id),
  decided_by_basis varchar(20) not null check (decided_by_basis in ('team_coach', 'club_admin', 'platform_admin')),
  decided_at timestamptz not null default now(),
  superseded_by_decision_id uuid references training.activity_athlete_decisions(id) deferrable initially deferred,
  superseded_at timestamptz,
  check ((decision_kind = 'did_not_participate') = (reason_key is not null)),
  check ((decision_kind in ('manual_values', 'estimated')) = (occasion_id is not null)),
  check ((superseded_by_decision_id is null) = (superseded_at is null)),
  check (superseded_by_decision_id is null or superseded_by_decision_id <> id),
  unique (request_id, athlete_id)
);
create unique index activity_athlete_decisions_one_current
  on training.activity_athlete_decisions (activity_id, athlete_id) where superseded_by_decision_id is null;
create index activity_athlete_decisions_athlete_idx on training.activity_athlete_decisions (athlete_id);

create function training.check_activity_athlete_decision() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'activity_athlete_decisions is append-only; a decision is superseded, never deleted (decision %)', old.id;
  end if;
  if tg_op = 'UPDATE' then
    if old.superseded_by_decision_id is not null or new.superseded_by_decision_id is null
       or new.id is distinct from old.id or new.activity_id is distinct from old.activity_id
       or new.athlete_id is distinct from old.athlete_id or new.owner_team_id is distinct from old.owner_team_id
       or new.request_id is distinct from old.request_id or new.decision_kind is distinct from old.decision_kind
       or new.reason_key is distinct from old.reason_key or new.note is distinct from old.note
       or new.occasion_id is distinct from old.occasion_id or new.decided_by_user_id is distinct from old.decided_by_user_id
       or new.decided_by_basis is distinct from old.decided_by_basis or new.decided_at is distinct from old.decided_at then
      raise exception 'activity_athlete_decisions: a decision only gets superseded, once (decision %)', old.id;
    end if;
    return new;
  end if;

  -- INSERT
  if new.superseded_by_decision_id is not null then
    raise exception 'activity_athlete_decisions: a new decision is current';
  end if;
  perform training.assert_canonical_team_activity(new.activity_id, new.owner_team_id, 'activity_athlete_decisions');
  if not exists (select 1 from training.activity_roster(new.activity_id) r where r.athlete_id = new.athlete_id) then
    raise exception 'activity_athlete_decisions: athlete % is not on the roster of activity %', new.athlete_id, new.activity_id;
  end if;
  if new.decision_kind in ('manual_values', 'estimated') then
    raise exception 'activity_athlete_decisions: % is not available yet (Phase 5b)', new.decision_kind;
  end if;
  if new.reason_key is not null and not exists (
    select 1 from training.participation_reasons where key = new.reason_key and is_active
  ) then
    raise exception 'activity_athlete_decisions: reason % is not active', new.reason_key;
  end if;
  -- A measured record is never overridden by a coach decision; only
  -- 'cleared' (back to the derived state) is allowed next to one.
  if new.decision_kind <> 'cleared' and exists (
    select 1 from training.canonical_activity_results(new.activity_id) r
     where r.fact_kind = 'metric_value' and r.athlete_id = new.athlete_id
       and r.detail ->> 'entryMethod' in ('api_import', 'csv_import')
  ) then
    raise exception 'activity_athlete_decisions: athlete % has a measured record in activity %', new.athlete_id, new.activity_id
      using errcode = 'check_violation';
  end if;
  perform training.lock_activity_decider(new.decided_by_user_id, new.owner_team_id, new.decided_by_basis);
  return new;
end;
$$ language plpgsql;

create trigger activity_athlete_decisions_check
  before insert or update or delete on training.activity_athlete_decisions
  for each row execute function training.check_activity_athlete_decision();
create trigger activity_athlete_decisions_no_truncate
  before truncate on training.activity_athlete_decisions
  for each statement execute function training.roster_history_no_truncate();

-- At commit: the request belongs to the decision's activity, and a
-- superseding decision is a decision about the same athlete of the same team
-- in the same alias set.
create function training.check_activity_athlete_decision_links() returns trigger as $$
declare
  req_activity uuid;
  sup record;
begin
  select activity_id into req_activity from training.activity_roster_requests where id = new.request_id;
  if req_activity is distinct from new.activity_id then
    raise exception 'activity_athlete_decisions: request % does not belong to activity %', new.request_id, new.activity_id;
  end if;
  if new.superseded_by_decision_id is not null then
    select athlete_id, owner_team_id, activity_id into sup from training.activity_athlete_decisions where id = new.superseded_by_decision_id;
    if not found or sup.athlete_id is distinct from new.athlete_id or sup.owner_team_id is distinct from new.owner_team_id
       or training.resolve_canonical_activity_id(sup.activity_id) is distinct from training.resolve_canonical_activity_id(new.activity_id) then
      raise exception 'activity_athlete_decisions: decision % cannot be superseded by %', new.id, new.superseded_by_decision_id;
    end if;
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger activity_athlete_decisions_check_links
  after insert or update on training.activity_athlete_decisions
  deferrable initially deferred
  for each row execute function training.check_activity_athlete_decision_links();

-- ---------------------------------------------------------------------------
-- 7. Completion — one row per canonical activity, created by the first 5a2
--    write, never by a read. Absent = not_complete, revision 0.
-- ---------------------------------------------------------------------------
create table training.activity_completions (
  activity_id uuid primary key references training.activities(id),
  owner_team_id uuid not null references public.teams(id),
  status varchar(20) not null check (status in ('not_complete', 'complete', 'needs_review')),
  revision integer not null default 0 check (revision >= 0),
  completed_by_user_id uuid references public.users(id),
  completed_by_basis varchar(20) check (completed_by_basis in ('team_coach', 'club_admin', 'platform_admin')),
  completed_at timestamptz,
  input_fingerprint text check (input_fingerprint is null or input_fingerprint ~ '^[0-9a-f]{64}$'),
  needs_review_causes text[] not null default '{}',
  updated_at timestamptz not null default now(),
  check ((status = 'complete') = (completed_by_user_id is not null and completed_by_basis is not null
                                  and completed_at is not null and input_fingerprint is not null)),
  check ((status = 'needs_review') = (cardinality(needs_review_causes) > 0)),
  check (needs_review_causes <@ array['decision_changed', 'roster_changed', 'measurement_changed', 'link_changed',
                                       'activity_merged', 'change_pending', 'record_unusable', 'input_changed']::text[])
);

-- Every write bumps the revision by exactly one (the roster's single
-- optimistic token); the activity and its team never change; a session
-- becomes complete only by someone who may decide on its roster, through the
-- recorded basis.
create function training.protect_activity_completion() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'activity_completions: completion of activity % is never deleted', old.activity_id;
  end if;
  if tg_op = 'INSERT' then
    perform training.assert_canonical_team_activity(new.activity_id, new.owner_team_id, 'activity_completions');
  else
    if new.activity_id is distinct from old.activity_id or new.owner_team_id is distinct from old.owner_team_id then
      raise exception 'activity_completions: the activity and team of a completion never change (activity %)', old.activity_id;
    end if;
    if new.revision is distinct from old.revision + 1 then
      raise exception 'activity_completions: every change bumps the revision by one (activity %, % -> %)', old.activity_id, old.revision, new.revision;
    end if;
    new.updated_at := now();
  end if;
  if new.status = 'complete' and (tg_op = 'INSERT' or old.status is distinct from 'complete'
       or new.completed_by_user_id is distinct from old.completed_by_user_id
       or new.completed_by_basis is distinct from old.completed_by_basis) then
    perform training.lock_activity_decider(new.completed_by_user_id, new.owner_team_id, new.completed_by_basis);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger activity_completions_protect
  before insert or update or delete on training.activity_completions
  for each row execute function training.protect_activity_completion();
create trigger activity_completions_no_truncate
  before truncate on training.activity_completions
  for each statement execute function training.roster_history_no_truncate();

create table training.activity_completion_log (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references training.activities(id),
  request_id uuid references training.activity_roster_requests(id) deferrable initially deferred,
  revision integer not null check (revision >= 0),
  from_status varchar(20) check (from_status in ('not_complete', 'complete', 'needs_review')),
  to_status varchar(20) not null check (to_status in ('not_complete', 'complete', 'needs_review')),
  cause varchar(30) not null check (cause in ('completed', 'reopened', 'decision_changed', 'roster_changed', 'measurement_changed',
                                              'link_changed', 'activity_merged', 'change_pending', 'record_unusable', 'input_changed')),
  performed_by_user_id uuid references public.users(id),
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now()
);
create index activity_completion_log_activity_idx on training.activity_completion_log (activity_id, created_at);

create function training.protect_activity_completion_log() returns trigger as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'activity_completion_log is append-only (% refused)', tg_op;
  end if;
  if not exists (select 1 from training.activities where id = new.activity_id and owner_scope = 'team') then
    raise exception 'activity_completion_log: activity % is not a team session', new.activity_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger activity_completion_log_protect
  before insert or update or delete on training.activity_completion_log
  for each row execute function training.protect_activity_completion_log();
create trigger activity_completion_log_no_truncate
  before truncate on training.activity_completion_log
  for each statement execute function training.roster_history_no_truncate();

-- ---------------------------------------------------------------------------
-- 8. Source observations — written by an import adapter, source-neutral.
-- ---------------------------------------------------------------------------
-- Ids only in adapter_ref (never a name). One open observation per activity,
-- athlete, connection and kind; resolved once. Removed only by the admin undo
-- of the import that produced it (backend/scripts/gpexe-undo-imported-session.mjs,
-- which switches the append-only trigger off inside its own transaction).
create table training.activity_source_observations (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references training.activities(id),
  athlete_id uuid not null references public.athletes(id),
  source_connection_id uuid not null references training_load.metric_source_connections(id),
  kind varchar(20) not null check (kind in ('record_unusable', 'change_pending')),
  reason_code varchar(40) not null check (reason_code ~ '^[a-z][a-z0-9_]{1,39}$'),
  observed_at timestamptz not null default now(),
  resolved_at timestamptz,
  adapter_ref jsonb not null default '{}' check (jsonb_typeof(adapter_ref) = 'object'),
  check (resolved_at is null or resolved_at >= observed_at)
);
create unique index activity_source_observations_one_open
  on training.activity_source_observations (activity_id, athlete_id, source_connection_id, kind) where resolved_at is null;
create index activity_source_observations_athlete_idx on training.activity_source_observations (athlete_id);

create function training.check_activity_source_observation() returns trigger as $$
declare
  v_team_id uuid;
  conn record;
begin
  if new.resolved_at is not null then
    raise exception 'activity_source_observations: an observation is recorded open';
  end if;
  v_team_id := training.assert_canonical_team_activity(new.activity_id, null, 'activity_source_observations');
  select owner_scope, owner_team_id into conn from training_load.metric_source_connections where id = new.source_connection_id;
  if not found or conn.owner_scope <> 'team' or conn.owner_team_id is distinct from v_team_id then
    raise exception 'activity_source_observations: connection % does not belong to the team of activity %', new.source_connection_id, new.activity_id;
  end if;
  if not exists (select 1 from training.activity_roster(new.activity_id) r where r.athlete_id = new.athlete_id) then
    raise exception 'activity_source_observations: athlete % is not on the roster of activity %', new.athlete_id, new.activity_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger activity_source_observations_check_insert
  before insert on training.activity_source_observations
  for each row execute function training.check_activity_source_observation();

create function training.protect_activity_source_observation() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'activity_source_observations: observation % is removed only by the undo of its import', old.id;
  end if;
  if old.resolved_at is not null or new.resolved_at is null
     or new.id is distinct from old.id or new.activity_id is distinct from old.activity_id
     or new.athlete_id is distinct from old.athlete_id or new.source_connection_id is distinct from old.source_connection_id
     or new.kind is distinct from old.kind or new.reason_code is distinct from old.reason_code
     or new.observed_at is distinct from old.observed_at or new.adapter_ref is distinct from old.adapter_ref then
    raise exception 'activity_source_observations: an observation is only resolved, once (observation %)', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger activity_source_observations_append_only
  before update or delete on training.activity_source_observations
  for each row execute function training.protect_activity_source_observation();
create trigger activity_source_observations_no_truncate
  before truncate on training.activity_source_observations
  for each statement execute function training.roster_history_no_truncate();
