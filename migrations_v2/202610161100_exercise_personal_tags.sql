create table if not exists library.exercise_personal_tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  exercise_id uuid not null references library.exercises(id) on delete cascade,
  name text not null check (name = btrim(name) and length(name) between 1 and 200),
  created_at timestamptz not null default now()
);

create unique index if not exists exercise_personal_tags_user_exercise_name_unique
  on library.exercise_personal_tags (user_id, exercise_id, lower(name));

alter table library.exercise_personal_tags enable row level security;
revoke all on library.exercise_personal_tags from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on library.exercise_personal_tags from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on library.exercise_personal_tags from authenticated;
  end if;
end $$;
