// U6a-3: a long selection of Ready sessions goes on by itself after the server's 45 s budget. Each round is an ordinary
// POST /imports with exactly the sessions the server did not try ("not_attempted" / "batch_time_budget") and the hashes they
// were chosen with; the series ends when all are decided, at a refusal that needs a person, at an unconfirmed result, at a round
// that decides nothing, at Stop, when the person leaves Imports, or after BATCH_MAX_ROUNDS. Driven through
// handleTrainingLoadAction with a fake fetch, like the other Training Load suites.
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
const { setGpexePollDelayForTests, importsUnloadShouldWarn, BATCH_MAX_ROUNDS } = await import("../gpexe-import-data.js");

setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";

const hashOf = (n) => String(n).padStart(2, "0").repeat(32);
const ORG = {
  teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }, { id: "bbbbbbbb-0000-4000-8000-000000000002", name: "U19", club_name: "Club" }],
  clubs: [],
  athletes: [{ id: "ath-1", name: "Ana Example", memberships: [{ teamId: TEAM_A, membershipType: "team", status: "active" }] }],
};

function fakeAction(dataset, extra = {}) {
  return { dataset, ...extra };
}

let renders;
// A hook a test sets to act between two rounds of a series (the screen repaints there).
let onRender = null;
function render() {
  renders += 1;
  if (onRender) onRender();
}

function resetState() {
  clearAllViewCache();
  state.activeTab = "training-load";
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  confirmAnswer = true;
  confirmQuestions = [];
  renders = 0;
  onRender = null;
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
  return { ...c, athletes: {}, approval: c.status === "imported" ? { id: `appr-${c.id}`, approvedAt: "2026-09-22T12:00:00Z", basis: "team_grant" } : null, preview: { version: 3, status: "ready", blocked: null, counts: c.counts, changesToImported: [], athletes: [], teamAthletesWithoutGpexeRecord: [], anomalies: [], unactivatedSourceMetricCount: 0 } };
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


const html = () => renderTrainingLoadCoachHtml();
const gx = () => state.trainingLoad.gpexe;
const candidatesReads = () => fetchCalls.filter((c) => c.method === "GET" && /\/candidates(\?|$)/.test(c.url)).length;

// The batch dialog's markup, when it is open.
function dialog() {
  const page = html();
  const start = page.indexOf('class="panel builder-athlete-picker gpexe-detail imports-batch"');
  assert.ok(start > 0, "the batch dialog is open");
  return page.slice(start);
}
function result(summary = {}, results = []) {
  return { status: 200, body: { results, summary: { requested: results.length, imported: 0, alreadyImported: 0, refused: 0, unknown: 0, notAttempted: 0, ...summary } } };
}

const done = (n) => ({ candidateId: `cand-${n}`, outcome: "imported" });
const budget = (n) => ({ candidateId: `cand-${n}`, outcome: "not_attempted", code: "batch_time_budget" });

function seriesServer(rounds, seen) {
  return gpexeServer({
    teamStatus: { [TEAM_A]: {} },
    candidates: [1, 2, 3, 4, 5, 6].map(ready),
    onImports: (call) => {
      seen.push(call.body);
      const next = rounds[Math.min(seen.length - 1, rounds.length - 1)];
      if (typeof next === "function") return next(call);
      return result({ imported: next.filter((r) => r.outcome === "imported").length, notAttempted: next.filter((r) => r.outcome === "not_attempted").length }, next);
    },
  });
}

test("U6a-3 1: a long selection goes on by itself - each round sends exactly the sessions the server did not try, with the hashes they were chosen with - until all are decided", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([[done(1), done(2), budget(3), budget(4), budget(5), budget(6)], [done(3), done(4), done(5), budget(6)], [done(6)]], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  assert.equal(seen.length, 0, "nothing is sent before the confirmation");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 3, "three requests");
  assert.deepEqual(seen[0].candidateIds, ["cand-1", "cand-2", "cand-3", "cand-4", "cand-5", "cand-6"]);
  assert.deepEqual(seen[1].candidateIds, ["cand-3", "cand-4", "cand-5", "cand-6"]);
  assert.deepEqual(seen[2].candidateIds, ["cand-6"]);
  for (const body of seen) for (const id of body.candidateIds) assert.equal(body.previewHashes[id], hashOf(Number(id.slice(5))), "the hash the session was chosen with");
  assert.equal(gx().batch.results.length, 6);
  assert.ok(gx().batch.results.every((r) => r.outcome === "imported"));
  assert.equal(gx().batch.summary.imported, 6, "the summary is counted from each session's final result");
  assert.equal(gx().batch.sending, false);
  assert.deepEqual(gx().batch.progress, { total: 6, done: 6, imported: 6, rounds: 3 });
});

