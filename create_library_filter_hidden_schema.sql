-- library.domains/categories/sections/tags/attractors already carry
-- owner_scope + owner_club_id/owner_team_id/owner_user_id (built earlier,
-- club/team just never wired into a UI or into exercises.js option
-- filtering). This adds one shared "hide for me" table covering all five,
-- instead of five near-identical tables, since a system-scoped row can't be
-- deleted outright (see library.node_preset_hidden for the same pattern
-- applied to builder tree presets).

create table if not exists library.filter_hidden (
  id uuid primary key default gen_random_uuid(),
  kind varchar(20) not null check (kind in ('domain', 'category', 'section', 'tag', 'attractor')),
  item_id uuid not null,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (kind, item_id, user_id)
);

create index if not exists filter_hidden_lookup_idx
  on library.filter_hidden (kind, item_id);
