// Settings -> Storage -> Import from Google Drive (platform administrator): the
// clicks, the folder choice and the repaints while an import runs. The work is
// in drive-import-data.js; every route checks the platform administrator role
// again on the server.
import {
  chooseDriveImportFolder, driveImportBusy, IMPORT_DEFAULT_CONCURRENCY, importErrorCode, loadDriveImportStatus,
  refreshPlatformAccount, requeueFailedImports, runDriveImport,
} from "./drive-import-data.js";
import {
  driveImportActiveKey, driveImportAttentionKey, driveImportCardKey, itemStateText, platformMissing, progressCountsText,
  renderDriveImportActiveHtml, renderDriveImportAttentionHtml, renderDriveImportCardHtml,
} from "./drive-import-view.js";
import { loadStorageAdmin, provisionStorageAccount, storageAdminContext } from "./media-storage-admin-data.js";
import { state } from "./state.js";

// Two at a time, never more than storage allows in parallel.
const concurrency = () => Math.max(1, Math.min(IMPORT_DEFAULT_CONCURRENCY, Number(state.storageAdmin.policy?.maxParallelUploads) || IMPORT_DEFAULT_CONCURRENCY));

// ---- Repaints while an import runs -------------------------------------------
// An import only ever repaints its own card, never the rest of the Storage tab
// while it runs: upload progress and a file's step patch the card's progress
// part in place (at most four times a second), so the Pause button and an open
// <details> stay as they are; a file joining or leaving one of the two lists
// redraws that list only, and not while a pointer is down (a click on one of
// its disclosures would be lost) - a focused disclosure keeps its focus; a
// change of the run's own state (start, pause, stop, a notice) replaces the
// card alone, again not while a pointer is down (the click would land on a
// replaced button). Held changes come right after pointerup, or after
// POINTER_HOLD_MS should no pointerup ever arrive. Once the run is over the whole tab is painted (the system storage
// row in the accounts list changes too), except while a limit or defaults form
// is open or a field is being typed in: then the card alone, so nothing typed
// is lost. With the card off screen nothing is painted; the tab paints it from
// state when it is shown again.
export const PROGRESS_PATCH_MS = 250;
export const POINTER_HOLD_MS = 1500;
let pointerDown = false;
let pointerDownAt = 0;
let deferred = null;
let patchTimer = null;
const pressed = () => pointerDown && Date.now() - pointerDownAt < POINTER_HOLD_MS;

const typing = () => {
  const element = globalThis.document?.activeElement;
  return Boolean(element && element !== globalThis.document.body && element.matches?.("input:not([type=file]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select, [contenteditable=true]"));
};

const cardOf = (root) => root?.querySelector?.("[data-drive-import-card]") || null;

// A list of the card drawn again, its focused disclosure (if any) focused again.
function redrawList(box, html) {
  const doc = box.ownerDocument;
  const focused = box.contains(doc.activeElement) ? doc.activeElement.closest?.("[data-drive-import-details]")?.dataset.driveImportDetails : "";
  box.innerHTML = html;
  if (focused) Array.from(box.querySelectorAll("[data-drive-import-details]")).find((element) => element.dataset.driveImportDetails === focused)?.querySelector("summary")?.focus();
}

const LISTS = [
  ["[data-drive-import-active]", "driveImportActiveKey", driveImportActiveKey, renderDriveImportActiveHtml],
  ["[data-drive-import-attention]", "driveImportAttentionKey", driveImportAttentionKey, renderDriveImportAttentionHtml],
];

// The card's progress part, patched in place: true when done, "held" when a
// list must be drawn again but a pointer is down (that waits), false when the
// card is not on screen or must be painted again.
export function patchDriveImportProgress(root = globalThis.document, { hold = false } = {}) {
  const card = cardOf(root);
  const live = card?.querySelector("[data-drive-import-live]");
  if (!live || card.dataset.driveImportKey !== driveImportCardKey()) return false;
  const imp = state.driveImport;
  const bar = live.querySelector("[data-drive-import-bar]");
  if (bar) {
    bar.max = imp.items.length || 1;
    bar.value = imp.items.filter((item) => item.state === "copied" || item.state === "already").length;
  }
  const counts = live.querySelector("[data-drive-import-counts]");
  if (counts) counts.textContent = progressCountsText(imp);
  let held = false;
  for (const [selector, keyName, keyOf, html] of LISTS) {
    const box = live.querySelector(selector);
    const key = keyOf(imp);
    if (!box || box.dataset[keyName] === key) continue;
    if (hold) { held = true; continue; }
    redrawList(box, html(imp));
    box.dataset[keyName] = key;
  }
  for (const element of live.querySelectorAll("[data-drive-import-state]")) {
    const item = imp.items.find((row) => row.id === element.dataset.driveImportState);
    if (item) element.textContent = itemStateText(item);
  }
  return held ? "held" : true;
}

// The card alone, painted again in place. False when it is not on screen.
export function replaceDriveImportCard(root = globalThis.document) {
  const card = cardOf(root);
  if (!card) return false;
  const template = card.ownerDocument.createElement("template");
  template.innerHTML = renderDriveImportCardHtml().trim();
  const fresh = template.content.firstElementChild;
  if (!fresh) return false;
  card.replaceWith(fresh);
  return true;
}