test("U6a-3 2: the series stops at the first refusal that needs a person, at an unconfirmed result, and when a round decides nothing; what is left stays selected", async () => {
  for (const [name, firstRound] of [
    ["a refusal that needs a person", [done(1), { candidateId: "cand-2", outcome: "refused", code: "preview_changed" }, budget(3), budget(4), budget(5), budget(6)]],
    ["an unconfirmed result", [done(1), { candidateId: "cand-2", outcome: "import_outcome_unknown", code: "import_outcome_unknown" }, budget(3), budget(4), budget(5), budget(6)]],
    ["a round that decided nothing", [budget(1), budget(2), budget(3), budget(4), budget(5), budget(6)]],
  ]) {
    resetState();
    const seen = [];
    installFetchMock(seriesServer([firstRound], seen));
    await openImports();
    await act("training-load-gpexe-import-ready");
    await act("training-load-gpexe-batch-send");
    assert.equal(seen.length, 1, `${name}: no second request`);
    assert.equal(gx().batch.sending, false, name);
  }
});

test("U6a-3 3: a busy server (try_again) ends the import after its round: the server leaves the rest untried with no budget code, so nothing is resent by itself", async () => {
  resetState();
  const seen = [];
  // The server's real shape (approveCandidates, BATCH_STOP_CODES): after try_again the rest is not_attempted with code null.
  const tail = (n) => ({ candidateId: `cand-${n}`, outcome: "not_attempted", code: null });
  installFetchMock(seriesServer([[done(1), { candidateId: "cand-2", outcome: "refused", code: "try_again" }, tail(3), tail(4), tail(5), tail(6)], [done(3), done(4), done(5), done(6)]], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 1, "no second request");
  assert.match(dialog(), /Not imported: the import stopped before this session\./);
  assert.deepEqual(Object.keys(gx().batch.selected).sort(), ["cand-2", "cand-3", "cand-4", "cand-5", "cand-6"], "the busy one and the untried stay ticked");
});

test("U6a-3 4: Stop ends the series after the request in flight; the rest is not sent", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([async () => { await act("training-load-gpexe-batch-stop"); return result({}, [done(1), done(2), budget(3), budget(4), budget(5), budget(6)]); }, [done(3), done(4), done(5), done(6)]], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 1);
  assert.equal(gx().batch.results.length, 6);
  assert.equal(gx().batch.stopRequested, false);
});

test("U6a-3 5: leaving Imports in the middle ends the series without another request; one click on Import ready sends what is left", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([
    () => { resetTrainingLoadForWorkspaceChange(); return result({}, [done(1), done(2), budget(3), budget(4), budget(5), budget(6)]); },
    [done(3), done(4), done(5), done(6)],
  ], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 1, "the answer of a page that was left starts no new request");
  // Back on the screen: the server still lists the four as Ready; one click sends exactly those.
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [3, 4, 5, 6].map(ready), onImports: (call) => { seen.push(call.body); return result({}, [done(3), done(4), done(5), done(6)]); } }));
  resetState();
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].candidateIds, ["cand-3", "cand-4", "cand-5", "cand-6"]);
});

