// Workspace selection (Phase 5): a multi-role account (platform admin,
// independent coach, club admin in one or more clubs, team coach in one or
// more teams, athlete) picks which context it is currently acting in after
// login, and can change it later without logging out.
//
// ARCHITECTURAL BOUNDARY - do not blur this:
//   - req.authz (real, active roles/FKs) decides what an account MAY do.
//   - the active workspace only decides what it is CURRENTLY presented as
//     doing, for navigation and Organization data-context filtering.
//   - a workspace never grants a permission on its own, and switching one
//     never grants, revokes, or otherwise touches any role row.
//   - role_hint plays no part here, in either direction.
import { query } from "./db.js";

export const WORKSPACE_TYPES = new Set(["platform", "private_coach", "club", "team", "athlete"]);

// Deterministic fallback order used only when there's no saved preference,
// or the saved one no longer matches a currently-available workspace (its
// backing role/FK was revoked or archived since it was chosen). A user
// whose only available workspace is athlete lands there automatically -
// there's no separate special case for that, it falls out of the loop
// simply finding nothing earlier in this list.
const FALLBACK_ORDER = ["platform", "club", "team", "private_coach", "athlete"];

function sortByLabel(rows) {
  return [...rows].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// Builds the exact, current set of workspaces this account may act in -
// purely from req.authz (real, active roles/FKs), never role_hint. A club
// admin does NOT get a separate workspace for every team of their club (they
// see those teams from inside the club workspace); a team workspace only
// exists for a real, active team_coach role. An archived club/team is never
// offered as a workspace even if the underlying role row is technically
// still active, matching how the rest of the app treats an archived
// club/team as no longer a real place to work in.
export async function loadAvailableWorkspaces(authz) {
  const workspaces = [];
  if (authz.platformRoles.length > 0) {
    workspaces.push({ type: "platform", scopeId: null, label: "Platform administration", role: "platform_admin" });
  }
  if (authz.isIndependentCoach) {
    workspaces.push({ type: "private_coach", scopeId: null, label: "Private coaching", role: "independent_coach" });
  }

  const clubIds = authz.clubRoles.filter((r) => r.role === "club_admin").map((r) => r.clubId);
  const teamIds = authz.teamRoles.filter((r) => r.role === "team_coach").map((r) => r.teamId);
  const [clubsResult, teamsResult] = await Promise.all([
    clubIds.length
      ? query(`select id, name from public.clubs where id = any($1::uuid[]) and coalesce(is_active, true)`, [clubIds])
      : { rows: [] },
    teamIds.length
      ? query(`select id, name from public.teams where id = any($1::uuid[]) and coalesce(is_active, true)`, [teamIds])
      : { rows: [] },
  ]);
  for (const club of sortByLabel(clubsResult.rows)) {
    workspaces.push({ type: "club", scopeId: club.id, label: club.name, role: "club_admin" });
  }
  for (const team of sortByLabel(teamsResult.rows)) {
    workspaces.push({ type: "team", scopeId: team.id, label: team.name, role: "team_coach" });
  }

  if (authz.isAthlete) {
    workspaces.push({ type: "athlete", scopeId: null, label: "Athlete", role: "athlete" });
  }
  return workspaces;
}

function findWorkspace(workspaces, type, scopeId) {
  return workspaces.find((w) => w.type === type && String(w.scopeId || "") === String(scopeId || "")) || null;
}

function pickFallbackWorkspace(workspaces) {
  for (const type of FALLBACK_ORDER) {
    const match = workspaces.find((w) => w.type === type);
    if (match) return match;
  }
  return null;
}

// Shared by PUT /api/auth/workspace and the controlled fallback-persist path
// in resolveActiveWorkspace below - the only two places a preference row is
// ever written. Never called with anything that loadAvailableWorkspaces
// hasn't just proven is real and currently available.
export async function saveWorkspacePreference(userId, type, scopeId) {
  await query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id, updated_at)
     values ($1, $2, $3, now())
     on conflict (user_id) do update
       set workspace_type = excluded.workspace_type,
           scope_id = excluded.scope_id,
           updated_at = now()`,
    [userId, type, scopeId || null],
  );
}

// The single source of truth for "which workspace is this account currently
// acting in" - used by both GET /api/auth/me and GET /api/organization, so a
// switch made via PUT /api/auth/workspace takes effect on the very next
// request to either, with nothing else to fall out of sync.
//
// If there's no saved preference, or the saved one no longer matches a
// currently-available workspace (its backing role/FK was revoked/archived
// since it was chosen), a deterministic fallback is chosen instead - never a
// 500, never inventing coach access the account doesn't actually have. That
// fallback is also persisted as the new preference (a controlled, tested
// write - see workspace-selection.test.mjs), so the next request already
// finds a matching, valid preference rather than recomputing the fallback
// every time.
export async function resolveActiveWorkspace(userId, authz) {
  const availableWorkspaces = await loadAvailableWorkspaces(authz);
  const preferenceResult = await query(
    `select workspace_type, scope_id from public.user_workspace_preferences where user_id = $1 limit 1`,
    [userId],
  );
  const preference = preferenceResult.rows[0] || null;
  if (preference) {
    const matched = findWorkspace(availableWorkspaces, preference.workspace_type, preference.scope_id);
    if (matched) return { workspace: matched, availableWorkspaces };
  }

  const fallback = pickFallbackWorkspace(availableWorkspaces);
  if (fallback) {
    const alreadyStored = preference
      && preference.workspace_type === fallback.type
      && String(preference.scope_id || "") === String(fallback.scopeId || "");
    if (!alreadyStored) await saveWorkspacePreference(userId, fallback.type, fallback.scopeId);
  }
  return { workspace: fallback, availableWorkspaces };
}

// The actual gate PUT /api/auth/workspace enforces - never trusts the
// client's claimed type/scopeId beyond matching it against a workspace
// loadAvailableWorkspaces (i.e. req.authz) just proved is real. role_hint
// plays no part in this decision.
export async function validateWorkspaceSelection(authz, type, scopeId) {
  if (!WORKSPACE_TYPES.has(type)) return { error: "UNSUPPORTED_WORKSPACE_TYPE" };
  const availableWorkspaces = await loadAvailableWorkspaces(authz);
  const matched = findWorkspace(availableWorkspaces, type, scopeId);
  if (!matched) return { error: "WORKSPACE_NOT_AVAILABLE" };
  return { workspace: matched, availableWorkspaces };
}
