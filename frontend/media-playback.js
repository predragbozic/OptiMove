import { api } from "./api.js";
import { decodeAccessContext, parseImageFallbacks } from "./media.js";

// ---------------------------------------------------------------------------
// Short-lived access to R2 media (FE-1).
//
// The only module that knows the two access routes of the media contract
// (owner's summary of the Codex contract, 2026-10-19):
//
//   POST /api/media/access        { assetId, accessContext }
//                                 -> { url, expiresAt }
//   POST /api/media/access/batch  { items: [{ assetId, accessContext }] }   (at most 50)
//                                 -> { items: [{ assetId, url, expiresAt }] }
//
// A URL the server issues lives ten minutes. It is kept here, in memory only
// - never in state, storage or a data attribute - and reused until
// ACCESS_URL_MARGIN_MS before it expires; an address that failed to load is
// forgotten and asked for once more. The request and answer field names are
// the frontend's reading of the owner's summary; should the final contract
// spell them differently, this file changes and nothing else does.
// ---------------------------------------------------------------------------

export const ACCESS_ROUTE = "/api/media/access";
export const ACCESS_BATCH_ROUTE = "/api/media/access/batch";
export const ACCESS_BATCH_LIMIT = 50;
export const PLAYBACK_TTL_MS = 10 * 60 * 1000;
export const ACCESS_URL_MARGIN_MS = 30 * 1000;
// One small JSON answer: well under the codebase's 45 s bound for writes.
export const PLAYBACK_CLIENT_BOUND_MS = 15 * 1000;

const cache = new Map(); // assetId -> { url, expiresAt }
const inFlight = new Map(); // assetId -> Promise<string> (the URL, or "")

const now = () => Date.now();

function readExpiry(value) {
  const at = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(at) && at > now() ? at : now() + PLAYBACK_TTL_MS;
}

function remember(assetId, url, expiresAt) {
  if (typeof url !== "string" || !url.trim()) return "";
  cache.set(assetId, { url, expiresAt: readExpiry(expiresAt) });
  return url;
}

function accessError(code, cause) {
  const error = new Error(code);
  error.code = code;
  error.cause = cause;
  error.status = cause?.status;
  return error;
}

function classify(error) {
  if (error?.status === 401 || error?.status === 403 || error?.status === 404) return "not_available";
  if (!error?.status || error.status >= 500) return "unavailable";
  return "refused";
}

// The cached address of an asset while it is still fresh, else "".
export function cachedMediaUrl(assetId) {
  const entry = cache.get(assetId);
  if (!entry) return "";
  if (entry.expiresAt - ACCESS_URL_MARGIN_MS <= now()) {
    cache.delete(assetId);
    return "";
  }
  return entry.url;
}

// Forgets one asset's address (after it failed to load), or every address.
export function forgetMediaAccess(assetId) {
  if (assetId === undefined) {
    cache.clear();
    inFlight.clear();
    return;
  }
  cache.delete(assetId);
}

// One asset, for the player: the cached address while it is fresh, else one
// request, bounded by PLAYBACK_CLIENT_BOUND_MS and by the caller's signal.
// Throws an error whose `code` is one of: aborted, timeout, not_available,
// unavailable, refused, answer_unexpected.
export async function loadPlayback(assetId, accessContext, { signal } = {}) {
  const fresh = cachedMediaUrl(assetId);
  if (fresh) return { url: fresh, expiresAt: cache.get(assetId).expiresAt };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAYBACK_CLIENT_BOUND_MS);
  const onOuterAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener?.("abort", onOuterAbort, { once: true });
  try {
    const answer = await api(ACCESS_ROUTE, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ assetId, accessContext: accessContext ?? null }),
    });
    const url = remember(assetId, answer?.url, answer?.expiresAt);
    if (!url) throw accessError("answer_unexpected");
    return { url, expiresAt: cache.get(assetId).expiresAt };
  } catch (error) {
    if (error?.code) throw error;
    if (controller.signal.aborted) throw accessError(signal?.aborted ? "aborted" : "timeout", error);
    throw accessError(classify(error), error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onOuterAbort);
  }
}

