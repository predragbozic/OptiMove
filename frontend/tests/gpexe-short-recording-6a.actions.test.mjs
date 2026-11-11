// 6a: the short-recording flag in the Session review. A GPS athlete whose recorded time is clearly shorter than the session's
// longest (below 75 %) gets a yellow "Check" and "41 / 94 min": a hint only, never a decision. The choice is the existing one:
// keep the values, or Leave out (J20-B) and "Participated · no device data" (J20-C). Driven through handleTrainingLoadAction with
// a fake fetch, on the J20-C suite's harness.
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
let MINUTES = {};
let HELPERS = {};
let UNLINKED = new Set();
let UNIT = "min";
let OUTCOME = {};
let DRILL = {};
function durationValue(gid, m = MINUTES[gid]) {
  return m === undefined ? [] : [{ metricDefinitionId: "def-duration", variableScope: "system", label: "Duration", unit: UNIT, value: String(m), sourceMetricKey: "athlete_session.total_time", sourceValue: String(m * 60), sourceUnit: "s", previous: null, change: "new" }];
}
function athleteEntry([gid, aid]) {
  return { gpexeAthleteId: gid, athleteId: aid, participation: { status: "recorded_by_gpexe" }, gps: { status: "measured", reason: null }, notImported: null, blocksSession: false,
    results: [...(DRILL[gid] === undefined ? [] : [{ externalId: `athlete_session:${gid}:drill:0`, level: "drill", drillIndex: 0, outcome: "created", values: DRILL[gid] === null ? [{ metricDefinitionId: "def-distance", variableScope: "system", label: "Distance", unit: "m", value: "500", sourceMetricKey: "athlete_session.total_distance", sourceValue: "500", sourceUnit: "m", previous: null, change: "new" }] : durationValue(gid, DRILL[gid]) }]),
      { externalId: `athlete_session:${gid}:full`, level: "full", drillIndex: null, outcome: OUTCOME[gid] || "created", values: [{ metricDefinitionId: "def-distance", variableScope: "system", label: "Distance", unit: "m", value: "3000", sourceMetricKey: "athlete_session.total_distance", sourceValue: "3000", sourceUnit: "m", previous: null, change: "new" }, ...durationValue(gid)] }], skippedValues: [] };
}
function previewOf(leftOut = []) {
  return { version: 3, status: "ready", blocked: null, counts: { created: 3, changesToImported: 0 }, changesToImported: [],
    athletes: ATHLETES.map((a) => (leftOut.includes(a[0]) ? { ...athleteEntry(a), notImported: { code: "left_out_by_coach", message: "" }, results: [] }
      : UNLINKED.has(a[0]) ? { ...athleteEntry(a), athleteId: null, notImported: { code: "athlete_not_linked", message: "" }, results: [] } : athleteEntry(a))),
    teamAthletesWithoutGpexeRecord: [{ athleteId: NOREC1 }, { athleteId: NOREC2 }], anomalies: [] };
}
let approvalRecord = null;
function detailOf(c) {
  const names = { ...Object.fromEntries(ATHLETES.map(([, aid, name]) => [aid, { name }])), ...Object.fromEntries(Object.entries(NAMES).map(([id, name]) => [id, { name }])) };
  return { ...c, athletes: names, approval: approvalRecord, preview: previewOf(approvalRecord?.excludedAthleteIds || []), helperValues: HELPERS };
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


const reviewHtml = () => { const h = html(); return h.slice(h.indexOf('aria-label="Session review"')); };
const rowOf = (name, page = reviewHtml()) => {
  const at = page.indexOf(`>${name}</th>`);
  assert.ok(at > 0, `row of ${name}`);
  return page.slice(at, page.indexOf("</tr>", at));
};

test("1. a GPS athlete clearly below the session's longest time gets a yellow Check and '41 / 94 min'; the others keep their plain time and no flag; the short one is not folded away", async () => {
  MINUTES = { 101: 94, 102: 92, 103: 41 };
  await openReview();
  const page = reviewHtml();
  assert.match(rowOf("Cy Example", page), /gpexe-badge is-check">Check</);
  assert.match(rowOf("Cy Example", page), /class="gpexe-short-cell">41 \/ 94 min</);
  assert.match(rowOf("Cy Example", page), /Only 41 of 94 min recorded \(the longest in this session\)\. Imported as is unless you tick Leave out and choose &quot;Participated · no device data&quot;\./);
  for (const [name, text] of [["Ana Example", "94 min"], ["Bea Example", "92 min"]]) {
    assert.ok(rowOf(name, page).includes(`>${text}<`), `${name}: ${text}`);
    assert.ok(!/is-check/.test(rowOf(name, page)), `${name}: no flag`);
  }
  assert.match(page, /data-filter="short" aria-pressed="false">Short recording <span class="gpexe-chip-count">1<\/span>/);
  assert.match(page, /Needs a person <span class="gpexe-chip-count">3<\/span>/, "the flagged athlete and the two without a record");
  const fine = page.slice(page.indexOf('class="gpexe-fine"'));
  assert.ok(!fine.includes(">Cy Example</th>"), "the flagged athlete is shown, not folded under the fine ones");
  assert.ok(fine.includes(">Ana Example</th>"));
});

test("2. the threshold is below 75 % of the longest: exactly 75 % is not flagged, just under it is", async () => {
  MINUTES = { 101: 100, 102: 75, 103: 74.9 };
  await openReview();
  assert.ok(!/is-check/.test(rowOf("Bea Example")), "75 of 100 is not short");
  assert.match(rowOf("Cy Example"), /is-check/);
  assert.match(rowOf("Cy Example"), />74 \/ 100 min</, "the athlete's minutes rounded down, never 75 beside an unflagged 75");
});

test("3. a hint only: the import is unchanged - the same button, every athlete sent, nothing left out unless the coach ticks it; ticking Leave out on the flagged row leaves exactly that athlete out", async () => {
  MINUTES = { 101: 94, 102: 92, 103: 41 };
  let approveBody = null;
  await openReview({ onApprove: async (call) => { approveBody = call.body; return imported(); } });
  assert.match(html(), /data-action="training-load-gpexe-approve"[^>]*>Import 3 athletes</);
  await act("training-load-gpexe-approve");
  assert.ok(approveBody, "the approval was sent");
  assert.equal(approveBody.excludedAthleteIds, undefined, "nobody is left out by the flag");
  // Leave out on the flagged row: the existing J20-B path.
  MINUTES = { 101: 94, 102: 92, 103: 41 };
  await openReview();
  await act("training-load-gpexe-leave-out", { gpexeAthleteId: "103" }, { checked: true });
  assert.deepEqual(gx().detail.leaveOut, ["103"]);
  assert.match(rowOf("Cy Example"), /data-gpexe-athlete-id="103" checked/);
});

test("4. without the Duration mapping there is no time to compare: no '/' and no flag", async () => {
  MINUTES = {};
  await openReview();
  const page = reviewHtml();
  assert.ok(!/is-check/.test(page));
  assert.ok(!/ \/ \d+ min/.test(page));
  assert.ok(!/gpexe-short-cell/.test(page));
  assert.ok(!/data-filter="short"/.test(page), "no Check chip");
});

test("5. a viewer who may not approve sees the flag and the time, and a sentence without a box to tick", async () => {
  MINUTES = { 101: 94, 102: 92, 103: 41 };
  await openReview({ canApprove: false });
  const row = rowOf("Cy Example");
  assert.match(row, /is-check/);
  assert.match(row, /Only 41 of 94 min recorded \(the longest in this session\)\. Whoever imports can keep the values or leave them out as &quot;Participated · no device data&quot;\./);
  assert.ok(!/training-load-gpexe-leave-out/.test(row));
});

test("6. only a row the import would write is flagged: an athlete not linked yet with a short time shows it, but no Check; it still counts for the session's longest", async () => {
  MINUTES = { 101: 94, 102: 92 };
  HELPERS = { 103: { duration: 41, distance: null, maxSpeed: null } };
  UNLINKED = new Set(["103"]);
  try {
    await openReview();
    const page = reviewHtml();
    assert.ok(!/is-check/.test(page), "the unlinked athlete is not flagged");
    assert.match(page, /is-needs_link[\s\S]*?data-label="Duration" role="cell">41 min</, "its time is shown as before");
    // A linked athlete below 75 % of an unlinked athlete's longer time is flagged: the longest counts every recorded time.
    MINUTES = { 101: 50, 102: 92 };
    HELPERS = { 103: { duration: 94, distance: null, maxSpeed: null } };
    await openReview();
    assert.match(rowOf("Ana Example"), />50 \/ 94 min</);
  } finally {
    HELPERS = {};
    UNLINKED = new Set();
  }
});

test("7. ticking Leave out on the flagged row clears the flag: the coach has decided", async () => {
  MINUTES = { 101: 94, 102: 92, 103: 41 };
  await openReview();
  await act("training-load-gpexe-leave-out", { gpexeAthleteId: "103" }, { checked: true });
  const row = rowOf("Cy Example");
  assert.ok(!/is-check/.test(row), "no flag once ticked");
  assert.ok(!/gpexe-short-cell/.test(row));
  // The row stays shown, outside the folded fine ones, until its attendance is chosen (the note's second step).
  const beforeFine = (h = reviewHtml()) => h.slice(0, h.indexOf('class="gpexe-fine"') < 0 ? h.length : h.indexOf('class="gpexe-fine"'));
  assert.ok(beforeFine().includes(">Cy Example</th>"), "the ticked row is not folded away");
  assert.ok(beforeFine().includes(`data-action="training-load-gpexe-state" data-athlete-id="${A3}"`), "its attendance chooser is in view");
  await choose(A3, "participated_no_values");
  assert.ok(!beforeFine().includes(">Cy Example</th>"), "once chosen, the row may fold with the fine ones");
  await choose(A3, "");
  await act("training-load-gpexe-leave-out", { gpexeAthleteId: "103" }, { checked: false });
  assert.match(rowOf("Cy Example"), /is-check/, "back when unticked");
});

test("8. only the time the import writes, in minutes, is compared: a Duration in seconds, a drill's own time, or a result that does not write are never flagged", async () => {
  try {
    UNIT = "s";
    MINUTES = { 101: 94, 102: 92, 103: 41 };
    await openReview();
    assert.ok(!/is-check/.test(reviewHtml()), "a Duration in another unit is not compared");
    UNIT = "min";
    MINUTES = { 101: 94, 102: 92 };
    DRILL = { 103: 10 };
    await openReview();
    assert.ok(!/is-check/.test(reviewHtml()), "a drill's own Duration is not the session time");
    DRILL = {};
    MINUTES = { 101: 94, 102: 92, 103: 41 };
    OUTCOME = { 103: "stale_resend_ignored" };
    DRILL = { 103: null };
    await openReview();
    assert.match(rowOf("Cy Example"), /Importable/, "the drill still writes");
    assert.ok(!/is-check/.test(reviewHtml()), "a whole-session result that writes nothing has no time to judge");
    // A linked athlete whose import carries no Duration is not judged by the server's helper time either.
    DRILL = {};
    OUTCOME = {};
    MINUTES = { 101: 94, 102: 92 };
    HELPERS = { 103: { duration: 41, distance: null, maxSpeed: null } };
    await openReview();
    assert.ok(!/is-check/.test(reviewHtml()), "the helper time is for an athlete not linked yet only");
  } finally {
    UNIT = "min";
    DRILL = {};
    OUTCOME = {};
    HELPERS = {};
  }
});

test("9. a flagged row without a Leave out box (results imported before) names the fact only, never a box that is not there", async () => {
  MINUTES = { 101: 94, 102: 92, 103: 41 };
  OUTCOME = { 103: "corrected" };
  try {
    await openReview();
    const row = rowOf("Cy Example");
    assert.match(row, /is-check/);
    assert.match(row, /Only 41 of 94 min recorded \(the longest in this session\)\.(?! Imported as is)/);
    assert.ok(!/tick Leave out/.test(row));
    assert.ok(!/training-load-gpexe-leave-out/.test(row));
    // The same row for a viewer who may not import: no "Whoever imports can ... leave them out" either.
    await openReview({ canApprove: false });
    assert.match(rowOf("Cy Example"), /is-check/);
    assert.ok(!/Whoever imports/.test(rowOf("Cy Example")));
  } finally {
    OUTCOME = {};
  }
});
