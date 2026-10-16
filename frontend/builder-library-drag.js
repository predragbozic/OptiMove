// Drag an exercise from the section editor's library onto its Added list -
// on a computer, with a mouse or trackpad. The browser's own drag and drop:
// a library card is draggable, the Added column takes the drop, and the
// exercise lands where it is dropped - one past every added exercise whose
// middle is above the pointer (dropIndexFor, the same rule as the reorder
// drag). Nothing is sent while dragging; on the drop the caller gets the
// exercise id and the zero-based position. On a phone or tablet a card
// does not drag (a long press would otherwise start the browser's drag and
// stop the page from scrolling); Add stays the way to add there.

import { dropIndexFor } from "./builder-item-drag.js";

export const LIBRARY_DRAG_TYPE = "application/x-optimove-exercise";
const CARD_SELECTOR = "[data-builder-library-drag]";
const ZONE_SELECTOR = ".builder-section-added";
const PANEL_SELECTOR = ".builder-section-panel";

// The id of the card being dragged, kept only to clean up after the drag:
// whether a drag is a library card's is read from the drag itself
// (isLibraryDrag), since the card can be re-rendered while it is dragged
// (the add confirmation repaints the results), and its dragend then never
// reaches the content.
let draggedExerciseId = "";

// Whether library cards are rendered draggable on this screen: only where
// the main pointer is a mouse or trackpad. A phone or tablet - also one
// with a pen or an extra trackpad - keeps Add, so a long press never
// starts the browser's drag there.
export function libraryDragAvailable() {
  if (!globalThis.matchMedia) return true;
  return globalThis.matchMedia("(pointer: fine)").matches && globalThis.matchMedia("(hover: hover)").matches;
}

// The added exercises the coach sees: the computer's form list or the
// phone cards, whichever one the screen shows.
function visibleItems(zone) {
  return [...zone.querySelectorAll("[data-drag-item]")].filter((item) => item.getClientRects().length > 0);
}

// Where an exercise dropped at `clientY` lands among the visible added ones;
// with none in view (an empty section, or one exercise open for editing)
// at the end.
export function libraryDropIndex(zone, clientY) {
  const items = visibleItems(zone);
  if (!items.length) return Number.MAX_SAFE_INTEGER;
  return dropIndexFor(clientY, items.map((item) => {
    const rect = item.getBoundingClientRect();
    return rect.top + rect.height / 2;
  }));
}

function isLibraryDrag(event) {
  return [...(event.dataTransfer?.types || [])].includes(LIBRARY_DRAG_TYPE);
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

function endDrag(root = globalThis.document) {
  draggedExerciseId = "";
  root?.querySelectorAll?.(`${PANEL_SELECTOR}.is-library-dragging`).forEach((panel) => panel.classList.remove("is-library-dragging"));
  clearMarks(root);
}

// Left over from a library drag whose end was not seen (see above).
function leftOver(root) {
  return Boolean(draggedExerciseId || root?.querySelector?.(`${PANEL_SELECTOR}.is-library-dragging, .is-library-drop-target`));
}

// dragstart on a library card. Returns true when the event was a card's.
export function startBuilderLibraryDrag(event, { isBlocked = () => false } = {}) {
  const card = event.target?.closest?.(CARD_SELECTOR);
  if (!card) return false;
  const exerciseId = card.dataset.exerciseId || "";
  // Nothing to drop on while the Added column is not on screen (a narrow
  // window shows the library and the Added list one at a time).
  const zone = card.closest(PANEL_SELECTOR)?.querySelector(ZONE_SELECTOR);
  if (!exerciseId || !event.dataTransfer || !libraryDragAvailable() || !zone?.getClientRects().length || isBlocked()) {
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
  if (!isLibraryDrag(event)) {
    // Another drag (a file, a selected text) is the browser's own.
    if (leftOver(event.currentTarget)) endDrag(event.currentTarget);
    return false;
  }
  const zone = event.target?.closest?.(ZONE_SELECTOR);
  if (!zone) {
    clearMarks(event.currentTarget);
    return true;
  }
  event.preventDefault();
  zone.closest(PANEL_SELECTOR)?.classList.add("is-library-dragging");
  event.dataTransfer.dropEffect = "copy";
  markDrop(zone, libraryDropIndex(zone, event.clientY));
  return true;
}

// dragleave: the marks go once the pointer is out of the Added column. A
// dragleave also comes from every element inside it the pointer passes,
// and the browser does not always say where the pointer went, so the
// column's own box decides.
export function leaveBuilderLibraryDrag(event) {
  if (!isLibraryDrag(event)) return false;
  const zone = event.target?.closest?.(ZONE_SELECTOR);
  if (!zone) return true;
  const box = zone.getBoundingClientRect();
  const inside = event.clientX > box.left && event.clientX < box.right && event.clientY > box.top && event.clientY < box.bottom;
  if (!inside) clearMarks(zone.parentElement || zone);
  return true;
}

// drop: the exercise and its position go to `onDrop`.
export function dropBuilderLibraryDrag(event, { onDrop }) {
  if (!isLibraryDrag(event)) {
    if (leftOver(event.currentTarget)) endDrag(event.currentTarget);
    return false;
  }
  const zone = event.target?.closest?.(ZONE_SELECTOR);
  const exerciseId = event.dataTransfer.getData(LIBRARY_DRAG_TYPE);
  if (!zone || !exerciseId) {
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
  if (!leftOver(event.currentTarget)) return false;
  endDrag(event.currentTarget);
  return true;
}

// A pointer that moves again means the drag is over: the browser sends no
// pointer events while it drags. Cleans up after a drag whose card was
// re-rendered and whose dragend therefore never came.
export function endStaleBuilderLibraryDrag() {
  if (!draggedExerciseId) return false;
  endDrag();
  return true;
}
