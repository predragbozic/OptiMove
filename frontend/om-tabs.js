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

export function revealActiveTab(root) {
  if (!root?.querySelectorAll) return;
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
