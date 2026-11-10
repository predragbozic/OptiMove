// Shared .om-tabs behaviour (design foundation, PR1). On a phone a tab row that does not fit
// scrolls sideways inside its own box; after a repaint the row starts at the left, so the
// active tab is brought into view horizontally, and data-fade marks the side(s) with more tabs
// (the CSS fades that edge). Only scrollLeft changes: the page itself never scrolls (no
// scrollIntoView, which would also move the page vertically). A row that fits (a computer,
// where the row wraps) is left alone.
export function fadeFor(row) {
  const more = row.scrollWidth - row.clientWidth;
  if (more <= 1) return "";
  const atStart = row.scrollLeft <= 1;
  const atEnd = row.scrollLeft >= more - 1;
  return atStart ? "end" : atEnd ? "start" : "both";
}

function markFade(row) {
  const fade = fadeFor(row);
  if (fade) row.setAttribute("data-fade", fade);
  else row.removeAttribute("data-fade");
}

// A width change (rotation, a resized window) can make a row fit or stop fitting without a
// scroll: one window listener, installed once, marks every row on screen again.
let resizeInstalled = false;
export function refreshTabFades(doc = globalThis.document) {
  doc?.querySelectorAll?.(".om-tabs").forEach(markFade);
}
function installResize() {
  if (resizeInstalled || typeof globalThis.addEventListener !== "function") return;
  resizeInstalled = true;
  globalThis.addEventListener("resize", () => refreshTabFades(), { passive: true });
}

export function revealActiveTab(root) {
  if (!root?.querySelectorAll) return;
  installResize();
  root.querySelectorAll(".om-tabs").forEach((row) => {
    const active = row.querySelector('.om-tab[aria-current="page"], .om-tab.is-active');
    if (active && row.scrollWidth > row.clientWidth) {
      const rowBox = row.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      const left = box.left - rowBox.left + row.scrollLeft;
      const right = left + box.width;
      if (left < row.scrollLeft) row.scrollLeft = Math.max(0, left - 8);
      else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth + 8;
    }
    markFade(row);
    // The row is new after every repaint (innerHTML), so the listener never piles up.
    row.addEventListener?.("scroll", () => markFade(row), { passive: true });
  });
}

// A shared .om-tabs row whose buttons are the app's own .tab buttons (the coach's athlete header,
// design A2): the current one says aria-current="page", every other one carries no aria-current.
export function markCurrentTab(tab, active) {
  if (!tab?.classList?.contains("om-tab")) return;
  if (active) tab.setAttribute("aria-current", "page");
  else tab.removeAttribute("aria-current");
}
