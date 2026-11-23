// ST-4 PR3 (docs/ai/session-type-plan.md section 8 and 16.2): the re-import question in the Session review - the athletes whose
// values were entered or corrected on the roster, kept by default, "Use GPEXE's values" per athlete as a reviewed choice.
// The harness is the J20-B leave-out suite's (gpexe-imports-leave-out-j20b.actions.test.mjs).
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
    session: { activityTypeKey: "training_session", activityTypeSource: "team_suggestion", categoryName: "FULL TRAINING" },
  };
}
let approval = null;
let manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep", replaceAvailable: true }, { athleteId: "ath-2", kind: "correction", choice: "keep", replaceAvailable: true }] };
function detailOf(c) {
  return { ...c, athletes: Object.fromEntries(ATHLETES.map(([, aid, name]) => [aid, { name }])), approval, preview: { ...previewOf(approval?.excludedAthleteIds || []), ...(manualValues ? { manualValues } : {}) }, helperValues: {} };
}
const subsetHashOf = (ids) => `${"b".repeat(60)}${ids.join("").slice(-4).padStart(4, "0")}`;

function server({ teamStatus = {}, candidates = [], onApprove, onSubset } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    if (call.url === "/api/training-activity/session-types") return { status: 200, body: { types: [{ key: "training_session", label: "Training session" }, { key: "match", label: "Match" }], canAdd: null } };
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
  const ids = call.body.excludedAthleteIds || [];
  const replace = call.body.replaceManualAthleteIds || [];
  const typeKey = call.body.activityTypeKey;
  const preview = previewOf(ids);
  if (typeKey !== undefined) preview.session = { ...preview.session, activityTypeKey: typeKey, activityTypeSource: "choice" };
  return { status: 200, body: { subset: { excludedAthleteIds: ids, ...(replace.length ? { replaceManualAthleteIds: replace } : {}), ...(typeKey !== undefined ? { activityTypeKey: typeKey } : {}), previewHash: HASH, subsetHash: subsetHashOf([...ids, ...replace.map((x) => x.slice(-1)), typeKey ?? ""]), preview }, importSwitch: { enabled: true } } };
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


const useGpexe = (athleteId, checked = true) => act("training-load-gpexe-use-gpexe", { athleteId }, { checked });
const useBoxes = (page = html()) => [...page.matchAll(/data-action="training-load-gpexe-use-gpexe" data-athlete-id="([^"]+)"( checked)?/g)].map((m) => [m[1], Boolean(m[2])]);

test("1. the review lists the athletes with values entered or corrected on the roster, kept by default (every box unticked); a plain import sends no choice", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep", replaceAvailable: true }, { athleteId: "ath-2", kind: "correction", choice: "keep", replaceAvailable: true }] };
  await openReview();
  const page = html();
  assert.match(page, /2 athletes have values entered or corrected on the roster\./);
  assert.match(page, /These are kept\. Tick Use GPEXE(?:'|&#0?39;)s values to replace them; the replaced values stay in the history\./);
  assert.match(page, /class="gpexe-manual-summary"><p><strong>2 athletes have values entered or corrected on the roster\.<\/strong>[^]*href="#gpexe-manual-choice"/, "named at the top of the review too");
  assert.match(page, /Ana Example <span class="muted">· values entered on the roster/);
  assert.match(page, /Bea Example <span class="muted">· values corrected on the roster/);
  assert.deepEqual(useBoxes(page), [["ath-1", false], ["ath-2", false]]);
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 1);
  assert.equal(approvals()[0].body.replaceManualAthleteIds, undefined, "keep is the default: no choice is sent");
  assert.equal(subsets().length, 0);
});

test("2. Use GPEXE's values is a reviewed choice: ticked, the import waits for Review your choice; the review sends the athletes; the import sends exactly the reviewed choice and its hash", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep", replaceAvailable: true }, { athleteId: "ath-2", kind: "correction", choice: "keep", replaceAvailable: true }] };
  await openReview();
  await useGpexe("ath-1");
  let page = html();
  assert.deepEqual(useBoxes(page), [["ath-1", true], ["ath-2", false]]);
  assert.match(page, /Using GPEXE(?:'|&#0?39;)s values for 1 athlete: Ana Example\./);
  assert.match(page, />Review your choice</);
  // The import is not sent before the review.
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 0);
  await act("training-load-gpexe-subset-review");
  assert.equal(subsets().length, 1);
  assert.deepEqual(subsets()[0].body, { replaceManualAthleteIds: ["ath-1"] }, "an empty left-out set is not sent (ST-5's body)");
  page = html();
  assert.match(page, /Reviewed with your choice: 3 athletes will be imported\./);
  const reviewedHash = gx().detail.subset.subsetHash;
  assert.ok(reviewedHash);
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 1);
  const body = approvals()[0].body;
  assert.deepEqual(body.replaceManualAthleteIds, ["ath-1"]);
  assert.equal(body.excludedAthleteIds, undefined);
  assert.equal(body.subsetHash, reviewedHash, "exactly the reviewed hash");
});

