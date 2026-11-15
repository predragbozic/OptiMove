// J20-C part b (docs/ai/j20-session-review-contract.md section 5.2): the attendance states chosen on the Session review's rows,
// saved right after a confirmed import through POST …/approvals/:approvalId/states. Driven through handleTrainingLoadAction with a
// fake fetch, like the other Imports suites.
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
const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

let fetchCalls;
let responder;
globalThis.fetch = async (url, options = {}) => {
  const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
  fetchCalls.push(call);
  const result = await responder(call);
  if (result.throws) throw new TypeError("network");
  return { ok: result.status < 300, status: result.status, statusText: "", json: async () => { if (result.body === undefined) throw new Error("no json"); return result.body; } };
};

const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { setGpexePollDelayForTests } = await import("../gpexe-import-data.js");
const { setImportStatesBoundForTests } = await import("../gpexe-import-states-data.js");

setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const APPROVAL = "abababab-0000-4000-8000-000000000001";
const ACTIVITY = "acacacac-0000-4000-8000-000000000001";
const A1 = "a1a1a1a1-0000-4000-8000-000000000001";
const A2 = "a2a2a2a2-0000-4000-8000-000000000002";
const A3 = "a3a3a3a3-0000-4000-8000-000000000003";
const NOREC1 = "b1b1b1b1-0000-4000-8000-000000000001";
const NOREC2 = "b2b2b2b2-0000-4000-8000-000000000002";
const ATHLETES = [["101", A1, "Ana Example"], ["102", A2, "Bea Example"], ["103", A3, "Cy Example"]];
const NAMES = { [NOREC1]: "Dee <b>Example</b>", [NOREC2]: "Eve Example" };
const REASONS = [{ key: "illness", label: "Illness" }, { key: "other", label: "Other <x>" }];
const ORG = {
  teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }],
  clubs: [],
  athletes: [...ATHLETES.map(([, id, name]) => ({ id, name, memberships: [{ teamId: TEAM_A, membershipType: "team", status: "active" }] })),
    ...Object.entries(NAMES).map(([id, name]) => ({ id, name, memberships: [{ teamId: TEAM_A, membershipType: "team", status: "active" }] }))],
};

const render = () => {};
function resetState() {
  clearAllViewCache();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "team", scopeId: TEAM_A } };
  state.trainingLoad = emptyTrainingLoadState();
  fetchCalls = [];
  confirmAsked = [];
  confirmAnswer = true;
}
function status({ canApprove = true } = {}) {
  return { settings: { gpexeTeamId: "980" }, importSwitch: { enabled: true, message: "" }, lastCheck: null,
    viewer: { canApprove, approvalBasis: canApprove ? "team_grant" : null, isPlatformAdmin: false }, approvalAvailable: true };
}
function row(overrides = {}) {
  return {
    id: "cand-1", gpexeTeamSessionId: "9977001", label: "FULL TRAINING 05.10.", sessionStartedAt: "2026-10-05T16:08:12Z",
    status: "pending", previewStatus: "ready", previewHash: HASH, counts: { created: 3, athletesNotImported: 0 }, changesToImported: 0,
    firstSeenAt: "2026-10-05T18:00:00Z", lastSeenAt: "2026-10-06T18:00:00Z", importedAt: null, supersededByCandidateId: null, supersededByCheckId: null,
    snapshot: { available: true, expiresAt: "2026-11-05T00:00:00Z" }, approvalBlockers: [], blockedCode: null, blockedSourceCode: null, sessionType: "FULL TRAINING", reasons: [], ...overrides,
  };
}
function athleteEntry([gid, aid]) {
  return { gpexeAthleteId: gid, athleteId: aid, participation: { status: "recorded_by_gpexe" }, gps: { status: "measured", reason: null }, notImported: null, blocksSession: false,
    results: [{ externalId: `athlete_session:${gid}:full`, level: "full", drillIndex: null, outcome: "created", values: [{ metricDefinitionId: "def-distance", variableScope: "system", label: "Distance", unit: "m", value: "3000", sourceMetricKey: "athlete_session.total_distance", sourceValue: "3000", sourceUnit: "m", previous: null, change: "new" }] }], skippedValues: [] };
}
function previewOf(leftOut = []) {
  return { version: 3, status: "ready", blocked: null, counts: { created: 3, changesToImported: 0 }, changesToImported: [],
    athletes: ATHLETES.map((a) => (leftOut.includes(a[0]) ? { ...athleteEntry(a), notImported: { code: "left_out_by_coach", message: "" }, results: [] } : athleteEntry(a))),
    teamAthletesWithoutGpexeRecord: [{ athleteId: NOREC1 }, { athleteId: NOREC2 }], anomalies: [] };
}
let approvalRecord = null;
function detailOf(c) {
  const names = { ...Object.fromEntries(ATHLETES.map(([, aid, name]) => [aid, { name }])), ...Object.fromEntries(Object.entries(NAMES).map(([id, name]) => [id, { name }])) };
  return { ...c, athletes: names, approval: approvalRecord, preview: previewOf(approvalRecord?.excludedAthleteIds || []), helperValues: {} };
}
const approvalView = (ids = []) => ({ id: APPROVAL, candidateId: "cand-1", excludedAthleteIds: ids, subsetHash: null, import: { eventId: "ev-1", activityId: ACTIVITY, counts: {} } });
const imported = (ids = []) => ({ status: 200, body: { outcome: "imported", commitConfirmation: "confirmed", approval: { id: APPROVAL, excludedAthleteIds: ids }, import: { activityId: ACTIVITY, counts: { results: 3, values: 3 } } } });

