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
const blockLabel = (item) => `${item.name} — ${item.accessAll ? "open to all" : "selected users"}`;
const currentBlockName = (block) => block.data?.current?.name || "Other";

// A block chosen in the list but not moved yet - Save and Close never drop it silently.
function unappliedBlock(block) {
  return Boolean(block?.data?.movable && !block.uncertain && block.chosen !== (block.data.current?.id || ""));
}
function pendingNote(block) {
  return unappliedBlock(block) ? `Not moved yet. It stays in “${currentBlockName(block)}” until you press Move to this block.` : "";
}

function renderBlockHtml(block) {
  if (!block) return "";
  const data = block.data;
  const locked = block.busy || block.uncertain;
  const body = block.loadError
    ? `<p role="alert">${escapeHtml(block.loadError)}</p>`
    : !data
      ? '<p role="status">Loading blocks...</p>'
      : !data.movable
        ? `<p>Block: <strong>${escapeHtml(currentBlockName(block))}</strong>. Personal copies and archived exercises can't be moved here. For a personal copy, move its original.</p>`
        : `<p>Changes access for every coach. A block with selected users: only they and the administrator. An open block or Other: every coach.</p>
          <label class="search-field"><span>Block</span><select class="builder-text-input" data-classification-block ${locked ? "disabled" : ""}>
            <option value="" ${block.chosen ? "" : "selected"}>Other — every coach</option>
            ${data.blocks.map((item) => `<option value="${escapeAttr(item.id)}" ${item.id === block.chosen ? "selected" : ""}>${escapeHtml(blockLabel(item))}</option>`).join("")}
          </select></label>
          <button class="plain-button" type="button" data-classification-block-save ${locked || !unappliedBlock(block) ? "disabled" : ""}>${block.busy ? "Moving..." : "Move to this block"}</button>
          <p class="exercise-classification-pending" data-block-pending>${escapeHtml(pendingNote(block))}</p>`;
  return `<section class="panel exercise-classification-block"><h4>Application block · all coaches</h4>
    ${body}
    ${block.error ? `<p role="alert">${escapeHtml(block.error)}</p>` : ""}
    ${block.saved ? `<p role="status">${escapeHtml(block.saved)}</p>` : ""}</section>`;
}

export function renderClassificationHtml(model, options = {}) {
  const busy = Boolean(model.saving || model.block?.busy);
  return `<div class="builder-modal-head"><h3>My classification</h3><button class="plain-button" data-classification-close ${busy ? "disabled" : ""}>Cancel</button></div>
    ${renderBlockHtml(model.block)}
    ${model.block ? "<h4>Only for you</h4>" : ""}
    <p class="muted">Only your library and filters change. Unchecked fields use the original. A personal empty list intentionally clears a field.</p>
    ${classificationFields.map((field) => {
      const overridden = Object.hasOwn(model.overrides, field.key);
      const value = overridden ? model.overrides[field.key] : model.system[field.key];
      const controls = (field.multiple ? renderMultiField(field, value || [], options[field.optionsKey] || []) : renderSingleField(field, value || "", options[field.optionsKey] || [])).replaceAll("data-exercise-editor", "data-classification").replaceAll('data-action="exercise-editor', 'data-action="classification');
      return `<section class="panel"><label><input type="checkbox" data-classification-override="${escapeAttr(field.key)}" ${overridden ? "checked" : ""}> Personal ${escapeHtml(field.label)}</label>
        <fieldset ${overridden ? "" : "disabled"}>${controls}</fieldset>
        <button class="text-action" data-classification-reset="${escapeAttr(field.key)}" ${busy ? "disabled" : ""}>Reset to system</button></section>`;
    }).join("")}
    ${model.error ? `<p role="alert">${escapeHtml(model.error)}</p>` : ""}
    <div class="builder-modal-actions"><button class="text-action" data-classification-reset-all ${busy ? "disabled" : ""}>Reset all to system</button>
    <button class="plain-button" data-classification-save ${busy ? "disabled" : ""}>${model.saving ? "Saving..." : "Save"}</button></div>`;
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
  // Closing never drops a chosen, unmoved block without asking.
  const requestClose = () => {
    if (busy()) return;
    if (unappliedBlock(model.block) && !window.confirm(`Close without moving? “${model.block.data.exerciseName || "This exercise"}” stays in “${currentBlockName(model.block)}”.`)) return;
    overlay.remove();
  };
  backdrop.addEventListener("click", requestClose);
  dialog.className = "panel exercise-editor-modal";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "My classification");
  overlay.append(backdrop, dialog);
  document.body.append(overlay);
  const render = () => { dialog.innerHTML = renderClassificationHtml(model, options); };
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.stopPropagation(); requestClose(); }
  });
  dialog.addEventListener("input", (event) => {
    event.stopPropagation();
    const field = event.target.dataset.classificationField;
    if (field && Object.hasOwn(model.overrides, field)) model.overrides[field] = event.target.value;
  });
  dialog.addEventListener("change", (event) => {
    event.stopPropagation();
    if (event.target.hasAttribute("data-classification-block")) {
      // Updated in place, never re-rendered: the select keeps the focus, so
      // the arrow keys go on choosing.
      model.block.chosen = event.target.value;
      model.block.error = "";
      model.block.saved = "";
      const section = event.target.closest(".exercise-classification-block");
      section.querySelectorAll("[role='status'], [role='alert']").forEach((note) => note.remove());
      section.querySelector("[data-classification-block-save]").disabled = !unappliedBlock(model.block);
      section.querySelector("[data-block-pending]").textContent = pendingNote(model.block);
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
    if (button.hasAttribute("data-classification-close")) { requestClose(); return; }
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
      if (unappliedBlock(model.block)) {
        const chosen = model.block.data.blocks.find((item) => item.id === model.block.chosen)?.name || "Other";
        model.block.error = `Your block choice “${chosen}” was not applied. Press Move to this block, or set Block back to “${currentBlockName(model.block)}”.`;
        render();
        dialog.querySelector("[data-classification-block]")?.focus();
        return;
      }
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
        target.accessAll ? "Every coach can use it: this block is open to all users." : "Only this block's selected users and the administrator can use it. Other coaches can no longer use it; their personal copies are hidden, not deleted.",
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
      block.saved = `Moved to ${target ? `“${target.name}”` : "Other"} for every coach. This is already saved; Cancel does not undo it.`;
      try { await refresh(); } catch {}
    } catch (error) {
      const known = !controller.signal.aborted && blockMessages[error.message];
      block.error = known || BLOCK_NOT_CONFIRMED;
      // Not confirmed: another try here could only answer "changed elsewhere".
      if (!known) block.uncertain = true;
    } finally {
      clearTimeout(bound);
      block.busy = false;
      if (overlay.isConnected) {
        render();
        (dialog.querySelector("[data-classification-block]:not(:disabled)") || dialog.querySelector("[data-classification-close]"))?.focus();
      }
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
