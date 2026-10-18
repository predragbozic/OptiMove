import { api } from "./api.js";
import { openModalShell } from "./modal-shell.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// The administrator's move of several selected exercises into one
// application block (or Other) at once - the library's selection, the same
// rules as one exercise's move in its classification panel.
export const EXERCISE_SELECTION_LIMIT = 100;
// A move whose answer never comes is "not confirmed" after this long.
export const BULK_MOVE_CLIENT_BOUND_MS = 45000;
const OTHER = "other";
const ACCESS_ID = "exercise-bulk-move-access";

const accessLabel = (block) => `${block.name} — ${block.accessAll ? "open to all" : "selected users"}`;
const noun = (count) => (count === 1 ? "exercise" : "exercises");
const destination = (target) => (target.id ? `“${target.name}”` : "Other");

// Every coded refusal is a whole refusal: the server moves all or nothing.
const moveMessages = {
  staleRevision: "Nothing was moved: some of these exercises were moved elsewhere after this was read. Check again to see where they are now.",
  blockNotAvailable: "Nothing was moved: that block no longer exists. Check again to choose another.",
  invalidSelection: "Nothing was moved: some of these exercises were archived or removed meanwhile. Check again.",
  tryAgain: "Nothing was moved: the blocks are being changed right now. Try again in a moment.",
  notFound: "Nothing was moved: you no longer have permission to manage application blocks.",
  invalidBody: "Nothing was moved: this selection could not be sent. Close and select again.",
};
const readMessages = {
  notFound: "You no longer have permission to manage application blocks.",
  invalidBody: "This selection could not be read. Close and select again.",
};
// Never "nothing was moved": a late COMMIT may still land.
const NOT_CONFIRMED = "The move was not confirmed. Check again to see where the exercises are now before you try again.";
const CHECKED = "Checked just now. Review where they are and press Move again.";

function targetOf(model) {
  if (model.target === OTHER) return { id: null, name: "Other", accessAll: true };
  return model.data?.blocks.find((block) => block.id === model.target) || null;
}

// Who can use the exercises after the move, before it and after it.
function accessSentence(target) {
  if (!target.id) return "Every coach can use them: Other is available to all coaches.";
  return target.accessAll
    ? "Every coach can use them: this block is open to all users."
    : "Only this block's selected users and the administrator can use them. Other coaches can no longer use them; their personal copies are hidden, not deleted.";
}

function accessNow(target) {
  return !target.id || target.accessAll
    ? "Every coach can use them now."
    : `Only the selected users of ${destination(target)} and the administrator can use them now.`;
}

function placeName(current) {
  return current ? current.name : "Other";
}

