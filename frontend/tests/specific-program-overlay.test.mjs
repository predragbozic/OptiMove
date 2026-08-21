import { test } from "node:test";
import assert from "node:assert/strict";

// Programs overhaul item 2: Specific Program detail as a real overlay.
// renderProgramRootHtml (program-view.js) is a pure function - these tests
// execute it directly and check the actual rendered markup, complementing
// the source-pattern-guard tests in athlete-mobile-navigation.test.mjs
// (which cover the app.js wiring: open/close handlers, handleAppBack/Escape
// cascades, and the CSS scroll-lock/mobile sizing - none of that is
// reachable from a pure-function test since app.js doesn't export its
// click handlers).
const { renderProgramRootHtml, renderProgramNodeOverlayHtml } = await import("../program-view.js");

function baseArgs(overrides = {}) {
  return {
    copyPlanModal: "",
    data: { rows: [{ id: "row-1" }, { id: "row-2" }] },
    groups: [{ id: "g1", name: "Block 1" }],
    isMicrocycle: false,
    program: { id: "program-1", name: "Strength Block" },
    renderNodeButton: (node) => `<button data-node="${node.id}"></button>`,
    renderPlanMoreMenu: (planId) => `<div data-more-menu="${planId}"></div>`,
    renderProgramDayCard: (node) => `<div data-day-card="${node.id}"></div>`,
    ...overrides,
  };
}

test("1. renders as a real dialog overlay (role=dialog, aria-modal), not inline content", () => {
  const html = renderProgramRootHtml(baseArgs());
  assert.match(html, /class="program-preview-overlay specific-program-overlay"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /aria-label="Strength Block"/);
});

test("2. provides two independent ways to close: the backdrop button and the header close button, both wired to specific-program-close", () => {
  const html = renderProgramRootHtml(baseArgs());
  const closeButtons = html.match(/data-action="specific-program-close"/g) || [];
  assert.equal(closeButtons.length, 2, "backdrop + header close button");
  assert.match(html, /class="program-preview-backdrop" type="button" data-action="specific-program-close"/);
});

test("3. the program's own name and item count are shown in the overlay header, escaped", () => {
  const html = renderProgramRootHtml(baseArgs({ program: { id: "p2", name: "<Legs & Core>" } }));
  assert.match(html, /&lt;Legs &amp; Core&gt;/);
  assert.match(html, /<span class="item-badge">2 items<\/span>/);
});

test("4. the more-menu (Edit/Copy/Delete) is still rendered for the open program, exactly as before the overlay change", () => {
  const html = renderProgramRootHtml(baseArgs());
  assert.match(html, /data-more-menu="program-1"/);
});

test("5. microcycle programs render the node grid; day-group programs render the day-card grid - unchanged branching", () => {
  const microHtml = renderProgramRootHtml(baseArgs({ isMicrocycle: true }));
  assert.match(microHtml, /class="node-grid"/);
  assert.doesNotMatch(microHtml, /class="program-day-grid"/);

  const dayHtml = renderProgramRootHtml(baseArgs({ isMicrocycle: false }));
  assert.match(dayHtml, /class="program-day-grid"/);
  assert.doesNotMatch(dayHtml, /class="node-grid"/);
});

test("6. the copy-plan modal markup (if any) renders outside the overlay dialog, not nested inside it", () => {
  const html = renderProgramRootHtml(baseArgs({ copyPlanModal: '<div class="builder-modal-overlay" data-test-marker="copy-modal"></div>' }));
  const overlayCloseIndex = html.lastIndexOf("</section>");
  const copyModalIndex = html.indexOf("data-test-marker=\"copy-modal\"");
  assert.ok(copyModalIndex > overlayCloseIndex, "the copy-plan modal must sit after the specific-program-modal's own closing tag, not nested inside it");
});

// fix/specific-program-overlay-node-scroll: drilling into a node (domain/
// category/section) from inside the Specific Program overlay used to swap
// els.content for the bare, non-modal .node-detail-panel markup - dropping
// this overlay/backdrop/modal wrapper (and its own scrollable
// .program-preview-body) entirely, while body.specific-program-open kept
// page scroll locked. Reported live as "scroll doesn't work" and, once
// deeper, "can't see the exercises" / "it's not there" - the content was
// there, just outside any scrollable container. renderProgramNodeOverlayHtml
// is the fix: the exact same overlay chrome as renderProgramRootHtml, with
// a drilled-in node's own detail markup as the body instead of the day grid.
function nodeOverlayArgs(overrides = {}) {
  return {
    nodeDetailHtml: '<section class="node-detail-panel" data-test-marker="node-detail"><div class="node-detail-body">exercises here</div></section>',
    program: { id: "program-1", name: "Strength Block" },
    renderPlanMoreMenu: (planId) => `<div data-more-menu="${planId}"></div>`,
    ...overrides,
  };
}

test("7. renderProgramNodeOverlayHtml wraps a drilled-in node's detail markup in the SAME overlay/backdrop/modal chrome as the root view", () => {
  const html = renderProgramNodeOverlayHtml(nodeOverlayArgs());
  assert.match(html, /class="program-preview-overlay specific-program-overlay"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /class="program-preview-body"/);
  assert.match(html, /data-test-marker="node-detail"/);
  assert.match(html, /aria-label="Strength Block"/, "the modal keeps identifying itself by the open program's name while drilled into a node, not the node's own label");
});

test("8. renderProgramNodeOverlayHtml still offers both close affordances (backdrop + header) and the more-menu, exactly like the root view", () => {
  const html = renderProgramNodeOverlayHtml(nodeOverlayArgs());
  const closeButtons = html.match(/data-action="specific-program-close"/g) || [];
  assert.equal(closeButtons.length, 2, "backdrop + header close button");
  assert.match(html, /data-more-menu="program-1"/);
});

test("9. the node detail's own body sits inside .program-preview-body (the overlay's single scroll container), not as a sibling of it", () => {
  const html = renderProgramNodeOverlayHtml(nodeOverlayArgs());
  const bodyOpenIndex = html.indexOf('class="program-preview-body"');
  const nodeDetailIndex = html.indexOf("data-test-marker=\"node-detail\"");
  const bodyCloseIndex = html.indexOf("</section>", bodyOpenIndex);
  assert.ok(bodyOpenIndex >= 0 && nodeDetailIndex > bodyOpenIndex && nodeDetailIndex < bodyCloseIndex, "the node-detail markup must be nested inside .program-preview-body so it inherits its overflow:auto scrolling");
});
