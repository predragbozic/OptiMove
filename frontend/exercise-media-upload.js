import { api } from "./api.js";
import { formatBytes } from "./utils.js";

// ---------------------------------------------------------------------------
// Exercise media upload (FE-2): what the frontend knows of the storage
// contract, and the one seam the upload transport fills in.
//
// Known and documented (BE-1, docs/backend/r2-be1-storage.md):
//   GET /api/media/storage -> { accounts: [usage] } - the coach's own storage
//   account and the clubs they administer; 503 media_storage_disabled while
//   MEDIA_STORAGE_ENABLED is off (then no upload control is offered at all),
//   403 operation_not_allowed outside a coach workspace. A usage row carries
//   usedBytes, reservedBytes, limitBytes, availableBytes (decimal strings),
//   limitSource, overLimit, activeUploads, maxParallelUploads, maxVideoBytes,
//   maxImageBytes, allowedMimeTypes, owner { type, id }. Error codes:
//   413 file_too_large, 415 unsupported_media, 422 media_verification_failed,
//   429 storage_quota_exceeded / parallel_upload_limit, 503 media_storage_
//   disabled / media_storage_busy.
//
// Not defined yet (BE-2): how an upload starts, where the bytes go (a direct
// PUT to R2), how it completes or is cancelled, and which fields of the
// exercise save carry the new media. Until the contract names them,
// startUpload() refuses locally with upload_contract_pending and sends
// nothing, and mediaSavePayload() adds nothing to the save - so every
// contract-dependent line of FE-2 is in this file and inert.
// ---------------------------------------------------------------------------

export const STORAGE_ROUTE = "/api/media/storage";
export const STORAGE_CLIENT_BOUND_MS = 15_000;
// The upload routes BE-2 will define; "pending" until the contract is final.
export const UPLOAD_CONTRACT = "pending";

export const UPLOAD_SLOTS = Object.freeze({
  video: Object.freeze({ accept: "video/mp4,video/webm", label: "video", limitKey: "maxVideoBytes", types: "MP4 or WebM video files" }),
  image: Object.freeze({ accept: "image/jpeg,image/png,image/webp", label: "picture", limitKey: "maxImageBytes", types: "JPG, PNG or WebP pictures" }),
});

export function emptyStorageState() {
  return { loading: false, data: null, error: "", disabled: false, unavailable: false };
}

function uploadError(code, cause) {
  const error = new Error(code);
  error.code = code;
  error.cause = cause;
  return error;
}

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

// The storage accounts the signed-in coach may upload against. Returns
// { accounts } or throws an error whose `code` is media_storage_disabled,
// operation_not_allowed, timeout or storage_unavailable.
export async function readStorageUsage({ signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORAGE_CLIENT_BOUND_MS);
  const onOuterAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener?.("abort", onOuterAbort, { once: true });
  try {
    const answer = await api(STORAGE_ROUTE, { signal: controller.signal });
    return { accounts: Array.isArray(answer?.accounts) ? answer.accounts : [] };
  } catch (error) {
    const code = error?.data?.code;
    if (code === "media_storage_disabled" || code === "operation_not_allowed") throw uploadError(code, error);
    if (controller.signal.aborted) throw uploadError("timeout", error);
    throw uploadError("storage_unavailable", error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onOuterAbort);
  }
}

// The account an exercise's media counts against. The frontend shows the
// coach's own account (owner.type "user"); which account an application
// exercise's or a club's media is charged to is BE-2's rule (open question),
// so the usage line always names the account it shows.
export function chargedAccount(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  return list.find((account) => account?.owner?.type === "user") || list[0] || null;
}

export function describeStorageAccount(account) {
  if (!account) return "";
  return account.owner?.type === "club" ? `club storage${account.owner?.name ? ` of ${account.owner.name}` : ""}` : "personal storage";
}

// Before a file is sent: the type the slot takes and the server allows, the
// per-file ceiling, the free space and the parallel cap, all from the usage
// row. The server's refusal is the rule; this only saves a doomed request.
export function validateFile(file, slot, account) {
  const spec = UPLOAD_SLOTS[slot];
  if (!file || !spec) return { ok: false, code: "invalid_file" };
  const slotTypes = spec.accept.split(",");
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

// One sentence per code, in the coach's words; never "nothing was uploaded"
// after a lost answer, since the server may hold a complete object.
export function describeUploadError(code, { slot = "video", file = null, account = null } = {}) {
  const spec = UPLOAD_SLOTS[slot] || UPLOAD_SLOTS.video;
  const size = file ? formatBytes(file.size) : "";
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
    case "media_verification_failed":
      return "The file could not be verified after the upload. Choose another file.";
    case "media_storage_disabled":
      return "Uploading files is switched off in this environment. Use a link.";
    case "operation_not_allowed":
      return "Uploading files is not available in this workspace. Use a link.";
    case "upload_contract_pending":
      return "Uploading files is not available yet in this version. Use a link for now.";
    case "cancelled":
      return "Upload cancelled.";
    case "media_storage_busy":
    case "storage_unavailable":
    case "timeout":
    default:
      return "The upload did not finish. Check your connection and retry, or use a link.";
  }
}

// ---- The transport seam (BE-2) ---------------------------------------------
// The one function BE-2's contract fills in: reserve the upload, send the
// bytes straight to R2 with progress, complete it, and return the media
// record { mediaId, uploadId }. `onProgress({ sent, total })` drives the
// bar, `signal` cancels. Until the contract names the routes it refuses
// locally and sends nothing.
export async function startUpload({ file, slot, context } = {}, { onProgress, signal } = {}) {
  void file; void slot; void context; void onProgress; void signal;
  throw uploadError("upload_contract_pending");
}

// Which fields of POST / PATCH /api/exercises carry a new or removed media
// (proposal: videoMediaId / imageMediaId, removeVideoMedia / removeImageMedia)
// is BE-2's to name. Until then the save body is exactly what it was.
export function mediaSavePayload(media) {
  void media;
  return {};
}