test("3. a change of the choice drops the review (it is made again, never reused); unticking every box goes back to the plain import", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep", replaceAvailable: true }, { athleteId: "ath-2", kind: "correction", choice: "keep", replaceAvailable: true }] };
  await openReview();
  await useGpexe("ath-1");
  await act("training-load-gpexe-subset-review");
  assert.equal(gx().detail.subset.status, "ready");
  await useGpexe("ath-2");
  assert.equal(gx().detail.subset, null, "a changed choice drops the review");
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 0);
  await useGpexe("ath-1", false);
  await useGpexe("ath-2", false);
  assert.match(html(), /data-action="training-load-gpexe-approve"/);
  assert.doesNotMatch(html(), />Review your choice</);
});

test("4. an athlete the server does not list cannot be chosen; a viewer who may not approve gets no choice; a session without roster values shows no block", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep", replaceAvailable: true }] };
  await openReview();
  await useGpexe("ath-3");
  assert.deepEqual(gx().detail.useGpexe || [], [], "not listed: ignored");
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep", replaceAvailable: true }] };
  await openReview({ teamStatus: { enabled: true, canApprove: false } });
  assert.equal(useBoxes().length, 0);
  await useGpexe("ath-1");
  assert.deepEqual(gx().detail.useGpexe || [], []);
  manualValues = null;
  await openReview();
  assert.doesNotMatch(html(), /values entered or corrected on the roster/);
});

test("5. an unconfirmed approval with GPEXE's values keeps that choice across a closed and reopened review: the plain import (roster values kept) is never offered in its place, and the retry sends the same choice after a new review", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep", replaceAvailable: true }] };
  await openReview({ onApprove: async () => ({ status: 503, body: { error: "import_outcome_unknown", message: "unknown", verify: { candidateId: "cand-1", approvalId: "ap-9" } } }) });
  await useGpexe("ath-1");
  await act("training-load-gpexe-subset-review");
  await act("training-load-gpexe-approve");
  assert.equal(gx().detail.outcome.kind, "unknown");
  await act("training-load-gpexe-close");
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  assert.deepEqual(gx().detail.useGpexe, ["ath-1"], "the choice that was sent is restored");
  const base = responder;
  responder = async (call) => (call.url.endsWith("/approvals/ap-9") ? { status: 404, body: { error: "notFound" } } : base(call));
  await act("training-load-gpexe-verify");
  assert.equal(gx().detail.outcome.verified, "not_visible_yet");
  const page = html();
  assert.deepEqual(useBoxes(page), [["ath-1", true]]);
  assert.doesNotMatch(page, /data-action="training-load-gpexe-approve"/, "no plain Import while the choice waits for a new review");
  assert.match(page, />Review your choice</);
  await act("training-load-gpexe-subset-review");
  await act("training-load-gpexe-approve");
  assert.deepEqual(approvals().at(-1).body.replaceManualAthleteIds, ["ath-1"], "the retry carries the same choice");
});

test("6. a refusal that means the choice no longer fits offers Update the review, never the same request again: subset_blocked and manual_replace_unavailable at the review, invalid_manual_choice at the import", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep", replaceAvailable: true }] };
  for (const code of ["subset_blocked", "manual_replace_unavailable", "invalid_manual_choice"]) {
    await openReview({ onSubset: async () => ({ status: code === "subset_blocked" ? 409 : 400, body: { error: code, message: "x" } }) });
    await useGpexe("ath-1");
    await act("training-load-gpexe-subset-review");
    const page = html();
    assert.match(page, /data-action="training-load-gpexe-review-update"[^>]*>Update the review</, code);
    assert.doesNotMatch(page, />Try again</, code);
  }
  await openReview({ onApprove: async () => ({ status: 400, body: { error: "invalid_manual_choice", message: "x" } }) });
  await useGpexe("ath-1");
  await act("training-load-gpexe-subset-review");
  await act("training-load-gpexe-approve");
  assert.match(html(), /the values entered on the roster changed\. Update the review and choose again\./);
});

