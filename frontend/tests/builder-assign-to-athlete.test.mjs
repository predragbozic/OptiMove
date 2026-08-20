import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Templates -> Specific Programs assignment (Programs overhaul, item 3):
// the open-Builder "Assign to athlete" button reuses the exact same
// /duplicate endpoint (and, for an edit-draft, the same /submit "Apply
// changes" endpoint) the pre-existing templates-list "Copy" action already
// uses - no new backend logic, only new client-side composition/UI. See
// backend/tests/template-assign-to-athlete.test.mjs for the shared
// endpoint's own behavior (independent copy, template unchanged, empty
// structures preserved, authorization).

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
globalThis.window = { confirm: () => true };

const { handleBuilderPlanAction } = await import("../builder-actions.js");
const { state, emptyBuilderState } = await import("../state.js");
const { renderCopyPlanModal } = await import("../builder-modals.js");

const originalFetch = globalThis.fetch;

function installFetchMock(responseFor) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method, body });
    const next = responseFor(url, method, body, calls.length);
    const status = next?.status ?? 200;
    const respBody = next?.body ?? {};
    return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => respBody };
  };
  return calls;
}

function installHeldFetchMock() {
  const calls = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    const body = await held;
    return { ok: true, status: 200, statusText: "", json: async () => body };
  };
  return { calls, release: (body = {}) => release(body) };
}

function fakeAction(dataset, { disabled = false, textContent = "" } = {}) {
  return { dataset, disabled, textContent, closest: () => null };
}

function templateDraft(overrides = {}) {
  return {
    plan: {
      id: "template-1", planType: "program", name: "Strength Template",
      isTemplate: true, status: "active", isEditDraft: false, editSourcePlanId: "",
      ...overrides.plan,
    },
    blocks: [{ id: "block-1", sessions: [] }],
    batch: null,
    ...overrides,
  };
}

function noopHandlers(overrides = {}) {
  return {
    renderBuilder: () => {},
    renderCopyPlanSource: async () => {},
    renderTabs: () => {},
    renderLibraryNav: () => {},
    loadBuilderExercises: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  state.builder = emptyBuilderState();
  state.athletes = [
    { athlete_id: "athlete-a", athlete: "Ana Athlete" },
    { athlete_id: "athlete-b", athlete: "Bojan Athlete" },
  ];
  state.activeTab = "builder";
  globalThis.fetch = originalFetch;
});

