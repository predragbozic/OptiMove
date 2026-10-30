// Sideways swipes on #content (app.js, handleHorizontalSwipe): between the
// exercises of a section in an exercise's detail, between the sibling nodes
// of a program's tree, and between weeks.

// The program tree and the weeks: as they have always been.
export const TREE_SWIPE = Object.freeze({ minDistance: 86, minVelocity: 0.28, axisRatio: 1.8 });

// An exercise's detail: only a clear, deliberate swipe changes the exercise
// (owner, 2026-10-29: a scroll of the detail and a scroll of its strip of
// other exercises changed it too easily).
// - Sideways only: a movement up or down scrolls the detail and never changes
//   the exercise.
// - At least 120 px and 30 % of the screen's width (120 px on any phone, more
//   on a tablet): a third of a phone's width is a stroke made on purpose,
//   well beyond a finger sliding while it scrolls.
// - At least 2.5 times as far sideways as up or down: a scroll that drifts
//   sideways is not a swipe.
// - At least 0.3 px/ms (120 px in 0.4 s): a swipe, not a slow drag.
// - Nothing scrolled meanwhile (the detail, the page, a pinch-zoomed view),
//   one finger only, and never from the strip of other exercises, which
//   scrolls sideways under the finger and opens an exercise only on a tap.
export const DETAIL_SWIPE = Object.freeze({ minDistance: 120, minWidthShare: 0.3, minVelocity: 0.3, axisRatio: 2.5 });

// A scroll position that moved by less than this is a rounding, not a scroll.
const SCROLL_TOLERANCE = 2;

// Where a swipe may start. The media viewer, calendars, the week picker and
// lists that scroll sideways keep the finger for themselves, and so does a
// dialog over the detail (the editor, its frame slider included; tags; a
// Builder modal): a drag in it never moves or closes the exercise behind.
export function isSwipeArea(target, { mediaOpen = false } = {}) {
  if (mediaOpen) return false;
  if (target.closest(".calendar-grid, .week-selector, .week-calendar-picker, .program-day-grid, .exercise-list, .tests-calendar, .exercise-sibling-strip")) return false;
  if (target.closest(".exercise-editor-overlay, .exercise-tag-overlay, .builder-modal-overlay")) return false;
  return Boolean(target.closest(".exercise-detail, .panel, .node-grid"));
}

// The decision for one finished touch: 1 (next), -1 (previous) or 0 (none).
export function swipeDirection(gesture, touch, { now = Date.now(), view = globalThis } = {}) {
  if (!gesture || gesture.cancelled) return 0;
  const deltaX = touch.clientX - gesture.startX;
  const deltaY = touch.clientY - gesture.startY;
  const elapsed = Math.max(1, now - gesture.startTime);
  const velocity = Math.abs(deltaX) / elapsed;
  if (gesture.detail) {
    const width = view.innerWidth || 0;
    const distance = Math.max(DETAIL_SWIPE.minDistance, width * DETAIL_SWIPE.minWidthShare);
    if (Math.abs(deltaX) < distance || velocity < DETAIL_SWIPE.minVelocity || Math.abs(deltaX) < Math.abs(deltaY) * DETAIL_SWIPE.axisRatio) return 0;
    if (scrolledSince(gesture.scroll, view)) return 0;
    return deltaX < 0 ? 1 : -1;
  }
  if (Math.abs(deltaX) < TREE_SWIPE.minDistance || velocity < TREE_SWIPE.minVelocity || Math.abs(deltaX) < Math.abs(deltaY) * TREE_SWIPE.axisRatio) return 0;
  return deltaX < 0 ? 1 : -1;
}

// Every scroll position the finger could move: the elements from the touched
// one up to the page, the page itself and a pinch-zoomed view.
function scrollSnapshot(target, view) {
  const elements = [];
  for (let element = target; element; element = element.parentElement) elements.push([element, element.scrollLeft, element.scrollTop]);
  const viewport = view.visualViewport;
  return { elements, page: [view.scrollX || 0, view.scrollY || 0], viewport: viewport ? [viewport.offsetLeft, viewport.offsetTop, viewport.scale] : null };
}

function scrolledSince(snapshot, view) {
  if (!snapshot) return false;
  const moved = (now, before) => Math.abs(now - before) >= SCROLL_TOLERANCE;
  if (snapshot.elements.some(([element, left, top]) => moved(element.scrollLeft, left) || moved(element.scrollTop, top))) return true;
  if (moved(view.scrollX || 0, snapshot.page[0]) || moved(view.scrollY || 0, snapshot.page[1])) return true;
  const viewport = view.visualViewport;
  if (!snapshot.viewport || !viewport) return false;
  return moved(viewport.offsetLeft, snapshot.viewport[0]) || moved(viewport.offsetTop, snapshot.viewport[1]) || viewport.scale !== snapshot.viewport[2];
}

// The touchstart / touchend listeners of #content. `onSwipe(direction)`
// gets 1 or -1; whether an exercise's detail is open is read from `content`.
export function createContentSwipe({ content, onSwipe, isMediaOpen = () => false, view = globalThis }) {
  let gesture = null;
  return {
    start(event) {
      const fingers = event.touches?.length || 1;
      // A second finger (a pinch), wherever it lands, is never a swipe of the detail.
      if (gesture?.detail && fingers > 1) {
        gesture = { cancelled: true, detail: true };
        return;
      }
      if (!isSwipeArea(event.target, { mediaOpen: isMediaOpen() })) return;
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      const detail = Boolean(content.querySelector(".exercise-detail"));
      if (detail && fingers > 1) {
        gesture = { cancelled: true, detail };
        return;
      }
      gesture = {
        startX: touch.clientX,
        startY: touch.clientY,
        startTime: Date.now(),
        detail,
        scroll: detail ? scrollSnapshot(event.target, view) : null,
      };
    },
    end(event) {
      if (!isSwipeArea(event.target, { mediaOpen: isMediaOpen() })) return;
      const touch = event.changedTouches?.[0];
      if (!touch || !gesture) return;
      const direction = swipeDirection(gesture, touch, { view });
      if (gesture.detail) gesture = null;
      if (direction) onSwipe(direction);
    },
  };
}
