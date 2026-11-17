import { isPlatformAdministrator } from '../authz.js';

export function canUseSimplePlatformPilot(req, workspace) {
  return Boolean(req.user?.id) && workspace?.type === 'platform'
    && Boolean(req.authz && isPlatformAdministrator(req.authz));
}
