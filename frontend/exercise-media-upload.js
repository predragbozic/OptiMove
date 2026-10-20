import { api } from "./api.js";
import { describePrepareError, PREPARE_ERROR_CODES } from "./exercise-media-prepare.js";
import { formatBytes } from "./utils.js";

// ---------------------------------------------------------------------------
// Exercise media upload (FE-2): the BE-2 upload transport, the storage usage
// and the limits, behind two explicit integration guards.
//
// Contract: docs/backend/r2-upload-api-v1.md (normative, v1.0.0, commit
// 5aa5589 on codex/r2-be2-upload, PR #187), answering the eleven questions of
// docs/ai/exercise-media-r2-fe2-upload-contract.md.
//
//   POST   /api/media/uploads                 Idempotency-Key: <uuid>
//          { context, kind, purpose, file: { name, mimeType, sizeBytes } }
//          -> 201 { uploadId, mediaId, status, expiresAt, errorCode,
//                   upload: { method, url, headers, expiresAt }, reservation }
//   PUT    <upload.url>                       the raw File with exactly upload.headers
//   GET    /api/media/uploads/:id             -> the status envelope (+ media when completed)
//   POST   /api/media/uploads/:id/renew  {}   -> the envelope with a fresh permission
//   POST   /api/media/uploads/:id/complete {} -> 200 completed (+ media) | 202 verifying
//   DELETE /api/media/uploads/:id             -> 200 cancelled | failed; 409 upload_already_completed
//   GET    /api/media/storage[?exerciseId=]   -> { accounts, selectedStorageAccountId? }  (BE-1 / BE-2)
//
// Upload contexts are their own wire format - { type: "exercise_edit",
// exerciseId } for an existing exercise, { type: "exercise_create" } for a new
// one or a copy - never FE-1's access context { type: "exercise", id }.
//
// The two guards (owner's order, contract preamble: "GET storage 200 is quota
// availability, not proof of R2 credentials, binding support, CORS, or
// playback readiness"):
//   UPLOAD_TRANSPORT_ENABLED - off: no upload control is drawn and
//     startUpload() refuses locally; on only by a code change after the
//     activation gates of docs/backend/r2-be2-upload.md are confirmed.
//   MEDIA_SAVE_ENABLED - off: a completed upload is never presented as saved
//     with the exercise, Save is refused while an uploaded file is in the
//     editor, Replace / Remove of a stored file are not offered, and the save
//     body gains nothing; on only once BE-3 (binding) is deployed.
// Production behaviour stays unchanged while both are off.
// ---------------------------------------------------------------------------

export const STORAGE_ROUTE = "/api/media/storage";
export const UPLOADS_ROUTE = "/api/media/uploads";
export const uploadRoute = (uploadId, suffix = "") => `${UPLOADS_ROUTE}/${encodeURIComponent(uploadId)}${suffix}`;

export const UPLOAD_CONTRACT = "r2-upload-api-v1.0.0";
// The client bounds (ms): storage and the small JSON calls (initiation,
// renew, status, cancel) short; completion waits for the server's HEAD
// (15 s), its inspection (30 s) and the commit, so 90 s. One mutable object
// so tests can shorten them.
export const CLIENT_BOUNDS = { storage: 15_000, request: 15_000, completion: 90_000 };
export const STORAGE_CLIENT_BOUND_MS = CLIENT_BOUNDS.storage;
export const REQUEST_CLIENT_BOUND_MS = CLIENT_BOUNDS.request;
export const COMPLETION_CLIENT_BOUND_MS = CLIENT_BOUNDS.completion;
export const VERIFICATION_POLL_DELAYS_MS = Object.freeze([1000, 2000, 4000]);
export const VERIFICATION_BUDGET_MS = 120_000;
// A PUT permission this close to its expiry is renewed first.
export const PERMISSION_RENEW_MARGIN_MS = 60_000;
// After an interrupted PUT, one more whole PUT of the same File (the contract: no byte ranges).
export const PUT_RETRY_LIMIT = 1;

