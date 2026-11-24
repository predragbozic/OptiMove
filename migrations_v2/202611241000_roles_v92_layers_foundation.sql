-- v92: roles R4-1, the foundation of the layers (docs/ai/roles-r4-contract.md, sections 3, 4, 7 and 8).
--
-- What it adds, all in public, in v84's conventions (row-level security without a policy, revokes from PUBLIC /
-- anon / authenticated / service_role, ON DELETE RESTRICT keys with an index, fixed refusal messages: 42501 "may
-- not", 23514 "not allowed", 55000 a lock-order programming error, 22023 an unknown word or mode):
--   1. the club's ceiling (club_permission_ceiling, ..._changes; contract 7.1);
--   2. the club versions of system roles (permission_club_role_versions, ..._items, ..._changes; 7.2);
--   3. the custom roles of one user (permission_custom_roles, ..._items, ..._changes; 7.3);
--   4. the per-club advisory lock (public.lock_club_ceiling) and its check (public.permission_club_lock_held; 7.6);
--   5. the layers in the twin of can(): public.user_has_permission, public.user_holds_role_items,
--      public.lock_permission_actor, the rule-7 check across clubs (3.2, 7.2, 7.5), and one shared definition of a
--      user's effective items per holding (public.permission_user_holdings) that the server's
--      ROLE_PERMISSIONS_SQL reads in the same statement as the closed modules (section 8);
--   6. the VIEW package storable (public.permission_word_honoured, 4 and 4.1);
--   7. the request record widened for the R4-3 operations (7.7);
--   8. on the two old scoped role tables: updated_at moves whenever is_active or revoked_at changes, and a change of
--      updated_at ends the live custom roles made on that row (3.4, 7.3);
--   9. the seed, last: the Club admin and Team coach roles get the view words of 4.1 (M15 path of v84: the role's
--      UPDATE, a 'migration' change row naming this file, then the items).
--
-- Bodies replaced (md5-gated in step 0, v84's): permission_word_honoured, user_has_permission,
-- user_holds_role_items, lock_permission_actor, permission_rule7_check, permission_requests_guard.
-- public.permission_actor_holds is NOT replaced: it delegates to user_holds_role_items and user_has_permission,
-- so it compares against the effective set through them.
--
-- The acting user: v84's optimove.permission_actor ('<user uuid>:<transaction id>'). A later migration writes
-- items of live club versions and custom roles without an acting user (7.4, H2): the row's UPDATE (revision + 1),
-- a 'migration' change row naming its own file, then the items; a deferred guard requires the runner's
-- schema_migrations row of that name written by the same transaction. The custom-role end that the old tables'
-- trigger writes carries no acting user; it is accepted only under the transaction-local marker
-- optimove.custom_role_end_tx = this transaction's id, which only that trigger sets and clears.
--
-- Independent of v93 (calendar): no object of this file names a calendar object, and v93 names none of this file.
-- Requires PostgreSQL 13 or later.

-- ===========================================================================
-- 0. Preconditions: v84 is in force, its bodies are the ones replaced here, the view words have club and team rows
-- ===========================================================================
do $$
declare
  expected text[][] := array[
    ['permission_word_honoured', '73ef8a1da7a45d4f68310fcc35210cd3'],
    ['user_has_permission', '98d788a19e8c0b04c8a20fdf6ba0a191'],
    ['user_holds_role_items', '742f4c03c8b0c1916d9581ee84619096'],
    ['lock_permission_actor', '30a14455bd6eb8b466784bfa3ac41872'],
    ['permission_rule7_check', 'fdaa0829e0cfe7f3ea9ba9ce2aec8bf9'],
    ['permission_requests_guard', 'd362631a890348310fab41bc5675e457'],
    ['permission_actor_holds', '4cf78e6ef38cf5e1006ff1b9c81b59e2']];
  i integer;
  v_word text;
begin
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611201300_roles_v84_permission_roles.sql') then
    raise exception 'v92 refused: v84 is not recorded' using errcode = '23514';
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v92 refused: a function body is not the one v92 expects (%)', expected[i][1] using errcode = '23514';
    end if;
  end loop;
  foreach v_word in array array['athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view',
                                 'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view',
                                 'tests.results.view', 'variables.view'] loop
    if not exists (select 1 from public.permissions where word = v_word and not platform_only and not system_role_only)
       or (select count(*) from public.permission_scope_types where permission_word = v_word and scope_type in ('club', 'team')) <> 2 then
      raise exception 'v92 refused: a view word is not in the catalog as v92 expects (%)', v_word using errcode = '23514';
    end if;
  end loop;
  if (select array_agg(permission_word order by permission_word) from public.permission_role_items where role_id = '00000000-0000-4000-8000-000000000842')
       is distinct from array['athletes.manage', 'athletes.remove', 'org.club.edit', 'org.teams.manage', 'org.view', 'roles.manage', 'staff.assign']
     or (select array_agg(permission_word order by permission_word) from public.permission_role_items where role_id = '00000000-0000-4000-8000-000000000843')
       is distinct from array['athletes.manage', 'athletes.remove', 'org.view'] then
    raise exception 'v92 refused: the basic roles'' items are not v84''s seed' using errcode = '23514';
  end if;
end $$;

-- ===========================================================================
-- 1. The per-club advisory lock (contract 7.6 place 0)
-- ===========================================================================
-- The namespace of the club ceiling lock: distinct from the club-admin headcount lock (891234567), the request-key
-- lock of the Roles API (hashtextextended, one key) and every other two-key namespace of the server.
create function public.permission_club_lock_namespace() returns integer
  language sql immutable set search_path = pg_catalog, public as $$ select 891234593 $$;

-- Does this transaction hold the club's ceiling lock, in at least `p_mode` ('shared' or 'exclusive')? A two-key
-- advisory lock shows in pg_locks as classid = key 1, objid = key 2 (an int4 cast to oid, so a negative hash reads
-- as its unsigned value), objsubid = 2.
create function public.permission_club_lock_held(p_club uuid, p_mode text) returns boolean
  language sql stable set search_path = pg_catalog, public as $$
    select exists (
      select 1 from pg_catalog.pg_locks l
       where l.locktype = 'advisory' and l.pid = pg_catalog.pg_backend_pid() and l.granted
         and l.classid = public.permission_club_lock_namespace()::oid
         and l.objid = pg_catalog.hashtext(p_club::text)::oid
         and l.objsubid = 2
         and (l.mode = 'ExclusiveLock' or (p_mode = 'shared' and l.mode = 'ShareLock')))
  $$;

-- Takes the ceiling lock of each club, in club id order, in one mode. Called by every writer of roles, club
-- versions, custom roles and the ceiling as the FIRST statement after the request-key lock, before any row lock
-- (lock_permission_actor and the table guards only check it). A transaction asks in one mode only: a club already
-- held in the other mode is refused (no upgrade inside one transaction).
create function public.lock_club_ceiling(p_club_ids uuid[], p_mode text) returns void as $$
declare
  c uuid;
  other text := case p_mode when 'shared' then 'ExclusiveLock' when 'exclusive' then 'ShareLock' end;
begin
  if other is null then
    raise exception 'permissions: unknown club lock mode' using errcode = '22023';
  end if;
  for c in select distinct x from unnest(p_club_ids) x where x is not null order by x loop
    if exists (select 1 from pg_catalog.pg_locks l
                where l.locktype = 'advisory' and l.pid = pg_catalog.pg_backend_pid()
                  and l.classid = public.permission_club_lock_namespace()::oid
                  and l.objid = pg_catalog.hashtext(c::text)::oid and l.objsubid = 2 and l.mode = other) then
      raise exception 'permissions: the club lock was already taken in another mode' using errcode = '55000';
    end if;
    if p_mode = 'shared' then
      perform pg_catalog.pg_advisory_xact_lock_shared(public.permission_club_lock_namespace(), pg_catalog.hashtext(c::text));
    else
      perform pg_catalog.pg_advisory_xact_lock(public.permission_club_lock_namespace(), pg_catalog.hashtext(c::text));
    end if;
  end loop;
end;
$$ language plpgsql volatile set search_path = pg_catalog, public;

-- The club of a club or team scope (a team's club; null for a team without one, an unknown team and other types).
create function public.permission_scope_club(p_scope_type text, p_scope_id uuid) returns uuid
  language sql stable set search_path = pg_catalog, public as $$
    select case p_scope_type when 'club' then p_scope_id
                             when 'team' then (select t.club_id from public.teams t where t.id = p_scope_id) end
  $$;

-- Is the acting user an active platform admin?
create function public.permission_is_platform_admin(p_user uuid) returns boolean
  language sql stable set search_path = pg_catalog, public as $$
    select exists (select 1 from public.users u join public.user_global_roles g on g.user_id = u.id
                    where u.id = p_user and u.is_active and g.role = 'platform_admin' and g.is_active)
  $$;

-- ===========================================================================
-- 2. The club's ceiling (contract 7.1)
-- ===========================================================================
create table public.club_permission_ceiling_changes (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete restrict,
  module_word text not null references public.permission_modules (word) on delete restrict,
  action text not null check (action in ('close', 'open')),
  performed_by_user_id uuid not null references public.users (id) on delete restrict,
  reason text not null check (public.permission_text_ok(reason, 500)),
  created_at timestamptz not null default now()
);
create index club_permission_ceiling_changes_club_id_idx on public.club_permission_ceiling_changes (club_id);
create index club_permission_ceiling_changes_module_word_idx on public.club_permission_ceiling_changes (module_word);
create index club_permission_ceiling_changes_performed_by_user_id_idx on public.club_permission_ceiling_changes (performed_by_user_id);

create table public.club_permission_ceiling (
  club_id uuid not null references public.clubs (id) on delete restrict,
  module_word text not null references public.permission_modules (word) on delete restrict,
  closed_by_user_id uuid not null references public.users (id) on delete restrict,
  closed_at timestamptz not null default now(),
  reason text not null check (public.permission_text_ok(reason, 500)),
  primary key (club_id, module_word)
);
create index club_permission_ceiling_module_word_idx on public.club_permission_ceiling (module_word);
create index club_permission_ceiling_closed_by_user_id_idx on public.club_permission_ceiling (closed_by_user_id);

-- The modules closed for a club (none for a null club: a team without a club has no ceiling, Q10).
create function public.permission_club_closed_modules(p_club uuid) returns text[]
  language sql stable set search_path = pg_catalog, public as $$
    select coalesce(array(select m.module_word from public.club_permission_ceiling m where m.club_id = p_club order by 1), '{}')
  $$;

-- ===========================================================================
-- 3. Club versions of system roles (contract 7.2)
-- ===========================================================================
create table public.permission_club_role_versions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete restrict,
  system_role_id uuid not null references public.permission_roles (id) on delete restrict,
  revision integer not null default 1 check (revision >= 1),
  based_on_revision integer not null check (based_on_revision >= 1),
  answered_revision integer not null check (answered_revision >= 1),
  created_by_user_id uuid not null references public.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by_user_id uuid references public.users (id) on delete restrict,
  end_kind text check (end_kind in ('accepted_default', 'reset')),
  constraint permission_club_role_versions_answer_shape check (answered_revision >= based_on_revision),
  constraint permission_club_role_versions_end_shape check ((ended_at is null) = (ended_by_user_id is null) and (ended_at is null) = (end_kind is null))
);
create unique index permission_club_role_versions_live_key on public.permission_club_role_versions (club_id, system_role_id) where ended_at is null;
create index permission_club_role_versions_club_id_idx on public.permission_club_role_versions (club_id);
create index permission_club_role_versions_system_role_id_idx on public.permission_club_role_versions (system_role_id);
create index permission_club_role_versions_created_by_user_id_idx on public.permission_club_role_versions (created_by_user_id);
create index permission_club_role_versions_ended_by_user_id_idx on public.permission_club_role_versions (ended_by_user_id);

create table public.permission_club_role_version_items (
  version_id uuid not null references public.permission_club_role_versions (id) on delete restrict,
  permission_word text not null references public.permissions (word) on delete restrict,
  primary key (version_id, permission_word)
);
create index permission_club_role_version_items_permission_word_idx on public.permission_club_role_version_items (permission_word);

create table public.permission_club_role_version_changes (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.permission_club_role_versions (id) on delete restrict,
  revision_after integer not null check (revision_after >= 1),
  kind text not null check (kind in ('create', 'change', 'answer_keep', 'accept_default', 'reset', 'default_follow', 'migration')),
  performed_by_user_id uuid references public.users (id) on delete restrict,
  basis text check (basis in ('platform_admin', 'club_admin')),
  migration_name text,
  reason text check (reason is null or public.permission_text_ok(reason, 500)),
  items_added text[] not null default '{}',
  items_removed text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint permission_club_role_version_changes_revision_key unique (version_id, revision_after),
  constraint permission_club_role_version_changes_actor_shape check (
    (kind = 'migration') = (performed_by_user_id is null)
    and (kind = 'migration') = (basis is null)
    and (kind = 'migration') = (migration_name is not null)
    and (migration_name is null or char_length(migration_name) between 1 and 200)
    and (kind <> 'default_follow' or basis = 'platform_admin')),
  constraint permission_club_role_version_changes_items_disjoint check (not (items_added && items_removed))
);
create index permission_club_role_version_changes_performed_by_user_id_idx on public.permission_club_role_version_changes (performed_by_user_id);

-- The items of a role in a club (3.2 step 8.2 and 8.3, no custom): a live club version of a system role, else the
-- role's own items. A null club (a private scope, a team without a club): the role's own items.
create function public.permission_role_club_items(p_role_id uuid, p_club uuid) returns text[]
  language sql stable set search_path = pg_catalog, public as $$
    select coalesce(
      (select array(select vi.permission_word from public.permission_club_role_version_items vi where vi.version_id = v.id order by 1)
         from public.permission_club_role_versions v
         join public.permission_roles r on r.id = v.system_role_id and r.owner_scope = 'system'
        where p_club is not null and v.club_id = p_club and v.system_role_id = p_role_id and v.ended_at is null),
      array(select i.permission_word from public.permission_role_items i where i.role_id = p_role_id order by 1))
  $$;

-- ===========================================================================
-- 4. Custom roles of one user (contract 3.4, 7.3)
-- ===========================================================================
create table public.permission_custom_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete restrict,
  base_role_id uuid not null references public.permission_roles (id) on delete restrict,
  scope_type text not null check (scope_type in ('club', 'team')),
  scope_id uuid not null,
  club_id uuid not null references public.clubs (id) on delete restrict,
  holding_assignment_id uuid references public.user_role_assignments (id) on delete restrict,
  holding_row_table text check (holding_row_table in ('user_club_roles', 'user_team_roles')),
  holding_row_id uuid,
  holding_row_version timestamptz,
  frozen_from text not null check (frozen_from in ('default', 'club_version', 'club_role')),
  frozen_from_revision integer not null check (frozen_from_revision >= 1),
  frozen_from_version_id uuid references public.permission_club_role_versions (id) on delete restrict,
  revision integer not null default 1 check (revision >= 1),
  created_by_user_id uuid not null references public.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by_user_id uuid references public.users (id) on delete restrict,
  end_kind text check (end_kind in ('reassigned', 'role_ended', 'reset')),
  constraint permission_custom_roles_holding_shape check (
    (holding_assignment_id is not null and holding_row_table is null and holding_row_id is null and holding_row_version is null)
    or (holding_assignment_id is null and holding_row_table is not null and holding_row_id is not null and holding_row_version is not null)),
  constraint permission_custom_roles_frozen_shape check ((frozen_from = 'club_version') = (frozen_from_version_id is not null)),
  constraint permission_custom_roles_end_shape check (
    (ended_at is null) = (end_kind is null)
    and (ended_at is null or (end_kind = 'role_ended') = (ended_by_user_id is null))
    and (ended_at is not null or ended_by_user_id is null))
);
create unique index permission_custom_roles_live_key on public.permission_custom_roles (user_id, base_role_id, scope_type, scope_id) where ended_at is null;
create index permission_custom_roles_user_id_idx on public.permission_custom_roles (user_id);
create index permission_custom_roles_base_role_id_idx on public.permission_custom_roles (base_role_id);
create index permission_custom_roles_club_id_idx on public.permission_custom_roles (club_id);
create index permission_custom_roles_scope_idx on public.permission_custom_roles (scope_type, scope_id);
create index permission_custom_roles_holding_assignment_id_idx on public.permission_custom_roles (holding_assignment_id);
create index permission_custom_roles_holding_row_idx on public.permission_custom_roles (holding_row_table, holding_row_id) where ended_at is null;
create index permission_custom_roles_frozen_from_version_id_idx on public.permission_custom_roles (frozen_from_version_id);
create index permission_custom_roles_created_by_user_id_idx on public.permission_custom_roles (created_by_user_id);
create index permission_custom_roles_ended_by_user_id_idx on public.permission_custom_roles (ended_by_user_id);

