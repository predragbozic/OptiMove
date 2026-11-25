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

// Roles R4-2 (docs/ai/roles-r4-contract.md 5.1, O8): club_view and team_view are the way into a club or a team for an
// account that holds a role there only through a live new-style assignment (user_role_assignments), with no club_admin
// row for that club / no team_coach row for that team. They are DIFFERENT types on purpose: the six modules that still
// treat an active "club" / "team" workspace as the permission itself (contract section 6) do not recognize them, so
// they stay closed for a view workspace by construction until each module's own VIEW pull request opens it next to a
// can() check. A "club" or "team" workspace stays offered only from the old role rows (the R4-1 standing rule).
export const VIEW_WORKSPACE_TYPES = new Set(["club_view", "team_view"]);
export const WORKSPACE_TYPES = new Set(["platform", "private_coach", "club", "team", "athlete", ...VIEW_WORKSPACE_TYPES]);

// The saved preference allows exactly five types (migrations/20260805_user_workspace_preferences.sql); a view
// workspace is stored as its base type and the same scope, and mapped back on read (findPreferredWorkspace).
const STORED_TYPE = Object.freeze({ club_view: "club", team_view: "team" });
export function storedWorkspaceType(type) {
  return STORED_TYPE[type] || type;
}

// Deterministic fallback order used only when there's no saved preference,
// or the saved one no longer matches a currently-available workspace (its
// backing role/FK was revoked or archived since it was chosen). A user
// whose only available workspace is athlete lands there automatically -
// there's no separate special case for that, it falls out of the loop
// simply finding nothing earlier in this list. The view workspaces come last
// (the manager's decision at R4-2's gate, L-3): an athlete who also holds an
// assignment lands in the athlete workspace and reaches club_view through the
// switch; an account whose only workspace is a view one still lands in it.
const FALLBACK_ORDER = ["platform", "club", "team", "private_coach", "athlete", "club_view", "team_view"];

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
export async function loadAvailableWorkspaces(authz, queryRunner = query) {
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
      ? queryRunner(`select id, name from public.clubs where id = any($1::uuid[]) and coalesce(is_active, true)`, [clubIds])
      : { rows: [] },
    teamIds.length
      ? queryRunner(`select id, name, club_id from public.teams where id = any($1::uuid[]) and coalesce(is_active, true)`, [teamIds])
      : { rows: [] },
  ]);
  for (const club of sortByLabel(clubsResult.rows)) {
    workspaces.push({ type: "club", scopeId: club.id, label: club.name, role: "club_admin" });
  }
  for (const team of sortByLabel(teamsResult.rows)) {
    workspaces.push({ type: "team", scopeId: team.id, clubId: team.club_id || null, label: team.name, role: "team_coach" });
  }

  workspaces.push(...await loadViewWorkspaces(authz, queryRunner));

  if (authz.isAthlete) {
    workspaces.push({ type: "athlete", scopeId: null, label: "Athlete", role: "athlete" });
  }
  return workspaces;
}

// The view workspaces (contract 5.1): a club C for every live club-scope assignment in an active club where the account
// has no club_admin row for C; a team T for every live team-scope assignment on an active team of an active club where
// the account has no team_coach row for T. The assignments come from authz.roleAssignments (the live, non-archived
// holdings loadAuthorizationContext already read: a revoked or expired assignment, or an archived role, is not there);
// only the names and the active state are read here. When the role tables could not be read for this request the list
// is empty, so nothing is offered (and resolveActiveWorkspace does not persist a fallback, below).
async function loadViewWorkspaces(authz, queryRunner) {
  const assignments = Array.isArray(authz.roleAssignments) ? authz.roleAssignments : [];
  const adminClubIds = new Set((authz.clubRoles || []).filter((r) => r.role === "club_admin").map((r) => String(r.clubId)));
  const coachTeamIds = new Set((authz.teamRoles || []).filter((r) => r.role === "team_coach").map((r) => String(r.teamId)));
  const viewClubIds = [...new Set(assignments.filter((a) => a.scopeType === "club").map((a) => String(a.scopeId)))]
    .filter((id) => !adminClubIds.has(id));
  const viewTeamIds = [...new Set(assignments.filter((a) => a.scopeType === "team").map((a) => String(a.scopeId)))]
    .filter((id) => !coachTeamIds.has(id));
  const [clubs, teams] = await Promise.all([
    viewClubIds.length
      ? queryRunner(`select id, name from public.clubs where id = any($1::uuid[]) and coalesce(is_active, true)`, [viewClubIds])
      : { rows: [] },
    viewTeamIds.length
      ? queryRunner(
        `select t.id, t.name, t.club_id from public.teams t join public.clubs c on c.id = t.club_id
          where t.id = any($1::uuid[]) and coalesce(t.is_active, true) and coalesce(c.is_active, true)`, [viewTeamIds])
      : { rows: [] },
  ]);
  return [
    ...sortByLabel(clubs.rows).map((club) => ({ type: "club_view", scopeId: club.id, label: club.name, role: "role_holder" })),
    ...sortByLabel(teams.rows).map((team) => ({ type: "team_view", scopeId: team.id, clubId: team.club_id, label: team.name, role: "role_holder" })),
  ];
}

