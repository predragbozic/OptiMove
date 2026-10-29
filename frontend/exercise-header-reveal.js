// Exercise Library, at every width: the app's top bar and the library's
// search and filters (#viewToolbar) scroll away with the list as before, and
// a short pull back up brings both back at once, pinned to the top of the
// screen over the list; going on down hides them again (owner, 2026-10-29: the
// header had to be scrolled back to from wherever the list was). At the very
// top of the page nothing changes. Only while the Exercise Library is open:
// app.js's renderTabs() calls sync() on every change of screen.
//
// Pinning is position: sticky (styles.css, body.exercise-header-pinned): both
// keep their place in the page, so the list never moves when they come or go.

// A short, deliberate pull up: more than the few pixels a finger drifts back
// as it lifts at the end of a scroll down, less than a third of a fingertip's
// width, so one small upward stroke is always enough.
export const HEADER_REVEAL_DISTANCE = 16;
// Going on down hides it again; a smaller distance, so reading on is never
// held up, and still above the jitter of a finger resting on the screen.
export const HEADER_HIDE_DISTANCE = 8;
// The slide in styles.css (180 ms), then the header goes back to its place.
const HIDE_SETTLE_MS = 200;

const PINNED_CLASS = "exercise-header-pinned";

export function installExerciseHeaderReveal({ view = window, isActive }) {
  const doc = view.document;
  const body = doc.body;
  let pinned = false;
  let shown = false;
  let lastY = scrollY();
  let upRun = 0;
  let downRun = 0;
  let hideTimer = 0;
  // Where the header sits in the page, measured before it is pinned.
  let slot = null;

  function scrollY() {
    return view.scrollY || doc.documentElement.scrollTop || 0;
  }

  function parts() {
    return { topbar: doc.querySelector(".workspace > .topbar"), toolbar: doc.getElementById("viewToolbar") };
  }

  function reducedMotion() {
    return Boolean(view.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  }

  function setVar(name, px) {
    body.style.setProperty(name, `${Math.round(px * 100) / 100}px`);
  }

  // Open "More filters" makes the search row taller than a pinned header can
  // be: it stays in the page, as before, and is never pinned over the list.
  function filtersOpen() {
    return Boolean(parts().toolbar?.querySelector("details[open]"));
  }

  // Never hidden while it is in use: typing in the search (or another text
  // field of it), the menu, or a panel of the top bar open. A button or a
  // tick box keeps the focus after a tap, and does not hold it.
  function inUse() {
    const { topbar, toolbar } = parts();
    const active = doc.activeElement;
    const typing = active?.matches?.('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), textarea');
    if (typing && (topbar?.contains(active) || toolbar?.contains(active))) return true;
    if (body.classList.contains("mobile-nav-open")) return true;
    return Boolean(topbar?.querySelector(".workspace-panel:not([hidden]), .notification-panel:not([hidden])"));
  }

  function reveal() {
    const { topbar, toolbar } = parts();
    if (!topbar || !toolbar) return;
    clearTimeout(hideTimer);
    if (!pinned) {
      const top = topbar.getBoundingClientRect();
      const bar = toolbar.getBoundingClientRect();
      slot = { pageTop: top.top + scrollY(), height: bar.bottom - top.top };
      setVar("--exercise-header-toolbar-top", bar.top - top.top);
      setVar("--exercise-header-gap", Math.max(0, bar.top - top.bottom));
      // It starts where it is: in its own place while part of it is still in
      // view, else just above the screen - and slides down from there.
      setVar("--exercise-header-shift", Math.max(top.top, -slot.height));
      body.classList.add(PINNED_CLASS);
      pinned = true;
      // The start position is applied before the slide begins.
      topbar.getBoundingClientRect();
    }
    shown = true;
    setVar("--exercise-header-shift", 0);
  }

  function hide() {
    shown = false;
    // It slides up to where it stands in the page (out of the screen when the
    // list has scrolled past it), then goes back into it.
    const inPage = slot ? Math.max(0, scrollY() - slot.pageTop) : 0;
    setVar("--exercise-header-shift", -Math.min(inPage, slot?.height || 0));
    clearTimeout(hideTimer);
    if (reducedMotion()) unpin();
    else hideTimer = setTimeout(unpin, HIDE_SETTLE_MS);
  }

  function unpin() {
    clearTimeout(hideTimer);
    pinned = false;
    shown = false;
    slot = null;
    body.classList.remove(PINNED_CLASS);
    for (const name of ["--exercise-header-shift", "--exercise-header-toolbar-top", "--exercise-header-gap"]) body.style.removeProperty(name);
  }

  function onScroll() {
    if (!isActive()) {
      if (pinned) unpin();
      lastY = scrollY();
      upRun = downRun = 0;
      return;
    }
    const y = scrollY();
    // At the top the header is in its own place, exactly as before.
    if (y <= 0) {
      if (pinned) unpin();
      lastY = 0;
      upRun = downRun = 0;
      return;
    }
    // The bounce past the end of the page (iOS) is not a pull up.
    const end = Math.max(0, doc.documentElement.scrollHeight - view.innerHeight);
    if (y > end) {
      lastY = end;
      upRun = downRun = 0;
      return;
    }
    const delta = y - lastY;
    lastY = y;
    if (delta < 0) {
      upRun -= delta;
      downRun = 0;
    } else if (delta > 0) {
      downRun += delta;
      upRun = 0;
    }
    if (!shown && upRun >= HEADER_REVEAL_DISTANCE && !filtersOpen()) reveal();
    else if (shown && downRun >= HEADER_HIDE_DISTANCE && !inUse()) hide();
  }

  // A field of the header taking the focus while it is sliding away keeps it.
  function onFocusIn(event) {
    if (!pinned || shown || !isActive()) return;
    const { topbar, toolbar } = parts();
    if (topbar?.contains(event.target) || toolbar?.contains(event.target)) reveal();
  }

  // "More filters" opened in the pinned header: the header goes back to its
  // place in the page with the page brought to it, so it is where it was on
  // the screen and the open filters can be scrolled through.
  function onToggle(event) {
    if (!pinned || !event.target?.open || !parts().toolbar?.contains(event.target)) return;
    const pageTop = slot?.pageTop || 0;
    unpin();
    view.scrollTo?.(0, pageTop);
    lastY = scrollY();
    upRun = downRun = 0;
  }

  view.addEventListener("scroll", onScroll, { passive: true });
  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("toggle", onToggle, true);

  return {
    // Called on every change of screen: off the Exercise Library the header
    // is back in its place at once.
    sync() {
      if (!isActive() && pinned) unpin();
      lastY = scrollY();
      upRun = downRun = 0;
    },
    destroy() {
      unpin();
      view.removeEventListener("scroll", onScroll);
      doc.removeEventListener("focusin", onFocusIn);
      doc.removeEventListener("toggle", onToggle, true);
    },
  };
}
