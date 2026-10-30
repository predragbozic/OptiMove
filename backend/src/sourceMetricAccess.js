// Access to the source-metric administration: one context per request, from
// the active workspace, and the caller's right checked again under FOR SHARE
// inside a write. Phase 7a of docs/ai/metrics-core-plan.md moved these
// helpers here unchanged from sourceMetricMappingService.js, so every writer
// - M2, M3-0 and R2, M2b, the revision lifecycle, the classification and,
// from phase 7d, the T5 activations - uses one source (discovery document,
// section K). Nothing here opens a connection: the context resolver reads
// through the bounded read its caller passes, and the right check runs on the
// caller's write transaction.
//
// Ownership comes from the caller's active workspace only (C60): the platform
// workspace is the system scope (a platform admin only); a club workspace is
// that club's scope (its active club admin, or a platform admin there for
// support). A body never names an owner.
import { isPlatformAdministrator, holdsClubAdminRole } from "./authz.js";
import { resolveActiveWorkspace } from "./workspace.js";

// The error of the source-metric administration services; the routes answer
// its status and code (backend/src/routes/sourceMetrics.js).
export class SourceMetricMappingError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "SourceMetricMappingError";
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}
export const refusal = (status, code, message, details) => new SourceMetricMappingError(status, code, message, details);
export const TRY_AGAIN_TEXT = "Another change is running. Nothing was changed; try again in a moment.";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Phase 7b (J8, R3): activating, replacing and disabling a mapping version are
// an active platform admin's, in the workspace of the mapping's owner (the
// platform workspace for a system mapping, club X's for a club X mapping;
// C60). A club admin reads its club's versions but gets the identical 404
// here; the routes ask this before they look at the body.
export function mayTransitionMappings(ctx) {
  return ctx?.basis === "platform_admin" && (ctx.owner?.scope === "system" || ctx.owner?.scope === "club");
}

// Phase 7d (J10, C106): starting and ending a T5 activation are an active
// platform admin's (in the platform workspace or a club workspace) and the
// active club admin's in its own club's workspace; everyone else gets the
// identical 404, before the body is looked at.
export function mayManageActivations(ctx) {
  if (ctx?.basis === "platform_admin") return ctx.owner?.scope === "system" || ctx.owner?.scope === "club";
  return ctx?.basis === "club_admin" && ctx.owner?.scope === "club";
}

// J10 section 2.1, the one scope rule of S1, S2, S3, A1's listed starts and
// every replay: the platform workspace admits system mappings on any club's
// binding; club X's workspace (its admin, or a platform admin there) admits
// system mappings and club X's own, on club X's bindings only. A binding with
// no club (a connection that is not club-owned) is never admitted. Whether the
// club is active is checked apart (an archived club is the identical 404).
export function activationInScope(ctx, { mappingOwnerKey, bindingClubId }) {
  if (!bindingClubId || !ctx?.owner) return false;
  if (ctx.owner.scope === "system") return ctx.basis === "platform_admin" && mappingOwnerKey === "system";
  return bindingClubId === ctx.owner.clubId && (mappingOwnerKey === "system" || mappingOwnerKey === ctx.owner.clubId);
}

// The bindings' clubs FOR SHARE, distinct ids in ascending order, for every
// basis (R6): false when one is archived or missing, so a club archive waits
// for the write or lands first.
export async function bindingClubHolds(client, clubIds) {
  const ids = [...new Set(clubIds)].sort();
  if (ids.length === 0) return false;
  const clubs = (await client.query(
    `select id, coalesce(is_active, true) as active from public.clubs where id = any($1::uuid[]) order by id for share`, [ids],
  )).rows;
  return clubs.length === ids.length && clubs.every((c) => c.active);
}

// Test seam (never set by the application): runs inside a write's transaction
// right before the caller's right is checked again under FOR SHARE (after
// every registry lock).
let rightsHold = null;
export function setRightsHoldForTests(fn) { rightsHold = fn ?? null; }

// ---------------------------------------------------------------------------
// Access: one context per request, from the active workspace.
// ---------------------------------------------------------------------------
// `read` is the caller's bounded read (sourceMetricMappingService.js binds
// its own: resolveMappingAdmin). `known` is the active workspace when the
// caller already resolved it (the canonical-variable editor, R2), so it is not
// resolved twice.
export async function resolveMappingAdminWith(read, req, known = undefined) {
  if (!req?.user?.id || !req.authz) return null;
  const workspace = known === undefined ? (await resolveActiveWorkspace(req.user.id, req.authz)).workspace : known;
  if (!workspace) return null;
  const userId = String(req.user.id);
  const scopeId = workspace.scopeId ? String(workspace.scopeId) : null;
  let ctx = null;
  if (isPlatformAdministrator(req.authz)) {
    if (workspace.type === "platform") return { userId, basis: "platform_admin", owner: { scope: "system", clubId: null } };
    if (workspace.type === "club" && scopeId) ctx = { userId, basis: "platform_admin", owner: { scope: "club", clubId: scopeId } };
  } else if (workspace.type === "club" && scopeId && holdsClubAdminRole(req.authz, scopeId)) {
    ctx = { userId, basis: "club_admin", owner: { scope: "club", clubId: scopeId } };
  }
  if (!ctx || !UUID.test(scopeId)) return null;
  // A club scope needs an active club (fail-closed, whatever the workspace
  // list admitted); writes check it again under FOR SHARE.
  const club = await read((client) => client.query(`select 1 from public.clubs where id = $1 and coalesce(is_active, true)`, [scopeId]));
  return club.rowCount === 1 ? ctx : null;
}
export const ownerKeyOf = (ctx) => (ctx.owner.scope === "system" ? "system" : ctx.owner.clubId);
// Readable: the system scope always; a club's own scope in its workspace.
export const readableOwnerKeys = (ctx) => (ctx.owner.scope === "system" ? ["system"] : ["system", ctx.owner.clubId]);