const DEFAULT_UPLOAD_TRANSPORT_ENABLED = true;
const DEFAULT_MEDIA_SAVE_ENABLED = true;
let uploadTransportEnabled = DEFAULT_UPLOAD_TRANSPORT_ENABLED;
let mediaSaveEnabled = DEFAULT_MEDIA_SAVE_ENABLED;

export function isUploadTransportEnabled() {
  return uploadTransportEnabled;
}

export function isMediaSaveEnabled() {
  return mediaSaveEnabled;
}

// For tests and for the one deliberate activation; nothing in the app calls these.
export function setUploadTransportEnabled(value) {
  uploadTransportEnabled = Boolean(value);
}

export function setMediaSaveEnabled(value) {
  mediaSaveEnabled = Boolean(value);
}

// `accept` is what the picker offers (every phone video: the preparation step
// reads the file and converts what the server would refuse); `mimeTypes` is
// what the server takes and what the local check compares against.
export const UPLOAD_SLOTS = Object.freeze({
  video: Object.freeze({ accept: "video/*,.mp4,.mov", mimeTypes: Object.freeze(["video/mp4", "video/webm"]), label: "video", limitKey: "maxVideoBytes", types: "MP4 or MOV videos", purpose: "exercise_video" }),
  image: Object.freeze({ accept: "image/jpeg,image/png,image/webp", mimeTypes: Object.freeze(["image/jpeg", "image/png", "image/webp"]), label: "picture", limitKey: "maxImageBytes", types: "JPG, PNG or WebP pictures", purpose: "exercise_image" }),
});

export const UPLOAD_CONTEXT_TYPES = Object.freeze(["exercise_create", "exercise_edit"]);
// The picture purposes that come from a video (contract Q1): both carry the
// top-level `sourceMediaId` and `frameTimeSeconds`.
export const FRAME_PURPOSES = Object.freeze(["video_frame", "automatic_thumbnail"]);

// The upload context of the editor: never FE-1's access context.
export function uploadContextFor({ isNew = false, isCopy = false, exerciseId = "" } = {}) {
  if (isNew || isCopy || !exerciseId) return { type: "exercise_create" };
  return { type: "exercise_edit", exerciseId: String(exerciseId) };
}

export function emptyStorageState() {
  return { loading: false, data: null, error: "", disabled: false, unavailable: false };
}

function uploadError(code, cause, extra = {}) {
  const error = new Error(code);
  error.code = code;
  error.cause = cause;
  error.status = cause?.status;
  Object.assign(error, extra);
  return error;
}

// The contract's `code` from an api() error, or a transport word.
function codeOf(error) {
  if (error?.code && typeof error.code === "string" && error.code !== "ABORT_ERR") return error.code;
  const code = error?.data?.code;
  if (typeof code === "string" && code) return code;
  if (error?.name === "AbortError") return "aborted";
  if (!error?.status) return "network";
  if (error.status === 401) return "authentication_required";
  if (error.status === 403) return "operation_not_allowed";
  if (error.status === 404) return "resource_not_found";
  if (error.status >= 500) return "media_storage_unavailable";
  return "invalid_request";
}

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bounded(ms, outer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onOuterAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  outer?.addEventListener?.("abort", onOuterAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => controller.signal.aborted && !outer?.aborted,
    done() {
      clearTimeout(timer);
      outer?.removeEventListener?.("abort", onOuterAbort);
    },
  };
}

// One bounded JSON call; a timeout is its own code, an outer abort "aborted".
async function call(path, options, ms, outer) {
  const bound = bounded(ms, outer);
  try {
    return await api(path, { ...options, signal: bound.signal });
  } catch (error) {
    if (outer?.aborted) throw uploadError("aborted", error);
    if (bound.timedOut()) throw uploadError("timeout", error);
    throw uploadError(codeOf(error), error);
  } finally {
    bound.done();
  }
}

