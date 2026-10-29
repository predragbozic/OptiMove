import { api } from "./api.js";
import { newIdempotencyKey, putObject } from "./exercise-media-upload.js";
import { readStorageAccount } from "./media-storage-admin-data.js";
import { state } from "./state.js";

// ---------------------------------------------------------------------------
// Settings -> Storage -> Import from Google Drive (platform administrator).
// The files are prepared on the administrator's computer: every Drive video
// and picture the exercises use, converted and checked, in one folder with a
// manifest.json keyed by Drive file id (docs/ai/drive-media-import-plan.md,
// phase 1). This screen uploads them to OptiMove's own storage through the
// backend of PR #202 (it depends on that API and does nothing useful without
// it):
//
//   GET    /api/admin/media/drive-import/status                -> { videos, images, platformStorageAccountId }
//   POST   /api/admin/media/drive-import/uploads   (Idempotency-Key) { kind, driveFileId, file } -> upload session
//   POST   /api/admin/media/drive-import/uploads/:id/complete -> 200 | 202 | 409 already_copied | ...
//   DELETE /api/admin/media/drive-import/uploads/:id           -> cancel
//
// Safe to repeat: each file keeps its Idempotency-Key (in this browser, across
// a reload) until it is copied, so a repeat after a lost answer is the same
// import, never a second one; the server refuses a second copy of a file
// (already_copied) and a second import in flight (import_in_progress). An
// outcome this screen could not confirm is "not confirmed", never "not copied".
// ---------------------------------------------------------------------------

export const DRIVE_IMPORT_ROUTE = "/api/admin/media/drive-import";
export const IMPORT_READ_BOUND_MS = 30_000;
export const IMPORT_REQUEST_BOUND_MS = 30_000;
// Completion inspects the file on the server: longer for a big video.
export const IMPORT_COMPLETE_BOUND_MS = 120_000;
// The bytes to R2: a minute plus one second per 50 KB (a slow line, not a dead one).
export const putBoundMs = (bytes) => 60_000 + Math.ceil(bytes / 50_000) * 1_000;
// A transient failure (network, timeout, busy) is repeated this often, then the file waits for Continue.
export const IMPORT_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000, 15_000]);
// "Still being verified" (202) is asked again after these delays.
export const IMPORT_VERIFY_DELAYS_MS = Object.freeze([2_000, 4_000, 8_000, 15_000, 30_000]);
// Another import of the same file in flight (often this computer's own earlier
// attempt, reserved for up to ten minutes): asked again this often, this late.
export const IMPORT_IN_PROGRESS_RETRIES = 3;
export const IMPORT_IN_PROGRESS_DELAY_MS = 60_000;
// Storage's parallel-upload limit is full (an earlier attempt still holds a
// slot): the file goes back to the queue and this worker waits.
export const IMPORT_PARALLEL_BACKOFF_MS = 30_000;
// ... at most this often (ten minutes, the lifetime of an unfinished upload), then it waits for Continue.
export const IMPORT_PARALLEL_RETRIES = 20;
export const IMPORT_DEFAULT_CONCURRENCY = 2;
const KEY_STORE = "optimove.driveImport.keys";
const KINDS = Object.freeze([["video", "videos"], ["image", "images"]]);
const MIME_TYPES = Object.freeze({ video: ["video/mp4"], image: ["image/jpeg", "image/png", "image/webp"] });
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// The run stops (nothing new starts) on these: none of them gets better by repeating.
export const STOP_CODES = Object.freeze(["authentication_required", "operation_not_allowed", "media_storage_disabled", "storage_quota_exceeded"]);
// Repeated after a delay with the same key. verification_outcome_unknown: the
// server lost the answer to its own claim COMMIT, so the copy may still land.
const TRANSIENT_CODES = new Set(["network", "timeout", "media_storage_busy", "media_storage_unavailable", "media_inspection_busy", "import_outcome_unknown", "verification_outcome_unknown"]);
// Refusals a repeat cannot change: the file needs preparing again (or is not used any more).
const FINAL_FAILURES = new Set(["file_changed", "file_missing", "unsupported_media", "video_too_long", "file_too_large", "media_verification_failed", "resource_not_found"]);
const ACTIVE = new Set(["checking", "starting", "uploading", "completing"]);

