// Imports phase 4b: choosing clean Ready sessions, one confirmation, ONE
// POST /imports for the whole selection, one understandable result per
// session (never "failed" or "nothing imported" for an unconfirmed one), and
// the local sessions calendar built from the candidates list alone. Driven
// through handleTrainingLoadAction with a fake fetch, like the other
// Training Load suites.
import { test } from "node:test";
import assert from "node:assert/strict";

let confirmAnswer = true;
let confirmQuestions = [];
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: (q) => { confirmQuestions.push(q); return confirmAnswer; }, matchMedia: () => ({ matches: false }) };

let fetchCalls;
function installFetchMock(responder) {
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    fetchCalls.push(call);
    const result = await responder(call);
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
}

const { handleTrainingLoadAction, confirmLeaveTrainingLoad, resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { setGpexePollDelayForTests, calendarDayKey } = await import("../gpexe-import-data.js");

setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TEAM_B = "bbbbbbbb-0000-4000-8000-000000000002";
const hashOf = (n) => String(n).padStart(2, "0").repeat(32);
const ORG = {
  teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }, { id: TEAM_B, name: "U19", club_name: "Club" }],
  clubs: [],
  athletes: [{ id: "ath-1", name: "Ana Example", memberships: [{ teamId: TEAM_A, membershipType: "team", status: "active" }] }],
};

function fakeAction(dataset, extra = {}) {
  return { dataset, ...extra };
}

let renders;
function render() {
  renders += 1;
}

function resetState() {
  clearAllViewCache();
  state.activeTab = "training-load";
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  confirmAnswer = true;
  confirmQuestions = [];
  renders = 0;
}

function status({ enabled = true, canApprove = true } = {}) {
  return {
    settings: { gpexeTeamId: "980" },
    importSwitch: { enabled, message: enabled ? "Approved imports can write results and activities in this environment." : "Import writing is switched off in this environment: checks and previews are saved, but no result or activity can be written." },
    lastCheck: null,
    viewer: { canApprove, approvalBasis: canApprove ? "team_grant" : null, isPlatformAdmin: false },
    approvalAvailable: true,
  };
}

// A clean Ready session as the list returns it (with its preview hash).
function ready(n, overrides = {}) {
  return {
    id: `cand-${n}`, gpexeTeamSessionId: `70${String(n).padStart(2, "0")}`, label: `FULL TRAINING ${n}`, sessionStartedAt: `2026-09-${String(n).padStart(2, "0")}T16:08:12Z`,
    status: "pending", previewStatus: "ready", previewHash: hashOf(n), counts: { created: 4, athletesNotImported: 0 }, changesToImported: 0,
    snapshot: { available: true, expiresAt: "2026-10-14T00:00:00Z" }, approvalBlockers: [],
    blockedCode: null, blockedSourceCode: null, sessionType: "FULL TRAINING", reasons: [], lastSeenAt: "2026-09-22T10:00:00Z", ...overrides,
  };
}

function candidateDetail(c) {
  return { ...c, athletes: {}, approval: c.status === "imported" ? { id: `appr-${c.id}`, approvedAt: "2026-09-22T12:00:00Z", basis: "team_grant" } : null, preview: { version: 2, status: "ready", blocked: null, counts: c.counts, changesToImported: [], athletes: [], teamAthletesWithoutGpexeRecord: [], anomalies: [] } };
}

function gpexeServer({ teamStatus = {}, candidates = [], onImports, onCandidate } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const [, team, rest] = m;
    if (rest === "/status") return { status: 200, body: status(teamStatus[team] || {}) };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: [], units: { duration: "min", distance: "m", maxSpeed: "km/h" }, lastSeenRule: "" } };
    if (rest === "/athlete-links" && call.method === "GET") return { status: 200, body: { links: [] } };
    if (rest.startsWith("/candidates?") || rest === "/candidates") {
      const list = typeof candidates === "function" ? candidates(call, team) : candidates;
      return { status: 200, body: { candidates: team === TEAM_A ? list : [] } };
    }
    if (rest === "/imports" && call.method === "POST") return onImports ? onImports(call, team) : { status: 200, body: { results: [], summary: {} } };
    const detail = rest.match(/^\/candidates\/([^/?]+)$/);
    if (detail) {
      if (onCandidate) return onCandidate(call, detail[1]);
      const list = typeof candidates === "function" ? candidates(call, team) : candidates;
      const c = list.find((x) => x.id === detail[1]);
      return c ? { status: 200, body: { candidate: candidateDetail(c) } } : { status: 404, body: { error: "notFound" } };
    }
    return { status: 404, body: { error: "notFound" } };
  };
}

async function act(action, dataset = {}, extra = {}) {
  await handleTrainingLoadAction(fakeAction({ action, ...dataset }, extra), { renderTrainingLoad: render });
}

async function openImports() {
  await act("training-load-section", { section: "imports" });
}

function pick(candidateId, checked = true) {
  return act("training-load-gpexe-pick", { candidateId }, { checked });
}

