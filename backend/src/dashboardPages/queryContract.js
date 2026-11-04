import { validateContract, isUuid } from '../dashboardSimple/schema.js';
import { pageJsonIssue } from './contract.js';

export function validatePageQuery(pageId, body) {
  if (pageJsonIssue(body)) return false;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (keys.some(key => !['period', 'runtimeFilter', 'widgetIds'].includes(key))) return false;
  const context = { kind: 'page', pageId, ...(Object.hasOwn(body, 'period') ? { period: body.period } : {}), ...(Object.hasOwn(body, 'runtimeFilter') ? { runtimeFilter: body.runtimeFilter } : {}) };
  if (!validateContract('context', context).valid) return false;
  if (Object.hasOwn(body, 'widgetIds') && (!Array.isArray(body.widgetIds) || body.widgetIds.length > 200 || body.widgetIds.some(id => !isUuid(id)) || new Set(body.widgetIds.map(id => id.toLowerCase())).size !== body.widgetIds.length)) return false;
  return true;
}
