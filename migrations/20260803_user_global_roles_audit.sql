-- Phase 4 PR 2B: audit trail for granting/revoking a global role
-- (public.user_global_roles). granted_by_user_id and updated_at already
-- exist from the Phase 4 PR 1 migration - this only adds the revoke side,
-- so a revoked row can say who revoked it and when, distinct from who most
-- recently (re-)granted it. Idempotent: safe to run against a database that
-- already has these columns (e.g. re-running migrate.js).

alter table public.user_global_roles
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by_user_id uuid references public.users(id) on delete set null;

-- Verification (read-only, for manual review after running this migration):
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name = 'user_global_roles'
-- order by column_name;
