-- Access memberships for club and team scoped users.
-- Existing direct coach-athlete links stay supported through public.user_athletes.

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  full_name text,
  display_name text,
  role_hint text not null default 'user',
  created_by_user_id uuid references public.users(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.users
  add column if not exists full_name text,
  add column if not exists display_name text,
  add column if not exists role_hint text not null default 'user',
  add column if not exists created_by_user_id uuid references public.users(id) on delete set null,
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

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

create table if not exists public.athlete_invites (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references public.athletes(id) on delete cascade,
  email text not null,
  token_hash text not null unique,
  invited_by_user_id uuid references public.users(id) on delete set null,
  accepted_by_user_id uuid references public.users(id) on delete set null,
  accepted_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.athlete_library_access (
  athlete_id uuid primary key references public.athletes(id) on delete cascade,
  managed_by_user_id uuid references public.users(id) on delete set null,
  can_view_coach_library boolean not null default true,
  can_view_team_library boolean not null default false,
  can_view_club_library boolean not null default false,
  can_view_optimove_library boolean not null default false,
  can_view_marketplace boolean not null default false,
  can_view_coach_profiles boolean not null default true,
  can_view_club_coach_profiles boolean not null default false,
  can_view_public_coach_profiles boolean not null default false,
  can_contact_visible_coaches boolean not null default true,
  can_view_assigned_exercises boolean not null default true,
  can_view_coach_exercise_library boolean not null default false,
  can_view_team_exercise_library boolean not null default false,
  can_view_club_exercise_library boolean not null default false,
  can_view_optimove_exercise_library boolean not null default false,
  can_view_exercise_groups boolean not null default false,
  free_only boolean not null default true,
  require_approval boolean not null default true,
  selected_programs_only boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_athletes
  add column if not exists relationship_type varchar(40) not null default 'coach',
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

delete from public.user_athletes ua
using public.user_athletes duplicate
where ua.ctid < duplicate.ctid
  and ua.user_id = duplicate.user_id
  and ua.athlete_id = duplicate.athlete_id
  and ua.relationship_type = duplicate.relationship_type;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_athletes'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (user_id, athlete_id, relationship_type)'
  ) then
    alter table public.user_athletes
      add constraint user_athletes_user_athlete_relationship_unique
      unique (user_id, athlete_id, relationship_type);
  end if;
end $$;

alter table public.athlete_invites
  add column if not exists athlete_id uuid references public.athletes(id) on delete cascade,
  add column if not exists email text,
  add column if not exists token_hash text,
  add column if not exists invited_by_user_id uuid references public.users(id) on delete set null,
  add column if not exists accepted_by_user_id uuid references public.users(id) on delete set null,
  add column if not exists accepted_at timestamptz,
  add column if not exists expires_at timestamptz not null default (now() + interval '14 days'),
  add column if not exists created_at timestamptz not null default now();

alter table public.athlete_library_access
  add column if not exists managed_by_user_id uuid references public.users(id) on delete set null,
  add column if not exists can_view_coach_library boolean not null default true,
  add column if not exists can_view_team_library boolean not null default false,
  add column if not exists can_view_club_library boolean not null default false,
  add column if not exists can_view_optimove_library boolean not null default false,
  add column if not exists can_view_marketplace boolean not null default false,
  add column if not exists can_view_coach_profiles boolean not null default true,
  add column if not exists can_view_club_coach_profiles boolean not null default false,
  add column if not exists can_view_public_coach_profiles boolean not null default false,
  add column if not exists can_contact_visible_coaches boolean not null default true,
  add column if not exists can_view_assigned_exercises boolean not null default true,
  add column if not exists can_view_coach_exercise_library boolean not null default false,
  add column if not exists can_view_team_exercise_library boolean not null default false,
  add column if not exists can_view_club_exercise_library boolean not null default false,
  add column if not exists can_view_optimove_exercise_library boolean not null default false,
  add column if not exists can_view_exercise_groups boolean not null default false,
  add column if not exists free_only boolean not null default true,
  add column if not exists require_approval boolean not null default true,
  add column if not exists selected_programs_only boolean not null default false,
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

create index if not exists athlete_invites_lookup_idx
  on public.athlete_invites (token_hash)
  where accepted_at is null;

create index if not exists athlete_library_access_manager_idx
  on public.athlete_library_access (managed_by_user_id);
