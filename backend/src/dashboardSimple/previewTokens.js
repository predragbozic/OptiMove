import { createHmac, timingSafeEqual } from 'node:crypto';

export const PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;
export const PREVIEW_TOKEN_MAX_LENGTH = 16384;
export const PREVIEW_TOKEN_BINDING_FIELDS = Object.freeze([
  'userId', 'workspace', 'target', 'draftHash', 'catalogToken',
  'semanticFingerprint', 'contextFingerprint', 'periodIntent', 'resolvedPeriod',
  'evaluatedAt',
]);
const maximumJsonBytes = 8192;
const maximumDate = 8640000000000000;
const plainObject = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const keyIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

function previewRequired(reason) {
  return Object.assign(new Error('previewRequired'), { code: 'previewRequired', status: 409, reason });
}

function canonicalJson(value) {
  let remainingNodes = 1024;
  const ancestors = new Set();
  function encode(current, depth) {
    if (--remainingNodes < 0 || depth > 12) throw new TypeError('Preview binding exceeds JSON bounds');
    if (current === null || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'string' && current.length <= 2048) return JSON.stringify(current);
    if (typeof current === 'number' && Number.isFinite(current) && !Object.is(current, -0)) return JSON.stringify(current);
    if (!current || typeof current !== 'object' || ancestors.has(current)) throw new TypeError('Plain JSON required');
    const isArray = Array.isArray(current);
    if (!isArray && !plainObject(current)) throw new TypeError('Plain JSON required');
    const keys = Reflect.ownKeys(current);
    if (keys.length > 1024 || keys.some(key => typeof key !== 'string')) throw new TypeError('Plain JSON keys required');
    ancestors.add(current);
    let encoded;
    if (isArray) {
      if (current.length > 1024 || keys.length !== current.length + 1) throw new TypeError('Dense JSON array required');
      encoded = `[${Array.from({ length: current.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('JSON values required');
        return encode(descriptor.value, depth + 1);
      }).join(',')}]`;
    } else {
      encoded = `{${keys.sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (key.length > 256 || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('JSON values required');
        return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
      }).join(',')}}`;
    }
    ancestors.delete(current);
    if (Buffer.byteLength(encoded) > maximumJsonBytes) throw new TypeError('Preview binding exceeds JSON bounds');
    return encoded;
  }
  const encoded = encode(value, 0);
  if (Buffer.byteLength(encoded) > maximumJsonBytes) throw new TypeError('Preview binding exceeds JSON bounds');
  return encoded;
}

function validateBinding(binding) {
  if (!plainObject(binding) || Object.keys(binding).length !== PREVIEW_TOKEN_BINDING_FIELDS.length
    || !PREVIEW_TOKEN_BINDING_FIELDS.every(field => Object.hasOwn(binding, field))) throw new TypeError('Complete preview binding required');
  for (const field of ['userId', 'draftHash', 'catalogToken', 'semanticFingerprint', 'contextFingerprint']) {
    if (!identifier(binding[field])) throw new TypeError(`Invalid ${field}`);
  }
  for (const field of ['workspace', 'target', 'periodIntent', 'resolvedPeriod']) {
    if (!plainObject(binding[field]) || Object.keys(binding[field]).length === 0) throw new TypeError(`Invalid ${field}`);
  }
  if (!exactFields(binding.target, ['dashboardId', 'widgetId', 'widgetRevision']) || !identifier(binding.target.dashboardId)
    || binding.target.widgetId !== null && !identifier(binding.target.widgetId)
    || binding.target.widgetRevision !== null && (!Number.isSafeInteger(binding.target.widgetRevision) || binding.target.widgetRevision < 1)) throw new TypeError('Invalid target');
  if (!timestamp(binding.evaluatedAt)) throw new TypeError('Server ISO evaluatedAt required');
  canonicalJson(binding);
  return binding;
}

function copyKey(key) {
  if (!(key instanceof Uint8Array) || key.byteLength < 32 || key.byteLength > 4096) throw new TypeError('Dedicated preview key of at least 32 bytes required');
  return Buffer.from(key);
}

