import { api } from "./api.js";
import { renderSingleField, renderMultiField } from "./exercise-editor.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export const classificationFields = [
  { key: "place", label: "Place", optionsKey: "places" },
  { key: "complexity", label: "Complexity", optionsKey: "complexities" },
  { key: "startingPosition", label: "Starting position", optionsKey: "startingPositions" },
  { key: "attractor", label: "Attractor", optionsKey: "attractors" },
  { key: "purposes", label: "Purpose", optionsKey: "purposes", multiple: true },
  { key: "qualities", label: "Quality", optionsKey: "qualities", multiple: true },
  { key: "groups", label: "Group", optionsKey: "groups", multiple: true },
  { key: "bodyParts", label: "Body part", optionsKey: "bodyParts", multiple: true },
  { key: "movementPatterns", label: "Movement pattern", optionsKey: "movementPatterns", multiple: true },
];

export function renderClassificationHtml(model, options = {}) {
  return `<div class="builder-modal-head"><h3>My classification</h3><button class="plain-button" data-classification-close>Cancel</button></div>
    <p class="muted">Only your library and filters change. Unchecked fields use the original. A personal empty list intentionally clears a field.</p>
    ${classificationFields.map((field) => {
      const overridden = Object.hasOwn(model.overrides, field.key);
      const value = overridden ? model.overrides[field.key] : model.system[field.key];
      const controls = (field.multiple ? renderMultiField(field, value || [], options[field.optionsKey] || []) : renderSingleField(field, value || "", options[field.optionsKey] || [])).replaceAll("data-exercise-editor", "data-classification").replaceAll('data-action="exercise-editor', 'data-action="classification');
      return `<section class="panel"><label><input type="checkbox" data-classification-override="${escapeAttr(field.key)}" ${overridden ? "checked" : ""}> Personal ${escapeHtml(field.label)}</label>
        <fieldset ${overridden ? "" : "disabled"}>${controls}</fieldset>
        <button class="text-action" data-classification-reset="${escapeAttr(field.key)}">Reset to system</button></section>`;
    }).join("")}
    ${model.error ? `<p role="alert">${escapeHtml(model.error)}</p>` : ""}
    <div class="builder-modal-actions"><button class="text-action" data-classification-reset-all>Reset all to system</button>
    <button class="plain-button" data-classification-save ${model.saving ? "disabled" : ""}>${model.saving ? "Saving..." : "Save"}</button></div>`;
}

export async function openExerciseClassification(exerciseId, options, refresh) {
  const data = await api(`/api/exercises/${encodeURIComponent(exerciseId)}/classification`);
  const model = { ...data, error: "", saving: false };
  const overlay = document.createElement("div");
  overlay.className = "exercise-editor-overlay exercise-classification-overlay";
  const dialog = document.createElement("section");
  const backdrop = document.createElement("button");
  backdrop.className = "exercise-editor-backdrop";
  backdrop.setAttribute("aria-label", "Cancel classification");
  backdrop.addEventListener("click", () => { if (!model.saving) overlay.remove(); });
  dialog.className = "panel exercise-editor-modal";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "My classification");
  overlay.append(backdrop, dialog);
  document.body.append(overlay);
  const render = () => { dialog.innerHTML = renderClassificationHtml(model, options); };
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !model.saving) { event.stopPropagation(); overlay.remove(); }
  });
  dialog.addEventListener("input", (event) => {
    event.stopPropagation();
    const field = event.target.dataset.classificationField;
    if (field && Object.hasOwn(model.overrides, field)) model.overrides[field] = event.target.value;
  });
  dialog.addEventListener("change", (event) => {
    event.stopPropagation();
    const field = event.target.dataset.classificationOverride;
    if (!field) return;
    if (event.target.checked) model.overrides[field] = structuredClone(model.system[field]);
    else delete model.overrides[field];
    render();
  });
  dialog.addEventListener("click", async (event) => {
    event.stopPropagation();
    const button = event.target.closest("button");
    if (!button || model.saving) return;
    if (button.hasAttribute("data-classification-close")) { overlay.remove(); return; }
    if (button.dataset.classificationReset) delete model.overrides[button.dataset.classificationReset];
    if (button.hasAttribute("data-classification-reset-all")) model.overrides = {};
    const field = button.dataset.field;
    if (button.dataset.action === "classification-add-value") {
      const input = button.closest(".exercise-editor-multi-add")?.querySelector("[data-classification-add-input]");
      const value = input?.value.trim();
      if (value && Array.isArray(model.overrides[field])) model.overrides[field] = [...new Set([...model.overrides[field], value])];
    }
    if (button.dataset.action === "classification-remove-value") model.overrides[field] = model.overrides[field].filter((value) => value !== button.dataset.value);
    if (button.hasAttribute("data-classification-save")) {
      model.saving = true;
      render();
      try {
        await api(`/api/exercises/${encodeURIComponent(exerciseId)}/classification`, { method: "PUT", body: JSON.stringify({ overrides: model.overrides }) });
        overlay.remove();
        await refresh();
      } catch (error) { model.saving = false; model.error = error.message; render(); }
      return;
    }
    render();
  });
  render();
  dialog.querySelector("button")?.focus();
}