const html = () => renderTrainingLoadCoachHtml();
const gx = () => state.trainingLoad.gpexe;
const candidatesReads = () => fetchCalls.filter((c) => c.method === "GET" && /\/candidates(\?|$)/.test(c.url)).length;
const importPosts = () => fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith("/imports"));
// The batch dialog's markup, when it is open.
function dialog() {
  const page = html();
  const start = page.indexOf('class="panel builder-athlete-picker gpexe-detail imports-batch"');
  assert.ok(start > 0, "the batch dialog is open");
  return page.slice(start);
}
function checkboxes(page = html()) {
  return [...page.matchAll(/<input type="checkbox" data-action="training-load-gpexe-pick" data-candidate-id="([^"]+)"[^>]*>/g)].map((m) => ({ id: m[1], checked: / checked/.test(m[0]), disabled: / disabled/.test(m[0]) }));
}
function result(summary = {}, results = []) {
  return { status: 200, body: { results, summary: { requested: results.length, imported: 0, alreadyImported: 0, refused: 0, unknown: 0, notAttempted: 0, ...summary } } };
}

test("1. nothing is chosen before the coach chooses: every Ready checkbox is empty, 0 selected, Review disabled", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1), ready(2), ready(3)] }));
  await openImports();
  const boxes = checkboxes();
  assert.deepEqual(boxes.map((b) => [b.id, b.checked]), [["cand-1", false], ["cand-2", false], ["cand-3", false]]);
  assert.match(html(), /<strong>0 selected<\/strong> · maximum 10/);
  assert.match(html(), /data-action="training-load-gpexe-batch-review" disabled >Review sessions</);
  assert.deepEqual(gx().batch.selected, {});
});

test("2. only a clean Ready session with a valid previewHash can be chosen; not a stale review, not without the right or with the switch off", async () => {
  resetState();
  const list = [
    ready(1),
    ready(2, { previewHash: null }),
    ready(3, { previewHash: "not-a-hash" }),
    ready(4, { reasons: [{ code: "athletes_not_linked", count: 1 }] }),
    ready(5, { changesToImported: 2, reasons: [{ code: "changes_to_imported_results", count: 2 }] }),
    ready(6, { status: "imported", importedAt: "2026-09-20T10:00:00Z" }),
    ready(7, { status: "blocked", previewStatus: "blocked", blockedCode: "unsupported_session_type", blockedSourceCode: "unsupported_category" }),
    ready(8, { snapshot: { available: false, reason: "expired", expiresAt: "2026-09-01T00:00:00Z" } }),
  ];
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: list }));
  await openImports();
  assert.deepEqual(checkboxes().map((b) => b.id), ["cand-1"], "only the clean Ready session with a hash gets a checkbox");
  // The rows without a checkbox still open their review.
  assert.match(html(), /data-action="training-load-gpexe-open" data-candidate-id="cand-2"/);
  // A pick of an unchoosable session is refused, and never staged.
  await pick("cand-2");
  await pick("cand-4");
  assert.deepEqual(gx().batch.selected, {});
  // A review made before a link change is not choosable: the selection is dropped with a sentence.
  await pick("cand-1");
  assert.deepEqual(Object.keys(gx().batch.selected), ["cand-1"]);
  gx().linkSeq = 1;
  gx().linkCheckStartedAt = null;
  await act("training-load-gpexe-superseded"); // any reload: the selection is checked again
  await act("training-load-gpexe-superseded");
  assert.deepEqual(gx().batch.selected, {});
  assert.match(html(), /1 selected session was removed from the selection: it changed or is no longer ready/);
  assert.equal(checkboxes().length, 0);

  // No right to approve: review only, nothing to choose.
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: { canApprove: false } }, candidates: [ready(1)] }));
  await openImports();
  assert.equal(checkboxes().length, 0);
  assert.ok(!/imports-select-bar/.test(html()));
  assert.match(html(), /Review only - an approver imports these/);
  // The switch off: the same.
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: { enabled: false } }, candidates: [ready(1)] }));
  await openImports();
  assert.equal(checkboxes().length, 0);
  assert.match(html(), /Review only - importing waits until it is turned on/);
});