create table public.permission_custom_role_items (
  custom_role_id uuid not null references public.permission_custom_roles (id) on delete restrict,
  permission_word text not null references public.permissions (word) on delete restrict,
  primary key (custom_role_id, permission_word)
);
create index permission_custom_role_items_permission_word_idx on public.permission_custom_role_items (permission_word);

create table public.permission_custom_role_changes (
  id uuid primary key default gen_random_uuid(),
  custom_role_id uuid not null references public.permission_custom_roles (id) on delete restrict,
  revision_after integer not null check (revision_after >= 1),
  kind text not null check (kind in ('create', 'change', 'end', 'role_ended', 'word_removal', 'migration')),
  performed_by_user_id uuid references public.users (id) on delete restrict,
  basis text check (basis in ('platform_admin', 'club_admin')),
  migration_name text,
  reason text check (reason is null or public.permission_text_ok(reason, 500)),
  items_added text[] not null default '{}',
  items_removed text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint permission_custom_role_changes_revision_key unique (custom_role_id, revision_after),
  constraint permission_custom_role_changes_actor_shape check (
    (kind in ('migration', 'role_ended')) = (performed_by_user_id is null)
    and (kind in ('migration', 'role_ended')) = (basis is null)
    and (kind = 'migration') = (migration_name is not null)
    and (migration_name is null or char_length(migration_name) between 1 and 200)),
  constraint permission_custom_role_changes_items_disjoint check (not (items_added && items_removed))
);
create index permission_custom_role_changes_performed_by_user_id_idx on public.permission_custom_role_changes (performed_by_user_id);

