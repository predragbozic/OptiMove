import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Builder horizontal-scroll-reset fix: renderBuilder() replaces
// els.content's entire innerHTML on every add/edit of a block, domain,
// category, or section, which destroys and recreates .builder-block-grid
// (the horizontally-scrolling row of block columns) - resetting scrollLeft
// to 0 with no DOM state left to preserve it from. Real jsdom (not the
// fakeElement/document.querySelector stub other builder tests use) because
// this specifically needs real scrollLeft get/set and querySelector
// behavior on a real element tree, which a stub can't reproduce.
//
// Each test uses its own plan id (and block ids namespaced to that plan).
// builder-view.js's lastRenderedPlanId/lastRenderedBlockIds bookkeeping is
// module-level by design (see the comment above captureBuilderScrollState in
// builder-view.js for why), so it persists across tests in this file - a
// distinct plan id per test makes every test's first render land on the
// "different plan than whatever came before" branch, exactly like a coach
// actually opening this plan for the first time, instead of accidentally
// inheriting bookkeeping left over from a previous test.

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="apiStatus"></div>
  <div id="screenTitle"></div>
  <div id="contextLabel"></div>
  <div id="athleteList"></div>
  <input id="athleteSearch">
  <button id="athletesToggle"></button>
  <button id="railToggle"></button>
  <button id="mobileNavToggle"></button>
  <div id="mobileNavBackdrop"></div>
  <button id="calendarToggle"></button>
  <div id="viewToolbar"></div>
  <div id="content"></div>
  <div id="mediaModal"></div>
  <div id="mediaTitle"></div>
  <div id="mediaBody"></div>
  <button id="signOutButton"></button>
  <button id="notificationToggle"></button>
  <div id="notificationPanel"></div>
  <button id="messageToggle"></button>
  <div id="messagePanel"></div>
  <button id="workspaceToggle"></button>
  <div id="workspacePanel"></div>
  <div id="connectionIndicator"></div>
  <div id="exitConfirmModal"></div>
</body></html>`);

globalThis.window = dom.window;
globalThis.document = dom.window.document;
// jsdom implements neither requestAnimationFrame nor scrollIntoView/layout -
// polyfill exactly what the fix under test needs.
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(options) {
  this.__scrolledIntoView = options;
};

const { els } = await import("../dom.js");
const { state, emptyBuilderState } = await import("../state.js");
const { renderBuilder } = await import("../builder-view.js");

function minimalBlock(id, index, extra = {}) {
  return { id, index, name: "", date: null, note: "", sessions: [], ...extra };
}

function minimalDraft(planId, blocks) {
  return { plan: { id: planId, athleteName: "Test Athlete", isTemplate: false }, batch: null, blocks };
}

function grid() {
  return els.content.querySelector(".builder-block-grid");
}

function waitForRestore() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  state.builder = emptyBuilderState();
  state.athletes = [];
});

test("1. editing a block (same block count) restores the exact prior scrollLeft", async () => {
  state.builder.draft = minimalDraft("plan-t1", [minimalBlock("t1-b1", 1), minimalBlock("t1-b2", 2)]);
  renderBuilder();
  await waitForRestore();
  grid().scrollLeft = 240;

  // "edit" a block: same ids, same count, just a name change - what
  // setBuilderDraft(await queuedBuilderApi(...)) does before renderBuilder()
  // is called for an update-block/update-node action.
  state.builder.draft = minimalDraft("plan-t1", [minimalBlock("t1-b1", 1, { name: "Renamed" }), minimalBlock("t1-b2", 2)]);
  renderBuilder();
  await waitForRestore();

  assert.equal(grid().scrollLeft, 240, "editing must not reset the horizontal scroll position");
});

test("2. adding a domain/category/section (block count unchanged) also restores the exact prior scrollLeft", async () => {
  // Adding a node nests inside an existing block's DOM subtree - it never
  // changes .builder-block-grid's own children, so this must behave exactly
  // like a same-block-count edit (test 1), not like a new block being
  // appended (test 3).
  state.builder.draft = minimalDraft("plan-t2", [minimalBlock("t2-b1", 1), minimalBlock("t2-b2", 2)]);
  renderBuilder();
  await waitForRestore();
  grid().scrollLeft = 180;

  state.builder.draft = minimalDraft("plan-t2", [minimalBlock("t2-b1", 1), minimalBlock("t2-b2", 2)]); // same blocks; only nested content differs in practice
  renderBuilder();
  await waitForRestore();

  assert.equal(grid().scrollLeft, 180, "adding a domain/category/section must not reset the horizontal scroll position");
});

test("3. adding a new block scrolls it minimally into view instead of restoring the old scrollLeft", async () => {
  state.builder.draft = minimalDraft("plan-t3", [minimalBlock("t3-b1", 1), minimalBlock("t3-b2", 2)]);
  renderBuilder();
  await waitForRestore();
  grid().scrollLeft = 50;

  state.builder.draft = minimalDraft("plan-t3", [minimalBlock("t3-b1", 1), minimalBlock("t3-b2", 2), minimalBlock("t3-b3", 3)]);
  renderBuilder();
  await waitForRestore();

  const newBlockForm = els.content.querySelector('[data-block-id="t3-b3"]');
  assert.ok(newBlockForm.__scrolledIntoView, "the newly added block must be scrolled into view");
  assert.deepEqual(newBlockForm.__scrolledIntoView, { inline: "nearest", block: "nearest" }, "must use a MINIMAL scroll (nearest), not center/start");
});

test("4. deleting a block (count decreased) restores the exact prior scrollLeft, not a scroll-into-view", async () => {
  state.builder.draft = minimalDraft("plan-t4", [minimalBlock("t4-b1", 1), minimalBlock("t4-b2", 2), minimalBlock("t4-b3", 3)]);
  renderBuilder();
  await waitForRestore();
  grid().scrollLeft = 90;

  state.builder.draft = minimalDraft("plan-t4", [minimalBlock("t4-b1", 1), minimalBlock("t4-b3", 3)]);
  renderBuilder();
  await waitForRestore();

  assert.equal(grid().scrollLeft, 90);
});

test("5. switching to a different plan does not leak the previous plan's scroll position", async () => {
  state.builder.draft = minimalDraft("plan-t5a", [minimalBlock("t5a-b1", 1), minimalBlock("t5a-b2", 2)]);
  renderBuilder();
  await waitForRestore();
  grid().scrollLeft = 300;

  state.builder.draft = minimalDraft("plan-t5b", [minimalBlock("t5b-b1", 1)]);
  renderBuilder();
  await waitForRestore();

  assert.equal(grid().scrollLeft, 0, "a freshly loaded, different plan must not inherit a stale scroll position from the plan that was open before");
});

test("6. a plan's first render in this session does not throw and leaves scrollLeft at the default", async () => {
  state.builder.draft = minimalDraft("plan-t6", [minimalBlock("t6-b1", 1)]);
  assert.doesNotThrow(() => renderBuilder());
  await waitForRestore();
  assert.equal(grid().scrollLeft, 0);
});