test("3. Select all / Select first 10 / Clear selection follow the list's order, stop at 10, and say how many stay for the next batch", async () => {
  resetState();
  const twelve = Array.from({ length: 12 }, (_, i) => ready(i + 1));
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: twelve }));
  await openImports();
  assert.match(html(), /data-action="training-load-gpexe-batch-select"  >Select first 10</);
  assert.match(html(), /2 more sessions stay for the next batch\./);
  await act("training-load-gpexe-batch-select");
  assert.deepEqual(Object.keys(gx().batch.selected), twelve.slice(0, 10).map((c) => c.id), "the first ten in the list's order");
  assert.match(html(), /<strong>10 selected<\/strong> · maximum 10 · maximum reached, import these first/);
  const boxes = checkboxes();
  assert.deepEqual(boxes.filter((b) => !b.checked).map((b) => [b.id, b.disabled]), [["cand-11", true], ["cand-12", true]], "the rest cannot be ticked");
  assert.match(html(), /data-action="training-load-gpexe-batch-select" disabled >Select all</, "never 'Select first 0'");
  // An eleventh pick is refused.
  await pick("cand-11");
  assert.equal(Object.keys(gx().batch.selected).length, 10);
  await act("training-load-gpexe-batch-clear");
  assert.deepEqual(gx().batch.selected, {});
  assert.match(html(), /data-action="training-load-gpexe-batch-clear" disabled >Clear selection</);
  // Three sessions: "Select all".
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1), ready(2), ready(3)] }));
  await openImports();
  assert.match(html(), /data-action="training-load-gpexe-batch-select"  >Select all</);
  await act("training-load-gpexe-batch-select");
  assert.deepEqual(Object.keys(gx().batch.selected), ["cand-1", "cand-2", "cand-3"]);
  assert.match(html(), /data-action="training-load-gpexe-batch-review"  >Review 3 sessions</);
});

test("4./5./6. Review shows the sessions (no hash, id or code in the open), Back keeps the selection, Import sends ONE POST with the exact ids and hashes in the list's order", async () => {
  resetState();
  const list = [ready(1), ready(2), ready(3)];
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: {} },
    candidates: list,
    onImports: () => result({ imported: 2 }, [{ candidateId: "cand-1", outcome: "imported", code: null, approvalId: "appr-1", commitConfirmation: "confirmed" }, { candidateId: "cand-3", outcome: "imported", code: null, approvalId: "appr-3", commitConfirmation: "confirmed" }]),
  }));
  await openImports();
  // Chosen in the other order: the request keeps the list's order.
  await pick("cand-3");
  await pick("cand-1");
  await act("training-load-gpexe-batch-review");
  let d = dialog();
  assert.match(d, /aria-label="Import 2 sessions"/);
  assert.match(d, /<strong>Import these sessions exactly as found in the last search\.<\/strong>/);
  assert.match(d, /<strong>FULL TRAINING 1<\/strong> <span class="muted">01\.09\.2026 /);
  assert.match(d, /<strong>FULL TRAINING 3<\/strong>/);
  assert.match(d, /one by one and the result is shown for each/);
  const open = d.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "");
  assert.ok(!open.includes("cand-1") && !open.includes("cand-3"), "ids only under Technical details");
  assert.ok(!html().includes(hashOf(1)) && !html().includes(hashOf(3)), "a hash is never in the page");
  assert.match(d, /Candidate ids<\/dt><dd>cand-1, cand-3<\/dd>/);
  // Back keeps the selection.
  await act("training-load-gpexe-batch-back");
  assert.ok(!/imports-batch"/.test(html()));
  assert.deepEqual(Object.keys(gx().batch.selected), ["cand-3", "cand-1"]);
  assert.match(html(), /<strong>2 selected<\/strong>/);
  await act("training-load-gpexe-batch-review");
  await act("training-load-gpexe-batch-send");
  const posts = importPosts();
  assert.equal(posts.length, 1, "exactly one request for the whole selection");
  assert.deepEqual(posts[0].body, { candidateIds: ["cand-1", "cand-3"], previewHashes: { "cand-1": hashOf(1), "cand-3": hashOf(3) } });
  assert.equal(fetchCalls.filter((c) => c.url.includes("/approve")).length, 0, "no per-session approve calls");
  assert.ok(!html().includes(hashOf(1)), "the hash is not in the result either");
});

test("7. a second click while the request runs sends nothing; the dialog cannot be closed meanwhile", async () => {
  resetState();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: {} },
    candidates: [ready(1)],
    onImports: async () => { await gate; return result({ imported: 1 }, [{ candidateId: "cand-1", outcome: "imported", code: null, approvalId: "appr-1", commitConfirmation: "confirmed" }]); },
  }));
  await openImports();
  await pick("cand-1");
  await act("training-load-gpexe-batch-review");
  const first = act("training-load-gpexe-batch-send");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gx().batch.sending, true);
  let d = dialog();
  assert.match(d, /data-action="training-load-gpexe-batch-send" disabled>Importing\.\.\.</);
  assert.match(d, /data-action="training-load-gpexe-batch-back" disabled>Back</);
  assert.match(d, /aria-label="Close" disabled>/);
  await act("training-load-gpexe-batch-send");
  await act("training-load-gpexe-batch-back");
  assert.equal(gx().batch.confirming, true, "a close while sending does nothing");
  release();
  await first;
  assert.equal(importPosts().length, 1);
  assert.match(dialog(), /aria-label="Import result"/);
});

