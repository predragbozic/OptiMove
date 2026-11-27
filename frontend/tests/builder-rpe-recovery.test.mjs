import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<main id="content"></main>', { url: "http://localhost/" });
globalThis.document = dom.window.document;
globalThis.window = dom.window;

const { emptyBuilderState, state } = await import("../state.js");
const { handleBuilderDraftAction } = await import("../builder-actions.js");
const { closeBuilderRpeReview, currentBuilderRpeReview, mountBuilderRpeReview } = await import("../builder-rpe-review.js");

const { buildContextKey, getCacheEntry, setCacheData } = await import("../view-cache.js");

const originalFetch = globalThis.fetch;
const summary = { plans: 1, sessions: 3, trackingEnabledSessions: 2, rpeEnabledSessions: 1, trackTrainingLoadDefault: false, requestRpeDefault: false };
const reviewResponse = (review = {}) => new Response(JSON.stringify({
  code: "rpe_recovery_required",
  error: "Review needed",
  review: { token: "opaque-review", expiresAt: new Date(Date.now() + 60_000).toISOString(), scope: "this", summary, ...review },
}), { status: 409 });

let errors, requests, handlers;
const activate = (action) => handleBuilderDraftAction({ dataset: { action }, innerHTML: "Save" }, handlers);
const root = () => document.querySelector("#content");

beforeEach(() => {
  state.activeTab = "builder";
  state.currentUser = { id: "coach", activeWorkspace: { type: "team", scopeId: "team-1" } };
  state.builder = emptyBuilderState({ draft: {
    plan: { id: "draft-1", planType: "weekly", isEditDraft: true, editSourcePlanId: "original" },
    batch: { plans: [{ id: "original" }, { id: "other" }] },
    blocks: [],
  } });
  state.builder.batchEditChoice = { stage: "scope" };
  errors = [];
  requests = [];
  handlers = { renderBuilder() {}, renderBuilderError: error => errors.push(error.message) };
});

afterEach(async () => {
  closeBuilderRpeReview();
  await mountBuilderRpeReview(root());
  globalThis.fetch = originalFetch;
});

function respond(fn) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    return fn(body);
  };
}

test("eligible recovery renders a React dialog without exposing the token and cancel keeps the draft", async () => {
  const draft = state.builder.draft;
  respond(() => reviewResponse());
  await activate("builder-batch-edit-only");
  await mountBuilderRpeReview(root());
  const dialog = root().querySelector("dialog[open]");
  assert.match(dialog.textContent, /Confirm Training Load settings/);
  assert.match(dialog.textContent, /this plan/);
  assert.match(dialog.textContent, /Tracking on2/);
  assert.match(dialog.textContent, /Tracking for new sessionsOff/);
  assert.match(dialog.textContent, /Request RPE for new sessionsOff/);
  assert.ok(!root().innerHTML.includes("opaque-review"));
  assert.equal(dialog.querySelector('[data-action="builder-rpe-review-confirm"]').disabled, false);
  await activate("builder-rpe-review-cancel");
  assert.equal(requests.length, 1);
  assert.equal(currentBuilderRpeReview(), null);
  assert.equal(state.builder.draft, draft);
  assert.equal(state.builder.batchEditChoice.stage, "scope");
});

test("confirmation sends the exact initiating batch selection and can only be sent once", async () => {
  state.builder.batchEditChoice = { stage: "ask", data: { applyTo: ["chosen"], choiceToken: "previous-choice" } };
  respond(body => body.rpeReviewToken
    ? new Response(JSON.stringify({ batchEdit: { appliedCount: 1 } }), { status: 200 })
    : reviewResponse());
  await activate("builder-batch-edit-others");
  let release;
  handlers.flushBuilderAutosaves = () => new Promise(resolve => { release = resolve; });
  state.builder.batchEditChoice.data.applyTo = ["new-local-choice"];
  const confirmation = activate("builder-rpe-review-confirm");
  await activate("builder-rpe-review-confirm");
  await activate("builder-batch-edit-all");
  release();
  await confirmation;
  const first = { responseMode: "summary", batchScope: "all", applyTo: ["chosen"], choiceToken: "previous-choice" };
  assert.deepEqual(requests, [
    { url: "/api/builder/plans/draft-1/submit", body: first },
    { url: "/api/builder/plans/draft-1/submit", body: { ...first, rpeReviewToken: "opaque-review" } },
  ]);
  assert.equal(currentBuilderRpeReview(), null);
  assert.equal(state.builder.batchEditChoice.stage, "done");
});

