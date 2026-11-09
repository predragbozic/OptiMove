// J20-B (docs/ai/j20-session-review-contract.md section 5.1): "Leave out" on the rows of the Session review and the subset approval.
// Driven through handleTrainingLoadAction with a fake fetch, like the other Imports suites.
import { test } from "node:test";
import assert from "node:assert/strict";

let confirmAnswer = true;
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = { confirm: () => confirmAnswer, matchMedia: () => ({ matches: false }) };

let fetchCalls;
let responder;
globalThis.fetch = async (url, options = {}) => {
  const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
  fetchCalls.push(call);
  const result = await responder(call);
  return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
};

const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { setGpexePollDelayForTests } = await import("../gpexe-import-data.js");

setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const MARKER_SESSION = "9977001";
const ORG = {
  teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }],
  clubs: [],
  athletes: [{ id: "ath-1", name: "Ana Example", memberships: [{ teamId: TEAM_A, membershipType: "team", status: "active" }] }],
};
const LINKED = [{ gpexeAthleteId: "101", status: "linked", link: { id: "link-1", athleteId: "ath-1", athleteName: "Ana Example", linkedAt: "2026-09-10T10:00:00Z" }, lastSeen: null, values: { duration: 40, distance: 3000, maxSpeed: 27 } }];

let renders = 0;
const render = () => { renders += 1; };
function resetState() {
  clearAllViewCache();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  fetchCalls = [];
  renders = 0;
}

function status({ enabled = false, canApprove = true, admin = false, lastCheck = null } = {}) {
  return {
    settings: { gpexeTeamId: "980" },
    importSwitch: { enabled, message: enabled ? "Approved imports can write results and activities in this environment." : "Import writing is switched off in this environment: checks and previews are saved, but no result or activity can be written." },
    lastCheck,
    viewer: { canApprove, approvalBasis: canApprove ? "team_grant" : null, isPlatformAdmin: admin, ...(admin ? { identityAdmin: true } : {}) },
    approvalAvailable: true,
  };
}

// A clean Ready session, as the list returns it since phase 4a / v33.
function row(overrides = {}) {
  return {
    id: "cand-1", gpexeTeamSessionId: MARKER_SESSION, label: "FULL TRAINING 05.10.", sessionStartedAt: "2026-10-05T16:08:12Z",
    status: "pending", previewStatus: "ready", previewHash: HASH, counts: { created: 4, athletesNotImported: 0 }, changesToImported: 0,
    firstSeenAt: "2026-10-05T18:00:00Z", lastSeenAt: "2026-10-06T18:00:00Z", importedAt: null,
    supersededByCandidateId: null, supersededByCheckId: null,
    snapshot: { available: true, expiresAt: "2026-11-05T00:00:00Z" }, approvalBlockers: [],
    blockedCode: null, blockedSourceCode: null, sessionType: "FULL TRAINING", reasons: [], ...overrides,
  };
}
const ATHLETES = [["101", "ath-1", "Ana Example"], ["102", "ath-2", "Bea Example"], ["103", "ath-3", "Cy Example"]];
function athleteEntry([gid, aid]) {
  return { gpexeAthleteId: gid, athleteId: aid, participation: { status: "recorded_by_gpexe" }, gps: { status: "measured", reason: null }, notImported: null, blocksSession: false,
    results: [{ externalId: `athlete_session:${gid}:full`, level: "full", drillIndex: null, outcome: "created", values: [{ metricDefinitionId: "def-distance", variableScope: "system", label: "Distance", unit: "m", value: "3000", sourceMetricKey: "athlete_session.total_distance", sourceValue: "3000", sourceUnit: "m", previous: null, change: "new" }] }], skippedValues: [] };
}
function previewOf(leftOut = []) {
  return {
    version: 3, status: "ready", blocked: null, counts: { created: 4, changesToImported: 0 }, changesToImported: [],
    athletes: ATHLETES.map((a) => (leftOut.includes(a[0])
      ? { ...athleteEntry(a), notImported: { code: "left_out_by_coach", message: "You chose to leave this athlete out of this import." }, results: [] }
      : athleteEntry(a))),
    teamAthletesWithoutGpexeRecord: [], anomalies: [],
  };
}
let approval = null;
function detailOf(c) {
  return { ...c, athletes: Object.fromEntries(ATHLETES.map(([, aid, name]) => [aid, { name }])), approval, preview: previewOf(approval?.excludedAthleteIds || []) , helperValues: {} };
}
const subsetHashOf = (ids) => `${"b".repeat(60)}${ids.join("").slice(-4).padStart(4, "0")}`;