function flushDeferred() {
  if (!deferred || pressed()) return;
  const paint = deferred;
  deferred = null;
  paint();
}

// The two repaint functions a run uses: `render` for a change of state, `progress` for upload progress.
export function importRenders(render, { root = globalThis.document } = {}) {
  const hold = () => {
    deferred = paint;
    setTimeout(flushDeferred, POINTER_HOLD_MS + 50);
  };
  const paint = () => {
    if (!cardOf(root)) return;
    if (state.driveImport.running) {
      const patched = patchDriveImportProgress(root, { hold: pressed() });
      if (patched === true) return;
      if (patched === "held") { hold(); return; }
    }
    if (pressed()) { hold(); return; }
    deferred = null;
    const formOpen = Boolean(state.storageAdmin.limitEdit || state.storageAdmin.policyEdit);
    if (state.driveImport.running || formOpen || typing()) { replaceDriveImportCard(root); return; }
    render();
  };
  const progress = () => {
    if (patchTimer) return;
    patchTimer = setTimeout(() => { patchTimer = null; paint(); }, PROGRESS_PATCH_MS);
  };
  return { render: paint, progress };
}

// app.js: pointerdown / pointerup / pointercancel (capture). Only the primary
// pointer's main button counts; a hold expires after POINTER_HOLD_MS.
export function handleDriveImportPointer(event) {
  if (event?.isPrimary === false) return;
  if (event?.type === "pointerdown") {
    if (event.button !== undefined && event.button !== 0) return;
    pointerDown = true;
    pointerDownAt = Date.now();
    return;
  }
  pointerDown = false;
  setTimeout(flushDeferred, 0);
}
// An opened or closed <details> of the card is remembered (it survives repaints).
export function handleDriveImportToggle(event) {
  const details = event?.target?.closest?.("[data-drive-import-details]");
  if (details) state.driveImport.open[details.dataset.driveImportDetails] = details.open;
}

function start(render) {
  const renders = importRenders(render);
  return runDriveImport(renders.render, { concurrency: concurrency(), renderProgress: renders.progress });
}

// ---- Clicks -----------------------------------------------------------------------

export async function handleDriveImportAction(action, { render }) {
  const type = action.dataset.action;
  if (!type?.startsWith("drive-import-")) return false;
  if (!storageAdminContext()) return true;
  const imp = state.driveImport;
  if (type === "drive-import-start") {
    // Start, or Continue: the files a repeat can change go back in the queue first.
    if (imp.running || platformMissing()) return true;
    requeueFailedImports();
    if (imp.items.some((item) => item.state === "queued")) void start(render);
    else render();
    return true;
  }
  if (type === "drive-import-pause") {
    if (imp.running && !imp.paused) {
      imp.paused = true;
      imp.notice = "Pausing: the files already on their way finish first.";
      // The card alone: a limit typed in the list below is not lost.
      if (!replaceDriveImportCard()) render();
    }
    return true;
  }
  if (type === "drive-import-status") {
    if (imp.running || imp.loadingStatus) return true;
    // The card (and the system storage row) only: an open limit form keeps what was typed.
    await loadDriveImportStatus(importRenders(render).render);
    return true;
  }
  if (type === "drive-import-create-account") {
    if (imp.creating) return true;
    imp.creating = true;
    imp.accountNotice = "";
    render();
    try {
      await provisionStorageAccount({ type: "platform" });
      imp.accountNotice = "OptiMove system storage was created. Set its limit below - at least what the import needs - then start the import.";
    } catch (error) {
      const code = importErrorCode(error);
      imp.accountNotice = code === "resource_not_found" || code === "invalid_request"
        ? "This server does not offer OptiMove system storage yet."
        : code === "authentication_required" || code === "operation_not_allowed"
          ? "This needs platform administrator access in the platform workspace."
          : "OptiMove system storage could not be created. Try again.";
    } finally {
      imp.creating = false;
    }
    await loadStorageAdmin(render);
    await loadDriveImportStatus(render);
    return true;
  }
  return false;
}

// The folder input: the administrator chose the prepared folder.
export async function handleDriveImportChange(event, { render }) {
  const input = event.target?.closest?.("[data-drive-import-folder]");
  if (!input) return false;
  if (!storageAdminContext() || state.driveImport.running) return true;
  await chooseDriveImportFolder(input.files, importRenders(render).render);
  input.value = "";
  return true;
}

// Every paint of Settings -> Storage: what is already copied, read once; and
// the platform account put back into the accounts list after the list was
// read again (it is past the list's first page while it is new and empty).
export function ensureDriveImportStatus(render) {
  if (!storageAdminContext()) return;
  const imp = state.driveImport;
  const paint = importRenders(render).render;
  if (!imp.status && !imp.loadingStatus && !imp.statusError) {
    void loadDriveImportStatus(paint);
    return;
  }
  const admin = state.storageAdmin;
  const id = imp.status?.platformStorageAccountId;
  if (id && admin.policy && !admin.loading && imp.accountGeneration !== admin.generation && !admin.accounts.some((account) => account.storageAccountId === id)) {
    void refreshPlatformAccount(paint);
  }
}

// A reload or close while files are on their way asks first (the browser's own
// dialog). The server keeps what is done; Continue goes on with the same imports.
export function handleDriveImportBeforeUnload(event) {
  if (!driveImportBusy()) return;
  event.preventDefault();
  event.returnValue = "";
}
