// The Roles API (roles R2 contract, docs/ai/roles-r2-contract.md, section 5):
// the role editor (system roles for a platform admin, a club's roles for its
// admin), copies, archives and the non-basic assignments, over migration v84.
//
// Rules this module keeps:
//   * identity comes from the session only; a body never names an actor, a
//     basis or an owner other than the clubId of the resource;
//   * the scope of a call is the clubId it names (or the role's / the
//     assignment's own club); the active workspace is never read;
//   * 404 before 403, and no 403 at all: a missing or archived club, a club
//     where the caller holds nothing the route accepts, a role or assignment of
//     another club and a random id all answer the identical
//     404 {"error":"notFound"};
//   * every write is one transaction, READ COMMITTED, bounded right after
//     BEGIN; its request record (public.permission_requests) is the last write;
//     a replay with the same requestKey answers the current state after the
//     caller's standing is evaluated again; the COMMIT is bounded and an
//     uncertain one is verified by the request record (contract 5.3);
//   * every lock is taken before the first write, in the order of contract
//     4.3: for an assignment and a revocation the pair statement (both users
//     rows in id order) first; then public.lock_permission_actor (the acting
//     user's rows of the old tables, the assignment rows by id, the role rows
//     by id); the request record last;
//   * a refusal is a stable code and a fixed sentence, never database text.
//
// No route here grants or revokes a basic role (the old routes stay their only
// writers), so none of them can lower a count the headcount advisory locks
// protect (routes/organization.js, lockLoginDisableRows): none takes them.
import crypto from "node:crypto";
import pg from "pg";
import { pool } from "./db.js";
import { can, clubScope, GLOBAL_SCOPE, HONOURED_PERMISSIONS, PERMISSION_GROUPS, PERMISSIONS, STORABLE_PERMISSIONS, teamScope } from "./permissions.js";
import { clubOfScope, lockClubCeiling } from "./clubCeilingLock.js";

const { DatabaseError } = pg;

export const ROLE_LIMIT_PER_CLUB = 50;
export const ASSIGNMENT_PAGE_SIZE = 100;
const LOCK_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 10_000;
export const COMMIT_ANSWER_TIMEOUT_MS = 15_000;
export const UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS = 5_000;
const READ_ANSWER_TIMEOUT_MS = 15_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL = "00000000-0000-0000-0000-000000000000";
const PLATFORM_ADMIN_ROLE_ID = "00000000-0000-4000-8000-000000000841";
const CLUB_ADMIN_ROLE_ID = "00000000-0000-4000-8000-000000000842";
const ROLE_SCOPE_TYPES = ["club", "team", "private", "global"];
const MODULE_WORDS = PERMISSION_GROUPS.map((g) => g.key);
const RULE7_REQUIRED = Object.freeze(["staff.assign", "roles.manage"]);
const HONOURED = new Set(HONOURED_PERMISSIONS);
const STORABLE = new Set(STORABLE_PERMISSIONS);