function server({ teamStatus = {}, candidates = [], onApprove, onSubset } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const [, team, rest] = m;
    if (rest === "/status") return { status: 200, body: status(teamStatus) };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: LINKED, units: { duration: "min", distance: "m", maxSpeed: "km/h" }, lastSeenRule: "" } };
    if (rest === "/athlete-links" && call.method === "GET") return { status: 200, body: { links: [] } };
    if (rest === "/candidates") return { status: 200, body: { candidates: team === TEAM_A ? candidates : [] } };
    const previewRoute = rest.match(/^\/candidates\/([^/]+)\/preview$/);
    if (previewRoute) return onSubset ? onSubset(call, previewRoute[1]) : { status: 404, body: { error: "notFound" } };
    const approve = rest.match(/^\/candidates\/([^/]+)\/approve$/);
    if (approve) return onApprove(call, approve[1]);
    const detail = rest.match(/^\/candidates\/([^/?]+)$/);
    if (detail) {
      const c = candidates.find((x) => x.id === detail[1]);
      return c ? { status: 200, body: { candidate: detailOf(c) } } : { status: 404, body: { error: "notFound" } };
    }
    return { status: 404, body: { error: "notFound" } };
  };
}

async function act(action, dataset = {}, extra = {}) {
  await handleTrainingLoadAction({ dataset: { action, ...dataset }, ...extra }, { renderTrainingLoad: render });
}
const html = () => renderTrainingLoadCoachHtml();
const gx = () => state.trainingLoad.gpexe;
const tick = (gid, checked = true) => act("training-load-gpexe-leave-out", { gpexeAthleteId: gid }, { checked });
const boxes = (page = html()) => [...page.matchAll(/data-action="training-load-gpexe-leave-out" data-gpexe-athlete-id="(\d+)"( checked)?/g)].map((m) => [m[1], Boolean(m[2])]);
const subsetOk = (call) => {
  const ids = call.body.excludedAthleteIds;
  return { status: 200, body: { subset: { excludedAthleteIds: ids, previewHash: HASH, subsetHash: subsetHashOf(ids), preview: previewOf(ids) }, importSwitch: { enabled: true } } };
};
const approvals = () => fetchCalls.filter((c) => c.url.endsWith("/approve"));
const subsets = () => fetchCalls.filter((c) => c.url.endsWith("/preview"));
const imported = (call, ids = []) => ({ status: 200, body: { outcome: "imported", commitConfirmation: "confirmed", approval: { id: "ap-1", basis: "team_grant", changesAccepted: 0, excludedAthleteIds: ids, subsetHash: ids.length ? subsetHashOf(ids) : null }, import: { counts: { results: 4, values: 8 } }, candidate: detailOf({ ...row(), status: "imported" }) } });

async function openReview(opts = {}) {
  resetState();
  approval = null;
  responder = server({ teamStatus: { enabled: true, canApprove: true }, candidates: [row()], onSubset: async (call) => subsetOk(call), onApprove: async (call) => imported(call, call.body.excludedAthleteIds || []), ...opts });
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
}

test("1. a 'Leave out' box on each row the import would write, for a viewer who may approve; none for a viewer who may not, and none on a session that is not pending", async () => {
  await openReview();
  assert.deepEqual(boxes(), [["101", false], ["102", false], ["103", false]]);
  assert.match(html(), /aria-label="Leave out Ana Example"/, "the accessible name carries the athlete");
  assert.match(html(), /<th scope="col" role="columnheader">Leave out<\/th>/);
  await openReview({ teamStatus: { enabled: true, canApprove: false } });
  assert.deepEqual(boxes(), [], "a viewer without the approval right sees no box");
  assert.doesNotMatch(html(), />Leave out</);
  await openReview({ candidates: [row({ approvalBlockers: ["not_confirmed_for_import"] })] });
  assert.deepEqual(boxes(), []);
});

test("2. ticking sends nothing; with a tick the Import button is replaced by 'Review without them', and approving without that review does nothing", async () => {
  await openReview();
  const before = fetchCalls.length;
  await tick("103");
  assert.equal(fetchCalls.length, before, "a tick sends no request");
  assert.deepEqual(boxes(), [["101", false], ["102", false], ["103", true]]);
  let page = html();
  assert.match(page, /Leaving out 1 athlete: Cy Example\./);
  assert.match(page, /data-action="training-load-gpexe-subset-review"[^>]*>Review without them</);
  assert.doesNotMatch(page, /data-action="training-load-gpexe-approve"/, "the whole-session Import button is gone while athletes are left out");
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 0, "a forced approve without the subset review sends nothing");
  assert.equal(subsets().length, 0);
});

