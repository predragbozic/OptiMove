import { normalizeExerciseView, renderExerciseThumb, renderExerciseThumbBackdrop, renderExerciseViewSwitcher } from "./exercise-view-modes.js";
import { imageSources, renderMediaThumb, videoThumbnailSources } from "./media.js";
import { EXERCISE_FILTERS } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export const QUICK_FILTER_KEYS = new Set(["purpose", "tag"]);

const ICON_STAR = `<svg viewBox="0 0 24 24" class="exercise-toggle-icon" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.9z"></path></svg>`;
const ICON_BOOKMARK = `<svg viewBox="0 0 24 24" class="exercise-toggle-icon" aria-hidden="true"><path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1z"></path></svg>`;
const ICON_MORE = `<svg viewBox="0 0 24 24" class="exercise-toggle-icon" aria-hidden="true"><circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle></svg>`;
// Blocks: a package. Manage: a gear (application block administration).
export const ICON_BLOCKS = `<svg viewBox="0 0 24 24" class="exercise-view-icon-svg" aria-hidden="true"><path d="M3.5 7.5 12 3l8.5 4.5L12 12z"></path><path d="M3.5 7.5v9L12 21l8.5-4.5v-9"></path><path d="M12 12v9"></path></svg>`;
export const ICON_SETTINGS = `<svg viewBox="0 0 24 24" class="exercise-view-icon-svg" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

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
  const includeToggles = !mode.endsWith("-selects");
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

export function activeExerciseFilterLabels(filters, options = {}) {
  const labels = EXERCISE_FILTERS
    .filter((filter) => filters[filter.key])
    .map((filter) => `${filter.label}: ${filters[filter.key]}`);
  if (filters.favorite) labels.push("Favorites");
  if (filters.marked) labels.push("Marked");
  const kinds = { system: "System exercises", mine: "My private exercises", private: "Private exercises", all: "All exercises" };
  if (kinds[filters.kind]) labels.push(kinds[filters.kind]);
  if (filters.visibility === "archived") labels.push("Archived");
  if (filters.visibility === "all") labels.push("Active and archived");
  if (filters.hidden === "hidden") labels.push("Hidden");
  if (filters.hidden === "all") labels.push("Including hidden");
  if (filters.searchIn === "all") labels.push("Search: all fields");
  if (filters.collection) labels.push(filters.collection === "other" ? "Block: Other" : "Selected block");
  if (filters.owner) labels.push(`Owner: ${options.owners?.find((owner) => owner.id === filters.owner)?.name || "selected account"}`);
  return labels;
}

// Blocks and the views share one group and one look. Block administration
// (the gear) is only in the Blocks view, never in the library list - also
// not inside a block (owner, 2026-10-17).
function renderExerciseBrowseControls(search, view) {
  return `
    <div class="exercise-browse-controls">
      <button class="exercise-browse-button" type="button" data-action="exercise-blocks-open" aria-label="Exercise blocks" title="Exercise blocks">${ICON_BLOCKS}<span aria-hidden="true">Blocks</span></button>
      ${renderExerciseViewSwitcher("library", view, "exercise-library-view")}
    </div>
  `;
}

// The open block as a filter chip: its x returns to all exercises.
function renderExerciseBlockChip(search) {
  const collection = search.filters?.collection;
  if (!collection) return "";
  const name = collection === "other" ? "Other" : search.collectionName || "Selected block";
  return `<button class="item-badge exercise-block-chip" type="button" data-action="exercise-blocks-clear" aria-label="Leave block ${escapeAttr(name)} and show all exercises" title="Show all exercises">Block: ${escapeHtml(name)}<span aria-hidden="true">×</span></button>`;
}

export function renderExerciseLibraryHtml(data) {
  const { exercises, itemIds, markedExerciseIds, search, tagEditor } = data;
  const view = normalizeExerciseView("library", search.view);
  const { collection, ...otherFilters } = search.filters || {};
  const filterBadges = [
    search.term ? `<span class="item-badge">${escapeHtml(search.term)}</span>` : "",
    renderExerciseBlockChip(search),
    ...activeExerciseFilterLabels(otherFilters, search.options).map((label) => `<span class="item-badge">${escapeHtml(label)}</span>`),
  ].join("");
  return `
    <div class="library-results-head exercise-results-head">
      <span class="muted exercise-results-count">${exercises.length} exercises shown</span>
      ${filterBadges ? `<div class="exercise-results-filters">${filterBadges}</div>` : ""}
      <div class="exercise-results-actions">
        <button class="plain-button compact-button exercise-add-button" type="button" data-action="exercise-add-open">+ Add exercise</button>
        ${renderExerciseBrowseControls(search, view)}
      </div>
    </div>
    ${view === "details" ? `
      <div class="exercise-grid">
        ${exercises.map((exercise, index) => renderExerciseLibraryCard(exercise, itemIds[index], markedExerciseIds, search.canManageCollections)).join("")}
      </div>
    ` : `
      <div class="exercise-view-grid is-${view}">
        ${exercises.map((exercise, index) => renderExerciseViewCard(exercise, itemIds[index], markedExerciseIds, search.canManageCollections, view)).join("")}
      </div>
    `}
    ${search.lockedPreviews?.length ? `<section class="exercise-locked-results"><h3>Locked exercises — name matches</h3><p class="muted">Contact your administrator to request access. Previews cannot be added, copied or played.</p><div class="exercise-block-grid">${search.lockedPreviews.map((exercise) => `<article class="panel exercise-block-card is-locked"><div class="exercise-block-card-body"><span class="exercise-block-lock">🔒 Access required</span><h4>${escapeHtml(exercise.name)}</h4><p>${escapeHtml(exercise.blockName)}</p></div></article>`).join("")}</div></section>` : ""}
    ${search.hasMore || search.moreLockedPreviews ? `
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

function canManageExercise(exercise, platformAdmin) {
  return exercise.owner_scope === "system" ? platformAdmin && exercise.can_edit !== false : exercise.can_edit !== false;
}

function renderExerciseLibraryCard(exercise, itemId, markedExerciseIds, platformAdmin = false) {
  const marked = markedExerciseIds.has(exercise.id);
  const tags = exercise.tags || [];
  return `
    <article class="exercise-card">
      ${exercise.image_url || exercise.video_url ? `
        <button class="exercise-media library-media" data-action="open-media" data-title="${escapeAttr(exercise.name || "Exercise media")}" data-image="${escapeAttr(exercise.image_url)}" data-video="${escapeAttr(exercise.video_url || "")}">
          ${exercise.image_url
            ? `${renderExerciseThumbBackdrop(imageSources(exercise.image_url))}${renderMediaThumb(exercise.image_url)}`
            : videoThumbnailSources(exercise.video_url).length
              ? renderExerciseThumb({ name: exercise.name, video_url: exercise.video_url }, "media-thumb", { backdrop: true })
              : `<span class="media-fallback">Video</span>`}
        </button>
      ` : ""}
      <button class="exercise-open" data-action="open-exercise" data-item-id="${escapeAttr(itemId)}">
        <span class="exercise-head">
          <span class="exercise-title">${escapeHtml(exercise.name || "")}</span>
          ${exercise.owner_scope ? `<span class="item-badge">${exercise.owner_scope === "system" ? "Application" : platformAdmin ? "Private exercise" : "My exercise"}</span>` : ""}
        </span>
        <span class="muted">${escapeHtml(exercise.aim || "")}</span>
        <span class="item-description">${escapeHtml(exercise.execution_notes || exercise.instruction || "")}</span>
      </button>
      <div class="exercise-card-actions">
        <button class="text-action" type="button" data-action="exercise-toggle-favorite" data-exercise-id="${escapeAttr(exercise.id)}" data-favorite="${exercise.is_favorite ? "true" : "false"}">${exercise.is_favorite ? "Unfavorite" : "Favorite"}</button>
        <button class="text-action" type="button" data-action="exercise-toggle-mark" data-exercise-id="${escapeAttr(exercise.id)}">${marked ? "Unmark" : "Mark"}</button>
        <button class="text-action" type="button" data-action="exercise-tags" data-exercise-id="${escapeAttr(exercise.id)}" data-exercise-name="${escapeAttr(exercise.name || "Exercise")}">Tags${tags.length ? ` (${tags.length})` : ""}</button>
        <button class="text-action" type="button" data-action="exercise-classification" data-exercise-id="${escapeAttr(exercise.id)}">My classification</button>
        <button class="text-action" type="button" data-action="exercise-hide" data-exercise-id="${escapeAttr(exercise.id)}" data-hidden="${exercise.is_hidden ? "true" : "false"}">${exercise.is_hidden ? "Unhide" : "Hide"}</button>
        ${exercise.is_active !== false ? `<button class="text-action" type="button" data-action="exercise-copy-open" data-exercise-id="${escapeAttr(exercise.id)}">Copy</button>` : ""}
        ${canManageExercise(exercise, platformAdmin) ? `
          ${exercise.is_active !== false ? `<button class="text-action" type="button" data-action="exercise-edit-open" data-exercise-id="${escapeAttr(exercise.id)}">Edit</button>` : ""}
          <button class="text-action" type="button" data-action="${exercise.is_active === false ? "exercise-restore" : "exercise-archive"}" data-exercise-id="${escapeAttr(exercise.id)}">${exercise.is_active === false ? "Restore" : "Archive"}</button>` : ""}
        ${exercise.owner_scope === "user" && exercise.can_edit === true ? `<button class="text-action" type="button" data-action="exercise-delete" data-exercise-id="${escapeAttr(exercise.id)}">Delete permanently</button>` : ""}
      </div>
      ${tags.length ? `<div class="exercise-tag-list">${tags.slice(0, 4).map((tag) => `<span>${escapeHtml(tag.name)}</span>`).join("")}${tags.length > 4 ? `<span>+${tags.length - 4}</span>` : ""}</div>` : ""}
    </article>
  `;
}

// The Tile, Big and List card: one markup, laid out by the grid's view class
// (styles.css, .exercise-view-grid.is-*). The picture opens the media, the
// name opens the exercise, favorite and mark stay one tap away, and Tags /
// Copy / Edit sit behind "⋯" with the same rules as the Details card.
function renderExerciseViewCard(exercise, itemId, markedExerciseIds, platformAdmin = false, view = "tile") {
  const name = exercise.name || "Exercise";
  const marked = markedExerciseIds.has(exercise.id);
  const favorite = Boolean(exercise.is_favorite);
  const tags = exercise.tags || [];
  // Big shows the whole picture over its blurred copy; Tile and List crop it.
  const thumb = renderExerciseThumb(exercise, "exercise-view-thumb", { backdrop: view === "big" });
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
            <button class="exercise-view-menu-item" type="button" data-action="exercise-classification" data-exercise-id="${escapeAttr(exercise.id)}">My classification</button>
            <button class="exercise-view-menu-item" type="button" data-action="exercise-hide" data-exercise-id="${escapeAttr(exercise.id)}" data-hidden="${exercise.is_hidden ? "true" : "false"}">${exercise.is_hidden ? "Unhide" : "Hide"}</button>
            ${exercise.is_active !== false ? `<button class="exercise-view-menu-item" type="button" data-action="exercise-copy-open" data-exercise-id="${escapeAttr(exercise.id)}">Copy</button>` : ""}
            ${canManageExercise(exercise, platformAdmin) ? `
              ${exercise.is_active !== false ? `<button class="exercise-view-menu-item" type="button" data-action="exercise-edit-open" data-exercise-id="${escapeAttr(exercise.id)}">Edit</button>` : ""}
              <button class="exercise-view-menu-item" type="button" data-action="${exercise.is_active === false ? "exercise-restore" : "exercise-archive"}" data-exercise-id="${escapeAttr(exercise.id)}">${exercise.is_active === false ? "Restore" : "Archive"}</button>` : ""}
            ${exercise.owner_scope === "user" && exercise.can_edit === true ? `<button class="exercise-view-menu-item" type="button" data-action="exercise-delete" data-exercise-id="${escapeAttr(exercise.id)}">Delete permanently</button>` : ""}
          </div>
        </details>
      </div>
    </article>
  `;
}