// The text rule of v84's public.permission_text_ok (a copy of v40's): 1..max
// characters, none of the invisible or control characters, no blank at either
// end. Trimmed nowhere: a refused value is a 400.
const TEXT_FORBIDDEN = /[\u0001-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/u;
const TEXT_EDGE = /^[\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]|[\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]$/u;
export function textOk(value, max) {
  if (typeof value !== "string") return false;
  const length = [...value].length;
  return length >= 1 && length <= max && !TEXT_FORBIDDEN.test(value) && !TEXT_EDGE.test(value);
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------
export class RolesRefusal extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const refusal = (status, code, message, extra) => new RolesRefusal(status, code, message, extra);
const NOT_FOUND = () => refusal(404, "notFound", "Not found.");
const bad = (message) => refusal(400, "invalid_request", message);
const conflict = (code, message, extra) => refusal(409, code, message, extra);

const MESSAGES = {
  staleRevision: "The role was changed meanwhile. Review the current version and try again.",
  role_name_taken: "A role with this name already exists here.",
  role_not_editable: "This role cannot be changed this way.",
  role_archived: "The role is archived.",
  role_has_assignments: "The role is assigned; revoke its assignments before archiving it.",
  permission_not_held: "You can only give permissions you hold yourself.",
  role_exceeds_your_permissions: "The role holds permissions you do not hold.",
  permission_not_delegable: "This permission exists only in the Club admin role.",
  permission_not_honoured: "No part of the app checks this permission yet.",
  permission_not_available_yet: "This permission is not available yet.",
  club_admin_would_lack: "A club's own Club admin role would lack a permission its other roles hold there.",
  role_limit_reached: "This club already has the largest number of roles allowed.",
  permission_platform_only: "This permission belongs to no role.",
  permission_scope_mismatch: "A permission does not cover the places this role can be assigned.",
  club_admin_requires: "The Club admin role must keep this permission.",
  scope_types_narrowed: "A place cannot be removed from a role that was assigned.",
  role_not_assignable_here: "This role cannot be assigned here.",
  assignment_exists: "This person already holds this role here.",
  assignment_already_revoked: "This assignment has already ended.",
  assignment_mismatch: "The assignment is not the one you reviewed.",
  self_assignment: "Nobody assigns a role to themselves.",
  user_inactive: "This person's login is switched off.",
  request_key_reused: "This requestKey was already used for a different request; use a new key.",
  try_again: "The server is busy right now. Nothing was written; try again in a moment.",
  // Roles R4-3 (contract 9).
  closed_by_club_ceiling: "This permission is not in the club's licence.",
  admin_not_narrowable: "Only a platform administrator changes the Club admin role or a club admin's own rights.",
  custom_exists: "This person already has their own version of this role here.",
  custom_changed: "This person's own version of the role was changed meanwhile. Review it and try again.",
  version_changed: "The club's version of this role was changed meanwhile. Review it and try again.",
  question_outdated: "The default role changed again, or there is no pending question. Review the current state.",
  module_not_closable: "This part of the app cannot be closed for a club.",
  ceiling_unchanged: "Every part named is already in the state asked for.",
  holding_ambiguous: "This person holds this role here more than once; end one of them first.",
  self_custom: "Nobody changes their own rights.",
};
const refuse = (code, extra) => conflict(code, MESSAGES[code], extra);

// A COMMIT that PostgreSQL itself refused with an ordinary ERROR (a deferred
// guard): rolled back, nothing written. Anything else is verified.
function commitCertainlyRefused(error) {
  if (!(error instanceof DatabaseError)) return false;
  if (error.severity !== "ERROR" || typeof error.routine !== "string" || error.routine === "") return false;
  const code = String(error.code ?? "");
  return !/^(08|57P|XX)/.test(code) && code !== "40003";
}
// The database errors this module maps; every other one is a sanitized 500.
function classifyDatabaseError(error) {
  if (error instanceof RolesRefusal) return error;
  const code = error?.code;
  if (code === "55P03" || code === "40P01") return refuse("try_again");
  if (code === "23505" && error.constraint === "permission_roles_owner_name_key") return refuse("role_name_taken");
  if (code === "23505" && error.constraint === "user_role_assignments_active_key") return refuse("assignment_exists");
  // Roles R4 (contract 7.2, N4): a default-role change that would leave a club's own Club admin version short of a word
  // the club's other roles hold there; v92's rule-7 trigger raises it with this fixed message (no club named).
  if (code === "23514" && /a club's Club admin would lack a permission/.test(String(error?.message ?? ""))) return refuse("club_admin_would_lack");
  // R4-3: the same rule inside one club (a club version, the ceiling) - v92's permission_club_rule7_check.
  if (code === "23514" && /the club's Club admin would lack a permission/.test(String(error?.message ?? ""))) return refuse("club_admin_would_lack");
  if (code === "23514" && /club ceiling: this module cannot be closed/.test(String(error?.message ?? ""))) return refuse("module_not_closable");
  // A lost race on the first create (contract 7.2, 7.3): the live keys are the backstop of expectedRevision.
  if (code === "23505" && error.constraint === "permission_club_role_versions_live_key") return refuse("version_changed");
  if (code === "23505" && error.constraint === "permission_custom_roles_live_key") return refuse("custom_changed");
  return null;
}

// ---------------------------------------------------------------------------
// Test seams (never set by the application)
// ---------------------------------------------------------------------------
let commitFault = null;
let uncertainCheckFault = null;
let commitTimeoutMs = COMMIT_ANSWER_TIMEOUT_MS;
let uncertainCheckTimeoutMs = UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS;
let beforeLocksHold = null;
let afterBeginHold = null;
let writeHold = null;
let statementRecorder = null;
export function setRolesCommitForTests({ fault = null, timeoutMs = COMMIT_ANSWER_TIMEOUT_MS, checkFault = null, checkTimeoutMs = UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS } = {}) {
  commitFault = fault; commitTimeoutMs = timeoutMs; uncertainCheckFault = checkFault; uncertainCheckTimeoutMs = checkTimeoutMs;
}
// Runs inside a write's transaction right after its bounds, before the replay check.
export function setRolesAfterBeginHoldForTests(fn) { afterBeginHold = fn ?? null; }
// Runs inside a write's transaction after the replay check, before the first lock.
export function setRolesBeforeLocksHoldForTests(fn) { beforeLocksHold = fn ?? null; }
// Runs inside a write's transaction after every lock and check, before the first write.
export function setRolesWriteHoldForTests(fn) { writeHold = fn ?? null; }
// Receives every SQL text a write transaction sends, in order.
export function setRolesStatementRecorderForTests(fn) { statementRecorder = fn ?? null; }

function withinBound(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function guardClient(client) {
  const onError = () => {};
  client.on("error", onError);
  return (destroy = false) => {
    client.removeListener("error", onError);
    client.release(destroy ? true : undefined);
  };
}

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------
const isUuid = (v) => typeof v === "string" && UUID.test(v) && v.toLowerCase() !== NIL;
function requireUuid(value, field) {
  if (!isUuid(value)) throw bad(`${field} must be an id.`);
  return value.toLowerCase();
}
function optionalUuid(value, field) {
  if (value === undefined || value === null || value === "") return null;
  return requireUuid(value, field);
}
function requireText(value, field, max) {
  if (!textOk(value, max)) throw bad(`${field} is missing or not allowed.`);
  return value;
}
function optionalText(value, field, max) {
  if (value === undefined || value === null) return null;
  return requireText(value, field, max);
}
function requireWords(value, field) {
  if (!Array.isArray(value) || value.some((w) => typeof w !== "string")) throw bad(`${field} must be a list of permissions.`);
  const words = [...new Set(value)];
  if (words.length !== value.length) throw bad(`${field} names a permission twice.`);
  for (const w of words) if (!Object.hasOwn(PERMISSIONS, w)) throw bad(`${field} names an unknown permission.`);
  return words.sort();
}
function requireScopeTypes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((t) => !ROLE_SCOPE_TYPES.includes(t))) throw bad("scopeTypes must name club and/or team.");
  const types = [...new Set(value)];
  if (types.length !== value.length) throw bad("scopeTypes names a place twice.");
  return types.sort();
}
function optionalDisplay(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw bad("moduleDisplay must be an object.");
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!MODULE_WORDS.includes(k)) throw bad("moduleDisplay names an unknown module.");
    if (v !== "hidden" && v !== "locked") throw bad("moduleDisplay values are hidden or locked.");
    out[k] = v;
  }
  return out;
}
function requestHashOf(operation, parts) {
  const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
  return crypto.createHash("sha256").update(JSON.stringify({ operation, ...canonical(parts) })).digest("hex");
}

// ---------------------------------------------------------------------------
// Standing (the 404 gate before any lock): the session's authorization context
// ---------------------------------------------------------------------------
const isPlatform = (ctx) => can(ctx.authz, "platform.admin", GLOBAL_SCOPE);
async function activeClub(clubId, runner = pool) {
  if (!isUuid(clubId)) return null;
  const row = (await runner.query(`select id from public.clubs where id = $1 and coalesce(is_active, true)`, [clubId])).rows[0];
  return row ? row.id : null;
}
function standingAt(ctx, clubId) {
  const platform = isPlatform(ctx);
  return {
    platform,
    rolesManage: platform || (clubId != null && can(ctx.authz, "roles.manage", clubScope(clubId))),
    staffAssign: platform || (clubId != null && can(ctx.authz, "staff.assign", clubScope(clubId))),
  };
}
// The club named by a read, and the caller's standing there. No club: a
// platform admin only. Anything else: the identical 404.
async function gateClub(ctx, clubIdRaw, { needs = "any" } = {}) {
  const platform = isPlatform(ctx);
  if (clubIdRaw === undefined || clubIdRaw === null || clubIdRaw === "") {
    if (!platform) throw NOT_FOUND();
    return { clubId: null, standing: standingAt(ctx, null) };
  }
  const clubId = await activeClub(String(clubIdRaw).toLowerCase());
  if (!clubId) throw NOT_FOUND();
  const standing = standingAt(ctx, clubId);
  const ok = needs === "roles" ? standing.rolesManage : needs === "staff" ? standing.staffAssign : standing.rolesManage || standing.staffAssign;
  if (!ok) throw NOT_FOUND();
  return { clubId, standing };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
async function boundedRead(work) {
  const client = await pool.connect();
  const release = guardClient(client);
  let dead = false;
  try {
    return await withinBound((async () => {
      await client.query("begin isolation level repeatable read read only");
      await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      const out = await work(client);
      await client.query("rollback");
      return out;
    })(), READ_ANSWER_TIMEOUT_MS);
  } catch (error) {
    dead = true;
    throw classifyDatabaseError(error) ?? error;
  } finally {
    release(dead);
  }
}

const ROLE_COLUMNS = `r.id, r.owner_scope, r.owner_club_id, r.name, r.description, r.assignable_club, r.assignable_team,
  r.assignable_private, r.assignable_global, r.is_basic, r.basic_key, r.copied_from_role_id, r.copied_from_revision,
  r.revision, r.archived_at, r.created_at, r.updated_at,
  array(select i.permission_word from public.permission_role_items i where i.role_id = r.id order by 1) as items`;

const scopeTypesOf = (r) => ROLE_SCOPE_TYPES.filter((t) => r[`assignable_${t}`]);

// Holders of a role: in a club (its scope and its teams) or everywhere.
async function holderCount(client, role, clubId) {
  if (role.basic_key === "platform_admin") {
    return clubId ? 0 : Number((await client.query(`select count(*)::int as n from public.user_global_roles g join public.users u on u.id = g.user_id where g.role = 'platform_admin' and g.is_active and u.is_active`)).rows[0].n);
  }
  if (role.basic_key === "independent_coach") {
    return clubId ? 0 : Number((await client.query(`select count(*)::int as n from public.user_global_roles g join public.users u on u.id = g.user_id where g.role = 'independent_coach' and g.is_active and u.is_active`)).rows[0].n);
  }
  if (role.basic_key === "club_admin") {
    return Number((await client.query(`select count(*)::int as n from public.user_club_roles r join public.users u on u.id = r.user_id
       where r.role = 'club_admin' and r.is_active and u.is_active and ($1::uuid is null or r.club_id = $1)`, [clubId])).rows[0].n);
  }
  if (role.basic_key === "team_coach") {
    return Number((await client.query(`select count(*)::int as n from public.user_team_roles r join public.users u on u.id = r.user_id join public.teams t on t.id = r.team_id
       where r.role = 'team_coach' and r.is_active and u.is_active and ($1::uuid is null or t.club_id = $1)`, [clubId])).rows[0].n);
  }
  return Number((await client.query(`select count(*)::int as n from public.user_role_assignments a
     left join public.teams t on a.scope_type = 'team' and t.id = a.scope_id
    where a.role_id = $1 and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())
      and ($2::uuid is null or (a.scope_type = 'club' and a.scope_id = $2) or (a.scope_type = 'team' and t.club_id = $2))`, [role.id, clubId])).rows[0].n);
}

// What the caller may do with a role, for the client's buttons; the server decides again on every write.
function actionsFor(role, standing, clubId) {
  const own = role.owner_scope === "club" && clubId != null && String(role.owner_club_id) === String(clubId);
  const archived = role.archived_at != null;
  const edit = !archived && role.basic_key !== "platform_admin" && (role.owner_scope === "system" ? standing.platform : (standing.platform || (own && standing.rolesManage)));
  return {
    change: edit,
    archive: edit && !role.is_basic,
    copy: !archived && role.basic_key !== "platform_admin" && clubId != null && (role.owner_scope === "system" || standing.platform) && standing.rolesManage,
    assign: !archived && !role.is_basic && clubId != null && standing.staffAssign && (role.owner_scope === "system" || own),
  };
}

function roleView(role, { holderCount: holders, actions }) {
  return {
    id: role.id,
    owner: { scope: role.owner_scope, clubId: role.owner_club_id },
    name: role.name,
    description: role.description,
    scopeTypes: scopeTypesOf(role),
    isBasic: role.is_basic,
    basicKey: role.basic_key,
    revision: role.revision,
    archived: role.archived_at != null,
    items: role.items,
    holderCount: holders,
    actions,
  };
}

export async function getCatalog(ctx, query) {
  const { clubId, standing } = await gateClub(ctx, query.clubId);
  return boundedRead(async (client) => {
    let held;
    if (standing.platform) held = Object.keys(PERMISSIONS);
    else {
      const rows = (await client.query(`select word from public.permissions p where public.user_has_permission($1, p.word, 'club', $2) order by p.sort_order`, [ctx.userId, clubId])).rows;
      held = rows.map((r) => r.word);
    }
    const permissions = (await client.query(`select p.word, p.module_word, p.platform_only, p.system_role_only,
        array(select s.scope_type from public.permission_scope_types s where s.permission_word = p.word order by 1) as scope_types
      from public.permissions p order by p.sort_order`)).rows.map((p) => ({
      word: p.word, module: p.module_word, scopeTypes: p.scope_types, platformOnly: p.platform_only,
      systemRoleOnly: p.system_role_only, honoured: HONOURED.has(p.word), storable: STORABLE.has(p.word), checked: HONOURED.has(p.word),
    }));
    const modules = (await client.query(`select word, label from public.permission_modules order by sort_order`)).rows;
    const systemOnly = new Set(permissions.filter((p) => p.systemRoleOnly).map((p) => p.word));
    return {
      modules,
      permissions,
      groups: PERMISSION_GROUPS.map((g) => ({ key: g.key, label: g.label, permissions: g.permissions, levels: g.levels })),
      held,
      delegable: held.filter((w) => !systemOnly.has(w)),
    };
  });
}

const STATES = new Set(["active", "archived", "all"]);
export async function listRoles(ctx, query) {
  const state = query.state === undefined ? "active" : query.state;
  if (!STATES.has(state)) throw bad("state must be active, archived or all.");
  const { clubId, standing } = await gateClub(ctx, query.clubId);
  return boundedRead(async (client) => {
    const rows = (await client.query(`select ${ROLE_COLUMNS} from public.permission_roles r
       where (r.owner_scope = 'system' or r.owner_club_id = $1)
         and ($2 = 'all' or ($2 = 'active') = (r.archived_at is null))
       order by r.owner_scope desc, r.is_basic desc, lower(r.name), r.id`, [clubId, state])).rows;
    const roles = [];
    for (const r of rows) roles.push(roleView(r, { holderCount: await holderCount(client, r, clubId), actions: actionsFor(r, standing, clubId) }));
    return { roles };
  });
}

// The club of a role-level read or write: the role's own club; for a system
// role the clubId the caller names (a platform admin may name none).
async function gateRole(ctx, roleIdRaw, clubIdRaw, needs) {
  if (!isUuid(roleIdRaw)) throw NOT_FOUND();
  const roleId = roleIdRaw.toLowerCase();
  const role = (await pool.query(`select id, owner_scope, owner_club_id from public.permission_roles where id = $1`, [roleId])).rows[0];
  if (!role) throw NOT_FOUND();
  const platform = isPlatform(ctx);
  if (role.owner_scope === "club") {
    if (clubIdRaw && String(clubIdRaw).toLowerCase() !== String(role.owner_club_id)) throw NOT_FOUND();
    const gate = await gateClub(ctx, role.owner_club_id, { needs });
    return { roleId, role, ...gate };
  }
  if (!clubIdRaw && platform) return { roleId, role, clubId: null, standing: standingAt(ctx, null) };
  const gate = await gateClub(ctx, clubIdRaw, { needs });
  return { roleId, role, ...gate };
}

export async function getRole(ctx, roleIdRaw, query) {
  const { roleId, clubId, standing } = await gateRole(ctx, roleIdRaw, query.clubId, "any");
  return boundedRead(async (client) => readRole(client, roleId, clubId, standing, { history: true }));
}

async function readRole(client, roleId, clubId, standing, { history = false } = {}) {
  const r = (await client.query(`select ${ROLE_COLUMNS} from public.permission_roles r where r.id = $1`, [roleId])).rows[0];
  if (!r) return null;
  const view = roleView(r, { holderCount: await holderCount(client, r, clubId), actions: actionsFor(r, standing, clubId) });
  view.moduleDisplay = Object.fromEntries((await client.query(`select module_word, display from public.permission_role_module_display where role_id = $1 order by 1`, [roleId])).rows.map((d) => [d.module_word, d.display]));
  if (r.copied_from_role_id) {
    const source = (await client.query(`select revision from public.permission_roles where id = $1`, [r.copied_from_role_id])).rows[0];
    view.copiedFrom = { roleId: r.copied_from_role_id, revision: r.copied_from_revision, sourceChangedSince: source ? source.revision > r.copied_from_revision : false };
  } else view.copiedFrom = null;
  if (history) {
    view.history = (await client.query(`select revision_after, kind, basis, reason, name_before, name_after, description_changed, items_added, items_removed,
        scope_types_added, display_after, created_at, (performed_by_user_id is null) as by_migration
      from public.permission_role_changes where role_id = $1 order by revision_after`, [roleId])).rows.map((h) => (
      // A system role's history, read by anyone but a platform admin, carries only what changed and when: a platform
      // admin's free-text reason, the basis and the names never reach the clubs (the security review's S1).
      r.owner_scope === "system" && !standing?.platform
        ? { revision: h.revision_after, kind: h.kind, itemsAdded: h.items_added, itemsRemoved: h.items_removed, at: h.created_at, byMigration: h.by_migration }
        : {
          revision: h.revision_after, kind: h.kind, basis: h.basis, reason: h.reason, nameBefore: h.name_before, nameAfter: h.name_after,
          descriptionChanged: h.description_changed, itemsAdded: h.items_added, itemsRemoved: h.items_removed, scopeTypesAdded: h.scope_types_added,
          moduleDisplay: h.display_after, at: h.created_at, byMigration: h.by_migration,
        }));
  }
  return view;
}

// ---------------------------------------------------------------------------
// The write runner (contract 5.3)
// ---------------------------------------------------------------------------
const REQUEST_KEY_LOCK_SQL = `select pg_advisory_xact_lock(hashtextextended('permission_request:' || $1, 0))`;
const ACTOR_SQL = `select set_config('optimove.permission_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const PAIR_SQL = `select u.id from public.users u where u.id in ($1, $2) order by u.id for share`;
const LOCK_ACTOR_SQL = `select public.lock_permission_actor($1, $2, $3, $4, $5, $6, $7) as basis`;

function recording(client) {
  if (!statementRecorder) return client;
  const send = client.query.bind(client);
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "query") return (...args) => { const t = typeof args[0] === "string" ? args[0] : args[0]?.text; if (t) statementRecorder(t.replace(/\s+/g, " ").trim(), args[1]); return send(...args); };
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

async function runWrite(ctx, { operation, requestKey, requestHash, prepare, write, reread, standingFor }) {
  const raw = await pool.connect();
  const release = guardClient(raw);
  const client = recording(raw);
  let released = false;
  const finish = async (destroy = false) => {
    if (released) return;
    released = true;
    let dead = destroy;
    if (!destroy) await withinBound(raw.query("rollback"), 5_000).catch(() => { dead = true; });
    release(dead);
  };
  try {
    await client.query("begin isolation level read committed");
    await client.query(`set local lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await client.query(`set local idle_in_transaction_session_timeout = '${IDLE_TIMEOUT_MS}ms'`);
    if (afterBeginHold) await afterBeginHold();
    // 0. Two requests of one caller with one key wait for each other here, so the second
    //    replays the first's committed answer instead of meeting its effect as a 409
    //    (idempotency under concurrency). Always the first lock; only same-key requests of
    //    the same caller share it, so it adds no lock-order edge between different requests.
    await client.query(REQUEST_KEY_LOCK_SQL, [`${String(ctx.userId).toLowerCase()}:${requestKey}`]);
    // 1. Replay: a request record of this caller and key.
    const earlier = (await client.query(`select id, operation, request_hash, role_change_id, assignment_id, owner_club_id,
        ceiling_change_id, club_version_change_id, custom_role_change_id
        from public.permission_requests where requested_by_user_id = $1 and request_key = $2`, [ctx.userId, requestKey])).rows[0];
    if (earlier) {
      if (earlier.operation !== operation || earlier.request_hash !== requestHash) throw refuse("request_key_reused");
      // The caller's standing is evaluated again (a retry never reuses the first decision).
      if (!(await standingFor(client, earlier.owner_club_id))) throw NOT_FOUND();
      const current = await reread(client, earlier);
      await finish();
      if (!current) throw NOT_FOUND();
      return { ...current, replayed: true };
    }
    if (beforeLocksHold) await beforeLocksHold();
    // 2. The acting user, then every lock (prepare), then 3. every check under the locks.
    await client.query(ACTOR_SQL, [String(ctx.userId).toLowerCase()]);
    const prepared = await prepare(client);
    if (writeHold) await writeHold();
    // 4. The writes; the change row; the request record last.
    const written = await write(client, prepared);
    await client.query(`insert into public.permission_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis,
        role_change_id, assignment_id, ceiling_change_id, club_version_change_id, custom_role_change_id)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [requestKey, ctx.userId, operation, requestHash, written.ownerClubId ? "club" : "system", written.ownerClubId, prepared.basis,
      written.roleChangeId ?? null, written.assignmentId ?? null, written.ceilingChangeId ?? null,
      written.clubVersionChangeId ?? null, written.customRoleChangeId ?? null]);
    // 5. Every deferred guard now, so a refusal is definite before the COMMIT.
    await client.query("set constraints all immediate");
    // 6. The bounded COMMIT.
    let commitError = null;
    try {
      const commit = commitFault ? commitFault(raw) : raw.query("commit");
      commit.catch(() => {});
      await withinBound(commit, commitTimeoutMs);
      released = true;
      release();
    } catch (error) {
      commitError = error;
      released = true;
      release(true);
    }
    if (commitError) {
      if (commitCertainlyRefused(commitError)) throw classifyDatabaseError(commitError) ?? commitError;
      console.error(`[roles] the COMMIT of ${operation} was not confirmed (${commitError?.code ?? ""}); checking the request record`);
      let found = false;
      try { found = await requestCommitted(ctx.userId, requestKey); } catch { found = false; }
      if (!found) throw refusal(503, "outcome_unknown", "The database did not confirm this request, and it could not be verified yet. Repeat it with the same requestKey.", { requestKey });
      return { ...(await answerAfterCommit(written, reread)), replayed: false, verified_after_commit_error: true };
    }
    return { ...(await answerAfterCommit(written, reread)), replayed: false };
  } catch (error) {
    await finish();
    const mapped = classifyDatabaseError(error);
    if (mapped) throw mapped;
    throw error;
  } finally {
    if (!released) await finish(true);
  }
}
async function requestCommitted(userId, requestKey) {
  const client = await pool.connect();
  const release = guardClient(client);
  let dead = false;
  try {
    return await withinBound((async () => {
      if (uncertainCheckFault) await uncertainCheckFault(client);
      return (await client.query(`select 1 from public.permission_requests where requested_by_user_id = $1 and request_key = $2`, [userId, requestKey])).rowCount > 0;
    })(), uncertainCheckTimeoutMs);
  } catch (error) {
    dead = true;
    throw error;
  } finally {
    release(dead);
  }
}
// A failed read after a confirmed COMMIT still answers 200, with readError.
async function answerAfterCommit(written, reread) {
  try {
    const current = await boundedRead((client) => reread(client, written));
    if (current) return current;
  } catch { /* below */ }
  return { readError: true, ...(written.ids || {}) };
}

// Under the locks: the acting user's basis for the club (or the platform).
// The club's ceiling lock (R4 contract 7.6, place 0) comes before it, taken by the caller as the first statement of
// prepare (takeClubLock), never inside: the pair statement and this function lock rows.
async function takeClubLock(client, scopeType, scopeId) {
  await lockClubCeiling(client, [await clubOfScope(client, scopeType, scopeId)], "shared");
}
// allSystemRoles: a club version writer (R4 7.2, H4) locks every non-archived system role row FOR SHARE in place 4.
async function lockActor(client, ctx, { scopeType, scopeId, roleForUpdate = null, assignmentForUpdate = null, roleForShare = null, allSystemRoles = false }) {
  return (await client.query(LOCK_ACTOR_SQL, [ctx.userId, scopeType, scopeId, roleForUpdate, assignmentForUpdate, roleForShare, allSystemRoles])).rows[0].basis;
}
const holdsSql = async (client, userId, word, clubId) => (await client.query(`select public.user_has_permission($1, $2, 'club', $3) as ok`, [userId, word, clubId])).rows[0].ok;
async function missingWords(client, ctx, words, clubId, basis) {
  if (basis === "platform_admin") return [];
  const missing = [];
  for (const w of words) if (!clubId || !(await holdsSql(client, ctx.userId, w, clubId))) missing.push(w);
  return missing;
}
async function lockedRole(client, roleId) {
  return (await client.query(`select ${ROLE_COLUMNS} from public.permission_roles r where r.id = $1`, [roleId])).rows[0] || null;
}

// The item rules of contract 2.4 and 3.3, in the order of the refusals.
function itemRuleRefusal(words, { basicKey, scopeTypes }) {
  for (const w of words) if (PERMISSIONS[w].platformOnly) return refuse("permission_platform_only", { words: [w] });
  for (const w of words) if (PERMISSIONS[w].systemRoleOnly && basicKey !== "club_admin") return refuse("permission_not_delegable", { words: [w] });
  for (const w of words) if (!STORABLE.has(w)) return refuse("permission_not_honoured", { words: [w] });
  // Roles R4 (O6): a storable word that no route checks yet is locked - never added, never taken away.
  for (const w of words) if (!HONOURED.has(w)) return refuse("permission_not_available_yet", { words: [w] });
  for (const w of words) if (scopeTypes.some((t) => !PERMISSIONS[w].scopeTypes.includes(t))) return refuse("permission_scope_mismatch", { words: [w] });
  return null;
}
// Rule 7, read from the catalog: after this change, Club admin holds
// staff.assign and roles.manage and every club-scope word of every other
// non-archived system role.
async function rule7Refusal(client, { roleId, items, archiving = false }) {
  const rows = (await client.query(`select r.id, r.basic_key, r.archived_at,
      array(select i.permission_word from public.permission_role_items i where i.role_id = r.id) as items
      from public.permission_roles r where r.owner_scope = 'system' and r.archived_at is null and r.basic_key is distinct from 'platform_admin'`)).rows;
  const itemsOf = new Map(rows.map((r) => [r.id, r.items]));
  if (roleId) {
    if (archiving) itemsOf.delete(roleId);
    else if (itemsOf.has(roleId) || items) itemsOf.set(roleId, items ?? itemsOf.get(roleId));
  }
  const clubAdmin = new Set(itemsOf.get(CLUB_ADMIN_ROLE_ID) || []);
  for (const w of RULE7_REQUIRED) if (!clubAdmin.has(w)) return refuse("club_admin_requires", { words: [w] });
  for (const [id, words] of itemsOf) {
    if (id === CLUB_ADMIN_ROLE_ID) continue;
    const lacking = words.filter((w) => PERMISSIONS[w].scopeTypes.includes("club") && !clubAdmin.has(w));
    if (lacking.length) return refuse("club_admin_requires", { words: lacking });
  }
  return null;
}
async function nameRefusal(client, { ownerClubId, name, exceptRoleId = null }) {
  const taken = (await client.query(`select 1 from public.permission_roles
      where archived_at is null and id is distinct from $3
        and lower(name) = lower($2)
        and (coalesce(owner_club_id, '${NIL}'::uuid) = coalesce($1::uuid, '${NIL}'::uuid) or ($1::uuid is not null and owner_scope = 'system'))`,
  [ownerClubId, name, exceptRoleId])).rowCount > 0;
  return taken ? refuse("role_name_taken") : null;
}
async function writeItems(client, ctx, roleId, add, remove, actorIsSet = true) {
  for (const w of remove) await client.query(`delete from public.permission_role_items where role_id = $1 and permission_word = $2`, [roleId, w]);
  for (const w of add) await client.query(`insert into public.permission_role_items (role_id, permission_word, added_by_user_id) values ($1, $2, $3)`, [roleId, w, actorIsSet ? ctx.userId : null]);
}
async function writeDisplay(client, roleId, display) {
  if (!display) return;
  await client.query(`delete from public.permission_role_module_display where role_id = $1`, [roleId]);
  for (const [module, value] of Object.entries(display)) {
    await client.query(`insert into public.permission_role_module_display (role_id, module_word, display) values ($1, $2, $3)`, [roleId, module, value]);
  }
}
async function insertChange(client, ctx, row) {
  return (await client.query(`insert into public.permission_role_changes (role_id, revision_after, kind, performed_by_user_id, basis, reason, name_before, name_after,
      description_changed, items_added, items_removed, scope_types_added, display_after, copied_from_role_id)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
  [row.roleId, row.revision, row.kind, ctx.userId, row.basis, row.reason ?? null, row.nameBefore ?? null, row.nameAfter ?? null,
    row.descriptionChanged ?? false, row.itemsAdded ?? [], row.itemsRemoved ?? [], row.scopeTypesAdded ?? [],
    row.display ? JSON.stringify(row.display) : null, row.copiedFrom ?? null])).rows[0].id;
}
// The standing a role write needs for its owner, evaluated again under the
// transaction (a replay included): a platform admin, or a holder of roles.manage
// for the active club.
const roleStanding = (ctx) => async (client, ownerClubId) => {
  const row = (await client.query(`select public.permission_actor_basis($1, 'roles.manage', $2, $3) as basis,
      ($4::uuid is null or exists (select 1 from public.clubs where id = $4 and coalesce(is_active, true))) as club_ok`,
  [ctx.userId, ownerClubId ? "club" : "global", ownerClubId ?? NIL, ownerClubId ?? null])).rows[0];
  if (!row.club_ok) return false;
  return ownerClubId ? row.basis != null : row.basis === "platform_admin";
};
const staffStanding = (ctx) => async (client, ownerClubId) => {
  const row = (await client.query(`select public.permission_actor_basis($1, 'staff.assign', 'club', $2) as basis,
      exists (select 1 from public.clubs where id = $2 and coalesce(is_active, true)) as club_ok`, [ctx.userId, ownerClubId])).rows[0];
  return row.club_ok && row.basis != null;
};
const roleReread = (ctx, standing) => async (client, rec) => {
  let roleId = rec.roleId;
  if (!roleId && rec.role_change_id) roleId = (await client.query(`select role_id from public.permission_role_changes where id = $1`, [rec.role_change_id])).rows[0]?.role_id;
  if (!roleId) return null;
  const clubId = rec.ownerClubId ?? rec.owner_club_id ?? null;
  const role = await readRole(client, roleId, clubId, standing(clubId));
  return role ? { role, ...(rec.extra || {}) } : null;
};

