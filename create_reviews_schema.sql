create table if not exists public.coach_profile_reviews (
  id uuid primary key default gen_random_uuid(),
  coach_profile_id uuid not null references public.coach_profiles(id) on delete cascade,
  reviewer_user_id uuid references public.users(id) on delete set null,
  rating smallint not null check (rating between 1 and 5),
  comment text,
  status varchar(32) not null default 'pending'
    check (status in ('pending', 'published', 'hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists library.program_reviews (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans.plans(id) on delete cascade,
  reviewer_user_id uuid references public.users(id) on delete set null,
  rating smallint not null check (rating between 1 and 5),
  comment text,
  status varchar(32) not null default 'pending'
    check (status in ('pending', 'published', 'hidden')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.coach_contact_requests
  drop constraint if exists coach_contact_requests_status_check;

alter table public.coach_contact_requests
  add constraint coach_contact_requests_status_check
  check (status in ('new', 'read', 'replied', 'accepted', 'archived'));

create table if not exists library.program_access (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references plans.plans(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  access_type varchar(32) not null default 'copied'
    check (access_type in ('assigned', 'copied', 'downloaded', 'purchased', 'coach_assigned')),
  status varchar(32) not null default 'accessed'
    check (status in ('accessed', 'used', 'completed', 'revoked')),
  related_plan_id uuid references plans.plans(id) on delete set null,
  accessed_at timestamptz not null default now(),
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, user_id, access_type)
);

alter table library.program_access
  add column if not exists starts_at timestamptz not null default now(),
  add column if not exists expires_at timestamptz,
  add column if not exists source varchar(32),
  add column if not exists license_snapshot jsonb not null default '{}'::jsonb;

create table if not exists library.program_usage_events (
  id uuid primary key default gen_random_uuid(),
  program_access_id uuid not null references library.program_access(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  event_type varchar(32) not null default 'used'
    check (event_type in ('opened', 'used', 'completed')),
  note text,
  created_at timestamptz not null default now()
);

alter table public.coach_profile_reviews
  add column if not exists is_verified boolean not null default false,
  add column if not exists verified_contact_request_id uuid references public.coach_contact_requests(id) on delete set null;

alter table library.program_reviews
  add column if not exists is_verified boolean not null default false,
  add column if not exists verified_access_id uuid references library.program_access(id) on delete set null,
  add column if not exists verification_type varchar(32);

create index if not exists coach_profile_reviews_profile_idx
  on public.coach_profile_reviews (coach_profile_id, status, created_at desc);

create index if not exists program_reviews_plan_idx
  on library.program_reviews (plan_id, status, created_at desc);

create unique index if not exists coach_profile_reviews_one_per_user_idx
  on public.coach_profile_reviews (coach_profile_id, reviewer_user_id)
  where reviewer_user_id is not null;

create unique index if not exists program_reviews_one_per_user_idx
  on library.program_reviews (plan_id, reviewer_user_id)
  where reviewer_user_id is not null;

create index if not exists program_access_user_plan_idx
  on library.program_access (user_id, plan_id, status);