test("8./11. every outcome is one understandable line; the list is read again exactly once; imported ones leave the selection, a refused one stays only while still Ready with the same hash", async () => {
  resetState();
  let afterImport = false;
  const before = [ready(1), ready(2), ready(3), ready(4), ready(5), ready(6), ready(7)];
  const after = [
    ready(1, { status: "imported", importedAt: "2026-09-22T12:00:00Z" }),
    ready(2, { status: "imported", importedAt: "2026-09-21T12:00:00Z" }),
    ready(3, { previewHash: hashOf(33) }), // preview_changed: recomputed
    ready(4, { changesToImported: 1, reasons: [{ code: "changes_to_imported_results", count: 1 }] }),
    ready(5, { reasons: [{ code: "athletes_not_linked", count: 1 }] }), // not ready now
    ready(6), // unknown: pending, marked
    ready(7), // not attempted, still Ready with the same hash
  ];
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: {} },
    candidates: () => (afterImport ? after : before),
    onImports: () => {
      afterImport = true;
      return result({ imported: 1, alreadyImported: 1, refused: 3, unknown: 1, notAttempted: 1 }, [
        { candidateId: "cand-1", outcome: "imported", code: null, approvalId: "appr-1", commitConfirmation: "verified_after_commit_error" },
        { candidateId: "cand-2", outcome: "already_imported", code: "already_imported", approvalId: "appr-2" },
        { candidateId: "cand-3", outcome: "refused", code: "preview_changed", approvalId: null, reviewAgain: { candidateId: "cand-3", href: "/x" } },
        { candidateId: "cand-4", outcome: "refused", code: "changes_need_acceptance", approvalId: null, changesToImported: 1 },
        { candidateId: "cand-5", outcome: "refused", code: "not_ready", approvalId: null, reasons: [{ code: "athletes_not_linked", count: 1 }] },
        { candidateId: "cand-6", outcome: "import_outcome_unknown", code: "import_outcome_unknown", approvalId: "appr-6", verify: { candidateId: "cand-6", approvalId: "appr-6", approvalHref: "/a", candidateHref: "/c", imported: "i", notImported: "n", retry: "r" } },
        { candidateId: "cand-7", outcome: "not_attempted", code: null, approvalId: null },
      ]);
    },
  }));
  await openImports();
  await act("training-load-gpexe-batch-select");
  assert.equal(Object.keys(gx().batch.selected).length, 7);
  const readsBefore = candidatesReads();
  await act("training-load-gpexe-batch-review");
  await act("training-load-gpexe-batch-send");
  assert.equal(candidatesReads() - readsBefore, 1, "the list is read again once after the answer");
  const d = dialog();
  assert.match(d, /aria-label="Import result"/);
  assert.match(d, /1 imported · 1 already imported · 3 not imported · 1 not confirmed · 1 not tried\./);
  assert.match(d, /FULL TRAINING 1<\/strong>[\s\S]*?Imported \(the confirmation arrived late, but the import is in OptiMove\)\./);
  assert.match(d, /FULL TRAINING 2<\/strong>[\s\S]*?Already imported, nothing more was written\./);
  assert.match(d, /FULL TRAINING 3<\/strong>[\s\S]*?Session changed - review it again\.<\/span><button [^>]*data-candidate-id="cand-3">Review again</);
  assert.match(d, /FULL TRAINING 4<\/strong>[\s\S]*?Open and review the changes individually\.<\/span><button [^>]*data-candidate-id="cand-4">Open</);
  assert.match(d, /FULL TRAINING 5<\/strong>[\s\S]*?Not imported: it is not ready any more - see its row under Needs attention\./);
  assert.match(d, /FULL TRAINING 6<\/strong>[\s\S]*?Import result not confirmed - check it before doing anything else\.[^<]*<\/span><button [^>]*data-candidate-id="cand-6">Check result</);
  assert.match(d, /FULL TRAINING 7<\/strong>[\s\S]*?Not tried because the batch stopped\./);
  const open = d.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "");
  assert.ok(!/failed|nothing was imported/i.test(open), "never 'failed' or 'nothing imported'");
  assert.ok(!/preview_changed|import_outcome_unknown|not_ready|appr-6/.test(open), "codes and ids only under Technical details");
  // The selection: every session the server decided about (1-6) left it with
  // the answer; 7 (not tried) stays because the fresh list still shows it Ready with the same hash.
  assert.deepEqual(Object.keys(gx().batch.selected), ["cand-7"]);
  assert.match(dialog(), /1 session that was not imported is still ticked\. After Done, Review 1 session opens the confirmation to import it again\./);
  assert.ok(gx().uncertain["cand-6"], "the unconfirmed session keeps its mark");
  assert.deepEqual(gx().uncertain["cand-6"].verify.approvalId, "appr-6");
  assert.equal(importPosts().length, 1, "nothing is sent again by itself");
  // The result stays until Done; the row of 6 carries the mark behind it.
  await act("training-load-gpexe-batch-done");
  assert.ok(!/imports-batch"/.test(html()));
  assert.match(html(), /<strong>FULL TRAINING 6<\/strong>[\s\S]*?Result not confirmed/);
  assert.ok(!/removed from the selection/.test(html()), "nothing to drop: the refused ones left with the answer, the not-tried one is still Ready with the same hash");
  assert.match(html(), /<strong>1 selected<\/strong>/);
});

