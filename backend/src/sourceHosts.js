// The host catalog for source credential connections (F3c1;
// docs/ai/gpexe-f3c-auth-discovery.md D1, section 4 rule 4). A source may
// run on several servers (one per organisation); a connection row stores
// only a host key and the exact HTTPS base URL comes from here, never from
// a row, a request or an administrator. Two layers, both required before
// any network call, with no fallback to another host:
//   * the database catalog (training_load.source_host_catalog) says whether
//     a key is APPROVED now; a retired key takes no new connection and no
//     new binding there;
//   * this module maps the key to an exact HTTPS host; sourceHost() alone
//     does NOT know whether the key was retired.
// resolveApprovedSourceHost() checks both and is the only resolver a
// network caller may use (mandatory F3c2 gate: read the catalog row in the
// same request, pass it here, refuse with host_not_allowed otherwise).
//
// Adding a confirmed server = one entry here (exact https host, no path
// games) + one approved row in training_load.source_host_catalog (a
// data-only migration). Neither alone is enough: the database refuses a
// connection whose key is not approved, the backend refuses a request whose
// key it cannot resolve. server3 is deliberately absent until a dedicated
// API account and Team ID 980 are confirmed to work there.
export const SOURCE_HOSTS = Object.freeze({
  gpexe: Object.freeze({
    e03: Object.freeze({ baseUrl: "https://e03.gpexe.com/", label: "GPEXE e03" }),
  }),
});

const EXACT_HTTPS_HOST = /^https:\/\/[a-z0-9.-]+\/$/;
for (const hosts of Object.values(SOURCE_HOSTS)) {
  for (const host of Object.values(hosts)) {
    if (!EXACT_HTTPS_HOST.test(host.baseUrl)) throw new Error("sourceHosts: every catalog entry must be an exact https host with a trailing slash");
  }
}

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

// Resolves a key to its host. Only an own, string key of the source's
// catalog resolves; anything else — another source's key, a URL, a
// prototype name, an empty value — is host_not_allowed. There is no default
// and no fallback.
export function sourceHost(sourceSystem, hostKey) {
  const hosts = Object.prototype.hasOwnProperty.call(SOURCE_HOSTS, sourceSystem) ? SOURCE_HOSTS[sourceSystem] : null;
  const host = hosts && typeof hostKey === "string" && Object.prototype.hasOwnProperty.call(hosts, hostKey) ? hosts[hostKey] : null;
  if (!host) {
    const error = new Error("unknown source host");
    error.code = "host_not_allowed";
    throw error;
  }
  return host;
}

// The approved keys the backend can resolve for a source (what a platform
// admin may choose from, intersected by F3c2 with the database catalog).
export function resolvableHostKeys(sourceSystem) {
  return Object.prototype.hasOwnProperty.call(SOURCE_HOSTS, sourceSystem) ? Object.keys(SOURCE_HOSTS[sourceSystem]) : [];
}

// The gate before any network call (F3c2): the connection's catalog row,
// read from the database in the same request, must be the same source and
// key and approved, AND the key must resolve here. Anything else -
// no row, a retired row, a row for another key, a key the code does not
// know - is host_not_allowed. There is no fallback.
export function resolveApprovedSourceHost(sourceSystem, hostKey, catalogRow) {
  const approved = catalogRow
    && catalogRow.source_system === sourceSystem
    && catalogRow.host_key === hostKey
    && catalogRow.state === "approved";
  if (!approved) {
    const error = new Error("source host is not approved");
    error.code = "host_not_allowed";
    throw error;
  }
  return sourceHost(sourceSystem, hostKey);
}

export function isAllowedHostKey(sourceSystem, hostKey) {
  try {
    sourceHost(sourceSystem, hostKey);
    return true;
  } catch {
    return false;
  }
}

export function isKnownCredentialKind(kind) {
  return CREDENTIAL_KINDS.includes(kind);
}
