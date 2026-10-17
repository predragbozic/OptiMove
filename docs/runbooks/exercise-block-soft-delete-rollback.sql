-- Rollback of migrations_v2/202610171200_exercise_block_soft_delete.sql,
-- together with a revert of the code that reads deleted_at (an older
-- application on this schema lists a deleted block as an empty live one).
-- Rollbacks run newest first. Refused once any block was deleted (those rows
-- must keep the facts of their deletion, or a deleted block would reappear as
-- an empty live one), or a later migration is recorded. Run it as one script
-- that stops at the first error (psql -v ON_ERROR_STOP=1 -f ...): after a
-- refusal the open transaction is aborted and nothing is changed. The tables
-- are locked before the checks, so a delete in flight cannot slip in between.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610171200_exercise_block_soft_delete.sql') then
    raise exception 'block delete rollback refused: the migration is not recorded on this database';
  end if;
end $$;

lock table library.exercise_collections, library.exercise_collection_items, library.exercise_collection_users
  in access exclusive mode;

do $$
begin
  if exists (select 1 from public.schema_migrations
             where migration_name like 'migrations_v2/%'
               and migration_name > 'migrations_v2/202610171200_exercise_block_soft_delete.sql') then
    raise exception 'block delete rollback refused: a later migration is recorded';
  end if;
  if exists (select 1 from library.exercise_collections where deleted_at is not null) then
    raise exception 'block delete rollback refused: deleted exercise blocks exist; keep their deletion facts';
  end if;
end $$;

drop trigger exercise_block_deletion_guard on library.exercise_collections;
drop trigger exercise_block_users_not_deleted on library.exercise_collection_users;
drop trigger exercise_block_items_not_deleted on library.exercise_collection_items;
drop function library.guard_exercise_block_deletion();
drop function library.guard_exercise_block_membership();

alter table library.exercise_collections drop constraint exercise_block_deleted_facts;
alter table library.exercise_collections drop column deleted_by_user_id;
alter table library.exercise_collections drop column deleted_at;

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610171200_exercise_block_soft_delete.sql';

commit;
