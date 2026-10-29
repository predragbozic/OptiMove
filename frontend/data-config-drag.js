// Drag a variable onto a category on the Categories screen of Data
// configuration (PR-2, docs/ai/data-configuration-visual-proposal.md section
// 6) - on a computer, with a mouse or trackpad, as the Builder's library drag
// (builder-library-drag.js). The browser's own drag and drop: a variable in
// the tray is draggable, an active category of this workspace takes the drop.
// Nothing is sent while dragging; on the drop the caller gets the variable id
// and the category id. On a phone or tablet nothing drags (a long press would
// otherwise start the browser's drag and stop the page from scrolling), and
// by keyboard nothing drags either: Add to a category, in a variable's
// detail, stays the way there.

export const VARIABLE_DRAG_TYPE = "application/x-optimove-variable";
const CHIP_SELECTOR = "[data-dc-drag-variable]";
const TARGET_SELECTOR = "[data-dc-drop-category]";

// The id of the variable being dragged, kept only to clean up after the drag:
// whether a drag is a variable's is read from the drag itself, since the tray
// can be re-rendered while it is dragged.
let draggedVariableId = "";

// Whether variables are offered for dragging on this screen: only where the
// main pointer is a mouse or trackpad.
export function variableDragAvailable() {
  if (!globalThis.matchMedia) return false;
  return globalThis.matchMedia("(pointer: fine)").matches && globalThis.matchMedia("(hover: hover)").matches;
}

// Whether a variable is being dragged right now (the screen waits with a
// redraw until it is dropped or let go).
export const variableDragInProgress = () => Boolean(draggedVariableId);

function isVariableDrag(event) {
  return [...(event.dataTransfer?.types || [])].includes(VARIABLE_DRAG_TYPE);
}

function clearMarks(root) {
  root?.querySelectorAll?.(".is-drop-target").forEach((target) => target.classList.remove("is-drop-target"));
  root?.querySelectorAll?.(`${CHIP_SELECTOR}.is-dragging`).forEach((chip) => chip.classList.remove("is-dragging"));
  root?.querySelectorAll?.(".dc-drag-board.is-dragging").forEach((board) => board.classList.remove("is-dragging"));
}

function endDrag(root = globalThis.document) {
  draggedVariableId = "";
  clearMarks(root);
}

// dragstart on a variable in the tray. Returns true when the event was one.
export function startVariableDrag(event, { isBlocked = () => false } = {}) {
  const chip = event.target?.closest?.(CHIP_SELECTOR);
  if (!chip) return false;
  const variableId = chip.dataset.variableId || "";
  if (!variableId || !event.dataTransfer || !variableDragAvailable() || isBlocked()) {
    event.preventDefault();
    return true;
  }
  draggedVariableId = variableId;
  // Only this drag's own type: an icon inside the chip would otherwise carry
  // markup, which a text field would take as typed text.
  event.dataTransfer.clearData();
  event.dataTransfer.setData(VARIABLE_DRAG_TYPE, variableId);
  event.dataTransfer.effectAllowed = "copy";
  chip.classList.add("is-dragging");
  chip.closest(".dc-drag-board")?.classList.add("is-dragging");
  return true;
}

// dragover anywhere in the content: over a category that takes a variable the
// drop is allowed and the category is marked.
export function overVariableDrag(event) {
  if (!isVariableDrag(event)) return false;
  const target = event.target?.closest?.(TARGET_SELECTOR);
  event.currentTarget?.querySelectorAll?.(".is-drop-target").forEach((other) => {
    if (other !== target) other.classList.remove("is-drop-target");
  });
  if (!target) return true;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  target.classList.add("is-drop-target");
  return true;
}

// dragleave: the mark goes once the pointer is out of the category. A
// dragleave also comes from every element inside it, so the category's own
// box decides.
export function leaveVariableDrag(event) {
  if (!isVariableDrag(event)) return false;
  const target = event.target?.closest?.(TARGET_SELECTOR);
  if (!target) return true;
  const to = event.relatedTarget;
  if (to && target.contains(to)) return true;
  target.classList.remove("is-drop-target");
  return true;
}

// drop: on a category, the caller gets the variable and the category; anywhere
// else nothing happens.
export function dropVariableDrag(event, { onDrop }) {
  if (!isVariableDrag(event)) return false;
  event.preventDefault();
  const target = event.target?.closest?.(TARGET_SELECTOR);
  const variableId = event.dataTransfer.getData(VARIABLE_DRAG_TYPE) || draggedVariableId;
  endDrag(event.currentTarget);
  const categoryId = target?.dataset.categoryId || "";
  if (variableId && categoryId) onDrop(variableId, categoryId);
  return true;
}

export function endVariableDrag(event) {
  if (!draggedVariableId && !event.currentTarget?.querySelector?.(".dc-drag-board.is-dragging")) return false;
  endDrag(event.currentTarget);
  return true;
}