// ---------------------------------------------------------------------------
// P4: create
// ---------------------------------------------------------------------------
export async function createRole(ctx, body) {
  const requestKey = requireUuid(body?.requestKey, "requestKey");
  const clubIdRaw = optionalUuid(body.clubId, "clubId");
  const name = requireText(body.name, "name", 80);
  const description = optionalText(body.description, "description", 500);
  const scopeTypes = requireScopeTypes(body.scopeTypes);
  const items = requireWords(body.items ?? [], "items");
  const display = optionalDisplay(body.moduleDisplay);
  const { clubId, standing } = clubIdRaw ? await gateClub(ctx, clubIdRaw, { needs: "roles" }) : await gateClub(ctx, null);
  const requestHash = requestHashOf("role_create", { clubId, name, description, scopeTypes, items, display });
  return runWrite(ctx, {
    operation: "role_create", requestKey, requestHash,
    standingFor: roleStanding(ctx),
    reread: roleReread(ctx, (c) => standingAt(ctx, c)),
    prepare: async (client) => {
      await takeClubLock(client, clubId ? "club" : "global", clubId);
      const basis = await lockActor(client, ctx, { scopeType: clubId ? "club" : "global", scopeId: clubId ?? NIL });
      if (clubId ? basis == null : basis !== "platform_admin") throw NOT_FOUND();
      // The basis also counts staff.assign; a role write needs roles.manage itself (as P9 re-checks staff.assign).
      if (!(await roleStanding(ctx)(client, clubId))) throw NOT_FOUND();
      if (clubId && !(await activeClub(clubId, client))) throw NOT_FOUND();
      if (scopeTypes.some((t) => t === "private" || t === "global")) throw refuse("role_not_assignable_here");
      const ruled = itemRuleRefusal(items, { basicKey: null, scopeTypes });
      if (ruled) throw ruled;
      const missing = await missingWords(client, ctx, items, clubId, basis);
      if (missing.length) throw refuse("permission_not_held", { words: missing });
      if (!clubId) { const r7 = await rule7Refusal(client, { roleId: "new", items }); if (r7) throw r7; }
      const named = await nameRefusal(client, { ownerClubId: clubId, name });
      if (named) throw named;
      if (clubId) {
        const n = Number((await client.query(`select count(*)::int as n from public.permission_roles where owner_club_id = $1 and archived_at is null`, [clubId])).rows[0].n);
        if (n >= ROLE_LIMIT_PER_CLUB) throw refuse("role_limit_reached");
      }
      return { basis };
    },
    write: async (client, { basis }) => {
      const roleId = (await client.query(`insert into public.permission_roles (owner_scope, owner_club_id, name, description, assignable_club, assignable_team, created_by_user_id)
          values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [clubId ? "club" : "system", clubId, name, description, scopeTypes.includes("club"), scopeTypes.includes("team"), ctx.userId])).rows[0].id;
      await writeItems(client, ctx, roleId, items, []);
      await writeDisplay(client, roleId, display);
      const roleChangeId = await insertChange(client, ctx, { roleId, revision: 1, kind: "create", basis, nameAfter: null, itemsAdded: items, scopeTypesAdded: scopeTypes, display });
      return { roleId, roleChangeId, ownerClubId: clubId, ids: { roleId } };
    },
  });
}

// ---------------------------------------------------------------------------
// P5: change, P6: archive
// ---------------------------------------------------------------------------
export async function changeRole(ctx, roleIdRaw, body) {
  const gate = await gateRole(ctx, roleIdRaw, body?.clubId, "roles");
  // Only a platform admin changes or archives a system role: anyone else gets the identical 404 here, before
  // runWrite, so no lock is ever taken on a system role row for them (the security review's S3).
  if (gate.role.owner_scope === "system" && !isPlatform(ctx)) throw NOT_FOUND();
  const requestKey = requireUuid(body?.requestKey, "requestKey");
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) throw bad("expectedRevision must be a revision.");
  const reason = requireText(body.reason, "reason", 500);
  const name = body.name === undefined ? undefined : requireText(body.name, "name", 80);
  const description = body.description === undefined ? undefined : (body.description === null ? null : requireText(body.description, "description", 500));
  const items = body.items === undefined ? undefined : requireWords(body.items, "items");
  const scopeTypes = body.scopeTypes === undefined ? undefined : requireScopeTypes(body.scopeTypes);
  const display = body.moduleDisplay === undefined ? undefined : optionalDisplay(body.moduleDisplay);
  if (name === undefined && description === undefined && items === undefined && scopeTypes === undefined && display === undefined) throw bad("Nothing to change.");
  const { roleId, role: owner } = gate;
  const ownerClubId = owner.owner_club_id;
  const requestHash = requestHashOf("role_change", { roleId, expectedRevision: body.expectedRevision, reason, name, description, items, scopeTypes, display });
  return runWrite(ctx, {
    operation: "role_change", requestKey, requestHash,
    standingFor: roleStanding(ctx),
    reread: roleReread(ctx, (c) => standingAt(ctx, c)),
    prepare: async (client) => {
      // R4 7.2 (H4): a change of a system role's items may write default_follow items into clubs' own Club admin
      // versions, so it takes the EXCLUSIVE ceiling lock of every club that has one (read without a lock; checked
      // again under the role's FOR UPDATE below), before any row lock. A club role takes its club's lock shared.
      let followLocked = [];
      if (ownerClubId) await takeClubLock(client, "club", ownerClubId);
      else if (items !== undefined) followLocked = await lockClubCeiling(client, await clubsWithLiveVersion(client, CLUB_ADMIN_ROLE_ID), "exclusive");
      const basis = await lockActor(client, ctx, { scopeType: ownerClubId ? "club" : "global", scopeId: ownerClubId ?? NIL, roleForUpdate: roleId });
      if (ownerClubId ? basis == null : basis !== "platform_admin") throw NOT_FOUND();
      if (!(await roleStanding(ctx)(client, ownerClubId))) throw NOT_FOUND();
      if (ownerClubId && !(await activeClub(ownerClubId, client))) throw NOT_FOUND();
      const role = await lockedRole(client, roleId);
      if (role.basic_key === "platform_admin") throw refuse("role_not_editable");
      if (role.archived_at) throw refuse("role_archived");
      if (role.revision !== body.expectedRevision) throw refuse("staleRevision", { current: await readRole(client, roleId, ownerClubId, standingAt(ctx, ownerClubId)) });
      const oldTypes = scopeTypesOf(role);
      const newTypes = scopeTypes ?? oldTypes;
      if (scopeTypes && role.is_basic && [...scopeTypes].sort().join() !== [...oldTypes].sort().join()) throw refuse("role_not_editable");
      if (newTypes.some((t) => t === "private" || t === "global") && !role.is_basic) throw refuse("role_not_assignable_here");
      const removedTypes = oldTypes.filter((t) => !newTypes.includes(t));
      if (removedTypes.length && (await client.query(`select 1 from public.user_role_assignments where role_id = $1 limit 1`, [roleId])).rowCount) throw refuse("scope_types_narrowed");
      const newItems = items ?? role.items;
      const add = newItems.filter((w) => !role.items.includes(w));
      const remove = role.items.filter((w) => !newItems.includes(w));
      const ruled = itemRuleRefusal(add, { basicKey: role.basic_key, scopeTypes: newTypes });
      if (ruled) throw ruled;
      // Roles R4 (O6): taking away a word no route checks yet is refused too, in every role (the basic roles
      // included: the seed is the only writer of their unchecked words, so a module's day-one old-vs-new holds).
      const lockedOut = remove.filter((w) => !HONOURED.has(w));
      if (lockedOut.length) throw refuse("permission_not_available_yet", { words: lockedOut });
      // Every kept item must cover a widened scope too.
      const uncovered = newItems.filter((w) => newTypes.some((t) => !PERMISSIONS[w].scopeTypes.includes(t)));
      if (uncovered.length) throw refuse("permission_scope_mismatch", { words: uncovered });
      const missing = await missingWords(client, ctx, add, ownerClubId, basis);
      if (missing.length) throw refuse("permission_not_held", { words: missing });
      if (basis !== "platform_admin" && (await missingWords(client, ctx, role.items, ownerClubId, basis)).length) throw refuse("role_exceeds_your_permissions");
      if (role.owner_scope === "system") { const r7 = await rule7Refusal(client, { roleId, items: newItems }); if (r7) throw r7; }
      if (name !== undefined && name !== role.name) { const named = await nameRefusal(client, { ownerClubId, name, exceptRoleId: roleId }); if (named) throw named; }
      const descriptionChanged = description !== undefined && description !== role.description;
      const nameChanged = name !== undefined && name !== role.name;
      const addedTypes = newTypes.filter((t) => !oldTypes.includes(t));
      if (!nameChanged && !descriptionChanged && !add.length && !remove.length && !addedTypes.length && !removedTypes.length && display === undefined) throw bad("Nothing to change.");
      const affected = await affectedBy(client, role, remove);
      const follow = role.owner_scope === "system" ? await defaultFollowPlan(client, role, add, followLocked) : [];
      // Q15: a word taken from a role does not reach the customs frozen from it; the answer names who still holds it.
      const stillHolding = await customsStillHolding(client, roleId, ownerClubId, remove);
      return { basis, role, add, remove, newTypes, addedTypes, nameChanged, descriptionChanged, affected, follow, stillHolding };
    },
    write: async (client, p) => {
      // default_follow first (the deferred rule-7 checks run at the end anyway; the version rows were locked by the
      // exclusive club locks taken at the start).
      for (const f of p.follow) {
        await client.query(`update public.permission_club_role_versions set revision = revision + 1 where id = $1`, [f.versionId]);
        for (const w of f.words) await client.query(`insert into public.permission_club_role_version_items (version_id, permission_word) values ($1, $2)`, [f.versionId, w]);
        await client.query(`insert into public.permission_club_role_version_changes (version_id, revision_after, kind, performed_by_user_id, basis, reason, items_added)
            values ($1, $2, 'default_follow', $3, 'platform_admin', $4, $5)`, [f.versionId, f.revision + 1, ctx.userId, reason, f.words]);
      }
      await client.query(`update public.permission_roles set revision = revision + 1, updated_at = now(),
          name = $2, description = $3, assignable_club = $4, assignable_team = $5 where id = $1`,
      [roleId, p.nameChanged ? name : p.role.name, p.descriptionChanged ? description : p.role.description,
        p.role.is_basic ? p.role.assignable_club : p.newTypes.includes("club"), p.role.is_basic ? p.role.assignable_team : p.newTypes.includes("team")]);
      await writeItems(client, ctx, roleId, p.add, p.remove);
      if (display !== undefined) await writeDisplay(client, roleId, display ?? {});
      const roleChangeId = await insertChange(client, ctx, {
        roleId, revision: p.role.revision + 1, kind: "change", basis: p.basis, reason,
        nameBefore: p.nameChanged ? p.role.name : null, nameAfter: p.nameChanged ? name : null,
        descriptionChanged: p.descriptionChanged, itemsAdded: p.add, itemsRemoved: p.remove, scopeTypesAdded: p.addedTypes,
        display: display === undefined ? null : (display ?? {}),
      });
      return {
        roleId, roleChangeId, ownerClubId, ids: { roleId },
        extra: {
          affected: p.affected, clubsTouched: p.follow.map((f) => ({ clubId: f.clubId, wordsAdded: f.words })),
          customsStillHolding: p.stillHolding.list, customsStillHoldingTruncated: p.stillHolding.truncated,
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Roles R4 helpers shared with permissionLayersService.js
// ---------------------------------------------------------------------------
// The clubs that have a live club version of a role (read without a lock: the caller locks them, then checks again).
async function clubsWithLiveVersion(client, roleId) {
  return (await client.query(`select distinct club_id from public.permission_club_role_versions where system_role_id = $1 and ended_at is null order by 1`, [roleId])).rows.map((r) => r.club_id);
}

// H4 (contract 7.2): a word added to a default role (not Club admin) is added to the live Club admin version of every
// club that follows that role (no live version of it), when that version lacks it - kind default_follow, by the
// platform admin. Every such club must be among the clubs whose exclusive lock this transaction took first; one that
// got its Club admin version since is a lost race: try_again (nothing written).
async function defaultFollowPlan(client, role, add, lockedClubs) {
  if (!add.length || role.basic_key === "club_admin") return [];
  const words = add.filter((w) => PERMISSIONS[w].scopeTypes.includes("club"));
  if (!words.length) return [];
  const versions = (await client.query(`select v.id, v.club_id, v.revision,
        array(select i.permission_word from public.permission_club_role_version_items i where i.version_id = v.id order by 1) as items,
        exists (select 1 from public.permission_club_role_versions o where o.club_id = v.club_id and o.system_role_id = $2 and o.ended_at is null) as own_version
      from public.permission_club_role_versions v where v.system_role_id = $1 and v.ended_at is null order by v.club_id`, [CLUB_ADMIN_ROLE_ID, role.id])).rows;
  const locked = new Set(lockedClubs.map(String));
  const plan = [];
  for (const v of versions) {
    if (!locked.has(String(v.club_id))) throw refuse("try_again");
    if (v.own_version) continue;
    const needed = words.filter((w) => !v.items.includes(w));
    if (needed.length) plan.push({ versionId: v.id, clubId: v.club_id, revision: v.revision, words: needed });
  }
  return plan;
}

// A live custom role whose holding is live now (contract 3.4: the same predicate as public.permission_user_holdings).
// `c` is a fixed SQL alias written by this module, never input.
export const customAliveSql = (c) => `(${c}.ended_at is null
  and exists (select 1 from public.users cu where cu.id = ${c}.user_id and cu.is_active)
  and exists (select 1 from public.permission_roles cr where cr.id = ${c}.base_role_id and cr.archived_at is null)
  and ((${c}.holding_assignment_id is not null and exists (select 1 from public.user_role_assignments ha
          where ha.id = ${c}.holding_assignment_id and ha.revoked_at is null and (ha.expires_at is null or ha.expires_at > now())))
    or (${c}.holding_row_table = 'user_club_roles' and exists (select 1 from public.user_club_roles hr
          where hr.id = ${c}.holding_row_id and hr.is_active and hr.updated_at = ${c}.holding_row_version))
    or (${c}.holding_row_table = 'user_team_roles' and exists (select 1 from public.user_team_roles hr
          where hr.id = ${c}.holding_row_id and hr.is_active and hr.updated_at = ${c}.holding_row_version))))`;

// Q15: the live customs of a role (in one club, or in every club for a null club) that still hold any of `words`; at
// most 200, `truncated` when there are more.
export const STILL_HOLDING_CAP = 200;
export async function customsStillHolding(client, roleId, clubId, words) {
  if (!words.length) return { list: [], truncated: false };
  const rows = await customsStillHoldingRows(client, roleId, clubId, words);
  return { list: rows.slice(0, STILL_HOLDING_CAP), truncated: rows.length > STILL_HOLDING_CAP };
}
async function customsStillHoldingRows(client, roleId, clubId, words) {
  return (await client.query(`select c.id, c.user_id, c.club_id, u.display_name,
        array(select i.permission_word from public.permission_custom_role_items i where i.custom_role_id = c.id and i.permission_word = any($3::text[]) order by 1) as words
      from public.permission_custom_roles c join public.users u on u.id = c.user_id
     where c.base_role_id = $1 and ($2::uuid is null or c.club_id = $2) and ${customAliveSql("c")}
       and exists (select 1 from public.permission_custom_role_items i where i.custom_role_id = c.id and i.permission_word = any($3::text[]))
     order by c.club_id, c.id limit ${STILL_HOLDING_CAP + 1}`, [roleId, clubId, words])).rows
    .map((r) => ({ customId: r.id, userId: r.user_id, clubId: r.club_id, name: r.display_name, words: r.words }));
}

// The people and clubs a change of the role reaches (P5's `affected`).
async function affectedBy(client, role, removed = []) {
  let row;
  if (role.basic_key === "club_admin") {
    row = (await client.query(`select count(distinct r.user_id)::int as people, count(distinct r.club_id)::int as clubs
      from public.user_club_roles r join public.users u on u.id = r.user_id where r.role = 'club_admin' and r.is_active and u.is_active`)).rows[0];
  } else if (role.basic_key === "team_coach") {
    row = (await client.query(`select count(distinct r.user_id)::int as people, count(distinct t.club_id)::int as clubs
      from public.user_team_roles r join public.users u on u.id = r.user_id join public.teams t on t.id = r.team_id where r.role = 'team_coach' and r.is_active and u.is_active`)).rows[0];
  } else {
    row = (await client.query(`select count(distinct a.user_id)::int as people,
        count(distinct coalesce(case when a.scope_type = 'club' then a.scope_id end, t.club_id))::int as clubs
      from public.user_role_assignments a left join public.teams t on a.scope_type = 'team' and t.id = a.scope_id
      where a.role_id = $1 and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())`, [role.id])).rows[0];
  }
  const affected = { people: Number(row.people), clubs: Number(row.clubs) };
  // Narrowing a system role is not retroactive for clubs' own roles: a club role that holds a removed word keeps it
  // (the security review's S4). The answer counts them, so the platform admin sees what the change does not reach.
  if (role.owner_scope === "system" && removed.length) {
    const kept = (await client.query(`select count(distinct r.id)::int as roles, count(distinct r.owner_club_id)::int as clubs,
        count(distinct a.user_id) filter (where a.id is not null)::int as people
      from public.permission_roles r
      join public.permission_role_items i on i.role_id = r.id and i.permission_word = any($1::text[])
      left join public.user_role_assignments a on a.role_id = r.id and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())
      where r.owner_scope = 'club' and r.archived_at is null`, [removed])).rows[0];
    affected.clubRolesKeepingRemovedWords = { roles: Number(kept.roles), clubs: Number(kept.clubs), people: Number(kept.people) };
  }
  return affected;
}

export async function archiveRole(ctx, roleIdRaw, body) {
  const gate = await gateRole(ctx, roleIdRaw, body?.clubId, "roles");
  // Only a platform admin changes or archives a system role: anyone else gets the identical 404 here, before
  // runWrite, so no lock is ever taken on a system role row for them (the security review's S3).
  if (gate.role.owner_scope === "system" && !isPlatform(ctx)) throw NOT_FOUND();
  const requestKey = requireUuid(body?.requestKey, "requestKey");
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) throw bad("expectedRevision must be a revision.");
  const reason = requireText(body.reason, "reason", 500);
  const { roleId, role: owner } = gate;
  const ownerClubId = owner.owner_club_id;
  const requestHash = requestHashOf("role_archive", { roleId, expectedRevision: body.expectedRevision, reason });
  return runWrite(ctx, {
    operation: "role_archive", requestKey, requestHash,
    standingFor: roleStanding(ctx),
    reread: roleReread(ctx, (c) => standingAt(ctx, c)),
    prepare: async (client) => {
      await takeClubLock(client, ownerClubId ? "club" : "global", ownerClubId);
      const basis = await lockActor(client, ctx, { scopeType: ownerClubId ? "club" : "global", scopeId: ownerClubId ?? NIL, roleForUpdate: roleId });
      if (ownerClubId ? basis == null : basis !== "platform_admin") throw NOT_FOUND();
      if (!(await roleStanding(ctx)(client, ownerClubId))) throw NOT_FOUND();
      if (ownerClubId && !(await activeClub(ownerClubId, client))) throw NOT_FOUND();
      const role = await lockedRole(client, roleId);
      if (role.is_basic) throw refuse("role_not_editable");
      if (role.archived_at) throw refuse("role_archived");
      if (role.revision !== body.expectedRevision) throw refuse("staleRevision", { current: await readRole(client, roleId, ownerClubId, standingAt(ctx, ownerClubId)) });
      if (basis !== "platform_admin" && (await missingWords(client, ctx, role.items, ownerClubId, basis)).length) throw refuse("role_exceeds_your_permissions");
      const assigned = Number((await client.query(`select count(*)::int as n from public.user_role_assignments a left join public.teams t on a.scope_type = 'team' and t.id = a.scope_id
          where a.role_id = $1 and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())`, [roleId])).rows[0].n);
      if (assigned > 0) throw refuse("role_has_assignments", { count: assigned });
      if (role.owner_scope === "system") { const r7 = await rule7Refusal(client, { roleId, archiving: true }); if (r7) throw r7; }
      return { basis, role };
    },
    write: async (client, p) => {
      await client.query(`update public.permission_roles set revision = revision + 1, updated_at = now(), archived_at = now(), archived_by_user_id = $2 where id = $1`, [roleId, ctx.userId]);
      const roleChangeId = await insertChange(client, ctx, { roleId, revision: p.role.revision + 1, kind: "archive", basis: p.basis, reason });
      return { roleId, roleChangeId, ownerClubId, ids: { roleId } };
    },
  });
}

// ---------------------------------------------------------------------------
// P7: copy
// ---------------------------------------------------------------------------
const COPY_SUFFIX = " (copy)";
export async function copyRole(ctx, roleIdRaw, body) {
  if (!isUuid(roleIdRaw)) throw NOT_FOUND();
  const requestKey = requireUuid(body?.requestKey, "requestKey");
  const clubIdRaw = requireUuid(body.clubId, "clubId");
  const nameIn = body.name === undefined || body.name === null ? null : requireText(body.name, "name", 80);
  const { clubId } = await gateClub(ctx, clubIdRaw, { needs: "roles" });
  const sourceId = roleIdRaw.toLowerCase();
  const source = (await pool.query(`select owner_scope, owner_club_id from public.permission_roles where id = $1`, [sourceId])).rows[0];
  // A club's admin copies a system role; a platform admin also any club's role.
  if (!source || (source.owner_scope === "club" && !isPlatform(ctx))) throw NOT_FOUND();
  const requestHash = requestHashOf("role_copy", { sourceId, clubId, name: nameIn });
  return runWrite(ctx, {
    operation: "role_copy", requestKey, requestHash,
    standingFor: roleStanding(ctx),
    reread: roleReread(ctx, (c) => standingAt(ctx, c)),
    prepare: async (client) => {
      await takeClubLock(client, "club", clubId);
      const basis = await lockActor(client, ctx, { scopeType: "club", scopeId: clubId, roleForShare: sourceId });
      if (basis == null) throw NOT_FOUND();
      if (!(await roleStanding(ctx)(client, clubId))) throw NOT_FOUND();
      if (!(await activeClub(clubId, client))) throw NOT_FOUND();
      const src = await lockedRole(client, sourceId);
      if (src.basic_key === "platform_admin") throw refuse("role_not_editable");
      if (src.archived_at) throw refuse("role_archived");
      const types = scopeTypesOf(src).filter((t) => t === "club" || t === "team");
      if (!types.length) throw refuse("role_not_assignable_here");
      const dropped = [];
      const items = [];
      for (const w of src.items) {
        if (PERMISSIONS[w].systemRoleOnly) dropped.push({ word: w, reason: "system_role_only" });
        // R4 (O6): a storable word no route checks yet is not copied (the copy is a new role; R2's rule that a role
        // holds only checked words stays); the answer names it as "not available yet".
        else if (!HONOURED.has(w)) dropped.push({ word: w, reason: STORABLE.has(w) ? "not_available_yet" : "not_honoured" });
        else if (basis !== "platform_admin" && !(await holdsSql(client, ctx.userId, w, clubId))) dropped.push({ word: w, reason: "not_held" });
        else items.push(w);
      }
      // Without a name: "<source name> (copy)" (O7: a club role never takes a current system
      // role's name); a long source name is cut so the whole fits 80 characters.
      const name = nameIn ?? `${[...src.name].slice(0, 80 - COPY_SUFFIX.length).join("").trimEnd()}${COPY_SUFFIX}`;
      if (!textOk(name, 80)) throw bad("name is missing or not allowed.");
      const named = await nameRefusal(client, { ownerClubId: clubId, name });
      if (named) throw named;
      const n = Number((await client.query(`select count(*)::int as n from public.permission_roles where owner_club_id = $1 and archived_at is null`, [clubId])).rows[0].n);
      if (n >= ROLE_LIMIT_PER_CLUB) throw refuse("role_limit_reached");
      return { basis, src, types, items, dropped, name };
    },
    write: async (client, p) => {
      const roleId = (await client.query(`insert into public.permission_roles (owner_scope, owner_club_id, name, description, assignable_club, assignable_team,
          copied_from_role_id, copied_from_revision, created_by_user_id) values ('club', $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [clubId, p.name, p.src.description, p.types.includes("club"), p.types.includes("team"), sourceId, p.src.revision, ctx.userId])).rows[0].id;
      await writeItems(client, ctx, roleId, p.items, []);
      const roleChangeId = await insertChange(client, ctx, { roleId, revision: 1, kind: "copy", basis: p.basis, itemsAdded: p.items, scopeTypesAdded: p.types, copiedFrom: sourceId });
      return { roleId, roleChangeId, ownerClubId: clubId, ids: { roleId }, extra: { dropped: p.dropped } };
    },
  });
}