export function newIdempotencyKey() {
  const random = globalThis.crypto?.randomUUID;
  if (typeof random === "function") return globalThis.crypto.randomUUID();
  // Older browsers: a v4 shape from Math.random is enough for a per-attempt key.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---- Storage usage (BE-1, with BE-2's target-aware selector) ----------------

// The usage rows the upload may count against: for an existing exercise the
// server resolves the owner (`?exerciseId=`, the same resolver as initiation)
// and names the row in `selectedStorageAccountId`; for a new exercise or a
// copy the coach's own row. Throws an error whose `code` is
// media_storage_disabled, operation_not_allowed, resource_not_found,
// timeout or storage_unavailable.
export async function readStorageUsage({ exerciseId = "", signal } = {}) {
  const path = exerciseId ? `${STORAGE_ROUTE}?exerciseId=${encodeURIComponent(exerciseId)}` : STORAGE_ROUTE;
  const bound = bounded(CLIENT_BOUNDS.storage, signal);
  try {
    const answer = await api(path, { signal: bound.signal });
    return {
      accounts: Array.isArray(answer?.accounts) ? answer.accounts : [],
      selectedStorageAccountId: typeof answer?.selectedStorageAccountId === "string" ? answer.selectedStorageAccountId : "",
    };
  } catch (error) {
    const code = error?.data?.code;
    if (code === "media_storage_disabled" || code === "operation_not_allowed" || code === "resource_not_found") throw uploadError(code, error);
    if (bound.timedOut()) throw uploadError("timeout", error);
    throw uploadError("storage_unavailable", error);
  } finally {
    bound.done();
  }
}

// The row an upload counts against: the server's selection for an existing
// exercise; the coach's own row (owner user = the signed-in user) for a new
// one or a copy; never a guess from the workspace or the first row.
export function chargedAccount(usage, { userId = "" } = {}) {
  const accounts = Array.isArray(usage?.accounts) ? usage.accounts : Array.isArray(usage) ? usage : [];
  const selected = usage?.selectedStorageAccountId;
  if (selected) return accounts.find((account) => account?.storageAccountId === selected) || null;
  if (userId) return accounts.find((account) => account?.owner?.type === "user" && String(account.owner.id) === String(userId)) || null;
  return accounts.find((account) => account?.owner?.type === "user") || null;
}

// Q8: an application exercise is charged to the uploading administrator.
export function describeStorageAccount(account, { ownerScope = "user" } = {}) {
  if (!account) return "";
  if (account.owner?.type === "club") return `club storage${account.owner?.name ? ` of ${account.owner.name}` : ""}`;
  return ownerScope === "system" ? "personal storage (uploading administrator)" : "personal storage";
}

// Before a file is sent: the type the slot takes and the server allows, the
// per-file ceiling, the free space and the parallel cap, all from the usage
// row. The server's refusal is the rule; this only saves a doomed request.
export function validateFile(file, slot, account) {
  const spec = UPLOAD_SLOTS[slot];
  if (!file || !spec) return { ok: false, code: "invalid_file" };
  const slotTypes = spec.mimeTypes;
  const allowed = Array.isArray(account?.allowedMimeTypes) ? account.allowedMimeTypes.filter((type) => slotTypes.includes(type)) : slotTypes;
  if (!allowed.includes(file.type)) return { ok: false, code: "unsupported_media" };
  const size = toNumber(file.size);
  if (!account) return { ok: true };
  const max = toNumber(account[spec.limitKey]);
  if (max !== null && size > max) return { ok: false, code: "file_too_large" };
  const available = toNumber(account.availableBytes);
  if (account.overLimit === true || (available !== null && size > available)) return { ok: false, code: "storage_quota_exceeded" };
  const active = toNumber(account.activeUploads);
  const cap = toNumber(account.maxParallelUploads);
  if (active !== null && cap !== null && active >= cap) return { ok: false, code: "parallel_upload_limit" };
  return { ok: true };
}

// Codes after which the same upload session may be resumed with the same
// idempotency key (the PUT or the completion did not land); every other
// failure is terminal and a new attempt needs a new key.
export const RESUMABLE_CODES = Object.freeze(["network", "timeout", "upload_interrupted", "upload_not_present", "media_storage_busy", "media_inspection_busy", "media_storage_unavailable", "verification_timeout"]);

export function isResumableCode(code) {
  return RESUMABLE_CODES.includes(code);
}

// One sentence per code, in the coach's words; never "nothing was uploaded"
// after a lost answer, since the server may hold a complete object.
export function describeUploadError(code, { slot = "video", file = null, account = null, detail = null } = {}) {
  const spec = UPLOAD_SLOTS[slot] || UPLOAD_SLOTS.video;
  const size = file ? formatBytes(file.size) : "";
  if (PREPARE_ERROR_CODES.includes(code)) return describePrepareError(code, { detail, file });
  switch (code) {
    case "unsupported_media":
    case "invalid_file":
      return `Only ${spec.types} can be uploaded.`;
    case "file_too_large": {
      const max = account ? formatBytes(account[spec.limitKey]) : "";
      return `This file is ${size || "too large"}. The limit for one ${spec.label} is ${max || "lower"}.`;
    }
    case "storage_quota_exceeded": {
      const free = account ? formatBytes(account.availableBytes) : "";
      return `This file needs ${size || "more space"}, but only ${free || "less"} of your storage ${free === "" ? "is" : "are"} free. Remove media you no longer use or ask an administrator for more storage.`;
    }
    case "parallel_upload_limit":
      return "Another upload is still running. Wait for it to finish, then try again.";
    case "upload_rate_limit":
      return "Too many uploads were started in a short time. Wait a minute, then try again.";
    case "media_verification_failed":
      return `The file was uploaded but could not be verified: it is not a supported ${spec.label} (MP4 H.264 or WebM VP8 for video; JPG, PNG or WebP for pictures). Choose another file.`;
    case "upload_expired":
      return "The upload took too long and its permission expired. Start it again.";
    case "upload_interrupted":
      return "The upload was interrupted twice. Check your connection and retry.";
    case "verification_timeout":
      return "The file is uploaded, but its check is taking longer than expected. Check again in a moment.";
    case "media_storage_disabled":
      return "Uploading files is switched off in this environment. Use a link.";
    case "operation_not_allowed":
      return "Uploading files is not available for this exercise in this workspace. Use a link.";
    case "resource_not_found":
      return "This exercise can't be found or you may no longer edit it. Close the editor and open it again.";
    case "authentication_required":
      return "You were signed out. Sign in again; the chosen file stays here.";
    case "upload_transport_disabled":
    case "upload_contract_pending":
      return "Uploading files is not available yet in this version. Use a link for now.";
    case "cancelled":
      return "Upload cancelled.";
    case "cancel_unconfirmed":
      return "Upload cancelled here. The reserved space is released once the server has confirmed it.";
    case "media_storage_busy":
    case "media_inspection_busy":
    case "media_storage_unavailable":
    case "upload_not_present":
    case "state_conflict":
    case "idempotency_conflict":
    case "network":
    case "timeout":
    default:
      return "The upload did not finish. Check your connection and retry, or use a link.";
  }
}

// ---- The transport ----------------------------------------------------------

// The request headers the browser owns: the contract forbids setting
// Content-Length (signed, supplied by the browser for the File) and nothing
// of OptiMove's session may reach R2.
const BROWSER_OWNED_HEADERS = new Set(["content-length", "authorization", "cookie", "host"]);

// The raw File to the presigned URL with exactly the returned method and
// headers, through XMLHttpRequest for progress. Resolves with the HTTP status
// (0 for a network or CORS failure); rejects only on an abort.
export function putObject(file, permission, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const XHR = globalThis.XMLHttpRequest;
    if (typeof XHR !== "function") {
      reject(uploadError("upload_unavailable"));
      return;
    }
    if (signal?.aborted) {
      reject(uploadError("aborted"));
      return;
    }
    const xhr = new XHR();
    xhr.open(String(permission.method || "PUT").toUpperCase(), permission.url, true);
    xhr.withCredentials = false;
    for (const [name, value] of Object.entries(permission.headers || {})) {
      if (!BROWSER_OWNED_HEADERS.has(String(name).toLowerCase())) xhr.setRequestHeader(name, String(value));
    }
    const total = Number(file?.size) || 0;
    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        onProgress?.({ sent: Number(event?.loaded) || 0, total: event?.lengthComputable && event.total ? Number(event.total) : total });
      };
    }
    const onAbort = () => xhr.abort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const settle = (status) => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve({ status, ok: status >= 200 && status < 300 });
    };
    xhr.onload = () => settle(Number(xhr.status) || 0);
    xhr.onerror = () => settle(0);
    xhr.ontimeout = () => settle(0);
    xhr.onabort = () => {
      signal?.removeEventListener?.("abort", onAbort);
      reject(uploadError("aborted"));
    };
    xhr.send(file);
  });
}

