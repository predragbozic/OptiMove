import { describeImportError, importCounts, isRetryable, planBytes } from "./drive-import-data.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml, formatBytes } from "./utils.js";

// Settings -> Storage -> Import from Google Drive (platform administrator): the
// card on the Storage tab. A file is named by the exercise that uses it; every
// id is under Technical details. While an import runs, the progress part of
// the card is patched in place (drive-import-actions.js); the whole card is
// painted again only when the run's state changes (start, pause, stop, end).

const KIND_LABEL = { video: "Video", image: "Picture" };
const STATE_LABEL = {
  queued: "Waiting", checking: "Checking the file", starting: "Starting", uploading: "Uploading", completing: "Verifying",
  copied: "Copied", already: "Already copied", failed: "Not copied", unconfirmed: "Not confirmed", waiting: "Waits for an earlier import",
};
const ACTIVE_STATES = new Set(["checking", "starting", "uploading", "completing"]);
const ATTENTION_STATES = new Set(["failed", "unconfirmed", "waiting"]);
const READ_ERRORS = {
  manifest_missing: "This folder has no manifest.json. Choose the folder the preparation made (OptiMove-R2-uvoz), not one of its subfolders.",
  manifest_unreadable: "The folder's manifest.json could not be read. Prepare the folder again.",
};
const PREPARE_REASONS = {
  drive_not_found: "the file no longer exists on Drive",
  drive_unavailable: "Drive did not hand the file out (not shared, or too large)",
  not_a_video: "the video field holds a picture, not a video",
  not_an_image: "the picture field does not hold a picture",
  unreadable_image: "the picture could not be read",
  check_failed: "the converted file failed its check",
  convert_failed: "the file could not be converted",
  download_failed: "the download failed",
  not_prepared: "it is not in the prepared folder (probably a newer exercise)",
  file_missing: "the manifest names it, but it is missing from the folder",
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// A <details> keeps what the administrator opened or closed across repaints
// (drive-import-actions.js records the toggle); `fallback` until then.
const openAttr = (key, fallback = false) => {
  const open = state.driveImport.open || {};
  return (key in open ? open[key] : fallback) ? " open" : "";
};

function statusMessage(code) {
  if (code === "resource_not_found" || code === "invalid_request") return "This server does not offer the import yet.";
  if (["authentication_required", "operation_not_allowed", "media_storage_disabled"].includes(code)) return describeImportError(code);
  return "What is already copied could not be read. Try again.";
}

const fileName = (name, more) => `${name || "Exercise file (no name in the manifest)"}${more ? ` (and ${plural(more, "other exercise", "other exercises")})` : ""}`;

// The platform account: by the id the status names, wherever it sits in the list.
export function platformAccount() {
  const id = state.driveImport.status?.platformStorageAccountId;
  const accounts = state.storageAdmin.accounts || [];
  return (id && accounts.find((account) => account.storageAccountId === id)) || accounts.find((account) => account.owner?.type === "platform") || null;
}
// The import writes into the platform account the server names; none yet -> create it first.
export const platformMissing = () => !state.driveImport.status?.platformStorageAccountId;

export function itemStateText(item) {
  const percent = item.state === "uploading" ? ` ${Math.round((item.progress || 0) * 100)}%` : "";
  return `${STATE_LABEL[item.state] || item.state}${percent}`;
}

function renderItemRow(item) {
  const technical = [`Drive file ${item.driveFileId}`, formatBytes(item.bytes), item.error, item.uploadId && `upload ${item.uploadId}`, item.mediaId && `media ${item.mediaId}`].filter(Boolean).join(" · ");
  return `
    <li class="drive-import-item">
      <span class="drive-import-item-name">${escapeHtml(KIND_LABEL[item.kind])} · ${escapeHtml(fileName(item.name, item.more))}</span>
      <span class="drive-import-item-state" data-drive-import-state="${escapeAttr(item.id)}">${escapeHtml(itemStateText(item))}</span>
      ${ATTENTION_STATES.has(item.state) ? `<span class="drive-import-item-reason">${escapeHtml(describeImportError(item.error))}</span>` : ""}
      <details class="storage-admin-technical" data-drive-import-details="${escapeAttr(`tech:${item.id}`)}"${openAttr(`tech:${item.id}`)}><summary>Technical details</summary><code>${escapeHtml(technical)}</code></details>
    </li>
  `;
}

// The two lists of the card, each redrawn only when its own key changes: the
// files on their way (a file joins or leaves; its step text is patched in
// place) and the files that need attention (a file joins, leaves or changes).
const activeItems = (imp) => imp.items.filter((item) => ACTIVE_STATES.has(item.state));
const attentionItems = (imp) => imp.items.filter((item) => ATTENTION_STATES.has(item.state));
export const driveImportActiveKey = (imp = state.driveImport) => activeItems(imp).map((item) => item.id).join(",");
export const driveImportAttentionKey = (imp = state.driveImport) => attentionItems(imp).map((item) => `${item.id}:${item.state}:${item.error}`).join(",");

export function renderDriveImportActiveHtml(imp = state.driveImport) {
  const active = activeItems(imp);
  return active.length ? `<ul class="drive-import-list">${active.map(renderItemRow).join("")}</ul>` : "";
}

export function renderDriveImportAttentionHtml(imp = state.driveImport) {
  const attention = attentionItems(imp);
  if (!attention.length) return "";
  const counts = importCounts(imp.items);
  const summary = [counts.failed && `${counts.failed} not copied`, counts.unconfirmed && `${counts.unconfirmed} not confirmed`, counts.waiting && `${counts.waiting} waiting`].filter(Boolean).join(" · ");
  return `<details class="drive-import-failed" data-drive-import-details="failed"${openAttr("failed", !imp.running)}><summary>${escapeHtml(summary)}</summary><ul class="drive-import-list">${attention.map(renderItemRow).join("")}</ul></details>`;
}

export function progressCountsText(imp = state.driveImport) {
  const counts = importCounts(imp.items);
  const finished = counts.copied + counts.already;
  const parts = [`${finished} of ${counts.total} copied${counts.already ? ` (${counts.already} already were)` : ""}`, `${formatBytes(String(counts.bytesDone))} of ${formatBytes(String(counts.bytesTotal))}`];
  if (counts.failed) parts.push(`${counts.failed} not copied`);
  if (counts.unconfirmed) parts.push(`${counts.unconfirmed} not confirmed`);
  if (counts.waiting) parts.push(`${counts.waiting} waiting`);
  return parts.join(" · ");
}

// What a whole repaint is needed for while a run goes on; the rest is patched.
export const driveImportCardKey = (imp = state.driveImport) => `${imp.generation}|${imp.running}|${imp.paused}|${imp.stopCode}|${imp.notice}`;

function renderPlatformLine() {
  const imp = state.driveImport;
  if (!imp.status) return "";
  const account = platformAccount();
  if (platformMissing()) {
    return `
      <p>OptiMove system storage does not exist yet. Create it, then set its limit in the list below before you import.</p>
      <div class="storage-admin-actions"><button class="plain-button compact-button" type="button" data-action="drive-import-create-account" ${imp.creating ? "disabled" : ""}>${imp.creating ? "Creating..." : "Create system storage"}</button></div>
    `;
  }
  if (!account) {
    return imp.accountError
      ? `<p>OptiMove system storage could not be read. <button class="text-action" type="button" data-action="drive-import-status">Try again</button></p>`
      : `<p class="muted">Reading OptiMove system storage...</p>`;
  }
  const free = BigInt(account.availableBytes || "0");
  const needed = BigInt(planBytes(imp.items));
  const atLeast = BigInt(account.usedBytes || "0") + BigInt(account.reservedBytes || "0") + needed;
  return `
    <p class="storage-admin-usage">OptiMove system storage: ${escapeHtml(formatBytes(account.usedBytes))} used of ${escapeHtml(formatBytes(account.limitBytes))}; ${escapeHtml(formatBytes(account.availableBytes))} free.</p>
    ${needed > free ? `<p class="builder-error" role="alert">The files still to upload need ${escapeHtml(formatBytes(String(needed)))}, more than is free. Set the limit of OptiMove system storage below to at least ${escapeHtml(formatBytes(String(atLeast)))} (what it holds now plus what is still to upload).</p>` : ""}
  `;
}

function renderPlan(imp) {
  const report = imp.report;
  const videos = imp.items.filter((item) => item.kind === "video").length;
  const images = imp.items.length - videos;
  const problems = [...report.notPrepared, ...report.missing];
  const total = imp.items.reduce((sum, item) => sum + item.bytes, 0);
  const problemName = (entry) => (entry.name ? fileName(entry.name, 0) : `A file used in ${plural(entry.rows || 0, "place", "places")}`);
  return `
    <p>Folder <strong>${escapeHtml(imp.folderName || "chosen")}</strong>: ${plural(videos, "video", "videos")} and ${plural(images, "picture", "pictures")} to copy (${escapeHtml(formatBytes(String(total)))}).
      Copied before: ${plural(report.copied.video, "video", "videos")} and ${plural(report.copied.image, "picture", "pictures")}.${report.unused ? ` ${plural(report.unused, "prepared file is", "prepared files are")} no longer used by any exercise and ${report.unused === 1 ? "stays" : "stay"} out.` : ""}</p>
    ${problems.length ? `
      <details class="drive-import-problems" data-drive-import-details="problems"${openAttr("problems")}><summary>${plural(problems.length, "file cannot", "files cannot")} be copied from this folder</summary>
        <p class="muted">These are left out: their exercises keep playing from Google Drive. Prepare them again (or fix the exercise's link), then choose the folder again to add them.</p>
        <ul class="drive-import-list">${problems.map((entry) => `
          <li class="drive-import-item">
            <span class="drive-import-item-name">${escapeHtml(KIND_LABEL[entry.kind])} · ${escapeHtml(problemName(entry))}</span>
            <span class="drive-import-item-reason">Left out: ${escapeHtml(PREPARE_REASONS[entry.reason] || "it could not be prepared")}.</span>
            <details class="storage-admin-technical" data-drive-import-details="${escapeAttr(`problem:${entry.kind}:${entry.driveFileId}`)}"${openAttr(`problem:${entry.kind}:${entry.driveFileId}`)}><summary>Technical details</summary><code>${escapeHtml(`Drive file ${entry.driveFileId} · ${entry.reason}`)}</code></details>
          </li>`).join("")}</ul>
      </details>` : ""}
  `;
}

function renderControls(imp, counts) {
  if (imp.running) {
    return `<button class="plain-button compact-button" type="button" data-action="drive-import-pause" ${imp.paused ? "disabled" : ""}>${imp.paused ? "Pausing..." : "Pause"}</button>`;
  }
  const retryable = imp.items.filter(isRetryable).length;
  const next = counts.queued + retryable;
  const begun = counts.copied + counts.already + counts.failed + counts.unconfirmed + counts.waiting > 0;
  const blocked = platformMissing();
  return `
    ${next ? `<button class="plain-button compact-button drive-import-primary" type="button" data-action="drive-import-start" ${blocked ? "disabled" : ""}>${begun ? "Continue" : "Start import"} (${next})</button>` : ""}
    <button class="text-action" type="button" data-action="drive-import-status">Check what is already copied</button>
    ${next && blocked ? `<p class="muted">Create OptiMove system storage first.</p>` : ""}
  `;
}

function renderProgress(imp) {
  const counts = importCounts(imp.items);
  const finished = counts.copied + counts.already;
  const next = counts.queued + imp.items.filter(isRetryable).length;
  return `
    <div class="drive-import-live" data-drive-import-live>
      <div class="drive-import-progress">
        <progress data-drive-import-bar max="${counts.total || 1}" value="${finished}" aria-label="Files copied"></progress>
        <p data-drive-import-counts>${escapeHtml(progressCountsText(imp))}</p>
        ${imp.notice ? `<p class="muted" role="status">${escapeHtml(imp.notice)}</p>` : ""}
      </div>
      ${imp.stopCode ? `<p class="builder-error" role="alert">The import stopped: ${escapeHtml(describeImportError(imp.stopCode))}</p>` : ""}
      ${!imp.running && !next && finished ? `<p class="drive-import-done" role="status">Done: ${plural(finished, "file", "files")} copied. Their exercises now play the copies.</p>` : ""}
      <div class="storage-admin-actions">${renderControls(imp, counts)}</div>
      <div data-drive-import-active data-drive-import-active-key="${escapeAttr(driveImportActiveKey(imp))}">${renderDriveImportActiveHtml(imp)}</div>
      <div data-drive-import-attention data-drive-import-attention-key="${escapeAttr(driveImportAttentionKey(imp))}">${renderDriveImportAttentionHtml(imp)}</div>
    </div>
  `;
}

export function renderDriveImportCardHtml() {
  const imp = state.driveImport;
  const locked = imp.running || imp.reading;
  const folderBlocked = locked || platformMissing();
  const body = imp.statusError
    ? `<p class="builder-error" role="alert">${escapeHtml(statusMessage(imp.statusError))}</p><div class="storage-admin-actions"><button class="plain-button compact-button" type="button" data-action="drive-import-status">Check again</button></div>`
    : `
      ${renderPlatformLine()}
      ${imp.accountNotice ? `<p class="muted" role="status">${escapeHtml(imp.accountNotice)}</p>` : ""}
      <div class="storage-admin-actions">
        <label class="plain-button compact-button drive-import-folder${folderBlocked ? " is-disabled" : ""}">
          ${imp.items.length || imp.report ? "Choose another folder..." : "Choose the prepared folder..."}
          <input class="drive-import-folder-input" type="file" webkitdirectory directory multiple data-drive-import-folder ${folderBlocked ? "disabled" : ""}>
        </label>
      </div>
      <p class="muted drive-import-hint">Your browser asks to upload the folder's files: that only lets this page read them. Nothing is sent until you choose Start import.</p>
      ${imp.reading || imp.loadingStatus ? `<p class="muted" role="status">${imp.reading ? "Reading the folder..." : "Checking what is already copied..."}</p>` : ""}
      ${imp.readError ? `<p class="builder-error" role="alert">${escapeHtml(READ_ERRORS[imp.readError] || READ_ERRORS.manifest_unreadable)}</p>` : ""}
      ${imp.report && !imp.reading ? `${renderPlan(imp)}${imp.items.length ? renderProgress(imp) : `<p>Nothing to copy from this folder: every file it can copy is already copied.</p>`}` : ""}
    `;
  return `
    <section class="panel storage-admin-card drive-import-card" data-drive-import-card data-drive-import-key="${escapeAttr(driveImportCardKey(imp))}">
      <p class="eyebrow">Import from Google Drive</p>
      <h3>Copy exercise videos and pictures into OptiMove storage</h3>
      <p class="muted">Exercises and plans keep their Google Drive links. Once a file is copied, OptiMove plays the copy: on every phone, without a Google account. Copies count against OptiMove system storage, never against a coach.</p>
      <p class="muted">Keep this page open while the import runs. Pause and Continue are safe and never copy a file twice. If you are signed out or the page closes, sign in again, open Settings → Storage and choose the same folder: copied files are skipped and unfinished ones continue the same import.</p>
      <p class="muted drive-import-phone-note">Importing needs the computer that holds the prepared folder.</p>
      ${body}
    </section>
  `;
}
