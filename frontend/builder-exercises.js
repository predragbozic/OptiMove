import { renderImage } from "./media.js";
import { escapeAttr, escapeHtml } from "./utils.js";

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

export function renderBuilderExerciseResult(exercise, markedExerciseIds) {
  const image = exercise.image_url || "";
  const video = exercise.video_url || "";
  const title = exercise.name || "Exercise";
  const marked = markedExerciseIds.has(exercise.id);
  const tags = exercise.tags || [];
  return `
    <article class="builder-exercise-result">
      ${image || video
        ? `<button type="button" class="builder-exercise-preview" data-action="open-media" data-title="${escapeAttr(title)}" data-image="${escapeAttr(image)}" data-video="${escapeAttr(video)}" aria-label="Preview ${escapeAttr(title)}">${image ? renderImage(image, "builder-exercise-thumb") : `<span class="builder-exercise-thumb builder-exercise-thumb-fallback">Video</span>`}</button>`
        : `<span class="builder-exercise-preview builder-exercise-preview-empty"><span class="node-dot"></span></span>`}
      <span class="builder-exercise-result-text"><strong>${escapeHtml(title)}</strong><small>${video ? "Preview or add" : "Add to section"}</small><span class="builder-exercise-mini-actions"><button type="button" class="text-action" data-action="exercise-toggle-favorite" data-exercise-id="${escapeAttr(exercise.id)}" data-favorite="${exercise.is_favorite ? "true" : "false"}">${exercise.is_favorite ? "Fav" : "Favorite"}</button><button type="button" class="text-action" data-action="exercise-toggle-mark" data-exercise-id="${escapeAttr(exercise.id)}">${marked ? "Marked" : "Mark"}</button><button type="button" class="text-action" data-action="exercise-tags" data-exercise-id="${escapeAttr(exercise.id)}" data-exercise-name="${escapeAttr(title)}">Tags${tags.length ? ` (${tags.length})` : ""}</button></span></span>
      <button type="button" class="plain-button builder-exercise-add" data-action="builder-pick-exercise" data-exercise-id="${escapeAttr(exercise.id)}">Add</button>
    </article>
  `;
}

export function renderBuilderItems(node) {
  if (!node.items.length) return "";
  return `<div class="builder-items">${node.items.map((item, index) => `
    <form class="builder-item" data-builder-form="update-item" data-builder-autosave data-item-id="${escapeAttr(item.id)}">
      <div class="builder-item-head">
        ${item.imageUrl || item.videoUrl ? `<button type="button" class="builder-added-exercise-media" data-action="open-media" data-title="${escapeAttr(item.title || "Exercise media")}" data-image="${escapeAttr(item.imageUrl || "")}" data-video="${escapeAttr(item.videoUrl || "")}">${item.imageUrl ? renderImage(item.imageUrl, "builder-added-exercise-image") : `<span class="builder-added-exercise-fallback">Video</span>`}</button>` : `<span class="builder-added-exercise-fallback">Exercise</span>`}
        <div><strong>${escapeHtml(item.title || "Exercise")}</strong><div class="builder-item-actions"><button class="text-action" type="button" data-action="builder-move-item" data-item-id="${escapeAttr(item.id)}" data-direction="up" ${index === 0 ? "disabled" : ""}>Move up</button><button class="text-action" type="button" data-action="builder-move-item" data-item-id="${escapeAttr(item.id)}" data-direction="down" ${index === node.items.length - 1 ? "disabled" : ""}>Move down</button><button class="text-action danger-action" type="button" data-action="builder-delete-item" data-item-id="${escapeAttr(item.id)}">Remove</button></div></div>
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