const permissionExpiring = (permission, now) => {
  const at = Date.parse(String(permission?.expiresAt || ""));
  return Number.isFinite(at) && at - now() <= PERMISSION_RENEW_MARGIN_MS;
};

function completedResult(envelope) {
  return {
    uploadId: String(envelope.uploadId || ""),
    mediaId: String(envelope.mediaId || envelope.media?.mediaId || ""),
    status: "completed",
    media: envelope.media && typeof envelope.media === "object" ? envelope.media : null,
  };
}

const isTerminalFailure = (status) => status === "failed" || status === "cancelled" || status === "expired";

// GET the session's status.
export async function checkUploadStatus(uploadId, { signal } = {}) {
  return call(uploadRoute(uploadId), {}, CLIENT_BOUNDS.request, signal);
}

// Polls the session until it is completed, failed or cancelled, with the
// contract's increasing delays (1, 2, 4, 4 ... s) inside VERIFICATION_BUDGET_MS.
// `retryComplete`: the completion request itself was lost, so a session
// still "pending" gets one more completion call.
async function awaitVerification(uploadId, { signal, sleep = sleepFor, now = Date.now, retryComplete = false } = {}) {
  const started = now();
  let step = 0;
  let completeRetried = !retryComplete;
  for (;;) {
    if (signal?.aborted) throw uploadError("aborted");
    const status = await checkUploadStatus(uploadId, { signal });
    if (status?.status === "completed") return completedResult(status);
    if (isTerminalFailure(status?.status)) throw uploadError(status.errorCode || "upload_failed", null, { uploadId });
    if (status?.status === "pending" && !completeRetried) {
      completeRetried = true;
      const answer = await requestCompletion(uploadId, { signal });
      if (answer?.status === "completed") return completedResult(answer);
      continue;
    }
    if (now() - started >= VERIFICATION_BUDGET_MS) throw uploadError("verification_timeout", null, { uploadId });
    await sleep(VERIFICATION_POLL_DELAYS_MS[Math.min(step, VERIFICATION_POLL_DELAYS_MS.length - 1)]);
    step += 1;
  }
}

