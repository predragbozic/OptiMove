create table library.exercise_classifications (
  user_id uuid not null references public.users(id) on delete cascade,
  exercise_id uuid not null references library.exercises(id) on delete cascade,
  overrides jsonb not null default '{}'::jsonb check (jsonb_typeof(overrides) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (user_id, exercise_id)
);
alter table library.exercise_classifications enable row level security;
revoke all on library.exercise_classifications from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on library.exercise_classifications from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on library.exercise_classifications from authenticated;
  end if;
end $$;

alter table library.filter_hidden drop constraint if exists filter_hidden_kind_check;
alter table library.filter_hidden add constraint filter_hidden_kind_check
  check (kind in ('domain', 'category', 'section', 'tag', 'attractor', 'exercise')) not valid;
alter table library.filter_hidden validate constraint filter_hidden_kind_check;

alter table library.exercises add column copy_parent_id uuid references library.exercises(id) on delete restrict;
alter table library.exercises add constraint exercise_copy_parent_check
  check (copy_parent_id is null or (owner_scope='user' and owner_user_id is not null and source_exercise_id is null and copy_parent_id<>id)) not valid;
alter table library.exercises validate constraint exercise_copy_parent_check;
create index exercise_copy_parent_idx on library.exercises(copy_parent_id) where copy_parent_id is not null;

create function library.guard_exercise_copy_parent() returns trigger
language plpgsql set search_path=pg_catalog,library as $$
begin
  if tg_op='UPDATE' and old.copy_parent_id is not null and
    (new.copy_parent_id is distinct from old.copy_parent_id or new.owner_user_id is distinct from old.owner_user_id or new.owner_scope is distinct from old.owner_scope) then
    raise exception using errcode='23514',message='Exercise copy provenance cannot be changed.';
  end if;
  if new.copy_parent_id is not null then
    perform id from library.exercises where id=new.copy_parent_id for share;
    if exists (
      with recursive ancestry as (
        select id,coalesce(source_exercise_id,copy_parent_id) as parent,array[id] as path from library.exercises where id=new.copy_parent_id
        union all
        select source.id,coalesce(source.source_exercise_id,source.copy_parent_id),ancestry.path||source.id
        from library.exercises source join ancestry on source.id=ancestry.parent
        where not source.id=any(ancestry.path)
      ) select 1 from ancestry where id=new.id or parent=any(path)
    ) then
      raise exception using errcode='23514',message='Exercise copy source cycle is not allowed.';
    end if;
  end if;
  return new;
end $$;
create trigger exercise_copy_parent_guard before insert or update of copy_parent_id,owner_scope,owner_user_id
  on library.exercises for each row execute function library.guard_exercise_copy_parent();
