-- Rollback of migrations_v2/202610171200_exercise_block_soft_delete.sql.
-- Run inside one transaction, together with a revert of the code that reads
-- deleted_at. Refused once any block was deleted: those rows must keep the
-- facts of their deletion, or a deleted block would reappear as an empty one.
do $$
begin
  if exists (select 1 from library.exercise_collections where deleted_at is not null) then
    raise exception 'Rollback refused: deleted exercise blocks exist; keep their deletion facts.';
  end if;
  if exists (select 1 from public.schema_migrations
             where migration_name > 'migrations_v2/202610171200_exercise_block_soft_delete.sql'
               and migration_name like 'migrations_v2/%') then
    raise exception 'Rollback refused: a later migration is recorded.';
  end if;
end;
$$;

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
