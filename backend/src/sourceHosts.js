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
// A host key never implies paths. Every entry is a complete PROFILE:
//   baseUrl      the exact https host, trailing slash, nothing else;
//   apiFamily    which API the host speaks; each family has ONE path prefix
//                (API_FAMILIES); a data URL is always baseUrl + that prefix
//                + a relative resource path (sourceApiUrl);
//   authScheme   the Authorization scheme word;
//   exchange     how a username/password pair becomes a token on this host
//                (path, body encoding, the answer's token field), or null
//                when no exchange has been confirmed there.
// Nothing here tries a second host, a second family or a second encoding:
// every function takes one host key and answers for that key only.
//
// Adding a confirmed server = one entry here + one approved row in
// training_load.source_host_catalog (a data-only migration). Neither alone
// is enough: the database refuses a connection whose key is not approved,
// the backend refuses a request whose key it cannot resolve.
//   e03      GPEXE api family. No credential exchange has succeeded there
//            (one refused attempt, 2026-09-29), so exchange is null.
//   server3  GPEXE rest/v1 family, confirmed by the owner-run verification
//            of 2026-09-29 (docs/ai/source-connections-f3c2-contract.md
//            section 1.8): exchange POST api-token-auth/ form-encoded,
//            answer field "token", scheme Token, team list and team read.
export const API_FAMILIES = Object.freeze({
  api: "api/",
  rest_v1: "rest/v1/",
});
export const EXCHANGE_ENCODINGS = Object.freeze(["form", "json"]);
// Every host of a source lies under that source's own domain; a catalog
// entry anywhere else is refused when this module loads.
export const SOURCE_DOMAINS = Object.freeze({
  gpexe: ".gpexe.com",
});

export const SOURCE_HOSTS = Object.freeze({
  gpexe: Object.freeze({
    e03: Object.freeze({
      baseUrl: "https://e03.gpexe.com/", label: "GPEXE e03",
      apiFamily: "api", authScheme: "Token", exchange: null,
    }),
    server3: Object.freeze({
      baseUrl: "https://server3.gpexe.com/", label: "GPEXE server3",
      apiFamily: "rest_v1", authScheme: "Token",
      exchange: Object.freeze({ path: "api-token-auth/", encoding: "form", tokenField: "token" }),
    }),
  }),
});

const EXACT_HTTPS_HOST = /^https:\/\/[a-z0-9.-]+\/$/;
const SCHEME_WORD = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const EXCHANGE_PATH = /^[a-z0-9_-]+\/$/;
const FIELD_NAME = /^(?!(?:__proto__|constructor|prototype|hasOwnProperty|toString|valueOf)$)[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HOST_LABELS = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
// A relative resource path: lower-case segments, digits, _ and -, each
// followed by a slash, then an optional query of plain key=value pairs. No
// leading slash, no dot, no colon, no backslash, no empty segment — so no
// "..", no "//host", no scheme.
const RESOURCE_PATH = /^(?:[a-z0-9_-]+\/)+(?:\?[A-Za-z0-9_]+=[A-Za-z0-9_.:-]*(?:&[A-Za-z0-9_]+=[A-Za-z0-9_.:-]*)*)?$/;

const own = (object, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key);

for (const [source, hosts] of Object.entries(SOURCE_HOSTS)) {
  const seen = new Set();
  const domain = own(SOURCE_DOMAINS, source) ? SOURCE_DOMAINS[source] : null;
  if (!domain) throw new Error("sourceHosts: every source names its domain");
  for (const host of Object.values(hosts)) {
    if (!EXACT_HTTPS_HOST.test(host.baseUrl)) throw new Error("sourceHosts: every catalog entry must be an exact https host with a trailing slash");
    const name = host.baseUrl.slice("https://".length, -1);
    if (!name.endsWith(domain) || !HOST_LABELS.test(name.slice(0, -domain.length))) throw new Error("sourceHosts: a host lies under its source's own domain");
    if (seen.has(host.baseUrl)) throw new Error("sourceHosts: two host keys may not share one base URL");
    seen.add(host.baseUrl);
    if (!own(API_FAMILIES, host.apiFamily)) throw new Error("sourceHosts: every catalog entry names a known API family");
    if (!SCHEME_WORD.test(host.authScheme)) throw new Error("sourceHosts: every catalog entry names one auth scheme word");
    if (host.exchange !== null) {
      if (!EXCHANGE_PATH.test(host.exchange.path)) throw new Error("sourceHosts: an exchange path is one relative segment ending in /");
      if (!EXCHANGE_ENCODINGS.includes(host.exchange.encoding)) throw new Error("sourceHosts: an exchange encoding is form or json");
      if (!FIELD_NAME.test(host.exchange.tokenField)) throw new Error("sourceHosts: an exchange names the answer's token field");
    }
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

function notAllowed(message, code = "host_not_allowed") {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Resolves a key to its host profile. Only an own, string key of the
// source's catalog resolves; anything else — another source's key, a URL, a
// prototype name, an empty value — is host_not_allowed. There is no default
// and no fallback.
export function sourceHost(sourceSystem, hostKey) {
  const hosts = own(SOURCE_HOSTS, sourceSystem) ? SOURCE_HOSTS[sourceSystem] : null;
  const host = hosts && own(hosts, hostKey) ? hosts[hostKey] : null;
  if (!host) throw notAllowed("unknown source host");
  return host;
}

// The approved keys the backend can resolve for a source (what a platform
// admin may choose from, intersected by F3c2 with the database catalog).
export function resolvableHostKeys(sourceSystem) {
  return own(SOURCE_HOSTS, sourceSystem) ? Object.keys(SOURCE_HOSTS[sourceSystem]) : [];
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
  if (!approved) throw notAllowed("source host is not approved");
  return sourceHost(sourceSystem, hostKey);
}

// The one way to build a data URL: this host's exact base URL, this host's
// family prefix, then a relative resource path. The path can never leave
// the prefix, and no other host or family is ever consulted. It goes
// through the gate itself: without the connection's APPROVED catalog row
// (read from the database in the same request) there is no URL.
// It scopes the host and the family ONLY. It does not know which source
// team a connection is bound to; limiting every request to the bound team
// is the adapter's duty (F3c2), not proven by this function.
export function sourceApiUrl(sourceSystem, hostKey, catalogRow, resourcePath) {
  const host = resolveApprovedSourceHost(sourceSystem, hostKey, catalogRow);
  if (typeof resourcePath !== "string" || resourcePath.length > 512 || !RESOURCE_PATH.test(resourcePath)) {
    throw notAllowed("a resource path is relative: lower-case segments ending in /, then an optional plain query", "path_not_allowed");
  }
  const root = `${host.baseUrl}${API_FAMILIES[host.apiFamily]}`;
  const url = new URL(resourcePath, root);
  if (url.origin !== new URL(host.baseUrl).origin || !url.href.startsWith(root) || url.username || url.password) {
    throw notAllowed("a resource path may not leave the host's API family", "path_not_allowed");
  }
  return url.href;
}

// The exchange of this host, or exchange_not_supported when none has been
// confirmed there. Never another host's exchange, and, like sourceApiUrl,
// never without the connection's approved catalog row.
export function sourceExchange(sourceSystem, hostKey, catalogRow) {
  const host = resolveApprovedSourceHost(sourceSystem, hostKey, catalogRow);
  if (!host.exchange) throw notAllowed("no credential exchange is confirmed on this host", "exchange_not_supported");
  return Object.freeze({ url: `${host.baseUrl}${host.exchange.path}`, encoding: host.exchange.encoding, tokenField: host.exchange.tokenField, authScheme: host.authScheme });
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
