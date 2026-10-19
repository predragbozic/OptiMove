import { api } from "./api.js";
import { chargedAccount, describeStorageAccount, describeUploadError, emptyStorageState, mediaSavePayload, readStorageUsage, startUpload, UPLOAD_SLOTS, validateFile } from "./exercise-media-upload.js";
import { exerciseMediaOf, legacyMediaKind, mediaAccessAttributes } from "./media.js";
import { escapeAttr, escapeHtml, formatBytes } from "./utils.js";

export const emptyExerciseEditorData = () => ({
  name: "", exerciseCode: "", aim: "", executionNotes: "", instruction: "", videoUrl: "", imageUrl: "",
  place: "", complexity: "", startingPosition: "", attractor: "",
  purposes: [], qualities: [], groups: [], bodyParts: [], movementPatterns: [], tags: [],
});

// One media slot of the editor (FE-2). `state` is the file's own story -
// none, stored (an R2 asset the exercise already has), uploading, uploaded
// (a record exists, the exercise not saved yet), failed, cancelled - while
// a Google Drive, YouTube or direct link lives in data.videoUrl / imageUrl as
// before. The File, the progress and the AbortController live here, never in
// the DOM: the editor is drawn again from scratch on every change.
export const emptyMediaField = () => ({
  state: "none", mediaId: "", file: null, fileName: "", fileSize: 0, mimeType: "",
  progress: { sent: 0, total: 0 }, error: null, controller: null, uploadId: "",
  linkOpen: false, previewOpen: false, previewUrl: "", removedMediaId: "", previous: null,
});

export const emptyExerciseMedia = () => ({ video: emptyMediaField(), image: emptyMediaField(), storage: emptyStorageState() });