// ---------------------------------------------------------------------------
// P8: who holds what
// ---------------------------------------------------------------------------
export async function listAssignments(ctx, query) {
  const { clubId } = await gateClub(ctx, query.clubId, { needs: "any" });
  const roleId = query.roleId ? (isUuid(query.roleId) ? query.roleId.toLowerCase() : (() => { throw bad("roleId must be an id."); })()) : null;
  const userId = query.userId ? (isUuid(query.userId) ? query.userId.toLowerCase() : (() => { throw bad("userId must be an id."); })()) : null;
  let after = null;
  if (query.cursor) {
    try { after = Buffer.from(String(query.cursor), "base64url").toString("utf8"); } catch { after = null; }
    if (!after || !/^[ab]:[0-9a-f-]{36}$/.test(after)) throw bad("cursor is not valid.");
  }
  return boundedRead(async (client) => {
    const rows = (await client.query(`
      with rows as (
        select 'a:' || r.id::text as sort_key, 'basic' as source, r.user_id, pr.id as role_id, pr.name as role_name, 'club' as scope_type, r.club_id as scope_id,
               r.club_id as club_id, null::text as title, r.granted_by_user_id, null::timestamptz as expires_at,
               case when r.is_active then 'active' else 'revoked' end as state, r.created_at,
               (select c.id from public.permission_custom_roles c where c.holding_row_table = 'user_club_roles' and c.holding_row_id = r.id
                   and ${customAliveSql("c")} limit 1) as custom_role_id
          from public.user_club_roles r join public.permission_roles pr on pr.basic_key = 'club_admin'
         where r.role = 'club_admin'
        union all
        select 'a:' || r.id::text, 'basic', r.user_id, pr.id, pr.name, 'team', r.team_id, t.club_id, null, r.granted_by_user_id, null,
               case when r.is_active then 'active' else 'revoked' end, r.created_at,
               (select c.id from public.permission_custom_roles c where c.holding_row_table = 'user_team_roles' and c.holding_row_id = r.id
                   and ${customAliveSql("c")} limit 1)
          from public.user_team_roles r join public.teams t on t.id = r.team_id join public.permission_roles pr on pr.basic_key = 'team_coach'
         where r.role = 'team_coach'
        union all
        select 'b:' || a.id::text, 'assignment', a.user_id, a.role_id, pr.name, a.scope_type, a.scope_id,
               case when a.scope_type = 'club' then a.scope_id else t.club_id end, a.display_title, a.granted_by_user_id, a.expires_at,
               case when a.revoked_at is not null then a.revoke_kind when a.expires_at is not null and a.expires_at <= now() then 'expired' else 'active' end,
               a.created_at,
               (select c.id from public.permission_custom_roles c where c.holding_assignment_id = a.id and ${customAliveSql("c")} limit 1)
          from public.user_role_assignments a join public.permission_roles pr on pr.id = a.role_id
          left join public.teams t on a.scope_type = 'team' and t.id = a.scope_id
      )
      select x.*, u.display_name as user_name from rows x join public.users u on u.id = x.user_id
       where ($1::uuid is null or x.club_id = $1) and ($2::uuid is null or x.role_id = $2) and ($3::uuid is null or x.user_id = $3)
         and ($4::text is null or x.sort_key > $4)
       order by x.sort_key limit ${ASSIGNMENT_PAGE_SIZE + 1}`, [clubId, roleId, userId, after])).rows;
    const page = rows.slice(0, ASSIGNMENT_PAGE_SIZE);
    return {
      assignments: page.map((r) => ({
        id: r.sort_key.slice(2), source: r.source, userId: r.user_id, userName: r.user_name, roleId: r.role_id, roleName: r.role_name,
        scopeType: r.scope_type, scopeId: r.scope_id, clubId: r.club_id, title: r.title, grantedBy: r.granted_by_user_id,
        expiresAt: r.expires_at, state: r.state, createdAt: r.created_at,
        // R4 (contract 9): a holding with a live custom role reads "<Role> (custom)".
        custom: r.custom_role_id != null, customRoleId: r.custom_role_id ?? null,
        displayName: r.custom_role_id != null ? `${r.role_name} (custom)` : r.role_name,
      })),
      nextCursor: rows.length > ASSIGNMENT_PAGE_SIZE ? Buffer.from(page[page.length - 1].sort_key, "utf8").toString("base64url") : null,
    };
  });
}

