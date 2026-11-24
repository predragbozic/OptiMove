// The organization router's entry gate (roles R4-2, docs/ai/roles-r4-contract.md 5.1), in place of requireCoach.
//
//   - An account that passes requireCoach (a role of the old tables, a platform admin, an independent coach) goes on
//     exactly as before: this is requireCoach's own test.
//   - Any other account reaches the organization router ONLY for the read routes on READ_ROUTES (GET / and nothing else
//     in R4), and only while its active workspace is a view workspace (club_view / team_view); the route then answers
//     from that workspace alone. Every other method and path answers exactly what requireCoach answers today
//     (403 Forbidden), so every write - POST /athletes, whose only gate is requireCoach and the athlete's club or team -
//     stays closed by construction for a role holder without an old role row.
// requireCoach, computeCapabilities and the old role helpers are not changed (contract 5.1, plan 2.1 rules 1 and 12).
import { VIEW_WORKSPACE_TYPES, resolveActiveWorkspaceReadOnly, pickFallbackWorkspace } from "./workspace.js";

const READ_ROUTES = Object.freeze([{ method: "GET", path: "/" }]);

function forbidden(res) {
  res.status(403).json({ error: "Forbidden" });
}

export async function organizationEntryGate(req, res, next) {
  try {
    if (req.authz?.capabilities?.coachWorkspace) return next();
    if (!req.user || !READ_ROUTES.some((r) => r.method === req.method && r.path === req.path)) return forbidden(res);
    // Read-only: the gate never writes a preference (the route's own resolveActiveWorkspace may, as for every account).
    const { workspace, availableWorkspaces } = await resolveActiveWorkspaceReadOnly(req.user.id, req.authz);
    const active = workspace || pickFallbackWorkspace(availableWorkspaces);
    if (!active || !VIEW_WORKSPACE_TYPES.has(active.type)) return forbidden(res);
    return next();
  } catch (error) {
    return next(error);
  }
}
