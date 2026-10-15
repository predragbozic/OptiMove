create table library.exercise_collections (
  id uuid primary key default gen_random_uuid(),
  name varchar(120) not null check (length(btrim(name)) > 0),
  revision integer not null default 1,
  created_by_user_id uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table library.exercise_collection_items (
  exercise_id uuid primary key references library.exercises(id) on delete restrict,
  collection_id uuid not null references library.exercise_collections(id) on delete restrict
);
create index exercise_collection_items_collection_idx on library.exercise_collection_items(collection_id);

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

alter table library.exercises add column source_exercise_id uuid references library.exercises(id) on delete restrict;
alter table library.exercises add constraint exercise_personal_source_check
  check (source_exercise_id is null or (owner_scope = 'user' and owner_user_id is not null and source_exercise_id <> id));
create unique index exercise_personal_source_owner_idx on library.exercises(owner_user_id, source_exercise_id)
  where source_exercise_id is not null;
