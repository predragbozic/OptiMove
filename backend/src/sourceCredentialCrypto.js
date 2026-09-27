// Encryption of source credentials at rest (F3c1). Contract:
// docs/ai/gpexe-f3c-auth-discovery.md, section 4 rule 2 and section 8c.
//
//   * AES-256-GCM from Node's standard library: a random 12-byte nonce per
//     encryption, a 16-byte authentication tag, a key version, and
//     additional authenticated data (AAD) that binds the ciphertext to the
//     row it belongs to (connection id, owner, source system, host key,
//     credential kind). Moving a ciphertext to another row, owner or host
//     makes it undecryptable.
//   * The key ring comes only from the server environment
//     (SOURCE_CREDENTIAL_KEYS, see keyringFromEnv) and is read when a
//     credential is encrypted or decrypted — never at import and never at
//     server start. A deploy without the variable starts normally; the
//     first encrypt/decrypt then fails with a stable code.
//   * Nothing here logs. Every error carries a stable code and a message
//     that names no plaintext, no key material and no ciphertext.
import crypto from "node:crypto";

export const CIPHER = "aes-256-gcm";
export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const AUTH_TAG_BYTES = 16;
export const KEYS_ENV = "SOURCE_CREDENTIAL_KEYS";
export const ACTIVE_VERSION_ENV = "SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION";
export const MAX_PLAINTEXT_BYTES = 4096;

export class SourceCredentialCryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SourceCredentialCryptoError";
    this.code = code;
  }
}

const fail = (code, message) => new SourceCredentialCryptoError(code, message);

// The key ring: "1:<base64 of 32 bytes>;2:<base64 of 32 bytes>". The active
// version (the one new credentials are encrypted with) is
// SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION, or the highest version present.
// Older versions stay for decryption until every row is re-encrypted
// (rotation, see the runbook). The parsed keys never leave this module.
export function parseKeyring(spec, activeSpec = undefined) {
  if (typeof spec !== "string" || !spec.trim()) throw fail("key_missing", `${KEYS_ENV} is not set on the server.`);
  const keys = new Map();
  for (const part of spec.split(";").map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^([1-9][0-9]{0,5}):([A-Za-z0-9+/=_-]+)$/);
    if (!m) throw fail("key_invalid", `${KEYS_ENV} has an entry that is not <version>:<base64 key>.`);
    const version = Number(m[1]);
    let raw;
    try {
      raw = Buffer.from(m[2], "base64");
    } catch {
      throw fail("key_invalid", `${KEYS_ENV} entry ${version} is not base64.`);
    }
    if (raw.length !== KEY_BYTES) throw fail("key_invalid", `${KEYS_ENV} entry ${version} is not ${KEY_BYTES} bytes.`);
    if (keys.has(version)) throw fail("key_invalid", `${KEYS_ENV} names version ${version} twice.`);
    keys.set(version, raw);
  }
  if (!keys.size) throw fail("key_missing", `${KEYS_ENV} holds no key.`);
  let active;
  if (activeSpec !== undefined && activeSpec !== null && String(activeSpec).trim() !== "") {
    active = Number(String(activeSpec).trim());
    if (!Number.isInteger(active) || !keys.has(active)) throw fail("key_version_unknown", `${ACTIVE_VERSION_ENV} names a version that is not in ${KEYS_ENV}.`);
  } else {
    active = Math.max(...keys.keys());
  }
  return { keys, active };
}

export function keyringFromEnv(env = process.env) {
  return parseKeyring(env[KEYS_ENV], env[ACTIVE_VERSION_ENV]);
}

// A fresh random key ring entry for tests and for rotation runbooks. Never
// called by the application at run time.
export function generateKeyEntry(version) {
  return `${version}:${crypto.randomBytes(KEY_BYTES).toString("base64")}`;
}

// The context every ciphertext is bound to. Its canonical JSON is the AAD.
// Every field is required so that two rows can never share a context.
const CONTEXT_FIELDS = ["connectionId", "ownerScope", "ownerClubId", "ownerTeamId", "sourceSystem", "hostKey", "credentialKind"];