test("7. an athlete for whom GPEXE sent only drill results is Keep only (replaceAvailable false): no box, a plain sentence, and a forced tick is ignored; a left-out athlete gets no box either", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep", replaceAvailable: false }, { athleteId: "ath-2", kind: "entry", choice: "keep", replaceAvailable: true }] };
  await openReview();
  let page = html();
  assert.deepEqual(useBoxes(page), [["ath-2", false]]);
  assert.match(page, /Kept: GPEXE sent only drill results\./);
  await useGpexe("ath-1");
  assert.deepEqual(gx().detail.useGpexe || [], [], "not offered: ignored");
  gx().detail.useGpexe = ["ath-1"];
  assert.doesNotMatch(html(), /Using GPEXE(?:'|&#0?39;)s values/, "a Keep-only athlete is never part of the choice");
  gx().detail.useGpexe = [];
  await useGpexe("ath-2");
  await tick("102");
  page = html();
  assert.deepEqual(useBoxes(page), [], "left out: no box");
  assert.match(page, /Left out of this import\./);
  assert.doesNotMatch(page, /Using GPEXE(?:'|&#0?39;)s values/, "never both left out and given GPEXE's values");
  await act("training-load-gpexe-subset-review");
  assert.equal(subsets().at(-1).body.replaceManualAthleteIds, undefined, "the left-out athlete is not sent as replaced");
});

test("8. the outcome labels: Your values kept / GPEXE's values used", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep", replaceAvailable: true }] };
  await openReview();
  const c = gx().detail.candidate;
  c.preview.athletes[0].results[0].outcome = "manual_kept";
  c.preview.athletes[1].results[0].outcome = "manual_replaced";
  const page = html();
  assert.match(page, /Your values kept/);
  assert.match(page, /GPEXE(?:'|&#0?39;)s values used/);
  assert.doesNotMatch(page, /saved aside/);
});

test("9. the summary at the top of the review links to the choice only when the choice is on the page: a session that can't be approved right now shows neither", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep", replaceAvailable: true }] };
  resetState();
  approval = null;
  responder = server({ teamStatus: { enabled: true, canApprove: true }, candidates: [row({ approvalBlockers: ["team_import_switch_off"] })], onSubset: async (call) => subsetOk(call), onApprove: async () => ({ status: 500, body: {} }) });
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  const page = html();
  assert.doesNotMatch(page, /href="#gpexe-manual-choice"/);
  assert.doesNotMatch(page, /id="gpexe-manual-choice"/);
  await openReview();
  assert.match(html(), /href="#gpexe-manual-choice"/);
  assert.match(html(), /id="gpexe-manual-choice"/);
});

test("10. with ST-5's session type: a chosen type and GPEXE's values are one reviewed choice - the review and the import send both with one hash; with a type alone the roster-values choice stays on the page; a change of either drops the review", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep", replaceAvailable: true }] };
  await openReview();
  await act("training-load-gpexe-session-type", {}, { value: "match" });
  // A type alone is reviewed at once (ST-5), and the roster-values question is still offered beside it.
  assert.equal(subsets().length, 1);
  assert.deepEqual(subsets()[0].body, { activityTypeKey: "match" });
  assert.deepEqual(useBoxes(), [["ath-1", false]]);
  assert.match(html(), /id="gpexe-manual-choice"/);
  await useGpexe("ath-1");
  assert.equal(gx().detail.subset, null, "the type-only review is dropped");
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 0, "nothing sent before the review of the whole choice");
  await act("training-load-gpexe-subset-review");
  assert.deepEqual(subsets().at(-1).body, { activityTypeKey: "match", replaceManualAthleteIds: ["ath-1"] });
  const reviewedHash = gx().detail.subset.subsetHash;
  await act("training-load-gpexe-session-type", {}, { value: "training_session" });
  assert.equal(gx().detail.subset, null, "a changed type drops the review");
  await act("training-load-gpexe-session-type", {}, { value: "match" });
  await act("training-load-gpexe-subset-review");
  await act("training-load-gpexe-approve");
  const body = approvals().at(-1).body;
  assert.equal(body.activityTypeKey, "match");
  assert.deepEqual(body.replaceManualAthleteIds, ["ath-1"]);
  assert.equal(body.subsetHash, reviewedHash);
});
