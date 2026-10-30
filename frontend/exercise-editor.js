import { api } from "./api.js";
import {
  applyMediaToSavePayload, chargedAccount, checkUploadStatus, describeStorageAccount, describeUploadError, emptyStorageState,
  FRAME_PURPOSES, isMediaSaveEnabled, isResumableCode, isUploadTransportEnabled, readStorageUsage, startUpload, uploadContextFor, UPLOAD_SLOTS, validateFile,
} from "./exercise-media-upload.js";
import {
  AUTOMATIC_THUMBNAIL_BOUND_MS, automaticThumbnailTime, captureFrameFromElement, captureVideoFrame, describeFrameError, describeFrameOrigin, formatFrameTime, FRAME_ERROR_CODES,
  FRAME_TAP_HINT, frameOrigin, readVideoMetadata, renderFramePickerHtml, roundFrameTime, showFrameAt,
} from "./exercise-media-thumbnail.js";
import { prepareVideo } from "./exercise-media-prepare.js";
import { exerciseMediaOf, legacyMediaKind, mediaAccessAttributes } from "./media.js";
import { forgetMediaAccess, loadPlayback } from "./media-playback.js";
import { escapeAttr, escapeHtml, formatBytes } from "./utils.js";

export const emptyExerciseEditorData = () => ({
  name: "", exerciseCode: "", aim: "", executionNotes: "", instruction: "", videoUrl: "", imageUrl: "",
  place: "", complexity: "", startingPosition: "", attractor: "",
  purposes: [], qualities: [], groups: [], bodyParts: [], movementPatterns: [], tags: [],
});

// One media slot of the editor (FE-2). `state` is the file's own story -
// none, stored (an R2 asset the exercise already has), uploading, cancelling,
// uploaded (a ready asset, the exercise not saved yet), failed, cancelled -
// while a Google Drive, YouTube or direct link lives in data.videoUrl /
// imageUrl as before. The File, the progress, the AbortController, the
// upload session (uploadId, idempotencyKey) and the ready media record live
// here, never in the DOM: the editor is drawn again from scratch on every
// change.
export const emptyMediaField = () => ({
  state: "none", mediaId: "", file: null, fileName: "", fileSize: 0, mimeType: "",
  progress: { sent: 0, total: 0 }, error: null, controller: null, uploadId: "", idempotencyKey: "", resumable: false,
  media: null, cancelOutcome: "", linkOpen: false, previewOpen: false, previewUrl: "", removedMediaId: "", previous: null,
  // PR 3: a picture that is a frame of the video carries its origin (purpose,
  // the ready R2 video, the moment); the image field also holds the inline
  // frame picker, whether an automatic thumbnail is being made ("capturing")
  // and the sentence when none could be made ("note").
  origin: null, framePicker: null, capturing: false, captureStop: null, note: "",
  // The on-device preparation of a video: its progress, the size it came from,
  // and whether the file in the field is the converted one.
  prepare: null,
});

export const emptyExerciseMedia = () => ({ video: emptyMediaField(), image: emptyMediaField(), storage: emptyStorageState() });

export const emptyExerciseEditor = () => ({
  open: false, isNew: false, isCopy: false, exerciseId: "", ownerScope: "user", loading: false, error: "", data: emptyExerciseEditorData(),
  media: emptyExerciseMedia(), viewerId: "",
});

const SINGLE_FIELDS = [
  { key: "place", label: "Place", optionsKey: "places" },
  { key: "complexity", label: "Complexity", optionsKey: "complexities" },
  { key: "startingPosition", label: "Starting position", optionsKey: "startingPositions" },
  { key: "attractor", label: "Attractor", optionsKey: "attractors" },
];

const MULTI_FIELDS = [
  { key: "purposes", label: "Purpose", optionsKey: "purposes" },
  { key: "qualities", label: "Quality", optionsKey: "qualities" },
  { key: "groups", label: "Group", optionsKey: "groups" },
  { key: "bodyParts", label: "Body part", optionsKey: "bodyParts" },
  { key: "movementPatterns", label: "Movement pattern", optionsKey: "movementPatterns" },
];

const MEDIA_SLOTS = [
  { slot: "video", label: "Video", urlKey: "videoUrl", noun: "video" },
  { slot: "image", label: "Image", urlKey: "imageUrl", noun: "picture" },
];

const LINK_KINDS = { youtube: "YouTube", drive: "Google Drive", url: "Direct link" };
const SAVE_BLOCKED_SENTENCE = "This uploaded file can't be saved with the exercise yet. Remove it, or use a link, to save the other changes.";

// Every redraw replaces the whole editor, the picker's video included (the
// app removes the overlay and inserts the new HTML at once): once the new
// element is in the page, it is asked for the chosen moment again - whoever
// redrew (a slot's Preview, a tag, Save, a storage answer).
export function renderExerciseEditorHtml(editor, filterOptions = {}) {
  const html = editorHtml(editor, filterOptions);
  const picker = editor?.media?.image?.framePicker;
  const state = framePickerState;
  if (picker?.src && !picker.loading && state?.exerciseEditor === editor) queueMicrotask(() => previewFrame(state, picker));
  return html;
}

function editorHtml(editor, filterOptions) {
  const d = editor.data;
  const held = uploadInFlight(editor);
  const blocked = mediaSaveBlocked(editor);
  return `
    <div class="exercise-editor-overlay">
      <button class="exercise-editor-backdrop" type="button" data-action="exercise-editor-close" aria-label="Close"></button>
      <section class="panel exercise-editor-modal" role="dialog" aria-modal="true" aria-label="${editor.isCopy ? "Copy exercise" : editor.isNew ? "Add exercise" : "Edit exercise"}">
        <div class="builder-modal-head">
          <div><p class="eyebrow">${editor.isCopy ? "New private copy" : editor.isNew ? "New exercise" : "Editing exercise"}</p><h3>${escapeHtml(d.name || "Untitled")}</h3></div>
          <button class="plain-button icon-button" type="button" data-action="exercise-editor-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        <div class="exercise-editor-body">
          ${editor.isCopy ? `<p class="muted">Saving creates your private copy without storing the original video or image. Available source media are used as fallback. The original stays unchanged. If access to its block is removed, your copy is hidden too.</p>` : editor.ownerScope === "system" ? `<p class="muted">You are editing the application original for all users.</p>` : ""}
          <label class="search-field"><span>Name</span><input class="builder-text-input" data-exercise-editor-field="name" value="${escapeAttr(d.name)}" required></label>
          <div class="exercise-editor-grid">
            <label class="search-field"><span>Exercise code</span><input class="builder-text-input" data-exercise-editor-field="exerciseCode" value="${escapeAttr(d.exerciseCode)}"></label>
          </div>
          ${renderExerciseMediaFields(editor)}
          <label class="search-field"><span>Aim</span><textarea class="builder-text-input" rows="2" data-exercise-editor-field="aim">${escapeHtml(d.aim)}</textarea></label>
          <label class="search-field"><span>Execution notes</span><textarea class="builder-text-input" rows="2" data-exercise-editor-field="executionNotes">${escapeHtml(d.executionNotes)}</textarea></label>
          <label class="search-field"><span>Instruction</span><textarea class="builder-text-input" rows="2" data-exercise-editor-field="instruction">${escapeHtml(d.instruction)}</textarea></label>
          <div class="exercise-editor-grid">
            ${SINGLE_FIELDS.map((field) => renderSingleField(field, d[field.key], filterOptions[field.optionsKey] || [])).join("")}
          </div>
          <div class="exercise-editor-multi-grid">
            ${MULTI_FIELDS.map((field) => renderMultiField(field, d[field.key] || [], filterOptions[field.optionsKey] || [])).join("")}
          </div>
          ${editor.error ? `<p class="builder-error" role="alert">${escapeHtml(editor.error)}</p>` : ""}
          ${blocked && !editor.error ? `<p class="muted exercise-media-note" role="status">${escapeHtml(SAVE_BLOCKED_SENTENCE)}</p>` : ""}
        </div>
        <div class="builder-modal-actions">
          <button class="plain-button" type="button" data-action="exercise-editor-save" ${editor.loading || held || blocked ? "disabled" : ""}>${held ? busyLabel(editor) : editor.loading ? "Saving..." : editor.isCopy ? "Save private copy" : "Save"}</button>
          <button class="text-action" type="button" data-action="exercise-editor-close">Cancel</button>
        </div>
      </section>
    </div>
  `;
}

