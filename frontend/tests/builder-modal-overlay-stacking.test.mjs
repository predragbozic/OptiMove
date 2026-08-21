import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// fix/copy-modal-behind-program-overlay: renderCopyPlanModal (builder-modals.js)
// - opened by "Copy" and "Assign to athlete" - wraps its content in
// .builder-modal-overlay. That class is also shared by a few Builder-page-only
// modals (structure/info pickers), so its z-index used to be tuned only for
// that flat page context (45, below the page's own sticky bits ~40-90).
// "Copy"/"Assign to athlete" can also be opened from INSIDE the Specific
// Program / Template preview overlay (.program-preview-overlay, z-index
// 1200) and its own info popup (.program-info-overlay, z-index 1250) - at
// z-index 45 the copy modal rendered fully behind both. It still appeared
// (fast - confirmed by direct timing of the underlying request) but was
// completely invisible and unclickable, since the still-open, full-viewport
// overlay above it intercepted every click. Reported live: "taj prozor
// ostaje u pozadini, vrlo brzo se pojavi ali ostaje u pozadini" ("Copy" felt
// like it hung, when it had actually already finished opening a modal no
// one could see or reach).
//
// This asserts the actual invariant that must hold - .builder-modal-overlay
// must outrank every overlay it can be opened from - via the real numbers in
// styles.css, not a hardcoded "must be 1300", so it stays correct even if
// those other overlays' z-indexes change later.
function readSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const cssSource = readSource("../styles.css");

function zIndexOf(css, selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `${selector} must exist in styles.css`);
  const block = css.slice(start, css.indexOf("}", start) + 1);
  const match = block.match(/z-index:\s*(\d+)/);
  assert.ok(match, `${selector} must declare a z-index`);
  return Number(match[1]);
}

test("styles.css: .builder-modal-overlay (Copy/Assign-to-athlete modal) stacks above .program-preview-overlay (Specific Program / Template preview)", () => {
  const modalZ = zIndexOf(cssSource, ".builder-modal-overlay {");
  const previewZ = zIndexOf(cssSource, ".program-preview-overlay {");
  assert.ok(modalZ > previewZ, `builder-modal-overlay (${modalZ}) must be above program-preview-overlay (${previewZ}), or Copy/Assign opened from inside a Specific Program renders invisibly behind it`);
});

test("styles.css: .builder-modal-overlay also stacks above .program-info-overlay (the preview's own info popup, the highest layer it can be opened alongside)", () => {
  const modalZ = zIndexOf(cssSource, ".builder-modal-overlay {");
  const infoZ = zIndexOf(cssSource, ".program-info-overlay {");
  assert.ok(modalZ > infoZ, `builder-modal-overlay (${modalZ}) must be above program-info-overlay (${infoZ})`);
});
