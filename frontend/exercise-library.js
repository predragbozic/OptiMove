import { renderMediaThumb } from "./media.js";
import { EXERCISE_FILTERS } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export function renderExerciseFilterControls(values, options, mode = "library") {
  const attr = mode.startsWith("builder") ? "data-builder-exercise-filter" : "data-exercise-filter";
  const includeToggles = mode !== "builder-selects";
  return `
    ${EXERCISE_FILTERS.map((filter) => renderExerciseFilterSelect(filter, values[filter.key], options[filter.optionsKey], attr)).join("")}
    ${includeToggles ? renderExerciseFilterToggle("favorite", "Favorites", values.favorite, attr) : ""}
    ${includeToggles ? renderExerciseFilterToggle("marked", "Marked", values.marked, attr) : ""}
  `;
}

export function renderExerciseQuickFilters(values, attr) {
  return `
    <div class="exercise-quick-filters">
      ${renderExerciseFilterToggle("favorite", "Favorites", values.favorite, attr)}
      ${renderExerciseFilterToggle("marked", "Marked", values.marked, attr)}
    </div>
  `;
}

export function activeExerciseFilterLabels(filters) {
  const labels = EXERCISE_FILTERS
    .filter((filter) => filters[filter.key])
    .map((filter) => `${filter.label}: ${filters[filter.key]}`);
  if (filters.favorite) labels.push("Favorites");
  if (filters.marked) labels.push("Marked");
  return labels;
}

export function renderExerciseLibraryHtml(data) {
  const { exercises, itemIds, markedExerciseIds, search, tagEditor } = data;
  return `
    <div class="library-results-head">
      <span class="muted">${exercises.length} exercises shown</span>
      ${search.term ? `<span class="item-badge">${escapeHtml(search.term)}</span>` : ""}
      ${activeExerciseFilterLabels(search.filters).map((label) => `<span class="item-badge">${escapeHtml(label)}</span>`).join("")}
    </div>
    <div class="exercise-grid">
      ${exercises.map((exercise, index) => renderExerciseLibraryCard(exercise, itemIds[index], markedExerciseIds)).join("")}
    </div>
    ${search.hasMore ? `
      <div class="load-more-row">
        <button class="plain-button" data-action="exercise-load-more">Load more</button>
      </div>
    ` : ""}
    ${tagEditor.open ? renderExerciseTagModal(tagEditor) : ""}
  `;
}

function renderExerciseFilterSelect(filter, value, options, attr) {
  if (!options?.length) return "";
  return `
    <label class="search-field exercise-filter-field">
      <span>${escapeHtml(filter.label)}</span>
      <select ${attr}="${escapeAttr(filter.key)}">
        <option value="">All</option>
        ${options.map((option) => `<option value="${escapeAttr(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
      </select>
    </label>
  `;
}

function renderExerciseFilterToggle(key, label, checked, attr) {
  return `
    <label class="exercise-filter-toggle">
      <input type="checkbox" ${attr}="${escapeAttr(key)}" ${checked ? "checked" : ""}>
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}

function renderExerciseLibraryCard(exercise, itemId, markedExerciseIds) {
  const marked = markedExerciseIds.has(exercise.id);
  const tags = exercise.tags || [];
  return `
    <article class="exercise-card">
      ${exercise.image_url ? `
        <button class="exercise-media library-media" data-action="open-media" data-title="${escapeAttr(exercise.name || "Exercise media")}" data-image="${escapeAttr(exercise.image_url)}" data-video="${escapeAttr(exercise.video_url || "")}">
          ${renderMediaThumb(exercise.image_url)}
        </button>
      ` : ""}
      <button class="exercise-open" data-action="open-exercise" data-item-id="${escapeAttr(itemId)}">
        <span class="exercise-head">
          <span class="exercise-title">${escapeHtml(exercise.name || "")}</span>
        </span>
        <span class="muted">${escapeHtml(exercise.aim || "")}</span>
        <span class="item-description">${escapeHtml(exercise.execution_notes || exercise.instruction || "")}</span>
      </button>
      <div class="exercise-card-actions">
        <button class="text-action" type="button" data-action="exercise-toggle-favorite" data-exercise-id="${escapeAttr(exercise.id)}" data-favorite="${exercise.is_favorite ? "true" : "false"}">${exercise.is_favorite ? "Unfavorite" : "Favorite"}</button>
        <button class="text-action" type="button" data-action="exercise-toggle-mark" data-exercise-id="${escapeAttr(exercise.id)}">${marked ? "Unmark" : "Mark"}</button>
        <button class="text-action" type="button" data-action="exercise-tags" data-exercise-id="${escapeAttr(exercise.id)}" data-exercise-name="${escapeAttr(exercise.name || "Exercise")}">Tags${tags.length ? ` (${tags.length})` : ""}</button>
      </div>
      ${tags.length ? `<div class="exercise-tag-list">${tags.slice(0, 4).map((tag) => `<span>${escapeHtml(tag.name)}</span>`).join("")}${tags.length > 4 ? `<span>+${tags.length - 4}</span>` : ""}</div>` : ""}
    </article>
  `;
}

export function renderExerciseTagModal(editor) {
  const assigned = new Set((editor.tags || []).map((tag) => String(tag.id)));
  const available = (editor.options || []).filter((tag) => !assigned.has(String(tag.id)));
  return `
    <div class="exercise-tag-overlay">
      <button class="exercise-tag-backdrop" type="button" data-action="exercise-tags-close" aria-label="Close tags"></button>
      <section class="panel exercise-tag-modal" role="dialog" aria-modal="true" aria-label="Exercise tags">
        <div class="builder-modal-head">
          <div><p class="eyebrow">Exercise tags</p><h3>${escapeHtml(editor.exerciseName)}</h3><p class="muted">Use tags as your own reusable labels for filtering and building programs faster.</p></div>
          <button class="plain-button icon-button" type="button" data-action="exercise-tags-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        <div class="exercise-tag-current">
          ${(editor.tags || []).length
            ? editor.tags.map((tag) => `<span class="exercise-tag-pill">${escapeHtml(tag.name)} <button type="button" data-action="exercise-tag-remove" data-exercise-id="${escapeAttr(editor.exerciseId)}" data-tag-id="${escapeAttr(tag.id)}" aria-label="Remove ${escapeAttr(tag.name)}">x</button></span>`).join("")
            : `<p class="muted">No tags yet.</p>`}
        </div>
        <form class="exercise-tag-form" data-exercise-tag-form>
          <label class="search-field"><span>Add existing tag</span><select name="tagId"><option value="">Choose tag</option>${available.map((tag) => `<option value="${escapeAttr(tag.id)}">${escapeHtml(tag.name)}</option>`).join("")}</select></label>
          <label class="search-field"><span>Or create new tag</span><input name="name" placeholder="e.g. hotel gym, pre-match, knee friendly"></label>
          ${editor.error ? `<p class="builder-error">${escapeHtml(editor.error)}</p>` : ""}
          <button class="plain-button" type="submit">Add tag</button>
        </form>
      </section>
    </div>
  `;
}