// ---- Media fields (FE-2) ---------------------------------------------------

// A video being checked or prepared on the device counts like an upload: Save
// waits, the editor asks before closing, a reload asks first.
export const BUSY_STATES = Object.freeze(["checking", "preparing", "uploading", "cancelling"]);

export function uploadInFlight(editor) {
  return MEDIA_SLOTS.some(({ slot }) => BUSY_STATES.includes(editor?.media?.[slot]?.state));
}

// BE-3 boundary: a completed upload is not a saved media until the binding
// routes exist; Save is refused while one sits in the editor.
export function mediaSaveBlocked(editor) {
  return !isMediaSaveEnabled() && MEDIA_SLOTS.some(({ slot }) => editor?.media?.[slot]?.state === "uploaded");
}

function uploadPercent(editor) {
  const field = MEDIA_SLOTS.map(({ slot }) => editor.media[slot]).find((entry) => entry.state === "uploading" || entry.state === "cancelling");
  return percentOf(field?.progress);
}

// The Save button's label while a slot is busy: the phase and its percent.
function busyLabel(editor) {
  const field = MEDIA_SLOTS.map(({ slot }) => editor.media[slot]).find((entry) => BUSY_STATES.includes(entry.state));
  if (!field) return "Save";
  if (field.state === "checking") return "Checking...";
  if (field.state === "preparing") return `Preparing... ${preparePercent(field)}%`;
  return `Uploading... ${uploadPercent(editor)}%`;
}

function preparePercent(field) {
  return Math.min(100, Math.floor((Number(field.prepare?.fraction) || 0) * 100));
}

function percentOf(progress) {
  const total = Number(progress?.total) || 0;
  return total ? Math.min(100, Math.floor((Number(progress.sent) || 0) / total * 100)) : 0;
}

// The storage account an upload from this editor would be charged to: the
// one the server selected for the exercise (a club exercise charges the club,
// an application exercise the uploading administrator), else the signed-in
// coach's own row for a new exercise or a copy. Null until the storage answer
// is in, and null when it failed, said the storage is off (503) or refused
// (403): an unknown account never enables anything.
export function chargedStorageAccount(editor) {
  const storage = editor?.media?.storage;
  if (!storage || storage.loading || storage.error || storage.disabled || storage.unavailable || !storage.data) return null;
  return chargedAccount(storage.data, { userId: editor.viewerId });
}

// The quota is the gate (owner's decision, phase E-1): an account may upload
// only with a limit above zero and room under it. The platform administrator
// hands out limits through Settings -> Storage, so the accounts with a limit
// are the pilot; the default of 0 B keeps every other coach on the editor of
// today, whatever the guards say.
export function quotaAllowsUploads(account) {
  if (!account) return false;
  const limit = Number(account.limitBytes);
  const available = Number(account.availableBytes);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  if (account.overLimit === true) return false;
  return Number.isFinite(available) && available > 0;
}

// Uploading is offered only behind the transport guard (a code change after
// the activation gates), only for an account the storage answer named and the
// quota allows (above), and, for a new exercise or a copy, only once BE-3 can
// bind the upload on save. Everything else - 0 B, a full account, a storage
// read still loading or failed, 503, 403 - leaves the editor exactly as it is
// today: the two link fields, Preview of a stored file, Remove by the save
// guard alone.
function uploadsOffered(editor) {
  if (!isUploadTransportEnabled()) return false;
  if ((editor.isNew || editor.isCopy) && !isMediaSaveEnabled()) return false;
  return quotaAllowsUploads(chargedStorageAccount(editor));
}

function storageWanted(editor) {
  if (!isUploadTransportEnabled()) return false;
  return editor.isNew || editor.isCopy ? isMediaSaveEnabled() : Boolean(editor.exerciseId);
}

// PR 3: the R2 video a frame of which may become the picture - the uploaded
// file through its own object URL, or the stored file through its signed
// playback address (read when the picker opens). A Drive / YouTube link has
// no frame the browser may read.
function frameSource(editor) {
  const video = editor?.media?.video;
  if (!video) return null;
  if (video.state === "uploaded" && video.mediaId && video.previewUrl) return { kind: "file", src: video.previewUrl, sourceMediaId: video.mediaId };
  if (video.state === "stored" && video.mediaId && editor.exerciseId) return { kind: "stored", src: "", sourceMediaId: video.mediaId };
  return null;
}

// A frame is offered only where the picture it makes can be saved with the
// exercise (BE-3) - an upload nobody can save would only be charged - and
// never while something uploads.
function frameOffered(editor) {
  return uploadsOffered(editor) && isMediaSaveEnabled() && !uploadInFlight(editor) && frameSource(editor) !== null;
}

function renderExerciseMediaFields(editor) {
  const offered = uploadsOffered(editor);
  // The storage line belongs to an account with a limit, and only once both
  // guards are on (owner, 2026-10-19: E-1 changes nothing on screen for
  // anyone, pilots included, until the save works): a full account then sees
  // its numbers and why nothing can be added; a 0 B account never sees a line.
  const account = isUploadTransportEnabled() && isMediaSaveEnabled() ? chargedStorageAccount(editor) : null;
  const quotaAccount = account && Number(account.limitBytes) > 0 ? account : null;
  return `
    <div class="exercise-media-fields" data-exercise-media-fields>
      ${MEDIA_SLOTS.map((spec) => renderMediaField(editor, spec, offered)).join("")}
      ${quotaAccount ? renderStorageLine(editor, quotaAccount, offered) : ""}
    </div>
  `;
}

function renderStorageLine(editor, account, offered) {
  const used = formatBytes(account.usedBytes);
  const limit = formatBytes(account.limitBytes);
  const free = formatBytes(account.availableBytes);
  const full = offered ? "" : " · Storage is full: remove media you no longer use or ask an administrator for more storage.";
  return `<p class="muted exercise-media-storage" data-exercise-media-storage>Storage (${escapeHtml(describeStorageAccount(account, { ownerScope: editor.ownerScope }))}): ${escapeHtml(used)} used of ${escapeHtml(limit)} · ${escapeHtml(free)} free · one video up to ${escapeHtml(formatBytes(account.maxVideoBytes))}, one picture up to ${escapeHtml(formatBytes(account.maxImageBytes))}${escapeHtml(full)}</p>`;
}

