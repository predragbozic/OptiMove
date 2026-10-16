import { normalizeExerciseView, renderExerciseThumb, renderExerciseViewSwitcher } from "./exercise-view-modes.js";
import { renderMediaThumb } from "./media.js";
import { EXERCISE_FILTERS } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export const QUICK_FILTER_KEYS = new Set(["purpose", "tag"]);

const ICON_STAR = `<svg viewBox="0 0 24 24" class="exercise-toggle-icon" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.9z"></path></svg>`;
const ICON_BOOKMARK = `<svg viewBox="0 0 24 24" class="exercise-toggle-icon" aria-hidden="true"><path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1z"></path></svg>`;
const ICON_MORE = `<svg viewBox="0 0 24 24" class="exercise-toggle-icon" aria-hidden="true"><circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle></svg>`;

export function filterIconSvg() {
  return `
    <svg class="rail-icon exercise-filter-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h18"></path><circle cx="9" cy="6" r="2.3"></circle>
      <path d="M3 12h18"></path><circle cx="15" cy="12" r="2.3"></circle>
      <path d="M3 18h18"></path><circle cx="8" cy="18" r="2.3"></circle>
    </svg>
  `;
}

export function renderExerciseFilterControls(values, options, mode = "library") {
  const attr = mode.startsWith("builder") ? "data-builder-exercise-filter" : "data-exercise-filter";
  const includeToggles = mode !== "builder-selects";
  return `
    ${EXERCISE_FILTERS.filter((filter) => !QUICK_FILTER_KEYS.has(filter.key)).map((filter) => renderExerciseFilterSelect(filter, values[filter.key], options[filter.optionsKey], attr)).join("")}
    ${includeToggles ? renderExerciseFilterToggle("favorite", "Favorites", values.favorite, attr) : ""}
    ${includeToggles ? renderExerciseFilterToggle("marked", "Marked", values.marked, attr) : ""}
  `;
}

export function renderExerciseQuickFilters(values, options, attr, moreFiltersHtml = "") {
  const quickSelects = EXERCISE_FILTERS.filter((filter) => QUICK_FILTER_KEYS.has(filter.key));
  return `
    <div class="exercise-quick-filters">
      <div class="exercise-quick-filters-row exercise-quick-filters-row-main">
        ${quickSelects.map((filter) => renderExerciseFilterSelect(filter, values[filter.key], options[filter.optionsKey], attr)).join("")}
        ${renderExerciseFilterToggle("favorite", "Favorites", values.favorite, attr)}
        ${renderExerciseFilterToggle("marked", "Marked", values.marked, attr)}
      </div>
      <div class="exercise-quick-filters-row exercise-quick-filters-row-more">
        ${moreFiltersHtml}
      </div>
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
  const view = normalizeExerciseView("library", search.view);
  return `
    <div class="library-results-head exercise-results-head">
      <span class="muted">${exercises.length} exercises shown</span>
      ${search.term ? `<span class="item-badge">${escapeHtml(search.term)}</span>` : ""}
      ${activeExerciseFilterLabels(search.filters).map((label) => `<span class="item-badge">${escapeHtml(label)}</span>`).join("")}
      <button class="plain-button compact-button" type="button" data-action="exercise-add-open">+ Add exercise</button>
      ${search.canManageCollections ? `<button class="plain-button compact-button" type="button" data-action="exercise-collections-open">Manage application blocks</button>` : ""}
      ${renderExerciseViewSwitcher("library", view, "exercise-library-view")}
    </div>
    ${view === "details" ? `
      <div class="exercise-grid">
        ${exercises.map((exercise, index) => renderExerciseLibraryCard(exercise, itemIds[index], markedExerciseIds, search.canManageCollections)).join("")}
      </div>
    ` : `
      <div class="exercise-view-grid is-${view}">
        ${exercises.map((exercise, index) => renderExerciseViewCard(exercise, itemIds[index], markedExerciseIds, search.canManageCollections)).join("")}
      </div>
    `}
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
  const listId = `exercise-filter-options-${filter.key}`;
  const currentValue = value && options.includes(value) ? value : "";
  return `
    <label class="search-field exercise-filter-field">
      <span>${escapeHtml(filter.label)}</span>
      <input type="search" list="${escapeAttr(listId)}" placeholder="All" autocomplete="off" value="${escapeAttr(currentValue)}" data-exercise-filter-search>
      <input type="hidden" ${attr}="${escapeAttr(filter.key)}" value="${escapeAttr(currentValue)}">
      <datalist id="${escapeAttr(listId)}">
        ${options.map((option) => `<option value="${escapeAttr(option)}"></option>`).join("")}
      </datalist>
    </label>
  `;
}

function renderExerciseFilterToggle(key, label, checked, attr) {
  const icon = key === "favorite" ? ICON_STAR : key === "marked" ? ICON_BOOKMARK : "";
  return `
    <label class="exercise-filter-toggle" title="${escapeAttr(label)}">
      <input type="checkbox" ${attr}="${escapeAttr(key)}" ${checked ? "checked" : ""}>
      ${icon}<span>${escapeHtml(label)}</span>
    </label>
  `;
}