-- ===========================================================================
-- 5. The effective items per holding (contract 3.2 steps 7 and 8; one definition for the twin and the server)
-- ===========================================================================
-- Every live holding of the user (the old tables mapped to the basic roles, and the live non-basic assignments of
-- a club, team or the user's own private scope), with the club it lies in and its effective words: a live custom
-- role of that holding (3.4: the same user, base role and scope, the holding still the one it was made on - for an
-- assignment the same live assignment, for an old-table row the same active row with an unchanged updated_at),
-- else a live club version of the system role in that club, else the role's own items. An archived role gives
-- nothing. No ceiling here: the caller applies the closed modules of `club_id` (3.2 step 6).
create function public.permission_user_holdings(p_user uuid)
returns table (scope_type text, scope_id uuid, role_id uuid, assignment_id uuid, expires_at timestamptz, club_id uuid,
               custom_role_id uuid, words text[]) as $$
  with held as (
    select 'club'::text as st, r.club_id as sid, pr.id as rid, null::uuid as aid, null::timestamptz as exp,
           'user_club_roles'::text as rt, r.id as hid, r.updated_at as hv
      from public.user_club_roles r join public.permission_roles pr on pr.basic_key = 'club_admin'
     where r.user_id = p_user and r.role = 'club_admin' and r.is_active = true
    union all
    select 'team', r.team_id, pr.id, null, null, 'user_team_roles', r.id, r.updated_at
      from public.user_team_roles r join public.permission_roles pr on pr.basic_key = 'team_coach'
     where r.user_id = p_user and r.role = 'team_coach' and r.is_active = true
    union all
    select 'private', p_user, pr.id, null, null, null, null, null
      from public.user_global_roles g join public.permission_roles pr on pr.basic_key = 'independent_coach'
     where g.user_id = p_user and g.role = 'independent_coach' and g.is_active = true
    union all
    select a.scope_type, a.scope_id, a.role_id, a.id, a.expires_at, null, null, null
      from public.user_role_assignments a
     where a.user_id = p_user and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())
       and a.scope_type in ('club', 'team', 'private') and (a.scope_type <> 'private' or a.scope_id = p_user)
  ), placed as (
    select h.*, pr.owner_scope,
           case h.st when 'club' then h.sid when 'team' then (select t.club_id from public.teams t where t.id = h.sid) end as cid
      from held h join public.permission_roles pr on pr.id = h.rid and pr.archived_at is null
  )
  select p.st, p.sid, p.rid, p.aid, p.exp, p.cid, cu.id,
         case when cu.id is not null
              then array(select ci.permission_word from public.permission_custom_role_items ci where ci.custom_role_id = cu.id order by 1)
              else public.permission_role_club_items(p.rid, p.cid) end
    from placed p
    left join lateral (
      select c.id from public.permission_custom_roles c
       where c.ended_at is null and c.user_id = p_user and c.base_role_id = p.rid
         and c.scope_type = p.st and c.scope_id = p.sid
         and ((p.aid is not null and c.holding_assignment_id = p.aid)
              or (p.rt is not null and c.holding_row_table = p.rt and c.holding_row_id = p.hid and c.holding_row_version = p.hv))
       limit 1) cu on true
$$ language sql stable set search_path = pg_catalog, public;

-- ===========================================================================
-- 6. The VIEW package is storable (contract 4, 4.1)
-- ===========================================================================
create or replace function public.permission_word_honoured(p_word text) returns boolean
  language sql immutable set search_path = pg_catalog, public as $$
    select p_word in ('org.view', 'org.teams.manage', 'org.club.edit', 'athletes.manage', 'athletes.remove',
                      'staff.assign', 'roles.manage',
                      'athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view',
                      'load.view.team', 'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view',
                      'variables.view')
  $$;

-- ===========================================================================
-- 7. The twin of can() with the layers (contract 3.2, 7.5)
-- ===========================================================================
create or replace function public.user_has_permission(p_user uuid, p_permission text, p_scope_type text, p_scope_id uuid)
returns boolean as $$
declare
  w record;
  club uuid;
begin
  -- 1. An unknown word or scope type is a programming error (M12).
  select word, platform_only, module_word into w from public.permissions where word = p_permission;
  if not found or p_scope_type is null or p_scope_type not in ('global', 'club', 'team', 'private') then
    raise exception 'permission check: unknown permission or scope type' using errcode = '22023';
  end if;
  -- 2. No user, an unknown or an inactive one (M13).
  if p_user is null or not exists (select 1 from public.users where id = p_user and is_active = true) then
    return false;
  end if;
  -- 3. A platform admin holds everything (O1: never limited by a ceiling).
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
  if p_scope_type = 'team' then
    select t.club_id into club from public.teams t where t.id = p_scope_id;
    if not found then
      return false;
    end if;
  elsif p_scope_type = 'club' then
    club := p_scope_id;
  end if;
  -- 6. The ceiling: the word's module closed for the club (a team without a club has none, Q10).
  if club is not null and exists (select 1 from public.club_permission_ceiling m where m.club_id = club and m.module_word = w.module_word) then
    return false;
  end if;
  -- 7 to 9. Any live holding for the scope (a club's holding reaches its teams) whose effective items hold the word.
  return exists (
    select 1 from public.permission_user_holdings(p_user) h
     where p_permission = any (h.words)
       and ((h.scope_type = p_scope_type and h.scope_id = p_scope_id)
            or (p_scope_type = 'team' and h.scope_type = 'club' and h.scope_id = club)));
end;
$$ language plpgsql stable set search_path = pg_catalog, public;

-- Does the user hold every item of the role's effective set in this scope's club (the club version when there is
-- one; 3.2, R2's ceiling and dominance)? A platform admin holds everything; a role without items is held by all.
create or replace function public.user_holds_role_items(p_user uuid, p_role_id uuid, p_scope_type text, p_scope_id uuid)
returns boolean as $$
  select coalesce(bool_and(public.user_has_permission(p_user, w, p_scope_type, p_scope_id)), true)
    from unnest(public.permission_role_club_items(p_role_id, public.permission_scope_club(p_scope_type, p_scope_id))) w
$$ language sql stable set search_path = pg_catalog, public;

-- ===========================================================================
-- 8. The lock function (contract 7.6): v84's order, the club lock checked first, the custom roles (place 3) and the
--    club's live versions (place 4, after the role rows) locked FOR SHARE. A seventh parameter,
--    p_all_system_roles: a club version writer (R4-3) passes true and every non-archived system role row is locked FOR
--    SHARE in id order inside place 4 (7.2, H4), so a default-role writer (its role FOR UPDATE) and a version writer
--    serialize. v84's six-parameter function is dropped and replaced (the rollback restores it).
-- ===========================================================================
drop function public.lock_permission_actor(uuid, text, uuid, uuid, uuid, uuid);
create function public.lock_permission_actor(p_user uuid, p_scope_type text, p_scope_id uuid,
                                             p_role_for_update uuid default null,
                                             p_assignment_for_update uuid default null,
                                             p_role_for_share uuid default null,
                                             p_all_system_roles boolean default false)
returns text as $$
declare
  club uuid;
  rid uuid;
  role_ids uuid[];
begin
  if p_scope_type is null or p_scope_type not in ('global', 'club', 'team', 'private') then
    raise exception 'permission check: unknown permission or scope type' using errcode = '22023';
  end if;
  if p_scope_type = 'team' then
    select t.club_id into club from public.teams t where t.id = p_scope_id;
  elsif p_scope_type = 'club' then
    club := p_scope_id;
  end if;
  -- Place 0: the caller took the club's ceiling lock as its first statement (never taken here: it would come after
  -- a row lock the caller may already hold).
  if club is not null and not public.permission_club_lock_held(club, 'shared') then
    raise exception 'permissions: the club lock must be taken before the first row lock' using errcode = '55000';
  end if;
  -- Place 1: the acting user's row, a statement of its own.
  perform 1 from public.users where id = p_user for share;
  -- Place 2: the old tables' rows of the acting user, then the assignment rows by id.
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
  -- Place 3: the acting user's live custom roles in the scope (and its club's for a team), by id.
  if club is not null then
    perform 1 from public.permission_custom_roles c
     where c.user_id = p_user and c.ended_at is null and c.club_id = club
       and ((c.scope_type = p_scope_type and c.scope_id = p_scope_id) or (p_scope_type = 'team' and c.scope_type = 'club'))
     order by c.id for share;
  end if;
  -- Place 4: the role rows by id, then the club's live versions by id.
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
    union select r.id from public.permission_roles r where p_all_system_roles and r.owner_scope = 'system' and r.archived_at is null
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
  if club is not null then
    perform 1 from public.permission_club_role_versions v where v.club_id = club and v.ended_at is null order by v.id for share;
  end if;
  if public.permission_is_platform_admin(p_user) then
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
-- 9. Rule 7 inside a club (contract 7.2) and across clubs when a default changes (H4)
-- ===========================================================================
-- In club C: the effective Club admin set holds staff.assign and roles.manage, and every club-scope word of the
-- effective set of every other non-archived system role (not Platform admin), minus the closed modules.
create function public.permission_club_rule7_ok(p_club uuid) returns boolean
  language sql stable set search_path = pg_catalog, public as $$
    with ca as (
      select unnest(public.permission_role_club_items((select id from public.permission_roles where basic_key = 'club_admin'), p_club)) as word
    )
    select exists (select 1 from ca where word = 'staff.assign')
       and exists (select 1 from ca where word = 'roles.manage')
       and not exists (
         select 1
           from public.permission_roles r
          cross join lateral unnest(public.permission_role_club_items(r.id, p_club)) w(word)
           join public.permissions p on p.word = w.word
          where r.owner_scope = 'system' and r.archived_at is null
            and r.basic_key is distinct from 'platform_admin' and r.basic_key is distinct from 'club_admin'
            and exists (select 1 from public.permission_scope_types s where s.permission_word = w.word and s.scope_type = 'club')
            and not exists (select 1 from public.club_permission_ceiling m where m.club_id = p_club and m.module_word = p.module_word)
            and not exists (select 1 from ca where ca.word = w.word))
  $$;

