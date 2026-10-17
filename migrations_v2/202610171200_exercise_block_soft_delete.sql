-- Deleting an application exercise block. Its exercises leave the block and
-- are back in Other (an exercise in no block is available to every coach),
-- its user grants are removed, and the block row itself stays: the audit
-- trail (library.exercise_collection_audit) references it and is kept.
-- A deleted block is final: it is never renamed, restored, or given
-- exercises or users again, whoever writes.
alter table library.exercise_collections
  add column deleted_at timestamptz,
  add column deleted_by_user_id uuid references public.users(id);

alter table library.exercise_collections
  add constraint exercise_block_deleted_facts check ((deleted_at is null) = (deleted_by_user_id is null));

-- An exercise or a user grant never joins a deleted block. FOR SHARE waits
-- for a deletion in flight and then reads its committed outcome, so an
-- insert racing the deletion is refused instead of reviving the block.
create function library.guard_exercise_block_membership() returns trigger
language plpgsql as $$
declare
  block_deleted_at timestamptz;
begin
  select c.deleted_at into block_deleted_at
    from library.exercise_collections c where c.id = new.collection_id for share;
  if block_deleted_at is not null then
    raise exception 'exercise block is deleted' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger exercise_block_items_not_deleted
  before insert or update on library.exercise_collection_items
  for each row execute function library.guard_exercise_block_membership();

create trigger exercise_block_users_not_deleted
  before insert or update on library.exercise_collection_users
  for each row execute function library.guard_exercise_block_membership();

-- A block is deleted only once it holds no exercises and no users, and a
-- deleted block is never changed again. The checks run after the row lock,
-- each with its own snapshot, so they see an item committed meanwhile.
create function library.guard_exercise_block_deletion() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is not null then
      raise exception 'an exercise block is not created deleted' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.deleted_at is not null then
    raise exception 'a deleted exercise block is final' using errcode = '23514';
  end if;
  if new.deleted_at is not null and (
       exists (select 1 from library.exercise_collection_items where collection_id = old.id)
       or exists (select 1 from library.exercise_collection_users where collection_id = old.id)) then
    raise exception 'an exercise block is deleted only without exercises and users' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger exercise_block_deletion_guard
  before insert or update on library.exercise_collections
  for each row execute function library.guard_exercise_block_deletion();
