import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// feature/mobile-builder-section-workflow: covers the mobile Add/Added-
// exercises workflow in the Builder's Exercise section editor. Two kinds of
// tests, matching the shape of the code under test:
//
// 1. Pure render-function tests against builder-exercises.js - those
//    functions only take plain data and return an HTML string, so they're
//    exercised directly with no DOM/fetch mocking at all.
// 2. Action-handler tests against builder-actions.js (mirrors the existing
//    fakeAction/fetch-mock pattern in organization-user-management.actions.
//    test.mjs) - these prove state transitions and exactly-what-was-sent to
//    the API, not rendered markup.
//
// A real browser is still required to prove the actual tap-race fix (no
// jsdom in this suite, so a synthetic DOM can't reproduce a mid-gesture
// CSS reflow) - that was verified manually (see the PR's final report) and
// is additionally guarded here by regression-guard tests 2b/16b below,
// which fail if the removed focus-driven CSS or scrollToLastAddedItem
// logic is ever reintroduced.

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const fakeElements = new Map();
function fakeElement() {
  return { innerHTML: "", textContent: "", querySelector: () => null, querySelectorAll: () => [] };
}
globalThis.document = {
  querySelector(selector) {
    if (!fakeElements.has(selector)) fakeElements.set(selector, fakeElement());
    return fakeElements.get(selector);
  },
  querySelectorAll: () => [],
};

const {
  builderAddedCounts,
  renderBuilderAddConfirmation,
  renderBuilderAddedList,
  renderBuilderExerciseResult,
  renderBuilderExerciseResults,
  renderBuilderItemEdit,
  renderBuilderItems,
  renderBuilderStickyBar,
} = await import("../builder-exercises.js");
const { handleBuilderItemAction, handleBuilderWorkspaceAction, submitBuilderForm } = await import("../builder-actions.js");
const { state, emptyBuilderState } = await import("../state.js");

const originalFetch = globalThis.fetch;

function installFetchMock(responses) {
  const calls = [];
  const queue = [...responses];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
    const next = queue.shift();
    if (next?.throwNetworkError) throw new TypeError("Failed to fetch");
    const status = next?.status ?? 200;
    const body = next?.body ?? {};
    return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => body };
  };
  return calls;
}

function fakeAction(dataset, { closestResult = null, disabled = false } = {}) {
  return { dataset, disabled, textContent: "Add", closest: () => closestResult };
}

function fakeDosePanel(dose = {}) {
  return {
    querySelector: (selector) => {
      const match = selector.match(/name="(\w+)"/);
      const name = match?.[1];
      return name && name in dose ? { value: dose[name] } : null;
    },
  };
}

function makeDraft(items, { sectionId = "section-1" } = {}) {
  return {
    plan: { id: "plan-1", status: "draft" },
    batch: null,
    blocks: [{ id: "block-1", sessions: [{ id: "session-1", nodes: [{ id: sectionId, type: "section", name: "Test Section", items }] }] }],
  };
}

function makeItem(overrides = {}) {
  return { id: `item-${Math.random().toString(36).slice(2)}`, exerciseId: "ex-1", title: "Nordic hamstring curl", sets: "", reps: "", load: "", description: "", imageUrl: "", videoUrl: "", ...overrides };
}

function resetState() {
  state.builder = emptyBuilderState();
  state.builder.draft = makeDraft([]);
  state.builder.selectedNodeId = "section-1";
  state.markedExerciseIds = new Set();
}

function noopHandlers(overrides = {}) {
  return {
    renderBuilder: () => {},
    renderBuilderSectionItems: () => false,
    renderBuilderAddFeedback: () => false,
    renderBuilderError: () => {},
    refreshBuilderDraft: async () => {},
    ...overrides,
  };
}

// --- Part 1: pure render functions ---

test("1a. renderBuilderExerciseResult shows plain Add with no badge when addedCount is 0", () => {
  const html = renderBuilderExerciseResult({ id: "ex-1", name: "Box jump" }, new Set(), 0);
  assert.match(html, />Add</);
  assert.doesNotMatch(html, /Added \d+×/);
  assert.doesNotMatch(html, /is-already-added/);
});