-- v84's rule 7 on the default roles, then the same rule in every club with a live version (H4: a default change
-- must not leave a club whose own Club admin version lacks what its following roles now hold).
create or replace function public.permission_rule7_check() returns trigger as $$
declare
  -- Club admin by its basic key (unique, immutable), never by a literal id: a schema-only
  -- dump keeps this body, and the legacy-schema tool refuses a uuid literal in it.
  v_club_admin uuid := (select id from public.permission_roles where basic_key = 'club_admin');
  v_club uuid;
  v_role uuid;
begin
  -- A club's own role never takes part in rule 7 (it reads system roles only): nothing to check.
  if tg_table_name = 'permission_role_items' then
    v_role := case when tg_op = 'DELETE' then old.role_id else new.role_id end;
  else
    v_role := new.id;
  end if;
  if (select r.owner_scope from public.permission_roles r where r.id = v_role) is distinct from 'system' then
    return null;
  end if;
  if not exists (select 1 from public.permission_role_items where role_id = v_club_admin and permission_word = 'staff.assign')
     or not exists (select 1 from public.permission_role_items where role_id = v_club_admin and permission_word = 'roles.manage') then
    raise exception 'permission role item: the Club admin role must hold this permission' using errcode = '23514';
  end if;
  if exists (
       select 1
         from public.permission_role_items i
         join public.permission_roles r on r.id = i.role_id
        where r.owner_scope = 'system' and r.archived_at is null
          and r.basic_key is distinct from 'platform_admin'
          and r.id <> v_club_admin
          and exists (select 1 from public.permission_scope_types s where s.permission_word = i.permission_word and s.scope_type = 'club')
          and not exists (select 1 from public.permission_role_items ci
                           where ci.role_id = v_club_admin and ci.permission_word = i.permission_word)) then
    raise exception 'permission role item: a system role holds a permission the Club admin role lacks' using errcode = '23514';
  end if;
  -- Every club with a live version, on every firing (no "already checked" cache: in immediate mode two writes of one
  -- client message share a statement timestamp, so a cache could skip the second). A system role changes rarely.
  for v_club in select distinct v.club_id from public.permission_club_role_versions v where v.ended_at is null loop
    if not public.permission_club_rule7_ok(v_club) then
      raise exception 'permission role item: a club''s Club admin would lack a permission another role holds there' using errcode = '23514';
    end if;
  end loop;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

-- At COMMIT, fired by a club version, its items or the ceiling: rule 7 in that club.
create function public.permission_club_rule7_check() returns trigger as $$
declare
  v_club uuid;
begin
  if tg_table_name = 'permission_club_role_versions' or tg_table_name = 'club_permission_ceiling' then
    v_club := case when tg_op = 'DELETE' then old.club_id else new.club_id end;
  else
    select v.club_id into v_club from public.permission_club_role_versions v
     where v.id = case when tg_op = 'DELETE' then old.version_id else new.version_id end;
  end if;
  if v_club is not null and not public.permission_club_rule7_ok(v_club) then
    raise exception 'permission club version: the club''s Club admin would lack a permission another role holds there' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

-- ===========================================================================
-- 10. Guards: the ceiling (contract 7.1)
-- ===========================================================================
create function public.club_permission_ceiling_guard() returns trigger as $$
declare
  actor uuid := public.permission_context_actor();
  rec record := case when tg_op = 'DELETE' then old else new end;
begin
  if not public.permission_is_platform_admin(actor) then
    raise exception 'club ceiling: the acting user may not change the ceiling' using errcode = '42501';
  end if;
  if not public.permission_club_lock_held(rec.club_id, 'exclusive') then
    raise exception 'permissions: the club lock must be taken before the first row lock' using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.module_word = 'organization' then
      raise exception 'club ceiling: this module cannot be closed' using errcode = '23514';
    end if;
    if new.closed_by_user_id is distinct from actor
       or not exists (select 1 from public.clubs c where c.id = new.club_id and coalesce(c.is_active, true)) then
      raise exception 'club ceiling: this change is not allowed' using errcode = '23514';
    end if;
    return new;
  end if;
  return old;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger club_permission_ceiling_guard before insert or delete on public.club_permission_ceiling
  for each row execute function public.club_permission_ceiling_guard();

create function public.permission_r4_refuse() returns trigger as $$
begin
  if tg_table_name like '%changes' then
    raise exception 'permission record: the record is append-only' using errcode = '23514';
  end if;
  raise exception 'permission layer: this change is not allowed' using errcode = '23514';
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger club_permission_ceiling_no_update before update on public.club_permission_ceiling
  for each row execute function public.permission_r4_refuse();
create trigger club_permission_ceiling_no_truncate before truncate on public.club_permission_ceiling
  for each statement execute function public.permission_r4_refuse();

-- A change row names the acting user and follows its own INSERT ('close') or DELETE ('open') in the same
-- transaction; at COMMIT (below) the ceiling agrees with it.
create function public.club_permission_ceiling_changes_guard() returns trigger as $$
declare
  actor uuid := public.permission_context_actor();
begin
  if new.performed_by_user_id is distinct from actor or not public.permission_is_platform_admin(actor) then
    raise exception 'club ceiling: the acting user may not change the ceiling' using errcode = '42501';
  end if;
  if not public.permission_club_lock_held(new.club_id, 'exclusive') then
    raise exception 'permissions: the club lock must be taken before the first row lock' using errcode = '55000';
  end if;
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger club_permission_ceiling_changes_guard before insert on public.club_permission_ceiling_changes
  for each row execute function public.club_permission_ceiling_changes_guard();
create trigger club_permission_ceiling_changes_append_only before update or delete on public.club_permission_ceiling_changes
  for each row execute function public.permission_r4_refuse();
create trigger club_permission_ceiling_changes_no_truncate before truncate on public.club_permission_ceiling_changes
  for each statement execute function public.permission_r4_refuse();

-- At COMMIT: every ceiling row written or removed by this transaction has its change row of this transaction, and
-- the record agrees with the final state.
create function public.club_permission_ceiling_complete() returns trigger as $$
declare
  rec record := case when tg_op = 'DELETE' then old else new end;
  want text := case when tg_op = 'DELETE' then 'open' else 'close' end;
  is_closed boolean;
begin
  if not exists (select 1 from public.club_permission_ceiling_changes c
                  where c.club_id = rec.club_id and c.module_word = rec.module_word and c.action = want
                    and c.xmin::text::bigint = public.permission_current_xmin()) then
    raise exception 'club ceiling: the change has no change record' using errcode = '23514';
  end if;
  is_closed := exists (select 1 from public.club_permission_ceiling m where m.club_id = rec.club_id and m.module_word = rec.module_word);
  if is_closed is distinct from (want = 'close') then
    raise exception 'club ceiling: the change has no change record' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create constraint trigger club_permission_ceiling_complete after insert or delete on public.club_permission_ceiling
  deferrable initially deferred for each row execute function public.club_permission_ceiling_complete();
create constraint trigger club_permission_ceiling_rule7 after insert or delete on public.club_permission_ceiling
  deferrable initially deferred for each row execute function public.permission_club_rule7_check();

