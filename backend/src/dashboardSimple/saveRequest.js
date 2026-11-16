import { createHash } from 'node:crypto';
import { canonicalKey } from './compiler.js';
import { validateContract, isUuid } from './schema.js';
import { previewError } from './previewTransaction.js';

export const SIMPLE_REQUEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SIMPLE_REQUEST_GRACE_MS = 10 * 60 * 1000;
export const SIMPLE_SAVE_BODY_BYTES = 96 * 1024;

export function validateSimpleSaveRequest(body) {
  const keys = ['requestId', 'requestIssuedAt', 'resolvedPeriod', 'previewToken', 'input'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== keys.length || !keys.every(key => Object.hasOwn(body, key))) throw previewError('invalidRequest', 400);
  if (!isUuid(body.requestId) || typeof body.requestIssuedAt !== 'string' || !Number.isFinite(Date.parse(body.requestIssuedAt)) ||
      typeof body.previewToken !== 'string' || body.previewToken.length < 1 || body.previewToken.length > 16384) throw previewError('invalidRequest', 400);
  const period = validateContract('context', { kind: 'legacyDashboard', period: body.resolvedPeriod });
  const input = validateContract('envelope', body.input);
  if (!period.valid || !input.valid) throw Object.assign(previewError('invalidDraft', 400), { issues: [...period.issues, ...input.issues] });
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > SIMPLE_SAVE_BODY_BYTES) throw previewError('payloadTooLarge', 413);
}

function normalize(value, field = '') {
  if (Array.isArray(value)) {
    const items = value.map(item => normalize(item));
    if (field === 'athleteIds') return items.sort();
    if (field === 'rules') return items.sort((left, right) => left.priority - right.priority);
    return items;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, key)]));
  return typeof value === 'string' && isUuid(value) ? value.toLowerCase() : value;
}

export function simpleSavePayloadHash({ userId, dashboardId, body }) {
  const normalized = normalize({ userId, dashboardId, input: body.input, requestIssuedAt: new Date(body.requestIssuedAt).toISOString(), resolvedPeriod: body.resolvedPeriod });
  return createHash('sha256').update(canonicalKey(normalized)).digest('hex');
}
