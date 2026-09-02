// perf/main-navigation-cache: a small, generic in-memory cache for
// navigation-triggered view data (Coaches, Settings/Organization, Program
// Library, Exercise Library, Builder's drafts list) - NOT localStorage/
// sessionStorage (never persisted past a page reload, by design for this
// PR), and NOT a parallel state system: call sites still keep their own
// render-facing state (state.coaches, state.organization.data,
// state.lastTemplates, ...) exactly as before. This module only remembers
// what was last fetched for a given (namespace, contextKey) pair so a
// re-entry into an already-loaded view can render instantly instead of
// showing an empty "Loading..." screen again.
//
// A "context key" must encode everything that legitimately changes which
// data is correct to show - at minimum the account id and active workspace
// (type + scope id), plus whatever view-specific filters/search/pagination
// apply (see buildContextKey). Two different context keys are simply two
// different cache slots - switching back to a context you've already
// visited is a legitimate cache hit, not a leak; the actual invariant this
// module exists to protect is that a render call must never apply data
// fetched for a DIFFERENT context than the one currently on screen (see
// loadCachedView's getCurrentContextKey race guard) and that logout/account
// switch clears everything (see clearAllViewCache).
export const VIEW_CACHE_FRESHNESS_MS = 30000;

const store = new Map();

// perf/training-load-perf-nav-results correction round 2: a monotonic
// per-key revision counter, tracked SEPARATELY from `store` so it survives
// invalidateCacheEntry's own deletion of the entry object. Reproduced race
// this exists to close: request A starts for key K; a mutation invalidates
// K (deleting its entry, including A's own pendingPromise tracking) and
// starts a fresh request B for the same K; B resolves first and writes
// genuinely fresh data; A - still in flight, fetched BEFORE the mutation -
// resolves last and, without this guard, would silently overwrite B's
// fresh write with its own stale one (loadCachedView calls setCacheData
// unconditionally on any successful response). Bumped by every
// invalidateCacheEntry/invalidateCacheNamespace/clearAllViewCache call;
// loadCachedView snapshots it right before fetching and re-checks it right
// after - if it moved, the response is void and is neither written to the
// cache nor handed to the caller's applyData/applyError (see that
// function's own comments below).
const revisions = new Map();

function storeKey(namespace, contextKey) {
  return `${namespace}::${contextKey}`;
}

function bumpRevision(key) {
  revisions.set(key, (revisions.get(key) || 0) + 1);
}

// Exported so a caller that needs to detect "was this key invalidated
// since I last looked" outside of loadCachedView's own built-in guard
// (below) can snapshot the current revision itself.
export function getCacheRevision(namespace, contextKey) {
  return revisions.get(storeKey(namespace, contextKey)) || 0;
}

// Joins primitive context parts into one stable string key. null/undefined
// become "" rather than the literal strings "null"/"undefined", so a missing
// workspace scope (platform/private_coach workspaces have no scopeId) never
// silently collides with a real "null" filter value elsewhere.
export function buildContextKey(parts) {
  return parts.map((part) => (part === null || part === undefined ? "" : String(part))).join("|");
}

export function getCacheEntry(namespace, contextKey) {
  return store.get(storeKey(namespace, contextKey));
}

export function hasCachedData(entry) {
  return Boolean(entry) && entry.data !== undefined && entry.data !== null;
}

export function isEntryFresh(entry, ttlMs = VIEW_CACHE_FRESHNESS_MS) {
  return Boolean(entry) && entry.status === "ready" && Date.now() - entry.loadedAt < ttlMs;
}

export function setCacheData(namespace, contextKey, data) {
  const key = storeKey(namespace, contextKey);
  const existing = store.get(key);
  store.set(key, { data, status: "ready", loadedAt: Date.now(), contextKey, error: null, pendingPromise: existing?.pendingPromise ?? null });
}