export const emptyExerciseEditor = () => ({
  open: false, isNew: false, isCopy: false, exerciseId: "", ownerScope: "user", loading: false, error: "", data: emptyExerciseEditorData(),
  media: emptyExerciseMedia(),
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

export function renderExerciseEditorHtml(editor, filterOptions = {}) {
  const d = editor.data;
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
        </div>
        <div class="builder-modal-actions">
          <button class="plain-button" type="button" data-action="exercise-editor-save" ${editor.loading || uploadInFlight(editor) ? "disabled" : ""}>${uploadInFlight(editor) ? `Uploading... ${uploadPercent(editor)}%` : editor.loading ? "Saving..." : editor.isCopy ? "Save private copy" : "Save"}</button>
          <button class="text-action" type="button" data-action="exercise-editor-close">Cancel</button>
        </div>
      </section>
    </div>
  `;
}

// ---- Media fields (FE-2) ---------------------------------------------------

export function uploadInFlight(editor) {
  return MEDIA_SLOTS.some(({ slot }) => editor?.media?.[slot]?.state === "uploading");
}

function uploadPercent(editor) {
  const field = MEDIA_SLOTS.map(({ slot }) => editor.media[slot]).find((entry) => entry.state === "uploading");
  return percentOf(field?.progress);
}

function percentOf(progress) {
  const total = Number(progress?.total) || 0;
  return total ? Math.min(100, Math.floor((Number(progress.sent) || 0) / total * 100)) : 0;
}

// Uploading is offered only while the server offers storage (BE-1: a 503
// media_storage_disabled or a 403 means no control at all, the links as
// before) and for an exercise that already exists (a new one or a copy has
// no context to upload into yet).
function uploadsOffered(editor) {
  const storage = editor.media?.storage;
  return Boolean(storage) && !storage.disabled && !storage.unavailable && !editor.isNew && !editor.isCopy;
}

function renderExerciseMediaFields(editor) {
  const offered = uploadsOffered(editor);
  const storage = editor.media?.storage;
  // A new exercise or a copy: links only, nothing said about files (see the
  // open questions of docs/ai/exercise-media-r2-fe2-upload-contract.md).
  const note = !storage || storage.disabled || storage.unavailable || editor.isNew || editor.isCopy ? "" : renderStorageLine(storage);
  return `
    <div class="exercise-media-fields" data-exercise-media-fields>
      ${MEDIA_SLOTS.map((spec) => renderMediaField(editor, spec, offered)).join("")}
      ${note}
    </div>
  `;
}

function renderStorageLine(storage) {
  if (storage.loading) return `<p class="muted exercise-media-storage" role="status">Reading storage...</p>`;
  if (storage.error) {
    return `<p class="muted exercise-media-storage">Storage usage could not be read; the server still checks every upload. <button class="text-action" type="button" data-action="exercise-media-storage-reload">Read again</button></p>`;
  }
  const account = chargedAccount(storage.data?.accounts);
  if (!account) return "";
  const used = formatBytes(account.usedBytes);
  const limit = formatBytes(account.limitBytes);
  const free = formatBytes(account.availableBytes);
  return `<p class="muted exercise-media-storage" data-exercise-media-storage>Storage (${escapeHtml(describeStorageAccount(account))}): ${escapeHtml(used)} used of ${escapeHtml(limit)} · ${escapeHtml(free)} free · one video up to ${escapeHtml(formatBytes(account.maxVideoBytes))}, one picture up to ${escapeHtml(formatBytes(account.maxImageBytes))}</p>`;
}

function renderMediaField(editor, spec, offered) {
  const field = editor.media[spec.slot];
  const url = String(editor.data[spec.urlKey] || "").trim();
  const upload = (label, action, extra = "") => `<button class="plain-button compact-button" type="button" data-action="${action}" data-slot="${spec.slot}" ${extra}>${label}</button>`;
  const link = (label = "Use a link") => `<button class="text-action" type="button" data-action="exercise-media-link" data-slot="${spec.slot}">${label}</button>`;
  const remove = (label = "Remove") => `<button class="text-action" type="button" data-action="exercise-media-remove" data-slot="${spec.slot}">${label}</button>`;
  const picker = offered ? `<input type="file" accept="${escapeAttr(UPLOAD_SLOTS[spec.slot].accept)}" data-exercise-media-file="${spec.slot}" aria-label="Choose a ${spec.noun} file">` : "";
  const linkInput = `<label class="search-field"><span>${spec.label} URL</span><input class="builder-text-input" type="url" data-exercise-editor-field="${spec.urlKey}" value="${escapeAttr(url)}" placeholder="Google Drive, YouTube or direct link"></label>`;
  // No storage offered (the flag off, another workspace, a new exercise, a
  // copy) and no stored file: the plain link field, exactly as before.
  if (!offered && field.state !== "stored") {
    return `
    <section class="exercise-media-field" data-exercise-media-slot="${spec.slot}" aria-label="${spec.label}">
      ${linkInput}
    </section>
  `;
  }
  let body = "";
  switch (field.state) {
    case "uploading":
      body = `
        ${renderFileLine(field)}
        <progress class="exercise-media-progress" max="100" value="${percentOf(field.progress)}" data-exercise-media-progress="${spec.slot}" aria-label="Upload progress"></progress>
        <p class="muted exercise-media-status" role="status" data-exercise-media-progress-text="${spec.slot}">${escapeHtml(progressText(field))}</p>
        <div class="exercise-media-actions">${upload("Cancel", "exercise-media-cancel")}</div>`;
      break;
    case "uploaded":
      body = `
        ${renderFileLine(field)}
        <p class="muted exercise-media-status" role="status">Uploaded. It is saved with the exercise.</p>
        ${field.previewOpen ? renderLocalPreview(field, spec) : ""}
        <div class="exercise-media-actions">${field.previewUrl ? upload(field.previewOpen ? "Hide preview" : "Preview", "exercise-media-preview-local") : ""}${upload("Replace...", "exercise-media-pick")}${remove()}</div>`;
      break;
    case "failed":
    case "cancelled":
      body = `
        ${field.fileName ? renderFileLine(field) : ""}
        <p class="${field.state === "failed" ? "builder-error" : "muted"} exercise-media-status" role="alert">${escapeHtml(field.error?.message || "")}</p>
        <div class="exercise-media-actions">
          ${field.file && field.state === "failed" && field.error?.code !== "upload_contract_pending" ? upload("Retry", "exercise-media-retry") : ""}
          ${offered ? upload(field.state === "cancelled" ? "Upload again" : "Choose another file", "exercise-media-pick") : ""}
          ${link()}${remove("Clear")}
        </div>`;
      break;
    case "stored": {
      const media = exerciseMediaOf({ media: { video: spec.slot === "video" ? { source: "asset", mediaId: field.mediaId } : { source: "none" }, image: spec.slot === "image" ? { source: "asset", mediaId: field.mediaId } : { source: "none" }, accessContext: { type: "exercise", id: editor.exerciseId } } });
      body = `
        <p class="exercise-media-status">${spec.label} file, stored with this exercise.</p>
        <details class="exercise-media-technical"><summary>Technical details</summary><code>media ${escapeHtml(field.mediaId)}</code></details>
        <div class="exercise-media-actions">
          <button class="plain-button compact-button" type="button" data-action="open-media" data-title="${escapeAttr(editor.data.name || "Exercise media")}" ${mediaAccessAttributes(media)}>Preview</button>
          ${offered ? upload("Replace...", "exercise-media-pick") : ""}${remove()}
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
            ${field.linkOpen ? "" : link("Edit link")}${offered ? upload("Replace with a file...", "exercise-media-pick") : ""}${remove()}
          </div>`;
      } else {
        body = `
          ${offered && !field.linkOpen ? `<p class="muted exercise-media-status">No ${spec.noun} yet.</p>` : ""}
          ${offered && !field.linkOpen ? `<div class="exercise-media-actions">${upload(`Upload ${spec.noun}...`, "exercise-media-pick")}${link()}</div>` : linkInput}`;
      }
  }
  return `
    <section class="exercise-media-field" data-exercise-media-slot="${spec.slot}" aria-label="${spec.label}">
      <p class="eyebrow">${spec.label}</p>
      ${body}
      ${picker}
    </section>
  `;
}

function renderFileLine(field) {
  return `<p class="exercise-media-file"><span class="exercise-media-file-name" title="${escapeAttr(field.fileName)}">${escapeHtml(field.fileName)}</span><span class="muted">${escapeHtml(formatBytes(field.fileSize))}</span></p>`;
}

function progressText(field) {
  const sent = Number(field.progress?.sent) || 0;
  const total = Number(field.progress?.total) || field.fileSize || 0;
  return `${percentOf({ sent, total })} % · ${formatBytes(sent)} of ${formatBytes(total)}`;
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
  state.exerciseEditor = { ...emptyExerciseEditor(), open: true, isNew: !exerciseId, isCopy: copy, exerciseId: exerciseId || "" };
  const editor = state.exerciseEditor;
  // Storage is read only where an upload could be offered: an existing
  // exercise that is edited, not a new one or a copy (links only there).
  if (exerciseId && !copy) void loadExerciseMediaStorage(state, handlers);
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
      // copy starts without it, like the links.
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
    const data = await readStorageUsage();
    if (state.exerciseEditor !== editor) return;
    Object.assign(storage, { loading: false, data, disabled: false, unavailable: false });
  } catch (error) {
    if (state.exerciseEditor !== editor) return;
    Object.assign(storage, {
      loading: false,
      data: null,
      disabled: error?.code === "media_storage_disabled",
      unavailable: error?.code === "operation_not_allowed",
      error: error?.code === "media_storage_disabled" || error?.code === "operation_not_allowed" ? "" : "unreadable",
    });
  }
  handlers.rerender();
}

// Closing with an upload in flight asks first (the browser's own confirm);
// "yes" cancels the upload. Returns true when the editor closed.
export function closeExerciseEditor(state, handlers) {
  const editor = state.exerciseEditor;
  if (uploadInFlight(editor)) {
    const ask = typeof globalThis.confirm === "function" ? globalThis.confirm : () => true;
    if (!ask("An upload is still running. Close the editor and cancel it?")) return false;
    for (const { slot } of MEDIA_SLOTS) editor.media[slot].controller?.abort();
  }
  releaseMediaPreviews(editor);
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
  event.returnValue = "An upload is still running.";
  return true;
}

export function handleExerciseEditorInput(state, event) {
  const field = event.target.closest("[data-exercise-editor-field]");
  if (field) {
    state.exerciseEditor.data[field.dataset.exerciseEditorField] = field.value;
    return true;
  }
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

export async function chooseExerciseMediaFile(state, handlers, slot, file) {
  const editor = state.exerciseEditor;
  const field = editor.media[slot];
  if (!uploadsOffered(editor) || field.state === "uploading") return;
  if (field.state === "stored") field.previous = { state: "stored", mediaId: field.mediaId };
  releaseFieldPreview(field);
  Object.assign(field, { file, fileName: file.name || "file", fileSize: Number(file.size) || 0, mimeType: file.type || "", error: null, previewOpen: false, mediaId: "", uploadId: "", linkOpen: false });
  const account = chargedAccount(editor.media.storage.data?.accounts);
  const check = validateFile(file, slot, editor.media.storage.data ? account : null);
  if (!check.ok) {
    // A file the limits refuse would be refused again: no Retry, another file.
    Object.assign(field, { state: "failed", error: { code: check.code, message: describeUploadError(check.code, { slot, file, account }) }, file: null });
    handlers.rerender();
    return;
  }
  await uploadExerciseMedia(state, handlers, slot);
}

async function uploadExerciseMedia(state, handlers, slot) {
  const editor = state.exerciseEditor;
  const field = editor.media[slot];
  const file = field.file;
  if (!file) return;
  const controller = new AbortController();
  Object.assign(field, { state: "uploading", controller, progress: { sent: 0, total: Number(file.size) || 0 }, error: null });
  handlers.rerender();
  const live = () => state.exerciseEditor === editor && field.controller === controller;
  const transport = handlers.upload || startUpload;
  try {
    const result = await transport(
      { file, slot, context: { type: "exercise", id: editor.exerciseId } },
      {
        signal: controller.signal,
        onProgress: (progress) => {
          if (!live()) return;
          field.progress = { sent: Number(progress?.sent) || 0, total: Number(progress?.total) || Number(file.size) || 0 };
          patchUploadProgress(slot, field);
        },
      },
    );
    if (!live()) return;
    Object.assign(field, {
      state: "uploaded", mediaId: String(result?.mediaId || ""), uploadId: String(result?.uploadId || ""), progress: { sent: field.progress.total, total: field.progress.total },
      previewUrl: typeof globalThis.URL?.createObjectURL === "function" ? safeObjectUrl(file) : "", previous: null,
    });
    // An uploaded file replaces the link of the same slot.
    editor.data[MEDIA_SLOTS.find((spec) => spec.slot === slot).urlKey] = "";
  } catch (error) {
    if (!live()) return;
    const cancelled = controller.signal.aborted;
    const code = cancelled ? "cancelled" : error?.code || "upload_failed";
    Object.assign(field, { state: cancelled ? "cancelled" : "failed", error: { code, message: describeUploadError(code, { slot, file, account: chargedAccount(editor.media.storage.data?.accounts) }) } });
    if (cancelled && field.previous) {
      // A Replace that was cancelled keeps what the exercise had.
      Object.assign(field, { state: field.previous.state, mediaId: field.previous.mediaId, file: null, fileName: "", fileSize: 0, error: null, previous: null });
    }
  } finally {
    if (field.controller === controller) field.controller = null;
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
  const bar = doc.querySelector(`[data-exercise-media-progress="${slot}"]`);
  if (bar) bar.value = percentOf(field.progress);
  const text = doc.querySelector(`[data-exercise-media-progress-text="${slot}"]`);
  if (text) text.textContent = progressText(field);
  const save = doc.querySelector('[data-action="exercise-editor-save"]');
  if (save) save.textContent = `Uploading... ${percentOf(field.progress)}%`;
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
    if (!uploadsOffered(editor) || field.state === "uploading") return true;
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
    field.controller?.abort();
    return true;
  }
  if (type === "exercise-media-retry") {
    if (field.state === "failed" && field.file) void uploadExerciseMedia(state, handlers, slot);
    return true;
  }
  if (type === "exercise-media-preview-local") {
    field.previewOpen = !field.previewOpen;
    handlers.rerender();
    return true;
  }
  if (type === "exercise-media-remove") {
    if (field.state === "uploading") return true;
    // A stored asset removed here is dropped from the exercise on Save
    // (the field BE-2 names); the link of the same slot is cleared at once.
    const removedMediaId = field.state === "stored" ? field.mediaId : field.previous?.state === "stored" ? field.previous.mediaId : field.removedMediaId;
    releaseFieldPreview(field);
    editor.media[slot] = { ...emptyMediaField(), removedMediaId: removedMediaId || "" };
    editor.data[spec.urlKey] = "";
    handlers.rerender();
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
    editor.loading = true;
    editor.error = "";
    handlers.rerender();
    try {
      const payload = { ...editor.data, ...mediaSavePayload(editor.media) };
      delete payload.tags;
      if (editor.isCopy) {
        await api(`/api/exercises/${encodeURIComponent(editor.exerciseId)}/copy`, { method: "POST", body: JSON.stringify(payload) });
      } else if (editor.isNew) {
        await api("/api/exercises", { method: "POST", body: JSON.stringify(payload) });
      } else {
        await api(`/api/exercises/${encodeURIComponent(editor.exerciseId)}`, { method: "PATCH", body: JSON.stringify(payload) });
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
