import { api } from "./api.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export const emptyExerciseEditorData = () => ({
  name: "", exerciseCode: "", aim: "", executionNotes: "", instruction: "", videoUrl: "", imageUrl: "",
  place: "", complexity: "", startingPosition: "", attractor: "",
  purposes: [], qualities: [], groups: [], bodyParts: [], movementPatterns: [], tags: [],
});

export const emptyExerciseEditor = () => ({
  open: false, isNew: false, exerciseId: "", loading: false, error: "", data: emptyExerciseEditorData(),
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
  { key: "tags", label: "Tag", optionsKey: "tags" },
];

export function renderExerciseEditorHtml(editor, filterOptions = {}) {
  const d = editor.data;
  return `
    <div class="exercise-editor-overlay">
      <button class="exercise-editor-backdrop" type="button" data-action="exercise-editor-close" aria-label="Close"></button>
      <section class="panel exercise-editor-modal" role="dialog" aria-modal="true" aria-label="${editor.isNew ? "Add exercise" : "Edit exercise"}">
        <div class="builder-modal-head">
          <div><p class="eyebrow">${editor.isNew ? "New exercise" : "Editing exercise"}</p><h3>${escapeHtml(d.name || "Untitled")}</h3></div>
          <button class="plain-button icon-button" type="button" data-action="exercise-editor-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        <div class="exercise-editor-body">
          <label class="search-field"><span>Name</span><input class="builder-text-input" data-exercise-editor-field="name" value="${escapeAttr(d.name)}" required></label>
          <div class="exercise-editor-grid">
            <label class="search-field"><span>Exercise code</span><input class="builder-text-input" data-exercise-editor-field="exerciseCode" value="${escapeAttr(d.exerciseCode)}"></label>
            <label class="search-field"><span>Video URL</span><input class="builder-text-input" type="url" data-exercise-editor-field="videoUrl" value="${escapeAttr(d.videoUrl)}"></label>
            <label class="search-field"><span>Image URL</span><input class="builder-text-input" type="url" data-exercise-editor-field="imageUrl" value="${escapeAttr(d.imageUrl)}"></label>
          </div>
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
          <button class="plain-button" type="button" data-action="exercise-editor-save" ${editor.loading ? "disabled" : ""}>${editor.loading ? "Saving..." : "Save"}</button>
          <button class="text-action" type="button" data-action="exercise-editor-close">Cancel</button>
        </div>
      </section>
    </div>
  `;
}

function renderSingleField(field, value, options) {
  const listId = `exercise-editor-${field.key}-options`;
  return `
    <label class="search-field">
      <span>${escapeHtml(field.label)}</span>
      <input class="builder-text-input" list="${escapeAttr(listId)}" data-exercise-editor-field="${escapeAttr(field.key)}" value="${escapeAttr(value || "")}" autocomplete="off">
      <datalist id="${escapeAttr(listId)}">${options.map((option) => `<option value="${escapeAttr(option)}"></option>`).join("")}</datalist>
    </label>
  `;
}

function renderMultiField(field, values, options) {
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

export async function openExerciseEditor(state, handlers, exerciseId) {
  state.exerciseEditor = { ...emptyExerciseEditor(), open: true, isNew: !exerciseId, exerciseId: exerciseId || "" };
  if (exerciseId) {
    state.exerciseEditor.loading = true;
    handlers.rerender();
    try {
      const detail = await api(`/api/exercises/${encodeURIComponent(exerciseId)}`);
      state.exerciseEditor.data = {
        name: detail.name || "", exerciseCode: detail.exerciseCode || "", aim: detail.aim || "",
        executionNotes: detail.executionNotes || "", instruction: detail.instruction || "",
        videoUrl: detail.videoUrl || "", imageUrl: detail.imageUrl || "",
        place: detail.place || "", complexity: detail.complexity || "", startingPosition: detail.startingPosition || "",
        attractor: detail.attractor || "", purposes: detail.purposes || [], qualities: detail.qualities || [],
        groups: detail.groups || [], bodyParts: detail.bodyParts || [], movementPatterns: detail.movementPatterns || [],
        tags: detail.tags || [],
      };
      state.exerciseEditor.loading = false;
    } catch (error) {
      state.exerciseEditor.loading = false;
      state.exerciseEditor.error = error.message || "Could not load exercise.";
    }
  }
  handlers.rerender();
}

export function closeExerciseEditor(state, handlers) {
  state.exerciseEditor = emptyExerciseEditor();
  handlers.rerender();
}

export function handleExerciseEditorInput(state, event) {
  const field = event.target.closest("[data-exercise-editor-field]");
  if (field) {
    state.exerciseEditor.data[field.dataset.exerciseEditorField] = field.value;
    return true;
  }
  return false;
}

export async function handleExerciseEditorAction(state, handlers, action) {
  const type = action.dataset.action;
  if (type === "exercise-editor-close") {
    closeExerciseEditor(state, handlers);
    return true;
  }
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
    editor.loading = true;
    editor.error = "";
    handlers.rerender();
    try {
      if (editor.isNew) {
        await api("/api/exercises", { method: "POST", body: JSON.stringify(editor.data) });
      } else {
        await api(`/api/exercises/${encodeURIComponent(editor.exerciseId)}`, { method: "PATCH", body: JSON.stringify(editor.data) });
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