test("8b. Check result on an unconfirmed session opens its review with the check the single import uses; the result comes back on close", async () => {
  resetState();
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: {} },
    candidates: [ready(1)],
    onImports: () => result({ unknown: 1 }, [{ candidateId: "cand-1", outcome: "import_outcome_unknown", code: "import_outcome_unknown", approvalId: "appr-1", verify: { candidateId: "cand-1", approvalId: "appr-1", approvalHref: "/a", candidateHref: "/c", imported: "i", notImported: "n", retry: "r" } }]),
  }));
  await openImports();
  await pick("cand-1");
  await act("training-load-gpexe-batch-review");
  await act("training-load-gpexe-batch-send");
  await act("training-load-gpexe-batch-open", { candidateId: "cand-1" });
  const page = html();
  assert.match(page, /We can't tell yet whether this session was imported\./);
  assert.match(page, /data-action="training-load-gpexe-verify" >Check the result</);
  assert.ok(!/imports-batch"/.test(page), "the result waits behind the review");
  await act("training-load-gpexe-close");
  assert.match(dialog(), /aria-label="Import result"/);
});

test("9. a session whose preview was recomputed after it was chosen is dropped from the selection with a sentence, and is never sent with the new hash", async () => {
  resetState();
  let recomputed = false;
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: {} },
    candidates: () => [ready(1, recomputed ? { previewHash: hashOf(11) } : {}), ready(2)],
    onImports: (call) => {
      assert.deepEqual(call.body.candidateIds, ["cand-2"], "only the unchanged session is sent");
      return result({ imported: 1 }, [{ candidateId: "cand-2", outcome: "imported", code: null, approvalId: "appr-2", commitConfirmation: "confirmed" }]);
    },
  }));
  await openImports();
  await pick("cand-1");
  await pick("cand-2");
  recomputed = true;
  await act("training-load-gpexe-superseded");
  await act("training-load-gpexe-superseded");
  assert.deepEqual(Object.keys(gx().batch.selected), ["cand-2"]);
  assert.match(html(), /1 selected session was removed from the selection/);
  await act("training-load-gpexe-batch-review");
  await act("training-load-gpexe-batch-send");
  assert.equal(importPosts().length, 1);
  assert.deepEqual(importPosts()[0].body.previewHashes, { "cand-2": hashOf(2) });
});

test("10. a lost answer never reads as failed: every session is 'not confirmed', the list is read once and only what it shows as imported is confirmed, Check again reads it again, nothing is sent again", async () => {
  resetState();
  let calls = 0;
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: {} },
    candidates: () => {
      calls += 1;
      // After the lost answer the server did import the first one.
      return [ready(1, calls >= 2 ? { status: "imported", importedAt: "2026-09-22T12:00:00Z" } : {}), ready(2)];
    },
    onImports: () => { throw new TypeError("Failed to fetch"); },
  }));
  await openImports();
  await act("training-load-gpexe-batch-select");
  const readsBefore = candidatesReads();
  await act("training-load-gpexe-batch-review");
  await act("training-load-gpexe-batch-send");
  assert.equal(candidatesReads() - readsBefore, 1, "read again once");
  let d = dialog();
  assert.match(d, /aria-label="Import result not confirmed"/);
  assert.match(d, /The answer to the import did not arrive\.<\/strong> Some of these sessions may already be imported\./);
  assert.match(d, /1 of 2 confirmed as imported so far\./);
  assert.match(d, /FULL TRAINING 1<\/strong>[\s\S]*?Imported - confirmed by the list\./);
  assert.match(d, /FULL TRAINING 2<\/strong>[\s\S]*?Not confirmed yet\./);
  const open = d.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "");
  assert.ok(!/failed|nothing was imported|not imported/i.test(open), "never failed / nothing imported");
  assert.match(d, /class="primary-button gpexe-button" data-action="training-load-gpexe-batch-check" >Check again</, "checking is the main action");
  assert.ok(gx().uncertain["cand-2"], "the unconfirmed session is marked");
  assert.ok(!gx().uncertain["cand-1"], "the confirmed one is not");
  assert.deepEqual(gx().batch.selected, {}, "nothing stays selected: nothing is sent again by itself");
  await act("training-load-gpexe-batch-check");
  assert.equal(candidatesReads() - readsBefore, 2);
  assert.equal(gx().batch.unknown.checks, 1);
  assert.equal(importPosts().length, 1);
  // The uncertain state survives closing the panel: the row keeps its mark.
  await act("training-load-gpexe-batch-done");
  assert.match(html(), /<strong>FULL TRAINING 2<\/strong>[\s\S]*?Result not confirmed/);
  assert.ok(gx().uncertain["cand-2"]);
  // Three checks without confirmation: the coach is sent to a platform admin.
  gx().batch.unknown = { candidateIds: ["cand-2"], error: { status: 0, code: "Failed to fetch" }, checks: 3 };
  assert.match(dialog(), /Still not confirmed after 3 checks\./);
});