test("1b. renderBuilderExerciseResult shows 'Add again' and 'Added N×' badge, never disabled, once addedCount > 0", () => {
  const html = renderBuilderExerciseResult({ id: "ex-1", name: "Box jump" }, new Set(), 2);
  assert.match(html, />Add again</);
  assert.match(html, /Added 2×/);
  assert.match(html, /is-already-added/);
  assert.doesNotMatch(html, /disabled/, "the Add button must never become permanently disabled just because the exercise was already added");
});

test("1c. builderAddedCounts + renderBuilderExerciseResults derive the badge per exercise, never deduping the results list itself", () => {
  const node = makeDraft([makeItem({ exerciseId: "ex-1" }), makeItem({ exerciseId: "ex-1" }), makeItem({ exerciseId: "ex-2" })]).blocks[0].sessions[0].nodes[0];
  const counts = builderAddedCounts(node);
  assert.equal(counts.get("ex-1"), 2);
  assert.equal(counts.get("ex-2"), 1);
  assert.equal(counts.get("ex-3"), undefined);

  const html = renderBuilderExerciseResults(
    [{ id: "ex-1", name: "Box jump" }, { id: "ex-2", name: "Lunge" }, { id: "ex-3", name: "Squat" }],
    new Set(),
    node,
  );
  assert.match(html, /Added 2×/);
  assert.match(html, /Added 1×/);
  const squatIndex = html.indexOf("Squat");
  assert.ok(squatIndex !== -1);
  assert.doesNotMatch(html.slice(squatIndex, squatIndex + 400), /Added \d+×/, "an exercise never added must never show a count badge");
});

test("2a. renderBuilderAddedList renders one compact card per item, each with live Sets/Reps/Load inputs (not a read-only summary) and a 2-line title clamp class", () => {
  const items = [makeItem({ id: "item-with-dose", title: "Nordic hamstring curl", sets: "3", reps: "8", load: "40 kg" }), makeItem({ id: "item-without-dose", title: "Box jump" })];
  const html = renderBuilderAddedList({ items });
  const cardCount = (html.match(/builder-added-card /g) || []).length;
  assert.equal(cardCount, 2);
  assert.match(html, /builder-added-card-title/, "the title element must carry the class styles.css clamps to 2 lines");
  assert.match(html, /name="sets" value="3" placeholder="e\.g\. 3"/, "Sets must be a live, editable input carrying the item's current value - not a read-only summary");
  assert.match(html, /name="reps" value="8" placeholder="e\.g\. 8"/);
  assert.match(html, /name="load" value="40 kg" placeholder="e\.g\. 40 kg"/);
  const emptyCardHtml = html.slice(html.indexOf("item-without-dose"));
  assert.match(emptyCardHtml, /name="sets" value="" placeholder="e\.g\. 3"/, "an item with no dose yet must show an empty, directly-editable input, not a blank summary");
});

test("2a-bis. each compact card is itself the autosave form, and always carries a hidden 'description' field with the item's current instruction - Instruction only ever renders inline in the single-item edit view, so without this hidden field an inline Sets/Reps/Load save would submit no description at all and wipe it (PATCH /items/:itemId writes all four columns unconditionally)", () => {
  const items = [makeItem({ id: "item-1", description: "Keep the knee soft on landing." })];
  const html = renderBuilderAddedList({ items });
  assert.match(html, /<form class="builder-added-card builder-item" data-builder-form="update-item" data-builder-autosave data-item-id="item-1">/, "the card must be a form wired to the same update-item autosave path as the desktop form and the single-item edit view");
  assert.match(html, /<input type="hidden" name="description" value="Keep the knee soft on landing\.">/);
  assert.doesNotMatch(html, /<textarea/, "the compact card must never render the Instruction textarea inline - only Sets/Reps/Load are inline, Instruction stays behind Edit details");
});

