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

function storeKey(namespace, contextKey) {
  return `${namespace}::${contextKey}`;
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

function clearPendingRequest(namespace, contextKey) {
  const key = storeKey(namespace, contextKey);
  const existing = store.get(key);
  if (existing) store.set(key, { ...existing, pendingPromise: null });
}

// Two fast clicks (or a click racing a background refresh) into the exact
// same (namespace, contextKey) collapse into a single real request - every
// caller gets the SAME promise instead of firing a second identical one.
export function dedupeRequest(namespace, contextKey, fetcher) {
  const existingPromise = getPendingRequest(namespace, contextKey);
  if (existingPromise) return existingPromise;
  const promise = fetcher().finally(() => clearPendingRequest(namespace, contextKey));
  setPendingRequest(namespace, contextKey, promise);
  return promise;
}

export function invalidateCacheEntry(namespace, contextKey) {
  store.delete(storeKey(namespace, contextKey));
}

export function invalidateCacheNamespace(namespace) {
  const prefix = `${namespace}::`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

// Logout/account switch: every cached view for the outgoing account must be
// gone, not just marked stale - the very next render of any view for
// whoever is signed in next must never be able to read a leftover entry.
export function clearAllViewCache() {
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
  try {
    const data = await dedupeRequest(namespace, contextKey, fetcher);
    if (getCurrentContextKey && getCurrentContextKey() !== contextKey) return { outcome: "stale-ignored" };
    setCacheData(namespace, contextKey, data);
    await applyData(data, { fromCache: false });
    return { outcome: cached ? "background-refreshed" : "loaded" };
  } catch (error) {
    const { keptCache } = setCacheError(namespace, contextKey, error);
    if (getCurrentContextKey && getCurrentContextKey() !== contextKey) return { outcome: "stale-ignored" };
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