test("1. the Assign to athlete button only renders while editing a template, never a weekly plan or a specific program", () => {
  const body = readFileSync(path.resolve(__dirname, "../builder-view.js"), "utf8");
  assert.match(
    body,
    /draft\.plan\.isTemplate && !isWeekly \? `<button class="plain-button builder-assign-button" type="button" data-action="builder-duplicate-plan"/,
  );
});

test("2. opening the assign flow from the Builder seeds copyIntent/copyPlanName/copyIsEditDraft from the open draft, not the more-menu DOM scrape", async () => {
  state.builder.draft = templateDraft();
  const action = fakeAction({ action: "builder-duplicate-plan", planId: "template-1", planType: "program", intent: "assign", isEditDraft: "false" });
  const handled = await handleBuilderPlanAction(action, noopHandlers());
  assert.equal(handled, true);
  assert.equal(state.builder.copyPlanId, "template-1");
  assert.equal(state.builder.copyPlanName, "Strength Template");
  assert.equal(state.builder.copyIntent, "assign");
  assert.equal(state.builder.copyIsEditDraft, false);
});

test("3. confirming assign for a non-edit-draft template calls /duplicate directly (no /submit), and does not navigate away", async () => {
  state.builder.draft = templateDraft();
  state.builder.copyPlanId = "template-1";
  state.builder.copyIntent = "assign";
  state.builder.copyIsEditDraft = false;
  state.builder.copyAthleteIds = ["athlete-a"];
  const calls = installFetchMock((url) => {
    if (url.endsWith("/duplicate")) return { status: 201, body: templateDraft({ plan: { id: "assigned-1", isTemplate: false, athleteId: "athlete-a" } }) };
    throw new Error(`unexpected fetch ${url}`);
  });
  const action = fakeAction({ action: "builder-confirm-duplicate-plan" }, { textContent: "Assign" });

  const handled = await handleBuilderPlanAction(action, noopHandlers());
  assert.equal(handled, true);
  assert.equal(calls.length, 1, "only /duplicate must be called - no /submit for a non-edit-draft template");
  assert.equal(calls[0].url, "/api/builder/plans/template-1/duplicate");
  assert.equal(calls[0].method, "POST");

  assert.equal(state.activeTab, "builder", "assigning must never navigate away from the open template");
  assert.equal(state.builder.draft.plan.id, "template-1", "the open template's identity must be completely unchanged");
  assert.ok(state.builder.assignResult, "a confirmation result must be recorded");
  assert.equal(state.builder.assignResult.planId, "assigned-1");
  assert.deepEqual(state.builder.assignResult.athleteNames, ["Ana Athlete"]);
  assert.equal(state.builder.copyPlanId, "", "the copy/assign modal state must be reset (closed) after success");
});

test("4. confirming assign for an EDIT-DRAFT template applies it first (/submit), then duplicates the now-updated ORIGINAL (not the edit-draft)", async () => {
  state.builder.draft = templateDraft({ plan: { id: "editdraft-1", isEditDraft: true, editSourcePlanId: "template-1" } });
  state.builder.copyPlanId = "editdraft-1";
  state.builder.copyIntent = "assign";
  state.builder.copyIsEditDraft = true;
  state.builder.copyAthleteIds = ["athlete-a"];
  const calls = installFetchMock((url) => {
    if (url.endsWith("/editdraft-1/submit")) return { status: 200, body: templateDraft({ plan: { id: "template-1", isEditDraft: false, name: "Strength Template (edited)" } }) };
    if (url.endsWith("/template-1/duplicate")) return { status: 201, body: templateDraft({ plan: { id: "assigned-2", isTemplate: false } }) };
    throw new Error(`unexpected fetch ${url}`);
  });
  const action = fakeAction({ action: "builder-confirm-duplicate-plan" }, { textContent: "Assign" });

  await handleBuilderPlanAction(action, noopHandlers());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/builder/plans/editdraft-1/submit", "apply must run BEFORE duplicate, so the copy can never contain a stale pre-edit version");
  assert.equal(calls[1].url, "/api/builder/plans/template-1/duplicate", "duplicate must target the ORIGINAL's id (from the applied response), not the edit-draft's own id");

  assert.equal(state.builder.draft.plan.id, "template-1", "the open Builder must switch to the now-applied original - the edit-draft row no longer exists server-side");
  assert.equal(state.builder.draft.plan.isEditDraft, false);
  assert.ok(state.builder.assignResult);
});

test("5. the button shows 'Assigning…' immediately, before the request resolves, and a second click while it's in flight sends nothing more", async () => {
  state.builder.draft = templateDraft();
  state.builder.copyPlanId = "template-1";
  state.builder.copyIntent = "assign";
  state.builder.copyIsEditDraft = false;
  state.builder.copyAthleteIds = ["athlete-a"];
  const { calls, release } = installHeldFetchMock();
  const action = fakeAction({ action: "builder-confirm-duplicate-plan" }, { textContent: "Assign" });

  const first = handleBuilderPlanAction(action, noopHandlers());
  await Promise.resolve();
  assert.equal(action.disabled, true, "the button must be disabled the instant Assign is clicked");
  assert.equal(action.textContent, "Assigning…");
  assert.equal(calls.length, 1);

  const second = handleBuilderPlanAction(action, noopHandlers());
  const secondHandled = await second;
  assert.equal(secondHandled, true, "the action type is still recognized (no unrelated fallback path runs)");
  assert.equal(calls.length, 1, "a click while the first request is still genuinely unresolved must never fire a second, parallel assign");

  release(templateDraft({ plan: { id: "assigned-3", isTemplate: false } }));
  await first;
});

test("6. a failed assign (non-edit-draft) leaves the open template completely untouched, restores the button, and never sets a confirmation", async () => {
  state.builder.draft = templateDraft();
  state.builder.copyPlanId = "template-1";
  state.builder.copyIntent = "assign";
  state.builder.copyIsEditDraft = false;
  state.builder.copyAthleteIds = ["athlete-a"];
  installFetchMock(() => ({ status: 500, body: { error: "Server error" } }));
  const action = fakeAction({ action: "builder-confirm-duplicate-plan" }, { textContent: "Assign" });

  // builder-confirm-duplicate-plan re-throws non-"not found" errors for the
  // real app.js wrapper (handleBuilderAction(action).catch(renderBuilderError))
  // to surface - mirror that exact contract here instead of expecting an
  // internal handlers.renderBuilderError call this branch never makes.
  await assert.rejects(() => handleBuilderPlanAction(action, noopHandlers()), /Server error/);

  assert.equal(action.disabled, false, "the button must be usable again for a retry");
  assert.equal(action.textContent, "Assign", "the button label must be restored, not stuck on 'Assigning…'");
  assert.equal(state.builder.draft.plan.id, "template-1");
  assert.equal(state.builder.assignResult, null);
});

test("7. a failed assign AFTER a successful apply (edit-draft case) still keeps the just-applied edits - nothing is lost, only the assignment itself needs a retry", async () => {
  state.builder.draft = templateDraft({ plan: { id: "editdraft-1", isEditDraft: true, editSourcePlanId: "template-1" } });
  state.builder.copyPlanId = "editdraft-1";
  state.builder.copyIntent = "assign";
  state.builder.copyIsEditDraft = true;
  state.builder.copyAthleteIds = ["athlete-a"];
  installFetchMock((url) => {
    if (url.endsWith("/editdraft-1/submit")) return { status: 200, body: templateDraft({ plan: { id: "template-1", isEditDraft: false, name: "Applied edits survive" } }) };
    return { status: 500, body: { error: "duplicate failed" } };
  });
  const action = fakeAction({ action: "builder-confirm-duplicate-plan" }, { textContent: "Assign" });

  await assert.rejects(() => handleBuilderPlanAction(action, noopHandlers()), /duplicate failed/);

  assert.equal(state.builder.draft.plan.id, "template-1", "the apply step's result must not be discarded just because the later duplicate step failed");
  assert.equal(state.builder.draft.plan.name, "Applied edits survive");
  assert.equal(state.builder.draft.plan.isEditDraft, false);
});

test("8. the existing plain 'Copy' flow (intent left as default 'copy') is completely unaffected - still navigates into the new plan, no assign banner", async () => {
  state.builder.draft = templateDraft();
  state.builder.copyPlanId = "template-1";
  state.builder.copyPlanType = "program";
  // copyIntent left at its default ("copy") - mirrors a plain more-menu Copy click.
  state.builder.copyAthleteIds = ["athlete-a"];
  const calls = installFetchMock((url) => ({ status: 201, body: templateDraft({ plan: { id: "copy-1", isTemplate: false } }) }));
  const action = fakeAction({ action: "builder-confirm-duplicate-plan" }, { textContent: "Create editable copy" });

  await handleBuilderPlanAction(action, noopHandlers());
  // A plain Copy also fires a pre-existing, unrelated fire-and-forget
  // loadBuilderNodePresets() background call on success (unchanged by this
  // feature) - filter to the /duplicate call itself rather than the raw
  // total, which the assign-intent tests above don't need to since that
  // background call only happens on this "copy" branch, never "assign".
  assert.equal(calls.filter((call) => call.url.endsWith("/duplicate")).length, 1);
  assert.equal(state.activeTab, "builder");
  assert.equal(state.builder.draft.plan.id, "copy-1", "a plain Copy still switches the Builder into editing the new copy");
  assert.equal(state.builder.assignResult, null, "no assign confirmation banner for a plain Copy");
});

test("9. renderCopyPlanModal: assign intent hides 'Reusable template', requires an athlete, and labels the confirm button 'Assign'", () => {
  state.builder.copyPlanId = "template-1";
  state.builder.copyPlanName = "Strength Template";
  state.builder.copyPlanType = "program";
  state.builder.copyIntent = "assign";
  state.builder.copyAthleteIds = [];
  const emptyHtml = renderCopyPlanModal(state);
  assert.doesNotMatch(emptyHtml, /Reusable template/);
  assert.match(emptyHtml, /data-action="builder-confirm-duplicate-plan" disabled/, "confirm must be disabled with zero athletes selected");
  assert.match(emptyHtml, />Assign</);

  state.builder.copyAthleteIds = ["athlete-a"];
  const withSelection = renderCopyPlanModal(state);
  assert.doesNotMatch(withSelection, /data-action="builder-confirm-duplicate-plan" disabled/);
});

test("10. renderCopyPlanModal: plain copy intent is unchanged - still offers 'Reusable template' and labels the confirm button 'Create editable copy'", () => {
  state.builder.copyPlanId = "template-1";
  state.builder.copyPlanName = "Strength Template";
  state.builder.copyPlanType = "program";
  state.builder.copyIntent = "copy";
  state.builder.copyAthleteIds = [];
  const html = renderCopyPlanModal(state);
  assert.match(html, /Reusable template/);
  assert.match(html, />Create editable copy</);
});