export function emptyDriveImport() {
  return {
    folderName: "", folder: null, reading: false, readError: "", status: null, statusError: "", loadingStatus: false,
    items: [], report: null, running: false, paused: false, stopCode: "", notice: "", generation: 0,
    open: {}, creating: false, accountNotice: "", accountGeneration: -1, accountError: false, statusGeneration: 0,
  };
}

// ---- Errors -----------------------------------------------------------------

export function importErrorCode(error) {
  if (typeof error?.data?.code === "string" && error.data.code) return error.data.code;
  if (error?.code === "timeout" || error?.name === "AbortError") return "timeout";
  if (!error?.status) return typeof error?.code === "string" && error.code ? error.code : "network";
  if (error.status === 401) return "authentication_required";
  if (error.status === 403) return "operation_not_allowed";
  if (error.status === 404) return "resource_not_found";
  if (error.status === 413) return "file_too_large";
  if (error.status === 415) return "unsupported_media";
  if (error.status >= 500) return "media_storage_unavailable";
  return "invalid_request";
}

export function describeImportError(code) {
  switch (code) {
    case "authentication_required": return "You were signed out. Sign in again, open Settings → Storage and choose the same folder: copied files are skipped and unfinished ones continue the same import.";
    case "operation_not_allowed": return "This needs platform administrator access in the platform workspace.";
    case "media_storage_disabled": return "Media storage is switched off in this environment.";
    case "storage_quota_exceeded": return "OptiMove system storage is full. Raise its limit below, then choose Continue.";
    case "resource_not_found": return "No exercise or plan uses this Drive file any more, so it is not imported.";
    case "already_copied": return "This file was already copied.";
    case "import_in_progress": return "An earlier import of this file is still open on the server (it closes by itself within ten minutes). Choose Continue later: it never copies twice.";
    case "file_changed": return "The file in the folder is not the one the manifest describes (size or checksum). Prepare it again.";
    case "file_missing": return "The manifest names this file, but it is not in the chosen folder.";
    case "unsupported_media": return "Storage refused the file's format. Prepare it again.";
    case "video_too_long": return "The video is longer than an import allows (180 seconds).";
    case "media_verification_failed": return "Storage could not verify the uploaded file. Prepare it again.";
    case "file_too_large": return "The file is larger than storage allows.";
    case "upload_interrupted": return "The upload was interrupted. Choose Continue to send it again.";
    case "parallel_upload_limit": return "Storage was still busy with earlier uploads of this computer. Choose Continue in a few minutes.";
    default: return "The result was not confirmed: the file may or may not be copied. Choose Continue: it asks again and never copies twice.";
  }
}

// ---- Keys kept across a reload ------------------------------------------------

function readKeys() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(KEY_STORE) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function writeKeys(keys) {
  try { globalThis.localStorage?.setItem(KEY_STORE, JSON.stringify(keys)); } catch { /* the key lives in memory only */ }
}
const itemKeyName = (item) => `${item.kind}:${item.driveFileId}`;
export function keyFor(item) {
  if (item.key) return item.key;
  const keys = readKeys();
  item.key = typeof keys[itemKeyName(item)] === "string" ? keys[itemKeyName(item)] : newIdempotencyKey();
  keys[itemKeyName(item)] = item.key;
  writeKeys(keys);
  return item.key;
}
export function forgetKey(item) {
  item.key = "";
  const keys = readKeys();
  delete keys[itemKeyName(item)];
  writeKeys(keys);
}

// ---- The folder -----------------------------------------------------------------

// A path inside the chosen folder: the browser names it with the folder's own name first.
const insideFolder = (file) => {
  const path = String(file.webkitRelativePath || file.name || "").replace(/\\/g, "/");
  const slash = path.indexOf("/");
  return file.webkitRelativePath && slash >= 0 ? path.slice(slash + 1) : path;
};

function validManifestEntry(kind, id, entry) {
  if (!DRIVE_ID.test(id) || !entry || typeof entry !== "object") return false;
  if (!entry.ok) return true; // a file phase 1 could not prepare: listed, never uploaded
  return typeof entry.file === "string" && Number.isSafeInteger(entry.bytes) && entry.bytes > 0
    && SHA256.test(String(entry.sha256 || "")) && MIME_TYPES[kind].includes(entry.mimeType);
}