test("10b. the whole request refused before anything was tried (the switch turned off) says so, and the selection stays", async () => {
  resetState();
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: {} },
    candidates: [ready(1)],
    onImports: () => ({ status: 409, body: { error: "import_switch_off", message: "Import writing is switched off." } }),
  }));
  await openImports();
  await pick("cand-1");
  await act("training-load-gpexe-batch-review");
  await act("training-load-gpexe-batch-send");
  const d = dialog();
  assert.match(d, /Not imported: importing is switched off in this environment\./);
  assert.match(d, /data-action="training-load-gpexe-batch-send" disabled>Import 1 session</);
  assert.match(d, /data-action="training-load-gpexe-batch-back" >Back</, "Back works");
  assert.deepEqual(Object.keys(gx().batch.selected), ["cand-1"]);
  assert.deepEqual(gx().uncertain, {});
  // Back closes the dialog; the reason stays under the Ready bucket until the next choice.
  await act("training-load-gpexe-batch-back");
  let page = html();
  assert.ok(!/imports-batch"/.test(page), "the dialog is closed");
  assert.match(page, /<div class="gpexe-refused" role="alert"><p>Not imported: importing is switched off in this environment\./);
  assert.match(page, /<strong>1 selected<\/strong>/);
  await act("training-load-gpexe-batch-clear");
  page = html();
  assert.ok(!/Not imported: importing is switched off/.test(page), "the next choice clears the reason");
});

test("10c. a Ready bucket locked by a link change offers no checkbox and no selection bar - its one line is the instruction", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1), ready(2, { lastSeenAt: "2026-09-25T10:00:00Z" })] }));
  await openImports();
  await pick("cand-1");
  gx().linkSeq = 1;
  gx().linkCheckStartedAt = "2026-09-25T09:00:00Z"; // only cand-2 was seen by a check after the link change
  await act("training-load-gpexe-superseded");
  await act("training-load-gpexe-superseded");
  const page = html();
  assert.match(page, /Find new sessions again[^<]*first - athlete links changed after these reviews were made\./);
  assert.equal(checkboxes(page).length, 0, "no checkbox while the bucket is locked");
  assert.ok(!/imports-select-bar/.test(page), "no selection bar either");
  assert.deepEqual(gx().batch.selected, {}, "the stale choice was dropped");
});

test("12. while the request runs the team cannot be changed (the select is off, a stale change is refused); a workspace reset meanwhile never receives the old team's answer", async () => {
  resetState();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: {}, [TEAM_B]: {} },
    candidates: [ready(1)],
    onImports: async () => { await gate; return result({ imported: 1 }, [{ candidateId: "cand-1", outcome: "imported", code: null, approvalId: "appr-1", commitConfirmation: "confirmed" }]); },
  }));
  await openImports();
  await pick("cand-1");
  await act("training-load-gpexe-batch-review");
  const sending = act("training-load-gpexe-batch-send");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(html(), /data-action="training-load-gpexe-team" aria-label="Team" disabled>/, "the team select is off while sending");
  await act("training-load-gpexe-team", {}, { value: TEAM_B });
  assert.equal(gx().teamId, TEAM_A, "a stale team change is refused");
  assert.equal(gx().batch.sending, true);
  // A workspace switch resets Training Load meanwhile: the old answer must not land in the new state.
  resetTrainingLoadForWorkspaceChange();
  release();
  await sending;
  const b = gx();
  assert.deepEqual(b.batch.selected, {});
  assert.equal(b.batch.results, null);
  assert.equal(b.batch.sending, false);
  assert.deepEqual(b.uncertain, {});
  assert.ok(!/imports-batch"/.test(html()));
  assert.equal(importPosts().length, 1);
  assert.ok(importPosts()[0].url.includes(TEAM_A));

  // With sessions chosen but not imported, a team change asks first; declined keeps everything.
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {}, [TEAM_B]: {} }, candidates: [ready(1)] }));
  await openImports();
  await pick("cand-1");
  confirmAnswer = false;
  await act("training-load-gpexe-team", {}, { value: TEAM_B });
  assert.equal(gx().teamId, TEAM_A);
  assert.deepEqual(Object.keys(gx().batch.selected), ["cand-1"]);
  assert.match(confirmQuestions.at(-1), /You selected 1 session for import but did not import it yet\. Change the team anyway\? The selection is lost\./);
  confirmAnswer = true;
  await act("training-load-gpexe-team", {}, { value: TEAM_B });
  assert.equal(gx().teamId, TEAM_B);
  assert.deepEqual(gx().batch.selected, {});
});

