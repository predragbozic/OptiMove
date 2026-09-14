# ADR-002: owner_scope and data_workspace are independent authorization checks

**Status:** Active

## Context

A single user can hold roles across several workspaces (e.g. manage two different clubs,
or be a platform admin with their own private coaching workspace). A resource like a
Training Load dashboard has two separate questions attached to it: who is allowed to
*manage* it, and which workspace's *data* it's allowed to read when queried. Collapsing
these into one check creates a real leak: a manager of Club A and Club B could have Club
A's dashboard execute against Club B's data just because they can manage both.

## Decision

Keep `owner_scope` (+ `owner_user_id`/`owner_club_id`/`owner_team_id`) and
`data_workspace_type`/`data_workspace_scope_id` as two independent columns/checks on
`training_load.dashboards`, each answering a different question, and require both to be
checked separately wherever relevant — never substitute one for the other or reduce them
to a single equality test.

## Exact contracts

- Columns added: `migrations_v2/202609100900_..._v15_dashboard_catalog_and_dashboards.sql:165-170`.
  `owner_scope` values: `'system' | 'club' | 'team' | 'user'`.
  `data_workspace_type` values: `'platform' | 'private_coach' | 'club' | 'team' | 'athlete'`.
- CHECK constraints tie shape to values: club/team owner_scope requires the matching
  `owner_*_id` set (v15:184-189); club/team-owned dashboards' workspace must equal their
  own club/team (v15:205-206); `system` owner_scope implies `is_template=true` and null
  workspace (v15:192,196). Both fields are made write-once by trigger
  `dashboards_protect_ownership_once_used` (v15:228-244).
- **Manage check**: `canManageDashboardRow` — `backend/src/trainingLoadDashboardAccess.js:213-219`.
  Platform admin, OR `owner_scope==="user" && owner_user_id===req.user.id`, OR
  `owner_scope==="club" && canManageClub`, OR `owner_scope==="team" && canManageTeamById`.
- **Data-workspace check**: `dataWorkspaceMatches` — `trainingLoadDashboardAccess.js:110-129`.
  Compares the caller's *currently active* workspace against the row's own
  `data_workspace_type`/`data_workspace_scope_id`.
- **Concrete separation in the query route**: `backend/src/routes/trainingLoadDashboard.js:747-765`.
  `getDashboardDetail` grants visibility via the (broader) manage check; the query
  handler then independently re-checks `dataWorkspaceMatches` and returns
  `404 {error:"notFound"}` if it fails — documented in the route's own comment as closing
  exactly the "manager of two workspaces" leak above.

## Consequences

- Any new route/service that reads dashboard (or similarly-shaped) data must perform
  BOTH checks independently, via the real domain helper for each — not a simplified
  "are these two fields equal" shortcut.
- A finding of only one check being present (manage OR workspace, not both) is a real
  security issue, not a style preference.

## Evidence

Verified against `trainingLoadDashboardAccess.js`, `routes/trainingLoadDashboard.js`, and
migration v15, in a research pass on 2026-09-14.

## Supersedes / Superseded by

—