function exactFields(value, fields) {
  return plainObject(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

export function createPreviewTokenService({ keyId, key, verificationKeys = {}, now = () => Date.now() } = {}) {
  if (!keyIdentifier(keyId) || typeof now !== 'function' || !plainObject(verificationKeys)
    || Reflect.ownKeys(verificationKeys).length > 16) throw new TypeError('Explicit preview signing configuration required');
  const signingKey = copyKey(key);
  const previousKeys = new Map();
  for (const [previousKeyId, entry] of Object.entries(verificationKeys)) {
    if (!keyIdentifier(previousKeyId) || previousKeyId === keyId || !exactFields(entry, ['key', 'retiredAt'])
      || !timestamp(entry.retiredAt)) throw new TypeError('Verification keys require key and ISO retiredAt');
    previousKeys.set(previousKeyId, { key: copyKey(entry.key), retiredAt: Date.parse(entry.retiredAt) });
  }
  let lastObservedTime = -Infinity;
  function serverTime() {
    const observedTime = now();
    if (!Number.isSafeInteger(observedTime) || observedTime < 0 || observedTime > maximumDate - PREVIEW_TOKEN_TTL_MS) throw previewRequired('invalidClock');
    if (observedTime < lastObservedTime) throw previewRequired('clockChanged');
    lastObservedTime = observedTime;
    return observedTime;
  }
  if (previousKeys.size > 0) {
    const configuredAt = serverTime();
    if ([...previousKeys.values()].some(entry => entry.retiredAt > configuredAt)) throw new TypeError('Verification key retirement cannot be in the future');
  }
  function issue(binding) {
    const issuedTime = serverTime();
    const issuedAt = new Date(issuedTime).toISOString();
    const copiedBinding = JSON.parse(canonicalJson(binding));
    validateBinding(copiedBinding);
    if (Date.parse(copiedBinding.evaluatedAt) > issuedTime) throw new TypeError('Binding timestamps cannot exceed server time');
    const expiresAt = new Date(issuedTime + PREVIEW_TOKEN_TTL_MS).toISOString();
    const payload = Buffer.from(canonicalJson({ version: 1, keyId, binding: copiedBinding, requestIssuedAt: issuedAt, issuedAt, expiresAt })).toString('base64url');
    const signature = createHmac('sha256', signingKey).update(payload).digest('base64url');
    return { previewToken: `${payload}.${signature}`, expiresAt, requestIssuedAt: issuedAt, serverNow: issuedAt };
  }
  function verify(previewToken, expectedBinding) {
    try {
      if (typeof previewToken !== 'string' || previewToken.length > PREVIEW_TOKEN_MAX_LENGTH) throw previewRequired('invalidToken');
      const segments = previewToken.split('.');
      if (segments.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(segments[0]) || !/^[A-Za-z0-9_-]{43}$/.test(segments[1])) throw previewRequired('invalidToken');
      const [payload, signature] = segments;
      const decoded = Buffer.from(payload, 'base64url');
      const suppliedSignature = Buffer.from(signature, 'base64url');
      if (decoded.length > maximumJsonBytes || decoded.toString('base64url') !== payload
        || suppliedSignature.toString('base64url') !== signature) throw previewRequired('invalidToken');
      const envelope = JSON.parse(decoded.toString('utf8'));
      if (!exactFields(envelope, ['version', 'keyId', 'binding', 'requestIssuedAt', 'issuedAt', 'expiresAt']) || !keyIdentifier(envelope.keyId)) throw previewRequired('invalidToken');
      const previousKey = previousKeys.get(envelope.keyId);
      const verificationKey = envelope.keyId === keyId ? signingKey : previousKey?.key;
      if (!verificationKey) throw previewRequired('invalidToken');
      const expectedSignature = createHmac('sha256', verificationKey).update(payload).digest();
      if (!timingSafeEqual(suppliedSignature, expectedSignature)) throw previewRequired('invalidToken');
      if (envelope.version !== 1) throw previewRequired('unsupportedTokenVersion');
      if (canonicalJson(envelope) !== decoded.toString('utf8') || !timestamp(envelope.issuedAt) || !timestamp(envelope.expiresAt)
        || envelope.requestIssuedAt !== envelope.issuedAt) throw previewRequired('invalidToken');
      validateBinding(envelope.binding);
      const issuedTime = Date.parse(envelope.issuedAt);
      const expiresTime = Date.parse(envelope.expiresAt);
      const currentTime = serverTime();
      if (expiresTime - issuedTime !== PREVIEW_TOKEN_TTL_MS
        || Date.parse(envelope.binding.evaluatedAt) > issuedTime) throw previewRequired('invalidToken');
      if (issuedTime > currentTime) throw previewRequired('tokenNotYetValid');
      if (currentTime >= expiresTime || previousKey && (issuedTime > previousKey.retiredAt || currentTime >= previousKey.retiredAt + PREVIEW_TOKEN_TTL_MS)) throw previewRequired('tokenExpired');
      const validatedExpected = validateBinding(JSON.parse(canonicalJson(expectedBinding)));
      if (canonicalJson(envelope.binding.resolvedPeriod) !== canonicalJson(validatedExpected.resolvedPeriod)) throw previewRequired('effectivePeriodChanged');
      const fieldsExceptPeriod = PREVIEW_TOKEN_BINDING_FIELDS.filter(field => field !== 'resolvedPeriod');
      if (fieldsExceptPeriod.some(field => canonicalJson(envelope.binding[field]) !== canonicalJson(validatedExpected[field]))) throw previewRequired('bindingChanged');
      return envelope.binding;
    } catch (error) {
      if (error?.code === 'previewRequired' && error.status === 409) throw error;
      throw previewRequired('invalidToken');
    }
  }
  return Object.freeze({ issue, verify });
}