-- ===========================================================================
-- 11. Guards: club versions (contract 7.2)
-- ===========================================================================
-- May the acting user write the club version of this system role in this club? A platform admin (club active); a
-- holder of roles.manage in the active club, never for Club admin (3.3, Q3).
create function public.permission_version_actor_may(p_actor uuid, p_club uuid, p_role_id uuid) returns boolean
  language sql stable set search_path = pg_catalog, public as $$
    select exists (select 1 from public.clubs c where c.id = p_club and coalesce(c.is_active, true))
       and (public.permission_is_platform_admin(p_actor)
            or ((select r.basic_key from public.permission_roles r where r.id = p_role_id) is distinct from 'club_admin'
                and public.user_has_permission(p_actor, 'roles.manage', 'club', p_club)))
  $$;

-- A system role a club version may exist for: not archived, not Platform admin, not Independent coach (no club).
create function public.permission_versionable_role(p_role_id uuid) returns boolean
  language sql stable set search_path = pg_catalog, public as $$
    select exists (select 1 from public.permission_roles r
                    where r.id = p_role_id and r.owner_scope = 'system' and r.archived_at is null
                      and r.basic_key is distinct from 'platform_admin' and r.basic_key is distinct from 'independent_coach'
                      and (r.assignable_club or r.assignable_team))
  $$;

create function public.permission_club_role_versions_guard() returns trigger as $$
declare
  actor uuid;
  role_revision integer;
begin
  if tg_op = 'INSERT' then
    actor := public.permission_context_actor();
    if new.created_by_user_id is distinct from actor or not public.permission_version_actor_may(actor, new.club_id, new.system_role_id) then
      raise exception 'permission club version: the acting user may not write this version' using errcode = '42501';
    end if;
    if not public.permission_club_lock_held(new.club_id, 'exclusive') then
      raise exception 'permissions: the club lock must be taken before the first row lock' using errcode = '55000';
    end if;
    select r.revision into role_revision from public.permission_roles r where r.id = new.system_role_id;
    if not public.permission_versionable_role(new.system_role_id) or new.revision <> 1 or new.ended_at is not null
       or new.based_on_revision <> role_revision or new.answered_revision <> role_revision then
      raise exception 'permission club version: this change is not allowed' using errcode = '23514';
    end if;
    return new;
  end if;
  -- UPDATE: a new revision of a live version, once ended never again.
  if not public.permission_club_lock_held(old.club_id, 'exclusive') then
    raise exception 'permissions: the club lock must be taken before the first row lock' using errcode = '55000';
  end if;
  if public.permission_actor_absent() then
    -- A later migration (7.4, H2): its 'migration' change row is required at COMMIT; it never ends a version.
    if new.ended_at is not null then
      raise exception 'permission club version: the acting user may not write this version' using errcode = '42501';
    end if;
  else
    actor := public.permission_context_actor();
    if not public.permission_version_actor_may(actor, old.club_id, old.system_role_id)
       or (new.ended_at is not null and new.ended_by_user_id is distinct from actor) then
      raise exception 'permission club version: the acting user may not write this version' using errcode = '42501';
    end if;
  end if;
  select r.revision into role_revision from public.permission_roles r where r.id = old.system_role_id;
  if new.id is distinct from old.id or new.club_id is distinct from old.club_id or new.system_role_id is distinct from old.system_role_id
     or new.created_by_user_id is distinct from old.created_by_user_id or new.created_at is distinct from old.created_at
     or old.ended_at is not null or new.revision is distinct from old.revision + 1
     or new.based_on_revision < old.based_on_revision or new.answered_revision < old.answered_revision
     or new.answered_revision > role_revision then
    raise exception 'permission club version: this change is not allowed' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger permission_club_role_versions_guard before insert or update on public.permission_club_role_versions
  for each row execute function public.permission_club_role_versions_guard();
create trigger permission_club_role_versions_no_delete before delete on public.permission_club_role_versions
  for each row execute function public.permission_r4_refuse();
create trigger permission_club_role_versions_no_truncate before truncate on public.permission_club_role_versions
  for each statement execute function public.permission_r4_refuse();

-- The items of a club version: the version row was written by this transaction; the acting user may write it (or a
-- migration's change row of this transaction names it); the word is storable, not platform-only, system-role-only
-- only in a version of Club admin, covers the role's scope types; the acting user (not a platform admin) holds it
-- in the club. The club's exclusive lock is held.
create function public.permission_club_role_version_items_guard() returns trigger as $$
declare
  v public.permission_club_role_versions;
  r public.permission_roles;
  w public.permissions;
  actor uuid;
  rec record := case when tg_op = 'DELETE' then old else new end;
begin
  select * into v from public.permission_club_role_versions where id = rec.version_id;
  if not found or v.xmin::text::bigint <> public.permission_current_xmin() or v.ended_at is not null then
    raise exception 'permission club version item: the acting user may not write this version' using errcode = '42501';
  end if;
  if not public.permission_club_lock_held(v.club_id, 'exclusive') then
    raise exception 'permissions: the club lock must be taken before the first row lock' using errcode = '55000';
  end if;
  if public.permission_actor_absent() then
    if not exists (select 1 from public.permission_club_role_version_changes c
                    where c.version_id = v.id and c.revision_after = v.revision and c.kind = 'migration'
                      and c.xmin::text::bigint = public.permission_current_xmin()) then
      raise exception 'permission club version item: the acting user may not write this version' using errcode = '42501';
    end if;
    actor := null;
  else
    actor := public.permission_context_actor();
    if not public.permission_version_actor_may(actor, v.club_id, v.system_role_id) then
      raise exception 'permission club version item: the acting user may not write this version' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' then
    select * into r from public.permission_roles where id = v.system_role_id;
    select * into w from public.permissions where word = new.permission_word;
    if w.platform_only then
      raise exception 'permission club version item: a platform-only permission belongs to no role' using errcode = '23514';
    end if;
    if w.system_role_only and r.basic_key is distinct from 'club_admin' then
      raise exception 'permission club version item: this permission exists only in the Club admin role' using errcode = '23514';
    end if;
    if not public.permission_word_honoured(new.permission_word) then
      raise exception 'permission club version item: no route checks this permission yet' using errcode = '23514';
    end if;
    if (r.assignable_club and not exists (select 1 from public.permission_scope_types s where s.permission_word = new.permission_word and s.scope_type = 'club'))
       or (r.assignable_team and not exists (select 1 from public.permission_scope_types s where s.permission_word = new.permission_word and s.scope_type = 'team')) then
      raise exception 'permission club version item: the permission does not cover the role''s scope types' using errcode = '23514';
    end if;
    if actor is not null and not public.permission_is_platform_admin(actor)
       and not public.user_has_permission(actor, new.permission_word, 'club', v.club_id) then
      raise exception 'permission club version item: the acting user does not hold this permission' using errcode = '42501';
    end if;
  end if;
  return rec;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger permission_club_role_version_items_guard before insert or delete on public.permission_club_role_version_items
  for each row execute function public.permission_club_role_version_items_guard();
create trigger permission_club_role_version_items_no_update before update on public.permission_club_role_version_items
  for each row execute function public.permission_r4_refuse();
create trigger permission_club_role_version_items_no_truncate before truncate on public.permission_club_role_version_items
  for each statement execute function public.permission_r4_refuse();

-- At COMMIT, per version written by this transaction: its change row of this revision; a version of Club admin
-- holds staff.assign and roles.manage (H1); a club admin holds every item of the version (dominance).
create function public.permission_club_role_versions_complete() returns trigger as $$
declare
  v public.permission_club_role_versions;
  actor uuid;
begin
  select * into v from public.permission_club_role_versions where id = new.id;
  if not exists (select 1 from public.permission_club_role_version_changes c
                  where c.version_id = v.id and c.revision_after = v.revision
                    and c.xmin::text::bigint = public.permission_current_xmin()) then
    raise exception 'permission club version: the change has no change record' using errcode = '23514';
  end if;
  if v.ended_at is null and (select basic_key from public.permission_roles where id = v.system_role_id) = 'club_admin'
     and (not exists (select 1 from public.permission_club_role_version_items i where i.version_id = v.id and i.permission_word = 'staff.assign')
          or not exists (select 1 from public.permission_club_role_version_items i where i.version_id = v.id and i.permission_word = 'roles.manage')) then
    raise exception 'permission club version: the Club admin role must hold this permission' using errcode = '23514';
  end if;
  if not public.permission_actor_absent() then
    actor := public.permission_context_actor();
    if not public.permission_is_platform_admin(actor) and exists (
         select 1 from public.permission_club_role_version_items i
          where i.version_id = v.id and not public.user_has_permission(actor, i.permission_word, 'club', v.club_id)) then
      raise exception 'permission club version: the acting user does not hold every permission of this version' using errcode = '42501';
    end if;
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create constraint trigger permission_club_role_versions_complete after insert or update on public.permission_club_role_versions
  deferrable initially deferred for each row execute function public.permission_club_role_versions_complete();
create constraint trigger permission_club_role_versions_rule7 after insert or update on public.permission_club_role_versions
  deferrable initially deferred for each row execute function public.permission_club_rule7_check();
create constraint trigger permission_club_role_version_items_rule7 after insert or delete on public.permission_club_role_version_items
  deferrable initially deferred for each row execute function public.permission_club_rule7_check();

create function public.permission_club_role_version_changes_guard() returns trigger as $$
declare
  v public.permission_club_role_versions;
  actor uuid;
  derived text;
begin
  select * into v from public.permission_club_role_versions where id = new.version_id;
  if new.kind = 'migration' then
    if not public.permission_actor_absent() then
      raise exception 'permission club version change: the record must follow its own change in the same transaction' using errcode = '23514';
    end if;
  else
    actor := public.permission_context_actor();
    derived := case when public.permission_is_platform_admin(actor) then 'platform_admin'
                    when public.user_has_permission(actor, 'roles.manage', 'club', v.club_id) then 'club_admin' end;
    if new.performed_by_user_id is distinct from actor or derived is null or derived is distinct from new.basis then
      raise exception 'permission club version: the acting user may not write this version' using errcode = '42501';
    end if;
  end if;
  if v.id is null or v.xmin::text::bigint <> public.permission_current_xmin() or v.revision <> new.revision_after then
    raise exception 'permission club version change: the record must follow its own change in the same transaction' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger permission_club_role_version_changes_guard before insert on public.permission_club_role_version_changes
  for each row execute function public.permission_club_role_version_changes_guard();
create trigger permission_club_role_version_changes_append_only before update or delete on public.permission_club_role_version_changes
  for each row execute function public.permission_r4_refuse();
create trigger permission_club_role_version_changes_no_truncate before truncate on public.permission_club_role_version_changes
  for each statement execute function public.permission_r4_refuse();

-- At COMMIT: the items this transaction added agree with the record, the removed ones are gone; a 'migration'
-- record has the runner's row of its name written by this transaction (v84's M15).
create function public.permission_club_role_version_changes_complete() returns trigger as $$
declare
  added text[];
