import { api } from "./api.js";
import { loadBuilderExercises } from "./builder-data.js";
import { renderBuilder } from "./builder-view.js";
import { els } from "./dom.js";
import { applyClientExerciseFilters, exerciseSearchUrl, loadExerciseFilterOptions } from "./exercise-data.js";
import { renderExerciseFilterControls } from "./exercise-library.js";
import { emptyExerciseOptions, state } from "./state.js";
import { debounce } from "./utils.js";

export async function loadExercises(handlers) {
  state.navStack = [];
  await loadExerciseFilterOptions();
  els.toolbar.innerHTML = `
    <label class="search-field exercise-search-field">
      <span>Exercise search</span>
      <input id="exerciseSearch" type="search" placeholder="Name or code" value="">
    </label>
    <div class="exercise-filter-strip">
      ${renderExerciseFilterControls(state.exerciseSearch.filters, state.exerciseSearch.options)}
    </div>
  `;
  const input = document.querySelector("#exerciseSearch");
  input.addEventListener("input", debounce(() => {
    state.exerciseSearch.limit = 30;
    searchExercises(input.value, handlers);
  }, 250));
  document.querySelectorAll("[data-exercise-filter]").forEach((control) => {
    control.addEventListener("change", () => {
      state.exerciseSearch.filters[control.dataset.exerciseFilter] =
        control.type === "checkbox" ? control.checked : control.value;
      state.exerciseSearch.limit = 30;
      searchExercises(input.value, handlers);
    });
  });
  await searchExercises(input.value, handlers);
}

export async function searchExercises(term, handlers) {
  const query = term.trim();
  state.exerciseSearch.term = query;
  handlers.setLoading(query ? "Searching exercises..." : "Loading exercises...");
  const data = await api(exerciseSearchUrl(query, state.exerciseSearch.limit, state.exerciseSearch.filters));
  state.exerciseSearch.hasMore = Boolean(data.hasMore);
  handlers.renderExercises(applyClientExerciseFilters(data.exercises || [], state.exerciseSearch.filters));
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
  if (type === "exercise-load-more") {
    state.exerciseSearch.limit += 30;
    searchExercises(state.exerciseSearch.term, handlers);
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

function findExerciseResultById(exerciseId) {
  return [...state.lastExerciseResults, ...state.builder.exercises].find((exercise) => String(exercise.id) === String(exerciseId)) || null;
}

async function toggleExerciseFavorite(exerciseId, isFavorite, handlers) {
  if (!exerciseId) return;
  await api(`/api/exercises/${encodeURIComponent(exerciseId)}/favorite`, {
    method: isFavorite ? "DELETE" : "POST",
  });
  if (state.activeTab === "builder" && state.builder.selectedNodeId) await loadBuilderExercises();
  else await searchExercises(state.exerciseSearch.term, handlers);
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
  else await searchExercises(state.exerciseSearch.term, handlers);
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
