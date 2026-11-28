import { isDashboardsViewRequest } from "../trainingLoadDashboardAccess.js";
import { resolveActiveWorkspace, resolveActiveWorkspaceReadOnly } from "../workspace.js";
import { isPlatformAdministrator } from "../authz.js";
import { lockClubCeiling } from "../clubCeilingLock.js";
import { lockDashboardActor, loadDashboardWriteActor } from "../dashboardManageAccess.js";
import { rightsStillHold } from "../sourceMetricAccess.js";
import { resolveVariableEditor } from "../canonicalVariableAdminService.js";
// Shared reference context keeps the existing published-read and binding scope.
export function resolveReferenceContext(req) {
  if (!req.user?.id || !req.authz || isDashboardsViewRequest(req)) return Promise.resolve(null);
  if (!req._referenceContext) req._referenceContext = (async () => {
    const known = req._resolvedDataWorkspacePromise ? await req._resolvedDataWorkspacePromise : null;
    const workspace = known ? {type:known.type,scopeId:known.dataWorkspaceScopeId} : (await resolveActiveWorkspace(req.user.id, req.authz)).workspace;
    // Explicit closed list: neither R4 view workspace gains access, even when
    // this account also has a platform/admin role in another workspace.
    if (!workspace || !["club", "team"].includes(workspace.type)) return null;
    const ctx = await resolveVariableEditor(req,workspace);
    return ctx?.owner?.scope === "club" ? { ...ctx, workspace } : null;
  })();
  return req._referenceContext;
}
export async function referenceCanWrite(query, ctx) {
  if (ctx?.owner?.scope !== "club" || ctx.view !== "admin") return false;
  if (ctx.basis === "platform_admin") return true;
  const { rows: [rights] } = await query(
    `select public.permission_word_honoured('variables.manage')
       and public.user_has_permission($1,'variables.view','club',$2)
       and public.user_has_permission($1,'variables.manage','club',$2) as allowed`,
    [ctx.userId, ctx.owner.clubId],
  );
  return rights?.allowed === true;
}

export async function referenceWriterStillHolds(client, req, ctx) {
  const query = client.query.bind(client);
  if (!req.sessionToken) return false;
  if (ctx.basis !== "platform_admin") await lockClubCeiling(client, [ctx.owner.clubId], "shared");
  await lockDashboardActor(query, req);
  const actor = await loadDashboardWriteActor(query, req);
  if (!actor || isPlatformAdministrator(actor.authz) !== (ctx.basis === "platform_admin")) return false;
  const { workspace } = await resolveActiveWorkspaceReadOnly(actor.user.id, actor.authz, query);
  if (workspace?.type !== ctx.workspace.type || String(workspace.scopeId) !== String(ctx.owner.clubId)) return false;
  if (ctx.basis !== "platform_admin") {
    await query("select public.lock_permission_actor($1,'club',$2)", [ctx.userId, ctx.owner.clubId]);
    if (!await referenceCanWrite(query, ctx)) return false;
  }
  return rightsStillHold(client, ctx);
}
