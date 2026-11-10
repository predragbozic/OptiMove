// Design (header panels): an open notifications or messages panel stays inside the window, the
// thread's column never grows past the panel, and the panels' controls are 44 px - a coach's
// screens only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { fitPanelToViewport } = await import("../panel-fit.js");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

// A fake window and panel: the panel's box is its anchored box moved by style.translate and capped
// by style.maxWidth, as a browser lays it out.
function world({ width = 390, left, boxWidth, position = "absolute", athlete = false, hidden = false }) {
  const panel = {
    hidden,
    style: { translate: "stale", maxWidth: "stale" },
    getBoundingClientRect() {
      const cap = parseFloat(this.style.maxWidth) || Infinity;
      const w = Math.min(boxWidth, cap);
      const shift = parseFloat(this.style.translate) || 0;
      // Anchored on the right edge (right: 0), so a narrower box keeps its right edge.
      const l = left + (boxWidth - w) + shift;
      return { left: l, right: l + w, width: w };
    },
  };
  const view = {
    document: { body: { classList: { contains: (c) => athlete && c === "athlete-mode" } }, documentElement: { clientWidth: width }, querySelectorAll: () => [panel] },
    innerWidth: 999,
    getComputedStyle: () => ({ position }),
    addEventListener() {},
  };
  return { panel, view };
}

test("a panel past the left edge (messages between 761 and about 940 px) moves right to the margin", () => {
  const { panel, view } = world({ width: 768, left: -144, boxWidth: 736 });
  fitPanelToViewport(panel, { view });
  assert.equal(panel.style.translate, "152px 0");
  assert.equal(panel.getBoundingClientRect().left, 8);
  assert.equal(panel.style.maxWidth, "");
});

test("a panel past the right edge (notifications on a phone) moves left to the margin", () => {
  const { panel, view } = world({ width: 390, left: 236, boxWidth: 314 });
  fitPanelToViewport(panel, { view });
  assert.equal(panel.style.translate, "-168px 0");
  assert.equal(panel.getBoundingClientRect().right, 382);
});

test("a panel wider than the window is narrowed to it, then placed at the margin", () => {
  const { panel, view } = world({ width: 300, left: 10, boxWidth: 360 });
  fitPanelToViewport(panel, { view });
  assert.equal(panel.style.maxWidth, "284px");
  const box = panel.getBoundingClientRect();
  assert.ok(box.left >= 8 && box.right <= 292, JSON.stringify(box));
});

test("a panel that fits, a hidden one, a full-screen one and the athlete's app are left as they are (stale shifts cleared)", () => {
  for (const options of [{ left: 600, boxWidth: 360, width: 1280 }, { left: -144, boxWidth: 736, width: 768, hidden: true }, { left: -144, boxWidth: 736, width: 768, position: "fixed" }, { left: -144, boxWidth: 736, width: 768, athlete: true }]) {
    const { panel, view } = world(options);
    fitPanelToViewport(panel, { view });
    assert.equal(panel.style.translate, "", JSON.stringify(options));
    assert.equal(panel.style.maxWidth, "", JSON.stringify(options));
  }
});

test("a panel without a box (a test's plain object) is left alone instead of throwing", () => {
  assert.doesNotThrow(() => fitPanelToViewport({ hidden: false }, { view: world({ left: 0, boxWidth: 10 }).view }));
  assert.doesNotThrow(() => fitPanelToViewport(null));
});

test("both panels are fitted after every render", () => {
  const notifications = readFileSync(new URL("../notifications.js", import.meta.url), "utf8");
  const messages = readFileSync(new URL("../messages.js", import.meta.url), "utf8");
  assert.match(notifications, /els\.notificationPanel\.innerHTML = renderNotificationPanelHtml\(\);\n\s+fitPanelToViewport\(els\.notificationPanel\);/);
  assert.match(messages, /fitPanelToViewport\(els\.messagePanel\);\n\s+wireComposer\(\);/);
});

test("the CSS block: a coach's only, the thread's column is bounded, long words wrap, 44 px controls and 16 px fields", () => {
  const from = css.indexOf("Design: the header panels (notifications, messages)");
  assert.ok(from > 0);
  const end = css.indexOf("\n/* =====", from + 10);
  const block = css.slice(css.lastIndexOf("/*", from), end > 0 ? end : undefined).replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...block.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(",").map((s) => s.trim())).filter(Boolean);
  assert.ok(selectors.length >= 8);
  for (const sel of selectors) assert.ok(sel.startsWith("body:not(.athlete-mode):not(.login-mode) "), sel);
  assert.match(block, /\.message-thread \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(block, /\.message-bubble p \{\s*overflow-wrap: anywhere;/);
  assert.match(block, /min-height: var\(--om-tap-target\);\s*font-size: 16px;/);
});
