import { validateContract } from '../dashboardSimple/schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_DASHBOARD_PAGES = 32;
const shapes = Object.freeze({
  create: ['name', 'periodConfig', 'defaultFilter', 'expectedPagesRevision'],
  rename: ['name', 'expectedPageRevision'],
  defaults: ['expectedPageDefaultsRevision'],
  reorder: ['pageIds', 'expectedPagesRevision'],
  duplicate: ['name', 'expectedPageRevision', 'expectedPagesRevision'],
  delete: ['expectedPageRevision', 'expectedPagesRevision', 'deleteWidgets'],
});

function jsonSafe(value, seen = new Set(), depth = 0) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 32 || seen.has(value)) return false;
  const array = Array.isArray(value);
  if (array && Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (!array && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return false;
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  const valid = keys.every(key => {
    if (array && key === 'length') return true;
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) return false;
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor.enumerable && Object.hasOwn(descriptor, 'value') && jsonSafe(descriptor.value, seen, depth + 1);
  }) && (!array || keys.length === value.length + 1);
  seen.delete(value);
  return valid;
}

export function validatePageRequest(operation, value) {
  if (!Object.hasOwn(shapes, operation)) throw new TypeError('Unknown page operation');
  if (!jsonSafe(value)) return { valid: false, issues: [{ code: 'invalidJson', path: '$' }] };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 65536) return { valid: false, issues: [{ code: 'payloadTooLarge', path: '$' }] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, issues: [{ code: 'invalidType', path: '$' }] };
  const required = ['contractVersion', 'requestId', ...shapes[operation]];
  const allowed = new Set([...required, ...(operation === 'defaults' ? ['periodConfig', 'defaultFilter'] : [])]);
  const issues = [];
  const add = (code, key) => issues.push({ code, path: key ? `$.${key}` : '$' });
  for (const key of required) if (!Object.hasOwn(value, key)) add('required', key);
  for (const key of Object.keys(value)) if (!allowed.has(key)) add('unknownKey', key);
  if (value.contractVersion !== 1) add('invalidVersion', 'contractVersion');
  if (typeof value.requestId !== 'string' || !UUID.test(value.requestId)) add('invalidUuid', 'requestId');
  for (const key of ['expectedPagesRevision', 'expectedPageRevision', 'expectedPageDefaultsRevision']) {
    if (Object.hasOwn(value, key) && (!Number.isSafeInteger(value[key]) || value[key] < 1)) add('invalidRevision', key);
  }
  if (Object.hasOwn(value, 'name') && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || /[\u0000-\u001f\u007f]/.test(value.name))) add('invalidName', 'name');
  for (const [key, schema] of [['periodConfig', 'periodConfig'], ['defaultFilter', 'runtimeFilter']]) {
    if (!Object.hasOwn(value, key)) continue;
    const nested = validateContract(schema, value[key]);
    issues.push(...nested.issues.map(issue => ({ code: issue.code, path: `$.${key}${schema === 'periodConfig' && issue.path === '$.periodConfig' ? '' : issue.path.slice(1)}` })));
  }
  if (operation === 'defaults' && !Object.hasOwn(value, 'periodConfig') && !Object.hasOwn(value, 'defaultFilter')) add('emptyUpdate');
  if (Object.hasOwn(value, 'deleteWidgets') && typeof value.deleteWidgets !== 'boolean') add('invalidType', 'deleteWidgets');
  if (Object.hasOwn(value, 'pageIds')) {
    if (!Array.isArray(value.pageIds) || !value.pageIds.length || value.pageIds.length > MAX_DASHBOARD_PAGES || value.pageIds.some(id => typeof id !== 'string' || !UUID.test(id))) add('invalidPageIds', 'pageIds');
    else if (new Set(value.pageIds.map(id => id.toLowerCase())).size !== value.pageIds.length) add('duplicatePageId', 'pageIds');
  }
  return { valid: issues.length === 0, issues };
}
