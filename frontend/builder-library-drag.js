// Drag an exercise from the section editor's library onto its Added list -
// on a computer, with a mouse or trackpad. The browser's own drag and drop:
// a library card is draggable, the Added column takes the drop, and the
// exercise lands where it is dropped - one past every added exercise whose
// middle is above the pointer (dropIndexFor, the same rule as the reorder
// drag). Nothing is sent while dragging; on the drop the caller gets the
// exercise id and the zero-based position. On a touch-only screen a card
// does not drag (a long press would otherwise start the browser's drag and
// stop the page from scrolling); Add stays the way to add there.

import { dropIndexFor } from "./builder-item-drag.js";

export const LIBRARY_DRAG_TYPE = "application/x-optimove-exercise";
const CARD_SELECTOR = "[data-builder-library-drag]";
const ZONE_SELECTOR = ".builder-section-added";
const PANEL_SELECTOR = ".builder-section-panel";

let draggedExerciseId = "";

function touchOnly() {
  const media = (query) => Boolean(globalThis.matchMedia?.(query).matches);
  return media("(pointer: coarse)") && !media("(any-pointer: fine)");
}

// Whether library cards are rendered draggable on this screen.
export function libraryDragAvailable() {
  return !touchOnly();
}

// The added exercises the coach sees: the computer's form list or the
// phone cards, whichever one the screen shows.
function visibleItems(zone) {
  return [...zone.querySelectorAll("[data-drag-item]")].filter((item) => item.getClientRects().length > 0);
}

// Where an exercise dropped at `clientY` lands among the visible added ones.
export function libraryDropIndex(zone, clientY) {
  return dropIndexFor(clientY, visibleItems(zone).map((item) => {
    const rect = item.getBoundingClientRect();
    return rect.top + rect.height / 2;
  }));
}

function clearMarks(root) {
  root?.querySelectorAll?.(".is-drop-before, .is-drop-after").forEach((item) => item.classList.remove("is-drop-before", "is-drop-after"));
  root?.querySelectorAll?.(".is-library-drop-target").forEach((zone) => zone.classList.remove("is-library-drop-target"));
}

function markDrop(zone, index) {
  clearMarks(zone);
  zone.classList.add("is-library-drop-target");
  const items = visibleItems(zone);
  if (!items.length) return;
  if (index < items.length) items[index].classList.add("is-drop-before");
  else items[items.length - 1].classList.add("is-drop-after");
}

function endDrag(root) {
  draggedExerciseId = "";
  root?.querySelectorAll?.(`${PANEL_SELECTOR}.is-library-dragging`).forEach((panel) => panel.classList.remove("is-library-dragging"));
  clearMarks(root);
}

// dragstart on a library card. Returns true when the event was a card's.
export function startBuilderLibraryDrag(event, { isBlocked = () => false } = {}) {
  const card = event.target?.closest?.(CARD_SELECTOR);
  if (!card) return false;
  const exerciseId = card.dataset.exerciseId || "";
  if (!exerciseId || !event.dataTransfer || touchOnly() || isBlocked()) {
    event.preventDefault();
    return true;
  }
  draggedExerciseId = exerciseId;
  // Only this drag's own type: a picture inside the card would otherwise
  // carry its address, which a text field would take as typed text.
  event.dataTransfer.clearData();
  event.dataTransfer.setData(LIBRARY_DRAG_TYPE, exerciseId);
  event.dataTransfer.effectAllowed = "copy";
  card.closest(PANEL_SELECTOR)?.classList.add("is-library-dragging");
  return true;
}

// dragover anywhere in the content: over the Added column a library card
// may drop, and the place it would land is marked.
export function overBuilderLibraryDrag(event) {
  if (!draggedExerciseId) return false;
  const zone = event.target?.closest?.(ZONE_SELECTOR);
  if (!zone) {
    clearMarks(event.currentTarget);
    return true;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  markDrop(zone, libraryDropIndex(zone, event.clientY));
  return true;
}

// dragleave: the marks go once the pointer is out of the Added column. A
// dragleave also comes from every element inside it the pointer passes,
// and the browser does not always say where the pointer went, so the
// column's own box decides.
export function leaveBuilderLibraryDrag(event) {
  if (!draggedExerciseId) return false;
  const zone = event.target?.closest?.(ZONE_SELECTOR);
  if (!zone) return true;
  const box = zone.getBoundingClientRect();
  const inside = event.clientX > box.left && event.clientX < box.right && event.clientY > box.top && event.clientY < box.bottom;
  if (!inside) clearMarks(zone.parentElement || zone);
  return true;
}

// drop: the exercise and its position go to `onDrop`.
export function dropBuilderLibraryDrag(event, { onDrop }) {
  if (!draggedExerciseId) return false;
  const zone = event.target?.closest?.(ZONE_SELECTOR);
  const exerciseId = draggedExerciseId;
  if (!zone) {
    endDrag(event.currentTarget);
    return true;
  }
  event.preventDefault();
  const index = libraryDropIndex(zone, event.clientY);
  endDrag(event.currentTarget);
  onDrop(exerciseId, index);
  return true;
}

// dragend: the drag is over, dropped or not.
export function endBuilderLibraryDrag(event) {
  if (!draggedExerciseId && !event.currentTarget?.querySelector?.(`${PANEL_SELECTOR}.is-library-dragging`)) return false;
  endDrag(event.currentTarget);
  return true;
}
