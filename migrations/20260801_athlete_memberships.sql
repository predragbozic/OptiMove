-- Phase 3: archive a specific club/team/private-coach relationship without
-- ever touching the athlete's global profile, login, or other relationships.
--
-- public.athlete_memberships is the new authoritative source for active
-- club/team relationships. An athlete may hold several active memberships
-- at once (multiple clubs, multiple teams, several private coaches via the
-- existing public.user_athletes table which is unchanged by this file).
--
-- athletes.club_id/team_id are NOT dropped and NOT authoritative anymore -
-- they remain only as a legacy "primary" pointer for old call sites and
-- simple display, informally renamed primary_club_id/primary_team_id in
-- comments below until a later phase renames the columns for real. They are
-- deliberately NOT auto-synced on every archive/restore (a single FK column
-- cannot represent "several active clubs"); application code only nudges
-- them when the pointer has gone stale (no longer points at any active
-- membership), picking the most recently created remaining active
-- membership, or NULL if none remain. See syncLegacyAthletePointer in
-- backend/src/routes/organization.js.

-- A composite FK target so an active TEAM membership can never point at a
-- team belonging to a different club than the membership's own club_id.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.teams'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (id, club_id)'
  ) then
    alter table public.teams
      add constraint teams_id_club_id_unique unique (id, club_id);
  end if;
end $$;

create table if not exists public.athlete_memberships (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references public.athletes(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  membership_type varchar(20) not null,
  status varchar(20) not null default 'active',
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  archived_at timestamptz,
  archived_by_user_id uuid references public.users(id) on delete set null,
  archive_reason text,
  created_by_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint athlete_memberships_type_check check (membership_type in ('club', 'team')),
  constraint athlete_memberships_status_check check (status in ('active', 'paused', 'archived')),
  -- A 'club' row is club-only (no team_id); a 'team' row must carry a
  -- team_id, and that team must belong to this same club_id (enforced by
  -- the composite FK below).
  constraint athlete_memberships_team_shape_check check (
    (membership_type = 'club' and team_id is null)
    or (membership_type = 'team' and team_id is not null)
  ),
  constraint athlete_memberships_team_club_fkey foreign key (team_id, club_id) references public.teams(id, club_id)
);

-- Prevent uncontrolled duplication of an IDENTICAL active relationship, while
-- still allowing an athlete to hold several DIFFERENT active club/team
-- memberships at once (multiple clubs, multiple teams, including several
-- teams within the same club).
create unique index if not exists athlete_memberships_one_active_club_idx
  on public.athlete_memberships (athlete_id, club_id)
  where status = 'active' and membership_type = 'club';

create unique index if not exists athlete_memberships_one_active_team_idx
  on public.athlete_memberships (athlete_id, team_id)
  where status = 'active' and membership_type = 'team';

create index if not exists athlete_memberships_athlete_idx
  on public.athlete_memberships (athlete_id);

create index if not exists athlete_memberships_club_active_idx
  on public.athlete_memberships (club_id)
  where status = 'active' and membership_type = 'club';

create index if not exists athlete_memberships_team_active_idx
  on public.athlete_memberships (team_id)
  where status = 'active' and membership_type = 'team';

-- Backfill: club membership from the existing legacy athletes.club_id
-- pointer. Idempotent - only inserts when no active club row already
-- exists for that (athlete, club) pair, so reruns never duplicate.
insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, created_by_user_id)
select a.id, a.club_id, null::uuid, 'club', 'active', a.created_by_user_id
from public.athletes a
where a.club_id is not null
  and not exists (
    select 1 from public.athlete_memberships m
    where m.athlete_id = a.id and m.club_id = a.club_id and m.membership_type = 'club' and m.status = 'active'
  );

-- Backfill: team membership from the existing legacy athletes.team_id
-- pointer, only for rows where the legacy club_id agrees with the team's own
-- club (or club_id was never set, in which case the team's club implicitly
-- backfills it too). A genuine conflict - athlete.club_id pointing at a
-- DIFFERENT club than athlete.team_id's club - is never guessed at: that
-- row is simply left out of this backfill so it can be reviewed and fixed
-- by hand. (As of writing, a read-only check against both the dev and
-- production databases found zero such conflicting rows.)
insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, created_by_user_id)
select a.id, t.club_id, a.team_id, 'team', 'active', a.created_by_user_id
from public.athletes a
join public.teams t on t.id = a.team_id
where a.team_id is not null
  and (a.club_id is null or a.club_id = t.club_id)
  and not exists (
    select 1 from public.athlete_memberships m
    where m.athlete_id = a.id and m.team_id = a.team_id and m.membership_type = 'team' and m.status = 'active'
  );

-- A team membership always requires its own club membership to exist too
-- (an athlete on a team must also be an active member of that team's club).
-- Backfill any missing one implied by the team backfill above.
insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, created_by_user_id)
select distinct tm.athlete_id, tm.club_id, null::uuid, 'club', 'active', tm.created_by_user_id
from public.athlete_memberships tm
where tm.membership_type = 'team'
  and not exists (
    select 1 from public.athlete_memberships cm
    where cm.athlete_id = tm.athlete_id and cm.club_id = tm.club_id and cm.membership_type = 'club' and cm.status = 'active'
  );

-- Verification (read-only, for manual review after running this migration):
-- select a.id, a.club_id as legacy_club_id, t.club_id as team_club_id
-- from public.athletes a
-- join public.teams t on t.id = a.team_id
-- where a.club_id is not null and a.club_id <> t.club_id;
-- (rows returned here were intentionally skipped by the backfill above.)