// The chosen folder: its manifest and its files by path. Throws a coded error.
export async function readImportFolder(fileList) {
  const files = new Map();
  let manifestFile = null;
  for (const file of Array.from(fileList || [])) {
    const path = insideFolder(file);
    if (path === "manifest.json") manifestFile = file;
    else files.set(path, file);
  }
  if (!manifestFile) throw Object.assign(new Error("manifest_missing"), { code: "manifest_missing" });
  let manifest;
  try { manifest = JSON.parse(await manifestFile.text()); } catch { throw Object.assign(new Error("manifest_unreadable"), { code: "manifest_unreadable" }); }
  if (!manifest || typeof manifest !== "object") throw Object.assign(new Error("manifest_unreadable"), { code: "manifest_unreadable" });
  for (const [kind, key] of KINDS) {
    const entries = manifest[key] || {};
    if (typeof entries !== "object" || Array.isArray(entries)) throw Object.assign(new Error("manifest_unreadable"), { code: "manifest_unreadable" });
    for (const [id, entry] of Object.entries(entries)) {
      if (!validManifestEntry(kind, id, entry)) throw Object.assign(new Error("manifest_unreadable"), { code: "manifest_unreadable", detail: `${key}/${id}` });
    }
  }
  const folderName = String(Array.from(fileList || [])[0]?.webkitRelativePath || "").split("/")[0] || "";
  return { manifest, files, folderName };
}

// The exercises the manifest names for a file: the first one names it on screen.
const exercisesOf = (entry) => (Array.isArray(entry?.exercises) ? entry.exercises : []);
const nameOf = (entry) => String(exercisesOf(entry)[0]?.name || "").slice(0, 200);

// What to upload: every Drive file the server says is used and not yet copied,
// prepared in the folder. The rest is reported, never uploaded.
export function buildImportPlan({ status, manifest, files }) {
  const items = [];
  const report = { copied: { video: 0, image: 0 }, notPrepared: [], missing: [], unused: 0 };
  for (const [kind, key] of KINDS) {
    const prepared = manifest?.[key] || {};
    const used = new Set();
    for (const entry of status?.[key] || []) {
      const id = String(entry.driveFileId || "");
      used.add(id);
      if (entry.copied) { report.copied[kind] += 1; continue; }
      const m = prepared[id];
      const problem = (reason) => ({ kind, driveFileId: id, rows: entry.rows || 0, reason, name: nameOf(m) });
      if (!m) { report.missing.push(problem("not_prepared")); continue; }
      if (!m.ok) { report.notPrepared.push(problem(String(m.error || "unknown"))); continue; }
      const file = files.get(m.file);
      if (!file) { report.missing.push(problem("file_missing")); continue; }
      items.push({
        id: `${kind}:${id}`, kind, driveFileId: id, file, bytes: m.bytes, sha256: m.sha256, mimeType: m.mimeType, rows: entry.rows || 0,
        name: nameOf(m), more: Math.max(0, exercisesOf(m).length - 1),
        state: "queued", progress: 0, error: "", key: "", uploadId: "", mediaId: "", waits: 0, slotWaits: 0,
      });
    }
    report.unused += Object.keys(prepared).filter((id) => !used.has(id)).length;
  }
  return { items, report };
}

// Bytes still to upload (not copied yet).
export const planBytes = (items) => items.reduce((sum, item) => sum + (["copied", "already"].includes(item.state) ? 0 : item.bytes), 0);

// ---- Requests -----------------------------------------------------------------------

async function call(path, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await api(path, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(new Error("timeout"), { code: "timeout" });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function readImportStatus() {
  return call(`${DRIVE_IMPORT_ROUTE}/status`, {}, IMPORT_READ_BOUND_MS);
}

async function sha256Hex(file) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const coded = (code) => Object.assign(new Error(code), { code });
const live = (generation) => state.driveImport.generation === generation;

// One request with the transient repeats: the same request (same key or
// upload id) again after a delay; anything else is thrown with its code.
async function repeating(work, { sleep, generation }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const code = importErrorCode(error);
      if (!TRANSIENT_CODES.has(code) || attempt >= IMPORT_RETRY_DELAYS_MS.length || !live(generation)) throw coded(code);
      await sleep(IMPORT_RETRY_DELAYS_MS[attempt]);
    }
  }
}