export function renderExerciseVisibilityFilters(filters, options = {}) {
  const select = (key, label, values) => `<label class="search-field exercise-filter-field"><span>${label}</span><select class="builder-text-input" data-exercise-filter="${key}">
    ${values.map(([value, title]) => `<option value="${escapeAttr(value)}" ${String(filters[key] || "") === value ? "selected" : ""}>${escapeHtml(title)}</option>`).join("")}</select></label>`;
  return `<div class="exercise-visibility-fields">
    ${select("kind", "Exercise type", [["", "System + my exercises"], ["system", "System exercises"], ["mine", "My private exercises"], ...(options.owners ? [["all", "All exercises"], ["private", "All private exercises"]] : [])])}
    ${select("visibility", "Archive status", [["", "Active"], ["archived", "Archived"], ["all", "Active and archived"]])}
    ${select("hidden", "Personal visibility", [["", "Not hidden"], ["hidden", "Hidden"], ["all", "All personal visibility states"]])}
    ${select("searchIn", "Search in", [["", "Name or code"], ["all", "Name, tags and classification"]])}
    ${options.owners ? `<div class="exercise-owner-filter">
      <label class="search-field exercise-filter-field"><span>Find owner</span><input class="builder-text-input" type="search" data-exercise-owner-search placeholder="Search other owners by name or email" autocomplete="off"></label>
      <label class="search-field exercise-filter-field"><span>Owner</span><select class="builder-text-input" data-exercise-filter="owner">${renderExerciseOwnerOptions(options.owners, filters.owner)}</select></label>
      <span class="muted" data-exercise-owner-hint>My account is first. Type at least 2 characters to find other owners.</span></div>` : ""}
  </div>`;
}

export function renderExerciseOwnerOptions(owners, selected = "") {
  return `<option value="" ${!selected ? "selected" : ""}>Any owner in selected type</option>` + owners.map((owner, index) =>
    `<option value="${escapeAttr(owner.id)}" ${owner.id === selected ? "selected" : ""}>${escapeHtml(`${index === 0 ? "My account · " : ""}${owner.name}${owner.email ? ` · ${owner.email}` : ""}`)}</option>`).join("");
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
