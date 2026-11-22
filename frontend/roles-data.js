// Settings > Roles and the role assignment in Settings > Users (roles plan R3, parts B and C): the data side over the
// Roles API, /api/organization/roles (backend/src/routes/permissionRoles.js, contract docs/ai/roles-r2-contract.md
// section 5). The server decides everything - who may read, what each role offers (`actions`), what the caller holds
// (`held`, `delegable`) and every refusal - so nothing here is the protection; the screens only show what the API
// returns. One write at a time, each with its requestKey; a lost answer is checked by sending the same request again.
import { api } from "./api.js";
import { CENTRAL_CALENDAR_WRITE_BOUND_MS, centralCalendarErrorInfo, centralCalendarOutcomeUnknown, newCentralCalendarRequestKey } from "./central-calendar-data.js";
import { emptyRolesState as emptyRoles, state } from "./state.js";

export const ROLES_BASE = "/api/organization/roles";
export const newRolesRequestKey = newCentralCalendarRequestKey;
export const rolesOutcomeUnknown = centralCalendarOutcomeUnknown;

let generation = 0;
let whoGeneration = 0;

const rs = () => state.roles;

// Who is offered the tab, from today's /me facts alone (a later change switches this to /me `permissions`): a
// platform admin in the platform workspace (system roles) or in a club workspace, and the club's admin in that
// club's workspace. The Roles API answers everyone else the one 404.
export function rolesContext(data = state.organization?.data) {
  const user = state.currentUser;
  const ws = user?.activeWorkspace || null;
  const platform = data?.isPlatformAdmin === true;
  if (ws?.type === "club" && ws.scopeId) {
    const clubId = String(ws.scopeId);
    const admin = (user.clubs || []).some((club) => String(club?.id) === clubId && club?.role === "club_admin");
    return admin || platform ? { clubId, platform } : null;
  }
  if (platform && ws?.type === "platform") return { clubId: "", platform: true };
  return null;
}

export function resetRolesForWorkspaceChange() {
  state.roles = emptyRoles();
  generation += 1;
  whoGeneration += 1;
}

const query = (params) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") q.set(key, value);
  const text = q.toString();
  return text ? `?${text}` : "";
};

export function describeRolesReadError(error) {
  const status = Number(error?.status) || 0;
  if (status === 401) return "Please sign in again to see the roles.";
  if (status === 403 || status === 404) return "Roles are not available in this workspace.";
  return "The roles could not be read. Try again.";
}

export function enterRolesSection() {
  const d = rs();
  d.notice = "";
  if (!d.form && !d.command) d.stale = true;
}

export function rolesNeedLoad() {
  const ctx = rolesContext();
  const d = rs();
  if (!ctx || d.loading) return false;
  if (d.ctxKey !== (ctx.clubId || "system")) return true;
  return d.stale || (!d.roles && !d.error);
}

// The catalog and every role (active and archived: the screen filters), for the club on screen or the system.
export async function loadRoles(render) {
  const ctx = rolesContext();
  const d = rs();
  if (!ctx) return;
  const key = ctx.clubId || "system";
  if (d.ctxKey !== key) {
    const { assign, who } = d;
    Object.assign(d, emptyRoles(), { ctxKey: key, assign, who });
  }
  const mine = ++generation;
  d.loading = true;
  d.stale = false;
  render?.();
  try {
    const [catalog, list] = await Promise.all([
      api(`${ROLES_BASE}/catalog${query({ clubId: ctx.clubId })}`),
      api(`${ROLES_BASE}${query({ clubId: ctx.clubId, state: "all" })}`),
    ]);
    if (mine !== generation || state.roles !== d) return;
    d.catalog = normalizeCatalog(catalog);
    d.roles = Array.isArray(list?.roles) ? list.roles : [];
    d.error = "";
  } catch (error) {
    if (mine !== generation || state.roles !== d) return;
    d.error = describeRolesReadError(error);
  } finally {
    if (mine === generation && state.roles === d) d.loading = false;
  }
  render?.();
}

export function normalizeCatalog(raw) {
  return {
    modules: Array.isArray(raw?.modules) ? raw.modules : [],
    permissions: Array.isArray(raw?.permissions) ? raw.permissions : [],
    groups: Array.isArray(raw?.groups) ? raw.groups : [],
    held: Array.isArray(raw?.held) ? raw.held : [],
    delegable: Array.isArray(raw?.delegable) ? raw.delegable : [],
  };
}

// One role with its history (P3). The server answers the identical 404 for a role it does not show.
export async function loadRoleDetail(roleId) {
  const ctx = rolesContext();
  return api(`${ROLES_BASE}/${encodeURIComponent(roleId)}${query({ clubId: ctx?.clubId })}`);
}