test("12b. a refused session leaves the selection with the answer even when the reload afterwards fails", async () => {
  resetState();
  let posted = false;
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: {} },
    candidates: () => { if (posted) throw new TypeError("Failed to fetch"); return [ready(1), ready(2)]; },
    onImports: () => { posted = true; return result({ refused: 1, notAttempted: 1 }, [{ candidateId: "cand-1", outcome: "refused", code: "preview_changed", approvalId: null, reviewAgain: { candidateId: "cand-1", href: "/x" } }, { candidateId: "cand-2", outcome: "not_attempted", code: null, approvalId: null }]); },
  }));
  await openImports();
  await act("training-load-gpexe-batch-select");
  await act("training-load-gpexe-batch-review");
  await act("training-load-gpexe-batch-send");
  assert.deepEqual(Object.keys(gx().batch.selected), ["cand-2"], "the refused one is gone, the not-tried one waits for a fresh list");
});

test("13. the calendar marks every day with a found session, whatever its bucket, with the count and a spoken label; nothing else is marked", async () => {
  resetState();
  const list = [
    ready(21),
    ready(22, { id: "cand-21b", sessionStartedAt: "2026-09-21T09:00:00Z", status: "imported", importedAt: "2026-09-22T12:00:00Z" }),
    ready(14, { reasons: [{ code: "athletes_not_linked", count: 1 }] }),
    ready(3, { status: "superseded", supersededByCandidateId: "cand-14" }),
  ];
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: list }));
  await openImports();
  const page = html();
  assert.match(page, /<h3>Sessions calendar<\/h3>/);
  assert.match(page, /Markers show sessions already found by OptiMove\. Other dates may not have been searched yet\./);
  assert.match(page, /<strong class="imports-cal-month" aria-live="polite">September 2026<\/strong>/, "the month of the newest session found");
  assert.match(page, /data-day="2026-09-21" aria-label="21 September, 2 sessions found" aria-pressed="false"><span class="imports-cal-num">21<\/span><span class="imports-cal-mark" aria-hidden="true"><span class="imports-cal-count">2<\/span>/);
  assert.match(page, /data-day="2026-09-14" aria-label="14 September, 1 session found" aria-pressed="false"><span class="imports-cal-num">14<\/span><span class="imports-cal-mark" aria-hidden="true"><span class="imports-cal-dot"><\/span>/);
  assert.match(page, /<span class="imports-cal-day" aria-label="15 September, nothing found yet"><span class="imports-cal-num">15<\/span><\/span>/);
  assert.ok(!/data-day="2026-09-03"/.test(page), "a replaced version is not a marker");
  await act("training-load-gpexe-cal-day", { day: "2026-09-21" });
  assert.match(html(), /Showing the sessions of 21\.09\.2026 only \(2 of 3\)\./, "the count is what the buckets show, without the hidden replaced version");
  await act("training-load-gpexe-cal-all");
  assert.equal((page.match(/data-action="training-load-gpexe-cal-day"/g) || []).length, 2);
  assert.equal((page.match(/class="imports-cal-weekday"/g) || []).length, 7);
});

test("14./15. a marked day filters the list locally (no request, the search dates untouched); Show all dates brings every session back", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(21), ready(14), ready(7, { reasons: [{ code: "athletes_not_linked", count: 1 }] })] }));
  await openImports();
  const calls = fetchCalls.length;
  await act("training-load-gpexe-cal-day", { day: "2026-09-21" });
  assert.equal(fetchCalls.length, calls, "no request");
  let page = html();
  assert.match(page, /data-day="2026-09-21" aria-label="21 September, 1 session found, showing this day" aria-pressed="true"/);
  assert.match(page, /Showing the sessions of 21\.09\.2026 only \(1 of 3\)\./);
  assert.match(page, /<h3>Ready to import \(1\)<\/h3>/);
  assert.ok(!/Needs attention \(/.test(page), "the attention row of another day is hidden");
  assert.match(page, /data-candidate-id="cand-21"/);
  assert.ok(!/data-candidate-id="cand-14"/.test(page));
  assert.match(page, /data-gpexe-field="from" value=""/, "the search dates stay empty");
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "", "the shared week is untouched");
  await act("training-load-gpexe-cal-all");
  page = html();
  assert.equal(gx().calendar.day, "");
  assert.match(page, /<h3>Ready to import \(2\)<\/h3>/);
  assert.match(page, /Needs attention \(1\)/);
  assert.ok(!/Showing the sessions of/.test(page));
  assert.equal(fetchCalls.length, calls);
  // The same day again also clears the filter.
  await act("training-load-gpexe-cal-day", { day: "2026-09-14" });
  await act("training-load-gpexe-cal-day", { day: "2026-09-14" });
  assert.equal(gx().calendar.day, "");
});

