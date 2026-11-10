// Design (header panels): the notifications and messages panels hang from their own button in the
// header (position: absolute; right: 0 for both, left: 0 for notifications on a phone). On a narrow
// window that put them past the edge: the 760 px messages panel was cut off on the left between
// 761 and about 940 px, and the notifications panel ran off the right edge of a phone (at 600 px it
// even widened the page). This keeps an open panel inside the window: it is moved sideways (and
// narrowed only if it is wider than the window) with the CSS `translate` property, which no other
// rule of these panels uses. A full-screen panel (position: fixed, messages on a phone) is left
// alone, and so is the athlete's app (not part of this change).
const MARGIN = 8;

export function fitPanelToViewport(panel, { margin = MARGIN, view = globalThis } = {}) {
  if (!panel?.style || typeof panel.getBoundingClientRect !== "function") return;
  panel.style.translate = "";
  panel.style.maxWidth = "";
  if (panel.hidden) return;
  const doc = view.document;
  if (doc?.body?.classList?.contains("athlete-mode")) return;
  if (view.getComputedStyle?.(panel).position === "fixed") return;
  const width = doc?.documentElement?.clientWidth || view.innerWidth;
  if (!width) return;
  let box = panel.getBoundingClientRect();
  if (box.width > width - 2 * margin) {
    panel.style.maxWidth = `${width - 2 * margin}px`;
    box = panel.getBoundingClientRect();
  }
  let shift = 0;
  if (box.right > width - margin) shift = width - margin - box.right;
  if (box.left + shift < margin) shift = margin - box.left;
  if (Math.abs(shift) >= 1) panel.style.translate = `${Math.round(shift)}px 0`;
  installResize(view);
}

// One window listener, installed on the first fit: a rotation or a resized window fits every open
// panel again.
let resizeInstalled = false;
function installResize(view) {
  if (resizeInstalled || typeof view.addEventListener !== "function") return;
  resizeInstalled = true;
  view.addEventListener("resize", () => {
    view.document?.querySelectorAll?.(".notification-panel, .message-panel").forEach((panel) => fitPanelToViewport(panel, { view }));
  }, { passive: true });
}