begin
  select coalesce(array_agg(i.permission_word), '{}') into added
    from public.permission_club_role_version_items i
   where i.version_id = new.version_id and i.xmin::text::bigint = public.permission_current_xmin();
  if not (new.items_added <@ added and added <@ new.items_added)
     or exists (select 1 from public.permission_club_role_version_items i where i.version_id = new.version_id and i.permission_word = any(new.items_removed)) then
    raise exception 'permission club version change: the record must follow its own change in the same transaction' using errcode = '23514';
  end if;
  if new.kind = 'migration' and not exists (
       select 1 from public.schema_migrations m
        where m.migration_name = new.migration_name and m.xmin::text::bigint = public.permission_current_xmin()) then
    raise exception 'permission club version change: the record must follow its own change in the same transaction' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create constraint trigger permission_club_role_version_changes_complete after insert on public.permission_club_role_version_changes
  deferrable initially deferred for each row execute function public.permission_club_role_version_changes_complete();

-- ===========================================================================
-- 12. Guards: custom roles (contract 3.4, 7.3)
-- ===========================================================================
-- The end written by the old tables' trigger: this transaction's marker, set and cleared by that trigger only.
create function public.permission_custom_end_marked() returns boolean
  language sql volatile set search_path = pg_catalog, public as $$
    select coalesce(current_setting('optimove.custom_role_end_tx', true), '') = pg_current_xact_id()::text
  $$;

-- May the acting user write a custom role of this base role in this club? A platform admin; a holder of
-- staff.assign in the active club, never for a holder of Club admin (O5: only a platform admin narrows an admin).
create function public.permission_custom_actor_may(p_actor uuid, p_club uuid, p_base_role uuid) returns boolean
  language sql stable set search_path = pg_catalog, public as $$
    select exists (select 1 from public.clubs c where c.id = p_club and coalesce(c.is_active, true))
       and (public.permission_is_platform_admin(p_actor)
            or ((select r.basic_key from public.permission_roles r where r.id = p_base_role) is distinct from 'club_admin'
                and public.user_has_permission(p_actor, 'staff.assign', 'club', p_club)))
  $$;

create function public.permission_custom_roles_guard() returns trigger as $$
declare
  actor uuid;
  r public.permission_roles;
  scope_club uuid;
  holding_ok boolean;
begin
  if tg_op = 'INSERT' then
    actor := public.permission_context_actor();
    if new.created_by_user_id is distinct from actor or not public.permission_custom_actor_may(actor, new.club_id, new.base_role_id) then
      raise exception 'permission custom role: the acting user may not write this custom role' using errcode = '42501';
    end if;
    if not public.permission_club_lock_held(new.club_id, 'shared') then
      raise exception 'permissions: the club lock must be taken before the first row lock' using errcode = '55000';
    end if;
    select * into r from public.permission_roles where id = new.base_role_id;
    scope_club := public.permission_scope_club(new.scope_type, new.scope_id);
    if scope_club is distinct from new.club_id or r.archived_at is not null
       or r.basic_key in ('platform_admin', 'independent_coach')
       or (r.owner_scope = 'club' and r.owner_club_id is distinct from new.club_id)
       or (new.scope_type = 'team' and not exists (select 1 from public.teams t where t.id = new.scope_id and coalesce(t.is_active, true)))
       or new.user_id = actor
       or not exists (select 1 from public.users u where u.id = new.user_id and u.is_active)
       or new.revision <> 1 or new.ended_at is not null then
      raise exception 'permission custom role: this change is not allowed' using errcode = '23514';
    end if;
    -- The user holds the base role in that scope through the named holding, now.
    holding_ok := case
      when new.holding_assignment_id is not null then exists (
        select 1 from public.user_role_assignments a
         where a.id = new.holding_assignment_id and a.user_id = new.user_id and a.role_id = new.base_role_id
           and a.scope_type = new.scope_type and a.scope_id = new.scope_id
           and a.revoked_at is null and (a.expires_at is null or a.expires_at > now()))
      when new.holding_row_table = 'user_club_roles' then r.basic_key = 'club_admin' and new.scope_type = 'club' and exists (
        select 1 from public.user_club_roles c
         where c.id = new.holding_row_id and c.user_id = new.user_id and c.club_id = new.scope_id
           and c.role = 'club_admin' and c.is_active and c.updated_at = new.holding_row_version)
      when new.holding_row_table = 'user_team_roles' then r.basic_key = 'team_coach' and new.scope_type = 'team' and exists (
        select 1 from public.user_team_roles t
         where t.id = new.holding_row_id and t.user_id = new.user_id and t.team_id = new.scope_id
           and t.role = 'team_coach' and t.is_active and t.updated_at = new.holding_row_version)
      else false end;
    if not holding_ok then
      raise exception 'permission custom role: this change is not allowed' using errcode = '23514';
    end if;
    if new.frozen_from_version_id is not null and not exists (
         select 1 from public.permission_club_role_versions v
          where v.id = new.frozen_from_version_id and v.club_id = new.club_id and v.system_role_id = new.base_role_id) then
      raise exception 'permission custom role: this change is not allowed' using errcode = '23514';
    end if;
    return new;
  end if;
  -- UPDATE: a new revision of a live custom; the end once.
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id or new.base_role_id is distinct from old.base_role_id
     or new.scope_type is distinct from old.scope_type or new.scope_id is distinct from old.scope_id or new.club_id is distinct from old.club_id
     or new.holding_assignment_id is distinct from old.holding_assignment_id or new.holding_row_table is distinct from old.holding_row_table
     or new.holding_row_id is distinct from old.holding_row_id or new.holding_row_version is distinct from old.holding_row_version
     or new.frozen_from is distinct from old.frozen_from or new.frozen_from_revision is distinct from old.frozen_from_revision
     or new.frozen_from_version_id is distinct from old.frozen_from_version_id
     or new.created_by_user_id is distinct from old.created_by_user_id or new.created_at is distinct from old.created_at
     or old.ended_at is not null or new.revision is distinct from old.revision + 1 then
    raise exception 'permission custom role: this change is not allowed' using errcode = '23514';
  end if;
  if public.permission_custom_end_marked() and public.permission_actor_absent() then
    -- The old tables' trigger: only the end of a custom whose holding row changed.
    if new.end_kind is distinct from 'role_ended' or new.ended_by_user_id is not null then
      raise exception 'permission custom role: this change is not allowed' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.end_kind = 'role_ended' then
    raise exception 'permission custom role: the acting user may not write this custom role' using errcode = '42501';
  end if;
  if not public.permission_club_lock_held(old.club_id, 'shared') then
    raise exception 'permissions: the club lock must be taken before the first row lock' using errcode = '55000';
  end if;
  if public.permission_actor_absent() then
    if new.ended_at is not null then
      raise exception 'permission custom role: the acting user may not write this custom role' using errcode = '42501';
    end if;
  else
    actor := public.permission_context_actor();
    if not public.permission_custom_actor_may(actor, old.club_id, old.base_role_id)
       or (new.ended_at is not null and new.ended_by_user_id is distinct from actor) then
      raise exception 'permission custom role: the acting user may not write this custom role' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger permission_custom_roles_guard before insert or update on public.permission_custom_roles
  for each row execute function public.permission_custom_roles_guard();
