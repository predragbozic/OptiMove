-- v84: roles and permissions, step R2 (docs/ai/roles-r2-contract.md, accepted 2026-11-19).
--
-- Nine tables in public: the closed catalog (permission_modules, permissions,
-- permission_scope_types), the roles (permission_roles, permission_role_items,
-- permission_role_module_display), their append-only change record
-- (permission_role_changes), the non-basic assignments (user_role_assignments)
-- and the request record of the Roles API (permission_requests). The SQL twin
-- of can() (public.user_has_permission), its companion
-- (public.user_holds_role_items), the lock function
-- (public.lock_permission_actor), and one CHECK on each of the two old scoped
-- role tables.
--
-- The migration assigns no role to anyone and reads no existing row to build
-- its seed: the four basic roles have literal ids, their 10 item rows are
-- literals (contract 3.3). The three old role tables stay the only source of
-- today's four roles; no existing row is rewritten.
--
-- Order of this file (contract 2.4, M15): the tables, the seed, then the
-- functions and the guard triggers (so the seed meets no guard), then row-level
-- security and the revokes, and last the refusal block and the two ALTER TABLE
-- statements of 2.10, after `set local lock_timeout`.
--
-- The acting user (contract 5.4): the Roles API sets the transaction-local
-- optimove.permission_actor = '<user uuid>:<id of this transaction>' before its
-- first protected write. Missing, malformed or naming another transaction:
-- 42501. Known limit (v35's): the guards keep an unintended write that bypasses
-- the service out; they are no defence against whoever controls the database
-- credentials the application and the migrations share. A row written inside a
-- savepoint carries the subtransaction's id as its xmin and is refused (fail
-- closed).
--
-- A later migration writes role items without an acting user (M15): the role's
-- UPDATE (revision + 1), then a permission_role_changes row of kind
-- 'migration' naming its own file, then the item rows. The guards skip the
-- actor, ceiling and dominance checks only then; a deferred guard requires the
-- public.schema_migrations row of that name written by the same transaction,
-- which only the runner writes.
--
-- Refusals: 42501 "the acting user may not", 23514 "the row or its chain is not
-- allowed", 22023 an unknown permission word or scope type in the twin. Fixed
-- messages only: no id, name, value or SQL text. Requires PostgreSQL 13 or later
-- (pg_current_xact_id()).

-- ===========================================================================
-- 1. The catalog
-- ===========================================================================
create table public.permission_modules (
  word text primary key check (word ~ '^[a-z_]{1,40}$'),
  label text not null,
  sort_order smallint not null unique check (sort_order > 0)
);

create table public.permissions (
  word text primary key check (word ~ '^[a-z_]+(\.[a-z_]+){1,2}$' and char_length(word) <= 60),
  module_word text not null references public.permission_modules (word) on delete restrict,
  platform_only boolean not null default false,
  system_role_only boolean not null default false,
  sort_order smallint not null unique check (sort_order > 0),
  constraint permissions_flags_exclusive check (not (platform_only and system_role_only))
);
create index permissions_module_word_idx on public.permissions (module_word);

create table public.permission_scope_types (
  permission_word text not null references public.permissions (word) on delete restrict,
  scope_type text not null check (scope_type in ('club', 'team', 'private', 'global')),
  primary key (permission_word, scope_type)
);

-- ===========================================================================
-- 2. Free text (a public copy of training_load.source_metric_text_ok as v40
--    left it; M3 - a test asserts the two bodies agree)
-- ===========================================================================
create function public.permission_text_ok(v text, max_len integer) returns boolean
  language sql immutable as $$
    select coalesce(char_length(v) between 1 and max_len
       and v !~ '^[\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]|[\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]$'
       and v !~ '[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]', false)
  $$;

