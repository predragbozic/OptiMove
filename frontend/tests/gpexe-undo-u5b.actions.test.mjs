// J19-U5b: undoing an imported session from the Imports review. Driven through handleTrainingLoadAction with a fake
// fetch that keeps the routes' contracts (PR #390): GET undo-preview (always read-only) and POST undo-import with a
// requestKey, a reason and expected.eventId. Rules under test: the offer is for a platform admin only and only on an
// imported, not-undone session; the scope is read first; the reason is mandatory; a lost answer keeps its key and
// Check the result repeats the SAME request; a refusal says nothing was removed; an undone row is history, never
// "Imported"; no write runs twice and nothing leaves the screen while one is in flight.
import { test } from "node:test";
import assert from "node:assert/strict";

let confirmAnswer = true;
let confirmAsked = [];
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = { confirm: (q) => { confirmAsked.push(q); return confirmAnswer; }, matchMedia: () => ({ matches: false }) };

let fetchCalls;
let responder;
globalThis.fetch = async (url, options = {}) => {
  const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
  fetchCalls.push(call);
  const result = await responder(call);
  return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
};

// The textarea the person types in: the action reads it by its data attribute when the button is pressed.
let typedReason = "";
// v60 (O1): the later roster changes' own checkbox, present only when the screen shows it (laterBox null = not on the screen).
let laterBox = null;
globalThis.document.querySelector = (selector) => {
  if (selector === "[data-gpexe-undo-reason]") return { value: typedReason };
  if (selector === "[data-gpexe-undo-later-confirm]") return laterBox;
  return null;
};

const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { setGpexePollDelayForTests, inboxBucket, candidateGroup, isImportUndone, importsUnloadShouldWarn } = await import("../gpexe-import-data.js");
const { undoReasonProblem, UNDO_REASON_MAX, normalizeUndoReason, handleUndoReasonInput, sendUndo } = await import("../gpexe-undo-data.js");
const { confirmLeaveTrainingLoad } = await import("../training-load-actions.js");
const { guideSteps } = await import("../gpexe-guide-steps.js");
const { removedSummary } = await import("../gpexe-undo-view.js");

setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TEAM_B = "aaaaaaaa-0000-4000-8000-000000000002";
const HASH = "a".repeat(64);
const EVENT = "eeeeeeee-0000-4000-8000-000000000001";
const NEW_CAND = "cccccccc-0000-4000-8000-0000000000aa";
const ORG = {
  teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }, { id: TEAM_B, name: "U19", club_name: "Club" }],
  clubs: [],
  athletes: [{ id: "ath-1", name: "Ana Example", memberships: [{ teamId: TEAM_A, membershipType: "team", status: "active" }] }],
};

const render = () => {};
function resetState() {
  clearAllViewCache();
  state.currentUser = { id: "admin-1", activeWorkspace: { type: "platform", scopeId: null } };
  state.trainingLoad = emptyTrainingLoadState();
  fetchCalls = [];
  confirmAnswer = true;
  confirmAsked = [];
  typedReason = "";
  laterBox = null;
}

function status({ admin = true, identityAdmin = admin } = {}) {
  return {
    settings: { gpexeTeamId: "980" },
    importSwitch: { enabled: false, message: "off" },
    lastCheck: null,
    viewer: { canApprove: admin, approvalBasis: admin ? "platform_admin" : null, isPlatformAdmin: admin, ...(identityAdmin ? { identityAdmin: true } : {}) },
    approvalAvailable: true,
  };
}

function row(overrides = {}) {
  return {
    id: "cand-imp", gpexeTeamSessionId: "9977001", label: "FULL TRAINING 05.10.", sessionStartedAt: "2026-10-05T16:08:12Z",
    status: "imported", previewStatus: "ready", previewHash: HASH, counts: { created: 4, athletesNotImported: 0 }, changesToImported: 0,
    firstSeenAt: "2026-10-05T18:00:00Z", lastSeenAt: "2026-10-06T18:00:00Z", importedAt: "2026-10-07T09:00:00Z", importUndoneAt: null,
    supersededByCandidateId: null, supersededByCheckId: null,
    snapshot: { available: true, expiresAt: "2026-11-05T00:00:00Z" }, approvalBlockers: ["already_imported"],
    blockedCode: null, blockedSourceCode: null, sessionType: "FULL TRAINING", reasons: [],
    approval: { approvedAt: "2026-10-07T09:00:00Z", basis: "platform_admin", import: { counts: { results: 4 } } },
    ...overrides,
  };
}
const undoneRow = (overrides = {}) => row({ id: "cand-undone", status: "imported", importUndoneAt: "2026-11-08T07:00:00Z", approvalBlockers: ["import_undone"], ...overrides });
const pendingRow = (overrides = {}) => row({ id: "cand-pend", status: "pending", importedAt: null, approval: null, approvalBlockers: [], ...overrides });

