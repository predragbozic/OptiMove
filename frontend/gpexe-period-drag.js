// P4: dragging across the days of the period chooser with a mouse or a pen. Two taps (or Enter on two days) do the same
// and are the visible control; a finger keeps scrolling the page, so touch never starts a drag. Local only.
import { clearPeriod, dragToDay, endDrag, pickDay } from "./gpexe-period-data.js";

const DAY = '[data-action="training-load-gpexe-period-day"]';
let drag = null;
let swallowClick = false;

// The click that ends a drag is not a tap: the period is already chosen.
export function takePeriodDragClick() {
  const swallow = swallowClick;
  swallowClick = false;
  return swallow;
}

export function bindPeriodDrag(root, render, doc = globalThis.document) {
  root.addEventListener("pointerdown", (event) => {
    swallowClick = false;
    if (event.pointerType === "touch" || event.button !== 0) return;
    const el = event.target?.closest?.(DAY);
    if (!el || el.getAttribute("aria-disabled") === "true") return;
    drag = { start: el.dataset.day, moved: false };
  });
  doc.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const el = doc.elementFromPoint?.(event.clientX, event.clientY)?.closest?.(DAY);
    if (!el || (!drag.moved && el.dataset.day === drag.start)) return;
    if (!drag.moved) {
      drag.moved = true;
      clearPeriod();
      pickDay(drag.start);
    }
    if (dragToDay(el.dataset.day)) render();
  });
  const end = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    endDrag();
    swallowClick = true;
    render();
  };
  doc.addEventListener("pointerup", end);
  doc.addEventListener("pointercancel", end);
}
