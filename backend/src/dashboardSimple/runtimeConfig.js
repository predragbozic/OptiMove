const modes = new Set(['off', 'preview', 'enabled', 'drain']);
const keyId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export class SimpleRuntimeConfigurationError extends Error {
  constructor(field) { super(`Invalid Dashboard Simple configuration: ${field}`); this.code = 'simpleRuntimeConfiguration'; }
}
function refuse(field) { throw new SimpleRuntimeConfigurationError(field); }
function decode(value, field) {
  if (typeof value !== 'string' || value.length > 5464 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) refuse(field);
  const result = Buffer.from(value, 'base64');
  if (result.length < 32 || result.length > 4096 || result.toString('base64') !== value) refuse(field);
  return result;
}
export function readSimpleRuntimeConfig(env = process.env) {
  const mode = env.DASHBOARD_SIMPLE_MODE ?? 'off';
  if (!modes.has(mode)) refuse('DASHBOARD_SIMPLE_MODE');
  if (mode === 'off' || mode === 'drain') return Object.freeze({ mode });
  if (env.DASHBOARD_SIMPLE_BUDGET_VERIFIED !== 'true') refuse('DASHBOARD_SIMPLE_BUDGET_VERIFIED');
  if (env.DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED !== 'true') refuse('DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED');
  const rawBudget = env.DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE;
  if (typeof rawBudget !== 'string' || !/^(?:[1-9]|1[0-6])$/.test(rawBudget)) refuse('DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE');
  if (!keyId(env.DASHBOARD_SIMPLE_KEY_ID)) refuse('DASHBOARD_SIMPLE_KEY_ID');
  const key = decode(env.DASHBOARD_SIMPLE_KEY_BASE64, 'DASHBOARD_SIMPLE_KEY_BASE64');
  const verificationKeys = {};
  let previous = {};
  if (env.DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON !== undefined) {
    if (typeof env.DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON !== 'string' || env.DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON.length > 100000) refuse('DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON');
    try { previous = JSON.parse(env.DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON); } catch { refuse('DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON'); }
  }
  if (!plain(previous) || Object.keys(previous).length > 16) refuse('DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON');
  for (const [id, entry] of Object.entries(previous)) {
    if (!keyId(id) || id === env.DASHBOARD_SIMPLE_KEY_ID || !plain(entry) || Object.keys(entry).length !== 2
      || !Object.hasOwn(entry, 'keyBase64') || !Object.hasOwn(entry, 'retiredAt') || typeof entry.retiredAt !== 'string'
      || !Number.isFinite(Date.parse(entry.retiredAt)) || new Date(entry.retiredAt).toISOString() !== entry.retiredAt) refuse('DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON');
    Object.defineProperty(verificationKeys, id, { enumerable: true, value: { key: decode(entry.keyBase64, 'DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON'), retiredAt: entry.retiredAt } });
  }
  return Object.freeze({ mode, maxActiveDeployment: Number(rawBudget), keyId: env.DASHBOARD_SIMPLE_KEY_ID, key, verificationKeys });
}
