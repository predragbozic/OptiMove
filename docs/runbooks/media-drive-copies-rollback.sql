-- Rollback of migrations_v2/202610211000_media_drive_copies.sql, together with
-- a revert of the code that reads media.drive_copies (an older application on
-- this schema ignores the copies and plays the Drive links again).
-- Usable only before the platform storage account exists: it is created by
-- the first import or by POST /api/admin/media/storage-accounts, and its limit
-- is then recorded in the append-only storage_limit_audit. Also refused once
-- anything was imported (a copy, a copy event or an import upload): each of
-- them records charged bytes or who did what, and must not disappear. After
-- that, undo an import by removing its copies through
-- DELETE /api/admin/media/drive-import/copies/:kind/:driveFileId (the Drive
-- links play again at once) and keep this additive schema. Also refused once a
-- later migration is recorded. Run it as one script that stops at the first
-- error (psql -v ON_ERROR_STOP=1 -f ...): after a refusal the open transaction
-- is aborted and nothing is changed. The tables are locked before the checks,
-- so an import in flight cannot slip in between.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610211000_media_drive_copies.sql') then
    raise exception 'drive copies rollback refused: the migration is not recorded on this database';
  end if;
end $$;

lock table media.storage_accounts, media.uploads, media.drive_copies, media.drive_copy_events in access exclusive mode;

do $$
begin
  if exists (select 1 from public.schema_migrations
             where migration_name like 'migrations_v2/%'
               and migration_name > 'migrations_v2/202610211000_media_drive_copies.sql') then
    raise exception 'drive copies rollback refused: a later migration is recorded';
  end if;
  if exists (select 1 from media.drive_copies)
     or exists (select 1 from media.drive_copy_events)
     or exists (select 1 from media.uploads where purpose in ('drive_import_video','drive_import_image')) then
    raise exception 'drive copies rollback refused: something was imported; remove copies through the admin route instead';
  end if;
  if exists (select 1 from media.storage_accounts where owner_platform) then
    raise exception 'drive copies rollback refused: the platform storage account exists; keep the schema and remove copies through the admin route instead';
  end if;
end $$;

drop table media.drive_copy_events;
drop table media.drive_copies;
drop function media.reject_drive_copy_update();
drop index media.uploads_active_drive_import;
alter table media.uploads drop constraint uploads_import_purpose_context;
alter table media.uploads drop constraint uploads_purpose_check;
alter table media.uploads add constraint uploads_purpose_check
  check (purpose in ('exercise_video','exercise_image','video_frame','automatic_thumbnail'));
drop index media.storage_accounts_platform_owner;
alter table media.storage_accounts drop constraint storage_accounts_one_owner;
alter table media.storage_accounts drop column owner_platform;
alter table media.storage_accounts add constraint storage_accounts_check
  check (num_nonnulls(owner_user_id, owner_club_id) = 1);
delete from public.schema_migrations where migration_name = 'migrations_v2/202610211000_media_drive_copies.sql';
commit;
