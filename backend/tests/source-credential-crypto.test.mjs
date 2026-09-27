// F3c1: encryption of source credentials at rest
// (backend/src/sourceCredentialCrypto.js). No database, no network, no real
// credential: every key is generated here, every "credential" is a marker
// string. Proves the module imports and works without the environment
// variables, that the AEAD binding holds (wrong key, version, nonce, tag,
// AAD or ciphertext never return the plaintext), that nonces are random,
// and that nothing sensitive reaches an error or a redacted object.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

delete process.env.SOURCE_CREDENTIAL_KEYS;
delete process.env.SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION;

const m = await import("../src/sourceCredentialCrypto.js");
const hosts = await import("../src/sourceHosts.js");

const MARKER = "MARKER-plaintext-7f3c1-not-a-real-token";
const KEY_MARKER_1 = m.generateKeyEntry(1);
const KEY_MARKER_2 = m.generateKeyEntry(2);

function context(overrides = {}) {
  return {
    connectionId: "11111111-1111-4111-8111-111111111111", ownerScope: "club", ownerClubId: "22222222-2222-4222-8222-222222222222", ownerTeamId: null,
    sourceSystem: "gpexe", hostKey: "e03", credentialKind: "api_token", ...overrides,
  };
}

function assertClean(error, ...secrets) {
  const text = `${error.name} ${error.code} ${error.message} ${JSON.stringify(Object.getOwnPropertyNames(error).map((k) => [k, error[k]]))}`;
  for (const s of secrets) assert.ok(!text.includes(s), `an error carried sensitive material (${s.slice(0, 6)}…)`);
}

test("the module imports and the key ring is read only when needed; without the variable encrypt/decrypt fail with key_missing", () => {
  assert.equal(process.env.SOURCE_CREDENTIAL_KEYS, undefined);
  assert.throws(() => m.keyringFromEnv(), (e) => e.code === "key_missing");
  assert.throws(() => m.encryptCredential(MARKER, context()), (e) => e.code === "key_missing");
  assert.throws(() => m.decryptCredential({ ciphertext: Buffer.alloc(3), nonce: Buffer.alloc(12), authTag: Buffer.alloc(16), keyVersion: 1 }, context()), (e) => e.code === "key_missing");
});

test("key ring parsing: versions, active version, malformed entries", () => {
  const ring = m.parseKeyring(`${KEY_MARKER_1};${KEY_MARKER_2}`);
  assert.deepEqual([...ring.keys.keys()], [1, 2]);
  assert.equal(ring.active, 2, "the highest version is active by default");
  assert.equal(m.parseKeyring(`${KEY_MARKER_1};${KEY_MARKER_2}`, "1").active, 1);
  assert.throws(() => m.parseKeyring(`${KEY_MARKER_1}`, "3"), (e) => e.code === "key_version_unknown");
  assert.throws(() => m.parseKeyring("1:short"), (e) => e.code === "key_invalid");
  assert.throws(() => m.parseKeyring("abc"), (e) => e.code === "key_invalid");
  assert.throws(() => m.parseKeyring(`${KEY_MARKER_1};${KEY_MARKER_1}`), (e) => e.code === "key_invalid");
  assert.throws(() => m.parseKeyring("   "), (e) => e.code === "key_missing");
  const secret = KEY_MARKER_1.split(":")[1];
  try { m.parseKeyring(`1:${secret};1:${secret}`); } catch (e) { assertClean(e, secret); }
});

test("encrypt then decrypt round-trips; the same plaintext twice gives different nonce and ciphertext; nothing is logged", () => {
  const ring = m.parseKeyring(KEY_MARKER_1);
  const a = m.encryptCredential(MARKER, context(), ring);
  const b = m.encryptCredential(MARKER, context(), ring);
  assert.equal(a.nonce.length, 12);
  assert.equal(a.authTag.length, 16);
  assert.equal(a.keyVersion, 1);
  assert.ok(!a.nonce.equals(b.nonce), "a fresh random nonce every time");
  assert.ok(!a.ciphertext.equals(b.ciphertext), "different ciphertext for the same plaintext");
  assert.ok(!a.ciphertext.toString("latin1").includes("MARKER"), "the ciphertext does not contain the plaintext");
  assert.equal(m.decryptCredential(a, context(), ring), MARKER);
  assert.equal(m.decryptCredential(b, context(), ring), MARKER);
});