// ---------------------------------------------------------------------------
// P9: assign, P10: revoke
// ---------------------------------------------------------------------------
async function assignmentView(client, assignmentId) {
  const a = (await client.query(`select a.*, case when a.scope_type = 'club' then a.scope_id else t.club_id end as club_id,
        (a.expires_at is not null and a.expires_at <= now()) as lapsed
      from public.user_role_assignments a left join public.teams t on a.scope_type = 'team' and t.id = a.scope_id where a.id = $1`, [assignmentId])).rows[0];
  if (!a) return null;
  const state = a.revoked_at ? a.revoke_kind : (a.lapsed ? "expired" : "active");
  return {
    id: a.id, userId: a.user_id, roleId: a.role_id, scopeType: a.scope_type, scopeId: a.scope_id, clubId: a.club_id,
    title: a.display_title, grantBasis: a.grant_basis, grantedBy: a.granted_by_user_id, reason: a.grant_reason, expiresAt: a.expires_at,
    state, revokedAt: a.revoked_at, revokedBy: a.revoked_by_user_id, revokeReason: a.revoke_reason, createdAt: a.created_at,
  };
}
const assignmentReread = async (client, rec) => {
  const view = await assignmentView(client, rec.assignmentId ?? rec.assignment_id);
  return view ? { assignment: view } : null;
};

