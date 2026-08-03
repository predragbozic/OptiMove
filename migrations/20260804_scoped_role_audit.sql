-- Phase 4: audit trail for granting/revoking a scoped club/team role
-- (public.user_club_roles / public.user_team_roles), mirroring the same
-- shape already added for public.user_global_roles in
-- 20260803_user_global_roles_audit.sql. created_at/updated_at already
-- exist on both tables from create_access_schema.sql - this only adds who
-- granted or revoked a row and when, distinct from the row's own
-- created_at/updated_at timestamps. Idempotent: safe to run against a
-- database that already has these columns (e.g. re-running migrate.js).
-- Never rewrites any existing row's data - every new column defaults to
-- null for rows that already exist.

alter table public.user_club_roles
  add column if not exists granted_by_user_id uuid references public.users(id) on delete set null,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by_user_id uuid references public.users(id) on delete set null;

alter table public.user_team_roles
  add column if not exists granted_by_user_id uuid references public.users(id) on delete set null,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by_user_id uuid references public.users(id) on delete set null;

-- Verification (read-only, for manual review after running this migration):
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name in ('user_club_roles', 'user_team_roles')
-- order by table_name, column_name;