test("U6a-3 6: a lost answer in a later round marks only that round's sessions as not confirmed; the leave guard asks while the series runs", async () => {
  resetState();
  const seen = [];
  let guardWhileSending;
  installFetchMock(seriesServer([
    [done(1), done(2), budget(3), budget(4), budget(5), budget(6)],
    () => { guardWhileSending = importsUnloadShouldWarn(); throw new TypeError("network down"); },
  ], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(guardWhileSending, true, "the leave guard asks while the series runs");
  assert.equal(seen.length, 2);
  assert.deepEqual(gx().batch.unknown.candidateIds, ["cand-3", "cand-4", "cand-5", "cand-6"], "only the lost request's sessions");
  assert.ok(!gx().uncertain["cand-1"] && !gx().uncertain["cand-2"], "the sessions answered earlier are not marked");
  assert.equal(importsUnloadShouldWarn(), true, "and it keeps asking until the result is confirmed");
});

test("U6a-3 7: the summary of a long series is counted from each session's final result, never summed over the rounds", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([[done(1), done(2), budget(3), budget(4), budget(5), budget(6)], [done(3), done(4), done(5), budget(6)], [done(6)]], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.deepEqual(gx().batch.summary, { requested: 6, imported: 6, alreadyImported: 0, refused: 0, unknown: 0, notAttempted: 0 });
  assert.ok(!/not tried/.test(dialog() || ""), "no 'not tried' on a series that finished");
});

test("U6a-3 8: a refusal in a later round (the switch turned off) shows what the earlier round did and why the series stopped, and the list is read again", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([[done(1), done(2), budget(3), budget(4), budget(5), budget(6)], () => ({ status: 409, body: { error: "import_switch_off", message: "Importing is switched off." } })], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  const readsBefore = candidatesReads();
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 2);
  const panel = dialog();
  assert.match(panel, /The import stopped before the rest of the sessions: importing was switched off in this environment\. The sessions marked Imported below are in OptiMove/, "why it stopped, never 'nothing was imported'");
  assert.ok(!/Nothing was imported/.test(panel));
  assert.match(panel, /Imported\./, "and what the first round did");
  assert.ok(candidatesReads() > readsBefore, "the list is read again after sessions were imported in round 1");
  // The Nezavisni revizor's L1: the branch for a refusal after earlier rounds closes the confirmation and keeps their answers.
  const b = gx().batch;
  assert.equal(b.confirming, false, "the confirmation is closed: the result panel shows");
  assert.equal(b.stopReason, "refused");
  assert.deepEqual(b.results.map((r) => [r.candidateId, r.outcome]), [["cand-1", "imported"], ["cand-2", "imported"], ["cand-3", "not_attempted"], ["cand-4", "not_attempted"], ["cand-5", "not_attempted"], ["cand-6", "not_attempted"]], "the earlier round's answers stay");
  assert.equal(b.summary.imported, 2);
  assert.equal(b.summary.notAttempted, 4);
});

test("U6a-3 9: moving to another Training Load section or another part of the app while a request is in flight ends the import after it; the leave question says so", async () => {
  for (const [name, move] of [
    ["another Training Load section", () => act("training-load-section", { section: "schedule" })],
    ["another part of the app", () => { assert.equal(confirmLeaveTrainingLoad("calendar"), true); state.activeTab = "calendar"; }],
  ]) {
    resetState();
    const seen = [];
    installFetchMock(seriesServer([
      async () => { await move(); return result({}, [done(1), done(2), budget(3), budget(4), budget(5), budget(6)]); },
      [done(3), done(4), done(5), done(6)],
    ], seen));
    await openImports();
    await act("training-load-gpexe-import-ready");
    await act("training-load-gpexe-batch-send");
    assert.equal(seen.length, 1, `${name}: no second round after the person left Imports`);
    assert.equal(gx().batch.stopReason, "left");
  }
  assert.match(confirmQuestions.at(-1), /the ones being imported right now finish and the rest are not imported/);
});

test("U6a-3 9b: a leave question answered yes, after which the person stays (another guard says no), does not stop the import", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([
    () => { assert.equal(confirmLeaveTrainingLoad("calendar"), true); return result({}, [done(1), done(2), budget(3), budget(4), budget(5), budget(6)]); },
    [done(3), done(4), done(5), done(6)],
  ], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 2, "still on Imports: the import goes on");
  assert.equal(gx().batch.summary.imported, 6);
});