-- A role's per-module display, as recorded on a change row: a flat object
-- module word -> 'hidden' / 'locked'.
create function public.permission_display_ok(v jsonb) returns boolean
  language sql immutable as $$
    select v is null or (
      jsonb_typeof(v) = 'object'
      and not exists (select 1 from jsonb_each(v) e
                       where e.key !~ '^[a-z_]{1,40}$'
                          or jsonb_typeof(e.value) <> 'string'
                          or (e.value #>> '{}') not in ('hidden', 'locked'))
    )
  $$;

-- ===========================================================================
-- 3. Roles, items, display, changes, assignments, requests
-- ===========================================================================
create table public.permission_roles (
  id uuid primary key default gen_random_uuid(),
  owner_scope text not null check (owner_scope in ('system', 'club')),
  owner_club_id uuid references public.clubs (id) on delete restrict,
  name text not null check (public.permission_text_ok(name, 80)),
  description text check (description is null or public.permission_text_ok(description, 500)),
  assignable_club boolean not null default false,
  assignable_team boolean not null default false,
  assignable_private boolean not null default false,
  assignable_global boolean not null default false,
  is_basic boolean not null default false,
  basic_key text check (basic_key in ('platform_admin', 'club_admin', 'team_coach', 'independent_coach')),
  copied_from_role_id uuid references public.permission_roles (id) on delete restrict,
  copied_from_revision integer,
  revision integer not null default 1 check (revision >= 1),
  archived_at timestamptz,
  archived_by_user_id uuid references public.users (id) on delete restrict,
  created_by_user_id uuid references public.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint permission_roles_owner_shape check ((owner_scope = 'system') = (owner_club_id is null)),
  constraint permission_roles_assignable_any check (assignable_club or assignable_team or assignable_private or assignable_global),
  constraint permission_roles_club_role_scopes check (owner_scope = 'system' or (not assignable_private and not assignable_global)),
  constraint permission_roles_global_platform_only check (not assignable_global or basic_key is not distinct from 'platform_admin'),
  constraint permission_roles_basic_shape check (is_basic = (basic_key is not null) and (not is_basic or owner_scope = 'system')),
  constraint permission_roles_copy_shape check ((copied_from_role_id is null) = (copied_from_revision is null)
                                                and (copied_from_role_id is null or owner_scope = 'club')),
  constraint permission_roles_archive_shape check ((archived_at is null) = (archived_by_user_id is null)
                                                   and (archived_at is null or not is_basic))
);
create unique index permission_roles_basic_key_key on public.permission_roles (basic_key) where basic_key is not null;
create unique index permission_roles_owner_name_key on public.permission_roles
  (coalesce(owner_club_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) where archived_at is null;
create index permission_roles_owner_club_active_idx on public.permission_roles (owner_club_id) where archived_at is null;
create index permission_roles_owner_club_id_idx on public.permission_roles (owner_club_id);
create index permission_roles_copied_from_role_id_idx on public.permission_roles (copied_from_role_id);
create index permission_roles_archived_by_user_id_idx on public.permission_roles (archived_by_user_id);
create index permission_roles_created_by_user_id_idx on public.permission_roles (created_by_user_id);

create table public.permission_role_items (
  role_id uuid not null references public.permission_roles (id) on delete restrict,
  permission_word text not null references public.permissions (word) on delete restrict,
  added_by_user_id uuid references public.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_word)
);
create index permission_role_items_permission_word_idx on public.permission_role_items (permission_word);
create index permission_role_items_added_by_user_id_idx on public.permission_role_items (added_by_user_id);

create table public.permission_role_module_display (
  role_id uuid not null references public.permission_roles (id) on delete restrict,
  module_word text not null references public.permission_modules (word) on delete restrict,
  display text not null check (display in ('hidden', 'locked')),
  primary key (role_id, module_word)
);
create index permission_role_module_display_module_word_idx on public.permission_role_module_display (module_word);

create table public.permission_role_changes (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references public.permission_roles (id) on delete restrict,
  revision_after integer not null check (revision_after >= 1),
  kind text not null check (kind in ('create', 'copy', 'change', 'archive', 'migration')),
  performed_by_user_id uuid references public.users (id) on delete restrict,
  basis text check (basis in ('platform_admin', 'club_admin')),
  migration_name text,
  reason text check (reason is null or public.permission_text_ok(reason, 500)),
  name_before text,
  name_after text,
  description_changed boolean not null default false,
  items_added text[] not null default '{}',
  items_removed text[] not null default '{}',
  scope_types_added text[] not null default '{}',
  display_after jsonb check (public.permission_display_ok(display_after)),
  copied_from_role_id uuid references public.permission_roles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint permission_role_changes_revision_key unique (role_id, revision_after),
  constraint permission_role_changes_actor_shape check (
    (kind = 'migration') = (performed_by_user_id is null)
    and (kind = 'migration') = (basis is null)
    and (kind = 'migration') = (migration_name is not null)
    and (migration_name is null or char_length(migration_name) between 1 and 200)),
  constraint permission_role_changes_reason_required check (kind not in ('change', 'archive') or reason is not null),
  constraint permission_role_changes_names_shape check ((name_before is null) = (name_after is null)),
  constraint permission_role_changes_items_disjoint check (not (items_added && items_removed)),
  constraint permission_role_changes_copy_shape check ((kind = 'copy') = (copied_from_role_id is not null)),
  constraint permission_role_changes_changes_something check (
    kind not in ('change', 'migration')
    or name_before is distinct from name_after
    or description_changed
    or cardinality(items_added) > 0
    or cardinality(items_removed) > 0
    or cardinality(scope_types_added) > 0
    or display_after is not null)
);
create index permission_role_changes_performed_by_user_id_idx on public.permission_role_changes (performed_by_user_id);
create index permission_role_changes_copied_from_role_id_idx on public.permission_role_changes (copied_from_role_id);

create table public.user_role_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete restrict,
  role_id uuid not null references public.permission_roles (id) on delete restrict,
  scope_type text not null check (scope_type in ('club', 'team', 'private', 'global')),
  scope_id uuid not null,
  scope_club_id uuid generated always as (case when scope_type = 'club' then scope_id end) stored
    references public.clubs (id) on delete restrict,
  scope_team_id uuid generated always as (case when scope_type = 'team' then scope_id end) stored
    references public.teams (id) on delete restrict,
  display_title text check (display_title is null or public.permission_text_ok(display_title, 80)),
  granted_by_user_id uuid not null references public.users (id) on delete restrict,
  grant_basis text not null check (grant_basis in ('platform_admin', 'club_admin')),
  grant_reason text not null check (public.permission_text_ok(grant_reason, 500)),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid references public.users (id) on delete restrict,
  revoke_kind text check (revoke_kind in ('revoked', 'expired')),
  revoke_reason text check (revoke_reason is null or public.permission_text_ok(revoke_reason, 500)),
  created_at timestamptz not null default now(),
  constraint user_role_assignments_scope_shape check (
    (scope_type = 'global' and scope_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (scope_type = 'private' and scope_id = user_id)
    or (scope_type in ('club', 'team') and scope_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
  constraint user_role_assignments_expiry_shape check (expires_at is null or expires_at > created_at),
  constraint user_role_assignments_revoke_shape check (
    (revoked_at is null) = (revoked_by_user_id is null)
    and (revoked_at is null) = (revoke_kind is null)
    and (revoked_at is not null or revoke_reason is null)
    and (revoke_kind is distinct from 'revoked' or revoke_reason is not null))
);
create unique index user_role_assignments_active_key on public.user_role_assignments (user_id, role_id, scope_type, scope_id) where revoked_at is null;
create index user_role_assignments_user_active_idx on public.user_role_assignments (user_id) where revoked_at is null;
create index user_role_assignments_scope_active_idx on public.user_role_assignments (scope_type, scope_id) where revoked_at is null;
create index user_role_assignments_user_id_idx on public.user_role_assignments (user_id);
create index user_role_assignments_role_id_idx on public.user_role_assignments (role_id);
create index user_role_assignments_scope_club_id_idx on public.user_role_assignments (scope_club_id);
create index user_role_assignments_scope_team_id_idx on public.user_role_assignments (scope_team_id);
create index user_role_assignments_granted_by_user_id_idx on public.user_role_assignments (granted_by_user_id);
create index user_role_assignments_revoked_by_user_id_idx on public.user_role_assignments (revoked_by_user_id);

create table public.permission_requests (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null,
  requested_by_user_id uuid not null references public.users (id) on delete restrict,
  operation text not null check (operation in ('role_create', 'role_copy', 'role_change', 'role_archive', 'assignment_grant', 'assignment_revoke')),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  owner_scope text not null check (owner_scope in ('system', 'club')),
  owner_club_id uuid references public.clubs (id) on delete restrict,
  basis text not null check (basis in ('platform_admin', 'club_admin')),
  role_change_id uuid references public.permission_role_changes (id) on delete restrict,
  assignment_id uuid references public.user_role_assignments (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint permission_requests_key unique (requested_by_user_id, request_key),
  constraint permission_requests_owner_shape check ((owner_scope = 'system') = (owner_club_id is null)),
  constraint permission_requests_result_shape check (
    (operation like 'role\_%' and role_change_id is not null and assignment_id is null)
    or (operation like 'assignment\_%' and assignment_id is not null and role_change_id is null)),
  constraint permission_requests_assignment_operation_key unique (assignment_id, operation)
);
create unique index permission_requests_role_change_id_key on public.permission_requests (role_change_id) where role_change_id is not null;
create index permission_requests_owner_club_id_idx on public.permission_requests (owner_club_id);

-- ===========================================================================
-- 4. The seed (contract 3; a fixed literal list, before any guard exists)
-- ===========================================================================
insert into public.permission_modules (word, label, sort_order) values
  ('organization', 'Organization and staff', 1),
  ('athletes', 'Athletes', 2),
  ('programs', 'Programs (Builder)', 3),
  ('exercises', 'Exercises', 4),
  ('presets', 'Tags and presets', 5),
  ('calendar', 'Calendar', 6),
  ('training_load', 'Training Load', 7),
  ('dashboards', 'Dashboards', 8),
  ('imports', 'Imports', 9),
  ('tests', 'Tests', 10),
  ('messages', 'Messages', 11),
  ('data_configuration', 'Data configuration', 12);

insert into public.permissions (word, module_word, platform_only, system_role_only, sort_order) values
  ('org.view', 'organization', false, false, 1),
  ('org.teams.manage', 'organization', false, false, 2),
  ('org.club.edit', 'organization', false, false, 3),
  ('accounts.manage', 'organization', false, true, 4),
  ('staff.assign', 'organization', false, true, 5),
  ('roles.manage', 'organization', false, true, 6),
  ('platform.admin', 'organization', true, false, 7),
  ('athletes.view', 'athletes', false, false, 8),
  ('athletes.manage', 'athletes', false, false, 9),
  ('athletes.remove', 'athletes', false, false, 10),
  ('athletes.logins.manage', 'athletes', false, false, 11),
  ('athletes.library_access', 'athletes', false, false, 12),
  ('join_links.manage', 'athletes', false, false, 13),
  ('programs.view', 'programs', false, false, 14),
  ('programs.edit', 'programs', false, false, 15),
  ('programs.assign', 'programs', false, false, 16),
  ('programs.publish', 'programs', false, false, 17),
  ('programs.rpe_settings', 'programs', false, false, 18),
  ('presets.use', 'presets', false, false, 19),
  ('presets.manage', 'presets', false, false, 20),
  ('exercise_lists.manage', 'presets', false, false, 21),
  ('exercises.use', 'exercises', false, false, 22),
  ('exercises.add', 'exercises', false, false, 23),
  ('exercises.media.upload', 'exercises', false, false, 24),
  ('exercises.remove', 'exercises', false, false, 25),
  ('exercises.blocks.manage', 'exercises', true, false, 26),
  ('calendar.view', 'calendar', false, false, 27),
  ('calendar.events.manage', 'calendar', false, false, 28),
  ('calendar.settings.manage', 'calendar', false, false, 29),
  ('load.view.team', 'training_load', false, false, 30),
  ('load.view.athlete', 'training_load', false, false, 31),
  ('load.schedule.manage', 'training_load', false, false, 32),
  ('load.roster.decide', 'training_load', false, false, 33),
  ('load.estimates.manage', 'training_load', false, false, 34),
  ('load.activities.manage', 'training_load', false, false, 35),
  ('dashboards.view', 'dashboards', false, false, 36),
  ('dashboards.manage', 'dashboards', false, false, 37),
  ('import.check', 'imports', false, false, 38),
  ('import.link', 'imports', false, false, 39),
  ('import.approve', 'imports', false, false, 40),
  ('import.undo', 'imports', false, false, 41),
  ('tests.view', 'tests', false, false, 42),
  ('tests.results.view', 'tests', false, false, 43),
  ('tests.schedule.manage', 'tests', false, false, 44),
  ('tests.library.manage', 'tests', true, false, 45),
  ('messages.send', 'messages', false, false, 46),
  ('variables.view', 'data_configuration', false, false, 47),
  ('variables.rename_archive', 'data_configuration', false, false, 48),
  ('variables.manage', 'data_configuration', false, false, 49),
  ('mappings.manage', 'data_configuration', false, false, 50),
  ('sources.connect', 'data_configuration', false, false, 51),
  ('platform.metrics.manage', 'data_configuration', true, false, 52);

-- 37 words for club and team (74 rows), 9 for a club only, 2 for a team only,
-- 4 global: 89 rows. No 'private' row in R2 (O9).
insert into public.permission_scope_types (permission_word, scope_type)
select w, s
  from unnest(array[
    'org.view', 'athletes.view', 'athletes.manage', 'athletes.remove', 'athletes.logins.manage',
    'athletes.library_access', 'join_links.manage', 'programs.view', 'programs.edit', 'programs.assign',
    'programs.publish', 'programs.rpe_settings', 'presets.use', 'presets.manage', 'exercise_lists.manage',
    'exercises.use', 'exercises.add', 'exercises.media.upload', 'exercises.remove', 'calendar.view',
    'calendar.events.manage', 'load.view.team', 'load.view.athlete', 'load.schedule.manage',
    'load.roster.decide', 'load.estimates.manage', 'load.activities.manage', 'dashboards.view',
    'dashboards.manage', 'import.check', 'import.link', 'tests.view', 'tests.results.view',
    'tests.schedule.manage', 'messages.send', 'variables.view', 'variables.rename_archive']) as w
 cross join unnest(array['club', 'team']) as s;
insert into public.permission_scope_types (permission_word, scope_type) values
  ('org.teams.manage', 'club'), ('org.club.edit', 'club'), ('accounts.manage', 'club'), ('staff.assign', 'club'),
  ('roles.manage', 'club'), ('calendar.settings.manage', 'club'), ('variables.manage', 'club'),
  ('mappings.manage', 'club'), ('sources.connect', 'club'),
  ('import.approve', 'team'), ('import.undo', 'team'),
  ('platform.admin', 'global'), ('exercises.blocks.manage', 'global'), ('tests.library.manage', 'global'),
  ('platform.metrics.manage', 'global');

-- The four basic roles (literal ids; created_by_user_id null exactly for them).
insert into public.permission_roles (id, owner_scope, name, assignable_club, assignable_team, assignable_private, assignable_global, is_basic, basic_key) values
  ('00000000-0000-4000-8000-000000000841', 'system', 'Platform admin', false, false, false, true, true, 'platform_admin'),
  ('00000000-0000-4000-8000-000000000842', 'system', 'Club admin', true, false, false, false, true, 'club_admin'),
  ('00000000-0000-4000-8000-000000000843', 'system', 'Team coach', false, true, false, false, true, 'team_coach'),
  ('00000000-0000-4000-8000-000000000844', 'system', 'Independent coach', false, false, true, false, true, 'independent_coach');

insert into public.permission_role_items (role_id, permission_word) values
  ('00000000-0000-4000-8000-000000000842', 'org.view'),
  ('00000000-0000-4000-8000-000000000842', 'org.teams.manage'),
  ('00000000-0000-4000-8000-000000000842', 'org.club.edit'),
  ('00000000-0000-4000-8000-000000000842', 'athletes.manage'),
  ('00000000-0000-4000-8000-000000000842', 'athletes.remove'),
  ('00000000-0000-4000-8000-000000000842', 'staff.assign'),
  ('00000000-0000-4000-8000-000000000842', 'roles.manage'),
  ('00000000-0000-4000-8000-000000000843', 'org.view'),
  ('00000000-0000-4000-8000-000000000843', 'athletes.manage'),
  ('00000000-0000-4000-8000-000000000843', 'athletes.remove');

-- ===========================================================================
-- 5. The acting user and helpers
-- ===========================================================================
-- The acting user of this transaction, or 42501.
create function public.permission_context_actor() returns uuid as $$
declare
  raw text := current_setting('optimove.permission_actor', true);
begin
  if raw is null
     or raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{1,20}$'
     or split_part(raw, ':', 2) is distinct from pg_current_xact_id()::text then
    raise exception 'permissions: no acting user is set for this transaction' using errcode = '42501';
  end if;
  return split_part(raw, ':', 1)::uuid;
end;
$$ language plpgsql volatile set search_path = pg_catalog, public;

-- True when no acting user is set at all (the setting missing or empty). Any
-- other value must be a valid acting user of this transaction.
create function public.permission_actor_absent() returns boolean as $$
  select coalesce(current_setting('optimove.permission_actor', true), '') = ''
$$ language sql volatile set search_path = pg_catalog, public;

-- This transaction's id as a row's xmin carries it.
create function public.permission_current_xmin() returns bigint
  language sql volatile set search_path = pg_catalog, public as $$
    select pg_current_xact_id()::text::bigint % 4294967296
  $$;

-- The honoured words (contract 3.3): a word some can() call site checks at a
-- club or team scope. A later migration replaces this function when a module
-- moves; its code twin is HONOURED_PERMISSIONS (backend/src/permissions.js).
create function public.permission_word_honoured(p_word text) returns boolean
  language sql immutable set search_path = pg_catalog, public as $$
    select p_word in ('org.view', 'org.teams.manage', 'org.club.edit', 'athletes.manage', 'athletes.remove',
                      'staff.assign', 'roles.manage')
  $$;

-- ===========================================================================
-- 6. The SQL twin of can() (contract 4.1)
-- ===========================================================================
create function public.user_has_permission(p_user uuid, p_permission text, p_scope_type text, p_scope_id uuid)
returns boolean as $$
declare
  w record;
  club uuid;
begin
  -- 1. An unknown word or scope type is a programming error (M12).
  select word, platform_only into w from public.permissions where word = p_permission;
  if not found or p_scope_type is null or p_scope_type not in ('global', 'club', 'team', 'private') then
    raise exception 'permission check: unknown permission or scope type' using errcode = '22023';
  end if;
  -- 2. No user, an unknown or an inactive one (M13).
  if p_user is null or not exists (select 1 from public.users where id = p_user and is_active = true) then
    return false;
  end if;
  -- 3. A platform admin holds everything.
  if exists (select 1 from public.user_global_roles where user_id = p_user and role = 'platform_admin' and is_active = true) then
    return true;
  end if;
  -- 4. Convention 1: global scope and platform-only words are a platform admin's only.
  if w.platform_only or p_scope_type = 'global' then
    return false;
  end if;
  -- 5. Convention 3: a scope without an id is no resource.
  if p_scope_id is null or p_scope_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;
  -- 6 and 7. The roles of the scope, from both sources; any of them not
  -- archived holding the word.
  if p_scope_type = 'team' then
    select t.club_id into club from public.teams t where t.id = p_scope_id;
    if not found then
      return false;
    end if;
  elsif p_scope_type = 'club' then
    club := p_scope_id;
  end if;
  return exists (
    select 1
      from public.permission_roles r
      join public.permission_role_items i on i.role_id = r.id and i.permission_word = p_permission
     where r.archived_at is null
       and (
         -- (b) the old tables, mapped to the basic roles
         (r.basic_key = 'club_admin' and club is not null and exists (
            select 1 from public.user_club_roles c
             where c.user_id = p_user and c.club_id = club and c.role = 'club_admin' and c.is_active = true))
         or (r.basic_key = 'team_coach' and p_scope_type = 'team' and exists (
            select 1 from public.user_team_roles t
             where t.user_id = p_user and t.team_id = p_scope_id and t.role = 'team_coach' and t.is_active = true))
         or (r.basic_key = 'independent_coach' and p_scope_type = 'private' and p_scope_id = p_user and exists (
            select 1 from public.user_global_roles g
             where g.user_id = p_user and g.role = 'independent_coach' and g.is_active = true))
         -- (a) the active non-basic assignments
         or exists (
            select 1 from public.user_role_assignments a
             where a.user_id = p_user and a.role_id = r.id
               and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())
               and ((a.scope_type = p_scope_type and a.scope_id = p_scope_id
                     and (p_scope_type <> 'private' or p_scope_id = p_user))
                    or (p_scope_type = 'team' and a.scope_type = 'club' and a.scope_id = club)))
       )
  );
end;
$$ language plpgsql stable set search_path = pg_catalog, public;

-- Does the user hold every item of the role in this scope? (The ceiling and
-- dominance of 2.4 and 2.7.) A platform admin holds everything; a role without
-- items is held by everyone.
create function public.user_holds_role_items(p_user uuid, p_role_id uuid, p_scope_type text, p_scope_id uuid)
returns boolean as $$
  select coalesce(bool_and(public.user_has_permission(p_user, i.permission_word, p_scope_type, p_scope_id)), true)
    from public.permission_role_items i
   where i.role_id = p_role_id
$$ language sql stable set search_path = pg_catalog, public;

-- The basis the database derives for an acting user and a word at a scope:
-- 'platform_admin' for an active platform admin, 'club_admin' for a holder of
-- the word there, otherwise null.
create function public.permission_actor_basis(p_actor uuid, p_word text, p_scope_type text, p_scope_id uuid) returns text as $$
  select case
    when exists (select 1 from public.users u join public.user_global_roles g on g.user_id = u.id
                  where u.id = p_actor and u.is_active and g.role = 'platform_admin' and g.is_active) then 'platform_admin'
    when p_scope_type in ('club', 'team') and public.user_has_permission(p_actor, p_word, p_scope_type, p_scope_id) then 'club_admin'
  end
$$ language sql stable set search_path = pg_catalog, public;

-- ===========================================================================
-- 7. The lock function (contract 4.2, 4.3)
-- ===========================================================================
-- Locks FOR SHARE every row the answer of user_has_permission for that user and
-- scope rests on, in the order of 4.3: the acting user's users row (its own
-- statement); the acting user's rows of the old tables (global, club, team);
-- the assignment rows by id; the role rows by id. As built (the contract's
-- three parameters, plus three optional ones): p_role_for_update names the role
-- being edited or archived, locked FOR UPDATE in its place in the id order;
-- p_assignment_for_update names the assignment being revoked, locked FOR NO KEY
-- UPDATE in its place; p_role_for_share names a role only read (the role being
-- assigned, the source of a copy), locked FOR SHARE in its place.
-- Returns 'platform_admin', 'club_admin' (the user holds staff.assign or
-- roles.manage at the scope) or null.
create function public.lock_permission_actor(p_user uuid, p_scope_type text, p_scope_id uuid,
                                             p_role_for_update uuid default null,
                                             p_assignment_for_update uuid default null,
                                             p_role_for_share uuid default null)
returns text as $$
declare
  club uuid;
  rid uuid;
  role_ids uuid[];
begin
  if p_scope_type is null or p_scope_type not in ('global', 'club', 'team', 'private') then
    raise exception 'permission check: unknown permission or scope type' using errcode = '22023';
  end if;
  -- Place 1: the acting user's row, a statement of its own.
  perform 1 from public.users where id = p_user for share;
  if p_scope_type = 'team' then
    select t.club_id into club from public.teams t where t.id = p_scope_id;
  elsif p_scope_type = 'club' then
    club := p_scope_id;
  end if;
  -- Place 3: the old tables' rows of the acting user, then the assignment rows by id.
  perform 1 from public.user_global_roles where user_id = p_user order by id for share;
  if club is not null then
    perform 1 from public.user_club_roles where user_id = p_user and club_id = club order by id for share;
  end if;
  if p_scope_type = 'team' then
    perform 1 from public.user_team_roles where user_id = p_user and team_id = p_scope_id order by id for share;
  end if;
  for rid in
    select a.id from public.user_role_assignments a
     where (a.id = p_assignment_for_update)
        or (a.user_id = p_user and a.revoked_at is null
            and ((a.scope_type = p_scope_type and a.scope_id = p_scope_id)
                 or (p_scope_type = 'team' and a.scope_type = 'club' and a.scope_id = club)))
     order by a.id
  loop
    if rid = p_assignment_for_update then
      perform 1 from public.user_role_assignments where id = rid for no key update;
    else
      perform 1 from public.user_role_assignments where id = rid for share;
    end if;
  end loop;
  -- Place 4: the role rows by id.
  select array_agg(distinct x order by x) into role_ids from (
    select a.role_id as x from public.user_role_assignments a
     where a.user_id = p_user and a.revoked_at is null
       and ((a.scope_type = p_scope_type and a.scope_id = p_scope_id)
            or (p_scope_type = 'team' and a.scope_type = 'club' and a.scope_id = club))
    union select r.id from public.permission_roles r
     where (r.basic_key = 'club_admin' and club is not null and exists (
              select 1 from public.user_club_roles c where c.user_id = p_user and c.club_id = club and c.role = 'club_admin' and c.is_active))
        or (r.basic_key = 'team_coach' and p_scope_type = 'team' and exists (
              select 1 from public.user_team_roles t where t.user_id = p_user and t.team_id = p_scope_id and t.role = 'team_coach' and t.is_active))
    union select p_role_for_update where p_role_for_update is not null
    union select p_role_for_share where p_role_for_share is not null
  ) s;
  if role_ids is not null then
    foreach rid in array role_ids loop
      if rid = p_role_for_update then
        perform 1 from public.permission_roles where id = rid for update;
      else
        perform 1 from public.permission_roles where id = rid for share;
      end if;
    end loop;
  end if;
  if exists (select 1 from public.users u join public.user_global_roles g on g.user_id = u.id
              where u.id = p_user and u.is_active and g.role = 'platform_admin' and g.is_active) then
    return 'platform_admin';
  end if;
  if p_scope_type in ('club', 'team')
     and (public.user_has_permission(p_user, 'staff.assign', p_scope_type, p_scope_id)
          or public.user_has_permission(p_user, 'roles.manage', p_scope_type, p_scope_id)) then
    return 'club_admin';
  end if;
  return null;
end;
$$ language plpgsql volatile set search_path = pg_catalog, public;

-- ===========================================================================
-- 8. Guards: the catalog
-- ===========================================================================
create function public.permission_catalog_fixed() returns trigger as $$
begin
  if tg_table_name = 'permission_modules' then
    raise exception 'permission modules: the list is fixed' using errcode = '23514';
  end if;
  raise exception 'permissions: the catalog is fixed' using errcode = '23514';
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger permission_modules_fixed before update or delete on public.permission_modules
  for each row execute function public.permission_catalog_fixed();
create trigger permission_modules_fixed_truncate before truncate on public.permission_modules
  for each statement execute function public.permission_catalog_fixed();
create trigger permissions_fixed before update or delete on public.permissions
  for each row execute function public.permission_catalog_fixed();
create trigger permissions_fixed_truncate before truncate on public.permissions
  for each statement execute function public.permission_catalog_fixed();
create trigger permission_scope_types_fixed before update or delete on public.permission_scope_types
  for each row execute function public.permission_catalog_fixed();
create trigger permission_scope_types_fixed_truncate before truncate on public.permission_scope_types
  for each statement execute function public.permission_catalog_fixed();

-- At COMMIT: every word has a scope row, and platform_only = (its only scope type is 'global').
create function public.permission_catalog_complete() returns trigger as $$
declare
  v_word text;
  types text[];
  only_platform boolean;
begin
  if tg_table_name = 'permissions' then
    v_word := new.word;
  else
    v_word := new.permission_word;
  end if;
  select array_agg(scope_type order by scope_type) into types from public.permission_scope_types where permission_word = v_word;
  select platform_only into only_platform from public.permissions p where p.word = v_word;
  if types is null or only_platform is null or only_platform is distinct from (types = array['global']) then
    raise exception 'permissions: the catalog is fixed' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create constraint trigger permissions_complete after insert on public.permissions
  deferrable initially deferred for each row execute function public.permission_catalog_complete();
create constraint trigger permission_scope_types_complete after insert on public.permission_scope_types
  deferrable initially deferred for each row execute function public.permission_catalog_complete();

-- ===========================================================================
-- 9. Guards: roles (contract 2.3)
-- ===========================================================================
-- May the acting user write a role of this owner? A system role: an active
-- platform admin; a club's role: an active platform admin, or a holder of
-- roles.manage for that active club.
create function public.permission_role_actor_may(p_actor uuid, p_owner_scope text, p_owner_club uuid) returns boolean as $$
  select case
    when exists (select 1 from public.users u join public.user_global_roles g on g.user_id = u.id
                  where u.id = p_actor and u.is_active and g.role = 'platform_admin' and g.is_active) then
      p_owner_scope = 'system'
      or exists (select 1 from public.clubs c where c.id = p_owner_club and coalesce(c.is_active, true))
    when p_owner_scope = 'club' then
      exists (select 1 from public.clubs c where c.id = p_owner_club and coalesce(c.is_active, true))
      and public.user_has_permission(p_actor, 'roles.manage', 'club', p_owner_club)
    else false
  end
$$ language sql stable set search_path = pg_catalog, public;

create function public.permission_roles_guard() returns trigger as $$
declare
  actor uuid;
begin
  if tg_op = 'INSERT' then
    actor := public.permission_context_actor();
    if new.created_by_user_id is distinct from actor
       or not public.permission_role_actor_may(actor, new.owner_scope, new.owner_club_id) then
      raise exception 'permission role: the acting user may not write this role' using errcode = '42501';
    end if;
    if new.is_basic or new.basic_key is not null or new.revision <> 1 or new.archived_at is not null then
      raise exception 'permission role: this change is not allowed' using errcode = '23514';
    end if;
    if new.assignable_private and new.basic_key is distinct from 'independent_coach' then
      raise exception 'permission role: this change is not allowed' using errcode = '23514';
    end if;
    return new;
  end if;
  -- UPDATE
  if public.permission_actor_absent() then
    -- A later migration (M15): only a system role; the deferred guard requires
    -- its 'migration' change row, which requires the runner's schema_migrations row.
    if old.owner_scope <> 'system' then
      raise exception 'permission role: the acting user may not write this role' using errcode = '42501';
    end if;
  else
    actor := public.permission_context_actor();
    if (new.archived_by_user_id is not null and new.archived_by_user_id is distinct from old.archived_by_user_id
        and new.archived_by_user_id is distinct from actor)
       or not public.permission_role_actor_may(actor, old.owner_scope, old.owner_club_id) then
      raise exception 'permission role: the acting user may not write this role' using errcode = '42501';
    end if;
  end if;
  if new.id is distinct from old.id or new.owner_scope is distinct from old.owner_scope
     or new.owner_club_id is distinct from old.owner_club_id or new.is_basic is distinct from old.is_basic
     or new.basic_key is distinct from old.basic_key or new.copied_from_role_id is distinct from old.copied_from_role_id
     or new.copied_from_revision is distinct from old.copied_from_revision
     or new.created_by_user_id is distinct from old.created_by_user_id or new.created_at is distinct from old.created_at
     or new.revision is distinct from old.revision + 1
     or old.basic_key = 'platform_admin'
     or old.archived_at is not null
     or (new.assignable_private and not old.assignable_private and new.basic_key is distinct from 'independent_coach') then
    raise exception 'permission role: this change is not allowed' using errcode = '23514';
  end if;
  if ((old.assignable_club and not new.assignable_club) or (old.assignable_team and not new.assignable_team)
      or (old.assignable_private and not new.assignable_private) or (old.assignable_global and not new.assignable_global))
     and exists (select 1 from public.user_role_assignments a where a.role_id = old.id) then
    raise exception 'permission role: a scope type cannot be removed once the role was assigned' using errcode = '23514';
  end if;
  if new.archived_at is not null and exists (
       select 1 from public.user_role_assignments a
        where a.role_id = old.id and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())) then
    raise exception 'permission role: a role that is assigned cannot be archived' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger permission_roles_guard before insert or update on public.permission_roles
  for each row execute function public.permission_roles_guard();

create function public.permission_roles_refuse_delete() returns trigger as $$
begin
  raise exception 'permission role: roles are archived, never deleted' using errcode = '23514';
end;
$$ language plpgsql set search_path = pg_catalog, public;
create trigger permission_roles_no_delete before delete on public.permission_roles
  for each row execute function public.permission_roles_refuse_delete();
create trigger permission_roles_no_truncate before truncate on public.permission_roles
  for each statement execute function public.permission_roles_refuse_delete();

-- At COMMIT: a change record for every revision this transaction wrote, and
-- (as built, deferred rather than BEFORE) every item covers the role's scope
-- types - so one change may remove an uncovered item and widen the role.
create function public.permission_roles_complete() returns trigger as $$
declare
  r record;
begin
  if not exists (select 1 from public.permission_role_changes c
                  where c.role_id = new.id and c.revision_after = new.revision
                    and c.xmin::text::bigint = public.permission_current_xmin()) then
    raise exception 'permission role: the change has no change record' using errcode = '23514';
  end if;
  select * into r from public.permission_roles where id = new.id;
  if exists (
       select 1 from public.permission_role_items i
        where i.role_id = r.id
          and ((r.assignable_club and not exists (select 1 from public.permission_scope_types s where s.permission_word = i.permission_word and s.scope_type = 'club'))
            or (r.assignable_team and not exists (select 1 from public.permission_scope_types s where s.permission_word = i.permission_word and s.scope_type = 'team'))
            or (r.assignable_private and not exists (select 1 from public.permission_scope_types s where s.permission_word = i.permission_word and s.scope_type = 'private'))
            or (r.assignable_global and not exists (select 1 from public.permission_scope_types s where s.permission_word = i.permission_word and s.scope_type = 'global')))) then
    raise exception 'permission role: an item does not cover the role''s scope types' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create constraint trigger permission_roles_complete after insert or update on public.permission_roles
  deferrable initially deferred for each row execute function public.permission_roles_complete();

-- ===========================================================================
-- 10. Guards: items and display (contract 2.4, 2.5)
-- ===========================================================================
-- Shared: the role row was written by this transaction; the acting user (or a
-- migration's change row) may write it; not the Platform admin role; not
-- archived. Returns the role row; sets `actor` (null in a migration).
create function public.permission_role_child_check(p_role_id uuid, p_what text, out r public.permission_roles, out actor uuid) as $$
begin
  select * into r from public.permission_roles where id = p_role_id;
  if not found or r.xmin::text::bigint <> public.permission_current_xmin() then
    raise exception '%', p_what || ': the acting user may not write this role' using errcode = '42501';
  end if;
  if public.permission_actor_absent() then
    if r.owner_scope <> 'system' or not exists (
         select 1 from public.permission_role_changes c
          where c.role_id = r.id and c.revision_after = r.revision and c.kind = 'migration'
            and c.xmin::text::bigint = public.permission_current_xmin()) then
      raise exception '%', p_what || ': the acting user may not write this role' using errcode = '42501';
    end if;
    actor := null;
  else
    actor := public.permission_context_actor();
    if not public.permission_role_actor_may(actor, r.owner_scope, r.owner_club_id) then
      raise exception '%', p_what || ': the acting user may not write this role' using errcode = '42501';
    end if;
  end if;
  if r.basic_key = 'platform_admin' or r.archived_at is not null then
    raise exception '%', p_what || ': this role''s items cannot change' using errcode = '23514';
  end if;
end;
$$ language plpgsql set search_path = pg_catalog, public;

-- Does the actor hold the word / every item for the role's owner? A system
-- role: an active platform admin only.
create function public.permission_actor_holds(p_actor uuid, r public.permission_roles, p_word text) returns boolean as $$
  select case when r.owner_scope = 'system'
    then exists (select 1 from public.users u join public.user_global_roles g on g.user_id = u.id
                  where u.id = p_actor and u.is_active and g.role = 'platform_admin' and g.is_active)
    else (case when p_word is null
            then public.user_holds_role_items(p_actor, r.id, 'club', r.owner_club_id)
            else public.user_has_permission(p_actor, p_word, 'club', r.owner_club_id) end)
  end
$$ language sql stable set search_path = pg_catalog, public;

create function public.permission_role_items_guard() returns trigger as $$
declare
  c record;
  w record;
  rec record := case when tg_op = 'DELETE' then old else new end;
begin
  c := public.permission_role_child_check(rec.role_id, 'permission role item');
  if tg_op = 'INSERT' then
    select * into w from public.permissions where word = new.permission_word;
    if w.platform_only then
      raise exception 'permission role item: a platform-only permission belongs to no role' using errcode = '23514';
    end if;
    if w.system_role_only and (c.r).basic_key is distinct from 'club_admin' then
      raise exception 'permission role item: this permission exists only in the Club admin role' using errcode = '23514';
    end if;
    if not public.permission_word_honoured(new.permission_word) then
      raise exception 'permission role item: no route checks this permission yet' using errcode = '23514';
    end if;
    if ((c.r).assignable_club and not exists (select 1 from public.permission_scope_types s where s.permission_word = new.permission_word and s.scope_type = 'club'))
       or ((c.r).assignable_team and not exists (select 1 from public.permission_scope_types s where s.permission_word = new.permission_word and s.scope_type = 'team'))
       or ((c.r).assignable_private and not exists (select 1 from public.permission_scope_types s where s.permission_word = new.permission_word and s.scope_type = 'private'))
       or ((c.r).assignable_global and not exists (select 1 from public.permission_scope_types s where s.permission_word = new.permission_word and s.scope_type = 'global')) then
      raise exception 'permission role item: the permission does not cover the role''s scope types' using errcode = '23514';
    end if;
    if c.actor is not null then
      if new.added_by_user_id is distinct from c.actor then
        raise exception 'permission role item: the acting user may not write this role' using errcode = '42501';
      end if;
      if not public.permission_actor_holds(c.actor, c.r, new.permission_word) then
        raise exception 'permission role item: the acting user does not hold this permission' using errcode = '42501';
      end if;
    elsif new.added_by_user_id is not null then
      raise exception 'permission role item: the acting user may not write this role' using errcode = '42501';
    end if;
  end if;
  if c.actor is not null and not public.permission_actor_holds(c.actor, c.r, null) then
    raise exception 'permission role item: the acting user does not hold every permission of this role' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger permission_role_items_guard before insert or delete on public.permission_role_items
  for each row execute function public.permission_role_items_guard();

create function public.permission_role_items_refuse() returns trigger as $$
begin
  raise exception 'permission role item: this role''s items cannot change' using errcode = '23514';
end;
$$ language plpgsql set search_path = pg_catalog, public;
create trigger permission_role_items_no_update before update on public.permission_role_items
  for each row execute function public.permission_role_items_refuse();
create trigger permission_role_items_no_truncate before truncate on public.permission_role_items
  for each statement execute function public.permission_role_items_refuse();

-- Rule 7 (contract 2.4), at COMMIT, fired by an item write and by a role update.
create function public.permission_rule7_check() returns trigger as $$
begin
  if not exists (select 1 from public.permission_role_items where role_id = '00000000-0000-4000-8000-000000000842' and permission_word = 'staff.assign')
     or not exists (select 1 from public.permission_role_items where role_id = '00000000-0000-4000-8000-000000000842' and permission_word = 'roles.manage') then
    raise exception 'permission role item: the Club admin role must hold this permission' using errcode = '23514';
  end if;
  if exists (
       select 1
         from public.permission_role_items i
         join public.permission_roles r on r.id = i.role_id
        where r.owner_scope = 'system' and r.archived_at is null
          and r.basic_key is distinct from 'platform_admin'
          and r.id <> '00000000-0000-4000-8000-000000000842'
          and exists (select 1 from public.permission_scope_types s where s.permission_word = i.permission_word and s.scope_type = 'club')
          and not exists (select 1 from public.permission_role_items ci
                           where ci.role_id = '00000000-0000-4000-8000-000000000842' and ci.permission_word = i.permission_word)) then
    raise exception 'permission role item: a system role holds a permission the Club admin role lacks' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create constraint trigger permission_role_items_rule7 after insert or delete on public.permission_role_items
  deferrable initially deferred for each row execute function public.permission_rule7_check();
create constraint trigger permission_roles_rule7 after update on public.permission_roles
  deferrable initially deferred for each row execute function public.permission_rule7_check();

create function public.permission_role_module_display_guard() returns trigger as $$
declare
  c record;
  rec record := case when tg_op = 'DELETE' then old else new end;
begin
  c := public.permission_role_child_check(rec.role_id, 'permission role item');
  if tg_op = 'UPDATE' and (new.role_id is distinct from old.role_id or new.module_word is distinct from old.module_word) then
    raise exception 'permission role item: this role''s items cannot change' using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger permission_role_module_display_guard before insert or update or delete on public.permission_role_module_display
  for each row execute function public.permission_role_module_display_guard();
create trigger permission_role_module_display_no_truncate before truncate on public.permission_role_module_display
  for each statement execute function public.permission_role_items_refuse();

-- ===========================================================================
-- 11. Guards: the change record (contract 2.6)
-- ===========================================================================
create function public.permission_role_changes_guard() returns trigger as $$
declare
  r public.permission_roles;
  actor uuid;
  derived text;
begin
  select * into r from public.permission_roles where id = new.role_id;
  if new.kind = 'migration' then
    if not public.permission_actor_absent() or r.owner_scope is distinct from 'system' then
      raise exception 'permission role change: the record must follow its own change in the same transaction' using errcode = '23514';
    end if;
  else
    actor := public.permission_context_actor();
    if new.performed_by_user_id is distinct from actor then
      raise exception 'permission role: the acting user may not write this role' using errcode = '42501';
    end if;
    derived := public.permission_actor_basis(actor, 'roles.manage', case when r.owner_scope = 'club' then 'club' else 'global' end,
                                             coalesce(r.owner_club_id, '00000000-0000-0000-0000-000000000000'::uuid));
    if derived is null or derived is distinct from new.basis or (r.owner_scope = 'system' and derived <> 'platform_admin') then
      raise exception 'permission role: the acting user may not write this role' using errcode = '42501';
    end if;
  end if;
  if r.id is null or r.xmin::text::bigint <> public.permission_current_xmin() or r.revision <> new.revision_after then
    raise exception 'permission role change: the record must follow its own change in the same transaction' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger permission_role_changes_guard before insert on public.permission_role_changes
  for each row execute function public.permission_role_changes_guard();

create function public.permission_append_only() returns trigger as $$
begin
  if tg_table_name = 'permission_requests' then
    raise exception 'permission request: the record is append-only' using errcode = '23514';
  end if;
  raise exception 'permission role change: the record is append-only' using errcode = '23514';
end;
$$ language plpgsql set search_path = pg_catalog, public;
create trigger permission_role_changes_append_only before update or delete on public.permission_role_changes
  for each row execute function public.permission_append_only();
create trigger permission_role_changes_no_truncate before truncate on public.permission_role_changes
  for each statement execute function public.permission_append_only();

-- At COMMIT: the items this transaction left agree with the record; a
-- 'migration' record has the runner's schema_migrations row of its name,
-- written by this transaction.
create function public.permission_role_changes_complete() returns trigger as $$
declare
  added text[];
begin
  select coalesce(array_agg(i.permission_word), '{}') into added
    from public.permission_role_items i
   where i.role_id = new.role_id and i.xmin::text::bigint = public.permission_current_xmin();
  if not (new.items_added <@ added and added <@ new.items_added)
     or exists (select 1 from public.permission_role_items i where i.role_id = new.role_id and i.permission_word = any(new.items_removed)) then
    raise exception 'permission role change: the record must follow its own change in the same transaction' using errcode = '23514';
  end if;
  if new.kind = 'migration' and not exists (
       select 1 from public.schema_migrations m
        where m.migration_name = new.migration_name and m.xmin::text::bigint = public.permission_current_xmin()) then
    raise exception 'permission role change: the record must follow its own change in the same transaction' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create constraint trigger permission_role_changes_complete after insert on public.permission_role_changes
  deferrable initially deferred for each row execute function public.permission_role_changes_complete();

-- ===========================================================================
-- 12. Guards: assignments (contract 2.7)
-- ===========================================================================
create function public.user_role_assignments_guard() returns trigger as $$
declare
  actor uuid := public.permission_context_actor();
  r public.permission_roles;
  scope_club uuid;
  derived text;
begin
  if tg_op = 'INSERT' then
    if new.granted_by_user_id is distinct from actor then
      raise exception 'role assignment: the row names another user than the acting user' using errcode = '42501';
    end if;
    derived := case when new.scope_type in ('club', 'team')
                    then public.permission_actor_basis(actor, 'staff.assign', new.scope_type, new.scope_id)
                    when exists (select 1 from public.users u join public.user_global_roles g on g.user_id = u.id
                                  where u.id = actor and u.is_active and g.role = 'platform_admin' and g.is_active)
                    then 'platform_admin' end;
    if derived is null or derived is distinct from new.grant_basis then
      raise exception 'role assignment: the acting user may not assign roles here' using errcode = '42501';
    end if;
    if derived <> 'platform_admin' and not public.user_holds_role_items(actor, new.role_id, new.scope_type, new.scope_id) then
      raise exception 'role assignment: the acting user does not hold every permission of this role' using errcode = '42501';
    end if;
    select * into r from public.permission_roles where id = new.role_id;
    if r.basic_key is not null or new.scope_type in ('global', 'private') then
      raise exception 'role assignment: this role is not assigned here' using errcode = '23514';
    end if;
    if new.scope_type = 'team' then
      select t.club_id into scope_club from public.teams t where t.id = new.scope_id;
    else
      scope_club := new.scope_id;
    end if;
    if r.archived_at is not null
       or (new.scope_type = 'club' and not r.assignable_club)
       or (new.scope_type = 'team' and not r.assignable_team)
       or (r.owner_scope = 'club' and scope_club is distinct from r.owner_club_id) then
      raise exception 'role assignment: the role cannot be assigned for this scope' using errcode = '23514';
    end if;
    if not exists (select 1 from public.users u where u.id = new.user_id and u.is_active)
       or not exists (select 1 from public.clubs c where c.id = scope_club and coalesce(c.is_active, true))
       or (new.scope_type = 'team' and not exists (select 1 from public.teams t where t.id = new.scope_id and coalesce(t.is_active, true))) then
      raise exception 'role assignment: the user or the scope takes no assignment' using errcode = '23514';
    end if;
    if new.user_id = new.granted_by_user_id then
      raise exception 'role assignment: nobody assigns a role to themselves' using errcode = '23514';
    end if;
    if new.revoked_at is not null then
      raise exception 'role assignment: only a revocation may change the row' using errcode = '23514';
    end if;
    return new;
  end if;
  -- UPDATE: only the revocation stamp, once.
  if old.revoked_at is not null or new.revoked_at is null
     or new.id is distinct from old.id or new.user_id is distinct from old.user_id or new.role_id is distinct from old.role_id
     or new.scope_type is distinct from old.scope_type or new.scope_id is distinct from old.scope_id
     or new.display_title is distinct from old.display_title or new.granted_by_user_id is distinct from old.granted_by_user_id
     or new.grant_basis is distinct from old.grant_basis or new.grant_reason is distinct from old.grant_reason
     or new.expires_at is distinct from old.expires_at or new.created_at is distinct from old.created_at
     or (new.revoke_kind = 'expired' and (old.expires_at is null or old.expires_at > now())) then
    raise exception 'role assignment: only a revocation may change the row' using errcode = '23514';
  end if;
  if new.revoked_by_user_id is distinct from actor
     or public.permission_actor_basis(actor, 'staff.assign', old.scope_type, old.scope_id) is null then
    raise exception 'role assignment: the acting user may not revoke this assignment' using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger user_role_assignments_guard before insert or update on public.user_role_assignments
  for each row execute function public.user_role_assignments_guard();

create function public.user_role_assignments_refuse_delete() returns trigger as $$
begin
  raise exception 'role assignment: assignments are revoked, never deleted' using errcode = '23514';
end;
$$ language plpgsql set search_path = pg_catalog, public;
create trigger user_role_assignments_no_delete before delete on public.user_role_assignments
  for each row execute function public.user_role_assignments_refuse_delete();
create trigger user_role_assignments_no_truncate before truncate on public.user_role_assignments
  for each statement execute function public.user_role_assignments_refuse_delete();

-- At COMMIT: a request record of this transaction names the assignment; an
-- 'expired' stamp is covered by the record of its replacing row (D4).
create function public.user_role_assignments_complete() returns trigger as $$
declare
  cur public.user_role_assignments;
begin
  select * into cur from public.user_role_assignments where id = new.id;
  if exists (select 1 from public.permission_requests q
              where q.assignment_id = new.id and q.xmin::text::bigint = public.permission_current_xmin()) then
    return null;
  end if;
  if tg_op = 'UPDATE' and cur.revoke_kind = 'expired' and exists (
       select 1 from public.user_role_assignments n
        where n.id <> cur.id and n.user_id = cur.user_id and n.role_id = cur.role_id
          and n.scope_type = cur.scope_type and n.scope_id = cur.scope_id
          and n.granted_by_user_id = cur.revoked_by_user_id
          and n.xmin::text::bigint = public.permission_current_xmin()
          and exists (select 1 from public.permission_requests q
                       where q.assignment_id = n.id and q.operation = 'assignment_grant'
                         and q.xmin::text::bigint = public.permission_current_xmin())) then
    return null;
  end if;
  raise exception 'role assignment: the write has no request record' using errcode = '23514';
end;
$$ language plpgsql set search_path = pg_catalog, public;

create constraint trigger user_role_assignments_complete after insert or update on public.user_role_assignments
  deferrable initially deferred for each row execute function public.user_role_assignments_complete();

-- ===========================================================================
-- 13. Guards: the request record (contract 2.9)
-- ===========================================================================
create function public.permission_requests_guard() returns trigger as $$
declare
  actor uuid := public.permission_context_actor();
  word text := case when new.operation like 'role\_%' then 'roles.manage' else 'staff.assign' end;
  derived text;
  result_xmin bigint;
begin
  if new.requested_by_user_id is distinct from actor then
    raise exception 'permission request: the acting user may not write this request' using errcode = '42501';
  end if;
  derived := case when new.owner_scope = 'system'
                  then (case when exists (select 1 from public.users u join public.user_global_roles g on g.user_id = u.id
                                           where u.id = actor and u.is_active and g.role = 'platform_admin' and g.is_active)
                             then 'platform_admin' end)
                  else public.permission_actor_basis(actor, word, 'club', new.owner_club_id) end;
  if derived is null or derived is distinct from new.basis then
    raise exception 'permission request: the acting user may not write this request' using errcode = '42501';
  end if;
  if new.role_change_id is not null then
    select c.xmin::text::bigint into result_xmin from public.permission_role_changes c where c.id = new.role_change_id;
  else
    select a.xmin::text::bigint into result_xmin from public.user_role_assignments a where a.id = new.assignment_id;
  end if;
  if result_xmin is null or result_xmin <> public.permission_current_xmin() then
    raise exception 'permission request: the request must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger permission_requests_guard before insert on public.permission_requests
  for each row execute function public.permission_requests_guard();
create trigger permission_requests_append_only before update or delete on public.permission_requests
  for each row execute function public.permission_append_only();
create trigger permission_requests_no_truncate before truncate on public.permission_requests
  for each statement execute function public.permission_append_only();

-- ===========================================================================
-- 14. Row-level security and revokes
-- ===========================================================================
alter table public.permission_modules enable row level security;
alter table public.permissions enable row level security;
alter table public.permission_scope_types enable row level security;
alter table public.permission_roles enable row level security;
alter table public.permission_role_items enable row level security;
alter table public.permission_role_module_display enable row level security;
alter table public.permission_role_changes enable row level security;
alter table public.user_role_assignments enable row level security;
alter table public.permission_requests enable row level security;

do $$
declare
  t text;
  f regprocedure;
begin
  foreach t in array array['permission_modules', 'permissions', 'permission_scope_types', 'permission_roles',
                           'permission_role_items', 'permission_role_module_display', 'permission_role_changes',
                           'user_role_assignments', 'permission_requests'] loop
    execute format('revoke all on public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
  end loop;
  for f in
    select p.oid::regprocedure from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('permission_text_ok', 'permission_display_ok', 'permission_context_actor', 'permission_actor_absent',
                         'permission_current_xmin', 'permission_word_honoured', 'user_has_permission', 'user_holds_role_items',
                         'permission_actor_basis', 'lock_permission_actor', 'permission_catalog_fixed', 'permission_catalog_complete',
                         'permission_role_actor_may', 'permission_roles_guard', 'permission_roles_refuse_delete',
                         'permission_roles_complete', 'permission_role_child_check', 'permission_actor_holds',
                         'permission_role_items_guard', 'permission_role_items_refuse', 'permission_rule7_check',
                         'permission_role_module_display_guard', 'permission_role_changes_guard', 'permission_append_only',
                         'permission_role_changes_complete', 'user_role_assignments_guard', 'user_role_assignments_refuse_delete',
                         'user_role_assignments_complete', 'permission_requests_guard')
  loop
    execute format('revoke execute on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke execute on function %s from authenticated', f);
    end if;
  end loop;
end $$;

-- ===========================================================================
-- 15. The two old scoped role tables (contract 2.10) - the last statements
-- ===========================================================================
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.user_club_roles where role is distinct from 'club_admin') then
    raise exception 'v84 refused: public.user_club_roles holds a role word other than club_admin' using errcode = '23514';
  end if;
  if exists (select 1 from public.user_team_roles where role is distinct from 'team_coach') then
    raise exception 'v84 refused: public.user_team_roles holds a role word other than team_coach' using errcode = '23514';
  end if;
end $$;

alter table public.user_club_roles add constraint user_club_roles_role_word check (role = 'club_admin');
alter table public.user_team_roles add constraint user_team_roles_role_word check (role = 'team_coach');
