// Drag a GPEXE column onto a variable on the board (J18, contract section
// 3.4) - on a computer, with a mouse or trackpad, as the Categories screen's
// drag (data-config-drag.js). The browser's own drag and drop, with its own
// type. Nothing is sent while dragging; on the drop the caller gets the field
// id and the variable id. On a phone or tablet nothing drags, and by keyboard
// nothing drags either: tapping a column and then a variable is the way
// there, and it works everywhere.

export const SOURCE_FIELD_DRAG_TYPE = "application/x-optimove-source-field";
const FIELD_SELECTOR = "[data-mb-drag-field]";
const TARGET_SELECTOR = "[data-mb-drop-variable]";
const BOARD_SELECTOR = "[data-mb-board]";

let draggedFieldId = "";

// Whether columns are offered for dragging: only where the main pointer is a
// mouse or trackpad.
export function sourceFieldDragAvailable() {
  if (!globalThis.matchMedia) return false;
  return globalThis.matchMedia("(pointer: fine)").matches && globalThis.matchMedia("(hover: hover)").matches;
}

export function sourceFieldDragInProgress() {
  if (!draggedFieldId) return false;
  if (globalThis.document?.querySelector?.(`${FIELD_SELECTOR}.is-dragging`)) return true;
  draggedFieldId = "";
  return false;
}

const isFieldDrag = (event) => [...(event.dataTransfer?.types || [])].includes(SOURCE_FIELD_DRAG_TYPE);

function clearMarks(root) {
  root?.querySelectorAll?.(".is-drop-target").forEach((target) => target.classList.remove("is-drop-target"));
  root?.querySelectorAll?.(`${FIELD_SELECTOR}.is-dragging`).forEach((el) => el.classList.remove("is-dragging"));
  root?.querySelectorAll?.(`${BOARD_SELECTOR}.is-dragging`).forEach((el) => el.classList.remove("is-dragging"));
}
function endDrag(root = globalThis.document) {
  draggedFieldId = "";
  clearMarks(root);
}

// dragstart on a column. Returns true when the event was one.
export function startSourceFieldDrag(event, { isBlocked = () => false } = {}) {
  const column = event.target?.closest?.(FIELD_SELECTOR);
  if (!column) return false;
  const fieldId = column.dataset.fieldId || "";
  if (!fieldId || !event.dataTransfer || !sourceFieldDragAvailable() || isBlocked()) {
    event.preventDefault();
    return true;
  }
  draggedFieldId = fieldId;
  event.dataTransfer.clearData();
  event.dataTransfer.setData(SOURCE_FIELD_DRAG_TYPE, fieldId);
  event.dataTransfer.effectAllowed = "copy";
  column.classList.add("is-dragging");
  column.closest(BOARD_SELECTOR)?.classList.add("is-dragging");
  return true;
}

// dragover: over an empty variable the drop is allowed and the variable is marked.
export function overSourceFieldDrag(event) {
  if (!isFieldDrag(event)) return false;
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

export function leaveSourceFieldDrag(event) {
  if (!isFieldDrag(event)) return false;
  const target = event.target?.closest?.(TARGET_SELECTOR);
  if (!target) return true;
  const to = event.relatedTarget;
  if (to && target.contains(to)) return true;
  target.classList.remove("is-drop-target");
  return true;
}

// drop: on a variable, the caller gets the field and the variable.
export function dropSourceFieldDrag(event, { onDrop }) {
  if (!isFieldDrag(event)) return false;
  event.preventDefault();
  const target = event.target?.closest?.(TARGET_SELECTOR);
  const fieldId = event.dataTransfer.getData(SOURCE_FIELD_DRAG_TYPE) || draggedFieldId;
  endDrag(event.currentTarget);
  const variableId = target?.dataset.variableId || "";
  if (fieldId && variableId) onDrop(fieldId, variableId);
  return true;
}

export function endSourceFieldDrag(event) {
  if (!draggedFieldId && !event.currentTarget?.querySelector?.(`${BOARD_SELECTOR}.is-dragging`)) return false;
  endDrag(event.currentTarget);
  return true;
}