test("U6a-3 10: a lost answer in the middle of a series stops it: no further round, the dialog says the result is not confirmed", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([
    [done(1), budget(2), budget(3), budget(4), budget(5), budget(6)],
    () => { throw new TypeError("network down"); },
    [done(3), done(4), done(5), done(6)],
  ], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 2, "no third request after the lost answer");
  assert.match(dialog(), /Import result not confirmed/);
  assert.deepEqual(gx().batch.unknown.candidateIds, ["cand-2", "cand-3", "cand-4", "cand-5", "cand-6"]);
  assert.equal(gx().batch.sending, false);
});

test("U6a-3 11: Stop pressed between two rounds and leaving Imports between two rounds each end the series before the next request", async () => {
  for (const [name, between] of [
    ["Stop", () => act("training-load-gpexe-batch-stop")],
    ["leaving Imports for another section", () => act("training-load-section", { section: "schedule" })],
    ["leaving Training Load", () => { state.activeTab = "calendar"; }],
    ["a workspace change", () => resetTrainingLoadForWorkspaceChange()],
  ]) {
    resetState();
    const seen = [];
    installFetchMock(seriesServer([[done(1), done(2), budget(3), budget(4), budget(5), budget(6)], [done(3), done(4), done(5), done(6)]], seen));
    await openImports();
    await act("training-load-gpexe-import-ready");
    // The repaint after the first answer, with the second round about to go: the person acts there.
    let fired = false;
    onRender = () => { if (!fired && gx().batch.sending && gx().batch.progress?.done === 2) { fired = true; between(); } };
    await act("training-load-gpexe-batch-send");
    assert.equal(fired, true, `${name}: the hook ran between the rounds`);
    assert.equal(seen.length, 1, `${name}: no second request`);
  }
});

test("U6a-3 12: a later round never sends a session that already has a final result; already_imported counts as imported and does not stop the series", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([
    [done(1), { candidateId: "cand-2", outcome: "already_imported" }, done(3), budget(4), budget(5), budget(6)],
    [done(4), { candidateId: "cand-5", outcome: "already_imported" }, budget(6)],
    [done(6)],
  ], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 3, "already_imported did not stop the series");
  assert.deepEqual(seen[1].candidateIds, ["cand-4", "cand-5", "cand-6"]);
  assert.deepEqual(seen[2].candidateIds, ["cand-6"]);
  // A session with a final answer (imported, already imported, refused) is never in a later round.
  for (const id of ["cand-1", "cand-2", "cand-3"]) assert.ok(!seen[1].candidateIds.includes(id) && !seen[2].candidateIds.includes(id), `${id} is not sent again`);
  assert.ok(!seen[2].candidateIds.includes("cand-5"), "cand-5 (already imported in round 2) is not sent again");
  assert.equal(gx().batch.summary.alreadyImported, 2);
  assert.equal(gx().batch.summary.imported, 4);
  assert.match(dialog(), /Already imported, nothing more was written\./);
});

