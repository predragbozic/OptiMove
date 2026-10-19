// Handbuilt runtime contract for tests that already provide users and exercises.
// This fixture does not validate or execute migrations or rollback scripts.
import { readFileSync } from "node:fs";

export const EXERCISE_COLLECTIONS_FIXTURE_SQL = `
  create table if not exists public.user_workspace_preferences (
    user_id uuid primary key references public.users(id),workspace_type varchar(20) not null,scope_id uuid,updated_at timestamptz not null default now()
  );
  ${readFileSync(new URL("../../../migrations_v2/202610161100_exercise_personal_tags.sql", import.meta.url), "utf8")}

  alter table library.exercises
    add column source_exercise_id uuid references library.exercises(id),
    add constraint fixture_exercise_source_check check (
      source_exercise_id is null or
      (owner_scope = 'user' and owner_user_id is not null and source_exercise_id <> id)
    );

  create table if not exists library.filter_hidden (
    id uuid primary key default gen_random_uuid(),kind varchar(20) not null,item_id uuid not null,
    user_id uuid not null references public.users(id),created_at timestamptz not null default now(),
    unique(kind,item_id,user_id)
  );
  ${readFileSync(new URL("../../../migrations_v2/202610161400_exercise_personal_classification.sql", import.meta.url), "utf8")}

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
  ${readFileSync(new URL("../../../migrations_v2/202610162230_exercise_block_catalog.sql", import.meta.url), "utf8")}
  ${readFileSync(new URL("../../../migrations_v2/202610171200_exercise_block_soft_delete.sql", import.meta.url), "utf8")}
`;

// BE-1 selection columns for legacy runtime fixtures, without a media store.
export async function addMediaSelectionFixture(runQuery) {
  for(const table of ['library.exercises','plans.plan_items']) {
    if(!(await runQuery('select to_regclass($1) as table_name',[table])).rows[0].table_name)continue;
    await runQuery(`alter table ${table}
      add column video_source text not null default 'legacy',add column video_asset_id uuid,
      add column image_source text not null default 'legacy',add column image_asset_id uuid`);
  }
}
