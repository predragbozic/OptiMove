import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSimpleRuntimeConfig, SimpleRuntimeConfigurationError } from '../src/dashboardSimple/runtimeConfig.js';

const current = Buffer.alloc(32, 77).toString('base64');
const base = () => ({ DASHBOARD_SIMPLE_MODE: 'enabled', DASHBOARD_SIMPLE_BUDGET_VERIFIED: 'true', DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED: 'true', DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE: '2', DASHBOARD_SIMPLE_KEY_ID: 'current', DASHBOARD_SIMPLE_KEY_BASE64: current });
test('off is the default and never reads signing secrets or activation dependencies', () => {
  const env = { get DASHBOARD_SIMPLE_KEY_BASE64() { throw new Error('secret unexpectedly read'); } };
  assert.deepEqual(readSimpleRuntimeConfig(env), { mode: 'off' });
  assert.deepEqual(readSimpleRuntimeConfig({ DASHBOARD_SIMPLE_MODE: 'drain', get DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON() { throw new Error('secret unexpectedly read'); } }), { mode: 'drain' });
});
test('preview and enabled require an explicit aggregate budget attestation and bounded integer', () => {
  for (const mode of ['preview','enabled']) {
    const good = base(); good.DASHBOARD_SIMPLE_MODE = mode;
    assert.equal(readSimpleRuntimeConfig(good).mode, mode);
    for (const value of [undefined,'false','TRUE','1']) assert.throws(() => readSimpleRuntimeConfig({ ...good, DASHBOARD_SIMPLE_BUDGET_VERIFIED: value }), SimpleRuntimeConfigurationError);
    for (const value of [undefined,'false','TRUE','1']) assert.throws(() => readSimpleRuntimeConfig({ ...good, DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED: value }), SimpleRuntimeConfigurationError);
    for (const value of [undefined,'0','17','1.5','01','2e0',' 2']) assert.throws(() => readSimpleRuntimeConfig({ ...good, DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE: value }), SimpleRuntimeConfigurationError);
  }
});
test('unknown modes and missing or malformed dedicated key never fall back to another secret', () => {
  for (const mode of ['', 'true', 'ON', 'enabled ']) assert.throws(() => readSimpleRuntimeConfig({ ...base(), DASHBOARD_SIMPLE_MODE: mode }), SimpleRuntimeConfigurationError);
  for (const value of [undefined,'secret',Buffer.alloc(31).toString('base64'), current.replace(/=$/,''), Buffer.alloc(4097).toString('base64')]) {
    assert.throws(() => readSimpleRuntimeConfig({ ...base(), DASHBOARD_SIMPLE_KEY_BASE64: value, SESSION_SECRET: current }), error => error.code === 'simpleRuntimeConfiguration' && !error.message.includes(current));
  }
});
test('previous keys are verification-only structured entries with exact fields and ISO retirement', () => {
  const keyBase64 = Buffer.alloc(32, 66).toString('base64');
  const old = { keyBase64, retiredAt: '2026-11-03T08:00:00.000Z' };
  const result = readSimpleRuntimeConfig({ ...base(), DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON: JSON.stringify({ old }) });
  assert.deepEqual(result.verificationKeys.old.key, Buffer.from(keyBase64,'base64'));
  assert.equal(result.verificationKeys.old.retiredAt, old.retiredAt);
  for (const json of ['null','[]','{',JSON.stringify({ current: old }),JSON.stringify({ old: { ...old, extra: true } }),JSON.stringify({ old: { ...old, retiredAt: 'yesterday' } })]) {
    assert.throws(() => readSimpleRuntimeConfig({ ...base(), DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON: json }), error => error.code === 'simpleRuntimeConfiguration' && !error.message.includes(keyBase64));
  }
});
test('prototype-like key IDs remain inert data without changing the verification-key prototype', () => {
  const json = '{"__proto__":{"keyBase64":"'+current+'","retiredAt":"2026-11-03T08:00:00.000Z"}}';
  const result = readSimpleRuntimeConfig({ ...base(), DASHBOARD_SIMPLE_VERIFICATION_KEYS_JSON: json });
  assert.equal(Object.getPrototypeOf(result.verificationKeys), Object.prototype);
  assert.ok(Object.hasOwn(result.verificationKeys,'__proto__'));
});