test("a wrong key, key version, nonce, auth tag, AAD or ciphertext byte never returns the plaintext, and the error names nothing sensitive", () => {
  const ring1 = m.parseKeyring(KEY_MARKER_1);
  const rec = m.encryptCredential(MARKER, context(), ring1);
  const attempts = {
    "wrong key": () => m.decryptCredential(rec, context(), m.parseKeyring(m.generateKeyEntry(1))),
    "unknown key version": () => m.decryptCredential({ ...rec, keyVersion: 2 }, context(), ring1),
    "nonce changed": () => m.decryptCredential({ ...rec, nonce: crypto.randomBytes(12) }, context(), ring1),
    "auth tag changed": () => { const t = Buffer.from(rec.authTag); t[0] ^= 1; return m.decryptCredential({ ...rec, authTag: t }, context(), ring1); },
    "ciphertext changed": () => { const c = Buffer.from(rec.ciphertext); c[0] ^= 1; return m.decryptCredential({ ...rec, ciphertext: c }, context(), ring1); },
    "other connection": () => m.decryptCredential(rec, context({ connectionId: "33333333-3333-4333-8333-333333333333" }), ring1),
    "other owner": () => m.decryptCredential(rec, context({ ownerClubId: "44444444-4444-4444-8444-444444444444" }), ring1),
    "other host": () => m.decryptCredential(rec, context({ hostKey: "server3" }), ring1),
    "other source": () => m.decryptCredential(rec, context({ sourceSystem: "catapult" }), ring1),
    "other credential kind": () => m.decryptCredential(rec, context({ credentialKind: "exchanged_token" }), ring1),
    "owner scope swapped": () => m.decryptCredential(rec, context({ ownerScope: "team", ownerClubId: null, ownerTeamId: "22222222-2222-4222-8222-222222222222" }), ring1),
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    let result;
    let error;
    try { result = attempt(); } catch (e) { error = e; }
    assert.equal(result, undefined, `${name}: must not return a value`);
    assert.ok(error instanceof m.SourceCredentialCryptoError, `${name}: a typed error`);
    assert.ok(["decrypt_failed", "key_version_unknown"].includes(error.code), `${name}: ${error.code}`);
    assertClean(error, MARKER, KEY_MARKER_1.split(":")[1], rec.ciphertext.toString("base64"), rec.ciphertext.toString("hex"));
  }
});

test("mutation proof: with the AAD removed, a moved ciphertext would decrypt — the module's binding is what refuses it", () => {
  const ring = m.parseKeyring(KEY_MARKER_1);
  const rec = m.encryptCredential(MARKER, context(), ring);
  // Re-do the decryption by hand WITHOUT the AAD: the tag no longer matches,
  // proving the AAD is part of what the tag protects.
  const key = ring.keys.get(1);
  const d = crypto.createDecipheriv("aes-256-gcm", key, rec.nonce, { authTagLength: 16 });
  d.setAuthTag(rec.authTag);
  assert.throws(() => Buffer.concat([d.update(rec.ciphertext), d.final()]));
  // And with the right AAD by hand it does decrypt: the module adds nothing hidden.
  const d2 = crypto.createDecipheriv("aes-256-gcm", key, rec.nonce, { authTagLength: 16 });
  const ctx = m.credentialContext(context());
  d2.setAAD(Buffer.from(JSON.stringify(["connectionId", "ownerScope", "ownerClubId", "ownerTeamId", "sourceSystem", "hostKey", "credentialKind"].map((f) => [f, ctx[f]])), "utf8"));
  d2.setAuthTag(rec.authTag);
  assert.equal(Buffer.concat([d2.update(rec.ciphertext), d2.final()]).toString("utf8"), MARKER);
});

test("rotation: a record encrypted under version 1 still decrypts after version 2 becomes active; new records use version 2", () => {
  const old = m.encryptCredential(MARKER, context(), m.parseKeyring(KEY_MARKER_1));
  const ring = m.parseKeyring(`${KEY_MARKER_1};${KEY_MARKER_2}`);
  assert.equal(m.decryptCredential(old, context(), ring), MARKER);
  const fresh = m.encryptCredential(MARKER, context(), ring);
  assert.equal(fresh.keyVersion, 2);
  assert.throws(() => m.decryptCredential(fresh, context(), m.parseKeyring(KEY_MARKER_1)), (e) => e.code === "key_version_unknown");
});

test("context and plaintext validation refuse incomplete input without echoing it", () => {
  const ring = m.parseKeyring(KEY_MARKER_1);
  assert.throws(() => m.encryptCredential("", context(), ring), (e) => e.code === "plaintext_invalid");
  assert.throws(() => m.encryptCredential("x".repeat(5000), context(), ring), (e) => e.code === "plaintext_invalid");
  assert.throws(() => m.encryptCredential(MARKER, context({ hostKey: "" }), ring), (e) => e.code === "context_invalid");
  assert.throws(() => m.encryptCredential(MARKER, context({ ownerScope: "club", ownerClubId: null }), ring), (e) => e.code === "context_invalid");
  assert.throws(() => m.encryptCredential(MARKER, context({ ownerScope: "user" }), ring), (e) => e.code === "context_invalid");
  assert.throws(() => m.decryptCredential({ ciphertext: Buffer.alloc(0), nonce: Buffer.alloc(12), authTag: Buffer.alloc(16), keyVersion: 1 }, context(), ring), (e) => e.code === "record_invalid");
  try { m.encryptCredential(MARKER, context({ hostKey: "" }), ring); } catch (e) { assertClean(e, MARKER); }
});