test("16. Prev/Next month turn the page without a request, and touch neither the shared week nor the search dates", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(21)] }));
  await openImports();
  const calls = fetchCalls.length;
  await act("training-load-gpexe-cal-prev");
  assert.match(html(), /imports-cal-month" aria-live="polite">August 2026</);
  await act("training-load-gpexe-cal-prev");
  assert.match(html(), /imports-cal-month" aria-live="polite">July 2026</);
  await act("training-load-gpexe-cal-next");
  await act("training-load-gpexe-cal-next");
  await act("training-load-gpexe-cal-next");
  assert.match(html(), /imports-cal-month" aria-live="polite">October 2026</);
  assert.ok(!/data-action="training-load-gpexe-cal-day"/.test(html()), "no marker in a month without sessions");
  assert.equal(fetchCalls.length, calls);
  assert.equal(state.trainingLoad.dataAnalysisWeekStart, "");
  assert.match(html(), /data-gpexe-field="from" value=""/);
  // December -> January crosses the year.
  gx().calendar.month = "2026-12";
  await act("training-load-gpexe-cal-next");
  assert.equal(gx().calendar.month, "2027-01");
  // No session found yet: this month.
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [] }));
  await openImports();
  const now = new Date();
  assert.match(html(), new RegExp(`imports-cal-month" aria-live="polite">${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][now.getMonth()]} ${now.getFullYear()}<`));
});

test("17. a session close to midnight is marked on the same day its row shows (the local clock), never on the UTC day", async () => {
  resetState();
  const iso = "2026-09-21T22:30:00Z";
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(21, { sessionStartedAt: iso })] }));
  await openImports();
  const d = new Date(iso);
  const two = (n) => String(n).padStart(2, "0");
  const localDay = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  assert.equal(calendarDayKey(iso), localDay);
  const page = html();
  assert.match(page, new RegExp(`data-day="${localDay}" aria-label="${d.getDate()} September, 1 session found`));
  // The row shows the same day.
  assert.match(page, new RegExp(`<span class="muted">${two(d.getDate())}\\.09\\.2026 ${two(d.getHours())}:30</span>`));
  const utcDay = iso.slice(0, 10);
  if (utcDay !== localDay) assert.ok(!page.includes(`data-day="${utcDay}"`), "the UTC day is not marked");
  // The filter uses the same key.
  await act("training-load-gpexe-cal-day", { day: localDay });
  assert.match(html(), /<h3>Ready to import \(1\)<\/h3>/);
});

test("18. a selection hidden by the date filter is still counted and named; Select all adds only visible sessions; the confirmation lists every chosen one", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(21), ready(20), ready(14)] }));
  await openImports();
  await pick("cand-14");
  await act("training-load-gpexe-cal-day", { day: "2026-09-21" });
  let page = html();
  assert.match(page, /<strong>1 selected<\/strong> · maximum 10 · 1 selected session is hidden by the date filter/);
  await act("training-load-gpexe-batch-select");
  assert.deepEqual(Object.keys(gx().batch.selected).sort(), ["cand-14", "cand-21"], "only the visible session was added");
  page = html();
  assert.match(page, /<strong>2 selected<\/strong> · maximum 10 · 1 selected session is hidden by the date filter/);
  await act("training-load-gpexe-batch-review");
  const d = dialog();
  assert.match(d, /aria-label="Import 2 sessions"/);
  assert.match(d, /<strong>FULL TRAINING 21<\/strong>/);
  assert.match(d, /<strong>FULL TRAINING 14<\/strong>/, "the hidden one is listed too");
});

test("leaving Training Load with a selection or a running import asks first; declined stays", async () => {
  resetState();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1)], onImports: async () => { await gate; return result({ imported: 1 }, [{ candidateId: "cand-1", outcome: "imported", code: null, approvalId: "appr-1", commitConfirmation: "confirmed" }]); } }));
  await openImports();
  assert.equal(confirmLeaveTrainingLoad("weekly"), true, "nothing chosen: no question");
  await pick("cand-1");
  confirmAnswer = false;
  assert.equal(confirmLeaveTrainingLoad("weekly"), false);
  assert.match(confirmQuestions.at(-1), /You selected 1 session for import but did not import it yet\. Leave anyway\?/);
  confirmAnswer = true;
  assert.equal(confirmLeaveTrainingLoad(null, { discard: false }), true);
  confirmQuestions = [];
  assert.equal(confirmLeaveTrainingLoad("training-load"), true, "the same tab keeps the selection: nothing to ask");
  assert.equal(confirmQuestions.length, 0);
  await act("training-load-gpexe-batch-review");
  const sending = act("training-load-gpexe-batch-send");
  await new Promise((resolve) => setImmediate(resolve));
  confirmAnswer = false;
  assert.equal(confirmLeaveTrainingLoad("weekly"), false);
  assert.match(confirmQuestions.at(-1), /An import of several sessions is still running\. Its result will be under Imports when it finishes\. Leave anyway\?/);
  assert.equal(confirmLeaveTrainingLoad(null, { discard: false }), false);
  assert.match(confirmQuestions.at(-1), /If you switch workspace now, its result is lost\. Leave anyway\?/, "the workspace exit tells the truth");
  release();
  await sending;
  assert.equal(confirmLeaveTrainingLoad("weekly"), true, "a result waiting behind Done asks nothing");
});