test("an autosaved draft change or workspace switch makes a pending review stale", async () => {
  respond(() => reviewResponse());
  for (const mutate of [
    () => { state.builder.draft.plan.name = "Changed while the dialog was open"; },
    () => { state.currentUser.activeWorkspace.scopeId = "another-team"; },
  ]) {
    await activate("builder-batch-edit-only");
    handlers.flushBuilderAutosaves = async () => mutate();
    await activate("builder-rpe-review-confirm");
    handlers.flushBuilderAutosaves = null;
    assert.equal(currentBuilderRpeReview(), null);
  }
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ body }) => !Object.hasOwn(body, "rpeReviewToken")));
  assert.equal(errors.length, 2);
});

test("a group hold without a token returns to scope selection without narrowing or sending another save", async () => {
  respond(() => reviewResponse({ token: undefined }));
  state.builder.batchEditChoice = { stage: "ask", data: { applyTo: ["other"], choiceToken: "ask" } };
  await activate("builder-batch-edit-others");
  assert.equal(currentBuilderRpeReview(), null);
  assert.deepEqual(state.builder.batchEditChoice, { stage: "scope" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.batchScope, "all");
  assert.match(errors[0], /Choose this athlete only/);
});

test("expired or malformed reviews never offer confirmation", async () => {
  for (const review of [
    { expiresAt: "invalid" },
    { expiresAt: new Date(Date.now() - 1).toISOString() },
    { summary: { ...summary, rpeEnabledSessions: 9 } },
    { summary: { ...summary, requestRpeDefault: "true" } },
    { summary: { ...summary, trackTrainingLoadDefault: undefined } },
    { summary: { ...summary, requestRpeDefault: true } },
    { scope: "all" },
  ]) {
    respond(() => reviewResponse(review));
    await activate("builder-batch-edit-only");
    assert.equal(currentBuilderRpeReview(), null);
  }
  assert.equal(requests.length, 7);
});

test("a permission refusal after clicking Confirm leaves the open draft and original batch choice available", async () => {
  const draft = state.builder.draft;
  respond(body => body.rpeReviewToken
    ? new Response(JSON.stringify({ error: "Draft program not found" }), { status: 404 })
    : reviewResponse());
  await activate("builder-batch-edit-only");
  await activate("builder-rpe-review-confirm");
  assert.equal(requests.length, 2);
  assert.equal(state.builder.draft, draft);
  assert.deepEqual(state.builder.batchEditChoice, { stage: "scope" });
  assert.equal(currentBuilderRpeReview(), null);
  assert.match(errors[0], /Reopen the draft/);
});

test("a draft without sessions still exposes both enabled plan defaults before confirming", async () => {
  const defaultsOnly = {
    plans: 1, sessions: 0, trackingEnabledSessions: 0, rpeEnabledSessions: 0,
    trackTrainingLoadDefault: true, requestRpeDefault: true,
  };
  respond(() => reviewResponse({ summary: defaultsOnly }));
  await activate("builder-batch-edit-only");
  await mountBuilderRpeReview(root());
  const dialog = root().querySelector("dialog[open]");
  const fields = Object.fromEntries([...dialog.querySelectorAll("dl div")].map(row =>
    [row.querySelector("dt").textContent, row.querySelector("dd").textContent]));
  assert.equal(fields.Sessions, "0");
  assert.equal(fields["Tracking on"], "0");
  assert.equal(fields["RPE requested"], "0");
  assert.equal(fields["Tracking for new sessions"], "On");
  assert.equal(fields["Request RPE for new sessions"], "On");
});

test("an acknowledged save invalidates drafts even when the user navigated during the request", async () => {
  const key = buildContextKey([state.currentUser.id]);
  setCacheData("builderDrafts", key, [{ id: "draft-1" }]);
  let resolveAck, requestSent;
  const sent = new Promise(resolve => { requestSent = resolve; });
  respond(body => {
    if (!body.rpeReviewToken) return reviewResponse();
    requestSent();
    return new Promise(resolve => { resolveAck = resolve; });
  });
  await activate("builder-batch-edit-only");
  const saving = activate("builder-rpe-review-confirm");
  await sent;
  state.activeTab = "home";
  resolveAck(new Response(JSON.stringify({ plan: { id: "original" } }), { status: 200 }));
  await saving;
  assert.equal(state.activeTab, "home");
  assert.ok(!getCacheEntry("builderDrafts", key));
  assert.equal(currentBuilderRpeReview(), null);
});

test("a stale confirmation asks to review the saved draft again", async () => {
  const draft = state.builder.draft;
  respond(body => body.rpeReviewToken
    ? new Response(JSON.stringify({ code: "rpe_recovery_required" }), { status: 409 })
    : reviewResponse());
  await activate("builder-batch-edit-only");
  await activate("builder-rpe-review-confirm");
  assert.equal(requests.length, 2);
  assert.equal(state.builder.draft, draft);
  assert.equal(currentBuilderRpeReview(), null);
  assert.deepEqual(errors, ["The draft is still saved. Save again to review the current Training Load settings."]);
});