export function sendRolesWrite({ path, body }) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(CENTRAL_CALENDAR_WRITE_BOUND_MS) : undefined;
  return api(`${ROLES_BASE}${path}`, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}

export function rolesErrorInfo(error) {
  const data = error?.data && typeof error.data === "object" ? error.data : null;
  return {
    ...centralCalendarErrorInfo(error),
    words: Array.isArray(data?.words) ? data.words.filter((w) => typeof w === "string") : [],
    count: Number.isInteger(data?.count) ? data.count : null,
    assignmentId: typeof data?.assignmentId === "string" ? data.assignmentId : "",
  };
}

// Check result sends the same request again; only an answer given after the server read its request record (or for
// the body itself) settles the first one - the calendar's rule.
const SETTLING = new Set([
  "staleRevision", "role_name_taken", "role_not_editable", "role_archived", "role_has_assignments", "permission_not_held",
  "role_exceeds_your_permissions", "permission_not_delegable", "permission_not_honoured", "role_limit_reached", "permission_platform_only",
  "permission_scope_mismatch", "club_admin_requires", "scope_types_narrowed", "role_not_assignable_here", "assignment_exists",
  "assignment_already_revoked", "assignment_mismatch", "self_assignment", "user_inactive", "request_key_reused",
]);
export function rolesCheckSettles(info) {
  return info.status === 400 || SETTLING.has(info.code);
}

// ---------------------------------------------------------------------------
// The assignment form's roles of one club (Users), and who holds what (P8).
// ---------------------------------------------------------------------------
export function rolesUsersAvailable(data = state.organization?.data) {
  const d = rs();
  return !d.assign.unavailable && !d.who.unavailable && Boolean(data);
}

export async function loadRolesOfClub(clubId, render) {
  const d = rs();
  const a = d.assign;
  if (!clubId || a.byClub[clubId]?.loading || a.byClub[clubId]?.roles) return;
  a.byClub[clubId] = { loading: true, roles: null, error: "" };
  render?.();
  try {
    const list = await api(`${ROLES_BASE}${query({ clubId, state: "active" })}`);
    if (state.roles !== d) return;
    a.byClub[clubId] = { loading: false, roles: Array.isArray(list?.roles) ? list.roles : [], error: "" };
    a.known = true;
  } catch (error) {
    if (state.roles !== d) return;
    // One club's list failing does not hide the other functions: only "who holds what" answering 404 does.
    a.byClub[clubId] = { loading: false, roles: null, error: describeRolesReadError(error) };
  }
  render?.();
}

export function whoQueryOf(who) {
  return { clubId: who.clubId, roleId: who.roleId };
}

// Each call is its own generation and remembers the query it asked; only the newest answer is used, and the newest
// always clears `loading`. A filter changed during a read simply starts the next one.
export async function loadWho({ more = false } = {}, render) {
  const d = rs();
  const who = d.who;
  const mine = ++whoGeneration;
  const key = `${who.clubId}|${who.roleId}`;
  const cursor = more ? who.nextCursor : "";
  who.loading = true;
  who.pendingKey = key;
  who.error = "";
  render?.();
  try {
    const answer = await api(`${ROLES_BASE}/assignments${query({ clubId: who.clubId, roleId: who.roleId, cursor })}`);
    if (state.roles !== d || mine !== whoGeneration) return;
    const rows = Array.isArray(answer?.assignments) ? answer.assignments : [];
    who.rows = more ? [...who.rows, ...rows] : rows;
    who.nextCursor = typeof answer?.nextCursor === "string" ? answer.nextCursor : "";
    who.loaded = true;
    who.queryKey = key;
  } catch (error) {
    if (state.roles !== d || mine !== whoGeneration) return;
    const status = Number(error?.status) || 0;
    who.error = describeRolesReadError(error);
    if (status === 404) { who.unavailable = true; d.assign.unavailable = true; }
    who.loaded = true;
    who.queryKey = key;
  } finally {
    if (state.roles === d && mine === whoGeneration) { who.loading = false; who.pendingKey = ""; }
  }
  render?.();
}

export function whoNeedsLoad() {
  const who = rs().who;
  return !who.unavailable && (!who.loaded || who.queryKey !== `${who.clubId}|${who.roleId}`) && !(who.loading && who.pendingKey === `${who.clubId}|${who.roleId}`);
}

// Leaving the Users section or the Roles tab drops what was read; the next entry reads again.
export function markRolesUsersStale() {
  const d = rs();
  whoGeneration += 1; // a read begun before this cannot bring old rows back
  d.who.loading = false;
  d.who.pendingKey = "";
  d.who.loaded = false;
  d.who.rows = [];
  d.who.nextCursor = "";
  d.assign.byClub = {};
}