function renderMediaField(editor, spec, offered) {
  const field = editor.media[spec.slot];
  const url = String(editor.data[spec.urlKey] || "").trim();
  const saveEnabled = isMediaSaveEnabled();
  // While a video or a picture is being prepared or uploaded, every other
  // control of both slots is shown disabled (its handler ignores it anyway);
  // only the busy slot's Cancel stays live.
  const busy = uploadInFlight(editor);
  const off = (action) => (busy && action !== "exercise-media-cancel" ? " disabled" : "");
  const upload = (label, action) => `<button class="plain-button compact-button" type="button" data-action="${action}" data-slot="${spec.slot}"${off(action)}>${label}</button>`;
  const link = (label = "Use a link") => `<button class="text-action" type="button" data-action="exercise-media-link" data-slot="${spec.slot}"${off("exercise-media-link")}>${label}</button>`;
  const remove = (label = "Remove") => `<button class="text-action" type="button" data-action="exercise-media-remove" data-slot="${spec.slot}"${off("exercise-media-remove")}>${label}</button>`;
  // PR 3: the picture may be a frame of the exercise's R2 video.
  const frame = (label) => (spec.slot === "image" && frameOffered(editor) ? `<button class="plain-button compact-button" type="button" data-action="exercise-media-frame-pick" data-slot="image">${label}</button>` : "");
  const originText = spec.slot !== "image" ? "" : field.origin ? describeFrameOrigin(field.origin) : field.note === FRAME_SAVED_AS_PICTURE ? field.note : "";
  const origin = originText ? `<p class="muted exercise-media-origin">${escapeHtml(originText)}</p>` : "";
  const picker = offered ? `<input type="file" accept="${escapeAttr(UPLOAD_SLOTS[spec.slot].accept)}" data-exercise-media-file="${spec.slot}" aria-label="Choose a ${spec.noun} file">` : "";
  const linkInput = `<label class="search-field"><span>${spec.label} URL</span><input class="builder-text-input" type="url" data-exercise-editor-field="${spec.urlKey}" value="${escapeAttr(url)}" placeholder="Google Drive, YouTube or direct link"></label>`;
  // No storage offered (the guard, the flag off, another workspace, a new
  // exercise, a copy) and no stored file: the plain link field, exactly as before.
  if (!offered && field.state !== "stored") {
    return `
    <section class="exercise-media-field" data-exercise-media-slot="${spec.slot}" aria-label="${spec.label}">
      ${linkInput}
    </section>
  `;
  }
  let body = "";
  switch (field.state) {
    case "checking":
      body = `
        ${renderFileLine(field)}
        <progress class="exercise-media-progress" data-exercise-media-progress="${spec.slot}" aria-label="Checking the ${spec.noun}"></progress>
        <p class="muted exercise-media-status" role="status" data-exercise-media-progress-text="${spec.slot}">Checking the ${spec.noun}...</p>
        <div class="exercise-media-actions">${upload("Cancel", "exercise-media-cancel")}</div>`;
      break;
    case "preparing":
      body = `
        ${renderFileLine(field)}
        <progress class="exercise-media-progress" max="100" value="${preparePercent(field)}" data-exercise-media-progress="${spec.slot}" aria-label="Preparation progress"></progress>
        <p class="muted exercise-media-status" role="status" data-exercise-media-progress-text="${spec.slot}">${escapeHtml(prepareText(field, spec))}</p>
        <div class="exercise-media-actions">${upload("Cancel", "exercise-media-cancel")}</div>`;
      break;
    case "uploading":
      body = `
        ${renderFileLine(field)}
        <progress class="exercise-media-progress" max="100" value="${percentOf(field.progress)}" data-exercise-media-progress="${spec.slot}" aria-label="Upload progress"></progress>
        <p class="muted exercise-media-status" role="status" data-exercise-media-progress-text="${spec.slot}">${escapeHtml(progressText(field, spec))}</p>
        <div class="exercise-media-actions">${upload("Cancel", "exercise-media-cancel")}</div>`;
      break;
    case "cancelling":
      body = `
        ${renderFileLine(field)}
        <p class="muted exercise-media-status" role="status">Cancelling...</p>`;
      break;
    case "uploaded":
      body = `
        ${renderFileLine(field)}
        <p class="${saveEnabled ? "muted" : ""} exercise-media-status" role="status">${saveEnabled
          ? "Uploaded and verified. It is saved with the exercise when you press Save."
          : "Uploaded and verified. Saving it with the exercise is not available yet."}</p>
        ${origin}
        ${field.previewOpen ? renderLocalPreview(field, spec) : ""}
        <div class="exercise-media-actions">${field.previewUrl ? upload(field.previewOpen ? "Hide preview" : "Preview", "exercise-media-preview-local") : ""}${upload("Replace...", "exercise-media-pick")}${frame(field.origin ? "Choose another frame..." : "Replace with a frame...")}${remove()}</div>`;
      break;
    case "failed":
    case "cancelled": {
      const code = field.error?.code || "";
      const retry = field.state === "failed" && field.file && !["upload_transport_disabled", "upload_contract_pending", "verification_timeout", "video_too_long"].includes(code);
      body = `
        ${field.fileName ? renderFileLine(field) : ""}
        <p class="${field.state === "failed" ? "builder-error" : "muted"} exercise-media-status" role="alert">${escapeHtml(field.error?.message || "")}</p>
        <div class="exercise-media-actions">
          ${code === "verification_timeout" && field.uploadId ? upload("Check again", "exercise-media-check") : ""}
          ${retry ? upload("Retry", "exercise-media-retry") : ""}
          ${offered ? upload(code === "preparation_cancelled" ? `Choose a ${spec.noun}` : field.state === "cancelled" ? "Upload again" : "Choose another file", "exercise-media-pick") : ""}${frame("Use a frame of the video...")}
          ${link()}${remove("Clear")}
        </div>`;
      break;
    }
    case "stored": {
      const media = exerciseMediaOf({ media: { video: spec.slot === "video" ? { source: "asset", mediaId: field.mediaId } : { source: "none" }, image: spec.slot === "image" ? { source: "asset", mediaId: field.mediaId } : { source: "none" }, accessContext: { type: "exercise", id: editor.exerciseId } } });
      body = `
        <p class="exercise-media-status">${spec.label} file, stored with this exercise.</p>
        <details class="exercise-media-technical"><summary>Technical details</summary><code>media ${escapeHtml(field.mediaId)}</code></details>
        <div class="exercise-media-actions">
          <button class="plain-button compact-button" type="button" data-action="open-media" data-title="${escapeAttr(editor.data.name || "Exercise media")}" ${mediaAccessAttributes(media)}>Preview</button>
          ${offered && saveEnabled ? upload("Replace...", "exercise-media-pick") : ""}${frame("Replace with a frame...")}${saveEnabled ? remove() : ""}
        </div>`;
      break;
    }
    default:
      if (url) {
        body = `
          <p class="exercise-media-status"><span class="item-badge">${escapeHtml(LINK_KINDS[legacyMediaKind(url)] || "Link")}</span> <span class="exercise-media-file-name" title="${escapeAttr(url)}">${escapeHtml(url)}</span></p>
          ${field.linkOpen ? linkInput : ""}
          <div class="exercise-media-actions">
            <button class="plain-button compact-button" type="button" data-action="open-media" data-title="${escapeAttr(editor.data.name || "Exercise media")}" data-image="${escapeAttr(spec.slot === "image" ? url : "")}" data-video="${escapeAttr(spec.slot === "video" ? url : "")}">Preview</button>
            ${field.linkOpen ? "" : link("Edit link")}${offered ? upload("Replace with a file...", "exercise-media-pick") : ""}${frame("Replace with a frame...")}${remove()}
          </div>`;
      } else {
        body = `
          ${offered && !field.linkOpen ? `<p class="muted exercise-media-status"${field.capturing ? ` role="status"` : ""}>${field.capturing ? "Making a thumbnail from the video..." : `No ${spec.noun} yet.`}</p>` : ""}
          ${field.note && !field.capturing ? `<p class="muted exercise-media-status" role="status">${escapeHtml(field.note)}</p>` : ""}
          ${offered && !field.linkOpen ? `<div class="exercise-media-actions">${upload(`Upload ${spec.noun}...`, "exercise-media-pick")}${frame("Choose a frame of the video...")}${link()}</div>` : linkInput}`;
      }
  }
  return `
    <section class="exercise-media-field" data-exercise-media-slot="${spec.slot}" aria-label="${spec.label}">
      <p class="eyebrow">${spec.label}</p>
      ${body}
      ${spec.slot === "image" ? renderFramePickerHtml(field.framePicker, { slot: "image" }) : ""}
      ${picker}
    </section>
  `;
}