test("2b. Instruction starts collapsed in the single-item edit view - no textarea until explicitly opened, and a hidden field keeps the existing text from being wiped by a dose-only save", () => {
  const node = { items: [makeItem({ id: "item-1", description: "Existing instruction text" })] };
  const closed = renderBuilderItemEdit(node, "item-1", false);
  assert.doesNotMatch(closed, /<textarea/, "the instruction textarea must not render while collapsed");
  assert.match(closed, /Instruction &#9662;/);
  assert.match(closed, /Existing instruction text/, "a collapsed item with existing text should still show a short preview, just not the full editable textarea");
  assert.match(closed, /<input type="hidden" name="description" value="Existing instruction text">/, "regression guard: without this hidden field, autosaving Sets/Reps/Load while Instruction is collapsed would submit no 'description' key, and PATCH /items/:itemId writes all four columns unconditionally - silently wiping the existing instruction");

  const open = renderBuilderItemEdit(node, "item-1", true);
  assert.match(open, /<textarea/);
  assert.match(open, /Instruction &#9652;/);
  assert.doesNotMatch(open, /type="hidden" name="description"/, "the hidden fallback must not coexist with the real textarea, or FormData would carry two 'description' entries");
});

test("2c. the single-item edit view shows position and disables Previous/Next only at the ends", () => {
  const node = { items: [makeItem({ id: "a" }), makeItem({ id: "b" }), makeItem({ id: "c" })] };
  const first = renderBuilderItemEdit(node, "a", false);
  assert.match(first, /1 of 3/);
  assert.match(first, /data-direction="prev"[^>]*disabled/);
  assert.doesNotMatch(first.match(/data-direction="next"[^>]*>/)?.[0] || "", /disabled/);

  const last = renderBuilderItemEdit(node, "c", false);
  assert.match(last, /3 of 3/);
  assert.match(last, /data-direction="next"[^>]*disabled/);
});

test("3a. renderBuilderStickyBar always shows the exact count and up to 4 thumbnails with a +N overflow badge beyond that", () => {
  const empty = renderBuilderStickyBar({ items: [] }, "add");
  assert.match(empty, /Added exercises \(0\)/);

  const three = renderBuilderStickyBar({ items: [makeItem(), makeItem(), makeItem()] }, "add");
  assert.match(three, /Added exercises \(3\)/);
  assert.doesNotMatch(three, /\+\d/);

  const six = renderBuilderStickyBar({ items: Array.from({ length: 6 }, () => makeItem()) }, "add");
  assert.match(six, /Added exercises \(6\)/);
  assert.match(six, /\+2/, "6 items with a 4-thumbnail limit must show a +2 overflow badge");
  const thumbCount = (six.match(/builder-sticky-thumb(?!-)/g) || []).length;
  assert.equal(thumbCount, 4, "never more than 4 real thumbnails, regardless of how many items exist");
});

test("3b. sticky bar thumbnails open a media preview, never the edit form directly", () => {
  const html = renderBuilderStickyBar({ items: [makeItem({ imageUrl: "https://example.test/img.jpg", title: "Box jump" })] }, "add");
  const thumbMarkup = html.slice(html.indexOf("builder-sticky-thumb"), html.indexOf("builder-sticky-thumb") + 300);
  assert.match(thumbMarkup, /data-action="open-media"/);
  assert.doesNotMatch(thumbMarkup, /data-action="builder-open-edit-item"/);
});

test("3c. the sticky bar has no standing mode-tabs pair - its own action button is mode-aware instead: 'Edit' (-> added) while in Add-exercises mode, 'Add exercises' (-> add) while already in Added-exercises mode", () => {
  const addMode = renderBuilderStickyBar({ items: [makeItem()] }, "add");
  assert.match(addMode, /<button class="text-action" type="button" data-action="builder-set-mobile-mode" data-mode="added">Edit<\/button>/);
  assert.doesNotMatch(addMode, />Add exercises</, "while already in Add-exercises mode there is nothing to switch back to");

  const addedMode = renderBuilderStickyBar({ items: [makeItem()] }, "added");
  assert.match(addedMode, /<button class="text-action" type="button" data-action="builder-set-mobile-mode" data-mode="add">Add exercises<\/button>/);
  assert.doesNotMatch(addedMode, />Edit</, "while already in Added-exercises mode there is nothing to switch back to");

  // Done must always be present and unaffected by mode.
  assert.match(addMode, /data-action="builder-finish-section">Done</);
  assert.match(addedMode, /data-action="builder-finish-section">Done</);
});

test("4a. renderBuilderAddConfirmation is empty when nothing was just added, and shows the title + Edit now otherwise", () => {
  assert.equal(renderBuilderAddConfirmation(null), "");
  const html = renderBuilderAddConfirmation({ itemId: "item-1", title: "Nordic hamstring curl" });
  assert.match(html, /Nordic hamstring curl added/);
  assert.match(html, /data-action="builder-edit-now"/);
});

test("5a. desktop's renderBuilderItems always shows full dose inputs and the instruction textarea inline - unchanged from before this feature", () => {
  const html = renderBuilderItems({ items: [makeItem({ title: "Nordic hamstring curl", sets: "3", reps: "8", load: "40 kg", description: "Keep it slow." })] });
  assert.match(html, /builder-added-list-desktop/);
  assert.match(html, /name="sets"[^>]*value="3"/);
  assert.match(html, /name="reps"[^>]*value="8"/);
  assert.match(html, /name="load"[^>]*value="40 kg"/);
  assert.match(html, /<textarea name="description"[^>]*>Keep it slow\.<\/textarea>/, "desktop must always render the instruction textarea inline, never collapsed");
});

// --- Part 2: action-handler behavior ---

const originalFormData = globalThis.FormData;

beforeEach(() => {
  resetState();
  globalThis.fetch = originalFetch;
  globalThis.FormData = originalFormData;
});

test("6a. a single tap on Add sends exactly one POST and adds exactly one item", async () => {
  const newItem = makeItem({ id: "new-item-1", exerciseId: "ex-1", title: "Box jump" });
  const calls = installFetchMock([{ status: 201, body: makeDraft([newItem]) }]);
  const action = fakeAction({ action: "builder-pick-exercise", exerciseId: "ex-1" }, { closestResult: fakeDosePanel({ sets: "3", reps: "8", load: "" }) });

  const handled = await handleBuilderItemAction(action, noopHandlers());
  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/builder/nodes/section-1/exercises");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body.exerciseId, "ex-1");
  assert.equal(state.builder.draft.blocks[0].sessions[0].nodes[0].items.length, 1);
});

test("6b. a tap while the button is already disabled (mid-request) never sends a second POST", async () => {
  const calls = installFetchMock([{ status: 201, body: makeDraft([makeItem()]) }]);
  const action = fakeAction({ action: "builder-pick-exercise", exerciseId: "ex-1" }, { closestResult: fakeDosePanel({}), disabled: true });

  const handled = await handleBuilderItemAction(action, noopHandlers());
  assert.equal(handled, true);
  assert.equal(calls.length, 0, "an already-disabled Add button must refuse to send another request");
});

test("6c. the fix no longer depends on document.activeElement or a focus-driven scroll helper", async () => {
  const source = await readFile(path.join(frontendDir, "builder-actions.js"), "utf8");
  assert.doesNotMatch(source, /scrollToLastAddedItem/, "the old blur-and-scroll-to-Added-panel helper must be gone");
  assert.doesNotMatch(source, /activeElement/, "adding an exercise must never depend on which element currently has focus");
});

test("6d. the CSS that used to hide the header/Added panel on :focus-within (the tap-race root cause) is gone", async () => {
  const css = await readFile(path.join(frontendDir, "styles.css"), "utf8");
  assert.doesNotMatch(css, /:has\(\.builder-section-library:focus-within\)/, "the focus-driven reflow rule must not come back");
  assert.doesNotMatch(css, /:has\(input\[data-builder-exercise-search\]:focus\)/);
  assert.doesNotMatch(css, /:has\(input\[data-builder-new-dose\]:focus\)/);
});

test("7a. after a successful add, the search query and filters are left completely untouched", async () => {
  state.builder.exerciseQuery = "hamstring";
  state.builder.exerciseFilters.purpose = "strength";
  installFetchMock([{ status: 201, body: makeDraft([makeItem()]) }]);
  const action = fakeAction({ action: "builder-pick-exercise", exerciseId: "ex-1" }, { closestResult: fakeDosePanel({}) });

  await handleBuilderItemAction(action, noopHandlers());
  assert.equal(state.builder.exerciseQuery, "hamstring");
  assert.equal(state.builder.exerciseFilters.purpose, "strength");
});

test("7b. after a successful add, mobileMode stays 'add' - the coach is never bounced into Added-exercises mode", async () => {
  state.builder.mobileMode = "add";
  installFetchMock([{ status: 201, body: makeDraft([makeItem()]) }]);
  const action = fakeAction({ action: "builder-pick-exercise", exerciseId: "ex-1" }, { closestResult: fakeDosePanel({}) });

  await handleBuilderItemAction(action, noopHandlers());
  assert.equal(state.builder.mobileMode, "add");
});

test("7c. after a successful add, an inline confirmation with the item's title is recorded for the caller to render", async () => {
  const newItem = makeItem({ id: "new-item-1", title: "Box jump" });
  installFetchMock([{ status: 201, body: makeDraft([newItem]) }]);
  const action = fakeAction({ action: "builder-pick-exercise", exerciseId: "ex-1" }, { closestResult: fakeDosePanel({}) });

  await handleBuilderItemAction(action, noopHandlers());
  assert.equal(state.builder.lastAddedItemId, "new-item-1");
  assert.equal(state.builder.addConfirmation.itemId, "new-item-1");
  assert.equal(state.builder.addConfirmation.title, "Box jump");
});

test("8a. Edit now switches to Added-exercises mode and opens exactly the just-added item", async () => {
  state.builder.lastAddedItemId = "new-item-1";
  state.builder.addConfirmation = { itemId: "new-item-1", title: "Box jump" };
  const action = fakeAction({ action: "builder-edit-now" });

  const handled = await handleBuilderWorkspaceAction(action, noopHandlers());
  assert.equal(handled, true);
  assert.equal(state.builder.mobileMode, "added");
  assert.equal(state.builder.editItemId, "new-item-1");
  assert.equal(state.builder.addConfirmation, null, "the confirmation banner must clear once the coach acts on it");
});

test("9a. adding the same exercise twice produces two independently-tracked items, never a dedup", async () => {
  const first = makeItem({ id: "item-1", exerciseId: "ex-1" });
  const second = makeItem({ id: "item-2", exerciseId: "ex-1" });
  installFetchMock([
    { status: 201, body: makeDraft([first]) },
    { status: 201, body: makeDraft([first, second]) },
  ]);
  const handlers = noopHandlers();
  const action1 = fakeAction({ action: "builder-pick-exercise", exerciseId: "ex-1" }, { closestResult: fakeDosePanel({ sets: "3" }) });
  await handleBuilderItemAction(action1, handlers);
  const action2 = fakeAction({ action: "builder-pick-exercise", exerciseId: "ex-1" }, { closestResult: fakeDosePanel({ sets: "4" }) });
  await handleBuilderItemAction(action2, handlers);

  const items = state.builder.draft.blocks[0].sessions[0].nodes[0].items;
  assert.equal(items.length, 2);
  assert.notEqual(items[0].id, items[1].id);
  assert.equal(items[0].exerciseId, items[1].exerciseId);
});

test("10a. editing one item's dose via the autosave form targets only that item's id", async () => {
  const targetItem = makeItem({ id: "item-1", sets: "3" });
  const otherItem = makeItem({ id: "item-2", sets: "5" });
  state.builder.draft = makeDraft([targetItem, otherItem]);
  const patchedTarget = { ...targetItem, sets: "10" };
  const calls = installFetchMock([{ status: 200, body: makeDraft([patchedTarget, otherItem]) }]);

  const form = { dataset: { builderForm: "update-item", itemId: "item-1" } };
  globalThis.FormData = class {
    constructor() { this.entries = [["sets", "10"], ["reps", ""], ["load", ""], ["description", ""]]; }
    [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
  };

  await submitBuilderForm(form, noopHandlers());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/builder/items/item-1");
  assert.equal(calls[0].method, "PATCH");
  const items = state.builder.draft.blocks[0].sessions[0].nodes[0].items;
  assert.equal(items.find((item) => item.id === "item-1").sets, "10");
  assert.equal(items.find((item) => item.id === "item-2").sets, "5", "the untouched duplicate must keep its own dose");
});

test("11a. removing one item's request targets only that item, and only clears edit/confirmation state tied to that same id", async () => {
  state.builder.editItemId = "item-2";
  state.builder.lastAddedItemId = "item-2";
  state.builder.addConfirmation = { itemId: "item-2", title: "Other item" };
  globalThis.window = { confirm: () => true };
  const calls = installFetchMock([{ status: 200, body: {} }]);
  const action = fakeAction({ action: "builder-delete-item", itemId: "item-1" });

  await handleBuilderItemAction(action, noopHandlers({ refreshBuilderDraft: async () => {} }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/builder/items/item-1");
  assert.equal(calls[0].method, "DELETE");
  assert.equal(state.builder.editItemId, "item-2", "deleting a different item must never disturb the one currently open for editing");
  assert.equal(state.builder.addConfirmation.itemId, "item-2");
});

test("11b. removing the item that IS open for editing/confirmation clears that state instead of leaving it stale", async () => {
  state.builder.editItemId = "item-1";
  state.builder.lastAddedItemId = "item-1";
  state.builder.addConfirmation = { itemId: "item-1", title: "Deleted item" };
  globalThis.window = { confirm: () => true };
  installFetchMock([{ status: 200, body: {} }]);
  const action = fakeAction({ action: "builder-delete-item", itemId: "item-1" });

  await handleBuilderItemAction(action, noopHandlers({ refreshBuilderDraft: async () => {} }));
  assert.equal(state.builder.editItemId, "", "the deleted item's own edit view must not linger with a dangling id");
  assert.equal(state.builder.addConfirmation, null);
});

test("12a. move-item still swaps order locally and sends the correct move request", async () => {
  const first = makeItem({ id: "item-1" });
  const second = makeItem({ id: "item-2" });
  state.builder.draft = makeDraft([first, second]);
  const calls = installFetchMock([{ status: 200, body: makeDraft([second, first]) }]);
  const action = fakeAction({ action: "builder-move-item", itemId: "item-2", direction: "up" });

  await handleBuilderItemAction(action, noopHandlers());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/builder/items/item-2/move");
  assert.equal(calls[0].body.direction, "up");
});

test("13a. Done (builder-finish-section) never makes an API call and fully resets the mobile UI state", async () => {
  state.builder.mobileMode = "added";
  state.builder.editItemId = "item-1";
  state.builder.addConfirmation = { itemId: "item-1", title: "X" };
  state.builder.selectedNodeId = "section-1";
  const calls = installFetchMock([]);
  const action = fakeAction({ action: "builder-finish-section" });

  const handled = await handleBuilderWorkspaceAction(action, noopHandlers());
  assert.equal(handled, true);
  assert.equal(calls.length, 0, "closing the editor must never itself call the API - nothing is discarded, everything already autosaved");
  assert.equal(state.builder.selectedNodeId, "");
  assert.equal(state.builder.mobileMode, "add");
  assert.equal(state.builder.editItemId, "");
  assert.equal(state.builder.addConfirmation, null);
});

test("14a. the sticky bar and mobile-only Added views are hidden by default (desktop) in the CSS, not just at the ≤560px breakpoint", async () => {
  const css = await readFile(path.join(frontendDir, "styles.css"), "utf8");
  const baseRuleMatch = css.match(/\.builder-added-list-compact,\s*\n\.builder-item-edit,\s*\n\.builder-mobile-sticky-bar,\s*\n\.builder-add-confirmation,\s*\n\.builder-section-close-button\s*\{\s*\n\s*display:\s*none;/);
  assert.ok(baseRuleMatch, "the mobile-only elements must default to display:none outside any media query, so desktop is unaffected even if the ≤560px query is ever mis-scoped");
});

test("16a. regression guard: .builder-item-edit is switched back to visible somewhere in the CSS - this was the actual root cause of \"Edit details doesn't work\" (a CSS bug, not an event-handler/render/state bug). The handler and DOM were always correct: builder-open-edit-item set editItemId and re-rendered .builder-item-edit into the DOM with the right content (verified live: the element existed, computedStyle.display was 'none', offsetParent was null), but the base rule (see test 14a) always set it to display:none and nothing ever turned it back on, so it could never actually become visible on any screen size.", async () => {
  const css = await readFile(path.join(frontendDir, "styles.css"), "utf8");
  // Every "turn it back on" rule for .builder-item-edit as a standalone
  // selector (not -head/-position/-nav children) must set a real display
  // value. There must be at least one such rule beyond the base
  // display:none - the exact bug was that there were zero.
  const standaloneRules = [...css.matchAll(/(?<!,\s*\n)\.builder-item-edit\s*\{\s*\n\s*display:\s*([a-z-]+);/g)];
  const turnOnRules = standaloneRules.filter((match) => match[1] !== "none");
  assert.ok(turnOnRules.length > 0, "there must be a rule setting .builder-item-edit to a non-'none' display - without one, the single-item edit view (Instruction, Previous/Next) can never be seen on any device, even though the handler and DOM patch are correct");
});

test("16b. the top-level mode-tabs pair (\"Add exercises\" / \"Added exercises (N)\" tab buttons) no longer exists anywhere - the sticky bar's own mode-aware button is the only way to switch modes on mobile", async () => {
  const sectionSource = await readFile(path.join(frontendDir, "builder-section.js"), "utf8");
  assert.doesNotMatch(sectionSource, /builder-mobile-mode-tabs/, "the standing mode-tabs container must not be rendered");
  assert.doesNotMatch(sectionSource, /role="tablist"/, "no tablist markup should remain once the tabs are gone");

  const css = await readFile(path.join(frontendDir, "styles.css"), "utf8");
  assert.doesNotMatch(css, /\.builder-mobile-mode-tab\b/, "the mode-tab styling rules must be removed along with the markup, not just hidden");
});

test("16c. regression guard: the reorder arrows stay vertical (up/down) at every width - the stale mobile override that rotated them to left/right (a leftover from the old horizontal-scroll Added-list design, long since replaced by a vertical list) must not come back", async () => {
  const css = await readFile(path.join(frontendDir, "styles.css"), "utf8");
  assert.match(css, /\.builder-item-move-up \.builder-icon-svg \{ transform: rotate\(0deg\); \}/);
  assert.match(css, /\.builder-item-move-down \.builder-icon-svg \{ transform: rotate\(180deg\); \}/);
  assert.doesNotMatch(css, /rotate\(-?90deg\)/, "no rule anywhere should rotate the reorder arrows onto their side");
});

test("16d. the quick-dose fields (Sets/Reps/Load, shown before an exercise is added) use 'e.g.' placeholders, not bare numbers that could be mistaken for an entered value", async () => {
  const sectionSource = await readFile(path.join(frontendDir, "builder-section.js"), "utf8");
  assert.match(sectionSource, /data-builder-new-dose name="sets" placeholder="e\.g\. 3"/);
  assert.match(sectionSource, /data-builder-new-dose name="reps" placeholder="e\.g\. 8"/);
  assert.match(sectionSource, /data-builder-new-dose name="load" placeholder="e\.g\. 40 kg"/);
});

test("16e. dose-input placeholders render in a visibly lighter color than typed values, via a dedicated ::placeholder rule scoped to .builder-dose-inputs", async () => {
  const css = await readFile(path.join(frontendDir, "styles.css"), "utf8");
  assert.match(css, /\.builder-dose-inputs input::placeholder \{ color: #a7b0ba; opacity: 1;/, "the placeholder color must be explicitly set and lighter than the default (near-black) typed-value text, not left to a possibly-inconsistent browser default");
});

test("15a. an add error resets the button, leaves query/filters untouched, and a retry can still succeed", async () => {
  state.builder.exerciseQuery = "hamstring";
  installFetchMock([{ status: 500, body: { error: "Server error" } }]);
  let errorSeen = null;
  const action = fakeAction({ action: "builder-pick-exercise", exerciseId: "ex-1" }, { closestResult: fakeDosePanel({}) });

  await handleBuilderItemAction(action, noopHandlers({ renderBuilderError: (error) => { errorSeen = error; } }));
  assert.ok(errorSeen);
  assert.equal(action.disabled, false, "the button must be usable again after a failed add");
  assert.equal(action.textContent, "Add", "the button's label must be restored, not stuck on 'Adding…'");
  assert.equal(state.builder.exerciseQuery, "hamstring");

  installFetchMock([{ status: 201, body: makeDraft([makeItem({ id: "retry-item" })]) }]);
  const retryAction = fakeAction({ action: "builder-pick-exercise", exerciseId: "ex-1" }, { closestResult: fakeDosePanel({}) });
  await handleBuilderItemAction(retryAction, noopHandlers());
  assert.equal(state.builder.draft.blocks[0].sessions[0].nodes[0].items.length, 1, "the retry must be able to succeed normally");
});