const SCOPE = {
  eventId: EVENT, removedCounts: { metric_event_participants: 13, metric_values: 117, metric_event_segments: 2, activities: 1, metric_events: 1 },
  removedTotal: 160, deletionLogId: null, newCandidateId: null, undoneCandidateIds: ["cand-imp"], wouldOfferAgain: true,
};

function detailOf(c) {
  return {
    ...c,
    athletes: { "ath-1": { name: "Ana Example" } },
    preview: { version: 3, status: "ready", blocked: null, counts: { created: 4, changesToImported: 0 }, changesToImported: [], athletes: [], teamAthletesWithoutGpexeRecord: [], anomalies: [] },
  };
}

// The fake server keeps the candidates in `world`, and the undo changes them like the function does.
let world;
function server({ preview = () => ({ status: 200, body: { undoPreview: SCOPE } }), undo } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const [, , rest] = m;
    if (rest === "/status") return { status: 200, body: status(world.status) };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: [], units: {}, lastSeenRule: "" } };
    if (rest === "/athlete-links") return { status: 200, body: { links: [] } };
    if (rest.startsWith("/candidates?") || rest === "/candidates") {
      // Like listCandidates(): an undone row is listed only with ?includeSuperseded=true.
      const withAll = rest === "/candidates?includeSuperseded=true";
      const listed = world.candidates.filter((c) => withAll || (c.status !== "superseded" && !c.importUndoneAt));
      return { status: 200, body: { candidates: listed } };
    }
    const pre = rest.match(/^\/candidates\/([^/]+)\/undo-preview$/);
    if (pre) return preview(call);
    const run = rest.match(/^\/candidates\/([^/]+)\/undo-import$/);
    if (run) return undo(call);
    const detail = rest.match(/^\/candidates\/([^/?]+)$/);
    if (detail) {
      const c = world.candidates.find((x) => x.id === detail[1]);
      return c ? { status: 200, body: { candidate: detailOf(c) } } : { status: 404, body: { error: "notFound" } };
    }
    return { status: 404, body: { error: "notFound" } };
  };
}

async function act(action, dataset = {}, extra = {}) {
  await handleTrainingLoadAction({ dataset: { action, ...dataset }, ...extra }, { renderTrainingLoad: render });
}
const openImports = () => act("training-load-section", { section: "imports" });
const openCandidate = (id) => act("training-load-gpexe-open", { candidateId: id });
const html = () => renderTrainingLoadCoachHtml();
const gx = () => state.trainingLoad.gpexe;
const undoCalls = () => fetchCalls.filter((c) => /undo-import$/.test(c.url));
const previewCalls = () => fetchCalls.filter((c) => /undo-preview$/.test(c.url));
const outsideTech = (page) => page.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "");
function undoSection(page = html()) {
  const start = page.indexOf('aria-label="Undo this import"');
  return start < 0 ? "" : page.slice(start, page.indexOf("</section>", start));
}

function setup({ candidates = [row()], statusOver = {}, preview, undo } = {}) {
  resetState();
  world = { candidates: candidates.map((c) => ({ ...c })), status: statusOver };
  responder = server({ preview, undo });
}

// The undo the function performs: the requested candidate (and every version of the event) becomes undone; a fresh pending one is offered.
function performUndo() {
  for (const c of world.candidates) if (c.status === "imported" && !c.importUndoneAt) c.importUndoneAt = "2026-11-08T07:00:00Z";
  world.candidates.push(pendingRow({ id: NEW_CAND }));
}
const okUndo = (extra = {}) => ({ replayed: false, eventId: EVENT, removedCounts: SCOPE.removedCounts, removedTotal: 160, deletionLogId: "log-1", newCandidateId: NEW_CAND, undoneCandidateIds: ["cand-imp"], offeredAgain: true, previewReady: true, ...extra });

// ---------------------------------------------------------------------------
test("1. the offer: a platform admin sees 'Undo this import...' on an imported, not-undone session; nobody else, and no other session", async () => {
  setup();
  await openImports();
  await openCandidate("cand-imp");
  assert.match(undoSection(), /Undo this import\.\.\./);
  assert.equal(previewCalls().length, 0, "nothing is read until the button is pressed");

  // A club admin (identityAdmin without being a platform admin), a coach: the server would answer the identical 404, so nothing is offered.
  setup({ statusOver: { admin: false, identityAdmin: true } });
  await openImports();
  await openCandidate("cand-imp");
  assert.equal(undoSection(), "", "an administrator who is not a platform admin");
  setup({ statusOver: { admin: false, identityAdmin: false } });
  await openImports();
  await openCandidate("cand-imp");
  assert.equal(undoSection(), "", "a coach");
  assert.doesNotMatch(html(), /Undo this import/);

  // Not imported: nothing to undo.
  setup({ candidates: [pendingRow()] });
  await openImports();
  await openCandidate("cand-pend");
  assert.equal(undoSection(), "");
  // Already undone: history, no button.
  setup({ candidates: [undoneRow()] });
  await openImports();
  gx().includeSuperseded = true;
  await openImports();
  await openCandidate("cand-undone");
  assert.equal(undoSection(), "");
});

