-- library.program_tag_definitions already existed (used for tagging templates
-- in the Program Library) with a partial owner_scope check that already
-- allowed 'club' but no club/team id columns. Finishing that scoping here
-- instead of introducing a second, disconnected "template tags" table, so
-- tags created from Settings and tags used when tagging a program are the
-- same rows.

alter table library.program_tag_definitions
  add column if not exists owner_club_id uuid references public.clubs(id) on delete cascade,
  add column if not exists owner_team_id uuid references public.teams(id) on delete cascade;

alter table library.program_tag_definitions
  drop constraint if exists program_tag_definitions_owner_scope_check;

alter table library.program_tag_definitions
  add constraint program_tag_definitions_owner_scope_check
    check (owner_scope in ('system', 'club', 'team', 'user'));

alter table library.program_tag_definitions
  drop constraint if exists program_tag_definitions_scope_shape_check;

alter table library.program_tag_definitions
  add constraint program_tag_definitions_scope_shape_check
    check (
      (owner_scope = 'system' and owner_club_id is null and owner_team_id is null and owner_user_id is null)
      or (owner_scope = 'club' and owner_club_id is not null and owner_team_id is null and owner_user_id is null)
      or (owner_scope = 'team' and owner_team_id is not null and owner_club_id is null and owner_user_id is null)
      or (owner_scope = 'user' and owner_user_id is not null and owner_club_id is null and owner_team_id is null)
    );

create unique index if not exists program_tag_definitions_scope_slug_idx
  on library.program_tag_definitions (
    slug,
    owner_scope,
    coalesce(owner_club_id, '00000000-0000-0000-0000-000000000000'),
    coalesce(owner_team_id, '00000000-0000-0000-0000-000000000000'),
    coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000')
  );

create table if not exists library.program_tag_hidden (
  id uuid primary key default gen_random_uuid(),
  tag_id uuid not null references library.program_tag_definitions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (tag_id, user_id)
);

-- Superseded by the scoping above: nothing ever wrote to these.
drop table if exists library.template_tag_hidden;
drop table if exists library.template_tags;
