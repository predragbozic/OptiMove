do $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '23514',
      message = 'Exercise source integrity migration requires READ COMMITTED.';
  end if;
end;
$$;

lock table library.exercises in share row exclusive mode;

do $$
begin
  if exists (
    select 1 from library.exercises personal
    left join library.exercises source on source.id = personal.source_exercise_id
    where personal.source_exercise_id is not null
      and (source.id is null or source.owner_scope is distinct from 'system'
        or source.source_exercise_id is not null)
  ) then
    raise exception using errcode = '23514',
      message = 'Exercise copy source integrity preflight failed.';
  end if;
end;
$$;

create index exercise_copy_source_idx on library.exercises(source_exercise_id)
  where source_exercise_id is not null;

create function library.guard_exercise_copy_source() returns trigger
language plpgsql
set search_path = pg_catalog, library
as $$
begin
  if tg_op = 'UPDATE' then
    if old.source_exercise_id is not null
       and (new.source_exercise_id is distinct from old.source_exercise_id
         or new.owner_scope is distinct from old.owner_scope
         or new.owner_user_id is distinct from old.owner_user_id) then
      raise exception using errcode = '23514',
        message = 'Exercise copy provenance cannot be changed.';
    end if;
    if old.owner_scope = 'system'
       and (new.owner_scope is distinct from 'system' or new.source_exercise_id is not null) then
      if current_setting('transaction_isolation') <> 'read committed' then
        raise exception using errcode = '23514',
          message = 'Exercise source ownership changes require READ COMMITTED.';
      end if;
      if exists (select 1 from library.exercises personal where personal.source_exercise_id = old.id) then
        raise exception using errcode = '23514',
          message = 'A referenced exercise source must remain system-owned.';
      end if;
    end if;
  end if;
  if new.source_exercise_id is not null then
    perform source.id from library.exercises source
      where source.id = new.source_exercise_id and source.owner_scope = 'system'
        and source.source_exercise_id is null
      for share of source;
    if not found then
      raise exception using errcode = '23514',
        message = 'Exercise copies require a canonical system source.';
    end if;
  end if;
  return new;
end;
$$;

create trigger exercise_copy_source_guard
  before insert or update of source_exercise_id, owner_scope, owner_user_id
  on library.exercises for each row execute function library.guard_exercise_copy_source();