test("2. the scope is read first (read-only), names what goes, every approved version and whether the session is offered again; nothing is written", async () => {
  setup({ preview: () => ({ status: 200, body: { undoPreview: { ...SCOPE, undoneCandidateIds: ["cand-imp", "cand-imp-2"], wouldOfferAgain: true } } }) });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  assert.equal(previewCalls().length, 1);
  assert.equal(previewCalls()[0].method, "GET");
  assert.match(previewCalls()[0].url, new RegExp(`/teams/${TEAM_A}/candidates/cand-imp/undo-preview$`));
  assert.equal(undoCalls().length, 0);
  const s = undoSection();
  assert.match(s, /13 athletes&#039; records, 117 imported values, 2 drills, 1 activity/);
  assert.match(s, /This can&#039;t be undone here|This can't be undone here/);
  assert.match(s, /imported more than once with different data[\s\S]*all 2 imports together/, "both versions named");
  assert.match(s, /offered again for review/);
  assert.match(s, /Why is this import undone\? \(required\)/);
  assert.match(s, /maxlength="500"/);
  assert.match(s, /data-action="training-load-gpexe-undo-confirm"/);
  assert.equal(removedSummary({ metric_values: 1, activities: 1, metric_event_participants: 1 }), "1 athlete's record, 1 imported value, 1 activity");
});

test("3. the reason is mandatory: nothing is asked or sent without it; too long or with control characters is refused locally", async () => {
  setup();
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "   ";
  await act("training-load-gpexe-undo-confirm");
  assert.equal(undoCalls().length, 0);
  assert.equal(confirmAsked.length, 0, "no question without a reason");
  assert.match(html(), /Write why the import is undone\./);
  assert.equal(undoReasonProblem("x".repeat(UNDO_REASON_MAX + 1)).includes("too long"), true);
  assert.notEqual(undoReasonProblem("a\u0001b"), "");
  assert.equal(undoReasonProblem("Wrong athlete linked"), "");
  assert.equal(gx().undo.step, "ready");
});

test("4. the explicit question: declining sends nothing; accepting sends one request with the key, the trimmed reason and the event, and shows the result", async () => {
  setup({
    undo: () => { performUndo(); return { status: 200, body: { undo: okUndo() } }; },
  });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "  Linked to the wrong athlete  ";
  confirmAnswer = false;
  await act("training-load-gpexe-undo-confirm");
  assert.equal(confirmAsked.length, 1);
  assert.match(confirmAsked[0], /Remove 160 records of FULL TRAINING 05\.10\. from OptiMove\? This can't be undone here/);
  assert.equal(undoCalls().length, 0, "declined");
  confirmAnswer = true;
  await act("training-load-gpexe-undo-confirm");
  assert.equal(undoCalls().length, 1);
  const call = undoCalls()[0];
  assert.equal(call.method, "POST");
  assert.match(call.body.requestKey, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(call.body.reason, "Linked to the wrong athlete");
  assert.deepEqual(call.body.expected, { eventId: EVENT });
  const s = undoSection();
  assert.match(s, /Import undone\./);
  assert.match(s, /Removed: 13 athletes&#039; records/);
  assert.match(s, new RegExp(`data-action="training-load-gpexe-open" data-candidate-id="${NEW_CAND}"`), "the offered session can be opened");
  // The review was read again: the session is history now, never Imported; the list was read again too.
  assert.equal(isImportUndone(gx().detail.candidate), true);
  assert.doesNotMatch(html(), /gpexe-badge is-imported/);
  assert.ok(fetchCalls.some((c) => c.url.endsWith("/candidates") || c.url.includes("/candidates?")), "the list was read again");
  assert.ok(gx().candidates.some((c) => c.id === NEW_CAND), "the fresh pending candidate is listed");
});

test("5. an undone row is history, never 'Imported': hidden by default, under replaced/undone versions with its own badge, no approval, no undo", async () => {
  setup({ candidates: [undoneRow(), pendingRow({ id: NEW_CAND })] });
  const u = undoneRow();
  assert.equal(isImportUndone(u), true);
  assert.equal(candidateGroup(u), "undone");
  assert.equal(inboxBucket(u, gx()), "hidden");
  assert.equal(isImportUndone(row()), false);
  await openImports();
  let page = html();
  assert.doesNotMatch(page, /data-candidate-id="cand-undone"/, "not listed by default");
  assert.doesNotMatch(page, /Imported \(1\)/, "not counted as imported");
  // IMP1: the replaced and undone versions are shown in the Stays out tab; the Imported tab counts 0.
  await act("training-load-gpexe-tab", { importTab: "out" });
  await act("training-load-gpexe-superseded");
  page = html();
  assert.match(page, /data-candidate-id="cand-undone"/);
  assert.match(page, /data-import-tab="imported">Imported \(0\)</, "never counted under Imported");
  assert.match(page, /Replaced or no longer found versions \(1\)/);
  assert.match(page, /gpexe-badge is-superseded">Import undone</);
  await openCandidate("cand-undone");
  const review = html();
  assert.match(review, /This import was undone\./);
  assert.match(review, /gpexe-badge is-superseded">Import undone</);
  assert.doesNotMatch(review, /gpexe-badge is-imported/);
  assert.match(review, /Was imported 07\.10\.2026/);
  assert.doesNotMatch(review, /training-load-gpexe-approve"/);
  assert.equal(undoSection(review), "");
  assert.doesNotMatch(outsideTech(review), /import_undone/, "no code outside Technical details");
});

test("6. a lost answer is 'not confirmed', never 'nothing was removed': the key is kept and Check the result sends the SAME request", async () => {
  let attempt = 0;
  setup({
    undo: () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError("Failed to fetch");
      performUndo();
      return { status: 200, body: { undo: okUndo({ replayed: true }) } };
    },
  });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "Wrong link";
  await act("training-load-gpexe-undo-confirm");
  assert.equal(gx().undo.step, "unknown");
  let s = undoSection();
  assert.match(s, /We can't tell yet whether the import was undone/);
  assert.doesNotMatch(s, /Nothing was removed|Import undone\./);
  assert.match(s, /Check the result/);
  assert.equal(importsUnloadShouldWarn(gx()), true, "leaving asks");
  // Another undo cannot be started meanwhile.
  await act("training-load-gpexe-undo-open");
  assert.equal(previewCalls().length, 1);
  await act("training-load-gpexe-undo-check");
  assert.equal(undoCalls().length, 2);
  assert.deepEqual(undoCalls()[1].body, undoCalls()[0].body, "the identical request, key included");
  s = undoSection();
  assert.match(s, /Import undone\./);
  assert.match(s, /answer saved for the same request/);
  assert.equal(importsUnloadShouldWarn(gx()), false);
});

test("7. 503 outcome_unknown and an uncoded 5xx are not confirmed too; a 5xx the service wrote itself (internal_error) is a refusal", async () => {
  for (const [status, body, expected] of [[503, { error: "outcome_unknown", message: "not confirmed", retrySameRequest: true }, "unknown"], [502, null, "unknown"], [500, { error: "internal_error", message: "x" }, "refused"]]) {
    setup({ undo: () => ({ status, body }) });
    await openImports();
    await openCandidate("cand-imp");
    await act("training-load-gpexe-undo-open");
    typedReason = "Wrong link";
    await act("training-load-gpexe-undo-confirm");
    assert.equal(gx().undo.step, expected, `${status}`);
  }
});

test("8. a refusal says nothing was removed, shows the server's sentence and the counts it carries; the key is dropped and a new attempt gets a new key", async () => {
  let n = 0;
  setup({
    undo: () => {
      n += 1;
      if (n === 1) return { status: 409, body: { error: "calendar_link_exists", message: "This session is attached to a calendar event. Remove it from the calendar event first, then undo the import.", calendarLinks: 2 } };
      performUndo();
      return { status: 200, body: { undo: okUndo() } };
    },
  });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "Wrong link";
  await act("training-load-gpexe-undo-confirm");
  let s = undoSection();
  assert.match(s, /Nothing was removed\./);
  assert.match(s, /This session is attached to a calendar event\./);
  assert.match(s, /2 calendar events are attached\./);
  assert.doesNotMatch(outsideTech(s), /calendar_link_exists/);
  assert.match(s, /calendar_link_exists/, "the code is under Technical details");
  assert.equal(gx().undo.step, "refused");
  const firstKey = undoCalls()[0].body.requestKey;
  await act("training-load-gpexe-undo-cancel");
  assert.equal(gx().undo, null);
  await act("training-load-gpexe-undo-open");
  typedReason = "Wrong link";
  await act("training-load-gpexe-undo-confirm");
  assert.equal(undoCalls().length, 2);
  assert.notEqual(undoCalls()[1].body.requestKey, firstKey, "a refused key is never reused");
  assert.match(undoSection(), /Import undone\./);
});

test("9. the preview refused (404, or a refusal the function would raise): no form, the sentence, nothing written", async () => {
  setup({ preview: () => ({ status: 404, body: { error: "notFound", message: "Not found." } }) });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  assert.match(undoSection(), /not available for an undo/);
  assert.doesNotMatch(html(), /data-gpexe-undo-reason/);
  setup({ preview: () => ({ status: 409, body: { error: "calendar_link_exists", message: "This session is attached to a calendar event. Remove it from the calendar event first, then undo the import.", calendarLinks: 2 } }) });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  const s = undoSection();
  assert.match(s, /attached to a calendar event/);
  assert.match(s, /2 calendar events are attached\./);
  assert.equal(undoCalls().length, 0);
});

test("10. already undone (409 already_undone) is settled, not an error: the review is read again and shows the history", async () => {
  setup({
    undo: () => { performUndo(); return { status: 409, body: { error: "already_undone", message: "This import was already undone." } }; },
  });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "Wrong link";
  await act("training-load-gpexe-undo-confirm");
  assert.equal(gx().undo.step, "settled");
  assert.match(undoSection(), /This import was already undone\./);
  assert.equal(isImportUndone(gx().detail.candidate), true);
});

test("11. nothing leaves the screen over a write: the review cannot be closed while it runs, the team cannot be changed while it runs or is not confirmed", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  setup({ undo: async () => { await gate; performUndo(); return { status: 200, body: { undo: okUndo() } }; } });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "Wrong link";
  const running = act("training-load-gpexe-undo-confirm");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gx().undo.step, "sending");
  assert.match(undoSection(), /disabled>Undoing\.\.\./);
  await act("training-load-gpexe-close");
  assert.ok(gx().detail, "not closable while the write runs");
  const before = gx().teamId;
  await act("training-load-gpexe-team", {}, { value: TEAM_B });
  assert.equal(gx().teamId, before, "the team is not changed meanwhile");
  assert.equal(importsUnloadShouldWarn(gx()), true);
  release();
  await running;
  assert.equal(gx().undo.step, "done");
  await act("training-load-gpexe-close");
  assert.equal(gx().detail, null);
  assert.equal(gx().undo, null, "a finished undo is dropped with the review");
});

test("12. a not-confirmed result survives closing the review: reopening shows Check the result with the same key", async () => {
  setup({ undo: () => { throw new TypeError("Failed to fetch"); } });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "Wrong link";
  await act("training-load-gpexe-undo-confirm");
  const key = undoCalls()[0].body.requestKey;
  await act("training-load-gpexe-close");
  assert.equal(gx().detail, null);
  assert.equal(gx().undo.step, "unknown");
  await openCandidate("cand-imp");
  assert.match(undoSection(), /Check the result/);
  assert.equal(gx().undo.requestKey, key);
  const team = gx().teamId;
  await act("training-load-gpexe-team", {}, { value: TEAM_B });
  assert.equal(gx().teamId, team, "the team cannot be changed over an unconfirmed undo");
});

test("13. a team's undo state never shows on another session's review", async () => {
  setup({ candidates: [row(), row({ id: "cand-other", gpexeTeamSessionId: "9977002", label: "MATCH 06.10." })] });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  await act("training-load-gpexe-undo-cancel");
  await act("training-load-gpexe-close");
  await openCandidate("cand-other");
  assert.match(undoSection(), /Undo this import\.\.\./, "the other session starts from the offer");
  assert.equal(gx().undo, null);
});

test("3b. the WHOLE reason is checked before the question: a control character is refused without asking; a line break is a space", async () => {
  setup({ undo: () => { performUndo(); return { status: 200, body: { undo: okUndo() } }; } });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "bad\u0001reason";
  await act("training-load-gpexe-undo-confirm");
  assert.equal(confirmAsked.length, 0, "no destructive question for an input that is refused anyway");
  assert.equal(undoCalls().length, 0);
  assert.equal(gx().undo.step, "ready");
  assert.match(html(), /control characters/);
  assert.equal(normalizeUndoReason("line1\nline2\r\n\tline3 "), "line1 line2 line3");
  typedReason = "Wrong link\nsecond line";
  await act("training-load-gpexe-undo-confirm");
  assert.equal(confirmAsked.length, 1);
  assert.equal(undoCalls()[0].body.reason, "Wrong link second line");
});

test("6b. 'busy' or 'not found' on Check the result stays NOT confirmed (the first request may still commit); a saved answer then settles it", async () => {
  let n = 0;
  setup({
    undo: () => {
      n += 1;
      if (n === 1) throw new TypeError("Failed to fetch");
      if (n === 2) return { status: 409, body: { error: "try_again", message: "Another change was running; nothing was removed. Try again in a moment." } };
      if (n === 3) return { status: 404, body: { error: "notFound" } };
      performUndo();
      return { status: 200, body: { undo: okUndo({ replayed: true }) } };
    },
  });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "Wrong link";
  await act("training-load-gpexe-undo-confirm");
  const key = undoCalls()[0].body.requestKey;
  await act("training-load-gpexe-undo-check");
  assert.equal(gx().undo.step, "unknown");
  assert.equal(gx().undo.requestKey, key);
  assert.doesNotMatch(undoSection(), /Nothing was removed/);
  assert.match(undoSection(), /server was busy/);
  await act("training-load-gpexe-undo-check");
  assert.equal(gx().undo.step, "unknown", "404 on the resend too");
  await act("training-load-gpexe-undo-check");
  assert.equal(gx().undo.step, "done");
  assert.deepEqual(undoCalls().map((c) => c.body.requestKey), [key, key, key, key]);
});

test("6c. a busy answer to the FIRST request is a plain refusal: nothing was removed, back to the question with the reason kept", async () => {
  let n = 0;
  setup({ undo: () => { n += 1; if (n === 1) return { status: 409, body: { error: "try_again", message: "Another change was running; nothing was removed. Try again in a moment." } }; performUndo(); return { status: 200, body: { undo: okUndo() } }; } });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "Wrong link";
  await act("training-load-gpexe-undo-confirm");
  assert.equal(gx().undo.step, "ready");
  assert.match(undoSection(), /Nothing was removed\./);
  assert.match(undoSection(), /Wrong link/, "the reason is kept");
  await act("training-load-gpexe-undo-confirm");
  assert.notEqual(undoCalls()[1].body.requestKey, undoCalls()[0].body.requestKey);
  assert.equal(gx().undo.step, "done");
});

test("14. leaving Training Load asks over an undo that is running or not confirmed (the real leave guard); a decline blocks", async () => {
  setup({ undo: () => { throw new TypeError("Failed to fetch"); } });
  state.activeTab = "training-load";
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "Wrong link";
  await act("training-load-gpexe-undo-confirm");
  assert.equal(gx().undo.step, "unknown");
  confirmAnswer = false;
  confirmAsked = [];
  assert.equal(confirmLeaveTrainingLoad("settings"), false, "declined: stays");
  assert.match(confirmAsked.at(-1), /not confirmed/);
  confirmAnswer = true;
  assert.equal(confirmLeaveTrainingLoad("settings"), true);
  gx().undo.step = "sending";
  confirmAnswer = false;
  assert.equal(confirmLeaveTrainingLoad("settings"), false);
  assert.match(confirmAsked.at(-1), /being undone/);
});

test("15. an undone session does not count as imported in the setup guide", async () => {
  const base = { admin: true, conn: { status: "ready", connected: true, reconnect: false, bound: true }, check: { status: "succeeded" }, sourceAthletes: [], links: [] };
  const withImported = JSON.stringify(guideSteps({ ...base, candidates: [row()] }).steps.map((s) => s.state));
  const withUndone = JSON.stringify(guideSteps({ ...base, candidates: [undoneRow()] }).steps.map((s) => s.state));
  const none = JSON.stringify(guideSteps({ ...base, candidates: [] }).steps.map((s) => s.state));
  assert.notEqual(withImported, withUndone, "an imported session changes the guide");
  assert.equal(withUndone, none, "an undone one does not");
});

test("16. another session's undo that is not confirmed: no dead button on a second review, and the first review shows one message", async () => {
  setup({ candidates: [row(), row({ id: "cand-b", gpexeTeamSessionId: "9977002", label: "MATCH 06.10." })], undo: () => { throw new TypeError("Failed to fetch"); } });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "Wrong link";
  await act("training-load-gpexe-undo-confirm");
  await act("training-load-gpexe-close");
  await openCandidate("cand-b");
  assert.doesNotMatch(undoSection(), /undo-open/);
  assert.match(undoSection(), /undo for another session is not finished or not confirmed/);
  await act("training-load-gpexe-close");
  // The first one, if it had committed, never shows "This import was undone" next to "We can't tell yet".
  world.candidates[0].importUndoneAt = "2026-11-08T07:00:00Z";
  await openCandidate("cand-imp");
  assert.match(html(), /We can't tell yet/);
  assert.doesNotMatch(html(), /This import was undone\./);
});

test("17. what is typed is kept when the dialog is painted again", async () => {
  setup();
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  const handled = handleUndoReasonInput({ matches: (sel) => sel === "[data-gpexe-undo-reason]", value: "Typed so far" });
  assert.equal(handled, true);
  assert.equal(handleUndoReasonInput({ matches: () => false, value: "x" }), false);
  assert.match(html(), />Typed so far<\/textarea>/);
});

// ---------------------------------------------------------------------------
// v60 (O1 of J20): the roster work an undo removes
// ---------------------------------------------------------------------------
const FP = "f".repeat(64);
const FP2 = "e".repeat(64);
const COACH = "dddddddd-0000-4000-8000-000000000001";
const later = (n = 1, fingerprint = FP) => ({
  decisions: n, requests: n, completions: 1, completionLog: n, total: 2 * n + 1, fingerprint,
  list: Array.from({ length: n }, (_, i) => ({ athleteId: `aaaa000${i}-0000-4000-8000-000000000001`, athleteName: `Athlete <${i}>`, kind: "did_not_participate", reasonCode: "illness", reasonLabel: "Illness", byUserId: COACH, byName: "Coach Example", at: "2026-11-09T08:05:00Z" })),
});
const importWritten = (n) => ({ decisions: n, requests: n ? 1 : 0, completions: n ? 1 : 0, completionLog: n ? 1 : 0, total: n ? n + 3 : 0 });
const scopeWith = (rosterWork) => ({ ...SCOPE, rosterWork, needsRosterConfirmation: rosterWork.laterWork.total > 0 });
const noLater = { decisions: 0, requests: 0, completions: 0, completionLog: 0, total: 0, list: [], fingerprint: null };

test("18. states the import set: one warning with the count, no checkbox, and the undo sends no confirmation", async () => {
  setup({
    preview: () => ({ status: 200, body: { undoPreview: scopeWith({ importWritten: importWritten(5), laterWork: noLater }) } }),
    undo: () => { performUndo(); return { status: 200, body: { undo: okUndo() } }; },
  });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  const s = undoSection();
  assert.match(s, /The undo also removes the 5 attendance states the import set\./);
  assert.doesNotMatch(s, /data-gpexe-undo-later-confirm/);
  typedReason = "Wrong link";
  await act("training-load-gpexe-undo-confirm");
  assert.equal(undoCalls().length, 1);
  assert.equal(undoCalls()[0].body.laterRosterFingerprint, undefined);
  assert.deepEqual(Object.keys(undoCalls()[0].body).sort(), ["expected", "reason", "requestKey"]);
});

test("19. later changes: a second, separate warning lists them (names escaped, DD.MM.YYYY); nothing is asked or sent until their own box is ticked; then the fingerprint goes with the request", async () => {
  setup({
    preview: () => ({ status: 200, body: { undoPreview: scopeWith({ importWritten: importWritten(2), laterWork: later(1) }) } }),
    undo: () => { performUndo(); return { status: 200, body: { undo: okUndo() } }; },
  });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  let s = undoSection();
  assert.match(s, /The undo also removes the 2 attendance states the import set\./);
  assert.match(s, /Attendance was changed in the Roster tab after the import: 1 change\./);
  assert.match(s, /class="gpexe-undo-later-list" tabindex="0" aria-label="Later attendance changes"/, "the scrolling list is reachable by keyboard");
  assert.match(s, /Athlete &lt;0&gt;/, "a name is escaped");
  assert.doesNotMatch(s, /Athlete <0>/);
  assert.match(s, /Did not participate · Illness/);
  assert.match(s, /by Coach Example, \d{2}\.11\.2026 \d{2}:\d{2}/);
  assert.match(s, /data-gpexe-undo-later-confirm/);
  assert.doesNotMatch(s, /aaaa0000-0000|dddddddd-0000|illness"/, "no ids or codes on the screen");
  typedReason = "Wrong link";
  laterBox = { checked: false };
  await act("training-load-gpexe-undo-confirm");
  assert.equal(confirmAsked.length, 0, "no question without the tick");
  assert.equal(undoCalls().length, 0);
  s = undoSection();
  assert.match(s, /Tick &quot;Remove these later changes too&quot; to continue\. Nothing was removed\./);
  // In its own place, under the checkbox and above the reason field (not under the reason).
  assert.ok(s.indexOf("Tick &quot;Remove") > s.indexOf("data-gpexe-undo-later-confirm") && s.indexOf("Tick &quot;Remove") < s.indexOf("data-gpexe-undo-reason"));
  laterBox = { checked: true };
  await act("training-load-gpexe-undo-confirm");
  assert.equal(confirmAsked.length, 1);
  assert.match(confirmAsked[0], /This also removes 1 later attendance change made in the Roster tab\./);
  assert.equal(undoCalls().length, 1);
  assert.equal(undoCalls()[0].body.laterRosterFingerprint, FP, "sending the fingerprint is the confirmation");
  assert.equal(undoCalls()[0].body.confirmLaterRosterWork, undefined);
  assert.match(undoSection(), /Import undone\./);
});

test("20. the list changed meanwhile (roster_work_changed): nothing removed, the scope is read again and shown unticked with its note, and the next attempt sends the new fingerprint with a new key", async () => {
  let n = 0;
  let previews = 0;
  setup({
    // The server's scope as it is: the first list, then (after the colleague's change) the second.
    preview: () => { previews += 1; return { status: 200, body: { undoPreview: { ...scopeWith({ importWritten: importWritten(0), laterWork: n ? later(2, FP2) : later(1) }), removedTotal: n ? 99 : 40 } } }; },
    undo: () => {
      n += 1;
      if (n === 1) return { status: 409, body: { error: "roster_work_changed", message: "The session's attendance changed since you reviewed it. Nothing was removed. Review the undo again.", rosterWork: { importWritten: importWritten(0), laterWork: later(2, FP2) } } };
      performUndo();
      return { status: 200, body: { undo: okUndo() } };
    },
  });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "Wrong link";
  laterBox = { checked: true };
  await act("training-load-gpexe-undo-confirm");
  assert.equal(gx().undo.step, "ready");
  assert.equal(gx().undo.laterConfirmed, false);
  let s = undoSection();
  assert.equal(previews, 2, "the whole scope is read again after the refusal");
  assert.equal(gx().undo.preview.removedTotal, 99, "the totals moved with it");
  assert.match(s, /Attendance changed since you opened this\. Nothing was removed\. The list below now shows the current changes; tick the box again to remove them too\./);
  assert.ok(s.indexOf("Attendance changed since") < s.indexOf("Attendance was changed in the Roster tab"), "the note heads the later block");
  assert.match(s, /Attendance was changed in the Roster tab after the import: 2 changes\./);
  assert.doesNotMatch(s, /data-gpexe-undo-later-confirm checked/, "the new list is not ticked");
  const firstKey = undoCalls()[0].body.requestKey;
  laterBox = { checked: true };
  await act("training-load-gpexe-undo-confirm");
  assert.equal(undoCalls().length, 2);
  assert.equal(undoCalls()[1].body.laterRosterFingerprint, FP2);
  assert.notEqual(undoCalls()[1].body.requestKey, firstKey);
});

test("21. a lost answer of a confirmed undo: Check the result repeats exactly the confirmed request (key, reason, fingerprint)", async () => {
  let n = 0;
  setup({
    preview: () => ({ status: 200, body: { undoPreview: scopeWith({ importWritten: importWritten(0), laterWork: later(1) }) } }),
    undo: () => {
      n += 1;
      if (n === 1) return { status: 503, body: { error: "outcome_unknown", message: "not confirmed" } };
      performUndo();
      return { status: 200, body: { undo: okUndo({ replayed: true }) } };
    },
  });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  typedReason = "Wrong link";
  laterBox = { checked: true };
  await act("training-load-gpexe-undo-confirm");
  assert.equal(gx().undo.step, "unknown");
  await act("training-load-gpexe-undo-check");
  assert.equal(undoCalls().length, 2);
  assert.deepEqual(undoCalls()[1].body, undoCalls()[0].body);
  assert.equal(undoCalls()[1].body.laterRosterFingerprint, FP);
});

test("22. the checkbox's state is kept across a repaint", async () => {
  setup({ preview: () => ({ status: 200, body: { undoPreview: scopeWith({ importWritten: importWritten(0), laterWork: later(1) }) } }) });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  assert.equal(handleUndoReasonInput({ matches: (sel) => sel === "[data-gpexe-undo-later-confirm]", checked: true }), true);
  assert.match(html(), /data-gpexe-undo-later-confirm checked/);
});

test("23. the change count is the server's: past the 60 listed it says how many more; the session's Complete reads as a row of its own", async () => {
  const big = { ...later(60), changes: 75 };
  big.list = [{ athleteId: null, kind: "complete", reasonCode: null, byUserId: COACH, byName: "Coach Example", at: "2026-11-09T08:05:00Z" }, ...big.list.slice(0, 59)];
  setup({ preview: () => ({ status: 200, body: { undoPreview: scopeWith({ importWritten: importWritten(0), laterWork: big }) } }) });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  const s = undoSection();
  assert.match(s, /after the import: 75 changes\./);
  assert.match(s, /and 15 more\./);
  assert.match(s, /<strong>Session<\/strong>: marked complete/);
  typedReason = "Wrong link";
  laterBox = { checked: true };
  await act("training-load-gpexe-undo-confirm");
  assert.match(confirmAsked[0], /This also removes 75 later attendance changes made in the Roster tab\./);
});

test("24. the removed summary names the attendance states too", async () => {
  const { removedSummary } = await import("../gpexe-undo-view.js");
  assert.equal(removedSummary({ metric_event_participants: 2, activity_athlete_decisions: 3 }), "2 athletes' records, 3 attendance states");
});

test("25. sendUndo itself keeps each problem in its own place: a missing tick is the checkbox's, never the reason field's; nothing is sent", async () => {
  setup({ preview: () => ({ status: 200, body: { undoPreview: scopeWith({ importWritten: importWritten(0), laterWork: later(1) }) } }) });
  await openImports();
  await openCandidate("cand-imp");
  await act("training-load-gpexe-undo-open");
  const sent = await sendUndo("Wrong link", () => {}, { laterConfirmed: false });
  assert.equal(sent, false);
  assert.equal(gx().undo.reasonProblem, "");
  assert.match(gx().undo.laterProblem, /Remove these later changes too/);
  assert.equal(undoCalls().length, 0);
  const noReason = await sendUndo("", () => {}, { laterConfirmed: false });
  assert.equal(noReason, false);
  assert.match(gx().undo.reasonProblem, /Write why/);
  assert.equal(gx().undo.laterProblem, "", "the reason comes first; the tick is asked once the reason is right");
});