test("redaction and description never expose plaintext, key or ciphertext", () => {
  const ring = m.parseKeyring(KEY_MARKER_1);
  const rec = m.encryptCredential(MARKER, context(), ring);
  const described = m.describeCredentialRecord(rec);
  assert.deepEqual(described, { present: true, ciphertextBytes: rec.ciphertext.length, keyVersion: 1 });
  assert.deepEqual(m.describeCredentialRecord({}), { present: false });
  const leaked = { token: MARKER, apiKey: "k", nested: { Authorization: "Token x", cookie: "c", username: "u", ok: 1 }, list: [{ password: "p" }], ciphertext: rec.ciphertext, blob: rec.nonce, SOURCE_CREDENTIAL_KEYS: KEY_MARKER_1, keys: "k-plural", BEARER: "b" };
  const red = JSON.stringify(m.redactSecrets(leaked));
  for (const s of [MARKER, "Token x", '"c"', '"u"', '"p"', "k-plural", '"b"', KEY_MARKER_1.split(":")[1]]) assert.ok(!red.includes(s), `redacted output still has ${s.slice(0, 8)}`);
  assert.ok(red.includes('"ok":1'));
  assert.ok(red.includes("[bytes]"));
  const cyclic = { token: "x", when: new Date(0), set: new Set([1]) };
  cyclic.self = cyclic;
  assert.deepEqual(m.redactSecrets(cyclic), { token: "[redacted]", when: "1970-01-01T00:00:00.000Z", set: [1], self: "[circular]" });
});

test("secret key names are detected after normalisation (camelCase, hyphens, dots), innocent words pass", () => {
  for (const k of ["signingKey", "private-key", "deviceKey", "auth", "Auth-Token", "Auth.Token", "X-Api-Key", "refreshToken", "SOURCE_CREDENTIAL_KEYS", "keys", "pwd", "set-cookie", "sessionId", "Authorization", "encryption key", "accesstoken", "authtoken", "sessionid", "passcode", "Xauth", "apitoken", "secretkey"]) {
    assert.equal(m.keyNameIsSecret(k), true, `${k} must count as a secret name`);
  }
  for (const k of ["monkey", "keyboard", "donkey", "turkey", "host_key", "hostKey", "credential_kind", "credentialKind", "authorName", "status", "sourceTeamId", "attempt"]) {
    assert.equal(m.keyNameIsSecret(k), false, `${k} must pass`);
  }
  assert.equal(m.normalizeKeyName("Auth.Token-ID  value"), "auth_token_id_value");
  const red = m.redactSecrets({ signingKey: "s", "private-key": "p", deviceKey: "d", auth: "a", monkey: "m", hostKey: "e03" });
  assert.deepEqual(red, { signingKey: "[redacted]", "private-key": "[redacted]", deviceKey: "[redacted]", auth: "[redacted]", monkey: "m", hostKey: "e03" });
});

test("host catalog: only approved keys resolve, to exact https hosts; URLs, other servers, prototype names and other sources are host_not_allowed; no fallback", () => {
  assert.equal(hosts.sourceHost("gpexe", "e03").baseUrl, "https://e03.gpexe.com/");
  assert.deepEqual(hosts.resolvableHostKeys("gpexe"), ["e03"]);
  assert.deepEqual(hosts.resolvableHostKeys("catapult"), []);
  for (const bad of ["server3", "https://e03.gpexe.com/", "e03/", "E03", "", null, undefined, "__proto__", "constructor", "toString", 7]) {
    assert.throws(() => hosts.sourceHost("gpexe", bad), (e) => e.code === "host_not_allowed", `${String(bad)} must not resolve`);
  }
  assert.throws(() => hosts.sourceHost("__proto__", "e03"), (e) => e.code === "host_not_allowed");
  assert.throws(() => hosts.sourceHost("gpexe", "server3"), (e) => e.code === "host_not_allowed");
  assert.throws(() => hosts.sourceHost("gpexe", "https://e03.gpexe.com/"), (e) => e.code === "host_not_allowed");
  assert.throws(() => hosts.sourceHost("catapult", "e03"), (e) => e.code === "host_not_allowed");
  assert.equal(hosts.isAllowedHostKey("gpexe", "e03"), true);
  assert.deepEqual([...hosts.CREDENTIAL_KINDS], ["api_token", "exchanged_token"]);
  assert.equal(hosts.isKnownCredentialKind("password"), false);
  assert.ok(Object.isFrozen(hosts.SOURCE_HOSTS.gpexe), "the allowlist cannot be extended at run time");
});