// The bytes to R2 with a bound: an answer that never comes ends as status 0.
async function putWithBound(item, permission, { progress, putBound }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), putBound(item.bytes));
  try {
    return await putObject(item.file, permission, { onProgress: progress, signal: controller.signal });
  } catch {
    return { status: 0, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// One file, start to end. Resolves the item's final state; a stop code (and
// import_in_progress / parallel_upload_limit) is thrown for the run to decide.
async function importItem(item, { render, renderProgress, sleep, generation, putBound }) {
  const step = (name) => { item.state = name; render(); };
  const progress = ({ sent, total }) => { item.progress = total ? sent / total : 0; renderProgress(); };
  const start = () => repeating(() => call(`${DRIVE_IMPORT_ROUTE}/uploads`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": keyFor(item) }, body }, IMPORT_REQUEST_BOUND_MS), { sleep, generation });
  // 1. The file is the one the manifest describes.
  step("checking");
  let matches;
  try {
    matches = Number(item.file.size) === item.bytes && await sha256Hex(item.file) === item.sha256;
  } catch {
    // The folder was moved, renamed or emptied while the screen held it.
    return fail(item, "file_missing", render);
  }
  if (!matches) return fail(item, "file_changed", render);
  const body = JSON.stringify({ kind: item.kind, driveFileId: item.driveFileId, file: { name: String(item.file.name || item.driveFileId), sizeBytes: String(item.bytes), mimeType: item.mimeType } });
  let restarts = 0;
  for (;;) {
    // 2. The import session, with the file's own key: a repeat is the same import.
    step("starting");
    let session;
    try {
      session = await start();
    } catch (error) {
      if (error.code === "already_copied") return done(item, "already", render);
      if (["idempotency_conflict", "upload_expired"].includes(error.code) && restarts < 1) { forgetKey(item); restarts += 1; continue; }
      throw error;
    }
    item.uploadId = String(session?.uploadId || "");
    item.mediaId = String(session?.mediaId || "");
    if (session?.status === "completed") return done(item, "copied", render);
    if (["cancelled", "failed"].includes(session?.status)) {
      // This key's earlier import ended: a new key is a new import.
      forgetKey(item);
      if (restarts < 1) { restarts += 1; continue; }
      return fail(item, session.errorCode || "upload_failed", render);
    }
    // 3. The bytes (unless an earlier attempt already got as far as verifying).
    if (session?.status !== "verifying") {
      if (!session?.upload?.url) return unconfirmed(item, "unconfirmed", render);
      step("uploading");
      let put = await putWithBound(item, session.upload, { progress, putBound });
      // 412: an earlier attempt's bytes are already there; never overwritten.
      if (!put.ok && put.status !== 412) {
        // The permission may have expired: the same key gives a fresh one for the same upload.
        try {
          const again = await start();
          if (again?.status === "completed") return done(item, "copied", render);
          if (again?.upload?.url) put = await putWithBound(item, again.upload, { progress, putBound });
        } catch (error) {
          if (error.code === "already_copied") return done(item, "already", render);
          if (STOP_CODES.includes(error.code)) throw error;
        }
        if (!put.ok && put.status !== 412) return interrupted(item, render);
      }
      item.progress = 1;
    }
    // 4. Completion: the server verifies the file and records the copy.
    step("completing");
    for (let poll = 0; ; poll += 1) {
      let result;
      try {
        result = await repeating(() => call(`${DRIVE_IMPORT_ROUTE}/uploads/${encodeURIComponent(item.uploadId)}/complete`, { method: "POST", body: "{}" }, IMPORT_COMPLETE_BOUND_MS), { sleep, generation });
      } catch (error) {
        if (error.code === "already_copied") return done(item, "already", render);
        if (error.code === "upload_not_present" && restarts < 1) { restarts += 1; break; }
        if (["upload_expired", "state_conflict"].includes(error.code) && restarts < 1) { forgetKey(item); restarts += 1; break; }
        if (TRANSIENT_CODES.has(error.code)) return unconfirmed(item, "unconfirmed", render);
        throw error;
      }
      if (result?.status === "completed" || result?.media) { item.mediaId = String(result.mediaId || result.media?.mediaId || item.mediaId); return done(item, "copied", render); }
      // 202: still being verified (another request holds the claim).
      if (poll >= IMPORT_VERIFY_DELAYS_MS.length) return unconfirmed(item, "unconfirmed", render);
      await sleep(IMPORT_VERIFY_DELAYS_MS[poll]);
    }
  }
}

function done(item, final, render) {
  item.state = final;
  item.error = "";
  item.progress = 1;
  forgetKey(item);
  render();
  return final;
}
// The server refused, for certain: not copied.
function fail(item, code, render) {
  item.state = "failed";
  item.error = code;
  render();
  return "failed";
}
// No answer that decides it: the file may or may not be copied; Continue asks again with the same key.
function unconfirmed(item, code, render) {
  item.state = "unconfirmed";
  item.error = code;
  render();
  return "unconfirmed";
}
// The bytes never got through: the session is cancelled so it frees its
// parallel-upload slot at once. Cancelled -> not copied (a new key next time);
// "already completed" -> copied after all; no answer -> not confirmed.
async function interrupted(item, render) {
  try {
    await call(`${DRIVE_IMPORT_ROUTE}/uploads/${encodeURIComponent(item.uploadId)}`, { method: "DELETE" }, IMPORT_REQUEST_BOUND_MS);
    forgetKey(item);
    return fail(item, "upload_interrupted", render);
  } catch (error) {
    if (importErrorCode(error) === "upload_already_completed") return done(item, "copied", render);
    return unconfirmed(item, "upload_interrupted", render);
  }
}

// The import: the queued files, `concurrency` at a time, until none is left,
// Pause, or a stop code. Upload progress repaints through `renderProgress`
// (the screen patches it in place); every change of state through `render`.
export async function runDriveImport(render, { concurrency = IMPORT_DEFAULT_CONCURRENCY, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), renderProgress = render, putBound = putBoundMs } = {}) {
  const imp = state.driveImport;
  if (imp.running) return;
  imp.running = true;
  imp.paused = false;
  imp.stopCode = "";
  imp.notice = "";
  const generation = ++imp.generation;
  render();
  const next = () => imp.items.find((item) => item.state === "queued");
  const worker = async () => {
    for (let item = next(); item && live(generation) && !imp.paused && !imp.stopCode; item = next()) {
      item.state = "checking";
      try {
        await importItem(item, { render, renderProgress, sleep, generation, putBound });
      } catch (error) {
        const code = error?.code || "unconfirmed";
        if (code === "parallel_upload_limit" && item.slotWaits < IMPORT_PARALLEL_RETRIES) {
          // Storage holds an earlier attempt's slot: this file waits its turn again.
          item.slotWaits += 1;
          item.state = "queued";
          render();
          await sleep(IMPORT_PARALLEL_BACKOFF_MS);
        } else if (code === "import_in_progress") {
          item.waits += 1;
          item.state = item.waits > IMPORT_IN_PROGRESS_RETRIES ? "unconfirmed" : "waiting";
          item.error = code;
        } else if (STOP_CODES.includes(code)) {
          fail(item, code, render);
          if (live(generation)) imp.stopCode = code;
        } else if (TRANSIENT_CODES.has(code) || !error?.code) {
          // No refusal from the server decided it (an uncoded failure here is this screen's own).
          unconfirmed(item, "unconfirmed", render);
        } else {
          fail(item, code, render);
        }
        render();
      }
    }
  };
  try {
    for (;;) {
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 4)) }, worker));
      const waiting = imp.items.filter((item) => item.state === "waiting");
      if (!waiting.length || !live(generation) || imp.paused || imp.stopCode) break;
      imp.notice = `${waiting.length} file${waiting.length === 1 ? "" : "s"} wait for an earlier import of the same file to close. Asking again in a minute...`;
      render();
      await sleep(IMPORT_IN_PROGRESS_DELAY_MS);
      if (!live(generation) || imp.paused) break;
      for (const item of waiting) if (item.state === "waiting") item.state = "queued";
      imp.notice = "";
    }
  } finally {
    if (live(generation)) {
      imp.running = false;
      imp.notice = imp.paused ? "Paused. Choose Continue to go on." : imp.stopCode ? "" : imp.notice;
      render();
      // What the system storage holds now.
      void refreshPlatformAccount(render);
    }
  }
}

