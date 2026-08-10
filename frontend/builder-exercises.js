import { renderImage } from "./media.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const ICON_ARROW_UP = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"></path></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"></path></svg>`;
const ICON_STAR = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.9z"></path></svg>`;
const ICON_BOOKMARK = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1z"></path></svg>`;
const ICON_CHEVRON_LEFT = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg>`;
const ICON_CHEVRON_RIGHT = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M9 5l7 7-7 7"></path></svg>`;
const ICON_BACK = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"></path></svg>`;

export function renderCustomExerciseModal(section, dose = {}) {
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-close-custom-exercise" aria-label="Close custom exercise"></button>
      <section class="panel builder-compact-modal builder-custom-exercise-modal" role="dialog" aria-modal="true" aria-label="Add custom exercise">
        <div class="builder-modal-head"><div><p class="eyebrow">${escapeHtml(section.name)}</p><h3>Add custom exercise</h3><p class="muted">This creates a private exercise in your library and adds it to this Exercise section.</p></div><button class="plain-button icon-button" type="button" data-action="builder-close-custom-exercise" aria-label="Close"><span class="button-icon">x</span></button></div>
        <form class="builder-custom-exercise-form" data-builder-form="add-custom-exercise" data-node-id="${escapeAttr(section.id)}">
          <label class="search-field"><span>Exercise name</span><input name="name" required placeholder="e.g. Tempo running - custom"></label>
          <label class="search-field"><span>Instruction</span><textarea name="instruction" rows="3" placeholder="Coaching instruction"></textarea></label>
          <div class="builder-dose-inputs"><label><span>Sets</span><input name="sets" placeholder="3" value="${escapeAttr(dose.sets || "")}"></label><label><span>Reps</span><input name="reps" placeholder="8" value="${escapeAttr(dose.reps || "")}"></label><label><span>Load</span><input name="load" placeholder="Optional" value="${escapeAttr(dose.load || "")}"></label></div>
          <label class="search-field"><span>Image URL</span><input name="imageUrl" type="url" placeholder="https://..."></label>
          <label class="search-field"><span>Video URL</span><input name="videoUrl" type="url" placeholder="https://..."></label>
          <p class="builder-upload-note">File upload will be added when Supabase Storage is connected.</p>
          <p class="builder-error" aria-live="polite"></p>
          <button class="plain-button" type="submit">Add custom exercise</button>
        </form>
      </section>
    </div>
  `;
}

// Counts how many items in this section already reference a given library
// exercise id - drives the "Added N×" badge (requirement: duplicates are a
// real, supported feature, never deduped/disabled, just visibly counted).
export function builderAddedCounts(node) {
  const counts = new Map();
  for (const item of node?.items || []) {
    if (!item.exerciseId) continue;
    counts.set(item.exerciseId, (counts.get(item.exerciseId) || 0) + 1);
  }
  return counts;
}

export function renderBuilderExerciseResult(exercise, markedExerciseIds, addedCount = 0) {
  const image = exercise.image_url || "";
  const video = exercise.video_url || "";
  const title = exercise.name || "Exercise";
  const marked = markedExerciseIds.has(exercise.id);
  const tags = exercise.tags || [];
  return `
    <article class="builder-exercise-result ${addedCount ? "is-already-added" : ""}">
      ${image || video
        ? `<button type="button" class="builder-exercise-preview" data-action="open-media" data-title="${escapeAttr(title)}" data-image="${escapeAttr(image)}" data-video="${escapeAttr(video)}" aria-label="Preview ${escapeAttr(title)}">${image ? renderImage(image, "builder-exercise-thumb") : `<span class="builder-exercise-thumb builder-exercise-thumb-fallback">Video</span>`}</button>`
        : `<span class="builder-exercise-preview builder-exercise-preview-empty"><span class="node-dot"></span></span>`}
      <span class="builder-exercise-result-text">
        <strong>${escapeHtml(title)}</strong>
        <small>${addedCount ? `Added ${addedCount}×` : (video ? "Preview or add" : "Add to section")}</small>
        <span class="builder-exercise-mini-actions"><button type="button" class="plain-button builder-icon-action builder-mini-toggle ${exercise.is_favorite ? "is-favorite" : ""}" data-action="exercise-toggle-favorite" data-exercise-id="${escapeAttr(exercise.id)}" data-favorite="${exercise.is_favorite ? "true" : "false"}" aria-label="${exercise.is_favorite ? "Remove favorite" : "Mark as favorite"}" title="Favorite">${ICON_STAR}</button><button type="button" class="plain-button builder-icon-action builder-mini-toggle ${marked ? "is-marked" : ""}" data-action="exercise-toggle-mark" data-exercise-id="${escapeAttr(exercise.id)}" aria-label="${marked ? "Unmark" : "Mark"}" title="Marked">${ICON_BOOKMARK}</button><button type="button" class="text-action" data-action="exercise-tags" data-exercise-id="${escapeAttr(exercise.id)}" data-exercise-name="${escapeAttr(title)}">Tags${tags.length ? ` (${tags.length})` : ""}</button></span>
      </span>
      <button type="button" class="plain-button builder-exercise-add" data-action="builder-pick-exercise" data-exercise-id="${escapeAttr(exercise.id)}">${addedCount ? "Add again" : "Add"}</button>
    </article>
  `;
}

// Patches only the results list (a sibling of the search input inside
// .builder-section-library, never the input itself) - safe to call after
// every add without touching search focus/scroll. See builder-actions.js's
// builder-pick-exercise handler and builder-view.js's
// renderBuilderAddFeedback, which call this alongside the sticky-bar and
// confirmation-banner patches.
export function renderBuilderExerciseResults(exercises, markedExerciseIds, node) {
  const addedCounts = builderAddedCounts(node);
  return exercises.map((exercise) => renderBuilderExerciseResult(exercise, markedExerciseIds, addedCounts.get(exercise.id) || 0)).join("") || `<div class="empty">No matching exercises.</div>`;
}

function renderAddedThumb(item, className) {
  if (item.imageUrl || item.videoUrl) {
    return `<button type="button" class="${className}" data-action="open-media" data-title="${escapeAttr(item.title || "Exercise media")}" data-image="${escapeAttr(item.imageUrl || "")}" data-video="${escapeAttr(item.videoUrl || "")}">${item.imageUrl ? renderImage(item.imageUrl, `${className}-image`) : `<span class="${className}-fallback">Video</span>`}</button>`;
  }
  return `<span class="${className}-fallback">${escapeHtml((item.title || "Exercise").slice(0, 1).toUpperCase())}</span>`;
}

function doseSummary(item) {
  const parts = [];
  if (item.sets) parts.push(`${escapeHtml(String(item.sets))} sets`);
  if (item.reps) parts.push(`${escapeHtml(String(item.reps))} reps`);
  if (item.load) parts.push(escapeHtml(String(item.load)));
  return parts.length ? parts.join(" &middot; ") : "No dose set yet";
}

// Desktop-only "Added to section" list: the original full-form-per-item
// layout is left completely unchanged so desktop behavior/appearance never
// moves (see the ≤560px CSS gate on .builder-added-list-compact/
// .builder-added-list-desktop in styles.css).
export function renderBuilderItems(node) {
  if (!node.items.length) return "";
  return `<div class="builder-items builder-added-list-desktop">${node.items.map((item, index) => `
    <form class="builder-item" data-builder-form="update-item" data-builder-autosave data-item-id="${escapeAttr(item.id)}">
      <div class="builder-item-head">
        ${item.imageUrl || item.videoUrl ? `<button type="button" class="builder-added-exercise-media" data-action="open-media" data-title="${escapeAttr(item.title || "Exercise media")}" data-image="${escapeAttr(item.imageUrl || "")}" data-video="${escapeAttr(item.videoUrl || "")}">${item.imageUrl ? renderImage(item.imageUrl, "builder-added-exercise-image") : `<span class="builder-added-exercise-fallback">Video</span>`}</button>` : `<span class="builder-added-exercise-fallback">Exercise</span>`}
        <div><strong>${escapeHtml(item.title || "Exercise")}</strong><div class="builder-item-actions"><button class="plain-button builder-icon-action builder-item-move-up" type="button" data-action="builder-move-item" data-item-id="${escapeAttr(item.id)}" data-direction="up" aria-label="Move up" title="Move up" ${index === 0 ? "disabled" : ""}>${ICON_ARROW_UP}</button><button class="plain-button builder-icon-action builder-item-move-down" type="button" data-action="builder-move-item" data-item-id="${escapeAttr(item.id)}" data-direction="down" aria-label="Move down" title="Move down" ${index === node.items.length - 1 ? "disabled" : ""}>${ICON_ARROW_UP}</button><button class="plain-button builder-icon-action builder-delete-icon" type="button" data-action="builder-delete-item" data-item-id="${escapeAttr(item.id)}" aria-label="Remove" title="Remove">${ICON_TRASH}</button></div></div>
      </div>
      <div class="builder-dose-inputs builder-item-dose">
        <label><span>Sets</span><input name="sets" value="${escapeAttr(item.sets || "")}"></label>
        <label><span>Reps</span><input name="reps" value="${escapeAttr(item.reps || "")}"></label>
        <label><span>Load</span><input name="load" value="${escapeAttr(item.load || "")}"></label>
      </div>
      <label class="search-field"><span>Instruction</span><textarea name="description" rows="2">${escapeHtml(item.description || "")}</textarea></label>
      <small class="builder-autosave-hint">Changes save automatically.</small>
    </form>
  `).join("")}</div>`;
}

// Mobile-only compact closed card - index, thumb, 2-line title, dose
// summary, reorder/remove, and an "Edit details" button that opens the
// single-item view below instead of showing every field inline.
function renderBuilderAddedCard(item, index, total) {
  return `
    <article class="builder-added-card" data-item-id="${escapeAttr(item.id)}">
      <span class="builder-added-card-index">${index + 1}</span>
      ${renderAddedThumb(item, "builder-added-card-media")}
      <div class="builder-added-card-body">
        <strong class="builder-added-card-title">${escapeHtml(item.title || "Exercise")}</strong>
        <small class="builder-added-card-dose">${doseSummary(item)}</small>
      </div>
      <div class="builder-added-card-actions">
        <button class="plain-button builder-icon-action builder-item-move-up" type="button" data-action="builder-move-item" data-item-id="${escapeAttr(item.id)}" data-direction="up" aria-label="Move up" title="Move up" ${index === 0 ? "disabled" : ""}>${ICON_ARROW_UP}</button>
        <button class="plain-button builder-icon-action builder-item-move-down" type="button" data-action="builder-move-item" data-item-id="${escapeAttr(item.id)}" data-direction="down" aria-label="Move down" title="Move down" ${index === total - 1 ? "disabled" : ""}>${ICON_ARROW_UP}</button>
        <button class="plain-button builder-icon-action builder-delete-icon" type="button" data-action="builder-delete-item" data-item-id="${escapeAttr(item.id)}" aria-label="Remove" title="Remove">${ICON_TRASH}</button>
        <button class="text-action builder-added-card-edit" type="button" data-action="builder-open-edit-item" data-item-id="${escapeAttr(item.id)}">Edit details</button>
      </div>
    </article>
  `;
}

export function renderBuilderAddedList(node) {
  if (!node.items.length) return "";
  return `<div class="builder-added-list-compact">${node.items.map((item, index) => renderBuilderAddedCard(item, index, node.items.length)).join("")}</div>`;
}

// Single-item edit view (mobile "Added exercises" mode, opened via "Edit
// details" or Edit now from the add-confirmation banner). Only this one
// item's Sets/Reps/Load/Instruction are shown - Instruction starts
// collapsed (editItemInstructionOpen resets to false on every open/nav) so
// a card never has to show a full textarea by default. Previous/Next lets
// the coach work through every added item without returning to the list.
export function renderBuilderItemEdit(node, itemId, instructionOpen) {
  const index = node.items.findIndex((candidate) => candidate.id === itemId);
  if (index === -1) return "";
  const item = node.items[index];
  return `
    <div class="builder-item-edit">
      <div class="builder-item-edit-head">
        <button class="plain-button icon-button" type="button" data-action="builder-close-edit-item" aria-label="Back to Added exercises" title="Back to Added exercises">${ICON_BACK}</button>
        <span class="builder-item-edit-position">${index + 1} of ${node.items.length}</span>
        <div class="builder-item-edit-nav">
          <button class="plain-button icon-button" type="button" data-action="builder-edit-item-nav" data-direction="prev" aria-label="Previous exercise" title="Previous" ${index === 0 ? "disabled" : ""}>${ICON_CHEVRON_LEFT}</button>
          <button class="plain-button icon-button" type="button" data-action="builder-edit-item-nav" data-direction="next" aria-label="Next exercise" title="Next" ${index === node.items.length - 1 ? "disabled" : ""}>${ICON_CHEVRON_RIGHT}</button>
        </div>
      </div>
      <form class="builder-item builder-item-edit-form" data-builder-form="update-item" data-builder-autosave data-item-id="${escapeAttr(item.id)}">
        <div class="builder-item-head">
          ${renderAddedThumb(item, "builder-added-exercise-media")}
          <div><strong>${escapeHtml(item.title || "Exercise")}</strong></div>
        </div>
        <div class="builder-dose-inputs builder-item-dose">
          <label><span>Sets</span><input name="sets" value="${escapeAttr(item.sets || "")}"></label>
          <label><span>Reps</span><input name="reps" value="${escapeAttr(item.reps || "")}"></label>
          <label><span>Load</span><input name="load" value="${escapeAttr(item.load || "")}"></label>
        </div>
        <div class="builder-item-instruction">
          <button class="text-action builder-item-instruction-toggle" type="button" data-action="builder-toggle-item-instruction" aria-expanded="${instructionOpen ? "true" : "false"}">Instruction ${instructionOpen ? "&#9652;" : "&#9662;"}</button>
          ${instructionOpen ? `<label class="search-field"><span class="visually-hidden">Instruction</span><textarea name="description" rows="3">${escapeHtml(item.description || "")}</textarea></label>` : (item.description ? `<p class="builder-item-instruction-preview muted">${escapeHtml(item.description)}</p>` : "")}
        </div>
        <small class="builder-autosave-hint">Changes save automatically.</small>
      </form>
    </div>
  `;
}

// Sticky bottom bar (mobile only) - always shows the running count, up to
// four thumbnails of the most recently added items (+N if more), a jump-to-
// list Edit action, and an always-reachable Done. Thumbnails never enter
// the edit form - tapping one just previews that exercise's media.
const STICKY_BAR_THUMB_LIMIT = 4;

export function renderBuilderStickyBar(node) {
  const items = node?.items || [];
  const count = items.length;
  const recent = items.slice(-STICKY_BAR_THUMB_LIMIT).reverse();
  const overflow = Math.max(0, count - STICKY_BAR_THUMB_LIMIT);
  return `
    <div class="builder-mobile-sticky-bar">
      <button class="builder-sticky-bar-summary" type="button" data-action="builder-set-mobile-mode" data-mode="added">
        <span class="builder-sticky-bar-thumbs">
          ${recent.map((item) => `<span class="builder-sticky-thumb" data-action="open-media" data-title="${escapeAttr(item.title || "Exercise media")}" data-image="${escapeAttr(item.imageUrl || "")}" data-video="${escapeAttr(item.videoUrl || "")}" role="button" tabindex="0" aria-label="Preview ${escapeAttr(item.title || "exercise")}">${item.imageUrl ? renderImage(item.imageUrl, "builder-sticky-thumb-image") : `<span class="builder-sticky-thumb-fallback">${escapeHtml((item.title || "Exercise").slice(0, 1).toUpperCase())}</span>`}</span>`).join("")}
          ${overflow ? `<span class="builder-sticky-thumb-overflow">+${overflow}</span>` : ""}
        </span>
        <span class="builder-sticky-bar-label">Added exercises (${count})</span>
      </button>
      <div class="builder-sticky-bar-actions">
        <button class="text-action" type="button" data-action="builder-set-mobile-mode" data-mode="added">Edit</button>
        <button class="plain-button builder-sticky-bar-done" type="button" data-action="builder-finish-section">Done</button>
      </div>
    </div>
  `;
}

// Inline, small "<title> added" confirmation with an Edit now shortcut -
// deliberately not a global toast (requirement: never covers the results
// list). Lives inside the Add-exercises mode, above the results, and is
// cleared by the caller (builder-actions.js) a few seconds after showing,
// or immediately on the next add/mode switch.
export function renderBuilderAddConfirmation(confirmation) {
  if (!confirmation) return "";
  return `
    <div class="builder-add-confirmation" role="status">
      <span class="builder-add-confirmation-text">${escapeHtml(confirmation.title || "Exercise")} added &#10003;</span>
      <button class="text-action" type="button" data-action="builder-edit-now">Edit now</button>
    </div>
  `;
}