export function renderBulkMoveHtml(model) {
  const closing = model.result || model.denied;
  const head = `<div class="builder-modal-head"><h3>Move to block</h3><button class="plain-button" type="button" data-bulk-move-close ${model.busy ? "disabled" : ""}>${closing ? "Close" : "Cancel"}</button></div>`;
  if (model.loading) return `${head}<p role="status">Reading where the selected exercises are...</p>`;
  if (model.loadError) return `${head}<p role="alert">${escapeHtml(model.loadError)}</p>
    ${model.denied ? "" : '<div class="builder-modal-actions"><button class="plain-button" type="button" data-bulk-move-check>Check again</button></div>'}`;
  // Saved: only what happened - the places shown before were the old ones.
  if (model.result) return `${head}<p role="status">${escapeHtml(model.result)}</p>`;
  if (model.denied) return `${head}<p role="alert">${escapeHtml(model.error)}</p>`;
  const movable = model.data.exercises.filter((exercise) => exercise.movable);
  const fixed = model.data.exercises.filter((exercise) => !exercise.movable);
  const missing = model.requested - model.data.exercises.length;
  const leftOut = `${fixed.length ? `<p class="muted">Left out (archived or a personal copy): ${fixed.map((exercise) => escapeHtml(exercise.name)).join(", ")}.</p>` : ""}
    ${missing > 0 ? `<p class="muted">${missing} selected ${missing === 1 ? "exercise no longer exists and is" : "exercises no longer exist and are"} left out.</p>` : ""}`;
  if (!movable.length) return `${head}<p>None of the selected exercises can be moved now.</p>${leftOut}`;
  const target = targetOf(model);
  const staying = target ? movable.filter((exercise) => (exercise.current?.id ?? null) === target.id) : [];
  const moving = movable.length - staying.length;
  const places = new Map();
  for (const exercise of movable) {
    const key = exercise.current?.id || OTHER;
    const place = places.get(key) || { name: placeName(exercise.current), count: 0 };
    place.count += 1;
    places.set(key, place);
  }
  const locked = model.busy || model.uncertain || model.checkable;
  const label = model.busy ? "Moving..."
    : !target ? `Move ${movable.length} ${noun(movable.length)}`
      : moving ? `Move ${moving} ${noun(moving)} to ${destination(target)}` : "Nothing to move";
  return `${head}
    <p>${movable.length} selected ${noun(movable.length)} — now in ${[...places.values()].map((place) => `${escapeHtml(place.name)} (${place.count})`).join(", ")}.</p>
    ${leftOut}
    <label class="search-field"><span>Move to</span><select class="builder-text-input" data-bulk-move-target ${locked ? "disabled" : ""}>
      <option value="" ${model.target ? "" : "selected"} disabled>Choose a block</option>
      ${model.data.blocks.map((block) => `<option value="${escapeAttr(block.id)}" ${block.id === model.target ? "selected" : ""}>${escapeHtml(accessLabel(block))}</option>`).join("")}
      <option value="${OTHER}" ${model.target === OTHER ? "selected" : ""}>Other — every coach</option>
    </select></label>
    ${target ? `<p id="${ACCESS_ID}">${escapeHtml(accessSentence(target))}</p>` : ""}
    ${target && staying.length ? `<p class="muted">${staying.length} ${staying.length === 1 ? "is" : "are"} already in ${escapeHtml(destination(target))} and ${staying.length === 1 ? "stays" : "stay"} as ${staying.length === 1 ? "it is" : "they are"}.</p>` : ""}
    ${model.checked ? `<p role="status">${escapeHtml(CHECKED)}</p>` : ""}
    ${model.error ? `<p role="alert">${escapeHtml(model.error)}</p>` : ""}
    <div class="builder-modal-actions">
      ${model.uncertain || model.checkable ? `<button class="plain-button" type="button" data-bulk-move-check ${model.busy ? "disabled" : ""}>Check again</button>` : ""}
      <button class="plain-button" type="button" data-bulk-move-submit ${target ? `aria-describedby="${ACCESS_ID}"` : ""} ${locked || !target || !moving ? "disabled" : ""}>${escapeHtml(label)}</button>
    </div>`;
}