// Continue / Retry: every file a repeat can change goes back in the queue
// (not confirmed, interrupted, waiting, a stop). Files the folder or the
// manifest got wrong stay failed: they need preparing again.
export const isRetryable = (item) => (item.state === "failed" && !FINAL_FAILURES.has(item.error)) || item.state === "waiting" || item.state === "unconfirmed";
export function requeueFailedImports() {
  let count = 0;
  for (const item of state.driveImport.items) {
    if (isRetryable(item)) {
      item.state = "queued";
      item.error = "";
      item.waits = 0;
      item.slotWaits = 0;
      count += 1;
    }
  }
  state.driveImport.stopCode = "";
  return count;
}

// The counts the screen shows.
export function importCounts(items = state.driveImport.items) {
  const counts = { total: items.length, queued: 0, active: 0, copied: 0, already: 0, failed: 0, final: 0, unconfirmed: 0, waiting: 0, bytesDone: 0, bytesTotal: 0 };
  for (const item of items) {
    counts.bytesTotal += item.bytes;
    if (item.state === "queued") counts.queued += 1;
    else if (ACTIVE.has(item.state)) { counts.active += 1; counts.bytesDone += Math.round(item.bytes * (item.progress || 0)); }
    else if (item.state === "copied") { counts.copied += 1; counts.bytesDone += item.bytes; }
    else if (item.state === "already") { counts.already += 1; counts.bytesDone += item.bytes; }
    else if (item.state === "failed") { counts.failed += 1; if (FINAL_FAILURES.has(item.error)) counts.final += 1; }
    else if (item.state === "unconfirmed") counts.unconfirmed += 1;
    else if (item.state === "waiting") counts.waiting += 1;
  }
  return counts;
}