export function credentialContext(input) {
  const out = {};
  for (const field of CONTEXT_FIELDS) {
    const value = input?.[field];
    if (field === "ownerClubId" || field === "ownerTeamId") {
      if (value !== null && value !== undefined && typeof value !== "string") throw fail("context_invalid", `${field} must be a string or null.`);
      out[field] = value ?? null;
      continue;
    }
    if (typeof value !== "string" || !value) throw fail("context_invalid", `${field} is required for the credential context.`);
    out[field] = value;
  }
  if (out.ownerScope === "club" ? !out.ownerClubId || out.ownerTeamId : out.ownerScope === "team" ? !out.ownerTeamId || out.ownerClubId : true) {
    throw fail("context_invalid", "ownerScope must be club (with ownerClubId) or team (with ownerTeamId).");
  }
  return out;
}

function aadOf(context) {
  const ctx = credentialContext(context);
  return Buffer.from(JSON.stringify(CONTEXT_FIELDS.map((f) => [f, ctx[f]])), "utf8");
}

// Encrypts a credential for one row. Returns the four parts the row stores;
// the plaintext is not kept anywhere here.
export function encryptCredential(plaintext, context, keyring = keyringFromEnv()) {
  if (typeof plaintext !== "string" || !plaintext) throw fail("plaintext_invalid", "the credential to store must be a non-empty string.");
  const bytes = Buffer.from(plaintext, "utf8");
  if (bytes.length > MAX_PLAINTEXT_BYTES) throw fail("plaintext_invalid", `the credential is longer than ${MAX_PLAINTEXT_BYTES} bytes.`);
  const aad = aadOf(context);
  const version = keyring.active;
  const key = keyring.keys.get(version);
  if (!key) throw fail("key_version_unknown", "the active key version is not in the key ring.");
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(CIPHER, key, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aad, { plaintextLength: bytes.length });
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  bytes.fill(0);
  return { ciphertext, nonce, authTag, keyVersion: version };
}

// Decrypts one row's credential. A wrong key, key version, nonce, tag, AAD
// or a changed ciphertext all end in one error (decrypt_failed): nothing is
// returned and nothing says which part was wrong.
export function decryptCredential({ ciphertext, nonce, authTag, keyVersion }, context, keyring = keyringFromEnv()) {
  if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw fail("record_invalid", "the stored credential is incomplete.");
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) throw fail("record_invalid", "the stored credential is incomplete.");
  if (!Buffer.isBuffer(authTag) || authTag.length !== AUTH_TAG_BYTES) throw fail("record_invalid", "the stored credential is incomplete.");
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw fail("record_invalid", "the stored credential is incomplete.");
  const aad = aadOf(context);
  const key = keyring.keys.get(keyVersion);
  if (!key) throw fail("key_version_unknown", `the server has no key for version ${keyVersion}.`);
  try {
    const decipher = crypto.createDecipheriv(CIPHER, key, nonce, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw fail("decrypt_failed", "the stored credential could not be decrypted with the server's key.");
  }
}

// What a log line or an error detail may say about a stored credential:
// only that one exists, how long it is and which key version it uses.
export function describeCredentialRecord(record) {
  if (!record?.ciphertext) return { present: false };
  return { present: true, ciphertextBytes: record.ciphertext.length, keyVersion: record.keyVersion ?? null };
}

// Removes every field that could carry a secret from an object before it is
// logged or answered. Keys are matched by NAME only (case-insensitive), not
// by content: a secret stored under an innocent key is not detected. F3c2
// therefore never passes raw HTTP header or cookie objects through here; it
// builds its own sanitized objects.
const SECRET_KEY = /(token|password|passwd|secret|authorization|bearer|cookie|jwt|session|credential|ciphertext|nonce|auth_?tag|api[_-]?key|(^|_)keys?$|username|login|^email$|^user$)/i;

export function redactSecrets(value, seen = new WeakSet()) {
  if (Buffer.isBuffer(value)) return "[bytes]";
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => redactSecrets(v, seen));
    if (value instanceof Map) return redactSecrets(Object.fromEntries(value), seen);
    if (value instanceof Set) return redactSecrets([...value], seen);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redactSecrets(v, seen)]));
  }
  return value;
}
