import { isDashboardsViewRequest } from "../trainingLoadDashboardAccess.js";
import { resolveActiveWorkspace } from "../workspace.js";
import { resolveVariableEditor } from "../canonicalVariableAdminService.js";
// The owner explicitly chose today's canonical-variable gates, NOT partially
// activated R4 words. The manager stream moves these with the whole module.
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
export const referenceCanWrite = ctx => ctx?.owner?.scope === "club" && ctx.view === "admin";
