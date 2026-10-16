// Handbuilt runtime contract for tests that already provide users and exercises.
// This fixture does not validate or execute migrations or rollback scripts.
import { readFileSync } from "node:fs";

export const EXERCISE_COLLECTIONS_FIXTURE_SQL = `
  ${readFileSync(new URL("../../../migrations_v2/202610161100_exercise_personal_tags.sql", import.meta.url), "utf8")}

  alter table library.exercises
    add column source_exercise_id uuid references library.exercises(id),
    add constraint fixture_exercise_source_check check (
      source_exercise_id is null or
      (owner_scope = 'user' and owner_user_id is not null and source_exercise_id <> id)
    );

  create unique index fixture_exercise_private_source_unique
    on library.exercises (owner_user_id, source_exercise_id)
    where owner_scope = 'user' and source_exercise_id is not null;

  create table library.exercise_collections (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    revision integer not null default 1,
    created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table library.exercise_collection_items (
    collection_id uuid not null references library.exercise_collections(id) on delete cascade,
    exercise_id uuid not null unique references library.exercises(id) on delete cascade,
    primary key (collection_id, exercise_id)
  );

  create table library.exercise_collection_users (
    collection_id uuid not null references library.exercise_collections(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    primary key (collection_id, user_id)
  );

  create table library.exercise_collection_audit (
    id uuid primary key default gen_random_uuid(),
    collection_id uuid not null references library.exercise_collections(id),
    actor_user_id uuid not null references public.users(id),
    before_state jsonb,
    after_state jsonb not null,
    created_at timestamptz not null default now()
  );
`;
