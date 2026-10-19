-- BE-1: additive private storage foundation. No legacy media data is changed.
-- The startup runner owns the transaction. Same DATABASE_URL role migrates and serves.
create schema media;
revoke all on schema media from public;

create table media.storage_policy (
  id boolean primary key default true check (id),
  default_limit_bytes bigint not null default 0 check (default_limit_bytes >= 0),
  max_video_bytes bigint not null default 209715200 check (max_video_bytes > 0),
  max_image_bytes bigint not null default 10485760 check (max_image_bytes > 0),
  max_parallel_uploads integer not null default 2 check (max_parallel_uploads between 1 and 20),
  allowed_mime_types text[] not null default array['video/mp4','video/webm','image/jpeg','image/png','image/webp'],
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (cardinality(allowed_mime_types) > 0 and allowed_mime_types <@ array['video/mp4','video/webm','image/jpeg','image/png','image/webp']::text[])
);
-- Fail closed until the administrator explicitly allocates storage.
insert into media.storage_policy (id) values (true);

create table media.storage_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid unique references public.users(id),
  owner_club_id uuid unique references public.clubs(id),
  used_bytes bigint not null default 0 check (used_bytes >= 0),
  reserved_bytes bigint not null default 0 check (reserved_bytes >= 0),
  override_limit_bytes bigint check (override_limit_bytes >= 0),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (num_nonnulls(owner_user_id, owner_club_id) = 1)
);

create table media.assets (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'r2' check (provider = 'r2'),
  object_key text not null unique check (length(object_key) between 1 and 1024),
  kind text not null check (kind in ('video','image')),
  storage_account_id uuid not null references media.storage_accounts(id),
  uploaded_by_user_id uuid not null references public.users(id),
  size_bytes bigint check (size_bytes > 0),
  mime_type text,
  status text not null default 'pending' check (status in ('pending','verifying','ready','failed','deleting','deleted')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  source_video_asset_id uuid references media.assets(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (status <> 'ready' or (size_bytes is not null and mime_type is not null))
);
create index assets_storage_account on media.assets(storage_account_id);
create index assets_source_video on media.assets(source_video_asset_id) where source_video_asset_id is not null;

create table media.uploads (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references media.assets(id),
  storage_account_id uuid not null references media.storage_accounts(id),
  uploaded_by_user_id uuid not null references public.users(id),
  idempotency_key uuid not null,
  request_fingerprint text not null,
  context jsonb not null check (jsonb_typeof(context) = 'object'),
  purpose text not null check (purpose in ('exercise_video','exercise_image','video_frame','automatic_thumbnail')),
  temporary_object_key text not null unique,
  expected_size_bytes bigint not null check (expected_size_bytes > 0),
  expected_mime_type text not null,
  reserved_bytes bigint not null check (reserved_bytes > 0),
  status text not null default 'reserved' check (status in ('reserved','verifying','cancelling','completed','cancelled','failed')),
  expires_at timestamptz not null,
  -- Reservation may be released only after BE-2 proves no write capability or
  -- unaccounted physical data remains. No expiry-only automatic release.
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(uploaded_by_user_id, idempotency_key)
);
create index uploads_active_account on media.uploads(storage_account_id, expires_at)
  where status in ('reserved','verifying','cancelling');

create table media.storage_limit_audit (
  id uuid primary key default gen_random_uuid(),
  storage_account_id uuid references media.storage_accounts(id),
  performed_by_user_id uuid not null references public.users(id),
  old_values jsonb not null, new_values jsonb not null,
  reason text not null check (length(reason) between 1 and 1000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index storage_audit_account on media.storage_limit_audit(storage_account_id, created_at desc, id desc);

create function media.reject_audit_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'Media storage audit is append-only' using errcode = '42501';
end;
$$;
revoke all on function media.reject_audit_mutation() from public;
create trigger storage_audit_immutable before update or delete or truncate on media.storage_limit_audit
  for each statement execute function media.reject_audit_mutation();

-- Explicitly remove inherited Supabase/default grants. RLS also denies direct
-- table access to non-owner roles even if this schema is accidentally exposed.
alter table media.storage_policy enable row level security;
alter table media.storage_accounts enable row level security;
alter table media.assets enable row level security;
alter table media.uploads enable row level security;
alter table media.storage_limit_audit enable row level security;
revoke all on all tables in schema media from public;
do $$
declare role_name text;
begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname=role_name) and role_name <> current_user then
      execute format('revoke all on schema media from %I',role_name);
      execute format('revoke all on all tables in schema media from %I',role_name);
      execute format('revoke all on all functions in schema media from %I',role_name);
    end if;
  end loop;
end;
$$;

-- No read/write integration yet. Existing URL-based readers and importers
-- keep working. New source selectors default to legacy without rewriting URLs.
alter table library.exercises
  add column video_asset_id uuid references media.assets(id),
  add column image_asset_id uuid references media.assets(id),
  add column video_source text not null default 'legacy' check (video_source in ('legacy','asset','none')),
  add column image_source text not null default 'legacy' check (image_source in ('legacy','asset','none')),
  add constraint exercises_video_asset_selection check ((video_source='asset') = (video_asset_id is not null)),
  add constraint exercises_image_asset_selection check ((image_source='asset') = (image_asset_id is not null));
alter table plans.plan_items
  add column video_asset_id uuid references media.assets(id),
  add column image_asset_id uuid references media.assets(id),
  add column video_source text not null default 'legacy' check (video_source in ('legacy','asset','none')),
  add column image_source text not null default 'legacy' check (image_source in ('legacy','asset','none')),
  add constraint plan_items_video_asset_selection check ((video_source='asset') = (video_asset_id is not null)),
  add constraint plan_items_image_asset_selection check ((image_source='asset') = (image_asset_id is not null));
create index exercises_video_asset on library.exercises(video_asset_id) where video_asset_id is not null;
create index exercises_image_asset on library.exercises(image_asset_id) where image_asset_id is not null;
create index plan_items_video_asset on plans.plan_items(video_asset_id) where video_asset_id is not null;
create index plan_items_image_asset on plans.plan_items(image_asset_id) where image_asset_id is not null;
