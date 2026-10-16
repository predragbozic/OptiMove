// Drag-to-reorder for the exercises added to a Builder section (desktop form
// list and the mobile compact cards). Pointer Events with pointer capture on
// the grip, so one code path serves mouse, pen and touch; the grip has
// `touch-action: none` (styles.css) so a touch drag never scrolls the page
// instead. Nothing is sent while dragging: on release the caller gets the
// item id and its new zero-based position (onDrop), and the up/down buttons
// stay for keyboard and screen-reader users.

const START_THRESHOLD_PX = 4;
const EDGE_SCROLL_PX = 48;
const EDGE_SCROLL_STEP_PX = 14;

// The position the dragged item takes among the OTHER items: one past every
// item whose vertical middle is above the pointer.
export function dropIndexFor(pointerY, otherMidpoints) {
  return otherMidpoints.filter((middle) => middle < pointerY).length;
}

function scrollParentOf(element) {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

function clearDropMarks(items) {
  items.forEach((item) => item.classList.remove("is-drop-before", "is-drop-after"));
}

// Starts a drag from a pointerdown on a [data-builder-item-drag] grip.
// Returns true when the event started one (the caller then stops handling it).
export function startBuilderItemDrag(event, { isBlocked = () => false, onDrop }) {
  const handle = event.target?.closest?.("[data-builder-item-drag]");
  if (!handle || event.button > 0 || isBlocked()) return false;
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
  let dragging = false;
  let targetIndex = fromIndex;
  try { handle.setPointerCapture(event.pointerId); } catch { /* synthetic event */ }

  const others = () => siblings().filter((child) => child !== itemEl);
  const move = (moveEvent) => {
    if (!itemEl.isConnected) return finish(false);
    const scrolled = (scroller?.scrollTop || 0) - startScroll;
    const offset = moveEvent.clientY - startY + scrolled;
    if (!dragging) {
      if (Math.abs(moveEvent.clientY - startY) < START_THRESHOLD_PX) return;
      dragging = true;
      itemEl.classList.add("is-dragging");
      listEl.classList.add("is-reordering");
    }
    moveEvent.preventDefault();
    itemEl.style.transform = `translateY(${offset}px)`;
    const rest = others();
    targetIndex = dropIndexFor(moveEvent.clientY, rest.map((child) => {
      const rect = child.getBoundingClientRect();
      return rect.top + rect.height / 2;
    }));
    clearDropMarks(rest);
    if (rest.length) {
      if (targetIndex < rest.length) rest[targetIndex].classList.add("is-drop-before");
      else rest[rest.length - 1].classList.add("is-drop-after");
    }
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      if (moveEvent.clientY < box.top + EDGE_SCROLL_PX) scroller.scrollTop -= EDGE_SCROLL_STEP_PX;
      else if (moveEvent.clientY > box.bottom - EDGE_SCROLL_PX) scroller.scrollTop += EDGE_SCROLL_STEP_PX;
    }
  };
  const finish = (commit) => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", cancel);
    itemEl.style.transform = "";
    itemEl.classList.remove("is-dragging");
    listEl.classList.remove("is-reordering");
    clearDropMarks(siblings());
    if (commit && dragging && itemEl.isConnected && targetIndex !== fromIndex) onDrop(handle.dataset.itemId, targetIndex);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", cancel);
  return true;
}