test("3. the Review step is one request with exactly the ticked set; then Import names the athletes after it and sends the subset, its hash and the candidate's hash, once", async () => {
  await openReview();
  await tick("103"); await tick("101");
  await act("training-load-gpexe-subset-review");
  assert.equal(subsets().length, 1);
  assert.deepEqual(subsets()[0].body, { excludedAthleteIds: ["101", "103"] }, "sorted numerically");
  assert.match(subsets()[0].url, /\/candidates\/cand-1\/preview$/);
  const page = html();
  assert.match(page, /Reviewed without them: 1 athlete will be imported\./);
  assert.match(page, /data-action="training-load-gpexe-approve"[^>]*>Import 1 athlete</);
  assert.doesNotMatch(page, /training-load-gpexe-subset-review/);
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 1);
  assert.deepEqual(approvals()[0].body, { previewHash: HASH, excludedAthleteIds: ["101", "103"], subsetHash: subsetHashOf(["101", "103"]) });
  assert.match(html(), /2 athletes were left out, as you chose\./);
  assert.match(html(), /<strong>Imported\.<\/strong>/);
});

test("4. a change of the set drops the review (a stale hash is never sent); unticking everything returns to the whole-session Import, which sends no exclusion", async () => {
  await openReview();
  await tick("103");
  await act("training-load-gpexe-subset-review");
  assert.equal(gx().detail.subset.status, "ready");
  await tick("102");
  assert.equal(gx().detail.subset, null, "the set changed: the review is stale and dropped");
  assert.match(html(), /Review without them/);
  await tick("102", false); await tick("103", false);
  assert.deepEqual(boxes().map((b) => b[1]), [false, false, false]);
  assert.match(html(), /data-action="training-load-gpexe-approve"[^>]*>Import 3 athletes</);
  await act("training-load-gpexe-approve");
  assert.deepEqual(approvals()[0].body, { previewHash: HASH }, "no excludedAthleteIds, no subsetHash on a whole-session approval");
});

test("5. a failed review says so and offers Try again, with nothing imported; a refused approval (preview_changed) drops the review and asks for a new one", async () => {
  await openReview({ onSubset: async () => ({ status: 409, body: { error: "try_again", message: "busy" } }) });
  await tick("103");
  await act("training-load-gpexe-subset-review");
  assert.match(html(), /The review without them could not be made right now\. Try again in a moment\./);
  assert.match(html(), /data-action="training-load-gpexe-subset-review"[^>]*>Try again</);
  assert.equal(approvals().length, 0);
  await openReview({ onApprove: async () => ({ status: 409, body: { error: "preview_changed", message: "changed", reviewAgain: { candidateId: "cand-1" }, subset: { excludedAthleteIds: ["103"], subsetHash: "c".repeat(64), preview: previewOf(["103"]) } } }) });
  await tick("103");
  await act("training-load-gpexe-subset-review");
  await act("training-load-gpexe-approve");
  assert.match(html(), /Not imported: the data changed since you opened this session\./);
  assert.equal(gx().detail.subset, null, "a subset review of a world that moved is made again, never reused");
  assert.match(html(), /Review without them/);
  assert.doesNotMatch(html(), /<strong>Imported\.<\/strong>/);
});