function renderFileLine(field) {
  // A prepared video shows its new size and the size it came from.
  const prepared = field.prepare?.converted && field.prepare.sourceSize ? ` · prepared from ${formatBytes(field.prepare.sourceSize)}` : "";
  return `<p class="exercise-media-file"><span class="exercise-media-file-name" title="${escapeAttr(field.fileName)}">${escapeHtml(field.fileName)}</span><span class="muted">${escapeHtml(formatBytes(field.fileSize) + prepared)}</span></p>`;
}

function progressText(field, spec = null) {
  const sent = Number(field.progress?.sent) || 0;
  const total = Number(field.progress?.total) || field.fileSize || 0;
  const bytes = `${percentOf({ sent, total })} % · ${formatBytes(sent)} of ${formatBytes(total)}`;
  return spec ? `Uploading the ${spec.noun}... ${bytes}` : bytes;
}

function prepareText(field, spec) {
  return `Preparing the ${spec.noun}... ${preparePercent(field)} %`;
}

function renderLocalPreview(field, spec) {
  if (!field.previewUrl) return "";
  return `<div class="exercise-media-preview-local">${spec.slot === "video"
    ? `<video controls playsinline muted preload="metadata" src="${escapeAttr(field.previewUrl)}"></video>`
    : `<img src="${escapeAttr(field.previewUrl)}" alt="">`}</div>`;
}

// ---- Field rendering (unchanged) -------------------------------------------

export function renderSingleField(field, value, options) {
  const listId = `exercise-editor-${field.key}-options`;
  return `
    <label class="search-field">
      <span>${escapeHtml(field.label)}</span>
      <input class="builder-text-input" list="${escapeAttr(listId)}" data-exercise-editor-field="${escapeAttr(field.key)}" value="${escapeAttr(value || "")}" autocomplete="off">
      <datalist id="${escapeAttr(listId)}">${options.map((option) => `<option value="${escapeAttr(option)}"></option>`).join("")}</datalist>
    </label>
  `;
}

export function renderMultiField(field, values, options) {
  const listId = `exercise-editor-${field.key}-options`;
  return `
    <div class="exercise-editor-multi-field">
      <span class="builder-quick-add-label">${escapeHtml(field.label)}</span>
      <div class="tag-chip-row">
        ${values.length ? values.map((value) => `
          <span class="tag-chip">
            ${escapeHtml(value)}
            <button class="tag-chip-remove" type="button" data-action="exercise-editor-remove-value" data-field="${escapeAttr(field.key)}" data-value="${escapeAttr(value)}" aria-label="Remove ${escapeAttr(value)}">&times;</button>
          </span>
        `).join("") : `<span class="muted">None yet.</span>`}
      </div>
      <div class="exercise-editor-multi-add">
        <input class="builder-text-input" list="${escapeAttr(listId)}" placeholder="Add ${escapeAttr(field.label.toLowerCase())}" data-exercise-editor-add-input data-field="${escapeAttr(field.key)}" autocomplete="off">
        <datalist id="${escapeAttr(listId)}">${options.map((option) => `<option value="${escapeAttr(option)}"></option>`).join("")}</datalist>
        <button class="plain-button compact-button" type="button" data-action="exercise-editor-add-value" data-field="${escapeAttr(field.key)}">+ Add</button>
      </div>
    </div>
  `;
}

// ---- Open / close ----------------------------------------------------------

export async function openExerciseEditor(state, handlers, exerciseId, { copy = false } = {}) {
  releaseMediaPreviews(state.exerciseEditor);
  state.exerciseEditor = { ...emptyExerciseEditor(), open: true, isNew: !exerciseId, isCopy: copy, exerciseId: exerciseId || "", viewerId: String(state.currentUser?.id || "") };
  const editor = state.exerciseEditor;
  // Storage is read only where an upload could be offered.
  if (storageWanted(editor)) void loadExerciseMediaStorage(state, handlers);
  if (exerciseId) {
    editor.loading = true;
    handlers.rerender();
    try {
      const detail = await api(`/api/exercises/${encodeURIComponent(exerciseId)}`);
      if (state.exerciseEditor !== editor) return;
      if (!copy && detail.canEdit === false) throw new Error("You cannot edit this exercise. Use Copy to create your own version.");
      editor.ownerScope = detail.ownerScope || "user";
      editor.data = {
        name: detail.name || "", exerciseCode: copy ? "" : detail.exerciseCode || "", aim: detail.aim || "",
        executionNotes: detail.executionNotes || "", instruction: detail.instruction || "",
        videoUrl: copy ? "" : detail.videoUrl || "", imageUrl: copy ? "" : detail.imageUrl || "",
        place: detail.place || "", complexity: detail.complexity || "", startingPosition: detail.startingPosition || "",
        attractor: detail.attractor || "", purposes: detail.purposes || [], qualities: detail.qualities || [],
        groups: detail.groups || [], bodyParts: detail.bodyParts || [], movementPatterns: detail.movementPatterns || [],
        tags: detail.tags || [],
      };
      // An R2 asset the exercise already has (the media descriptor, FE-1): a
      // copy starts without it, like the links (Q6: a copy uploads its own files).
      if (!copy) {
        const media = exerciseMediaOf(detail);
        for (const { slot } of MEDIA_SLOTS) {
          if (media[slot].source === "asset") editor.media[slot] = { ...emptyMediaField(), state: "stored", mediaId: media[slot].mediaId };
        }
      }
      editor.loading = false;
    } catch (error) {
      if (state.exerciseEditor !== editor) return;
      editor.loading = false;
      editor.error = error.message || "Could not load exercise.";
    }
  }
  handlers.rerender();
}

async function loadExerciseMediaStorage(state, handlers) {
  const editor = state.exerciseEditor;
  const storage = editor.media.storage;
  storage.loading = true;
  storage.error = "";
  try {
    // An existing exercise: the server resolves the owner it would charge (Q8).
    const data = await readStorageUsage({ exerciseId: editor.isNew || editor.isCopy ? "" : editor.exerciseId });
    if (state.exerciseEditor !== editor) return;
    Object.assign(storage, { loading: false, data, disabled: false, unavailable: false });
  } catch (error) {
    if (state.exerciseEditor !== editor) return;
    const code = error?.code;
    Object.assign(storage, {
      loading: false,
      data: null,
      disabled: code === "media_storage_disabled",
      unavailable: code === "operation_not_allowed" || code === "resource_not_found",
      error: ["media_storage_disabled", "operation_not_allowed", "resource_not_found"].includes(code) ? "" : "unreadable",
    });
  }
  handlers.rerender();
}

// Closing with an upload in flight asks first (the browser's own confirm);
// "yes" cancels the upload, on the server too. Returns true when the editor closed.
export function closeExerciseEditor(state, handlers) {
  const editor = state.exerciseEditor;
  if (uploadInFlight(editor)) {
    const ask = typeof globalThis.confirm === "function" ? globalThis.confirm : () => true;
    if (!ask("A video is still being prepared or uploaded. Close the editor and cancel it?")) return false;
    for (const { slot } of MEDIA_SLOTS) editor.media[slot].controller?.abort();
  }
  releaseMediaPreviews(editor);
  stopAutomaticThumbnail(editor.media?.image);
  state.exerciseEditor = emptyExerciseEditor();
  handlers.rerender();
  return true;
}

function releaseMediaPreviews(editor) {
  for (const { slot } of MEDIA_SLOTS) {
    const field = editor?.media?.[slot];
    if (field?.previewUrl && typeof globalThis.URL?.revokeObjectURL === "function") {
      try { globalThis.URL.revokeObjectURL(field.previewUrl); } catch { /* already gone */ }
    }
  }
}

// app.js registers this next to the other beforeunload guards: a reload or
// a closed tab while an upload runs asks first (the browser's own dialog).
export function handleExerciseMediaBeforeUnload(event, state) {
  if (!uploadInFlight(state?.exerciseEditor)) return false;
  event.preventDefault();
  event.returnValue = "A video is still being prepared or uploaded.";
  return true;
}

