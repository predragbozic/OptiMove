-- Reusable presets for builder tree nodes (domain/category/section). Scoped
-- to system (admin-seeded), club, team, or a single coach without a
-- club/team. System-scoped rows can be hidden per-user instead of deleted,
-- so an admin default never disappears for everyone just because one coach
-- doesn't like it.
--
-- Template grouping tags reuse the existing library.program_tag_definitions
-- table (see alter_program_tags_scope.sql) instead of a separate table here,
-- since that table already backs program tagging in the Program Library.

create schema if not exists library;

create table if not exists library.node_presets (
  id uuid primary key default gen_random_uuid(),
  node_type varchar(20) not null check (node_type in ('domain', 'category', 'section')),
  name text not null,
  slug text not null,
  color varchar(32),
  icon_url text,
  owner_scope varchar(20) not null default 'user'
    check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_club_id uuid references public.clubs(id) on delete cascade,
  owner_team_id uuid references public.teams(id) on delete cascade,
  owner_user_id uuid references public.users(id) on delete cascade,
  created_by_user_id uuid references public.users(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (owner_scope = 'system' and owner_club_id is null and owner_team_id is null and owner_user_id is null)
    or (owner_scope = 'club' and owner_club_id is not null and owner_team_id is null and owner_user_id is null)
    or (owner_scope = 'team' and owner_team_id is not null and owner_club_id is null and owner_user_id is null)
    or (owner_scope = 'user' and owner_user_id is not null and owner_club_id is null and owner_team_id is null)
  )
);

create table if not exists library.node_preset_hidden (
  id uuid primary key default gen_random_uuid(),
  preset_id uuid not null references library.node_presets(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (preset_id, user_id)
);

-- Nulls compare as distinct from each other in a plain unique constraint, so a
-- sentinel value is substituted for the absent scope columns to actually
-- enforce "one slug per node type per scope owner".
create unique index if not exists node_presets_scope_slug_idx
  on library.node_presets (
    node_type,
    slug,
    owner_scope,
    coalesce(owner_club_id, '00000000-0000-0000-0000-000000000000'),
    coalesce(owner_team_id, '00000000-0000-0000-0000-000000000000'),
    coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000')
  );

create index if not exists node_presets_lookup_idx
  on library.node_presets (node_type, owner_scope, is_active);