test("6. a lost answer is never 'not imported': Check the result reads the recorded set and says so when it is not the set chosen", async () => {
  await openReview({
    onApprove: async () => ({ status: 503, body: { error: "import_outcome_unknown", message: "unknown", verify: { candidateId: "cand-1", approvalId: "ap-9" } } }),
  });
  await tick("103");
  await act("training-load-gpexe-subset-review");
  await act("training-load-gpexe-approve");
  assert.equal(gx().detail.outcome.kind, "unknown");
  assert.deepEqual(gx().detail.outcome.chosenExcluded, ["103"]);
  assert.match(html(), /We can't tell yet whether this session was imported/);
  // The server recorded ANOTHER set (a retry with a different set is indistinguishable from a replay).
  const base = responder;
  responder = async (call) => {
    if (call.url.endsWith("/approvals/ap-9")) return { status: 200, body: { approval: { id: "ap-9", excludedAthleteIds: ["102"], subsetHash: "d".repeat(64) } } };
    if (/\/candidates\/cand-1$/.test(call.url)) return { status: 200, body: { candidate: { ...detailOf({ ...row(), status: "imported" }), approval: { id: "ap-9", excludedAthleteIds: ["102"] } } } };
    return base(call);
  };
  await act("training-load-gpexe-verify");
  const page = html();
  assert.match(page, /<strong>Imported\.<\/strong> Checked: the import is in OptiMove\./);
  assert.match(page, /Imported\. Left out: Bea Example\. This differs from your current ticks; what is shown is what was imported\./);
  assert.equal(approvals().length, 1, "Check the result never approves again");
});

test("7. an imported session shows the athletes it left out as 'Left out by you', not as Importable", async () => {
  await openReview();
  approval = { id: "ap-1", excludedAthleteIds: ["103"], subsetHash: "e".repeat(64) };
  responder = server({ teamStatus: { enabled: true, canApprove: true }, candidates: [row({ status: "imported", importedAt: "2026-10-07T10:00:00Z" })] });
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  const page = html();
  assert.match(page, /Left out by you/);
  assert.match(page, /You left this athlete out of the import\. Nothing of them is stored from this session; open the session(?:'|&#039;)s Roster tab to say whether they took part\./);
  assert.doesNotMatch(page, /gpexe-badge is-blocked">Left out by you/, "a choice is not shown as a problem");
  assert.deepEqual(boxes(page), [], "no box on an imported session");
  approval = null;
});

test("8. leaving everybody out is not importable: the button says nobody is left and nothing can be sent", async () => {
  await openReview();
  await tick("101"); await tick("102"); await tick("103");
  const page = html();
  assert.match(page, /Nobody would be left to import\./);
  assert.match(page, /data-action="training-load-gpexe-subset-review"[^>]*disabled/);
  await act("training-load-gpexe-subset-review");
  assert.equal(subsets().length, 1, "the review is still askable by the action, and the server refuses it with no_importable_athlete");
});

test("9. the review shows the hint; a set that no longer fits offers Update the review (not the same request again); the review step is explained", async () => {
  await openReview({ onSubset: async () => ({ status: 400, body: { error: "invalid_exclusion", message: "x" } }) });
  const page = html();
  assert.match(page, /To import without someone, tick Leave out on their row\./);
  assert.match(page, /To import without someone, tick Leave out on their row/);
  await tick("103");
  assert.match(html(), /First we check the import without them\. Nothing is saved yet\./);
  assert.match(html(), /Nothing of Cy Example is imported from this session\. If GPEXE later sends different data for it, you will review it again\./);
  await act("training-load-gpexe-subset-review");
  const failed = html();
  assert.match(failed, /The session changed, and one of the athletes you left out is no longer part of it\. Update the review, then choose again\./);
  assert.match(failed, /data-action="training-load-gpexe-review-update"[^>]*>Update the review</);
  assert.doesNotMatch(failed, /data-action="training-load-gpexe-subset-review"/, "the same request is not offered again");
  assert.match(failed, /1 athlete is ready to import|2 athletes are ready to import, 1 left out/);
});

test("10. an unconfirmed subset approval keeps its set across a closed and reopened review: the whole session is never offered in its place, and the retry sends the same set after a new review", async () => {
  await openReview({ onApprove: async () => ({ status: 503, body: { error: "import_outcome_unknown", message: "unknown", verify: { candidateId: "cand-1", approvalId: "ap-9" } } }) });
  await tick("103");
  await act("training-load-gpexe-subset-review");
  await act("training-load-gpexe-approve");
  assert.equal(gx().detail.outcome.kind, "unknown");
  await act("training-load-gpexe-close");
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  assert.deepEqual(gx().detail.leaveOut, ["103"], "the set that was sent is restored");
  // Nothing visible yet: the first answer may still be finishing.
  const base = responder;
  responder = async (call) => (call.url.endsWith("/approvals/ap-9") ? { status: 404, body: { error: "notFound" } } : base(call));
  await act("training-load-gpexe-verify");
  assert.equal(gx().detail.outcome.verified, "not_visible_yet");
  const page = html();
  assert.doesNotMatch(page, /data-action="training-load-gpexe-approve"/, "no whole-session Import button while a subset is pending a new review");
  assert.match(page, /data-action="training-load-gpexe-subset-review"/);
  const before = approvals().length;
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, before, "a forced approve sends nothing without the review");
  await act("training-load-gpexe-subset-review");
  await act("training-load-gpexe-approve");
  const last = approvals().at(-1);
  assert.deepEqual(last.body.excludedAthleteIds, ["103"], "the retry carries the same set");
  assert.ok(last.body.subsetHash);
});

test("12. an athlete with a result imported before (not only new ones) has no Leave out box: the server refuses it, so the screen never offers it", async () => {
  await openReview();
  const c = gx().detail.candidate;
  c.preview.athletes[1].results.push({ ...c.preview.athletes[1].results[0], externalId: "athlete_session:102:drill:0", level: "drill", drillIndex: 0, outcome: "unchanged" });
  assert.deepEqual(boxes().map((b) => b[0]), ["101", "103"], "athlete 102 has an earlier imported result: no box");
});

test("11. a refused set that would block the session gets its own sentence", async () => {
  await openReview({ onSubset: async () => ({ status: 409, body: { error: "subset_blocked", message: "x" } }) });
  await tick("103");
  await act("training-load-gpexe-subset-review");
  assert.match(html(), /This session can(?:'|&#039;)t be imported right now\. Update the review, then choose again\./);
});
