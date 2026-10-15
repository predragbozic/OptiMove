do $$
begin
  if exists (select 1 from library.exercise_collections)
     or exists (select 1 from library.exercise_collection_items)
     or exists (select 1 from library.exercise_collection_users)
     or exists (select 1 from library.exercise_collection_audit)
     or exists (select 1 from library.exercises where source_exercise_id is not null) then
    raise exception 'Rollback refused: preserve existing blocks, grants, audit and personal-copy provenance.';
  end if;
end;
$$;

drop trigger if exists exercise_copy_source_guard on library.exercises;
drop function if exists library.guard_exercise_copy_source();
drop index if exists library.exercise_copy_source_idx;

alter table library.exercises drop constraint exercise_personal_source_check;
drop index library.exercise_personal_source_owner_idx;
alter table library.exercises drop column source_exercise_id;
drop table library.exercise_collection_audit;
drop table library.exercise_collection_users;
drop table library.exercise_collection_items;
drop table library.exercise_collections;