// POST complete; a timeout is an unknown state (null), not a failure.
async function requestCompletion(uploadId, { signal } = {}) {
  try {
    return await call(uploadRoute(uploadId, "/complete"), { method: "POST", body: "{}" }, CLIENT_BOUNDS.completion, signal);
  } catch (error) {
    if (error.code === "timeout") return null;
    throw error;
  }
}

async function completeUpload(uploadId, { signal, sleep, now } = {}) {
  const answer = await requestCompletion(uploadId, { signal });
  if (answer?.status === "completed") return completedResult(answer);
  if (isTerminalFailure(answer?.status)) throw uploadError(answer.errorCode || "upload_failed", null, { uploadId });
  return awaitVerification(uploadId, { signal, sleep, now, retryComplete: answer === null });
}

// DELETE the session. Returns { outcome }: "cancelled" | "failed" (with the
// stored code) | "completed" (too late to cancel; the asset is ready) |
// "cancelling" (the provider cleanup is pending) | "unconfirmed" (the server
// did not answer; the reservation stays until it does).
export async function cancelUpload(uploadId, { signal } = {}) {
  try {
    const answer = await call(uploadRoute(uploadId), { method: "DELETE" }, CLIENT_BOUNDS.request, signal);
    const status = answer?.status;
    if (status === "cancelled" || status === "failed" || status === "cancelling") return { outcome: status, errorCode: answer.errorCode || null };
    return { outcome: "unconfirmed", errorCode: null };
  } catch (error) {
    if (error.code === "upload_already_completed") return { outcome: "completed", errorCode: null };
    if (error.code === "resource_not_found") return { outcome: "unknown", errorCode: null };
    return { outcome: "unconfirmed", errorCode: error.code || null };
  }
}

