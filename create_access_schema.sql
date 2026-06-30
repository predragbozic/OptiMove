-- Access memberships for club and team scoped users.
-- Existing direct coach-athlete links stay supported through public.user_athletes.

alter table public.athletes
  add column if not exists club_id uuid references public.clubs(id) on delete set null,
  add column if not exists team_id uuid references public.teams(id) on delete set null;

create table if not exists public.user_club_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  role varchar(40) not null default 'club_admin',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, club_id, role)
);

create table if not exists public.user_team_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  role varchar(40) not null default 'team_coach',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, team_id, role)
);

create index if not exists user_club_roles_user_active_idx
  on public.user_club_roles (user_id, club_id)
  where is_active = true;

create index if not exists user_team_roles_user_active_idx
  on public.user_team_roles (user_id, team_id)
  where is_active = true;

create index if not exists athletes_club_team_idx
  on public.athletes (club_id, team_id)
  where coalesce(is_active, true);