export function handleExerciseEditorInput(state, event) {
  const field = event.target.closest("[data-exercise-editor-field]");
  if (field) {
    state.exerciseEditor.data[field.dataset.exerciseEditorField] = field.value;
    return true;
  }
  const slider = event.target.closest?.("[data-exercise-media-frame-time]");
  if (slider) return handleFrameSliderInput(state, slider);
  return false;
}

// The hidden file input's change: the chosen file is kept in state and its
// upload starts at once. Returns true when it was ours.
export function handleExerciseEditorChange(state, handlers, event) {
  const input = event.target?.closest?.("[data-exercise-media-file]");
  if (!input) return false;
  const slot = input.dataset.exerciseMediaFile;
  const file = input.files?.[0] || null;
  if (file && MEDIA_SLOTS.some((spec) => spec.slot === slot)) void chooseExerciseMediaFile(state, handlers, slot, file);
  return true;
}

// ---- The upload itself (FE-2) ---------------------------------------------

export async function chooseExerciseMediaFile(state, handlers, slot, file, { origin = null } = {}) {
  const editor = state.exerciseEditor;
  const field = editor.media[slot];
  if (!uploadsOffered(editor) || uploadInFlight(editor)) return;
  if (field.state === "stored") field.previous = { state: "stored", mediaId: field.mediaId };
  // A new video: the picker and a thumbnail being made belong to the old one.
  if (slot === "video") detachVideoDependents(editor);
  // A picture chosen by the coach: a thumbnail still being made is stopped (its video stops loading).
  else stopAutomaticThumbnail(field);
  releaseFieldPreview(field);
  Object.assign(field, {
    file, fileName: file.name || "file", fileSize: Number(file.size) || 0, mimeType: file.type || "", error: null, previewOpen: false,
    mediaId: "", uploadId: "", idempotencyKey: "", resumable: false, media: null, cancelOutcome: "", linkOpen: false,
    origin: slot === "image" ? frameOrigin(origin || {}) : null, framePicker: null, capturing: false, captureStop: null, note: "", prepare: null,
  });
  if (slot === "video") {
    // The chosen video is read and, when the server would refuse it as it
    // is, converted on this device first; the upload then takes the result.
    const prepared = await prepareChosenVideo(state, handlers, editor, field, file);
    if (!prepared) return;
    file = prepared;
  }
  const account = chargedAccount(editor.media.storage.data, { userId: editor.viewerId });
  const check = validateFile(file, slot, editor.media.storage.data ? account : null);
  if (!check.ok) {
    // A file the limits refuse would be refused again: no Retry, another file.
    Object.assign(field, { state: "failed", error: { code: check.code, message: describeUploadError(check.code, { slot, file, account }) }, file: null });
    handlers.rerender();
    return;
  }
  await uploadExerciseMedia(state, handlers, slot);
}

// The on-device preparation of a chosen video (exercise-media-prepare.js):
// "Checking the video..." while it is read, "Preparing the video... N %" while
// it is converted, then the prepared file replaces the chosen one in the
// field and the upload starts. Resolves to the file to upload, or null when
// the field already says why there is none (refused, cancelled, the editor
// closed). The field's controller cancels it like an upload.
async function prepareChosenVideo(state, handlers, editor, field, file) {
  const controller = new AbortController();
  Object.assign(field, { state: "checking", controller, prepare: { fraction: 0, percent: 0, sourceSize: Number(file.size) || 0, converted: false }, progress: { sent: 0, total: 0 } });
  handlers.rerender();
  const live = () => state.exerciseEditor === editor && field.controller === controller;
  const prepare = handlers.prepareVideo || prepareVideo;
  let settled = false;
  try {
    const result = await prepare(file, {
      signal: controller.signal,
      onPhase: (phase) => {
        if (!live() || field.state === "cancelling") return;
        // The same face in place (no redraw): a Cancel being tapped is not replaced under the finger.
        if (phase === "preparing" && field.state === "checking") { field.state = "preparing"; if (!patchPrepareStart("video", field)) handlers.rerender(); }
        if (phase === "verifying" && field.state === "preparing") { field.prepare.fraction = 1; patchPrepareProgress("video", field); }
      },
      onProgress: (fraction) => {
        if (!live() || field.state !== "preparing") return;
        field.prepare.fraction = Math.max(0, Math.min(1, Number(fraction) || 0));
        // One patch per whole percent: the encoder may report far more often.
        if (preparePercent(field) === field.prepare.percent) return;
        field.prepare.percent = preparePercent(field);
        patchPrepareProgress("video", field);
      },
    });
    if (!live()) return null;
    // A Cancel that landed after the preparation's last check: the result is dropped, nothing goes up.
    if (controller.signal.aborted || field.state === "cancelling") throw Object.assign(new Error("preparation_cancelled"), { code: "preparation_cancelled" });
    const prepared = result.file;
    Object.assign(field, {
      file: prepared, fileName: prepared.name || field.fileName, fileSize: Number(prepared.size) || 0, mimeType: prepared.type || "",
      prepare: { fraction: 1, percent: 100, sourceSize: Number(file.size) || 0, converted: result.converted === true },
    });
    // The upload draws the next face itself.
    settled = true;
    return prepared;
  } catch (error) {
    if (!live()) return null;
    const code = error?.code || "conversion_failed";
    const cancelled = code === "preparation_cancelled";
    // A refused or failed preparation offers another file, never a retry of
    // the same bytes; a cancelled Replace keeps what the exercise had.
    Object.assign(field, {
      state: cancelled ? "cancelled" : "failed", file: null, error: { code, message: describeUploadError(code, { slot: "video", file, detail: error?.detail || null }) },
      prepare: null, cancelOutcome: "",
    });
    if (cancelled && field.previous) Object.assign(field, { state: field.previous.state, mediaId: field.previous.mediaId, fileName: "", fileSize: 0, error: null, previous: null });
    return null;
  } finally {
    if (field.controller === controller) field.controller = null;
    if (!settled && state.exerciseEditor === editor) handlers.rerender();
  }
}

async function uploadExerciseMedia(state, handlers, slot, { resume = false } = {}) {
  const editor = state.exerciseEditor;
  const field = editor.media[slot];
  const file = field.file;
  if (!file) return;
  const controller = new AbortController();
  Object.assign(field, { state: "uploading", controller, progress: { sent: 0, total: Number(file.size) || 0 }, error: null, cancelOutcome: "" });
  handlers.rerender();
  const live = () => state.exerciseEditor === editor && field.controller === controller;
  const transport = handlers.upload || startUpload;
  const urlKey = MEDIA_SLOTS.find((spec) => spec.slot === slot).urlKey;
  try {
    const result = await transport(
      {
        file, slot, context: uploadContextFor(editor), purpose: field.origin?.purpose || UPLOAD_SLOTS[slot].purpose,
        // A frame of the video (PR 3): the contract's two extra top-level facts.
        ...(field.origin ? { sourceMediaId: field.origin.sourceMediaId, frameTimeSeconds: field.origin.frameTimeSeconds } : {}),
      },
      {
        signal: controller.signal,
        idempotencyKey: resume ? field.idempotencyKey : "",
        onProgress: (progress) => {
          if (!live()) return;
          field.progress = { sent: Number(progress?.sent) || 0, total: Number(progress?.total) || Number(file.size) || 0 };
          patchUploadProgress(slot, field);
        },
      },
    );
    if (!live()) return;
    Object.assign(field, {
      state: "uploaded", mediaId: String(result?.mediaId || ""), uploadId: String(result?.uploadId || ""), media: result?.media || null,
      progress: { sent: field.progress.total, total: field.progress.total }, idempotencyKey: "", resumable: false,
      previewUrl: typeof globalThis.URL?.createObjectURL === "function" ? safeObjectUrl(file) : "", previous: null,
    });
    // An uploaded file replaces the link of the same slot.
    editor.data[urlKey] = "";
    if (slot === "video") {
      // A new video: a thumbnail made from the previous one goes with it, and
      // one is made from this one when the picture is empty (PR 3).
      dropAutomaticThumbnail(editor, field.mediaId);
      void makeAutomaticThumbnail(state, handlers, editor);
    }
  } catch (error) {
    if (!live()) return;
    const code = error?.code || "upload_failed";
    // A frame of a stored video the server will not record as its frame - a
    // Drive copy is in the platform's storage, not the coach's - is refused
    // before any byte is sent (404, no upload). It goes up once more as a
    // plain picture, without its moment (owner, 2026-10-30).
    if (code === "resource_not_found" && !error?.uploadId && frameOfStoredVideo(editor, field)) {
      Object.assign(field, { origin: null, note: FRAME_SAVED_AS_PICTURE });
      return uploadExerciseMedia(state, handlers, slot);
    }
    const cancelled = code === "cancelled" || code === "cancel_unconfirmed";
    Object.assign(field, {
      state: cancelled ? "cancelled" : "failed",
      error: { code, message: describeUploadError(code, { slot, file, account: chargedAccount(editor.media.storage.data, { userId: editor.viewerId }) }) },
      uploadId: String(error?.uploadId || field.uploadId || ""),
      idempotencyKey: String(error?.idempotencyKey || ""),
      resumable: !cancelled && isResumableCode(code),
      cancelOutcome: String(error?.cancelOutcome || ""),
    });
    if (cancelled && field.previous) {
      // A Replace that was cancelled keeps what the exercise had.
      Object.assign(field, { state: field.previous.state, mediaId: field.previous.mediaId, file: null, fileName: "", fileSize: 0, error: null, previous: null });
    }
  } finally {
    if (field.controller === controller) field.controller = null;
  }
  handlers.rerender();
}