// The platform account, wherever it sits in the accounts list (a new one uses
// 0 bytes and is past the first page of a list sorted by use): read by id and
// put first, so the card shows it and the list's limit editor can change it.
// A list read in flight would replace it: then nothing is written, and the
// next paint of the tab asks again (ensureDriveImportStatus).
export async function refreshPlatformAccount(render) {
  const id = state.driveImport.status?.platformStorageAccountId;
  const admin = state.storageAdmin;
  if (!id || admin.loading) return;
  const generation = admin.generation;
  state.driveImport.accountGeneration = generation;
  state.driveImport.accountError = false;
  try {
    const usage = await readStorageAccount(id);
    if (admin.generation !== generation || admin.loading) { state.driveImport.accountGeneration = -1; return; }
    admin.accounts = [usage, ...admin.accounts.filter((account) => account.storageAccountId !== id)];
  } catch {
    // The card says so and offers Try again; nothing asks again by itself.
    state.driveImport.accountError = true;
  }
  render();
}

// What the server says is used and copied now, then the plan again from the
// chosen folder (kept in memory) - so a plan is never built from an old status.
export async function loadDriveImportStatus(render) {
  const imp = state.driveImport;
  // A workspace switch (or a newer read) makes this answer stale: it is dropped.
  const generation = ++imp.statusGeneration;
  imp.loadingStatus = true;
  imp.statusError = "";
  render();
  try {
    const status = await readImportStatus();
    if (generation !== imp.statusGeneration) return;
    imp.status = status;
  } catch (error) {
    if (generation !== imp.statusGeneration) return;
    imp.status = null;
    imp.statusError = importErrorCode(error);
  } finally {
    if (generation === imp.statusGeneration) imp.loadingStatus = false;
  }
  if (imp.status) {
    if (imp.folder && !imp.running) {
      const { items, report } = buildImportPlan({ status: imp.status, manifest: imp.folder.manifest, files: imp.folder.files });
      imp.items = items;
      imp.report = report;
    }
    await refreshPlatformAccount(render);
  }
  render();
}

// The folder the administrator chose: read, matched against a fresh status.
export async function chooseDriveImportFolder(fileList, render) {
  const imp = state.driveImport;
  if (imp.running) return;
  imp.reading = true;
  imp.readError = "";
  render();
  try {
    const { manifest, files, folderName } = await readImportFolder(fileList);
    imp.folder = { manifest, files };
    imp.folderName = folderName;
    imp.items = [];
    imp.report = null;
    imp.open = {};
    await loadDriveImportStatus(render);
  } catch (error) {
    imp.readError = error?.code || "manifest_unreadable";
  } finally {
    imp.reading = false;
    render();
  }
}

// A workspace switch: the run starts nothing new (the server keeps what is
// done), and the status is read again when the platform workspace is back.
export function resetDriveImportForWorkspaceChange() {
  const imp = state.driveImport;
  imp.generation += 1;
  imp.running = false;
  imp.paused = false;
  imp.status = null;
  imp.statusError = "";
  imp.loadingStatus = false;
  imp.statusGeneration += 1;
  imp.accountGeneration = -1;
  imp.accountError = false;
  for (const item of imp.items) {
    if (ACTIVE.has(item.state)) {
      item.state = "unconfirmed";
      item.error = "unconfirmed";
    }
  }
}

// Leaving with an import running loses the screen's view of it (the server
// keeps what is done; Continue asks again with the same keys).
// A deliberate app navigation (sign-out, workspace switch) is not held back.
export const driveImportBusy = () => state.driveImport.running && !state.deliberateNavigation;
