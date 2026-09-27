// The fixed host allowlist for source credential connections (F3c1;
// docs/ai/gpexe-f3c-auth-discovery.md D1, section 4 rule 4). A connection
// row stores only a host key; the base URL comes from here, never from a
// row, a request or an administrator. Extending this table is a code change
// plus a migration (the database CHECK on host_key lists the same keys), so
// no host can ever be added by data alone.
export const SOURCE_HOSTS = Object.freeze({
  gpexe: Object.freeze({
    e03: Object.freeze({ baseUrl: "https://e03.gpexe.com/", label: "GPEXE e03" }),
  }),
});

// The kinds of credential a connection may hold (owner decision 2026-09-27):
//   api_token        — an official API token entered by the administrator;
//                      OptiMove never sees a password. Preferred.
//   exchanged_token  — a token obtained once from a username/password
//                      exchange, allowed only as a fallback when the source
//                      has no official token generation; the password is
//                      used for that one exchange and never stored or logged.
// Both store the same thing: an opaque encrypted token. F3c1 supports both
// and chooses neither; the choice belongs to F3c2 per source.
export const CREDENTIAL_KINDS = Object.freeze(["api_token", "exchanged_token"]);

export function sourceHost(sourceSystem, hostKey) {
  const host = SOURCE_HOSTS[sourceSystem]?.[hostKey];
  if (!host) {
    const error = new Error("unknown source host");
    error.code = "host_not_allowed";
    throw error;
  }
  return host;
}

export function isAllowedHostKey(sourceSystem, hostKey) {
  return Boolean(SOURCE_HOSTS[sourceSystem]?.[hostKey]);
}

export function isKnownCredentialKind(kind) {
  return CREDENTIAL_KINDS.includes(kind);
}
