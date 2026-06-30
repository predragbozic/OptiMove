create table if not exists library.exercise_favorites (
  user_id uuid not null references public.users(id) on delete cascade,
  exercise_id uuid not null references library.exercises(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

create index if not exists exercise_favorites_exercise_idx
  on library.exercise_favorites (exercise_id);