// `ids`: the selected exercise ids (at most EXERCISE_SELECTION_LIMIT).
// `onMoved()`: called once the move is known to be saved, to clear the
// selection and read the library again. Returns the overlay.
export function openExerciseBulkMove(ids, { onMoved = async () => {} } = {}) {
  const model = { requested: ids.length, data: null, loading: true, loadError: "", target: "", busy: false, error: "", result: "",
    uncertain: false, checkable: false, checked: false, denied: false };
  // A move in flight is never left behind by a close. Focus goes back to the
  // selection bar: Move to block… while something is selected, else its count.
  const { overlay, dialog, close: requestClose } = openModalShell({
    overlayClass: "exercise-bulk-move-overlay", dialogClass: "exercise-bulk-move-modal",
    label: "Move to block", closeLabel: "Close move to block",
    canClose: () => !model.busy,
    onClosed: () => (document.querySelector('[data-action="exercise-bulk-move-open"]:not(:disabled)') || document.querySelector("[data-exercise-selection-count]"))?.focus(),
  });
  const render = () => { if (overlay.isConnected) dialog.innerHTML = renderBulkMoveHtml(model); };

  let saved = false;
  async function markSaved(message) {
    model.result = message;
    if (saved) return;
    saved = true;
    try { await onMoved(); } catch {}
  }

  // Reads where every selected exercise is now; its answer is what the move
  // will expect, so a block that changed meanwhile is refused, never overrun.
  // After an unconfirmed move it also tells whether that move landed.
  let readGeneration = 0;
  async function read() {
    const generation = ++readGeneration;
    const afterUncertain = model.uncertain;
    const afterRefusal = model.checkable;
    model.loading = !model.data;
    model.loadError = "";
    model.error = "";
    model.checked = false;
    render();
    try {
      const data = await api(`/api/exercise-collections/exercise-blocks?ids=${ids.map(encodeURIComponent).join(",")}`);
      if (generation !== readGeneration) return;
      model.data = data;
      model.uncertain = false;
      model.checkable = false;
      if (model.target && model.target !== OTHER && !data.blocks.some((block) => block.id === model.target)) model.target = "";
      const target = targetOf(model);
      const movable = data.exercises.filter((exercise) => exercise.movable);
      if (afterUncertain && target && movable.length && movable.every((exercise) => (exercise.current?.id ?? null) === target.id)) {
        await markSaved(`The move was saved: ${movable.length === 1 ? "it is" : `all ${movable.length} are`} now in ${destination(target)}. ${accessNow(target)}`);
      } else if (afterUncertain || afterRefusal) model.checked = true;
    } catch (error) {
      if (generation !== readGeneration) return;
      model.denied = error.message === "notFound";
      model.loadError = readMessages[error.message] || "The selected exercises could not be read. Check again.";
    } finally {
      if (generation === readGeneration) {
        model.loading = false;
        render();
        (dialog.querySelector("[data-bulk-move-target]:not(:disabled)") || dialog.querySelector("[data-bulk-move-close]"))?.focus();
      }
    }
  }

  async function submit() {
    const target = targetOf(model);
    if (!target || model.busy) return;
    const moves = model.data.exercises.filter((exercise) => exercise.movable)
      .map((exercise) => ({ exerciseId: exercise.id, expectedCollectionId: exercise.current?.id ?? null }));
    model.busy = true;
    model.error = "";
    model.checked = false;
    render();
    const controller = new AbortController();
    const bound = setTimeout(() => controller.abort(), BULK_MOVE_CLIENT_BOUND_MS);
    try {
      const answer = await api("/api/exercise-collections/exercise-blocks", { method: "PUT", signal: controller.signal,
        body: JSON.stringify({ collectionId: target.id, moves }) });
      const already = answer.unchanged?.length || 0;
      if (answer.changed) {
        await markSaved(`Moved ${answer.moved.length} ${noun(answer.moved.length)} to ${destination(target)}. ${accessNow(target)}${already ? ` ${already} ${already === 1 ? "was" : "were"} already there.` : ""}`);
      } else model.result = `Nothing to move: ${already === 1 ? "it is" : "all of them are"} already in ${destination(target)}.`;
    } catch (error) {
      const known = !controller.signal.aborted && moveMessages[error.message];
      model.error = known || NOT_CONFIRMED;
      if (!known) model.uncertain = true;
      else if (error.message === "notFound") model.denied = true;
      else if (["staleRevision", "blockNotAvailable", "invalidSelection"].includes(error.message)) model.checkable = true;
    } finally {
      clearTimeout(bound);
      model.busy = false;
      render();
      (dialog.querySelector("[data-bulk-move-check]") || dialog.querySelector("[data-bulk-move-close]"))?.focus();
    }
  }

  dialog.addEventListener("change", (event) => {
    event.stopPropagation();
    if (!event.target.hasAttribute("data-bulk-move-target")) return;
    model.target = event.target.value;
    model.error = "";
    model.checked = false;
    render();
    dialog.querySelector("[data-bulk-move-target]")?.focus();
  });
  dialog.addEventListener("click", (event) => {
    event.stopPropagation();
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-bulk-move-close")) requestClose();
    else if (button.hasAttribute("data-bulk-move-check")) void read();
    else if (button.hasAttribute("data-bulk-move-submit")) void submit();
  });

  render();
  dialog.querySelector("[data-bulk-move-close]")?.focus();
  void read();
  return overlay;
}
