// One request-only boundary for a view gate's legacy handoff. Identity is not changed.
import { computeCapabilities } from './authz.js';
import { rememberReadOnlyWorkspace } from './workspace.js';

export function rolelessViewHandoff(req, resolution) {
  const authz = {
    userId: req.user.id,
    roleHint: null,
    platformRoles: [],
    clubRoles: [],
    teamRoles: [],
    managedTeamIds: [],
    isIndependentCoach: false,
    // A verified athlete profile is personal identity, independent of staff roles.
    isAthlete: req.authz?.isAthlete === true,
    athleteId: req.authz?.isAthlete === true ? req.authz.athleteId : null,
    rolePermissions: Object.freeze([]),
    roleAssignments: Object.freeze([]),
  };
  authz.capabilities = Object.freeze(computeCapabilities(authz));
  req.authz = Object.freeze(authz);
  delete req.moduleView;
  rememberReadOnlyWorkspace(req.user.id, req.authz, resolution);
}
