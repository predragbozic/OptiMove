import { api } from "./api.js";
import { decodeAccessContext, normalizeAccessContext, parseImageFallbacks } from "./media.js";

// ---------------------------------------------------------------------------
// Short-lived access to R2 media (FE-1).
//
// The only module that knows the two access routes of the media contract
// (final Codex contract, as the owner confirmed it on 2026-10-19):
//
//   POST /api/media/access
//     { context: { type, id }, slots: ["video" | "image", ...] }
//     -> { video?: { source, mediaId, url, expiresAt, mimeType }, image?: { ... } }
//   POST /api/media/access/batch                       (at most 50 requests)
//     { requests: [{ context: { type, id }, slots: [...] }] }
//     -> { results: [{ index, media: { video?: { ... }, image?: { ... } } }] }
//
// The server authorizes by the context, not by the object: an address is
// therefore cached per (context, slot) and never per media id, so two
// contexts that happen to show the same object never share a signed address.
// A URL lives ten minutes. It is kept here, in memory only - never in state,
// storage or a data attribute - and reused until ACCESS_URL_MARGIN_MS before
// it expires; an address that failed to load is forgotten and asked for once
// more.
// ---------------------------------------------------------------------------

export const ACCESS_ROUTE = "/api/media/access";
export const ACCESS_BATCH_ROUTE = "/api/media/access/batch";
export const ACCESS_BATCH_LIMIT = 50;
export const MEDIA_SLOTS = Object.freeze(["video", "image"]);
export const PLAYBACK_TTL_MS = 10 * 60 * 1000;
export const ACCESS_URL_MARGIN_MS = 30 * 1000;
// One small JSON answer: well under the codebase's 45 s bound for writes.
export const PLAYBACK_CLIENT_BOUND_MS = 15 * 1000;

const cache = new Map(); // key -> { url, mediaId, expiresAt }
const inFlight = new Map(); // key -> Promise<entry | null>

const now = () => Date.now();

// The cache key of one slot of one context; "" for anything malformed.
export function accessKey(context, slot) {
  const normalized = normalizeAccessContext(context);
  if (!normalized || !MEDIA_SLOTS.includes(slot)) return "";
  return `${normalized.type}\u0000${normalized.id}\u0000${slot}`;
}

function readExpiry(value) {
  const at = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(at) && at > now() ? at : now() + PLAYBACK_TTL_MS;
}

function readEntry(value) {
  if (!value || typeof value !== "object") return null;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!url) return null;
  const mediaId = typeof value.mediaId === "string" ? value.mediaId : value.mediaId == null ? "" : String(value.mediaId);
  return { url, mediaId, expiresAt: readExpiry(value.expiresAt) };
}

function remember(key, value) {
  const entry = readEntry(value);
  if (entry && key) cache.set(key, entry);
  return entry;
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

// The cached address of one slot of a context while it is still fresh, else null.
export function cachedMediaAccess(context, slot) {
  const key = accessKey(context, slot);
  const entry = key ? cache.get(key) : null;
  if (!entry) return null;
  if (entry.expiresAt - ACCESS_URL_MARGIN_MS <= now()) {
    cache.delete(key);
    return null;
  }
  return entry;
}

// Forgets one slot of a context, every slot of a context, or everything.
export function forgetMediaAccess(context, slot) {
  if (context === undefined) {
    cache.clear();
    inFlight.clear();
    return;
  }
  for (const each of slot ? [slot] : MEDIA_SLOTS) {
    const key = accessKey(context, each);
    if (key) cache.delete(key);
  }
}

// The slots of one context, for the player: the cached addresses while they
// are fresh, one request for the rest, bounded by PLAYBACK_CLIENT_BOUND_MS
// and by the caller's signal. Returns `{ [slot]: { url, mediaId, expiresAt } }`
// with only the slots the server answered. Throws an error whose `code` is
// one of: context_invalid, aborted, timeout, not_available, unavailable,
// refused, answer_unexpected.
export async function loadMediaAccess(context, slots, { signal } = {}) {
  const normalized = normalizeAccessContext(context);
  const wanted = [...new Set((slots || []).filter((slot) => MEDIA_SLOTS.includes(slot)))];
  if (!normalized || !wanted.length) throw accessError("context_invalid");
  const result = {};
  const missing = [];
  for (const slot of wanted) {
    const cached = cachedMediaAccess(normalized, slot);
    if (cached) result[slot] = cached;
    else missing.push(slot);
  }
  if (!missing.length) return result;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAYBACK_CLIENT_BOUND_MS);
  const onOuterAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener?.("abort", onOuterAbort, { once: true });
  try {
    const answer = await api(ACCESS_ROUTE, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ context: normalized, slots: missing }),
    });
    if (!answer || typeof answer !== "object") throw accessError("answer_unexpected");
    for (const slot of missing) {
      const entry = remember(accessKey(normalized, slot), answer[slot]);
      if (entry) result[slot] = entry;
    }
    return result;
  } catch (error) {
    if (error?.code) throw error;
    if (controller.signal.aborted) throw accessError(signal?.aborted ? "aborted" : "timeout", error);
    throw accessError(classify(error), error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onOuterAbort);
  }
}