function server({ canApprove = true, candidate = row(), onApprove, onStates, roster, onSubset, rosterFail } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    if (call.url === `/api/training-activity/${ACTIVITY}/roster`) {
      if (rosterFail && rosterFail()) return { status: 503, body: { error: "database_busy" } };
      return { status: 200, body: { athletes: (roster || [NOREC1, NOREC2, A1, A2, A3]).map((id) => ({ athleteId: id, group: [A1, A2, A3].includes(id) ? "done" : "needs_state" })) } };
    }
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const [, , rest] = m;
    if (rest === "/status") return { status: 200, body: status({ canApprove }) };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: [], units: {}, lastSeenRule: "" } };
    if (rest === "/athlete-links" && call.method === "GET") return { status: 200, body: { links: [] } };
    if (rest === "/candidates") return { status: 200, body: { candidates: [candidate] } };
    if (rest === `/approvals/${APPROVAL}/states`) return onStates(call);
    if (rest === `/approvals/${APPROVAL}`) return { status: 200, body: { approval: approvalView() } };
    const sub = rest.match(/^\/candidates\/([^/]+)\/preview$/);
    if (sub) return onSubset(call);
    const approve = rest.match(/^\/candidates\/([^/]+)\/approve$/);
    if (approve) return onApprove(call);
    const detail = rest.match(/^\/candidates\/([^/?]+)$/);
    if (detail) return { status: 200, body: { candidate: detailOf(candidate), participationReasons: REASONS } };
    return { status: 404, body: { error: "notFound" } };
  };
}