function renderExerciseLibraryCard(exercise, itemId, markedExerciseIds, platformAdmin = false) {
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
          ${exercise.owner_scope ? `<span class="item-badge">${exercise.owner_scope === "system" ? "Application" : "My exercise"}</span>` : ""}
        </span>
        <span class="muted">${escapeHtml(exercise.aim || "")}</span>
        <span class="item-description">${escapeHtml(exercise.execution_notes || exercise.instruction || "")}</span>
      </button>
      <div class="exercise-card-actions">
        <button class="text-action" type="button" data-action="exercise-toggle-favorite" data-exercise-id="${escapeAttr(exercise.id)}" data-favorite="${exercise.is_favorite ? "true" : "false"}">${exercise.is_favorite ? "Unfavorite" : "Favorite"}</button>
        <button class="text-action" type="button" data-action="exercise-toggle-mark" data-exercise-id="${escapeAttr(exercise.id)}">${marked ? "Unmark" : "Mark"}</button>
        <button class="text-action" type="button" data-action="exercise-tags" data-exercise-id="${escapeAttr(exercise.id)}" data-exercise-name="${escapeAttr(exercise.name || "Exercise")}">Tags${tags.length ? ` (${tags.length})` : ""}</button>
        ${exercise.owner_scope === "system" ? `<button class="text-action" type="button" data-action="exercise-copy-open" data-exercise-id="${escapeAttr(exercise.id)}">Copy</button>` : ""}
        ${exercise.owner_scope !== "system" || platformAdmin ? `<button class="text-action" type="button" data-action="exercise-edit-open" data-exercise-id="${escapeAttr(exercise.id)}">Edit</button>` : ""}
      </div>
      ${tags.length ? `<div class="exercise-tag-list">${tags.slice(0, 4).map((tag) => `<span>${escapeHtml(tag.name)}</span>`).join("")}${tags.length > 4 ? `<span>+${tags.length - 4}</span>` : ""}</div>` : ""}
    </article>
  `;
}

// The Tile, Big and List card: one markup, laid out by the grid's view class
// (styles.css, .exercise-view-grid.is-*). The picture opens the media, the
// name opens the exercise, favorite and mark stay one tap away, and Tags /
// Copy / Edit sit behind "⋯" with the same rules as the Details card.
function renderExerciseViewCard(exercise, itemId, markedExerciseIds, platformAdmin = false) {
  const name = exercise.name || "Exercise";
  const marked = markedExerciseIds.has(exercise.id);
  const favorite = Boolean(exercise.is_favorite);
  const tags = exercise.tags || [];
  const thumb = renderExerciseThumb(exercise, "exercise-view-thumb");
  const media = exercise.image_url || exercise.video_url
    ? `<button class="exercise-view-media" type="button" data-action="open-media" data-title="${escapeAttr(name)}" data-image="${escapeAttr(exercise.image_url || "")}" data-video="${escapeAttr(exercise.video_url || "")}" aria-label="Preview ${escapeAttr(name)}">${thumb}</button>`
    : `<span class="exercise-view-media">${thumb}</span>`;
  return `
    <article class="exercise-view-card">
      ${media}
      <button class="exercise-view-open" type="button" data-action="open-exercise" data-item-id="${escapeAttr(itemId)}">
        <span class="exercise-view-title">${escapeHtml(name)}</span>
        ${exercise.aim ? `<span class="exercise-view-meta">${escapeHtml(exercise.aim)}</span>` : ""}
      </button>
      <div class="exercise-view-actions">
        <button class="exercise-view-icon ${favorite ? "is-favorite" : ""}" type="button" data-action="exercise-toggle-favorite" data-exercise-id="${escapeAttr(exercise.id)}" data-favorite="${favorite ? "true" : "false"}" aria-pressed="${favorite ? "true" : "false"}" aria-label="${favorite ? "Remove favorite" : "Mark as favorite"}" title="Favorite">${ICON_STAR}</button>
        <button class="exercise-view-icon ${marked ? "is-marked" : ""}" type="button" data-action="exercise-toggle-mark" data-exercise-id="${escapeAttr(exercise.id)}" aria-pressed="${marked ? "true" : "false"}" aria-label="${marked ? "Unmark" : "Mark"}" title="Marked">${ICON_BOOKMARK}</button>
        <details class="exercise-view-menu">
          <summary class="exercise-view-icon" aria-label="More actions for ${escapeAttr(name)}" title="More actions">${ICON_MORE}</summary>
          <div class="exercise-view-menu-list">
            <button class="exercise-view-menu-item" type="button" data-action="exercise-tags" data-exercise-id="${escapeAttr(exercise.id)}" data-exercise-name="${escapeAttr(name)}">Tags${tags.length ? ` (${tags.length})` : ""}</button>
            ${exercise.owner_scope === "system" ? `<button class="exercise-view-menu-item" type="button" data-action="exercise-copy-open" data-exercise-id="${escapeAttr(exercise.id)}">Copy</button>` : ""}
            ${exercise.owner_scope !== "system" || platformAdmin ? `<button class="exercise-view-menu-item" type="button" data-action="exercise-edit-open" data-exercise-id="${escapeAttr(exercise.id)}">Edit</button>` : ""}
          </div>
        </details>
      </div>
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
            ? editor.tags.map((tag) => `<span class="exercise-tag-pill">${escapeHtml(tag.name)} ${tag.readonly ? `<span class="muted">Application</span>` : `<button type="button" data-action="exercise-tag-remove" data-exercise-id="${escapeAttr(editor.exerciseId)}" data-tag-id="${escapeAttr(tag.id)}" aria-label="Remove ${escapeAttr(tag.name)}">x</button>`}</span>`).join("")
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
