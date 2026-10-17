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

// The application block of the exercise, for the block administrator only:
// unlike every field below it changes the exercise for every coach, so it
// has its own button and confirmation and is never part of Save.
function renderBlockHtml(block) {
  if (!block) return "";
  const data = block.data;
  const currentName = data?.current?.name || "Other (no block)";
  const body = block.loadError
    ? `<p role="alert">${escapeHtml(block.loadError)}</p>`
    : !data
      ? '<p role="status">Loading blocks...</p>'
      : !data.movable
        ? `<p>Block: <strong>${escapeHtml(currentName)}</strong>. A private or archived exercise follows its original's block and cannot be moved here.</p>`
        : `<label class="search-field"><span>Block</span><select class="builder-text-input" data-classification-block ${block.busy ? "disabled" : ""}>
            <option value="" ${block.chosen ? "" : "selected"}>Other (no block)</option>
            ${data.blocks.map((item) => `<option value="${escapeAttr(item.id)}" ${item.id === block.chosen ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
          </select></label>
          <button class="plain-button" type="button" data-classification-block-save ${block.busy || block.chosen === (data.current?.id || "") ? "disabled" : ""}>${block.busy ? "Moving..." : "Move to this block"}</button>`;
  return `<section class="panel exercise-classification-block"><h4>Application block</h4>
    <p class="muted">For every coach, not only you: an exercise in a block is available only to that block's users; Other is available to all coaches.</p>
    ${body}
    ${block.error ? `<p role="alert">${escapeHtml(block.error)}</p>` : ""}
    ${block.saved ? `<p role="status">${escapeHtml(block.saved)}</p>` : ""}</section>`;
}

export function renderClassificationHtml(model, options = {}) {
  return `<div class="builder-modal-head"><h3>My classification</h3><button class="plain-button" data-classification-close>Cancel</button></div>
    ${renderBlockHtml(model.block)}
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

const blockMessages = {
  staleRevision: "This exercise's block changed elsewhere. Close and reopen to see it.",
  blockNotAvailable: "That block is no longer available. Close and reopen to choose again.",
  invalidSelection: "This exercise cannot be placed in a block.",
  tryAgain: "The blocks are busy. Please try again.",
  notFound: "You no longer have permission to manage application blocks.",
};
const BLOCK_NOT_CONFIRMED = "The move was not confirmed. Close and reopen to check the exercise's block before retrying.";
// A move whose answer never comes is "not confirmed" after this long.
export const BLOCK_MOVE_CLIENT_BOUND_MS = 45000;

// `canManageBlocks`: the viewer administers application blocks, so the panel
// also shows the exercise's block.
export async function openExerciseClassification(exerciseId, options, refresh, { canManageBlocks = false } = {}) {
  const blockPath = `/api/exercise-collections/exercise-block/${encodeURIComponent(exerciseId)}`;
  const blockRead = canManageBlocks ? api(blockPath).catch(() => null) : null;
  const data = await api(`/api/exercises/${encodeURIComponent(exerciseId)}/classification`);
  const model = { ...data, error: "", saving: false, block: canManageBlocks ? { data: null, chosen: "", busy: false, error: "", saved: "", loadError: "" } : null };
  const busy = () => model.saving || model.block?.busy;
  const overlay = document.createElement("div");
  overlay.className = "exercise-editor-overlay exercise-classification-overlay";
  const dialog = document.createElement("section");
  const backdrop = document.createElement("button");
  backdrop.className = "exercise-editor-backdrop";
  backdrop.setAttribute("aria-label", "Cancel classification");
  backdrop.addEventListener("click", () => { if (!busy()) overlay.remove(); });
  dialog.className = "panel exercise-editor-modal";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "My classification");
  overlay.append(backdrop, dialog);
  document.body.append(overlay);
  const render = () => { dialog.innerHTML = renderClassificationHtml(model, options); };
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !busy()) { event.stopPropagation(); overlay.remove(); }
  });
  dialog.addEventListener("input", (event) => {
    event.stopPropagation();
    const field = event.target.dataset.classificationField;
    if (field && Object.hasOwn(model.overrides, field)) model.overrides[field] = event.target.value;
  });
  dialog.addEventListener("change", (event) => {
    event.stopPropagation();
    if (event.target.hasAttribute("data-classification-block")) {
      model.block.chosen = event.target.value;
      model.block.error = "";
      model.block.saved = "";
      render();
      return;
    }
    const field = event.target.dataset.classificationOverride;
    if (!field) return;
    if (event.target.checked) model.overrides[field] = structuredClone(model.system[field]);
    else delete model.overrides[field];
    render();
  });
  dialog.addEventListener("click", async (event) => {
    event.stopPropagation();
    const button = event.target.closest("button");
    if (!button || busy()) return;
    if (button.hasAttribute("data-classification-close")) { overlay.remove(); return; }
    if (button.hasAttribute("data-classification-block-save")) { await moveBlock(); return; }
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
  async function moveBlock() {
    const block = model.block;
    const current = block.data.current;
    const target = block.data.blocks.find((item) => item.id === block.chosen) || null;
    if ((current?.id || "") === (target?.id || "")) return;
    const name = block.data.exerciseName || "this exercise";
    const confirmation = (target
      ? [`Move “${name}” into the block “${target.name}”?`,
        target.accessAll ? "Every coach can use it: this block is open to all users." : "Only this block's selected users and the administrator can use it. Other coaches lose it, including their personal copies.",
        current ? `It leaves “${current.name}”.` : ""]
      : [`Move “${name}” to Other?`, `It leaves “${current.name}” and becomes available to all coaches.`]).filter(Boolean).join("\n\n");
    if (!window.confirm(confirmation)) return;
    block.busy = true;
    block.error = "";
    block.saved = "";
    render();
    const controller = new AbortController();
    const bound = setTimeout(() => controller.abort(), BLOCK_MOVE_CLIENT_BOUND_MS);
    try {
      await api(blockPath, { method: "PUT", signal: controller.signal,
        body: JSON.stringify({ collectionId: target?.id || null, expectedCollectionId: current?.id || null }) });
      clearTimeout(bound);
      block.data.current = target ? { id: target.id, name: target.name } : null;
      block.saved = target ? `Moved to “${target.name}”.` : "Moved to Other.";
      try { await refresh(); } catch {}
    } catch (error) {
      block.error = (!controller.signal.aborted && blockMessages[error.message]) || BLOCK_NOT_CONFIRMED;
    } finally {
      clearTimeout(bound);
      block.busy = false;
      if (overlay.isConnected) render();
    }
  }

  render();
  dialog.querySelector("button")?.focus();
  if (blockRead) {
    const answer = await blockRead;
    if (!overlay.isConnected) return;
    if (answer) {
      model.block.data = answer;
      model.block.chosen = answer.current?.id || "";
    } else model.block.loadError = "The blocks could not be loaded. Close and reopen to try again.";
    render();
  }
}