// A failed fetch keeps any previously-cached good data completely
// untouched (only `error`/`pendingPromise` change) - a background refresh
// that fails must never make an already-usable screen go blank or stale-shy.
// Only when there was NOTHING cached yet does this record a real error
// entry for the caller's existing error/retry UI to show.
export function setCacheError(namespace, contextKey, error) {
  const key = storeKey(namespace, contextKey);
  const existing = store.get(key);
  if (hasCachedData(existing)) {
    store.set(key, { ...existing, error, pendingPromise: null });
    return { keptCache: true };
  }
  store.set(key, { data: null, status: "error", loadedAt: Date.now(), contextKey, error, pendingPromise: null });
  return { keptCache: false };
}

export function getPendingRequest(namespace, contextKey) {
  return getCacheEntry(namespace, contextKey)?.pendingPromise || null;
}

function setPendingRequest(namespace, contextKey, promise) {
  const key = storeKey(namespace, contextKey);
  const existing = store.get(key);
  store.set(key, existing ? { ...existing, pendingPromise: promise } : { data: null, status: "loading", loadedAt: 0, contextKey, error: null, pendingPromise: promise });
}

// Correction: only clears the pendingPromise reference if it's STILL the
// exact promise THIS call itself set. invalidateCacheEntry deletes the
// WHOLE entry (not just its pendingPromise), so an older in-flight
// request's own tracking is gone the instant a mutation invalidates its
// key - a NEWER dedupeRequest call for that same key then creates a fresh
// entry/promise of its own. Without this own-reference check, the OLDER
// request's `.finally()` (firing later, since it's still genuinely in
// flight) would blindly null out whatever `pendingPromise` currently sits
// in the entry - which by then belongs to the NEWER, still-actually-
// pending request - making a THIRD caller think nothing is in flight and
// fire a redundant extra fetch.
function clearPendingRequest(namespace, contextKey, ownPromise) {
  const key = storeKey(namespace, contextKey);
  const existing = store.get(key);
  if (existing && existing.pendingPromise === ownPromise) store.set(key, { ...existing, pendingPromise: null });
}

// Two fast clicks (or a click racing a background refresh) into the exact
// same (namespace, contextKey) collapse into a single real request - every
// caller gets the SAME promise instead of firing a second identical one.
export function dedupeRequest(namespace, contextKey, fetcher) {
  const existingPromise = getPendingRequest(namespace, contextKey);
  if (existingPromise) return existingPromise;
  const promise = fetcher();
  setPendingRequest(namespace, contextKey, promise);
  // .catch(() => {}) on this SEPARATE derived chain only - it exists purely
  // for the cleanup side effect, never to consume/handle the rejection for
  // real callers (the returned `promise` itself is untouched and still
  // rejects normally for whoever awaits it). Without this, a rejected
  // fetch would leave this internal, nobody-awaits-it .finally() chain
  // looking like an unhandled rejection to the runtime.
  promise.finally(() => clearPendingRequest(namespace, contextKey, promise)).catch(() => {});
  return promise;
}

export function invalidateCacheEntry(namespace, contextKey) {
  const key = storeKey(namespace, contextKey);
  store.delete(key);
  bumpRevision(key);
}

export function invalidateCacheNamespace(namespace) {
  const prefix = `${namespace}::`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      bumpRevision(key);
    }
  }
}

// perf/training-load-perf-nav-results correction round 3: a mutation whose
// blast radius is "this one identity+week (or any other fixed prefix of a
// context key), under ANY value of whatever comes after it" - e.g. a
// training-load session toggle affects the same week shown under every
// different club/team/athlete filter a coach has separately cached, not
// just the one filter that happened to be active when the toggle was
// clicked. `contextKeyPrefix` is joined onto `namespace` the same way a
// full contextKey would be (see storeKey) - callers build it with
// buildContextKey(leadingParts) + the same "|" separator buildContextKey
// itself uses, so a real match never accidentally spans a value boundary
// (e.g. week "2026-08-2" matching a stored "2026-08-24" instead of
// requiring the full "2026-08-24|" segment boundary).
export function invalidateCacheEntriesWithPrefix(namespace, contextKeyPrefix) {
  const prefix = `${namespace}::${contextKeyPrefix}`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      bumpRevision(key);
    }
  }
}