const FRAME_SAVED_AS_PICTURE = "Taken from the video and saved as a picture.";
// A frame (its origin) of the video stored with this exercise.
function frameOfStoredVideo(editor, field) {
  const video = editor.media.video;
  return FRAME_PURPOSES.includes(field.origin?.purpose) && video?.state === "stored" && Boolean(video.mediaId) && video.mediaId === field.origin.sourceMediaId;
}

// After a verification timeout: the same session's status, no new upload.
async function checkExerciseMediaUpload(state, handlers, slot) {
  const editor = state.exerciseEditor;
  const field = editor.media[slot];
  if (!field.uploadId) return;
  const check = handlers.checkUpload || checkUploadStatus;
  try {
    const status = await check(field.uploadId);
    if (state.exerciseEditor !== editor) return;
    if (status?.status === "completed") {
      Object.assign(field, {
        state: "uploaded", mediaId: String(status.mediaId || status.media?.mediaId || ""), media: status.media || null, error: null, resumable: false, idempotencyKey: "",
        previewUrl: field.file && typeof globalThis.URL?.createObjectURL === "function" ? safeObjectUrl(field.file) : field.previewUrl,
      });
      editor.data[MEDIA_SLOTS.find((spec) => spec.slot === slot).urlKey] = "";
    } else if (["failed", "cancelled", "expired"].includes(status?.status)) {
      const code = status.errorCode || "upload_failed";
      Object.assign(field, { state: "failed", error: { code, message: describeUploadError(code, { slot, file: field.file }) }, resumable: false });
    }
    // Still verifying: the sentence and Check again stay.
  } catch (error) {
    if (state.exerciseEditor !== editor) return;
    const code = error?.code || "network";
    Object.assign(field, { state: "failed", error: { code: "verification_timeout", message: describeUploadError(code === "resource_not_found" ? code : "verification_timeout", { slot }) } });
  }
  handlers.rerender();
}

function safeObjectUrl(file) {
  try {
    return globalThis.URL.createObjectURL(file);
  } catch {
    return "";
  }
}

// ---- Thumbnails (PR 3) ------------------------------------------------------

// The picker and a thumbnail being made depend on the video field as it is.
function detachVideoDependents(editor) {
  const image = editor.media.image;
  image.framePicker = null;
  stopAutomaticThumbnail(image);
}

// An automatic thumbnail in progress is stopped: its result is not used and
// its video stops loading at once (the coach chose a frame, the video changed,
// the editor closed).
function stopAutomaticThumbnail(image) {
  if (!image) return;
  image.capturing = false;
  const stop = image.captureStop;
  image.captureStop = null;
  stop?.abort();
}

// An automatic thumbnail belongs to the video it was made from: when that
// video is removed or replaced it goes too. A frame the coach chose stays.
function dropAutomaticThumbnail(editor, keepSourceMediaId = "") {
  detachVideoDependents(editor);
  const image = editor.media.image;
  if (image.state !== "uploaded" || !image.origin?.automatic || image.origin.sourceMediaId === keepSourceMediaId) return;
  releaseFieldPreview(image);
  editor.media.image = { ...emptyMediaField(), removedMediaId: image.removedMediaId };
}

// The duration the server verified (the completed upload's media metadata),
// or the file's own metadata read in the browser.
async function videoDuration(handlers, video, src, { crossOrigin = "", signal = null } = {}) {
  const known = Number(video.media?.metadata?.durationSeconds);
  if (Number.isFinite(known) && known > 0) return known;
  const read = handlers.readVideoMetadata || readVideoMetadata;
  return (await read(src, { crossOrigin, ...(signal ? { signal } : {}) })).durationSeconds;
}

// After a video upload that left the picture empty: a thumbnail a quarter
// into the video, through the same transport as any picture
// (`automatic_thumbnail`). Nothing is made where the picture could not be
// saved (BE-3), where the coach has a link or a file, or while something
// uploads; a failure leaves one sentence and the picture empty.
async function makeAutomaticThumbnail(state, handlers, editor) {
  const video = editor.media.video;
  const image = editor.media.image;
  const source = frameSource(editor);
  if (!frameOffered(editor) || source?.kind !== "file") return;
  if (image.state !== "none" || String(editor.data.imageUrl || "").trim() || image.capturing || image.framePicker) return;
  const sourceMediaId = source.sourceMediaId;
  // One deadline for the whole attempt (reading the video included), and a stop the coach's own choice uses too.
  const stop = new AbortController();
  const limit = Number(handlers.automaticThumbnailBoundMs) > 0 ? Number(handlers.automaticThumbnailBoundMs) : AUTOMATIC_THUMBNAIL_BOUND_MS;
  const deadline = setTimeout(() => stop.abort(Object.assign(new Error("frame_capture_timeout"), { code: "frame_capture_timeout" })), limit);
  deadline?.unref?.();
  image.capturing = true;
  image.captureStop = stop;
  image.note = "";
  handlers.rerender();
  const live = () => state.exerciseEditor === editor && editor.media.image === image && editor.media.video === video && video.state === "uploaded" && video.mediaId === sourceMediaId && image.capturing && image.captureStop === stop;
  try {
    const duration = await videoDuration(handlers, video, source.src, { signal: stop.signal });
    if (!live()) return;
    const timeSeconds = automaticThumbnailTime(duration);
    const capture = handlers.captureFrame || captureVideoFrame;
    const frame = await capture(source.src, timeSeconds, { videoName: video.fileName || editor.data.name, bound: limit, signal: stop.signal });
    if (!live()) return;
    image.capturing = false;
    image.captureStop = null;
    await chooseExerciseMediaFile(state, handlers, "image", frame.file, { origin: { purpose: "automatic_thumbnail", sourceMediaId, frameTimeSeconds: frame.timeSeconds } });
    return;
  } catch (error) {
    if (!live()) return;
    image.capturing = false;
    image.captureStop = null;
    image.note = `No thumbnail was made from the video. ${describeFrameError(error?.code)}`;
  } finally {
    clearTimeout(deadline);
  }
  handlers.rerender();
}