export async function assignRole(ctx, body) {
  const requestKey = requireUuid(body?.requestKey, "requestKey");
  const userId = requireUuid(body.userId, "userId");
  const roleId = requireUuid(body.roleId, "roleId");
  if (!ROLE_SCOPE_TYPES.includes(body.scopeType)) throw bad("scopeType must be club or team.");
  const scopeType = body.scopeType;
  const scopeId = scopeType === "global" ? NIL : requireUuid(body.scopeId, "scopeId");
  const displayTitle = optionalText(body.displayTitle, "displayTitle", 80);
  const reason = requireText(body.reason, "reason", 500);
  let expiresAt = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    const t = typeof body.expiresAt === "string" ? new Date(body.expiresAt) : null;
    if (!t || Number.isNaN(t.getTime()) || t.getTime() <= Date.now()) throw bad("expiresAt must be a time in the future.");
    expiresAt = t.toISOString();
  }
  // The club of the scope, and the caller's standing there; a private or global scope has none.
  let clubId = null;
  if (scopeType === "club") clubId = scopeId;
  else if (scopeType === "team") {
    const team = (await pool.query(`select club_id from public.teams where id = $1 and coalesce(is_active, true)`, [scopeId])).rows[0];
    if (!team) throw NOT_FOUND();
    clubId = team.club_id;
  }
  if (clubId) await gateClub(ctx, clubId, { needs: "staff" });
  else if (!isPlatform(ctx)) throw NOT_FOUND();
  const role = (await pool.query(`select owner_scope, owner_club_id from public.permission_roles where id = $1`, [roleId])).rows[0];
  // ADR-006: every 404 (the role, another club's role, the user) before any 409, so no
  // body-level refusal tells another club's role id from a random one.
  if (!role) throw NOT_FOUND();
  if (clubId && role.owner_scope === "club" && String(role.owner_club_id) !== String(clubId)) throw NOT_FOUND();
  const target = (await pool.query(`select is_active from public.users where id = $1`, [userId])).rows[0];
  if (!target) throw NOT_FOUND();
  if (userId === String(ctx.userId).toLowerCase()) throw refuse("self_assignment");
  // A global or private scope (a platform admin only gets here): never in R2 (O9).
  if (!clubId) throw refuse("role_not_assignable_here");
  const requestHash = requestHashOf("assignment_grant", { userId, roleId, scopeType, scopeId, displayTitle, expiresAt, reason });
  return runWrite(ctx, {
    operation: "assignment_grant", requestKey, requestHash,
    standingFor: staffStanding(ctx),
    reread: assignmentReread,
    prepare: async (client) => {
      // R4 contract 7.6 place 0: the club's ceiling lock (shared) before any row lock.
      await takeClubLock(client, scopeType, scopeId);
      // Contract 4.3 place 2: both users rows, in id order, one statement, no is_active filter.
      await client.query(PAIR_SQL, [ctx.userId, userId]);
      const basis = await lockActor(client, ctx, { scopeType, scopeId, roleForShare: roleId });
      if (!basis || !(await staffStanding(ctx)(client, clubId))) throw NOT_FOUND();
      if (scopeType === "team" && !(await client.query(`select 1 from public.teams where id = $1 and coalesce(is_active, true)`, [scopeId])).rowCount) throw NOT_FOUND();
      const r = await lockedRole(client, roleId);
      if (r.basic_key) throw refuse("role_not_assignable_here");
      if (r.archived_at) throw refuse("role_archived");
      if (!r[`assignable_${scopeType}`]) throw refuse("role_not_assignable_here");
      if (basis !== "platform_admin" && !(await client.query(`select public.user_holds_role_items($1, $2, $3, $4) as ok`, [ctx.userId, roleId, scopeType, scopeId])).rows[0].ok) {
        throw refuse("role_exceeds_your_permissions");
      }
      const u = (await client.query(`select is_active from public.users where id = $1`, [userId])).rows[0];
      if (!u) throw NOT_FOUND();
      if (!u.is_active) throw refuse("user_inactive");
      // Lapsed or not by the database's clock (the same now() the twin and the guards read).
      const existing = (await client.query(`select id, (expires_at is not null and expires_at <= now()) as lapsed from public.user_role_assignments
          where user_id = $1 and role_id = $2 and scope_type = $3 and scope_id = $4 and revoked_at is null`, [userId, roleId, scopeType, scopeId])).rows[0];
      if (existing && !existing.lapsed) throw refuse("assignment_exists", { assignmentId: existing.id });
      return { basis, lapsed: existing?.id ?? null };
    },
    write: async (client, p) => {
      // D4: a lapsed row of the same key is stamped expired first.
      if (p.lapsed) {
        await client.query(`update public.user_role_assignments set revoked_at = now(), revoked_by_user_id = $2, revoke_kind = 'expired' where id = $1 and revoked_at is null`, [p.lapsed, ctx.userId]);
      }
      const assignmentId = (await client.query(`insert into public.user_role_assignments (user_id, role_id, scope_type, scope_id, display_title, granted_by_user_id, grant_basis, grant_reason, expires_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [userId, roleId, scopeType, scopeId, displayTitle, ctx.userId, p.basis, reason, expiresAt])).rows[0].id;
      return { assignmentId, ownerClubId: clubId, ids: { assignmentId } };
    },
  });
}

export async function revokeAssignment(ctx, assignmentIdRaw, body) {
  if (!isUuid(assignmentIdRaw)) throw NOT_FOUND();
  const assignmentId = assignmentIdRaw.toLowerCase();
  const found = (await pool.query(`select a.user_id, a.role_id, a.scope_type, a.scope_id, case when a.scope_type = 'club' then a.scope_id else t.club_id end as club_id
      from public.user_role_assignments a left join public.teams t on a.scope_type = 'team' and t.id = a.scope_id where a.id = $1`, [assignmentId])).rows[0];
  if (!found || !found.club_id) throw NOT_FOUND();
  await gateClub(ctx, found.club_id, { needs: "staff" });
  const requestKey = requireUuid(body?.requestKey, "requestKey");
  const reason = requireText(body.reason, "reason", 500);
  const expectedUser = requireUuid(body.expected?.userId, "expected.userId");
  const expectedRole = requireUuid(body.expected?.roleId, "expected.roleId");
  const clubId = found.club_id;
  const requestHash = requestHashOf("assignment_revoke", { assignmentId, reason, expectedUser, expectedRole });
  return runWrite(ctx, {
    operation: "assignment_revoke", requestKey, requestHash,
    standingFor: staffStanding(ctx),
    reread: assignmentReread,
    prepare: async (client) => {
      await takeClubLock(client, found.scope_type, found.scope_id);
      await client.query(PAIR_SQL, [ctx.userId, found.user_id]);
      const basis = await lockActor(client, ctx, { scopeType: found.scope_type, scopeId: found.scope_id, assignmentForUpdate: assignmentId });
      if (!basis || !(await staffStanding(ctx)(client, clubId))) throw NOT_FOUND();
      const a = (await client.query(`select user_id, role_id, revoked_at, (expires_at is not null and expires_at <= now()) as lapsed from public.user_role_assignments where id = $1`, [assignmentId])).rows[0];
      if (String(a.user_id) !== expectedUser || String(a.role_id) !== expectedRole) throw refuse("assignment_mismatch");
      if (a.revoked_at || a.lapsed) throw refuse("assignment_already_revoked", { current: await assignmentView(client, assignmentId) });
      return { basis };
    },
    write: async (client) => {
      await client.query(`update public.user_role_assignments set revoked_at = now(), revoked_by_user_id = $2, revoke_kind = 'revoked', revoke_reason = $3 where id = $1`,
        [assignmentId, ctx.userId, reason]);
      return { assignmentId, ownerClubId: clubId, ids: { assignmentId } };
    },
  });
}

// The write runner and the rules above, for the R4-3 layers (permissionLayersService.js): one runner, one set of
// refusals, one request record.
export const rolesInternals = Object.freeze({
  runWrite, boundedRead, refuse, NOT_FOUND, bad, requireUuid, requireText, requireWords, requestHashOf, isUuid,
  itemRuleRefusal, lockActor, holdsSql, lockedRole, scopeTypesOf, activeClub, isPlatform, CLUB_ADMIN_ROLE_ID,
  RULE7_REQUIRED, HONOURED, PAIR_SQL, NIL,
});
