-- Access memberships for club and team scoped users.
-- Existing direct coach-athlete links stay supported through public.user_athletes.

create table if not exists public.clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  short_name text,
  logo_url text,
  city text,
  country text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  club_id uuid references public.clubs(id) on delete set null,
  name text not null,
  short_name text,
  logo_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.clubs
  add column if not exists name text,
  add column if not exists short_name text,
  add column if not exists logo_url text,
  add column if not exists city text,
  add column if not exists country text,
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.teams
  add column if not exists name text,
  add column if not exists club_id uuid references public.clubs(id) on delete set null,
  add column if not exists short_name text,
  add column if not exists logo_url text,
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.athletes
  add column if not exists athlete_id text,
  add column if not exists source_external_id text,
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists full_name text,
  add column if not exists display_name text,
  add column if not exists image_url text,
  add column if not exists user_id uuid references public.users(id) on delete set null,
  add column if not exists is_active boolean not null default true,
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

create table if not exists public.user_athletes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  athlete_id uuid not null references public.athletes(id) on delete cascade,
  relationship_type varchar(40) not null default 'coach',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, athlete_id, relationship_type)
);

alter table public.user_athletes
  add column if not exists relationship_type varchar(40) not null default 'coach',
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists user_club_roles_user_active_idx
  on public.user_club_roles (user_id, club_id)
  where is_active = true;

create index if not exists user_team_roles_user_active_idx
  on public.user_team_roles (user_id, team_id)
  where is_active = true;

create index if not exists user_athletes_user_active_idx
  on public.user_athletes (user_id, athlete_id)
  where is_active = true;

create index if not exists athletes_club_team_idx
  on public.athletes (club_id, team_id)
  where coalesce(is_active, true);