create trigger permission_custom_roles_no_delete before delete on public.permission_custom_roles
  for each row execute function public.permission_r4_refuse();
create trigger permission_custom_roles_no_truncate before truncate on public.permission_custom_roles
  for each statement execute function public.permission_r4_refuse();

create function public.permission_custom_role_items_guard() returns trigger as $$
declare
  c public.permission_custom_roles;
  r public.permission_roles;
  w public.permissions;
  actor uuid;
  rec record := case when tg_op = 'DELETE' then old else new end;
begin
  select * into c from public.permission_custom_roles where id = rec.custom_role_id;
  if not found or c.xmin::text::bigint <> public.permission_current_xmin() or c.ended_at is not null then
    raise exception 'permission custom role item: the acting user may not write this custom role' using errcode = '42501';
  end if;
  if not public.permission_club_lock_held(c.club_id, 'shared') then
    raise exception 'permissions: the club lock must be taken before the first row lock' using errcode = '55000';
  end if;
  if public.permission_actor_absent() then
    if not exists (select 1 from public.permission_custom_role_changes x
                    where x.custom_role_id = c.id and x.revision_after = c.revision and x.kind = 'migration'
                      and x.xmin::text::bigint = public.permission_current_xmin()) then
      raise exception 'permission custom role item: the acting user may not write this custom role' using errcode = '42501';
    end if;
    actor := null;
  else
    actor := public.permission_context_actor();
    if not public.permission_custom_actor_may(actor, c.club_id, c.base_role_id) then
      raise exception 'permission custom role item: the acting user may not write this custom role' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' then
    select * into r from public.permission_roles where id = c.base_role_id;
    select * into w from public.permissions where word = new.permission_word;
    if w.platform_only then
      raise exception 'permission custom role item: a platform-only permission belongs to no role' using errcode = '23514';
    end if;
    if w.system_role_only and r.basic_key is distinct from 'club_admin' then
      raise exception 'permission custom role item: this permission exists only in the Club admin role' using errcode = '23514';
    end if;
    if not public.permission_word_honoured(new.permission_word) then
      raise exception 'permission custom role item: no route checks this permission yet' using errcode = '23514';
    end if;
    if not exists (select 1 from public.permission_scope_types s where s.permission_word = new.permission_word and s.scope_type = c.scope_type) then
      raise exception 'permission custom role item: the permission does not cover the role''s scope types' using errcode = '23514';
    end if;
    if actor is not null and not public.permission_is_platform_admin(actor)
       and not public.user_has_permission(actor, new.permission_word, 'club', c.club_id) then
      raise exception 'permission custom role item: the acting user does not hold this permission' using errcode = '42501';
    end if;
  end if;
  return rec;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger permission_custom_role_items_guard before insert or delete on public.permission_custom_role_items
  for each row execute function public.permission_custom_role_items_guard();
create trigger permission_custom_role_items_no_update before update on public.permission_custom_role_items
  for each row execute function public.permission_r4_refuse();
create trigger permission_custom_role_items_no_truncate before truncate on public.permission_custom_role_items
  for each statement execute function public.permission_r4_refuse();

create function public.permission_custom_roles_complete() returns trigger as $$
declare
  c public.permission_custom_roles;
  actor uuid;
begin
  select * into c from public.permission_custom_roles where id = new.id;
  if not exists (select 1 from public.permission_custom_role_changes x
                  where x.custom_role_id = c.id and x.revision_after = c.revision
                    and x.xmin::text::bigint = public.permission_current_xmin()) then
    raise exception 'permission custom role: the change has no change record' using errcode = '23514';
  end if;
  if c.ended_at is null and (select basic_key from public.permission_roles where id = c.base_role_id) = 'club_admin'
     and (not exists (select 1 from public.permission_custom_role_items i where i.custom_role_id = c.id and i.permission_word = 'staff.assign')
          or not exists (select 1 from public.permission_custom_role_items i where i.custom_role_id = c.id and i.permission_word = 'roles.manage')) then
    raise exception 'permission custom role: the Club admin role must hold this permission' using errcode = '23514';
  end if;
  if c.ended_at is null and not public.permission_actor_absent() then
    actor := public.permission_context_actor();
    if not public.permission_is_platform_admin(actor) and exists (
         select 1 from public.permission_custom_role_items i
          where i.custom_role_id = c.id and not public.user_has_permission(actor, i.permission_word, 'club', c.club_id)) then
      raise exception 'permission custom role: the acting user does not hold every permission of this custom role' using errcode = '42501';
    end if;
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create constraint trigger permission_custom_roles_complete after insert or update on public.permission_custom_roles
  deferrable initially deferred for each row execute function public.permission_custom_roles_complete();

create function public.permission_custom_role_changes_guard() returns trigger as $$
declare
  c public.permission_custom_roles;
  actor uuid;
  derived text;
begin
  select * into c from public.permission_custom_roles where id = new.custom_role_id;
  if new.kind = 'migration' then
    if not public.permission_actor_absent() then
      raise exception 'permission custom role change: the record must follow its own change in the same transaction' using errcode = '23514';
    end if;
  elsif new.kind = 'role_ended' then
    if not (public.permission_custom_end_marked() and public.permission_actor_absent()) or c.end_kind is distinct from 'role_ended' then
      raise exception 'permission custom role: the acting user may not write this custom role' using errcode = '42501';
    end if;
  else
    actor := public.permission_context_actor();
    derived := case when public.permission_is_platform_admin(actor) then 'platform_admin'
                    when public.user_has_permission(actor, 'staff.assign', 'club', c.club_id) then 'club_admin' end;
    if new.performed_by_user_id is distinct from actor or derived is null or derived is distinct from new.basis then
      raise exception 'permission custom role: the acting user may not write this custom role' using errcode = '42501';
    end if;
  end if;
  if c.id is null or c.xmin::text::bigint <> public.permission_current_xmin() or c.revision <> new.revision_after then
    raise exception 'permission custom role change: the record must follow its own change in the same transaction' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger permission_custom_role_changes_guard before insert on public.permission_custom_role_changes
  for each row execute function public.permission_custom_role_changes_guard();
create trigger permission_custom_role_changes_append_only before update or delete on public.permission_custom_role_changes
  for each row execute function public.permission_r4_refuse();
create trigger permission_custom_role_changes_no_truncate before truncate on public.permission_custom_role_changes
  for each statement execute function public.permission_r4_refuse();

create function public.permission_custom_role_changes_complete() returns trigger as $$
declare
  added text[];
begin
  select coalesce(array_agg(i.permission_word), '{}') into added
    from public.permission_custom_role_items i
   where i.custom_role_id = new.custom_role_id and i.xmin::text::bigint = public.permission_current_xmin();
  if not (new.items_added <@ added and added <@ new.items_added)
     or exists (select 1 from public.permission_custom_role_items i where i.custom_role_id = new.custom_role_id and i.permission_word = any(new.items_removed)) then
    raise exception 'permission custom role change: the record must follow its own change in the same transaction' using errcode = '23514';
  end if;
  if new.kind = 'migration' and not exists (
       select 1 from public.schema_migrations m
        where m.migration_name = new.migration_name and m.xmin::text::bigint = public.permission_current_xmin()) then
    raise exception 'permission custom role change: the record must follow its own change in the same transaction' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create constraint trigger permission_custom_role_changes_complete after insert on public.permission_custom_role_changes
  deferrable initially deferred for each row execute function public.permission_custom_role_changes_complete();

-- ===========================================================================
-- 13. The request record widened for R4-3 (contract 7.7)
-- ===========================================================================
alter table public.permission_requests
  add column ceiling_change_id uuid references public.club_permission_ceiling_changes (id) on delete restrict,
  add column club_version_change_id uuid references public.permission_club_role_version_changes (id) on delete restrict,
  add column custom_role_change_id uuid references public.permission_custom_role_changes (id) on delete restrict;
create index permission_requests_ceiling_change_id_idx on public.permission_requests (ceiling_change_id);
create index permission_requests_club_version_change_id_idx on public.permission_requests (club_version_change_id);
create index permission_requests_custom_role_change_id_idx on public.permission_requests (custom_role_change_id);
alter table public.permission_requests drop constraint permission_requests_operation_check;
alter table public.permission_requests add constraint permission_requests_operation_check check (operation in (
  'role_create', 'role_copy', 'role_change', 'role_archive', 'assignment_grant', 'assignment_revoke',
  'ceiling_close', 'ceiling_open', 'club_version_change', 'club_version_answer', 'custom_change', 'custom_end',
  'custom_word_removal'));
alter table public.permission_requests drop constraint permission_requests_result_shape;
alter table public.permission_requests add constraint permission_requests_result_shape check (
  num_nonnulls(role_change_id, assignment_id, ceiling_change_id, club_version_change_id, custom_role_change_id) = 1
  and (operation not like 'role\_%' or role_change_id is not null)
  and (operation not like 'assignment\_%' or assignment_id is not null)
  and (operation not like 'ceiling\_%' or ceiling_change_id is not null)
  and (operation not like 'club\_version\_%' or club_version_change_id is not null)
  and (operation not like 'custom\_%' or custom_role_change_id is not null));