async function requestBatch(items) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAYBACK_CLIENT_BOUND_MS);
  try {
    const answer = await api(ACCESS_BATCH_ROUTE, { method: "POST", signal: controller.signal, body: JSON.stringify({ items }) });
    const answers = new Map();
    for (const entry of Array.isArray(answer?.items) ? answer.items : []) {
      const assetId = typeof entry?.assetId === "string" ? entry.assetId : "";
      if (!assetId) continue;
      const url = remember(assetId, entry.url, entry.expiresAt);
      if (url) answers.set(assetId, url);
    }
    return answers;
  } catch {
    // A failed batch leaves every picture on its fallbacks; nothing retries here.
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

// Several assets at once, for the pictures of a list: every id asked once per
// call, in requests of at most ACCESS_BATCH_LIMIT, a fresh cached address not
// asked again, a request already running for an id shared. Returns a Map of
// the ids that got an address; an id the server left out, refused or did
// not answer is absent.
export async function resolveMediaAccess(items) {
  const result = new Map();
  const pending = new Map(); // assetId -> accessContext
  const waits = [];
  for (const item of items || []) {
    const assetId = typeof item?.assetId === "string" ? item.assetId.trim() : "";
    if (!assetId || result.has(assetId) || pending.has(assetId)) continue;
    const fresh = cachedMediaUrl(assetId);
    if (fresh) {
      result.set(assetId, fresh);
      continue;
    }
    const running = inFlight.get(assetId);
    if (running) {
      waits.push(running.then((url) => { if (url) result.set(assetId, url); }, () => {}));
      continue;
    }
    pending.set(assetId, item.accessContext ?? null);
  }
  const ids = [...pending.keys()];
  for (let start = 0; start < ids.length; start += ACCESS_BATCH_LIMIT) {
    const chunk = ids.slice(start, start + ACCESS_BATCH_LIMIT);
    const request = requestBatch(chunk.map((assetId) => ({ assetId, accessContext: pending.get(assetId) })));
    for (const assetId of chunk) {
      const own = request.then((answers) => answers.get(assetId) || "");
      inFlight.set(assetId, own);
      waits.push(own.then((url) => { if (url) result.set(assetId, url); }, () => {}).finally(() => {
        if (inFlight.get(assetId) === own) inFlight.delete(assetId);
      }));
    }
  }
  await Promise.all(waits);
  return result;
}

export function readAccessContext(element) {
  return decodeAccessContext(element?.dataset?.mediaAccessContext || "");
}

// A picture the server gave no address for moves on to its public fallbacks
// (data-fallbacks), and with none left is handed to the app's image error
// path through a synthetic "error" event, so it ends where any broken
// picture ends: the initials, the placeholder. From here on it is an
// ordinary picture, no longer an asset.
function giveUpAssetImage(image) {
  const fallbacks = parseImageFallbacks(image.dataset.fallbacks);
  const next = fallbacks.shift();
  delete image.dataset.mediaAssetId;
  delete image.dataset.mediaAccessContext;
  delete image.dataset.mediaRetried;
  if (next) {
    if (fallbacks.length) image.dataset.fallbacks = JSON.stringify(fallbacks);
    else delete image.dataset.fallbacks;
    image.src = next;
    return;
  }
  delete image.dataset.fallbacks;
  const Event = image.ownerDocument?.defaultView?.Event || globalThis.Event;
  if (Event) image.dispatchEvent(new Event("error"));
}

async function resolveImages(images) {
  const wanted = images.filter((image) => image?.dataset?.mediaAssetId && !image.dataset.mediaResolving);
  if (!wanted.length) return 0;
  for (const image of wanted) image.dataset.mediaResolving = "1";
  const urls = await resolveMediaAccess(wanted.map((image) => ({ assetId: image.dataset.mediaAssetId, accessContext: readAccessContext(image) })));
  let resolved = 0;
  for (const image of wanted) {
    delete image.dataset.mediaResolving;
    if (!image.isConnected) continue;
    const url = urls.get(image.dataset.mediaAssetId);
    if (url) {
      image.src = url;
      resolved += 1;
    } else {
      giveUpAssetImage(image);
    }
  }
  return resolved;
}

const PENDING_SELECTOR = "img[data-media-asset-id]:not([src])";

// Gives every asset picture under `root` that has no address yet its address,
// in one batch. Returns how many got one.
export function resolvePendingThumbnails(root) {
  return resolveImages([...(root?.querySelectorAll?.(PENDING_SELECTOR) || [])]);
}

// Called from the app's image error handler before its own fallbacks: an
// asset picture whose address failed to load (expired, revoked) asks for a
// new one, once; a second failure walks the fallbacks like any other picture.
export function retryExpiredMediaImage(image) {
  const assetId = image?.dataset?.mediaAssetId;
  if (!assetId || image.dataset.mediaRetried) return false;
  image.dataset.mediaRetried = "1";
  forgetMediaAccess(assetId);
  image.removeAttribute("src");
  void resolveImages([image]);
  return true;
}

// Installs the resolver on a root for the life of the page: whatever renders
// an asset picture (the library, the Builder, the blocks catalog, the player)
// needs no call of its own - the next frame after a change asks for every
// new picture at once. Returns a function that uninstalls it.
export function installThumbnailResolver(root) {
  const view = root?.ownerDocument?.defaultView || globalThis;
  const Observer = view.MutationObserver;
  if (!Observer || !root) return () => {};
  let scheduled = false;
  const later = typeof view.requestAnimationFrame === "function" ? (fn) => view.requestAnimationFrame(fn) : (fn) => setTimeout(fn, 0);
  const flush = () => {
    scheduled = false;
    void resolvePendingThumbnails(root);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    later(flush);
  };
  const observer = new Observer(schedule);
  observer.observe(root, { childList: true, subtree: true });
  schedule();
  return () => observer.disconnect();
}