// Logout/account switch: every cached view for the outgoing account must be
// gone, not just marked stale - the very next render of any view for
// whoever is signed in next must never be able to read a leftover entry.
// Also bumps every currently-tracked key's own revision (see the
// `revisions` Map's own header) so any request still in flight from the
// outgoing account, however unlikely, can never write its response into
// the fresh state the next account starts with.
export function clearAllViewCache() {
  for (const key of store.keys()) bumpRevision(key);
  store.clear();
}

// The single call sites use to both read-and-render cached data immediately
// and, when appropriate, kick off a request:
//   - nothing cached yet: `showLoading()` (unchanged existing loading UI),
//     then fetch and apply.
//   - cached and fresh (< ttlMs old): apply the cached data, no request.
//   - cached but stale: apply the cached data immediately (no loading
//     screen, no flicker), then refresh in the background.
// `getCurrentContextKey` (optional) is the race guard: called again right
// after the request resolves/rejects - if the context the user is actually
// looking at has since changed (workspace switch, account switch, a
// different filter selected), the result is silently dropped instead of
// being applied to state.
export async function loadCachedView({
  namespace,
  contextKey,
  ttlMs = VIEW_CACHE_FRESHNESS_MS,
  forceRefresh = false,
  fetcher,
  applyData,
  applyError,
  showLoading,
  getCurrentContextKey,
}) {
  const entry = getCacheEntry(namespace, contextKey);
  const cached = hasCachedData(entry);
  if (cached) {
    // Awaited so a caller that itself needs to do something after the
    // render (e.g. Settings' presets section loading taxonomy data before
    // painting) can rely on the cached paint having actually happened
    // before this function's own promise resolves - applyData may be a
    // plain sync function (the common case) or return a promise.
    await applyData(entry.data, { fromCache: true });
    if (!forceRefresh && isEntryFresh(entry, ttlMs)) return { outcome: "fresh-cache" };
  } else {
    showLoading?.();
  }
  // Snapshotted right before fetching/joining a fetch (see the `revisions`
  // Map's own header for the exact race this guards) - re-checked below,
  // after the await, for BOTH the success and error paths. A mismatch
  // means some invalidation happened while this response was in flight -
  // it is now void: never written to the cache (which could silently
  // clobber a fresher write that already landed) and never handed to the
  // caller's applyData/applyError (which could show pre-mutation data as
  // current, or a now-irrelevant error over a fresher result).
  const startRevision = getCacheRevision(namespace, contextKey);
  try {
    const data = await dedupeRequest(namespace, contextKey, fetcher);
    if (getCurrentContextKey && getCurrentContextKey() !== contextKey) return { outcome: "stale-ignored" };
    if (getCacheRevision(namespace, contextKey) !== startRevision) return { outcome: "stale-ignored" };
    setCacheData(namespace, contextKey, data);
    await applyData(data, { fromCache: false });
    return { outcome: cached ? "background-refreshed" : "loaded" };
  } catch (error) {
    if (getCurrentContextKey && getCurrentContextKey() !== contextKey) return { outcome: "stale-ignored" };
    if (getCacheRevision(namespace, contextKey) !== startRevision) return { outcome: "stale-ignored" };
    const { keptCache } = setCacheError(namespace, contextKey, error);
    if (!keptCache) {
      await applyError?.(error);
      return { outcome: "error" };
    }
    return { outcome: "background-refresh-failed" };
  }
}

// Test-only introspection - never used by application code.
export function __debugCacheSize() {
  return store.size;
}