create or replace function public.permission_requests_guard() returns trigger as $$
declare
  actor uuid := public.permission_context_actor();
  word text := case when new.operation like 'role\_%' or new.operation like 'club\_version\_%' then 'roles.manage' else 'staff.assign' end;
  derived text;
  result_xmin bigint;
begin
  if new.requested_by_user_id is distinct from actor then
    raise exception 'permission request: the acting user may not write this request' using errcode = '42501';
  end if;
  derived := case when new.owner_scope = 'system' or new.operation like 'ceiling\_%'
                  then (case when exists (select 1 from public.users u join public.user_global_roles g on g.user_id = u.id
                                           where u.id = actor and u.is_active and g.role = 'platform_admin' and g.is_active)
                             then 'platform_admin' end)
                  else public.permission_actor_basis(actor, word, 'club', new.owner_club_id) end;
  if derived is null or derived is distinct from new.basis then
    raise exception 'permission request: the acting user may not write this request' using errcode = '42501';
  end if;
  if new.role_change_id is not null then
    select c.xmin::text::bigint into result_xmin from public.permission_role_changes c where c.id = new.role_change_id;
  elsif new.assignment_id is not null then
    select a.xmin::text::bigint into result_xmin from public.user_role_assignments a where a.id = new.assignment_id;
  elsif new.ceiling_change_id is not null then
    select c.xmin::text::bigint into result_xmin from public.club_permission_ceiling_changes c where c.id = new.ceiling_change_id;
  elsif new.club_version_change_id is not null then
    select c.xmin::text::bigint into result_xmin from public.permission_club_role_version_changes c where c.id = new.club_version_change_id;
  else
    select c.xmin::text::bigint into result_xmin from public.permission_custom_role_changes c where c.id = new.custom_role_change_id;
  end if;
  if result_xmin is null or result_xmin <> public.permission_current_xmin() then
    raise exception 'permission request: the request must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;

-- ===========================================================================
-- 14. The two old scoped role tables (contract 3.4 and 7.3; the db re-review's N1, the Nezavisni revizor's N2)
-- ===========================================================================
-- BEFORE UPDATE: a change of is_active or revoked_at always moves updated_at (a raw writer that flips is_active
-- without touching it included), so a custom bound to the row's updated_at dies with any revoke or re-grant.
-- revoked_at is read through to_jsonb, so a database whose copy of these tables has no such column (the minimal test
-- scaffolds) is served by the same body.
create function public.permission_old_role_row_version() returns trigger as $$
begin
  if (new.is_active is distinct from old.is_active
      or (to_jsonb(new) -> 'revoked_at') is distinct from (to_jsonb(old) -> 'revoked_at'))
     and new.updated_at is not distinct from old.updated_at then
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$$ language plpgsql set search_path = pg_catalog, public;

-- AFTER UPDATE of updated_at: the live custom roles made on that row (its old updated_at) end, 'role_ended', with
-- their change row - under this transaction's marker, set here and cleared before returning.
create function public.permission_old_role_row_ends_customs() returns trigger as $$
declare
  c record;
  saved_actor text := current_setting('optimove.permission_actor', true);
begin
  if new.updated_at is not distinct from old.updated_at then
    return null;
  end if;
  if not exists (select 1 from public.permission_custom_roles x
                  where x.holding_row_table = tg_table_name and x.holding_row_id = old.id and x.ended_at is null) then
    return null;
  end if;
  perform set_config('optimove.permission_actor', '', true);
  perform set_config('optimove.custom_role_end_tx', pg_current_xact_id()::text, true);
  for c in select x.id, x.revision from public.permission_custom_roles x
            where x.holding_row_table = tg_table_name and x.holding_row_id = old.id and x.ended_at is null
            order by x.id for update loop
    update public.permission_custom_roles
       set ended_at = clock_timestamp(), end_kind = 'role_ended', revision = c.revision + 1
     where id = c.id;
    insert into public.permission_custom_role_changes (custom_role_id, revision_after, kind)
    values (c.id, c.revision + 1, 'role_ended');
  end loop;
  perform set_config('optimove.custom_role_end_tx', '', true);
  perform set_config('optimove.permission_actor', coalesce(saved_actor, ''), true);
  return null;
end;
$$ language plpgsql set search_path = pg_catalog, public;

create trigger user_club_roles_permission_version before update on public.user_club_roles
  for each row execute function public.permission_old_role_row_version();
create trigger user_team_roles_permission_version before update on public.user_team_roles
  for each row execute function public.permission_old_role_row_version();
create trigger user_club_roles_permission_ends_customs after update on public.user_club_roles
  for each row execute function public.permission_old_role_row_ends_customs();
create trigger user_team_roles_permission_ends_customs after update on public.user_team_roles
  for each row execute function public.permission_old_role_row_ends_customs();

-- ===========================================================================
-- 15. Row-level security and revokes
-- ===========================================================================
alter table public.club_permission_ceiling enable row level security;
alter table public.club_permission_ceiling_changes enable row level security;
alter table public.permission_club_role_versions enable row level security;
alter table public.permission_club_role_version_items enable row level security;
alter table public.permission_club_role_version_changes enable row level security;
alter table public.permission_custom_roles enable row level security;
alter table public.permission_custom_role_items enable row level security;
alter table public.permission_custom_role_changes enable row level security;

do $$
declare
  t text;
  f regprocedure;
begin
  foreach t in array array['club_permission_ceiling', 'club_permission_ceiling_changes', 'permission_club_role_versions',
                           'permission_club_role_version_items', 'permission_club_role_version_changes', 'permission_custom_roles',
                           'permission_custom_role_items', 'permission_custom_role_changes'] loop
    execute format('revoke all on public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on public.%I from service_role', t);
    end if;
  end loop;
  for f in
    select p.oid::regprocedure from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('permission_club_lock_namespace', 'permission_club_lock_held', 'lock_club_ceiling', 'permission_scope_club',
                         'permission_is_platform_admin', 'permission_club_closed_modules', 'permission_role_club_items',
                         'permission_user_holdings', 'permission_word_honoured', 'user_has_permission', 'user_holds_role_items',
                         'lock_permission_actor', 'permission_club_rule7_ok', 'permission_rule7_check', 'permission_club_rule7_check',
                         'club_permission_ceiling_guard', 'permission_r4_refuse', 'club_permission_ceiling_changes_guard',
                         'club_permission_ceiling_complete', 'permission_version_actor_may', 'permission_versionable_role',
                         'permission_club_role_versions_guard', 'permission_club_role_version_items_guard',
                         'permission_club_role_versions_complete', 'permission_club_role_version_changes_guard',
                         'permission_club_role_version_changes_complete', 'permission_custom_end_marked', 'permission_custom_actor_may',
                         'permission_custom_roles_guard', 'permission_custom_role_items_guard', 'permission_custom_roles_complete',
                         'permission_custom_role_changes_guard', 'permission_custom_role_changes_complete', 'permission_requests_guard',
                         'permission_old_role_row_version', 'permission_old_role_row_ends_customs')
  loop
    execute format('revoke execute on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke execute on function %s from authenticated', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke execute on function %s from service_role', f);
    end if;
  end loop;
end $$;

-- ===========================================================================
-- 16. The seed, last (contract 4.1, 7.4 step 5; v84's M15 path). Plain statements only: a refusal stops the file.
-- ===========================================================================
update public.permission_roles set revision = revision + 1, updated_at = now() where id = '00000000-0000-4000-8000-000000000842';
insert into public.permission_role_changes (role_id, revision_after, kind, migration_name, items_added)
select id, revision, 'migration', 'migrations_v2/202611241000_roles_v92_layers_foundation.sql',
       array['athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view', 'load.view.team',
             'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view', 'variables.view']
  from public.permission_roles where id = '00000000-0000-4000-8000-000000000842';
insert into public.permission_role_items (role_id, permission_word)
select '00000000-0000-4000-8000-000000000842', w
  from unnest(array['athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view', 'load.view.team',
                    'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view', 'variables.view']) w;

update public.permission_roles set revision = revision + 1, updated_at = now() where id = '00000000-0000-4000-8000-000000000843';
insert into public.permission_role_changes (role_id, revision_after, kind, migration_name, items_added)
select id, revision, 'migration', 'migrations_v2/202611241000_roles_v92_layers_foundation.sql',
       array['athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view', 'load.view.team',
             'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view', 'variables.view']
  from public.permission_roles where id = '00000000-0000-4000-8000-000000000843';
insert into public.permission_role_items (role_id, permission_word)
select '00000000-0000-4000-8000-000000000843', w
  from unnest(array['athletes.view', 'programs.view', 'exercises.use', 'presets.use', 'calendar.view', 'load.view.team',
                    'load.view.athlete', 'dashboards.view', 'tests.view', 'tests.results.view', 'variables.view']) w;