async function act(action, dataset = {}, extra = {}) {
  await handleTrainingLoadAction({ dataset: { action, ...dataset }, ...extra }, { renderTrainingLoad: render });
}
const html = () => renderTrainingLoadCoachHtml();
const gx = () => state.trainingLoad.gpexe;
const choose = (athleteId, value) => act("training-load-gpexe-state", { athleteId }, { value });
const choosers = (page = html()) => [...page.matchAll(/data-action="training-load-gpexe-state" data-athlete-id="([^"]+)"/g)].map((m) => m[1]);
const statesCalls = () => fetchCalls.filter((c) => c.url.endsWith("/states"));
const okStates = (call) => ({ status: 200, body: { decisions: call.body.athletes.map((a) => ({ athleteId: a.athleteId })) } });
async function openReview(opts = {}) {
  resetState();
  store.clear();
  approvalRecord = null;
  responder = server({ onApprove: async () => imported(), onStates: async (call) => okStates(call), ...opts });
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("1. the chooser sits on the rows without a GPEXE record (with the reasons, escaped) and only for a viewer who may approve; nothing is sent before the import", async () => {
  await openReview();
  assert.deepEqual(choosers().sort(), [NOREC1, NOREC2].sort());
  const page = html();
  assert.match(page, /Participated · no device data/);
  assert.match(page, /Did not participate · Illness/);
  assert.match(page, /Did not participate · Other &lt;x&gt;/);
  assert.doesNotMatch(page, /Other <x>/);
  assert.match(page, /aria-label="Attendance for Dee &lt;b&gt;Example&lt;\/b&gt;"/);
  await choose(NOREC1, "participated_no_values");
  assert.equal(statesCalls().length, 0);
  assert.match(page, /data-filter="needs"[^>]*aria-pressed="true">Needs you <span class="gpexe-chip-count">2<\/span>/, "with the chooser the no-data rows need a person");
  await openReview({ canApprove: false });
  assert.deepEqual(choosers(), []);
  assert.ok(!/data-filter="needs"/.test(html()), "without the chooser they do not");
});

test("2. a choice is kept in the browser (ids, kinds and reasons only); the button and the question name the states; the keys exist before the approval is sent", async () => {
  await openReview({ onApprove: async () => {
    const saved = JSON.parse([...store.values()][0]);
    assert.equal(Object.keys(saved.groups).length, 2, "one key per kind + reason, made before the approval");
    return imported();
  } });
  await choose(NOREC1, "participated_no_values");
  await choose(NOREC2, "did_not_participate:illness");
  const saved = [...store.values()][0];
  assert.doesNotMatch(saved, /Example/, "no name is kept");
  assert.match(html(), /After the import, OptiMove also saves 2 attendance states\./);
  await act("training-load-gpexe-approve");
  assert.match(confirmAsked[0], /Then it saves 2 attendance states\./);
});

test("3. after the confirmed import: the roster is read, then one request per group with its own key; the result says how many were saved", async () => {
  await openReview();
  await choose(NOREC1, "participated_no_values");
  await choose(NOREC2, "did_not_participate:illness");
  await act("training-load-gpexe-approve");
  await flush();
  const calls = statesCalls();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].body.requestKey, calls[1].body.requestKey);
  const byKind = Object.fromEntries(calls.map((c) => [c.body.kind, c.body]));
  assert.deepEqual(byKind.participated_no_values.athletes, [{ athleteId: NOREC1, expectedDecisionId: null }]);
  assert.equal(byKind.participated_no_values.reasonKey, undefined);
  assert.deepEqual(byKind.did_not_participate.athletes, [{ athleteId: NOREC2, expectedDecisionId: null }]);
  assert.equal(byKind.did_not_participate.reasonKey, "illness");
  const rosterRead = fetchCalls.findIndex((c) => c.url.endsWith("/roster"));
  assert.ok(rosterRead >= 0 && rosterRead < fetchCalls.indexOf(calls[0]), "the roster is read first");
  assert.match(html(), /2 attendance states saved\./);
});

