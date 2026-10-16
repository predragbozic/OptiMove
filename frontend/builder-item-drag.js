// Drag-to-reorder for the exercises added to a Builder section (desktop form
// list and the mobile compact cards). Pointer Events with pointer capture on
// the grip, so one code path serves mouse, pen and touch; the grip has
// `touch-action: none` (styles.css) so a touch drag never scrolls the page
// instead. Nothing is sent while dragging: on release the caller gets the
// item id and its new zero-based position (onDrop), and the up/down buttons
// stay for keyboard and screen-reader users.

const START_THRESHOLD_PX = 4;
const EDGE_ZONE_PX = 56;
const EDGE_SCROLL_MAX_PX = 18;

// The position the dragged item takes among the OTHER items: one past every
// item whose vertical middle is above `probeY`.
export function dropIndexFor(probeY, otherMidpoints) {
  return otherMidpoints.filter((middle) => middle < probeY).length;
}

// The point of the dragged item that decides where it lands: its bottom
// edge while it moves down, its top edge while it moves up. A neighbour
// then gives way once the dragged item covers half of it - the same
// distance in both directions. (The pointer itself would not do: the grip
// sits near the item's top, so going down it would need almost a whole
// item more travel than going up.)
export function dragProbeY(box, offset) {
  return offset > 0 ? box.bottom : box.top;
}

// Pixels to scroll per frame for a pointer at `y` in a visible band: zero
// outside its edge zones, faster the deeper the pointer is in a zone.
export function edgeScrollStep(y, band, zone = EDGE_ZONE_PX, max = EDGE_SCROLL_MAX_PX) {
  if (y < band.top + zone) return -Math.ceil(max * Math.min(1, (band.top + zone - y) / zone));
  if (y > band.bottom - zone) return Math.ceil(max * Math.min(1, (y - (band.bottom - zone)) / zone));
  return 0;
}

function scrollParentOf(element) {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

// The part of the scroller the list is really visible in: on phones the
// section editor's header is sticky at the top and the Added bar at the
// bottom, and an edge zone under them could never be reached. A scroller
// inside another one (the landscape Added column inside the editor) shows
// only where every scrolling ancestor and the screen show it - its own box
// can reach below the screen while the editor is not scrolled yet.
export function visibleBand(scroller) {
  const box = scroller.getBoundingClientRect();
  let { top, bottom } = box;
  const head = scroller.querySelector?.(".builder-section-panel-head");
  if (head && getComputedStyle(head).position === "sticky") top = Math.max(top, head.getBoundingClientRect().bottom);
  const bar = scroller.querySelector?.(".builder-mobile-sticky-bar");
  if (bar && getComputedStyle(bar).display !== "none") bottom = Math.min(bottom, bar.getBoundingClientRect().top);
  const outer = scrollParentOf(scroller);
  if (outer) {
    const band = visibleBand(outer);
    top = Math.max(top, band.top);
    bottom = Math.min(bottom, band.bottom);
  }
  const screenHeight = globalThis.visualViewport?.height || globalThis.innerHeight;
  if (screenHeight) bottom = Math.min(bottom, screenHeight);
  return { top: Math.max(top, 0), bottom };
}

function clearDropMarks(items) {
  items.forEach((item) => item.classList.remove("is-drop-before", "is-drop-after"));
}

// Starts a drag from a pointerdown on a [data-builder-item-drag] grip.
// Returns true when the event started one (the caller then stops handling it).
export function startBuilderItemDrag(event, { isBlocked = () => false, onDrop }) {
  const handle = event.target?.closest?.("[data-builder-item-drag]");
  // A real, primary pointer only: the Tests calendar's normalized touchstart
  // object carries no pointerId and must not start a second drag, and a
  // second finger must not start another one.
  if (!handle || typeof event.pointerId !== "number" || event.isPrimary === false || event.button > 0 || isBlocked()) return false;
  const itemEl = handle.closest("[data-drag-item]");
  const listEl = itemEl?.parentElement;
  if (!itemEl || !listEl) return false;
  const siblings = () => [...listEl.children].filter((child) => child.matches("[data-drag-item]"));
  const fromIndex = siblings().indexOf(itemEl);
  if (fromIndex < 0) return false;

  event.preventDefault();
  const scroller = scrollParentOf(listEl);
  const startY = event.clientY;
  const startScroll = scroller?.scrollTop || 0;
  const raf = globalThis.requestAnimationFrame?.bind(globalThis);
  const caf = globalThis.cancelAnimationFrame?.bind(globalThis);
  let dragging = false;
  let targetIndex = fromIndex;
  let pointerY = startY;
  let frame = 0;
  try { handle.setPointerCapture(event.pointerId); } catch { /* not capturable */ }

  const others = () => siblings().filter((child) => child !== itemEl);
  // Places the dragged item under the pointer and marks where it would land.
  const follow = () => {
    const scrolled = (scroller?.scrollTop || 0) - startScroll;
    const offset = pointerY - startY + scrolled;
    itemEl.style.transform = `translateY(${offset}px)`;
    const rest = others();
    targetIndex = dropIndexFor(dragProbeY(itemEl.getBoundingClientRect(), offset), rest.map((child) => {
      const rect = child.getBoundingClientRect();
      return rect.top + rect.height / 2;
    }));
    clearDropMarks(rest);
    if (rest.length) {
      if (targetIndex < rest.length) rest[targetIndex].classList.add("is-drop-before");
      else rest[rest.length - 1].classList.add("is-drop-after");
    }
  };
  // While the pointer rests in an edge zone the list keeps scrolling, one
  // step per frame, without waiting for the next pointermove.
  const autoScroll = () => {
    frame = 0;
    if (!dragging || !scroller || !itemEl.isConnected) return;
    const step = edgeScrollStep(pointerY, visibleBand(scroller));
    if (!step) return;
    const before = scroller.scrollTop;
    scroller.scrollTop += step;
    if (scroller.scrollTop === before) return;
    follow();
    frame = raf ? raf(autoScroll) : 0;
  };
  const move = (moveEvent) => {
    if (!itemEl.isConnected) return finish(false);
    pointerY = moveEvent.clientY;
    if (!dragging) {
      if (Math.abs(pointerY - startY) < START_THRESHOLD_PX) return;
      dragging = true;
      itemEl.classList.add("is-dragging");
      listEl.classList.add("is-reordering");
    }
    moveEvent.preventDefault();
    follow();
    if (scroller && !frame) {
      if (raf) frame = raf(autoScroll);
      else autoScroll();
    }
  };
  const finish = (commit) => {
    if (frame && caf) caf(frame);
    frame = 0;
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", cancel);
    handle.removeEventListener("lostpointercapture", cancel);
    itemEl.style.transform = "";
    itemEl.classList.remove("is-dragging");
    listEl.classList.remove("is-reordering");
    clearDropMarks(siblings());
    const wasDragging = dragging;
    dragging = false;
    if (commit && wasDragging && itemEl.isConnected && targetIndex !== fromIndex) onDrop(handle.dataset.itemId, targetIndex);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", cancel);
  handle.addEventListener("lostpointercapture", cancel);
  return true;
}
