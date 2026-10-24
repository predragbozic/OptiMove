import { api } from "./api.js";
import { state } from "./state.js";
import { formatBytes } from "./utils.js";

// ---------------------------------------------------------------------------
// Settings -> Storage (R2 media, PR 5): what a platform administrator reads
// and sets about media storage - the defaults for every account and each
// account's own limit. The routes are BE-1's (docs/backend/r2-be1-storage.md):
//
//   GET   /api/admin/media/storage-policy             -> { policy, revision }
//   PATCH /api/admin/media/storage-policy             { changes, expectedRevision, reason }
//   GET   /api/admin/media/storage-accounts?limit&cursor&sort=used_desc -> { accounts, nextCursor }
//   POST  /api/admin/media/storage-accounts           { owner: { type, id } } -> usage (idempotent)
//   GET   /api/admin/media/storage-accounts/:id       -> usage
//   PATCH /api/admin/media/storage-accounts/:id/limit { limitBytes | null, expectedRevision, reason } -> usage
//   GET   /api/admin/media/storage-limit-audit?storageAccountId&limit&cursor -> { entries, nextCursor }
//
// Bytes travel as decimal strings; the administrator types gigabytes
// (limits) and megabytes (per-file ceilings). Every write needs a reason
// (1-1000 characters) and the revision it was read at: a 409
// revision_conflict means another administrator changed it meanwhile, so the
// values are read again before the change can be repeated. While
// MEDIA_STORAGE_ENABLED is off every route answers 503 media_storage_disabled;
// the screen says so and changes nothing. Hiding the tab is not the
// protection: every route checks the active platform_admin role again.
// ---------------------------------------------------------------------------

export const STORAGE_ADMIN_ROUTE = "/api/admin/media";
export const READ_BOUND_MS = 15_000;
// A write whose answer never comes is "not confirmed" after this long.
export const WRITE_BOUND_MS = 45_000;
export const ACCOUNTS_PAGE_SIZE = 50;
export const AUDIT_PAGE_SIZE = 20;
export const BYTES_PER_GB = 1_000_000_000;
export const BYTES_PER_MB = 1_000_000;
export const REASON_MAX_LENGTH = 1000;
const MAX_BYTES = 9_223_372_036_854_775_807n;

// Who may administer storage: a platform administrator in the platform
// workspace - the Exercise Library's rule for application blocks.
export function storageAdminContext(data = state.organization?.data) {
  return Boolean(data?.isPlatformAdmin) && state.currentUser?.activeWorkspace?.type === "platform";
}

export function emptyStorageAdmin() {
  return {
    loading: false, error: "", disabled: false, unavailable: false, generation: 0,
    policy: null, revision: 0, accounts: [], nextCursor: null, loadingMore: false,
    policyEdit: null, limitEdit: null, history: {}, busy: false, notice: "",
  };
}

// The storage part of the Manage account modal (one user's own account).
export function emptyAccountStorage() {
  return { loading: false, error: "", disabled: false, unavailable: false, usage: null, limitEdit: null, busy: false, notice: "" };
}

// ---- Errors ----------------------------------------------------------------

export function storageError(error) {
  const code = typeof error?.data?.code === "string" && error.data.code ? error.data.code
    : error?.name === "AbortError" || error?.code === "timeout" ? "timeout"
      : !error?.status ? "network"
        : error.status === 401 ? "authentication_required"
          : error.status === 403 ? "operation_not_allowed"
            : error.status === 404 ? "resource_not_found"
              : error.status === 409 ? "revision_conflict"
                : error.status >= 500 ? "media_storage_unavailable" : "invalid_request";
  return { code, status: error?.status || 0, retryable: Boolean(error?.data?.retryable) };
}