function findWorkspace(workspaces, type, scopeId) {
  return workspaces.find((w) => w.type === type && String(w.scopeId || "") === String(scopeId || "")) || null;
}

// A saved preference names one of the five stored types. A stored club + C is the club workspace when the account has
// the club_admin row for C, else the club_view workspace when it has a live assignment there, else nothing (the
// fallback, as for any unavailable preference); team + T the same with team_view. A stored type never resolves to
// "club" or "team" without the old role row: the match is only ever against the list loadAvailableWorkspaces built.
function findPreferredWorkspace(workspaces, storedType, scopeId) {
  const exact = findWorkspace(workspaces, storedType, scopeId);
  if (exact) return exact;
  if (storedType === "club") return findWorkspace(workspaces, "club_view", scopeId);
  if (storedType === "team") return findWorkspace(workspaces, "team_view", scopeId);
  return null;
}

// Keys are fresh request authorization objects, never user ids or persisted state.
const readOnlyWorkspaceSnapshots = new WeakMap();
export function rememberReadOnlyWorkspace(userId, authz, resolution) {
 if (!VIEW_WORKSPACE_TYPES.has(resolution.workspace?.type)) throw new Error('A resolved view workspace is required.');
 readOnlyWorkspaceSnapshots.set(authz, { userId: String(userId), resolution });
}
export function rememberCheckedCoachWorkspace(userId, authz, resolution) {
  if (!["club", "team"].includes(resolution.workspace?.type)) throw new Error("A checked coach workspace is required.");
  readOnlyWorkspaceSnapshots.set(authz, { userId: String(userId), resolution });
}

function rememberedWorkspace(userId, authz) {
 const known = authz && readOnlyWorkspaceSnapshots.get(authz);
 return known?.userId === String(userId) ? known.resolution : null;
}

export async function resolveActiveWorkspaceReadOnly(userId, authz, queryRunner = query) {
  const known = rememberedWorkspace(userId, authz);
  if (known) return known;
  const availableWorkspaces = await loadAvailableWorkspaces(authz, queryRunner);
  const preference = (await queryRunner(
    'select workspace_type, scope_id from public.user_workspace_preferences where user_id = $1 limit 1', [userId],
  )).rows[0];
  const workspace = preference ? findPreferredWorkspace(availableWorkspaces, preference.workspace_type, preference.scope_id) : null;
  return { workspace, availableWorkspaces };
}

export function pickFallbackWorkspace(workspaces) {
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
// A view type is stored as its base type (storedWorkspaceType) on every write path, so the five-value CHECK of the
// preference table is never hit.
export async function saveWorkspacePreference(userId, type, scopeId) {
  await query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id, updated_at)
     values ($1, $2, $3, now())
     on conflict (user_id) do update
       set workspace_type = excluded.workspace_type,
           scope_id = excluded.scope_id,
           updated_at = now()`,
    [userId, storedWorkspaceType(type), scopeId || null],
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
  const known = rememberedWorkspace(userId, authz);
  if (known) return known;
  const availableWorkspaces = await loadAvailableWorkspaces(authz);
  const preferenceResult = await query(
    `select workspace_type, scope_id from public.user_workspace_preferences where user_id = $1 limit 1`,
    [userId],
  );
  const preference = preferenceResult.rows[0] || null;
  if (preference) {
    const matched = findPreferredWorkspace(availableWorkspaces, preference.workspace_type, preference.scope_id);
    if (matched) return { workspace: matched, availableWorkspaces };
  }

  const fallback = pickFallbackWorkspace(availableWorkspaces);
  if (fallback && await mayPersistFallback(userId, authz, preference)) {
    const alreadyStored = preference
      && preference.workspace_type === storedWorkspaceType(fallback.type)
      && String(preference.scope_id || "") === String(fallback.scopeId || "");
    if (!alreadyStored) await saveWorkspacePreference(userId, fallback.type, fallback.scopeId);
  }
  return { workspace: fallback, availableWorkspaces };
}

// Contract 5.1, the Nezavisni revizor's L1: when the role tables could not be read for this request the view workspaces
// are missing from the list, and a passing database error must not overwrite a role holder's saved club or team. So
// with the role tables unreadable, a stale stored club / team preference is kept while the account may hold a live
// assignment in that scope (asked of the assignments table itself; any error but "no such table" keeps it too). A
// database without the table (one built before v84) can hold no assignment, so its fallback is persisted as before
// R4-2; so is every other preference, and every fallback while the role tables are readable.
async function mayPersistFallback(userId, authz, preference) {
  const rolesReadable = !(authz?.rolePermissions && !Array.isArray(authz.rolePermissions));
  if (rolesReadable) return true;
  if (!preference || (preference.workspace_type !== "club" && preference.workspace_type !== "team") || !preference.scope_id) return true;
  try {
    const result = await query(
      `select exists (select 1 from public.user_role_assignments
                       where user_id = $1 and scope_type = $2 and scope_id = $3 and revoked_at is null
                         and (expires_at is null or expires_at > now())) as held`,
      [userId, preference.workspace_type, preference.scope_id],
    );
    return !result.rows[0]?.held;
  } catch (error) {
    return error?.code === "42P01";
  }
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
