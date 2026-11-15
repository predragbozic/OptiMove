// P4: dragging across the days of the period chooser with a mouse or a pen. Two taps (or Enter on two days) do the same
// and are the visible control; a finger keeps scrolling the page, so touch never starts a drag. Local only.
import { clearPeriod, dragToDay, endDrag, pickDay } from "./gpexe-period-data.js";
import { ensurePeriodData } from "./gpexe-import-data.js";

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
    if (event.buttons === 0) { end(); return; }
    const el = doc.elementFromPoint?.(event.clientX, event.clientY)?.closest?.(DAY);
    if (!el || (!drag.moved && el.dataset.day === drag.start)) return;
    if (!drag.moved) {
      drag.moved = true;
      clearPeriod();
      pickDay(drag.start);
    }
    if (dragToDay(el.dataset.day)) render();
  });
  function end() {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    endDrag();
    // Only the click that ends this drag is swallowed: a release away from the days leaves no click to take it, and a
    // later keyboard tap must count.
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
    render();
    // #540: older dragged days the list does not hold are read on their own.
    void ensurePeriodData(render);
  }
  doc.addEventListener("pointerup", end);
  doc.addEventListener("pointercancel", end);
}

// The open phone sheet is modal (aria-modal): Tab and Shift+Tab stay inside it, as in the icon picker (icon-picker.js).
export function trapPeriodSheetTab(event, doc = globalThis.document) {
  if (event?.key !== "Tab") return false;
  const sheet = doc?.querySelector?.(".imports-help.is-open") || doc?.querySelector?.(".imports-period.is-open");
  if (!sheet) return false;
  const controls = Array.from(sheet.querySelectorAll("button:not(:disabled)")).filter((b) => b.getAttribute("aria-disabled") !== "true");
  if (!controls.length) return false;
  const at = controls.indexOf(doc.activeElement);
  const inside = sheet.contains(doc.activeElement);
  if (event.shiftKey && (at <= 0)) {
    event.preventDefault();
    controls.at(-1).focus();
    return true;
  }
  if (!event.shiftKey && (at === controls.length - 1 || !inside)) {
    event.preventDefault();
    controls[0].focus();
    return true;
  }
  return false;
}