export function describeStorageAdminError(code) {
  switch (code) {
    case "media_storage_disabled":
      return "Media storage is switched off in this environment (MEDIA_STORAGE_ENABLED). The limits can be read and set once it is on.";
    case "operation_not_allowed":
      return "This needs platform administrator access in the platform workspace. Reload the app before trying again.";
    case "authentication_required":
      return "You were signed out. Sign in again.";
    case "revision_conflict":
      return "Another administrator changed this meanwhile. The values were read again - check them and save once more.";
    case "resource_not_found":
      return "This storage account could not be found any more. Read again.";
    case "invalid_request":
      return "These values could not be sent. Check the numbers and the reason (1 to 1000 characters).";
    case "media_storage_busy":
      return "Storage is busy right now. Try again in a moment.";
    case "media_storage_unavailable":
      return "Media storage is not available right now. Try again in a moment.";
    default:
      return "The change was not confirmed. The values were read again - check them before you repeat it.";
  }
}

// The change was certainly refused (nothing written) for these codes; for
// anything else the answer was lost and the list has to show what is saved.
export const REFUSAL_CODES = Object.freeze(["media_storage_disabled", "operation_not_allowed", "authentication_required", "revision_conflict", "resource_not_found", "invalid_request", "media_storage_busy"]);

async function call(path, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await api(path, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(new Error("timeout"), { code: "timeout", cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Routes ----------------------------------------------------------------

export function readStoragePolicy() {
  return call(`${STORAGE_ADMIN_ROUTE}/storage-policy`, {}, READ_BOUND_MS);
}

export function updateStoragePolicy({ changes, expectedRevision, reason }) {
  return call(`${STORAGE_ADMIN_ROUTE}/storage-policy`, { method: "PATCH", body: JSON.stringify({ changes, expectedRevision, reason }) }, WRITE_BOUND_MS);
}

export function listStorageAccounts({ cursor = "" } = {}) {
  const params = new URLSearchParams({ limit: String(ACCOUNTS_PAGE_SIZE), sort: "used_desc" });
  if (cursor) params.set("cursor", cursor);
  return call(`${STORAGE_ADMIN_ROUTE}/storage-accounts?${params}`, {}, READ_BOUND_MS);
}

// Returns (and, the first time, creates) the owner's usage row, so a limit
// can be set before the owner's first upload (BE-1's own design).
export function provisionStorageAccount(owner) {
  return call(`${STORAGE_ADMIN_ROUTE}/storage-accounts`, { method: "POST", body: JSON.stringify({ owner }) }, WRITE_BOUND_MS);
}

export function readStorageAccount(storageAccountId) {
  return call(`${STORAGE_ADMIN_ROUTE}/storage-accounts/${encodeURIComponent(storageAccountId)}`, {}, READ_BOUND_MS);
}

// `limitBytes`: a decimal string, "0" for no new uploads, null to remove the override.
export function updateStorageLimit(storageAccountId, { limitBytes, expectedRevision, reason }) {
  return call(`${STORAGE_ADMIN_ROUTE}/storage-accounts/${encodeURIComponent(storageAccountId)}/limit`, { method: "PATCH", body: JSON.stringify({ limitBytes, expectedRevision, reason }) }, WRITE_BOUND_MS);
}

export function listStorageAudit({ storageAccountId = "", cursor = "" } = {}) {
  const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });
  if (storageAccountId) params.set("storageAccountId", storageAccountId);
  if (cursor) params.set("cursor", cursor);
  return call(`${STORAGE_ADMIN_ROUTE}/storage-limit-audit?${params}`, {}, READ_BOUND_MS);
}

// ---- Numbers ---------------------------------------------------------------

function unitsToBytes(value, unit) {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  // Exact decimal arithmetic: no floating point for a byte count.
  const digits = unit === BYTES_PER_GB ? 9 : 6;
  if (fraction.length > digits) return null;
  const bytes = BigInt(whole) * BigInt(unit) + BigInt((fraction + "0".repeat(digits)).slice(0, digits));
  if (bytes > MAX_BYTES) return null;
  return bytes.toString();
}

export const gigabytesToBytes = (value) => unitsToBytes(value, BYTES_PER_GB);
export const megabytesToBytes = (value) => unitsToBytes(value, BYTES_PER_MB);

function bytesToUnits(bytes, unit) {
  const number = Number(bytes);
  if (!Number.isFinite(number) || number < 0) return "";
  const units = number / unit;
  return String(Math.round(units * 100) / 100);
}

export const bytesToGigabytes = (bytes) => bytesToUnits(bytes, BYTES_PER_GB);
export const bytesToMegabytes = (bytes) => bytesToUnits(bytes, BYTES_PER_MB);

export function validReason(value) {
  const reason = String(value ?? "").trim();
  return reason.length >= 1 && reason.length <= REASON_MAX_LENGTH ? reason : "";
}

// ---- Names -----------------------------------------------------------------

// Whose account a row is, from the organization data already on screen;
// never a raw id in the open (it sits under Technical details).
export function ownerLabel(owner, data = state.organization?.data) {
  if (!owner) return "Unknown account";
  // The one platform account: copies of exercise media from Google Drive, no coach's quota.
  if (owner.type === "platform") return "OptiMove system storage";
  if (owner.type === "user") {
    const user = (data?.users || []).find((row) => String(row.id) === String(owner.id));
    return user ? user.name || user.email || "User account" : "User account (not in this list)";
  }
  if (owner.type === "club") {
    const club = (data?.clubs || []).find((row) => String(row.id) === String(owner.id));
    return club ? club.name || "Club account" : "Club account (not in this list)";
  }
  return "Unknown account";
}

export function usageSentence(usage) {
  if (!usage) return "";
  const parts = [`${formatBytes(usage.usedBytes)} used of ${formatBytes(usage.limitBytes)}`, `${formatBytes(usage.availableBytes)} free`];
  if (Number(usage.reservedBytes) > 0) parts.push(`${formatBytes(usage.reservedBytes)} reserved by uploads in progress`);
  if (Number(usage.activeUploads) > 0) parts.push(`${usage.activeUploads} upload${Number(usage.activeUploads) === 1 ? "" : "s"} running`);
  return parts.join(" · ");
}

// ---- Loading (the Storage tab) ---------------------------------------------

function classifyLoadFailure(target, error) {
  const info = storageError(error);
  target.disabled = info.code === "media_storage_disabled";
  target.unavailable = info.code === "operation_not_allowed" || info.code === "authentication_required";
  target.error = target.disabled || target.unavailable ? "" : describeStorageAdminError(info.code);
}

// Entering the tab reads everything again: another administrator may have changed it.
export function enterStorageAdminSection() {
  const admin = state.storageAdmin;
  admin.generation += 1;
  Object.assign(admin, { loading: false, error: "", disabled: false, unavailable: false, policy: null, revision: 0, accounts: [], nextCursor: null, loadingMore: false, policyEdit: null, limitEdit: null, history: {}, notice: "" });
}

export function storageAdminNeedsLoad() {
  const admin = state.storageAdmin;
  return !admin.loading && !admin.policy && !admin.disabled && !admin.unavailable && !admin.error;
}

export async function loadStorageAdmin(render, notice = "") {
  const admin = state.storageAdmin;
  const generation = ++admin.generation;
  Object.assign(admin, { loading: true, error: "", disabled: false, unavailable: false, notice });
  render();
  try {
    const [policy, accounts] = await Promise.all([readStoragePolicy(), listStorageAccounts()]);
    if (generation !== admin.generation) return;
    Object.assign(admin, { loading: false, policy: policy?.policy || null, revision: Number(policy?.revision) || 0, accounts: Array.isArray(accounts?.accounts) ? accounts.accounts : [], nextCursor: accounts?.nextCursor || null });
  } catch (error) {
    if (generation !== admin.generation) return;
    admin.loading = false;
    admin.policy = null;
    classifyLoadFailure(admin, error);
  }
  render();
}

export async function loadMoreStorageAccounts(render) {
  const admin = state.storageAdmin;
  if (!admin.nextCursor || admin.loadingMore) return;
  const generation = admin.generation;
  admin.loadingMore = true;
  render();
  try {
    const page = await listStorageAccounts({ cursor: admin.nextCursor });
    if (generation !== admin.generation) return;
    const seen = new Set(admin.accounts.map((account) => account.storageAccountId));
    admin.accounts = [...admin.accounts, ...(page?.accounts || []).filter((account) => !seen.has(account.storageAccountId))];
    admin.nextCursor = page?.nextCursor || null;
  } catch (error) {
    if (generation !== admin.generation) return;
    admin.notice = describeStorageAdminError(storageError(error).code);
  }
  admin.loadingMore = false;
  render();
}

export async function loadStorageHistory(storageAccountId, render) {
  const admin = state.storageAdmin;
  const entry = admin.history[storageAccountId] || (admin.history[storageAccountId] = { open: true, loading: false, entries: null, error: "" });
  entry.loading = true;
  entry.error = "";
  render();
  try {
    const answer = await listStorageAudit({ storageAccountId });
    entry.entries = Array.isArray(answer?.entries) ? answer.entries : [];
  } catch (error) {
    entry.error = describeStorageAdminError(storageError(error).code);
  }
  entry.loading = false;
  render();
}

// ---- Changes (the tab and the Manage account section share these) ------------

// Saves the defaults; after a refusal or a lost answer the tab is read again
// so the screen always shows what is saved.
export async function saveStoragePolicy({ changes, expectedRevision, reason }, render) {
  const admin = state.storageAdmin;
  if (admin.busy) return false;
  admin.busy = true;
  render();
  let notice;
  try {
    const answer = await updateStoragePolicy({ changes, expectedRevision, reason });
    admin.policy = answer?.policy || admin.policy;
    admin.revision = Number(answer?.revision) || admin.revision;
    admin.policyEdit = null;
    notice = "Defaults saved. They apply to every account without an individual limit.";
    admin.busy = false;
    admin.notice = notice;
    render();
    return true;
  } catch (error) {
    const info = storageError(error);
    admin.busy = false;
    admin.policyEdit = null;
    await loadStorageAdmin(render, describeStorageAdminError(info.code));
    return false;
  }
}

// Sets or removes one account's limit. `target` is the state slice that
// shows the account (the tab, or the Manage account section) with its
// `busy` / `notice` / `limitEdit`; `apply(usage)` puts the fresh usage row
// where that slice keeps it; `reread()` reads the slice again after a
// refusal or a lost answer.
export async function changeStorageLimit({ storageAccountId, limitBytes, expectedRevision, reason }, { target, apply, reread, render }) {
  if (target.busy) return false;
  target.busy = true;
  target.notice = "";
  render();
  try {
    const usage = await updateStorageLimit(storageAccountId, { limitBytes, expectedRevision, reason });
    apply(usage);
    target.limitEdit = null;
    target.busy = false;
    target.notice = limitBytes === null
      ? "Individual limit removed. The default applies to this account again."
      : limitBytes === "0"
        ? "Limit set to 0: this account can start no new uploads. What it already holds stays."
        : `Limit saved: ${formatBytes(limitBytes)} for this account.`;
    render();
    return true;
  } catch (error) {
    const info = storageError(error);
    target.busy = false;
    target.limitEdit = null;
    await reread(describeStorageAdminError(info.code));
    return false;
  }
}

// ---- The Manage account section ----------------------------------------------

export async function loadManageAccountStorage(userId, render, notice = "") {
  const manage = state.organizationUserManage;
  const current = () => state.organizationUserManage === manage && manage.open && manage.userId === userId && manage.storage;
  if (!current()) return;
  const storage = manage.storage;
  Object.assign(storage, { loading: !storage.usage, error: "", disabled: false, unavailable: false, notice });
  render();
  try {
    const usage = await provisionStorageAccount({ type: "user", id: userId });
    if (!current()) return;
    Object.assign(storage, { loading: false, usage: usage && typeof usage === "object" ? usage : null });
  } catch (error) {
    if (!current()) return;
    storage.loading = false;
    classifyLoadFailure(storage, error);
    // A change's note is kept: an unconfirmed change must not be forgotten
    // because the read after it failed too.
    if (notice && storage.error) storage.notice = `${notice} The account could not be read; read again before you repeat it.`;
  }
  render();
}
