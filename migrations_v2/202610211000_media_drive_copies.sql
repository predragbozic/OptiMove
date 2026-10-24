-- Drive copies: an R2 copy of a Google Drive file that exercises and plan items
-- still name by their legacy link. A legacy slot whose link names a copied Drive
-- file is served as that asset; no exercise, copy or plan-item row is rewritten.
-- The copies are charged to the one platform storage account, never to a coach.
-- No legacy media data is changed by this migration.

-- One platform-owned storage account beside the user and club accounts.
alter table media.storage_accounts add column owner_platform boolean check (owner_platform);
alter table media.storage_accounts drop constraint storage_accounts_check;
alter table media.storage_accounts add constraint storage_accounts_one_owner
  check (num_nonnulls(owner_user_id, owner_club_id, owner_platform) = 1);
create unique index storage_accounts_platform_owner on media.storage_accounts (owner_platform) where owner_platform;

-- Import uploads: the same reservation, verification and cleanup lifecycle as a
-- coach's upload, with their own purposes (and their own duration limit in code).
alter table media.uploads drop constraint uploads_purpose_check;
alter table media.uploads add constraint uploads_purpose_check
  check (purpose in ('exercise_video','exercise_image','video_frame','automatic_thumbnail','drive_import_video','drive_import_image'));
-- An import purpose belongs to an import context, and an import context to nothing else.
alter table media.uploads add constraint uploads_import_purpose_context
  check ((purpose in ('drive_import_video','drive_import_image')) = coalesce(context->>'type' = 'drive_import', false));
-- At most one import of a Drive file in flight, whoever starts it.
create unique index uploads_active_drive_import on media.uploads (purpose, (context->>'driveFileId'))
  where purpose in ('drive_import_video','drive_import_image') and status in ('reserved','verifying','cancelling');

create table media.drive_copies (
  drive_file_id text not null check (drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  kind text not null check (kind in ('video','image')),
  asset_id uuid not null unique references media.assets(id),
  created_by_user_id uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  primary key (drive_file_id, kind)
);
-- A copy is added or removed (with its events), never changed in place.
create function media.reject_drive_copy_update() returns trigger language plpgsql as $$
begin
  raise exception 'A Drive copy is added or removed, never changed' using errcode = '42501';
end;
$$;
revoke all on function media.reject_drive_copy_update() from public;
create trigger drive_copies_no_update before update on media.drive_copies
  for each row execute function media.reject_drive_copy_update();

-- Who added or removed a copy, and why: append-only.
create table media.drive_copy_events (
  id uuid primary key default gen_random_uuid(),
  drive_file_id text not null,
  kind text not null check (kind in ('video','image')),
  asset_id uuid not null references media.assets(id),
  event text not null check (event in ('created','removed')),
  performed_by_user_id uuid not null references public.users(id),
  reason text check (reason is null or length(reason) between 1 and 1000),
  created_at timestamptz not null default now(),
  check (event = 'created' or reason is not null)
);
create index drive_copy_events_file on media.drive_copy_events (drive_file_id, kind, created_at);
create trigger drive_copy_events_immutable before update or delete or truncate on media.drive_copy_events
  for each statement execute function media.reject_audit_mutation();

alter table media.drive_copies enable row level security;
alter table media.drive_copy_events enable row level security;
revoke all on media.drive_copies from public;
revoke all on media.drive_copy_events from public;
do $$
declare role_name text;
begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname=role_name) and role_name <> current_user then
      execute format('revoke all on media.drive_copies from %I',role_name);
      execute format('revoke all on media.drive_copy_events from %I',role_name);
    end if;
  end loop;
end;
$$;