// The caller's right and, for a club scope, the club, under FOR SHARE (after
// every registry row of the lock order).
export async function rightsStillHold(client, ctx) {
  if (rightsHold) await rightsHold(client);
  if (ctx.basis === "team_coach") return coachRightsStillHold(client, ctx);
  if (ctx.basis === "club_admin") {
    // The database derives platform_admin for an active platform admin (v35,
    // C79): a club admin granted that role since this request began repeats
    // it (try_again), so the basis it writes is the one the database derives.
    // The same rows, in the same order, as the v35 basis check.
    const promoted = await client.query(
      `select 1 from public.user_global_roles g join public.users u on u.id = g.user_id
        where g.user_id = $1 and g.role = 'platform_admin' and g.is_active = true and u.is_active = true for share of g, u`,
      [ctx.userId],
    );
    if (promoted.rowCount > 0) throw refusal(409, "try_again", TRY_AGAIN_TEXT);
  }
  const right = ctx.basis === "platform_admin"
    ? await client.query(
      `select 1 from public.user_global_roles g join public.users u on u.id = g.user_id
        where g.user_id = $1 and g.role = 'platform_admin' and g.is_active = true and u.is_active = true for share of g, u`,
      [ctx.userId],
    )
    : await client.query(
      `select 1 from public.user_club_roles r join public.users u on u.id = r.user_id
        where r.user_id = $1 and r.club_id = $2 and r.role = 'club_admin' and r.is_active = true and u.is_active = true for share of r, u`,
      [ctx.userId, ctx.owner.clubId],
    );
  if (right.rowCount === 0) return false;
  if (ctx.owner.scope === "club") {
    const club = await client.query(`select 1 from public.clubs where id = $1 and coalesce(is_active, true) for share`, [ctx.owner.clubId]);
    if (club.rowCount === 0) return false;
  }
  return true;
}
// The team_coach basis (R2, section J3b.3; only the canonical-variable editor
// sets it): an active coach of an active team of the variable's active club.
// The stronger bases are probed first, as v38's
// training_load.metric_variable_change_basis() derives them - each a joined
// FOR SHARE, which locks only the rows it returns: found means the database
// would derive another basis, so the request repeats (try_again). Then the
// team, the club and the coach role with the user, FOR SHARE - v26's
// lock_activity_decider order.
async function coachRightsStillHold(client, ctx) {
  const platform = await client.query(
    `select 1 from public.user_global_roles g join public.users u on u.id = g.user_id
      where g.user_id = $1 and g.role = 'platform_admin' and g.is_active = true and u.is_active = true for share of g, u`,
    [ctx.userId],
  );
  if (platform.rowCount > 0) throw refusal(409, "try_again", TRY_AGAIN_TEXT);
  const clubAdmin = await client.query(
    `select 1 from public.user_club_roles r join public.users u on u.id = r.user_id join public.clubs c on c.id = r.club_id
      where r.user_id = $1 and r.club_id = $2 and r.role = 'club_admin' and r.is_active = true and u.is_active = true
        and coalesce(c.is_active, true)
        for share of r, u, c`,
    [ctx.userId, ctx.owner.clubId],
  );
  if (clubAdmin.rowCount > 0) throw refusal(409, "try_again", TRY_AGAIN_TEXT);
  const team = await client.query(
    `select 1 from public.teams where id = $1 and club_id = $2 and coalesce(is_active, true) for share`, [ctx.teamId, ctx.owner.clubId],
  );
  if (team.rowCount === 0) return false;
  const club = await client.query(`select 1 from public.clubs where id = $1 and coalesce(is_active, true) for share`, [ctx.owner.clubId]);
  if (club.rowCount === 0) return false;
  const role = await client.query(
    `select 1 from public.user_team_roles r join public.users u on u.id = r.user_id
      where r.user_id = $1 and r.team_id = $2 and r.role = 'team_coach' and r.is_active = true and u.is_active = true for share of r, u`,
    [ctx.userId, ctx.teamId],
  );
  return role.rowCount > 0;
}