// The picker's own video is asked for its moment (on open, after a redraw
// and on every slide): iOS Safari draws nothing in a video that has never
// played (see showFrameAt). A moment it cannot show asks for one tap on play,
// patched in place - a redraw would reopen the video. The handlers of the
// open picker are kept for the slider, whose input has none.
let framePickerHandlers = null;
let framePickerState = null;
// The picker videos already listening for a read failure (one listener each, however often they are asked).
const failureHeard = new WeakSet();

function previewFrame(state, picker) {
  const video = globalThis.document?.querySelector?.('[data-exercise-media-frame-video="image"]');
  if (!video || !picker?.src || picker.loading) return;
  const show = framePickerHandlers?.showFrameAt || showFrameAt;
  // Only the answer to the latest request counts: an older one ending late changes nothing.
  const seq = (picker.previewSeq = (picker.previewSeq || 0) + 1);
  const current = () => state.exerciseEditor?.media?.image?.framePicker === picker && picker.previewSeq === seq;
  // A video the browser cannot read says so (no tap would help); it may fail after the answer too.
  if (!failureHeard.has(video)) {
    failureHeard.add(video);
    video.addEventListener?.("error", () => {
      if (state.exerciseEditor?.media?.image?.framePicker === picker && video.isConnected !== false) setFrameHint(picker, "error");
    });
  }
  Promise.resolve()
    .then(() => show(video, picker.timeSeconds))
    .then((result) => {
      if (!current()) return;
      setFrameHint(picker, result === "tap" || result === "error" ? result : "");
      if (result === "tap") clearHintOnPicture(state, picker, video);
    }, () => { /* the video is gone: nothing to show */ });
}

// The sentence lives in a status region that is always there; only its text
// changes (a screen reader reads the change). `kind`: "" | "tap" | "error".
function setFrameHint(picker, kind) {
  picker.needsTap = kind === "tap";
  picker.previewError = kind === "error";
  const hint = globalThis.document?.querySelector?.('[data-exercise-media-frame-hint="image"]');
  if (hint) hint.textContent = picker.needsTap ? FRAME_TAP_HINT : picker.previewError ? describeFrameError("frame_source_unreadable") : "";
}

// The sentence goes as soon as the video shows a picture - the coach tapped its
// play or used its own scrubber, or the data came late - not only on the next slide.
function clearHintOnPicture(state, picker, video) {
  const events = ["loadeddata", "seeked", "playing", "timeupdate"];
  const off = () => { for (const name of events) video.removeEventListener?.(name, check); };
  function check() {
    if (state.exerciseEditor?.media?.image?.framePicker !== picker || video.isConnected === false) { off(); return; }
    if (Number(video.readyState) < 2) return;
    off();
    if (picker.needsTap) setFrameHint(picker, "");
  }
  for (const name of events) video.addEventListener?.(name, check);
}

// The inline picker of the image field: the video opened at a quarter in,
// the coach moves to a moment, Use this frame captures and uploads it
// (`video_frame`). A stored file is read through its signed playback address.
async function openFramePicker(state, handlers) {
  const editor = state.exerciseEditor;
  const image = editor.media.image;
  const source = frameSource(editor);
  if (!frameOffered(editor) || !source) return;
  const picker = { open: true, loading: true, src: "", crossOrigin: "", sourceMediaId: source.sourceMediaId, durationSeconds: 0, timeSeconds: 0, busy: false, error: "", needsTap: false, previewError: false };
  // The coach chooses: an automatic thumbnail still being made is stopped (its result is not used, its video stops).
  stopAutomaticThumbnail(image);
  image.framePicker = picker;
  image.note = "";
  framePickerHandlers = handlers;
  framePickerState = state;
  handlers.rerender();
  const live = () => state.exerciseEditor === editor && editor.media.image === image && image.framePicker === picker;
  try {
    let src = source.src;
    let crossOrigin = "";
    if (source.kind === "stored") {
      const playback = await (handlers.loadPlayback || loadPlayback)({ type: "exercise", id: editor.exerciseId });
      src = String(playback?.url || "");
      crossOrigin = "anonymous";
      if (!src) throw Object.assign(new Error("frame_source_unavailable"), { code: "frame_source_unavailable" });
    }
    const duration = await videoDuration(handlers, editor.media.video, src, { crossOrigin });
    if (!live()) return;
    Object.assign(picker, { loading: false, src, crossOrigin, durationSeconds: duration, timeSeconds: automaticThumbnailTime(duration) });
  } catch (error) {
    if (!live()) return;
    const code = FRAME_ERROR_CODES.includes(error?.code) ? error.code : source.kind === "stored" ? "frame_source_unavailable" : "frame_capture_failed";
    Object.assign(picker, { loading: false, src: "", error: describeFrameError(code) });
  }
  handlers.rerender();
}

async function useFrame(state, handlers) {
  const editor = state.exerciseEditor;
  const image = editor.media.image;
  const picker = image.framePicker;
  if (!picker || picker.loading || picker.busy || !picker.src || !frameOffered(editor)) return;
  // The moment: where the coach left the video (its own controls or the slider).
  const element = globalThis.document?.querySelector?.('[data-exercise-media-frame-video="image"]');
  const shown = Number(element?.currentTime);
  const timeSeconds = roundFrameTime(Number(element?.readyState) > 0 && Number.isFinite(shown) ? shown : picker.timeSeconds);
  const videoName = editor.media.video.fileName || editor.data.name;
  const capture = handlers.captureFrame || captureVideoFrame;
  // The frame the coach sees, taken from the picker's own video while it shows
  // that moment - drawn now, before the redraw below replaces the element.
  // Otherwise (no picture yet) the moment is read from a video of its own.
  let drawn = null;
  if (element && Number(element.readyState) >= 2 && !element.seeking && Number.isFinite(shown)) {
    drawn = Promise.resolve((handlers.captureFrameFromElement || captureFrameFromElement)(element, { videoName }));
    drawn.catch(() => { /* falls back below */ });
  }
  Object.assign(picker, { timeSeconds, busy: true, error: "" });
  handlers.rerender();
  const live = () => state.exerciseEditor === editor && editor.media.image === image && image.framePicker === picker;
  try {
    const fromVideo = () => capture(picker.src, timeSeconds, { crossOrigin: picker.crossOrigin, videoName });
    const frame = drawn ? await drawn.catch(fromVideo) : await fromVideo();
    if (!live()) return;
    image.framePicker = null;
    await chooseExerciseMediaFile(state, handlers, "image", frame.file, { origin: { purpose: "video_frame", sourceMediaId: picker.sourceMediaId, frameTimeSeconds: frame.timeSeconds } });
    return;
  } catch (error) {
    if (!live()) return;
    Object.assign(picker, { busy: false, error: describeFrameError(error?.code) });
  }
  handlers.rerender();
}

// The picker's slider: the moment in state and in the video, no redraw (a
// redraw would reopen the video).
function handleFrameSliderInput(state, slider) {
  const picker = state.exerciseEditor?.media?.image?.framePicker;
  if (!picker || picker.loading) return true;
  picker.timeSeconds = roundFrameTime(slider.value);
  const doc = globalThis.document;
  previewFrame(state, picker);
  const label = doc?.querySelector?.('[data-exercise-media-frame-label="image"]');
  if (label) label.textContent = formatFrameTime(picker.timeSeconds);
  return true;
}

function releaseFieldPreview(field) {
  if (field.previewUrl && typeof globalThis.URL?.revokeObjectURL === "function") {
    try { globalThis.URL.revokeObjectURL(field.previewUrl); } catch { /* already gone */ }
  }
  field.previewUrl = "";
}

