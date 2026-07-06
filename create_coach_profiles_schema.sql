create table if not exists public.coach_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  headline text,
  bio text,
  specialties text,
  photo_url text,
  cover_image_url text,
  contact_email text,
  contact_enabled boolean not null default true,
  visibility varchar(32) not null default 'private'
    check (visibility in ('private', 'club', 'public', 'marketplace')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create table if not exists public.coach_profile_tags (
  id uuid primary key default gen_random_uuid(),
  coach_profile_id uuid not null references public.coach_profiles(id) on delete cascade,
  name text not null,
  slug text not null,
  created_at timestamptz not null default now(),
  unique (coach_profile_id, slug)
);

create table if not exists public.coach_contact_requests (
  id uuid primary key default gen_random_uuid(),
  coach_profile_id uuid not null references public.coach_profiles(id) on delete cascade,
  sender_user_id uuid references public.users(id) on delete set null,
  sender_name text,
  sender_email text,
  message text not null,
  status varchar(32) not null default 'new'
    check (status in ('new', 'read', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists coach_profiles_visibility_idx
  on public.coach_profiles (visibility, is_active);

create index if not exists coach_profile_tags_slug_idx
  on public.coach_profile_tags (slug);

create index if not exists coach_contact_requests_profile_idx
  on public.coach_contact_requests (coach_profile_id, created_at desc);
