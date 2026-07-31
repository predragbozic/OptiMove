-- Phase 4 PR 1: give platform_admin and independent_coach a real,
-- independently-managed home instead of a single-valued users.role_hint
-- string. A user_global_roles row is authoritative; role_hint remains a
-- legacy column used only as a UI "which screen did they last pick"
-- preference (never read for authorization after this migration lands -
-- see backend/src/authz.js) and is left completely untouched here.
--
-- This lets one account hold BOTH platform_admin AND independent_coach at
-- once (structurally impossible with a single role_hint string), and lets
-- either be granted/revoked independently of the other, of any club/team
-- role, and of the account's login status.

create table if not exists public.user_global_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  role varchar(40) not null,
  is_active boolean not null default true,
  granted_by_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_global_roles_role_check check (role in ('platform_admin', 'independent_coach')),
  constraint user_global_roles_user_role_unique unique (user_id, role)
);

create index if not exists user_global_roles_user_active_idx
  on public.user_global_roles (user_id)
  where is_active = true;

-- Idempotent backfill: mirrors the exact PLATFORM_ROLES / INDEPENDENT_COACH_ROLE_HINTS
-- sets already used by backend/src/access.js and backend/src/authz.js - this
-- does not redefine who counts as what, it only moves the existing string
-- match into a real, independently-queryable row. Re-running this insert is
-- always a no-op for accounts that already have the matching row.
insert into public.user_global_roles (user_id, role)
select u.id, 'platform_admin'
from public.users u
where lower(coalesce(u.role_hint, '')) in ('admin', 'platform_admin', 'general_admin')
  and not exists (
    select 1 from public.user_global_roles g
    where g.user_id = u.id and g.role = 'platform_admin'
  );

insert into public.user_global_roles (user_id, role)
select u.id, 'independent_coach'
from public.users u
where lower(coalesce(u.role_hint, '')) in ('coach', 'independent_coach', 'fitness_coach', 'trainer')
  and not exists (
    select 1 from public.user_global_roles g
    where g.user_id = u.id and g.role = 'independent_coach'
  );

-- A read-only audit (run before this migration, against both dev and
-- production) confirmed zero athletes rows share a non-null user_id, so
-- this is safe to enforce going forward: one login maps to at most one
-- sporting profile. If this ever needs to be lifted, drop the index below -
-- do not add duplicate athlete rows to work around it.
create unique index if not exists athletes_user_id_unique
  on public.athletes (user_id)
  where user_id is not null;

-- Verification (read-only, for manual review after running this migration):
-- select role, count(*) from public.user_global_roles group by role;
-- select user_id, count(*) from public.athletes where user_id is not null group by user_id having count(*) > 1;
