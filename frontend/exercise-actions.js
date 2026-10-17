import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { loadBuilderExercises } from "./builder-data.js";
import { renderBuilder } from "./builder-view.js";
import { els } from "./dom.js";
import { applyClientExerciseFilters, exerciseSearchUrl, loadExerciseFilterOptions, loadMarkedExerciseVisibility } from "./exercise-data.js";
import { normalizeExerciseView, saveExerciseViewPreference } from "./exercise-view-modes.js";
import { EXERCISE_SELECTION_LIMIT, openExerciseBulkMove } from "./exercise-bulk-move.js";
import { filterIconSvg, isSelectableExercise, QUICK_FILTER_KEYS, renderExerciseFilterControls, renderExerciseQuickFilters, renderExerciseSelectionBar, renderExerciseVisibilityFilters, renderExerciseOwnerOptions } from "./exercise-library.js";
import { emptyExerciseFilters, emptyExerciseOptions, EXERCISE_FILTERS, state } from "./state.js";
import { debounce, escapeHtml } from "./utils.js";
import { buildContextKey, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

const EXERCISES_CACHE_NAMESPACE = "exercises";

// Mirrors exactly what exerciseSearchUrl() itself sends to the server - the
// search term, every EXERCISE_FILTERS value, `favorite` (also a real query
// param) and `limit` (this view's only form of pagination - "load more"
// bumps it and, as a different limit, is naturally a fresh fetch, never a
// stale short page). `marked` is deliberately excluded: it's a purely
// client-side filter (see applyClientExerciseFilters) that exerciseSearchUrl
// never sends to the server, so it must never fragment the cache - toggling
// it re-derives instantly from whatever's already cached under the other,
// server-relevant filters.
function exercisesContextKey(term, limit, filters) {
  return buildContextKey([
    ...currentUserWorkspaceContextParts(),
    ...(state.exerciseSearch.surface === "blocks" ? ["surface:blocks"] : []),
    term,
    limit,
    ...EXERCISE_FILTERS.map((filter) => filters[filter.key]),
    filters.favorite,
    ...["kind", "visibility", "hidden", "owner", "searchIn", "collection"].filter((key) => filters[key]).map((key) => `${key}:${filters[key]}`),
  ]);
}

export function invalidateExercisesCache() {
  invalidateCacheNamespace(EXERCISES_CACHE_NAMESPACE);
}

export function resetExercisesForWorkspaceChange() {
  invalidateExercisesCache();
  state.exerciseSearch.options = emptyExerciseOptions();
  state.exerciseSearch.filters = emptyExerciseFilters();
  state.exerciseSearch.canManageCollections = false;
  state.exerciseSearch.hasMore = false;
  state.exerciseSearch.surface = "exercises";
  state.exerciseSearch.lockedPreviews = [];
  state.exerciseSearch.moreLockedPreviews = false;
  state.exerciseSelection = { active: false, ids: new Map(), note: "" };
  state.lastExerciseResults = [];
  state.exerciseEditor.open = false;
  state.tagEditor.open = false;
  state.exerciseDetail = { ids: [], currentId: null };
  state.builder.exercises = [];
  document.querySelectorAll(".exercise-editor-overlay, .exercise-classification-overlay, .exercise-detail-overlay").forEach((element) => element.remove());
}

// The selection's marks and bar, brought up to date in place - no new list,
// so the scroll position stays and focus stays on the control just used.
function refreshExerciseSelectionView() {
  const selection = state.exerciseSelection;
  els.content.querySelectorAll('[data-action="exercise-select-toggle"]').forEach((box) => {
    box.checked = selection.ids.has(box.dataset.exerciseId);
    box.closest("[data-exercise-card]")?.classList.toggle("is-selected", box.checked);
  });
  const bar = els.content.querySelector(".exercise-selection-bar");
  if (!bar) return;
  // The bar's own nodes are kept (its live regions announce the new text);
  // only their text and the buttons' state come from a fresh render.
  const fresh = document.createElement("div");
  fresh.innerHTML = renderExerciseSelectionBar(selection, state.lastExerciseResults || []);
  for (const selector of ["[data-exercise-selection-count]", "[data-exercise-selection-note]"]) {
    bar.querySelector(selector).textContent = fresh.querySelector(selector).textContent;
  }
  const focusWasInBar = bar.contains(document.activeElement);
  bar.querySelectorAll("button[data-action]").forEach((button) => {
    button.disabled = fresh.querySelector(`button[data-action="${button.dataset.action}"]`)?.disabled ?? button.disabled;
  });
  // A button that just turned itself off hands the focus to the count.
  if (focusWasInBar && (!bar.contains(document.activeElement) || document.activeElement.disabled)) bar.querySelector("[data-exercise-selection-count]").focus();
}

function selectionLimitNote() {
  return `At most ${EXERCISE_SELECTION_LIMIT} exercises can be moved at once.`;
}

// The block administrator's selection: Select / Done, a mark per exercise,
// Select all shown, Clear and Move to block…. Returns true when handled.
async function handleExerciseSelectionAction(action, handlers) {
  const type = action.dataset.action;
  const selection = state.exerciseSelection;
  if (type === "exercise-select-mode") {
    // Done leaves the selection behind; Select starts an empty one.
    state.exerciseSelection = { active: !selection.active, ids: new Map(), note: "" };
    handlers.renderExercises(state.lastExerciseResults || []);
    els.content.querySelector(".exercise-select-button")?.focus({ preventScroll: true });
    return true;
  }
  if (type === "exercise-select-toggle") {
    const id = action.dataset.exerciseId;
    selection.note = "";
    if (!action.checked) selection.ids.delete(id);
    else if (selection.ids.size >= EXERCISE_SELECTION_LIMIT) selection.note = selectionLimitNote();
    else selection.ids.set(id, action.dataset.exerciseName || "");
    refreshExerciseSelectionView();
    return true;
  }
  if (type === "exercise-select-all-shown") {
    selection.note = "";
    for (const exercise of (state.lastExerciseResults || []).filter(isSelectableExercise)) {
      if (selection.ids.has(exercise.id)) continue;
      if (selection.ids.size >= EXERCISE_SELECTION_LIMIT) { selection.note = selectionLimitNote(); break; }
      selection.ids.set(exercise.id, exercise.name || "");
    }
    refreshExerciseSelectionView();
    return true;
  }
  if (type === "exercise-select-clear") {
    selection.ids.clear();
    selection.note = "";
    refreshExerciseSelectionView();
    return true;
  }
  if (type === "exercise-bulk-move-open") {
    if (!selection.ids.size) return true;
    openExerciseBulkMove([...selection.ids.keys()], {
      // Saved: the selection is done with, and the list is read again (an
      // exercise moved out of the open block leaves it).
      onMoved: async () => {
        state.exerciseSelection = { active: true, ids: new Map(), note: "" };
        invalidateExercisesCache();
        if (state.activeTab === "exercises" && state.exerciseSearch.surface !== "blocks") {
          await searchExercises(state.exerciseSearch.term, handlers, { forceRefresh: true });
        }
      },
    });
    return true;
  }
  return false;
}

function activeExerciseSelectFilterCount(filters) {
  return EXERCISE_FILTERS.filter((filter) => !QUICK_FILTER_KEYS.has(filter.key) && filters[filter.key]).length
    + ["kind", "visibility", "hidden", "owner", "searchIn"].filter((key) => filters[key]).length;
}

export function bindExerciseOwnerSearch() {
  const input = document.querySelector("[data-exercise-owner-search]");
  if (!input) return;
  const select = document.querySelector('[data-exercise-filter="owner"]');
  const hint = document.querySelector("[data-exercise-owner-hint]");
  input.addEventListener("input", debounce(async () => {
    const search = input.value.trim();
    try {
      const data = await api(`/api/exercises/owners?search=${encodeURIComponent(search)}`);
      if (!input.isConnected || input.value.trim() !== search) return;
      const previous = state.exerciseSearch.options.owners || [];
      const selected = previous.find((owner) => owner.id === select.value);
      const owners = [...data.owners];
      if (selected && !owners.some((owner) => owner.id === selected.id)) owners.push(selected);
      state.exerciseSearch.options.owners = owners;
      select.innerHTML = renderExerciseOwnerOptions(owners, state.exerciseSearch.filters.owner);
      hint.textContent = data.hasMore ? "More owners match. Refine the name or email." : search.length < 2
        ? "My account is first. Type at least 2 characters to find other owners." : "Matching owners; my account stays first.";
    } catch { hint.textContent = "Could not load owners. Try again."; }
  }, 250));
}

export async function loadExercises(handlers) {
  state.exerciseSearch.surface = "exercises";
  state.navStack = [];
  // /api/exercises/options (filter dropdown data) and the initial
  // /api/exercises search never depend on each other - the search query is
  // built purely from state.exerciseSearch.filters (already-selected
  // values), never from the options list - so both start at once instead of
  // the options fetch blocking the exercise list. Options failing is
  // swallowed here (non-critical background refinement, same "silent"
  // treatment other secondary loads get elsewhere in this app) so it can
  // never stop the toolbar/list from rendering with whatever's already in
  // state.exerciseSearch.options.
  const optionsPromise = loadExerciseFilterOptions().catch(() => {});
  const searchPromise = searchExercises("", handlers);
  await optionsPromise;
  const selectFilterCount = activeExerciseSelectFilterCount(state.exerciseSearch.filters);
  els.toolbar.innerHTML = `
    <label class="search-field exercise-search-field">
      <span>Exercise search</span>
      <input id="exerciseSearch" type="search" placeholder="Name or code" value="">
    </label>
    ${renderExerciseQuickFilters(state.exerciseSearch.filters, state.exerciseSearch.options, "data-exercise-filter", `
      <details class="builder-exercise-filters" ${selectFilterCount ? "open" : ""}>
        <summary class="exercise-filter-toggle-icon" aria-label="More filters${selectFilterCount ? ` (${selectFilterCount} active)` : ""}" title="More filters">
          ${filterIconSvg()}${selectFilterCount ? `<span class="filter-count-badge">${selectFilterCount}</span>` : ""}
        </summary>
        <div class="exercise-filter-strip">
          ${renderExerciseVisibilityFilters(state.exerciseSearch.filters, state.exerciseSearch.options)}
          ${renderExerciseFilterControls(state.exerciseSearch.filters, state.exerciseSearch.options, "library-selects")}
        </div>
      </details>
    `)}
  `;
  const input = document.querySelector("#exerciseSearch");
  bindExerciseOwnerSearch();
  input.addEventListener("input", debounce(() => {
    state.exerciseSearch.limit = 30;
    searchExercises(input.value, handlers);
  }, 250));
  document.querySelectorAll("[data-exercise-filter]").forEach((control) => {
    control.addEventListener("change", () => {
      state.exerciseSearch.filters[control.dataset.exerciseFilter] =
        control.type === "checkbox" ? control.checked : control.value;
      if (control.dataset.exerciseFilter === "owner" && control.value) {
        state.exerciseSearch.filters.kind = control.value === state.currentUser?.id ? "mine" : "private";
        const kind = document.querySelector('[data-exercise-filter="kind"]');
        if (kind) kind.value = state.exerciseSearch.filters.kind;
      }
      if (control.dataset.exerciseFilter === "kind" && !["all", "private"].includes(control.value)) {
        state.exerciseSearch.filters.owner = "";
        const owner = document.querySelector('[data-exercise-filter="owner"]');
        if (owner) owner.value = "";
      }
      state.exerciseSearch.limit = 30;
      searchExercises(input.value, handlers);
    });
  });
  await searchPromise;
}

// Reads the Exercise Library again where the coach is: the Blocks view
// stays the Blocks view (after a block save or a realtime access change),
// the library list - inside a block too - is loaded again.
export async function reloadExerciseLibrarySurface(handlers) {
  if (state.exerciseSearch.surface === "blocks") {
    const { refreshExerciseBlocks } = await import("./exercise-blocks.js");
    await refreshExerciseBlocks();
    return;
  }
  await loadExercises(handlers);
}

export async function searchExercises(term, handlers, { forceRefresh = false } = {}) {
  if (state.exerciseSearch.surface === "blocks") {
    const { refreshExerciseBlocks } = await import("./exercise-blocks.js");
    await refreshExerciseBlocks();
    return;
  }
  const query = term.trim();
  state.exerciseSearch.term = query;
  const { limit, filters } = state.exerciseSearch;
  const contextKey = exercisesContextKey(query, limit, filters);
  state.exerciseSearch.lockedPreviews = [];
  let visibleMarkedIds = [];
  try { visibleMarkedIds = await loadMarkedExerciseVisibility(filters); }
  catch { handlers.renderExercises([]); return; }
  await loadCachedView({
    namespace: EXERCISES_CACHE_NAMESPACE,
    contextKey,
    forceRefresh,
    fetcher: () => api(exerciseSearchUrl(query, limit, filters, { lockedPreviews: true })),
    showLoading: () => handlers.setLoading(query ? "Searching exercises..." : "Loading exercises..."),
    applyData: (data) => {
      state.exerciseSearch.hasMore = Boolean(data.hasMore);
      state.exerciseSearch.lockedPreviews = state.exerciseSearch.filters.marked ? [] : data.lockedPreviews || [];
      // Marked is a client-side filter: no previews under it, and so no
      // Load more for them.
      state.exerciseSearch.moreLockedPreviews = state.exerciseSearch.filters.marked ? false : Boolean(data.moreLockedPreviews);
      state.exerciseSearch.canManageCollections = data.canManageCollections === true;
      // Reads the LIVE filters, not the snapshot this fetch was keyed by -
      // `marked` isn't part of the cache key (see exercisesContextKey), so
      // it may have changed since this fetch was dispatched even though the
      // rest of the context hasn't; the render must reflect its current
      // value, not a stale one from dispatch time.
      handlers.renderExercises(applyClientExerciseFilters(data.exercises || [], state.exerciseSearch.filters, visibleMarkedIds));
    },
    applyError: (error) => {
      // Without this, a failed fetch leaves the "Loading/Searching
      // exercises..." placeholder from setLoading above on screen forever -
      // handlers only carries setLoading/renderExercises, neither of which is
      // an error view, so the error is rendered directly here (same pattern as
      // app.js's own renderError: a plain .error box, no new UI concept).
      els.content.innerHTML = `<div class="error">${escapeHtml(error?.message || "Could not load exercises.")}</div>`;
    },
    getCurrentContextKey: () => exercisesContextKey(state.exerciseSearch.term, state.exerciseSearch.limit, state.exerciseSearch.filters),
  });
}

export async function submitExerciseTagForm(form, handlers) {
  const formData = new FormData(form);
  const tagId = String(formData.get("tagId") || "").trim();
  const name = String(formData.get("name") || "").trim();
  if (!tagId && !name) {
    state.tagEditor.error = "Choose a tag or write a new one.";
    rerenderCurrentExerciseSurface(handlers);
    return;
  }
  try {
    await api(`/api/exercises/${encodeURIComponent(state.tagEditor.exerciseId)}/tags`, {
      method: "POST",
      body: JSON.stringify(tagId ? { tagId } : { name }),
    });
    await refreshExerciseTagEditor();
    state.exerciseSearch.options = emptyExerciseOptions();
    await loadExerciseFilterOptions();
    await refreshCurrentExerciseSearch(handlers);
  } catch (error) {
    state.tagEditor.error = error.message || "Could not add tag.";
    rerenderCurrentExerciseSurface(handlers);
  }
}

export async function handleExerciseLibraryAction(action, handlers) {
  const type = action.dataset.action;
  if (await handleExerciseSelectionAction(action, handlers)) return true;
  if (type === "exercise-blocks-clear") {
    delete state.exerciseSearch.filters.collection;
    state.exerciseSearch.limit = 30;
    await searchExercises(state.exerciseSearch.term, handlers);
    return true;
  }
  if (type === "exercise-delete") {
    if (!window.confirm("Permanently delete this private exercise? This cannot be undone. Programs, activities or dependent copies prevent deletion; use Archive to keep references.")) return true;
    try {
      const id = action.dataset.exerciseId;
      await api(`/api/exercises/${encodeURIComponent(id)}/permanent`, { method: "DELETE" });
      state.markedExercises.delete(id);
      state.markedExerciseIds.delete(id);
      invalidateExercisesCache();
      await refreshCurrentExerciseSearch(handlers);
    } catch (error) { window.alert(error.message || "Could not delete exercise. Use Archive instead."); }
    return true;
  }
  if (["exercise-hide", "exercise-archive", "exercise-restore"].includes(type)) {
    try {
      const id = encodeURIComponent(action.dataset.exerciseId);
      if (type === "exercise-hide") {
        await api(`/api/exercises/${id}/hidden`, { method: "POST", body: JSON.stringify({ hidden: action.dataset.hidden !== "true" }) });
      } else {
        const restore = type === "exercise-restore";
        if (!window.confirm(restore ? "Restore this exercise to the active library?" : "Archive this exercise? Existing programs and references are kept. This does not permanently delete it.")) return true;
        await api(`/api/exercises/${id}/${restore ? "restore" : "archive"}`, { method: "POST" });
      }
      invalidateExercisesCache();
      await refreshCurrentExerciseSearch(handlers);
    } catch (error) { window.alert(error.message || "Could not update this exercise."); }
    return true;
  }
  if (type === "exercise-load-more") {
    state.exerciseSearch.limit += 30;
    searchExercises(state.exerciseSearch.term, handlers);
    return true;
  }
  if (type === "exercise-library-view") {
    state.exerciseSearch.view = normalizeExerciseView("library", action.dataset.view);
    saveExerciseViewPreference("library", state.exerciseSearch.view);
    handlers.renderExercises(state.lastExerciseResults);
    return true;
  }
  if (type === "exercise-toggle-favorite") {
    void toggleExerciseFavorite(action.dataset.exerciseId, action.dataset.favorite === "true", handlers);
    return true;
  }
  if (type === "exercise-toggle-mark") {
    toggleExerciseMark(action.dataset.exerciseId, handlers);
    return true;
  }
  if (type === "exercise-tags") {
    void openExerciseTagEditor(action.dataset.exerciseId, action.dataset.exerciseName || "Exercise", handlers);
    return true;
  }
  if (type === "exercise-tags-close") {
    closeExerciseTagEditor(handlers);
    return true;
  }
  if (type === "exercise-tag-remove") {
    void removeExerciseTag(action.dataset.exerciseId, action.dataset.tagId, handlers);
    return true;
  }
  return false;
}

export function handleExerciseDetailAction(action, handlers) {
  const type = action.dataset.action;
  if (type === "exercise-layout") {
    state.exerciseLayout = action.dataset.layout === "vertical" ? "vertical" : "horizontal";
    handlers.renderCurrentNode();
    return true;
  }
  if (type === "open-exercise") {
    const item = handlers.getItemById(action.dataset.itemId);
    if (!item) return true;
    handlers.pushAppHistory();
    handlers.renderExerciseDetail(item, action.dataset.itemId);
    return true;
  }
  if (type === "exercise-prev") {
    handlers.moveExerciseDetail(-1);
    return true;
  }
  if (type === "exercise-next") {
    handlers.moveExerciseDetail(1);
    return true;
  }
  if (type === "exercise-jump") {
    const item = handlers.getItemById(action.dataset.itemId);
    if (!item) return true;
    handlers.renderExerciseDetail(item, action.dataset.itemId);
    return true;
  }
  return false;
}

function findExerciseResultById(exerciseId) {
  return [...state.lastExerciseResults, ...state.builder.exercises].find((exercise) => String(exercise.id) === String(exerciseId)) || null;
}

async function toggleExerciseFavorite(exerciseId, isFavorite, handlers) {
  if (!exerciseId) return;
  await api(`/api/exercises/${encodeURIComponent(exerciseId)}/favorite`, {
    method: isFavorite ? "DELETE" : "POST",
  });
  if (state.activeTab === "builder" && state.builder.selectedNodeId) await loadBuilderExercises();
  // Just changed this exercise's favorite flag server-side - the cached
  // entry for the current search context still has the pre-toggle value
  // (favorite is a real server filter, so a favorites-only view could even
  // need to drop/gain this row), so this specific re-fetch must never be
  // satisfied from cache.
  else await searchExercises(state.exerciseSearch.term, handlers, { forceRefresh: true });
}

function toggleExerciseMark(exerciseId, handlers) {
  if (!exerciseId) return;
  if (state.markedExerciseIds.has(exerciseId)) {
    state.markedExerciseIds.delete(exerciseId);
    state.markedExercises.delete(exerciseId);
  } else {
    state.markedExerciseIds.add(exerciseId);
    const exercise = findExerciseResultById(exerciseId);
    if (exercise) state.markedExercises.set(exerciseId, exercise);
  }
  if (state.activeTab === "builder" && state.builder.selectedNodeId) {
    if (state.builder.exerciseFilters.marked) void loadBuilderExercises();
    else renderBuilder();
  } else {
    searchExercises(state.exerciseSearch.term, handlers);
  }
}

async function openExerciseTagEditor(exerciseId, exerciseName, handlers) {
  if (!exerciseId) return;
  const data = await api(`/api/exercises/${encodeURIComponent(exerciseId)}/tags`);
  state.tagEditor = {
    open: true,
    exerciseId,
    exerciseName,
    tags: data.tags || [],
    options: data.options || [],
    error: "",
  };
  rerenderCurrentExerciseSurface(handlers);
}

function closeExerciseTagEditor(handlers) {
  state.tagEditor = { open: false, exerciseId: "", exerciseName: "", tags: [], options: [], error: "" };
  rerenderCurrentExerciseSurface(handlers);
}

async function removeExerciseTag(exerciseId, tagId, handlers) {
  if (!exerciseId || !tagId) return;
  await api(`/api/exercises/${encodeURIComponent(exerciseId)}/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" });
  await refreshExerciseTagEditor();
  state.exerciseSearch.options = emptyExerciseOptions();
  await loadExerciseFilterOptions();
  await refreshCurrentExerciseSearch(handlers);
}

async function refreshExerciseTagEditor() {
  if (!state.tagEditor.open || !state.tagEditor.exerciseId) return;
  const data = await api(`/api/exercises/${encodeURIComponent(state.tagEditor.exerciseId)}/tags`);
  state.tagEditor = { ...state.tagEditor, tags: data.tags || [], options: data.options || [], error: "" };
  updateExerciseTagsInCache(state.tagEditor.exerciseId, state.tagEditor.tags);
}

async function refreshCurrentExerciseSearch(handlers) {
  if (state.activeTab === "builder" && state.builder.selectedNodeId) await loadBuilderExercises();
  // Called after a tag was added/removed on an exercise - the cached list
  // still has the pre-change tags for that row, so this must always be a
  // real re-fetch, never satisfied from cache.
  else await searchExercises(state.exerciseSearch.term, handlers, { forceRefresh: true });
}

function rerenderCurrentExerciseSurface(handlers) {
  if (state.activeTab === "builder" && state.builder.draft) renderBuilder();
  else handlers.renderExercises(state.lastExerciseResults);
}

function updateExerciseTagsInCache(exerciseId, tags) {
  const update = (exercise) => {
    if (String(exercise.id) === String(exerciseId)) exercise.tags = tags;
  };
  state.lastExerciseResults.forEach(update);
  state.builder.exercises.forEach(update);
  if (state.markedExercises.has(exerciseId)) {
    const exercise = state.markedExercises.get(exerciseId);
    state.markedExercises.set(exerciseId, { ...exercise, tags });
  }
}