// The video of a context for the player, and its image as the poster when
// asked for - one request for both.
export async function loadPlayback(context, { withPoster = false, signal } = {}) {
  const access = await loadMediaAccess(context, withPoster ? ["video", "image"] : ["video"], { signal });
  if (!access.video) throw accessError("not_available");
  return { url: access.video.url, mediaId: access.video.mediaId, expiresAt: access.video.expiresAt, poster: access.image?.url || "" };
}

async function requestBatch(requests) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAYBACK_CLIENT_BOUND_MS);
  try {
    const answer = await api(ACCESS_BATCH_ROUTE, { method: "POST", signal: controller.signal, body: JSON.stringify({ requests }) });
    const answers = new Map();
    for (const result of Array.isArray(answer?.results) ? answer.results : []) {
      const request = requests[Number(result?.index)];
      if (!request) continue;
      for (const slot of request.slots) {
        const key = accessKey(request.context, slot);
        const entry = remember(key, result?.media?.[slot]);
        if (entry) answers.set(key, entry);
      }
    }
    return answers;
  } catch {
    // A failed batch leaves every picture on its fallbacks; nothing retries here.
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

// Several (context, slot) pairs at once, for the pictures of a list: one
// request per context with the slots it needs, in calls of at most
// ACCESS_BATCH_LIMIT requests; a fresh cached address is not asked again and
// a request already running for a pair is shared. Returns a Map from
// accessKey() to the entry; a pair the server left out, refused or did not
// answer is absent.
export async function resolveMediaAccess(items) {
  const result = new Map();
  const groups = new Map(); // context key -> { context, slots: Set }
  const waits = [];
  for (const item of items || []) {
    const context = normalizeAccessContext(item?.context);
    const slot = item?.slot;
    const key = accessKey(context, slot);
    if (!key || result.has(key)) continue;
    const cached = cachedMediaAccess(context, slot);
    if (cached) {
      result.set(key, cached);
      continue;
    }
    const running = inFlight.get(key);
    if (running) {
      waits.push(running.then((entry) => { if (entry) result.set(key, entry); }, () => {}));
      continue;
    }
    const contextKey = `${context.type}\u0000${context.id}`;
    const group = groups.get(contextKey) || { context, slots: new Set() };
    group.slots.add(slot);
    groups.set(contextKey, group);
  }
  const requests = [...groups.values()].map((group) => ({ context: group.context, slots: [...group.slots] }));
  for (let start = 0; start < requests.length; start += ACCESS_BATCH_LIMIT) {
    const chunk = requests.slice(start, start + ACCESS_BATCH_LIMIT);
    const request = requestBatch(chunk);
    for (const entry of chunk) {
      for (const slot of entry.slots) {
        const key = accessKey(entry.context, slot);
        const own = request.then((answers) => answers.get(key) || null);
        inFlight.set(key, own);
        waits.push(own.then((found) => { if (found) result.set(key, found); }, () => {}).finally(() => {
          if (inFlight.get(key) === own) inFlight.delete(key);
        }));
      }
    }
  }
  await Promise.all(waits);
  return result;
}

export function readAccessContext(element) {
  return decodeAccessContext(element?.dataset?.mediaAccessContext || "");
}

function imageRequest(image) {
  return { context: readAccessContext(image), slot: image.dataset.mediaSlot || "image" };
}

// A picture the server gave no address for moves on to its public fallbacks
// (data-fallbacks), and with none left is handed to the app's image error
// path through a synthetic "error" event, so it ends where any broken
// picture ends: the initials, the placeholder. From here on it is an
// ordinary picture, no longer an asset.
function giveUpAssetImage(image) {
  const fallbacks = parseImageFallbacks(image.dataset.fallbacks);
  const next = fallbacks.shift();
  delete image.dataset.mediaId;
  delete image.dataset.mediaSlot;
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
  const wanted = images.filter((image) => image?.dataset?.mediaId && !image.dataset.mediaResolving);
  if (!wanted.length) return 0;
  for (const image of wanted) image.dataset.mediaResolving = "1";
  const answers = await resolveMediaAccess(wanted.map(imageRequest));
  let resolved = 0;
  for (const image of wanted) {
    delete image.dataset.mediaResolving;
    if (!image.isConnected) continue;
    const request = imageRequest(image);
    const entry = answers.get(accessKey(request.context, request.slot));
    if (entry) {
      // The context's current object: the row may have been replaced since it was drawn.
      if (entry.mediaId) image.dataset.mediaId = entry.mediaId;
      image.src = entry.url;
      resolved += 1;
    } else {
      giveUpAssetImage(image);
    }
  }
  return resolved;
}

const PENDING_SELECTOR = "img[data-media-id]:not([src])";

// Gives every asset picture under `root` that has no address yet its address,
// in one batch. Returns how many got one.
export function resolvePendingThumbnails(root) {
  return resolveImages([...(root?.querySelectorAll?.(PENDING_SELECTOR) || [])]);
}

// Called from the app's image error handler before its own fallbacks: an
// asset picture whose address failed to load (expired, revoked) asks for a
// new one, once; a second failure walks the fallbacks like any other picture.
export function retryExpiredMediaImage(image) {
  if (!image?.dataset?.mediaId || image.dataset.mediaRetried) return false;
  image.dataset.mediaRetried = "1";
  const request = imageRequest(image);
  forgetMediaAccess(request.context, request.slot);
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