// Starts (or, with `idempotencyKey`, resumes) one upload: initiation with the
// idempotency key, the PUT with progress and one whole retry after an
// interruption, a renewal before the permission expires, completion with
// verification polling. Resolves { uploadId, mediaId, status: "completed",
// media }. Rejects with a coded error; "cancelled" / "cancel_unconfirmed"
// after the caller's signal aborted (the server was told); the error carries
// `uploadId` and `idempotencyKey` so a resumable failure can continue the
// same session.
export async function startUpload({ file, slot, context, purpose, sourceMediaId = "", frameTimeSeconds = null } = {}, { onProgress, signal, sleep = sleepFor, now = Date.now, idempotencyKey = "" } = {}) {
  if (!uploadTransportEnabled) throw uploadError("upload_transport_disabled");
  const spec = UPLOAD_SLOTS[slot];
  if (!file || !spec) throw uploadError("invalid_file");
  if (!context || !UPLOAD_CONTEXT_TYPES.includes(context.type)) throw uploadError("invalid_request");
  const chosenPurpose = purpose || spec.purpose;
  // A frame of a video (PR 3): a picture with the contract's two extra top-level
  // facts - the ready R2 video it came from and the moment - or no request at all.
  const frame = FRAME_PURPOSES.includes(chosenPurpose);
  const moment = frameTimeSeconds === null || frameTimeSeconds === undefined || frameTimeSeconds === "" ? NaN : Number(frameTimeSeconds);
  if (frame && (slot !== "image" || !sourceMediaId || !Number.isFinite(moment) || moment < 0)) throw uploadError("invalid_request");
  const key = idempotencyKey || newIdempotencyKey();
  const body = JSON.stringify({
    context: context.type === "exercise_edit" ? { type: "exercise_edit", exerciseId: String(context.exerciseId || "") } : { type: "exercise_create" },
    kind: slot,
    purpose: chosenPurpose,
    ...(frame ? { sourceMediaId: String(sourceMediaId), frameTimeSeconds: moment } : {}),
    file: { name: String(file.name || "file"), mimeType: String(file.type || ""), sizeBytes: String(Number(file.size) || 0) },
  });
  let uploadId = "";
  const tag = (error) => Object.assign(error, { uploadId: error.uploadId || uploadId, idempotencyKey: key });
  try {
    // 1. Initiation: a lost answer is retried once with the same key (the contract's recovery).
    let session;
    for (let attempt = 0; ; attempt += 1) {
      try {
        // api() lets a caller's headers replace its own, so the JSON type travels with the key.
        session = await call(UPLOADS_ROUTE, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body }, CLIENT_BOUNDS.request, signal);
        break;
      } catch (error) {
        if (attempt === 0 && (error.code === "network" || error.code === "timeout")) continue;
        throw error;
      }
    }
    uploadId = String(session?.uploadId || "");
    if (!uploadId) throw uploadError("answer_unexpected");
    if (session.status === "completed") return completedResult(session);
    if (session.status === "verifying" || session.status === "cancelling") return await awaitVerification(uploadId, { signal, sleep, now });
    if (isTerminalFailure(session.status)) throw uploadError(session.errorCode || "upload_failed");
    let permission = session.upload;
    if (!permission?.url) throw uploadError("state_conflict");
    // 2. The bytes: one PUT, one whole retry after an interruption, a renewal before expiry.
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw uploadError("aborted");
      if (permissionExpiring(permission, now)) {
        const renewed = await call(uploadRoute(uploadId, "/renew"), { method: "POST", body: "{}" }, CLIENT_BOUNDS.request, signal);
        if (renewed?.status === "completed") return completedResult(renewed);
        if (!renewed?.upload?.url) throw uploadError(renewed?.status && isTerminalFailure(renewed.status) ? renewed.errorCode || "upload_expired" : "state_conflict");
        permission = renewed.upload;
      }
      const outcome = await putObject(file, permission, { onProgress, signal });
      // 2xx: the object is in. 412: it already is (an earlier attempt landed); never overwritten.
      if (outcome.ok || outcome.status === 412) break;
      // 403, a network or CORS failure: the outcome is unknown - the server's status decides.
      const status = await checkUploadStatus(uploadId, { signal });
      if (status?.status === "completed") return completedResult(status);
      if (status?.status === "verifying") return await awaitVerification(uploadId, { signal, sleep, now });
      if (isTerminalFailure(status?.status)) throw uploadError(status.errorCode || "upload_failed");
      if (attempt >= PUT_RETRY_LIMIT) throw uploadError("upload_interrupted");
    }
    // 3. Completion and verification.
    return await completeUpload(uploadId, { signal, sleep, now });
  } catch (error) {
    if (signal?.aborted) {
      // Stopping the request alone releases nothing on the server (Q4).
      const cancel = uploadId ? await cancelUpload(uploadId) : { outcome: "cancelled" };
      if (cancel.outcome === "completed") {
        const status = await checkUploadStatus(uploadId).catch(() => null);
        if (status?.status === "completed") return completedResult(status);
      }
      throw tag(uploadError(cancel.outcome === "cancelled" || cancel.outcome === "failed" ? "cancelled" : "cancel_unconfirmed", error, { cancelOutcome: cancel.outcome }));
    }
    throw tag(error.code ? error : uploadError(codeOf(error), error));
  }
}