test("U6a-3 13: the series stops after BATCH_MAX_ROUNDS requests; what is left is 'not tried' and stays ticked", async () => {
  assert.equal(BATCH_MAX_ROUNDS, 30);
  resetState();
  const seen = [];
  const all = Array.from({ length: 40 }, (_, i) => i + 1);
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: {} },
    candidates: all.map((n) => ready(n, { sessionStartedAt: `2026-09-${String((n % 28) + 1).padStart(2, "0")}T16:08:12Z` })),
    onImports: (call) => {
      seen.push(call.body);
      const [first, ...rest] = call.body.candidateIds;
      return result({}, [{ candidateId: first, outcome: "imported" }, ...rest.map((id) => ({ candidateId: id, outcome: "not_attempted", code: "batch_time_budget" }))]);
    },
  }));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 30, "exactly BATCH_MAX_ROUNDS requests");
  assert.equal(gx().batch.summary.imported, 30);
  assert.equal(gx().batch.summary.notAttempted, 10);
  assert.equal(gx().batch.sending, false);
  assert.equal(Object.keys(gx().batch.selected).length, 10, "the ten not tried stay ticked for the next click");
  assert.match(dialog(), /Not imported yet: the import stops after 30 rounds\./);
  assert.equal(gx().batch.stopReason, "cap");
});

test("U6a-3 14: while the import goes on, the dialog says 'Importing sessions', the rows not reached read 'waiting', nothing says 'not tried' or 'still ticked', and Done is off; after Stop the rows no longer say waiting", async () => {
  resetState();
  const seen = [];
  let during = "";
  let afterStop = "";
  installFetchMock(seriesServer([
    [done(1), done(2), budget(3), budget(4), budget(5), budget(6)],
    async () => { during = dialog(); await act("training-load-gpexe-batch-stop"); afterStop = dialog(); return result({}, [done(3), budget(4), budget(5), budget(6)]); },
  ], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.match(html(), /aria-label="Import result"/);
  const page = during;
  assert.match(page, /Waiting: it will be imported automatically\./);
  assert.ok(!/not tried|still ticked/i.test(page), "nothing reads as finished");
  assert.match(page, /data-action="training-load-gpexe-batch-done" disabled/, "Done is off while it runs");
  assert.match(page, /Stop after the current sessions/);
  assert.match(page, /2 of 6 sessions handled - 2 imported so far\./);
  assert.ok(!/Waiting: it will be imported/.test(afterStop), "after Stop no row says it will be imported");
  assert.ok(!/Nothing was saved|Not imported/.test(afterStop), "a session in the request in flight is never called not saved");
  assert.match(afterStop, /Being imported now - the result follows\./);
  assert.ok(!/Imported sessions are listed under Imported below/.test(during), "that note waits for the end");
  assert.match(afterStop, /Stopping - the sessions being imported right now finish first/);
  assert.equal(seen.length, 2);
  assert.match(dialog(), /Not imported: you stopped the import\./);
});

test("U6a-3 15: after a lost answer in a later round, the sessions answered earlier stay in the dialog", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([[done(1), done(2), budget(3), budget(4), budget(5), budget(6)], () => { throw new TypeError("network down"); }], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  const panel = dialog();
  assert.match(panel, /The answer to the import did not arrive for the last 4 sessions\./);
  assert.match(panel, /Answered before the answer was lost:[\s\S]*FULL TRAINING 1[\s\S]*Imported\./);
});

test("U6a-3 16: a team change is refused while an import of several sessions runs (its answers belong to this team)", async () => {
  const { selectGpexeTeam } = await import("../gpexe-import-data.js");
  resetState();
  const seen = [];
  installFetchMock(seriesServer([
    async () => { await selectGpexeTeam("bbbbbbbb-0000-4000-8000-000000000002", render); return result({}, [done(1), budget(2), budget(3), budget(4), budget(5), budget(6)]); },
    [done(2), done(3), done(4), done(5), done(6)],
  ], seen));
  await openImports();
  const team = gx().teamId;
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(gx().teamId, team, "the team stays");
  assert.equal(seen.length, 2);
  assert.equal(gx().batch.summary.imported, 6);
});

test("U6a-3 17: a series that stops at a session that needs a person says so for the sessions it did not reach", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([[done(1), { candidateId: "cand-2", outcome: "refused", code: "preview_changed" }, budget(3), budget(4), budget(5), budget(6)]], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 1);
  assert.equal(gx().batch.stopReason, "person");
  assert.match(dialog(), /Not imported: the import stopped at a session that needs you\./);
});