// Progress ticks patch the bar and its text in place: a full rerender on
// every tick would rebuild the whole editor many times a second.
function patchUploadProgress(slot, field) {
  const doc = globalThis.document;
  if (!doc?.querySelector) return;
  const spec = MEDIA_SLOTS.find((entry) => entry.slot === slot);
  const bar = doc.querySelector(`[data-exercise-media-progress="${slot}"]`);
  if (bar) bar.value = percentOf(field.progress);
  const text = doc.querySelector(`[data-exercise-media-progress-text="${slot}"]`);
  if (text) text.textContent = progressText(field, spec);
  const save = doc.querySelector('[data-action="exercise-editor-save"]');
  if (save) save.textContent = `Uploading... ${percentOf(field.progress)}%`;
}

// "Checking" becomes "Preparing" in place: the bar gains its scale, the
// sentence and the Save label change. False when the face is not on screen.
function patchPrepareStart(slot, field) {
  const doc = globalThis.document;
  const bar = doc?.querySelector?.(`[data-exercise-media-progress="${slot}"]`);
  if (!bar) return false;
  bar.setAttribute("max", "100");
  bar.setAttribute("value", String(preparePercent(field)));
  bar.setAttribute("aria-label", "Preparation progress");
  field.prepare.percent = preparePercent(field);
  patchPrepareProgress(slot, field);
  return true;
}

function patchPrepareProgress(slot, field) {
  const doc = globalThis.document;
  if (!doc?.querySelector) return;
  const spec = MEDIA_SLOTS.find((entry) => entry.slot === slot);
  const bar = doc.querySelector(`[data-exercise-media-progress="${slot}"]`);
  if (bar) bar.value = preparePercent(field);
  const text = doc.querySelector(`[data-exercise-media-progress-text="${slot}"]`);
  if (text) text.textContent = prepareText(field, spec);
  const save = doc.querySelector('[data-action="exercise-editor-save"]');
  if (save) save.textContent = `Preparing... ${preparePercent(field)}%`;
}

function handleExerciseMediaAction(state, handlers, action) {
  const type = action.dataset.action;
  if (!type?.startsWith("exercise-media-")) return false;
  const editor = state.exerciseEditor;
  if (type === "exercise-media-storage-reload") {
    void loadExerciseMediaStorage(state, handlers);
    return true;
  }
  const slot = action.dataset.slot;
  const spec = MEDIA_SLOTS.find((entry) => entry.slot === slot);
  if (!spec) return true;
  const field = editor.media[slot];
  if (type === "exercise-media-pick") {
    if (!uploadsOffered(editor) || uploadInFlight(editor)) return true;
    action.closest?.("[data-exercise-media-slot]")?.querySelector?.("[data-exercise-media-file]")?.click?.();
    return true;
  }
  if (type === "exercise-media-link") {
    field.linkOpen = true;
    handlers.rerender();
    globalThis.document?.querySelector?.(`[data-exercise-media-slot="${slot}"] [data-exercise-editor-field]`)?.focus?.();
    return true;
  }
  if (type === "exercise-media-cancel") {
    if (!["uploading", "checking", "preparing"].includes(field.state) || !field.controller) return true;
    // An upload: the transport tells the server (DELETE) and the field settles
    // when it answers. A preparation: the conversion stops on the device.
    field.state = "cancelling";
    field.controller.abort();
    handlers.rerender();
    return true;
  }
  if (type === "exercise-media-retry") {
    if (field.state === "failed" && field.file) void uploadExerciseMedia(state, handlers, slot, { resume: field.resumable && Boolean(field.idempotencyKey) });
    return true;
  }
  if (type === "exercise-media-check") {
    void checkExerciseMediaUpload(state, handlers, slot);
    return true;
  }
  if (type === "exercise-media-preview-local") {
    field.previewOpen = !field.previewOpen;
    handlers.rerender();
    return true;
  }
  if (type === "exercise-media-remove") {
    if (uploadInFlight(editor)) return true;
    if (field.state === "stored" && !isMediaSaveEnabled()) return true;
    // A stored file removed here is dropped from the exercise on Save (Q5,
    // { source: "none" }, the object stays); an uploaded, unsaved file is
    // simply left out (it stays charged until the lifecycle work, Q9); the
    // link of the same slot is cleared at once.
    const removedMediaId = field.state === "stored" ? field.mediaId : field.previous?.state === "stored" ? field.previous.mediaId : field.removedMediaId;
    // The video goes: so does a thumbnail made from it, and the picker over it (PR 3).
    if (slot === "video") dropAutomaticThumbnail(editor);
    releaseFieldPreview(field);
    editor.media[slot] = { ...emptyMediaField(), removedMediaId: removedMediaId || "" };
    editor.data[spec.urlKey] = "";
    handlers.rerender();
    return true;
  }
  if (type === "exercise-media-frame-pick") {
    if (slot === "image") void openFramePicker(state, handlers);
    return true;
  }
  if (type === "exercise-media-frame-cancel") {
    if (field.framePicker && !field.framePicker.busy) {
      field.framePicker = null;
      handlers.rerender();
    }
    return true;
  }
  if (type === "exercise-media-frame-use") {
    if (slot === "image") void useFrame(state, handlers);
    return true;
  }
  return true;
}

export async function handleExerciseEditorAction(state, handlers, action) {
  const type = action.dataset.action;
  if (type === "exercise-editor-close") {
    closeExerciseEditor(state, handlers);
    return true;
  }
  if (handleExerciseMediaAction(state, handlers, action)) return true;
  if (type === "exercise-editor-add-value") {
    const fieldKey = action.dataset.field;
    const input = action.closest(".exercise-editor-multi-add")?.querySelector("[data-exercise-editor-add-input]");
    const value = (input?.value || "").trim();
    if (value) {
      const list = state.exerciseEditor.data[fieldKey] || [];
      if (!list.includes(value)) state.exerciseEditor.data[fieldKey] = [...list, value];
    }
    handlers.rerender();
    return true;
  }
  if (type === "exercise-editor-remove-value") {
    const fieldKey = action.dataset.field;
    const value = action.dataset.value;
    state.exerciseEditor.data[fieldKey] = (state.exerciseEditor.data[fieldKey] || []).filter((entry) => entry !== value);
    handlers.rerender();
    return true;
  }
  if (type === "exercise-editor-save") {
    const editor = state.exerciseEditor;
    if (!editor.data.name.trim()) {
      editor.error = "Exercise name is required.";
      handlers.rerender();
      return true;
    }
    if (uploadInFlight(editor)) {
      editor.error = "Wait for the upload to finish, or cancel it, before saving.";
      handlers.rerender();
      return true;
    }
    if (mediaSaveBlocked(editor)) {
      editor.error = SAVE_BLOCKED_SENTENCE;
      handlers.rerender();
      return true;
    }
    editor.loading = true;
    editor.error = "";
    handlers.rerender();
    try {
      const payload = applyMediaToSavePayload({ ...editor.data }, editor.media);
      delete payload.tags;
      if (editor.isCopy) {
        await api(`/api/exercises/${encodeURIComponent(editor.exerciseId)}/copy`, { method: "POST", body: JSON.stringify(payload) });
      } else if (editor.isNew) {
        await api("/api/exercises", { method: "POST", body: JSON.stringify(payload) });
      } else {
        await api(`/api/exercises/${encodeURIComponent(editor.exerciseId)}`, { method: "PATCH", body: JSON.stringify(payload) });
        // The signed addresses are cached per (context, slot) and the
        // resolver writes the cached object back onto a card, so a saved
        // Replace / Remove / frame would keep showing the previous object
        // until the address expires (pilot E5, 2026-10-19). Only this
        // exercise's context is forgotten, after the server confirmed the
        // save and before the library or the Builder draws the row again;
        // a new exercise and a private copy have no cached context yet.
        forgetMediaAccess({ type: "exercise", id: editor.exerciseId });
      }
      closeExerciseEditor(state, handlers);
      await handlers.refreshAfterSave();
    } catch (error) {
      editor.loading = false;
      editor.error = error.message || "Could not save exercise.";
      handlers.rerender();
    }
    return true;
  }
  return false;
}
