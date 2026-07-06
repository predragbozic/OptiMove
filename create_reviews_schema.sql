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

create index if not exists coach_profile_reviews_profile_idx
  on public.coach_profile_reviews (coach_profile_id, status, created_at desc);

create index if not exists program_reviews_plan_idx
  on library.program_reviews (plan_id, status, created_at desc);