// ---- The exercise save (Q5, behind MEDIA_SAVE_ENABLED) ----------------------

// A slot that still holds the exercise's stored R2 file: untouched, or a
// Replace that failed or was cancelled and kept what the exercise had.
const holdsStoredAsset = (field) => Boolean(field) && (field.state === "stored" || field.previous?.state === "stored");

// Shapes a save body's media fields. Whatever the guards say, a slot that
// holds a stored R2 file sends NO legacy field: BE-3 reads a present
// videoUrl / imageUrl - even an empty one - as a legacy selection that would
// detach the stored file ("omitted slot: unchanged", contract Q5), and on a
// backend without BE-3 no exercise has a stored file, so nothing changes
// there. Behind the BE-3 guard the contract's additive `media` selection is
// added and the legacy field of every slot it selects dropped (never both
// formats for one slot): an uploaded, ready file -> { source: "asset",
// mediaId }; a stored file removed in the editor -> { source: "none" }, or
// { source: "legacy", url } when a link replaced it; an untouched slot is
// omitted. While the guard is off the rest of the body is as it was.
export function applyMediaToSavePayload(payload, media) {
  if (!media) return payload;
  const slots = [["video", "videoUrl"], ["image", "imageUrl"]];
  for (const [slot, urlKey] of slots) {
    if (holdsStoredAsset(media[slot]) && !media[slot].removedMediaId) delete payload[urlKey];
  }
  if (!mediaSaveEnabled) return payload;
  const selection = {};
  for (const [slot, urlKey] of slots) {
    const field = media[slot];
    if (!field) continue;
    if (field.state === "uploaded" && field.mediaId) {
      selection[slot] = { source: "asset", mediaId: field.mediaId };
      delete payload[urlKey];
    } else if (field.removedMediaId) {
      const url = String(payload[urlKey] || "").trim();
      selection[slot] = url ? { source: "legacy", url } : { source: "none" };
      delete payload[urlKey];
    }
  }
  if (Object.keys(selection).length) payload.media = selection;
  return payload;
}

// Kept for callers of the FE-2 first commit: the selection only.
export function mediaSavePayload(media) {
  const payload = applyMediaToSavePayload({}, media);
  return payload.media ? { media: payload.media } : {};
}
