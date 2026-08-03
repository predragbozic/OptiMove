-- Phase 5: workspace selection. A multi-role account (platform admin,
-- independent coach, club admin in one or more clubs, team coach in one or
-- more teams, athlete) picks which context it is currently acting in after
-- login, and can change it later without logging out.
--
-- This table stores ONLY that UI preference - it is never consulted for
-- authorization. Every permission decision still comes from req.authz
-- (public.user_global_roles / public.user_club_roles / public.user_team_roles
-- / public.athletes), exactly as before this migration. See
-- backend/src/workspace.js: loadAvailableWorkspaces always recomputes the
-- real, currently-available workspace set from those tables, and
-- resolveActiveWorkspace only trusts a saved preference here when it still
-- matches one of them - a preference whose backing role/FK was since
-- revoked never grants access, it just falls back to a fresh valid choice.
--
-- Idempotent: safe to run against a database that already has this table.

create table if not exists public.user_workspace_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  workspace_type varchar(20) not null,
  scope_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_workspace_preferences_type_check
    check (workspace_type in ('platform', 'private_coach', 'club', 'team', 'athlete')),
  -- club/team workspaces are meaningless without a specific club/team id;
  -- platform/private_coach/athlete are single scopes for this account and
  -- must never carry one. Enforced here (not just in application code) so
  -- no future call site can ever write a malformed row.
  constraint user_workspace_preferences_scope_shape_check check (
    (workspace_type in ('club', 'team') and scope_id is not null)
    or (workspace_type in ('platform', 'private_coach', 'athlete') and scope_id is null)
  )
);

-- Verification (read-only, for manual review after running this migration):
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name = 'user_workspace_preferences'
-- order by column_name;