test("4. an athlete who got a state in the Roster tab meanwhile is not sent (never overwritten) and is named as kept", async () => {
  await openReview({ roster: [NOREC2] });
  await choose(NOREC1, "participated_no_values");
  await choose(NOREC2, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  assert.deepEqual(statesCalls()[0].body.athletes, [{ athleteId: NOREC2, expectedDecisionId: null }]);
  assert.match(html(), /1 athlete already had a state from the Roster tab; it was kept\./);
});

test("5. a lost states answer: never 'not saved'; Check the result repeats exactly the same request with the same key", async () => {
  let n = 0;
  await openReview({ onStates: async (call) => (++n === 1 ? { throws: true } : okStates(call)) });
  await choose(NOREC1, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  assert.match(html(), /We can&#039;t tell yet whether 1 attendance state was saved\. The import itself is done\./);
  assert.doesNotMatch(html(), /not saved:/);
  await act("training-load-gpexe-states-check");
  const calls = statesCalls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, calls[0].body);
  assert.match(html(), /1 attendance state saved\./);
});

test("6. a refusal the server answered (the attendance changed): not saved; Save them again reads the roster again and sends with the same key", async () => {
  let n = 0;
  await openReview({ onStates: async (call) => (++n === 1 ? { status: 409, body: { error: "bulk_conflict", message: "", failed: [] } } : okStates(call)) });
  await choose(NOREC1, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  assert.match(html(), /1 attendance state was not saved: the attendance changed meanwhile\. Nothing was written; the import is done\./);
  const rosterReads = () => fetchCalls.filter((c) => c.url.endsWith("/roster")).length;
  const before = rosterReads();
  await act("training-load-gpexe-states-again");
  assert.equal(rosterReads(), before + 1);
  const calls = statesCalls();
  assert.equal(calls[1].body.requestKey, calls[0].body.requestKey, "a refused request wrote nothing: its key stays");
  assert.match(html(), /1 attendance state saved\./);
});

test("7. after the window (or an undo): not saved with the import, set them in the Roster tab; no retry is offered", async () => {
  await openReview({ onStates: async () => ({ status: 409, body: { error: "import_states_window_closed", message: "" } }) });
  await choose(NOREC1, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  const page = html();
  assert.match(page, /1 attendance state was not saved with the import\. Set it in the session&#039;s Roster tab\./);
  assert.doesNotMatch(page, /training-load-gpexe-states-again|training-load-gpexe-states-check/);
});

test("8. an import whose answer was lost: no state is sent until Check the result confirms the import; then they follow with the recorded approval", async () => {
  let candidateNow = row();
  await openReview({ onApprove: async () => ({ status: 503, body: { error: "import_outcome_unknown", verify: { approvalId: APPROVAL, candidateId: "cand-1" } } }) });
  await choose(NOREC1, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  assert.equal(statesCalls().length, 0);
  approvalRecord = approvalView();
  candidateNow = { ...row(), status: "imported" };
  responder = server({ candidate: candidateNow, onStates: async (call) => okStates(call) });
  await act("training-load-gpexe-verify");
  await flush();
  assert.equal(statesCalls().length, 1);
  assert.ok(statesCalls()[0].url.includes(`/approvals/${APPROVAL}/states`));
});

test("9. a reload: the choice and its key survive; a reopened imported session shows the states not saved yet with Save them", async () => {
  await openReview({ onApprove: async () => ({ status: 200, body: { outcome: "imported", approval: { id: APPROVAL }, import: { counts: {} } } }) });
  await choose(NOREC1, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  assert.equal(statesCalls().length, 0, "no activity in the answer: nothing sent");
  const kept = [...store.entries()];
  // A reload: new state, the same browser storage.
  resetState();
  for (const [k, v] of kept) store.set(k, v);
  approvalRecord = approvalView();
  responder = server({ candidate: { ...row(), status: "imported" }, onStates: async (call) => okStates(call) });
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  assert.match(html(), /1 attendance state you chose is not saved yet\./);
  await act("training-load-gpexe-states-again");
  assert.equal(statesCalls().length, 1);
  assert.equal(statesCalls()[0].body.requestKey, JSON.parse(kept[0][1]).groups["participated_no_values|"].requestKey);
});

test("10. a ticked Leave out row gets a chooser too (the left-out athlete may get a state); untick removes it", async () => {
  await openReview();
  await act("training-load-gpexe-leave-out", { gpexeAthleteId: "102" }, { checked: true });
  assert.ok(choosers().includes(A2));
  await act("training-load-gpexe-leave-out", { gpexeAthleteId: "102" }, { checked: false });
  assert.ok(!choosers().includes(A2));
});

test("11. (F1) a failed roster read: nothing is sent, the text says so (never 'can't tell'), and Save them reads the roster again and sends", async () => {
  let r = 0;
  await openReview({ rosterFail: () => ++r === 1 });
  await choose(NOREC1, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  assert.equal(statesCalls().length, 0);
  assert.match(html(), /1 attendance state you chose is not saved yet\. The session(?:&#039;)s roster could not be read; nothing was sent\./);
  assert.doesNotMatch(html(), /can&#039;t tell/);
  await act("training-load-gpexe-states-again");
  assert.equal(statesCalls().length, 1);
  assert.match(html(), /1 attendance state saved\./);
});

test("12. (F2) a reload while a states request is in flight: never 'not saved'; Check the result sends the same body and key", async () => {
  let first = true;
  setImportStatesBoundForTests(300);
  await openReview({ onStates: () => (first ? new Promise(() => {}) : null) });
  await choose(NOREC1, "participated_no_values");
  const pending = act("training-load-gpexe-approve");
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(statesCalls().length, 1, "the request is in flight");
  const kept = [...store.entries()];
  first = false;
  resetState();
  store.clear();
  for (const [k, v] of kept) store.set(k, v);
  approvalRecord = approvalView();
  responder = server({ candidate: { ...row(), status: "imported" }, onStates: async (call) => okStates(call) });
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  assert.doesNotMatch(html(), /not saved/);
  assert.match(html(), /We can&#039;t tell yet whether 1 attendance state was saved/);
  await act("training-load-gpexe-states-check");
  const calls = statesCalls();
  assert.equal(calls.length, 1, "after the reset only the resend is counted");
  assert.deepEqual(calls[0].body, JSON.parse(kept[0][1]).groups["participated_no_values|"].body);
  setImportStatesBoundForTests(null);
  void pending;
});

test("13. (F3) an unknown send, then a refusal the server gives before its replay check (404, 403): never 'not saved', no body rebuilt, the Roster tab named", async () => {
  for (const refusal of [{ status: 404, body: { error: "notFound" } }, { status: 403, body: { error: "not_a_team_coach", message: "" } }]) {
    let n = 0;
    await openReview({ onStates: async () => (++n === 1 ? { throws: true } : refusal) });
    await choose(NOREC1, "participated_no_values");
    await act("training-load-gpexe-approve");
    await flush();
    await act("training-load-gpexe-states-check");
    const page = html();
    assert.doesNotMatch(page, /not saved/, refusal.body.error);
    assert.match(page, /it can&#039;t be checked from here\. Look at the session&#039;s Roster tab\./);
    assert.doesNotMatch(page, /training-load-gpexe-states-again/);
    const calls = statesCalls();
    assert.deepEqual(calls[1].body, calls[0].body, "the same body: never rebuilt for a key that may be saved");
  }
});

test("14. (F4) a choice on a Leave out row that was unticked before the import is neither sent nor counted", async () => {
  await openReview({ roster: [NOREC1, NOREC2, A2] });
  await act("training-load-gpexe-leave-out", { gpexeAthleteId: "102" }, { checked: true });
  await choose(A2, "participated_no_values");
  await act("training-load-gpexe-leave-out", { gpexeAthleteId: "102" }, { checked: false });
  await choose(NOREC1, "participated_no_values");
  assert.match(html(), /After the import, OptiMove also saves 1 attendance state\./);
  await act("training-load-gpexe-approve");
  await flush();
  assert.deepEqual(statesCalls()[0].body.athletes, [{ athleteId: NOREC1, expectedDecisionId: null }]);
  assert.doesNotMatch(html(), /already had a state/);
});

test("15. (F5) after a refusal that carries names and notes, the stored states hold no name, note or server message", async () => {
  await openReview({ onStates: async () => ({ status: 409, body: { error: "bulk_conflict", message: "Nothing was saved: some athletes changed.", failed: [{ athleteId: NOREC1, error: "decision_changed", current: { decision: { decidedBy: { name: "Coach Zed" }, note: "knee" } } }] } }) });
  await choose(NOREC1, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  const stored = [...store.values()].join(" ");
  assert.ok(stored.length > 0);
  assert.doesNotMatch(stored, /Coach Zed|knee|some athletes changed|Example/);
});

test("16. (F6) states chosen, then the session imported elsewhere (no keys were made): the reopened session says they were not saved", async () => {
  await openReview();
  await choose(NOREC1, "participated_no_values");
  const kept = [...store.entries()];
  resetState();
  for (const [k, v] of kept) store.set(k, v);
  approvalRecord = approvalView();
  responder = server({ candidate: { ...row(), status: "imported" }, onStates: async (call) => okStates(call) });
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  assert.match(html(), /1 attendance state you chose was not saved with this import\. Set it in the session&#039;s Roster tab\./);
  assert.equal(statesCalls().length, 0);
});

test("17. (F7) a refusal that a retry cannot fix (unknown_reason, the import undone): no Save them again, a sentence per case", async () => {
  await openReview({ onStates: async () => ({ status: 400, body: { error: "unknown_reason", message: "" } }) });
  await choose(NOREC1, "did_not_participate:illness");
  await act("training-load-gpexe-approve");
  await flush();
  assert.doesNotMatch(html(), /training-load-gpexe-states-again/);
  assert.match(html(), /1 attendance state was not saved\. Nothing was written; set it in the session&#039;s Roster tab\./);
  await openReview({ onStates: async () => ({ status: 409, body: { error: "import_undone", message: "" } }) });
  await choose(NOREC1, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  assert.match(html(), /The import was undone, so its attendance states were not saved\./);
});

test("18. (F8) once every state is saved the stored item is removed; a hung request ends as 'can't tell yet' at the client bound", async () => {
  await openReview();
  await choose(NOREC1, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  assert.equal(store.size, 0);
  assert.match(html(), /1 attendance state saved\./);
  setImportStatesBoundForTests(5);
  const realFetch = globalThis.fetch;
  try {
    responder = null;
    await openReview({ onStates: () => new Promise(() => {}) });
    globalThis.fetch = ((orig) => async (url, options = {}) => {
      if (String(url).endsWith("/states")) {
        fetchCalls.push({ url, method: options.method, body: JSON.parse(options.body) });
        return new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      }
      return orig(url, options);
    })(globalThis.fetch);
    await choose(NOREC1, "participated_no_values");
    await act("training-load-gpexe-approve");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(html(), /We can&#039;t tell yet whether 1 attendance state was saved/);
  } finally {
    globalThis.fetch = realFetch;
    setImportStatesBoundForTests(null);
  }
});

test("19. (NEW-1) an import refused for certain frees the choices: the changed choice is what is sent; while keys exist the chooser is disabled", async () => {
  let n = 0;
  await openReview({ onApprove: async () => (++n === 1 ? { status: 409, body: { error: "preview_changed", message: "" } } : imported()) });
  await choose(NOREC1, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  assert.equal(statesCalls().length, 0);
  await choose(NOREC1, "did_not_participate:illness");
  assert.deepEqual(gx().detail.states.choices[NOREC1], { kind: "did_not_participate", reasonKey: "illness" }, "the change is taken");
  assert.deepEqual(gx().detail.states.groups, {}, "no keys after a certain refusal");
  await act("training-load-gpexe-approve");
  await flush();
  assert.equal(statesCalls().length, 1);
  assert.equal(statesCalls()[0].body.kind, "did_not_participate");
  assert.equal(statesCalls()[0].body.reasonKey, "illness");
  // An unknown import outcome keeps the keys: the chooser is disabled, a change is not taken.
  await openReview({ onApprove: async () => ({ status: 503, body: { error: "import_outcome_unknown" } }) });
  await choose(NOREC1, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  assert.ok(Object.keys(gx().detail.states.groups).length > 0);
  assert.doesNotMatch(html(), /data-action="training-load-gpexe-state" data-athlete-id="[^"]+" aria-label="[^"]*" >/, "no enabled chooser");
  await choose(NOREC2, "participated_no_values");
  assert.equal(gx().detail.states.choices[NOREC2], undefined, "a change is not taken while keys exist");
});

test("20. after a certain refusal the next send is a first send again: a later refusal reads as not saved, never 'can't be checked'", async () => {
  let n = 0;
  await openReview({ onStates: async () => (++n === 1 ? { status: 409, body: { error: "bulk_conflict", message: "", failed: [] } } : { status: 403, body: { error: "not_a_team_coach", message: "" } }) });
  await choose(NOREC1, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  await act("training-load-gpexe-states-again");
  assert.match(html(), /not saved\. Nothing was written/);
  assert.doesNotMatch(html(), /can&#039;t be checked from here/);
});

test("21. already_imported (the import exists) keeps the keys: the reopened review offers Save them, with the same key", async () => {
  let key = null;
  await openReview({ onApprove: async () => {
    key = Object.values(gx().detail.states.groups)[0]?.requestKey;
    approvalRecord = approvalView();
    responder = server({ candidate: { ...row(), status: "imported" }, onStates: async (call) => okStates(call) });
    return { status: 409, body: { error: "already_imported", message: "" } };
  } });
  await choose(NOREC1, "participated_no_values");
  await act("training-load-gpexe-approve");
  await flush();
  assert.ok(key, "keys were made at the confirm");
  assert.deepEqual(Object.values(gx().detail.states.groups).map((x) => x.requestKey), [key], "kept, not dropped");
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  assert.match(html(), /data-action="training-load-gpexe-states-again">Save them</);
  await act("training-load-gpexe-states-again");
  assert.equal(statesCalls().length, 1);
  assert.equal(statesCalls()[0].body.requestKey, key);
});

test("22. keys restored after a reload (no outcome in memory) lock the chooser: it is drawn disabled and a change is not taken", async () => {
  const k = "c0c0c0c0-0000-4000-8000-000000000001";
  resetState();
  store.clear();
  store.set(`optimove.gpexe.importStates.v1.coach-1.${TEAM_A}.cand-1`, JSON.stringify({ choices: { [NOREC1]: { kind: "participated_no_values" } },
    groups: { "participated_no_values|": { requestKey: k, status: "pending", athleteIds: [NOREC1] } } }));
  approvalRecord = null;
  responder = server({ onApprove: async () => imported(), onStates: async (call) => okStates(call) });
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  await act("training-load-gpexe-review-filter", { filter: "all" });
  assert.match(html(), new RegExp(`data-athlete-id="${NOREC1}" aria-label="[^"]*" disabled`));
  await choose(NOREC1, "did_not_participate:illness");
  assert.equal(gx().detail.states.choices[NOREC1].kind, "participated_no_values");
});

test("23. the stored choices belong to the signed-in user: another user in the same tab starts empty and never sends them", async () => {
  await openReview();
  await choose(NOREC1, "participated_no_values");
  assert.equal(store.size, 1);
  assert.match([...store.keys()][0], /\.coach-1\./);
  const kept = [...store.entries()];
  resetState();
  for (const [k, v] of kept) store.set(k, v);
  state.currentUser = { id: "coach-2", activeWorkspace: { type: "team", scopeId: TEAM_A } };
  responder = server({ onApprove: async () => imported(), onStates: async (call) => okStates(call) });
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  assert.deepEqual(gx().detail.states.choices, {});
  await act("training-load-gpexe-approve");
  await flush();
  assert.equal(statesCalls().length, 0);
});

test("24. a reason the loaded catalog does not hold (or not in the catalog's key shape) is not taken, and a stored one is dropped on read", async () => {
  await openReview();
  await choose(NOREC1, "did_not_participate:retired");
  await choose(NOREC2, "did_not_participate:a|b");
  assert.deepEqual(gx().detail.states.choices, {});
  resetState();
  store.clear();
  store.set(`optimove.gpexe.importStates.v1.coach-1.${TEAM_A}.cand-1`, JSON.stringify({ choices: { [NOREC1]: { kind: "did_not_participate", reasonKey: "A|b" } },
    groups: { "did_not_participate|A|b": { requestKey: "c0c0c0c0-0000-4000-8000-000000000002", status: "pending", athleteIds: [NOREC1] } } }));
  responder = server({ onApprove: async () => imported(), onStates: async (call) => okStates(call) });
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  assert.deepEqual(gx().detail.states.choices, {});
  assert.deepEqual(gx().detail.states.groups, {});
});

test("25. (INFO 2) leaving between two groups does not send the next one: the review closed, or the team's state replaced, while the first group is in flight", async () => {
  for (const leave of ["close", "replace"]) {
    let release;
    let first = true;
    await openReview({
      onStates: async (call) => {
        if (first) {
          first = false;
          await new Promise((resolve) => { release = resolve; });
        }
        return okStates(call);
      },
    });
    await choose(NOREC1, "participated_no_values");
    await choose(NOREC2, "did_not_participate:illness");
    const approving = act("training-load-gpexe-approve");
    while (!release) await flush();
    assert.equal(statesCalls().length, 1, `${leave}: the first group is in flight`);
    if (leave === "close") {
      await act("training-load-gpexe-close");
      assert.equal(gx().detail, null, "the review is closed");
    } else {
      // What a workspace switch does: the old object's generation is bumped and the object replaced.
      state.trainingLoad.gpexe.generation += 1;
      state.trainingLoad.gpexe = emptyTrainingLoadState().gpexe;
    }
    release();
    await approving;
    for (let i = 0; i < 5; i += 1) await flush();
    assert.equal(statesCalls().length, 1, `${leave}: the second group is never sent after leaving`);
  }
});
